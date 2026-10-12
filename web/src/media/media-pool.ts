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
import { MediaDecoder, type MediaFallback, type MediaInfo } from './decoder.ts';
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
  /** Fase 4: FFmpeg fallback handed to every decoder (lazy; never loaded unless needed). */
  fallback?: MediaFallback | null;
}

/** Fase 4: a proxy attached to an asset. */
interface AttachedProxy {
  decoder: MediaDecoder;
  width: number;
  height: number;
}

/** Thumbs shown in the library grid. */
const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;

/** Fase 6 hook: options of {@link MediaPool.getFrame}. */
export interface FrameRequestOptions {
  /** `auto` = proxy when enabled; `original` = never a proxy; `proxy` = only the proxy. */
  quality?: 'auto' | 'original' | 'proxy';
}

/** Runtime media pool: decoders, frames and thumbnails. */
export class MediaPool implements FramePool {
  private readonly assets = new Map<string, MediaAsset>();
  private readonly decoders = new Map<string, MediaDecoder>();
  private readonly thumbnailStore: ThumbnailStore;
  private readonly preloadSeconds: number;
  private readonly fallback: MediaFallback | null;
  private readonly proxies = new Map<string, AttachedProxy>();
  private useProxies = true;
  // Fase 6 hook: export forces original quality while it runs.
  private forceOriginal = false;

  constructor(options: MediaPoolOptions = {}) {
    this.thumbnailStore = options.thumbnailStore ?? new MemoryThumbnailStore();
    this.preloadSeconds = options.preloadSeconds ?? 2;
    this.fallback = options.fallback ?? null;
  }

