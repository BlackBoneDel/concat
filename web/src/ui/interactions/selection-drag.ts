// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Selection gestures: click, Ctrl/Cmd toggle, Shift ranges, and the
 * marquee (lasso) that adds every clip it touches with Shift, or replaces
 * the selection without.
 */

import type { ProjectDocument } from '../../model/document.ts';
import { currentTimeline, groupMembers, linkMembers } from '../../editor/operations.ts';
import type { SelectionManager } from '../../editor/selection.ts';
import type { TimelineView } from '../timeline/timeline-view.ts';

/** A marquee in progress. */
export interface MarqueeState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** True when the gesture adds to the selection. */
  additive: boolean;
}

/** Everything selection gestures need. */
export interface SelectionDragOptions {
  view: TimelineView;
  selection: SelectionManager;
  getDocument(): ProjectDocument;
  onChange(): void;
}

/** Click and marquee selection on the timeline. */
export class SelectionDrag {
  private readonly options: SelectionDragOptions;
  private marquee: MarqueeState | null = null;

  /**
   * @param options host wiring.
   */
  constructor(options: SelectionDragOptions) {
    this.options = options;
  }

  /**
   * Handles a pointerdown on empty space (or a clip, with modifiers).
   * @param x content x.
   * @param y content y.
   * @param modifiers the modifier keys held.
   * @returns true when the gesture started here.
   */
  begin(
    x: number,
    y: number,
    modifiers: { ctrl: boolean; shift: boolean },
  ): boolean {
    this.marquee = {
      fromX: x,
      fromY: y,
      toX: x,
      toY: y,
      additive: modifiers.ctrl || modifiers.shift,
    };
    return true;
  }

  /**
   * Updates the marquee.
   * @param x pointer x.
   * @param y pointer y.
   */
  update(x: number, y: number): void {
    if (!this.marquee) return;
    this.marquee = { ...this.marquee, toX: x, toY: y };
    this.options.view.requestRender();
  }

  /** The current marquee for the overlay to draw. */
  state(): MarqueeState | null {
    return this.marquee;
  }

  /**
   * Selects the clips the marquee touched.
   * @param extendWithShift true when Shift is held at release (adds).
   */
  commit(extendWithShift: boolean): void {
    const marquee = this.marquee;
    this.marquee = null;
    if (!marquee) return;
    const left = Math.min(marquee.fromX, marquee.toX);
    const right = Math.max(marquee.fromX, marquee.toX);
    const top = Math.min(marquee.fromY, marquee.toY);
    const bottom = Math.max(marquee.fromY, marquee.toY);
    const view = this.options.view;
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const touched: string[] = [];
    for (const clip of timeline.clips) {
      const x1 = view.timeToX(clip.start);
      const x2 = view.timeToX(clip.start + clip.duration);
      const layout = view.trackLayout(clip.trackId);
      if (!layout) continue;
      const y1 = layout.y - view.viewport().scrollTop;
      const y2 = y1 + layout.height;
      if (x2 >= left && x1 <= right && y2 >= top && y1 <= bottom) touched.push(clip.id);
    }
    // Groups and links come along.
    const all = new Set(touched);
    for (const id of touched) {
      for (const member of groupMembers(timeline, id)) all.add(member);
      for (const member of linkMembers(timeline, id)) all.add(member);
    }
    const additive = marquee.additive || extendWithShift;
    this.options.selection.selectClips([...all], additive, this.options.getDocument());
    this.options.onChange();
    this.options.view.requestRender();
  }

  /** Drops the marquee (Escape). */
  cancel(): void {
    this.marquee = null;
    this.options.view.requestRender();
  }

  /**
   * Handles a click on a clip.
   * @param clipId the clip.
   * @param modifiers the modifier keys held.
   */
  clickClip(clipId: string, modifiers: { ctrl: boolean; shift: boolean }): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const ids = new Set([clipId, ...groupMembers(timeline, clipId), ...linkMembers(timeline, clipId)]);
    this.options.selection.selectClips([...ids], modifiers.ctrl || modifiers.shift, this.options.getDocument());
    this.options.onChange();
    this.options.view.requestRender();
  }
}
