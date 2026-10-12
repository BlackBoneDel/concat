// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The `concat.json` document: its shape, its reader and its writer — a
 * faithful port of `concat-project/src/model.rs` and `concat-project/src/doc.rs`.
 *
 * The file is `version 1 + document`:
 *
 * 1. **Migrate.** The JSON is walked through {@link MIGRATIONS}, oldest shape
 *    first. Each step is idempotent. A document from a later build is refused.
 * 2. **Parse.** Every struct is read with its `Default` as the base, so fields
 *    the file is missing keep the editor's values, and fields this build does
 *    not know land in each struct's `extra` map and round-trip untouched.
 * 3. **Settle.** Orphans are dropped, a tidy pass clamps every number back
 *    into the range a command would have held it to, and an active timeline
 *    that exists is guaranteed.
 *
 * Nothing short of a document that is not an object, or has no timeline with a
 * lane, fails the load.
 */

import { FrameRate } from '../core/time.ts';
import {
  type BrushTool,
  type ClipKind,
  type ColorRange,
  type ColorSpace,
  type CutoutMode,
  type Extra,
  type Json,
  type JsonObject,
  type MediaKind,
  type MediaOrigin,
  type ShapeKind,
  type Subject,
  type TextAlign,
  BRUSH_TOOLS,
  CUTOUT_MODES,
  KeyEase,
  KeyProperty,
  MAX_BRUSH,
  MAX_FEATHER,
  MIN_BRUSH,
  clampFinite,
  clipKindIsVisual,
  collectExtra,
  colorSpaceIsSdr,
  bool,
  finite,
  int,
  listOf,
  maybe,
  maybeListOf,
  num,
  parseClipKind,
  parseColorRange,
  parseColorSpace,
  parseMediaKind,
  parseMediaOrigin,
  parseShapeKind,
  parseSubject,
  parseTextAlign,
  str,
  wrapRotation,
  MAX_SCALE,
  MAX_OFFSET,
  MAX_STRETCH,
  MAX_TIME,
  MIN_CLIP_DURATION,
  MIN_SCALE,
  MIN_SPEED,
  MIN_STRETCH,
  MIN_TRANSITION,
  MAX_SPEED,
  DEFAULT_FEATHER,
} from './wire.ts';

/** The largest frame side any Concat build renders or exports: 8192, from
 * `concat-core/src/frame.rs` (`MAX_SIDE`). */
export const MAX_SIDE = 8192;

/** The version this build writes and reads. Documents from before the field
 * existed are version 1: that is the version their shape was given. Port of
 * `doc::DOCUMENT_VERSION`. */
export const DOCUMENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Small structures.
// ---------------------------------------------------------------------------

/** One audio stream of a media file, as the probe reported it. */
export interface AudioTrack {
  /** The stream's index within the file — what `Clip.audioStream` holds. */
  index: number;
  /** Codec short name, e.g. "aac". Informational. */
  codec: string;
  /** Channel count: 1 mono, 2 stereo. */
  channels: number;
  /** Samples per second. */
  sampleRate: number;
  /** The name the file gives the track, when it gives one; empty otherwise. */
  title: string;
  /** The track's language tag, e.g. "eng"; empty when unstated. */
  language: string;
}

const AUDIO_TRACK_KEYS = new Set(['index', 'codec', 'channels', 'sampleRate', 'title', 'language']);

export function readAudioTrack(value: Json): AudioTrack | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // `index` has no serde default: an entry without one does not parse and the
  // wire list drops it.
  const index = object['index'];
  if (typeof index !== 'number' || !Number.isFinite(index)) return null;
  return {
    index: Math.trunc(index),
    codec: str(object['codec'], ''),
    channels: int(object['channels'], 0),
    sampleRate: int(object['sampleRate'], 0),
    title: str(object['title'], ''),
    language: str(object['language'], ''),
  };
}

export function writeAudioTrack(track: AudioTrack): Json {
  return {
    index: track.index,
    codec: track.codec,
    channels: track.channels,
    sampleRate: track.sampleRate,
    ...(track.title ? { title: track.title } : {}),
    ...(track.language ? { language: track.language } : {}),
  };
}

/** What is cut off each edge of the source before it is fitted, as fractions
 * of the source's width and height. */
export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** True when nothing is cut. Port of `Crop::is_none`. */
export function cropIsNone(crop: Crop): boolean {
  return crop.left <= 0 && crop.top <= 0 && crop.right <= 0 && crop.bottom <= 0;
}

/** Each edge held to `0..=0.9`, and a pair that would meet pulled back so at
 * least a tenth of the picture is left. Port of `Crop::tidy`. */
export function tidyCrop(crop: Crop): Crop {
  const out: Crop = {
    left: Math.min(0.9, Math.max(0, crop.left)),
    top: Math.min(0.9, Math.max(0, crop.top)),
    right: Math.min(0.9, Math.max(0, crop.right)),
    bottom: Math.min(0.9, Math.max(0, crop.bottom)),
  };
  if (out.left + out.right > 0.9) out.right = Math.max(0, 0.9 - out.left);
  if (out.top + out.bottom > 0.9) out.bottom = Math.max(0, 0.9 - out.top);
  return out;
}

const CROP_KEYS = new Set(['left', 'top', 'right', 'bottom']);

export function readCrop(value: Json): Crop | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // All four edges are required numbers; anything else drops the crop.
  const edges = (['left', 'top', 'right', 'bottom'] as const).map((key) => object[key]);
  if (!edges.every((edge) => typeof edge === 'number' && Number.isFinite(edge))) return null;
  return {
    left: edges[0] as number,
    top: edges[1] as number,
    right: edges[2] as number,
    bottom: edges[3] as number,
  };
}

export function writeCrop(crop: Crop): Json {
  return { left: crop.left, top: crop.top, right: crop.right, bottom: crop.bottom };
}

/** One brush stroke over a cutout: which tool, how wide, and where it went.
 * Points are fractions of the source picture, `(0, 0)` its top-left, so a
 * stroke survives a change of output size, a crop or a flip. */
export interface Stroke {
  tool: BrushTool;
  /** The brush's diameter as a fraction of the picture's width. */
  size: number;
  /** The path, as `[x, y]` fractions. */
  points: [number, number][];
  /** The source instant, in seconds, the stroke was painted at. */
  at: number | null;
}

const STROKE_KEYS = new Set(['tool', 'size', 'points', 'at']);

