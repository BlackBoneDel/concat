// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The Fase 4 media services behind the UI's {@link MediaTools}: proxies
 * (generation, OPFS persistence, playback toggle), LUT library and browser,
 * eyedropper, deep metadata, relinking, bulk/folder import and subtitle
 * import/export. Mirrors the media/speech/vision crates of the Rust editor
 * (`src/crates/concat-media`, `concat-speech`, `concat-effects`).
 *
 * Every failure is reported as a toast + console entry; nothing throws
 * into the UI.
 */

import type { EditSession } from '../session/edit-session.ts';
import type { MediaPool } from '../media/media-pool.ts';
import type { MediaInfo } from '../media/decoder.ts';
import type { MediaStore } from '../storage/media-store.ts';
import type { MediaItem } from '../model/document.ts';
import { MetadataExtractor, type DeepMetadata } from '../media/import/metadata-extractor.ts';
import {
  DEFAULT_PROXY_CONFIG,
  LOW_PROXY_CONFIG,
  ProxyGenerator,
  ProxyQueue,
  ProxyQuotaError,
  ProxyStore,
  type ProxyMetadata,
  type ProxyTranscoder,
} from '../media/proxy/index.ts';
import { MemoryProxyFiles, ProxyRecordStore, openProxyStorage } from '../storage/proxy-store.ts';
import { MemoryKeyValue } from '../storage/idb.ts';
import { HashValidator } from '../media/relink/hash-validator.ts';
import { FolderScanner } from '../media/relink/folder-scanner.ts';
import { HASH_KEY, Relinker, SIZE_KEY, type RelinkAssignment } from '../media/relink/relinker.ts';
import { LutLibrary } from '../media/vision/lut-library.ts';
import { LutParseError, loadCubeFile, type Lut3D } from '../media/vision/lut-loader.ts';
import { Eyedropper } from '../media/vision/eyedropper.ts';
import { VisionWorkerClient } from '../media/vision/vision-worker.ts';
import { emptyClipEffects } from '../media/clip-effects.ts';
import type { Rgb255 } from '../media/vision/color-space.ts';
import { loadSubtitleFile } from '../media/subtitles/subtitle-parser.ts';
import { buildSubtitleImport } from '../media/subtitles/subtitle-to-clips.ts';
import { SUBTITLE_KEY, clipsToSubtitles, toSRT, toVTT } from '../media/subtitles/subtitle-writer.ts';
import type { MediaTools, ProxyState } from '../ui/media-tools.ts';
import type { Notifications } from '../ui/notifications.ts';
import type { ProxyAssetInfo, ProxyModalSource } from '../ui/modals/index.ts';
// Fase 5: dialogs load on first use (their own chunks keep the main bundle small).
const loadLutBrowser = () => import('../ui/modals/lut-browser.ts');
const loadProxyModal = () => import('../ui/modals/proxy-modal.ts');
const loadRelinkModal = () => import('../ui/modals/relink-modal.ts');
const loadBulkImportModal = () => import('../ui/modals/bulk-import-modal.ts');

/** localStorage key of the proxy playback toggle. */
const PROXY_PREF_KEY = 'concat.useProxies';

/** What the toolkit needs from the app. */
export interface ToolkitHost {
  readonly session: EditSession;
  readonly pool: MediaPool;
  readonly mediaStore: MediaStore;
  readonly notifications: Notifications;
  /** The preview canvas (eyedropper). */
  previewCanvas(): HTMLCanvasElement | null;
  /** Imports one file into pool, OPFS and bin; returns the bin item. */
  importOne(file: File): Promise<MediaItem>;
  /** After a document edit: refresh panels, render, autosave. */
  afterEdit(): void;
  requestRender(): void;
}

/** Options of {@link MediaToolkit}. */
export interface MediaToolkitOptions {
  /** Proxy storage override (tests); real IndexedDB + OPFS otherwise. */
  proxyStore?: ProxyStore;
  /** FFmpeg transcoder for proxies when WebCodecs cannot encode. */
  transcoder?: ProxyTranscoder | null;
  /** Proxy runner override (tests). */
  generator?: ProxyGenerator;
  hasher?: HashValidator;
  scanner?: FolderScanner;
  relinker?: Relinker;
  extractor?: MetadataExtractor;
}

/** Downloads text as a file (ObjectURL revoked right after). */
export function downloadText(text: string, name: string, type: string): void {
  const blob = new Blob([text], { type });
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const revoke = typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL.bind(URL) : null;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been dispatched (the download holds its own copy).
  queueMicrotask(() => revoke?.(url));
}

