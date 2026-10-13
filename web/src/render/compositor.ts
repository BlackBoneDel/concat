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
import { getTextEngineHook, renderAdvancedText } from './text-engine.ts';
import { getVideoEffectsHook } from './video-effects-hook.ts';
import { applyTransform, fitRect } from './transform.ts';
import { intrinsicSize } from './types.ts';
import { getVisionHook } from './vision-pipeline.ts';
import type { FramePool, RenderContext2D, RenderImage, RenderTarget } from './types.ts';

/** Options for {@link renderFrame}. */
export interface RenderOptions {
  /** Letterbox colour; black by default. */
  background?: string;
  /**
   * Fase 7: what a decoder failure does. `'throw'` (default — export must
   * fail loudly, never ship a placeholder) propagates the error; `'slate'`
   * (the preview) paints a red "Media Missing" card where the clip would be
   * and keeps compositing the other layers.
   */
  missingMedia?: 'throw' | 'slate';
  /** Fase 7: told about every decoder failure handled as a slate. */
  onMediaError?: (mediaId: string, error: unknown) => void;
}

/** Fase 7: the colours of the missing-media card (theme-independent: it is
 * picture content, like the letterbox). */
export const MISSING_MEDIA_COLORS = Object.freeze({ fill: '#7a1f24', stripe: '#a3262d', text: '#ffffff' });
/** Fase 7: the card's caption. */
export const MISSING_MEDIA_LABEL = 'Media Missing';

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

  // Every frame is resolved before the first pixel is painted. Clearing to the
  // background while a decode was still pending showed black between frames.
  const prefetched = await prefetchFrames(timeline, time, mediaPool);

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
      await drawClip(ctx, timeline, clip, time, mediaPool, options, prefetched);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** A prefetched frame: the image, or the error the decoder raised. */
type Settled = { ok: true; image: RenderImage | null } | { ok: false; error: unknown };

/** The kind of a clip as the compositor reads it (media unless an editor says otherwise). */
function clipKind(clip: Clip): string {
  return (clip instanceof EditorClip ? clip.kind : undefined) ?? 'video';
}

/**
 * Resolves the frame of every clip that will be drawn at `time`, so the
 * compositor can clear and paint in one go. Errors are kept, not thrown here:
 * {@link drawClip} rethrows them where the missing-media slate handles them.
 * @param timeline the timeline.
 * @param time the playhead.
 * @param mediaPool where frames come from.
 * @returns the settled frame per clip.
 */
async function prefetchFrames(timeline: Timeline, time: Rational, mediaPool: FramePool): Promise<Map<Clip, Settled>> {
  const wanted: { clip: Clip; sourceTime: Rational }[] = [];
  for (const [, track] of timeline.tracks()) {
    if (!track.enabled) continue;
    for (const clipId of track.clips()) {
      const clip = timeline.clip(clipId);
      if (!clip || !clip.contains(time)) continue;
      const kind = clipKind(clip);
      if (kind === 'text' || kind === 'shape' || kind === 'layer') continue;
      if (clip.opacityAt(time) * clip.videoFadeFactor(time) <= 0) continue;
      const sourceTime = clip.sourceTimeAt(time);
      if (sourceTime) wanted.push({ clip, sourceTime });
    }
  }
  // One request at a time within a composite: the decoders are CPU-bound.
  const settled = new Map<Clip, Settled>();
  for (const { clip, sourceTime } of wanted) {
    try {
      settled.set(clip, { ok: true, image: await mediaPool.getFrame(clip.media.path, sourceTime) });
    } catch (error) {
      settled.set(clip, { ok: false, error });
    }
  }
  return settled;
}

/** The frame of a clip: the prefetched one when there is one, else a fresh request. */
async function frameFor(
  clip: Clip,
  sourceTime: Rational,
  mediaPool: FramePool,
  prefetched: Map<Clip, Settled>,
): Promise<RenderImage | null> {
  const settled = prefetched.get(clip);
  if (!settled) return mediaPool.getFrame(clip.media.path, sourceTime);
  if (!settled.ok) throw settled.error;
  return settled.image;
}

