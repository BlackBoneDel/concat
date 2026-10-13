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
import { FrameRate } from '../core/time.ts';
import type { FramePool, RenderImage } from '../render/types.ts';
import type { ThumbnailStripProvider, TimelineThumbnailStrip } from '../ui/timeline/types.ts';
import { MediaDecoder, type MediaFallback, type MediaInfo } from './decoder.ts';
import {
  generateThumbnail,
  placeholderThumbnail,
  thumbnailKey,
  MemoryThumbnailStore,
  type ThumbnailStore,
} from './thumbnail.ts';
import { ThumbnailStripService, type ThumbnailStripStore } from './thumbnail-strip.ts';
import { kindByExtension } from './import/format-support.ts';

/** Where an asset is in its (background) enrichment. */
export type MediaAssetStatus = 'processing' | 'ready' | 'error';

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
  /**
   * Import state. `processing` is what the library sees during the first
   * milliseconds (the card is on screen before a single byte is decoded);
   * `ready` once the probe landed; `error` when the probe could not read the
   * file — the card stays, with the placeholder art and the reason.
   */
  status: MediaAssetStatus;
  /** Why the enrichment failed, in the user's words (`status: 'error'`). */
  statusMessage?: string;
}

/** Options for {@link MediaPool.constructor}. */
export interface MediaPoolOptions {
  /** Where thumbnails are cached; an in-memory store by default. */
  thumbnailStore?: ThumbnailStore;
  /** Seconds of frames to warm ahead of the playhead. */
  preloadSeconds?: number;
  /** Fase 4: FFmpeg fallback handed to every decoder (lazy; never loaded unless needed). */
  fallback?: MediaFallback | null;
  /** Fase 8: where the filmstrips of the timeline clips are cached. */
  stripStore?: ThumbnailStripStore;
  /** Called the instant an asset exists (optimistic card) — never after an `await`. */
  onMediaAdded?: (asset: MediaAsset) => void;
  /** Called when an asset's metadata/thumbnail changed (or its enrichment failed). */
  onMediaUpdated?: (asset: MediaAsset) => void;
}

/** How long a metadata probe may take before the import gives up on it. */
export const PROBE_TIMEOUT_MS = 2000;

/** How long the real thumbnail may take before the placeholder stays. */
export const THUMBNAIL_TIMEOUT_MS = 4000;

/** Why an import was refused before it started. */
export type MediaImportErrorCode = 'empty' | 'unsupported' | 'unavailable';

/**
 * A refused import. Carries the file name and a code so the shell can pick
 * the right toast (a `.zip` is a warning, a full disk is an error) without
 * string-matching the message.
 */
export class MediaImportError extends Error {
  readonly code: MediaImportErrorCode;
  readonly fileName: string;

  /**
   * @param code why the file cannot be imported.
   * @param fileName the file the user dropped.
   * @param message the user-facing sentence.
   */
  constructor(code: MediaImportErrorCode, fileName: string, message: string) {
    super(message);
    this.name = 'MediaImportError';
    this.code = code;
    this.fileName = fileName;
  }
}

/** What an import will do with a file, decided before any I/O. */
export type ImportPlan =
  | { ok: true; kind: 'video' | 'audio' | 'image' }
  | { ok: false; code: MediaImportErrorCode; message: string };

/**
 * Decide what an import will do with a file, from its MIME type and
 * extension — synchronously, because the library card and the toasts are
 * built from this and neither can wait for a probe.
 * @param file the dropped/picked file.
 * @returns the plan (kind, or the reason it is refused).
 */
