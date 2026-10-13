// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The ghost the timeline paints while a library card hovers it: where the
 * clip would land (`rgba(76, 175, 80, 0.4)` with a `#4caf50` border), plus a
 * dashed outline when the drop would create a lane of its own. Pure canvas
 * painting — the state it draws comes from `media-drop.ts`.
 */

import { Rational } from '../../core/rational.ts';
import type { SnapCandidate } from '../../editor/snapping.ts';
import {
  TRACK_HEIGHT_AUDIO,
  TRACK_HEIGHT_VIDEO,
  type TimelineViewport,
  type TrackLayout,
} from './types.ts';

/** The fill of the drop ghost. */
export const DROP_FILL = 'rgba(76, 175, 80, 0.4)';
/** The border of the drop ghost. */
export const DROP_BORDER = '#4caf50';

/** Where a drag currently holds the clip it carries. */
export interface DropPreviewState {
  mediaId: string;
  /** The kind of lane the drop wants. */
  kind: 'video' | 'audio';
  /** The lane under the pointer, or `null` when a new one would be created. */
  trackId: string | null;
  /** Where the clip would start (already snapped). */
  atTime: Rational;
  /** How long it would last. */
  duration: Rational;
  /** The candidate the snap engine locked on, when it snapped. */
  snappedTo: SnapCandidate | null;
  /** The pointer's viewport-space y (positions the new-lane ghost). */
  pointerY: number;
}

/** A rectangle in viewport space. */
export interface DropPreviewRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the drop would create a lane (dashed outline). */
  newTrack: boolean;
}

/**
 * The lane height of a kind. Shared with the layout so the ghost always
 * matches the row it points at.
 * @param kind video or audio.
 * @returns pixels.
 */
export function laneHeight(kind: 'video' | 'audio'): number {
  return kind === 'audio' ? TRACK_HEIGHT_AUDIO : TRACK_HEIGHT_VIDEO;
}

/**
 * The rectangle the drop ghost occupies.
 * @param state the live drag state.
 * @param layouts the laid-out tracks (content space).
 * @param viewport the current viewport (zoom + scroll).
 * @returns the rectangle, or `null` when there is nothing to draw.
 */
export function dropPreviewRect(
  state: DropPreviewState,
  layouts: readonly TrackLayout[],
  viewport: TimelineViewport,
): DropPreviewRect | null {
  const duration = Math.max(0.05, state.duration.asNumber());
  const w = Math.max(3, duration * viewport.pixelsPerSecond);
  const x = (state.atTime.asNumber() - viewport.scrollTime) * viewport.pixelsPerSecond;
  const lane = state.trackId === null ? null : layouts.find((layout) => layout.trackId === state.trackId) ?? null;
  if (lane) {
    return {
      x,
      y: lane.y - viewport.scrollTop,
      w,
      h: Math.max(8, lane.height),
      newTrack: false,
    };
  }
  // A brand-new lane goes below the last one: anchor it at the bottom edge.
  const last = layouts[layouts.length - 1];
  const bottom = last ? last.y + last.height : 0;
  return { x, y: bottom - viewport.scrollTop, w, h: laneHeight(state.kind), newTrack: true };
}

/**
 * Paints the drop ghost.
 * @param ctx the content canvas context.
 * @param rect the rectangle to paint.
 * @param radius corner radius (default 4).
 */
export function drawDropPreview(
  ctx: CanvasRenderingContext2D,
  rect: DropPreviewRect,
  radius = 4,
): void {
  const { x, y, w, h } = rect;
  ctx.save();
  if (rect.newTrack) ctx.setLineDash([6, 4]);
  ctx.fillStyle = DROP_FILL;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = DROP_BORDER;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2));
  ctx.setLineDash([]);
  if (rect.newTrack) {
    // A lane is about to be born: label it so the gesture is unambiguous.
    ctx.fillStyle = DROP_BORDER;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('+ pista nueva', x + 6, y + h / 2);
  }
  ctx.restore();
  void radius;
}
