// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 Bézier maths + keyframe curve/value operations. */

import { describe, expect, it } from 'vitest';
import { bezierYAtX } from '../src/core/animate.ts';
import {
  BEZIER_PRESETS,
  BEZIER_Y_LIMIT,
  MoveKeyframeValueOperation,
  UpdateKeyframeCurveOperation,
  clampBezier,
  evaluateBezier,
  percentToValue,
  presetOf,
  valueToPercent,
} from '../src/editor/keyframe-operations.ts';
import { AddKeyframeOperation, EditError, keyframeId } from '../src/editor/operations.ts';
import { KeyEase } from '../src/model/wire.ts';
import { clipById, r, snap } from './f3-helpers.ts';
import { makeF5Session } from './f5-helpers.ts';

describe('clampBezier', () => {
  it('clamps x1/x2 into [0,1] but leaves y free (within the editor limit)', () => {
    expect(clampBezier([-0.5, 1.4, 1.7, -0.6])).toEqual([0, 1.4, 1, -0.6]);
    expect(clampBezier([0.3, 9, 0.6, -9])).toEqual([0.3, BEZIER_Y_LIMIT, 0.6, -BEZIER_Y_LIMIT]);
  });

  it('replaces non-finite numbers with the linear defaults', () => {
    expect(clampBezier([Number.NaN, Number.POSITIVE_INFINITY])).toEqual([0, 0, 1, 1]);
  });
});

describe('evaluateBezier', () => {
  it('pins the endpoints P0(0,0) and P3(1,1)', () => {
    for (const curve of Object.values(BEZIER_PRESETS).filter((c) => c !== BEZIER_PRESETS.hold)) {
      expect(evaluateBezier(curve, 0)).toBeCloseTo(0, 5);
      expect(evaluateBezier(curve, 1)).toBeCloseTo(1, 5);
    }
  });

  it('is the identity for linear and matches the core solver otherwise', () => {
    expect(evaluateBezier(BEZIER_PRESETS.linear, 0.37)).toBeCloseTo(0.37, 9);
    const [x1, y1, x2, y2] = BEZIER_PRESETS.easeInOut;
    for (const x of [0.1, 0.25, 0.5, 0.8]) expect(evaluateBezier(BEZIER_PRESETS.easeInOut, x)).toBeCloseTo(bezierYAtX(x1, y1, x2, y2, x), 9);
    expect(evaluateBezier(BEZIER_PRESETS.easeInOut, 0.5)).toBeCloseTo(0.5, 3);
  });

  it('ease-in starts slow, ease-out starts fast', () => {
    expect(evaluateBezier(BEZIER_PRESETS.easeIn, 0.25)).toBeLessThan(0.25);
    expect(evaluateBezier(BEZIER_PRESETS.easeOut, 0.25)).toBeGreaterThan(0.25);
  });

  it('hold stays flat until the end', () => {
    expect(evaluateBezier(BEZIER_PRESETS.hold, 0.5)).toBeLessThan(0.05);
  });

  it('overshoot curves leave [0,1] in y', () => {
    const back: [number, number, number, number] = [0.3, -0.6, 0.7, 1.6];
    const ys = [0.05, 0.1, 0.9, 0.95].map((x) => evaluateBezier(back, x));
    expect(Math.min(...ys)).toBeLessThan(0);
    expect(Math.max(...ys)).toBeGreaterThan(1);
  });

  it('recognises presets', () => {
    expect(presetOf(BEZIER_PRESETS.easeOut)).toBe('easeOut');
    expect(presetOf([0.1, 0.2, 0.3, 0.4])).toBeNull();
  });
});

describe('value ↔ percent', () => {
  it('maps each property range to 0..100 and back', () => {
    expect(valueToPercent('opacity', 0.5)).toBe(50);
    expect(valueToPercent('rotation', 0)).toBe(50);
    expect(valueToPercent('scale', 99)).toBe(100);
    expect(percentToValue('offsetX', 75)).toBeCloseTo(0.5);
    expect(percentToValue('volume', -10)).toBe(0);
    for (const value of [0, 1.5, 4]) expect(percentToValue('scale', valueToPercent('scale', value))).toBeCloseTo(value);
  });
});

describe('keyframe operations', () => {
  function keyed() {
    const session = makeF5Session();
    session.run(new AddKeyframeOperation('c1', 'opacity', r(0), 0));
    session.run(new AddKeyframeOperation('c1', 'opacity', r(1), 1));
    return session;
  }

  it('UpdateKeyframeCurve stores the clamped curve and undoes it', () => {
    const session = keyed();
    const before = snap(session.document);
    const id = keyframeId('opacity', 0.5);
    expect(session.run(new UpdateKeyframeCurveOperation('c1', 'opacity', id, [1.5, 2, -1, 1]))).toBe(true);
    const key = clipById(session, 'c1').keys.find((k) => k.at === 0.5)!;
    expect(key.ease.points).toEqual([1, 2, 0, 1]);
    session.undo();
    expect(snap(session.document)).toBe(before);
    expect(clipById(session, 'c1').keys.find((k) => k.at === 0.5)!.ease).toEqual(KeyEase.LINEAR);
  });

  it('curve drags merge; validation errors throw', () => {
    const session = keyed();
    const id = keyframeId('opacity', 0.5);
    const a = new UpdateKeyframeCurveOperation('c1', 'opacity', id, [0.1, 0, 1, 1]);
    const b = new UpdateKeyframeCurveOperation('c1', 'opacity', id, [0.2, 0, 1, 1]);
    expect(a.merge(b)).toBe(b);
    expect(a.merge(new UpdateKeyframeCurveOperation('c1', 'opacity', keyframeId('opacity', 0), [0, 0, 1, 1]))).toBeNull();
    expect(() => new UpdateKeyframeCurveOperation('c1', 'blur', id, [0, 0, 1, 1])).toThrow(EditError);
    expect(() => new UpdateKeyframeCurveOperation('c1', 'opacity', id, [0, 0, 1])).toThrow(/4 números/);
    expect(() => new UpdateKeyframeCurveOperation('c1', 'opacity', 'opacity@0.3', [0, 0, 1, 1]).apply(session.document)).toThrow(EditError);
  });

  it('MoveKeyframeValue clamps to the property range and restores exactly', () => {
    const session = keyed();
    const id = keyframeId('opacity', 0);
    session.run(new MoveKeyframeValueOperation('c1', 'opacity', id, 7));
    expect(clipById(session, 'c1').keys.find((k) => k.at === 0)!.value).toBe(1);
    session.undo();
    expect(clipById(session, 'c1').keys.find((k) => k.at === 0)!.value).toBe(0);
    expect(() => new MoveKeyframeValueOperation('c1', 'opacity', id, Number.NaN)).toThrow(EditError);
    expect(new MoveKeyframeValueOperation('c1', 'opacity', id, 5, false).value).toBe(5);
  });
});
