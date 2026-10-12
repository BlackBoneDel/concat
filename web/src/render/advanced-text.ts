// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 advanced titling data, stored in `clip.extra.advanced_text`, and the
 * project's custom fonts, stored in `doc.extra.fonts`.
 *
 * The base {@link TextStyle} (`model.rs` `TextStyle`) keeps content, family,
 * size, weight, alignment and wrapping; this object adds what `concat-text`
 * draws on top of it: gradient fill, independent stroke/shadow/plate
 * controls, a glow and the typewriter reveal. Every field is optional on
 * read and clamped/validated (documents come from disk), so a hand-edited
 * file degrades to something drawable — the standing rule of `doc.rs`.
 */

import type { Json, JsonObject } from '../model/wire.ts';

/** `extra` key of the advanced style. */
export const ADVANCED_TEXT_KEY = 'advanced_text';
/** `doc.extra` key of the custom font list. */
export const FONTS_KEY = 'fonts';

/** Outline around the glyphs. */
export interface TextStrokeStyle {
  enabled: boolean;
  color: string;
  /** Fraction of the frame height. */
  width: number;
}

/** Drop shadow (canvas `shadow*`). */
export interface TextShadowStyle {
  enabled: boolean;
  color: string;
  /** Blur radius, fraction of the frame height. */
  blur: number;
  /** Fractions of the frame height. */
  offsetX: number;
  offsetY: number;
}

/** The plate behind the block. */
export interface TextBackgroundStyle {
  enabled: boolean;
  color: string;
  /** Fractions of the frame height. */
  paddingX: number;
  paddingY: number;
  radius: number;
  opacity: number;
}

/** Character-by-character reveal. */
export interface TypewriterStyle {
  enabled: boolean;
  /** Seconds to reveal the whole text. */
  duration: number;
  /** Blinking caret while typing. */
  cursor: boolean;
}

/** Outer glow (a coloured, zero-offset shadow drawn twice). */
export interface TextGlowStyle {
  enabled: boolean;
  color: string;
  /** Fraction of the frame height. */
  blur: number;
}

/** Everything `extra.advanced_text` holds. */
export interface AdvancedTextStyle {
  version: 1;
  /** One colour, or 2+ colour stops of a linear gradient. */
  fill: string | string[];
  /** Gradient direction in degrees (0 = left→right, 90 = top→bottom). */
  gradientAngle: number;
  stroke: TextStrokeStyle;
  shadow: TextShadowStyle;
  background: TextBackgroundStyle;
  typewriter: TypewriterStyle;
  glow: TextGlowStyle;
  /** A {@link CustomFont} id (its family overrides the base family). */
  fontId: string | null;
}

/** A deep partial, for patches. */
export type AdvancedTextPatch = {
  [K in keyof AdvancedTextStyle]?: AdvancedTextStyle[K] extends string | string[] | number | null | 1
    ? AdvancedTextStyle[K]
    : Partial<AdvancedTextStyle[K]>;
};

/** A font file the user added to the project (bytes in OPFS `/fonts/`). */
export interface CustomFont {
  id: string;
  /** The CSS family name it registers as. */
  family: string;
  /** Original file name. */
  fileName: string;
  /** OPFS path, e.g. `/fonts/<id>.ttf`. */
  path: string;
  format: FontFormat;
}

/** Accepted font containers. */
export type FontFormat = 'truetype' | 'opentype' | 'woff' | 'woff2';

/** The neutral advanced style (draws like the base renderer). */
export function defaultAdvancedText(): AdvancedTextStyle {
  return {
    version: 1,
    fill: '#ffffff',
    gradientAngle: 90,
    stroke: { enabled: false, color: '#000000', width: 0.004 },
    shadow: { enabled: false, color: 'rgba(0,0,0,0.6)', blur: 0.01, offsetX: 0.004, offsetY: 0.006 },
    background: { enabled: false, color: '#000000', paddingX: 0.03, paddingY: 0.018, radius: 0.012, opacity: 0.75 },
    typewriter: { enabled: false, duration: 2, cursor: false },
    glow: { enabled: false, color: '#00e5ff', blur: 0.03 },
    fontId: null,
  };
}

/** Colours accepted from documents: hex, rgb()/hsl() functions or a CSS name. */
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\)|[a-z]{3,24})$/i;

/**
 * Validates a CSS colour from a document.
 * @param value anything.
 * @param fallback used when the value is not an acceptable colour.
 * @returns a safe colour string.
 */
export function sanitizeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length <= 64 && COLOR_PATTERN.test(trimmed) ? trimmed : fallback;
}

function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = v;
  return out;
}

function clampNum(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Normalises a fill: a gradient needs ≥2 valid stops, otherwise the first
 * valid colour (or the fallback) is used.
 * @param value a colour or a list of colours.
 * @param fallback the solid colour to fall back on.
 * @returns a solid colour or ≥2 stops.
 */
export function sanitizeFill(value: unknown, fallback: string): string | string[] {
  if (Array.isArray(value)) {
    const stops = value.map((stop) => sanitizeColor(stop, '')).filter((stop) => stop !== '').slice(0, 8);
    if (stops.length >= 2) return stops;
    return stops[0] ?? fallback;
  }
  return sanitizeColor(value, fallback);
}

/**
 * Parses `extra.advanced_text` (lenient, clamped).
 * @param value the stored JSON.
 * @returns the style, or `null` when the clip has none.
 */
export function parseAdvancedText(value: unknown): AdvancedTextStyle | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return mergeAdvancedText(defaultAdvancedText(), rec(value));
}

