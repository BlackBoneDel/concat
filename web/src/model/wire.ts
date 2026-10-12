// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Reading with tolerance — a faithful port of the `wire` module of
 * `concat-project/src/model.rs`.
 *
 * The document reader's standing rule is that a hand-edited or older file
 * degrades to something openable: a list keeps the entries that parse and
 * drops the rest, an optional keeps a value that parses and is otherwise
 * nothing, and a kind this build has never heard of falls back to the plainest
 * one. Every helper reads a loose JSON value first, so nothing here can fail
 * the whole load.
 */

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A JSON object. */
export type JsonObject = { [key: string]: Json };

/** The unknown fields of a struct, kept so a document written by a newer or a
 * different build round-trips through this one intact. The Rust model's
 * `extra: Map<String, Value>`. */
export type Extra = JsonObject;

/** The object form of `value`, or `null`. */
export function asObject(value: Json): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** A string field, `fallback` when missing or not a string. */
export function str(value: Json | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** A finite number field, `fallback` for anything else (including NaN and
 * Infinity — the same rule `finite()` applies in Rust `tidy`). */
export function num(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A number field as an integer, `fallback` for anything else. */
export function int(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** A boolean field, `fallback` when missing or not a boolean. */
export function bool(value: Json | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** An optional field: `null` when missing or when the entry does not parse. */
export function maybe<T>(value: Json | undefined, read: (value: Json) => T | null): T | null {
  if (value === undefined || value === null) return null;
  return read(value);
}

/** The entries of a list that parse, in order; not a list at all is an empty
 * one. Port of `wire::list`. */
export function listOf<T>(value: Json | undefined, read: (value: Json) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const parsed = read(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** {@link listOf}, as an optional that is null when nothing parsed. Port of
 * `wire::maybe_list`. */
export function maybeListOf<T>(
  value: Json | undefined,
  read: (value: Json) => T | null,
): T[] | null {
  const list = listOf(value, read);
  return list.length > 0 ? list : null;
}

/** The fields of `source` this build does not know, kept to round-trip. */
export function collectExtra(source: JsonObject, known: ReadonlySet<string>): Extra {
  const extra: Extra = {};
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) extra[key] = value;
  }
  return extra;
}

// ---------------------------------------------------------------------------
// The vocabulary of the document.
// ---------------------------------------------------------------------------

/** What made a media file, when it was the editor and not the user's import. */
export type MediaOrigin = 'speech' | 'processed';
export const MEDIA_ORIGINS: readonly MediaOrigin[] = ['speech', 'processed'];
export function parseMediaOrigin(value: Json | undefined): MediaOrigin | null {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (MEDIA_ORIGINS as readonly string[]).includes(name) ? (name as MediaOrigin) : null;
}

/** What a media file is. Unknown kinds fall back to `video`, matching
 * `wire::media_kind`. */
export type MediaKind = 'video' | 'audio' | 'image';
export const MEDIA_KINDS: readonly MediaKind[] = ['video', 'audio', 'image'];
export function parseMediaKind(value: Json | undefined): MediaKind {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (MEDIA_KINDS as readonly string[]).includes(name) ? (name as MediaKind) : 'video';
}

/** What a clip renders as. An unknown kind falls back to `video` — the rule
 * from `wire::clip_kind` that keeps shapes saved by a newer build openable. */
export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'layer' | 'shape';
export const CLIP_KINDS: readonly ClipKind[] = ['video', 'audio', 'image', 'text', 'layer', 'shape'];
export function parseClipKind(value: Json | undefined): ClipKind {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (CLIP_KINDS as readonly string[]).includes(name) ? (name as ClipKind) : 'video';
}
/** True for the kinds that put pixels on screen. Port of `ClipKind::is_visual`. */
export function clipKindIsVisual(kind: ClipKind): boolean {
  return kind === 'video' || kind === 'image';
}

/** The levels a media file's picture spans, when the person says so over
 * whatever the file claims. */
export type ColorRange = 'limited' | 'full';
export const COLOR_RANGES: readonly ColorRange[] = ['limited', 'full'];
export function parseColorRange(value: Json | undefined): ColorRange | null {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (COLOR_RANGES as readonly string[]).includes(name) ? (name as ColorRange) : null;
}

/** The colour a picture is in: SDR on Rec. 709, or HDR on Rec. 2020 with the
 * hybrid log-gamma or the perceptual quantiser transfer. */
export type ColorSpace = 'sdr' | 'hlg' | 'pq';
export const COLOR_SPACES: readonly ColorSpace[] = ['sdr', 'hlg', 'pq'];
export function parseColorSpace(value: Json | undefined): ColorSpace {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (COLOR_SPACES as readonly string[]).includes(name) ? (name as ColorSpace) : 'sdr';
}
export function colorSpaceIsSdr(space: ColorSpace): boolean {
  return space === 'sdr';
}

/** How a title's lines sit within their block. */
export type TextAlign = 'left' | 'center' | 'right';
export const TEXT_ALIGNMENTS: readonly TextAlign[] = ['left', 'center', 'right'];
export function parseTextAlign(value: Json | undefined): TextAlign {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (TEXT_ALIGNMENTS as readonly string[]).includes(name) ? (name as TextAlign) : 'center';
}

/** A figure drawn over the picture. Unknown kinds fall back to `square`. */
export type ShapeKind = 'square' | 'circle' | 'triangle' | 'parallelogram' | 'trapezoid' | 'line' | 'arrow';
export const SHAPE_KINDS: readonly ShapeKind[] = [
  'square',
  'circle',
  'triangle',
  'parallelogram',
  'trapezoid',
  'line',
  'arrow',
];
export function parseShapeKind(value: Json | undefined): ShapeKind {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SHAPE_KINDS as readonly string[]).includes(name) ? (name as ShapeKind) : 'square';
}

/** The four brushes of a custom cutout. */
export type BrushTool = 'smartBrush' | 'brush' | 'smartEraser' | 'eraser';
export const BRUSH_TOOLS: readonly BrushTool[] = ['smartBrush', 'brush', 'smartEraser', 'eraser'];
export function parseBrushTool(value: Json | undefined): BrushTool {
  const name = typeof value === 'string' ? value.trim() : '';
  return (BRUSH_TOOLS as readonly string[]).includes(name) ? (name as BrushTool) : 'brush';
}

/** The two ways a cutout decides what stays. */
export type CutoutMode = 'auto' | 'custom';
export const CUTOUT_MODES: readonly CutoutMode[] = ['auto', 'custom'];
export function parseCutoutMode(value: Json | undefined): CutoutMode {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (CUTOUT_MODES as readonly string[]).includes(name) ? (name as CutoutMode) : 'auto';
}

/** What a cutout keeps. */
export type Subject = 'auto' | 'person' | 'object';
export const SUBJECTS: readonly Subject[] = ['auto', 'person', 'object'];
export function parseSubject(value: Json | undefined): Subject {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SUBJECTS as readonly string[]).includes(name) ? (name as Subject) : 'auto';
}

/** Which property a user-set key belongs to. Port of `KeyProperty`, with the
 * same document names (`"offsetX"`, ...). */
export type KeyProperty = 'scale' | 'offsetX' | 'offsetY' | 'rotation' | 'opacity' | 'volume';

export const KeyProperty = {
  Scale: 'scale',
  OffsetX: 'offsetX',
  OffsetY: 'offsetY',
  Rotation: 'rotation',
  Opacity: 'opacity',
  Volume: 'volume',
  /** Every property that can be keyed, in the order a panel lists them. */
  ALL: ['scale', 'offsetX', 'offsetY', 'rotation', 'opacity', 'volume'] as const,
  /** The property of that name, or null. Port of `KeyProperty::from_name`. */
  fromName(name: string): KeyProperty | null {
    return (KeyProperty.ALL as readonly string[]).includes(name) ? (name as KeyProperty) : null;
  },
} as const;

/**
 * How a key is approached from the one before it: a CSS timing function's two
 * control points, `[x1, y1, x2, y2]`.
 *
 * The document's spelling of `core/animate`'s `Ease`, which is what it becomes.
 * Serialised as a bare array: `"ease": [0.42, 0, 0.58, 1]`. Documents written
 * before the curve editor spell it `"linear"` / `"in"` / `"out"` / `"inOut"`
 * instead, and {@link KeyEase.fromWire} still reads those. Port of `KeyEase`.
 */
export class KeyEase {
  readonly points: readonly [number, number, number, number];

  constructor(points: readonly [number, number, number, number]) {
    this.points = points;
    Object.freeze(this);
    Object.freeze(points);
  }

  /** A straight line. */
  static readonly LINEAR: KeyEase = new KeyEase([0, 0, 1, 1]);
  /** Starts slow, arrives fast. */
  static readonly IN: KeyEase = new KeyEase([0.42, 0, 1, 1]);
  /** Starts fast, arrives slow. */
  static readonly OUT: KeyEase = new KeyEase([0, 0, 0.58, 1]);
  /** Slow at both ends. */
  static readonly IN_OUT: KeyEase = new KeyEase([0.42, 0, 0.58, 1]);

  equals(other: KeyEase): boolean {
    return this.points.every((point, index) => point === other.points[index]);
  }

  /** Either spelling, and a straight line for anything else: the reader's
   * standing rule is that a hand-edited file degrades to something openable,
   * and a key that still moves is better than one that fails its clip. Port of
   * the `Deserialize` impl and `KeyEase::from_name`. */
  static fromWire(value: Json | undefined): KeyEase {
    if (typeof value === 'string') {
      switch (value.trim().toLowerCase()) {
        case 'linear':
          return KeyEase.LINEAR;
        case 'in':
          return KeyEase.IN;
        case 'out':
          return KeyEase.OUT;
        case 'inout':
          return KeyEase.IN_OUT;
        default:
          return KeyEase.LINEAR;
      }
    }
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((point) => typeof point === 'number' && Number.isFinite(point))
    ) {
      return new KeyEase([value[0] as number, value[1] as number, value[2] as number, value[3] as number]);
    }
    return KeyEase.LINEAR;
  }

  /** The bare array spelling written back to a document. */
  toJson(): Json {
    return [...this.points];
  }
}

// ---------------------------------------------------------------------------
// The floors and ceilings a command holds a number to. Port of `model.rs`'s
// `ranges` module.
// ---------------------------------------------------------------------------

export const MIN_CLIP_DURATION = 1 / 60;
export const MAX_TIME = 360_000;
export const MIN_SPEED = 0.0625;
export const MAX_SPEED = 16;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;
export const MIN_STRETCH = 0.1;
export const MAX_STRETCH = 10;
export const MAX_OFFSET = 3;
export const MIN_TRANSITION = 0.1;
export const DEFAULT_FEATHER = 0.01;
export const MAX_FEATHER = 0.1;
export const MIN_BRUSH = 0.005;
export const MAX_BRUSH = 0.5;
/** How near two keys on one property have to be to count as the same key. */
export const KEY_EPSILON = 0.002;

/** Rotates degrees into `(-180, 180]`. Port of `ranges::wrap_rotation`. */
export function wrapRotation(degrees: number): number {
  const wrapped = (((degrees % 360) + 540) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** `value` when finite, `fallback` otherwise. Port of the `finite()` helper
 * every `tidy` carries. */
export function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Numbers into `[low, high]`, `fallback` first for the non-finite. */
export function clampFinite(value: number, fallback: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, finite(value, fallback)));
}
