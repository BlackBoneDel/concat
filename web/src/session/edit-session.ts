// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The Fase-3 editing session: one project, one history, one selection,
 * one clipboard and one snap engine. Every document change goes through
 * {@link EditSession.run} — never mutate the document directly.
 */

import { Rational } from '../core/rational.ts';
import type { DocumentClip, MediaItem, ProjectDocument } from '../model/document.ts';
import {
  AddKeyframeOperation,
  AddMarkerOperation,
  AddTrackOperation,
  AddTransitionOperation,
  CompoundOperation,
  DeleteClipOperation,
  DeleteClipsOperation,
  DeleteTrackOperation,
  DuplicateClipOperation,
  EditError,
  GroupClipsOperation,
  InsertClipOperation,
  LinkClipsOperation,
  MoveClipOperation,
  RemoveTransitionOperation,
  SetClipPropertyOperation,
  SetSpeedOperation,
  SplitClipOperation,
  ToggleClipEnabledOperation,
  TrimClipOperation,
  UngroupClipsOperation,
  UnlinkClipsOperation,
  cloneClip,
  currentTimeline,
  newId,
  readMarkers,
  requireClip,
  requireTrack,
  trackKindOf,
  type DeleteMode,
  type EditOperation,
  type InsertMode,
  type MarkerData,
  type TrackKind,
  type TransitionKind,
  type TrimEdge,
} from '../editor/operations.ts';
import { EditHistory } from '../editor/history.ts';
import { SelectionManager } from '../editor/selection.ts';
import { ClipboardManager } from '../editor/clipboard.ts';
import { SnapEngine } from '../editor/snapping.ts';
import { KeyEase, type ClipKind, type Json, type KeyProperty } from '../model/wire.ts';
import { EditorSession, type SessionOptions } from './editor-session.ts';

/** Options for {@link EditSession.constructor}. */
export interface EditSessionOptions extends SessionOptions {
  /** Reports an error to the user (toast). Defaults to console + throw. */
  onError?: (message: string, error: Error) => void;
  /** Called after every document change (UI refresh). */
  onChanged?: () => void;
}

/** The editing session behind the interactive timeline. */
export class EditSession extends EditorSession {
  /** Undo/redo, transactions and gesture merging. */
  readonly history: EditHistory;
  /** What is selected. */
  readonly selection = new SelectionManager();
  /** Copy/cut/paste of clip sets. */
  readonly clipboard = new ClipboardManager();
  /** Magnetic snapping. */
  readonly snapping = new SnapEngine(10);
  /** Error sink for invalid operations (main wires it to toasts). */
  onError: (message: string, error: Error) => void;
  /** Change sink for the UI. */
  onChanged: () => void;

  /**
   * @param options starting document, name and sinks.
   */
  constructor(options: EditSessionOptions = {}) {
    super(options);
    this.onError =
      options.onError ??
      ((message, error) => {
        console.error(message, error);
      });
    this.onChanged = options.onChanged ?? ((): void => undefined);
    this.history = new EditHistory(this.document);
    this.history.onChange = (doc): void => {
      this.document = doc;
      this.rebuild();
      this.dirty = true;
      this.onChanged();
    };
    this.selection.onSelectionChanged = (): void => {
      this.onChanged();
    };
  }

  /**
   * Runs one operation through history.
   * @param op the operation.
   * @returns true when it ran; false when it was rejected (toast shown).
   */
  run(op: EditOperation): boolean {
    try {
      this.history.execute(op);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onError(message, error instanceof Error ? error : new Error(message));
      return false;
    }
  }

  /**
   * Imports a bin item outside the history: re-bases so later ops see it.
   * @param item the media item.
   */
  override addMediaItem(item: MediaItem): void {
    super.addMediaItem(item);
    this.history.rebase(this.document);
  }

  /**
   * Swaps the whole document outside the history (project load, reset).
   * @param doc the new document.
   */
  loadDocument(doc: ProjectDocument): void {
    this.document = doc;
    this.rebuild();
    this.history.rebase(doc);
    this.selection.clearSelection();
    this.dirty = false;
    this.onChanged();
  }

  /** Starts a multi-op gesture (drag): buffered until commit. */
  beginGesture(name = 'Gesto'): void {
    if (!this.history.isInTransaction()) this.history.beginTransaction(name);
  }

