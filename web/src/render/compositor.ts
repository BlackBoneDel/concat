// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The frame compositor: turns a timeline instant into pixels.
 *
 * Composition is bottom-first exactly as `concat-core/src/timeline.rs`
 * documents — `track_ids()[0]` is composited first and everything after
 * draws on top — and every per-clip number comes from the engine model's own
 * `source_time_at`, `transform_at`, `opacity_at` and `video_fade_factor`, so
 * preview and export cannot disagree.
 */

import { Rational } from '../core/rational.ts';
import type { Clip, Timeline } from '../core/timeline.ts';
import type { Crop, ShapeStyle } from '../model/index.ts';
import { EditorClip } from '../session/editor-clip.ts';
import { applyBlend, resetBlend } from './blend.ts';
import { renderTextClip } from './text-renderer.ts';
import { applyTransform, fitRect } from './transform.ts';
import { intrinsicSize } from './types.ts';
import { getVisionHook } from './vision-pipeline.ts';
import type { FramePool, RenderContext2D, RenderImage, RenderTarget } from './types.ts';

/** Options for {@link renderFrame}. */
export interface RenderOptions {
  /** Letterbox colour; black by default. */
  background?: string;
}

/**
 * Renders the timeline at `time` into `canvas`.
 *
 * The canvas backing store may be any multiple of the project frame (the
 * preview's quality scale); the compositor maps frame space onto it and
 * letterboxes when the aspect ratios differ.
 * @param timeline the engine timeline to composite.
 * @param time the instant to render.
 * @param canvas the surface to paint.
 * @param mediaPool where decoded frames come from.
 * @param options background colour.
 */
