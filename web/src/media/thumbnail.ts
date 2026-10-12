// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Thumbnail generation for the media library and the timeline strip.
 *
 * Frames are drawn from a {@link MediaDecoder} into an offscreen canvas and
 * returned as `ImageBitmap`s. Results are cached through a small key/value
 * store (IndexedDB in the app, memory in tests) keyed by the file's identity
 * — name, size and mtime — so re-importing a file never re-decodes its art.
 */

import { Rational } from '../core/rational.ts';
import type { MediaDecoder } from './decoder.ts';
import { intrinsicSize, type RenderImage } from '../render/types.ts';

/** The blob side of a cached thumbnail. */
export interface ThumbnailRecord {
  key: string;
  /** PNG bytes of the thumbnail. */
  blob: Blob;
  width: number;
  height: number;
}

/** A key/value slice that remembers thumbnails. */
export interface ThumbnailStore {
  get(key: string): Promise<ThumbnailRecord | undefined>;
  put(record: ThumbnailRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/** An in-memory {@link ThumbnailStore} — the default and the test double. */
export class MemoryThumbnailStore implements ThumbnailStore {
  private readonly map = new Map<string, ThumbnailRecord>();

  async get(key: string): Promise<ThumbnailRecord | undefined> {
    return this.map.get(key);
  }

  async put(record: ThumbnailRecord): Promise<void> {
    this.map.set(record.key, record);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/**
 * The cache key of a file: stable across sessions, cheap to compute.
 * @param file the file whose art this caches.
 * @returns `name: size: lastModified`.
 */
export function thumbnailKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Renders one frame to an `ImageBitmap` of `width × height` (aspect kept,
 * letterboxed on transparency).
 * @param frame the decoded picture.
 * @param width target width.
 * @param height target height.
 * @returns the thumbnail bitmap; the caller owns it.
 */
export async function scaleThumbnail(
  frame: RenderImage,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('no 2d context for thumbnails');
  const { width: sourceWidth, height: sourceHeight } = intrinsicSize(frame);
  const scale = Math.min(width / Math.max(1, sourceWidth), height / Math.max(1, sourceHeight));
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  ctx.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h);
  if ('transferToImageBitmap' in canvas) return canvas.transferToImageBitmap();
  return createImageBitmap(canvas as HTMLCanvasElement);
}

/**
 * The thumbnail of a media at `time`, through the cache.
 * @param decoder the media's decoder.
 * @param time the instant to show (ignored for stills).
 * @param width target width.
 * @param height target height.
 * @param store where cached thumbnails live.
 * @param key the file's cache key.
 * @returns the thumbnail, or `null` when the frame would not decode.
 */
export async function generateThumbnail(
  decoder: MediaDecoder,
  time: Rational,
  width: number,
  height: number,
  store: ThumbnailStore,
  key: string,
): Promise<ImageBitmap | null> {
  const cached = await store.get(key);
  if (cached) {
    try {
      return await createImageBitmap(cached.blob);
    } catch {
      await store.delete(key);
    }
  }
  const frame = await decoder.getFrame(time);
  if (!frame) return null;
  const bitmap = await scaleThumbnail(frame, width, height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await store.put({ key, blob, width, height });
  }
  return bitmap;
}

/**
 * N equidistant thumbnails across a media — the filmstrip inside timeline
 * clips.
 * @param decoder the media's decoder.
 * @param duration the media's length.
 * @param count how many frames to take.
 * @param thumbWidth target width of each.
 * @param thumbHeight target height of each.
 * @returns the frames, in order; the caller owns them.
 */
export async function generateThumbnailStrip(
  decoder: MediaDecoder,
  duration: Rational,
  count: number,
  thumbWidth: number,
  thumbHeight: number,
): Promise<ImageBitmap[]> {
  const out: ImageBitmap[] = [];
  const n = Math.max(1, Math.trunc(count));
  for (let i = 0; i < n; i += 1) {
    // Centre of each slice: (i + 0.5) / n of the duration.
    const at = duration.mul(Rational.new(BigInt(2 * i + 1), BigInt(2 * n)));
    const frame = await decoder.getFrame(at);
    if (!frame) continue;
    out.push(await scaleThumbnail(frame, thumbWidth, thumbHeight));
  }
  return out;
}
