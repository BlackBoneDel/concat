// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Colour-space helpers shared by the vision modules.
 *
 * sRGB transfer functions follow IEC 61966-2-1; luma weights and the
 * Cb/Cr matrix are BT.709 (studio swing, as in OBS Studio's
 * `chroma_key_filter_v2.effect`, which the chroma key mirrors).
 */

/** BT.709 luma weights (linear or gamma-encoded RGB). */
export const LUMA_709: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * sRGB-encoded 0..1 → linear light.
 * @param v encoded value.
 * @returns linear value.
 */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * Linear light → sRGB-encoded 0..1.
 * @param v linear value.
 * @returns encoded value.
 */
export function linearToSrgb(v: number): number {
  const c = v <= 0 ? 0 : v;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** 8-bit sRGB → linear lookup table. */
export const SRGB_TO_LINEAR_8: Float32Array = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = srgbToLinear(i / 255);
  return table;
})();

/**
 * BT.709 chroma (Cb, Cr) of an RGB triple in 0..1 — OBS's key space.
 * @param r red.
 * @param g green.
 * @param b blue.
 * @returns `[cb, cr]`, each about 0..1.
 */
export function rgbToCbCr(r: number, g: number, b: number): [number, number] {
  return [
    -0.100644 * r - 0.338572 * g + 0.439216 * b + 0.501961,
    0.439216 * r - 0.398942 * g - 0.040274 * b + 0.501961,
  ];
}

/** Clamp to 0..1. */
export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * GLSL `smoothstep`.
 * @param edge0 lower edge.
 * @param edge1 upper edge.
 * @param x value.
 * @returns 0..1.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** An RGB colour, 0–255 per channel. */
export type Rgb255 = [number, number, number];

/**
 * Validates an RGB colour (integers 0–255).
 * @param value anything.
 * @returns the colour.
 */
export function checkRgb255(value: unknown): Rgb255 {
  if (!Array.isArray(value) || value.length !== 3) throw new RangeError('El color debe ser [r, g, b]');
  const out = value.map((v) => Number(v));
  if (!out.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) throw new RangeError('Cada canal RGB debe ser un entero 0–255');
  return [out[0]!, out[1]!, out[2]!];
}

/**
 * `#rrggbb` → RGB.
 * @param hex CSS hex colour.
 * @returns the colour, or `null` when malformed.
 */
export function hexToRgb(hex: string): Rgb255 | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** RGB → `#rrggbb`. */
export function rgbToHex([r, g, b]: Rgb255): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}
