// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Biquad filters: coefficient design, response and offline processing.
 *
 * Coefficients follow Robert Bristow-Johnson's "Cookbook formulae for audio
 * EQ biquad filter coefficients" — the same formulas `BiquadFilterNode`
 * implements, so offline renders match realtime playback.
 */

/** The filter types the equalizer exposes (a subset of `BiquadFilterType`). */
export type BiquadType = 'highpass' | 'lowpass' | 'peaking' | 'lowshelf' | 'highshelf' | 'notch' | 'bandpass';

/** Normalised coefficients (a0 = 1). */
export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Designs one biquad.
 * @param type filter type.
 * @param frequency centre/corner frequency in Hz.
 * @param q quality factor (for shelves: slope-equivalent Q).
 * @param gainDb gain for peaking/shelf filters.
 * @param sampleRate samples per second.
 * @returns normalised coefficients.
 */
export function designBiquad(type: BiquadType, frequency: number, q: number, gainDb: number, sampleRate: number): BiquadCoefficients {
  const f = Math.min(Math.max(frequency, 1), sampleRate / 2 - 1);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(q, 1e-4));
  const A = 10 ** (gainDb / 40);
  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cos; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Magnitude response |H(e^jω)| at one frequency.
 * @param c coefficients.
 * @param frequency Hz.
 * @param sampleRate samples per second.
 * @returns linear magnitude.
 */
export function biquadMagnitude(c: BiquadCoefficients, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const ni = -(c.b1 * sin1 + c.b2 * sin2);
  const dr = 1 + c.a1 * cos1 + c.a2 * cos2;
  const di = -(c.a1 * sin1 + c.a2 * sin2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/**
 * Filters samples in place (transposed direct form II, double precision state).
 * @param data samples.
 * @param c coefficients.
 */
export function biquadProcess(data: Float32Array, c: BiquadCoefficients): void {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < data.length; i += 1) {
    const x = data[i]!;
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    data[i] = y;
  }
}
