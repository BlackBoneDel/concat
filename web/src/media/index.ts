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
export { MediaDecoder, type MediaInfo } from './decoder.ts';
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
