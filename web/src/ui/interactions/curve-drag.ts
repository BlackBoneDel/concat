// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Bending the curve between two ◆ by dragging it vertically: the drag maps
 * to a "bend" in −1…1 that becomes the cubic-bezier of the segment's end key
 * (keys own the curve they are approached through, `animate.rs`). Dragging
 * the curve towards the next value eases out; away from it eases in.
 */

import { clampBezier, UpdateKeyframeCurveOperation, type CubicBezier } from '../../editor/keyframe-operations.ts';
import type { KeyProperty } from '../../model/wire.ts';
import type { KeyframeNode, LaneRect } from '../timeline/keyframe-node.ts';
import type { KeyframeGesturePreview } from '../timeline/keyframe-track.ts';

/**
 * The curve of a bend amount.
 * @param bend −1 (strong ease-in) … 0 (linear) … 1 (strong ease-out).
 * @returns `[x1, y1, x2, y2]` with x fixed at ⅓ and ⅔ (always a valid timing function).
 */
export function curveFromBend(bend: number): CubicBezier {
  const b = Math.min(1, Math.max(-1, Number.isFinite(bend) ? bend : 0));
  if (b >= 0) return clampBezier([1 / 3, 1 / 3 + (2 * b) / 3, 2 / 3, 2 / 3 + b / 3]);
  return clampBezier([1 / 3, 1 / 3 + b / 3, 2 / 3, 2 / 3 + (2 * b) / 3]);
}

/**
 * Estimates the bend of an existing curve (inverse of {@link curveFromBend}
 * for curves it produced; a smooth approximation otherwise).
 * @param curve control points.
 * @returns −1…1.
 */
export function bendOfCurve(curve: CubicBezier): number {
  // Area between the curve's control polygon and the diagonal, normalised.
  const lift = (curve[1] - curve[0] + (curve[3] - curve[2])) / 2;
  return Math.min(1, Math.max(-1, lift * 2));
}

/** One curve-bending gesture. */
export class CurveDrag {
  private state: { clipId: string; property: KeyProperty; to: KeyframeNode; direction: number; startY: number; startBend: number; lane: LaneRect } | null = null;
  private curve: CubicBezier | null = null;

  /** Whether a gesture is running. */
  get active(): boolean {
    return this.state !== null;
  }

  /**
   * Grabs a segment.
   * @param clipId the clip.
   * @param property the lane property.
   * @param from the segment's first key.
   * @param to the segment's end key (owner of the curve).
   * @param lane the lane.
   * @param pointerY pointer y.
   */
  begin(clipId: string, property: KeyProperty, from: KeyframeNode, to: KeyframeNode, lane: LaneRect, pointerY: number): void {
    // Going up the lane (value rising) → dragging up eases out.
    const direction = to.y < from.y ? 1 : to.y > from.y ? -1 : 1;
    this.state = { clipId, property, to, direction, startY: pointerY, startBend: bendOfCurve(to.ease), lane };
    this.curve = null;
  }

  /**
   * Follows the pointer.
   * @param y pointer y.
   * @returns the ghost curve.
   */
  update(y: number): CubicBezier | null {
    const state = this.state;
    if (!state) return null;
    const dy = state.startY - y; // up = positive
    const bend = state.startBend + (dy / Math.max(8, state.lane.h / 2)) * state.direction;
    this.curve = curveFromBend(bend);
    return this.curve;
  }

  /** The ghost for the lane renderer. */
  preview(): KeyframeGesturePreview | null {
    if (!this.state || !this.curve) return null;
    return { clipId: this.state.clipId, property: this.state.property, keyframeId: this.state.to.id, curve: this.curve };
  }

  /**
   * Ends the gesture.
   * @returns the curve edit, or `null` when nothing moved.
   */
  commit(): UpdateKeyframeCurveOperation | null {
    const state = this.state;
    const curve = this.curve;
    this.cancel();
    if (!state || !curve) return null;
    if (curve.every((value, index) => Math.abs(value - (state.to.ease[index] ?? Number.NaN)) < 1e-9)) return null;
    return new UpdateKeyframeCurveOperation(state.clipId, state.property, state.to.id, curve);
  }

  /** Abandons the gesture. */
  cancel(): void {
    this.state = null;
    this.curve = null;
  }
}
