// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Loudness measurement (EBU R128 / ITU-R BS.1770-4) and normalisation.
 *
 * Algorithm (BS.1770-4 §2, EBU Tech 3341/3342):
 *   1. K-weighting per channel: a high-shelf "head" filter (+4 dB above
 *      ~1.5 kHz) then an RLB high-pass (~38 Hz). Coefficients are derived for
 *      any sample rate from the analog prototypes exactly as libebur128 does
 *      (f0, G, Q constants below), reproducing the 48 kHz table of BS.1770.
 *   2. Mean square z over 400 ms blocks with 75 % overlap (100 ms hop).
 *   3. Block loudness l = −0.691 + 10·log10(Σ G_i·z_i), channel weights
 *      L/R/C = 1, LFE = 0, surrounds = 1.41.
 *   4. Integrated: drop blocks below −70 LUFS (absolute gate), then below
 *      (mean of the rest − 10 LU) (relative gate); average the survivors'
 *      energies.
 *   5. LRA (Tech 3342): 3 s short-term blocks, gates −70 LUFS and −20 LU,
 *      spread between the 10th and 95th percentiles.
 *   6. True peak: 4× oversampling with a 48-tap windowed-sinc polyphase
 *      interpolator (BS.1770-4 Annex 2).
 * Reference implementation consulted: libebur128 (MIT), `ebur128.c`.
 */

import { createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';
import { biquadProcess, type BiquadCoefficients } from './biquad.ts';
import { dbToGain, gainToDb } from './dynamics.ts';

/** Result of a loudness measurement. */
export interface LoudnessResult {
  /** Integrated loudness, LUFS (−Infinity for silence). */
  integrated: number;
  /** Loudness range, LU. */
  range: number;
  /** Highest momentary (400 ms) loudness, LUFS. */
  momentaryMax: number;
  /** Highest short-term (3 s) loudness, LUFS. */
  shortTermMax: number;
  /** True peak, dBTP. */
  truePeak: number;
  /** Sample peak, dBFS. */
  samplePeak: number;
}

/** Common delivery targets, LUFS. */
export const LOUDNESS_TARGETS = Object.freeze({ broadcast: -23, streaming: -14, podcast: -16 });

/**
 * The K-weighting filter pair for a sample rate (libebur128 derivation).
 * @param sampleRate samples per second.
 * @returns [head shelf, RLB high-pass].
 */
export function kWeightingFilters(sampleRate: number): [BiquadCoefficients, BiquadCoefficients] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: BiquadCoefficients = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  // BS.1770 keeps the RLB numerator un-normalised: (1, −2, 1).
  const highpass: BiquadCoefficients = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, highpass];
}

/**
 * BS.1770 channel weights for a channel count (SMPTE order L R C LFE Ls Rs …).
 * @param channels channel count.
 * @returns weights.
 */
export function channelWeights(channels: number): number[] {
  if (channels <= 2) return new Array<number>(channels).fill(1);
  return Array.from({ length: channels }, (_, i) => (i < 3 ? 1 : i === 3 ? 0 : 1.41));
}

/** Loudness of a weighted energy sum. */
function lufs(energy: number): number {
  return energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
}

/**
 * Weighted mean-square energies of overlapping blocks.
 * @param filtered K-weighted channels.
 * @param weights channel weights.
 * @param blockSamples block length.
 * @param hopSamples hop.
 * @returns block energies.
 */
function blockEnergies(filtered: Float32Array[], weights: number[], blockSamples: number, hopSamples: number): number[] {
  const length = filtered[0]?.length ?? 0;
  if (length < blockSamples) return [];
  // Prefix sums of squares per channel → O(1) per block.
  const prefixes = filtered.map((channel) => {
    const prefix = new Float64Array(channel.length + 1);
    for (let i = 0; i < channel.length; i += 1) prefix[i + 1] = prefix[i]! + channel[i]! * channel[i]!;
    return prefix;
  });
  const out: number[] = [];
  for (let start = 0; start + blockSamples <= length; start += hopSamples) {
    let energy = 0;
    prefixes.forEach((prefix, c) => {
      energy += (weights[c] ?? 1) * ((prefix[start + blockSamples]! - prefix[start]!) / blockSamples);
    });
    out.push(energy);
  }
  return out;
}

/**
 * Gated mean of energies (BS.1770 two-stage gate).
 * @param energies block energies.
 * @param relativeGate LU below the ungated-above-absolute mean.
 * @returns gated energies.
 */
function gate(energies: number[], relativeGate: number): number[] {
  const absolute = energies.filter((e) => lufs(e) > -70);
  if (absolute.length === 0) return [];
  const mean = absolute.reduce((s, e) => s + e, 0) / absolute.length;
  const threshold = lufs(mean) + relativeGate;
  return absolute.filter((e) => lufs(e) > threshold);
}

