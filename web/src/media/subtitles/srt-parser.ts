// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * SubRip (.srt) parser — tolerant, partial results with warnings.
 *
 * A file is blocks separated by blank lines: an optional counter, a timing
 * line `00:00:01,000 --> 00:00:02,500` (players also accept `.` and missing
 * hours; trailing `X1:… Y2:…` coordinates are ignored) and one or more text
 * lines. Text may carry `<b> <i> <u> <font color="…">` (and the `{b}` brace
 * forms some tools write). Bad blocks are skipped with a warning naming the
 * line so the rest of the file still imports.
 */

import {
  MAX_CUES,
  MAX_SUBTITLE_CHARS,
  SubtitleParseError,
  decodeEntities,
  emptyTrack,
  parseTimestamp,
  plainSpan,
  splitLines,
  type StyledSpan,
  type SubtitleCue,
  type SubtitleTrack,
} from './types.ts';

const TIMING = /^\s*(\S+)\s*-->\s*(\S+)(.*)$/;

/**
 * Parses an SRT file.
 * @param text the file contents.
 * @returns the cues and warnings (never throws for bad blocks).
 * @throws SubtitleParseError when the file is too large.
 */
export function parseSRT(text: string): SubtitleTrack {
  if (text.length > MAX_SUBTITLE_CHARS) throw new SubtitleParseError('El archivo de subtítulos es demasiado grande (máx. 10 MB)');
  const track = emptyTrack('srt');
  const lines = splitLines(text);
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === '') i += 1;
    if (i >= lines.length) break;
    const blockStart = i;
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      block.push(lines[i]!);
      i += 1;
    }
    const cue = parseBlock(block, blockStart + 1, track);
    if (!cue) continue;
    if (track.cues.length >= MAX_CUES) {
      track.warnings.push({ line: blockStart + 1, message: `Se alcanzó el máximo de ${MAX_CUES} subtítulos; el resto se ignora` });
      break;
    }
    const previous = track.cues[track.cues.length - 1];
    if (previous && cue.startMs < previous.endMs) {
      track.warnings.push({ line: blockStart + 1, message: `El subtítulo ${cue.id || track.cues.length + 1} se solapa con el anterior` });
    }
    track.cues.push(cue);
  }
  if (track.cues.length === 0 && text.trim() !== '') {
    track.warnings.push({ line: 1, message: 'No se encontró ningún subtítulo válido' });
  }
  return track;
}

function parseBlock(block: string[], firstLine: number, track: SubtitleTrack): SubtitleCue | null {
  let cursor = 0;
  let id = '';
  if (!block[0]!.includes('-->')) {
    id = block[0]!.trim();
    cursor = 1;
    if (!/^\d+$/.test(id)) {
      track.warnings.push({ line: firstLine, message: `Número de subtítulo inválido: "${id}"` });
    }
  }
  const timingLine = block[cursor];
  const timingLineNo = firstLine + cursor;
  if (timingLine === undefined) {
    track.warnings.push({ line: firstLine, message: 'Bloque sin línea de tiempos; se ignora' });
    return null;
  }
  const match = TIMING.exec(timingLine);
  if (!match) {
    track.warnings.push({ line: timingLineNo, message: `Línea de tiempos inválida: "${timingLine.trim()}"` });
    return null;
  }
  const startMs = parseTimestamp(match[1]!);
  const endMs = parseTimestamp(match[2]!);
  if (startMs === null || endMs === null) {
    track.warnings.push({ line: timingLineNo, message: `Marca de tiempo inválida: "${timingLine.trim()}"` });
    return null;
  }
  if (endMs <= startMs) {
    track.warnings.push({ line: timingLineNo, message: 'El final del subtítulo no es posterior a su inicio; se ignora' });
    return null;
  }
  const textLines = block.slice(cursor + 1);
  if (textLines.length === 0) {
    track.warnings.push({ line: timingLineNo, message: 'Subtítulo sin texto' });
  }
  return { id, startMs, endMs, text: textLines.join('\n'), settings: '' };
}

/** Normalises the brace forms `{b}…{/b}` to tags. */
function bracesToTags(text: string): string {
  return text.replace(/\{(\/?)([biu])\}/gi, '<$1$2>');
}

/**
 * Splits SRT markup into styled spans. Unknown tags are dropped (their
 * text kept); unbalanced tags close at the end of the cue.
 * @param text cue text with markup.
 * @returns styled runs (entities decoded).
 */
export function parseSrtMarkup(text: string): StyledSpan[] {
  const spans: StyledSpan[] = [];
  let bold = 0;
  let italic = 0;
  let underline = 0;
  const colors: string[] = [];
  const source = bracesToTags(text);
  const tag = /<(\/?)\s*([a-z]+)([^>]*)>/gi;
  let last = 0;
  const push = (chunk: string): void => {
    if (chunk === '') return;
    const span = plainSpan(decodeEntities(chunk));
    span.bold = bold > 0;
    span.italic = italic > 0;
    span.underline = underline > 0;
    span.color = colors[colors.length - 1] || null;
    const prev = spans[spans.length - 1];
    if (prev && prev.bold === span.bold && prev.italic === span.italic && prev.underline === span.underline && prev.color === span.color) {
      prev.text += span.text;
    } else {
      spans.push(span);
    }
  };
  for (let match = tag.exec(source); match; match = tag.exec(source)) {
    push(source.slice(last, match.index));
    last = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    const delta = closing ? -1 : 1;
    if (name === 'b') bold = Math.max(0, bold + delta);
    else if (name === 'i') italic = Math.max(0, italic + delta);
    else if (name === 'u') underline = Math.max(0, underline + delta);
    else if (name === 'font') {
      if (closing) colors.pop();
      else {
        const color = /color\s*=\s*["']?([^"'\s>]+)/i.exec(match[3] ?? '');
        colors.push(color ? color[1]! : colors[colors.length - 1] ?? '');
      }
    }
  }
  push(source.slice(last));
  return spans;
}

/**
 * Plain text of an SRT cue (tags removed, entities decoded).
 * @param text cue text.
 * @returns the text.
 */
export function srtPlainText(text: string): string {
  return parseSrtMarkup(text).map((span) => span.text).join('');
}
