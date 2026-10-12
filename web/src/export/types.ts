// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the types of the offline export pipeline — configuration,
 * progress, result and the typed error every stage raises.
 *
 * Port of the seam in `src/crates/concat-host/src/export.rs` (`ExportSpec`,
 * `Progress` with its "video"/"audio"/"mux" stages, one cancellable export
 * at a time) and the checks of `concat-export/src/lib.rs::render_on` (a valid
 * `FrameRate`, a frame side within `MAX_SIDE`, a non-empty timeline). Where
 * the desktop pipes frames into FFmpeg, the web pipeline is: render
 * (compositor) → encode (WebCodecs) → mux (own MP4/WebM writers, or the own
 * GIF encoder) → `Blob`.
 */

import { Rational } from '../core/rational.ts';

/** Output container. */
export type ExportFormat = 'mp4' | 'webm' | 'gif';

/** Video codec choice (GIF ignores it). */
export type ExportVideoCodec = 'h264-baseline' | 'h264-high' | 'vp9' | 'av1';

/** Audio codec choice; `none` exports silent video. */
export type ExportAudioCodec = 'aac' | 'opus' | 'none';

/** WebCodecs hardware preference, passed through to `VideoEncoder`. */
export type ExportHardware = 'no-preference' | 'prefer-hardware' | 'prefer-software';

/** An exact frame rate (`num/den` fps, e.g. 30000/1001). */
export interface ExportFrameRate {
  num: number;
  den: number;
}

/** GIF-specific options. */
export interface GifOptions {
  /** Floyd–Steinberg error diffusion (smoother gradients, larger files). */
  dither: boolean;
  /** NETSCAPE loop count: 0 = forever. */
  loop: number;
  /** Palette size, 2..256. */
  maxColors: number;
}

/** Everything one export needs. */
export interface ExportConfig {
  format: ExportFormat;
  videoCodec: ExportVideoCodec;
  audioCodec: ExportAudioCodec;
  /** Output frame size, even numbers for the YUV codecs. */
  width: number;
  height: number;
  frameRate: ExportFrameRate;
  /** Bits per second. */
  videoBitrate: number;
  /** Bits per second. */
  audioBitrate: number;
  /** Always 48 000 in the presets. */
  sampleRate: number;
  /** 1 or 2. */
  channels: number;
  /** Seconds between keyframes (2 by default). */
  keyframeInterval: number;
  /** Timeline range; `null` = the session's in/out range, else everything. */
  range: { start: Rational; end: Rational } | null;
  /** Keep subtitle clips (`clip.extra.subtitle`) in the picture. */
  burnSubtitles: boolean;
  /** Use proxies when an original is missing (off: missing original = NO_MEDIA). */
  allowProxyFallback: boolean;
  hardwareAcceleration: ExportHardware;
  gif: GifOptions;
  /** Download name without the extension. */
  fileName: string;
  /** Preset the config came from, when any. */
  presetId: string | null;
}

/** The pipeline stages, in order; the last three are terminal. */
export type ExportPhase =
  | 'idle'
  | 'preparing'
  | 'rendering'
  | 'encoding-audio'
  | 'muxing'
  | 'finalizing'
  | 'done'
  | 'cancelled'
  | 'error';

/** One progress report. */
export interface ExportProgress {
  phase: ExportPhase;
  /** Frames rendered and encoded so far. */
  frame: number;
  totalFrames: number;
  /** Overall progress, 0..1. */
  ratio: number;
  /** Measured render+encode speed, frames per second. */
  fps: number;
  /** Estimated seconds left, `null` before the first measurement. */
  etaSeconds: number | null;
  /** Bytes produced so far (encoded chunks). */
  bytesWritten: number;
  /** Small preview of the last rendered frame (≤ 480 px wide), when any. */
  preview: ImageBitmap | null;
  /** Human message for the current step. */
  message: string;
}

/** A finished export. */
export interface ExportResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  /** Seconds of media. */
  duration: number;
  frames: number;
  /** Wall-clock milliseconds the export took. */
  elapsedMs: number;
  /** `webcodecs` normally; `ffmpeg` when the WASM fallback encoded it; `gif` for the GIF encoder. */
  encoder: 'webcodecs' | 'ffmpeg' | 'gif';
  warnings: string[];
}

/** Machine-readable failure reasons. */
export type ExportErrorCode =
  | 'ABORTED'
  | 'ENCODER_UNSUPPORTED'
  | 'MUX_FAILED'
  | 'OUT_OF_MEMORY'
  | 'NO_MEDIA'
  | 'INVALID_RANGE'
  | 'UNKNOWN';

