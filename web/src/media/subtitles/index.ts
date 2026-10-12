// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Subtitles: SRT/WebVTT parsing, writing and timeline conversion. */

export * from './types.ts';
export { parseSRT, parseSrtMarkup, srtPlainText } from './srt-parser.ts';
export { parseCueSettings, parseVTT, parseVttCueText, vttPlainText, type VttCueContent, type VttCueSettings } from './vtt-parser.ts';
export {
  SUBTITLE_KEY,
  clipsToSubtitles,
  convertMarkup,
  plainOf,
  subtitleSourceOf,
  toSRT,
  toVTT,
  writeTrack,
  type VttExtras,
} from './subtitle-writer.ts';
export {
  SUBTITLE_OFFSET_Y,
  assignLanes,
  buildSubtitleImport,
  cueLook,
  subtitleStyle,
  subtitlesToClips,
  type SubtitleClipOptions,
} from './subtitle-to-clips.ts';
export { decodeSubtitleBytes, detectSubtitleFormat, loadSubtitleFile, parseSubtitles } from './subtitle-parser.ts';
