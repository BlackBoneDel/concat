// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The edit itself: a project, its tracks, and the clips on them — a faithful
 * port of `concat-core/src/timeline.rs`.
 *
 * Tracks and clips live in arenas and are addressed by {@link Id} handles.
 * Nothing here owns another editable object directly, which is what makes
 * undo, cross-references and multi-threaded rendering tractable.
 *
 * Track order is explicit and bottom-first: `timeline.trackIds()[0]` is
 * composited first and everything after it draws on top.
 */

import { Animation, type BaseTransform } from './animate.ts';
import { Arena, Id } from './arena.ts';
import { SpeedCurve } from './retime.ts';
import { FrameRate, TimeRange } from './time.ts';
import { Rational } from './rational.ts';

/** Handle to a {@link Track}. */
export type TrackId = Id<Track>;
/** Handle to a {@link Clip}. */
export type ClipId = Id<Clip>;

/** What kind of material a track carries. */
export type TrackKind = 'video' | 'audio';
export const TrackKind = {
  Video: 'video',
  Audio: 'audio',
} as const;

/**
 * Where a clip's pixels come from. A path today. When a media library lands
 * this becomes a handle into it, and this is the one type that has to change —
 * exactly as the Rust `MediaRef` documents.
 */
export class MediaRef {
  /** Path (or web handle name) of the media file. */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    Object.freeze(this);
  }

  equals(other: MediaRef): boolean {
    return this.path === other.path;
  }
}

/** How a layer's colour meets what is beneath it.
 *
 * Source-over is the ordinary case. The rest are the fixed-function blends a
 * GPU offers over premultiplied colour, spelled the same way on the CPU so the
 * two paths agree pixel for pixel: with `s` the layer's colour times its alpha
 * and `d` the ground, Multiply is `s·d + d(1-a)`, Screen `s(1-d) + d`, Add
 * `s + d`, Lighten `max(s, d)`, Darken `min(s, d)`. */
export type Blend = 'normal' | 'multiply' | 'screen' | 'add' | 'lighten' | 'darken';

export const Blend = {
  Normal: 'normal',
  Multiply: 'multiply',
  Screen: 'screen',
  Add: 'add',
  Lighten: 'lighten',
  Darken: 'darken',
  /** Every mode, in menu order. Port of `Blend::ALL`. */
  ALL: ['normal', 'multiply', 'screen', 'add', 'lighten', 'darken'] as const,
  /** The mode a document names, Normal for anything unknown. Port of
   * `Blend::parse`. */
  parse(name: string): Blend {
    const trimmed = name.trim();
    return (Blend.ALL as readonly Blend[]).find((mode) => mode === trimmed) ?? Blend.Normal;
  },
} as const;

/** A clip's placement in the output frame.
 *
 * Deliberately resolution-independent: `scale` is relative to the fitted size
 * and the offsets are fractions of the frame, so the same transform means the
 * same picture on a 720p export and a 4K one. */
export class Transform implements BaseTransform {
  /** Multiplier over the fitted size. 1 fills the frame, preserving aspect. */
  readonly scale: number;
  /** Offset of the picture's centre from frame centre, as a fraction of frame
   * width. */
  readonly offset_x: number;
  /** Offset as a fraction of frame height. */
  readonly offset_y: number;
  /** Clockwise rotation about the picture's centre, in degrees. */
  readonly rotation: number;
  /** A multiplier on the fitted width beyond `scale`, for a picture pulled
   * wider or narrower than its aspect. 1 keeps the aspect. */
  readonly stretch_x: number;
  /** The same for the height. */
  readonly stretch_y: number;

  constructor(
    scale = 1,
    offsetX = 0,
    offsetY = 0,
    rotation = 0,
    stretchX = 1,
    stretchY = 1,
  ) {
    this.scale = scale;
    this.offset_x = offsetX;
    this.offset_y = offsetY;
    this.rotation = rotation;
    this.stretch_x = stretchX;
    this.stretch_y = stretchY;
    Object.freeze(this);
  }

  /** Fitted, centred, unrotated. Port of `Transform::IDENTITY`. */
  static readonly IDENTITY: Transform = new Transform();

