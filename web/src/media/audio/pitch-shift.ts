// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Speed changes with and without pitch preservation.
 *
 * Port of `speed_filters` in `src/crates/concat-media/src/audio.rs`:
 *
 * - **Tape mode** (`preservePitch = false`, Rust `asetrate`): the signal is
 *   resampled by the rate, so duration ÷ rate and pitch × rate. Interpolation
 *   is 4-point cubic Hermite (Catmull–Rom), plenty for 0.25–4×.
 * - **Pitch-preserving** (Rust `atempo`): a phase vocoder — Flanagan & Golden
 *   1966; formulation of Laroche & Dolson, "Improved phase vocoder time-scale
 *   modification of audio", IEEE TSAP 1999. STFT with a 2048-point Hann
 *   window, synthesis hop Hs = 512, analysis hop Ha = Hs·rate. For every bin
 *   the true frequency is recovered from the phase advance between analysis
 *   frames, `ω = ω_k + princarg(Δφ − ω_k·Ha) / Ha`, and the synthesis phase
 *   accumulates `ω·Hs`, so partials keep their frequency while the frames are
 *   re-spaced. Overlap-add is normalised by Σw², which removes the window
 *   modulation exactly.
 *
 * Why not PSOLA? TD-PSOLA needs pitch marks and is only artefact-free on
 * monophonic voiced signals; a phase vocoder handles music and mixed sources
 * uniformly, which is what a timeline clip can contain. Pitch shift by
 * semitones (`shiftPitch`) composes both: stretch by 2^(s/12), then resample.
 */

import { createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';
import { FFT, hann } from './fft.ts';

/** Accepted rate range (same as Rust `clamp_speed`). */
export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
/** STFT size of the phase vocoder. */
export const VOCODER_SIZE = 2048;
/** Synthesis hop of the phase vocoder (75 % overlap). */
export const VOCODER_HOP = 512;

/**
 * Validates a rate.
 * @param rate playback rate.
 * @returns the rate.
 */
export function checkRate(rate: number): number {
  if (!(rate >= MIN_RATE && rate <= MAX_RATE)) throw new RangeError(`Velocidad fuera de rango (0.25–4×): ${rate}`);
  return rate;
}

/**
 * Tape-style resample: reads the source `rate` times faster.
 * @param input samples.
 * @param rate speed factor (> 0).
 * @returns `round(len / rate)` samples.
 */
export function resample(input: Float32Array, rate: number): Float32Array {
  const length = Math.max(0, Math.round(input.length / rate));
  const out = new Float32Array(length);
  const last = input.length - 1;
  const at = (i: number): number => input[i < 0 ? 0 : i > last ? last : i]!;
  for (let i = 0; i < length; i += 1) {
    const pos = i * rate;
    const k = Math.floor(pos);
    const t = pos - k;
    const y0 = at(k - 1);
    const y1 = at(k);
    const y2 = at(k + 1);
    const y3 = at(k + 2);
    // Catmull–Rom cubic Hermite.
    out[i] = y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
  }
  return out;
}

/** Wraps a phase to (−π, π]. */
function princarg(phase: number): number {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI));
}

/**
 * Phase-vocoder time stretch: duration ÷ rate, pitch unchanged.
 * @param input samples.
 * @param rate speed factor (0.25–4).
 * @returns `round(len / rate)` samples.
 */
