// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The pool of loaded media — the compositor's `FramePool`.
 *
 * Owns one {@link MediaDecoder} per asset, hands frames to the renderer, and
 * keeps the decoded-frame cache warm ahead of the playhead. Import here is
 * *runtime* state; persistence is `storage/media-store.ts`'s job (the pool
 * optionally writes through to it).
 */

import { Rational } from '../core/rational.ts';
import type { FramePool, RenderImage } from '../render/types.ts';
import { MediaDecoder, type MediaInfo } from './decoder.ts';
import { generateThumbnail, thumbnailKey, MemoryThumbnailStore, type ThumbnailStore } from './thumbnail.ts';

/** A loaded asset: what the library shows and the timeline references. */
export interface MediaAsset {
  id: string;
  name: string;
  type: 'video' | 'audio' | 'image';
  duration: Rational;
  width: number;
  height: number;
  fps: import('../core/time.ts').FrameRate;
  codec: string;
  fileSize: number;
  thumbnailUrl: string;
  opfsPath: string;
  importedAt: number;
  /** The local file this asset was imported from (kept for re-decode). */
  file: File | Blob;
}

/** Options for {@link MediaPool.constructor}. */
export interface MediaPoolOptions {
  /** Where thumbnails are cached; an in-memory store by default. */
  thumbnailStore?: ThumbnailStore;
  /** Seconds of frames to warm ahead of the playhead. */
  preloadSeconds?: number;
}

/** Thumbs shown in the library grid. */
const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;

/** Runtime media pool: decoders, frames and thumbnails. */
export class MediaPool implements FramePool {
  private readonly assets = new Map<string, MediaAsset>();
  private readonly decoders = new Map<string, MediaDecoder>();
  private readonly thumbnailStore: ThumbnailStore;
  private readonly preloadSeconds: number;

  constructor(options: MediaPoolOptions = {}) {
    this.thumbnailStore = options.thumbnailStore ?? new MemoryThumbnailStore();
    this.preloadSeconds = options.preloadSeconds ?? 2;
  }

  /**
   * Imports a local file: probes it, decodes a thumbnail, and makes it
   * available to the compositor.
   * @param file the file the user dropped or picked.
   * @param id the asset id (minted by the caller; `crypto.randomUUID`).
   * @returns the loaded asset.
   */
  async addMedia(file: File | Blob, id: string, name = file instanceof File ? file.name : id): Promise<MediaAsset> {
    const decoder = new MediaDecoder(file, id);
    const info: MediaInfo = await decoder.init();
    this.decoders.set(id, decoder);

    let thumbnailUrl = '';
    if (info.type !== 'audio') {
      const key = file instanceof File ? thumbnailKey(file) : `${id}:${file.size}`;
      const thumb = await generateThumbnail(
        decoder,
        Rational.approximate(info.duration.asNumber() / 2) ?? Rational.ZERO,
        THUMB_WIDTH,
        THUMB_HEIGHT,
        this.thumbnailStore,
        key,
      );
      if (thumb) {
        thumbnailUrl = URL.createObjectURL(await bitmapToBlob(thumb));
        thumb.close();
      }
    }

    const asset: MediaAsset = {
      id,
      name,
      type: info.type,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      codec: info.videoCodec || info.audioCodec,
      fileSize: info.fileSize,
      thumbnailUrl,
      opfsPath: `media/${id}`,
      importedAt: Date.now(),
      file,
    };
    this.assets.set(id, asset);
    return asset;
  }

  /** The decoder of an asset, or `null`. */
  getDecoder(id: string): MediaDecoder | null {
    return this.decoders.get(id) ?? null;
  }

  /**
   * The frame of `id` at `sourceTime` — the compositor's entry point.
   * @param id the asset id.
   * @param sourceTime seconds into the media.
   * @returns a drawable frame, or `null`.
   */
  async getFrame(id: string, sourceTime: Rational): Promise<RenderImage | null> {
    const decoder = this.decoders.get(id);
    if (!decoder) return null;
    return decoder.getFrame(sourceTime);
  }

  /** The whole audio track of an asset. */
  async getAudioBuffer(id: string): Promise<AudioBuffer | null> {
    const decoder = this.decoders.get(id);
    if (!decoder) return null;
    return decoder.getAudioBuffer();
  }

  /** Intrinsic pixel size of the media, for aspect-fitting. */
  getSize(id: string): { width: number; height: number } | null {
    const asset = this.assets.get(id);
    return asset && asset.width > 0 ? { width: asset.width, height: asset.height } : null;
  }

  /** Every loaded asset, newest first. */
  listMedia(): MediaAsset[] {
    return [...this.assets.values()].sort((a, b) => b.importedAt - a.importedAt);
  }

  /** One loaded asset. */
  get(id: string): MediaAsset | undefined {
    return this.assets.get(id);
  }

  /**
   * Warms the frame cache ahead of `time` for every clip about to play.
   * @param requests the (media id, source time) pairs coming up.
   */
  async preload(requests: { id: string; time: Rational }[]): Promise<void> {
    for (const { id, time } of requests) {
      const decoder = this.decoders.get(id);
      if (!decoder) continue;
      void decoder.getFrame(time);
      void decoder.getFrame(time.add(Rational.approximate(this.preloadSeconds / 2) ?? Rational.ZERO));
    }
  }

  /** Removes an asset: decoder, frames and thumbnail URL. */
  removeMedia(id: string): void {
    const asset = this.assets.get(id);
    if (!asset) return;
    if (asset.thumbnailUrl !== '') URL.revokeObjectURL(asset.thumbnailUrl);
    this.decoders.get(id)?.close();
    this.decoders.delete(id);
    this.assets.delete(id);
  }

  /** Frees every decoder, frame and URL. */
  destroy(): void {
    for (const id of [...this.assets.keys()]) this.removeMedia(id);
  }
}

/** A bitmap as PNG bytes, for the library's `<img>` thumbnails. */
async function bitmapToBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
