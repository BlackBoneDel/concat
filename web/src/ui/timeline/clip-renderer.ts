// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Draws clip faces on the content canvas — the CapCut-style body of an NLE:
 *
 * - a vertical gradient body per kind (blue for video, green for audio,
 *   violet for stills) with a 2 px accent border along the top,
 * - an opaque 18 px name bar (`rgba(0,0,0,0.4)`) holding the clip's type glyph
 *   and its name, truncated with an ellipsis,
 * - a **filmstrip** of the media inside video faces once the zoom is wide
 *   enough (`MIN_STRIP_PIXELS_PER_SECOND`); a neutral checkerboard placeholder
 *   while the frames are still being generated,
 * - the waveform inside audio faces,
 * - selection (`2 px #ffeb3b` + glow), locked (diagonal hatching) and disabled
 *   (`0.4` alpha) states, plus fades, transitions and the missing badge.
 *
 * Clips outside the viewport are culled.
 */

import type { DocumentClip, ProjectDocument } from '../../model/document.ts';
import { clipEnabled, transitionIdOf } from '../../editor/operations.ts';
import type { SelectionManager } from '../../editor/selection.ts';
import type { StripRenderer } from './strip-renderer.ts';
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
  /** Fase 5: clips with an open keyframe lane (button shows the up chevron). */
  expanded?: ReadonlySet<string>;
  /** Fase 8: the filmstrips inside video faces. */
  strips?: StripRenderer | null;
}

/** Padding inside a clip face. */
export const FACE_PADDING = 4;

/** Height of the opaque name bar at the top of a face. */
export const NAME_BAR_HEIGHT = 18;

/** Below this zoom a filmstrip is unreadable, so the body stays plain. */
export const MIN_STRIP_PIXELS_PER_SECOND = 20;

/** Aspect the filmstrip frames are painted with. */
const STRIP_ASPECT = 16 / 9;

/**
 * Fase 5: the keyframe-lane button of a clip face.
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

/** The body gradient base of one clip. */
function faceColor(clip: DocumentClip, colors: ThemeColors, missing: boolean, enabled: boolean): string {
  if (missing) return colors.clipMissing;
  if (!enabled) return colors.clipDisabled;
  const label = clip.extra['colorLabel'];
  if (typeof label === 'string' && label !== '') return label;
  if (clip.kind === 'audio') return colors.clipAudioBg;
  if (clip.kind === 'image') return colors.clipImageBg;
  if (clip.kind === 'text' || clip.kind === 'shape' || clip.kind === 'layer') return colors.clipImageBg;
  return colors.clipVideoBg;
}

