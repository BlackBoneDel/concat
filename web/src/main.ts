// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The application: wires session, media pool, player, storage and the shell
 * together, and owns the app-level flows (import, save/open, autosave,
 * shortcuts). Everything runs against local storage — no network, no
 * telemetry.
 *
 * Fase 4 wiring: FFmpeg fallback for the pool, proxies, audio effects
 * resolver (+ gate worklet), vision pipeline (keying, grading, LUTs),
 * bulk import with fingerprints, relinking and subtitles — all through the
 * {@link MediaToolkit} registered as the UI's media tools.
 *
 * Fase 6 wiring: offline export (Ctrl+E, I/O marks), the shortcut sheet
 * (`?`), storage manager, project packages and the installable PWA — all
 * through `app/production.ts`, every dialog loaded on demand.
 */

import { Rational } from './core/rational.ts';
import { FrameRate } from './core/time.ts';
import type { MediaItem } from './model/document.ts';
import { createProjectDocument } from './model/document.ts';
import { MediaPool } from './media/media-pool.ts';
import { PreviewPlayer } from './player/player.ts';
import type { RenderContext2D, RenderTarget } from './render/types.ts';
import { EditSession } from './session/edit-session.ts';
import { generateWaveformMultiRes, WAVEFORM_RESOLUTIONS } from './media/waveform-generator.ts';
import { History } from './session/history.ts';
import { MediaStore } from './storage/media-store.ts';
import { ProjectStore } from './storage/project-store.ts';
import { MemoryKeyValue, MEDIA_DB_STORES, MEDIA_DB_VERSION, openKeyValue } from './storage/idb.ts';
import { KeyValueThumbnailStripStore } from './media/thumbnail-strip.ts';
import { loadSettings, saveSettings as persistSettings, type UserSettings } from './storage/settings-store.ts';
import { FFmpegFallback } from './media/ffmpeg/ffmpeg-fallback.ts';
import { BulkImporter } from './media/import/bulk-importer.ts';
import { AudioProcessor } from './media/audio/audio-processor.ts';
import { ensureGateWorklet } from './media/audio/noise-gate.ts';
import { setDefaultAudioFxResolver } from './player/audio-mixer.ts';
import { VisionPipeline, setVisionHook } from './render/vision-pipeline.ts';
import { MediaToolkit } from './app/media-toolkit.ts';
import { EffectsCache, createAudioFxResolver, createVisionResolver } from './app/effect-resolvers.ts';
import { setMediaTools } from './ui/media-tools.ts';
import { PROXY_TOGGLE_SHORTCUT } from './ui/header-bar.ts';
// Fase 5: effect stacks, advanced titling, custom fonts, presets, VU meter.
import { createTextEngineHook, createVideoEffectsHook, withAudioStack } from './app/effect-resolvers.ts';
import { projectFonts } from './editor/text-operations.ts';
import type { EditOperation } from './editor/operations.ts';
import { ReverbIrProvider } from './media/effects/reverb-ir-generator.ts';
import { addMasterTap } from './player/audio-mixer.ts';
import { PresetManager, PRESETS_DB_NAME, PRESETS_DB_VERSION, USER_PRESETS_STORE } from './presets/preset-manager.ts';
import { FontLoader } from './render/font-loader.ts';
import { setTextEngineHook } from './render/text-engine.ts';
import type { VideoEffectsEngine } from './render/video-effects-engine.ts';
import { setVideoEffectsHook } from './render/video-effects-hook.ts';
import { FontStore } from './storage/font-store.ts';
import { IndexedDbKeyValue } from './storage/idb.ts';
import { VuMeterStereo } from './ui/components/vu-meter-stereo.ts';
import { setStudioServices } from './ui/studio-services.ts';
// Fase 6: export, PWA, storage manager, project packages.
import { createProductionServices } from './app/production.ts';
import { InstallPrompt } from './pwa/install-prompt.ts';
import { registerServiceWorker } from './pwa/sw-register.ts';
import { setProductionServices } from './ui/production-services.ts';
import { actionToast } from './ui/action-toast.ts';
import { EXPORT_SHORTCUT } from './ui/header-bar.ts';
import { isTypingTarget } from './ui/interactions/keyboard-shortcuts.ts';
import { parseCube, toCube } from './media/vision/lut-loader.ts';
import { fontFileName, OpfsFontFiles } from './storage/font-store.ts';
import { openProxyStorage } from './storage/proxy-store.ts';
import { waveformCache } from './media/waveform-generator.ts';
// Fase 7+: timeline drop capture and the ?debug=1 diagnostics panel.
import { installDropGuard, installFileDrop } from './ui/timeline/file-drop.ts';
// Fase 9: the app-wide capture of dropped OS files and the persistent picker.
import { installGlobalDrop, type GlobalDropHandle } from './ui/global-drop.ts';
import { installGlobalFileInput } from './ui/global-file-input.ts';
import { planImport } from './media/media-pool.ts';
import { trackKindOf } from './editor/operations.ts';
import { mountDebugPanel } from './ui/debug-panel.ts';
import { formatEta } from './export/bitrate-estimator.ts';
import type { OpenedPackage } from './storage/project-package.ts';
import type { StorageCategory } from './ui/modals/storage-manager-modal.ts';
import {
  HeaderBar,
  InspectorPanel,
  KeyboardShortcuts,
  MediaPanel,
  Notifications,
  PreviewPanel,
  ThemeManager,
  TimelinePanel,
  createEditorLayout,
  type AppContext,
} from './ui/index.ts';

/** A render target that finds its canvas once the panel has built it. */
class CanvasRef implements RenderTarget {
  private canvas: HTMLCanvasElement | null = null;

  /** Points the ref at the real canvas. */
  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  get width(): number {
    return this.canvas?.width ?? 640;
  }

  get height(): number {
    return this.canvas?.height ?? 360;
  }

  getContext(type: '2d'): RenderContext2D | null {
    return this.canvas?.getContext(type) ?? null;
  }

