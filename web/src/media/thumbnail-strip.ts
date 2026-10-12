// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The filmstrip behind every video clip on the timeline: N equidistant frames
 * of a media, cached per media id so scrubbing and zooming never re-decode.
 *
 * Frame *decoding* stays on the main thread: {@link MediaDecoder} falls back to
 * an `HTMLVideoElement` for containers WebCodecs cannot open (Firefox and
 * Safari without H.264 in `VideoDecoder`), and a video element does not exist
 * in a worker. Generation is therefore *cooperative* — a frame at a time, with
 * a yield to the event loop between frames — so a 4K import never freezes the
 * UI while its strip builds (and the timeline paints the plain clip body until
 * the strip lands).
 *
 * The strip is persisted as PNG bytes (`thumbnail_strips` in `ConcatMediaDB`),
 * so the second visit of a project shows filmstrips without decoding
 * anything. A store that cannot hold bytes (jsdom, private windows) degrades
 * to memory only.
 */

import { Rational } from '../core/rational.ts';
import type { KeyValue } from '../storage/idb.ts';
import type { MediaFallback } from './decoder.ts';
import { MediaDecoder } from './decoder.ts';
import { scaleThumbnail } from './thumbnail.ts';

/** The IndexedDB slice the strips live in. */
export const THUMBNAIL_STRIP_STORE = 'thumbnail_strips';

/** Bumped when the strip layout changes; older records are ignored. */
export const THUMBNAIL_STRIP_VERSION = 1;

/** Default frame size of a strip thumbnail (16:9). */
export const STRIP_THUMB_WIDTH = 160;
export const STRIP_THUMB_HEIGHT = 90;

/** Bounds on how many frames one strip holds. */
export const STRIP_MIN_FRAMES = 4;
export const STRIP_MAX_FRAMES = 40;

/** Seconds of media one strip frame stands for when nothing else is known. */
const SECONDS_PER_FRAME = 1.5;

/** Frames decoded between two yields to the event loop. */
const FRAMES_PER_YIELD = 2;

/** A persisted filmstrip. */
export interface ThumbnailStripRecord {
  mediaId: string;
  /** PNG bytes, in playback order. */
  frames: Blob[];
  /** Seconds between two neighbouring frames. */
  intervalSeconds: number;
  thumbWidth: number;
  thumbHeight: number;
  durationSeconds: number;
  version: number;
}

/** A paintable filmstrip: the frames plus the timing that indexes them. */
export interface ThumbnailStripInfo {
  frames: readonly ImageBitmap[];
  /** Seconds between two neighbouring frames. */
  intervalSeconds: number;
  /** The media's total length, in seconds. */
  durationSeconds: number;
  width: number;
  height: number;
}

/** One cached entry: frames plus their timing. */
interface CachedStrip {
  frames: ImageBitmap[];
  intervalSeconds: number;
  durationSeconds: number;
  width: number;
  height: number;
}

/** Where strips are cached between sessions. */
export interface ThumbnailStripStore {
  get(mediaId: string): Promise<ThumbnailStripRecord | undefined>;
  put(record: ThumbnailStripRecord): Promise<void>;
  delete(mediaId: string): Promise<void>;
}

/** An in-memory store — the default and the test double. */
export class MemoryThumbnailStripStore implements ThumbnailStripStore {
  private readonly records = new Map<string, ThumbnailStripRecord>();

  async get(mediaId: string): Promise<ThumbnailStripRecord | undefined> {
    return this.records.get(mediaId);
  }

  async put(record: ThumbnailStripRecord): Promise<void> {
    this.records.set(record.mediaId, record);
  }

  async delete(mediaId: string): Promise<void> {
    this.records.delete(mediaId);
  }
}

/** The strips of `ConcatMediaDB.thumbnail_strips`. */
export class KeyValueThumbnailStripStore implements ThumbnailStripStore {
  /**
   * @param backend the database slice (opened at {@link MEDIA_DB_VERSION} by
   * the caller, so the store always exists on a fresh open).
   */
  constructor(private readonly backend: KeyValue) {}

  async get(mediaId: string): Promise<ThumbnailStripRecord | undefined> {
    const record = await this.backend.get<ThumbnailStripRecord>(THUMBNAIL_STRIP_STORE, mediaId);
    if (!record || record.version !== THUMBNAIL_STRIP_VERSION) return undefined;
    return record;
  }