/** Readable message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Fase 4 media services. */
export class MediaToolkit implements MediaTools {
  readonly luts = new LutLibrary();
  private readonly host: ToolkitHost;
  private store: ProxyStore;
  private generator: ProxyGenerator;
  private readonly transcoder: ProxyTranscoder | null;
  private readonly hasher: HashValidator;
  private readonly scanner: FolderScanner;
  private readonly relinker: Relinker;
  private readonly extractor: MetadataExtractor;
  private readonly eyedropper = new Eyedropper();
  private readonly vision = new VisionWorkerClient();
  private readonly listeners = new Set<() => void>();
  private offline = new Set<string>();
  private readonly customGenerator: boolean;

  /**
   * @param host app services.
   * @param options overrides.
   */
  constructor(host: ToolkitHost, options: MediaToolkitOptions = {}) {
    this.host = host;
    this.transcoder = options.transcoder ?? null;
    this.store = options.proxyStore ?? new ProxyStore(new ProxyRecordStore(new MemoryKeyValue()), new MemoryProxyFiles());
    this.customGenerator = options.generator !== undefined;
    this.generator = options.generator ?? this.makeGenerator(this.store);
    this.hasher = options.hasher ?? new HashValidator();
    this.scanner = options.scanner ?? new FolderScanner();
    this.relinker = options.relinker ?? new Relinker({ hasher: this.hasher });
    this.extractor = options.extractor ?? new MetadataExtractor();
    this.host.pool.setUseProxies(this.readPref());
    this.wireGenerator();
  }

  /**
   * Opens persistent proxy storage, drops orphans and re-attaches the
   * proxies of the restored library.
   */
  async init(): Promise<void> {
    if (!this.customGenerator) {
      try {
        const { records, files } = await openProxyStorage();
        this.store = new ProxyStore(records, files);
        this.generator = this.makeGenerator(this.store);
        this.wireGenerator();
      } catch (error) {
        console.warn('Almacenamiento de proxies no disponible; se usa memoria.', error);
      }
    }
    try {
      await this.store.cleanup(this.host.pool.listMedia().map((asset) => asset.id));
      for (const meta of await this.store.list()) await this.attach(meta);
    } catch (error) {
      console.warn('No se pudieron restaurar los proxies', error);
    }
    await this.refreshOffline();
  }

  // -- MediaTools: feedback, colour, LUTs -----------------------------------

  notify(kind: 'info' | 'success' | 'warning' | 'error', title: string, message?: string): void {
    if (kind === 'error') console.error(title, message ?? '');
    this.host.notifications[kind](title, message);
  }

  async pickColor(): Promise<Rgb255 | null> {
    const canvas = this.host.previewCanvas();
    const reader = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;
    if (!canvas || !reader) {
      this.notify('warning', 'Cuentagotas no disponible', 'La previsualización no está lista.');
      return null;
    }
    this.notify('info', 'Cuentagotas', 'Haz clic en la previsualización (Esc cancela).');
    return this.eyedropper.pick(canvas, reader);
  }

  browseLuts(currentId: string | null): Promise<Lut3D | null> {
    return loadLutBrowser().then(({ openLutBrowser }) => openLutBrowser({
      luts: this.luts.list(),
      currentId,
      importLut: (file) => this.importLut(file),
      render: (pixels, width, height, lut) => this.vision.process(pixels, width, height, { ...emptyClipEffects(), lut: { id: lut.id, strength: 1 } }, lut),
    }));
  }

  async importLut(file: File): Promise<Lut3D | null> {
    try {
      const lut = await loadCubeFile(file);
      this.luts.add(lut);
      this.notify('success', 'LUT cargada', `${lut.title || file.name} (${lut.size}³)`);
      return lut;
    } catch (error) {
      const where = error instanceof LutParseError && error.line !== null ? ` (línea ${error.line})` : '';
      this.notify('error', `LUT inválida${where}`, `${file.name}: ${describe(error)}`);
      return null;
    }
  }

  // -- MediaTools: proxies ---------------------------------------------------

  get proxiesEnabled(): boolean {
    return this.host.pool.proxiesEnabled;
  }

