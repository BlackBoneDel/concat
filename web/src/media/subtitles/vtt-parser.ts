// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * WebVTT parser (W3C WebVTT, https://www.w3.org/TR/webvtt1/).
 *
 * Handles the `WEBVTT` header and its metadata, `NOTE`, `STYLE` and
 * `REGION` blocks, cue identifiers, cue settings (`vertical line position
 * size align region`), and the cue-text tags `c i b u ruby/rt v lang` plus
 * karaoke timestamps `<00:00:01.500>`. Like the SRT parser it is partial:
 * a broken cue is skipped with a warning, the rest of the file survives.
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
  type KaraokeSegment,
  type StyledSpan,
  type SubtitleCue,
  type SubtitleTrack,
  type SubtitleWarning,
} from './types.ts';

/** Structured cue settings. */
export interface VttCueSettings {
  vertical: 'rl' | 'lr' | null;
  /** Line as percentage (0–100) when given as `NN%`, or line number. */
  line: { value: number; percent: boolean; align: 'start' | 'center' | 'end' } | null;
  position: { value: number; align: 'line-left' | 'center' | 'line-right' | 'auto' } | null;
  size: number | null;
  align: 'start' | 'center' | 'end' | 'left' | 'right';
  region: string | null;
}

const PCT = /^(\d+(?:\.\d+)?)%$/;

/**
 * Parses (and validates) cue settings.
 * @param text settings as written.
 * @param warn optional sink for invalid settings.
 * @returns the structured settings and the canonical string of the valid ones.
 */
export function parseCueSettings(text: string, warn?: (message: string) => void): { settings: VttCueSettings; canonical: string } {
  const settings: VttCueSettings = { vertical: null, line: null, position: null, size: null, align: 'center', region: null };
  const kept: string[] = [];
  for (const token of text.trim().split(/\s+/)) {
    if (token === '') continue;
    const colon = token.indexOf(':');
    const key = colon > 0 ? token.slice(0, colon) : '';
    const value = colon > 0 ? token.slice(colon + 1) : '';
    let ok = false;
    if (key === 'vertical' && (value === 'rl' || value === 'lr')) {
      settings.vertical = value;
      ok = true;
    } else if (key === 'line') {
      const [raw, align = 'start'] = value.split(',');
      const pct = PCT.exec(raw ?? '');
      const num = /^-?\d+$/.test(raw ?? '') ? Number(raw) : null;
      if ((pct || num !== null) && (align === 'start' || align === 'center' || align === 'end')) {
        const pctValue = pct ? Number(pct[1]) : null;
        if (pctValue === null || pctValue <= 100) {
          settings.line = { value: pctValue ?? num!, percent: pct !== null, align };
          ok = true;
        }
      }
    } else if (key === 'position') {
      const [raw, align = 'auto'] = value.split(',');
      const pct = PCT.exec(raw ?? '');
      if (pct && Number(pct[1]) <= 100 && (align === 'line-left' || align === 'center' || align === 'line-right' || align === 'auto')) {
        settings.position = { value: Number(pct[1]), align };
        ok = true;
      }
    } else if (key === 'size') {
      const pct = PCT.exec(value);
      if (pct && Number(pct[1]) <= 100) {
        settings.size = Number(pct[1]);
        ok = true;
      }
    } else if (key === 'align' && (value === 'start' || value === 'center' || value === 'end' || value === 'left' || value === 'right' || value === 'middle')) {
      settings.align = value === 'middle' ? 'center' : value;
      ok = true;
    } else if (key === 'region' && value !== '' && !value.includes('-->')) {
      settings.region = value;
      ok = true;
    }
    if (ok) kept.push(token);
    else warn?.(`Ajuste de subtítulo inválido: "${token}"`);
  }
  return { settings, canonical: kept.join(' ') };
}

/**
 * Parses a WebVTT file.
 * @param text the file contents.
 * @returns cues, blocks and warnings.
 * @throws SubtitleParseError without a `WEBVTT` header or when too large.
 */
