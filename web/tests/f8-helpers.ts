// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/**
 * Fase 8 doubles for the drag & drop / HUD suites: a fake `AppContext` (real
 * session, pool, notifications and settings; fake player and media bytes), a
 * structural `DataTransfer` and `DragEvent` (jsdom ships neither) and a few
 * geometry helpers.
 */

import { Rational } from '../src/core/rational.ts';
import { EditSession } from '../src/session/edit-session.ts';
import { History } from '../src/session/history.ts';
import { MediaPool, type MediaAsset } from '../src/media/media-pool.ts';
import { MediaStore } from '../src/storage/media-store.ts';
import { ProjectStore } from '../src/storage/project-store.ts';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import { loadSettings, type UserSettings } from '../src/storage/settings-store.ts';
import { Notifications } from '../src/ui/notifications.ts';
import { ThemeManager } from '../src/ui/theme-manager.ts';
import { KeyboardShortcuts } from '../src/ui/shortcuts.ts';
import type { AppContext } from '../src/ui/app-context.ts';
import type { PreviewPlayer } from '../src/player/player.ts';
import type { DocumentClip, MediaItem, ProjectDocument } from '../src/model/document.ts';
import type { DataTransferLike } from '../src/ui/dnd/media-drag.ts';

// -- the player -------------------------------------------------------------

/** A `PreviewPlayer` stand-in: real time bookkeeping, no audio, no decodes. */
export class FakePlayer {
  private time = Rational.ZERO;
  private playing = false;
  private loopRange: { start: Rational; end: Rational } | null = null;
  durationSeconds = 0;
  onTimeUpdate: ((time: Rational) => void) | null = null;
  onStateChanged: ((state: 'playing' | 'paused' | 'stopped') => void) | null = null;
  renders = 0;

  get currentTime(): Rational {
    return this.time;
  }

  set currentTime(time: Rational) {
    this.time = time;
    this.onTimeUpdate?.(time);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** The transport slider's level reaches the player (see PreviewPanel.applyVolume). */
  readonly volumeCalls: number[] = [];

  setOutputVolume(volume: number): void {
    this.volumeCalls.push(volume);
  }

  syncTrackStates(): void {}

  get duration(): Rational {
    return Rational.approximate(this.durationSeconds) ?? Rational.ZERO;
  }

  get playbackRate(): number {
    return 1;
  }

  get loop(): { start: Rational; end: Rational } | null {
    return this.loopRange;
  }

  get level(): number {
    return 0;
  }

  play(): void {
    this.playing = true;
    this.onStateChanged?.('playing');
  }

  pause(): void {
    this.playing = false;
    this.onStateChanged?.('paused');
  }

  stop(): void {
    this.playing = false;
    this.seekTo(Rational.ZERO);
    this.onStateChanged?.('stopped');
  }

  seekTo(time: Rational): void {
    this.currentTime = time;
  }

  stepForward(): void {
    this.seekTo(Rational.approximate(this.time.asNumber() + 1 / 30) ?? Rational.ZERO);
  }

  stepBackward(): void {
    this.seekTo(Rational.approximate(Math.max(0, this.time.asNumber() - 1 / 30)) ?? Rational.ZERO);
  }

  setPlaybackRate(): void {
    // Fixed rate in the double.
  }

  setLoop(start: Rational, end: Rational): void {
    this.loopRange = { start, end };
  }

  clearLoop(): void {
    this.loopRange = null;
  }

  async renderOnce(): Promise<void> {
    this.renders += 1;
  }

  clearMediaErrors(): void {
    // Nothing cached in the double.
  }

  destroy(): void {
    // Nothing to free.
  }
}

// -- the media pool ---------------------------------------------------------

/** A pool whose library is filled by hand — no decoding in jsdom. */
export class FakeMediaPool extends MediaPool {
  private readonly library = new Map<string, MediaAsset>();

  /** Registers an asset (newest first, like the real pool). */
  add(asset: MediaAsset): MediaAsset {
    this.library.set(asset.id, asset);
    return asset;
  }

  override listMedia(): MediaAsset[] {
    return [...this.library.values()].sort((a, b) => b.importedAt - a.importedAt);
  }

  override getAsset(id: string): MediaAsset | undefined {
    return this.library.get(id);
  }

  override get(id: string): MediaAsset | undefined {
    return this.library.get(id);
  }

