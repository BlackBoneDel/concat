// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Trilinear 3D LUT application and GPU upload helpers. */

import { describe, expect, it } from 'vitest';
import { applyLut, lutCoordOffset, lutCoordScale, lutToHalfRgba, sampleLut, toHalf } from '../src/media/vision/lut-applier.ts';
import { builtinLut, generateLut } from '../src/media/vision/lut-loader.ts';

const identity = generateLut('id', 'id', 17, (r, g, b) => [r, g, b]);
const invert = generateLut('inv', 'inv', 2, (r, g, b) => [1 - r, 1 - g, 1 - b]);

describe('sampleLut', () => {
  it('is exact on an identity table, including between lattice points', () => {
    for (const c of [[0, 0, 0], [1, 1, 1], [0.3, 0.6, 0.9], [0.123, 0.456, 0.789]] as const) {
      const out = sampleLut(identity, c[0], c[1], c[2]);
      out.forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 6));
    }
  });

  it('interpolates trilinearly (linear functions are reproduced on a 2³ table)', () => {
    const out = sampleLut(invert, 0.25, 0.5, 0.75);
    expect(out[0]).toBeCloseTo(0.75, 9);
    expect(out[1]).toBeCloseTo(0.5, 9);
    expect(out[2]).toBeCloseTo(0.25, 9);
    // Clamps outside the domain.
    expect(sampleLut(invert, -1, 2, 0.5)[0]).toBe(1);
  });
});

describe('applyLut', () => {
  it('applies with strength and leaves alpha', () => {
    const px = new Uint8ClampedArray([0, 128, 255, 77]);
    applyLut(px, invert, 1);
    expect(Array.from(px)).toEqual([255, 127, 0, 77]);
    const half = new Uint8ClampedArray([0, 0, 0, 255]);
    applyLut(half, invert, 0.5);
    expect(half[0]).toBe(128);
    const none = new Uint8ClampedArray([10, 20, 30, 255]);
    applyLut(none, invert, 0);
    expect(Array.from(none)).toEqual([10, 20, 30, 255]);
  });

  it('is fast enough on the CPU fallback', () => {
    const px = new Uint8ClampedArray(320 * 180 * 4).fill(100);
    const look = builtinLut('builtin:teal-orange')!;
    const t0 = performance.now();
    applyLut(px, look, 1);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('GPU helpers', () => {
  it('addresses texel centres and encodes half floats', () => {
    expect(lutCoordScale(17)).toBeCloseTo(16 / 17, 12);
    expect(lutCoordOffset(17)).toBeCloseTo(0.5 / 17, 12);
    expect(toHalf(0)).toBe(0);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(1e-9)).toBe(0);
    expect(toHalf(3e-5)).toBeGreaterThan(0);
    const texels = lutToHalfRgba(invert);
    expect(texels.length).toBe(8 * 4);
    expect(texels[0]).toBe(0x3c00);
    expect(texels[3]).toBe(0x3c00);
  });
});
