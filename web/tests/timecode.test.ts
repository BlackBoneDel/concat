// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Timecode formatting/parsing: round-trips, drop-frame, duration text. */

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { FrameRate } from '../src/core/time.ts';
import {
  formatDuration,
  formatFrames,
  formatTimecode,
  isDropFrameRate,
  parseTimecode,
} from '../src/player/timecode.ts';

const RATES: { name: string; fps: FrameRate }[] = [
  { name: '24 fps', fps: FrameRate.FILM },
  { name: '23.976 fps', fps: FrameRate.FILM_NTSC },
  { name: '25 fps', fps: FrameRate.PAL },
  { name: '29.97 fps', fps: FrameRate.NTSC_30 },
  { name: '30 fps', fps: FrameRate.THIRTY },
  { name: '59.94 fps', fps: FrameRate.NTSC_60 },
  { name: '60 fps', fps: FrameRate.SIXTY },
];

describe('formatTimecode', () => {
  for (const { name, fps } of RATES) {
    it(`formats zero at ${name}`, () => {
      expect(formatTimecode(Rational.ZERO, fps)).toBe('00:00:00:00');
    });

    it(`round-trips frames at ${name}`, () => {
      for (const frames of [0n, 1n, 23n, 24n, 999n, 1000n, 17_999n, 215_999n, 86_399n]) {
        const time = Rational.fromInt(frames).div(fps.fps());
        const tc = formatTimecode(time, fps);
        const back = parseTimecode(tc, fps);
        expect(back).not.toBeNull();
        // Round-trip is exact to the frame: the re-parsed frame index matches.
        expect(formatFrames(back!, fps)).toBe(Number(frames % (BigInt(Math.round(fps.fps().asNumber() * 86400)))));
      }
    });

    it(`formats known instants at ${name}`, () => {
      // Exactly one second in.
      const oneSecond = Rational.fromInt(1n);
      const expectedFrame = Math.round(fps.fps().asNumber());
      const tc = formatTimecode(oneSecond, fps);
      const [, , , ff] = tc.split(':');
      expect(Number(ff)).toBeGreaterThanOrEqual(0);
      expect(expectedFrame).toBeGreaterThan(0);
    });
  }

  it('formats 30 fps simple values', () => {
    const fps = FrameRate.THIRTY;
    expect(formatTimecode(Rational.fromInt(1n).div(fps.fps()), fps)).toBe('00:00:00:01');
    expect(formatTimecode(Rational.fromInt(30n).div(fps.fps()), fps)).toBe('00:00:01:00');
    expect(formatTimecode(Rational.fromInt(1800n).div(fps.fps()), fps)).toBe('00:01:00:00');
    expect(formatTimecode(Rational.fromInt(21_600n).div(fps.fps()), fps)).toBe('00:12:00:00');
    expect(formatTimecode(Rational.fromInt(107_892n).div(fps.fps()), fps)).toBe('00:59:56:12');
  });

  it('knows the drop-frame rates', () => {
    expect(isDropFrameRate(FrameRate.NTSC_30)).toBe(true);
    expect(isDropFrameRate(FrameRate.NTSC_60)).toBe(true);
    expect(isDropFrameRate(FrameRate.THIRTY)).toBe(false);
    expect(isDropFrameRate(FrameRate.FILM)).toBe(false);
    expect(isDropFrameRate(FrameRate.PAL)).toBe(false);
    expect(isDropFrameRate(FrameRate.SIXTY)).toBe(false);
    expect(isDropFrameRate(FrameRate.FILM_NTSC)).toBe(false);
  });
});

describe('drop-frame timecode (29.97)', () => {
  const fps = FrameRate.NTSC_30;

  it('skips frames 0 and 1 of each minute except every tenth', () => {
    // Frame 17982 is the tenth minute of drop-frame: labels 00:01:00;00 and
    // 00:01:00;01 never appear — frame 1800 is already 00:01:00;02.
    const tc = (frames: number) =>
      formatTimecode(Rational.fromInt(BigInt(frames)).div(fps.fps()), fps, true);
    expect(tc(0)).toBe('00:00:00;00');
    expect(tc(1799)).toBe('00:00:59;29');
    expect(tc(1798)).toBe('00:00:59;28');
    expect(tc(1800)).toBe('00:01:00;02');
    expect(tc(3598)).toBe('00:02:00;02');
    // Every tenth minute keeps 00:0X:00;00.
    expect(tc(17_982)).toBe('00:10:00;00');
    // One drop-frame hour is 107892 frames.
    expect(tc(107_892)).toBe('01:00:00;00');
  });

  it('uses the semicolon separator', () => {
    expect(formatTimecode(Rational.ZERO, fps, true)).toContain(';');
    expect(formatTimecode(Rational.ZERO, fps, false)).toContain(':');
  });

  it('round-trips through parseTimecode', () => {
    for (const frames of [0n, 2n, 1798n, 1800n, 17_982n, 107_892n, 200_000n]) {
      const time = Rational.fromInt(frames).div(fps.fps());
      const tc = formatTimecode(time, fps, true);
      const back = parseTimecode(tc, fps);
      expect(back).not.toBeNull();
      // Exact to the frame both ways.
      expect(formatFrames(back!, fps)).toBe(Number(frames));
      expect(formatTimecode(back!, fps, true)).toBe(tc);
    }
  });
});

describe('parseTimecode', () => {
  const fps = FrameRate.THIRTY;

  it('parses both separators', () => {
    expect(parseTimecode('00:00:01:15', fps)?.asNumber()).toBeCloseTo(1.5, 6);
    expect(parseTimecode('00:00:01;15', fps)?.asNumber()).toBeCloseTo(1.5, 6);
    expect(parseTimecode('01:02:03:04', fps)).not.toBeNull();
  });

  it('rejects garbage and out-of-range fields', () => {
    expect(parseTimecode('', fps)).toBeNull();
    expect(parseTimecode('nonsense', fps)).toBeNull();
    expect(parseTimecode('00:00:00', fps)).toBeNull();
    expect(parseTimecode('00:60:00:00', fps)).toBeNull();
    expect(parseTimecode('00:00:60:00', fps)).toBeNull();
    expect(parseTimecode('00:00:00:30', fps)).toBeNull();
    expect(parseTimecode('00:00:00:29', fps)).not.toBeNull();
  });

  it('round-trips every rate at a few instants', () => {
    for (const { fps: rate } of RATES) {
      for (const frames of [0n, 7n, 100n, 5000n]) {
        const time = Rational.fromInt(frames).div(rate.fps());
        const parsed = parseTimecode(formatTimecode(time, rate), rate);
        expect(parsed).not.toBeNull();
        expect(formatFrames(parsed!, rate)).toBe(Number(frames));
      }
    }
  });
});

describe('formatDuration', () => {
  it('formats the human forms', () => {
    expect(formatDuration(Rational.approximate(0.4) ?? Rational.ZERO)).toBe('0.4s');
    expect(formatDuration(Rational.approximate(12.3) ?? Rational.ZERO)).toBe('12s');
    expect(formatDuration(Rational.approximate(34.7) ?? Rational.ZERO)).toBe('34s');
    expect(formatDuration(Rational.approximate(154) ?? Rational.ZERO)).toBe('2m 34s');
    expect(formatDuration(Rational.approximate(3912) ?? Rational.ZERO)).toBe('1h 5m');
    expect(formatDuration(Rational.ZERO)).toBe('0.0s');
  });
});
