// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The editing session: the `concat.json` document as the source of truth, the
 * engine `Timeline` built from it, and the dirty flag the save indicator and
 * autosave watch.
 *
 * Mutations land on the document (what `model/document.ts` writes) and
 * {@link EditorSession.rebuild} re-derives the engine timeline, so the
 * document and the render model can never disagree. Cheap enough for the clip
 * counts of a real edit, and revisited with incremental updates when the
 * Fase 3 commands arrive.
 */

import { FrameRate } from '../core/time.ts';
import { Rational } from '../core/rational.ts';
import { Timeline, Track, TrackKind, type ClipId, type TrackId } from '../core/timeline.ts';
import {
  type DocumentClip,
  type DocumentSettings,
  type DocumentTimeline,
  type DocumentTrack,
  type MediaItem,
  type ProjectDocument,
  type VideoSettings,
  activeTimeline,
  createProjectDocument,
  defaultVideoSettings,
  videoSettingsRate,
} from '../model/index.ts';
import { EditorClip } from './editor-clip.ts';

/** The four starter lanes of a fresh project, in document order. */
const STARTER_TRACKS = 4;

/** Engine rows of one document track: its core handle and its clips. */
interface EngineRow {
  docTrack: DocumentTrack;
  trackId: TrackId;
  clipIds: ClipId[];
}

/** A media import as the session tracks it. */
export interface SessionMedia {
  item: MediaItem;
}

/** Options for {@link EditorSession.constructor}. */
export interface SessionOptions {
  /** The document to start from; a fresh project when omitted. */
  document?: ProjectDocument;
  /** Display name of the project. */
  name?: string;
}

/** The editing session around one project. */
export class EditorSession {
  /** The document: what `toDocument` writes and `fromDocument` reads. */
  document: ProjectDocument;
  /** The display name; written as the document's `name` field. */
  name: string;
  /** The engine timeline derived from the active document timeline. */
  engine: Timeline = Timeline.hd();
  /** Unsaved-changes flag for the save indicator and autosave. */
  dirty = false;

  private rows: EngineRow[] = [];
  private readonly clipsById = new Map<string, EditorClip>();
  private readonly trackIdsByName = new Map<string, TrackId>();

  /**
   * Builds a session, deriving the engine timeline from the document.
   * @param options starting document and name.
   */
  constructor(options: SessionOptions = {}) {
    this.document = options.document ?? createProjectDocument();
    this.name = options.name ?? 'Untitled';
    if (options.document) this.name = options.name ?? this.readNameFromDocument();
    this.rebuild();
    this.dirty = false;
  }

  /** The active document timeline. */
  get timeline(): DocumentTimeline {
    return activeTimeline(this.document);
  }

  /** The output frame of the active timeline. */
  get video(): VideoSettings {
    return this.timeline.video;
  }

  /** The exact output rate of the active timeline. */
  get frameRate(): FrameRate {
    return (
      FrameRate.checked(this.video.rateNum, this.video.rateDen) ??
      FrameRate.THIRTY
    );
  }

  /** The bin: every imported file. */
  get media(): readonly MediaItem[] {
    return this.document.media;
  }

  /** How long the edit runs, in engine seconds. */
  duration(): Rational {
    return this.engine.duration();
  }

  /**
   * Re-derives the engine timeline from the document. The document lists
   * lanes top to bottom; the engine composites bottom-first, so the
   * document's last lane becomes engine track 0. A lane's engine kind is
   * what its clips are: a lane whose clips are all sound is an audio lane.
   */
  rebuild(): void {
    const docTimeline = this.timeline;
    const rate = this.frameRate;
    const engine = new Timeline(docTimeline.video.width, docTimeline.video.height, rate);

    this.rows = [];
    this.clipsById.clear();
    this.trackIdsByName.clear();

    const ordered = [...docTimeline.tracks].reverse();
    for (const docTrack of ordered) {
      const clips = docTimeline.clips.filter((clip) => clip.trackId === docTrack.id);
      const kind: TrackKind =
        clips.length > 0 && clips.every((clip) => clip.kind === 'audio')
          ? TrackKind.Audio
          : TrackKind.Video;
      const track = new Track(docTrack.id, kind);
      // `visible` gates the composite: a hidden lane is skipped entirely.
      track.enabled = docTrack.visible;
      const trackId = engine.addTrack(track);
      this.trackIdsByName.set(docTrack.id, trackId);
      this.rows.push({ docTrack, trackId, clipIds: [] });
    }

    for (const docClip of docTimeline.clips) {
      const row = this.rows.find((entry) => entry.docTrack.id === docClip.trackId);
      if (!row) continue;
      const clip = new EditorClip(docClip);
      const clipId = engine.addClip(row.trackId, clip);
      if (!clipId) continue;
      row.clipIds.push(clipId);
      this.clipsById.set(docClip.id, clip);
    }

    this.engine = engine;
    this.dirty = true;
  }

  /** The engine clip behind a document clip id. */
  clip(docClipId: string): EditorClip | undefined {
    return this.clipsById.get(docClipId);
  }

  /** Every engine clip of the edit, in track order. */
  clips(): EditorClip[] {
    return [...this.clipsById.values()];
  }

