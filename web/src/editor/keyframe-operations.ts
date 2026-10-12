// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 keyframe edits on top of Fase 3's Add/Remove/Move: the easing curve
 * of a key (the CSS cubic-bezier it is approached through) and its value.
 *
 * Keys are the document's own `clip.keys` (`model/document.ts` `ClipKey`,
 * port of `model.rs` `Key`), so these are first-class schema edits — no
 * `extra`. The curve is the exact four numbers `core/animate.ts`'s
 * {@link Ease} solves; {@link clampBezier} enforces the timing-function rule
 * (x in `0..=1`, y free) that `animate.rs` documents.
 */

import { bezierYAtX, Ease } from '../core/animate.ts';
import type { ClipKey, ProjectDocument } from '../model/document.ts';
import { KeyEase, KeyProperty } from '../model/wire.ts';
import { cloneDocument, EditError, keyframeId, requireClip, type EditOperation } from './operations.ts';

/** A cubic-bezier as `[x1, y1, x2, y2]`. */
export type CubicBezier = readonly [number, number, number, number];

/** How far y may overshoot in the editor (CSS allows any y). */
export const BEZIER_Y_LIMIT = 3;

/** Named curves of the Bézier editor. `hold` is a step: flat, then jump. */
export const BEZIER_PRESETS: Readonly<Record<'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold', CubicBezier>> = Object.freeze({
  linear: Object.freeze<CubicBezier>([0, 0, 1, 1]),
  easeIn: Object.freeze<CubicBezier>([0.42, 0, 1, 1]),
  easeOut: Object.freeze<CubicBezier>([0, 0, 0.58, 1]),
  easeInOut: Object.freeze<CubicBezier>([0.42, 0, 0.58, 1]),
  hold: Object.freeze<CubicBezier>([1, 0, 1, 0]),
});

/**
 * Holds a curve to a legal timing function: x1/x2 clamped into `[0, 1]`
 * (otherwise x(t) is not monotonic and y(x) is not a function), y kept free
 * but finite and within ±{@link BEZIER_Y_LIMIT}.
 * @param points the raw control points.
 * @returns the clamped curve.
 */
export function clampBezier(points: readonly number[]): CubicBezier {
  const at = (index: number, fallback: number): number => {
    const value = points[index];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const clampX = (value: number): number => Math.min(1, Math.max(0, value));
  const clampY = (value: number): number => Math.min(BEZIER_Y_LIMIT, Math.max(-BEZIER_Y_LIMIT, value));
  return [clampX(at(0, 0)), clampY(at(1, 0)), clampX(at(2, 1)), clampY(at(3, 1))];
}

/**
 * Samples a curve through the engine's own solver (preview = export).
 * @param curve the control points.
 * @param x progress `0..1`.
 * @returns eased progress.
 */
export function evaluateBezier(curve: CubicBezier, x: number): number {
  const ease = new Ease(curve[0], curve[1], curve[2], curve[3]);
  return ease.isLinear() ? Math.min(1, Math.max(0, x)) : bezierYAtX(curve[0], curve[1], curve[2], curve[3], x);
}

/**
 * The name of a preset matching a curve, if any.
 * @param curve the control points.
 * @returns the preset key or `null` for a custom curve.
 */
export function presetOf(curve: CubicBezier): keyof typeof BEZIER_PRESETS | null {
  for (const [name, points] of Object.entries(BEZIER_PRESETS)) {
    if (points.every((value, index) => Math.abs(value - (curve[index] ?? Number.NaN)) < 1e-6)) {
      return name as keyof typeof BEZIER_PRESETS;
    }
  }
  return null;
}

/** The value range a key's 0–100 % maps to, per property (absolute values). */
export const KEYFRAME_VALUE_RANGES: Readonly<Record<KeyProperty, readonly [number, number]>> = Object.freeze({
  scale: Object.freeze([0, 8] as const),
  offsetX: Object.freeze([-1, 1] as const),
  offsetY: Object.freeze([-1, 1] as const),
  rotation: Object.freeze([-360, 360] as const),
  opacity: Object.freeze([0, 1] as const),
  volume: Object.freeze([0, 2] as const),
});

/**
 * Property value → 0–100 % of its range (the lane's vertical axis).
 * @param property the keyed property.
 * @param value an absolute value.
 * @returns the percentage, clamped.
 */
export function valueToPercent(property: KeyProperty, value: number): number {
  const [lo, hi] = KEYFRAME_VALUE_RANGES[property];
  return Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100));
}

