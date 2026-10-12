// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Colour-spill suppression ("despill").
 *
 * The key colour's dominant channel is limited to the average of the other
 * two — the classic green/blue-screen despill (see Steve Wright, "Digital
 * Compositing for Film and Video", ch. 4) — and the removed excess is blended
 * back by `amount`. Works for any key: the dominant channel is taken from the
 * key colour itself. Optional luminance restore adds back the luma lost so
 * despilled edges do not darken.
 */

import { LUMA_709, type Rgb255 } from './color-space.ts';

/** Despill settings. */
export interface SpillParams {
  enabled: boolean;
  /** 0–1 blend of the despilled result. */
  amount: number;
  /** Restore the luminance removed with the spill. */
  preserveLuminance: boolean;
}

/** Defaults: full despill with luminance restore. */
export const DEFAULT_SPILL: Readonly<SpillParams> = Object.freeze({ enabled: true, amount: 1, preserveLuminance: true });

/**
 * The channel a key colour dominates (0 = R, 1 = G, 2 = B).
 * @param key the key colour.
 * @returns channel index.
 */
export function dominantChannel(key: Rgb255): 0 | 1 | 2 {
  if (key[1] >= key[0] && key[1] >= key[2]) return 1;
  return key[2] >= key[0] ? 2 : 0;
}

/**
 * Despills RGBA pixels in place.
 * @param pixels `ImageData.data`.
 * @param key the key colour.
 * @param params settings.
 */
export function suppressSpill(pixels: Uint8ClampedArray, key: Rgb255, params: SpillParams): void {
  if (!params.enabled || params.amount <= 0) return;
  const amount = Math.min(1, params.amount);
  const d = dominantChannel(key);
  const o1 = (d + 1) % 3;
  const o2 = (d + 2) % 3;
  for (let i = 0; i < pixels.length; i += 4) {
    const c = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    const limit = (c[o1]! + c[o2]!) / 2;
    const excess = c[d]! - limit;
    if (excess <= 0) continue;
    const removed = excess * amount;
    c[d] = c[d]! - removed;
    if (params.preserveLuminance) {
      // Spread the lost luma evenly over all channels.
      const lost = removed * LUMA_709[d];
      c[0] = c[0]! + lost;
      c[1] = c[1]! + lost;
      c[2] = c[2]! + lost;
    }
    pixels[i] = c[0]!;
    pixels[i + 1] = c[1]!;
    pixels[i + 2] = c[2]!;
  }
}