export function parseVTT(text: string): SubtitleTrack {
  if (text.length > MAX_SUBTITLE_CHARS) throw new SubtitleParseError('El archivo de subtítulos es demasiado grande (máx. 10 MB)');
  const lines = splitLines(text);
  const first = lines[0] ?? '';
  const header = /^WEBVTT(?:[ \t](.*))?$/.exec(first);
  if (!header) throw new SubtitleParseError('Falta la cabecera WEBVTT', 1);
  const track = emptyTrack('vtt');
  track.header = (header[1] ?? '').trim();
  let i = 1;
  while (i < lines.length && lines[i]!.trim() !== '') {
    if (lines[i]!.includes('-->')) {
      track.warnings.push({ line: i + 1, message: 'Falta una línea en blanco tras la cabecera; el subtítulo se ignora' });
    } else {
      track.metadata.push(lines[i]!);
    }
    i += 1;
  }

  // Split into blocks of non-blank lines, remembering where each starts.
  const blocks: { start: number; lines: string[] }[] = [];
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === '') i += 1;
    if (i >= lines.length) break;
    const start = i + 1;
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      block.push(lines[i]!);
      i += 1;
    }
    blocks.push({ start, lines: block });
  }

  for (let b = 0; b < blocks.length; b += 1) {
    const { start, lines: block } = blocks[b]!;
    const head = block[0]!;
    const hasArrow = block.some((line) => line.includes('-->'));
    if (/^NOTE(?:[ \t]|$)/.test(head)) {
      track.notes.push(block.join('\n'));
      continue;
    }
    if (head.trim() === 'STYLE' && !hasArrow) {
      if (track.cues.length > 0) {
        track.warnings.push({ line: start, message: 'Bloque STYLE después de los subtítulos; se ignora' });
      } else {
        track.styles.push(block.slice(1).join('\n'));
      }
      continue;
    }
    if (head.trim() === 'REGION' && !hasArrow) {
      const settings = block.slice(1).join(' ').trim().split(/\s+/).filter((t) => t !== '');
      const id = settings.find((t) => t.startsWith('id:'))?.slice(3) ?? '';
      if (track.cues.length > 0) {
        track.warnings.push({ line: start, message: 'Bloque REGION después de los subtítulos; se ignora' });
      } else if (id === '') {
        track.warnings.push({ line: start, message: 'REGION sin id; se ignora' });
      } else {
        track.regions.push({ id, settings: settings.join(' ') });
      }
      continue;
    }
    // A cue: optional identifier, timing line, payload.
    let cursor = 0;
    let id = '';
    if (!head.includes('-->')) {
      id = head;
      cursor = 1;
    }
    const timing = block[cursor];
    if (timing === undefined || !timing.includes('-->')) {
      track.warnings.push({ line: start, message: 'Bloque sin línea de tiempos; se ignora' });
      continue;
    }
    // A payload line with "-->" starts a new cue (spec); split the block.
    const payload: string[] = [];
    for (let k = cursor + 1; k < block.length; k += 1) {
      if (block[k]!.includes('-->')) {
        track.warnings.push({ line: start + k, message: 'Falta una línea en blanco entre subtítulos' });
        blocks.splice(b + 1, 0, { start: start + k, lines: block.slice(k) });
        break;
      }
      payload.push(block[k]!);
    }
    const cue = parseCue(id, timing, payload, start + cursor, track.warnings);
    if (!cue) continue;
    if (track.cues.length >= MAX_CUES) {
      track.warnings.push({ line: start, message: `Se alcanzó el máximo de ${MAX_CUES} subtítulos; el resto se ignora` });
      break;
    }
    const previous = track.cues[track.cues.length - 1];
    if (previous && cue.startMs < previous.startMs) {
      track.warnings.push({ line: start + cursor, message: 'Los subtítulos no están en orden cronológico' });
    }
    track.cues.push(cue);
  }
  return track;
}

function parseCue(id: string, timing: string, payload: string[], line: number, warnings: SubtitleWarning[]): SubtitleCue | null {
  const match = /^\s*(\S+)\s+-->\s+(\S+)(.*)$/.exec(timing) ?? /^\s*(\S+?)\s*-->\s*(\S+)(.*)$/.exec(timing);
  if (!match) {
    warnings.push({ line, message: `Línea de tiempos inválida: "${timing.trim()}"` });
    return null;
  }
  let startMs = parseTimestamp(match[1]!, true);
  let endMs = parseTimestamp(match[2]!, true);
  if (startMs === null || endMs === null) {
    startMs = startMs ?? parseTimestamp(match[1]!);
    endMs = endMs ?? parseTimestamp(match[2]!);
    if (startMs === null || endMs === null) {
      warnings.push({ line, message: `Marca de tiempo inválida: "${timing.trim()}"` });
      return null;
    }
    warnings.push({ line, message: 'Marca de tiempo con formato no estándar' });
  }
  if (endMs <= startMs) {
    warnings.push({ line, message: 'El final del subtítulo no es posterior a su inicio; se ignora' });
    return null;
  }
  const { canonical } = parseCueSettings(match[3] ?? '', (message) => warnings.push({ line, message }));
  return { id, startMs, endMs, text: payload.join('\n'), settings: canonical };
}

