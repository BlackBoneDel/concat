// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: offline export — public surface of `src/export/`.
 * Render (compositor) → encode (WebCodecs, or FFmpeg.wasm fallback) → mux
 * (own MP4/WebM writers) or GIF (own encoder) → `Blob`.
 */

export * from './types.ts';
export * from './export-presets.ts';
export * from './bitrate-estimator.ts';
export * from './frame-clock.ts';
export * from './export-document.ts';
export * from './offline-renderer.ts';
export * from './audio-exporter.ts';
export * from './packet-store.ts';
export * from './video-encoder-pool.ts';
export * from './audio-encoder-pool.ts';
export * from './mp4-muxer-adapter.ts';
export * from './webm-muxer-adapter.ts';
export * from './gif-exporter.ts';
export * from './ffmpeg-mux-fallback.ts';
export * from './export-controller.ts';
