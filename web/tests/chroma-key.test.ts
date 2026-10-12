// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Chroma key (OBS v2 algorithm) — CPU reference. */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHROMA_KEY,
  applyChromaKey,
  chromaMask,
  pickColorFromCanvas,
  validateChromaKey,
} from '../src/media/vision/chroma-key.ts';
import { checkRgb255, hexToRgb, linearToSrgb, rgbToCbCr, rgbToHex, smoothstep, srgbToLinear } from '../src/media/vision/color-space.ts';
import { solid } from './f4-helpers.ts';

const GREEN = rgbToCbCr(0, 1, 0);

describe('chroma key', () => {
  it('keys the screen colour out and keeps distant colours', () => {
    const p = { ...DEFAULT_CHROMA_KEY };
    expect(chromaMask(0, 1, 0, GREEN, p)[0]).toBe(0);
    expect(chromaMask(1, 0, 0, GREEN, p)[0]).toBe(1);
    expect(chromaMask(0.5, 0.5, 0.5, GREEN, p)[0]).toBe(1);
    // Darker green (shadow on the screen) is keyed too: luminance is ignored.
    expect(chromaMask(0, 0.6, 0, GREEN, p)[0]).toBe(0);
  });

  it('produces a soft edge across `smoothness` and hard edges at 0', () => {
    const p = { ...DEFAULT_CHROMA_KEY, similarity: 0.2, smoothness: 0.2 };
    const alphas = [0, 0.25, 0.5, 0.75, 1].map((t) => chromaMask(t, 1 - t * 0.5, t, GREEN, p)[0]);
    expect(alphas[0]).toBe(0);
    expect(alphas.some((a) => a > 0 && a < 1)).toBe(true);
    for (let i = 1; i < alphas.length; i += 1) expect(alphas[i]!).toBeGreaterThanOrEqual(alphas[i - 1]!);
    const hard = { ...p, smoothness: 0 };
    expect([0, 1]).toContain(chromaMask(0.3, 0.8, 0.3, GREEN, hard)[0]);
  });

  it('applies alpha and desaturates spill in RGBA buffers', () => {
    const pixels = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255, 120, 200, 120, 255]);
    applyChromaKey(pixels, { ...DEFAULT_CHROMA_KEY, similarity: 0.25, smoothness: 0.1, spill: 0.4 });
    expect(pixels[3]).toBe(0);
    expect(Array.from(pixels.subarray(4, 8))).toEqual([255, 0, 0, 255]);
    // The greenish pixel keeps opacity but loses green dominance.
    expect(pixels[11]).toBeGreaterThan(0);
    expect(pixels[9]! - pixels[8]!).toBeLessThan(80);
    const untouched = new Uint8ClampedArray([0, 255, 0, 255]);
    applyChromaKey(untouched, { ...DEFAULT_CHROMA_KEY, enabled: false });
    expect(untouched[3]).toBe(255);
  });

  it('keys a blue screen too', () => {
    const pixels = solid(2, 2, [0, 0, 255, 255]);
    applyChromaKey(pixels, { ...DEFAULT_CHROMA_KEY, color: [0, 0, 255] });
    expect(pixels[3]).toBe(0);
  });

  it('validates parameters with Spanish errors', () => {
    expect(validateChromaKey({})).toEqual(DEFAULT_CHROMA_KEY);
    expect(() => validateChromaKey({ similarity: 2 })).toThrow(/similitud/);
    expect(() => validateChromaKey({ smoothness: -0.1 })).toThrow(/suavidad/);
    expect(() => validateChromaKey({ spill: 'x' })).toThrow(/derrame/);
    expect(() => validateChromaKey({ color: [0, 256, 0] })).toThrow(/0–255/);
    expect(() => validateChromaKey({ color: [0, 1] })).toThrow(/\[r, g, b\]/);
    expect(validateChromaKey({ enabled: false }).enabled).toBe(false);
  });

  it('picks an averaged colour from a canvas', () => {
    const data = solid(10, 10, [10, 200, 30, 255]);
    data.set([250, 250, 250, 255], (5 * 10 + 5) * 4);
    const reader = {
      canvas: { width: 10, height: 10 },
      getImageData: (sx: number, sy: number, sw: number, sh: number) => {
        const out = new Uint8ClampedArray(sw * sh * 4);
        for (let y = 0; y < sh; y += 1) out.set(data.subarray(((sy + y) * 10 + sx) * 4, ((sy + y) * 10 + sx + sw) * 4), y * sw * 4);
        return { data: out, width: sw, height: sh };
      },
    };
    expect(pickColorFromCanvas(reader, 2, 2, 1)).toEqual([10, 200, 30]);
    expect(pickColorFromCanvas(reader, 5, 5, 0)).toEqual([250, 250, 250]);
    const avg = pickColorFromCanvas(reader, 5, 5, 1);
    expect(avg[0]).toBe(Math.round((10 * 8 + 250) / 9));
    expect(pickColorFromCanvas(reader, -50, 99, 2)).toEqual([10, 200, 30]); // clamped to the canvas
  });
});

describe('color-space helpers', () => {
  it('round-trips sRGB and hex, and validates colours', () => {
    for (const v of [0, 0.01, 0.2, 0.5, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    expect(hexToRgb('#00ff80')).toEqual([0, 255, 128]);
    expect(hexToRgb('nope')).toBeNull();
    expect(rgbToHex([0, 255, 128])).toBe('#00ff80');
    expect(checkRgb255(['1', 2, 3])).toEqual([1, 2, 3]);
    expect(smoothstep(1, 1, 0.5)).toBe(0);
    expect(smoothstep(1, 1, 2)).toBe(1);
  });
});
