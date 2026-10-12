// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Frame rates and spans of time — a faithful port of the `FrameRate` and
 * `TimeRange` halves of `concat-core/src/time.rs`.
 *
 * Frames are half-open intervals: a timestamp exactly on a boundary belongs to
 * the frame that starts there. The same convention runs through
 * {@link TimeRange}.
 */

import { Rational } from './rational.ts';

/** Output frame rate, held as an exact fraction of frames per second. */
export class FrameRate {
  private readonly rate: Rational;

  private constructor(rate: Rational) {
    this.rate = rate;
    Object.freeze(this);
  }

  /** 24000/1001 — film on NTSC tape. */
  static readonly FILM_NTSC: FrameRate = FrameRate.new(Rational.new(24000n, 1001n));
  /** 24 fps. */
  static readonly FILM: FrameRate = FrameRate.new(Rational.fromInt(24n));
  /** 25 fps — PAL. */
  static readonly PAL: FrameRate = FrameRate.new(Rational.fromInt(25n));
  /** 30000/1001 — NTSC video. */
  static readonly NTSC_30: FrameRate = FrameRate.new(Rational.new(30000n, 1001n));
  /** 30 fps. */
  static readonly THIRTY: FrameRate = FrameRate.new(Rational.fromInt(30n));
  /** 60000/1001 — NTSC high rate. */
  static readonly NTSC_60: FrameRate = FrameRate.new(Rational.new(60000n, 1001n));
  /** 60 fps. */
  static readonly SIXTY: FrameRate = FrameRate.new(Rational.fromInt(60n));

  /**
   * The largest term {@link FrameRate.checked} takes. Every rate a camera or a
   * standard uses is a few thousand over a thousand and one at most; terms
   * past this only come from a hand-edited document, and frame arithmetic on
   * them overflows.
   */
  static readonly MAX_TERM: bigint = 1_000_000n;

  /**
   * Builds a frame rate from an exact fraction of frames per second.
   * Throws when `fps` is zero or negative — the same contract as Rust
   * `FrameRate::new`.
   */
  static new(fps: Rational): FrameRate {
    if (fps.isZero() || fps.isNegative()) {
      throw new Error('frame rate must be positive');
    }
    return new FrameRate(fps);
  }

  /**
   * The rate `num / den`, or `null` for one no video has: a zero or negative
   * term, or one past {@link FrameRate.MAX_TERM} in lowest terms —
   * `60000000/2002000` is 29.97 and taken. The non-panicking path for a rate
   * that comes from a document or a request rather than from a constant.
   * Port of `FrameRate::checked`.
   */
  static checked(num: bigint | number, den: bigint | number): FrameRate | null {
    const n = typeof num === 'bigint' ? num : BigInt(Math.trunc(num));
    const d = typeof den === 'bigint' ? den : BigInt(Math.trunc(den));
    if (n <= 0n || d <= 0n) return null;
    const rate = Rational.new(n, d);
    const within = (term: bigint) => term >= 1n && term <= FrameRate.MAX_TERM;
    return within(rate.numerator()) && within(rate.denominator())
      ? new FrameRate(rate)
      : null;
  }

  /** Builds a whole-number frame rate. */
  static fromInt(fps: number): FrameRate {
    return FrameRate.new(Rational.fromInt(BigInt(Math.trunc(fps))));
  }

  /** Frames per second. */
  fps(): Rational {
    return this.rate;
  }

  /** How long one frame lasts, in seconds. */
  frameDuration(): Rational {
    return this.rate.recip();
  }

  /** The timestamp at which frame `index` begins. Frame 0 begins at zero. */
  timeOfFrame(index: bigint): Rational {
    return Rational.fromInt(index).mul(this.frameDuration());
  }

  /** The index of the frame that is on screen at `time`. */
  frameAt(time: Rational): bigint {
    return time.mul(this.rate).floor();
  }

  /** How many whole frames fit in `duration`. */
  framesIn(duration: Rational): bigint {
    return duration.mul(this.rate).floor();
  }

  /** e.g. `"29.970 fps"` — display only; never parse this back. */
  toString(): string {
    return `${this.rate.asNumber().toFixed(3)} fps`;
  }
}

/** A half-open span of time, `[start, start + duration)`. */
export class TimeRange {
  readonly start: Rational;
  readonly duration: Rational;

  constructor(start: Rational, duration: Rational) {
    this.start = start;
    this.duration = duration;
    Object.freeze(this);
  }

  /** The timestamp one instant past the range. */
  end(): Rational {
    return this.start.add(this.duration);
  }

  /** True when `time` falls inside `[start, start + duration)`. */
  contains(time: Rational): boolean {
    return this.start.compare(time) <= 0 && time.compare(this.end()) < 0;
  }

  /** True when the two spans share any instant. */
  overlaps(other: TimeRange): boolean {
    return this.start.compare(other.end()) < 0 && other.start.compare(this.end()) < 0;
  }
}