/** 4× polyphase interpolator taps (48 taps total, Kaiser-ish window). */
const OVERSAMPLE = 4;
const TAPS_PER_PHASE = 12;
const PHASES: Float64Array[] = (() => {
  const total = OVERSAMPLE * TAPS_PER_PHASE;
  const centre = (total - 1) / 2;
  const phases = Array.from({ length: OVERSAMPLE }, () => new Float64Array(TAPS_PER_PHASE));
  for (let i = 0; i < total; i += 1) {
    const x = (i - centre) / OVERSAMPLE;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / total);
    phases[i % OVERSAMPLE]![Math.floor(i / OVERSAMPLE)] = sinc * w;
  }
  return phases;
})();

/**
 * True peak of one channel (linear).
 * @param data samples.
 * @returns max |x| of the 4× oversampled signal (never below the sample peak).
 */
export function truePeakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]!));
  for (let n = 0; n < data.length; n += 1) {
    for (let p = 0; p < OVERSAMPLE; p += 1) {
      const taps = PHASES[p]!;
      let acc = 0;
      for (let t = 0; t < TAPS_PER_PHASE; t += 1) {
        const index = n - t + TAPS_PER_PHASE / 2;
        if (index >= 0 && index < data.length) acc += data[index]! * taps[t]!;
      }
      const v = Math.abs(acc);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * Measures loudness of planar channels.
 * @param channels samples.
 * @param sampleRate samples per second.
 * @returns the measurement.
 */
export function measureChannels(channels: readonly Float32Array[], sampleRate: number): LoudnessResult {
  const [shelf, highpass] = kWeightingFilters(sampleRate);
  const filtered = channels.map((channel) => {
    const copy = new Float32Array(channel);
    biquadProcess(copy, shelf);
    biquadProcess(copy, highpass);
    return copy;
  });
  const weights = channelWeights(channels.length);
  const hop = Math.round(sampleRate * 0.1);
  const momentary = blockEnergies(filtered, weights, Math.round(sampleRate * 0.4), hop);
  const shortTerm = blockEnergies(filtered, weights, Math.round(sampleRate * 3), hop);
  const gated = gate(momentary, -10);
  const integrated = gated.length > 0 ? lufs(gated.reduce((s, e) => s + e, 0) / gated.length) : -Infinity;
  const lraBlocks = gate(shortTerm, -20).map(lufs).sort((a, b) => a - b);
  const percentile = (q: number): number => lraBlocks[Math.min(lraBlocks.length - 1, Math.max(0, Math.round(q * (lraBlocks.length - 1))))]!;
  const range = lraBlocks.length > 1 ? percentile(0.95) - percentile(0.1) : 0;
  let samplePeak = 0;
  let truePeak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) samplePeak = Math.max(samplePeak, Math.abs(channel[i]!));
    truePeak = Math.max(truePeak, truePeakOf(channel));
  }
  return {
    integrated,
    range,
    momentaryMax: momentary.length > 0 ? Math.max(...momentary.map(lufs)) : -Infinity,
    shortTermMax: shortTerm.length > 0 ? Math.max(...shortTerm.map(lufs)) : -Infinity,
    truePeak: gainToDb(truePeak),
    samplePeak: gainToDb(samplePeak),
  };
}

/** Normalisation request. */
export interface NormalizeOptions {
  /** `'loudness'` targets LUFS, `'peak'` targets a sample peak. */
  mode: 'loudness' | 'peak';
  /** LUFS for loudness mode, dBFS for peak mode. */
  target: number;
  /** Loudness mode: never let the true peak exceed this (dBTP). Default −1. */
  truePeakCeiling?: number;
}

/**
 * The gain (dB) that normalises a measurement.
 * @param measurement a loudness measurement.
 * @param options the target.
 * @returns gain in dB (0 for silence).
 */
export function normalizationGain(measurement: LoudnessResult, options: NormalizeOptions): number {
  if (options.mode === 'peak') {
    return Number.isFinite(measurement.samplePeak) && measurement.samplePeak > -200 ? options.target - measurement.samplePeak : 0;
  }
  if (!Number.isFinite(measurement.integrated)) return 0;
  const wanted = options.target - measurement.integrated;
  const ceiling = options.truePeakCeiling ?? -1;
  return Math.min(wanted, ceiling - measurement.truePeak);
}

/** Loudness measurement + gain application over audio buffers. */
export class AudioNormalizer {
  /**
   * Measures a buffer.
   * @param buffer the audio.
   * @returns the measurement.
   */
  measure(buffer: AudioBufferLike): LoudnessResult {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
    return measureChannels(channels, buffer.sampleRate);
  }

  /**
   * Normalises a buffer.
   * @param buffer the audio.
   * @param options the target.
   * @param measurement a precomputed measurement (e.g. from the worker).
   * @returns the normalised buffer and the applied gain (dB).
   */
  normalize(buffer: AudioBufferLike, options: NormalizeOptions, measurement = this.measure(buffer)): { buffer: AudioBufferLike; gainDb: number } {
    const gainDb = normalizationGain(measurement, options);
    const g = dbToGain(gainDb);
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      const source = buffer.getChannelData(c);
      const out = new Float32Array(source.length);
      for (let i = 0; i < source.length; i += 1) out[i] = source[i]! * g;
      channels.push(out);
    }
    return { buffer: createAudioBuffer(channels, buffer.sampleRate), gainDb };
  }
}
