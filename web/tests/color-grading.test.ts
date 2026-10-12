// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Linear-light grading (port of the concat-effects scene-linear library). */

import { describe, expect, it } from 'vitest';
import {
  GRADING_LABELS,
  GRADING_RANGES,
  MID_GREY,
  NEUTRAL_GRADING,
  applyColorGrading,
  fromLog,
  gradeLinear,
  isNeutralGrading,
  planGrading,
  planckian,
  sanitizeGrading,
  toLog,
  whiteBalanceMatrix,
  type ColorGradingParams,
} from '../src/media/vision/color-grading.ts';
import { linearToSrgb } from '../src/media/vision/color-space.ts';

const grade = (patch: Partial<ColorGradingParams>, rgb: [number, number, number]): [number, number, number] =>
  gradeLinear([...rgb], planGrading({ ...NEUTRAL_GRADING, ...patch }));

describe('color grading', () => {
  it('is an identity when neutral', () => {
    expect(isNeutralGrading(NEUTRAL_GRADING)).toBe(true);
    const out = grade({}, [0.2, 0.4, 0.6]);
    out.forEach((v, i) => expect(v).toBeCloseTo([0.2, 0.4, 0.6][i]!, 5));
    const px = new Uint8ClampedArray([10, 128, 250, 255]);
    applyColorGrading(px, NEUTRAL_GRADING);
    expect(Array.from(px)).toEqual([10, 128, 250, 255]);
  });

  it('exposure doubles light per stop', () => {
    expect(grade({ exposure: 1 }, [0.1, 0.2, 0.3])[1]).toBeCloseTo(0.4, 5);
    expect(grade({ exposure: -2 }, [0.4, 0.4, 0.4])[0]).toBeCloseTo(0.1, 5);
  });

  it('contrast pivots around 18 % grey and never goes negative', () => {
    expect(grade({ contrast: 1.8 }, [MID_GREY, MID_GREY, MID_GREY])[0]).toBeCloseTo(MID_GREY, 6);
    expect(grade({ contrast: 1.5 }, [0.5, 0.5, 0.5])[0]).toBeGreaterThan(0.5);
    expect(grade({ contrast: 1.5 }, [0.05, 0.05, 0.05])[0]).toBeLessThan(0.05);
    expect(grade({ contrast: 2 }, [0, 0.001, 0])[0]).toBeGreaterThanOrEqual(0);
    expect(grade({ contrast: 2 }, [0, 0.001, 0])[0]).toBeLessThan(1e-9);
    expect(grade({ contrast: 0 }, [0.9, 0.01, 0.4])[0]).toBeCloseTo(MID_GREY, 6);
  });

  it('white balance keeps greys grey-luminance and warms/cools', () => {
    const wb = whiteBalanceMatrix(6500, 0);
    expect(wb[0]).toBeCloseTo(1, 4);
    expect(wb[4]).toBeCloseTo(1, 4);
    const warm = grade({ temperature: 3200 }, [0.5, 0.5, 0.5]);
    const cool = grade({ temperature: 10000 }, [0.5, 0.5, 0.5]);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
    const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(luma(warm)).toBeCloseTo(0.5, 3);
    const magenta = grade({ tint: 50 }, [0.5, 0.5, 0.5]);
    expect(magenta[1]).toBeLessThan(magenta[0]);
    const [u, v] = planckian(6500);
    // Planckian locus at 6500 K (Krystek 1985): x≈0.3135, y≈0.3236 → CIE 1960 uv.
    expect(u).toBeCloseTo(0.2004, 3);
    expect(v).toBeCloseTo(0.3104, 3);
  });

  it('saturation, vibrance and hue act about luminance', () => {
    const grey = grade({ saturation: 0 }, [0.8, 0.2, 0.1]);
    expect(grey[0]).toBeCloseTo(grey[1], 9);
    const rich = grade({ saturation: 1.5 }, [0.6, 0.3, 0.3]);
    expect(rich[0] - rich[1]).toBeGreaterThan(0.3);
    const muted = grade({ vibrance: 1 }, [0.5, 0.45, 0.45]);
    const vivid = grade({ vibrance: 1 }, [0.9, 0.05, 0.05]);
    expect((muted[0] - muted[1]) / 0.05).toBeGreaterThan((vivid[0] - vivid[1]) / 0.85);
    const rotated = grade({ hue: 120 }, [1, 0, 0]);
    expect(rotated[1]).toBeCloseTo(1, 6);
    expect(rotated[0]).toBeCloseTo(0, 6);
  });

  it('tonal controls move their range in log space', () => {
    const shadow = 0.03;
    const highlight = 0.7;
    expect(grade({ shadows: 1 }, [shadow, shadow, shadow])[0]).toBeGreaterThan(shadow * 1.3);
    expect(grade({ shadows: 1 }, [highlight, highlight, highlight])[0]).toBeCloseTo(highlight, 1);
    expect(grade({ highlights: -1 }, [highlight, highlight, highlight])[0]).toBeLessThan(highlight * 0.8);
    expect(grade({ blacks: -1 }, [0.004, 0.004, 0.004])[0]).toBeLessThan(0.004);
    expect(grade({ whites: 1 }, [1, 1, 1])[0]).toBeGreaterThan(1);
    for (const v of [0, 0.001, 0.18, 1, 16]) expect(fromLog(toLog(v))).toBeCloseTo(v, 5);
    expect(toLog(0.18)).toBeCloseTo(0.4135, 3);
  });

  it('applies gamma and a split view on 8-bit pixels', () => {
    const px = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255]);
    applyColorGrading(px, { ...NEUTRAL_GRADING, gamma: 2 }, 0.5, 2);
    expect(px[0]).toBe(128); // left half untouched
    expect(px[4]).toBe(Math.round(255 * (128 / 255) ** 0.5));
    const lit = new Uint8ClampedArray([64, 64, 64, 255]);
    applyColorGrading(lit, { ...NEUTRAL_GRADING, exposure: 1 });
    expect(lit[0]).toBeGreaterThan(80);
    expect(lit[3]).toBe(255);
    expect(linearToSrgb(-1)).toBe(0);
  });

  it('sanitises controls and exposes ranges/labels', () => {
    const s = sanitizeGrading({ exposure: 99, temperature: 'x', hue: -500, gamma: 0 });
    expect(s.exposure).toBe(5);
    expect(s.temperature).toBe(6500);
    expect(s.hue).toBe(-180);
    expect(s.gamma).toBe(0.2);
    expect(Object.keys(GRADING_RANGES)).toHaveLength(12);
    expect(Object.keys(GRADING_LABELS)).toEqual(Object.keys(NEUTRAL_GRADING));
  });
});
