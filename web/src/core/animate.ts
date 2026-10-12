// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Keyframe animation — a faithful port of `concat-core/src/animate.rs`.
 *
 * Keys sit at fractions of a clip's length and are approached through CSS
 * timing functions, solved here exactly once for the whole engine: a preview
 * whose easing disagreed with the export's would disagree invisibly.
 *
 * Naming: Rust calls the per-property key list `animate::Track`; in one
 * TypeScript namespace that collides with `timeline::Track`, so it is
 * {@link KeyTrack} here. Every other name is the Rust name.
 */

/** How a key is approached from the one before it: a CSS timing function, as
 * its two control points. Endpoints pinned at (0,0) and (1,1), so only the
 * middle two points are stored, and `x` is clamped into `0..=1` where a legal
 * timing function keeps it. */
export class Ease {
  /** First control point's x, `0..=1`. */
  readonly x1: number;
  /** First control point's y; may overshoot. */
  readonly y1: number;
  /** Second control point's x, `0..=1`. */
  readonly x2: number;
  /** Second control point's y; may overshoot. */
  readonly y2: number;

  /** The four control-point numbers, as given. */
  constructor(x1: number, y1: number, x2: number, y2: number) {
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
    Object.freeze(this);
  }

  /** A straight line. */
  static readonly LINEAR: Ease = new Ease(0, 0, 1, 1);
  /** Starts slow, arrives fast. CSS `ease-in`. */
  static readonly IN: Ease = new Ease(0.42, 0, 1, 1);
  /** Starts fast, arrives slow. CSS `ease-out`. */
  static readonly OUT: Ease = new Ease(0, 0, 0.58, 1);
  /** Slow at both ends. CSS `ease-in-out`. */
  static readonly IN_OUT: Ease = new Ease(0.42, 0, 0.58, 1);

  equals(other: Ease): boolean {
    return (
      this.x1 === other.x1 && this.y1 === other.y1 && this.x2 === other.x2 && this.y2 === other.y2
    );
  }

  /** Whether this is the straight line, to within a hair. What lets the mixer
   * skip resampling a ride that has nothing to resample. */
  isLinear(): boolean {
    return Math.abs(this.x1 - this.y1) < 1e-6 && Math.abs(this.x2 - this.y2) < 1e-6;
  }

  /** The eased fraction at `t`. */
  apply(t: number): number {
    if (this.isLinear()) return Math.min(1, Math.max(0, t));
    return bezierYAtX(this.x1, this.y1, this.x2, this.y2, t);
  }
}