/** Paints one active clip in frame space. */
async function drawClip(
  ctx: RenderContext2D,
  timeline: Timeline,
  clip: Clip,
  time: Rational,
  mediaPool: FramePool,
  options: RenderOptions = {},
  prefetched: Map<Clip, Settled> = new Map(),
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
    // Fase 5 hook: advanced titling (plate, shadow, gradient, typewriter).
    const advanced = getTextEngineHook()?.resolve(clip) ?? null;
    if (advanced) {
      renderAdvancedText(ctx, editor.text, advanced.advanced, frameWidth, frameHeight, {
        localTime: time.asNumber() - clip.start.asNumber(),
        fontFamily: advanced.fontFamily,
      });
    } else {
      renderTextClip(ctx, editor.text, frameWidth, frameHeight);
    }
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
  let source: RenderImage | null;
  try {
    source = await frameFor(clip, sourceTime, mediaPool, prefetched);
  } catch (error) {
    // Fase 7 hook (QA): a deleted file / dead decoder mid-playback.
    if (options.missingMedia !== 'slate') throw error;
    options.onMediaError?.(clip.media.path, error);
    applyBlend(ctx, clip.blend, opacity);
    applyTransform(ctx, transform, frameWidth, frameHeight, frameWidth, frameHeight);
    drawMissingMediaSlate(ctx, frameWidth, frameHeight);
    ctx.restore();
    resetBlend(ctx);
    return;
  }
  if (!source) return;

  const intrinsic = intrinsicSize(source);
  const sourceWidth = size?.width ?? intrinsic.width;
  const sourceHeight = size?.height ?? intrinsic.height;
  // Crop takes fractions off each edge *before* fitting: the picture that is
  // fitted and placed is the cropped source.
  const crop = editor?.crop ?? null;
  const left = crop ? Math.min(0.9, Math.max(0, crop.left)) : 0;
  const top = crop ? Math.min(0.9, Math.max(0, crop.top)) : 0;
  const right = crop ? Math.min(0.9, Math.max(0, crop.right)) : 0;
  const bottom = crop ? Math.min(0.9, Math.max(0, crop.bottom)) : 0;
  let sx = sourceWidth * left;
  let sy = sourceHeight * top;
  const sw = Math.max(1, sourceWidth * (1 - left - right));
  const sh = Math.max(1, sourceHeight * (1 - top - bottom));

  const vision = getVisionHook();
  // Fase 5 hook: Source → Crop → Chroma (F4) → EffectsStack → ColorGrading (F4)
  // → Transform → Blend/Opacity. Without a stack this is the Fase 4 path.
  const effectsHook = getVideoEffectsHook();
  const stack = effectsHook?.resolve(clip) ?? null;
  let picture: RenderImage | null = null;
  if (effectsHook && stack && stack.length > 0) {
    const keyed = vision?.process(clip, source, sourceWidth, sourceHeight, 'key') ?? source;
    const stacked = effectsHook.apply(keyed, { sx, sy, sw, sh }, stack, time.asNumber() - clip.start.asNumber());
    if (stacked) {
      picture = vision?.process(clip, stacked, sw, sh, 'grade') ?? stacked;
      sx = 0;
      sy = 0;
    }
  }
  // Fase 4 hook: picture effects (keys, grade, LUT) before blend/transform.
  picture ??= vision?.process(clip, source, sourceWidth, sourceHeight) ?? source;

  applyBlend(ctx, clip.blend, opacity);
  applyTransform(ctx, transform, sw, sh, frameWidth, frameHeight);
  drawSource(ctx, picture, sx, sy, sw, sh, frameWidth, frameHeight);
  ctx.restore();
  resetBlend(ctx);
}

/**
 * Fase 7: the red "Media Missing" card over the clip's frame rectangle
 * (frame space, top-left origin — same as `drawSource`), with a diagonal
 * stripe and the caption.
 * @param ctx the context (already transformed to the clip).
 * @param frameWidth frame width.
 * @param frameHeight frame height.
 */
export function drawMissingMediaSlate(ctx: RenderContext2D, frameWidth: number, frameHeight: number): void {
  const x = 0;
  const y = 0;
  ctx.fillStyle = MISSING_MEDIA_COLORS.fill;
  ctx.fillRect(x, y, frameWidth, frameHeight);
  ctx.beginPath();
  ctx.moveTo(x, y + frameHeight * 0.62);
  ctx.lineTo(x + frameWidth * 0.62, y);
  ctx.lineTo(x + frameWidth * 0.78, y);
  ctx.lineTo(x, y + frameHeight * 0.78);
  ctx.closePath();
  ctx.fillStyle = MISSING_MEDIA_COLORS.stripe;
  ctx.fill();
  ctx.fillStyle = MISSING_MEDIA_COLORS.text;
  ctx.font = `600 ${Math.max(12, Math.round(frameHeight / 14))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(MISSING_MEDIA_LABEL, frameWidth / 2, frameHeight / 2);
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

