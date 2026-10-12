// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Speed that changes over a clip — a faithful port of
 * `concat-core/src/retime.rs`.
 *
 * A constant speed is one number. A *curve* is speed as a function of where in
 * the clip you are: a handful of points, `(x, speed)` with `x` the fraction of
 * the clip's timeline length, joined by straight lines. The source time at any
 * instant is then the area under that line up to it — which is why the curve
 * lives beside the clip's affine map: it is the same fact, and every renderer
 * has to agree with it.
 *
 * The units are deliberately relative. A curve stored as fractions means the
 * same thing after the clip is trimmed or the project re-timed, and a preset
 * can be applied to any clip without knowing how long it is.
 */

/** Speed over a clip, as points joined by straight lines. */
export class SpeedCurve {
  /** The floor a curve's speed is held at: a stop would consume no source and
   * the map would stop being invertible. */
  static readonly MIN_SPEED = 0.0625;
  /** And the ceiling, matching the constant rate's. */
  static readonly MAX_SPEED = 16.0;

  private readonly points: readonly (readonly [number, number])[];

  private constructor(points: readonly (readonly [number, number])[]) {
    this.points = points;
    Object.freeze(this);
    Object.freeze(points);
  }

  /**
   * A curve through these points, tidied: sorted by `x`, clamped into the unit
   * interval and the speed range, and anchored at both ends so the line covers
   * the whole clip. Fewer than one point is `null`. Port of
   * `SpeedCurve::new`.
   */
  static new(points: readonly (readonly [number, number])[]): SpeedCurve | null {
    const cleaned: [number, number][] = points
      .filter(([x, speed]) => Number.isFinite(x) && Number.isFinite(speed))
      .map(([x, speed]) => [
        Math.min(1, Math.max(0, x)),
        Math.min(SpeedCurve.MAX_SPEED, Math.max(SpeedCurve.MIN_SPEED, speed)),
      ]);
    if (cleaned.length === 0) return null;
    cleaned.sort((a, b) => a[0] - b[0]);
    const first = cleaned[0]!;
    if (first[0] > 0) cleaned.unshift([0, first[1]]);
    const last = cleaned[cleaned.length - 1]!;
    if (last[0] < 1) cleaned.push([1, last[1]]);
    return new SpeedCurve(cleaned);
  }

  /** The points, as tidied. */
  all(): readonly (readonly [number, number])[] {
    return this.points;
  }

  /** Speed at `x`, a fraction of the clip's length. Port of `speed_at`. */
  speedAt(x: number): number {
    const at = Math.min(1, Math.max(0, x));
    for (let i = 0; i + 1 < this.points.length; i += 1) {
      const [x0, v0] = this.points[i]!;
      const [x1, v1] = this.points[i + 1]!;
      if (at <= x1) {
        if (x1 <= x0) return v1;
        return v0 + ((v1 - v0) * (at - x0)) / (x1 - x0);
      }
    }
    return this.points[this.points.length - 1]![1];
  }

  /** The area under the curve from the start to `x`: how much of the source,
   * as a fraction of the clip's timeline length, has been consumed by then.
   * Each segment is a trapezoid, so this is exact. Port of `consumed`. */
  consumed(x: number): number {
    const at = Math.min(1, Math.max(0, x));
    let area = 0;
    for (let i = 0; i + 1 < this.points.length; i += 1) {
      const [x0, v0] = this.points[i]!;
      const x1 = this.points[i + 1]![0];
      if (at <= x0) break;
      const end = Math.min(at, x1);
      const vEnd = this.speedAt(end);
      area += ((end - x0) * (v0 + vEnd)) / 2;
      if (at <= x1) break;
    }
    return area;
  }

  /** The average speed: source seconds consumed per timeline second over the
   * whole clip. Port of `mean`. */
  mean(): number {
    return Math.max(SpeedCurve.MIN_SPEED, this.consumed(1));
  }

  /** The clip cut into `count` equal timeline pieces, each
   * `(x0, x1, consumed_at_x0, mean_speed)` — the constant-rate approximation a
   * sound path that can only change tempo in steps needs. Port of `pieces`. */
  pieces(count: number): [number, number, number, number][] {
    const n = Math.max(1, Math.trunc(count));
    const out: [number, number, number, number][] = [];
    for (let index = 0; index < n; index += 1) {
      const x0 = index / n;
      const x1 = (index + 1) / n;
      const from = this.consumed(x0);
      const to = this.consumed(x1);
      out.push([x0, x1, from, Math.max(SpeedCurve.MIN_SPEED, (to - from) / (x1 - x0))]);
    }
    return out;
  }
}