  /** True when applying this transform would change nothing. */
  isIdentity(): boolean {
    return (
      this.scale === 1 &&
      this.offset_x === 0 &&
      this.offset_y === 0 &&
      this.rotation === 0 &&
      this.stretch_x === 1 &&
      this.stretch_y === 1
    );
  }
}

/** A span of one piece of media, placed on a track. Port of `timeline::Clip`.
 *
 * Every field maps one-to-one to the Rust struct; the doc comments there
 * explain the contract each carries. */
export class Clip {
  /** Where the pixels come from. */
  media: MediaRef;
  /** The in-point: how far into the media the clip starts. */
  source_start: Rational;
  /** Where the clip sits on the timeline. */
  start: Rational;
  /** How long the clip runs on the timeline. */
  duration: Rational;
  /** Playback rate: source seconds consumed per timeline second. One is
   * normal speed. Always positive — enforce at the boundary that sets it.
   * This is the *only* definition of retiming. */
  speed: Rational;
  /** Blend factor in `0.0..=1.0`, applied over whatever is beneath. */
  opacity: number;
  /** Ramp the picture's opacity from zero over this many seconds from the
   * clip's start. Zero means no ramp. This is what a cross-dissolve is made
   * of: it multiplies `opacity`, so a half-transparent clip fades up to half,
   * not to solid. */
  video_fade_in: Rational;
  /** Ramp the opacity back to zero over this many seconds into the clip's
   * end. Zero means no ramp. */
  video_fade_out: Rational;
  /** How the picture sits in the frame. Identity is fitted and centred. */
  transform: Transform;
  /** Speed as it changes over the clip, when it does. Overrides `speed` for
   * the time map; `speed` is then the curve's mean. */
  retime: SpeedCurve | null;
  /** Keys over the clip's placement and opacity, when it has any. */
  animation: Animation | null;
  /** How the clip's colour meets what is beneath it. */
  blend: Blend;
  /** One frame, held: every instant of the clip maps to `source_start`, and no
   * decoder is paced along it. */
  hold: boolean;

  /** A clip that starts at the beginning of its media and is fully opaque.
   * Port of `Clip::new`. */
  constructor(
    media: MediaRef,
    start: Rational,
    duration: Rational,
    {
      sourceStart = Rational.ZERO,
      speed = Rational.ONE,
      opacity = 1,
      videoFadeIn = Rational.ZERO,
      videoFadeOut = Rational.ZERO,
      transform = Transform.IDENTITY,
      retime = null,
      animation = null,
      blend = Blend.Normal,
      hold = false,
    }: Partial<{
      sourceStart: Rational;
      speed: Rational;
      opacity: number;
      videoFadeIn: Rational;
      videoFadeOut: Rational;
      transform: Transform;
      retime: SpeedCurve | null;
      animation: Animation | null;
      blend: Blend;
      hold: boolean;
    }> = {},
  ) {
    this.media = media;
    this.source_start = sourceStart;
    this.start = start;
    this.duration = duration;
    this.speed = speed;
    this.opacity = opacity;
    this.video_fade_in = videoFadeIn;
    this.video_fade_out = videoFadeOut;
    this.transform = transform;
    this.retime = retime;
    this.animation = animation;
    this.blend = blend;
    this.hold = hold;
  }

  /** Where in the clip `time` falls, `0..=1`; zero outside it. Port of
   * `fraction_at`. */
  fractionAt(time: Rational): number {
    if (this.duration.isZero()) return 0;
    const fraction = time.sub(this.start).div(this.duration).asNumber();
    return Math.min(1, Math.max(0, fraction));
  }

  /** The placement at `time`: the clip's own, moved by its animation. Port of
   * `transform_at`. */
  transformAt(time: Rational): Transform {
    const moved = this.animation
      ? this.animation.transformAt(this.transform, this.fractionAt(time))
      : this.transform;
    return moved instanceof Transform
      ? moved
      : new Transform(
          moved.scale,
          moved.offset_x,
          moved.offset_y,
          moved.rotation,
          moved.stretch_x,
          moved.stretch_y,
        );
  }

  /** The opacity at `time`, before the fade ramps: the clip's own, scaled by
   * its animation. Port of `opacity_at`. */
  opacityAt(time: Rational): number {
    return this.animation
      ? this.animation.opacityAt(this.opacity, this.fractionAt(time))
      : this.opacity;
  }