/**
 * 0–100 % → property value.
 * @param property the keyed property.
 * @param percent the lane position.
 * @returns the absolute value.
 */
export function percentToValue(property: KeyProperty, percent: number): number {
  const [lo, hi] = KEYFRAME_VALUE_RANGES[property];
  const p = Math.min(100, Math.max(0, percent));
  return lo + ((hi - lo) * p) / 100;
}

function findKey(keys: ClipKey[], property: string, id: string): ClipKey | undefined {
  return keys.find((key) => key.property === property && keyframeId(property, key.at) === id);
}

function requireProperty(property: string): KeyProperty {
  const parsed = KeyProperty.fromName(property);
  if (!parsed) throw new EditError(`Propiedad no animable: ${property}`);
  return parsed;
}

/** UpdateKeyframeCurve(clipId, property, keyframeId, cubicBezier[4]). */
export class UpdateKeyframeCurveOperation implements EditOperation {
  readonly name = 'UpdateKeyframeCurve';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly property: KeyProperty;
  readonly keyframeId: string;
  /** The clamped curve that will be stored. */
  readonly curve: CubicBezier;

  /**
   * @param clipId the clip.
   * @param property the keyed property.
   * @param keyframeIdValue the key ({@link keyframeId}).
   * @param cubicBezier `[x1, y1, x2, y2]` (x clamped into 0..1).
   */
  constructor(clipId: string, property: string, keyframeIdValue: string, cubicBezier: readonly number[]) {
    this.clipId = clipId;
    this.property = requireProperty(property);
    this.keyframeId = keyframeIdValue;
    if (cubicBezier.length !== 4) throw new EditError('Una curva Bézier necesita 4 números');
    this.curve = clampBezier(cubicBezier);
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const key = findKey(requireClip(next, this.clipId).keys, this.property, this.keyframeId);
    if (!key) throw new EditError(`No existe el keyframe ${this.keyframeId}`);
    key.ease = new KeyEase([this.curve[0], this.curve[1], this.curve[2], this.curve[3]]);
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const key = findKey(requireClip(doc, this.clipId).keys, this.property, this.keyframeId);
    if (!key) throw new EditError(`No existe el keyframe ${this.keyframeId}`);
    return new UpdateKeyframeCurveOperation(this.clipId, this.property, this.keyframeId, [...key.ease.points]);
  }

  /** Handle drags in the Bézier editor fuse into one step. */
  merge(next: EditOperation): EditOperation | null {
    if (
      next instanceof UpdateKeyframeCurveOperation &&
      next.clipId === this.clipId &&
      next.property === this.property &&
      next.keyframeId === this.keyframeId &&
      next.timestamp - this.timestamp <= 600
    ) {
      return next;
    }
    return null;
  }

  describe(): string {
    return `Curva de ${this.keyframeId}`;
  }
}

/** MoveKeyframeValue(clipId, property, keyframeId, value): the key's value. */
export class MoveKeyframeValueOperation implements EditOperation {
  readonly name = 'MoveKeyframeValue';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly property: KeyProperty;
  readonly keyframeId: string;
  readonly value: number;

  /**
   * @param clipId the clip.
   * @param property the keyed property.
   * @param keyframeIdValue the key.
   * @param value the new absolute value (clamped to the property's range).
   * @param clamp false only for inverses, which restore the exact old value.
   */
  constructor(clipId: string, property: string, keyframeIdValue: string, value: number, clamp = true) {
    this.clipId = clipId;
    this.property = requireProperty(property);
    this.keyframeId = keyframeIdValue;
    if (!Number.isFinite(value)) throw new EditError('Valor de keyframe inválido');
    const [lo, hi] = KEYFRAME_VALUE_RANGES[this.property];
    this.value = clamp ? Math.min(hi, Math.max(lo, value)) : value;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const key = findKey(requireClip(next, this.clipId).keys, this.property, this.keyframeId);
    if (!key) throw new EditError(`No existe el keyframe ${this.keyframeId}`);
    key.value = this.value;
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const key = findKey(requireClip(doc, this.clipId).keys, this.property, this.keyframeId);
    if (!key) throw new EditError(`No existe el keyframe ${this.keyframeId}`);
    return new MoveKeyframeValueOperation(this.clipId, this.property, this.keyframeId, key.value, false);
  }

  describe(): string {
    return `Valor de ${this.keyframeId}`;
  }
}
