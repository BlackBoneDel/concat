// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fade curve shapes and offline fades. */

import { describe, expect, it } from 'vitest';
import {
  FADE_CURVES,
  FADE_CURVE_LABELS,
  applyFade,
  curveTable,
  fadeGainAt,
  isFadeCurve,
  sampleCurve,
} from '../src/media/audio/fader-curves.ts';
import { bufferOf } from './f4-helpers.ts';

describe('sampleCurve', () => {
  it('implements each formula exactly', () => {
    const t = 0.3;
    expect(sampleCurve('linear', t)).toBeCloseTo(0.3, 12);
    expect(sampleCurve('exponential', t)).toBeCloseTo(0.09, 12);
    expect(sampleCurve('logarithmic', t)).toBeCloseTo(Math.log(1 + 0.3 * (Math.E - 1)), 12);
    expect(sampleCurve('sCurve', t)).toBeCloseTo(3 * 0.09 - 2 * 0.027, 12);
    expect(sampleCurve('easeIn', t)).toBeCloseTo(0.027, 12);
    expect(sampleCurve('easeOut', t)).toBeCloseTo(1 - 0.7 ** 3, 12);
  });

  it('starts at 0, ends at 1, is monotonic, and clamps', () => {
    for (const curve of FADE_CURVES) {
      expect(sampleCurve(curve, 0)).toBeCloseTo(0, 12);
      expect(sampleCurve(curve, 1)).toBeCloseTo(1, 12);
      let previous = -1;
      for (let i = 0; i <= 100; i += 1) {
        const v = sampleCurve(curve, i / 100);
        expect(v).toBeGreaterThanOrEqual(previous);
        previous = v;
      }
      expect(sampleCurve(curve, -1)).toBe(sampleCurve(curve, 0));
      expect(sampleCurve(curve, 2)).toBe(sampleCurve(curve, 1));
      expect(sampleCurve(curve, Number.NaN)).toBe(sampleCurve(curve, 0));
      expect(FADE_CURVE_LABELS[curve].length).toBeGreaterThan(0);
    }
    expect(isFadeCurve('sCurve')).toBe(true);
    expect(isFadeCurve('cubic')).toBe(false);
  });
});

describe('fades', () => {
  it('computes clip gain with both fades', () => {
    const fadeIn = { duration: 1, curve: 'linear' as const };
    const fadeOut = { duration: 2, curve: 'exponential' as const };
    expect(fadeGainAt(0.5, 10, fadeIn, fadeOut)).toBeCloseTo(0.5, 12);
    expect(fadeGainAt(5, 10, fadeIn, fadeOut)).toBe(1);
    expect(fadeGainAt(9, 10, fadeIn, fadeOut)).toBeCloseTo(0.25, 12);
    expect(fadeGainAt(0.5, 10, null, null)).toBe(1);
  });

  it('renders fades into a copy and tabulates curves for Web Audio', () => {
    const source = bufferOf([new Float32Array(100).fill(1)], 100);
    const out = applyFade(source, { fadeIn: { duration: 0.5, curve: 'linear' }, fadeOut: { duration: 0.5, curve: 'easeIn' } });
    const data = out.getChannelData(0);
    expect(data[0]).toBe(0);
    expect(data[25]).toBeCloseTo(0.5, 6);
    expect(data[75]).toBeCloseTo(0.125, 6);
    expect(source.getChannelData(0)[0]).toBe(1);
    const table = curveTable('sCurve', 0.8, 'in', 5);
    expect(table[0]).toBe(0);
    expect(table[4]).toBeCloseTo(0.8, 6);
    expect(table[2]).toBeCloseTo(0.4, 6);
    const down = curveTable('linear', 1, 'out', 3);
    expect(Array.from(down)).toEqual([1, 0.5, 0]);
    expect(curveTable('linear', 1, 'in', 1).length).toBe(2);
  });
});
