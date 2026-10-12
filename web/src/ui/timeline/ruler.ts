// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The timeline ruler: time labels, second/minute grid, and clickable
 * markers drawn over it. Also double-click to add a marker.
 */

import type { MarkerData } from '../../editor/operations.ts';
import type { ThemeColors, TimelineViewport } from './types.ts';

/** Height of the ruler strip in pixels. */
export const RULER_HEIGHT = 28;

/** How many seconds each grid step marks, given the zoom. */
function gridStep(pixelsPerSecond: number): number {
  const options = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
  for (const step of options) {
    if (step * pixelsPerSecond >= 60) return step;
  }
  return 600;
}

/** Formats seconds as `m:ss` / `h:mm:ss`. */
export function formatRulerTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Draws the ruler grid and its labels.
 * @param ctx the ruler canvas context.
 * @param viewport the current viewport.
 * @param colors the theme.
 * @param width canvas width.
 */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  viewport: TimelineViewport,
  colors: ThemeColors,
  width: number,
): void {
  ctx.clearRect(0, 0, width, RULER_HEIGHT);
  ctx.fillStyle = colors.rulerBackground;
  ctx.fillRect(0, 0, width, RULER_HEIGHT);
  const step = gridStep(viewport.pixelsPerSecond);
  const first = Math.floor(viewport.scrollTime / step) * step;
  const last = viewport.scrollTime + width / viewport.pixelsPerSecond;
  ctx.strokeStyle = colors.gridLine;
  ctx.fillStyle = colors.textDim;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.beginPath();
  for (let time = first; time <= last + step; time += step) {
    const x = Math.round((time - viewport.scrollTime) * viewport.pixelsPerSecond) + 0.5;
    ctx.moveTo(x, RULER_HEIGHT - 10);
    ctx.lineTo(x, RULER_HEIGHT);
    ctx.fillText(formatRulerTime(time), x + 3, 4);
  }
  ctx.stroke();
  // Minor ticks each half step.
  ctx.beginPath();
  for (let time = first; time <= last + step; time += step / 2) {
    const x = Math.round((time - viewport.scrollTime) * viewport.pixelsPerSecond) + 0.5;
    ctx.moveTo(x, RULER_HEIGHT - 5);
    ctx.lineTo(x, RULER_HEIGHT);
  }
  ctx.stroke();
  ctx.strokeStyle = colors.border;
  ctx.beginPath();
  ctx.moveTo(0, RULER_HEIGHT - 0.5);
  ctx.lineTo(width, RULER_HEIGHT - 0.5);
  ctx.stroke();
}

/**
 * Draws the markers over the ruler.
 * @param ctx the ruler canvas context.
 * @param markers the markers to draw.
 * @param viewport the current viewport.
 * @param width canvas width.
 */
export function drawMarkers(
  ctx: CanvasRenderingContext2D,
  markers: MarkerData[],
  viewport: TimelineViewport,
  width: number,
): void {
  for (const marker of markers) {
    const x = (marker.time.asNumber() - viewport.scrollTime) * viewport.pixelsPerSecond;
    if (x < -8 || x > width + 8) continue;
    ctx.fillStyle = marker.color === '' ? '#4c8dff' : marker.color;
    // A pennant at the top of the ruler.
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 7, 5);
    ctx.lineTo(x, 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(Math.round(x) - 0.5, 8, 1.5, RULER_HEIGHT - 8);
    if (marker.label !== '') {
      ctx.fillStyle = '#e8e8ea';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(marker.label, x + 9, 12);
    }
  }
}

/**
 * The marker under a ruler click.
 * @param markers the markers.
 * @param viewport the current viewport.
 * @param x click x in content pixels.
 * @param y click y inside the ruler.
 * @returns the marker hit, or `null`.
 */
export function markerAtPosition(
  markers: MarkerData[],
  viewport: TimelineViewport,
  x: number,
  y: number,
): MarkerData | null {
  if (y > RULER_HEIGHT) return null;
  for (const marker of markers) {
    const mx = (marker.time.asNumber() - viewport.scrollTime) * viewport.pixelsPerSecond;
    if (Math.abs(mx - x) <= 6) return marker;
  }
  return null;
}