  async put(record: ThumbnailStripRecord): Promise<void> {
    await this.backend.put(THUMBNAIL_STRIP_STORE, record.mediaId, record);
  }

  async delete(mediaId: string): Promise<void> {
    await this.backend.delete(THUMBNAIL_STRIP_STORE, mediaId);
  }
}

/**
 * How many frames a strip of `duration` should hold.
 * @param durationSeconds the media's length.
 * @returns a count between {@link STRIP_MIN_FRAMES} and {@link STRIP_MAX_FRAMES}.
 */
export function desiredStripFrames(durationSeconds: number): number {
  const wanted = Math.round(durationSeconds / SECONDS_PER_FRAME);
  return Math.max(STRIP_MIN_FRAMES, Math.min(STRIP_MAX_FRAMES, wanted || STRIP_MIN_FRAMES));
}

/**
 * The instants a strip samples: the centre of each of the `count` slices, so
 * a cut list reads evenly instead of front-loaded.
 * @param duration the media's length.
 * @param count how many frames.
 * @returns the times, in order.
 */
export function stripSampleTimes(duration: Rational, count: number): Rational[] {
  const frames = Math.max(1, Math.trunc(count));
  const seconds = Math.max(0, duration.asNumber());
  const out: Rational[] = [];
  for (let index = 0; index < frames; index += 1) {
    const at = (seconds * (index + 0.5)) / frames;
    out.push(Rational.approximate(Math.min(Math.max(0, at), Math.max(0, seconds - 1e-3))) ?? Rational.ZERO);
  }
  return out;
}

/** A neutral frame for a sample that would not decode. */
async function placeholderBitmap(width: number, height: number): Promise<ImageBitmap> {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (ctx) {
    ctx.fillStyle = '#333333';
    ctx.fillRect(0, 0, width, height);
  }
  if ('transferToImageBitmap' in canvas) return canvas.transferToImageBitmap();
  return createImageBitmap(canvas as HTMLCanvasElement);
}

/** Hands the event loop back between frames (cooperative generation). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

/** Options of {@link generateStripFromSource}. */
export interface GenerateStripOptions {
  /** An already-open decoder (the media pool hands its own). */
  decoder?: MediaDecoder;
  /** Frames decoded between yields; `0` never yields (tests). */
  framesPerYield?: number;
  /** The FFmpeg fallback for containers WebCodecs refuses. */
  fallback?: MediaFallback | null;
  /** Progress hook, 0…1. */
  onProgress?: (fraction: number) => void;
  /** Called before each decode (diagnostics/tests). */
  onFrame?: (index: number, at: Rational) => void;
}

/**
 * Decodes a filmstrip of a file.
 * @param source the media's bytes.
 * @param duration the media's length.
 * @param count how many frames (< {@link stripSampleTimes}).
 * @param thumbWidth frame width.
 * @param thumbHeight frame height.
 * @param options decoder reuse, yielding and hooks.
 * @returns the frames, in order; the caller owns them.
 */
export async function generateStripFromSource(
  source: File | Blob,
  duration: Rational,
  count: number,
  thumbWidth: number = STRIP_THUMB_WIDTH,
  thumbHeight: number = STRIP_THUMB_HEIGHT,
  options: GenerateStripOptions = {},
): Promise<ImageBitmap[]> {
  const times = stripSampleTimes(duration, count);
  if (times.length === 0) return [];
  const owned = options.decoder === undefined;
  const decoder = options.decoder ?? new MediaDecoder(source, 'strip', { fallback: options.fallback ?? null });
  const framesPerYield = options.framesPerYield ?? FRAMES_PER_YIELD;
  const out: ImageBitmap[] = [];
  try {
    if (owned) await decoder.init();
    for (let index = 0; index < times.length; index += 1) {
      const at = times[index]!;
      options.onFrame?.(index, at);
      let bitmap: ImageBitmap;
      try {
        const frame = await decoder.getFrame(at);
        bitmap = frame ? await scaleThumbnail(frame, thumbWidth, thumbHeight) : await placeholderBitmap(thumbWidth, thumbHeight);
      } catch (error) {
        console.warn('[ThumbnailStrip] Frame no decodificado', index, error);
        bitmap = await placeholderBitmap(thumbWidth, thumbHeight);
      }
      out.push(bitmap);
      options.onProgress?.((index + 1) / times.length);
      if (framesPerYield > 0 && index > 0 && index % framesPerYield === 0) await yieldToEventLoop();
    }
  } finally {
    if (owned) decoder.close();
  }
  return out;
}