export function readStroke(value: Json): Stroke | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // `tool`, `size` and `points` are required; one bad point fails the stroke,
  // and a stroke that does not parse takes the cutout with it (plain `Vec`,
  // not the tolerant wire list).
  const toolValue = object['tool'];
  const tool =
    typeof toolValue === 'string'
      ? BRUSH_TOOLS.find((name) => name.toLowerCase() === toolValue.trim().toLowerCase())
      : undefined;
  if (!tool) return null;
  const size = object['size'];
  if (typeof size !== 'number' || !Number.isFinite(size)) return null;
  const rawPoints = object['points'];
  if (!Array.isArray(rawPoints)) return null;
  const points: [number, number][] = [];
  for (const point of rawPoints) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [x, y] = point as [Json, Json];
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      return null;
    }
    points.push([x, y]);
  }
  return {
    tool,
    size,
    points,
    at: maybe(object['at'], (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
  };
}

/** A stroke held to the brush floors and ceilings; `null` for one with no
 * path. Port of `Stroke::tidy`. */
export function tidyStroke(stroke: Stroke): Stroke | null {
  if (stroke.points.length === 0) return null;
  return {
    ...stroke,
    size: clampFinite(stroke.size, MIN_BRUSH, MIN_BRUSH, MAX_BRUSH),
    points: stroke.points.map(([x, y]) => [finite(x, 0.5), finite(y, 0.5)] as [number, number]),
    at: stroke.at === null ? null : finite(stroke.at, 0),
  };
}

export function writeStroke(stroke: Stroke): Json {
  return {
    tool: stroke.tool,
    size: stroke.size,
    points: stroke.points.map(([x, y]) => [x, y]),
    ...(stroke.at !== null ? { at: stroke.at } : {}),
  };
}

/** The background taken away by a mask rather than a key colour. */
export interface Cutout {
  /** Automatic keeps what the model finds; custom adds the strokes. */
  mode: CutoutMode;
  /** What the model looks for. Left out of the document when auto. */
  subject: Subject;
  /** How far the edge is softened, as a fraction of the picture's width. */
  feather: number;
  /** Corrections painted on the monitor, in the order they were made. */
  strokes: Stroke[];
}

const CUTOUT_KEYS = new Set(['mode', 'subject', 'feather', 'strokes']);

export function readCutout(value: Json): Cutout | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // `mode` is required and unknown modes take the whole cutout with them;
  // a stroke that does not parse does the same (a plain `Vec` in the
  // document, not the tolerant wire list).
  const modeValue = object['mode'];
  const mode =
    typeof modeValue === 'string'
      ? CUTOUT_MODES.find((name) => name.toLowerCase() === modeValue.trim().toLowerCase())
      : undefined;
  if (!mode) return null;
  const strokes: Stroke[] = [];
  const rawStrokes = object['strokes'];
  if (rawStrokes !== undefined && rawStrokes !== null) {
    if (!Array.isArray(rawStrokes)) return null;
    for (const entry of rawStrokes) {
      const stroke = readStroke(entry);
      if (!stroke) return null;
      strokes.push(stroke);
    }
  }
  return {
    mode,
    subject: parseSubject(object['subject']),
    feather: clampFinite(num(object['feather'], DEFAULT_FEATHER), DEFAULT_FEATHER, 0, MAX_FEATHER),
    strokes,
  };
}

/** Port of `Cutout::tidy`: the feather held to its range, every stroke that
 * has a path held to the brush floors and ceilings. */
export function tidyCutout(cutout: Cutout): Cutout {
  return {
    ...cutout,
    feather: clampFinite(cutout.feather, DEFAULT_FEATHER, 0, MAX_FEATHER),
    strokes: cutout.strokes.map(tidyStroke).filter((stroke): stroke is Stroke => stroke !== null),
  };
}

export function writeCutout(cutout: Cutout): Json {
  return {
    mode: cutout.mode,
    ...(cutout.subject !== 'auto' ? { subject: cutout.subject } : {}),
    ...(cutout.feather !== DEFAULT_FEATHER ? { feather: cutout.feather } : {}),
    ...(cutout.strokes.length > 0 ? { strokes: cutout.strokes.map(writeStroke) } : {}),
  };
}

/** One key on one parameter of an applied effect. */
export interface ParamKey {
  /** Where in the clip, as a fraction of its timeline length, `0..=1`. */
  at: number;
  /** The value there, in the parameter's own units. */
  value: number;
  /** How this key is approached from the previous one. */
  ease: KeyEase;
}

export function readParamKey(value: Json): ParamKey | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // `at` and `value` are required numbers; `ease` defaults to a straight line.
  const at = object['at'];
  const val = object['value'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  return {
    at,
    value: val,
    ease: KeyEase.fromWire(object['ease']),
  };
}

export function writeParamKey(key: ParamKey): Json {
  return {
    at: key.at,
    value: key.value,
    ...(key.ease.equals(KeyEase.LINEAR) ? {} : { ease: key.ease.toJson() }),
  };
}

/** One applied audio filter or video effect: a catalogue id plus whatever
 * parameters were set. */
export interface AppliedFilter {
  /** Which catalogue entry this is, e.g. "sepia". An id the catalogue no
   * longer knows is simply skipped at render time. */
  id: string;
  /** The user's knob settings, keyed by parameter name; ordered so
   * serialisation is stable. */
  params: Record<string, number>;
  /** False bypasses without losing settings. Absent means enabled. */
  enabled: boolean;
  /** The knobs that ride rather than hold: a sorted run of keys per parameter
   * name. A parameter with keys is played from them and its `params` entry is
   * only what it falls back to. */
  keys: Record<string, ParamKey[]>;
}

const APPLIED_FILTER_KEYS = new Set(['id', 'params', 'enabled', 'keys']);

export function readAppliedFilter(value: Json): AppliedFilter | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // `id` is required. A knob that is not a number fails the whole filter —
  // it is a plain map in the document, not a tolerant wire list.
  const id = object['id'];
  if (typeof id !== 'string') return null;
  const params: Record<string, number> = {};
  const rawParams = asObjectSafe(object['params']);
  if (object['params'] !== undefined && object['params'] !== null) {
    if (!rawParams) return null;
    for (const [name, entry] of Object.entries(rawParams)) {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
      params[name] = entry;
    }
  }
  const keys: Record<string, ParamKey[]> = {};
  const rawKeys = asObjectSafe(object['keys']);
  if (rawKeys) {
    for (const [name, run] of Object.entries(rawKeys)) {
      // Port of `wire::runs`: one sorted run per parameter name.
      const parsed = listOf(run, readParamKey).sort((a, b) => a.at - b.at);
      if (parsed.length > 0) keys[name] = parsed;
    }
  }
  return {
    id,
    params,
    enabled: bool(object['enabled'], true),
    keys,
  };
}

/** Port of `AppliedFilter::sort_keys`. */
export function sortFilterKeys(filter: AppliedFilter): void {
  for (const run of Object.values(filter.keys)) {
    run.sort((a, b) => a.at - b.at);
  }
}

export function writeAppliedFilter(filter: AppliedFilter): Json {
  const keys: JsonObject = {};
  for (const name of Object.keys(filter.keys).sort()) {
    const run = filter.keys[name];
    if (run && run.length > 0) keys[name] = run.map(writeParamKey);
  }
  const params: JsonObject = {};
  for (const name of Object.keys(filter.params).sort()) {
    params[name] = filter.params[name] as number;
  }
  return {
    id: filter.id,
    params,
    ...(filter.enabled ? {} : { enabled: false }),
    ...(Object.keys(keys).length > 0 ? { keys } : {}),
  };
}

/** One property's keys, as `(at, value, ease)` over `0..=1` of the clip's
 * length. */
export interface ClipKey {
  property: KeyProperty;
  at: number;
  value: number;
  ease: KeyEase;
}

const CLIP_KEY_KEYS = new Set(['property', 'at', 'value', 'ease']);

export function readClipKey(value: Json): ClipKey | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // `property`, `at` and `value` are required; an unknown property drops
  // the key (the wire list keeps what parses).
  const property = KeyProperty.fromName(str(object['property'], ''));
  if (!property) return null;
  const at = object['at'];
  const val = object['value'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  return {
    property,
    at,
    value: val,
    ease: KeyEase.fromWire(object['ease']),
  };
}

export function writeClipKey(key: ClipKey): Json {
  return {
    property: key.property,
    at: key.at,
    value: key.value,
    ...(key.ease.equals(KeyEase.LINEAR) ? {} : { ease: key.ease.toJson() }),
  };
}