  /**
   * Imports a local file: probes it, decodes a thumbnail, and makes it
   * available to the compositor.
   * @param file the file the user dropped or picked.
   * @param id the asset id (minted by the caller; `crypto.randomUUID`).
   * @returns the loaded asset.
   */
  async addMedia(file: File | Blob, id: string, name = file instanceof File ? file.name : id): Promise<MediaAsset> {
    const decoder = new MediaDecoder(file, id, { fallback: this.fallback });
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
  async getFrame(id: string, sourceTime: Rational, options?: FrameRequestOptions): Promise<RenderImage | null> {
    // Fase 6 hook: export asks for originals explicitly, or forces them
    // process-wide while it runs (so no code path can sample a proxy).
    const quality = options?.quality ?? 'auto';
    if (quality === 'original' || (this.forceOriginal && quality !== 'proxy')) return this.getOriginalFrame(id, sourceTime);
    if (quality === 'proxy') {
      const attached = this.proxies.get(id);
      return attached ? attached.decoder.getFrame(sourceTime) : null;
    }
    const proxy = this.activeProxy(id);
    if (proxy) {
      const frame = await proxy.decoder.getFrame(sourceTime);
      if (frame) return frame;
    }
    const decoder = this.decoders.get(id);
    if (!decoder) return null;
    return decoder.getFrame(sourceTime);
  }

  /**
   * Fase 4: the full-quality frame, ignoring proxies — what export renders.
   * @param id the asset id.
   * @param sourceTime seconds into the media.
   * @returns a drawable frame, or `null`.
   */
  async getOriginalFrame(id: string, sourceTime: Rational): Promise<RenderImage | null> {
    const decoder = this.decoders.get(id);
    return decoder ? decoder.getFrame(sourceTime) : null;
  }

  /**
   * Fase 4: a {@link FramePool} view that always reads originals — what the
   * export renderer must use so proxies never reach the output file.
   * @returns the original-quality pool view.
   */
  originalFrames(): FramePool {
    return {
      getFrame: (id, sourceTime) => this.getOriginalFrame(id, sourceTime),
      getSize: (id) => {
        const asset = this.assets.get(id);
        return asset && asset.width > 0 ? { width: asset.width, height: asset.height } : null;
      },
    };
  }

  /**
   * Fase 6 hook: while `enabled`, {@link getFrame} ignores proxies (unless a
   * caller asks for `quality: 'proxy'` explicitly). The export controller
   * turns it on for the duration of an export and always turns it off.
   * @param enabled whether originals are forced.
   */
  forceOriginalQuality(enabled: boolean): void {
    this.forceOriginal = enabled;
  }

  /** Fase 6 hook: whether originals are currently forced. */
  get originalQualityForced(): boolean {
    return this.forceOriginal;
  }

  /**
   * Fase 6 hook: whether the original of an asset can be decoded (an asset
   * whose file went missing may still have a proxy).
   * @param id the asset id.
   * @returns `true` when a decoder for the original exists.
   */
  hasOriginal(id: string): boolean {
    return this.decoders.has(id);
  }

  /**
   * Fase 6 hook: the pool view the exporter renders from. Originals only;
   * with `allowProxyFallback`, an asset without an original falls back to
   * its proxy (off by default — the export then fails with `NO_MEDIA`).
   * @param allowProxyFallback whether proxies may stand in for missing originals.
   * @returns a {@link FramePool}.
   */
  exportFrames(allowProxyFallback = false): FramePool {
    const originals = this.originalFrames();
    if (!allowProxyFallback) return originals;
    return {
      getFrame: (id, sourceTime) =>
        this.decoders.has(id) ? this.getOriginalFrame(id, sourceTime) : this.getFrame(id, sourceTime, { quality: 'proxy' }),
      getSize: (id) => originals.getSize(id),
    };
  }

  /**
   * Fase 4: plays `proxy` instead of the original while proxies are on.
   * Replaces (and closes) any proxy already attached.
   * @param id the asset id.
   * @param proxy the proxy file (OPFS blob).
   * @param size the proxy's pixel size.
   * @returns false when the asset is unknown.
   */
  attachProxy(id: string, proxy: Blob, size: { width: number; height: number }): boolean {
    if (!this.assets.has(id)) return false;
    this.detachProxy(id);
    this.proxies.set(id, { decoder: new MediaDecoder(proxy, `${id}:proxy`), width: size.width, height: size.height });
    return true;
  }

  /** Fase 4: drops the proxy of an asset (closing its decoder). */
  detachProxy(id: string): void {
    this.proxies.get(id)?.decoder.close();
    this.proxies.delete(id);
  }

  /** Fase 4: whether an asset has a proxy attached. */
  hasProxy(id: string): boolean {
    return this.proxies.has(id);
  }

  /** Fase 4: whether preview uses proxies. */
  get proxiesEnabled(): boolean {
    return this.useProxies;
  }

  /** Fase 4: switches preview between proxies and originals. */
  setUseProxies(on: boolean): void {
    this.useProxies = on;
  }

  /**
   * Fase 4: swaps an asset's source file (relink), keeping its id so every
   * clip referencing it keeps its edits.
   * @param id the asset id.
   * @param file the new local file.
   * @returns the refreshed asset, or `null` when the id is unknown.
   */
  async replaceSource(id: string, file: File | Blob): Promise<MediaAsset | null> {
    const asset = this.assets.get(id);
    if (!asset) return null;
    const decoder = new MediaDecoder(file, id, { fallback: this.fallback });
    const info = await decoder.init();
    this.decoders.get(id)?.close();
    this.decoders.set(id, decoder);
    const next: MediaAsset = {
      ...asset,
      name: file instanceof File ? file.name : asset.name,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      codec: info.videoCodec || info.audioCodec,
      fileSize: info.fileSize,
      file,
    };
    this.assets.set(id, next);
    return next;
  }

  /** The proxy serving `id` right now, if any. */
  private activeProxy(id: string): AttachedProxy | null {
    return this.useProxies ? this.proxies.get(id) ?? null : null;
  }

  /** The whole audio track of an asset. */
  async getAudioBuffer(id: string): Promise<AudioBuffer | null> {
    const decoder = this.decoders.get(id);
    if (!decoder) return null;
    return decoder.getAudioBuffer();
  }

  /** Intrinsic pixel size of the media, for aspect-fitting. */
  getSize(id: string): { width: number; height: number } | null {
    // Fase 4: the compositor crops in source pixels, so report the proxy's.
    const proxy = this.activeProxy(id);
    if (proxy) return { width: proxy.width, height: proxy.height };
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
      const decoder = this.activeProxy(id)?.decoder ?? this.decoders.get(id);
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
    this.detachProxy(id);
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