/** The user-facing wording of each code (Spanish UI). */
export const EXPORT_ERROR_MESSAGES: Readonly<Record<ExportErrorCode, string>> = Object.freeze({
  ABORTED: 'La exportación se canceló.',
  ENCODER_UNSUPPORTED: 'Este navegador no puede codificar con la configuración elegida.',
  MUX_FAILED: 'No se pudo empaquetar el archivo de salida.',
  OUT_OF_MEMORY: 'Memoria insuficiente para exportar con esta configuración.',
  NO_MEDIA: 'Faltan medios originales para exportar.',
  INVALID_RANGE: 'El rango de exportación no es válido.',
  UNKNOWN: 'La exportación falló por un error inesperado.',
});

/** The error every export stage raises. */
export class ExportError extends Error {
  /** Why it failed. */
  readonly code: ExportErrorCode;
  /** The underlying error, when one was wrapped. */
  override readonly cause: unknown;

  /**
   * @param code the reason.
   * @param message detail (defaults to the code's wording).
   * @param cause the wrapped error.
   */
  constructor(code: ExportErrorCode, message?: string, cause?: unknown) {
    super(message ?? EXPORT_ERROR_MESSAGES[code]);
    this.name = 'ExportError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Narrows an unknown to {@link ExportError}.
 * @param value anything thrown.
 * @returns whether it is an export error.
 */
export function isExportError(value: unknown): value is ExportError {
  return value instanceof ExportError;
}

/**
 * Wraps anything thrown into an {@link ExportError}: aborts become
 * `ABORTED`, allocation failures `OUT_OF_MEMORY`, the rest `UNKNOWN`.
 * @param error what was thrown.
 * @returns a typed error.
 */
export function toExportError(error: unknown): ExportError {
  if (error instanceof ExportError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError') return new ExportError('ABORTED', undefined, error);
  if (error instanceof RangeError || /out of memory|allocation failed|QuotaExceeded/i.test(`${name} ${message}`)) {
    return new ExportError('OUT_OF_MEMORY', undefined, error);
  }
  if (name === 'NotSupportedError') return new ExportError('ENCODER_UNSUPPORTED', message, error);
  return new ExportError('UNKNOWN', message || EXPORT_ERROR_MESSAGES.UNKNOWN, error);
}

/**
 * Throws `ABORTED` when the signal fired.
 * @param signal the export's signal.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportError('ABORTED');
}

/** MIME type per container. */
export const EXPORT_MIME_TYPES: Readonly<Record<ExportFormat, string>> = Object.freeze({
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
});

/** The video codecs each container accepts. */
export const CONTAINER_VIDEO_CODECS: Readonly<Record<ExportFormat, readonly ExportVideoCodec[]>> = Object.freeze({
  mp4: ['h264-baseline', 'h264-high', 'av1'],
  webm: ['vp9', 'av1'],
  gif: [],
});

/** The audio codecs each container accepts. */
export const CONTAINER_AUDIO_CODECS: Readonly<Record<ExportFormat, readonly ExportAudioCodec[]>> = Object.freeze({
  mp4: ['aac', 'opus', 'none'],
  webm: ['opus', 'none'],
  gif: ['none'],
});

/** Largest frame side the encoders are asked for (AV1/H.264 level limits). */
export const MAX_EXPORT_SIDE = 4096;

/**
 * The default configuration: 1080p30 H.264 High + AAC 192k in MP4.
 * @returns a fresh config.
 */
export function defaultExportConfig(): ExportConfig {
  return {
    format: 'mp4',
    videoCodec: 'h264-high',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    frameRate: { num: 30, den: 1 },
    videoBitrate: 8_000_000,
    audioBitrate: 192_000,
    sampleRate: 48_000,
    channels: 2,
    keyframeInterval: 2,
    range: null,
    burnSubtitles: true,
    allowProxyFallback: false,
    hardwareAcceleration: 'no-preference',
    gif: { dither: true, loop: 0, maxColors: 256 },
    fileName: 'concat-export',
    presetId: null,
  };
}

/**
 * The frame rate as an exact rational.
 * @param rate the config rate.
 * @returns `num/den`, or `null` when not a positive integer ratio.
 */
export function frameRateOf(rate: ExportFrameRate): Rational | null {
  if (!Number.isInteger(rate.num) || !Number.isInteger(rate.den) || rate.num <= 0 || rate.den <= 0) return null;
  return Rational.new(rate.num, rate.den);
}

/**
 * Validates a configuration.
 * @param config the config.
 * @returns human-readable problems (empty when valid).
 */
export function validateExportConfig(config: ExportConfig): string[] {
  const problems: string[] = [];
  const sizeOk = (value: number): boolean => Number.isInteger(value) && value >= 16 && value <= MAX_EXPORT_SIDE;
  if (!sizeOk(config.width) || !sizeOk(config.height)) {
    problems.push(`La resolución debe estar entre 16 y ${MAX_EXPORT_SIDE} px por lado.`);
  } else if (config.format !== 'gif' && (config.width % 2 !== 0 || config.height % 2 !== 0)) {
    problems.push('Ancho y alto deben ser pares para MP4/WebM.');
  }
  const fps = frameRateOf(config.frameRate);
  if (!fps) problems.push('La frecuencia de fotogramas debe ser una fracción positiva.');
  else if (fps.asNumber() > 120) problems.push('La frecuencia máxima es 120 fps.');
  else if (config.format === 'gif' && fps.asNumber() > 50) problems.push('GIF admite como máximo 50 fps.');
  if (config.format !== 'gif') {
    if (!CONTAINER_VIDEO_CODECS[config.format].includes(config.videoCodec)) {
      problems.push(`${config.format.toUpperCase()} no admite el códec de vídeo ${config.videoCodec}.`);
    }
    if (!CONTAINER_AUDIO_CODECS[config.format].includes(config.audioCodec)) {
      problems.push(`${config.format.toUpperCase()} no admite el códec de audio ${config.audioCodec}.`);
    }
    if (!(config.videoBitrate >= 100_000 && config.videoBitrate <= 200_000_000)) {
      problems.push('El bitrate de vídeo debe estar entre 0,1 y 200 Mbps.');
    }
    if (config.audioCodec !== 'none' && !(config.audioBitrate >= 32_000 && config.audioBitrate <= 512_000)) {
      problems.push('El bitrate de audio debe estar entre 32 y 512 kbps.');
    }
  }
  if (config.sampleRate !== 48_000 && config.sampleRate !== 44_100) problems.push('Frecuencia de muestreo: 44 100 o 48 000 Hz.');
  if (config.channels !== 1 && config.channels !== 2) problems.push('Canales de audio: 1 o 2.');
  if (!(config.keyframeInterval > 0 && config.keyframeInterval <= 10)) problems.push('Intervalo de keyframes: 0–10 s.');
  if (config.range && config.range.end.compare(config.range.start) <= 0) problems.push('El final del rango debe ser posterior al inicio.');
  if (config.format === 'gif' && !(Number.isInteger(config.gif.maxColors) && config.gif.maxColors >= 2 && config.gif.maxColors <= 256)) {
    problems.push('La paleta GIF debe tener entre 2 y 256 colores.');
  }
  return problems;
}

/**
 * The download name: sanitized base name plus the container extension.
 * @param config the config.
 * @returns e.g. `mi-video.mp4`.
 */
export function exportFileName(config: ExportConfig): string {
  const base = config.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().replace(/\.(mp4|webm|gif)$/i, '') || 'concat-export';
  return `${base.slice(0, 120)}.${config.format}`;
}

/** One encoded access unit, copied out of WebCodecs into owned bytes. */
export interface EncodedPacket {
  data: Uint8Array<ArrayBuffer>;
  /** Presentation time, microseconds from the file start. */
  timestamp: number;
  /** Microseconds. */
  duration: number;
  keyFrame: boolean;
}

/** What a muxer needs to describe the video track. */
export interface VideoTrackInfo {
  /** WebCodecs codec string (`avc1.640028`, `vp09.00.10.08`, `av01.0.04M.08`). */
  codec: string;
  width: number;
  height: number;
  frameRate: ExportFrameRate;
  /** `decoderConfig.description` (avcC / av1C), when the encoder gave one. */
  description: Uint8Array<ArrayBuffer> | null;
}

/** What a muxer needs to describe the audio track. */
export interface AudioTrackInfo {
  /** `mp4a.40.2` or `opus`. */
  codec: string;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig / OpusHead, when the encoder gave one. */
  description: Uint8Array<ArrayBuffer> | null;
}

/** The streaming interface both container writers implement. */
export interface MuxerAdapter {
  /** Updates the track descriptions once the encoders report them. */
  setVideoTrack(info: VideoTrackInfo): void;
  setAudioTrack(info: AudioTrackInfo | null): void;
  addVideoPacket(packet: EncodedPacket): void;
  addAudioPacket(packet: EncodedPacket): void;
  /** Bytes accepted so far. */
  readonly bytesWritten: number;
  /** Writes indexes and returns the file. */
  finalize(): Blob;
  /** Drops everything buffered. */
  abort(): void;
}