/** Cue text as styled spans plus karaoke timing. */
export interface VttCueContent {
  spans: StyledSpan[];
  karaoke: KaraokeSegment[];
  /** The first voice (`<v Ana>`) of the cue, or null. */
  voice: string | null;
}

interface OpenTag {
  name: string;
  classes: string[];
  annotation: string;
}

/**
 * Parses cue-text markup (W3C "cue text parsing rules", simplified to the
 * styles a title clip can show).
 * @param text the cue payload.
 * @param cueStartMs the cue start (first karaoke segment time).
 * @returns spans, karaoke segments and voice.
 */
export function parseVttCueText(text: string, cueStartMs = 0): VttCueContent {
  const spans: StyledSpan[] = [];
  const karaoke: KaraokeSegment[] = [{ atMs: cueStartMs, text: '' }];
  const stack: OpenTag[] = [];
  let voice: string | null = null;
  let rubyBase: StyledSpan[] = [];
  let rtText: string | null = null;
  const token = /<([^>]*)>/g;
  let last = 0;

  const emit = (raw: string): void => {
    if (raw === '') return;
    const textValue = decodeEntities(raw);
    if (rtText !== null) {
      rtText += textValue;
      return;
    }
    const span = plainSpan(textValue);
    for (const tag of stack) {
      if (tag.name === 'b') span.bold = true;
      else if (tag.name === 'i') span.italic = true;
      else if (tag.name === 'u') span.underline = true;
      if (tag.name === 'v' && tag.annotation !== '') span.voice = tag.annotation;
      span.classes.push(...tag.classes);
    }
    spans.push(span);
    karaoke[karaoke.length - 1]!.text += textValue;
    if (stack.some((tag) => tag.name === 'ruby')) rubyBase.push(span);
  };

  for (let match = token.exec(text); match; match = token.exec(text)) {
    emit(text.slice(last, match.index));
    last = match.index + match[0].length;
    const body = match[1]!.trim();
    const stamp = parseTimestamp(body, true);
    if (stamp !== null) {
      karaoke.push({ atMs: stamp, text: '' });
      continue;
    }
    if (body.startsWith('/')) {
      const name = body.slice(1).split('.')[0]!.trim().toLowerCase();
      if (name === 'rt' && rtText !== null) {
        for (const span of rubyBase) span.ruby = rtText;
        rubyBase = [];
        rtText = null;
      }
      const at = stack.map((tag) => tag.name).lastIndexOf(name);
      if (at >= 0) stack.splice(at);
      if (name === 'ruby') rubyBase = [];
      continue;
    }
    const space = body.search(/[\s]/);
    const head = space >= 0 ? body.slice(0, space) : body;
    const annotation = space >= 0 ? body.slice(space + 1).trim() : '';
    const [rawName = '', ...classes] = head.split('.');
    const name = rawName.toLowerCase();
    if (!['c', 'i', 'b', 'u', 'ruby', 'rt', 'v', 'lang'].includes(name)) continue;
    if (name === 'rt') {
      rtText = '';
      continue;
    }
    if (name === 'v' && voice === null && annotation !== '') voice = decodeEntities(annotation);
    stack.push({ name, classes: classes.filter((c) => c !== ''), annotation: decodeEntities(annotation) });
  }
  emit(text.slice(last));
  const steps = karaoke.filter((segment) => segment.text !== '');
  return { spans, karaoke: steps.length > 0 ? steps : [{ atMs: cueStartMs, text: '' }], voice };
}

/**
 * Plain text of a VTT cue (tags, timestamps and ruby text removed).
 * @param text the cue payload.
 * @returns the text.
 */
export function vttPlainText(text: string): string {
  return parseVttCueText(text).spans.map((span) => span.text).join('');
}
