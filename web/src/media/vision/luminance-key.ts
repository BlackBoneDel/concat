// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Luma key: keeps pixels whose BT.709 luma lies in [min, max], with soft
 * edges of width `smoothness` on both sides (OBS `luma_key_filter`):
 *   alpha = smoothstep(min − s, min, Y) · (1 − smoothstep(max, max + s, Y))
 * `invert` keys the band out instead of in.
 */

import { LUMA_709, smoothstep } from './color-space.ts';

/** Luma key settings. */
export interface LumaKeyParams {
  enabled: boolean;
  /** Lowest kept luma, 0–1. */
  min: number;
  /** Highest kept luma, 0–1. */
  max: number;
  /** Soft edge width, 0–1. */
  smoothness: number;
  invert: boolean;
}

/** Keys out black (keeps everything above 10 % luma). */
export const DEFAULT_LUMA_KEY: Readonly<LumaKeyParams> = Object.freeze({ enabled: true, min: 0.1, max: 1, smoothness: 0.05, invert: false });

/**
 * Validates settings.
 * @param p candidate.
 * @returns valid settings.
 */
export function validateLumaKey(p: Partial<LumaKeyParams>): LumaKeyParams {
  const min = Number(p.min ?? DEFAULT_LUMA_KEY.min);
  const max = Number(p.max ?? DEFAULT_LUMA_KEY.max);
  const smoothness = Number(p.smoothness ?? DEFAULT_LUMA_KEY.smoothness);
  for (const [name, v] of [['mínimo', min], ['máximo', max], ['suavidad', smoothness]] as const) {
    if (!(v >= 0 && v <= 1)) throw new RangeError(`Luma key: ${name} debe estar entre 0 y 1`);
  }
  if (min > max) throw new RangeError('Luma key: el mínimo no puede superar al máximo');
  return { enabled: p.enabled !== false, min, max, smoothness, invert: p.invert === true };
}

/**
 * Alpha factor for a luma value.
 * @param y luma 0..1.
 * @param p settings.
 * @returns 0..1.
 */
export function lumaAlpha(y: number, p: LumaKeyParams): number {
  const s = p.smoothness;
  const a = smoothstep(p.min - s, p.min, y) * (1 - smoothstep(p.max, p.max + s, y));
  return p.invert ? 1 - a : a;
}

/**
 * Keys RGBA pixels in place.
 * @param pixels `ImageData.data`.
 * @param params settings.
 */
export function applyLumaKey(pixels: Uint8ClampedArray, params: LumaKeyParams): void {
  if (!params.enabled) return;
  for (let i = 0; i < pixels.length; i += 4) {
    const y = (pixels[i]! * LUMA_709[0] + pixels[i + 1]! * LUMA_709[1] + pixels[i + 2]! * LUMA_709[2]) / 255;
    pixels[i + 3] = pixels[i + 3]! * lumaAlpha(y, params);
  }
}
