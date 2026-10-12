// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Despill: dominant channel limited to the mean of the others. */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SPILL, dominantChannel, suppressSpill } from '../src/media/vision/spill-suppression.ts';

describe('suppressSpill', () => {
  it('limits green to the mean of red and blue', () => {
    const px = new Uint8ClampedArray([100, 200, 60, 255]);
    suppressSpill(px, [0, 255, 0], { enabled: true, amount: 1, preserveLuminance: false });
    expect(Array.from(px)).toEqual([100, 80, 60, 255]);
  });

  it('blends by amount and restores luminance when asked', () => {
    const half = new Uint8ClampedArray([100, 200, 60, 255]);
    suppressSpill(half, [0, 255, 0], { enabled: true, amount: 0.5, preserveLuminance: false });
    expect(half[1]).toBe(140);
    const lit = new Uint8ClampedArray([100, 200, 60, 255]);
    suppressSpill(lit, [0, 255, 0], DEFAULT_SPILL);
    const lost = 120 * 0.7152;
    expect(lit[0]).toBe(Math.round(100 + lost));
    expect(lit[1]).toBe(Math.round(80 + lost));
  });

  it('leaves pixels without spill and disabled settings alone', () => {
    const px = new Uint8ClampedArray([200, 100, 50, 255, 10, 20, 30, 128]);
    const copy = Array.from(px);
    suppressSpill(px, [0, 255, 0], DEFAULT_SPILL);
    expect(Array.from(px)).toEqual(copy);
    const spilled = new Uint8ClampedArray([0, 255, 0, 255]);
    suppressSpill(spilled, [0, 255, 0], { ...DEFAULT_SPILL, enabled: false });
    suppressSpill(spilled, [0, 255, 0], { ...DEFAULT_SPILL, amount: 0 });
    expect(spilled[1]).toBe(255);
  });

  it('handles blue and red keys', () => {
    expect(dominantChannel([0, 255, 0])).toBe(1);
    expect(dominantChannel([20, 40, 230])).toBe(2);
    expect(dominantChannel([230, 40, 20])).toBe(0);
    const px = new Uint8ClampedArray([50, 70, 220, 255]);
    suppressSpill(px, [0, 0, 255], { enabled: true, amount: 1, preserveLuminance: false });
    expect(px[2]).toBe(60);
  });
});
