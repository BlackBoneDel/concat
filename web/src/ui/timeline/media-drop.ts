// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The timeline as a drop target for the media library: a card dragged from
 * the left panel lands on the lane under the pointer — or on a brand-new
 * lane when it is dropped over empty space — snapped to the playhead, the
 * clip edges and the markers unless Shift is held.
 *
 * The install is written against structural event/transfer types so it is
 * testable in jsdom (which ships neither `DataTransfer` nor `DragEvent`) and
 * so the same code can be driven by real browser events.
 */

import { Rational } from '../../core/rational.ts';
import type { SnapCandidate, SnapResult } from '../../editor/snapping.ts';
import { markDropHandled } from '../dnd/drop-handled.ts';
import { hasMediaDrag, readMediaDrag, type MediaDragEventLike, type MediaDragPayload } from '../dnd/media-drag.ts';
import type { DropPreviewState } from './drop-preview.ts';
import type { TimelineViewport, TrackLayout } from './types.ts';

/** Insertion mode of a drop (overwrite replaces, insert pushes the tail). */
export type DropMode = 'insert' | 'overwrite';

/** What the installer needs from its host (the timeline panel). */
export interface MediaDropOptions {
  /** The element that receives the drag events. */
  target: HTMLElement;
  /** The content area's rect (pointer → content coordinates). */
  contentRect(): { left: number; top: number };
  /** The live viewport (zoom + scroll). */
  viewport(): TimelineViewport;
  /** The laid-out tracks, top to bottom. */
  layouts(): readonly TrackLayout[];
  /** The lane under a viewport-space y, or `null` between lanes. */
  trackAtY(y: number): string | null;
  /** Whether the magnetic snapping is on. */
  snappingEnabled(): boolean;
  /** Builds the snap candidates for the current document. */
  candidates(excludeClipIds: string[]): SnapCandidate[];
  /** Runs the snap engine at the current zoom. */
  snap(time: Rational, candidates: SnapCandidate[]): SnapResult;
  /** The lane kind a media drop wants. */
  kindForMedia(payload: MediaDragPayload): 'video' | 'audio';
  /** Creates a lane and returns its id (`null` on failure). */
  createTrack(kind: 'video' | 'audio'): string | null;
  /**
   * The kind of an existing lane (needed to route an audio card dropped over
   * a video lane to an audio one instead of failing).
   */
  trackKind?(trackId: string): 'video' | 'audio' | null;
  /** The first lane of `kind`, if the document has one. */
  trackOfKind?(kind: 'video' | 'audio'): string | null;
  /** Inserts the clip; throws (or returns `false`) when the document refuses. */
  insert(payload: MediaDragPayload, trackId: string, atTime: Rational, mode: DropMode): void;
  /** Visual-only preview updates (`null` clears it). */
  onPreview(state: DropPreviewState | null): void;
  /** The guide of the candidate the preview locked on (`null` clears it). */
  onGuide(candidate: SnapCandidate | null): void;
  /** The drop landed; called once per successful gesture. */
  onDrop(result: { payload: MediaDragPayload; trackId: string; atTime: Rational; createdTrack: boolean }): void;
  /** The host reports failures (toast). */
  onError?(error: unknown): void;
  /** Class toggled while a media drag hovers (default `timeline-drop-active`). */
  activeClass?: string;
}

/** A disposable installer. */
export interface MediaDropHandle {
  dispose(): void;
}

/**
 * Makes a timeline panel accept media drags from the library.
 * @param options host wiring.
 * @returns a handle whose `dispose()` removes every listener.
 */