  /** Commits the running gesture as one undo step. */
  commitGesture(): void {
    if (this.history.isInTransaction()) this.history.commitTransaction();
    this.dirty = true;
    this.onChanged();
  }

  /** Cancels the running gesture (Escape): buffered ops vanish. */
  cancelGesture(): void {
    if (this.history.isInTransaction()) {
      // Buffered ops were never applied; dropping the buffer is enough.
      this.history.cancelTransaction();
    }
    this.onChanged();
  }

  /** Undoes one step. */
  undo(): void {
    const doc = this.history.undo();
    if (doc) {
      this.document = doc;
      this.rebuild();
      this.onChanged();
    }
  }

  /** Redoes one step. */
  redo(): void {
    const doc = this.history.redo();
    if (doc) {
      this.document = doc;
      this.rebuild();
      this.onChanged();
    }
  }

  // ------------------------------------------------------------------
  // High-level commands (used by UI and tests)
  // ------------------------------------------------------------------

  /**
   * Moves a clip to another time/track.
   * @param clipId the clip.
   * @param toTrackId target lane.
   * @param toStart new start in seconds.
   */
  moveClip(clipId: string, toTrackId: string, toStart: number): void {
    const clip = requireClip(this.document, clipId);
    this.run(
      new MoveClipOperation(
        clipId,
        clip.trackId,
        toTrackId,
        Rational.approximate(clip.start) ?? Rational.ZERO,
        Rational.approximate(toStart) ?? Rational.ZERO,
      ),
    );
  }

  /**
   * Trims a clip edge.
   * @param clipId the clip.
   * @param edge which edge.
   * @param toValue the new edge time in seconds.
   */
  trimClip(clipId: string, edge: TrimEdge, toValue: number): void {
    const clip = requireClip(this.document, clipId);
    const fromValue = edge === 'in' ? clip.start : clip.start + clip.duration;
    this.run(
      new TrimClipOperation(
        clipId,
        edge,
        Rational.approximate(fromValue) ?? Rational.ZERO,
        Rational.approximate(toValue) ?? Rational.ZERO,
      ),
    );
  }

  /**
   * Splits a clip in two.
   * @param clipId the clip.
   * @param timeSeconds where to cut.
   * @returns the id of the new tail, or `null` when the cut was invalid.
   */
  splitClip(clipId: string, timeSeconds: number): string | null {
    const clip = requireClip(this.document, clipId);
    const local = timeSeconds - clip.start;
    if (local <= 1 / 60 || local >= clip.duration - 1 / 60) return null;
    const tailId = newId('c-');
    return this.run(
      new SplitClipOperation(clipId, Rational.approximate(timeSeconds) ?? Rational.ZERO, tailId),
    )
      ? tailId
      : null;
  }

  /**
   * Deletes clips (lift or ripple).
   * @param clipIds the clips.
   * @param mode lift keeps the gap, ripple closes it.
   */
  deleteClips(clipIds: string[], mode: DeleteMode = 'lift'): void {
    if (clipIds.length === 1) {
      this.run(new DeleteClipOperation(clipIds[0]!, mode));
    } else {
      this.run(new DeleteClipsOperation(clipIds, mode));
    }
    this.selection.clearSelection();
    this.onChanged();
  }

  /**
   * Inserts a clip built from a media item.
   * @param clip the clip to insert.
   * @param mode insert pushes the tail, overwrite replaces.
   */
  insertClip(clip: DocumentClip, mode: InsertMode = 'overwrite'): void {
    this.run(
      new InsertClipOperation(
        clip,
        clip.trackId,
        Rational.approximate(clip.start) ?? Rational.ZERO,
        mode,
      ),
    );
  }