  override removeMedia(id: string): void {
    this.library.delete(id);
  }
}

/**
 * A library asset without a file behind it.
 * @param options id/name/type/duration.
 * @returns the asset, ready for `FakeMediaPool.add`.
 */
export function fakeAsset(options: {
  id: string;
  name?: string;
  type?: 'video' | 'audio' | 'image';
  durationSeconds?: number;
  importedAt?: number;
}): MediaAsset {
  const duration = Rational.approximate(options.durationSeconds ?? 10) ?? Rational.ZERO;
  return {
    id: options.id,
    name: options.name ?? `${options.id}.mp4`,
    type: options.type ?? 'video',
    duration,
    width: 1920,
    height: 1080,
    fps: { fps: () => Rational.approximate(30) ?? Rational.ZERO, toString: () => '30/1' } as unknown as MediaAsset['fps'],
    codec: 'avc1',
    fileSize: 1024,
    thumbnailUrl: '',
    opfsPath: `media/${options.id}`,
    importedAt: options.importedAt ?? Date.now(),
    file: new Blob([]),
    // Fase 9: an asset built by hand is a settled one.
    status: 'ready',
  };
}

// -- the app context --------------------------------------------------------

/** What {@link createFakeApp} hands back. */
export interface FakeApp {
  ctx: AppContext;
  session: EditSession;
  player: FakePlayer;
  pool: FakeMediaPool;
  notifications: Notifications;
  toasts: HTMLElement;
  mediaStore: MediaStore;
  settings: UserSettings;
  /** Every toolbar/panel refresh the app was asked for. */
  renders: number;
  /** The double's own selection (the interface field is readonly). */
  selectedClipId: string | null;
}

/** Options of {@link createFakeApp}. */
export interface FakeAppOptions {
  document?: ProjectDocument;
  /** Milliseconds of the debounced render (unused: the fake counts calls). */
  throwOnImport?: boolean;
}

/**
 * An `AppContext` good enough to mount the shell's panels in jsdom.
 * @param options starting document and tweaks.
 * @returns the context plus the doubles a test may want to poke.
 */
export function createFakeApp(options: FakeAppOptions = {}): FakeApp {
  const session = new EditSession(options.document ? { document: options.document } : {});
  const player = new FakePlayer();
  const pool = new FakeMediaPool();
  const toasts = document.createElement('div');
  const notifications = new Notifications(toasts);
  const theme = new ThemeManager(document.documentElement);
  const settings = loadSettings();
  const mediaStore = new MediaStore(new MemoryKeyValue());
  const projectStore = new ProjectStore(new MemoryKeyValue());
  const history = new History();
  const fake: FakeApp = {
    ctx: null as unknown as AppContext,
    session,
    player,
    pool,
    notifications,
    toasts,
    mediaStore,
    settings,
    renders: 0,
    selectedClipId: null,
  };
  const ctx: AppContext = {
    session,
    editSession: session,
    player: player as unknown as PreviewPlayer,
    pool,
    mediaStore,
    projectStore,
    history,
    notifications,
    theme,
    shortcuts: new KeyboardShortcuts(),
    settings,
    projectId: null,
    async importFiles(files: File[]): Promise<void> {
      if (options.throwOnImport) throw new Error('importFiles no configurado');
      for (const file of files) {
        const id = `m-${file.name}`;
        pool.add(fakeAsset({ id, name: file.name }));
        session.addMediaItem(mediaItem({ id, name: file.name, kind: 'video', duration: 1 }));
      }
    },
    async saveProject(): Promise<void> {
      session.dirty = false;
    },
    async openProject(): Promise<void> {
      // The double has nowhere to load from.
    },
    addMediaToTimeline(mediaId: string): void {
      const track = session.timeline.tracks.find((candidate) => candidate.extra['kind'] === 'video') ?? session.timeline.tracks[0];
      if (!track) return;
      const clip = session.makeClip(mediaId, track.id, player.currentTime.asNumber());
      session.insertClip(clip, 'insert');
    },
    selectClip(clipId: string | null): void {
      // `selectedClipId` is readonly on the interface: the double keeps its own copy.
      fake.selectedClipId = clipId;
      document.dispatchEvent(new CustomEvent('selection-changed'));
    },
    selectedClipId: null,
    requestRender(): void {
      fake.renders += 1;
    },
    requestAutosave(): void {
      session.dirty = true;
    },
    saveSettings(): void {
      // The double keeps settings in memory only.
    },
  };
  fake.ctx = ctx;
  return fake;
}

/**
 * A bin entry shaped like the one `main.ts` builds on import.
 * @param options id/name/kind/duration.
 * @returns the media item.
 */
export function mediaItem(options: {
  id: string;
  name?: string;
  kind?: 'video' | 'audio' | 'image';
  duration?: number | null;
}): MediaItem {
  const kind = options.kind ?? 'video';
  return {
    id: options.id,
    path: `media/${options.id}`,
    name: options.name ?? `${options.id}.mp4`,
    duration: options.duration === undefined ? 10 : options.duration,
    kind,
    width: 1920,
    height: 1080,
    frameRate: 30,
    frameRateFraction: '30/1',
    videoCodec: 'avc1',
    audioCodec: null,
    hasAudio: kind !== 'image',
    audioTracks: [],
    slot: false,
    origin: null,
    colorRange: null,
    colorSpace: 'sdr',
    extra: {},
  };
}

// -- drag & drop doubles ----------------------------------------------------

/** A `DataTransfer` double: MIME map, effects and the drag image. */
export class FakeDataTransfer implements DataTransferLike {
  private readonly data = new Map<string, string>();
  dropEffect = '';
  effectAllowed = '';
  dragImage: { image: Element; x: number; y: number } | null = null;
  /**
   * The OS files a real file drag carries (`dataTransfer.files`). The
   * app-wide drop handler imports *these*, not the `Files` marker in the
   * type list, so the double has to model them too.
   */
  files: File[] = [];

