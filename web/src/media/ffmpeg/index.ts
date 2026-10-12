// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The FFmpeg.wasm fallback and container/codec detection. */
export {
  FFMPEG_IDLE_MS,
  FFmpegFallback,
  FFmpegUnavailableError,
  buildTranscodeArgs,
  channelsOfLayout,
  parseFFmpegLog,
  parseFFprobeJson,
  vendoredCoreUrls,
  type DecodeOptions,
  type ProbeResult,
  type ProbeStream,
  type TranscodeOptions,
} from './ffmpeg-fallback.ts';
export {
  INPUT_DIR,
  OUTPUT_DIR,
  createFFmpegHandlers,
  importCore,
  isFFmpegCore,
  readExecRequest,
  type CoreLoader,
  type ExecInput,
  type ExecRequest,
  type ExecResult,
  type FFmpegCore,
  type FFmpegFS,
} from './ffmpeg-worker.ts';
export {
  FormatDetector,
  HEAD_BYTES,
  TAIL_BYTES,
  ebmlDocType,
  sniffCodecs,
  sniffContainer,
  type FormatInfo,
} from './format-detector.ts';
