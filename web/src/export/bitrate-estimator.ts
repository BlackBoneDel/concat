// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: output-size estimates and the human formatting the export modal
 * shows ("12.4 MB", "00:03:21"). The desktop export sheet
 * (`src/crates/concat-host/src/export.rs`, `ExportSpec::bitrate_kbps`)
 * reasons in kbps; the estimates here are the same arithmetic in bits.
 */

import type { ExportConfig, ExportFormat } from './types.ts';

/**
 * Bytes of a constant-bitrate stream.
 * @param bitsPerSecond the bitrate.
 * @param seconds the duration.
 * @returns bytes (0 for non-positive input).
 */
export function estimateStreamBytes(bitsPerSecond: number, seconds: number): number {
  if (!(bitsPerSecond > 0) || !(seconds > 0)) return 0;
  return Math.round((bitsPerSecond * seconds) / 8);
}

/**
 * Bytes of the encoded video stream.
 * @param config the export config.
 * @param seconds the duration.
 * @returns bytes.
 */
export function estimateVideoBytes(config: Pick<ExportConfig, 'videoBitrate'>, seconds: number): number {
  return estimateStreamBytes(config.videoBitrate, seconds);
}

/**
 * Bytes of the encoded audio stream (0 for `none`).
 * @param config the export config.
 * @param seconds the duration.
 * @returns bytes.
 */
export function estimateAudioBytes(config: Pick<ExportConfig, 'audioBitrate' | 'audioCodec'>, seconds: number): number {
  if (config.audioCodec === 'none') return 0;
  return estimateStreamBytes(config.audioBitrate, seconds);
}

/**
 * Container overhead: headers plus a per-sample index cost. MP4 writes
 * ~4 KB of `moov` boxes and 12 bytes a sample (size + offset + timing
 * tables); WebM ~1 KB of EBML header and ~16 bytes a frame (SimpleBlock
 * header, cluster and cue entries).
 * @param format the container.
 * @param seconds the duration.
 * @param fps frames per second.
 * @returns bytes.
 */
export function estimateContainerOverhead(format: ExportFormat, seconds: number, fps: number): number {
  if (!(seconds > 0)) return 0;
  const frames = Math.ceil(seconds * Math.max(1, fps));
  if (format === 'mp4') return 4096 + frames * 12;
  if (format === 'webm') return 1024 + frames * 16;
  return 800 + frames * 19;
}

/**
 * GIF size: LZW over an 8-bit indexed image lands at roughly 0.45 bytes a
 * pixel for video footage (0.6 with dithering, which defeats run lengths).
 * @param width frame width.
 * @param height frame height.
 * @param frames frame count.
 * @param dither whether Floyd–Steinberg is on.
 * @returns bytes.
 */
export function estimateGifBytes(width: number, height: number, frames: number, dither: boolean): number {
  if (!(width > 0 && height > 0 && frames > 0)) return 0;
  const perPixel = dither ? 0.6 : 0.45;
  return Math.round(width * height * frames * perPixel + 800 + 768 * frames);
}

/**
 * The whole file.
 * @param config the export config.
 * @param seconds the duration.
 * @returns bytes.
 */
export function estimateTotalBytes(config: ExportConfig, seconds: number): number {
  const fps = config.frameRate.den > 0 ? config.frameRate.num / config.frameRate.den : 30;
  if (config.format === 'gif') {
    return estimateGifBytes(config.width, config.height, Math.floor(seconds * fps), config.gif.dither);
  }
  return estimateVideoBytes(config, seconds) + estimateAudioBytes(config, seconds) + estimateContainerOverhead(config.format, seconds, fps);
}

/**
 * Human byte count with one decimal: `512 B`, `3.2 KB`, `12.4 MB`, `1.1 GB`.
 * @param bytes the count.
 * @returns the label.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Seconds as `HH:MM:SS` (`--:--:--` when unknown).
 * @param seconds the time left.
 * @returns the label.
 */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--:--:--';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Bits per second as `8 Mbps` / `192 kbps`.
 * @param bitsPerSecond the bitrate.
 * @returns the label.
 */
export function formatBitrate(bitsPerSecond: number): string {
  if (!(bitsPerSecond > 0)) return '0 kbps';
  if (bitsPerSecond >= 1_000_000) {
    const mbps = bitsPerSecond / 1_000_000;
    return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mbps`;
  }
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}
