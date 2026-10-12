// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The format support matrix: which containers/codecs each browser engine
 * decodes natively (WebCodecs or `<video>`), which need the FFmpeg.wasm
 * fallback, and which file extensions the importer accepts.
 *
 * Static data is the documented baseline (Chrome/Edge 113+, Firefox 120+,
 * Safari 17+); {@link detectCapabilities} refines it at runtime with
 * `HTMLMediaElement.canPlayType`, so a Chrome with HEVC hardware support is
 * treated as such.
 */

/** Containers the detector distinguishes. */
export type ContainerName = 'mp4' | 'webm' | 'mov' | 'mkv' | 'avi' | 'flv' | 'ogg' | 'unknown';

/** Browser engines of the compatibility matrix. */
export type EngineName = 'chromium' | 'firefox' | 'safari';

/** What the current browser can decode natively. */
export interface CodecCapabilities {
  containers: ReadonlySet<ContainerName>;
  video: ReadonlySet<string>;
  audio: ReadonlySet<string>;
  /** `VideoEncoder` exists (proxies without FFmpeg). */
  videoEncoder: boolean;
  /** `VideoDecoder` exists. */
  videoDecoder: boolean;
}

/** One row of the documented matrix. */
export interface SupportRow {
  engine: EngineName;
  containers: readonly ContainerName[];
  video: readonly string[];
  audio: readonly string[];
  videoEncoder: boolean;
}

/** The documented baseline per engine (README "Matriz de compatibilidad"). */
export const SUPPORT_MATRIX: readonly SupportRow[] = [
  {
    engine: 'chromium',
    containers: ['mp4', 'mov', 'webm', 'ogg'],
    video: ['h264', 'vp8', 'vp9', 'av1'],
    audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm'],
    videoEncoder: true,
  },
  {
    engine: 'firefox',
    containers: ['mp4', 'webm', 'ogg'],
    video: ['h264', 'vp8', 'vp9', 'av1', 'theora'],
    audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm'],
    videoEncoder: false,
  },
  {
    engine: 'safari',
    containers: ['mp4', 'mov', 'webm'],
    video: ['h264', 'hevc', 'vp9'],
    audio: ['aac', 'mp3', 'opus', 'flac', 'pcm', 'alac'],
    videoEncoder: false,
  },
];

/** Extensions the importer accepts (video, audio, image, subtitles, LUTs). */
export const MEDIA_EXTENSIONS: readonly string[] = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', 'ogv', 'ogg', 'mts', 'm2ts', 'ts', 'mxf', '3gp', 'wmv',
  'wav', 'mp3', 'm4a', 'aac', 'flac', 'opus', 'oga', 'aiff', 'aif',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif',
];

/** Subtitle extensions. */
export const SUBTITLE_EXTENSIONS: readonly string[] = ['srt', 'vtt'];

/** LUT extensions. */
export const LUT_EXTENSIONS: readonly string[] = ['cube'];

/** Media kind by extension (for grouping before probing). */
export function kindByExtension(name: string): 'video' | 'audio' | 'image' | 'subtitle' | 'lut' | 'other' {
  const ext = extensionOf(name);
  if (SUBTITLE_EXTENSIONS.includes(ext)) return 'subtitle';
  if (LUT_EXTENSIONS.includes(ext)) return 'lut';
  if (['wav', 'mp3', 'm4a', 'aac', 'flac', 'opus', 'oga', 'aiff', 'aif'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) return 'image';
  if (MEDIA_EXTENSIONS.includes(ext)) return 'video';
  return 'other';
}

/**
 * Lowercase extension without the dot.
 * @param name a file name.
 * @returns e.g. `mp4`, or `''`.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/** `canPlayType` probes per codec family. */
const VIDEO_PROBES: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.42E01E"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  vp8: 'video/webm; codecs="vp8"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
  theora: 'video/ogg; codecs="theora"',
};

const AUDIO_PROBES: Record<string, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mpeg',
  opus: 'audio/webm; codecs="opus"',
  vorbis: 'audio/ogg; codecs="vorbis"',
  flac: 'audio/flac',
  pcm: 'audio/wav; codecs="1"',
  alac: 'audio/mp4; codecs="alac"',
};

const CONTAINER_PROBES: Partial<Record<ContainerName, string>> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mkv: 'video/x-matroska',
};

/** Something with `canPlayType` (a media element). */
export interface PlayTypeProbe {
  canPlayType(type: string): string;
}

/**
 * The capabilities of this browser.
 * @param probe a media element (created from `document` by default).
 * @returns detected capabilities; the Chromium baseline when nothing can be probed.
 */
export function detectCapabilities(probe?: PlayTypeProbe | null): CodecCapabilities {
  const element: PlayTypeProbe | null =
    probe ?? (typeof document !== 'undefined' ? document.createElement('video') : null);
  const videoEncoder = typeof VideoEncoder !== 'undefined';
  const videoDecoder = typeof VideoDecoder !== 'undefined';
  const baseline = SUPPORT_MATRIX[0]!;
  if (!element || typeof element.canPlayType !== 'function') {
    return {
      containers: new Set(baseline.containers),
      video: new Set(baseline.video),
      audio: new Set(baseline.audio),
      videoEncoder,
      videoDecoder,
    };
  }
  const can = (type: string): boolean => {
    try {
      return element.canPlayType(type) !== '';
    } catch {
      return false;
    }
  };
  const video = new Set(Object.keys(VIDEO_PROBES).filter((key) => can(VIDEO_PROBES[key]!)));
  const audio = new Set(Object.keys(AUDIO_PROBES).filter((key) => can(AUDIO_PROBES[key]!)));
  const containers = new Set<ContainerName>();
  for (const [name, type] of Object.entries(CONTAINER_PROBES)) {
    if (isContainerName(name) && type && can(type)) containers.add(name);
  }
  // jsdom and similar answer "" to everything: fall back to the baseline.
  if (video.size === 0 && audio.size === 0 && containers.size === 0) {
    return {
      containers: new Set(baseline.containers),
      video: new Set(baseline.video),
      audio: new Set(baseline.audio),
      videoEncoder,
      videoDecoder,
    };
  }
  return { containers, video, audio, videoEncoder, videoDecoder };
}

/** Narrowing guard for container names. */
export function isContainerName(value: string): value is ContainerName {
  return ['mp4', 'webm', 'mov', 'mkv', 'avi', 'flv', 'ogg', 'unknown'].includes(value);
}

/**
 * The matrix row of an engine.
 * @param engine the engine.
 * @returns the row.
 */
export function supportFor(engine: EngineName): SupportRow {
  return SUPPORT_MATRIX.find((row) => row.engine === engine) ?? SUPPORT_MATRIX[0]!;
}

/**
 * The capabilities a documented engine would have (tests, README).
 * @param engine the engine.
 * @returns capabilities from the matrix.
 */
export function capabilitiesOf(engine: EngineName): CodecCapabilities {
  const row = supportFor(engine);
  return {
    containers: new Set(row.containers),
    video: new Set(row.video),
    audio: new Set(row.audio),
    videoEncoder: row.videoEncoder,
    videoDecoder: true,
  };
}
