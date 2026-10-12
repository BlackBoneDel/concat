// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Draws transitions where clips meet: the incoming clip carries the
 * transition, so its left edge wears the badge (kind + duration).
 */

import type { DocumentClip } from '../../model/document.ts';
import { transitionIdOf, type TransitionKind } from '../../editor/operations.ts';
import type { ThemeColors, TimelineViewport, TrackLayout } from './types.ts';

/** Everything {@link drawTransitions} needs. */
export interface DrawTransitionsContext {
  clips: DocumentClip[];
  layouts: TrackLayout[];
  viewport: TimelineViewport;
  colors: ThemeColors;
}

/** Short labels for the badges. */
const SHORT_LABELS: Record<TransitionKind, string> = {
  crossfade: 'XFADE',
  'fade-black': 'FADE',
  'fade-white': 'FLASH',
  dissolve: 'DISS',
  'wipe-left': 'W-◀',
  'wipe-right': 'W-▶',
  'wipe-up': 'W-▲',
  'wipe-down': 'W-▼',
  'slide-left': 'S-◀',
  'slide-right': 'S-▶',
};

/**
 * Paints the transition badges of visible clips.
 * @param ctx the content canvas context.
 * @param context the draw context.
 */
export function drawTransitions(
  ctx: CanvasRenderingContext2D,
  context: DrawTransitionsContext,
): void {
  const { viewport, colors, clips, layouts } = context;
  const layoutById = new Map(layouts.map((layout) => [layout.trackId, layout]));
  for (const clip of clips) {
    if (!clip.transitionIn) continue;
    const layout = layoutById.get(clip.trackId);
    if (!layout) continue;
    const x = (clip.start - viewport.scrollTime) * viewport.pixelsPerSecond;
    const w = clip.duration * viewport.pixelsPerSecond;
    if (x > 2000 || x + w < 0) continue;
    const y = layout.y - viewport.scrollTop;
    const badgeWidth = Math.min(Math.max(28, w * 0.4), 64);
    ctx.fillStyle = colors.transition;
    ctx.globalAlpha = 0.9;
    // Trapezoid badge across the left edge.
    ctx.beginPath();
    ctx.moveTo(x, y + 8);
    ctx.lineTo(x + badgeWidth, y + 22);
    ctx.lineTo(x + badgeWidth, y + layout.height - 30);
    ctx.lineTo(x, y + layout.height - 16);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const labels: Readonly<Record<string, string>> = SHORT_LABELS;
    ctx.fillText(labels[clip.transitionIn.id] ?? 'TR', x + 3, y + 10);
    ctx.fillText(`${clip.transitionIn.duration.toFixed(1)}s`, x + 3, y + 21);
    void transitionIdOf;
  }
}