  /**
   * Inserts a clip built from a library asset — what a media card dropped on
   * the timeline needs. The clip is minted here (`c-…`), so the caller
   * only has to know the asset, the lane and the time.
   * @param mediaId the library asset.
   * @param trackId the destination lane.
   * @param atTime where the clip starts.
   * @param mode insert pushes the tail, overwrite replaces what it covers.
   * @param meta duration/kind/name for assets the document's bin does not
   * know yet (a just-imported file); they win over the bin entry.
   * @returns the id of the inserted clip.
   * @throws when the media is unknown and no duration is supplied, or when
   * the lane refuses the clip (wrong kind, locked document…).
   */
  insertClipFromMedia(
    mediaId: string,
    trackId: string,
    atTime: Rational,
    mode: InsertMode = 'overwrite',
    meta: { durationSeconds?: number; kind?: ClipKind; name?: string } = {},
  ): string {
    const media = this.document.media.find((item) => item.id === mediaId);
    const duration = meta.durationSeconds ?? media?.duration ?? null;
    if (duration === null || !(duration > 0)) throw new Error(`Medio no encontrado: ${mediaId}`);
    const kind: ClipKind =
      meta.kind ?? (media?.kind === 'audio' ? 'audio' : media?.kind === 'image' ? 'image' : 'video');
    const clip = cloneClip(createDefaultClip());
    clip.id = newId('c-');
    clip.mediaId = mediaId;
    clip.trackId = trackId;
    clip.name = meta.name ?? media?.name ?? mediaId;
    clip.kind = kind;
    clip.start = Math.max(0, atTime.asNumber());
    clip.duration = Math.max(1 / 60, duration);
    if (!this.run(new InsertClipOperation(clip, trackId, atTime, mode))) {
      throw new Error(`No se pudo insertar el clip en la pista ${trackId}`);
    }
    return clip.id;
  }

  /**
   * Adds a track.
   * @param kind video or audio.
   * @param index where to place it (default: on top).
   * @returns the new track id, or `null` on failure.
   */
  addTrack(kind: TrackKind, index = 0): string | null {
    const trackId = newId('T-');
    return this.run(new AddTrackOperation(kind, index, undefined, trackId)) ? trackId : null;
  }

  /**
   * Deletes a track and its clips.
   * @param trackId the track.
   */
  deleteTrack(trackId: string): void {
    this.run(new DeleteTrackOperation(trackId));
  }

  /**
   * Groups clips.
   * @param clipIds the clips.
   */
  groupClips(clipIds: string[]): void {
    this.run(new GroupClipsOperation(clipIds));
  }

  /** Ungroups the selection's groups. */
  ungroupClips(clipIds: string[]): void {
    const timeline = currentTimeline(this.document);
    const groupIds = new Set<string>();
    for (const id of clipIds) {
      const clip = timeline.clips.find((candidate) => candidate.id === id);
      const groupId = clip ? (clip.extra['groupId'] ?? null) : null;
      if (typeof groupId === 'string' && groupId !== '') groupIds.add(groupId);
    }
    this.beginGesture('Deshacer grupo');
    for (const groupId of groupIds) this.run(new UngroupClipsOperation(groupId));
    this.commitGesture();
  }

  /**
   * Links video+audio clips.
   * @param clipIds the clips.
   */
  linkClips(clipIds: string[]): void {
    this.run(new LinkClipsOperation(clipIds));
  }

  /** Unlinks the selection's links. */
  unlinkClips(clipIds: string[]): void {
    const timeline = currentTimeline(this.document);
    const linkIds = new Set<string>();
    for (const id of clipIds) {
      const clip = timeline.clips.find((candidate) => candidate.id === id);
      const linkId = clip ? (clip.extra['linkId'] ?? null) : null;
      if (typeof linkId === 'string' && linkId !== '') linkIds.add(linkId);
    }
    this.beginGesture('Desvincular');
    for (const linkId of linkIds) this.run(new UnlinkClipsOperation(linkId));
    this.commitGesture();
  }

  /**
   * Adds a marker.
   * @param timeSeconds where.
   * @param label the text.
   * @param color the color.
   * @returns the marker id, or `null`.
   */
  addMarker(timeSeconds: number, label = '', color = '#ffd166'): string | null {
    const before = currentTimeline(this.document);
    void before;
    const op = new AddMarkerOperation(Rational.approximate(timeSeconds) ?? Rational.ZERO, label, color);
    return this.run(op) ? op.markerId : null;
  }

  /** The ruler markers. */
  markers(): MarkerData[] {
    return readMarkers(this.document);
  }

  /**
   * Sets a clip property (name/enabled/color_label/opacity/volume/fade…).
   * @param clipId the clip.
   * @param property the property name.
   * @param value the new value.
   */
  setClipProperty(clipId: string, property: string, value: Json): void {
    const clip = requireClip(this.document, clipId);
    const old = this.propertyOf(clip, property);
    this.run(new SetClipPropertyOperation(clipId, property, old, value));
  }

