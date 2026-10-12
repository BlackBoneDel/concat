// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Trimming a clip edge, rippling the tail, or rolling the cut between
 * neighbours — all preview-only until pointerup, then one operation.
 */

import { Rational } from '../../core/rational.ts';
import type { ProjectDocument } from '../../model/document.ts';
import {
  currentTimeline,
  RippleEditOperation,
  RollEditOperation,
  TrimClipOperation,
  type EditOperation,
  type TrimEdge,
} from '../../editor/operations.ts';
import type { SnapCandidate } from '../../editor/snapping.ts';
import type { TimelineView } from '../timeline/timeline-view.ts';
import type { ClipDragPreview } from '../timeline/types.ts';

/** How a trim behaves. */
export type TrimMode = 'normal' | 'ripple' | 'roll';

/** Everything a trim drag needs from its host. */
export interface TrimDragOptions {
  view: TimelineView;
  getDocument(): ProjectDocument;
  snapCandidates(excludeClipIds: string[]): SnapCandidate[];
  snap(time: Rational, candidates: SnapCandidate[]): Rational;
}

/** One clip-edge trim in progress. */
export class TrimDrag {
  private readonly options: TrimDragOptions;
  private clipId = '';
  private edge: TrimEdge = 'in';
  private mode: TrimMode = 'normal';
  private originalStart = 0;
  private originalDuration = 0;

  /**
   * @param options host wiring.
   */
  constructor(options: TrimDragOptions) {
    this.options = options;
  }

  /**
   * Starts the trim.
   * @param clipId the clip whose edge is grabbed.
   * @param edge which edge.
   * @param mode ripple/roll modifiers.
   */
  begin(clipId: string, edge: TrimEdge, mode: TrimMode): void {
    const doc = this.options.getDocument();
    const clip = currentTimeline(doc).clips.find((candidate) => candidate.id === clipId);
    if (!clip) return;
    this.clipId = clipId;
    this.edge = edge;
    this.mode = mode;
    this.originalStart = clip.start;
    this.originalDuration = clip.duration;
  }

  /**
   * Updates the preview.
   * @param pointerTime where the pointer is now.
   * @param shiftDown true when Shift suppresses snapping.
   */
  update(pointerTime: number, shiftDown: boolean): void {
    if (this.clipId === '') return;
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const clip = timeline.clips.find((candidate) => candidate.id === this.clipId);
    if (!clip) return;
    const candidates = this.options.snapCandidates([this.clipId]);
    let time = pointerTime;
    if (!shiftDown) {
      time = this.options.snap(Rational.approximate(pointerTime) ?? Rational.ZERO, candidates).asNumber();
    }
    const minDuration = 1 / 60;
    let start = this.originalStart;
    let duration = this.originalDuration;
    if (this.edge === 'in') {
      const maxStart = this.originalStart + this.originalDuration - minDuration;
      const newStart = Math.min(Math.max(0, time), maxStart);
      start = newStart;
      duration = this.originalStart + this.originalDuration - newStart;
    } else {
      const newEnd = Math.max(this.originalStart + minDuration, time);
      duration = newEnd - this.originalStart;
    }
    const preview: ClipDragPreview = {
      offsets: new Map(),
      trims: new Map([[this.clipId, { start, duration }]]),
    };
    this.options.view.setDragPreview(preview);
    this.options.view.requestRender();
  }

  /** The operation that finishes the trim. */
  commit(): EditOperation | null {
    if (this.clipId === '') return null;
    const preview = this.options.view.dragPreview();
    const trim = preview?.trims?.get(this.clipId);
    this.cancel();
    if (!trim) return null;
    const fromValue = this.edge === 'in' ? this.originalStart : this.originalStart + this.originalDuration;
    const toValue = this.edge === 'in' ? trim.start : trim.start + trim.duration;
    if (Math.abs(toValue - fromValue) < 1e-9) return null;
    const from = Rational.approximate(fromValue) ?? Rational.ZERO;
    const to = Rational.approximate(toValue) ?? Rational.ZERO;
    if (this.mode === 'ripple') {
      return new RippleEditOperation(this.clipId, this.edge, Rational.approximate(toValue - fromValue) ?? Rational.ZERO);
    }
    return new TrimClipOperation(this.clipId, this.edge, from, to);
  }

  /**
   * The roll variant: one op covering both clips of the cut.
   * @param clipAId left clip.
   * @param clipBId right clip.
   * @param deltaSeconds how far the cut moves.
   * @returns the roll operation.
   */
  static rollOperation(clipAId: string, clipBId: string, deltaSeconds: number): EditOperation {
    return new RollEditOperation(
      clipAId,
      clipBId,
      Rational.approximate(deltaSeconds) ?? Rational.ZERO,
    );
  }

  /** Drops the preview. */
  cancel(): void {
    this.clipId = '';
    this.options.view.setDragPreview(null);
    this.options.view.requestRender();
  }
}