  /** The opacity ramp factor at `time`, in `0.0..=1.0`. One at any instant
   * outside the fade windows, and always one for a clip with no fades — the
   * common case costs two comparisons. Port of `video_fade_factor`. */
  videoFadeFactor(time: Rational): number {
    let factor = 1;
    const local = time.sub(this.start);

    if (!this.video_fade_in.isZero() && local.compare(this.video_fade_in) < 0) {
      factor *= Math.min(1, Math.max(0, local.div(this.video_fade_in).asNumber()));
    }
    const remaining = this.duration.sub(local);
    if (!this.video_fade_out.isZero() && remaining.compare(this.video_fade_out) < 0) {
      factor *= Math.min(1, Math.max(0, remaining.div(this.video_fade_out).asNumber()));
    }
    return factor;
  }

  /** The span of timeline this clip occupies. */
  range(): TimeRange {
    return new TimeRange(this.start, this.duration);
  }

  /** True if the clip is on screen at `time`. */
  contains(time: Rational): boolean {
    return this.range().contains(time);
  }

  /** Converts a timeline timestamp into a timestamp within the source media,
   * or `null` if the clip is not on screen then.
   *
   * An affine map: `source_start + (time - start) * speed`. This is the one
   * piece of arithmetic that every trim, ripple, slip and retime operation
   * ultimately has to agree with, so it lives in exactly one place. Port of
   * `source_time_at`. */
  sourceTimeAt(time: Rational): Rational | null {
    if (!this.contains(time)) return null;
    if (this.hold) return this.source_start;
    let forward: Rational;
    if (this.retime) {
      // The area under the curve, in fractions of the clip's length, scaled
      // back to seconds. Approximated to a rational at the end so the rest of
      // the arithmetic stays exact.
      const x = time.sub(this.start).div(this.duration).asNumber();
      const consumed = this.retime.consumed(x) * this.duration.asNumber();
      forward = Rational.approximate(consumed) ?? Rational.ZERO;
    } else {
      forward = time.sub(this.start).mul(this.speed);
    }
    return this.source_start.add(forward);
  }

  /** How much of the source this clip consumes: `duration * speed`, or the
   * area under the curve when there is one. Port of `source_duration`. */
  sourceDuration(): Rational {
    if (this.retime) {
      return (
        Rational.approximate(this.retime.mean() * this.duration.asNumber()) ?? this.duration
      );
    }
    return this.duration.mul(this.speed);
  }

  /** Whether a decoder can be paced at one rate for this clip: false when the
   * speed changes over it, or when it holds one frame, in which case every
   * frame has to be sought by its own source time. Port of `is_paced`. */
  isPaced(): boolean {
    return this.retime === null && !this.hold;
  }
}

/** A horizontal lane of clips. Port of `timeline::Track`. */
export class Track {
  /** Display name. */
  name: string;
  /** Picture or sound. */
  kind: TrackKind;
  /** When false the track is skipped entirely while rendering. */
  enabled: boolean;
  private readonly clipIds: ClipId[] = [];

  /** An empty, enabled track. Port of `Track::new`. */
  constructor(name: string, kind: TrackKind) {
    this.name = name;
    this.kind = kind;
    this.enabled = true;
  }

  /** The clips on this track, in insertion order. */
  clips(): readonly ClipId[] {
    return this.clipIds;
  }

  /** Records a clip on this lane. Called only by {@link Timeline.addClip} —
   * the same private `Vec<ClipId>` mutation the Rust struct keeps to itself. */
  insertClip(id: ClipId): void {
    this.clipIds.push(id);
  }

  /** Forgets a clip on this lane. Called only by {@link Timeline.removeClip}. */
  eraseClip(id: ClipId): void {
    const at = this.clipIds.findIndex((other) => other.equals(id));
    if (at >= 0) this.clipIds.splice(at, 1);
  }
}

/** The edit: output format, tracks, and the clips on them. Port of
 * `timeline::Timeline`. */
export class Timeline {
  /** Output frame rate. */
  frame_rate: FrameRate;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  private readonly trackArena: Arena<Track> = new Arena<Track>();
  private readonly clipArena: Arena<Clip> = new Arena<Clip>();
  private readonly order: TrackId[] = [];

