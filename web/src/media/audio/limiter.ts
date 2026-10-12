// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Brick-wall look-ahead limiter.
 *
 * Offline algorithm (guarantees |y| ≤ ceiling):
 *   1. required gain  r[n] = min(1, ceiling / peak[n])  (stereo-linked);
 *   2. look-ahead minimum  m[n] = min r[n−L … n+L]  (O(N) monotonic deque);
 *   3. box smoothing  g[n] = mean m[n−L … n+L] — every term of that mean
 *      covers sample n in its own window, so g[n] ≤ r[n] still holds and the
 *      gain ramps down *before* the peak arrives (the look-ahead);
 *   4. release: g'[n] = min(g[n], g'[n−1] + (1 − g'[n−1])·(1 − aR)), which can
 *      only lower the gain further.
 * Realtime: a hard-knee 20:1 `DynamicsCompressorNode` (its built-in ~6 ms
 * look-ahead) followed by a `WaveShaperNode` that clips at the ceiling.
 */

import { copyChannels, createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';
import { clampParam, dbToGain, linkedPeak, type CompressorNodeLike } from './dynamics.ts';

/** Limiter settings. */
export interface LimiterParams {
  /** dBFS, −20…0. */
  ceiling: number;
  /** Milliseconds, 0…20. */
  lookahead: number;
  /** Milliseconds, 1…1000. */
  release: number;
}

/** Streaming-safe default: −1 dBFS, 5 ms look-ahead. */
export const DEFAULT_LIMITER: Readonly<LimiterParams> = Object.freeze({ ceiling: -1, lookahead: 5, release: 100 });

/**
 * Clamps every parameter into range.
 * @param params candidate.
 * @returns valid parameters.
 */
export function sanitizeLimiter(params: Partial<Record<keyof LimiterParams, unknown>>): LimiterParams {
  return {
    ceiling: clampParam(params.ceiling, -20, 0, DEFAULT_LIMITER.ceiling),
    lookahead: clampParam(params.lookahead, 0, 20, DEFAULT_LIMITER.lookahead),
    release: clampParam(params.release, 1, 1000, DEFAULT_LIMITER.release),
  };
}

/**
 * Sliding-window minimum over [i − radius, i + radius].
 * @param values input.
 * @param radius half window.
 * @returns the minima.
 */
export function slidingMin(values: Float32Array, radius: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const deque = new Int32Array(n + 1);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i += 1) {
    const right = Math.min(n - 1, i + radius);
    while (next <= right) {
      while (tail > head && values[deque[tail - 1]!]! >= values[next]!) tail -= 1;
      deque[tail] = next;
      tail += 1;
      next += 1;
    }
    while (deque[head]! < i - radius) head += 1;
    out[i] = values[deque[head]!]!;
  }
  return out;
}

/**
 * Limits a buffer offline.
 * @param buffer the source.
 * @param params settings.
 * @returns the limited buffer and its gain curve.
 */
export function processLimiter(buffer: AudioBufferLike, params: LimiterParams): { buffer: AudioBufferLike; gain: Float32Array } {
  const p = sanitizeLimiter(params);
  const ceiling = dbToGain(p.ceiling);
  const channels = copyChannels(buffer);
  const peak = linkedPeak(channels);
  const n = peak.length;
  const required = new Float32Array(n);
  for (let i = 0; i < n; i += 1) required[i] = peak[i]! > ceiling ? ceiling / peak[i]! : 1;
  const radius = Math.max(0, Math.round((p.lookahead / 1000) * buffer.sampleRate));
  const minimum = radius > 0 ? slidingMin(required, radius) : required;
  const gain = new Float32Array(n);
  if (radius > 0) {
    // Box mean via prefix sums.
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i]! + minimum[i]!;
    for (let i = 0; i < n; i += 1) {
      const from = Math.max(0, i - radius);
      const to = Math.min(n - 1, i + radius);
      gain[i] = (prefix[to + 1]! - prefix[from]!) / (to - from + 1);
    }
  } else {
    gain.set(minimum);
  }
  const releaseStep = 1 - Math.exp(-1 / ((p.release / 1000) * buffer.sampleRate));
  let previous = 1;
  for (let i = 0; i < n; i += 1) {
    const recovered = previous + (1 - previous) * releaseStep;
    const g = Math.min(gain[i]!, recovered);
    gain[i] = g;
    previous = g;
    for (const channel of channels) {
      // Final clamp only absorbs float rounding; the gain already guarantees it.
      channel[i] = Math.max(-ceiling, Math.min(ceiling, channel[i]! * g));
    }
  }
  return { buffer: createAudioBuffer(channels, buffer.sampleRate), gain };
}

/** The slice of `WaveShaperNode` the limiter drives. */
export interface WaveShaperLike {
  curve: Float32Array | null;
  oversample: OverSampleType;
  connect(destination: unknown): unknown;
  disconnect(): void;
}

/**
 * A hard clip transfer curve at `ceiling`.
 * @param ceiling linear ceiling.
 * @param points curve resolution.
 * @returns the curve for a `WaveShaperNode`.
 */
export function clipCurve(ceiling: number, points = 2049): Float32Array {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.max(-ceiling, Math.min(ceiling, x));
  }
  return curve;
}

/**
 * Builds the realtime limiter: compressor (fast, hard knee) → clipper.
 * @param createCompressor `() => ctx.createDynamicsCompressor()`.
 * @param createShaper `() => ctx.createWaveShaper()`.
 * @param params settings.
 * @returns input/output nodes and a disposer.
 */
export function createLimiterChain(
  createCompressor: () => CompressorNodeLike,
  createShaper: () => WaveShaperLike,
  params: LimiterParams,
): { input: CompressorNodeLike; output: WaveShaperLike; dispose(): void } {
  const p = sanitizeLimiter(params);
  const input = createCompressor();
  input.threshold.value = p.ceiling - 1;
  input.knee.value = 0;
  input.ratio.value = 20;
  input.attack.value = 0.001;
  input.release.value = p.release / 1000;
  const output = createShaper();
  output.curve = clipCurve(dbToGain(p.ceiling));
  output.oversample = '4x';
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
