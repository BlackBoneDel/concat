// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { FrameRate, TimeRange } from '../src/core/time.ts';

describe('FrameRate', () => {
  it('holds the standard rates', () => {
    expect(FrameRate.THIRTY.fps().equals(Rational.fromInt(30n))).toBe(true);
    expect(FrameRate.NTSC_30.fps().equals(Rational.new(30000n, 1001n))).toBe(true);
  });

  it('maps frames to timestamps and back without drift', () => {
    // The module's own doctest.
    const rate = FrameRate.NTSC_30;
    const t = rate.timeOfFrame(1800n);
    expect(t.equals(Rational.new(60060n, 1000n))).toBe(true);
    expect(rate.frameAt(t)).toBe(1800n);
  });

  it('treats frames as half-open intervals', () => {
    const rate = FrameRate.THIRTY;
    // Exactly on a boundary belongs to the frame that starts there.
    expect(rate.frameAt(rate.timeOfFrame(10n))).toBe(10n);
    const justBefore = rate.timeOfFrame(10n).sub(Rational.new(1n, 1_000_000n));
    expect(rate.frameAt(justBefore)).toBe(9n);
  });

  it('counts whole frames in a duration', () => {
    expect(FrameRate.THIRTY.framesIn(Rational.fromInt(2n))).toBe(60n);
    expect(FrameRate.THIRTY.framesIn(Rational.new(59n, 30n))).toBe(59n);
  });

  it('refuses rates no video has, but takes the long ones that reduce', () => {
    expect(FrameRate.checked(0, 1)).toBeNull();
    expect(FrameRate.checked(30, 0)).toBeNull();
    expect(FrameRate.checked(-30, 1)).toBeNull();
    expect(FrameRate.checked(2_000_000, 1)).toBeNull();
    // 60000000/2002000 is 30/1 in lowest terms and is taken.
    expect(FrameRate.checked(60_000_000, 2_002_000)).not.toBeNull();
  });
});

describe('TimeRange', () => {
  it('is half-open: [start, start + duration)', () => {
    const range = new TimeRange(Rational.fromInt(2n), Rational.fromInt(3n));
    expect(range.end().equals(Rational.fromInt(5n))).toBe(true);
    expect(range.contains(Rational.fromInt(2n))).toBe(true);
    expect(range.contains(Rational.new(9n, 2n))).toBe(true);
    expect(range.contains(Rational.fromInt(5n))).toBe(false);
    expect(range.contains(Rational.fromInt(1n))).toBe(false);
  });

  it('detects overlap', () => {
    const a = new TimeRange(Rational.fromInt(0n), Rational.fromInt(3n));
    const b = new TimeRange(Rational.fromInt(2n), Rational.fromInt(3n));
    const c = new TimeRange(Rational.fromInt(3n), Rational.fromInt(1n));
    expect(a.overlaps(b)).toBe(true);
    // Half-open: [0,3) and [3,4) share no instant.
    expect(a.overlaps(c)).toBe(false);
  });
});
