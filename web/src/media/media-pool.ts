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
import {
  MediaDecoder,
  METADATA_PROBE_TIMEOUT_MS,
  PROBE_FALLBACK,
  probeMediaMetadata,
  withDeadline,
  type MediaFallback,
  type MediaInfo,
} from './decoder.ts';
import { generateThumbnail, thumbnailKey, MemoryThumbnailStore, type ThumbnailStore } from './thumbnail.ts';
import { mediaKindOf, type ImportMediaKind } from './import/format-support.ts';

/**
 * How far along an asset's import is.
 *
 * - `processing`: the card is already in the library, the browser is still
 *   probing it (thumbnail and real duration arrive with `ready`).
 * - `ready`: metadata and artwork come from the file itself.
 * - `error`: nothing could be read (unsupported codec, torn file): the asset
 *   stays in the library with {@link PROBE_FALLBACK} metadata and its
 *   placeholder thumbnail, never dropped.
 */
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
  /** Import progress; `processing` only while the background probe runs. */
  status: MediaAssetStatus;
  /** Why the metadata could not be read, when `status` is `error`. */
  statusMessage: string | null;
}

/** Options for {@link MediaPool.constructor}. */
export interface MediaPoolOptions {
  /** Where thumbnails are cached; an in-memory store by default. */
  thumbnailStore?: ThumbnailStore;
  /** Seconds of frames to warm ahead of the playhead. */
  preloadSeconds?: number;
  /** Fase 4: FFmpeg fallback handed to every decoder (lazy; never loaded unless needed). */
  fallback?: MediaFallback | null;
  /** Strict metadata-probe deadline passed to every decoder (default 2 s). */
  probeTimeoutMs?: number;
}

/** One file the pool took in, with the card that appeared for it. */
export interface AcceptedFile {
  file: File | Blob;
  asset: MediaAsset;
}

