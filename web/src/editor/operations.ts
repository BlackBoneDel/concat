// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The atomic edit operations: pure, validated, reversible and (where it
 * makes sense) mergeable. Nothing in the app mutates a `ProjectDocument`
 * except through these — `EditHistory` applies them and keeps their inverses
 * for undo.
 *
 * Conventions:
 * - `apply` never mutates its argument; it returns a cloned, updated copy.
 * - `inverse(before)` receives the document *before* `apply` and returns the
 *   operation that restores exactly that state.
 * - Invalid operations throw {@link EditError} before touching anything.
 * - Document fields the core schema does not carry (markers, groups, links,
 *   track names/locks, clip enabled/labels) live in each struct's `extra`
 *   map, which the model round-trips untouched.
 */

import { Rational } from '../core/rational.ts';
import { Transform } from '../core/timeline.ts';
import {
  activeTimeline,
  type Crop,
  type DocumentClip,
  type DocumentTrack,
  type DocumentTimeline,
  type ProjectDocument,
} from '../model/document.ts';
import {
  KeyEase,
  MIN_CLIP_DURATION,
  type Extra,
  type Json,
  type JsonObject,
  type KeyProperty,
} from '../model/wire.ts';

/** Thrown when an operation cannot run. The UI shows `message` as a toast. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/** The kinds of transition the editor offers (stored as `transition.id`). */
export type TransitionKind =
  | 'crossfade'
  | 'dissolve'
  | 'fade-black'
  | 'fade-white'
  | 'wipe-left'
  | 'wipe-right'
  | 'wipe-up'
  | 'wipe-down'
  | 'slide-left'
  | 'slide-right';

/** Every transition kind, in menu order. */
export const TRANSITION_KINDS: readonly TransitionKind[] = [
  'crossfade',
  'dissolve',
  'fade-black',
  'fade-white',
  'wipe-left',
  'wipe-right',
  'wipe-up',
  'wipe-down',
  'slide-left',
  'slide-right',
];

/** Which edge of a clip a trim touches. */
export type TrimEdge = 'in' | 'out';

/** How a deletion treats the gap it leaves. */
export type DeleteMode = 'lift' | 'ripple';

/** How an insert treats what it lands on. */
export type InsertMode = 'insert' | 'overwrite';

/** Track categories; a clip may only live on a lane of its own kind. */
export type TrackKind = 'video' | 'audio';

/** A timeline marker (stored in `document.extra.markers`). */
export interface MarkerData {
  id: string;
  /** Seconds from timeline zero. */
  time: Rational;
  label: string;
  color: string;
  note: string;
}

/** One undoable edit. */
export interface EditOperation {
  readonly name: string;
  readonly timestamp: number;
  /**
   * Runs the edit.
   * @param doc the current document (never mutated).
   * @returns the updated document.
   * @throws EditError when the edit is not valid.
   */
  apply(doc: ProjectDocument): ProjectDocument;
  /**
   * The operation that undoes this one.
   * @param doc the document *before* `apply`.
   * @returns the restoring operation.
   */
  inverse(doc: ProjectDocument): EditOperation;
  /**
   * Fuses this op with the next one when they are one gesture.
   * @param next the operation that just arrived.
   * @returns the merged operation, or `null` when they stay separate.
   */
  merge?(next: EditOperation): EditOperation | null;
  /** Human description for the history list. */
  describe(): string;
}

// ---------------------------------------------------------------------------
// Shared document helpers
// ---------------------------------------------------------------------------

/** Mints a fresh id. */
export function newId(prefix = ''): string {
  const raw = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prefix === '' ? raw : `${prefix}${raw}`;
}

function cloneJson(value: Json): Json {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) out[key] = cloneJson(item);
  return out;
}

function cloneExtra(extra: Extra): Extra {
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(extra)) out[key] = cloneJson(item);
  return out;
}

/** Deep-copies a clip, keeping `KeyEase` instances intact. */
export function cloneClip(clip: DocumentClip): DocumentClip {
  return {
    ...clip,
    keys: clip.keys.map((key) => ({ ...key, ease: new KeyEase(key.ease.points) })),
    speedCurve: clip.speedCurve ? clip.speedCurve.map((point) => ({ ...point })) : null,
    filters: clip.filters.map((filter) => ({ ...filter })),
    videoEffects: clip.videoEffects.map((filter) => ({ ...filter })),
    crop: clip.crop ? { ...clip.crop } : null,
    transitionIn: clip.transitionIn ? { ...clip.transitionIn } : null,
    text: clip.text ? { ...clip.text } : null,
    shape: clip.shape ? { ...clip.shape } : null,
    extra: cloneExtra(clip.extra),
  };
}

/** Deep-copies a track. */
export function cloneTrack(track: DocumentTrack): DocumentTrack {
  return { ...track, extra: cloneExtra(track.extra) };
}

/** Deep-copies a whole project document. */
export function cloneDocument(doc: ProjectDocument): ProjectDocument {
  return {
    media: doc.media.map((item) => ({
      ...item,
      audioTracks: item.audioTracks.map((track) => ({ ...track })),
      extra: cloneExtra(item.extra),
    })),
    fonts: doc.fonts.map((font) => ({ ...font })),
    timelines: doc.timelines.map((timeline) => ({
      ...timeline,
      video: { ...timeline.video },
      tracks: timeline.tracks.map(cloneTrack),
      clips: timeline.clips.map(cloneClip),
      extra: cloneExtra(timeline.extra),
    })),
    activeTimelineId: doc.activeTimelineId,
    extra: cloneExtra(doc.extra),
  };
}

/** The timeline commands act on. */
export function currentTimeline(doc: ProjectDocument): DocumentTimeline {
  return activeTimeline(doc);
}

/**
 * The clip with `id`.
 * @throws EditError when there is no such clip.
 */
export function requireClip(doc: ProjectDocument, clipId: string): DocumentClip {
  const clip = currentTimeline(doc).clips.find((item) => item.id === clipId);
  if (!clip) throw new EditError(`No existe el clip ${clipId}`);
  return clip;
}

/**
 * The track with `id`.
 * @throws EditError when there is no such track.
 */
export function requireTrack(doc: ProjectDocument, trackId: string): DocumentTrack {
  const track = currentTimeline(doc).tracks.find((item) => item.id === trackId);
  if (!track) throw new EditError(`No existe la pista ${trackId}`);
  return track;
}

/** The track a clip sits on, or `null`. */
export function trackOfClip(doc: ProjectDocument, clipId: string): DocumentTrack | null {
  const clip = currentTimeline(doc).clips.find((item) => item.id === clipId);
  if (!clip) return null;
  return currentTimeline(doc).tracks.find((track) => track.id === clip.trackId) ?? null;
}

/** The category of a lane: every clip sound ⇒ audio, otherwise video. */
export function trackKindOf(doc: ProjectDocument, track: DocumentTrack): TrackKind {
  const explicit = track.extra['kind'];
  if (explicit === 'audio' || explicit === 'video') return explicit;
  const clips = currentTimeline(doc).clips.filter((clip) => clip.trackId === track.id);
  return clips.length > 0 && clips.every((clip) => clip.kind === 'audio') ? 'audio' : 'video';
}

/** A clip's end time on the timeline. */
export function clipEnd(clip: DocumentClip): number {
  return clip.start + clip.duration;
}

/** True when `kind` may sit on a lane of category `kind`. */
export function kindFitsTrack(kind: DocumentClip['kind'], track: TrackKind): boolean {
  return (kind === 'audio') === (track === 'audio');
}

// -- extras the core schema does not carry --------------------------------

