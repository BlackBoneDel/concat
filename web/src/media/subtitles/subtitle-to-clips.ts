// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Subtitles → timeline: one `text` clip per cue on dedicated lanes.
 *
 * Cues become title clips (`model.rs` `TextStyle`) at the bottom centre of
 * the frame, sized as fractions of the frame like every title. Overlapping
 * cues (two speakers) go to extra lanes, so overwrite inserts never trim
 * each other. The import is ONE {@link CompoundOperation} (AddTrack ×N +
 * InsertClip ×M): a single undo removes it. Each clip keeps its source cue in
 * `clip.extra.subtitle` so export can round-trip the original markup.
 */

import { Rational } from '../../core/rational.ts';
import { AddTrackOperation, CompoundOperation, InsertClipOperation, newId, type EditOperation } from '../../editor/operations.ts';
import { blankClip, defaultTextStyle, type DocumentClip, type TextStyle } from '../../model/document.ts';
import { MIN_CLIP_DURATION, type JsonObject } from '../../model/wire.ts';
import { parseSrtMarkup } from './srt-parser.ts';
import { SUBTITLE_KEY } from './subtitle-writer.ts';
import type { StyledSpan, SubtitleCue, SubtitleFormat } from './types.ts';
import { parseCueSettings, parseVttCueText } from './vtt-parser.ts';

/** Default look of a subtitle: readable, on a translucent plate. */
export function subtitleStyle(): TextStyle {
  return {
    ...defaultTextStyle(),
    content: '',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 0.05,
    fontWeight: 600,
    shadow: false,
    background: 'rgba(0, 0, 0, 0.6)',
    backgroundRadius: 0.008,
    backgroundPaddingX: 0.02,
    backgroundPaddingY: 0.01,
    maxWidth: 0.84,
  };
}

/** Vertical centre of a default subtitle (fraction of frame height from the centre). */
export const SUBTITLE_OFFSET_Y = 0.4;

/** Options of {@link subtitlesToClips}. */
export interface SubtitleClipOptions {
  /** Format of the cue markup. */
  format: SubtitleFormat;
  /** Lane ids, one per overlap level (missing ones are minted). */
  trackIds?: string[];
  /** Seconds added to every cue. */
  offsetSeconds?: number;
  /** Style overrides on top of {@link subtitleStyle}. */
  style?: Partial<TextStyle>;
  /** Clip id factory (tests pass a deterministic one). */
  makeId?: (index: number) => string;
}

/**
 * Greedy lane assignment: a cue goes to the first lane free at its start.
 * @param cues the cues.
 * @returns lane index per cue (same order as `cues`).
 */
export function assignLanes(cues: readonly SubtitleCue[]): number[] {
  const order = cues.map((_, index) => index).sort((a, b) => cues[a]!.startMs - cues[b]!.startMs || a - b);
  const laneEnds: number[] = [];
  const lanes = new Array<number>(cues.length).fill(0);
  for (const index of order) {
    const cue = cues[index]!;
    let lane = laneEnds.findIndex((end) => end <= cue.startMs);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(cue.endMs);
    } else {
      laneEnds[lane] = cue.endMs;
    }
    lanes[index] = lane;
  }
  return lanes;
}

/** Spans of a cue in its dialect. */
function spansOf(cue: SubtitleCue, format: SubtitleFormat): StyledSpan[] {
  return format === 'srt' ? parseSrtMarkup(cue.text) : parseVttCueText(cue.text, cue.startMs).spans;
}

/**
 * The title style of one cue: whole-cue bold/italic/colour carry over,
 * VTT `line`/`position`/`align` place it.
 * @param cue the cue.
 * @param format its dialect.
 * @param base the base style.
 * @returns style and placement.
 */
