// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Front door for subtitle files: format detection, text decoding and
 * dispatch to the SRT / WebVTT parsers.
 */

import { SUBTITLE_EXTENSIONS, extensionOf } from '../import/format-support.ts';
import { parseSRT } from './srt-parser.ts';
import { MAX_SUBTITLE_CHARS, SubtitleParseError, type SubtitleFormat, type SubtitleTrack } from './types.ts';
import { parseVTT } from './vtt-parser.ts';


/**
 * Detects the format from the name, then the content.
 * @param text file text.
 * @param fileName optional name.
 * @returns the format.
 */
export function detectSubtitleFormat(text: string, fileName = ''): SubtitleFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.vtt')) return 'vtt';
  if (lower.endsWith('.srt')) return 'srt';
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return /^WEBVTT(?:[ \t\r\n]|$)/.test(body) ? 'vtt' : 'srt';
}

/**
 * Parses subtitle text of either format.
 * @param text file text.
 * @param fileName optional name (format hint).
 * @returns the parsed track.
 * @throws SubtitleParseError on fatal problems (no header, too large).
 */
export function parseSubtitles(text: string, fileName = ''): SubtitleTrack {
  return detectSubtitleFormat(text, fileName) === 'vtt' ? parseVTT(text) : parseSRT(text);
}

/**
 * Decodes subtitle bytes: UTF-8 (BOM or valid), else UTF-16 by BOM, else
 * Windows-1252 — old `.srt` files are often ANSI.
 * @param bytes the file bytes.
 * @returns the text.
 */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Reads and parses a subtitle file.
 * @param file the picked file.
 * @returns the parsed track.
 * @throws SubtitleParseError for unsupported extensions, size, or fatal syntax.
 */
export async function loadSubtitleFile(file: Blob & { name: string }): Promise<SubtitleTrack> {
  if (!SUBTITLE_EXTENSIONS.includes(extensionOf(file.name))) {
    throw new SubtitleParseError(`${file.name} no es un archivo .srt ni .vtt`);
  }
  if (file.size > MAX_SUBTITLE_CHARS * 4) throw new SubtitleParseError('El archivo de subtítulos es demasiado grande (máx. 10 MB)');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseSubtitles(decodeSubtitleBytes(bytes), file.name);
}