  /** Fase 4: the real canvas (eyedropper). */
  get element(): HTMLCanvasElement | null {
    return this.canvas;
  }
}

/** Fase 6: the storage manager source without its UI callbacks. */
type ProductionStorage = Omit<import('./ui/modals/storage-manager-modal.ts').StorageManagerSource, 'confirm' | 'notify'>;

/** Subtitle files routed to the subtitle importer. */
const SUBTITLE_FILE = /\.(srt|vtt)$/i;

/** Where an OS file dropped on the timeline wants its clip. */
export interface ImportPlacement {
  /** Seconds into the timeline. */
  time: number;
  /** The lane under the pointer, when there was one. */
  trackId: string | null;
}

/** Options of {@link EditorApp.importFiles}. */
export interface ImportFilesOptions {
  /** Set when the files were dropped on the timeline: insert them there. */
  place?: ImportPlacement | null;
}

/** The editor application. */
class EditorApp implements AppContext {
  session = new EditSession();
  editSession: EditSession = this.session;
  player: PreviewPlayer;
  /** Fase 4: lazy FFmpeg (never loaded unless WebCodecs fails). */
  readonly ffmpeg = new FFmpegFallback();
  pool = new MediaPool({ fallback: this.ffmpeg });
  /** Fase 4: proxies, LUTs, relink, subtitles, bulk import. */
  readonly media: MediaToolkit;
  private readonly effectsCache = new EffectsCache();
  private audioProcessor: AudioProcessor | null = null;
  /** Fase 5: project fonts (OPFS `/fonts/`) and their FontFace registration. */
  private readonly fontStore = new FontStore();
  private readonly fontLoader = new FontLoader(this.fontStore);
  /** Fase 5: reverb tails, synthesised in a worker and cached. */
  private readonly reverbIrs = new ReverbIrProvider();
  private videoEffects: VideoEffectsEngine | null = null;
  private vuMeter: VuMeterStereo | null = null;
  /** Fase 5: presets in `ConcatProjectDB.user_presets`. */
  presets = new PresetManager(new MemoryKeyValue());
  mediaStore: MediaStore;
  projectStore: ProjectStore;
  history = new History();
  notifications: Notifications;
  theme: ThemeManager;
  shortcuts = new KeyboardShortcuts();
  settings: UserSettings = loadSettings();
  projectId: string | null = null;
  selectedClipId: string | null = null;

  private readonly canvasRef = new CanvasRef();
  private header: HeaderBar | null = null;
  private timelinePanel: TimelinePanel | null = null;
  private mediaPanel: MediaPanel | null = null;
  private inspectorPanel: InspectorPanel | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fase 6: the browser's install offer. */
  private readonly installPrompt = new InstallPrompt();
  /** Fase 6: the I/O range badge in the header. */
  private rangeBadge: HTMLElement | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  /** Fase 9: the window-wide capture of dropped OS files. */
  private globalDrop: GlobalDropHandle | null = null;

  constructor() {
    this.mediaStore = new MediaStore(new MemoryKeyValue());
    this.projectStore = new ProjectStore(new MemoryKeyValue());
    this.notifications = new Notifications(document.createElement('div'));
    this.theme = new ThemeManager(document.documentElement);
    this.player = new PreviewPlayer({
      canvas: this.canvasRef,
      session: this.session,
      mediaPool: this.pool,
      audioContext: null,
    });
    this.media = new MediaToolkit(this, { transcoder: this.ffmpeg });
  }