  toggleProxies(): void {
    const next = !this.host.pool.proxiesEnabled;
    this.host.pool.setUseProxies(next);
    try {
      localStorage.setItem(PROXY_PREF_KEY, next ? '1' : '0');
    } catch {
      // Private mode: the toggle still works for this session.
    }
    this.notify('info', next ? 'Proxies activados' : 'Proxies desactivados', next ? 'La previsualización usa las copias ligeras.' : 'La previsualización usa los originales.');
    this.emit();
    this.host.requestRender();
  }

  proxyState(mediaId: string): ProxyState {
    return { status: this.generator.statusOf(mediaId), progress: this.generator.progressOf(mediaId), error: this.generator.errorOf(mediaId) };
  }

  generateProxy(mediaId: string, quality: 'default' | 'low', priority: 'high' | 'normal' = 'high'): void {
    const asset = this.host.pool.get(mediaId);
    if (!asset || asset.type !== 'video') return;
    this.generator.generate({
      mediaId,
      sourceFile: asset.file,
      config: quality === 'low' ? LOW_PROXY_CONFIG : DEFAULT_PROXY_CONFIG,
      priority,
    }).catch(() => undefined); // reported through onError
    this.emit();
  }

  deleteProxy(mediaId: string): void {
    void (async () => {
      try {
        const status = this.generator.statusOf(mediaId);
        if (status === 'pending' || status === 'generating') await this.generator.cancel(mediaId);
        await this.store.delete(mediaId);
        this.host.pool.detachProxy(mediaId);
        this.generator.markNone(mediaId);
        this.emit();
        this.host.requestRender();
      } catch (error) {
        this.notify('error', 'No se pudo borrar el proxy', describe(error));
      }
    })();
  }

  openProxyManager(): void {
    void loadProxyModal()
      .then(({ openProxyModal }) => openProxyModal(this.proxySource()))
      .catch((error: unknown) => this.notify('error', 'Proxies', describe(error)));
  }

  async clearProxies(): Promise<void> {
    try {
      for (const asset of this.host.pool.listMedia()) {
        const status = this.generator.statusOf(asset.id);
        if (status === 'pending' || status === 'generating') await this.generator.cancel(asset.id);
      }
      const freed = await this.store.usage();
      await this.store.clear();
      for (const asset of this.host.pool.listMedia()) {
        this.host.pool.detachProxy(asset.id);
        this.generator.markNone(asset.id);
      }
      this.notify('success', 'Proxies borrados', `Se liberaron ${(freed / (1024 * 1024)).toFixed(1)} MB.`);
      this.emit();
      this.host.requestRender();
    } catch (error) {
      this.notify('error', 'No se pudieron borrar los proxies', describe(error));
    }
  }

  /**
   * Called after an import: queues a proxy when the policy asks for one.
   * @param mediaId the new asset.
   * @param info its probe.
   */
  autoProxy(mediaId: string, info: MediaInfo): void {
    if (this.generator.shouldGenerateProxy(info)) this.generateProxy(mediaId, 'default', 'normal');
  }

  // -- MediaTools: metadata, relink, import ------------------------------------

  async metadata(mediaId: string): Promise<DeepMetadata | null> {
    const asset = this.host.pool.get(mediaId);
    const blob = asset?.file ?? (await this.host.mediaStore.readFile(mediaId));
    if (!blob) return null;
    const name = asset?.name ?? mediaId;
    const file = blob instanceof File ? blob : new File([blob], name, { type: blob.type });
    try {
      return await this.extractor.extract(file, this.host.pool.getDecoder(mediaId)?.mediaInfo ?? null);
    } catch (error) {
      this.notify('error', 'Metadatos no disponibles', describe(error));
      return null;
    }
  }

  get offlineIds(): ReadonlySet<string> {
    return this.offline;
  }

  /** Recomputes which bin items lack their bytes. */
  async refreshOffline(): Promise<void> {
    const missing = await this.relinker.detectMissing(this.host.session.document, async (item) => this.host.pool.get(item.id) !== undefined);
    const next = new Set(missing.map((m) => m.item.id));
    const changed = next.size !== this.offline.size || [...next].some((id) => !this.offline.has(id));
    this.offline = next;
    if (changed) {
      if (next.size > 0) this.notify('warning', 'Medios sin conexión', `${next.size} medio(s) no están en el almacenamiento local. Usa «Medios sin conexión…» para volver a vincularlos.`);
      this.emit();
    }
  }