  /** The engine handle of a document track id. */
  trackId(docTrackId: string): TrackId | undefined {
    return this.trackIdsByName.get(docTrackId);
  }

  /** The engine clip currently under `time` on a document track, if any. */
  clipOnTrackAt(docTrackId: string, time: Rational): EditorClip | undefined {
    const trackId = this.trackIdsByName.get(docTrackId);
    if (!trackId) return undefined;
    const clipId = this.engine.clipOnTrackAt(trackId, time);
    return clipId ? (this.engine.clip(clipId) as EditorClip | undefined) : undefined;
  }

  /**
   * Adds a bin item to the document.
   * @param item the media entry as the import produced it.
   */
  addMediaItem(item: MediaItem): void {
    this.document.media.push(item);
    this.dirty = true;
  }

  /**
   * Places a clip of `mediaId` at `time` on the first lane that can take it:
   * the first lane of a matching kind, created if the project has none.
   * @param mediaId the bin item to cut from.
   * @param time where the clip starts, in engine seconds.
   * @returns the document clip that was added.
   */
  addClipAt(mediaId: string, time: Rational): DocumentClip {
    const item = this.document.media.find((entry) => entry.id === mediaId);
    if (!item) throw new Error(`media ${mediaId} is not in the bin`);
    const kind: DocumentClip['kind'] = item.kind;
    const docTrack = this.ensureTrackFor(kind);

    // Mint the next clip id: "c1", "c2", ... never re-issued.
    let counter = this.timeline.clips.length + 1;
    let id = `c${counter}`;
    while (this.clipsById.has(id)) {
      counter += 1;
      id = `c${counter}`;
    }

    // The timeline length of a cut: the whole media at 1x, one second for a
    // still whose length is editorial.
    const duration = item.duration ?? 1;
    const docClip: DocumentClip = {
      id,
      trackId: docTrack.id,
      mediaId,
      name: item.name,
      kind,
      start: Math.max(0, time.asNumber()),
      duration: Math.max(1 / 60, duration),
      sourceStart: 0,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      stretchX: 1,
      stretchY: 1,
      opacity: 1,
      speed: 1,
      speedCurve: null,
      keys: [],
      flipH: false,
      flipV: false,
      blend: '',
      crop: null,
      cutout: null,
      preservePitch: true,
      filters: [],
      videoEffects: [],
      audioStream: null,
      muted: null,
      detachedFrom: null,
      transitionIn: null,
      enhanced: null,
      text: null,
      shape: null,
      extra: {},
    };
    this.timeline.clips.push(docClip);
    this.rebuild();
    return docClip;
  }

  /**
   * Removes a clip from the edit.
   * @param docClipId the document clip id.
   * @returns true when something was removed.
   */
  removeClip(docClipId: string): boolean {
    const clips = this.timeline.clips;
    const at = clips.findIndex((clip) => clip.id === docClipId);
    if (at < 0) return false;
    clips.splice(at, 1);
    this.rebuild();
    return true;
  }

  /**
   * The settings the writer needs around the edit: identity fields of the
   * manifest.
   */
  documentSettings(): DocumentSettings {
    return {
      name: this.name,
      width: this.video.width,
      height: this.video.height,
      rateNum: this.video.rateNum,
      rateDen: this.video.rateDen,
    };
  }

  /**
   * Renames the project.
   * @param name the new display name.
   */
  rename(name: string): void {
    this.name = name.trim() === '' ? this.name : name;
    this.dirty = true;
  }

  /** The first lane that can carry `kind`, creating one when none fits. */
  private ensureTrackFor(kind: DocumentClip['kind']): DocumentTrack {
    const wanted: TrackKind = kind === 'audio' ? TrackKind.Audio : TrackKind.Video;
    const existing = this.timeline.tracks.find((track) => this.trackKindOf(track) === wanted);
    if (existing) return existing;
    const number = this.timeline.tracks.length + 1;
    const created: DocumentTrack = {
      id: `T${number + STARTER_TRACKS}`,
      visible: true,
      muted: false,
      extra: {},
    };
    this.timeline.tracks.push(created);
    return created;
  }

  /** Display name kept on the document's writer-owned `name` mirror. */
  private readNameFromDocument(): string {
    const name = this.document.extra['name'];
    return typeof name === 'string' && name !== '' ? name : 'Untitled';
  }

  /** A lane whose clips are all sound is an audio lane. */
  private trackKindOf(track: DocumentTrack): TrackKind {
    const clips = this.timeline.clips.filter((clip) => clip.trackId === track.id);
    return clips.length > 0 && clips.every((clip) => clip.kind === 'audio')
      ? TrackKind.Audio
      : TrackKind.Video;
  }
}

/** Video lanes carry picture; the mixer silences lanes the document mutes. */
export function trackMuted(track: DocumentTrack): boolean {
  return track.muted;
}

/** True when the frame rate of these settings is one a video has. */
export function usableVideoSettings(video: VideoSettings): boolean {
  return (
    video.width > 0 &&
    video.height > 0 &&
    videoSettingsRate(video) > 0
  );
}

/** The default frame of a fresh project, for the New Project dialog. */
export const DEFAULT_VIDEO: VideoSettings = defaultVideoSettings();