/**
 * Encodes frames as PNG bytes for the cache.
 * @param mediaId the media the strip belongs to.
 * @param bitmaps the frames.
 * @param meta timing and size.
 * @returns the record, or `null` when the environment cannot encode PNGs
 * (jsdom, a canvas-less worker): the strip then stays in memory only.
 */
export async function encodeStrip(
  mediaId: string,
  bitmaps: readonly ImageBitmap[],
  meta: { intervalSeconds: number; durationSeconds: number },
): Promise<ThumbnailStripRecord | null> {
  const first = bitmaps[0];
  if (!first) return null;
  try {
    const frames: Blob[] = [];
    for (const bitmap of bitmaps) {
      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(bitmap.width, bitmap.height)
          : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      if ('convertToBlob' in canvas) frames.push(await canvas.convertToBlob({ type: 'image/png' }));
      else {
        const blob = await new Promise<Blob | null>((resolve) => {
          (canvas as HTMLCanvasElement).toBlob((value) => resolve(value), 'image/png');
        });
        if (!blob) return null;
        frames.push(blob);
      }
    }
    return {
      mediaId,
      frames,
      intervalSeconds: meta.intervalSeconds,
      thumbWidth: first.width,
      thumbHeight: first.height,
      durationSeconds: meta.durationSeconds,
      version: THUMBNAIL_STRIP_VERSION,
    };
  } catch (error) {
    console.warn('[ThumbnailStrip] No se pudo cachear la tira', error);
    return null;
  }
}

/**
 * Rebuilds the frames of a cached strip.
 * @param record the persisted strip.
 * @returns the frames, or `null` when this environment cannot decode bitmaps.
 */
export async function decodeStrip(record: ThumbnailStripRecord): Promise<ImageBitmap[] | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    return await Promise.all(record.frames.map((blob) => createImageBitmap(blob)));
  } catch (error) {
    console.warn('[ThumbnailStrip] Tira cacheada ilegible', error);
    return null;
  }
}

/** Options of {@link ThumbnailStripService}. */
export interface ThumbnailStripServiceOptions {
  store?: ThumbnailStripStore;
  thumbWidth?: number;
  thumbHeight?: number;
  /** Frames between yields (0 in tests). */
  framesPerYield?: number;
  fallback?: MediaFallback | null;
}

/**
 * The strip cache of one pool: in-memory frames for the paint path (which is
 * synchronous) plus the persistence layer for the next session.
 */
export class ThumbnailStripService {
  private store: ThumbnailStripStore;
  private readonly thumbWidth: number;
  private readonly thumbHeight: number;
  private readonly framesPerYield: number;
  private readonly fallback: MediaFallback | null;
  private readonly cached = new Map<string, CachedStrip>();
  private readonly inflight = new Map<string, Promise<ImageBitmap[] | null>>();
  private disposed = false;
  /** Called once per media when its strip becomes paintable. */
  onReady: ((mediaId: string) => void) | null = null;

  constructor(options: ThumbnailStripServiceOptions = {}) {
    this.store = options.store ?? new MemoryThumbnailStripStore();
    this.thumbWidth = options.thumbWidth ?? STRIP_THUMB_WIDTH;
    this.thumbHeight = options.thumbHeight ?? STRIP_THUMB_HEIGHT;
    this.framesPerYield = options.framesPerYield ?? FRAMES_PER_YIELD;
    this.fallback = options.fallback ?? null;
  }

  /**
   * The paintable strip of a media — the synchronous read the renderer uses.
   * @param mediaId the media.
   * @returns the frames, or `null` while they are still being generated.
   */
  strip(mediaId: string): readonly ImageBitmap[] | null {
    return this.cached.get(mediaId)?.frames ?? null;
  }

