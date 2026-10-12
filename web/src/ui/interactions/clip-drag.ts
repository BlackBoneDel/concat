// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Moving clips with the mouse: one undoable step per gesture. The drag
 * only paints a preview; the document changes on pointerup, and Escape
 * throws the preview away.
 */

import { Rational } from '../../core/rational.ts';
import type { ProjectDocument } from '../../model/document.ts';
import {
  currentTimeline,
  groupMembers,
  kindFitsTrack,
  linkMembers,
  MoveClipOperation,
  requireClip,
  trackKindOf,
  type EditOperation,
} from '../../editor/operations.ts';
import type { SnapCandidate } from '../../editor/snapping.ts';
import type { TimelineView } from '../timeline/timeline-view.ts';
import type { ClipDragPreview } from '../timeline/types.ts';

/** One dragged clip's origin. */
interface DragOrigin {
  clipId: string;
  start: number;
  trackId: string;
}

/** Everything a clip drag needs from its host. */
export interface ClipDragOptions {
  view: TimelineView;
  getDocument(): ProjectDocument;
  snapCandidates(excludeClipIds: string[]): SnapCandidate[];
  snap(time: Rational, candidates: SnapCandidate[]): Rational;
  operationFor(
    clipId: string,
    fromTrackId: string,
    toTrackId: string,
    fromStart: Rational,
    toStart: Rational,
  ): EditOperation;
}

/** A clip move in progress. */
export class ClipDrag {
  private readonly options: ClipDragOptions;
  private origins: DragOrigin[] = [];
  private grabOffset = 0;

  /**
   * @param options host wiring.
   */
  constructor(options: ClipDragOptions) {
    this.options = options;
  }

  /**
   * Starts the drag.
   * @param clipId the grabbed clip.
   * @param grabTimeSeconds where the pointer grabbed it.
   * @param alsoIds extra selected clips that move along (groups/links).
   */
  begin(clipId: string, grabTimeSeconds: number, alsoIds: string[]): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const ids = [clipId, ...alsoIds.filter((id) => id !== clipId)];
    this.origins = [];
    for (const id of ids) {
      const clip = timeline.clips.find((candidate) => candidate.id === id);
      if (clip) {
        this.origins.push({ clipId: id, start: clip.start, trackId: clip.trackId });
      }
    }
    const main = this.origins.find((origin) => origin.clipId === clipId);
    this.grabOffset = main ? grabTimeSeconds - main.start : 0;
  }

  /**
   * Updates the preview.
   * @param pointerTime where the pointer is now.
   * @param targetTrackId the track under the pointer.
   * @param shiftDown true when Shift suppresses snapping.
   */
  update(pointerTime: number, targetTrackId: string | null, shiftDown: boolean): void {
    const doc = this.options.getDocument();
    const movingIds = this.origins.map((origin) => origin.clipId);
    const rawStart = pointerTime - this.grabOffset;
    let delta = rawStart - (this.origins[0]?.start ?? 0);
    if (!shiftDown) {
      const candidates = this.options.snapCandidates(movingIds);
      // Snap the earliest moving edge: try start and end of the whole drag.
      const earliest = Math.min(...this.origins.map((origin) => origin.start), Infinity);
      const latest = Math.max(
        ...this.origins.map((origin) => {
          const clip = currentTimeline(doc).clips.find((c) => c.id === origin.clipId);
          return origin.start + (clip?.duration ?? 0);
        }),
        -Infinity,
      );
      const snappedStart = this.options.snap(Rational.approximate(earliest + delta) ?? Rational.ZERO, candidates);
      const snappedEnd = this.options.snap(Rational.approximate(latest + delta) ?? Rational.ZERO, candidates);
      const deltaStart = snappedStart.asNumber() - earliest;
      const deltaEnd = snappedEnd.asNumber() - latest;
      delta = Math.abs(deltaStart) <= Math.abs(deltaEnd) ? deltaStart : deltaEnd;
    }
    const preview: ClipDragPreview = { offsets: new Map() };
    const timelineNow = currentTimeline(doc);
    for (const origin of this.origins) {
      const clip = timelineNow.clips.find((candidate) => candidate.id === origin.clipId);
      if (!clip) continue;
      let toTrack = origin.trackId;
      if (targetTrackId) {
        const track = timelineNow.tracks.find((candidate) => candidate.id === targetTrackId);
        if (track && kindFitsTrack(clip.kind, trackKindOf(doc, track))) toTrack = targetTrackId;
      }
      preview.offsets.set(origin.clipId, { deltaTime: delta, toTrackId: toTrack });
    }
    this.options.view.setDragPreview(preview);
    this.options.view.requestRender();
  }

  /** The operations that finish the move (one per origin). */
  commit(): EditOperation[] {
    const doc = this.options.getDocument();
    const preview = this.options.view.dragPreview();
    const ops: EditOperation[] = [];
    if (!preview) return ops;
    const timeline = currentTimeline(doc);
    for (const origin of this.origins) {
      const offset = preview.offsets.get(origin.clipId);
      const clip = timeline.clips.find((candidate) => candidate.id === origin.clipId);
      if (!offset || !clip) continue;
      const toStart = clip.start + offset.deltaTime;
      const toTrack = offset.toTrackId ?? origin.trackId;
      if (Math.abs(toStart - origin.start) < 1e-6 && toTrack === origin.trackId) continue;
      ops.push(
        this.options.operationFor(
          origin.clipId,
          origin.trackId,
          toTrack,
          Rational.approximate(origin.start) ?? Rational.ZERO,
          Rational.approximate(toStart) ?? Rational.ZERO,
        ),
      );
    }
    this.cancel();
    return ops;
  }

  /** Drops the preview (also after commit). */
  cancel(): void {
    this.origins = [];
    this.options.view.setDragPreview(null);
    this.options.view.requestRender();
  }

  /**
   * Collects the clips that must ride along: selection, group, link.
   * @param clipId the grabbed clip.
   * @param selectedIds the current selection.
   * @returns unique ids to move.
   */
  static companionIds(doc: ProjectDocument, clipId: string, selectedIds: string[]): string[] {
    const timeline = currentTimeline(doc);
    const set = new Set<string>();
    if (selectedIds.includes(clipId)) {
      for (const id of selectedIds) set.add(id);
    }
    for (const id of groupMembers(timeline, clipId)) set.add(id);
    for (const id of linkMembers(timeline, clipId)) set.add(id);
    set.delete(clipId);
    return [...set];
  }
}

/**
 * The default `operationFor` of the drag manager.
 * @param clipId the moved clip.
 * @param fromTrackId origin lane.
 * @param toTrackId target lane.
 * @param fromStart origin time.
 * @param toStart target time.
 * @returns the move operation.
 */
export function moveOperationFor(
  clipId: string,
  fromTrackId: string,
  toTrackId: string,
  fromStart: Rational,
  toStart: Rational,
): EditOperation {
  return new MoveClipOperation(clipId, fromTrackId, toTrackId, fromStart, toStart);
}

/** Loads `requireClip` for consumers of this module. */
export { requireClip };