/** The 2 px border colour along the top of a clip. */
function faceBorder(clip: DocumentClip, colors: ThemeColors, enabled: boolean): string {
  if (!enabled) return colors.border;
  if (clip.kind === 'audio') return colors.clipAudioBorder;
  if (clip.kind === 'image' || clip.kind === 'text' || clip.kind === 'shape' || clip.kind === 'layer') {
    return colors.clipImageBorder;
  }
  return colors.clipVideoBorder;
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
  const { colors, selection, viewport, waveform, thumbnails, strips } = context;
  const missing = clip.extra['missing'] === true;
  const enabled = clipEnabled(clip);
  const locked = clip.extra['locked'] === true || context.document.extra['locked'] === true;
  const selected = selection.isSelected(clip.id);
  const nameBar = Math.min(NAME_BAR_HEIGHT, Math.max(0, h - 2));
  ctx.save();
  roundedRect(ctx, x, y, w, h, 4);
  ctx.clip();
  if (!enabled) ctx.globalAlpha = 0.4;

  // 1. Gradient body.
  drawGradientBody(ctx, x, y, w, h, faceColor(clip, colors, missing, enabled));

  // 2. Content: filmstrip for video, waveform for audio, still for images.
  if (enabled && !missing) {
    if (clip.kind === 'audio') {
      ctx.globalAlpha = (clip.kind === 'audio' ? 0.9 : 1) * (enabled ? 1 : 0.4);
      waveform.draw(ctx, clip, x, y + nameBar, w, h - nameBar, colors, viewport.pixelsPerSecond);
      ctx.globalAlpha = enabled ? 1 : 0.4;
    } else if (w >= 24 && h > nameBar + 4) {
      if (viewport.pixelsPerSecond >= MIN_STRIP_PIXELS_PER_SECOND) {
        renderClipThumbnails(ctx, {
          clip,
          x,
          y,
          w,
          h,
          pixelsPerSecond: viewport.pixelsPerSecond,
          strips: strips ?? null,
        });
      } else {
        // Too zoomed out for a filmstrip: one face thumbnail, as before.
        thumbnails.draw(ctx, clip, x, y + nameBar, h - nameBar);
      }
    }
    drawFades(ctx, clip, x, y, w, h, viewport.pixelsPerSecond);
  }

  // 3. Opaque name bar: glyph + name (+ the keyframe-lane toggle).
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(x, y, w, nameBar);
  ctx.restore();
  const button = expandButtonRect(x, y, w);
  const labelLeft = drawClipTypeIcon(ctx, clip.kind, x + 6, y + nameBar / 2, 12) + 4;
  const labelWidth = Math.max(10, w - labelLeft - 8 - (button ? 20 : 0));
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;
  ctx.fillText(ellipsize(ctx, clip.name === '' ? clip.id : clip.name, labelWidth), labelLeft, y + nameBar / 2 + 0.5, labelWidth);
  ctx.restore();
  if (button) {
    const open = context.expanded?.has(clip.id) === true;
    ctx.fillStyle = open ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
    ctx.fillRect(button.x, button.y, button.w, button.h);
    ctx.fillStyle = '#ffffff';
    drawChevron(ctx, button.x + button.w / 2, button.y + button.h / 2, Math.min(button.w, button.h) * 0.28, open ? 'up' : 'down');
    if (clip.keys.length > 0 && !open) {
      ctx.beginPath();
      ctx.arc(button.x - 4, button.y + button.h / 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 4. 2 px accent border along the top edge.
  ctx.fillStyle = faceBorder(clip, colors, enabled);
  ctx.fillRect(x, y, w, 2);
  if (locked) drawLockedHatch(ctx, x, y, w, h);
  ctx.globalAlpha = 1;
  if (missing || !enabled) {
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(missing ? 'MISSING' : 'DISABLED', x + 8, y + h / 2);
  }
  ctx.restore();
  // Transition notch at the left edge (what flows in).
  if (clip.transitionIn) {
    ctx.fillStyle = colors.transition;
    ctx.fillRect(x, y, Math.min(10, w), 3);
  }
  // 5. Selection: 2 px yellow outline with a glow, outside the clip.
  if (selected) {
    ctx.save();
    ctx.strokeStyle = colors.clipSelectedBorder;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(255, 235, 59, 0.6)';
    ctx.shadowBlur = 8;
    roundedRect(ctx, x + 1, y + 1, w - 2, h - 2, 4);
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    roundedRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4);
    ctx.stroke();
  }
  void transitionIdOf;
}

/**
 * Fills a face with its vertical gradient and a 2 px top accent.
 * @param ctx the context.
 * @param x face x.
 * @param y face y.
 * @param w face width.
 * @param h face height.
 * @param base the theme colour of the kind.
 */
export function drawGradientBody(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  base: string,
): void {
  ctx.fillStyle = base;
  ctx.fillRect(x, y, w, h);
  if (h < 3 || typeof ctx.createLinearGradient !== 'function') return;
  const gradient = ctx.createLinearGradient(x, y, x, y + h);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
  gradient.addColorStop(0.45, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0.38)');
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/**
 * The filmstrip inside a video clip: one frame per screen-width slice of the
 * clip, indexed by the source time it shows.
 */
export interface RenderClipThumbnailsOptions {
  clip: DocumentClip;
  /** Face rectangle (content space). */
  x: number;
  y: number;
  w: number;
  h: number;
  pixelsPerSecond: number;
  strips: StripRenderer | null;
}

/**
 * Paints the frame sequence inside a clip face (Fase 8).
 * @param ctx the content canvas context.
 * @param options the face, the zoom and the strip source.
 * @returns the number of frames painted (0 when none were available).
 */
export function renderClipThumbnails(ctx: CanvasRenderingContext2D, options: RenderClipThumbnailsOptions): number {
  const { clip, x, y, w, h, pixelsPerSecond, strips } = options;
  const bodyY = y + Math.min(NAME_BAR_HEIGHT, Math.max(0, h - 2));
  const bodyH = h - (bodyY - y);
  if (bodyH <= 2 || w <= 2) return 0;
  const frameWidth = Math.max(24, bodyH * STRIP_ASPECT);
  const visible = Math.max(1, Math.ceil(w / frameWidth));
  const strip = clip.mediaId === '' ? null : strips?.get(clip.mediaId) ?? null;
  const frames = strip?.frames ?? null;
  const mediaSeconds = Math.max(1e-6, strip?.durationSeconds ?? Math.max(clip.sourceStart + clip.duration * clip.speed, 1e-6));
  let painted = 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, bodyY, w, bodyH);
  ctx.clip();
  for (let index = 0; index < visible; index += 1) {
    const drawX = x + index * frameWidth;
    if (drawX >= x + w) break;
    const drawW = Math.min(frameWidth, x + w - drawX);
    const timeInClip = (drawX - x) / Math.max(1e-6, pixelsPerSecond);
    const sourceAt = clip.sourceStart + timeInClip * clip.speed;
    const bitmap = frames && frames.length > 0 ? frames[Math.min(frames.length - 1, Math.max(0, Math.floor((sourceAt / mediaSeconds) * frames.length)))] : null;
    if (bitmap) {
      ctx.drawImage(bitmap as CanvasImageSource, drawX, bodyY, drawW, bodyH);
      painted += 1;
    } else {
      drawStripPlaceholder(ctx, drawX, bodyY, drawW, bodyH);
    }
    // Hairline between frames, so the strip reads as a sequence.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(drawX) + 0.5, bodyY);
    ctx.lineTo(Math.round(drawX) + 0.5, bodyY + bodyH);
    ctx.stroke();
  }
  ctx.restore();
  return painted;
}

/** A neutral chequer for a frame that is still decoding. */
function drawStripPlaceholder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  const cell = 8;
  for (let row = 0; row * cell < h; row += 1) {
    for (let column = (row % 2 === 0 ? 0 : 1); column * cell < w; column += 2) {
      ctx.fillRect(x + column * cell, y + row * cell, cell, cell);
    }
  }
  ctx.restore();
}

/** Grey diagonal hatching over a locked lane's clips. */
export function drawLockedHatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(180, 180, 180, 0.35)';
  ctx.lineWidth = 2;
  for (let offset = -h; offset < w; offset += 10) {
    ctx.beginPath();
    ctx.moveTo(x + offset, y + h);
    ctx.lineTo(x + offset + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The clip's type glyph on its name bar (canvas twin of the SVG clip icons).
 * @param ctx the context.
 * @param kind the clip kind.
 * @param x left edge.
 * @param cy vertical centre.
 * @param size glyph box (square).
 * @returns the x the label should start at (the glyph's right edge).
 */
export function drawClipTypeIcon(
  ctx: CanvasRenderingContext2D,
  kind: DocumentClip['kind'],
  x: number,
  cy: number,
  size: number,
): number {
  const top = cy - size / 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'audio': {
      // Three bars: the waveform glyph.
      for (let bar = 0; bar < 3; bar += 1) {
        const height = size * (bar === 1 ? 1 : 0.6);
        ctx.fillRect(x + bar * (size / 3), cy - height / 2, Math.max(1.5, size / 6), height);
      }
      break;
    }
    case 'image': {
      ctx.strokeRect(x + 0.5, top + 0.5, size - 1, size - 1);
      ctx.beginPath();
      ctx.moveTo(x + 2, top + size - 2);
      ctx.lineTo(x + size * 0.45, top + size * 0.45);
      ctx.lineTo(x + size - 2, top + size - 2);
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.beginPath();
      ctx.moveTo(x + 1, top + 1);
      ctx.lineTo(x + size - 1, top + 1);
      ctx.moveTo(x + size / 2, top + 1);
      ctx.lineTo(x + size / 2, top + size - 1);
      ctx.stroke();
      break;
    }
    case 'shape': {
      ctx.beginPath();
      ctx.moveTo(x + size / 2, top);
      ctx.lineTo(x + size, cy);
      ctx.lineTo(x + size / 2, top + size);
      ctx.lineTo(x, cy);
      ctx.closePath();
      ctx.stroke();
      break;
    }
    default: {
      // Video: a film frame with its perforations.
      ctx.strokeRect(x + 0.5, top + 2.5, size - 1, size - 5);
      ctx.fillRect(x + 2, top + 0.5, size - 4, 1.5);
      ctx.fillRect(x + 2, top + size - 2, size - 4, 1.5);
      break;
    }
  }
  ctx.restore();
  return x + size;
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
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
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
export function formatSpan(seconds: number): string {
  const total = Math.max(0, seconds);
  const whole = Math.floor(total);
  const tenths = Math.floor((total - whole) * 10);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}.${tenths}`;
}

/** Truncates a label to a pixel width with a trailing ellipsis. */
export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (typeof ctx.measureText !== 'function') return text;
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let cut = text;
  while (cut.length > 1 && ctx.measureText(cut + ellipsis).width > maxWidth) cut = cut.slice(0, -1);
  return cut + ellipsis;
}

/**
 * Fase 7: a 2 px round chevron, the canvas twin of the SVG `chevronUp` /
 * `chevronDown` icons (fonts may lack the arrows or render them as emoji).
 * @param ctx the 2D context (fill style is reused as the stroke colour).
 * @param cx centre x.
 * @param cy centre y.
 * @param half half-width of the chevron.
 * @param direction which way it points.
 */
export function drawChevron(ctx: CanvasRenderingContext2D, cx: number, cy: number, half: number, direction: 'up' | 'down'): void {
  const rise = (direction === 'down' ? 1 : -1) * half * 0.55;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - half, cy - rise);
  ctx.lineTo(cx, cy + rise);
  ctx.lineTo(cx + half, cy - rise);
  ctx.stroke();
  ctx.restore();
}