/** What {@link MediaPool.addFiles} did with a batch. */
export interface AddFilesResult {
  /** Files that are media: their cards are already in `listMedia()`. */
  accepted: AcceptedFile[];
  /** Files that are not audio/video/image — the caller warns about them. */
  rejected: File[];
  /** Settles (never rejects) once every background probe finished. */
  ready: Promise<MediaAsset[]>;
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

/**
 * Deadline of the last-ditch probe run when the full one already came back
 * empty: the browser had its 2 seconds inside the decoder, so this pass only
 * fills in the provisional values and must not make the card spin again.
 */
const PROVISIONAL_PROBE_TIMEOUT_MS = 250;

/**
 * How much longer than the element probe the whole background import may
 * take: the probe deadline (2 s) plus the budget of the duration-reveal seek
 * (`revealDuration`, 2.5 s) that OBS-shaped WebM files need. It only fires
 * when the browser truly stopped answering — the card is on screen from the
 * first millisecond either way.
 */
const ENRICHMENT_GRACE_MS = 3000;

/**
 * The placeholder palette of the fallback thumbnails, per kind — a
 * background colour and a drawn glyph (SVG shapes, never emoji: the project
 * has an anti-emoji guard for a reason).
 */
const PLACEHOLDER_COLOURS: Record<ImportMediaKind, { background: string; glyph: string }> = {
  video: {
    background: '#1b1b28',
    glyph: '<polygon points="70,30 70,58 92,44" fill="#e8e8f4"/>',
  },
  audio: {
    background: '#161a2e',
    glyph:
      '<circle cx="66" cy="52" r="5" fill="#e8e8f4"/><rect x="70" y="28" width="3" height="24" fill="#e8e8f4"/>' +
      '<circle cx="88" cy="47" r="5" fill="#e8e8f4"/><rect x="92" y="23" width="3" height="24" fill="#e8e8f4"/>',
  },
  image: {
    background: '#1a241f',
    glyph:
      '<rect x="66" y="29" width="28" height="22" rx="3" fill="none" stroke="#e8e8f4" stroke-width="2"/>' +
      '<circle cx="74" cy="37" r="3" fill="#e8e8f4"/>' +
      '<path d="M68 49l7-7 5 5 5-4 5 6" fill="none" stroke="#e8e8f4" stroke-width="2"/>',
  },
};

/**
 * The fallback thumbnail: a coloured card with the file's own name, as a
 * `data:` SVG. It is what the library shows while (and if) the real frame
 * never arrives, so an unreadable file still has a recognisable card.
 * @param kind the media kind (picks the glyph and the colour).
 * @param name the file name shown under the glyph.
 * @returns a `data:image/svg+xml` URL.
 */
export function placeholderThumbnail(kind: ImportMediaKind, name: string): string {
  const colours = PLACEHOLDER_COLOURS[kind] ?? PLACEHOLDER_COLOURS.video;
  const label = escapeXml(name.length > 26 ? `${name.slice(0, 25)}…` : name);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90">' +
    `<rect width="160" height="90" fill="${colours.background}"/>` +
    `${colours.glyph}` +
    `<text x="80" y="70" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#a6a6be">${label}</text>` +
    '</svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Fallback counter for environments without `crypto.randomUUID`. */
let idCounter = 0;

/** A fresh asset id: `crypto.randomUUID` where available, else a local one. */
function randomId(): string {
  const source = globalThis.crypto as Crypto | undefined;
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  idCounter += 1;
  return `media-${Date.now().toString(36)}-${idCounter}`;
}

/** Escapes the five characters that would break the SVG above. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The kind a file claims to be, falling back to `video` for nameless blobs. */
function kindOf(file: File | Blob, name: string, mime = file.type): ImportMediaKind {
  return mediaKindOf(name, mime) ?? 'video';
}

/**
 * Whether a probe produced nothing usable — no duration and no size, or an
 * image without pixels. Nothing to show, so the provisional metadata takes
 * over (and the FFmpeg fallback still gets its chance inside the decoder).
 * @param info the probe result (or `null` when it threw).
 * @returns `true` when the asset needs the documented provisional values.
 */
export function isInconclusiveProbe(info: MediaInfo | null): boolean {
  if (!info) return true;
  if (info.type === 'image') return info.width <= 0 || info.height <= 0;
  return info.duration.asNumber() <= 0 && info.width <= 0;
}

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
  private readonly probeTimeoutMs: number;
  /** The background import of every id currently being probed. */
  private readonly inFlight = new Map<string, Promise<MediaAsset | null>>();
  /** Per-asset revision: a late (stale) write never overwrites a newer one. */
  private readonly revisions = new Map<string, number>();
  private revisionCounter = 0;

  /**
   * Called synchronously the moment an asset's card exists (the optimistic
   * shell), so the library can show it before any probing happens.
   */
  onMediaAdded: ((asset: MediaAsset) => void) | null = null;
  /**
   * Called when a background import finishes (or fails): real duration,
   * size, thumbnail and `status` are on the asset by then.
   */
  onMediaUpdated: ((asset: MediaAsset) => void) | null = null;

  constructor(options: MediaPoolOptions = {}) {
    this.thumbnailStore = options.thumbnailStore ?? new MemoryThumbnailStore();
    this.preloadSeconds = options.preloadSeconds ?? 2;
    this.fallback = options.fallback ?? null;
    this.probeTimeoutMs = options.probeTimeoutMs ?? METADATA_PROBE_TIMEOUT_MS;
  }

  /**
   * Imports a local file: puts an optimistic card in the library **before it
   * awaits anything** (so the UI reacts in milliseconds) and enriches it in
   * the background.
   *
   * @param file the file the user dropped or picked.
   * @param id the asset id (minted by the caller; `crypto.randomUUID`).
   * @param name the library name (the file's own by default).
   * @returns the enriched asset — never rejects, never hangs: a file whose
   * metadata cannot be read keeps its card with provisional metadata.
   */
  async addMedia(file: File | Blob, id: string, name = file instanceof File ? file.name : id): Promise<MediaAsset> {
    const shell = this.assets.get(id) ?? this.registerShell(file, id, name);
    const asset = await this.startEnrichment(id, file, shell);
    return asset ?? this.assets.get(id) ?? shell;
  }

  /**
   * Imports a batch the way a drop or a file picker delivers it: every file
   * that is media gets its card immediately (synchronously), the ones that
   * are not are handed back for the caller to report.
   *
   * @param files the dropped or picked files.
   * @returns the accepted cards, the rejected files and a `ready` promise.
   */
  addFiles(files: (File | Blob)[]): AddFilesResult {
    const accepted: AcceptedFile[] = [];
    const rejected: File[] = [];
    const pending: Promise<MediaAsset | null>[] = [];
    for (const file of files) {
      const name = file instanceof File ? file.name : '';
      if (file instanceof File && mediaKindOf(name, file.type) === null) {
        rejected.push(file);
        continue;
      }
      const id = randomId();
      const shell = this.registerShell(file, id, name === '' ? id : name);
      accepted.push({ file, asset: shell });
      pending.push(this.startEnrichment(id, file, shell));
    }
    return {
      accepted,
      rejected,
      ready: Promise.all(pending).then((assets) => assets.filter((asset): asset is MediaAsset => asset !== null)),
    };
  }

  /**
   * Creates the optimistic card: id, name, kind by extension/MIME, size, a
   * placeholder thumbnail and `status: 'processing'` — all synchronously.
   * @param file the imported file.
   * @param id the asset id.
   * @param name the library name.
   * @returns the shell, already in `listMedia()`.
   */
  private registerShell(file: File | Blob, id: string, name: string): MediaAsset {
    const type = kindOf(file, name);
    const shell: MediaAsset = {
      id,
      name,
      type,
      // Provisional values: the real ones arrive with the background probe.
      duration: Rational.fromRatio(0, 1),
      width: type === 'audio' ? 0 : PROBE_FALLBACK.width,
      height: type === 'audio' ? 0 : PROBE_FALLBACK.height,
      fps: FrameRate.THIRTY,
      codec: '',
      fileSize: file.size,
      thumbnailUrl: placeholderThumbnail(type, name),
      opfsPath: `media/${id}`,
      importedAt: Date.now(),
      file,
      status: 'processing',
      statusMessage: null,
    };
    this.revisions.set(id, (this.revisionCounter += 1));
    this.assets.set(id, shell);
    console.info('[MediaImport] Archivo recibido:', name, `(${file.size} bytes)`);
    console.info('[MediaImport] Asset optimista creado con ID:', id);
    this.onMediaAdded?.(shell);
    return shell;
  }

  /** Starts (or joins) the background import of an asset. */
  private startEnrichment(id: string, file: File | Blob, shell: MediaAsset): Promise<MediaAsset | null> {
    const inFlight = this.inFlight.get(id);
    if (inFlight) return inFlight;
    const revision = this.revisions.get(id) ?? 0;
    const task = this.enrich(id, file, shell, revision);
    this.inFlight.set(id, task);
    void task.then(() => {
      if (this.inFlight.get(id) === task) this.inFlight.delete(id);
    });
    return task;
  }

  /**
   * The background half of an import: probe, thumbnail, publish. It has a
   * hard deadline of its own (see {@link METADATA_PROBE_TIMEOUT_MS}); when
   * the browser overruns it the asset is published with provisional
   * metadata and the late answer is applied if it ever arrives.
   */
  private async enrich(id: string, file: File | Blob, shell: MediaAsset, revision: number): Promise<MediaAsset | null> {
    const work = this.probeAndPublish(id, file, shell, revision);
    const published = await withDeadline<MediaAsset | null | undefined>(
      work,
      this.probeTimeoutMs + ENRICHMENT_GRACE_MS,
      undefined,
    );
    if (published) return published;
    // Deadline exceeded: the card is already on screen with the shell's
    // provisional values; give it the documented fallback metadata now and
    // let a late answer upgrade it in place.
    const provisional = await probeMediaMetadata(file, {
      id,
      type: shell.type,
      timeoutMs: PROVISIONAL_PROBE_TIMEOUT_MS,
    });
    const asset = this.publish(
      {
        ...shell,
        type: provisional.type,
        duration: provisional.duration,
        width: provisional.width,
        height: provisional.height,
        fps: provisional.fps,
        status: 'error',
        statusMessage: 'La sonda de metadatos no respondió a tiempo; se usan valores provisionales.',
      },
      revision,
    );
    void work.then((late) => {
      if (late) console.info('[MediaImport] Metadatos actualizados OK (tarde):', id);
    });
    return asset ?? this.assets.get(id) ?? shell;
  }

  /**
   * Probes the file, decodes its thumbnail and publishes the result —
   * resolving with `null` when nothing usable could be read.
   */
  private async probeAndPublish(
    id: string,
    file: File | Blob,
    shell: MediaAsset,
    revision: number,
  ): Promise<MediaAsset | null> {
    let decoder: MediaDecoder | null = null;
    let info: MediaInfo | null = null;
    try {
      decoder = new MediaDecoder(file, id, { fallback: this.fallback, probeTimeoutMs: this.probeTimeoutMs });
      info = await decoder.init();
    } catch (error) {
      console.warn('[MediaImport] La sonda de metadatos falló:', shell.name, error);
    }

    if (info === null || isInconclusiveProbe(info)) {
      // Nothing usable (unsupported codec, torn file, silent browser): the
      // card stays, with provisional metadata and the placeholder thumbnail.
      const provisional = await probeMediaMetadata(file, {
        id,
        type: shell.type,
        timeoutMs: PROVISIONAL_PROBE_TIMEOUT_MS,
      });
      return this.publish(
        {
          ...shell,
          type: provisional.type,
          duration: provisional.duration,
          width: provisional.width,
          height: provisional.height,
          fps: provisional.fps,
          status: 'error',
          statusMessage: 'No se pudieron leer los metadatos del archivo; se usan valores provisionales.',
        },
        revision,
        // The element path may still play the file even when its metadata is
        // unreadable, so keep the decoder when one could be built.
        decoder,
      );
    }

    const ready = info;
    let thumbnailUrl = shell.thumbnailUrl;
    if (ready.type !== 'audio' && decoder) {
      thumbnailUrl = await this.thumbnailFor(id, file, decoder, ready, shell.thumbnailUrl);
    }
    const asset: MediaAsset = {
      id,
      name: shell.name,
      type: ready.type,
      duration: ready.duration,
      width: ready.width,
      height: ready.height,
      fps: ready.fps,
      codec: ready.videoCodec || ready.audioCodec,
      fileSize: ready.fileSize,
      thumbnailUrl,
      opfsPath: shell.opfsPath,
      importedAt: shell.importedAt,
      file,
      status: 'ready',
      statusMessage: null,
    };
    console.info('[MediaImport] Metadatos actualizados OK:', shell.name, `${asset.width}×${asset.height}`);
    return this.publish(asset, revision, decoder);
  }

  /** The real thumbnail, or the placeholder when the frame cannot be drawn. */
  private async thumbnailFor(
    id: string,
    file: File | Blob,
    decoder: MediaDecoder,
    info: MediaInfo,
    fallbackUrl: string,
  ): Promise<string> {
    try {
      const key = file instanceof File ? thumbnailKey(file) : `${id}:${file.size}`;
      const thumb = await withDeadline(
        generateThumbnail(
          decoder,
          Rational.approximate(info.duration.asNumber() / 2) ?? Rational.ZERO,
          THUMB_WIDTH,
          THUMB_HEIGHT,
          this.thumbnailStore,
          key,
        ),
        this.probeTimeoutMs,
        null,
      );
      if (!thumb) return fallbackUrl;
      const url = URL.createObjectURL(await bitmapToBlob(thumb));
      thumb.close();
      if (fallbackUrl.startsWith('blob:')) URL.revokeObjectURL(fallbackUrl);
      return url;
    } catch (error) {
      console.warn('[MediaImport] No se pudo generar la miniatura:', id, error);
      return fallbackUrl;
    }
  }

  /**
   * Writes an asset into the library when it is still the current attempt
   * (an asset removed or re-imported meanwhile keeps its newest state) and
   * notifies the UI.
   */
  private publish(asset: MediaAsset, revision: number, decoder: MediaDecoder | null = null): MediaAsset | null {
    if (this.revisions.get(asset.id) !== revision || !this.assets.has(asset.id)) {
      if (decoder && this.decoders.get(asset.id) !== decoder) decoder.close();
      return null;
    }
    if (decoder) {
      const previous = this.decoders.get(asset.id);
      if (previous && previous !== decoder) previous.close();
      this.decoders.set(asset.id, decoder);
    }
    this.assets.set(asset.id, asset);
    this.onMediaUpdated?.(asset);
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
      type: info.type,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      codec: info.videoCodec || info.audioCodec,
      fileSize: info.fileSize,
      status: 'ready',
      statusMessage: null,
      file,
    };
    // The relinked source wins over any probe still running for the old one.
    this.revisions.set(id, (this.revisionCounter += 1));
    this.inFlight.delete(id);
    this.assets.set(id, next);
    this.onMediaUpdated?.(next);
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
    if (asset.thumbnailUrl.startsWith('blob:')) URL.revokeObjectURL(asset.thumbnailUrl);
    this.decoders.get(id)?.close();
    this.decoders.delete(id);
    this.detachProxy(id);
    this.assets.delete(id);
    // A background probe still running for this id must not resurrect it.
    this.revisions.delete(id);
    this.inFlight.delete(id);
  }

  /** Frees every decoder, frame and URL. */
  destroy(): void {
    for (const id of [...this.assets.keys()]) this.removeMedia(id);
    this.inFlight.clear();
    this.revisions.clear();
  }
}

/** A bitmap as PNG bytes, for the library's `<img>` thumbnails. */
async function bitmapToBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