/** One point of a speed curve: `(at, speed)`, `at` a fraction of the clip's
 * timeline length. */
export interface SpeedPoint {
  at: number;
  speed: number;
}

const SPEED_POINT_KEYS = new Set(['at', 'speed']);

export function readSpeedPoint(value: Json): SpeedPoint | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  const at = object['at'];
  const speed = object['speed'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return null;
  return { at, speed };
}

export function writeSpeedPoint(point: SpeedPoint): Json {
  return { at: point.at, speed: point.speed };
}

/** A clip's Enhance, once it has a copy. */
export interface Enhanced {
  /** The bin item the clip was cut from. */
  original: string;
  /** The bin item holding the enhanced copy. */
  copy: string;
  /** Whether the clip shows the copy. */
  on: boolean;
}

const ENHANCED_KEYS = new Set(['original', 'copy', 'on']);

export function readEnhanced(value: Json): Enhanced | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  const original = object['original'];
  const copy = object['copy'];
  const on = object['on'];
  if (typeof original !== 'string' || typeof copy !== 'string' || typeof on !== 'boolean') return null;
  return { original, copy, on };
}

export function writeEnhanced(enhanced: Enhanced): Json {
  return { original: enhanced.original, copy: enhanced.copy, on: enhanced.on };
}

/** A transition on the cut into a clip. */
export interface Transition {
  /** Which transition from the catalogue, e.g. "cross-fade". */
  id: string;
  /** Seconds the transition covers. */
  duration: number;
}

const TRANSITION_KEYS = new Set(['id', 'duration']);

export function readTransition(value: Json): Transition | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // `id` is required; `duration` defaults to one second.
  const id = object['id'];
  if (typeof id !== 'string') return null;
  return { id, duration: num(object['duration'], 1) };
}

export function writeTransition(transition: Transition): Json {
  return {
    id: transition.id,
    ...(transition.duration !== 1 ? { duration: transition.duration } : {}),
  };
}

// ---------------------------------------------------------------------------
// Text and shape styles.
// ---------------------------------------------------------------------------

/** A title's styling. Sizes are fractions of the frame, so a title composed
 * against 1080p lands correctly exported at 4K. */
export interface TextStyle {
  content: string;
  fontFamily: string;
  /** Fraction of frame height. */
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  align: TextAlign;
  opacity: number;
  strokeWidth: number;
  strokeColor: string;
  shadow: boolean;
  /** The plate colour behind the text; empty is no plate. */
  background: string;
  backgroundRadius: number;
  backgroundPaddingX: number;
  backgroundPaddingY: number;
  lineHeight: number;
  tracking: number;
  maxWidth: number;
  maxHeight: number;
}

/** Port of `TextStyle::default`: the window's default title. */
export function defaultTextStyle(): TextStyle {
  return {
    content: 'Your text',
    fontFamily: '"Cabinet Grotesk"',
    fontSize: 0.09,
    fontWeight: 700,
    italic: false,
    color: '#ffffff',
    align: 'center',
    opacity: 1,
    strokeWidth: 0,
    strokeColor: '#000000',
    shadow: true,
    background: '',
    backgroundRadius: 0.0135,
    backgroundPaddingX: 0.0315,
    backgroundPaddingY: 0.018,
    lineHeight: 1.2,
    tracking: 0,
    maxWidth: 0,
    maxHeight: 0,
  };
}

const TEXT_STYLE_KEYS = new Set([
  'content',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'italic',
  'color',
  'align',
  'opacity',
  'strokeWidth',
  'strokeColor',
  'shadow',
  'background',
  'backgroundRadius',
  'backgroundPaddingX',
  'backgroundPaddingY',
  'lineHeight',
  'tracking',
  'maxWidth',
  'maxHeight',
]);

export function readTextStyle(value: Json): TextStyle | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  const base = defaultTextStyle();
  return {
    content: str(object['content'], base.content),
    fontFamily: str(object['fontFamily'], base.fontFamily),
    fontSize: num(object['fontSize'], base.fontSize),
    fontWeight: num(object['fontWeight'], base.fontWeight),
    italic: bool(object['italic'], base.italic),
    color: str(object['color'], base.color),
    align: parseTextAlign(object['align']),
    opacity: num(object['opacity'], base.opacity),
    strokeWidth: num(object['strokeWidth'], base.strokeWidth),
    strokeColor: str(object['strokeColor'], base.strokeColor),
    shadow: bool(object['shadow'], base.shadow),
    background: str(object['background'], base.background),
    backgroundRadius: num(object['backgroundRadius'], base.backgroundRadius),
    backgroundPaddingX: num(object['backgroundPaddingX'], base.backgroundPaddingX),
    backgroundPaddingY: num(object['backgroundPaddingY'], base.backgroundPaddingY),
    lineHeight: num(object['lineHeight'], base.lineHeight),
    tracking: num(object['tracking'], base.tracking),
    maxWidth: num(object['maxWidth'], base.maxWidth),
    maxHeight: num(object['maxHeight'], base.maxHeight),
  };
}

/** Port of `TextStyle::tidy`. */
export function tidyTextStyle(style: TextStyle): TextStyle {
  const base = defaultTextStyle();
  return {
    ...style,
    fontSize: clampFinite(style.fontSize, base.fontSize, 0.01, 1),
    fontWeight: clampFinite(style.fontWeight, base.fontWeight, 100, 900),
    opacity: clampFinite(style.opacity, base.opacity, 0, 1),
    strokeWidth: Math.max(0, finite(style.strokeWidth, base.strokeWidth)),
    lineHeight: Math.max(0.5, finite(style.lineHeight, base.lineHeight)),
    tracking: finite(style.tracking, base.tracking),
    maxWidth: Math.max(0, finite(style.maxWidth, base.maxWidth)),
    maxHeight: Math.max(0, finite(style.maxHeight, base.maxHeight)),
    backgroundRadius: Math.max(0, finite(style.backgroundRadius, base.backgroundRadius)),
    backgroundPaddingX: Math.max(0, finite(style.backgroundPaddingX, base.backgroundPaddingX)),
    backgroundPaddingY: Math.max(0, finite(style.backgroundPaddingY, base.backgroundPaddingY)),
  };
}

export function writeTextStyle(style: TextStyle): Json {
  const base = defaultTextStyle();
  return {
    content: style.content,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    italic: style.italic,
    color: style.color,
    align: style.align,
    opacity: style.opacity,
    strokeWidth: style.strokeWidth,
    strokeColor: style.strokeColor,
    shadow: style.shadow,
    background: style.background,
    backgroundRadius: style.backgroundRadius,
    backgroundPaddingX: style.backgroundPaddingX,
    backgroundPaddingY: style.backgroundPaddingY,
    lineHeight: style.lineHeight,
    tracking: style.tracking,
    maxWidth: style.maxWidth,
    maxHeight: style.maxHeight,
  };
}

/** A figure drawn over the picture. */
export interface ShapeStyle {
  kind: ShapeKind;
  /** A fraction of frame height. */
  size: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

/** Port of `ShapeStyle::default`: solid white, and a visible rule for the
 * kinds that are nothing but their stroke. */
export function defaultShapeStyle(): ShapeStyle {
  return { kind: 'square', size: 0.35, fill: '#ffffff', stroke: '', strokeWidth: 0.012 };
}

const SHAPE_STYLE_KEYS = new Set(['kind', 'size', 'fill', 'stroke', 'strokeWidth']);

export function readShapeStyle(value: Json): ShapeStyle | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  const base = defaultShapeStyle();
  return {
    kind: parseShapeKind(object['kind']),
    size: num(object['size'], base.size),
    fill: str(object['fill'], base.fill),
    stroke: str(object['stroke'], base.stroke),
    strokeWidth: num(object['strokeWidth'], base.strokeWidth),
  };
}