/**
 * Applies a (possibly partial, possibly untrusted) patch over a style.
 * @param base the current style.
 * @param patch fields to change.
 * @returns a new, validated style.
 */
export function mergeAdvancedText(base: AdvancedTextStyle, patch: Readonly<Record<string, unknown>> | AdvancedTextPatch): AdvancedTextStyle {
  const p = rec(patch);
  const stroke = rec(p['stroke']);
  const shadow = rec(p['shadow']);
  const background = rec(p['background']);
  const typewriter = rec(p['typewriter']);
  const glow = rec(p['glow']);
  const fontId = p['fontId'];
  return {
    version: 1,
    fill: 'fill' in p ? sanitizeFill(p['fill'], typeof base.fill === 'string' ? base.fill : base.fill[0] ?? '#ffffff') : structuredClone(base.fill),
    gradientAngle: clampNum(p['gradientAngle'], -360, 360, base.gradientAngle),
    stroke: {
      enabled: bool(stroke['enabled'], base.stroke.enabled),
      color: sanitizeColor(stroke['color'], base.stroke.color),
      width: clampNum(stroke['width'], 0, 0.1, base.stroke.width),
    },
    shadow: {
      enabled: bool(shadow['enabled'], base.shadow.enabled),
      color: sanitizeColor(shadow['color'], base.shadow.color),
      blur: clampNum(shadow['blur'], 0, 0.2, base.shadow.blur),
      offsetX: clampNum(shadow['offsetX'], -0.2, 0.2, base.shadow.offsetX),
      offsetY: clampNum(shadow['offsetY'], -0.2, 0.2, base.shadow.offsetY),
    },
    background: {
      enabled: bool(background['enabled'], base.background.enabled),
      color: sanitizeColor(background['color'], base.background.color),
      paddingX: clampNum(background['paddingX'], 0, 0.3, base.background.paddingX),
      paddingY: clampNum(background['paddingY'], 0, 0.3, base.background.paddingY),
      radius: clampNum(background['radius'], 0, 0.2, base.background.radius),
      opacity: clampNum(background['opacity'], 0, 1, base.background.opacity),
    },
    typewriter: {
      enabled: bool(typewriter['enabled'], base.typewriter.enabled),
      duration: clampNum(typewriter['duration'], 0.05, 120, base.typewriter.duration),
      cursor: bool(typewriter['cursor'], base.typewriter.cursor),
    },
    glow: {
      enabled: bool(glow['enabled'], base.glow.enabled),
      color: sanitizeColor(glow['color'], base.glow.color),
      blur: clampNum(glow['blur'], 0, 0.2, base.glow.blur),
    },
    fontId: fontId === null ? null : typeof fontId === 'string' && fontId !== '' ? fontId : base.fontId,
  };
}

/**
 * The JSON written to `extra.advanced_text`.
 * @param style the style.
 * @returns a plain JSON object.
 */
export function serializeAdvancedText(style: AdvancedTextStyle): JsonObject {
  const fill: Json = typeof style.fill === 'string' ? style.fill : [...style.fill];
  return {
    version: 1,
    fill,
    gradientAngle: style.gradientAngle,
    stroke: { ...style.stroke },
    shadow: { ...style.shadow },
    background: { ...style.background },
    typewriter: { ...style.typewriter },
    glow: { ...style.glow },
    fontId: style.fontId,
  };
}

/** Sniffs the font container from its first bytes (and the name as a hint). */
export function detectFontFormat(bytes: Uint8Array, fileName: string): FontFormat | null {
  const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'OTTO') return 'opentype';
  if ((bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || tag === 'true') return 'truetype';
  // Unknown magic: never trust the extension alone.
  void fileName;
  return null;
}

/**
 * Parses the project's font list.
 * @param value `doc.extra.fonts`.
 * @returns valid entries.
 */
export function parseFonts(value: unknown): CustomFont[] {
  if (!Array.isArray(value)) return [];
  const out: CustomFont[] = [];
  for (const raw of value) {
    const r = rec(raw);
    const id = r['id'];
    const family = r['family'];
    const path = r['path'];
    const format = r['format'];
    if (typeof id !== 'string' || id === '' || typeof family !== 'string' || family === '' || typeof path !== 'string') continue;
    if (format !== 'truetype' && format !== 'opentype' && format !== 'woff' && format !== 'woff2') continue;
    out.push({ id, family, fileName: typeof r['fileName'] === 'string' ? r['fileName'] : family, path, format });
  }
  return out;
}

/**
 * A safe CSS family name for a font file.
 * @param fileName e.g. `My Font-Bold.ttf`.
 * @param id the font id (keeps names unique).
 * @returns e.g. `My Font-Bold (a1b2)`.
 */
export function familyFromFileName(fileName: string, id: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 48) || 'Fuente';
  return `${base} ${id.slice(0, 4)}`;
}
