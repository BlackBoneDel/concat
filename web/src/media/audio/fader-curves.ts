// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fade curves for clip fades.
 *
 * The Rust renderer fades with FFmpeg's `afade` (linear by default; see
 * `src/crates/concat-media/src/audio.rs`, `mix_graph_from`). The web port
 * keeps linear as the default and adds the curve set of common NLEs. Every curve maps
 * `t ∈ [0, 1]` (fraction of the fade elapsed) to a gain in `[0, 1]`:
 *
 * | curve        | g(t)                    |
 * | ------------ | ----------------------- |
 * | linear       | t                       |
 * | exponential  | t²                      |
 * | logarithmic  | ln(1 + t·(e − 1))       |
 * | sCurve       | 3t² − 2t³ (smoothstep)  |
 * | easeIn       | t³                      |
 * | easeOut      | 1 − (1 − t)³            |
 */

import { createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';

/** The supported curve shapes. */
export type FadeCurve = 'linear' | 'exponential' | 'logarithmic' | 'sCurve' | 'easeIn' | 'easeOut';

/** Every curve, in UI order. */
export const FADE_CURVES: readonly FadeCurve[] = ['linear', 'exponential', 'logarithmic', 'sCurve', 'easeIn', 'easeOut'];

/** Spanish UI labels. */
export const FADE_CURVE_LABELS: Readonly<Record<FadeCurve, string>> = {
  linear: 'Lineal',
  exponential: 'Exponencial',
  logarithmic: 'Logarítmica',
  sCurve: 'Curva S',
  easeIn: 'Entrada suave',
  easeOut: 'Salida suave',
};

/**
 * Narrows a string to a curve.
 * @param value anything.
 * @returns true for a known curve.
 */
export function isFadeCurve(value: unknown): value is FadeCurve {
  return typeof value === 'string' && (FADE_CURVES as readonly string[]).includes(value);
}

/**
 * Gain of a curve at `t`.
 * @param curve the shape.
 * @param t fraction of the fade elapsed (clamped to 0..1).
 * @returns the gain, 0..1.
 */
export function sampleCurve(curve: FadeCurve, t: number): number {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  switch (curve) {
    case 'linear':
      return x;
    case 'exponential':
      return x * x;
    case 'logarithmic':
      return Math.log(1 + x * (Math.E - 1));
    case 'sCurve':
      return x * x * (3 - 2 * x);
    case 'easeIn':
      return x * x * x;
    case 'easeOut':
      return 1 - (1 - x) ** 3;
  }
}

/** One fade of a clip. */
export interface FadeSpec {
  /** Seconds. */
  duration: number;
  curve: FadeCurve;
}

/**
 * Gain of a clip at `time` given its fades — the offline twin of the mixer's
 * automation.
 * @param time seconds into the clip.
 * @param clipDuration clip length in seconds.
 * @param fadeIn the fade-in (or null).
 * @param fadeOut the fade-out (or null).
 * @returns the gain, 0..1.
 */
export function fadeGainAt(time: number, clipDuration: number, fadeIn: FadeSpec | null, fadeOut: FadeSpec | null): number {
  let gain = 1;
  if (fadeIn && fadeIn.duration > 0 && time < fadeIn.duration) gain *= sampleCurve(fadeIn.curve, time / fadeIn.duration);
  if (fadeOut && fadeOut.duration > 0) {
    const left = clipDuration - time;
    if (left < fadeOut.duration) gain *= sampleCurve(fadeOut.curve, left / fadeOut.duration);
  }
  return gain;
}

/**
 * Tabulates a curve for `AudioParam.setValueCurveAtTime`.
 * @param curve the shape.
 * @param level the gain the fade reaches (fade-in) or starts from (fade-out).
 * @param direction `'in'` rises 0→level, `'out'` falls level→0.
 * @param points table size (≥ 2).
 * @returns the values.
 */
export function curveTable(curve: FadeCurve, level: number, direction: 'in' | 'out', points = 128): Float32Array {
  const count = Math.max(2, Math.trunc(points));
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    out[i] = level * sampleCurve(curve, direction === 'in' ? t : 1 - t);
  }
  return out;
}

/**
 * Renders fades into a copy of a buffer.
 * @param buffer the source.
 * @param fades the fade-in/out (either may be omitted).
 * @returns a new buffer with the gain applied.
 */
export function applyFade(buffer: AudioBufferLike, fades: { fadeIn?: FadeSpec | null; fadeOut?: FadeSpec | null }): AudioBufferLike {
  const rate = buffer.sampleRate;
  const total = buffer.length / rate;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const source = buffer.getChannelData(c);
    const out = new Float32Array(source.length);
    for (let i = 0; i < source.length; i += 1) {
      out[i] = source[i]! * fadeGainAt(i / rate, total, fades.fadeIn ?? null, fades.fadeOut ?? null);
    }
    channels.push(out);
  }
  return createAudioBuffer(channels, rate);
}
