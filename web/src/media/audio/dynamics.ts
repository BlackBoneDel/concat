// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Shared helpers of the dynamics processors (compressor, limiter, gate). */

/** dBFS → linear. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Linear → dBFS (floored at −200 dB). */
export function gainToDb(gain: number): number {
  return gain > 1e-10 ? 20 * Math.log10(gain) : -200;
}

/**
 * One-pole smoothing coefficient for a time constant.
 * @param seconds time to reach ~63 % of a step.
 * @param sampleRate samples per second.
 * @returns the coefficient `a` in `y = a·y + (1 − a)·x`.
 */
export function timeCoefficient(seconds: number, sampleRate: number): number {
  return seconds > 0 ? Math.exp(-1 / (seconds * sampleRate)) : 0;
}

/**
 * Linked peak level across channels at each sample (stereo-linked detection).
 * @param channels the signal.
 * @returns max |x| per frame.
 */
export function linkedPeak(channels: readonly Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) {
      const v = Math.abs(channel[i]!);
      if (v > out[i]!) out[i] = v;
    }
  }
  return out;
}

/**
 * Clamps a number into a range, using `fallback` for non-finite input.
 * @param value candidate.
 * @param min lower bound.
 * @param max upper bound.
 * @param fallback used when `value` is not finite.
 * @returns the clamped value.
 */
export function clampParam(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** The slice of `DynamicsCompressorNode` the processors drive. */
export interface CompressorNodeLike {
  threshold: { value: number };
  knee: { value: number };
  ratio: { value: number };
  attack: { value: number };
  release: { value: number };
  connect(destination: unknown): unknown;
  disconnect(): void;
}

/** The slice of `GainNode` the processors drive. */
export interface GainNodeLike {
  gain: { value: number };
  connect(destination: unknown): unknown;
  disconnect(): void;
}