  /** Boots the shell and the services. */
  async start(): Promise<void> {
    // Theme + notifications.
    this.theme.apply(this.settings.theme);
    const toastStack = document.createElement('div');
    toastStack.id = 'toast-stack';
    document.body.appendChild(toastStack);
    this.notifications = new Notifications(toastStack);
    this.notifications.setEnabled(this.settings.showTooltips);
    this.session.onError = (message, error) => {
      console.error(message, error);
      this.notifications.error('Operación inválida', message);
    };

    // Storage backends (real IndexedDB + OPFS when available).
    // Fase 7+: one connection with the full v3 schema (files + waveforms) —
    // opening `files` alone left the waveforms store uncreated and every
    // waveform read/write died with NotFoundError.
    const mediaBackend = await openKeyValue('ConcatMediaDB', [...MEDIA_DB_STORES], MEDIA_DB_VERSION);
    this.mediaStore = new MediaStore(mediaBackend);
    // Fase 8: the filmstrips persist in the same v4 schema.
    this.pool.useStripStore(new KeyValueThumbnailStripStore(mediaBackend));
    // Fase 5: one v3 connection (projects + user_presets) shared by both
    // stores — a second connection at another version would block.
    const projectBackend =
      (await IndexedDbKeyValue.open(PRESETS_DB_NAME, PRESETS_DB_VERSION, ['projects', USER_PRESETS_STORE])) ?? new MemoryKeyValue();
    this.projectStore = new ProjectStore(projectBackend);
    this.presets = new PresetManager(projectBackend);

    // Audio: a live context (starts suspended until the first play).
    let audioContext: AudioContext | null = null;
    try {
      audioContext = new AudioContext();
    } catch {
      audioContext = null;
    }
    this.player = new PreviewPlayer({
      canvas: this.canvasRef,
      session: this.session,
      mediaPool: this.pool,
      audioContext,
    });
    // Fase 7 hook (QA): a media file that dies mid-playback shows a red card
    // in the preview plus one actionable toast — the rAF loop keeps going.
    this.player.onRenderError = (error, mediaId) => {
      console.warn('Error de previsualización', mediaId, error);
      if (mediaId === null) {
        this.notifications.warning('Error de previsualización', error instanceof Error ? error.message : String(error));
        return;
      }
      const name = this.session.document.media.find((item) => item.id === mediaId)?.name ?? mediaId;
      actionToast(this.notifications, {
        type: 'warning',
        title: 'Medio no disponible',
        message: `${name} no se puede decodificar. Se muestra «Media Missing» en su lugar.`,
        actionLabel: 'Volver a vincular',
        onAction: () => {
          this.player.clearMediaErrors();
          this.media.openRelink(mediaId);
        },
        duration: 12_000,
      });
    };

    // The shell.
    const root = document.getElementById('app');
    if (!root) throw new Error('#app missing');
    const layout = createEditorLayout(root, this);
    this.header = new HeaderBar(layout.header, this);
    this.mediaPanel = new MediaPanel(layout.mediaPanel, this);
    const preview = new PreviewPanel(layout.previewPanel, this);
    this.canvasRef.attach(preview.renderCanvas);
    this.timelinePanel = new TimelinePanel(layout.timelinePanel, this);
    this.inspectorPanel = new InspectorPanel(layout.inspectorPanel, this);

    // Fase 9: the library card appears the instant the pool registers the
    // asset, not when its probe lands (the "no pasa nada al soltar el MP4").
    this.pool.setImportListeners({
      onMediaAdded: () => document.dispatchEvent(new CustomEvent('media-library-changed')),
      onMediaUpdated: () => document.dispatchEvent(new CustomEvent('media-library-changed')),
    });

    // Fase 7+: OS file drops on the timeline import into the library and land
    // on the lane under the pointer.
    installFileDrop(layout.timelinePanel, {
      onFiles: (files, point) => {
        const target = this.timelinePanel?.dropTargetAt(point.x, point.y) ?? null;
        void this.importFiles(files, { place: target });
      },
    });
    // Fase 9: the last line of defence. A file let go of anywhere else —
    // header, preview, empty workspace, the body — imports too, and the
    // browser never navigates to the raw file. `installDropGuard` is kept so
    // the older structural tests keep watching the same invariant.
    installDropGuard();
    this.globalDrop = installGlobalDrop({
      onFiles: (files) => void this.importFiles(files),
    });
    // Fase 9: one persistent picker in the DOM for every import affordance.
    installGlobalFileInput({
      onFiles: (files) => void this.importFiles(files),
    });
    // Fase 7+: `?debug=1` mounts the diagnostics panel (engine, codecs,
    // OPFS/IndexedDB, service worker caches) for import troubleshooting.
    void mountDebugPanel(document.body);

    // Fase 4: media tools, effect hooks.
    setMediaTools(this.media);
    this.header.syncProxyToggle();
    this.installEffectHooks(audioContext);
    this.installStudio(layout.header);
    this.installProduction(layout.header);

    // Shortcuts.
    this.wireShortcuts();
    this.shortcuts.setEnabled(true);

    // App-level events.
    document.addEventListener('open-import', () => this.mediaPanel?.openPicker());
    document.addEventListener('session-reset', () => {
      this.session.name = 'Untitled';
      this.session.loadDocument(createProjectDocument());
      this.projectId = null;
      this.selectedClipId = null;
      this.refreshAll();
    });
    document.addEventListener('timeline-changed', () => {
      this.timelinePanel?.refresh();
      this.inspectorPanel?.refresh();
    });
    document.addEventListener('selection-changed', () => {
      this.inspectorPanel?.refresh();
    });
    document.addEventListener('preview-quality-changed', () => {
      this.requestRender();
    });

    // Autosave on the configured interval.
    this.armAutosave();

    // Restore the media library from OPFS.
    await this.restoreMediaLibrary();
    // Fase 4: proxies (orphan cleanup + re-attach) and offline detection.
    void this.media.init();

    // OPFS status line.
    if (!(await this.mediaStore.hasOpfs())) {
      this.notifications.warning(
        'Almacenamiento limitado',
        'Este navegador no permite OPFS: los archivos se conservarán solo durante esta sesión.',
      );
    }

    this.refreshAll();
    void this.player.renderOnce();
  }

  // -- AppContext ----------------------------------------------------------

  /**
   * Imports dropped/picked files.
   *
   * Every route into the app (the Import button, Archivo → Importar medios,
   * Ctrl+I, an OS drop anywhere) ends up here, so the validation, the toasts
   * and the logs are the same for all of them. Files the browser cannot use
   * are refused with a toast *before* any work starts — no phantom card with
   * a 0-second duration.
   * @param files the files.
   * @param options `place` inserts what was imported on the timeline (an OS
   * file dropped on the timeline).
   */
  async importFiles(files: File[], options: ImportFilesOptions = {}): Promise<void> {
    console.info(`[MediaImport] received ${files.length}`);
    // Fase 4: subtitles go to their own importer; media through the
    // BulkImporter (2 in parallel, per-file errors never stop the batch).
    const subtitles = files.filter((f) => SUBTITLE_FILE.test(f.name));
    for (const file of subtitles) await this.media.importSubtitles(file);

    const candidates = files.filter((f) => !SUBTITLE_FILE.test(f.name));
    const media: File[] = [];
    for (const file of candidates) {
      const plan = planImport(file);
      if (plan.ok) {
        media.push(file);
        continue;
      }
      // Empty and non-media files never reach the pool: no ghost asset, and
      // the user is told why.
      console.warn(`[MediaImport] error ${file.name}: ${plan.message}`);
      if (plan.code === 'unsupported') this.notifications.warning('Formato no compatible', `${file.name} no es un archivo de vídeo, audio o imagen.`);
      else this.notifications.warning('El archivo está vacío', `${file.name} no tiene contenido.`);
    }

    const imported: MediaItem[] = [];
    if (media.length > 0) {
      const importer = new BulkImporter<MediaItem>((source) => this.importOne(source.file), { concurrency: 2 });
      for await (const event of importer.run(media)) {
        if (event.type === 'complete') {
          imported.push(event.result);
          console.info(`[MediaImport] ok ${event.result.name}`);
          this.notifications.success('Medio importado', event.result.name);
        } else if (event.type === 'error') {
          console.warn(`[MediaImport] error ${event.name}: ${event.error}`);
          this.notifications.error('Error al importar', `${event.name}: ${event.error}`);
        }
      }
    }
    if (options.place && imported.length > 0) this.placeOnTimeline(imported, options.place);
    document.dispatchEvent(new CustomEvent('media-library-changed'));
    this.requestAutosave();
  }