export function timeStretch(input: Float32Array, rate: number): Float32Array {
  const n = VOCODER_SIZE;
  const hs = VOCODER_HOP;
  const outLength = Math.max(0, Math.round(input.length / rate));
  if (input.length === 0 || outLength === 0) return new Float32Array(outLength);
  if (Math.abs(rate - 1) < 1e-9) return new Float32Array(input);
  const fft = new FFT(n);
  const window = hann(n);
  const half = n / 2;
  const frames = Math.ceil(outLength / hs) + 1;
  // Pad so the first frame is centred on sample 0.
  const padded = new Float32Array(input.length + 2 * n);
  padded.set(input, half);
  const out = new Float64Array(frames * hs + n);
  const norm = new Float64Array(frames * hs + n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const lastPhase = new Float64Array(half + 1);
  const sumPhase = new Float64Array(half + 1);
  const magnitude = new Float64Array(half + 1);
  let previousPos = 0;
  for (let f = 0; f < frames; f += 1) {
    const pos = Math.round(f * hs * rate);
    for (let i = 0; i < n; i += 1) {
      const src = pos + i;
      re[i] = (src < padded.length ? padded[src]! : 0) * window[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);
    const ha = pos - previousPos;
    for (let k = 0; k <= half; k += 1) {
      const phase = Math.atan2(im[k]!, re[k]!);
      magnitude[k] = Math.hypot(re[k]!, im[k]!);
      if (f === 0) {
        sumPhase[k] = phase;
      } else {
        const omega = (2 * Math.PI * k) / n;
        const delta = ha > 0 ? princarg(phase - lastPhase[k]! - omega * ha) : 0;
        const trueFrequency = ha > 0 ? omega + delta / ha : omega;
        sumPhase[k] = sumPhase[k]! + trueFrequency * hs;
      }
      lastPhase[k] = phase;
    }
    previousPos = pos;
    // Rebuild a Hermitian spectrum from magnitude + synthesis phase.
    for (let k = 0; k <= half; k += 1) {
      re[k] = magnitude[k]! * Math.cos(sumPhase[k]!);
      im[k] = magnitude[k]! * Math.sin(sumPhase[k]!);
    }
    for (let k = half + 1; k < n; k += 1) {
      re[k] = re[n - k]!;
      im[k] = -im[n - k]!;
    }
    fft.transform(re, im, true);
    const base = f * hs;
    for (let i = 0; i < n; i += 1) {
      out[base + i] = out[base + i]! + re[i]! * window[i]!;
      norm[base + i] = norm[base + i]! + window[i]! * window[i]!;
    }
  }
  const result = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const j = i + half;
    const w = norm[j]!;
    result[i] = w > 1e-6 ? out[j]! / w : 0;
  }
  return result;
}

/** Options of {@link PitchShifter.process}. */
export interface PitchOptions {
  /** Speed factor, 0.25–4. */
  rate: number;
  /** Keep the original pitch (phase vocoder) instead of tape-style. */
  preservePitch: boolean;
}

/**
 * Per-channel speed processing.
 * @param channels input channels.
 * @param options rate + mode.
 * @returns processed channels.
 */
export function processChannels(channels: readonly Float32Array[], options: PitchOptions): Float32Array[] {
  const rate = checkRate(options.rate);
  return channels.map((channel) => (options.preservePitch ? timeStretch(channel, rate) : resample(channel, rate)));
}

/**
 * Pitch shift by semitones without changing duration.
 * @param channels input channels.
 * @param semitones −24…+24.
 * @returns processed channels (same length).
 */
export function shiftPitchChannels(channels: readonly Float32Array[], semitones: number): Float32Array[] {
  if (!(semitones >= -24 && semitones <= 24)) throw new RangeError(`Transposición fuera de rango (±24 semitonos): ${semitones}`);
  if (semitones === 0) return channels.map((channel) => new Float32Array(channel));
  const factor = 2 ** (semitones / 12);
  return channels.map((channel) => {
    // Stretch longer by `factor`, then read it `factor` times faster.
    const stretched = timeStretch(channel, 1 / factor);
    const shifted = resample(stretched, factor);
    const out = new Float32Array(channel.length);
    out.set(shifted.subarray(0, channel.length));
    return out;
  });
}

/** Speed/pitch processing over audio buffers. */
export class PitchShifter {
  /**
   * Changes speed.
   * @param buffer the source.
   * @param options rate + mode.
   * @returns the processed buffer (`duration / rate`).
   */
  process(buffer: AudioBufferLike, options: PitchOptions): AudioBufferLike {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
    return createAudioBuffer(processChannels(channels, options), buffer.sampleRate);
  }

  /**
   * Transposes without changing duration.
   * @param buffer the source.
   * @param semitones −24…+24.
   * @returns the transposed buffer.
   */
  shift(buffer: AudioBufferLike, semitones: number): AudioBufferLike {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
    return createAudioBuffer(shiftPitchChannels(channels, semitones), buffer.sampleRate);
  }
}