  /**
   * The strip plus the timing the renderer needs to index it.
   * @param mediaId the media.
   * @returns the strip info, or \`null\` while the frames are being built.
   */
  stripInfo(mediaId: string): ThumbnailStripInfo | null {
    const cached = this.cached.get(mediaId);
    if (!cached) return null;
    return {
      frames: cached.frames,
      intervalSeconds: cached.intervalSeconds,
      durationSeconds: cached.durationSeconds,
      width: cached.width,
      height: cached.height,
    };
  }

  /**
   * Loads a media's strip: memory, then the persisted cache, then a fresh
   * generation. Repeated calls while one runs share the same promise.
   * @param mediaId the media.
   * @param source the media's bytes (only needed for a fresh generation).
   * @param duration the media's length.
   * @param count how many frames (defaults to {@link desiredStripFrames}).
   * @returns the frames, or `null` when they could not be built.
   */
  async ensure(mediaId: string, source?: File | Blob, duration?: Rational, count?: number): Promise<ImageBitmap[] | null> {
    if (this.disposed) return null;
    const ready = this.cached.get(mediaId);
    if (ready) return ready.frames;
    const running = this.inflight.get(mediaId);
    if (running) return running;
    const job = this.build(mediaId, source, duration, count).finally(() => this.inflight.delete(mediaId));
    this.inflight.set(mediaId, job);
    return job;
  }

  /**
   * Drops a media's strip (relink, delete, re-import).
   * @param mediaId the media.
   */
  invalidate(mediaId: string): void {
    const cached = this.cached.get(mediaId);
    this.cached.delete(mediaId);
    if (cached) for (const frame of cached.frames) frame.close?.();
    void Promise.resolve(this.store.delete(mediaId)).catch(() => undefined);
  }

  /** Drops every strip (unmount). */
  clear(): void {
    this.disposed = true;
    for (const cached of this.cached.values()) for (const frame of cached.frames) frame.close?.();
    this.cached.clear();
    this.inflight.clear();
    this.onReady = null;
  }

  /**
   * Points the service at a durable store (the pool is built before
   * `ConcatMediaDB` opens).
   * @param store the store to use from now on.
   */
  setStore(store: ThumbnailStripStore): void {
    this.store = store;
  }

  /** The frame size every strip in this service uses. */
  get frameSize(): { width: number; height: number } {
    return { width: this.thumbWidth, height: this.thumbHeight };
  }

  /** The persisted record of a media, if any (diagnostics). */
  async cachedRecord(mediaId: string): Promise<ThumbnailStripRecord | undefined> {
    return this.store.get(mediaId);
  }

  /** Load → generate → publish, in that order. */
  private async build(
    mediaId: string,
    source: File | Blob | undefined,
    duration: Rational | undefined,
    count: number | undefined,
  ): Promise<ImageBitmap[] | null> {
    const record = await this.store.get(mediaId).catch(() => undefined);
    if (record) {
      const frames = await decodeStrip(record);
      if (frames && frames.length > 0 && !this.disposed) {
        this.publish(mediaId, {
          frames,
          intervalSeconds: record.intervalSeconds,
          durationSeconds: record.durationSeconds,
          width: record.thumbWidth,
          height: record.thumbHeight,
        });
        return frames;
      }
    }
    if (!source || !duration || duration.isZero()) return null;
    const frames = await generateStripFromSource(source, duration, count ?? desiredStripFrames(duration.asNumber()), this.thumbWidth, this.thumbHeight, {
      fallback: this.fallback,
      framesPerYield: this.framesPerYield,
    });
    if (frames.length === 0 || this.disposed) return frames.length > 0 ? frames : null;
    const durationSeconds = duration.asNumber();
    const intervalSeconds = durationSeconds / frames.length;
    this.publish(mediaId, {
      frames,
      intervalSeconds,
      durationSeconds,
      width: this.thumbWidth,
      height: this.thumbHeight,
    });
    const encoded = await encodeStrip(mediaId, frames, { intervalSeconds, durationSeconds });
    if (encoded) await this.store.put(encoded).catch(() => undefined);
    return frames;
  }

  /** Makes a strip paintable and tells the view to repaint. */
  private publish(mediaId: string, cached: CachedStrip): void {
    this.cached.set(mediaId, cached);
    this.onReady?.(mediaId);
  }
}
