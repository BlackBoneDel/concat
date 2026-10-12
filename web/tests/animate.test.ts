// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import { Animation, Ease, Key, KeyTrack, bezierYAtX } from '../src/core/animate.ts';

describe('Ease', () => {
  it('passes a linear ride through untouched', () => {
    expect(Ease.LINEAR.apply(0.25)).toBe(0.25);
    expect(Ease.LINEAR.isLinear()).toBe(true);
    expect(Ease.IN_OUT.isLinear()).toBe(false);
  });

  it('solves a CSS cubic-bezier at its endpoints and between', () => {
    expect(bezierYAtX(0.42, 0, 0.58, 1, 0)).toBeCloseTo(0, 7);
    expect(bezierYAtX(0.42, 0, 0.58, 1, 1)).toBeCloseTo(1, 7);
    // ease-in-out at 0.5 is the centre of the curve.
    expect(bezierYAtX(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 5);
    // A monotone solve: more x never means less y for these presets.
    let previous = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const y = Ease.IN_OUT.apply(x);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
  });
});

describe('KeyTrack', () => {
  it('holds its ends and eases between — the Rust test, ported', () => {
    const track = new KeyTrack([new Key(0.5, 1, Ease.LINEAR), new Key(0, 0, Ease.LINEAR)]);
    expect(track.valueAt(-1, 7)).toBe(0);
    expect(track.valueAt(0.25, 7)).toBeCloseTo(0.5, 12);
    expect(track.valueAt(0.5, 7)).toBe(1);
    expect(track.valueAt(2, 7)).toBe(1);
  });

  it('returns the rest value with no keys', () => {
    const track = new KeyTrack([]);
    expect(track.valueAt(0.5, 7)).toBe(7);
    expect(track.isEmpty()).toBe(true);
  });

  it('sorts keys on the way in', () => {
    const track = new KeyTrack([new Key(1, 3), new Key(0, 1), new Key(0.5, 2)]);
    expect(track.all().map((key) => key.at)).toEqual([0, 0.5, 1]);
  });

  it('resamples an eased ride into straight segments', () => {
    const track = new KeyTrack([new Key(0, 0, Ease.LINEAR), new Key(1, 1, Ease.IN_OUT)]);
    const resampled = track.resample(4);
    // Linear segments pass through untouched; only the eased one grows.
    expect(resampled.all().length).toBeGreaterThan(2);
    for (const key of resampled.all()) {
      expect(key.ease.isLinear()).toBe(true);
    }
    // The same ride at the ends.
    expect(resampled.valueAt(0, 0)).toBeCloseTo(0, 12);
    expect(resampled.valueAt(1, 0)).toBeCloseTo(1, 12);
  });
});

describe('Animation', () => {
  const keys = (pairs: [number, number][]) =>
    new KeyTrack(pairs.map(([at, value]) => new Key(at, value, Ease.LINEAR)));

  it('rides the base transform and opacity', () => {
    const animation = new Animation(
      keys([
        [0, 1],
        [1, 2],
      ]), // scale factor doubles over the clip
      keys([]),
      keys([]),
      keys([
        [0, 0],
        [1, 90],
      ]), // +90 degrees at the end
      keys([
        [0, 1],
        [1, 0],
      ]),
      keys([]),
    );
    expect(animation.isEmpty()).toBe(false);

    const base = { scale: 2, offset_x: 0.1, offset_y: 0.2, rotation: 10, stretch_x: 1, stretch_y: 1 };
    const half = animation.transformAt(base, 0.5);
    expect(half.scale).toBeCloseTo(3, 12); // 2 * 1.5
    expect(half.rotation).toBeCloseTo(55, 12); // 10 + 45
    expect(half.offset_x).toBeCloseTo(0.1, 12);
    expect(animation.opacityAt(0.5, 0.5)).toBeCloseTo(0.25, 12); // 0.5 base * 0.5 ride
  });

  it('keeps gain unclamped at the top, clamped at the bottom', () => {
    const animation = new Animation(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      keys([
        [0, 2],
        [1, -1],
      ]),
    );
    expect(animation.volumeAt(1, 0)).toBe(2);
    expect(animation.volumeAt(1, 1)).toBe(0);
  });
});