  get types(): string[] {
    return [...this.data.keys()];
  }

  setData(type: string, value: string): void {
    this.data.set(type, value);
  }

  getData(type: string): string {
    return this.data.get(type) ?? '';
  }

  setDragImage(image: Element, x: number, y: number): void {
    this.dragImage = { image, x, y };
  }

  /** A transfer carrying OS files (a real file drag has no MIME map). */
  static files(names: string[]): FakeDataTransfer {
    const transfer = new FakeDataTransfer();
    transfer.data.set('Files', names.join(','));
    transfer.files = names.map((name) => new File([new Uint8Array(8)], name, { type: 'application/octet-stream' }));
    return transfer;
  }
}

/** What a synthetic drag event carries. */
export interface DragEventInitLike {
  dataTransfer?: DataTransferLike | null;
  clientX?: number;
  clientY?: number;
  shiftKey?: boolean;
  /** The element the pointer "left" (dragleave only). */
  relatedTarget?: EventTarget | null;
}

/**
 * Builds a DOM event carrying the drag payload (jsdom has no `DragEvent`).
 * @param type the event type.
 * @param init the payload and coordinates.
 * @returns the event, ready for `dispatchEvent`.
 */
export function dragEvent(type: string, init: DragEventInitLike = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: init.dataTransfer ?? null, writable: true, configurable: true },
    clientX: { value: init.clientX ?? 0, configurable: true },
    clientY: { value: init.clientY ?? 0, configurable: true },
    shiftKey: { value: init.shiftKey ?? false, configurable: true },
    relatedTarget: { value: init.relatedTarget ?? null, configurable: true },
  });
  return event;
}

/**
 * Forces an element's bounding box (jsdom lays nothing out).
 * @param element the element.
 * @param rect the box.
 */
export function stubRect(
  element: Element,
  rect: { left?: number; top?: number; width?: number; height?: number },
): void {
  const box = {
    left: rect.left ?? 0,
    top: rect.top ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    right: (rect.left ?? 0) + (rect.width ?? 0),
    bottom: (rect.top ?? 0) + (rect.height ?? 0),
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    toJSON: () => ({}),
  };
  Object.defineProperty(element, 'getBoundingClientRect', { value: () => box, configurable: true });
}

/** The clip list of one lane (the document keeps clips on the timeline). */
export function laneClips(session: EditSession, trackId: string): DocumentClip[] {
  return (session.document.timelines[0]?.clips ?? []).filter((clip) => clip.trackId === trackId);
}

/** Every toast title the double recorded, oldest first. */
export function toastTitles(toasts: HTMLElement): string[] {
  return [...toasts.querySelectorAll('.toast-title')].map((node) => node.textContent ?? '');
}
