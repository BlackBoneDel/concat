// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * 3D LUT application — CPU reference (Canvas 2D fallback) of the GPU path.
 *
 * Trilinear interpolation: the input colour falls in a lattice cell of 8
 * corners; the result interpolates along R, then G, then B (7 lerps). On the
 * GPU the table is a `TEXTURE_3D` (RGBA16F, `LINEAR` filtering) and the
 * sampler does exactly this; texel centres are addressed with
 * `uv = c·(n−1)/n + 0.5/n` (see `lutCoordScale/Offset`). `strength` mixes
 * the result with the input.
 */

import type { Lut3D } from './lut-loader.ts';

/**
 * Samples a table at one colour (trilinear).
 * @param lut the table.
 * @param r red 0..1.
 * @param g green 0..1.
 * @param b blue 0..1.
 * @param out receives the colour.
 * @returns `out`.
 */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const n = lut.size;
  const max = n - 1;
  const fr = Math.min(max, Math.max(0, r * max));
  const fg = Math.min(max, Math.max(0, g * max));
  const fb = Math.min(max, Math.max(0, b * max));
  const r0 = Math.min(max - 1, Math.floor(fr));
  const g0 = Math.min(max - 1, Math.floor(fg));
  const b0 = Math.min(max - 1, Math.floor(fb));
  const tr = fr - r0;
  const tg = fg - g0;
  const tb = fb - b0;
  const d = lut.data;
  const at = (ri: number, gi: number, bi: number): number => ((bi * n + gi) * n + ri) * 3;
  const i000 = at(r0, g0, b0);
  const i100 = at(r0 + 1, g0, b0);
  const i010 = at(r0, g0 + 1, b0);
  const i110 = at(r0 + 1, g0 + 1, b0);
  const i001 = at(r0, g0, b0 + 1);
  const i101 = at(r0 + 1, g0, b0 + 1);
  const i011 = at(r0, g0 + 1, b0 + 1);
  const i111 = at(r0 + 1, g0 + 1, b0 + 1);
  for (let c = 0; c < 3; c += 1) {
    const c00 = d[i000 + c]! + (d[i100 + c]! - d[i000 + c]!) * tr;
    const c10 = d[i010 + c]! + (d[i110 + c]! - d[i010 + c]!) * tr;
    const c01 = d[i001 + c]! + (d[i101 + c]! - d[i001 + c]!) * tr;
    const c11 = d[i011 + c]! + (d[i111 + c]! - d[i011 + c]!) * tr;
    const c0 = c00 + (c10 - c00) * tg;
    const c1 = c01 + (c11 - c01) * tg;
    out[c] = c0 + (c1 - c0) * tb;
  }
  return out;
}

/**
 * Applies a table to RGBA pixels in place.
 * @param pixels `ImageData.data` (sRGB, the space display LUTs expect).
 * @param lut the table.
 * @param strength 0 (off) … 1 (full).
 */
export function applyLut(pixels: Uint8ClampedArray, lut: Lut3D, strength = 1): void {
  const s = Math.min(1, Math.max(0, strength));
  if (s === 0) return;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]! / 255;
    const g = pixels[i + 1]! / 255;
    const b = pixels[i + 2]! / 255;
    sampleLut(lut, r, g, b, out);
    pixels[i] = (r + (out[0] - r) * s) * 255;
    pixels[i + 1] = (g + (out[1] - g) * s) * 255;
    pixels[i + 2] = (b + (out[2] - b) * s) * 255;
  }
}

/** Texture-coordinate scale for a table side (texel-centre addressing). */
export function lutCoordScale(size: number): number {
  return (size - 1) / size;
}

/** Texture-coordinate offset for a table side. */
export function lutCoordOffset(size: number): number {
  return 0.5 / size;
}

/**
 * Float32 → IEEE 754 half (for RGBA16F uploads).
 * @param value the float.
 * @returns the half bits.
 */
export function toHalf(value: number): number {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = value;
  const x = u[0]!;
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  const rounded = mant + 0x1000;
  if (rounded & 0x800000) {
    mant = 0;
    exp += 1;
    if (exp >= 31) return sign | 0x7c00;
    return sign | (exp << 10);
  }
  return sign | (exp << 10) | (rounded >> 13);
}

/**
 * RGBA16F texel data of a table (alpha 1).
 * @param lut the table.
 * @returns half-float texels.
 */
export function lutToHalfRgba(lut: Lut3D): Uint16Array {
  const texels = lut.size ** 3;
  const out = new Uint16Array(texels * 4);
  const one = toHalf(1);
  for (let i = 0; i < texels; i += 1) {
    out[i * 4] = toHalf(lut.data[i * 3]!);
    out[i * 4 + 1] = toHalf(lut.data[i * 3 + 1]!);
    out[i * 4 + 2] = toHalf(lut.data[i * 3 + 2]!);
    out[i * 4 + 3] = one;
  }
  return out;
}
