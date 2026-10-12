// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The media module: demuxing, decoding, thumbnails, pool. */
export {
  MP4Demuxer,
  detectContainer,
  type ContainerKind,
  type DemuxSample,
  type DemuxTrack,
} from './demuxer.ts';
export { MediaDecoder, type MediaDecoderOptions, type MediaFallback, type MediaInfo } from './decoder.ts';
export {
  MemoryThumbnailStore,
  generateThumbnail,
  generateThumbnailStrip,
  scaleThumbnail,
  thumbnailKey,
  type ThumbnailRecord,
  type ThumbnailStore,
} from './thumbnail.ts';
export { MediaPool, type MediaAsset, type MediaPoolOptions } from './media-pool.ts';

// Fase 4 submodules (namespaced to keep names unambiguous).
export * as proxy from './proxy/index.ts';
export * as ffmpeg from './ffmpeg/index.ts';
export * as audio from './audio/index.ts';
export * as vision from './vision/index.ts';
export * as subtitles from './subtitles/index.ts';
export * as relink from './relink/index.ts';
export * as importer from './import/index.ts';
export { EFFECTS_KEY, emptyClipEffects, parseClipEffects, serializeClipEffects, type ClipEffects } from './clip-effects.ts';