/** Port of `ShapeStyle::tidy`. */
export function tidyShapeStyle(style: ShapeStyle): ShapeStyle {
  const base = defaultShapeStyle();
  return {
    ...style,
    size: clampFinite(style.size, base.size, 0.01, 2),
    strokeWidth: clampFinite(style.strokeWidth, base.strokeWidth, 0, 0.5),
  };
}

export function writeShapeStyle(style: ShapeStyle): Json {
  return {
    kind: style.kind,
    size: style.size,
    fill: style.fill,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
  };
}

// ---------------------------------------------------------------------------
// Media, tracks, clips, timelines, project.
// ---------------------------------------------------------------------------

/** One imported file (or generated take), shared by all timelines. */
export interface MediaItem {
  /** Minted by the editor ("m1", "m2", ...) and never re-issued; clips
   * reference media by this id. */
  id: string;
  /** Path to the user's disk — or, in the web build, the name of the asset
   * the OPFS/IndexedDB layer will hand back. Doubles as the duplicate check. */
  path: string;
  name: string;
  /** Seconds. `null` when the container did not say. */
  duration: number | null;
  kind: MediaKind;
  width: number | null;
  height: number | null;
  /** Frames per second as a decimal — convenient for display, not exact. */
  frameRate: number | null;
  /** The exact fraction the engine works in, e.g. "30000/1001". */
  frameRateFraction: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Whether the file carries an audio stream; gates `DetachAudio`. */
  hasAudio: boolean;
  /** Every audio stream the file carries, in file order, when the probe listed
   * them. */
  audioTracks: AudioTrack[];
  /** True when this item is a template slot: a stand-in waiting to be replaced
   * by the user's own file. */
  slot: boolean;
  /** What made the file, when it was the editor and not the user's import. */
  origin: MediaOrigin | null;
  colorRange: ColorRange | null;
  /** Left out of the document for SDR. */
  colorSpace: ColorSpace;
  /** Fields this build does not know. */
  extra: Extra;
}

const MEDIA_ITEM_KEYS = new Set([
  'id',
  'path',
  'name',
  'duration',
  'kind',
  'width',
  'height',
  'frameRate',
  'frameRateFraction',
  'videoCodec',
  'audioCodec',
  'hasAudio',
  'audioTracks',
  'slot',
  'origin',
  'colorRange',
  'colorSpace',
]);