  /**
   * Fase 9: puts just-imported media on the timeline — what an OS file
   * dropped *on* the timeline means. The lane under the pointer wins when it
   * fits; otherwise a lane of the right kind is reused, or created.
   * @param items the imported bin entries.
   * @param target where the drop landed.
   */
  private placeOnTimeline(items: MediaItem[], target: ImportPlacement): void {
    const session = this.session;
    let at = Math.max(0, target.time);
    for (const item of items) {
      const kind: 'video' | 'audio' = item.kind === 'audio' ? 'audio' : 'video';
      const trackId = this.resolveTrackFor(kind, target.trackId);
      if (trackId === null) {
        this.notifications.error('No se pudo añadir el clip', 'El timeline no tiene pistas disponibles.');
        return;
      }
      try {
        const clipId = session.insertClipFromMedia(item.id, trackId, Rational.approximate(at) ?? Rational.ZERO, 'overwrite', {
          durationSeconds: item.duration && item.duration > 0 ? item.duration : 5,
          kind,
          name: item.name,
        });
        this.history.push(session.document, session.documentSettings());
        this.selectedClipId = clipId;
        at += Math.max(0.1, item.duration ?? 0);
      } catch (error) {
        this.reportError('No se pudo añadir el clip', error);
        return;
      }
    }
    this.refreshAll();
    this.requestRender();
    document.dispatchEvent(new CustomEvent('timeline-changed'));
  }

  /**
   * Picks the lane a clip of `kind` should land on: the one under the
   * pointer when it accepts it, the first lane of that kind, or a new one.
   * @param kind what the clip needs.
   * @param preferred the lane under the pointer, if any.
   * @returns the lane id, or `null` when one could not be made.
   */
  private resolveTrackFor(kind: 'video' | 'audio', preferred: string | null): string | null {
    const session = this.session;
    const tracks = session.timeline.tracks;
    const fits = (trackId: string): boolean => {
      const track = tracks.find((candidate) => candidate.id === trackId);
      return track !== undefined && trackKindOf(session.document, track) === kind;
    };
    if (preferred !== null && fits(preferred)) return preferred;
    const existing = tracks.find((track) => trackKindOf(session.document, track) === kind);
    if (existing) return existing.id;
    return session.addTrack(kind, session.timeline.tracks.length);
  }

  /**
   * Imports one file: pool, OPFS, bin item, waveforms, fingerprint and the
   * automatic proxy policy (Fase 4).
   *
   * The pool registers the asset (and the library card) synchronously; this
   * method then waits — with a hard budget inside the pool — for the probe,
   * because the durable copy in OPFS is keyed to the probed metadata. A file
   * whose probe failed still lands in the bin: `duration` falls back to a
   * usable default so it can be dropped on the timeline.
   * @param file the local file.
   * @returns the new bin item.
   */
  async importOne(file: File): Promise<MediaItem> {
    const id = crypto.randomUUID();
    await this.pool.addMedia(file, id, file.name);
    const asset = (await this.pool.whenReady(id)) ?? this.pool.getAsset(id);
    if (!asset) throw new Error('El archivo no se pudo registrar en la biblioteca');
    const info = this.pool.getDecoder(id)?.mediaInfo;
    if (info && asset.status !== 'error') await this.mediaStore.importFile(file, info, id, file.name);
    const item = this.toMediaItem(asset.id, asset.name, asset);
    this.session.addMediaItem(item);
    if (asset.thumbnailUrl !== '') this.refreshAll();
    void this.generateWaveforms(file, asset.id);
    // Fase 8: the timeline filmstrip of the new media builds in the background.
    if (asset.type !== 'audio' && asset.status !== 'error') void this.pool.ensureThumbnailStrip(asset.id);
    void this.media.fingerprint(id, file);
    if (info) this.media.autoProxy(id, info);
    return item;
  }

  /** Fase 4 {@link ToolkitHost}: the preview canvas. */
  previewCanvas(): HTMLCanvasElement | null {
    return this.canvasRef.element;
  }

  /** Fase 4 {@link ToolkitHost}: refresh after a toolkit edit. */
  afterEdit(): void {
    this.refreshAll();
    this.requestRender();
    this.requestAutosave();
    document.dispatchEvent(new CustomEvent('timeline-changed'));
  }

  async saveProject(): Promise<void> {
    try {
      const record = await this.projectStore.saveProject(
        this.session.document,
        this.session.documentSettings(),
        this.projectId ?? undefined,
      );
      this.projectId = record.id;
      this.session.dirty = false;
      this.header?.markSaved();
    } catch (error) {
      this.notifications.error('Error al guardar', describe(error));
    }
  }

  async openProject(id: string): Promise<void> {
    const loaded = await this.projectStore.loadProject(id);
    if (!loaded) {
      this.notifications.error('Error al cargar', 'El proyecto no existe o está dañado.');
      return;
    }
    this.history.clear();
    this.session.name = loaded.name;
    this.session.loadDocument(loaded.document);
    this.projectId = id;
    this.selectedClipId = null;
    this.refreshAll();
    this.requestRender();
    void this.media.refreshOffline();
    this.notifications.success('Proyecto abierto', loaded.name);
  }

  addMediaToTimeline(mediaId: string): void {
    const session = this.session;
    const timeline = session.timeline;
    const target =
      timeline.tracks.find((track) => track.extra['kind'] === 'video') ??
      timeline.tracks[0];
    if (!target) return;
    this.history.push(this.session.document, this.session.documentSettings());
    const clip = session.makeClip(mediaId, target.id, this.player.currentTime.asNumber());
    session.insertClip(clip, 'insert');
    session.selection.selectClips([clip.id], false, session.document);
    this.selectedClipId = clip.id;
    this.refreshAll();
    this.requestRender();
    this.requestAutosave();
    document.dispatchEvent(new CustomEvent('selection-changed'));
    document.dispatchEvent(new CustomEvent('timeline-changed'));
  }

