// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the built-in export presets. The desktop sheet
 * (`src/crates/concat-host/src/export.rs`, `ExportSpec`) exposes CRF and an
 * x264 preset; the web encoders are bitrate-driven, so each preset pins a
 * target bitrate that matches the platform's upload recommendation.
 */

import { estimateTotalBytes } from './bitrate-estimator.ts';
import { defaultExportConfig, type ExportConfig } from './types.ts';

/** One preset: a label and the fields it overrides. */
export interface ExportPreset {
  id: string;
  label: string;
  description: string;
  config: Partial<Omit<ExportConfig, 'range' | 'fileName' | 'presetId'>>;
}

const AAC_320 = 320_000;

/** The built-in presets, in menu order. */
export const EXPORT_PRESETS: readonly ExportPreset[] = Object.freeze([
  {
    id: 'youtube-1080p',
    label: 'YouTube 1080p',
    description: 'MP4 H.264 High 1920×1080 · 30 fps · 8 Mbps · AAC 192 kbps',
    config: { format: 'mp4', videoCodec: 'h264-high', audioCodec: 'aac', width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, videoBitrate: 8_000_000, audioBitrate: 192_000 },
  },
  {
    id: 'youtube-4k',
    label: 'YouTube 4K',
    description: 'MP4 H.264 High 3840×2160 · 30 fps · 20 Mbps · AAC 320 kbps',
    config: { format: 'mp4', videoCodec: 'h264-high', audioCodec: 'aac', width: 3840, height: 2160, frameRate: { num: 30, den: 1 }, videoBitrate: 20_000_000, audioBitrate: AAC_320 },
  },
  {
    id: 'tiktok-reels',
    label: 'TikTok / Reels',
    description: 'MP4 H.264 vertical 1080×1920 · 30 fps · 6 Mbps · AAC 192 kbps',
    config: { format: 'mp4', videoCodec: 'h264-high', audioCodec: 'aac', width: 1080, height: 1920, frameRate: { num: 30, den: 1 }, videoBitrate: 6_000_000, audioBitrate: 192_000 },
  },
  {
    id: 'instagram-square',
    label: 'Instagram cuadrado',
    description: 'MP4 H.264 1080×1080 · 30 fps · 5 Mbps · AAC 192 kbps',
    config: { format: 'mp4', videoCodec: 'h264-high', audioCodec: 'aac', width: 1080, height: 1080, frameRate: { num: 30, den: 1 }, videoBitrate: 5_000_000, audioBitrate: 192_000 },
  },
  {
    id: 'pro-60fps',
    label: 'Pro 60 fps',
    description: 'MP4 H.264 High 1920×1080 · 60 fps · 12 Mbps · AAC 320 kbps',
    config: { format: 'mp4', videoCodec: 'h264-high', audioCodec: 'aac', width: 1920, height: 1080, frameRate: { num: 60, den: 1 }, videoBitrate: 12_000_000, audioBitrate: AAC_320 },
  },
  {
    id: 'web-low',
    label: 'Web ligero',
    description: 'WebM VP9 1280×720 · 30 fps · 2 Mbps · Opus 128 kbps',
    config: { format: 'webm', videoCodec: 'vp9', audioCodec: 'opus', width: 1280, height: 720, frameRate: { num: 30, den: 1 }, videoBitrate: 2_000_000, audioBitrate: 128_000 },
  },
  {
    id: 'gif-short',
    label: 'GIF corto',
    description: 'GIF animado 480×270 · 12 fps · 256 colores',
    config: { format: 'gif', audioCodec: 'none', width: 480, height: 270, frameRate: { num: 12, den: 1 }, gif: { dither: true, loop: 0, maxColors: 256 } },
  },
  {
    id: 'master-prores-like',
    label: 'Máster alta calidad',
    description: 'MP4 H.264 High 1920×1080 · 30 fps · 15 Mbps · AAC 320 kbps',
    config: { format: 'mp4', videoCodec: 'h264-high', audioCodec: 'aac', width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, videoBitrate: 15_000_000, audioBitrate: AAC_320, keyframeInterval: 1 },
  },
]);

/**
 * Looks a preset up.
 * @param id the preset id.
 * @returns the preset, or `null`.
 */
export function getPresetById(id: string): ExportPreset | null {
  return EXPORT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * A config with the preset applied over `base` (range and file name kept).
 * @param preset the preset (or its id).
 * @param base the config to start from (defaults otherwise).
 * @returns a new config.
 * @throws Error for an unknown preset id.
 */
export function applyPreset(preset: ExportPreset | string, base: ExportConfig = defaultExportConfig()): ExportConfig {
  const resolved = typeof preset === 'string' ? getPresetById(preset) : preset;
  if (!resolved) throw new Error(`Preset de exportación desconocido: ${String(preset)}`);
  const merged: ExportConfig = {
    ...base,
    ...resolved.config,
    frameRate: { ...(resolved.config.frameRate ?? base.frameRate) },
    gif: { ...(resolved.config.gif ?? base.gif) },
    range: base.range,
    fileName: base.fileName,
    presetId: resolved.id,
  };
  if (merged.format === 'gif') merged.audioCodec = 'none';
  return merged;
}

/**
 * The expected file size of a preset (or config) over a duration.
 * @param preset a preset, its id, or a full config.
 * @param seconds the duration.
 * @returns bytes.
 */
export function estimateOutputBytes(preset: ExportPreset | ExportConfig | string, seconds: number): number {
  const config = typeof preset === 'string' || 'config' in preset ? applyPreset(preset) : preset;
  return estimateTotalBytes(config, seconds);
}