export function readMediaItem(value: Json): MediaItem | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  return {
    id: str(object['id'], ''),
    path: str(object['path'], ''),
    name: str(object['name'], ''),
    duration: maybe(object['duration'], (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
    kind: parseMediaKind(object['kind']),
    width: maybe(object['width'], (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)),
    height: maybe(object['height'], (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)),
    frameRate: maybe(object['frameRate'], (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
    frameRateFraction: maybe(object['frameRateFraction'], (v) => (typeof v === 'string' ? v : null)),
    videoCodec: maybe(object['videoCodec'], (v) => (typeof v === 'string' ? v : null)),
    audioCodec: maybe(object['audioCodec'], (v) => (typeof v === 'string' ? v : null)),
    hasAudio: bool(object['hasAudio'], false),
    audioTracks: listOf(object['audioTracks'], readAudioTrack),
    slot: bool(object['slot'], false),
    origin: parseMediaOrigin(object['origin']),
    colorRange: parseColorRange(object['colorRange']),
    colorSpace: parseColorSpace(object['colorSpace']),
    extra: collectExtra(object, MEDIA_ITEM_KEYS),
  };
}

/** Port of `MediaItem::tidy`: a nameless item is named by its path. */
export function tidyMediaItem(item: MediaItem): MediaItem {
  return { ...item, name: item.name === '' ? item.path : item.name };
}

export function writeMediaItem(item: MediaItem): Json {
  return {
    id: item.id,
    path: item.path,
    name: item.name,
    ...(item.duration !== null ? { duration: item.duration } : {}),
    kind: item.kind,
    ...(item.width !== null ? { width: item.width } : {}),
    ...(item.height !== null ? { height: item.height } : {}),
    ...(item.frameRate !== null ? { frameRate: item.frameRate } : {}),
    ...(item.frameRateFraction !== null ? { frameRateFraction: item.frameRateFraction } : {}),
    ...(item.videoCodec !== null ? { videoCodec: item.videoCodec } : {}),
    ...(item.audioCodec !== null ? { audioCodec: item.audioCodec } : {}),
    hasAudio: item.hasAudio,
    ...(item.audioTracks.length > 0 ? { audioTracks: item.audioTracks.map(writeAudioTrack) } : {}),
    ...(item.slot ? { slot: true } : {}),
    ...(item.origin !== null ? { origin: item.origin } : {}),
    ...(item.colorRange !== null ? { colorRange: item.colorRange } : {}),
    ...(colorSpaceIsSdr(item.colorSpace) ? {} : { colorSpace: item.colorSpace }),
    ...item.extra,
  };
}

/** A lane of a document timeline. */
export interface DocumentTrack {
  /** Minted per timeline ("t5", or "T1".."T4" for the first timeline's
   * starter lanes); never shared between timelines. */
  id: string;
  /** Video clips on this track are left out of the composite when false. */
  visible: boolean;
  /** Audio on this track is silent when true. */
  muted: boolean;
  extra: Extra;
}

const DOCUMENT_TRACK_KEYS = new Set(['id', 'visible', 'muted']);

/** Port of `Track::default`. */
export function defaultDocumentTrack(): DocumentTrack {
  return { id: '', visible: true, muted: false, extra: {} };
}

export function readDocumentTrack(value: Json): DocumentTrack | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  return {
    id: str(object['id'], ''),
    visible: bool(object['visible'], true),
    muted: bool(object['muted'], false),
    extra: collectExtra(object, DOCUMENT_TRACK_KEYS),
  };
}

export function writeDocumentTrack(track: DocumentTrack): Json {
  return {
    id: track.id,
    visible: track.visible,
    muted: track.muted,
    ...track.extra,
  };
}

/** One placed piece of a timeline: a stretch of media (or a title) with its
 * timing, mix, transform, and effects. Everything an edit decision touches
 * lives here, which is why most commands are clip commands. */
export interface DocumentClip {
  /** Minted by the editor ("c1", "c2", ...); how every command names its
   * target. Survives splits — the head keeps the id — and merges. */
  id: string;
  /** The lane this clip sits on. The reader drops clips whose track vanished. */
  trackId: string;
  /** Empty for a text clip, which has no file behind it. */
  mediaId: string;
  name: string;
  kind: ClipKind;
  /** Seconds from the start of the timeline. */
  start: number;
  /** Seconds of timeline the clip occupies. Source seconds divided by `speed`;
   * never below a sixtieth of a second. */
  duration: number;
  /** In-point: how far into the media the clip starts. */
  sourceStart: number;
  /** Linear gain, 1 being unity. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Clockwise rotation in degrees, about the picture's centre. */
  rotation: number;
  stretchX: number;
  stretchY: number;
  /** Blend strength over whatever is beneath, in `0..1`. */
  opacity: number;
  /** Playback rate. With a curve set this is the curve's mean. */
  speed: number;
  /** Speed as it changes over the clip. Null is the constant rate. */
  speedCurve: SpeedPoint[] | null;
  /** The user's own keys, sorted by property and then by `at`. Empty is a clip
   * whose properties are the constants above. */
  keys: ClipKey[];
  flipH: boolean;
  flipV: boolean;
  /** How the picture's colour meets what is beneath it: "normal", "multiply",
   * "screen", "add", "lighten", "darken". Empty is normal. */
  blend: string;
  crop: Crop | null;
  cutout: Cutout | null;
  /** Keep voices at their natural pitch when `speed` is not 1. */
  preservePitch: boolean;
  /** Audio filters, in order — order is audible. */
  filters: AppliedFilter[];
  /** Video effects, in order — the visual sibling of `filters`. */
  videoEffects: AppliedFilter[];
  /** Which of the media's audio streams this clip plays, by index. */
  audioStream: number | null;
  /** True when a video clip's embedded audio is detached out of it. */
  muted: boolean | null;
  /** On a detached audio clip: the video clip the sound came from. */
  detachedFrom: string | null;
  /** The transition on the cut into this clip, if any. */
  transitionIn: Transition | null;
  enhanced: Enhanced | null;
  /** The overlay, when this is a text clip. */
  text: TextStyle | null;
  /** The figure, when this is a shape clip. */
  shape: ShapeStyle | null;
  /** Fields this build does not know, kept to round-trip. */
  extra: Extra;
}

const DOCUMENT_CLIP_KEYS = new Set([
  'id',
  'trackId',
  'mediaId',
  'name',
  'kind',
  'start',
  'duration',
  'sourceStart',
  'volume',
  'fadeIn',
  'fadeOut',
  'scale',
  'offsetX',
  'offsetY',
  'rotation',
  'stretchX',
  'stretchY',
  'opacity',
  'speed',
  'speedCurve',
  'keys',
  'flipH',
  'flipV',
  'blend',
  'crop',
  'cutout',
  'preservePitch',
  'filters',
  'videoEffects',
  'audioStream',
  'muted',
  'detachedFrom',
  'transitionIn',
  'enhanced',
  'text',
  'shape',
]);

/**
 * A clip with nothing set but what names and places it: unity gain, scale and
 * speed, no fades, no effects, no keys. Every constructor starts here and sets
 * the few fields its kind needs. Port of `Clip::blank`.
 */
export function blankClip(
  id: string,
  trackId: string,
  kind: ClipKind,
  name: string,
  start: number,
  duration: number,
): DocumentClip {
  return {
    id,
    trackId,
    mediaId: '',
    name,
    kind,
    start: Math.max(0, start),
    duration: Math.max(MIN_CLIP_DURATION, duration),
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

/** What a document entry starts from before its own fields land on it:
 * {@link blankClip} with no id, on no track, one second of video. Port of
 * `impl Default for Clip`. */
export function defaultDocumentClip(): DocumentClip {
  return blankClip('', '', 'video', 'clip', 0, 1);
}

export function readDocumentClip(value: Json): DocumentClip | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  const base = defaultDocumentClip();
  return {
    id: str(object['id'], base.id),
    trackId: str(object['trackId'], base.trackId),
    mediaId: str(object['mediaId'], base.mediaId),
    name: str(object['name'], base.name),
    kind: parseClipKind(object['kind']),
    start: num(object['start'], base.start),
    duration: num(object['duration'], base.duration),
    sourceStart: num(object['sourceStart'], base.sourceStart),
    volume: num(object['volume'], base.volume),
    fadeIn: num(object['fadeIn'], base.fadeIn),
    fadeOut: num(object['fadeOut'], base.fadeOut),
    scale: num(object['scale'], base.scale),
    offsetX: num(object['offsetX'], base.offsetX),
    offsetY: num(object['offsetY'], base.offsetY),
    rotation: num(object['rotation'], base.rotation),
    stretchX: num(object['stretchX'], base.stretchX),
    stretchY: num(object['stretchY'], base.stretchY),
    opacity: num(object['opacity'], base.opacity),
    speed: num(object['speed'], base.speed),
    speedCurve: maybeListOf(object['speedCurve'], readSpeedPoint),
    keys: listOf(object['keys'], readClipKey),
    flipH: bool(object['flipH'], base.flipH),
    flipV: bool(object['flipV'], base.flipV),
    blend: str(object['blend'], base.blend),
    crop: maybe(object['crop'], readCrop),
    cutout: maybe(object['cutout'], readCutout),
    preservePitch: bool(object['preservePitch'], base.preservePitch),
    filters: listOf(object['filters'], readAppliedFilter),
    videoEffects: listOf(object['videoEffects'], readAppliedFilter),
    audioStream: maybe(object['audioStream'], (v) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null,
    ),
    muted: maybe(object['muted'], (v) => (typeof v === 'boolean' ? v : null)),
    detachedFrom: maybe(object['detachedFrom'], (v) => (typeof v === 'string' ? v : null)),
    transitionIn: maybe(object['transitionIn'], readTransition),
    enhanced: maybe(object['enhanced'], readEnhanced),
    text: maybe(object['text'], readTextStyle),
    shape: maybe(object['shape'], readShapeStyle),
    extra: collectExtra(object, DOCUMENT_CLIP_KEYS),
  };
}

/** The clip's own constant for a keyable property — what the property is
 * before its keys ride on it. Port of `Clip::constant`. */
export function clipConstant(clip: DocumentClip, property: KeyProperty): number {
  switch (property) {
    case 'scale':
      return clip.scale;
    case 'offsetX':
      return clip.offsetX;
    case 'offsetY':
      return clip.offsetY;
    case 'rotation':
      return clip.rotation;
    case 'opacity':
      return clip.opacity;
    case 'volume':
      return clip.volume;
  }
}

/** The keys on one property, sorted by `at`. Port of `Clip::keys_on`. */
export function clipKeysOn(clip: DocumentClip, property: KeyProperty): ClipKey[] {
  return clip.keys.filter((key) => key.property === property).sort((a, b) => a.at - b.at);
}

/** True when the property is played from keys rather than from its constant.
 * Port of `Clip::is_keyed`. */
export function clipIsKeyed(clip: DocumentClip, property: KeyProperty): boolean {
  return clip.keys.some((key) => key.property === property);
}

/** Sorts the keys by property and then by `at`. Port of `Clip::sort_keys`. */
export function sortClipKeys(clip: DocumentClip): void {
  const order = new Map<string, number>(['scale', 'offsetX', 'offsetY', 'rotation', 'opacity', 'volume'].map((name, index) => [name, index]));
  clip.keys.sort((a, b) => {
    const byProperty = (order.get(a.property) ?? 99) - (order.get(b.property) ?? 99);
    return byProperty !== 0 ? byProperty : a.at - b.at;
  });
}

/**
 * Pulls every number back into the range a command would have held it to: the
 * floors and ceilings in `ranges`, the rotation wrapped, non-finite values
 * replaced by their neutral, the crop and the cutout tidied, the keys sorted.
 * What the document reader runs over a clip it has just read, so a hand-edited
 * or older file holds nothing an edit could not have produced. Port of
 * `Clip::tidy`.
 */
export function tidyDocumentClip(clip: DocumentClip): DocumentClip {
  const out: DocumentClip = {
    ...clip,
    start: clampFinite(clip.start, 0, 0, MAX_TIME),
    duration: clampFinite(clip.duration, 1, MIN_CLIP_DURATION, MAX_TIME),
    sourceStart: clampFinite(clip.sourceStart, 0, 0, MAX_TIME),
    volume: Math.max(0, finite(clip.volume, 1)),
    fadeIn: clampFinite(clip.fadeIn, 0, 0, MAX_TIME),
    fadeOut: clampFinite(clip.fadeOut, 0, 0, MAX_TIME),
    scale: clampFinite(clip.scale, 1, MIN_SCALE, MAX_SCALE),
    offsetX: clampFinite(clip.offsetX, 0, -MAX_OFFSET, MAX_OFFSET),
    offsetY: clampFinite(clip.offsetY, 0, -MAX_OFFSET, MAX_OFFSET),
    rotation: wrapRotation(finite(clip.rotation, 0)),
    stretchX: clampFinite(clip.stretchX, 1, MIN_STRETCH, MAX_STRETCH),
    stretchY: clampFinite(clip.stretchY, 1, MIN_STRETCH, MAX_STRETCH),
    opacity: clampFinite(clip.opacity, 1, 0, 1),
    speed: clampFinite(clip.speed, 1, MIN_SPEED, MAX_SPEED),
    keys: clip.keys
      .filter((key) => key.at >= 0 && key.at <= 1 && Number.isFinite(key.value))
      .map((key) => ({ ...key, value: clampKeyValue(key) })),
  };

  // The speed curve: points outside the unit interval dropped, speeds held to
  // the same range as the constant rate; nothing left is no curve.
  if (clip.speedCurve) {
    const points = clip.speedCurve
      .filter((point) => Number.isFinite(point.at) && point.at >= 0 && point.at <= 1)
      .map((point) => ({ at: point.at, speed: clampFinite(point.speed, 1, MIN_SPEED, MAX_SPEED) }));
    out.speedCurve = points.length > 0 ? points : null;
  }

  if (out.crop) {
    const crop = tidyCrop(out.crop);
    out.crop = cropIsNone(crop) ? null : crop;
  }
  if (out.cutout) out.cutout = tidyCutout(out.cutout);
  if (out.transitionIn) {
    out.transitionIn = {
      ...out.transitionIn,
      duration: Math.max(MIN_TRANSITION, finite(out.transitionIn.duration, 1)),
    };
  }
  sortClipKeys(out);
  for (const chain of [out.filters, out.videoEffects]) {
    for (const entry of chain) sortFilterKeys(entry);
  }
  if (out.text) out.text = tidyTextStyle(out.text);
  if (out.shape) out.shape = tidyShapeStyle(out.shape);
  if (out.muted === false) out.muted = null;
  return out;
}

/** A key holds what the field itself may hold. Rotation is the one exception:
 * a key past a full turn is a spin, and wrapping it would take the spin away. */
function clampKeyValue(key: ClipKey): number {
  switch (key.property) {
    case 'scale':
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, key.value));
    case 'opacity':
      return Math.min(1, Math.max(0, key.value));
    case 'volume':
      return Math.max(0, key.value);
    case 'offsetX':
    case 'offsetY':
      return Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, key.value));
    case 'rotation':
      return key.value;
  }
}

