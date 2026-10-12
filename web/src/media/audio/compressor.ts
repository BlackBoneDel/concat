// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Feed-forward compressor.
 *
 * Offline: log-domain gain computer with a quadratic soft knee and a smooth
 * branching peak detector — design (and equations) from Giannoulis, Massberg
 * & Reiss, "Digital Dynamic Range Compressor Design — A Tutorial and
 * Analysis", JAES 60(6), 2012. Detection is stereo-linked so the image never
 * shifts. Realtime: `DynamicsCompressorNode` + make-up gain.
 */

import { copyChannels, createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';
import { clampParam, dbToGain, gainToDb, linkedPeak, timeCoefficient, type CompressorNodeLike, type GainNodeLike } from './dynamics.ts';

/** Compressor settings. */
export interface CompressorParams {
  /** dBFS, −100…0. */
  threshold: number;
  /** n:1, 1…20. */
  ratio: number;
  /** dB, 0…40. */
  knee: number;
  /** Seconds, 0…1. */
  attack: number;
  /** Seconds, 0…1. */
  release: number;
  /** dB, 0…24. */
  makeupGain: number;
}

/** A gentle voice preset. */
export const DEFAULT_COMPRESSOR: Readonly<CompressorParams> = Object.freeze({
  threshold: -24, ratio: 4, knee: 6, attack: 0.003, release: 0.25, makeupGain: 0,
});

/**
 * Clamps every parameter into range.
 * @param params candidate (partial or from JSON).
 * @returns valid parameters.
 */
export function sanitizeCompressor(params: Partial<Record<keyof CompressorParams, unknown>>): CompressorParams {
  return {
    threshold: clampParam(params.threshold, -100, 0, DEFAULT_COMPRESSOR.threshold),
    ratio: clampParam(params.ratio, 1, 20, DEFAULT_COMPRESSOR.ratio),
    knee: clampParam(params.knee, 0, 40, DEFAULT_COMPRESSOR.knee),
    attack: clampParam(params.attack, 0, 1, DEFAULT_COMPRESSOR.attack),
    release: clampParam(params.release, 0, 1, DEFAULT_COMPRESSOR.release),
    makeupGain: clampParam(params.makeupGain, 0, 24, DEFAULT_COMPRESSOR.makeupGain),
  };
}

/**
 * Static curve: output level for an input level (Giannoulis eq. 4).
 * @param inputDb input level, dB.
 * @param p settings.
 * @returns output level, dB (before make-up).
 */
export function compressorCurve(inputDb: number, p: CompressorParams): number {
  const over = inputDb - p.threshold;
  if (2 * over < -p.knee) return inputDb;
  if (p.knee > 0 && 2 * Math.abs(over) <= p.knee) {
    return inputDb + ((1 / p.ratio - 1) * (over + p.knee / 2) ** 2) / (2 * p.knee);
  }
  return p.threshold + over / p.ratio;
}

/**
 * Compresses a buffer offline.
 * @param buffer the source.
 * @param params settings.
 * @returns the compressed buffer and the per-frame gain reduction (dB, ≤ 0).
 */
export function processCompressor(buffer: AudioBufferLike, params: CompressorParams): { buffer: AudioBufferLike; reduction: Float32Array } {
  const p = sanitizeCompressor(params);
  const channels = copyChannels(buffer);
  const peak = linkedPeak(channels);
  const aA = timeCoefficient(p.attack, buffer.sampleRate);
  const aR = timeCoefficient(p.release, buffer.sampleRate);
  const makeup = p.makeupGain;
  const reduction = new Float32Array(peak.length);
  let level = 0; // smoothed gain reduction, dB (≥ 0)
  for (let i = 0; i < peak.length; i += 1) {
    const x = gainToDb(peak[i]!);
    const target = x - compressorCurve(x, p); // ≥ 0
    // Smooth branching detector (Giannoulis eq. 17).
    level = target > level ? aA * level + (1 - aA) * target : aR * level + (1 - aR) * target;
    reduction[i] = -level;
    const g = dbToGain(makeup - level);
    for (const channel of channels) channel[i] = channel[i]! * g;
  }
  return { buffer: createAudioBuffer(channels, buffer.sampleRate), reduction };
}

/** Realtime compressor nodes: compressor → make-up gain. */
export interface CompressorChain {
  input: CompressorNodeLike;
  output: GainNodeLike;
  dispose(): void;
}

/**
 * Builds the realtime compressor.
 * @param createCompressor `() => ctx.createDynamicsCompressor()`.
 * @param createGain `() => ctx.createGain()`.
 * @param params settings.
 * @returns the connected chain.
 */
export function createCompressorChain(
  createCompressor: () => CompressorNodeLike,
  createGain: () => GainNodeLike,
  params: CompressorParams,
): CompressorChain {
  const p = sanitizeCompressor(params);
  const input = createCompressor();
  input.threshold.value = p.threshold;
  input.knee.value = p.knee;
  input.ratio.value = p.ratio;
  input.attack.value = p.attack;
  input.release.value = p.release;
  const output = createGain();
  output.gain.value = dbToGain(p.makeupGain);
  input.connect(output);
  return {
    input,
    output,
    dispose: () => {
      input.disconnect();
      output.disconnect();
    },
  };
}
