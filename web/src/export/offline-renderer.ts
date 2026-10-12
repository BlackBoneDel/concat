// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: renders the frames of an export. Each frame goes through the
 * Fase 2–5 compositor (`render/compositor.ts::renderFrame`, so transforms,
 * keyframes, transitions, vision, the effect stack and titles all apply)
 * onto an `OffscreenCanvas` at the output size — letterboxed when the
 * aspect differs — then becomes a `VideoFrame` stamped in microseconds from
 * the frame index (never from accumulated floats).
 *
 * Originals only: the pool view comes from `MediaPool.exportFrames`, and
 * `prepare` fails with `NO_MEDIA` when a visual clip's original is missing
 * (unless proxy fallback was enabled). At most two frames are in flight:
 * the generator waits for the consumer to release frames before drawing the
 * next one, so memory stays flat for any length.
 *
 * Port of the frame loop in `src/crates/concat-export/src/lib.rs::render_on`
 * (one composite per output frame, stop at the next frame once cancelled).
 */

import type { Rational } from '../core/rational.ts';
import { renderFrame as compositeFrame } from '../render/compositor.ts';
import type { FramePool, RenderTarget } from '../render/types.ts';
import type { Timeline } from '../core/timeline.ts';
import type { ProjectDocument } from '../model/document.ts';
import { exportSession, snapshotForExport, visualMediaPaths } from './export-document.ts';
import { FrameClock } from './frame-clock.ts';
import { ExportError, frameRateOf, throwIfAborted, type ExportConfig } from './types.ts';

/** A frame the encoders accept: a `VideoFrame` in browsers, a double in tests. */
export interface ExportFrameLike {
  readonly timestamp: number;
  readonly duration: number | null;
  close(): void;
}

/** The drawing surface of an export: canvas plus the conversions it offers. */
export interface ExportSurface {
  readonly target: RenderTarget;
  /** The current picture as a frame for the video encoder. */
  toFrame(timestamp: number, duration: number): ExportFrameLike;
  /** The current picture as RGBA bytes (GIF path). */
  readPixels(): Uint8ClampedArray;
  /** The current picture as a JPEG (FFmpeg fallback path). */
  encodeJpeg(quality: number): Promise<Blob>;
  /** A small copy for the progress preview, or `null`. */
  preview(maxWidth: number): Promise<ImageBitmap | null>;
  /** Releases the canvas. */
  dispose(): void;
}

/** Builds a surface of a size. */
export type SurfaceFactory = (width: number, height: number) => ExportSurface;

/** The compositor entry point (injectable for tests). */
export type CompositeFn = (timeline: Timeline, time: Rational, canvas: RenderTarget, pool: FramePool, options: { background?: string }) => Promise<void>;

/** One rendered frame. */
export interface RenderedFrame {
  index: number;
  time: Rational;
  /** Microseconds from the file start. */
  timestamp: number;
  /** Microseconds. */
  duration: number;
  /** Starts a group of pictures. */
  keyFrame: boolean;
  /** The encodable frame (`null` when the renderer reads pixels instead). */
  frame: ExportFrameLike | null;
  /** RGBA bytes (only with `output: 'pixels'`). */
  pixels: Uint8ClampedArray | null;
  /** JPEG bytes (only with `output: 'jpeg'`). */
  jpeg: Blob | null;
  /** Closes the frame and frees its in-flight slot. Idempotent. */
  release(): void;
}

/** What the renderer reads from. */
export interface OfflineRenderSource {
  /** The live document (snapshotted in `prepare`). */
  document: ProjectDocument;
  /** Originals-only frames (`MediaPool.exportFrames`). */
  frames: FramePool;
  /** Whether a media path can be rendered (original, or proxy when allowed). */
  hasMedia(path: string): boolean;
}

/** Options of {@link OfflineRenderer}. */
export interface OfflineRendererOptions {
  config: ExportConfig;
  range: { start: Rational; end: Rational };
  signal?: AbortSignal;
  /** `frames` → `VideoFrame`s for WebCodecs; `pixels` → RGBA for GIF; `jpeg` → JPEG for the FFmpeg fallback. */
  output?: 'frames' | 'pixels' | 'jpeg';
  /** Frames the consumer may hold before rendering pauses (2). */
  maxInFlight?: number;
  createSurface?: SurfaceFactory;
  composite?: CompositeFn;
  background?: string;
}

/** Widest progress preview. */
export const PREVIEW_MAX_WIDTH = 480;

/**
 * The browser surface: an `OffscreenCanvas` with `willReadFrequently` for
 * the pixel path.
 * @param width output width.
 * @param height output height.
 * @returns the surface.
 * @throws ExportError `ENCODER_UNSUPPORTED` without OffscreenCanvas.
 */