  openRelink(mediaId?: string): void {
    void (async () => {
      const all = await this.relinker.detectMissing(this.host.session.document, async (item) => this.host.pool.get(item.id) !== undefined);
      const missing = mediaId ? all.filter((m) => m.item.id === mediaId) : all;
      if (missing.length === 0 && mediaId) {
        this.notify('info', 'Medio disponible', 'Este medio ya está en el almacenamiento local.');
        return;
      }
      const { openRelinkModal } = await loadRelinkModal();
      await openRelinkModal({
        missing,
        relinker: this.relinker,
        scanner: this.scanner,
        apply: (assignments) => this.applyRelink(assignments),
        onError: (error) => this.notify('error', 'Error al volver a vincular', describe(error)),
      });
    })().catch((error: unknown) => this.notify('error', 'Error al volver a vincular', describe(error)));
  }

  /**
   * Copies relinked files into OPFS under the same ids, swaps the pool
   * sources and records the new file identity as one undoable edit (clip
   * edits are untouched).
   * @param assignments chosen files.
   */
  async applyRelink(assignments: readonly RelinkAssignment[]): Promise<void> {
    const hashes = new Map<string, string>();
    const done: RelinkAssignment[] = [];
    for (const assignment of assignments) {
      const { mediaId, file } = assignment;
      const item = this.host.session.document.media.find((m) => m.id === mediaId);
      const name = item?.name ?? file.name;
      try {
        if (this.host.pool.get(mediaId)) await this.host.pool.replaceSource(mediaId, file);
        else await this.host.pool.addMedia(file, mediaId, name);
        const info = this.host.pool.getDecoder(mediaId)?.mediaInfo;
        if (info) await this.host.mediaStore.importFile(file, info, mediaId, name);
        hashes.set(mediaId, await this.hasher.computeSHA256(file));
        done.push(assignment);
      } catch (error) {
        this.notify('error', 'No se pudo vincular', `${file.name}: ${describe(error)}`);
      }
    }
    if (done.length === 0) return;
    this.host.session.run(this.relinker.buildOperation(done, hashes));
    this.host.afterEdit();
    document.dispatchEvent(new CustomEvent('media-library-changed'));
    await this.refreshOffline();
    this.emit();
    this.notify('success', 'Medios vinculados', `${done.length} medio(s) vuelven a estar disponibles.`);
  }

  importFolder(): void {
    void loadBulkImportModal().then(({ openBulkImportModal }) => openBulkImportModal<MediaItem>({
      scanner: this.scanner,
      importOne: ({ file }) => this.host.importOne(file),
      classify: (item) => ({ kind: item.kind, width: item.width ?? 0, height: item.height ?? 0 }),
      onDone: (_groups, summary) => {
        document.dispatchEvent(new CustomEvent('media-library-changed'));
        this.host.afterEdit();
        const kind = summary.failed > 0 ? 'warning' : 'success';
        this.notify(kind, 'Importación terminada', `${summary.completed} importado(s)${summary.failed ? `, ${summary.failed} con error` : ''}${summary.cancelled ? ' (cancelada)' : ''}.`);
      },
    })).catch((error: unknown) => this.notify('error', 'Importar carpeta', describe(error)));
  }

  /**
   * Records size and SHA-256 on a bin item (outside the undo history, like
   * the import itself) so relinking can match by hash later.
   * @param mediaId the item.
   * @param file its bytes.
   */
  async fingerprint(mediaId: string, file: Blob): Promise<void> {
    const item = this.host.session.document.media.find((m) => m.id === mediaId);
    if (!item) return;
    item.extra[SIZE_KEY] = file.size;
    try {
      item.extra[HASH_KEY] = await this.hasher.computeSHA256(file);
    } catch (error) {
      console.warn('SHA-256 no disponible para', mediaId, error);
    }
    this.host.session.history.rebase(this.host.session.document);
  }

  // -- MediaTools: subtitles -----------------------------------------------------

  async importSubtitles(file: File): Promise<void> {
    try {
      const track = await loadSubtitleFile(file);
      if (track.cues.length === 0) {
        this.notify('error', 'Subtítulos vacíos', `${file.name}: no se encontró ningún cue válido.`);
        return;
      }
      const { operation, clipIds } = buildSubtitleImport(track.cues, { format: track.format, trackName: `Subtítulos (${file.name})` });
      if (!this.host.session.run(operation)) return;
      this.host.afterEdit();
      if (track.warnings.length > 0) {
        const first = track.warnings[0];
        this.notify('warning', `${track.warnings.length} aviso(s) en ${file.name}`, first ? `Línea ${first.line}: ${first.message}` : undefined);
        for (const warning of track.warnings) console.warn(`${file.name}:${warning.line}`, warning.message);
      }
      this.notify('success', 'Subtítulos importados', `${clipIds.length} cue(s) de ${file.name}.`);
    } catch (error) {
      this.notify('error', 'Error al importar subtítulos', `${file.name}: ${describe(error)}`);
    }
  }

