// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The blade (N): click a clip to split it where you clicked, or split
 * everything under the playhead with the keyboard.
 */

import { Rational } from '../../core/rational.ts';
import type { ProjectDocument } from '../../model/document.ts';
import {
  currentTimeline,
  SplitClipOperation,
  type EditOperation,
} from '../../editor/operations.ts';
import type { TimelineView } from '../timeline/timeline-view.ts';

/** Splitting helpers. */
export class SplitTool {
  /**
   * @param view the timeline geometry.
   * @param getDocument the live document.
   */
  constructor(
    private readonly view: TimelineView,
    private readonly getDocument: () => ProjectDocument,
  ) {}

  /**
   * Splits whatever clip sits at a point.
   * @param x content x.
   * @param y content y.
   * @returns the split operations (one per clip hit), or an empty list.
   */
  splitAtPoint(x: number, y: number): EditOperation[] {
    const clip = this.view.clipAt(x, y);
    if (!clip) return [];
    return this.splitClipAt(clip.id, this.view.xToTime(x));
  }

  /**
   * Splits one clip at a time.
   * @param clipId the clip.
   * @param timeSeconds the cut time.
   * @returns the split, or an empty list when the cut is outside.
   */
  splitClipAt(clipId: string, timeSeconds: number): EditOperation[] {
    const doc = this.getDocument();
    const clip = currentTimeline(doc).clips.find((candidate) => candidate.id === clipId);
    if (!clip) return [];
    const local = timeSeconds - clip.start;
    if (local <= 1 / 60 || local >= clip.duration - 1 / 60) return [];
    return [new SplitClipOperation(clipId, Rational.approximate(timeSeconds) ?? Rational.ZERO)];
  }

  /**
   * Splits every clip under the playhead.
   * @param playheadSeconds the playhead.
   * @returns one split per cut clip.
   */
  splitAtPlayhead(playheadSeconds: number): EditOperation[] {
    const doc = this.getDocument();
    const timeline = currentTimeline(doc);
    const ops: EditOperation[] = [];
    for (const clip of timeline.clips) {
      if (playheadSeconds > clip.start + 1 / 60 && playheadSeconds < clip.start + clip.duration - 1 / 60) {
        ops.push(
          new SplitClipOperation(
            clip.id,
            Rational.approximate(playheadSeconds) ?? Rational.ZERO,
          ),
        );
      }
    }
    return ops;
  }
}
