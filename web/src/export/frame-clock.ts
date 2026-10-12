// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the export's frame clock — exact `Rational` arithmetic only, so
 * frame N always lands at `start + N / fps` without float drift (a
 * 10-minute 29.97 export never slips a frame). Port of the frame stepping in
 * `src/crates/concat-export/src/lib.rs::render_on`, which counts frames from
 * a checked `FrameRate`; the web version floors instead of rounding so the
 * last frame never samples past `end`.
 */

import { Rational } from '../core/rational.ts';
import { ExportError } from './types.ts';

/** Microseconds in a second, as a rational. */
const MICROS = Rational.fromInt(1_000_000);

/** Steps through `[start, end)` at an exact rate. */
export class FrameClock {
  /** First timeline instant exported. */
  readonly start: Rational;
  /** Exclusive end of the range. */
  readonly end: Rational;
  /** Frames per second. */
  readonly fps: Rational;
  /** `floor((end - start) * fps)`. */
  readonly totalFrames: number;

  /**
   * @param start range start (timeline seconds).
   * @param end range end (must be after `start`).
   * @param fps frames per second (must be positive).
   * @throws ExportError `INVALID_RANGE` for an empty/negative range or rate.
   */
  constructor(start: Rational, end: Rational, fps: Rational) {
    if (fps.isNegative() || fps.isZero()) throw new ExportError('INVALID_RANGE', 'La frecuencia de fotogramas debe ser positiva.');
    if (end.compare(start) <= 0) throw new ExportError('INVALID_RANGE', 'El final del rango debe ser posterior al inicio.');
    if (start.isNegative()) throw new ExportError('INVALID_RANGE', 'El rango no puede empezar antes de 0.');
    this.start = start;
    this.end = end;
    this.fps = fps;
    const frames = end.sub(start).mul(fps).floor();
    if (frames <= 0n) throw new ExportError('INVALID_RANGE', 'El rango es más corto que un fotograma.');
    if (frames > BigInt(Number.MAX_SAFE_INTEGER)) throw new ExportError('INVALID_RANGE', 'El rango es demasiado largo.');
    this.totalFrames = Number(frames);
  }

  /** The frame duration, `1 / fps`. */
  get frameDuration(): Rational {
    return this.fps.recip();
  }

  /** Exported duration, `totalFrames / fps`. */
  get duration(): Rational {
    return Rational.fromInt(this.totalFrames).div(this.fps);
  }

  /**
   * Timeline instant of frame `index`.
   * @param index 0-based frame index.
   * @returns `start + index / fps`.
   */
  timeOf(index: number): Rational {
    this.check(index);
    return this.start.add(Rational.fromInt(index).div(this.fps));
  }

  /**
   * Output timestamp of frame `index`, in microseconds from the file start.
   * @param index 0-based frame index.
   * @returns `round(index * 1e6 / fps)`.
   */
  timestampMicros(index: number): number {
    return roundRational(Rational.fromInt(index).mul(MICROS).div(this.fps));
  }

  /**
   * Duration of frame `index` in microseconds — the gap to the next frame's
   * timestamp, so durations always sum to the file duration exactly.
   * @param index 0-based frame index.
   * @returns microseconds.
   */
  durationMicros(index: number): number {
    return this.timestampMicros(index + 1) - this.timestampMicros(index);
  }

  /**
   * Whether frame `index` starts a group of pictures.
   * @param index 0-based frame index.
   * @param intervalSeconds keyframe spacing.
   * @returns `true` every `intervalSeconds` (and at frame 0).
   */
  isKeyframe(index: number, intervalSeconds: number): boolean {
    return index % this.keyframeEvery(intervalSeconds) === 0;
  }

  /**
   * Frames between keyframes.
   * @param intervalSeconds keyframe spacing.
   * @returns at least 1.
   */
  keyframeEvery(intervalSeconds: number): number {
    const interval = Rational.approximate(intervalSeconds) ?? Rational.fromInt(2);
    return Math.max(1, Number(interval.mul(this.fps).floor()));
  }

  /**
   * Iterates every frame index with its time and timestamp.
   * @yields `{ index, time, timestamp, duration }`.
   */
  *frames(): Generator<{ index: number; time: Rational; timestamp: number; duration: number }> {
    for (let index = 0; index < this.totalFrames; index += 1) {
      yield { index, time: this.timeOf(index), timestamp: this.timestampMicros(index), duration: this.durationMicros(index) };
    }
  }

  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0) throw new RangeError(`Índice de fotograma inválido: ${index}`);
  }
}

/**
 * Rounds a rational half away from zero, exactly.
 * @param value the rational.
 * @returns the nearest integer.
 */
export function roundRational(value: Rational): number {
  const num = value.numerator();
  const den = value.denominator();
  const twice = 2n * (num < 0n ? -num : num) + den;
  const magnitude = twice / (2n * den);
  return Number(num < 0n ? -magnitude : magnitude);
}
