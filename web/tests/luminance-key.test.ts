// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Luma key (OBS luma_key_filter). */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LUMA_KEY, applyLumaKey, lumaAlpha, validateLumaKey } from '../src/media/vision/luminance-key.ts';

describe('luma key', () => {
  it('keeps the band, keys below/above with soft edges', () => {
    const p = { enabled: true, min: 0.2, max: 0.8, smoothness: 0.1, invert: false };
    expect(lumaAlpha(0.05, p)).toBe(0);
    expect(lumaAlpha(0.5, p)).toBe(1);
    expect(lumaAlpha(0.95, p)).toBe(0);
    expect(lumaAlpha(0.15, p)).toBeCloseTo(0.5, 6);
    expect(lumaAlpha(0.85, p)).toBeCloseTo(0.5, 6);
    expect(lumaAlpha(0.5, { ...p, invert: true })).toBe(0);
  });

  it('keys black out of RGBA pixels', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 200]);
    applyLumaKey(px, DEFAULT_LUMA_KEY);
    expect(px[3]).toBe(0);
    expect(px[7]).toBe(255);
    expect(px[11]).toBe(200);
    const off = new Uint8ClampedArray([0, 0, 0, 255]);
    applyLumaKey(off, { ...DEFAULT_LUMA_KEY, enabled: false });
    expect(off[3]).toBe(255);
  });

  it('validates the range', () => {
    expect(validateLumaKey({})).toEqual(DEFAULT_LUMA_KEY);
    expect(() => validateLumaKey({ min: 0.9, max: 0.1 })).toThrow(/mínimo/);
    expect(() => validateLumaKey({ smoothness: 3 })).toThrow(/suavidad/);
    expect(validateLumaKey({ invert: true }).invert).toBe(true);
  });
});