export function writeDocumentClip(clip: DocumentClip): Json {
  return {
    id: clip.id,
    trackId: clip.trackId,
    mediaId: clip.mediaId,
    name: clip.name,
    kind: clip.kind,
    start: clip.start,
    duration: clip.duration,
    sourceStart: clip.sourceStart,
    volume: clip.volume,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    scale: clip.scale,
    offsetX: clip.offsetX,
    offsetY: clip.offsetY,
    rotation: clip.rotation,
    ...(clip.stretchX !== 1 ? { stretchX: clip.stretchX } : {}),
    ...(clip.stretchY !== 1 ? { stretchY: clip.stretchY } : {}),
    opacity: clip.opacity,
    speed: clip.speed,
    ...(clip.speedCurve ? { speedCurve: clip.speedCurve.map(writeSpeedPoint) } : {}),
    ...(clip.keys.length > 0 ? { keys: clip.keys.map(writeClipKey) } : {}),
    ...(clip.flipH ? { flipH: true } : {}),
    ...(clip.flipV ? { flipV: true } : {}),
    ...(clip.blend ? { blend: clip.blend } : {}),
    ...(clip.crop ? { crop: writeCrop(clip.crop) } : {}),
    ...(clip.cutout ? { cutout: writeCutout(clip.cutout) } : {}),
    preservePitch: clip.preservePitch,
    filters: clip.filters.map(writeAppliedFilter),
    videoEffects: clip.videoEffects.map(writeAppliedFilter),
    ...(clip.audioStream !== null ? { audioStream: clip.audioStream } : {}),
    ...(clip.muted !== null ? { muted: clip.muted } : {}),
    ...(clip.detachedFrom !== null ? { detachedFrom: clip.detachedFrom } : {}),
    ...(clip.transitionIn ? { transitionIn: writeTransition(clip.transitionIn) } : {}),
    ...(clip.enhanced ? { enhanced: writeEnhanced(clip.enhanced) } : {}),
    ...(clip.text ? { text: writeTextStyle(clip.text) } : {}),
    ...(clip.shape ? { shape: writeShapeStyle(clip.shape) } : {}),
    ...clip.extra,
  };
}

/** The frame this timeline renders to and the rate it runs at. Each
 * timeline's own: a vertical cut for one platform and a wide one for another
 * are different frames of the same media. */
export interface VideoSettings {
  width: number;
  height: number;
  /** Numerator of the frame rate, e.g. 30000 for 29.97 fps. */
  rateNum: number;
  rateDen: number;
  /** Left out of the document for SDR. */
  colorSpace: ColorSpace;
}

const VIDEO_SETTINGS_KEYS = new Set(['width', 'height', 'rateNum', 'rateDen', 'colorSpace']);

/** 1080p at 30 in SDR, the frame a fresh project has always been born with.
 * Port of `VideoSettings::default`. */
export function defaultVideoSettings(): VideoSettings {
  return { width: 1920, height: 1080, rateNum: 30, rateDen: 1, colorSpace: 'sdr' };
}

export function readVideoSettings(value: Json): VideoSettings | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // The four frame fields are required numbers in the document; a block that
  // is missing one does not parse. Colour is optional, SDR when absent.
  const width = object['width'];
  const height = object['height'];
  const rateNum = object['rateNum'];
  const rateDen = object['rateDen'];
  for (const term of [width, height, rateNum, rateDen]) {
    if (typeof term !== 'number' || !Number.isFinite(term)) return null;
  }
  return {
    width: Math.trunc(width as number),
    height: Math.trunc(height as number),
    rateNum: Math.trunc(rateNum as number),
    rateDen: Math.trunc(rateDen as number),
    colorSpace: parseColorSpace(object['colorSpace']),
  };
}

/** The rate as a number, for anything that draws or counts frames. Port of
 * `VideoSettings::rate`. */
export function videoSettingsRate(settings: VideoSettings): number {
  return settings.rateNum / Math.max(1, settings.rateDen);
}

/**
 * This frame with every zero, negative or oversize field taken from `fallback`
 * instead, and the rate as a pair when it is not one a video has: a document
 * hand-edited into nonsense still opens at a size that is a size, and at a
 * rate the frame arithmetic can count in. Port of `VideoSettings::or`.
 */