  exportSubtitles(format: 'srt' | 'vtt'): void {
    const clips = this.host.session.document.timelines.flatMap((t) => t.clips);
    const onlySubtitles = clips.some((clip) => clip.kind === 'text' && clip.extra[SUBTITLE_KEY] !== undefined);
    const cues = clipsToSubtitles(clips, format, onlySubtitles);
    if (cues.length === 0) {
      this.notify('info', 'Nada que exportar', 'No hay clips de texto ni subtítulos en el proyecto.');
      return;
    }
    const base = (this.host.session.name || 'subtitulos').replace(/[\\/:*?"<>|]+/g, '_');
    if (format === 'srt') downloadText(toSRT(cues, 'srt'), `${base}.srt`, 'application/x-subrip');
    else downloadText(toVTT(cues, {}, 'vtt'), `${base}.vtt`, 'text/vtt');
    this.notify('success', 'Subtítulos exportados', `${cues.length} cue(s) en ${format.toUpperCase()}.`);
  }

  // -- events ------------------------------------------------------------------

  /**
   * Subscribes to proxy/offline changes.
   * @param listener callback.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cancels pending picks and drops listeners (workers idle out on their own). */
  dispose(): void {
    this.eyedropper.cancel();
    this.listeners.clear();
  }

  // -- internals -----------------------------------------------------------------

  private makeGenerator(store: ProxyStore): ProxyGenerator {
    return new ProxyGenerator(store, new ProxyQueue(2), { transcoder: this.transcoder });
  }

  private wireGenerator(): void {
    const generator = this.generator;
    generator.onStatusChange = () => this.emit();
    generator.onProgress = () => this.emit();
    generator.onComplete = (mediaId, meta) => {
      void this.attach(meta).then(() => {
        const asset = this.host.pool.get(mediaId);
        this.notify('success', 'Proxy listo', asset ? asset.name : mediaId);
        this.host.requestRender();
      });
    };
    generator.onError = (mediaId, error) => {
      const asset = this.host.pool.get(mediaId);
      const quota = error instanceof ProxyQuotaError || error.name === 'QuotaExceededError';
      if (quota) {
        this.notify('warning', 'Almacenamiento lleno', 'No hay espacio para más proxies.');
        void this.host.notifications.confirm('Almacenamiento lleno', 'Se puede liberar espacio borrando todos los proxies (los originales no se tocan).', 'Borrar proxies')
          .then((ok) => (ok ? this.clearProxies() : undefined));
      } else {
        this.notify('error', 'Error al generar el proxy', `${asset?.name ?? mediaId}: ${error.message}`);
      }
      this.emit();
    };
  }

  private async attach(meta: ProxyMetadata): Promise<void> {
    if (!this.host.pool.get(meta.mediaId)) return;
    const blob = await this.store.load(meta.mediaId);
    if (!blob) return;
    if (this.host.pool.attachProxy(meta.mediaId, blob, meta.resolution)) this.generator.markReady(meta.mediaId);
    this.emit();
  }

  private proxySource(): ProxyModalSource {
    return {
      assets: (): ProxyAssetInfo[] => this.host.pool.listMedia()
        .filter((asset) => asset.type === 'video')
        .map((asset) => {
          const info = this.host.pool.getDecoder(asset.id)?.mediaInfo;
          return { id: asset.id, name: asset.name, width: asset.width, height: asset.height, recommended: info ? this.generator.shouldGenerateProxy(info) : false };
        }),
      state: (id) => this.proxyState(id),
      generate: (id, quality) => this.generateProxy(id, quality),
      remove: (id) => this.deleteProxy(id),
      clearAll: () => this.clearProxies(),
      usage: async () => ({ bytes: await this.store.usage(), limit: this.store.limit }),
      subscribe: (listener) => this.subscribe(listener),
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('media-proxy-changed'));
  }

  private readPref(): boolean {
    try {
      return localStorage.getItem(PROXY_PREF_KEY) !== '0';
    } catch {
      return true;
    }
  }
}