  /**
   * Toggles a clip's enabled flag.
   * @param clipId the clip.
   */
  toggleClipEnabled(clipId: string): void {
    this.run(new ToggleClipEnabledOperation(clipId));
  }

  /**
   * Sets the playback speed.
   * @param clipId the clip.
   * @param speed the new rate.
   */
  setSpeed(clipId: string, speed: number): void {
    const clip = requireClip(this.document, clipId);
    this.run(new SetSpeedOperation(clipId, clip.speed, speed, clip.preservePitch));
  }

  /**
   * Adds a keyframe at a clip-relative fraction.
   * @param clipId the clip.
   * @param property the keyed property.
   * @param at fraction `0..1` of the clip.
   * @param value the value there.
   */
  addKeyframe(clipId: string, property: KeyProperty, at: number, value: number): void {
    const clip = requireClip(this.document, clipId);
    const fraction = Math.min(1, Math.max(0, at));
    // AddKeyframe takes timeline seconds; the key stores the 0..1 fraction.
    const timelineTime = clip.start + fraction * clip.duration;
    this.run(
      new AddKeyframeOperation(
        clipId,
        property,
        Rational.approximate(timelineTime) ?? Rational.ZERO,
        value,
        KeyEase.LINEAR,
      ),
    );
  }

  /**
   * Adds or removes a transition on the cut into a clip.
   * @param clipBId the clip the transition flows into.
   * @param kind the transition, or `null` to remove.
   * @param durationSeconds the length.
   */
  setTransition(clipBId: string, kind: TransitionKind | null, durationSeconds = 1): void {
    const timeline = currentTimeline(this.document);
    const clipB = requireClip(this.document, clipBId);
    if (kind === null) {
      if (clipB.transitionIn) this.run(new RemoveTransitionOperation(`tr:${clipBId}:in`));
      return;
    }
    const prev = timeline.clips
      .filter((clip) => clip.trackId === clipB.trackId && clip.id !== clipB.id)
      .filter((clip) => Math.abs(clip.start + clip.duration - clipB.start) < 1e-6)
      .sort((a, b) => a.start - b.start)
      .pop();
    this.run(
      new AddTransitionOperation(
        prev?.id ?? clipBId,
        clipBId,
        kind,
        Rational.approximate(durationSeconds) ?? Rational.ONE,
      ),
    );
  }

  /**
   * Duplicates the selection after the originals.
   * @param clipIds the clips.
   */
  duplicateClips(clipIds: string[]): void {
    const timeline = currentTimeline(this.document);
    const ops: EditOperation[] = [];
    for (const id of clipIds) {
      const clip = timeline.clips.find((candidate) => candidate.id === id);
      if (!clip) continue;
      ops.push(
        new DuplicateClipOperation(
          id,
          clip.trackId,
          Rational.approximate(clip.start + clip.duration) ?? Rational.ZERO,
          newId('c-'),
        ),
      );
    }
    if (ops.length === 1) {
      this.run(ops[0]!);
    } else if (ops.length > 1) {
      this.beginGesture('Duplicar');
      for (const op of ops) this.run(op);
      this.commitGesture();
    }
  }

  /**
   * Copies the selection to the clipboard.
   * @param clipIds the clips.
   */
  copyClips(clipIds: string[]): void {
    this.clipboard.copy(clipIds, this.document);
    this.onChanged();
  }

  /**
   * Cuts the selection (copy + delete, one step).
   * @param clipIds the clips.
   */
  cutClips(clipIds: string[]): void {
    const op = this.clipboard.cut(clipIds, this.document, 'lift');
    this.run(op);
  }

  /**
   * Pastes the clipboard at a point.
   * @param atSeconds where.
   * @param targetTrackId the lane.
   * @param mode insert/overwrite.
   */
  pasteClips(atSeconds: number, targetTrackId: string, mode: InsertMode = 'overwrite'): void {
    try {
      const op = this.clipboard.paste(
        Rational.approximate(atSeconds) ?? Rational.ZERO,
        targetTrackId,
        this.document,
        mode,
      );
      this.run(op);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onError(message, error instanceof Error ? error : new Error(message));
    }
  }

