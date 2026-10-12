// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Placement mathematics: fitting, matrices, inversion, hit-testing. */

import { describe, expect, it } from 'vitest';
import { Transform } from '../src/core/timeline.ts';
import {
  applyPoint,
  composeMatrices,
  fitRect,
  inverseTransform,
  inverseTransformPoint,
  invertMatrix,
  transformMatrix,
  type Mat2D,
} from '../src/render/index.ts';

describe('fitRect', () => {
  it('fits a wide source with pillarbox letterboxing', () => {
    const fitted = fitRect(1920, 1080, 1080, 1080);
    expect(fitted.w).toBeCloseTo(1080, 6);
    expect(fitted.h).toBeCloseTo(607.5, 6);
    expect(fitted.x).toBeCloseTo(0, 6);
    expect(fitted.y).toBeCloseTo((1080 - 607.5) / 2, 6);
  });

  it('fits a tall source with letterboxing', () => {
    const fitted = fitRect(1080, 1920, 1920, 1080);
    expect(fitted.h).toBeCloseTo(1080, 6);
    expect(fitted.w).toBeCloseTo(607.5, 6);
    expect(fitted.x).toBeCloseTo((1920 - 607.5) / 2, 6);
  });

  it('fills the frame when the aspect ratios match', () => {
    const fitted = fitRect(1280, 720, 1920, 1080);
    expect(fitted).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('falls back to the frame for a degenerate source', () => {
    expect(fitRect(0, 0, 100, 50)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });
});

describe('transformMatrix', () => {
  it('centres the picture at frame centre for the identity', () => {
    const m = transformMatrix(new Transform(), 1920, 1080, 1920, 1080);
    // The fitted centre (960, 540) must land on the frame centre.
    const centre = applyPoint(m, 960, 540);
    expect(centre.x).toBeCloseTo(960, 6);
    expect(centre.y).toBeCloseTo(540, 6);
  });

  it('moves the picture by the offset fractions', () => {
    const transform = new Transform(1, 0.25, -0.5, 0, 1, 1);
    const m = transformMatrix(transform, 1920, 1080, 1920, 1080);
    const centre = applyPoint(m, 960, 540);
    expect(centre.x).toBeCloseTo(960 + 0.25 * 1920, 6);
    expect(centre.y).toBeCloseTo(540 - 0.5 * 1080, 6);
  });

  it('scales around the picture centre', () => {
    const transform = new Transform(2, 0, 0, 0, 1, 1);
    const m = transformMatrix(transform, 1920, 1080, 1920, 1080);
    // A point one pixel right of centre ends up two pixels right of centre.
    const moved = applyPoint(m, 961, 540);
    expect(moved.x).toBeCloseTo(962, 6);
  });

  it('rotates 90° clockwise (screen coords)', () => {
    const transform = new Transform(1, 0, 0, 90, 1, 1);
    const m = transformMatrix(transform, 200, 100, 200, 100);
    // A point 50 above the centre (100, 0) goes 50 to its right.
    const moved = applyPoint(m, 100, 0);
    expect(moved.x).toBeCloseTo(150, 6);
    expect(moved.y).toBeCloseTo(50, 6);
  });
});

describe('matrix algebra', () => {
  it('inverts to the identity', () => {
    const transform = new Transform(1.3, 0.2, -0.1, 37, 1.1, 0.9);
    const m = transformMatrix(transform, 1920, 1080, 640, 480);
    const inverse = invertMatrix(m);
    expect(inverse).not.toBeNull();
    const identity = composeMatrices(m, inverse!);
    const expected: Mat2D = [1, 0, 0, 1, 0, 0];
    identity.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 6));
  });

  it('refuses to invert a degenerate matrix', () => {
    expect(invertMatrix([0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it('composes outer ∘ inner in the right order', () => {
    // inner: translate by (10, 0); outer: scale by 2.
    const inner: Mat2D = [1, 0, 0, 1, 10, 0];
    const outer: Mat2D = [2, 0, 0, 2, 0, 0];
    const composed = composeMatrices(outer, inner);
    const point = applyPoint(composed, 0, 0);
    expect(point.x).toBeCloseTo(20, 6);
    expect(point.y).toBeCloseTo(0, 6);
  });
});

describe('inverseTransform', () => {
  it('inverts the uniform family as an involution', () => {
    const transform = new Transform(2, 0.3, -0.2, 45, 1, 1);
    const inverse = inverseTransform(transform);
    const round = inverseTransform(inverse);
    expect(round.scale).toBeCloseTo(transform.scale, 6);
    expect(round.offset_x).toBeCloseTo(transform.offset_x, 6);
    expect(round.offset_y).toBeCloseTo(transform.offset_y, 6);
    expect(round.rotation % 360).toBeCloseTo(transform.rotation % 360, 6);
  });

  it('inverts plain building blocks', () => {
    const inverse = inverseTransform(new Transform(2, 0, 0, 0, 1, 1));
    expect(inverse.scale).toBeCloseTo(0.5, 6);
    const inverseRotation = inverseTransform(new Transform(1, 0, 0, 90, 1, 1));
    expect(inverseRotation.rotation).toBeCloseTo(-90, 6);
    const inverseOffset = inverseTransform(new Transform(1, 0.25, -0.5, 0, 1, 1));
    expect(inverseOffset.offset_x).toBeCloseTo(-0.25, 6);
    expect(inverseOffset.offset_y).toBeCloseTo(0.5, 6);
  });
});

describe('inverseTransformPoint', () => {
  it('is the exact hit-test, even with stretch', () => {
    const transform = new Transform(1.4, 0.1, 0.05, 23, 1.7, 0.8);
    const source = { x: 321, y: 123 };
    const forward = transformMatrix(transform, 1920, 1080, 640, 480);
    const screen = applyPoint(forward, source.x, source.y);
    const back = inverseTransformPoint(transform, 1920, 1080, 640, 480, screen.x, screen.y);
    expect(back).not.toBeNull();
    expect(back!.x).toBeCloseTo(source.x, 4);
    expect(back!.y).toBeCloseTo(source.y, 4);
  });

  it('returns null for a degenerate transform', () => {
    const degenerate = new Transform(0, 0, 0, 0, 1, 1);
    expect(inverseTransformPoint(degenerate, 1920, 1080, 640, 480, 10, 10)).toBeNull();
  });
});