export function videoSettingsOr(settings: VideoSettings, fallback: VideoSettings): VideoSettings {
  const usable = (value: number) => value > 0 && value <= MAX_SIDE;
  const merged: VideoSettings = {
    width: usable(settings.width) ? settings.width : fallback.width,
    height: usable(settings.height) ? settings.height : fallback.height,
    rateNum: settings.rateNum > 0 ? settings.rateNum : fallback.rateNum,
    rateDen: settings.rateDen > 0 ? settings.rateDen : fallback.rateDen,
    colorSpace: settings.colorSpace,
  };
  return FrameRate.checked(merged.rateNum, merged.rateDen)
    ? merged
    : { ...merged, rateNum: fallback.rateNum, rateDen: fallback.rateDen };
}

export function writeVideoSettings(settings: VideoSettings): Json {
  return {
    width: settings.width,
    height: settings.height,
    rateNum: settings.rateNum,
    rateDen: settings.rateDen,
    ...(colorSpaceIsSdr(settings.colorSpace) ? {} : { colorSpace: settings.colorSpace }),
  };
}

/** One timeline of the document: lanes and clips around its own frame. */
export interface DocumentTimeline {
  /** Minted by the editor ("tl2", ...), except the founding "TL1". */
  id: string;
  /** The tab label; "Timeline N" by default, renameable but never blank. */
  name: string;
  video: VideoSettings;
  /** The lanes, top to bottom. Never empty — `RemoveTrack` keeps a floor of
   * one. */
  tracks: DocumentTrack[];
  /** Every clip on this timeline, in insertion order, not time order — readers
   * must sort by `start` where order matters. */
  clips: DocumentClip[];
  extra: Extra;
}

const DOCUMENT_TIMELINE_KEYS = new Set(['id', 'name', 'video', 'tracks', 'clips']);

export function readDocumentTimeline(value: Json): DocumentTimeline | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // `video` is field-defaulted: absent means the standard frame. A block that
  // is present but does not parse drops the whole timeline — the wire list
  // keeps what parses, and a timeline whose frame is unreadable is not one.
  let video: VideoSettings;
  if (object['video'] === undefined || object['video'] === null) {
    video = defaultVideoSettings();
  } else {
    const parsed = readVideoSettings(object['video']);
    if (!parsed) return null;
    video = parsed;
  }
  return {
    id: str(object['id'], ''),
    name: str(object['name'], 'Timeline'),
    video,
    tracks: listOf(object['tracks'], readDocumentTrack),
    clips: listOf(object['clips'], readDocumentClip),
    extra: collectExtra(object, DOCUMENT_TIMELINE_KEYS),
  };
}

export function writeDocumentTimeline(timeline: DocumentTimeline): Json {
  return {
    id: timeline.id,
    name: timeline.name,
    video: writeVideoSettings(timeline.video),
    tracks: timeline.tracks.map(writeDocumentTrack),
    clips: timeline.clips.map(writeDocumentClip),
    ...timeline.extra,
  };
}

/** A font the user added from disk, available to every title. */
export interface CustomFont {
  family: string;
  path: string;
}

export function readCustomFont(value: Json): CustomFont | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  return { family: str(object['family'], ''), path: str(object['path'], '') };
}

export function writeCustomFont(font: CustomFont): Json {
  return { family: font.family, path: font.path };
}

/** The document's body: the bin, the fonts, and every timeline. The top-level
 * `name`/`video`/`tracks`/`clips` keys are the writer's mirror of the active
 * timeline and never live here. */
export interface ProjectDocument {
  /** The bin: every imported file, shared by all timelines. */
  media: MediaItem[];
  /** Fonts the user added from disk, available to every title. */
  fonts: CustomFont[];
  /** Every timeline, in tab order. Always at least one. */
  timelines: DocumentTimeline[];
  /** Which timeline commands act on. Always names a member of `timelines`. */
  activeTimelineId: string;
  /** Top-level fields this build does not know, kept to round-trip. */
  extra: Extra;
}

const PROJECT_KEYS = new Set(['media', 'fonts', 'timelines', 'activeTimelineId']);

/** A new project: one timeline, four lanes, at the default frame. Port of
 * `Project::new` / `Project::with_video`. */
export function createProjectDocument(video: VideoSettings = defaultVideoSettings()): ProjectDocument {
  return {
    media: [],
    fonts: [],
    timelines: [
      {
        id: 'TL1',
        name: 'Timeline 1',
        video,
        tracks: [1, 2, 3, 4].map((number) => ({ ...defaultDocumentTrack(), id: `T${number}` })),
        clips: [],
        extra: {},
      },
    ],
    activeTimelineId: 'TL1',
    extra: {},
  };
}

export function readProjectDocument(value: Json): ProjectDocument | null {
  const object = asObjectSafe(value);
  if (!object) return null;
  // Missing fields fall back to `Project::default()`, which is `Project::new`:
  // no bin, no fonts, and the founding "TL1" timeline with four lanes. An
  // *empty* `timelines` list stays empty and fails the load in `settle`.
  const fallback = createProjectDocument();
  return {
    media: listOf(object['media'], readMediaItem),
    fonts: listOf(object['fonts'], readCustomFont),
    timelines:
      object['timelines'] === undefined || object['timelines'] === null
        ? fallback.timelines
        : listOf(object['timelines'], readDocumentTimeline),
    activeTimelineId: str(object['activeTimelineId'], 'TL1'),
    extra: collectExtra(object, PROJECT_KEYS),
  };
}

/** The timeline being edited. The active id is maintained by the command layer,
 * but it degrades to the first timeline rather than failing. Port of
 * `Project::active`. */
export function activeTimeline(project: ProjectDocument): DocumentTimeline {
  return (
    project.timelines.find((timeline) => timeline.id === project.activeTimelineId) ??
    project.timelines[0]!
  );
}

// ---------------------------------------------------------------------------
// The reader pipeline: migrate, parse, settle. Port of `doc.rs`.
// ---------------------------------------------------------------------------

/** The version a document says it is. Documents from before the field existed
 * are version 1: that is the version their shape was given. Port of
 * `doc::document_version`. */
export function documentVersion(document: Json): number {
  const object = asObjectSafe(document);
  const version = object ? object['version'] : undefined;
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : 1;
}

/** One step of the reader's migration table: a name for the log, and the
 * rewrite. Each step is idempotent — a document already in the shape it
 * produces passes through unchanged — so the table is simply applied in
 * order, and a document at any age comes out at the current shape. */
export interface Migration {
  name: string;
  apply: (document: JsonObject) => void;
}

/** Timelines from the flat fields: a document written before there were
 * timelines carries `tracks` and `clips` at the top level, and they become the
 * founding timeline. Port of `lift_flat_timeline`. */
function liftFlatTimeline(document: JsonObject): void {
  const timelines = document['timelines'];
  if (Array.isArray(timelines) && timelines.length > 0) return;
  const tracks = document['tracks'];
  if (!Array.isArray(tracks) || tracks.length === 0) return;
  const clips = Array.isArray(document['clips']) ? document['clips'] : [];
  const timeline: JsonObject = { id: 'TL1', name: 'Timeline 1', tracks, clips };
  const video = asObjectSafe(document['video'] ?? null);
  if (video) timeline['video'] = video;
  document['timelines'] = [timeline];
}

/** Every timeline carries its frame: a timeline naming a zero dimension or
 * rate gets the shared top-level value for that field rather than the zero,
 * and one naming nothing gets the block whole. Port of
 * `give_timelines_their_frame`. */