  /**
   * Builds a fresh clip from a media item (for drags from the media bin).
   * @param mediaId the media.
   * @param trackId the lane.
   * @param startSeconds where it starts.
   * @returns the clip (not yet inserted).
   */
  makeClip(mediaId: string, trackId: string, startSeconds: number): DocumentClip {
    const media = this.document.media.find((item) => item.id === mediaId);
    const clip = cloneClip(createDefaultClip());
    clip.id = newId('c-');
    clip.mediaId = mediaId;
    clip.trackId = trackId;
    clip.start = Math.max(0, startSeconds);
    clip.duration = media && media.duration !== null ? media.duration : 1;
    clip.kind = media && media.kind === 'audio' ? 'audio' : 'video';
    if (media && media.kind === 'image') clip.kind = 'image';
    clip.name = media ? media.name : mediaId;
    return clip;
  }

  /** A stub clip matching `defaultDocumentClip` (never mutated). */
  private readonly stub: DocumentClip | null = null;

  /** Reads a property's current Json value (for op old values). */
  // -- Fase 6 hook: export range (in/out points) ------------------------------
  // Session state, not document state: marking a range is not an edit, so it
  // stays out of the undo stack and the saved project.

  private exportIn: Rational | null = null;
  private exportOut: Rational | null = null;

  /** Fase 6 hook: called after the in/out range changes. */
  onExportRangeChange: (() => void) | null = null;

  /** Fase 6 hook: the export in-point, or `null` (timeline start). */
  get inPoint(): Rational | null {
    return this.exportIn;
  }

  /** Fase 6 hook: the export out-point, or `null` (timeline end). */
  get outPoint(): Rational | null {
    return this.exportOut;
  }

  /**
   * Fase 6 hook: marks the in-point (`I`). An out-point at or before it is
   * cleared so the range never inverts.
   * @param time the timeline instant, or `null` to clear.
   */
  setInPoint(time: Rational | null): void {
    this.exportIn = time && time.isNegative() ? Rational.ZERO : time;
    if (this.exportIn && this.exportOut && this.exportOut.compare(this.exportIn) <= 0) this.exportOut = null;
    this.onExportRangeChange?.();
  }

  /**
   * Fase 6 hook: marks the out-point (`O`). An in-point at or after it is
   * cleared so the range never inverts.
   * @param time the timeline instant, or `null` to clear.
   */
  setOutPoint(time: Rational | null): void {
    this.exportOut = time && time.isNegative() ? Rational.ZERO : time;
    if (this.exportIn && this.exportOut && this.exportIn.compare(this.exportOut) >= 0) this.exportIn = null;
    this.onExportRangeChange?.();
  }

  /** Fase 6 hook: clears both points. */
  clearExportRange(): void {
    this.exportIn = null;
    this.exportOut = null;
    this.onExportRangeChange?.();
  }

  /**
   * Fase 6 hook: the range an export covers — the in/out points clamped to
   * the edit, defaulting to the whole timeline.
   * @returns `{ start, end }` (`end` equals `start` for an empty edit).
   */
  exportRange(): { start: Rational; end: Rational } {
    const duration = this.duration();
    const start = (this.exportIn ?? Rational.ZERO).clampTo(Rational.ZERO, duration);
    const end = (this.exportOut ?? duration).clampTo(start, duration);
    return { start, end };
  }

  private propertyOf(clip: DocumentClip, property: string): Json {
    switch (property) {
      case 'name':
        return clip.name;
      case 'enabled':
        return clip.extra['enabled'] ?? true;
      case 'color_label':
        return clip.extra['colorLabel'] ?? '';
      case 'opacity':
        return clip.opacity;
      case 'volume':
        return clip.volume;
      case 'fade_in':
        return clip.fadeIn;
      case 'fade_out':
        return clip.fadeOut;
      case 'pan':
        return clip.extra['pan'] ?? 0;
      case 'blend':
        return clip.blend;
      default:
        return null;
    }
  }
}

/** A minimal fresh clip (the model's default). */
function createDefaultClip(): DocumentClip {
  return {
    id: '',
    trackId: '',
    mediaId: '',
    name: '',
    kind: 'video',
    start: 0,
    duration: 1,
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
}

/** Loads helpers other modules use from here. */
export { CompoundOperation, currentTimeline, requireTrack, trackKindOf };
