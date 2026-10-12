// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Timeline coordinate maths, as pure functions so every interaction (drag &
 * drop, gestures, overlays) converts between pixels and time the same way —
 * always through the live zoom (`pixelsPerSecond`) and the live scroll
 * (`scrollTime` / `scrollTop`), never with hard-coded constants.
 *
 * Two spaces exist and the names matter:
 *
 * - **content space**: pixels measured from the top-left of the scrolled
 *   content element (`.tl-content-wrap`). `x` there is
 *   `time * pixelsPerSecond - scrollTime * pixelsPerSecond`.
 * - **viewport space**: pixels measured from the top-left of the visible
 *   scroll box. `y` is viewport space; the track layout's `y` is content
 *   space, so {@link getTrackAtY} adds `scrollTop` before hit-testing.
 */

import { Rational } from '../../core/rational.ts';
import type { TrackLayout } from './types.ts';

/** A track rectangle in viewport space, ready to paint. */
export interface TrackRect {
  trackId: string;
  /** Top edge, viewport space. */
  y: number;
  height: number;
}

/**
 * Content pixels → timeline time.
 * @param x pixels from the left edge of the content (scroll included).
 * @param pixelsPerSecond current zoom.
 * @returns the time at that pixel; never negative.
 */
export function pixelsToTime(x: number, pixelsPerSecond: number): Rational {
  if (!Number.isFinite(x) || !Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return Rational.ZERO;
  const seconds = Math.max(0, x / pixelsPerSecond);
  return Rational.approximate(seconds) ?? Rational.ZERO;
}

/**
 * Timeline time → content pixels.
 * @param time the time.
 * @param pixelsPerSecond current zoom.
 * @returns pixels from the left edge of the content.
 */
export function timeToPixels(time: Rational, pixelsPerSecond: number): number {
  return time.asNumber() * pixelsPerSecond;
}

/**
 * The track layout under a viewport-space y coordinate.
 * @param y pixels below the top of the visible content area.
 * @param trackLayout laid-out tracks, top to bottom.
 * @param scrollTop the vertical scroll of the content (0 when omitted).
 * @returns the track id there, or `null` in the gaps/outside.
 */
export function getTrackAtY(
  y: number,
  trackLayout: readonly TrackRect[],
  scrollTop = 0,
): string | null {
  const contentY = y + scrollTop;
  for (const track of trackLayout) {
    if (contentY >= track.y && contentY < track.y + track.height) return track.trackId;
  }
  return null;
}

/**
 * The viewport-space rectangle of one track layout.
 * @param layout the layout.
 * @param scrollTop the vertical scroll.
 * @returns the rectangle the pointer hit-tests and the overlay paints.
 */
export function layoutToRect(layout: TrackLayout, scrollTop: number): TrackRect {
  return { trackId: layout.trackId, y: layout.y - scrollTop, height: layout.height };
}

/**
 * Every layout as a viewport-space rectangle.
 * @param layouts the laid-out tracks.
 * @param scrollTop the vertical scroll.
 * @returns the rectangles, top to bottom.
 */
export function layoutRects(layouts: readonly TrackLayout[], scrollTop: number): TrackRect[] {
  return layouts.map((layout) => layoutToRect(layout, scrollTop));
}

/**
 * Local pointer coordinates inside a hit area.
 * @param event an event carrying client coordinates.
 * @param rect the hit area's bounding box.
 * @returns the point relative to the area's top-left corner.
 */
export function localPoint(
  event: { clientX?: number; clientY?: number },
  rect: { left: number; top: number },
): { x: number; y: number } {
  return { x: (event.clientX ?? 0) - rect.left, y: (event.clientY ?? 0) - rect.top };
}