  /** An empty timeline with the given output format. */
  constructor(width: number, height: number, frameRate: FrameRate) {
    this.width = width;
    this.height = height;
    this.frame_rate = frameRate;
  }

  /** A 1920x1080, 30 fps timeline — the default for a new project. Port of
   * `Timeline::hd`. */
  static hd(): Timeline {
    return new Timeline(1920, 1080, FrameRate.THIRTY);
  }

  /** Adds a track on top of the existing ones. */
  addTrack(track: Track): TrackId {
    const id = this.trackArena.insert(track);
    this.order.push(id);
    return id;
  }

  /** Track handles, bottom-most first. Composite in this order. */
  trackIds(): readonly TrackId[] {
    return this.order;
  }

  /** Borrows a track. */
  track(id: TrackId): Track | undefined {
    return this.trackArena.get(id);
  }

  /** Mutably borrows a track. In JavaScript the same live object comes back;
   * the name is kept for parity with the Rust API. */
  trackMut(id: TrackId): Track | undefined {
    return this.trackArena.getMut(id);
  }

  /** Iterates over tracks bottom-most first. */
  *tracks(): IterableIterator<[TrackId, Track]> {
    for (const id of this.order) {
      const track = this.trackArena.get(id);
      if (track) yield [id, track];
    }
  }

  /** Removes a track and every clip on it. */
  removeTrack(id: TrackId): Track | undefined {
    const track = this.trackArena.remove(id);
    if (!track) return undefined;
    for (const clip of track.clips()) {
      this.clipArena.remove(clip);
    }
    const at = this.order.findIndex((other) => other.equals(id));
    if (at >= 0) this.order.splice(at, 1);
    return track;
  }

  /** Places a clip on a track. Returns `undefined` if the track handle is
   * stale. Port of `add_clip` — the clip enters the arena only once the track
   * is known to be real, otherwise a stale handle leaks an orphaned clip. */
  addClip(track: TrackId, clip: Clip): ClipId | undefined {
    const lane = this.trackArena.get(track);
    if (!lane) return undefined;
    const id = this.clipArena.insert(clip);
    lane.insertClip(id);
    return id;
  }

  /** Borrows a clip. */
  clip(id: ClipId): Clip | undefined {
    return this.clipArena.get(id);
  }

  /** Mutably borrows a clip. Same live object; name kept for parity. */
  clipMut(id: ClipId): Clip | undefined {
    return this.clipArena.getMut(id);
  }

  /** Removes a clip from wherever it sits. */
  removeClip(id: ClipId): Clip | undefined {
    const clip = this.clipArena.remove(id);
    if (!clip) return undefined;
    for (const [, track] of this.trackArena.iter()) {
      track.eraseClip(id);
    }
    return clip;
  }

  /** How many clips the timeline holds, across all tracks. */
  clipCount(): number {
    return this.clipArena.len();
  }

  /** The clip visible on `track` at `time`, if any. Clips on one track are not
   * supposed to overlap; if they do, the last-added one wins, which matches
   * what you see after a paste. Port of `clip_on_track_at`. */
  clipOnTrackAt(track: TrackId, time: Rational): ClipId | undefined {
    const lane = this.trackArena.get(track);
    if (!lane) return undefined;
    const ids = lane.clips();
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const id = ids[i]!;
      const clip = this.clipArena.get(id);
      if (clip && clip.contains(time)) return id;
    }
    return undefined;
  }

  /** Where the last clip ends. Zero for an empty timeline. */
  duration(): Rational {
    let longest = Rational.ZERO;
    for (const [, clip] of this.clipArena.iter()) {
      const end = clip.range().end();
      if (end.compare(longest) > 0) longest = end;
    }
    return longest;
  }

  /** How many whole output frames the timeline runs for. */
  frameCount(): bigint {
    return this.frame_rate.framesIn(this.duration());
  }
}

/** A timeline plus the things that surround it on disk. Port of
 * `timeline::Project`. */
export class Project {
  /** Display name. */
  name: string;
  /** The edit. */
  timeline: Timeline;

  /** A new, empty project at the given output format. */
  constructor(name: string, timeline: Timeline) {
    this.name = name;
    this.timeline = timeline;
  }
}
