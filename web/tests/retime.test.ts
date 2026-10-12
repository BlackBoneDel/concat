// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import { SpeedCurve } from '../src/core/retime.ts';

describe('SpeedCurve', () => {
  it('a flat curve is a constant speed — the Rust test, ported', () => {
    const curve = SpeedCurve.new([
      [0, 2],
      [1, 2],
    ])!;
    expect(curve.speedAt(0.3)).toBeCloseTo(2, 12);
    expect(curve.consumed(0.5)).toBeCloseTo(1, 12);
    expect(curve.mean()).toBeCloseTo(2, 12);
  });

  it('anchors the ends and the area is exact', () => {
    const curve = SpeedCurve.new([
      [0.25, 1],
      [0.75, 3],
    ])!;
    const points = curve.all();
    expect(points[0]).toEqual([0, 1]);
    expect(points[points.length - 1]).toEqual([1, 3]);
    expect(curve.speedAt(0.5)).toBeCloseTo(2, 12);
    // 0..0.25 at 1, 0.25..0.75 averaging 2, 0.75..1 at 3.
    expect(curve.mean()).toBeCloseTo(0.25 + 1 + 0.75, 12);
    expect(curve.consumed(0.5)).toBeCloseTo(0.25 + 0.25 * 1.5, 12);
  });

  it('pieces add up to the whole', () => {
    const curve = SpeedCurve.new([
      [0, 0.5],
      [0.5, 4],
      [1, 0.5],
    ])!;
    const pieces = curve.pieces(8);
    expect(pieces.length).toBe(8);
    const total = pieces.reduce((sum, [x0, x1, , mean]) => sum + (x1 - x0) * mean, 0);
    expect(total).toBeCloseTo(curve.mean(), 9);
    expect(pieces[3]![2]).toBeCloseTo(curve.consumed(3 / 8), 12);
  });

  it('nonsense is tidied or refused', () => {
    expect(SpeedCurve.new([])).toBeNull();
    const curve = SpeedCurve.new([
      [2, 0],
      [-1, 100],
    ])!;
    expect(curve.all()[0]).toEqual([0, SpeedCurve.MAX_SPEED]);
    expect(curve.all()[1]).toEqual([1, SpeedCurve.MIN_SPEED]);
  });
});