/** x of a cubic bezier with endpoints pinned at 0 and 1, at parameter `t`. */
function bezierAxis(p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** Derivative of {@link bezierAxis} in `t`. */
function bezierAxisSlope(p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/**
 * Solve a CSS cubic-bezier for y at a given x: Newton first, bisection as the
 * fallback where the curve is flat enough that Newton stalls.
 *
 * The one solver. The engine reaches it through {@link Ease.apply} on every
 * frame of every keyed property. Port of `animate::bezier_y_at_x`.
 */
export function bezierYAtX(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const target = Math.min(1, Math.max(0, x));
  let t = target;

  for (let i = 0; i < 8; i += 1) {
    const error = bezierAxis(x1, x2, t) - target;
    if (Math.abs(error) < 1e-7) return bezierAxis(y1, y2, t);
    const slope = bezierAxisSlope(x1, x2, t);
    if (Math.abs(slope) < 1e-9) break;
    t -= error / slope;
  }

  let lo = 0;
  let hi = 1;
  t = target;
  for (let i = 0; i < 32; i += 1) {
    const at = bezierAxis(x1, x2, t);
    if (Math.abs(at - target) < 1e-7) break;
    if (at > target) hi = t;
    else lo = t;
    t = (lo + hi) / 2;
  }
  return bezierAxis(y1, y2, t);
}

/** One key of one property. Port of `animate::Key`. */
export class Key {
  /** Where in the clip, `0..=1`. */
  readonly at: number;
  /** The value there, in the property's relative terms. */
  readonly value: number;
  /** How this key is approached from the previous one. */
  readonly ease: Ease;

  constructor(at: number, value: number, ease: Ease = Ease.LINEAR) {
    this.at = at;
    this.value = value;
    this.ease = ease;
    Object.freeze(this);
  }
}

/** The keys of one property, sorted by `at`. Port of `animate::Track`. */
export class KeyTrack {
  private readonly keys: Key[];

  /** A track through these keys, sorted by `at`. */
  constructor(keys: Key[]) {
    this.keys = [...keys].sort((a, b) => a.at - b.at);
  }

  /** The keys, sorted. */
  all(): readonly Key[] {
    return this.keys;
  }

  /** True with no keys: the property is the clip's own. */
  isEmpty(): boolean {
    return this.keys.length === 0;
  }

  /** The value at `x`: `rest` with no keys, the first key's before it, the
   * last key's after it, and eased between neighbours. Port of
   * `animate::Track::value_at`. */
  valueAt(x: number, rest: number): number {
    const first = this.keys[0];
    if (!first) return rest;
    if (x <= first.at) return first.value;
    for (let i = 0; i + 1 < this.keys.length; i += 1) {
      const a = this.keys[i];
      const b = this.keys[i + 1];
      if (!a || !b) continue;
      if (x <= b.at) {
        if (b.at <= a.at) return b.value;
        const t = b.ease.apply((x - a.at) / (b.at - a.at));
        return a.value + (b.value - a.value) * t;
      }
    }
    return this.keys[this.keys.length - 1]!.value;
  }

  /** The same ride, with every eased segment replaced by `steps` straight ones
   * through the same points. For callers that can interpolate but cannot ease.
   * Linear segments pass through untouched. Port of
   * `animate::Track::resample`. */
  resample(steps: number): KeyTrack {
    const count = Math.max(1, Math.trunc(steps));
    if (this.keys.length < 2 || this.keys.every((key) => key.ease.isLinear())) {
      return new KeyTrack(this.keys);
    }
    const out: Key[] = [this.keys[0]!];
    for (let i = 0; i + 1 < this.keys.length; i += 1) {
      const a = this.keys[i]!;
      const b = this.keys[i + 1]!;
      if (b.ease.isLinear() || b.at <= a.at) {
        out.push(new Key(b.at, b.value, Ease.LINEAR));
        continue;
      }
      for (let step = 1; step <= count; step += 1) {
        const t = step / count;
        out.push(
          new Key(a.at + (b.at - a.at) * t, a.value + (b.value - a.value) * b.ease.apply(t), Ease.LINEAR),
        );
      }
    }
    return new KeyTrack(out);
  }
}

/** The base placement of a clip, as `timeline.ts` holds it. Declared here as a
 * structural type so `animate` stays independent of `timeline` — the same
 * layering the Rust crate has. */
export interface BaseTransform {
  scale: number;
  offset_x: number;
  offset_y: number;
  rotation: number;
  stretch_x: number;
  stretch_y: number;
}

/** Every animatable property's keys. Port of `animate::Animation`. */
export class Animation {
  /** A factor on the clip's scale; 1 is as placed. */
  readonly scale: KeyTrack;
  /** Added to the clip's horizontal offset, in frame widths. */
  readonly offsetX: KeyTrack;
  /** Added to the clip's vertical offset, in frame heights. */
  readonly offsetY: KeyTrack;
  /** Added to the clip's rotation, in degrees. */
  readonly rotation: KeyTrack;
  /** A factor on the clip's opacity; 1 is as set. */
  readonly opacity: KeyTrack;
  /** A factor on the clip's gain; 1 is as mixed. Sound rather than picture,
   * but the same shape of fact. Nothing in the compositor reads it; the mixer
   * does. */
  readonly volume: KeyTrack;

  constructor(
    scale: KeyTrack = new KeyTrack([]),
    offsetX: KeyTrack = new KeyTrack([]),
    offsetY: KeyTrack = new KeyTrack([]),
    rotation: KeyTrack = new KeyTrack([]),
    opacity: KeyTrack = new KeyTrack([]),
    volume: KeyTrack = new KeyTrack([]),
  ) {
    this.scale = scale;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.rotation = rotation;
    this.opacity = opacity;
    this.volume = volume;
    Object.freeze(this);
  }

  /** True when no property has a key. */
  isEmpty(): boolean {
    return (
      this.scale.isEmpty() &&
      this.offsetX.isEmpty() &&
      this.offsetY.isEmpty() &&
      this.rotation.isEmpty() &&
      this.opacity.isEmpty() &&
      this.volume.isEmpty()
    );
  }

  /** The clip's transform at `x`, a fraction of its length. Port of
   * `Animation::transform_at`. */
  transformAt(base: BaseTransform, x: number): BaseTransform {
    return {
      scale: Math.max(0.001, base.scale * this.scale.valueAt(x, 1)),
      offset_x: base.offset_x + this.offsetX.valueAt(x, 0),
      offset_y: base.offset_y + this.offsetY.valueAt(x, 0),
      rotation: base.rotation + this.rotation.valueAt(x, 0),
      stretch_x: base.stretch_x,
      stretch_y: base.stretch_y,
    };
  }

  /** The clip's opacity at `x`. Port of `Animation::opacity_at`. */
  opacityAt(base: number, x: number): number {
    return Math.min(1, Math.max(0, base * this.opacity.valueAt(x, 1)));
  }

  /** The clip's gain at `x`. Unclamped at the top: a key above unity is a clip
   * being lifted, which is the whole point of keying gain. Port of
   * `Animation::volume_at`. */
  volumeAt(base: number, x: number): number {
    return Math.max(0, base * this.volume.valueAt(x, 1));
  }
}