export function planImport(file: { name: string; size: number; type?: string }): ImportPlan {
  if (file.size <= 0) return { ok: false, code: 'empty', message: 'El archivo está vacío' };
  const mime = (file.type ?? '').toLowerCase();
  if (mime.startsWith('video/')) return { ok: true, kind: 'video' };
  if (mime.startsWith('audio/')) return { ok: true, kind: 'audio' };
  if (mime.startsWith('image/')) return { ok: true, kind: 'image' };
  const kind = kindByExtension(file.name);
  if (kind === 'video' || kind === 'audio' || kind === 'image') return { ok: true, kind };
  return {
    ok: false,
    code: 'unsupported',
    message: `Formato no compatible: ${file.name.split('.').pop() ?? file.name}`,
  };
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

/** Runtime media pool: decoders, frames, thumbnails and filmstrips. */
export class MediaPool implements FramePool, ThumbnailStripProvider {
  private readonly assets = new Map<string, MediaAsset>();
  private readonly decoders = new Map<string, MediaDecoder>();
  private readonly thumbnailStore: ThumbnailStore;
  private readonly preloadSeconds: number;
  private readonly fallback: MediaFallback | null;
  private readonly proxies = new Map<string, AttachedProxy>();
  /** Fase 8: the filmstrip of every media (canvas reads it synchronously). */
  readonly strips: ThumbnailStripService;
  private useProxies = true;
  // Fase 6 hook: export forces original quality while it runs.
  private forceOriginal = false;
  /** Import listeners (the library card appears from the optimistic event). */
  private onMediaAdded: ((asset: MediaAsset) => void) | null;
  private onMediaUpdated: ((asset: MediaAsset) => void) | null;
  /** The enrichment of every asset, so callers can await the real metadata. */
  private readonly enriching = new Map<string, Promise<MediaAsset>>();

  constructor(options: MediaPoolOptions = {}) {
    this.thumbnailStore = options.thumbnailStore ?? new MemoryThumbnailStore();
    this.preloadSeconds = options.preloadSeconds ?? 2;
    this.fallback = options.fallback ?? null;
    this.strips = new ThumbnailStripService({ store: options.stripStore, fallback: this.fallback });
    // The view repaints the clip with its filmstrip as soon as it lands.
    this.strips.onReady = () => notifyStripsChanged();
    this.onMediaAdded = options.onMediaAdded ?? null;
    this.onMediaUpdated = options.onMediaUpdated ?? null;
  }

  /**
   * Registers the import listeners (the pool is built before the library
   * panel exists, so `main.ts` wires them once the shell is up).
   * @param listeners what to call when an asset appears or settles.
   */
  setImportListeners(listeners: {
    onMediaAdded?(asset: MediaAsset): void;
    onMediaUpdated?(asset: MediaAsset): void;
  }): void {
    this.onMediaAdded = listeners.onMediaAdded ?? null;
    this.onMediaUpdated = listeners.onMediaUpdated ?? null;
  }

  /**
   * Imports a local file.
   *
   * The asset — and therefore the library card — exists **synchronously**:
   * the id, the name, the kind and a placeholder thumbnail are known from the
   * file's own metadata, so `onMediaAdded` fires before the first `await` and
   * the UI answers in under a millisecond. The probe, the real thumbnail and
   * the waveform then happen in the background; the returned promise resolves
   * with the optimistic asset, and {@link whenReady} hands back the enriched
   * one (or the fallback) without ever rejecting: a file whose frames will
   * not decode keeps its card instead of vanishing.
   *
   * The resolved value is the *settled* asset, so callers that need the real
   * metadata (the OPFS copy is keyed to it) keep working exactly as before;
   * the card does not wait for it, it came from `onMediaAdded`.
   * @param file the file the user dropped or picked.
   * @param id the asset id (minted by the caller; `crypto.randomUUID`).
   * @param name the display name.
   * @returns the enriched asset (`status: 'error'` when the probe failed).
   * @throws {MediaImportError} when the file is empty or is not media.
   */
  async addMedia(file: File | Blob, id: string, name = file instanceof File ? file.name : id): Promise<MediaAsset> {
    const plan = planImport({ name, size: file.size, type: file.type });
    if (!plan.ok) throw new MediaImportError(plan.code, name, plan.message);

    const optimistic: MediaAsset = {
      id,
      name,
      type: plan.kind,
      duration: Rational.ZERO,
      width: 0,
      height: 0,
      fps: FrameRate.THIRTY,
      codec: '',
      fileSize: file.size,
      thumbnailUrl: placeholderThumbnail(name, plan.kind, 'Procesando…'),
      opfsPath: `media/${id}`,
      importedAt: Date.now(),
      file,
      status: 'processing',
    };
    this.assets.set(id, optimistic);
    // Synchronous: no `await` above this line, so the card is on screen
    // before the event loop turns.
    this.onMediaAdded?.(optimistic);

    const enrichment = this.enrich(id, file, name, plan.kind);
    this.enriching.set(id, enrichment);
    void enrichment.then((asset) => this.onMediaUpdated?.(asset));
    // Never rejects: a failed probe settles on the placeholder instead.
    return enrichment.catch(() => optimistic);
  }

  /**
   * Waits for an asset's background enrichment (probe, thumbnail).
   * @param id the asset id.
   * @returns the settled asset, or `null` when the id is unknown.
   */
  async whenReady(id: string): Promise<MediaAsset | null> {
    const pending = this.enriching.get(id);
    if (pending) return pending;
    return this.assets.get(id) ?? null;
  }

  /**
   * The probe, the thumbnail and the fallback metadata — everything
   * `addMedia` used to do before returning.
   * @param id the asset id.
   * @param file the bytes.
   * @param name the display name.
   * @param kind the kind the extension/MIME claimed.
   * @returns the enriched asset (never a rejection).
   */
  private async enrich(
    id: string,
    file: File | Blob,
    name: string,
    kind: 'video' | 'audio' | 'image',
  ): Promise<MediaAsset> {
    const decoder = new MediaDecoder(file, id, { fallback: this.fallback });
    let info: MediaInfo | null = null;
    try {
      info = await timeout(decoder.init(), PROBE_TIMEOUT_MS, null);
    } catch {
      info = null;
    }
    if (this.assets.has(id)) this.decoders.set(id, decoder);
    else decoder.close();

    const current = this.assets.get(id);
    if (!current) return emptyAsset(id, name, kind, file);

    let thumbnailUrl = current.thumbnailUrl;
    let note: string | null = null;
    if (!info) {
      note = 'No se pudo leer la cabecera del archivo';
    } else if (info.type !== 'audio') {
      const key = file instanceof File ? thumbnailKey(file) : `${id}:${file.size}`;
      try {
        const thumb = await timeout(
          generateThumbnail(
            decoder,
            Rational.approximate(info.duration.asNumber() / 2) ?? Rational.ZERO,
            THUMB_WIDTH,
            THUMB_HEIGHT,
            this.thumbnailStore,
            key,
          ),
          THUMBNAIL_TIMEOUT_MS,
          null,
        );
        if (thumb) {
          thumbnailUrl = URL.createObjectURL(await bitmapToBlob(thumb));
          thumb.close();
        } else {
          note = 'Miniatura no disponible';
        }
      } catch {
        note = 'Miniatura no disponible';
      }
    }

    const type = info?.type ?? kind;
    const settled: MediaAsset = {
      ...current,
      type,
      duration: info?.duration ?? Rational.ZERO,
      width: info?.width ?? 0,
      height: info?.height ?? 0,
      fps: info?.fps ?? FrameRate.THIRTY,
      codec: info ? info.videoCodec || info.audioCodec : '',
      fileSize: info?.fileSize ?? file.size,
      // Audio has no picture (the card draws its glyph); a silent/failed
      // thumbnail leaves the placeholder — with the reason on it — in place.
      thumbnailUrl: type === 'audio' ? '' : note === null ? thumbnailUrl : placeholderThumbnail(name, type, note),
      status: info === null ? 'error' : 'ready',
      ...(note !== null ? { statusMessage: note } : {}),
    };
    this.assets.set(id, settled);
    return settled;
  }

  /**
   * Fase 8: swaps the durable store of the filmstrip cache (the pool is
   * constructed before `ConcatMediaDB` is open).
   * @param store the store to persist strips in.
   */
  useStripStore(store: ThumbnailStripStore): void {
    this.strips.setStore(store);
  }

  /**
   * Fase 8: the filmstrip of a media, as the timeline's canvas reads it.
   * @param mediaId the media.
   * @returns the frames plus their timing, or `null` while they build.
   */
  strip(mediaId: string): TimelineThumbnailStrip | null {
    return this.strips.stripInfo(mediaId);
  }

  /**
   * Fase 8: builds a media's filmstrip if it is not cached yet (memory, then
   * IndexedDB, then a fresh decode of the asset's own bytes).
   * @param mediaId the media.
   * @returns the frames, or `null` when the asset is unknown.
   */
  async ensureThumbnailStrip(mediaId: string, count?: number): Promise<readonly ImageBitmap[] | null> {
    const ready = this.strips.strip(mediaId);
    if (ready) return ready;
    const asset = this.assets.get(mediaId);
    if (!asset || asset.type === 'audio') return null;
    return this.strips.ensure(mediaId, asset.file, asset.duration, count);
  }

  /**
   * Fase 8: the frames of a filmstrip (convenience alias of
   * {@link strip} for callers that only want the pictures).
   * @param mediaId the media.
   * @returns the frames, or `null`.
   */
  thumbnailStrip(mediaId: string): readonly ImageBitmap[] | null {
    return this.strips.strip(mediaId);
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
    // The frames changed: the cached filmstrip is stale.
    this.strips.invalidate(id);
    notifyStripsChanged();
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
   * One loaded asset by id — the name the drag & drop wiring uses.
   * @param id the asset id.
   * @returns the asset, or `undefined` when the library never saw it.
   */
  getAsset(id: string): MediaAsset | undefined {
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
    // Only blob URLs are ours to free; the placeholder is a `data:` URL and
    // `revokeObjectURL` on one is a no-op that would warn in some engines.
    if (asset.thumbnailUrl.startsWith('blob:')) URL.revokeObjectURL(asset.thumbnailUrl);
    this.decoders.get(id)?.close();
    this.decoders.delete(id);
    this.enriching.delete(id);
    this.detachProxy(id);
    this.strips.invalidate(id);
    this.assets.delete(id);
  }

  /** Frees every decoder, frame and URL. */
  destroy(): void {
    for (const id of [...this.assets.keys()]) this.removeMedia(id);
  }
}

/** An asset for a file whose import was cancelled mid-flight. */
function emptyAsset(id: string, name: string, kind: 'video' | 'audio' | 'image', file: File | Blob): MediaAsset {
  return {
    id,
    name,
    type: kind,
    duration: Rational.ZERO,
    width: 0,
    height: 0,
    fps: FrameRate.THIRTY,
    codec: '',
    fileSize: file.size,
    thumbnailUrl: placeholderThumbnail(name, kind, 'Importación cancelada'),
    opfsPath: `media/${id}`,
    importedAt: Date.now(),
    file,
    status: 'error',
    statusMessage: 'Importación cancelada',
  };
}

/**
 * Awaits `promise` but never longer than `ms`; on timeout (or rejection) the
 * fallback stands in. The background enrichment is not allowed to hang the
 * library: a probe that never answers means "unknown metadata", not a card
 * that spins forever.
 * @param promise the work.
 * @param ms the budget in milliseconds.
 * @param fallback what to return when the budget runs out.
 * @returns the result or the fallback.
 */
function timeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = globalThis.setTimeout(() => finish(fallback), ms);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        finish(value);
      },
      () => {
        globalThis.clearTimeout(timer);
        finish(fallback);
      },
    );
  });
}

/** Fase 8: tells the timeline a filmstrip changed (no-op outside a DOM). */
function notifyStripsChanged(): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent('media-strips-changed'));
}

/** A bitmap as PNG bytes, for the library's `<img>` thumbnails. */
async function bitmapToBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