function giveTimelinesTheirFrame(document: JsonObject): void {
  const shared = asObjectSafe(document['video'] ?? null) ?? {};
  const timelines = document['timelines'];
  if (!Array.isArray(timelines)) return;
  for (const entry of timelines) {
    const timeline = asObjectSafe(entry);
    if (!timeline) continue;
    const video = asObjectSafe(timeline['video'] ?? null) ?? {};
    for (const key of ['width', 'height', 'rateNum', 'rateDen']) {
      const own = video[key];
      const usable = typeof own === 'number' && Number.isInteger(own) && own > 0;
      const borrowed = shared[key];
      if (!usable && borrowed !== undefined) video[key] = borrowed;
    }
    if (Object.keys(video).length > 0) timeline['video'] = video;
  }
}

/** The migration table, oldest shape first. Add to the end; never reorder or
 * remove. Port of `doc::MIGRATIONS`. */
export const MIGRATIONS: readonly Migration[] = [
  { name: 'timelines from the flat fields', apply: liftFlatTimeline },
  { name: 'every timeline carries its frame', apply: giveTimelinesTheirFrame },
];

/** The document at this build's shape, or `null` for one from a later build.
 * Port of `doc::migrate`. */
export function migrate(document: Json): JsonObject | null {
  const object = asObjectSafe(document);
  if (!object) return null;
  if (documentVersion(object) > DOCUMENT_VERSION) return null;
  const out: JsonObject = { ...object };
  for (const migration of MIGRATIONS) migration.apply(out);
  return out;
}

/** The top-level keys the writer owns. Read, they would land in the project's
 * `extra` map and be written twice; they are the writer's to produce afresh.
 * Port of `doc::WRITER_OWNED`. */
export const WRITER_OWNED: readonly string[] = [
  'concat',
  'version',
  'name',
  'video',
  'tracks',
  'clips',
  'media',
  'fonts',
  'timelines',
  'activeTimelineId',
];

/**
 * Rebuilds a project from a document. `null` only when there is nothing to
 * open: a value that is not an object, a document from a later build, or one
 * with no timeline that has a lane. Port of `doc::from_document`.
 */
export function fromDocument(document: Json): ProjectDocument | null {
  const migrated = migrate(document);
  if (!migrated) return null;
  const project = readProjectDocument(migrated);
  if (!project) return null;
  return settle(project);
}

/** Everything the field defaults cannot decide about a freshly parsed project.
 * `null` when no timeline survives. Port of `doc::settle`. */
export function settle(project: ProjectDocument): ProjectDocument | null {
  for (const key of WRITER_OWNED) delete project.extra[key];
  // An empty path is a template's placeholder, not a broken entry.
  project.media = project.media
    .filter((item) => item.id !== '')
    .map(tidyMediaItem);
  const media = project.media;
  project.fonts = project.fonts.filter((font) => font.family !== '' && font.path !== '');

  const seenTimelines = new Set<string>();
  project.timelines = project.timelines
    .map((timeline) => settleTimeline(timeline, media))
    .filter((timeline): timeline is DocumentTimeline => timeline !== null)
    .filter((timeline) => {
      if (seenTimelines.has(timeline.id)) return false;
      seenTimelines.add(timeline.id);
      return true;
    });
  if (project.timelines.length === 0) return null;
  if (!project.timelines.some((timeline) => timeline.id === project.activeTimelineId)) {
    project.activeTimelineId = project.timelines[0]!.id;
  }
  return project;
}

/** One timeline settled: lanes and clips with ids, clips on lanes that exist
 * and media that is in the bin, every number in range. `null` for a timeline
 * with no id or no lane. Port of `doc::settle_timeline`. */
function settleTimeline(timeline: DocumentTimeline, media: MediaItem[]): DocumentTimeline | null {
  if (timeline.id === '') return null;
  const out: DocumentTimeline = {
    ...timeline,
    name: timeline.name.trim() === '' ? 'Timeline' : timeline.name,
    video: videoSettingsOr(timeline.video, defaultVideoSettings()),
  };
  const seenTracks = new Set<string>();
  out.tracks = out.tracks.filter((track) => {
    if (track.id === '' || seenTracks.has(track.id)) return false;
    seenTracks.add(track.id);
    return true;
  });
  if (out.tracks.length === 0) return null;
  const tracks = out.tracks;
  out.clips = out.clips
    .map((clip) => settleClip(clip, tracks, media))
    .filter((clip): clip is DocumentClip => clip !== null);
  return out;
}

/** One clip settled, or `null` for one with nowhere to live: no id, a track
 * that vanished, or — for the kinds that come from the bin — media that is
 * gone. Titles and layers have no media and need none. Port of
 * `doc::settle_clip`. */
function settleClip(
  clip: DocumentClip,
  tracks: DocumentTrack[],
  media: MediaItem[],
): DocumentClip | null {
  if (clip.id === '') return null;
  if (!tracks.some((track) => track.id === clip.trackId)) return null;
  const out = { ...clip };
  if (!clipKindIsVisual(clip.kind) && clip.kind !== 'audio') {
    // text | layer | shape: no media behind them.
    out.mediaId = '';
  } else if (!media.some((item) => item.id === clip.mediaId)) {
    return null;
  }
  if (out.kind !== 'text') out.text = null;
  if (out.kind !== 'shape') out.shape = null;
  return tidyDocumentClip(out);
}

// ---------------------------------------------------------------------------
// The writer. Port of `doc::to_document`.
// ---------------------------------------------------------------------------

/** Settings the host manages around the edit: the manifest's identity fields.
 * The frame and rate here are what a project *starts* as. */
export interface DocumentSettings {
  /** The project's display name, written as the document's `name` field. */
  name: string;
  width: number;
  height: number;
  rateNum: number;
  rateDen: number;
}

/** The frame and rate, as the first timeline of a fresh project gets them.
 * Port of `DocumentSettings::video`. */
export function documentSettingsVideo(settings: DocumentSettings): VideoSettings {
  return {
    width: settings.width,
    height: settings.height,
    rateNum: settings.rateNum,
    rateDen: settings.rateDen,
    colorSpace: 'sdr',
  };
}

/**
 * Builds the full `concat.json` document: `version 1 + document`, with the
 * active timeline's frame, tracks and clips mirrored at the top level where
 * every build has read them, and whatever a newer build put at the top level
 * back where it was — never over a field this writer owns. Port of
 * `doc::to_document`.
 */
export function toDocument(settings: DocumentSettings, project: ProjectDocument): Json {
  const active = activeTimeline(project);
  const document: JsonObject = {
    concat: '0.1.0',
    version: DOCUMENT_VERSION,
    name: settings.name,
    video: {
      width: active.video.width,
      height: active.video.height,
      rateNum: active.video.rateNum,
      rateDen: active.video.rateDen,
    },
    media: project.media.map(writeMediaItem),
    tracks: active.tracks.map(writeDocumentTrack),
    clips: active.clips.map(writeDocumentClip),
    fonts: project.fonts.map(writeCustomFont),
    timelines: project.timelines.map(writeDocumentTimeline),
    activeTimelineId: project.activeTimelineId,
  };
  const owned = new Set(WRITER_OWNED);
  for (const [key, value] of Object.entries(project.extra)) {
    if (!owned.has(key)) document[key] = value;
  }
  return document;
}

// ---------------------------------------------------------------------------
// Internal JSON helpers.
// ---------------------------------------------------------------------------

function asObjectSafe(value: Json | undefined): JsonObject | null {
  if (value === undefined || value === null) return null;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