  selectClip(docClipId: string | null): void {
    this.selectedClipId = docClipId;
    document.dispatchEvent(new CustomEvent('selection-changed'));
  }

  requestRender(): void {
    if (this.renderTimer !== null) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.player.renderOnce();
    }, 16);
  }

  requestAutosave(): void {
    // Autosave fires on the interval; the flag marks the document dirty.
    this.session.dirty = true;
    this.header?.sync();
  }

  saveSettings(): void {
    persistSettings(this.settings);
  }

  /** Generates + caches the audio waveforms of a fresh import. */
  private async generateWaveforms(file: File | Blob, mediaId: string): Promise<void> {
    try {
      let audioContext: AudioContext | null = null;
      try {
        audioContext = new AudioContext();
      } catch {
        audioContext = null;
      }
      if (!audioContext) return;
      const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
      await generateWaveformMultiRes(buffer, [...WAVEFORM_RESOLUTIONS], mediaId);
      void audioContext.close();
    } catch (error) {
      console.warn('Waveform no disponible para', mediaId, error);
    }
  }

  // -- internals -----------------------------------------------------------

  /**
   * Fase 4: audio effects resolver (+ noise-gate worklet) and the vision
   * pipeline, both reading `clip.extra.effects`.
   */
  private installEffectHooks(audioContext: AudioContext | null): void {
    const reschedule = (): void => {
      if (this.player.isPlaying) this.player.seekTo(this.player.currentTime);
      else this.requestRender();
    };
    const processor = new AudioProcessor();
    processor.onVariantReady = reschedule;
    this.audioProcessor = processor;
    const fx = createAudioFxResolver({
      processor,
      getDocument: () => this.session.document,
      cache: this.effectsCache,
      onMeasured: reschedule,
      onError: (error) => console.warn('Medición de sonoridad fallida', error),
    });
    // Fase 5: the clip's audio stack (delay/reverb/chorus) in series after F4.
    setDefaultAudioFxResolver(withAudioStack(fx, {
      getDocument: () => this.session.document,
      cache: this.effectsCache,
      irs: this.reverbIrs,
      onError: (error) => this.reportError('Efecto de audio', error),
    }));
    if (audioContext) {
      void ensureGateWorklet(audioContext).catch((error: unknown) => console.warn('Puerta de ruido sin AudioWorklet', error));
    }
    setVisionHook(new VisionPipeline(createVisionResolver(() => this.session.document, this.effectsCache), {
      resolveLut: (id) => this.media.luts.get(id),
      onError: (error) => this.media.notify('error', 'Efecto de vídeo', error.message),
    }));
    this.media.luts.onChange(() => this.requestRender());
  }

  /**
   * Fase 5: video effect stack + titling hooks, custom fonts, the master VU
   * meter and the UI services (presets, font manager, curve preview).
   * @param header the header bar root (hosts the VU meter).
   */
  private installStudio(header: HTMLElement): void {
    // The engine (shaders + CPU kernels) loads in its own chunk; until it
    // arrives frames render without the stack, exactly as in Fase 4.
    void import('./render/video-effects-engine.ts')
      .then(({ VideoEffectsEngine: Engine }) => {
        this.videoEffects = new Engine();
        setVideoEffectsHook(createVideoEffectsHook(() => this.session.document, this.videoEffects, this.effectsCache));
        this.requestRender();
      })
      .catch((error: unknown) => this.reportError('Efectos de vídeo', error));
    setTextEngineHook(createTextEngineHook(() => this.session.document, this.fontLoader));
    this.fontLoader.onLoad(() => this.requestRender());
    this.presets.onChange(() => this.inspectorPanel?.refresh());

    this.vuMeter = new VuMeterStereo({ addMasterTap: (tap) => addMasterTap(tap) });
    const actions = header.querySelector('.header-actions');
    (actions ?? header).appendChild(this.vuMeter.element);

    setStudioServices({
      presets: this.presets,
      openFontManager: () => {
        void import('./ui/components/font-manager-modal.ts')
          .then(({ openFontManager }) =>
            openFontManager({
              getDocument: () => this.session.document,
              run: (op) => this.runStudioOp(op),
              store: this.fontStore,
              loader: this.fontLoader,
              onError: (error) => this.reportError('Fuentes', error),
            }),
          )
          .catch((error: unknown) => this.reportError('Fuentes', error));
      },
      previewKeyframeCurve: (clipId, ref, curve) => this.timelinePanel?.previewKeyframeCurve(clipId, ref, curve),
      reportError: (title, error) => this.reportError(title, error),
    });

    window.addEventListener('pagehide', () => {
      this.vuMeter?.dispose();
      this.videoEffects?.dispose();
      this.reverbIrs.dispose();
    }, { once: true });
  }

  /**
   * Fase 6: export, in/out marks, shortcut sheet, storage manager, project
   * packages and the PWA.
   * @param header the header bar root (hosts the range badge).
   */
  private installProduction(header: HTMLElement): void {
    const previousChanged = this.session.onChanged;
    this.session.onChanged = () => {
      previousChanged();
      document.dispatchEvent(new CustomEvent('session-changed'));
    };
    const badge = document.createElement('button');
    badge.type = 'button';
    this.rangeBadge = badge;
    this.rangeBadge.className = 'btn btn-ghost btn-small range-badge';
    this.rangeBadge.hidden = true;
    this.rangeBadge.title = 'Rango de exportación (I / O). Pulsa para borrarlo (Alt+X).';
    this.rangeBadge.addEventListener('click', () => this.session.clearExportRange());
    const actions = header.querySelector('.header-actions');
    (actions ?? header).insertBefore(this.rangeBadge, header.querySelector('.header-export'));
    this.session.onExportRangeChange = () => this.syncRangeBadge();

    const services = createProductionServices({
      getDocument: () => this.session.document,
      documentSettings: () => this.session.documentSettings(),
      projectName: () => this.session.name,
      timelineSeconds: () => this.session.duration().asNumber(),
      clipCount: () => this.session.clips().length,
      markedRange: () => (this.session.inPoint || this.session.outPoint ? this.session.exportRange() : null),
      sequence: () => ({ width: this.session.video.width, height: this.session.video.height, fps: this.session.frameRate.fps().asNumber() }),
      media: {
        exportFrames: (allowProxy) => this.pool.exportFrames(allowProxy),
        hasOriginal: (id) => this.pool.hasOriginal(id),
        hasProxy: (id) => this.pool.hasProxy(id),
        forceOriginalQuality: (enabled) => this.pool.forceOriginalQuality(enabled),
        getAudioBuffer: (id) => this.pool.getAudioBuffer(id),
      },
      ffmpeg: () => (typeof WebAssembly === 'object' && typeof Worker !== 'undefined' && !this.ffmpeg.unavailable ? this.ffmpeg : null),
      assets: {
        readMedia: (id) => this.mediaStore.readFile(id),
        readFont: async (font) => {
          const bytes = await this.fontStore.read(font);
          return bytes ? new Blob([bytes]) : null;
        },
        lutCube: (id) => {
          const lut = this.media.luts.sessionLuts().find((item) => item.id === id);
          return lut ? toCube(lut) : null;
        },
      },
      installPackage: (opened) => this.installPackage(opened),
      storage: this.storageSource(),
      install: this.installPrompt,
      notify: (kind, title, message) => this.notifications[kind](title, message),
      confirm: (title, message, label) => this.notifications.confirm(title, message, label),
      beforeExport: () => {
        if (this.player.isPlaying) this.player.pause();
      },
    });
    setProductionServices(services);
    document.dispatchEvent(new CustomEvent('production-ready'));
    this.installPrompt.onChange(() => {
      if (this.installPrompt.canInstall) {
        actionToast(this.notifications, {
          type: 'info',
          title: 'Instala Concat',
          message: 'Úsalo como aplicación, también sin conexión.',
          actionLabel: 'Instalar',
          onAction: () => services.install(),
          duration: 10_000,
        });
      }
    });

    // Shortcuts (ignored while typing; never while a dialog is open).
    const free = (event: KeyboardEvent): boolean => !isTypingTarget(event.target) && document.querySelector('.modal-backdrop') === null;
    this.shortcuts.bind(EXPORT_SHORTCUT, (event) => {
      if (!isTypingTarget(event.target)) services.openExport();
    });
    this.shortcuts.bind('I', (event) => {
      if (free(event)) this.session.setInPoint(this.player.currentTime);
    });
    this.shortcuts.bind('O', (event) => {
      if (free(event)) this.session.setOutPoint(this.player.currentTime);
    });
    this.shortcuts.bind('Alt+X', (event) => {
      if (free(event)) this.session.clearExportRange();
    });
    for (const combo of ['?', 'Shift+?']) {
      this.shortcuts.bind(combo, (event) => {
        if (free(event)) services.openShortcuts();
      });
    }

    // Service worker: production builds only.
    void registerServiceWorker({
      onOfflineReady: () => this.notifications.success('Listo sin conexión', 'Concat ya funciona sin red en este navegador.'),
      onNeedRefresh: (update) =>
        actionToast(this.notifications, {
          type: 'info',
          title: 'Nueva versión disponible',
          message: 'Recarga para actualizar. Guarda antes si tienes cambios.',
          actionLabel: 'Recargar',
          onAction: () => {
            void this.saveProjectSilently().finally(update);
          },
        }),
      onError: (error) => console.warn('Service worker no registrado', error),
    }).then((result) => window.addEventListener('pagehide', () => result.dispose(), { once: true }));
    window.addEventListener('pagehide', () => this.installPrompt.dispose(), { once: true });
  }

  /** Fase 6: reflects the I/O marks in the header badge. */
  private syncRangeBadge(): void {
    const badge = this.rangeBadge;
    if (!badge) return;
    const marked = this.session.inPoint !== null || this.session.outPoint !== null;
    badge.hidden = !marked;
    if (marked) {
      const range = this.session.exportRange();
      badge.textContent = `I ${formatEta(range.start.asNumber())} → O ${formatEta(range.end.asNumber())}`;
      badge.setAttribute('aria-label', `Rango de exportación de ${formatEta(range.start.asNumber())} a ${formatEta(range.end.asNumber())}. Pulsa para borrarlo.`);
    }
  }

  /** Fase 6: installs an opened project package and opens its project. */
  private async installPackage(opened: OpenedPackage): Promise<void> {
    for (const [id, file] of opened.media) {
      if (this.pool.hasOriginal(id) || (await this.mediaStore.get(id))) continue;
      const name = opened.document.media.find((item) => item.id === id)?.name ?? file.name;
      try {
        await this.pool.addMedia(file, id, name);
        const info = this.pool.getDecoder(id)?.mediaInfo;
        if (info) await this.mediaStore.importFile(file, info, id, name);
        void this.generateWaveforms(file, id);
      } catch (error) {
        this.reportError(`No se pudo importar ${name}`, error);
      }
    }
    const fontFiles = new OpfsFontFiles();
    for (const [path, blob] of opened.fonts) await fontFiles.write(fontFileName(path), blob);
    for (const [id, cube] of opened.luts) {
      try {
        this.media.luts.add({ ...parseCube(cube, id), id });
      } catch (error) {
        this.reportError('LUT del paquete', error);
      }
    }
    this.history.clear();
    this.session.name = opened.name;
    this.session.loadDocument(opened.document);
    this.session.clearExportRange();
    this.projectId = null;
    this.selectedClipId = null;
    this.session.dirty = true;
    this.refreshAll();
    this.requestRender();
    void this.media.refreshOffline();
    document.dispatchEvent(new CustomEvent('media-library-changed'));
  }

  /** Fase 6: the storage manager's data and actions. */
  private storageSource(): ProductionStorage {
    const waveformsDb = (): Promise<import('./storage/idb.ts').KeyValue> => openKeyValue('ConcatMediaDB', ['files', 'waveforms']);
    const referencedMedia = async (): Promise<Set<string>> => {
      const ids = new Set(this.session.document.media.map((item) => item.id));
      for (const summary of await this.projectStore.listProjects()) {
        const loaded = await this.projectStore.loadProject(summary.id);
        for (const item of loaded?.document.media ?? []) ids.add(item.id);
      }
      return ids;
    };
    return {
      estimate: async () => {
        if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
        const estimate = await navigator.storage.estimate();
        return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
      },
      breakdown: async () => {
        const out: StorageCategory[] = [];
        const media = await this.mediaStore.list();
        out.push({ id: 'media', label: 'Medios originales', bytes: media.reduce((sum, record) => sum + record.fileSize, 0), count: media.length });
        try {
          const proxies = await (await openProxyStorage()).records.list();
          out.push({ id: 'proxies', label: 'Proxies', bytes: proxies.reduce((sum, record) => sum + record.fileSize, 0), count: proxies.length });
        } catch {
          out.push({ id: 'proxies', label: 'Proxies', bytes: 0, count: 0 });
        }
        const fonts = projectFonts(this.session.document);
        let fontBytes = 0;
        for (const font of fonts) fontBytes += (await this.fontStore.read(font))?.byteLength ?? 0;
        out.push({ id: 'fonts', label: 'Fuentes del proyecto', bytes: fontBytes, count: fonts.length });
        const waves = await (await waveformsDb()).getAll<{ data?: { byteLength?: number } }>('waveforms');
        out.push({ id: 'waveforms', label: 'Formas de onda', bytes: waves.reduce((sum, wave) => sum + (wave.data?.byteLength ?? 0), 0), count: waves.length });
        const projects = await this.projectStore.listProjects();
        out.push({ id: 'projects', label: 'Proyectos guardados', bytes: projects.reduce((sum, project) => sum + project.fileSize, 0), count: projects.length });
        return out;
      },
      persisted: async () => (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persisted === 'function' ? navigator.storage.persisted() : false),
      requestPersist: async () => (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function' ? navigator.storage.persist() : false),
      clearProxies: () => this.media.clearProxies(),
      clearWaveforms: async () => {
        await (await waveformsDb()).clear('waveforms');
      },
      clearOrphans: async () => {
        const keep = await referencedMedia();
        let removed = 0;
        for (const record of await this.mediaStore.list()) {
          if (keep.has(record.id)) continue;
          await this.mediaStore.deleteFile(record.id);
          await waveformCache.delete(record.id).catch(() => undefined);
          this.pool.removeMedia(record.id);
          removed += 1;
        }
        if (removed > 0) document.dispatchEvent(new CustomEvent('media-library-changed'));
        return removed;
      },
      clearAll: async () => {
        await this.media.clearProxies();
        await this.mediaStore.clearAll();
        await this.projectStore.clearAll();
        await (await waveformsDb()).clear('waveforms');
        const builtin = new Set(this.presets.builtins().map((preset) => preset.id));
        for (const preset of await this.presets.list()) if (!builtin.has(preset.id)) await this.presets.delete(preset.id);
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry('fonts', { recursive: true }).catch(() => undefined);
        } catch {
          // No OPFS: nothing stored there.
        }
        for (const key of Object.keys(localStorage)) if (key.startsWith('concat')) localStorage.removeItem(key);
        this.history.clear();
        this.session.name = 'Untitled';
        this.session.loadDocument(createProjectDocument());
        this.session.clearExportRange();
        this.projectId = null;
        this.selectedClipId = null;
        this.session.dirty = false;
        this.refreshAll();
        this.requestRender();
      },
    };
  }

  /** Fase 5: an edit from a dialog (history + refresh + autosave). */
  private runStudioOp(op: EditOperation): boolean {
    const ok = this.session.run(op);
    if (ok) {
      this.inspectorPanel?.refresh();
      this.requestRender();
      this.requestAutosave();
    }
    return ok;
  }

  /** Fase 5: toast + console, never a crash. */
  private reportError(title: string, error: unknown): void {
    console.error(title, error);
    this.notifications.error(title, error instanceof Error ? error.message : String(error));
  }

  /** Fase 5: registers the open project's fonts with `document.fonts`. */
  private syncFonts(): void {
    const fonts = projectFonts(this.session.document);
    if (fonts.length > 0) void this.fontLoader.loadAll(fonts);
  }

  private wireShortcuts(): void {
    const ctx = this;
    // Fase 4: proxy playback toggle.
    this.shortcuts.bind(PROXY_TOGGLE_SHORTCUT, () => {
      ctx.media.toggleProxies();
      ctx.header?.syncProxyToggle();
    });
    this.shortcuts.bindAction('play', () => {
      if (ctx.player.isPlaying) ctx.player.pause();
      else ctx.player.play();
    });
    this.shortcuts.bindAction('save', () => void ctx.saveProject());
    this.shortcuts.bindAction('import', () => ctx.mediaPanel?.openPicker());
    this.shortcuts.bindAction('delete', () => {
      const id = ctx.selectedClipId;
      if (!id) return;
      ctx.history.push(ctx.session.document, ctx.session.documentSettings());
      ctx.session.removeClip(id);
      ctx.selectedClipId = null;
      ctx.refreshAll();
      ctx.requestRender();
      ctx.requestAutosave();
    });
    this.shortcuts.bindAction('cut', () => ctx.splitAtPlayhead());
    this.shortcuts.bindAction('duplicate', () => ctx.duplicateSelection());
    this.shortcuts.bindAction('undo', () => {
      const restored = ctx.history.undo(ctx.session.document, ctx.session.documentSettings());
      if (restored) {
        ctx.session.document = restored;
        ctx.session.rebuild();
        ctx.session.dirty = true;
        ctx.refreshAll();
        ctx.requestRender();
      }
    });
    this.shortcuts.bindAction('redo', () => {
      const restored = ctx.history.redo(ctx.session.document, ctx.session.documentSettings());
      if (restored) {
        ctx.session.document = restored;
        ctx.session.rebuild();
        ctx.session.dirty = true;
        ctx.refreshAll();
        ctx.requestRender();
      }
    });
    this.shortcuts.bindAction('nextFrame', () => ctx.player.stepForward());
    this.shortcuts.bindAction('prevFrame', () => ctx.player.stepBackward());
    this.shortcuts.bindAction('goStart', () => ctx.player.seekTo(Rational.ZERO));
    this.shortcuts.bindAction('goEnd', () => ctx.player.seekTo(ctx.session.duration()));
    this.shortcuts.bindAction('zoomIn', () => ctx.timelinePanel?.zoomIn());
    this.shortcuts.bindAction('zoomOut', () => ctx.timelinePanel?.zoomOut());
    this.shortcuts.bindAction('zoomFit', () => ctx.timelinePanel?.zoomFit());
  }

  /** Ctrl+K: splits the clip under the playhead. */
  splitAtPlayhead(): void {
    const at = this.player.currentTime.asNumber();
    const timeline = this.session.timeline;
    const clip = timeline.clips.find(
      (item) => item.start < at && at < item.start + item.duration,
    );
    if (!clip) {
      this.notifications.info('Nada que cortar', 'Coloca el playhead sobre un clip.');
      return;
    }
    this.history.push(this.session.document, this.session.documentSettings());
    if (this.session.splitClip(clip.id, at)) {
      this.refreshAll();
      this.requestRender();
      this.requestAutosave();
      document.dispatchEvent(new CustomEvent('timeline-changed'));
    }
  }

  /** Ctrl+D: duplicates the selection after the original. */
  duplicateSelection(): void {
    const id = this.selectedClipId;
    const timeline = this.session.timeline;
    const clip = id === null ? undefined : timeline.clips.find((item) => item.id === id);
    if (!clip || id === null) return;
    this.history.push(this.session.document, this.session.documentSettings());
    this.session.duplicateClips([id]);
    this.refreshAll();
    this.requestRender();
    this.requestAutosave();
  }

  private armAutosave(): void {
    if (this.autosaveTimer !== null) clearInterval(this.autosaveTimer);
    this.autosaveTimer = setInterval(() => {
      if (this.session.dirty) void this.saveProjectSilently();
    }, Math.max(5, this.settings.autosaveInterval) * 1000);
  }

  private async saveProjectSilently(): Promise<void> {
    try {
      const record = await this.projectStore.saveProject(
        this.session.document,
        this.session.documentSettings(),
        this.projectId ?? undefined,
      );
      this.projectId = record.id;
      this.session.dirty = false;
      this.header?.sync();
    } catch {
      // Autosave is best-effort; Ctrl+S surfaces errors.
    }
  }

  /** Rebuilds every panel from the session. */
  private refreshAll(): void {
    this.syncFonts();
    this.mediaPanel?.refresh();
    this.timelinePanel?.refresh();
    this.inspectorPanel?.refresh();
    this.header?.sync();
    document.dispatchEvent(new CustomEvent('media-library-changed'));
  }

  /** Loads the persisted media back into the pool at boot. */
  private async restoreMediaLibrary(): Promise<void> {
    const records = await this.mediaStore.list();
    let restored = 0;
    for (const record of records) {
      const blob = await this.mediaStore.readFile(record.id);
      if (!blob) continue;
      await this.pool.addMedia(blob, record.id, record.name);
      // Decoders have to exist before the first render asks for a frame.
      const asset = await this.pool.whenReady(record.id);
      if (asset) restored += 1;
    }
    if (restored > 0) {
      this.notifications.info('Biblioteca restaurada', `${restored} medios disponibles.`);
      document.dispatchEvent(new CustomEvent('media-library-changed'));
    }
  }

  /** A bin entry from an imported asset. */
  private toMediaItem(id: string, name: string, asset: { type: string; duration: Rational; width: number; height: number; fps: FrameRate; codec: string }): MediaItem {
    return {
      id,
      path: `media/${id}`,
      name,
      duration: asset.duration.asNumber(),
      kind: asset.type === 'image' ? 'image' : asset.type === 'audio' ? 'audio' : 'video',
      width: asset.width > 0 ? asset.width : null,
      height: asset.height > 0 ? asset.height : null,
      frameRate: asset.fps.fps().asNumber(),
      frameRateFraction: asset.fps.fps().toString(),
      videoCodec: asset.codec !== '' ? asset.codec : null,
      audioCodec: null,
      hasAudio: asset.type !== 'image',
      audioTracks: [],
      slot: false,
      origin: null,
      colorRange: null,
      colorSpace: 'sdr',
      extra: {},
    };
  }
}

/** The next free clip id in the `c1`, `c2`, … series. */
function nextClipId(existing: string[]): string {
  let counter = existing.length + 1;
  let id = `c${counter}`;
  while (existing.includes(id)) {
    counter += 1;
    id = `c${counter}`;
  }
  return id;
}

/** A readable message from an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -- boot ------------------------------------------------------------------

const app = new EditorApp();
void app.start().catch((error) => {
  const banner = document.createElement('div');
  banner.className = 'boot-error';
  banner.textContent = `Concat no pudo iniciar: ${describe(error)}`;
  document.body.appendChild(banner);
});

// The running instance, for tests and the browser console.
export { app, EditorApp };
