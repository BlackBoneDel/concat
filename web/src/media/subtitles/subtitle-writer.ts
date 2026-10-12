// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * SRT / WebVTT writers and the timeline → subtitles direction.
 *
 * Canonical output (renumbered SRT counters, `HH:MM:SS,mmm` / `.mmm`
 * timestamps, one blank line between blocks, trailing newline) means
 * `toSRT(parseSRT(x).cues) === x` for any canonical `x`, and parsing a
 * written file returns the same cues (exact round-trip, integer ms).
 * Markup crossing formats is translated: SRT `<font color>` becomes plain
 * text in VTT, VTT-only tags (`c v ruby lang`, karaoke stamps) are dropped
 * in SRT; `b i u` survive both ways.
 */

import type { DocumentClip } from '../../model/document.ts';
import { asObject } from '../../model/wire.ts';
import { srtPlainText } from './srt-parser.ts';
import { vttPlainText } from './vtt-parser.ts';
import { encodeEntities, formatTimestamp, type SubtitleCue, type SubtitleFormat, type SubtitleTrack, type VttRegion } from './types.ts';

/** The key text clips carry their subtitle source in (`clip.extra.subtitle`). */
export const SUBTITLE_KEY = 'subtitle';

/**
 * Converts cue markup between formats.
 * @param text cue payload.
 * @param from source format.
 * @param to target format.
 * @returns the payload in the target dialect.
 */
export function convertMarkup(text: string, from: SubtitleFormat, to: SubtitleFormat): string {
  if (from === to) return text;
  if (from === 'srt') {
    // SRT → VTT: keep b/i/u, drop font tags and brace forms.
    return text
      .replace(/\{(\/?)([biu])\}/gi, '<$1$2>')
      .replace(/<\/?font[^>]*>/gi, '')
      .replace(/<(\/?)([biu])(\s[^>]*)?>/gi, (_m, slash: string, name: string) => `<${slash}${name.toLowerCase()}>`)
      .replace(/<(?!\/?[biu]>)[^>]*>/gi, '');
  }
  // VTT → SRT: drop everything but b/i/u (voices become "Name: " prefixes).
  return text
    .replace(/<v(?:\.[^\s>]*)?\s+([^>]+)>/gi, '$1: ')
    .replace(/<rt>.*?<\/rt>/gi, '')
    .replace(/<(\/?)([biu])(?:\.[^>]*)?>/gi, '<$1$2>')
    .replace(/<(?!\/?[biu]>)[^>]*>/gi, '');
}

/**
 * Writes SubRip text.
 * @param cues the cues (sorted by the caller).
 * @param from the dialect of the cue markup (default SRT).
 * @returns the file contents.
 */
export function toSRT(cues: readonly SubtitleCue[], from: SubtitleFormat = 'srt'): string {
  if (cues.length === 0) return '';
  return cues
    .map((cue, index) => `${index + 1}\n${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}\n${convertMarkup(cue.text, from, 'srt')}`)
    .join('\n\n') + '\n';
}

/** VTT blocks around the cues. */
export interface VttExtras {
  header?: string;
  metadata?: readonly string[];
  styles?: readonly string[];
  regions?: readonly VttRegion[];
  notes?: readonly string[];
}

/**
 * Writes WebVTT text.
 * @param cues the cues.
 * @param extras header, metadata, STYLE/REGION/NOTE blocks.
 * @param from the dialect of the cue markup (default VTT).
 * @returns the file contents.
 */
export function toVTT(cues: readonly SubtitleCue[], extras: VttExtras = {}, from: SubtitleFormat = 'vtt'): string {
  const head = [`WEBVTT${extras.header ? ` ${extras.header}` : ''}`, ...(extras.metadata ?? [])].join('\n');
  const blocks = [head];
  for (const css of extras.styles ?? []) blocks.push(`STYLE\n${css}`);
  for (const region of extras.regions ?? []) blocks.push(`REGION\n${region.settings}`);
  for (const note of extras.notes ?? []) blocks.push(note);
  for (const cue of cues) {
    const timing = `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}${cue.settings ? ` ${cue.settings}` : ''}`;
    // An identifier containing "-->" would be read back as timing: drop it.
    const id = from === 'vtt' && cue.id !== '' && !cue.id.includes('-->') ? `${cue.id}\n` : '';
    const payload = convertMarkup(cue.text, from, 'vtt')
      .split('\n')
      // A blank line would end the cue early: drop it (VTT payloads cannot hold one).
      .filter((line) => line.trim() !== '')
      .map((line) => line.replace(/-->/g, '--&gt;'))
      .join('\n');
    blocks.push(`${id}${timing}${payload === '' ? '' : `\n${payload}`}`);
  }
  return blocks.join('\n\n') + '\n';
}

/**
 * Writes a parsed track back in its own or another format.
 * @param track the track.
 * @param format output format.
 * @returns the file contents.
 */
export function writeTrack(track: SubtitleTrack, format: SubtitleFormat): string {
  return format === 'srt'
    ? toSRT(track.cues, track.format)
    : toVTT(track.cues, { header: track.header, metadata: track.metadata, styles: track.styles, regions: track.regions, notes: track.notes }, track.format);
}

/**
 * Reads the subtitle metadata a text clip carries.
 * @param clip a document clip.
 * @returns the stored source, or null.
 */
export function subtitleSourceOf(clip: DocumentClip): { format: SubtitleFormat; text: string; id: string; settings: string } | null {
  const raw = clip.extra[SUBTITLE_KEY];
  if (raw === undefined) return null;
  const record = asObject(raw);
  if (!record) return null;
  const format = record['format'] === 'srt' ? 'srt' : 'vtt';
  return {
    format,
    text: typeof record['text'] === 'string' ? record['text'] : '',
    id: typeof record['id'] === 'string' ? record['id'] : '',
    settings: typeof record['settings'] === 'string' ? record['settings'] : '',
  };
}

/**
 * Builds cues from timeline text clips (subtitle export).
 *
 * Clips imported from a file keep their original markup (converted to
 * `format`); other title clips export their plain content, escaped.
 * @param clips document clips (any kinds; only text clips count).
 * @param format the dialect the cue text should be in.
 * @param onlySubtitles when true, only clips imported as subtitles.
 * @returns sorted cues.
 */
export function clipsToSubtitles(clips: readonly DocumentClip[], format: SubtitleFormat = 'srt', onlySubtitles = false): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const clip of clips) {
    if (clip.kind !== 'text' || !clip.text) continue;
    if (clip.extra['enabled'] === false) continue;
    const source = subtitleSourceOf(clip);
    if (onlySubtitles && !source) continue;
    const content = clip.text.content;
    const unchanged = source !== null && plainOf(source.text, source.format) === content;
    const text = unchanged && source ? convertMarkup(source.text, source.format, format) : encodeEntities(content);
    cues.push({
      id: source && format === 'vtt' ? source.id : '',
      startMs: Math.round(clip.start * 1000),
      endMs: Math.round((clip.start + clip.duration) * 1000),
      text,
      settings: source && format === 'vtt' && source.format === 'vtt' ? source.settings : '',
    });
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * Plain text of markup in either dialect (what a title clip displays).
 * @param text cue payload.
 * @param format its dialect.
 * @returns the plain text.
 */
export function plainOf(text: string, format: SubtitleFormat): string {
  return format === 'srt' ? srtPlainText(text) : vttPlainText(text);
}
