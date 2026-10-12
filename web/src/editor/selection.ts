// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Which clips are selected. Clicks add, toggle or replace; groups and links
 * pull their members in; ranges come from the selection lasso and time
 * ranges.
 */

import { Rational } from '../core/rational.ts';
import type { ProjectDocument } from '../model/document.ts';
import { currentTimeline, groupMembers, linkMembers, type MarkerData } from './operations.ts';

/** The selection of one timeline. */
export class SelectionManager {
  /** Fired whenever the selection changes. */
  onSelectionChanged: ((ids: ReadonlySet<string>) => void) | null = null;

  private ids = new Set<string>();
  /** When on, selecting one member selects the whole group/link. */
  expandGroups = true;

  /**
   * Selects one clip.
   * @param clipId the clip.
   * @param additive true to keep what is already selected (Shift+click).
   * @param doc the document, needed for group/link expansion.
   */
  selectClip(clipId: string, additive = false, doc?: ProjectDocument): void {
    if (!additive) this.ids.clear();
    for (const id of this.expand(clipId, doc)) this.ids.add(id);
    this.fire();
  }

  /**
   * Drops one clip (and its group/link members) from the selection.
   * @param clipId the clip.
   * @param doc the document, needed for group/link expansion.
   */
  deselectClip(clipId: string, doc?: ProjectDocument): void {
    for (const id of this.expand(clipId, doc)) this.ids.delete(id);
    this.fire();
  }

  /**
   * Toggles one clip (Ctrl+click).
   * @param clipId the clip.
   * @param doc the document, needed for group/link expansion.
   */
  toggleClip(clipId: string, doc?: ProjectDocument): void {
    const members = this.expand(clipId, doc);
    const allSelected = members.every((id) => this.ids.has(id));
    for (const id of members) {
      if (allSelected) this.ids.delete(id);
      else this.ids.add(id);
    }
    this.fire();
  }

  /**
   * Selects several clips.
   * @param clipIds the clips.
   * @param additive true to keep the current selection.
   * @param doc the document, needed for group/link expansion.
   */
  selectClips(clipIds: string[], additive = false, doc?: ProjectDocument): void {
    if (!additive) this.ids.clear();
    for (const clipId of clipIds) {
      for (const id of this.expand(clipId, doc)) this.ids.add(id);
    }
    this.fire();
  }

  /**
   * Selects every clip touching a time range on the given lanes.
   * @param startTime range start.
   * @param endTime range end.
   * @param trackIds the lanes to consider.
   * @param doc the document.
   * @param additive true to keep the current selection.
   */
  selectRange(
    startTime: Rational,
    endTime: Rational,
    trackIds: string[],
    doc: ProjectDocument,
    additive = false,
  ): void {
    if (!additive) this.ids.clear();
    const from = Math.min(startTime.asNumber(), endTime.asNumber());
    const to = Math.max(startTime.asNumber(), endTime.asNumber());
    for (const clip of currentTimeline(doc).clips) {
      if (!trackIds.includes(clip.trackId)) continue;
      const clipStart = clip.start;
      const clipStop = clip.start + clip.duration;
      if (clipStop > from + 1e-9 && clipStart < to - 1e-9) {
        for (const id of this.expand(clip.id, doc)) this.ids.add(id);
      }
    }
    this.fire();
  }

  /**
   * Selects every clip of the document.
   * @param doc the document.
   */
  selectAll(doc: ProjectDocument): void {
    this.ids = new Set(currentTimeline(doc).clips.map((clip) => clip.id));
    this.fire();
  }

  /**
   * Selects every clip of one lane.
   * @param trackId the lane.
   * @param doc the document.
   */
  selectAllInTrack(trackId: string, doc: ProjectDocument): void {
    for (const clip of currentTimeline(doc).clips) {
      if (clip.trackId === trackId) this.ids.add(clip.id);
    }
    this.fire();
  }

  /** Empties the selection. */
  clearSelection(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.fire();
  }

  /**
   * @param clipId the clip to test.
   * @returns whether it is selected.
   */
  isSelected(clipId: string): boolean {
    return this.ids.has(clipId);
  }

  /** The selected ids. */
  get selectedClipIds(): ReadonlySet<string> {
    return this.ids;
  }

  /** True when anything is selected. */
  get hasSelection(): boolean {
    return this.ids.size > 0;
  }

  /** How many clips are selected. */
  get selectionCount(): number {
    return this.ids.size;
  }

  /**
   * The time/track box around the selection.
   * @param doc the document.
   * @returns the bounds, or `null` when nothing is selected.
   */
  selectionBounds(doc: ProjectDocument): { start: Rational; end: Rational; trackIds: Set<string> } | null {
    const timeline = currentTimeline(doc);
    const clips = timeline.clips.filter((clip) => this.ids.has(clip.id));
    if (clips.length === 0) return null;
    const start = Math.min(...clips.map((clip) => clip.start));
    const end = Math.max(...clips.map((clip) => clip.start + clip.duration));
    const trackIds = new Set(clips.map((clip) => clip.trackId));
    return {
      start: Rational.approximate(start) ?? Rational.ZERO,
      end: Rational.approximate(end) ?? Rational.ZERO,
      trackIds,
    };
  }

  // -- internals -----------------------------------------------------------

  /** Group and link members of `clipId`, or just itself. */
  private expand(clipId: string, doc?: ProjectDocument): string[] {
    if (!doc || !this.expandGroups) return [clipId];
    const timeline = currentTimeline(doc);
    const expanded = new Set<string>([clipId, ...groupMembers(timeline, clipId), ...linkMembers(timeline, clipId)]);
    return [...expanded];
  }

  private fire(): void {
    this.onSelectionChanged?.(this.ids);
  }
}

/** Marker under a time, for marker-aware shortcuts. */
export function markerAt(markers: MarkerData[], time: Rational, epsilon = 0.05): MarkerData | null {
  return markers.find((marker) => Math.abs(marker.time.asNumber() - time.asNumber()) <= epsilon) ?? null;
}
