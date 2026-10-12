// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Matte choke + feather (3× box ≈ Gaussian). */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATHER, blurPlane, chokeAlpha, featherAlpha, validateFeather } from '../src/media/vision/edge-feather.ts';

function halfMatte(width: number, height: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      px.set([255, 255, 255, x < width / 2 ? 255 : 0], i);
    }
  }
  return px;
}

describe('edge feather', () => {
  it('softens a hard matte edge symmetrically, colour untouched', () => {
    const w = 40;
    const px = halfMatte(w, 4);
    featherAlpha(px, w, 4, { enabled: true, radius: 6, choke: 0 });
    const row = Array.from({ length: w }, (_, x) => px[(w + x) * 4 + 3]!);
    expect(row[0]).toBe(255);
    expect(row[w - 1]).toBe(0);
    expect(row[19]).toBeGreaterThan(100);
    expect(row[19]).toBeLessThan(255);
    expect(row[20]).toBeLessThan(155);
    expect(Math.abs(row[19]! + row[20]! - 255)).toBeLessThan(4);
    for (let x = 1; x < w; x += 1) expect(row[x]!).toBeLessThanOrEqual(row[x - 1]!);
    expect(px[0]).toBe(255);
  });

  it('chokes (shrinks/grows) the matte', () => {
    expect(chokeAlpha(0.5, 0)).toBe(0.5);
    expect(chokeAlpha(0.5, 0.5)).toBe(0);
    expect(chokeAlpha(0.75, 0.5)).toBeCloseTo(0.5, 9);
    expect(chokeAlpha(0.25, -0.5)).toBeCloseTo(0.5, 9);
    expect(chokeAlpha(1, -1)).toBe(1);
    const px = new Uint8ClampedArray([0, 0, 0, 128]);
    featherAlpha(px, 1, 1, { enabled: true, radius: 0, choke: 0.4 });
    expect(px[3]).toBeLessThan(128);
  });

  it('preserves the mean of a blurred plane (energy conserving)', () => {
    const plane = new Float32Array(64 * 8);
    for (let y = 0; y < 8; y += 1) plane.fill(1, y * 64 + 24, y * 64 + 40); // zero at the edges
    const before = plane.reduce((s, v) => s + v, 0);
    blurPlane(plane, 64, 8, 4);
    const after = plane.reduce((s, v) => s + v, 0);
    expect(Math.abs(after - before) / before).toBeLessThan(0.01);
  });

  it('validates and skips no-ops', () => {
    expect(validateFeather({})).toEqual(DEFAULT_FEATHER);
    expect(() => validateFeather({ radius: 60 })).toThrow(/0 y 50/);
    expect(() => validateFeather({ choke: 2 })).toThrow(/−1 y 1/);
    const px = halfMatte(4, 1);
    const copy = Array.from(px);
    featherAlpha(px, 4, 1, { enabled: true, radius: 0, choke: 0 });
    featherAlpha(px, 4, 1, { enabled: false, radius: 5, choke: 0 });
    expect(Array.from(px)).toEqual(copy);
  });
});