export async function renderFrame(
  timeline: Timeline,
  time: Rational,
  canvas: RenderTarget,
  mediaPool: FramePool,
  options: RenderOptions = {},
): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const frameWidth = timeline.width;
  const frameHeight = timeline.height;

  // Frame space → canvas pixels, letterboxed if the ratios disagree.
  const scale = Math.min(canvas.width / frameWidth, canvas.height / frameHeight);
  const offsetX = (canvas.width - frameWidth * scale) / 2;
  const offsetY = (canvas.height - frameHeight * scale) / 2;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = options.background ?? '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);

  // Bottom-first: engine track 0 is composited first.
  for (const [, track] of timeline.tracks()) {
    if (!track.enabled) continue;
    for (const clipId of track.clips()) {
      const clip = timeline.clip(clipId);
      if (!clip || !clip.contains(time)) continue;
      await drawClip(ctx, timeline, clip, time, mediaPool);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Paints one active clip in frame space. */
async function drawClip(
  ctx: RenderContext2D,
  timeline: Timeline,
  clip: Clip,
  time: Rational,
  mediaPool: FramePool,
): Promise<void> {
  // The four engine calls — the single definition every renderer agrees with.
  const sourceTime = clip.sourceTimeAt(time);
  if (!sourceTime) return;
  const transform = clip.transformAt(time);
  const opacity = clip.opacityAt(time) * clip.videoFadeFactor(time);
  if (opacity <= 0) return;

  const frameWidth = timeline.width;
  const frameHeight = timeline.height;

  // The document extras (kind, crop, text, shape) ride along when the clip is
  // an `EditorClip`; a plain engine clip is always a media picture.
  const editor = clip instanceof EditorClip ? clip : null;
  const kind = editor?.kind ?? 'video';

  if (kind === 'text') {
    if (!editor?.text) return;
    applyBlend(ctx, clip.blend, opacity);
    applyTransform(ctx, transform, frameWidth, frameHeight, frameWidth, frameHeight);
    renderTextClip(ctx, editor.text, frameWidth, frameHeight);
    ctx.restore();
    resetBlend(ctx);
    return;
  }

  if (kind === 'shape') {
    if (!editor?.shape) return;
    applyBlend(ctx, clip.blend, opacity);
    applyTransform(ctx, transform, frameWidth, frameHeight, frameWidth, frameHeight);
    renderShapeClip(ctx, editor.shape, frameWidth, frameHeight);
    ctx.restore();
    resetBlend(ctx);
    return;
  }

  // Layer clips carry effects only (Fase 5); they draw nothing today.
  if (kind === 'layer') return;

  const size = mediaPool.getSize(clip.media.path);
  const source = await mediaPool.getFrame(clip.media.path, sourceTime);
  if (!source) return;

  const intrinsic = intrinsicSize(source);
  const sourceWidth = size?.width ?? intrinsic.width;
  const sourceHeight = size?.height ?? intrinsic.height;
  // Fase 4 hook: picture effects (keys, grade, LUT) before blend/transform.
  const picture = getVisionHook()?.process(clip, source, sourceWidth, sourceHeight) ?? source;

  // Crop takes fractions off each edge *before* fitting: the picture that is
  // fitted and placed is the cropped source.
  const crop = editor?.crop ?? null;
  const left = crop ? Math.min(0.9, Math.max(0, crop.left)) : 0;
  const top = crop ? Math.min(0.9, Math.max(0, crop.top)) : 0;
  const right = crop ? Math.min(0.9, Math.max(0, crop.right)) : 0;
  const bottom = crop ? Math.min(0.9, Math.max(0, crop.bottom)) : 0;
  const sx = sourceWidth * left;
  const sy = sourceHeight * top;
  const sw = Math.max(1, sourceWidth * (1 - left - right));
  const sh = Math.max(1, sourceHeight * (1 - top - bottom));

  applyBlend(ctx, clip.blend, opacity);
  applyTransform(ctx, transform, sw, sh, frameWidth, frameHeight);
  drawSource(ctx, picture, sx, sy, sw, sh, frameWidth, frameHeight);
  ctx.restore();
  resetBlend(ctx);
}

/** Blits the cropped source picture into its fitted rectangle of the frame. */
function drawSource(
  ctx: RenderContext2D,
  source: RenderImage,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  frameWidth: number,
  frameHeight: number,
): void {
  const fitted = fitRect(sw, sh, frameWidth, frameHeight);
  ctx.drawImage(source, sx, sy, sw, sh, fitted.x, fitted.y, fitted.w, fitted.h);
}

/** A shape clip: the figures of `model.rs`'s `ShapeKind`. */
function renderShapeClip(
  ctx: RenderContext2D,
  shape: ShapeStyle,
  frameWidth: number,
  frameHeight: number,
): void {
  // A third-of-frame figure centred on the picture centre.
  const size = shape.size * frameHeight;
  const half = size / 2;
  ctx.beginPath();
  switch (shape.kind) {
    case 'circle':
      ctx.arc(0, 0, half, 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(0, -half);
      ctx.lineTo(half, half);
      ctx.lineTo(-half, half);
      ctx.closePath();
      break;
    case 'parallelogram':
      ctx.moveTo(-half + size * 0.2, -half);
      ctx.lineTo(half, -half);
      ctx.lineTo(-half, half);
      ctx.lineTo(half - size * 0.2, half);
      ctx.closePath();
      break;
    case 'trapezoid':
      ctx.moveTo(-half + size * 0.2, -half);
      ctx.lineTo(half - size * 0.2, -half);
      ctx.lineTo(half, half);
      ctx.lineTo(-half, half);
      ctx.closePath();
      break;
    case 'line':
    case 'arrow':
      ctx.moveTo(-half, 0);
      ctx.lineTo(half, 0);
      if (shape.kind === 'arrow') {
        ctx.moveTo(half - size * 0.15, -size * 0.12);
        ctx.lineTo(half, 0);
        ctx.lineTo(half - size * 0.15, size * 0.12);
      }
      break;
    case 'square':
    default:
      ctx.rect(-half, -half, size, size);
      break;
  }
  if (shape.fill !== '') {
    ctx.fillStyle = shape.fill;
    ctx.fill();
  }
  if (shape.stroke !== '' && shape.strokeWidth > 0) {
    ctx.lineWidth = shape.strokeWidth * frameHeight;
    ctx.strokeStyle = shape.stroke;
    ctx.stroke();
  }
}

