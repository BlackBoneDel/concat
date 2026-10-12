// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Shared subtitle model: cues in integer milliseconds (exact round-trips),
 * warnings with line numbers, timestamp formatting and HTML entities.
 *
 * Formats: SubRip (de-facto spec, https://en.wikipedia.org/wiki/SubRip) and
 * WebVTT (W3C, https://www.w3.org/TR/webvtt1/). The Rust editor has no
 * subtitle importer; this is web-only, feeding `text` clips
 * (`model.rs` `TextStyle`).
 */

/** Source format. */
export type SubtitleFormat = 'srt' | 'vtt';

/** A recoverable problem found while parsing (the cue may be dropped). */
export interface SubtitleWarning {
  /** 1-based line in the file. */
  line: number;
  message: string;
}

/** One karaoke step: text revealed at `atMs` (VTT `<00:00:01.000>`). */
export interface KaraokeSegment {
  atMs: number;
  text: string;
}

/** A styled run of plain text. */
export interface StyledSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** CSS colour (`<font color>`), or null. */
  color: string | null;
  /** VTT classes (`<c.yellow.loud>`). */
  classes: string[];
  /** VTT voice (`<v Ana>`), or null. */
  voice: string | null;
  /** Ruby annotation text (`<ruby>漢<rt>kan</rt></ruby>`), or null. */
  ruby: string | null;
}

/** One cue. `text` keeps the original markup so writers can round-trip it. */
export interface SubtitleCue {
  /** VTT identifier or SRT number as written ('' when absent). */
  id: string;
  startMs: number;
  endMs: number;
  /** Cue payload with markup, lines joined by `\n`. */
  text: string;
  /** VTT cue settings as written (`line:90% align:center`), '' if none. */
  settings: string;
}

/** A VTT region definition. */
export interface VttRegion {
  id: string;
  /** Settings as written, e.g. `width:40% lines:3`. */
  settings: string;
}

/** A parsed file. */
export interface SubtitleTrack {
  format: SubtitleFormat;
  cues: SubtitleCue[];
  warnings: SubtitleWarning[];
  /** VTT text after `WEBVTT` on the first line. */
  header: string;
  /** VTT header metadata lines (`Language: es`). */
  metadata: string[];
  /** VTT STYLE blocks (CSS). */
  styles: string[];
  regions: VttRegion[];
  /** VTT NOTE blocks. */
  notes: string[];
}

/** Hard parse failure (not a subtitle file at all). */
export class SubtitleParseError extends Error {
  readonly line: number;

  /**
   * @param message Spanish description.
   * @param line 1-based line (0 = whole file).
   */
  constructor(message: string, line = 0) {
    super(line > 0 ? `Línea ${line}: ${message}` : message);
    this.name = 'SubtitleParseError';
    this.line = line;
  }
}

/** Largest accepted file (characters). */
export const MAX_SUBTITLE_CHARS = 10 * 1024 * 1024;
/** Largest accepted cue count. */
export const MAX_CUES = 50_000;

/** An empty track. */
export function emptyTrack(format: SubtitleFormat): SubtitleTrack {
  return { format, cues: [], warnings: [], header: '', metadata: [], styles: [], regions: [], notes: [] };
}

/**
 * Normalises line endings and strips a BOM.
 * @param text raw file text.
 * @returns the lines.
 */
export function splitLines(text: string): string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.replace(/\r\n?/g, '\n').split('\n');
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/**
 * Formats milliseconds as `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT).
 * @param ms time in integer milliseconds.
 * @param separator `,` or `.`.
 * @returns the timestamp.
 */
export function formatTimestamp(ms: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor(total / 60_000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(total % 1000, 3)}`;
}

/**
 * Parses `[HH:]MM:SS[,.]mmm` into milliseconds.
 * @param text the timestamp.
 * @param strictVtt VTT rules: `.` separator, exactly 3 fraction digits, 2-digit minutes/seconds.
 * @returns milliseconds, or null when malformed.
 */
export function parseTimestamp(text: string, strictVtt = false): number | null {
  const match = strictVtt
    ? /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(text)
    : /^(?:(\d{1,}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  const fraction = match[4]!;
  const ms = Number(fraction.padEnd(3, '0'));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f',
};

/**
 * Decodes the HTML entities subtitle files use.
 * @param text escaped text.
 * @returns plain text.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Escapes text for a markup payload.
 * @param text plain text.
 * @returns escaped text.
 */
export function encodeEntities(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A default span. */
export function plainSpan(text: string): StyledSpan {
  return { text, bold: false, italic: false, underline: false, color: null, classes: [], voice: null, ruby: null };
}

/**
 * Concatenates spans to plain text.
 * @param spans styled runs.
 * @returns the text.
 */
export function spansToPlain(spans: readonly StyledSpan[]): string {
  return spans.map((span) => span.text).join('');
}

/** Clones a cue. */
export function cloneCue(cue: SubtitleCue): SubtitleCue {
  return { ...cue };
}