/** Group id of a clip, or `null`. */
export function groupIdOf(clip: DocumentClip): string | null {
  const value = clip.extra['groupId'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Link id of a clip, or `null`. */
export function linkIdOf(clip: DocumentClip): string | null {
  const value = clip.extra['linkId'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Clips whose `extra[key]` equals `value`. */
function clipsWithExtra(timeline: DocumentTimeline, key: string, value: string): DocumentClip[] {
  return timeline.clips.filter((clip) => clip.extra[key] === value);
}

/** Clips sharing `id`'s group (including itself). */
export function groupMembers(timeline: DocumentTimeline, clipId: string): string[] {
  const clip = timeline.clips.find((item) => item.id === clipId);
  const group = clip ? groupIdOf(clip) : null;
  if (!group) return [clipId];
  const members = clipsWithExtra(timeline, 'groupId', group).map((item) => item.id);
  return members.length > 0 ? members : [clipId];
}

/** Clips sharing `id`'s link (including itself). */
export function linkMembers(timeline: DocumentTimeline, clipId: string): string[] {
  const clip = timeline.clips.find((item) => item.id === clipId);
  const link = clip ? linkIdOf(clip) : null;
  if (!link) return [clipId];
  const members = clipsWithExtra(timeline, 'linkId', link).map((item) => item.id);
  return members.length > 0 ? members : [clipId];
}

/** A clip is drawn and heard unless `extra.enabled` is exactly `false`. */
export function clipEnabled(clip: DocumentClip): boolean {
  return clip.extra['enabled'] !== false;
}

// -- markers ---------------------------------------------------------------

/** Reads the marker list out of the document's extra. */
export function readMarkers(doc: ProjectDocument): MarkerData[] {
  const raw = doc.extra['markers'];
  if (!Array.isArray(raw)) return [];
  const out: MarkerData[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as JsonObject;
    const id = record['id'];
    const time = record['time'];
    if (typeof id !== 'string' || typeof time !== 'number') continue;
    out.push({
      id,
      time: Rational.approximate(time) ?? Rational.ZERO,
      label: typeof record['label'] === 'string' ? record['label'] : '',
      color: typeof record['color'] === 'string' ? record['color'] : '#ffd166',
      note: typeof record['note'] === 'string' ? record['note'] : '',
    });
  }
  return out;
}

/** Writes the marker list into the document's extra (on a clone). */
export function writeMarkers(doc: ProjectDocument, markers: MarkerData[]): void {
  if (markers.length === 0) {
    delete doc.extra['markers'];
    return;
  }
  doc.extra['markers'] = markers.map((marker) => ({
    id: marker.id,
    time: marker.time.asNumber(),
    label: marker.label,
    color: marker.color,
    note: marker.note,
  }));
}

/** The stable id of a transition: it rides on the clip it enters. */
export function transitionIdOf(clipBId: string): string {
  return `tr:${clipBId}:in`;
}

/** The clip a transition id rides on, or `null`. */
function clipOfTransitionId(transitionId: string): string | null {
  const match = /^tr:(.+):in$/.exec(transitionId);
  return match ? (match[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Internal restore operations (exact inverses of structural edits)
// ---------------------------------------------------------------------------

/** Replaces one track's clip list wholesale — the exact inverse of cuts. */
class RestoreTrackClipsOperation implements EditOperation {
  readonly name = 'RestoreTrackClips';
  readonly timestamp = Date.now();
  private readonly snapshot: DocumentClip[];

  constructor(clips: DocumentClip[]) {
    this.snapshot = clips.map(cloneClip);
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    const trackIds = new Set(this.snapshot.map((clip) => clip.trackId));
    // Also clear clips whose track vanished from the snapshot on that lane.
    const keep = timeline.clips.filter((clip) => !trackIds.has(clip.trackId));
    timeline.clips = [...keep, ...this.snapshot.map(cloneClip)];
    return next;
  }

  inverse(): EditOperation {
    return new NoOpOperation();
  }

  describe(): string {
    return 'Restaurar clips';
  }
}

/** Puts exact clip objects back and removes the ids they replace. */
class RestoreClipsOperation implements EditOperation {
  readonly name = 'RestoreClips';
  readonly timestamp = Date.now();
  private readonly removeIds: string[];
  private readonly clips: DocumentClip[];

  constructor(removeIds: string[], clips: DocumentClip[]) {
    this.removeIds = [...removeIds];
    this.clips = clips.map(cloneClip);
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    timeline.clips = timeline.clips.filter((clip) => !this.removeIds.includes(clip.id));
    timeline.clips.push(...this.clips.map(cloneClip));
    return next;
  }

  inverse(): EditOperation {
    return new NoOpOperation();
  }

  describe(): string {
    return 'Restaurar clips';
  }
}

/** Puts a deleted track (and its clips) back at its index. */
class RestoreTrackOperation implements EditOperation {
  readonly name = 'RestoreTrack';
  readonly timestamp = Date.now();
  private readonly track: DocumentTrack;
  private readonly clips: DocumentClip[];
  private readonly index: number;

  constructor(track: DocumentTrack, clips: DocumentClip[], index: number) {
    this.track = cloneTrack(track);
    this.clips = clips.map(cloneClip);
    this.index = index;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    timeline.tracks.splice(Math.min(this.index, timeline.tracks.length), 0, cloneTrack(this.track));
    timeline.clips.push(...this.clips.map(cloneClip));
    return next;
  }

  inverse(): EditOperation {
    return new NoOpOperation();
  }

  describe(): string {
    return 'Restaurar pista';
  }
}

/** Puts the marker list back — inverses of the marker operations. */
class RestoreMarkersOperation implements EditOperation {
  readonly name = 'RestoreMarkers';
  readonly timestamp = Date.now();
  private readonly markers: MarkerData[];

  constructor(markers: MarkerData[]) {
    this.markers = markers.map((marker) => ({ ...marker }));
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    writeMarkers(next, this.markers.map((marker) => ({ ...marker })));
    return next;
  }

  inverse(): EditOperation {
    return new NoOpOperation();
  }

  describe(): string {
    return 'Restaurar markers';
  }
}

/** The identity operation — placeholder inverses of restore ops. */
class NoOpOperation implements EditOperation {
  readonly name = 'NoOp';
  readonly timestamp = Date.now();

  apply(doc: ProjectDocument): ProjectDocument {
    return cloneDocument(doc);
  }

  inverse(): EditOperation {
    return new NoOpOperation();
  }

  describe(): string {
    return 'Sin cambios';
  }
}

/** Applies a sequence as one undoable unit (transaction commits). */
export class CompoundOperation implements EditOperation {
  readonly name: string;
  readonly timestamp: number;
  private readonly operations: EditOperation[];

  constructor(name: string, operations: EditOperation[]) {
    this.name = name;
    this.operations = [...operations];
    this.timestamp = operations[0]?.timestamp ?? Date.now();
  }

  apply(doc: ProjectDocument): ProjectDocument {
    let next = doc;
    for (const operation of this.operations) next = operation.apply(next);
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    // Inverse of A∘B∘C is invC∘invB∘invA, each captured at its own step.
    const inverses: EditOperation[] = [];
    let state = doc;
    for (const operation of this.operations) {
      inverses.unshift(operation.inverse(state));
      state = operation.apply(state);
    }
    return new CompoundOperation(`undo:${this.name}`, inverses);
  }

  describe(): string {
    return `${this.name} (${this.operations.length} ops)`;
  }

  /** The wrapped operations, for the history list. */
  get items(): readonly EditOperation[] {
    return this.operations;
  }
}

// ---------------------------------------------------------------------------
// 1–2. Move / Trim
// ---------------------------------------------------------------------------

/** Moves a clip in time and/or onto another lane. Merges rapid moves. */
export class MoveClipOperation implements EditOperation {
  readonly name = 'MoveClip';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly fromTrackId: string;
  readonly toTrackId: string;
  readonly fromStart: Rational;
  readonly toStart: Rational;

  constructor(clipId: string, fromTrackId: string, toTrackId: string, fromStart: Rational, toStart: Rational) {
    this.clipId = clipId;
    this.fromTrackId = fromTrackId;
    this.toTrackId = toTrackId;
    this.fromStart = fromStart;
    this.toStart = toStart;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const target = requireTrack(doc, this.toTrackId);
    const kind = trackKindOf(doc, target);
    if (!kindFitsTrack(clip.kind, kind)) {
      throw new EditError(
        `Un clip de ${clip.kind} no puede ir a una pista de ${kind}`,
      );
    }
    if (this.toStart.asNumber() < 0) throw new EditError('El inicio no puede ser negativo');
    const next = cloneDocument(doc);
    const moved = requireClip(next, this.clipId);
    moved.trackId = this.toTrackId;
    moved.start = this.toStart.asNumber();
    return next;
  }

  inverse(): EditOperation {
    return new MoveClipOperation(this.clipId, this.toTrackId, this.fromTrackId, this.toStart, this.fromStart);
  }

  merge(nextOp: EditOperation): EditOperation | null {
    if (nextOp instanceof MoveClipOperation && nextOp.clipId === this.clipId
      && nextOp.fromTrackId === this.toTrackId
      && nextOp.timestamp - this.timestamp <= 300) {
      return new MoveClipOperation(this.clipId, this.fromTrackId, nextOp.toTrackId, this.fromStart, nextOp.toStart);
    }
    return null;
  }

  describe(): string {
    return `Mover clip ${this.clipId}`;
  }
}

/** Trims one edge of a clip. Merges rapid trims of the same edge. */
export class TrimClipOperation implements EditOperation {
  readonly name = 'TrimClip';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly edge: TrimEdge;
  readonly fromValue: Rational;
  readonly toValue: Rational;

  constructor(clipId: string, edge: TrimEdge, fromValue: Rational, toValue: Rational) {
    this.clipId = clipId;
    this.edge = edge;
    this.fromValue = fromValue;
    this.toValue = toValue;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const target = requireClip(next, this.clipId);
    const delta = this.toValue.asNumber() - this.fromValue.asNumber();
    if (this.edge === 'in') {
      const start = clip.start + delta;
      const duration = clip.duration - delta;
      if (duration < MIN_CLIP_DURATION) throw new EditError('El clip no puede durar menos de un fotograma');
      if (clip.sourceStart + delta * clip.speed < 0) throw new EditError('El origen no puede ser negativo');
      target.start = start;
      target.duration = duration;
      target.sourceStart = clip.sourceStart + delta * clip.speed;
    } else {
      const duration = clip.duration + delta;
      if (duration < MIN_CLIP_DURATION) throw new EditError('El clip no puede durar menos de un fotograma');
      const sourceEnd = clip.sourceStart + duration * clip.speed;
      const media = doc.media.find((item) => item.id === clip.mediaId);
      if (media && media.duration !== null && sourceEnd > media.duration + 1e-6) {
        throw new EditError('El clip excede la duración del medio de origen');
      }
      target.duration = duration;
    }
    return next;
  }

  inverse(): EditOperation {
    return new TrimClipOperation(this.clipId, this.edge, this.toValue, this.fromValue);
  }

  merge(nextOp: EditOperation): EditOperation | null {
    if (nextOp instanceof TrimClipOperation && nextOp.clipId === this.clipId
      && nextOp.edge === this.edge
      && nextOp.timestamp - this.timestamp <= 300) {
      return new TrimClipOperation(this.clipId, this.edge, this.fromValue, nextOp.toValue);
    }
    return null;
  }

  describe(): string {
    return `Recortar ${this.edge === 'in' ? 'inicio' : 'final'} de ${this.clipId}`;
  }
}

// ---------------------------------------------------------------------------
// 3–4. Split / Merge
// ---------------------------------------------------------------------------

/** Cuts a clip in two at `splitTime`; B is a brand-new clip. */
export class SplitClipOperation implements EditOperation {
  readonly name = 'SplitClip';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly splitTime: Rational;
  /** The id the second half will carry (pre-minted so undo can merge back). */
  readonly newClipId: string;

  constructor(clipId: string, splitTime: Rational, newClipId?: string) {
    this.clipId = clipId;
    this.splitTime = splitTime;
    this.newClipId = newClipId ?? newId('c-');
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const at = this.splitTime.asNumber();
    if (at <= clip.start + 1e-9 || at >= clip.start + clip.duration - 1e-9) {
      throw new EditError('El punto de corte debe estar dentro del clip');
    }
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    const index = timeline.clips.findIndex((item) => item.id === this.clipId);
    const a = timeline.clips[index]!;
    const b = cloneClip(a);
    const headDuration = at - a.start;
    a.duration = headDuration;

    // The tail keeps every property but re-anchors in time and source.
    b.id = this.newClipId;
    b.start = at;
    b.duration = clip.duration - headDuration;
    b.sourceStart = clip.sourceStart + headDuration * clip.speed;
    // Keys are clip fractions: they stay in place relative to each half.
    b.transitionIn = null;
    // A transition out of the head rides onto the tail (the cut moves).
    if (a.transitionIn && a.transitionIn !== b.transitionIn) {
      // transitionIn belongs to the cut INTO the clip; the head keeps it.
    }
    timeline.clips.splice(index + 1, 0, b);
    return next;
  }

  inverse(): EditOperation {
    return new MergeClipsOperation(this.clipId, this.newClipId);
  }

  describe(): string {
    return `Dividir clip ${this.clipId}`;
  }
}

/** Joins two contiguous clips from the same media into one. */
export class MergeClipsOperation implements EditOperation {
  readonly name = 'MergeClips';
  readonly timestamp = Date.now();
  readonly clipAId: string;
  readonly clipBId: string;

  constructor(clipAId: string, clipBId: string) {
    this.clipAId = clipAId;
    this.clipBId = clipBId;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const a = requireClip(doc, this.clipAId);
    const b = requireClip(doc, this.clipBId);
    if (a.trackId !== b.trackId) throw new EditError('Los clips deben estar en la misma pista');
    if (a.mediaId !== b.mediaId) throw new EditError('Los clips deben venir del mismo medio');
    if (Math.abs(clipEnd(a) - b.start) > 1e-6) throw new EditError('Los clips deben ser contiguos');

    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    const merged = requireClip(next, this.clipAId);
    merged.duration = a.duration + b.duration;
    // The head keeps its keys (fractions rescale through the new duration).
    timeline.clips = timeline.clips.filter((clip) => clip.id !== this.clipBId);
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    // Exact: put the two original halves back and drop the merged clip.
    const a = requireClip(doc, this.clipAId);
    const b = requireClip(doc, this.clipBId);
    return new RestoreClipsOperation([this.clipAId], [cloneClip(a), cloneClip(b)]);
  }

  describe(): string {
    return `Unir clips ${this.clipAId} + ${this.clipBId}`;
  }
}

// ---------------------------------------------------------------------------
// 5–7. Insert / Delete
// ---------------------------------------------------------------------------

/** Places a clip on a lane, pushing (insert) or trimming (overwrite). */
export class InsertClipOperation implements EditOperation {
  readonly name = 'InsertClip';
  readonly timestamp = Date.now();
  readonly clip: DocumentClip;
  readonly trackId: string;
  readonly atTime: Rational;
  readonly mode: InsertMode;

  constructor(clip: DocumentClip, trackId: string, atTime: Rational, mode: InsertMode) {
    this.clip = cloneClip(clip);
    this.trackId = trackId;
    this.atTime = atTime;
    this.mode = mode;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const track = requireTrack(doc, this.trackId);
    const kind = trackKindOf(doc, track);
    if (!kindFitsTrack(this.clip.kind, kind)) {
      throw new EditError(`Un clip de ${this.clip.kind} no puede ir a una pista de ${kind}`);
    }
    const at = this.atTime.asNumber();
    if (at < 0) throw new EditError('El inicio no puede ser negativo');

    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    const placed = cloneClip(this.clip);
    placed.trackId = this.trackId;
    placed.start = at;

    const laneClips = timeline.clips.filter((clip) => clip.trackId === this.trackId);
    if (this.mode === 'insert') {
      // Everything at or after the insertion point slides right.
      for (const clip of laneClips) {
        if (clip.start >= at - 1e-9) clip.start += placed.duration;
      }
    } else {
      // Overwrite: trim or drop what the new clip covers.
      const end = at + placed.duration;
      for (const clip of laneClips) {
        const clipStart = clip.start;
        const clipStop = clipEnd(clip);
        if (clipStop <= at + 1e-9 || clipStart >= end - 1e-9) continue;
        if (clipStart >= at - 1e-9 && clipStop <= end + 1e-9) {
          timeline.clips = timeline.clips.filter((item) => item.id !== clip.id);
        } else if (clipStart < at) {
          clip.duration = at - clipStart;
        } else {
          const eaten = end - clipStart;
          clip.start = end;
          clip.duration = clip.duration - eaten;
          clip.sourceStart = clip.sourceStart + eaten * clip.speed;
        }
      }
    }
    timeline.clips.push(placed);
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    // Exact: the lane's clip list goes back to its pre-insert shape.
    const lane = currentTimeline(doc)
      .clips
      .filter((clip) => clip.trackId === this.trackId);
    return new RestoreTrackClipsOperation(lane);
  }

  describe(): string {
    return `Insertar clip en ${this.trackId}`;
  }
}

/** Removes one clip, optionally pulling the rest of the lane closed. */
export class DeleteClipOperation implements EditOperation {
  readonly name = 'DeleteClip';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly mode: DeleteMode;

  constructor(clipId: string, mode: DeleteMode = 'lift') {
    this.clipId = clipId;
    this.mode = mode;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    const duration = clip.duration;
    timeline.clips = timeline.clips.filter((item) => item.id !== this.clipId);
    if (this.mode === 'ripple') {
      for (const other of timeline.clips) {
        if (other.trackId === clip.trackId && other.start >= clip.start - 1e-9) {
          other.start = Math.max(0, other.start - duration);
        }
      }
    }
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    return new DeleteClipsOperation([this.clipId], this.mode).inverse(doc);
  }

  describe(): string {
    return `Eliminar clip ${this.clipId}`;
  }
}

/** Removes several clips at once; ripple closes each lane's gaps. */
export class DeleteClipsOperation implements EditOperation {
  readonly name = 'DeleteClips';
  readonly timestamp = Date.now();
  readonly clipIds: string[];
  readonly mode: DeleteMode;

  constructor(clipIds: string[], mode: DeleteMode = 'lift') {
    this.clipIds = [...clipIds];
    this.mode = mode;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    for (const id of this.clipIds) requireClip(doc, id);
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    const removed = timeline.clips.filter((clip) => this.clipIds.includes(clip.id));
    timeline.clips = timeline.clips.filter((clip) => !this.clipIds.includes(clip.id));
    if (this.mode === 'ripple') {
      // Each removed clip closes its own gap on its lane, latest first.
      const byTrack = new Map<string, DocumentClip[]>();
      for (const clip of removed) {
        const list = byTrack.get(clip.trackId) ?? [];
        list.push(clip);
        byTrack.set(clip.trackId, list);
      }
      for (const [trackId, clips] of byTrack) {
        const ordered = [...clips].sort((a, b) => b.start - a.start);
        for (const gone of ordered) {
          for (const other of timeline.clips) {
            if (other.trackId === trackId && other.start >= gone.start - 1e-9) {
              other.start = Math.max(0, other.start - gone.duration);
            }
          }
        }
      }
    }
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const timeline = currentTimeline(doc);
    const laneIds = new Set(
      timeline.clips.filter((clip) => this.clipIds.includes(clip.id)).map((clip) => clip.trackId),
    );
    const snapshot = timeline.clips.filter((clip) => laneIds.has(clip.trackId));
    return new RestoreTrackClipsOperation(snapshot);
  }

  describe(): string {
    return `Eliminar ${this.clipIds.length} clip(s)`;
  }
}

// ---------------------------------------------------------------------------
// 8–11. Ripple / Roll / Slip / Slide
// ---------------------------------------------------------------------------

/** Trims an edge and pulls the rest of the lane with it. */
export class RippleEditOperation implements EditOperation {
  readonly name = 'RippleEdit';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly edge: TrimEdge;
  readonly delta: Rational;

  constructor(clipId: string, edge: TrimEdge, delta: Rational) {
    this.clipId = clipId;
    this.edge = edge;
    this.delta = delta;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    const target = requireClip(next, this.clipId);
    const delta = this.delta.asNumber();

    if (this.edge === 'in') {
      const duration = clip.duration - delta;
      if (duration < MIN_CLIP_DURATION) throw new EditError('El clip no puede durar menos de un fotograma');
      if (clip.sourceStart + delta * clip.speed < 0) throw new EditError('El origen no puede ser negativo');
      target.start = clip.start + delta;
      target.duration = duration;
      target.sourceStart = clip.sourceStart + delta * clip.speed;
      for (const other of timeline.clips) {
        if (other.trackId === clip.trackId && other.id !== clip.id && other.start >= clip.start - 1e-9) {
          other.start = Math.max(0, other.start + delta);
        }
      }
    } else {
      const duration = clip.duration + delta;
      if (duration < MIN_CLIP_DURATION) throw new EditError('El clip no puede durar menos de un fotograma');
      const media = doc.media.find((item) => item.id === clip.mediaId);
      const sourceEnd = clip.sourceStart + duration * clip.speed;
      if (media && media.duration !== null && sourceEnd > media.duration + 1e-6) {
        throw new EditError('El clip excede la duración del medio de origen');
      }
      target.duration = duration;
      for (const other of timeline.clips) {
        if (other.trackId === clip.trackId && other.id !== clip.id && other.start > clip.start + 1e-9) {
          other.start = Math.max(0, other.start + delta);
        }
      }
    }
    return next;
  }

  inverse(): EditOperation {
    return new RippleEditOperation(this.clipId, this.edge, Rational.ZERO.sub(this.delta));
  }

  describe(): string {
    return `Ripple edit ${this.clipId}`;
  }
}

/** Rolls the cut between two contiguous clips. */
export class RollEditOperation implements EditOperation {
  readonly name = 'RollEdit';
  readonly timestamp = Date.now();
  readonly clipAId: string;
  readonly clipBId: string;
  readonly delta: Rational;

  constructor(clipAId: string, clipBId: string, delta: Rational) {
    this.clipAId = clipAId;
    this.clipBId = clipBId;
    this.delta = delta;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const a = requireClip(doc, this.clipAId);
    const b = requireClip(doc, this.clipBId);
    if (Math.abs(clipEnd(a) - b.start) > 1e-6) throw new EditError('Los clips deben ser contiguos');
    const delta = this.delta.asNumber();
    if (a.duration + delta < MIN_CLIP_DURATION || b.duration - delta < MIN_CLIP_DURATION) {
      throw new EditError('Ambos clips deben seguir durando al menos un fotograma');
    }
    const next = cloneDocument(doc);
    const nextA = requireClip(next, this.clipAId);
    const nextB = requireClip(next, this.clipBId);
    nextA.duration = a.duration + delta;
    nextB.start = b.start + delta;
    nextB.duration = b.duration - delta;
    nextB.sourceStart = b.sourceStart + delta * b.speed;
    return next;
  }

  inverse(): EditOperation {
    return new RollEditOperation(this.clipAId, this.clipBId, Rational.ZERO.sub(this.delta));
  }

  describe(): string {
    return `Roll edit ${this.clipAId}/${this.clipBId}`;
  }
}

/** Slips the source window under a fixed timeline clip. */
export class SlipClipOperation implements EditOperation {
  readonly name = 'SlipClip';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly delta: Rational;

  constructor(clipId: string, delta: Rational) {
    this.clipId = clipId;
    this.delta = delta;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const sourceStart = clip.sourceStart + this.delta.asNumber() * clip.speed;
    if (sourceStart < 0) throw new EditError('El origen no puede ser negativo');
    const media = doc.media.find((item) => item.id === clip.mediaId);
    const sourceEnd = sourceStart + clip.duration * clip.speed;
    if (media && media.duration !== null && sourceEnd > media.duration + 1e-6) {
      throw new EditError('El clip excede la duración del medio de origen');
    }
    const next = cloneDocument(doc);
    requireClip(next, this.clipId).sourceStart = sourceStart;
    return next;
  }

  inverse(): EditOperation {
    return new SlipClipOperation(this.clipId, Rational.ZERO.sub(this.delta));
  }

  describe(): string {
    return `Slip clip ${this.clipId}`;
  }
}

/** Slides a clip along the lane, absorbing the change into its neighbours. */
export class SlideClipOperation implements EditOperation {
  readonly name = 'SlideClip';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly delta: Rational;

  constructor(clipId: string, delta: Rational) {
    this.clipId = clipId;
    this.delta = delta;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const delta = this.delta.asNumber();
    const start = clip.start + delta;
    if (start < 0) throw new EditError('El inicio no puede ser negativo');
    const timeline = currentTimeline(doc);
    const lane = timeline.clips
      .filter((item) => item.trackId === clip.trackId && item.id !== clip.id)
      .sort((a, b) => a.start - b.start);
    const prev = [...lane].reverse().find((item) => clipEnd(item) <= clip.start + 1e-6);
    const next = lane.find((item) => item.start >= clipEnd(clip) - 1e-6);
    if (!prev || !next) throw new EditError('El slide necesita clips adyacentes a ambos lados');
    if (prev.duration + delta < MIN_CLIP_DURATION) throw new EditError('El clip anterior no puede encogerse más');
    if (next.duration - delta < MIN_CLIP_DURATION) throw new EditError('El clip siguiente no puede encogerse más');

    const out = cloneDocument(doc);
    const clips = currentTimeline(out).clips;
    const moved = clips.find((item) => item.id === this.clipId)!;
    const prevOut = clips.find((item) => item.id === prev.id)!;
    const nextOut = clips.find((item) => item.id === next.id)!;
    moved.start = start;
    // The clip slides over the cut on each side: the previous clip grows by
    // what the move vacates, the next one is trimmed from its head (its
    // source in-point does not move).
    prevOut.duration = prev.duration + delta;
    nextOut.start = next.start + delta;
    nextOut.duration = next.duration - delta;
    return out;
  }

  inverse(): EditOperation {
    return new SlideClipOperation(this.clipId, Rational.ZERO.sub(this.delta));
  }

  describe(): string {
    return `Slide clip ${this.clipId}`;
  }
}

// ---------------------------------------------------------------------------
// 12–15. Track structure
// ---------------------------------------------------------------------------

/** Adds a lane. Inverse removes it even when it is the last one. */
export class AddTrackOperation implements EditOperation {
  readonly name = 'AddTrack';
  readonly timestamp = Date.now();
  readonly kind: TrackKind;
  readonly index: number;
  readonly trackName: string | undefined;
  /** The id the new lane will carry (pre-minted for a stable inverse). */
  readonly newTrackId: string;

  constructor(kind: TrackKind, index: number, name?: string, newTrackId?: string) {
    this.kind = kind;
    this.index = index;
    this.trackName = name;
    this.newTrackId = newTrackId ?? newId('T-');
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    if (timeline.tracks.some((track) => track.id === this.newTrackId)) {
      throw new EditError(`La pista ${this.newTrackId} ya existe`);
    }
    const track: DocumentTrack = {
      id: this.newTrackId,
      visible: true,
      muted: false,
      extra: this.trackName
        ? { kind: this.kind, name: this.trackName }
        : { kind: this.kind },
    };
    const at = Math.max(0, Math.min(this.index, timeline.tracks.length));
    timeline.tracks.splice(at, 0, track);
    return next;
  }

  inverse(): EditOperation {
    return new RemoveTrackInternalOperation(this.newTrackId);
  }

  describe(): string {
    return `Añadir pista de ${this.kind}`;
  }
}

/** Deletes a lane and everything on it. */
export class DeleteTrackOperation implements EditOperation {
  readonly name = 'DeleteTrack';
  readonly timestamp = Date.now();
  readonly trackId: string;

  constructor(trackId: string) {
    this.trackId = trackId;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const timeline = currentTimeline(doc);
    requireTrack(doc, this.trackId);
    if (timeline.tracks.length <= 1) throw new EditError('El proyecto debe conservar al menos una pista');
    return removeTrack(doc, this.trackId);
  }

  inverse(doc: ProjectDocument): EditOperation {
    return restoreTrackInverse(doc, this.trackId);
  }

  describe(): string {
    return `Eliminar pista ${this.trackId}`;
  }
}

/** Deletes a lane without the last-track rule (undo of AddTrack). */
class RemoveTrackInternalOperation implements EditOperation {
  readonly name = 'RemoveTrack';
  readonly timestamp = Date.now();
  private readonly trackId: string;

  constructor(trackId: string) {
    this.trackId = trackId;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireTrack(doc, this.trackId);
    return removeTrack(doc, this.trackId);
  }

  inverse(doc: ProjectDocument): EditOperation {
    return restoreTrackInverse(doc, this.trackId);
  }

  describe(): string {
    return `Eliminar pista ${this.trackId}`;
  }
}

function removeTrack(doc: ProjectDocument, trackId: string): ProjectDocument {
  const next = cloneDocument(doc);
  const timeline = currentTimeline(next);
  timeline.tracks = timeline.tracks.filter((track) => track.id !== trackId);
  timeline.clips = timeline.clips.filter((clip) => clip.trackId !== trackId);
  return next;
}

function restoreTrackInverse(doc: ProjectDocument, trackId: string): EditOperation {
  const timeline = currentTimeline(doc);
  const index = timeline.tracks.findIndex((track) => track.id === trackId);
  const track = timeline.tracks[index];
  if (!track || index < 0) return new NoOpOperation();
  const clips = timeline.clips.filter((clip) => clip.trackId === trackId);
  return new RestoreTrackOperation(track, clips, index);
}

/** Moves a lane up or down the stack. */
export class ReorderTracksOperation implements EditOperation {
  readonly name = 'ReorderTracks';
  readonly timestamp = Date.now();
  readonly trackId: string;
  readonly fromIndex: number;
  readonly toIndex: number;

  constructor(trackId: string, fromIndex: number, toIndex: number) {
    this.trackId = trackId;
    this.fromIndex = fromIndex;
    this.toIndex = toIndex;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireTrack(doc, this.trackId);
    const next = cloneDocument(doc);
    const tracks = currentTimeline(next).tracks;
    if (this.fromIndex < 0 || this.fromIndex >= tracks.length) {
      throw new EditError('Índice de pista fuera de rango');
    }
    const [moved] = tracks.splice(this.fromIndex, 1);
    if (!moved) throw new EditError('Índice de pista fuera de rango');
    tracks.splice(Math.max(0, Math.min(this.toIndex, tracks.length)), 0, moved);
    return next;
  }

  inverse(): EditOperation {
    return new ReorderTracksOperation(this.trackId, this.toIndex, this.fromIndex);
  }

  describe(): string {
    return `Reordenar pista ${this.trackId}`;
  }
}

/** Renames a lane (stored in its extra). */
export class RenameTrackOperation implements EditOperation {
  readonly name = 'RenameTrack';
  readonly timestamp = Date.now();
  readonly trackId: string;
  readonly oldName: string;
  readonly newName: string;

  constructor(trackId: string, oldName: string, newName: string) {
    this.trackId = trackId;
    this.oldName = oldName;
    this.newName = newName;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireTrack(doc, this.trackId);
    const next = cloneDocument(doc);
    const track = requireTrack(next, this.trackId);
    // The name defaults to the id: the key only exists when renamed.
    if (this.newName === track.id) delete track.extra['name'];
    else track.extra['name'] = this.newName;
    return next;
  }

  inverse(): EditOperation {
    return new RenameTrackOperation(this.trackId, this.newName, this.oldName);
  }

  merge(nextOp: EditOperation): EditOperation | null {
    if (nextOp instanceof RenameTrackOperation && nextOp.trackId === this.trackId
      && nextOp.timestamp - this.timestamp <= 300) {
      return new RenameTrackOperation(this.trackId, this.oldName, nextOp.newName);
    }
    return null;
  }

  describe(): string {
    return `Renombrar pista a "${this.newName}"`;
  }
}

/** Flips one track flag: muted, solo, locked, hidden or colour. */
export class SetTrackPropertyOperation implements EditOperation {
  readonly name = 'SetTrackProperty';
  readonly timestamp = Date.now();
  readonly trackId: string;
  readonly property: 'muted' | 'solo' | 'locked' | 'hidden' | 'color';
  readonly oldValue: Json;
  readonly newValue: Json;

  constructor(trackId: string, property: 'muted' | 'solo' | 'locked' | 'hidden' | 'color', oldValue: Json, newValue: Json) {
    this.trackId = trackId;
    this.property = property;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireTrack(doc, this.trackId);
    const next = cloneDocument(doc);
    const track = requireTrack(next, this.trackId);
    if (this.property === 'muted') {
      if (typeof this.newValue !== 'boolean') throw new EditError('muted debe ser booleano');
      track.muted = this.newValue;
    } else if (this.property === 'hidden') {
      if (typeof this.newValue !== 'boolean') throw new EditError('hidden debe ser booleano');
      track.visible = !this.newValue;
    } else {
      track.extra[this.property] = cloneJson(this.newValue);
    }
    return next;
  }

  inverse(): EditOperation {
    return new SetTrackPropertyOperation(this.trackId, this.property, this.newValue, this.oldValue);
  }

  describe(): string {
    return `Cambiar ${this.property} de ${this.trackId}`;
  }
}

// ---------------------------------------------------------------------------
// 16–20. Groups and links
// ---------------------------------------------------------------------------

/** Tags clips with a shared group id so they move as one. */
export class GroupClipsOperation implements EditOperation {
  readonly name = 'GroupClips';
  readonly timestamp = Date.now();
  readonly clipIds: string[];
  readonly groupId: string;

  constructor(clipIds: string[], groupId?: string) {
    this.clipIds = [...clipIds];
    this.groupId = groupId ?? newId('g-');
  }

  apply(doc: ProjectDocument): ProjectDocument {
    if (this.clipIds.length < 2) throw new EditError('Se necesitan al menos dos clips para agrupar');
    for (const id of this.clipIds) requireClip(doc, id);
    const next = cloneDocument(doc);
    for (const clip of currentTimeline(next).clips) {
      if (this.clipIds.includes(clip.id)) clip.extra['groupId'] = this.groupId;
    }
    return next;
  }

  inverse(): EditOperation {
    return new UngroupClipsOperation(this.groupId, this.clipIds);
  }

  describe(): string {
    return `Agrupar ${this.clipIds.length} clips`;
  }
}

/** Dissolves a group. */
export class UngroupClipsOperation implements EditOperation {
  readonly name = 'UngroupClips';
  readonly timestamp = Date.now();
  readonly groupId: string;
  private readonly memberIds: string[] | null;

  constructor(groupId: string, memberIds?: string[]) {
    this.groupId = groupId;
    this.memberIds = memberIds ? [...memberIds] : null;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const members = clipsWithExtra(currentTimeline(next), 'groupId', this.groupId);
    if (members.length === 0) throw new EditError(`No existe el grupo ${this.groupId}`);
    for (const clip of members) delete clip.extra['groupId'];
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const ids = this.memberIds
      ?? clipsWithExtra(currentTimeline(doc), 'groupId', this.groupId).map((clip) => clip.id);
    return new GroupClipsOperation(ids, this.groupId);
  }

  describe(): string {
    return 'Desagrupar clips';
  }
}

/** Links clips (typically the video and audio of one take). */
export class LinkClipsOperation implements EditOperation {
  readonly name = 'LinkClips';
  readonly timestamp = Date.now();
  readonly clipIds: string[];
  readonly linkId: string;

  constructor(clipIds: string[], linkId?: string) {
    this.clipIds = [...clipIds];
    this.linkId = linkId ?? newId('l-');
  }

  apply(doc: ProjectDocument): ProjectDocument {
    if (this.clipIds.length < 2) throw new EditError('Se necesitan al menos dos clips para vincular');
    for (const id of this.clipIds) requireClip(doc, id);
    const next = cloneDocument(doc);
    for (const clip of currentTimeline(next).clips) {
      if (this.clipIds.includes(clip.id)) clip.extra['linkId'] = this.linkId;
    }
    return next;
  }

  inverse(): EditOperation {
    return new UnlinkClipsOperation(this.linkId, this.clipIds);
  }

  describe(): string {
    return `Vincular ${this.clipIds.length} clips`;
  }
}

/** Removes a link. */
export class UnlinkClipsOperation implements EditOperation {
  readonly name = 'UnlinkClips';
  readonly timestamp = Date.now();
  readonly linkId: string;
  private readonly memberIds: string[] | null;

  constructor(linkId: string, memberIds?: string[]) {
    this.linkId = linkId;
    this.memberIds = memberIds ? [...memberIds] : null;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const members = clipsWithExtra(currentTimeline(next), 'linkId', this.linkId);
    if (members.length === 0) throw new EditError(`No existe el vínculo ${this.linkId}`);
    for (const clip of members) delete clip.extra['linkId'];
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const ids = this.memberIds
      ?? clipsWithExtra(currentTimeline(doc), 'linkId', this.linkId).map((clip) => clip.id);
    return new LinkClipsOperation(ids, this.linkId);
  }

  describe(): string {
    return 'Desvincular clips';
  }
}

// ---------------------------------------------------------------------------
// 21–23. Transitions (they ride on the clip they enter)
// ---------------------------------------------------------------------------

/** Puts a transition on the cut between two contiguous clips. */
export class AddTransitionOperation implements EditOperation {
  readonly name = 'AddTransition';
  readonly timestamp = Date.now();
  readonly clipAId: string;
  readonly clipBId: string;
  readonly kind: TransitionKind;
  readonly duration: Rational;

  constructor(clipAId: string, clipBId: string, kind: TransitionKind, duration: Rational) {
    this.clipAId = clipAId;
    this.clipBId = clipBId;
    this.kind = kind;
    this.duration = duration;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const a = requireClip(doc, this.clipAId);
    const b = requireClip(doc, this.clipBId);
    if (Math.abs(clipEnd(a) - b.start) > 1e-6) throw new EditError('Los clips deben ser contiguos');
    const seconds = this.duration.asNumber();
    if (seconds <= 0) throw new EditError('La transición debe durar más de cero');
    const limit = Math.min(a.duration, b.duration) / 2;
    if (seconds > limit + 1e-9) {
      throw new EditError('La transición no puede durar más de la mitad del clip más corto');
    }
    const next = cloneDocument(doc);
    requireClip(next, this.clipBId).transitionIn = { id: this.kind, duration: seconds };
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const b = requireClip(doc, this.clipBId);
    return new RestoreTransitionOperation(this.clipBId, b.transitionIn ? { ...b.transitionIn } : null);
  }

  describe(): string {
    return `Añadir transición ${this.kind}`;
  }
}

/** Removes the transition on a cut. */
export class RemoveTransitionOperation implements EditOperation {
  readonly name = 'RemoveTransition';
  readonly timestamp = Date.now();
  readonly transitionId: string;

  constructor(transitionId: string) {
    this.transitionId = transitionId;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clipBId = clipOfTransitionId(this.transitionId);
    if (!clipBId) throw new EditError(`Transición desconocida ${this.transitionId}`);
    const clip = requireClip(doc, clipBId);
    if (!clip.transitionIn) throw new EditError('El clip no tiene transición de entrada');
    const next = cloneDocument(doc);
    requireClip(next, clipBId).transitionIn = null;
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const clipBId = clipOfTransitionId(this.transitionId);
    const clip = clipBId ? requireClip(doc, clipBId) : null;
    return new RestoreTransitionOperation(
      clipBId ?? '',
      clip?.transitionIn ? { ...clip.transitionIn } : null,
    );
  }

  describe(): string {
    return 'Eliminar transición';
  }
}

/** Puts a stored transition back (inverses of add/remove). */
class RestoreTransitionOperation implements EditOperation {
  readonly name = 'RestoreTransition';
  readonly timestamp = Date.now();
  private readonly clipBId: string;
  private readonly transition: { id: string; duration: number } | null;

  constructor(clipBId: string, transition: { id: string; duration: number } | null) {
    this.clipBId = clipBId;
    this.transition = transition ? { ...transition } : null;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    requireClip(next, this.clipBId).transitionIn = this.transition ? { ...this.transition } : null;
    return next;
  }

  inverse(): EditOperation {
    return new NoOpOperation();
  }

  describe(): string {
    return 'Restaurar transición';
  }
}

/** Edits one field of a transition (kind or duration). */
export class SetTransitionPropertyOperation implements EditOperation {
  readonly name = 'SetTransitionProperty';
  readonly timestamp = Date.now();
  readonly transitionId: string;
  readonly property: string;
  readonly oldValue: Json;
  readonly newValue: Json;

  constructor(transitionId: string, property: string, oldValue: Json, newValue: Json) {
    this.transitionId = transitionId;
    this.property = property;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clipBId = clipOfTransitionId(this.transitionId);
    if (!clipBId) throw new EditError(`Transición desconocida ${this.transitionId}`);
    const clip = requireClip(doc, clipBId);
    if (!clip.transitionIn) throw new EditError('El clip no tiene transición de entrada');
    const next = cloneDocument(doc);
    const transition = requireClip(next, clipBId).transitionIn!;
    if (this.property === 'duration') {
      if (typeof this.newValue !== 'number' || this.newValue <= 0) {
        throw new EditError('La duración debe ser un número positivo');
      }
      transition.duration = this.newValue;
    } else if (this.property === 'kind') {
      if (typeof this.newValue !== 'string' || !TRANSITION_KINDS.includes(this.newValue as TransitionKind)) {
        throw new EditError(`Tipo de transición desconocido: ${String(this.newValue)}`);
      }
      transition.id = this.newValue;
    } else {
      throw new EditError(`Propiedad de transición desconocida: ${this.property}`);
    }
    return next;
  }

  inverse(): EditOperation {
    return new SetTransitionPropertyOperation(this.transitionId, this.property, this.newValue, this.oldValue);
  }

  describe(): string {
    return `Cambiar ${this.property} de la transición`;
  }
}

// ---------------------------------------------------------------------------
// 24–26. Markers
// ---------------------------------------------------------------------------

/** Drops a marker on the ruler. */
export class AddMarkerOperation implements EditOperation {
  readonly name = 'AddMarker';
  readonly timestamp = Date.now();
  readonly time: Rational;
  readonly label: string;
  readonly color: string;
  readonly markerId: string;

  constructor(time: Rational, label: string, color = '#ffd166', markerId?: string) {
    this.time = time;
    this.label = label;
    this.color = color;
    this.markerId = markerId ?? newId('m-');
  }

  apply(doc: ProjectDocument): ProjectDocument {
    if (this.time.asNumber() < 0) throw new EditError('El marker no puede ir antes del inicio');
    const next = cloneDocument(doc);
    const markers = readMarkers(next);
    markers.push({
      id: this.markerId,
      time: this.time,
      label: this.label,
      color: this.color,
      note: '',
    });
    markers.sort((a, b) => a.time.asNumber() - b.time.asNumber());
    writeMarkers(next, markers);
    return next;
  }

  inverse(): EditOperation {
    return new RemoveMarkerOperation(this.markerId).asUndo();
  }

  describe(): string {
    return `Añadir marker "${this.label}"`;
  }
}

/** Deletes a marker. */
export class RemoveMarkerOperation implements EditOperation {
  readonly name = 'RemoveMarker';
  readonly timestamp = Date.now();
  readonly markerId: string;
  private silent = false;

  constructor(markerId: string) {
    this.markerId = markerId;
  }

  /** Marks this instance as the inverse of an add (never fails). */
  asUndo(): RemoveMarkerOperation {
    this.silent = true;
    return this;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const markers = readMarkers(next);
    const exists = markers.some((marker) => marker.id === this.markerId);
    if (!exists && !this.silent) throw new EditError(`No existe el marker ${this.markerId}`);
    writeMarkers(next, markers.filter((marker) => marker.id !== this.markerId));
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    return new RestoreMarkersOperation(readMarkers(doc).map((item) => ({ ...item })));
  }

  describe(): string {
    return 'Eliminar marker';
  }
}

/** Edits a marker's label, colour or note. */
export class UpdateMarkerOperation implements EditOperation {
  readonly name = 'UpdateMarker';
  readonly timestamp = Date.now();
  readonly markerId: string;
  readonly oldData: Partial<MarkerData>;
  readonly newData: Partial<MarkerData>;

  constructor(markerId: string, oldData: Partial<MarkerData>, newData: Partial<MarkerData>) {
    this.markerId = markerId;
    this.oldData = { ...oldData };
    this.newData = { ...newData };
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const markers = readMarkers(next);
    const marker = markers.find((item) => item.id === this.markerId);
    if (!marker) throw new EditError(`No existe el marker ${this.markerId}`);
    if (this.newData.label !== undefined) marker.label = this.newData.label;
    if (this.newData.color !== undefined) marker.color = this.newData.color;
    if (this.newData.note !== undefined) marker.note = this.newData.note;
    if (this.newData.time !== undefined) marker.time = this.newData.time;
    markers.sort((a, b) => a.time.asNumber() - b.time.asNumber());
    writeMarkers(next, markers);
    return next;
  }

  inverse(): EditOperation {
    return new UpdateMarkerOperation(this.markerId, this.newData, this.oldData);
  }

  describe(): string {
    return `Editar marker ${this.markerId}`;
  }
}

// ---------------------------------------------------------------------------
// 27–35. Clip properties, keyframes, speed, crop, duplicates
// ---------------------------------------------------------------------------

/** Sets one simple clip property. Merges rapid edits of the same field. */
export class SetClipPropertyOperation implements EditOperation {
  readonly name = 'SetClipProperty';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly property: string;
  readonly oldValue: Json;
  readonly newValue: Json;

  constructor(clipId: string, property: string, oldValue: Json, newValue: Json) {
    this.clipId = clipId;
    this.property = property;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const clip = requireClip(next, this.clipId);
    switch (this.property) {
      case 'name':
        if (typeof this.newValue !== 'string') throw new EditError('name debe ser texto');
        clip.name = this.newValue;
        break;
      case 'enabled':
        if (typeof this.newValue !== 'boolean') throw new EditError('enabled debe ser booleano');
        // Enabled is the default: the key only exists when disabled.
        if (this.newValue) delete clip.extra['enabled'];
        else clip.extra['enabled'] = false;
        break;
      case 'color_label':
        if (this.newValue === '') delete clip.extra['colorLabel'];
        else clip.extra['colorLabel'] = cloneJson(this.newValue);
        break;
      case 'blend':
        if (typeof this.newValue !== 'string') throw new EditError('blend debe ser texto');
        clip.blend = this.newValue;
        break;
      case 'opacity':
      case 'volume':
      case 'fade_in':
      case 'fade_out':
      case 'pan': {
        if (typeof this.newValue !== 'number' || !Number.isFinite(this.newValue)) {
          throw new EditError(`${this.property} debe ser un número`);
        }
        const field = this.property === 'fade_in'
          ? 'fadeIn'
          : this.property === 'fade_out'
            ? 'fadeOut'
            : this.property;
        if (field === 'pan') {
          if (this.newValue === 0) delete clip.extra['pan'];
          else clip.extra['pan'] = this.newValue;
        } else if (field === 'fadeIn' || field === 'fadeOut' || field === 'opacity' || field === 'volume') {
          clip[field] = this.newValue;
        }
        break;
      }
      default:
        throw new EditError(`Propiedad de clip desconocida: ${this.property}`);
    }
    return next;
  }

  inverse(): EditOperation {
    return new SetClipPropertyOperation(this.clipId, this.property, this.newValue, this.oldValue);
  }

  merge(nextOp: EditOperation): EditOperation | null {
    if (nextOp instanceof SetClipPropertyOperation && nextOp.clipId === this.clipId
      && nextOp.property === this.property
      && nextOp.timestamp - this.timestamp <= 500) {
      return new SetClipPropertyOperation(this.clipId, this.property, this.oldValue, nextOp.newValue);
    }
    return null;
  }

  describe(): string {
    return `Cambiar ${this.property} de ${this.clipId}`;
  }
}

/** Replaces a clip's transform wholesale. */
export class SetTransformOperation implements EditOperation {
  readonly name = 'SetTransform';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly oldTransform: Transform;
  readonly newTransform: Transform;

  constructor(clipId: string, oldTransform: Transform, newTransform: Transform) {
    this.clipId = clipId;
    this.oldTransform = oldTransform;
    this.newTransform = newTransform;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const clip = requireClip(next, this.clipId);
    clip.scale = this.newTransform.scale;
    clip.offsetX = this.newTransform.offset_x;
    clip.offsetY = this.newTransform.offset_y;
    clip.rotation = this.newTransform.rotation;
    clip.stretchX = this.newTransform.stretch_x;
    clip.stretchY = this.newTransform.stretch_y;
    return next;
  }

  inverse(): EditOperation {
    return new SetTransformOperation(this.clipId, this.newTransform, this.oldTransform);
  }

  describe(): string {
    return `Transformar ${this.clipId}`;
  }
}

/** Adds (or replaces) a keyframe on one property. */
export class AddKeyframeOperation implements EditOperation {
  readonly name = 'AddKeyframe';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly property: KeyProperty;
  readonly time: Rational;
  readonly value: number;
  readonly easing: KeyEase;

  constructor(clipId: string, property: KeyProperty, time: Rational, value: number, easing: KeyEase = KeyEase.LINEAR) {
    this.clipId = clipId;
    this.property = property;
    this.time = time;
    this.value = value;
    this.easing = easing;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const at = (this.time.asNumber() - clip.start) / Math.max(1e-9, clip.duration);
    if (at < -1e-9 || at > 1 + 1e-9) throw new EditError('El keyframe cae fuera del clip');
    const fraction = Math.min(1, Math.max(0, at));
    const next = cloneDocument(doc);
    const target = requireClip(next, this.clipId);
    // A property with keys reads through the animation: put the constant
    // value at a neutral base by keying every read.
    target.keys = target.keys.filter((key) => !(key.property === this.property && Math.abs(key.at - fraction) < 1e-9));
    target.keys.push({
      property: this.property,
      at: fraction,
      value: this.value,
      ease: new KeyEase(this.easing.points),
    });
    target.keys.sort((a, b) => (a.property === b.property ? a.at - b.at : a.property.localeCompare(b.property)));
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const clip = requireClip(doc, this.clipId);
    const at = (this.time.asNumber() - clip.start) / Math.max(1e-9, clip.duration);
    return new RemoveKeyframeOperation(this.clipId, this.property, keyframeId(this.property, at), true);
  }

  describe(): string {
    return `Añadir keyframe ${this.property}`;
  }
}

/** The stable id of a keyframe. */
export function keyframeId(property: string, at: number): string {
  return `${property}@${Math.round(at * 1e6) / 1e6}`;
}

/** Removes one keyframe. */
export class RemoveKeyframeOperation implements EditOperation {
  readonly name = 'RemoveKeyframe';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly property: string;
  readonly keyframeId: string;
  private readonly tolerant: boolean;

  constructor(clipId: string, property: string, keyframeIdValue: string, tolerant = false) {
    this.clipId = clipId;
    this.property = property;
    this.keyframeId = keyframeIdValue;
    this.tolerant = tolerant;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const index = clip.keys.findIndex(
      (key) => key.property === this.property && keyframeId(this.property, key.at) === this.keyframeId,
    );
    if (index < 0) {
      if (this.tolerant) return cloneDocument(doc);
      throw new EditError(`No existe el keyframe ${this.keyframeId}`);
    }
    const next = cloneDocument(doc);
    const target = requireClip(next, this.clipId);
    target.keys.splice(index, 1);
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const clip = requireClip(doc, this.clipId);
    const key = clip.keys.find(
      (item) => item.property === this.property && keyframeId(this.property, item.at) === this.keyframeId,
    );
    if (!key) return new NoOpOperation();
    const time = Rational.approximate(clip.start + key.at * clip.duration) ?? Rational.ZERO;
    return new AddKeyframeOperation(this.clipId, key.property as KeyProperty, time, key.value, key.ease);
  }

  describe(): string {
    return `Eliminar keyframe ${this.keyframeId}`;
  }
}

/** Drags a keyframe along its clip. */
export class MoveKeyframeOperation implements EditOperation {
  readonly name = 'MoveKeyframe';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly property: string;
  readonly keyframeId: string;
  readonly fromTime: Rational;
  readonly toTime: Rational;

  constructor(clipId: string, property: string, keyframeIdValue: string, fromTime: Rational, toTime: Rational) {
    this.clipId = clipId;
    this.property = property;
    this.keyframeId = keyframeIdValue;
    this.fromTime = fromTime;
    this.toTime = toTime;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const target = requireClip(next, this.clipId);
    const key = target.keys.find(
      (item) => item.property === this.property && keyframeId(this.property, item.at) === this.keyframeId,
    );
    if (!key) throw new EditError(`No existe el keyframe ${this.keyframeId}`);
    const at = (this.toTime.asNumber() - clip.start) / Math.max(1e-9, clip.duration);
    if (at < -1e-9 || at > 1 + 1e-9) throw new EditError('El keyframe cae fuera del clip');
    key.at = Math.min(1, Math.max(0, at));
    target.keys.sort((a, b) => a.at - b.at);
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    // The key's id follows its position: undo names the *moved* key.
    const clip = requireClip(doc, this.clipId);
    const movedAt = (this.toTime.asNumber() - clip.start) / Math.max(1e-9, clip.duration);
    return new MoveKeyframeOperation(
      this.clipId,
      this.property,
      keyframeId(this.property, Math.min(1, Math.max(0, movedAt))),
      this.toTime,
      this.fromTime,
    );
  }

  describe(): string {
    return `Mover keyframe ${this.keyframeId}`;
  }
}

/** Changes playback rate (and pitch preservation). */
export class SetSpeedOperation implements EditOperation {
  readonly name = 'SetSpeed';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly oldSpeed: number;
  readonly newSpeed: number;
  readonly maintainPitch: boolean;

  constructor(clipId: string, oldSpeed: number, newSpeed: number, maintainPitch = true) {
    this.clipId = clipId;
    this.oldSpeed = oldSpeed;
    this.newSpeed = newSpeed;
    this.maintainPitch = maintainPitch;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireClip(doc, this.clipId);
    if (!(this.newSpeed > 0)) throw new EditError('La velocidad debe ser positiva');
    const next = cloneDocument(doc);
    const clip = requireClip(next, this.clipId);
    clip.speed = this.newSpeed;
    clip.preservePitch = this.maintainPitch;
    return next;
  }

  inverse(): EditOperation {
    return new SetSpeedOperation(this.clipId, this.newSpeed, this.oldSpeed, this.maintainPitch);
  }

  describe(): string {
    return `Velocidad ${this.newSpeed}x en ${this.clipId}`;
  }
}

/** Replaces a clip's crop. */
export class SetCropOperation implements EditOperation {
  readonly name = 'SetCrop';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly oldCrop: Crop | null;
  readonly newCrop: Crop | null;

  constructor(clipId: string, oldCrop: Crop | null, newCrop: Crop | null) {
    this.clipId = clipId;
    this.oldCrop = oldCrop ? { ...oldCrop } : null;
    this.newCrop = newCrop ? { ...newCrop } : null;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    requireClip(next, this.clipId).crop = this.newCrop ? { ...this.newCrop } : null;
    return next;
  }

  inverse(): EditOperation {
    return new SetCropOperation(this.clipId, this.newCrop, this.oldCrop);
  }

  describe(): string {
    return `Recortar imagen de ${this.clipId}`;
  }
}

/** Enables/disables a clip (disabled clips skip the compositor). */
export class ToggleClipEnabledOperation implements EditOperation {
  readonly name = 'ToggleClipEnabled';
  readonly timestamp = Date.now();
  readonly clipId: string;

  constructor(clipId: string) {
    this.clipId = clipId;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const target = requireClip(next, this.clipId);
    target.extra['enabled'] = !clipEnabled(clip);
    return next;
  }

  inverse(): EditOperation {
    return new ToggleClipEnabledOperation(this.clipId);
  }

  describe(): string {
    return `Activar/desactivar ${this.clipId}`;
  }
}

/** Clones a clip onto another lane and time. */
export class DuplicateClipOperation implements EditOperation {
  readonly name = 'DuplicateClip';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly targetTrackId: string;
  readonly atTime: Rational;
  readonly newClipId: string;

  constructor(clipId: string, targetTrackId: string, atTime: Rational, newClipId?: string) {
    this.clipId = clipId;
    this.targetTrackId = targetTrackId;
    this.atTime = atTime;
    this.newClipId = newClipId ?? newId('c-');
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const track = requireTrack(doc, this.targetTrackId);
    const kind = trackKindOf(doc, track);
    if (!kindFitsTrack(clip.kind, kind)) {
      throw new EditError(`Un clip de ${clip.kind} no puede ir a una pista de ${kind}`);
    }
    const at = this.atTime.asNumber();
    if (at < 0) throw new EditError('El inicio no puede ser negativo');
    const next = cloneDocument(doc);
    const copy = cloneClip(clip);
    copy.id = this.newClipId;
    copy.trackId = this.targetTrackId;
    copy.start = at;
    currentTimeline(next).clips.push(copy);
    return next;
  }

  inverse(): EditOperation {
    return new DeleteClipInternalOperation(this.newClipId);
  }

  describe(): string {
    return `Duplicar clip ${this.clipId}`;
  }
}

/** Deletes a clip by id without validating ripple (undo of duplicate). */
class DeleteClipInternalOperation implements EditOperation {
  readonly name = 'DeleteClip';
  readonly timestamp = Date.now();
  private readonly clipId: string;

  constructor(clipId: string) {
    this.clipId = clipId;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = cloneDocument(doc);
    const timeline = currentTimeline(next);
    if (!timeline.clips.some((clip) => clip.id === this.clipId)) {
      throw new EditError(`No existe el clip ${this.clipId}`);
    }
    timeline.clips = timeline.clips.filter((clip) => clip.id !== this.clipId);
    return next;
  }

  inverse(): EditOperation {
    return new NoOpOperation();
  }

  describe(): string {
    return `Eliminar clip ${this.clipId}`;
  }
}