export function installMediaDrop(options: MediaDropOptions): MediaDropHandle {
  const activeClass = options.activeClass ?? 'timeline-drop-active';
  let state: DropPreviewState | null = null;
  /** Escape during a drag: the gesture is over, a stray drop must be ignored. */
  let cancelled = false;

  /** Pointer → content point, using the one rect the whole view shares. */
  const contentPoint = (event: MediaDragEventLike): { x: number; y: number } => {
    const rect = options.contentRect();
    return { x: (event.clientX ?? 0) - rect.left, y: (event.clientY ?? 0) - rect.top };
  };

  /** Time under the pointer, snapped unless Shift says otherwise. */
  const timeAt = (
    x: number,
    shiftKey: boolean,
  ): { atTime: Rational; snappedTo: SnapCandidate | null } => {
    const viewport = options.viewport();
    const raw = Rational.approximate(Math.max(0, x / Math.max(1e-6, viewport.pixelsPerSecond))) ?? Rational.ZERO;
    if (shiftKey || !options.snappingEnabled()) return { atTime: raw, snappedTo: null };
    const candidates = options.candidates([]);
    const result = options.snap(raw, candidates);
    return { atTime: result.snappedTime, snappedTo: result.snappedTo };
  };

  /** Recomputes and publishes the ghost under the pointer. */
  const preview = (event: MediaDragEventLike, payload: MediaDragPayload): DropPreviewState => {
    const { x, y } = contentPoint(event);
    const { atTime, snappedTo } = timeAt(x, event.shiftKey === true);
    const durationSeconds = payload.durationSeconds > 0 ? payload.durationSeconds : 5;
    const trackId = y < 0 ? null : options.trackAtY(y);
    state = {
      mediaId: payload.mediaId,
      kind: options.kindForMedia(payload),
      trackId,
      atTime,
      duration: Rational.approximate(durationSeconds) ?? Rational.ZERO,
      snappedTo,
      pointerY: y,
    };
    options.onPreview(state);
    options.onGuide(snappedTo);
    return state;
  };

  const clear = (target: HTMLElement): void => {
    state = null;
    target.classList.remove(activeClass);
    options.onPreview(null);
    options.onGuide(null);
  };

  const onDragEnter = (event: MediaDragEventLike & Event): void => {
    const payload = readMediaDrag(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    cancelled = false;
    options.target.classList.add(activeClass);
    preview(event, payload);
  };

  const onDragOver = (event: MediaDragEventLike & Event): void => {
    const payload = readMediaDrag(event.dataTransfer);
    if (!payload) return;
    // Without preventDefault the browser refuses the drop.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!cancelled) preview(event, payload);
  };

  const onDragLeave = (event: MediaDragEventLike & Event): void => {
    if (!hasMediaDrag(event.dataTransfer)) return;
    // Only a real exit clears the ghost: children fire dragleave on their way.
    const related = (event as unknown as { relatedTarget?: unknown }).relatedTarget;
    if (related instanceof Node && options.target.contains(related)) return;
    clear(options.target);
  };

  const onDrop = (event: MediaDragEventLike & Event): void => {
    const payload = readMediaDrag(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    event.stopPropagation();
    // Claim it: a window-level drop handler must not process it again.
    markDropHandled(event);
    const dropped = preview(event, payload);
    clear(options.target);
    if (cancelled) {
      cancelled = false;
      return;
    }
    const wanted = dropped.kind;
    const kindOf = (id: string): 'video' | 'audio' | null => options.trackKind?.(id) ?? null;
    let trackId = dropped.trackId;
    let createdTrack = false;
    try {
      // Dropping an audio card over a video lane (or the reverse) is not an
      // error the user has to read about: the drop lands on a lane of the
      // right kind — the first one, or a brand-new lane below the last.
      if (trackId !== null && options.trackKind && kindOf(trackId) !== wanted) {
        trackId = options.trackOfKind?.(wanted) ?? null;
      }
      if (trackId === null) {
        trackId = options.createTrack(wanted);
        createdTrack = true;
        if (trackId === null) throw new Error('No se pudo crear la pista');
      }
      options.insert(payload, trackId, dropped.atTime, 'overwrite');
    } catch (error) {
      options.onError?.(error);
      return;
    }
    options.onDrop({ payload, trackId, atTime: dropped.atTime, createdTrack });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || state === null) return;
    cancelled = true;
    clear(options.target);
  };

  const target = options.target;
  target.addEventListener('dragenter', onDragEnter as EventListener);
  target.addEventListener('dragover', onDragOver as EventListener);
  target.addEventListener('dragleave', onDragLeave as EventListener);
  target.addEventListener('drop', onDrop as EventListener);
  document.addEventListener('keydown', onKeyDown);
  return {
    dispose(): void {
      target.removeEventListener('dragenter', onDragEnter as EventListener);
      target.removeEventListener('dragover', onDragOver as EventListener);
      target.removeEventListener('dragleave', onDragLeave as EventListener);
      target.removeEventListener('drop', onDrop as EventListener);
      document.removeEventListener('keydown', onKeyDown);
      clear(target);
    },
  };
}