export function cueLook(cue: SubtitleCue, format: SubtitleFormat, base: TextStyle): { style: TextStyle; offsetX: number; offsetY: number } {
  const spans = spansOf(cue, format).filter((span) => span.text.trim() !== '');
  const style: TextStyle = { ...base, content: spansOf(cue, format).map((span) => span.text).join('') };
  if (spans.length > 0) {
    if (spans.every((span) => span.bold)) style.fontWeight = 700;
    if (spans.every((span) => span.italic)) style.italic = true;
    const color = spans[0]!.color;
    if (color && spans.every((span) => span.color === color)) style.color = color;
  }
  let offsetX = 0;
  let offsetY = SUBTITLE_OFFSET_Y;
  if (format === 'vtt' && cue.settings !== '') {
    const { settings } = parseCueSettings(cue.settings);
    if (settings.line) {
      if (settings.line.percent) offsetY = Math.min(0.5, Math.max(-0.5, settings.line.value / 100 - 0.5));
      else if (settings.line.value >= 0) offsetY = -0.45 + settings.line.value * base.fontSize * base.lineHeight;
      else offsetY = 0.45 + (settings.line.value + 1) * base.fontSize * base.lineHeight;
    }
    if (settings.position) offsetX = Math.min(0.5, Math.max(-0.5, settings.position.value / 100 - 0.5));
    if (settings.align === 'start' || settings.align === 'left') style.align = 'left';
    else if (settings.align === 'end' || settings.align === 'right') style.align = 'right';
    if (settings.size !== null) style.maxWidth = settings.size / 100;
  }
  return { style, offsetX, offsetY };
}

/**
 * Builds the title clips for cues.
 * @param cues the cues.
 * @param options format, lanes, offset, style.
 * @returns clips grouped by lane, and the lane ids used.
 */
export function subtitlesToClips(cues: readonly SubtitleCue[], options: SubtitleClipOptions): { lanes: DocumentClip[][]; trackIds: string[] } {
  const lanesOf = assignLanes(cues);
  const laneCount = cues.length === 0 ? 0 : Math.max(...lanesOf) + 1;
  const trackIds = Array.from({ length: laneCount }, (_, lane) => options.trackIds?.[lane] ?? newId('T-'));
  const lanes: DocumentClip[][] = trackIds.map(() => []);
  const base: TextStyle = { ...subtitleStyle(), ...options.style };
  const offset = options.offsetSeconds ?? 0;
  cues.forEach((cue, index) => {
    const lane = lanesOf[index]!;
    const trackId = trackIds[lane]!;
    const start = Math.max(0, cue.startMs / 1000 + offset);
    const duration = Math.max(MIN_CLIP_DURATION, (cue.endMs - cue.startMs) / 1000);
    const id = options.makeId?.(index) ?? newId('sub-');
    const { style, offsetX, offsetY } = cueLook(cue, options.format, base);
    const name = style.content.split('\n')[0]!.slice(0, 40) || `Subtítulo ${index + 1}`;
    const clip = blankClip(id, trackId, 'text', name, start, duration);
    clip.text = style;
    clip.offsetX = offsetX;
    clip.offsetY = offsetY;
    const source: JsonObject = { format: options.format, text: cue.text, id: cue.id, settings: cue.settings, index: index + 1 };
    clip.extra = { [SUBTITLE_KEY]: source };
    lanes[lane]!.push(clip);
  });
  return { lanes, trackIds };
}

/**
 * The undoable import: new lanes on top of the stack plus every clip.
 * @param cues the cues.
 * @param options as {@link subtitlesToClips}, plus the lane name.
 * @returns the compound operation and what it creates.
 */
export function buildSubtitleImport(
  cues: readonly SubtitleCue[],
  options: SubtitleClipOptions & { trackName?: string },
): { operation: EditOperation; trackIds: string[]; clipIds: string[] } {
  const { lanes, trackIds } = subtitlesToClips(cues, options);
  const name = options.trackName ?? 'Subtítulos';
  const ops: EditOperation[] = trackIds.map((trackId, lane) =>
    new AddTrackOperation('video', lane, trackIds.length > 1 ? `${name} ${lane + 1}` : name, trackId));
  const clipIds: string[] = [];
  for (const lane of lanes) {
    for (const clip of lane) {
      ops.push(new InsertClipOperation(clip, clip.trackId, Rational.approximate(clip.start) ?? Rational.ZERO, 'overwrite'));
      clipIds.push(clip.id);
    }
  }
  return { operation: new CompoundOperation('Importar subtítulos', ops), trackIds, clipIds };
}
