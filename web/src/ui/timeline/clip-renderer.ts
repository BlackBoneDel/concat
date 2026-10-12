// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Draws clip faces on the content canvas: color-coded bodies, names,
 * thumbnails, waveforms, fade ramps, missing/disabled states and the
 * selection outline. Clips outside the viewport are culled.
 */

import type { DocumentClip } from '../../model/document.ts';
import type { ProjectDocument } from '../../model/document.ts';
import { clipEnabled, transitionIdOf } from '../../editor/operations.ts';
import type { SelectionManager } from '../../editor/selection.ts';
import type { ThumbnailRenderer } from './thumbnail-renderer.ts';
import type { WaveformRenderer } from './waveform-renderer.ts';
import type { ClipDragPreview, ThemeColors, TimelineViewport, TrackLayout } from './types.ts';

/** Everything {@link drawClips} needs. */
export interface DrawClipsContext {
  clips: DocumentClip[];
  layouts: TrackLayout[];
  viewport: TimelineViewport;
  colors: ThemeColors;
  width: number;
  height: number;
  selection: SelectionManager;
  document: ProjectDocument;
  waveform: WaveformRenderer;
  thumbnails: ThumbnailRenderer;
  preview: ClipDragPreview | null;
  /** Fase 5: clips with an open keyframe lane (button shows ⏶). */
  expanded?: ReadonlySet<string>;
}

/** Padding inside a clip face. */
export const FACE_PADDING = 4;

/**
 * Fase 5: the "⏷" keyframe-lane button of a clip face.
 * @param x face x.
 * @param y face y.
 * @param w face width.
 * @returns the button rectangle, or `null` when the face is too narrow.
 */
export function expandButtonRect(x: number, y: number, w: number): { x: number; y: number; w: number; h: number } | null {
  if (w < 44) return null;
  return { x: x + w - 20, y: y + 2, w: 16, h: 14 };
}

/**
 * Paints every visible clip.
 * @param ctx the content canvas context.
 * @param context the draw context.
 */
export function drawClips(ctx: CanvasRenderingContext2D, context: DrawClipsContext): void {
  const { viewport, width, height, preview } = context;
  const layoutById = new Map(context.layouts.map((layout) => [layout.trackId, layout]));
  for (const clip of context.clips) {
    // Drag preview: paint where the gesture holds the clip.
    const offset = preview?.offsets.get(clip.id);
    const trim = preview?.trims?.get(clip.id);
    const drawTrackId = offset?.toTrackId ?? clip.trackId;
    const layout = layoutById.get(drawTrackId);
    if (!layout) continue;
    const drawStart = trim ? trim.start : clip.start + (offset?.deltaTime ?? 0);
    const drawDuration = trim ? trim.duration : clip.duration;
    const x = (drawStart - viewport.scrollTime) * viewport.pixelsPerSecond;
    const w = drawDuration * viewport.pixelsPerSecond;
    if (x > width || x + w < 0) continue;
    const y = layout.y - viewport.scrollTop + FACE_PADDING;
    // Fase 5: the keyframe lane band sits below the faces.
    const h = layout.height - (layout.keyframeLane ?? 0) - FACE_PADDING * 2;
    if (y > height || y + h < 0) continue;
    drawClipFace(ctx, clip, x, y, Math.max(2, w), h, context);
  }
}

/** The body color of one clip. */
function faceColor(clip: DocumentClip, colors: ThemeColors, missing: boolean, enabled: boolean): string {
  if (missing) return colors.clipMissing;
  if (!enabled) return colors.clipDisabled;
  const label = clip.extra['colorLabel'];
  if (typeof label === 'string' && label !== '') return label;
  if (clip.kind === 'audio') return colors.clipAudio;
  if (clip.kind === 'image') return colors.clipImage;
  return colors.clipVideo;
}

/** Draws one clip body and its ornaments. */
function drawClipFace(
  ctx: CanvasRenderingContext2D,
  clip: DocumentClip,
  x: number,
  y: number,
  w: number,
  h: number,
  context: DrawClipsContext,
): void {
  const { colors, selection, viewport, waveform, thumbnails } = context;
  const missing = clip.extra['missing'] === true;
  const enabled = clipEnabled(clip);
  const selected = selection.isSelected(clip.id);
  ctx.save();
  roundedRect(ctx, x, y, w, h, 4);
  ctx.clip();
  ctx.fillStyle = faceColor(clip, colors, missing, enabled);
  ctx.fillRect(x, y, w, h);
  if (enabled) {
    if (clip.kind === 'audio') {
      ctx.globalAlpha = 0.85;
      waveform.draw(ctx, clip, x, y + 18, w, h - 18, colors, viewport.pixelsPerSecond);
      ctx.globalAlpha = 1;
    } else {
      thumbnails.draw(ctx, clip, x, y, h);
    }
    drawFades(ctx, clip, x, y, w, h, viewport.pixelsPerSecond);
  }
  // Labels.
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const name = clip.name === '' ? clip.id : clip.name;
  const button = expandButtonRect(x, y, w);
  ctx.fillText(name, x + 8, y + 3, Math.max(10, w - 16 - (button ? 20 : 0)));
  if (button) {
    // Fase 5: keyframe lane toggle; a dot marks clips that have keys.
    const open = context.expanded?.has(clip.id) === true;
    ctx.fillStyle = open ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
    ctx.fillRect(button.x, button.y, button.w, button.h);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(open ? '⏶' : '⏷', button.x + button.w / 2, button.y + 1);
    ctx.textAlign = 'left';
    if (clip.keys.length > 0 && !open) {
      ctx.beginPath();
      ctx.arc(button.x - 4, button.y + button.h / 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (missing) {
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('MISSING', x + 8, y + h / 2);
  } else if (!enabled) {
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('DISABLED', x + 8, y + h / 2);
  }
  // Bottom time strip.
  if (w > 72) {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatSpan(clip.duration), x + 8, y + h - 3);
  }
  ctx.restore();
  // Transition notch at the left edge (what flows in).
  if (clip.transitionIn) {
    ctx.fillStyle = colors.transition;
    ctx.fillRect(x, y, Math.min(10, w), 3);
  }
  if (selected) {
    ctx.strokeStyle = colors.clipSelected;
    ctx.lineWidth = 2;
    roundedRect(ctx, x + 1, y + 1, w - 2, h - 2, 4);
    ctx.stroke();
    ctx.lineWidth = 1;
  } else {
    ctx.strokeStyle = colors.border;
    roundedRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4);
    ctx.stroke();
  }
  void transitionIdOf;
}

/** Audio fade ramps, drawn as diagonal edges. */
function drawFades(
  ctx: CanvasRenderingContext2D,
  clip: DocumentClip,
  x: number,
  y: number,
  w: number,
  h: number,
  pixelsPerSecond: number,
): void {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  if (clip.fadeIn > 0) {
    const fw = Math.min(w, clip.fadeIn * pixelsPerSecond);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + fw, y);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fill();
  }
  if (clip.fadeOut > 0) {
    const fw = Math.min(w, clip.fadeOut * pixelsPerSecond);
    ctx.beginPath();
    ctx.moveTo(x + w, y);
    ctx.lineTo(x + w - fw, y);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }
}

/** A rounded rectangle path. */
export function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Seconds → `1:23.4` style label. */
function formatSpan(seconds: number): string {
  const total = Math.max(0, seconds);
  const whole = Math.floor(total);
  const tenths = Math.floor((total - whole) * 10);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}.${tenths}`;
}