export function offscreenSurface(width: number, height: number): ExportSurface {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new ExportError('ENCODER_UNSUPPORTED', 'Este navegador no ofrece OffscreenCanvas, necesario para exportar.');
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!context) throw new ExportError('ENCODER_UNSUPPORTED', 'No se pudo crear el lienzo de exportación.');
  return {
    target: canvas,
    toFrame(timestamp: number, duration: number): ExportFrameLike {
      if (typeof VideoFrame === 'undefined') throw new ExportError('ENCODER_UNSUPPORTED', 'VideoFrame no está disponible en este navegador.');
      return new VideoFrame(canvas, { timestamp, duration, alpha: 'discard' });
    },
    readPixels(): Uint8ClampedArray {
      return context.getImageData(0, 0, width, height).data;
    },
    encodeJpeg(quality: number): Promise<Blob> {
      return canvas.convertToBlob({ type: 'image/jpeg', quality });
    },
    async preview(maxWidth: number): Promise<ImageBitmap | null> {
      if (typeof createImageBitmap === 'undefined') return null;
      const scale = Math.min(1, maxWidth / width);
      return createImageBitmap(canvas, {
        resizeWidth: Math.max(1, Math.round(width * scale)),
        resizeHeight: Math.max(1, Math.round(height * scale)),
        resizeQuality: 'low',
      });
    },
    dispose(): void {
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}

/** Renders every frame of an export range. */
export class OfflineRenderer {
  private readonly source: OfflineRenderSource;
  private readonly options: OfflineRendererOptions;
  private readonly maxInFlight: number;
  private readonly composite: CompositeFn;
  private surface: ExportSurface | null = null;
  private timeline: Timeline | null = null;
  private frameClock: FrameClock | null = null;
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private disposed = false;

  /**
   * @param source document, original frames and the media check.
   * @param options config, range, signal and injectable factories.
   */
  constructor(source: OfflineRenderSource, options: OfflineRendererOptions) {
    this.source = source;
    this.options = options;
    this.maxInFlight = Math.max(1, options.maxInFlight ?? 2);
    this.composite = options.composite ?? compositeFrame;
  }

  /** The frame clock (after {@link prepare}). */
  get clock(): FrameClock {
    if (!this.frameClock) throw new Error('OfflineRenderer.prepare() no se ha llamado');
    return this.frameClock;
  }

  /** Frames to render (after {@link prepare}). */
  get totalFrames(): number {
    return this.clock.totalFrames;
  }

  /** Frames currently held by the consumer. */
  get framesInFlight(): number {
    return this.inFlight;
  }

  /**
   * Snapshots the document, builds the engine timeline and the clock,
   * checks media and creates the surface.
   * @throws ExportError `INVALID_RANGE`, `NO_MEDIA`, `ENCODER_UNSUPPORTED`, `ABORTED`.
   */
  async prepare(): Promise<void> {
    throwIfAborted(this.options.signal);
    const { config, range } = this.options;
    const fps = frameRateOf(config.frameRate);
    if (!fps) throw new ExportError('INVALID_RANGE', 'Frecuencia de fotogramas inválida.');
    this.frameClock = new FrameClock(range.start, range.end, fps);
    const snapshot = snapshotForExport(this.source.document, { burnSubtitles: config.burnSubtitles });
    const session = exportSession(snapshot);
    const missing = visualMediaPaths(session).filter((path) => !this.source.hasMedia(path));
    if (missing.length > 0) {
      const names = missing.map((path) => snapshot.media.find((item) => item.id === path)?.name ?? path);
      throw new ExportError(
        'NO_MEDIA',
        `Faltan los originales de: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}. Vuelve a vincularlos o activa «usar proxies si falta el original».`,
      );
    }
    this.timeline = session.engine;
    this.surface = (this.options.createSurface ?? offscreenSurface)(config.width, config.height);
    await Promise.resolve();
  }

  /**
   * Renders frame `index`.
   * @param index 0-based frame index.
   * @returns the frame; the caller must `release()` it.
   */
  async renderFrame(index: number): Promise<RenderedFrame> {
    throwIfAborted(this.options.signal);
    const surface = this.surface;
    const timeline = this.timeline;
    if (!surface || !timeline || this.disposed) throw new Error('OfflineRenderer no está preparado');
    const clock = this.clock;
    const time = clock.timeOf(index);
    await this.composite(timeline, time, surface.target, this.source.frames, { background: this.options.background ?? '#000000' });
    throwIfAborted(this.options.signal);
    const timestamp = clock.timestampMicros(index);
    const duration = clock.durationMicros(index);
    const output = this.options.output ?? 'frames';
    const frame = output === 'frames' ? surface.toFrame(timestamp, duration) : null;
    const jpeg = output === 'jpeg' ? await surface.encodeJpeg(0.92) : null;
    let released = false;
    this.inFlight += 1;
    return {
      index,
      time,
      timestamp,
      duration,
      keyFrame: clock.isKeyframe(index, this.options.config.keyframeInterval),
      frame,
      pixels: output === 'pixels' ? surface.readPixels() : null,
      jpeg,
      release: () => {
        if (released) return;
        released = true;
        frame?.close();
        this.inFlight -= 1;
        this.waiters.shift()?.();
      },
    };
  }

  /**
   * Renders every frame in order, pausing while {@link maxInFlight} frames
   * are unreleased.
   * @yields frames; release each one.
   */
  async *renderAll(): AsyncGenerator<RenderedFrame> {
    const total = this.totalFrames;
    for (let index = 0; index < total; index += 1) {
      while (this.inFlight >= this.maxInFlight) {
        throwIfAborted(this.options.signal);
        if (this.disposed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
      if (this.disposed) return;
      yield await this.renderFrame(index);
    }
  }

  /**
   * A ≤ 480 px copy of the last rendered picture, for the progress view.
   * @returns the bitmap (the caller closes it), or `null`.
   */
  async preview(): Promise<ImageBitmap | null> {
    if (!this.surface || this.disposed) return null;
    try {
      return await this.surface.preview(PREVIEW_MAX_WIDTH);
    } catch {
      return null;
    }
  }

  /** Frees the surface and wakes any waiter. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.surface?.dispose();
    this.surface = null;
    this.timeline = null;
    for (const wake of this.waiters.splice(0)) wake();
  }
}
