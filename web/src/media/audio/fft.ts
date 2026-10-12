// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * In-place radix-2 FFT for the phase vocoder (`pitch-shift.ts`).
 *
 * Iterative Cooley–Tukey: bit-reversal permutation, then log2(n) butterfly
 * passes with precomputed twiddles. Reference: Cooley & Tukey, "An algorithm
 * for the machine calculation of complex Fourier series", Math. Comp. 1965.
 */

/** A reusable FFT of one power-of-two size. */
export class FFT {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reversed: Uint32Array;

  /**
   * @param size transform length (power of two, ≥ 2).
   */
  constructor(size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new RangeError(`El tamaño de la FFT debe ser potencia de dos (recibido ${size})`);
    }
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i += 1) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let i = 0; i < size; i += 1) {
      let r = 0;
      for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reversed[i] = r;
    }
  }

  /**
   * Transforms `re`/`im` in place.
   * @param re real parts (length `size`).
   * @param im imaginary parts (length `size`).
   * @param inverse true for the inverse transform (scaled by 1/n).
   */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size;
    for (let i = 0; i < n; i += 1) {
      const j = this.reversed[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k += 1) {
          const wr = this.cos[k * step]!;
          const wi = sign * this.sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i += 1) {
        re[i] = re[i]! / n;
        im[i] = im[i]! / n;
      }
    }
  }
}

/**
 * A periodic Hann window (sums to a constant under 75 % overlap).
 * @param size window length.
 * @returns the window.
 */
export function hann(size: number): Float64Array {
  const out = new Float64Array(size);
  for (let i = 0; i < size; i += 1) out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return out;
}
