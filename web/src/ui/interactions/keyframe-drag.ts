// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Dragging a ◆ in the keyframe lane: horizontal = time (a {@link Rational},
 * clamped to the clip, magnet to the playhead within 8 px), vertical = value
 * (0–100 % of the property's range). Preview-only while the pointer moves;
 * pointerup yields exactly one history step (a compound of
 * MoveKeyframeValue + MoveKeyframe when both changed).
 */

import { Rational } from '../../core/rational.ts';
import { MoveKeyframeValueOperation, percentToValue } from '../../editor/keyframe-operations.ts';
import { CompoundOperation, keyframeId, MoveKeyframeOperation, type EditOperation } from '../../editor/operations.ts';
import type { DocumentClip } from '../../model/document.ts';
import type { KeyProperty } from '../../model/wire.ts';
import { laneYToPercent, type LaneRect } from '../timeline/keyframe-node.ts';
import type { KeyframeGesturePreview } from '../timeline/keyframe-track.ts';

/** Playhead magnet distance (px). */
export const KEYFRAME_SNAP_PX = 8;
/** Pointer travel below which a press is a click, not a drag (px). */
export const KEYFRAME_CLICK_SLOP = 3;

/**
 * Snaps a timeline time to the playhead when it is within `thresholdPx`.
 * @param seconds the candidate time.
 * @param playhead the playhead time.
 * @param pixelsPerSecond the zoom.
 * @param thresholdPx magnet distance.
 * @returns the time and whether it snapped.
 */
export function snapToPlayhead(seconds: number, playhead: number, pixelsPerSecond: number, thresholdPx = KEYFRAME_SNAP_PX): { seconds: number; snapped: boolean } {
  if (Math.abs(seconds - playhead) * pixelsPerSecond <= thresholdPx) return { seconds: playhead, snapped: true };
  return { seconds, snapped: false };
}

/** Where a drag would put the key. */
export interface KeyframeDragTarget {
  /** Timeline time. */
  time: Rational;
  /** Clip fraction. */
  at: number;
  /** Absolute value. */
  value: number;
  snapped: boolean;
}

/** Inputs of {@link KeyframeDrag.begin}. */
export interface KeyframeDragStart {
  clip: DocumentClip;
  property: KeyProperty;
  keyframeId: string;
  lane: LaneRect;
  pointerX: number;
  pointerY: number;
}

/** One ◆ drag gesture. */
export class KeyframeDrag {
  private start: KeyframeDragStart | null = null;
  private origin: { at: number; value: number } | null = null;
  private target: KeyframeDragTarget | null = null;
  private moved = false;

  /** Whether a gesture is running. */
  get active(): boolean {
    return this.start !== null;
  }

  /**
   * Starts dragging a key.
   * @param start the clip, key, lane and pointer.
   * @returns false when the key does not exist.
   */
  begin(start: KeyframeDragStart): boolean {
    const key = start.clip.keys.find((item) => item.property === start.property && keyframeId(start.property, item.at) === start.keyframeId);
    if (!key) return false;
    this.start = start;
    this.origin = { at: key.at, value: key.value };
    this.target = null;
    this.moved = false;
    return true;
  }

  /**
   * Follows the pointer.
   * @param x pointer x (content px).
   * @param y pointer y.
   * @param options playhead, zoom, snapping and axis lock.
   * @returns the ghost target (or `null` before the slop is exceeded).
   */
  update(x: number, y: number, options: { playheadSeconds: number; pixelsPerSecond: number; snap: boolean; lockAxis?: boolean }): KeyframeDragTarget | null {
    const start = this.start;
    const origin = this.origin;
    if (!start || !origin) return null;
    const dx = x - start.pointerX;
    const dy = y - start.pointerY;
    if (!this.moved && Math.abs(dx) < KEYFRAME_CLICK_SLOP && Math.abs(dy) < KEYFRAME_CLICK_SLOP) return null;
    this.moved = true;
    const { clip, lane, property } = start;
    // Shift locks to the dominant axis.
    const lockHorizontal = options.lockAxis === true && Math.abs(dy) > Math.abs(dx);
    const lockVertical = options.lockAxis === true && !lockHorizontal;
    let at = lockHorizontal ? origin.at : Math.min(1, Math.max(0, origin.at + dx / Math.max(1, lane.w)));
    let seconds = clip.start + at * clip.duration;
    let snapped = false;
    if (!lockHorizontal && options.snap) {
      const playhead = options.playheadSeconds;
      if (playhead >= clip.start && playhead <= clip.start + clip.duration) {
        const result = snapToPlayhead(seconds, playhead, options.pixelsPerSecond);
        seconds = result.seconds;
        snapped = result.snapped;
        at = (seconds - clip.start) / Math.max(1e-9, clip.duration);
      }
    }
    // Two keys of one property may not share an instant: keep the old time.
    const collides = clip.keys.some(
      (key) => key.property === property && keyframeId(property, key.at) !== start.keyframeId && Math.abs(key.at - at) < 1e-6,
    );
    if (collides) {
      at = origin.at;
      seconds = clip.start + at * clip.duration;
      snapped = false;
    }
    const value = lockVertical ? origin.value : percentToValue(property, laneYToPercent(y, lane));
    this.target = { time: Rational.approximate(seconds) ?? Rational.ZERO, at, value, snapped };
    return this.target;
  }

  /** The ghost for the lane renderer. */
  preview(): KeyframeGesturePreview | null {
    if (!this.start || !this.target) return null;
    return {
      clipId: this.start.clip.id,
      property: this.start.property,
      keyframeId: this.start.keyframeId,
      at: this.target.at,
      value: this.target.value,
      snapped: this.target.snapped,
    };
  }

  /**
   * Ends the gesture.
   * @returns the operation to run (or `null` for a click / no change) and the key's new id.
   */
  commit(): { op: EditOperation | null; keyframeId: string } | null {
    const start = this.start;
    const origin = this.origin;
    const target = this.target;
    this.cancel();
    if (!start || !origin) return null;
    if (!target) return { op: null, keyframeId: start.keyframeId };
    const ops: EditOperation[] = [];
    if (Math.abs(target.value - origin.value) > 1e-9) {
      // Value first: the id still names the key at its old time.
      ops.push(new MoveKeyframeValueOperation(start.clip.id, start.property, start.keyframeId, target.value));
    }
    let id = start.keyframeId;
    if (Math.abs(target.at - origin.at) > 1e-9) {
      const fromTime = Rational.approximate(start.clip.start + origin.at * start.clip.duration) ?? Rational.ZERO;
      ops.push(new MoveKeyframeOperation(start.clip.id, start.property, start.keyframeId, fromTime, target.time));
      const movedAt = Math.min(1, Math.max(0, (target.time.asNumber() - start.clip.start) / Math.max(1e-9, start.clip.duration)));
      id = keyframeId(start.property, movedAt);
    }
    if (ops.length === 0) return { op: null, keyframeId: id };
    return { op: ops.length === 1 ? ops[0]! : new CompoundOperation('Mover keyframe', ops), keyframeId: id };
  }

  /** Abandons the gesture (Escape / pointercancel). */
  cancel(): void {
    this.start = null;
    this.origin = null;
    this.target = null;
    this.moved = false;
  }
}
