// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The application: wires session, media pool, player, storage and the shell
 * together, and owns the app-level flows (import, save/open, autosave,
 * shortcuts). Everything runs against local storage — no network, no
 * telemetry.
 */

import { Rational } from './core/rational.ts';
import { FrameRate } from './core/time.ts';
import type { MediaItem } from './model/document.ts';
import { createProjectDocument } from './model/document.ts';
import { MediaPool } from './media/media-pool.ts';
import { PreviewPlayer } from './player/player.ts';
import type { RenderContext2D, RenderTarget } from './render/types.ts';
import { EditorSession } from './session/editor-session.ts';
import { History } from './session/history.ts';
import { MediaStore } from './storage/media-store.ts';
import { ProjectStore } from './storage/project-store.ts';
import { MemoryKeyValue, openKeyValue } from './storage/idb.ts';
import { loadSettings, saveSettings as persistSettings, type UserSettings } from './storage/settings-store.ts';
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
}

/** The editor application. */
class EditorApp implements AppContext {
  session = new EditorSession();
  player: PreviewPlayer;
  pool = new MediaPool();
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
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;

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

    // Storage backends (real IndexedDB + OPFS when available).
    const mediaBackend = await openKeyValue('ConcatMediaDB', ['files']);
    this.mediaStore = new MediaStore(mediaBackend);
    const projectBackend = await openKeyValue('ConcatProjectDB', ['projects']);
    this.projectStore = new ProjectStore(projectBackend);

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

    // Shortcuts.
    this.wireShortcuts();
    this.shortcuts.setEnabled(true);

    // App-level events.
    document.addEventListener('open-import', () => this.mediaPanel?.openPicker());
    document.addEventListener('session-reset', () => {
      this.session.document = createProjectDocument();
      this.session.name = 'Untitled';
      this.session.rebuild();
      this.session.dirty = false;
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

  async importFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const id = crypto.randomUUID();
      try {
        const asset = await this.pool.addMedia(file, id, file.name);
        const decoder = this.pool.getDecoder(id);
        const info = decoder?.mediaInfo;
        if (info) {
          await this.mediaStore.importFile(file, info, id, file.name);
        }
        this.session.addMediaItem(this.toMediaItem(asset.id, asset.name, asset));
        this.notifications.success('Medio importado', asset.name);
      } catch (error) {
        this.notifications.error('Error al importar', `${file.name}: ${describe(error)}`);
      }
    }
    document.dispatchEvent(new CustomEvent('media-library-changed'));
    this.requestAutosave();
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
    this.session.document = loaded.document;
    this.session.name = loaded.name;
    this.session.rebuild();
    this.session.dirty = false;
    this.projectId = id;
    this.selectedClipId = null;
    this.refreshAll();
    this.requestRender();
    this.notifications.success('Proyecto abierto', loaded.name);
  }

  addMediaToTimeline(mediaId: string): void {
    this.history.push(this.session.document, this.session.documentSettings());
    const clip = this.session.addClipAt(mediaId, this.player.currentTime);
    this.selectedClipId = clip.id;
    this.refreshAll();
    this.requestRender();
    this.requestAutosave();
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

  // -- internals -----------------------------------------------------------

  private wireShortcuts(): void {
    const ctx = this;
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
    const headDuration = at - clip.start;
    const tailDuration = clip.duration - headDuration;
    if (headDuration <= 0 || tailDuration <= 0) return;
    const tail = structuredClone(clip);
    tail.id = nextClipId(timeline.clips.map((item) => item.id));
    tail.start = at;
    tail.duration = tailDuration;
    tail.sourceStart = clip.sourceStart + headDuration * clip.speed;
    clip.duration = headDuration;
    timeline.clips.push(tail);
    this.session.rebuild();
    this.session.dirty = true;
    this.refreshAll();
    this.requestRender();
    this.requestAutosave();
  }

  /** Ctrl+D: duplicates the selection after the original. */
  duplicateSelection(): void {
    const id = this.selectedClipId;
    const timeline = this.session.timeline;
    const clip = timeline.clips.find((item) => item.id === id);
    if (!clip) return;
    this.history.push(this.session.document, this.session.documentSettings());
    const copy = structuredClone(clip);
    copy.id = nextClipId(timeline.clips.map((item) => item.id));
    copy.start = clip.start + clip.duration;
    timeline.clips.push(copy);
    this.selectedClipId = copy.id;
    this.session.rebuild();
    this.session.dirty = true;
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
    this.mediaPanel?.refresh();
    this.timelinePanel?.refresh();
    this.inspectorPanel?.refresh();
    this.header?.sync();
    document.dispatchEvent(new CustomEvent('media-library-changed'));
  }

  /** Loads the persisted media back into the pool at boot. */
  private async restoreMediaLibrary(): Promise<void> {
    const records = await this.mediaStore.list();
    for (const record of records) {
      const blob = await this.mediaStore.readFile(record.id);
      if (!blob) continue;
      await this.pool.addMedia(blob, record.id, record.name);
    }
    if (records.length > 0) {
      this.notifications.info('Biblioteca restaurada', `${records.length} medios disponibles.`);
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
