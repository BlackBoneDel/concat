// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Chroma key — CPU reference implementation (also the Canvas 2D fallback).
 *
 * Mirrors OBS Studio's `chroma_key_filter_v2.effect` (GPL-2.0, algorithm
 * only): distance in BT.709 Cb/Cr between the pixel and the key colour,
 *   base  = d − similarity
 *   alpha = saturate(base / smoothness)^1.5
 *   spill = saturate(base / spill)^1.5
 *   rgb   = mix(luma(rgb), rgb, spill)   // desaturate edge spill
 * Luminance is ignored by construction, so shadows on the screen key out
 * cleanly. The GPU path (`chroma-shader.ts`) evaluates the same expression.
 */

import { checkRgb255, rgbToCbCr, saturate, LUMA_709, type Rgb255 } from './color-space.ts';

/** Chroma key settings. */
export interface ChromaKeyParams {
  enabled: boolean;
  /** Key colour, RGB 0–255. */
  color: Rgb255;
  /** Cb/Cr distance keyed out completely, 0–1. */
  similarity: number;
  /** Width of the soft edge, 0–1. */
  smoothness: number;
  /** Spill desaturation reach, 0–1 (0 = off). */
  spill: number;
}

/** Green-screen defaults (OBS: similarity 400/1000, smoothness 80/1000, spill 100/1000). */
export const DEFAULT_CHROMA_KEY: Readonly<ChromaKeyParams> = Object.freeze<ChromaKeyParams>({
  enabled: true,
  color: [0, 255, 0],
  similarity: 0.4,
  smoothness: 0.08,
  spill: 0.1,
});

/** A 0–1 number or throw. */
function unit(name: string, value: unknown): number {
  const n = Number(value);
  if (!(n >= 0 && n <= 1)) throw new RangeError(`${name} debe estar entre 0 y 1 (recibido ${String(value)})`);
  return n;
}

/**
 * Validates chroma settings (Spanish errors).
 * @param params candidate.
 * @returns valid settings.
 */
export function validateChromaKey(params: { enabled?: unknown; color?: unknown; similarity?: unknown; smoothness?: unknown; spill?: unknown }): ChromaKeyParams {
  return {
    enabled: params.enabled !== false,
    color: checkRgb255(params.color ?? DEFAULT_CHROMA_KEY.color),
    similarity: unit('La similitud', params.similarity ?? DEFAULT_CHROMA_KEY.similarity),
    smoothness: unit('La suavidad', params.smoothness ?? DEFAULT_CHROMA_KEY.smoothness),
    spill: unit('La reducción de derrame', params.spill ?? DEFAULT_CHROMA_KEY.spill),
  };
}

/**
 * Key alpha and spill factor of one pixel (all 0..1).
 * @param r red.
 * @param g green.
 * @param b blue.
 * @param keyCbCr Cb/Cr of the key colour.
 * @param p settings.
 * @returns `[alpha, spill]`.
 */
export function chromaMask(r: number, g: number, b: number, keyCbCr: readonly [number, number], p: ChromaKeyParams): [number, number] {
  const [cb, cr] = rgbToCbCr(r, g, b);
  const d = Math.hypot(cb - keyCbCr[0], cr - keyCbCr[1]);
  const base = d - p.similarity;
  const alpha = p.smoothness > 0 ? saturate(base / p.smoothness) ** 1.5 : base > 0 ? 1 : 0;
  const spill = p.spill > 0 ? saturate(base / p.spill) ** 1.5 : 1;
  return [alpha, spill];
}

/**
 * Keys RGBA pixels in place.
 * @param pixels `ImageData.data`.
 * @param params settings.
 */
export function applyChromaKey(pixels: Uint8ClampedArray, params: ChromaKeyParams): void {
  if (!params.enabled) return;
  const key = rgbToCbCr(params.color[0] / 255, params.color[1] / 255, params.color[2] / 255);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]! / 255;
    const g = pixels[i + 1]! / 255;
    const b = pixels[i + 2]! / 255;
    const [alpha, spill] = chromaMask(r, g, b, key, params);
    if (spill < 1) {
      const luma = saturate(r * LUMA_709[0] + g * LUMA_709[1] + b * LUMA_709[2]);
      pixels[i] = (luma + (r - luma) * spill) * 255;
      pixels[i + 1] = (luma + (g - luma) * spill) * 255;
      pixels[i + 2] = (luma + (b - luma) * spill) * 255;
    }
    pixels[i + 3] = pixels[i + 3]! * alpha;
  }
}

/** The slice of a 2D context the colour picker reads. */
export interface PixelReader {
  readonly canvas: { width: number; height: number };
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray; width: number; height: number };
}

/**
 * Average colour around a canvas point — the key-colour picker.
 * @param ctx a 2D context over the preview.
 * @param x canvas x.
 * @param y canvas y.
 * @param radius half-size of the sampled square (0 = one pixel).
 * @returns the RGB colour, 0–255.
 */
export function pickColorFromCanvas(ctx: PixelReader, x: number, y: number, radius = 2): Rgb255 {
  const r = Math.max(0, Math.trunc(radius));
  const x0 = Math.max(0, Math.min(ctx.canvas.width - 1, Math.round(x) - r));
  const y0 = Math.max(0, Math.min(ctx.canvas.height - 1, Math.round(y) - r));
  const w = Math.max(1, Math.min(ctx.canvas.width - x0, 2 * r + 1));
  const h = Math.max(1, Math.min(ctx.canvas.height - y0, 2 * r + 1));
  const { data } = ctx.getImageData(x0, y0, w, h);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    sr += data[i]!;
    sg += data[i + 1]!;
    sb += data[i + 2]!;
    count += 1;
  }
  return count === 0 ? [0, 0, 0] : [Math.round(sr / count), Math.round(sg / count), Math.round(sb / count)];
}
