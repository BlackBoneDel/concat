// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Proxies: generation, queue, persistence. */
export {
  AUTO_PROXY_BITRATE,
  DEFAULT_PROXY_CONFIG,
  HEAVY_CODECS,
  LOW_PROXY_CONFIG,
  ProxyGenerator,
  codecFamily,
  workerRunner,
  type ProxyGeneratorOptions,
  type ProxyRunner,
  type ProxyStatus,
  type ProxyTranscoder,
} from './proxy-generator.ts';
export {
  ProxyQueue,
  type ProxyConfig,
  type ProxyGenerationJob,
  type ProxyPriority,
} from './proxy-queue.ts';
export {
  DEFAULT_PROXY_LIMIT_BYTES,
  ProxyQuotaError,
  ProxyStore,
  type ProxyMetadata,
  type ProxyStoreOptions,
} from './proxy-store.ts';
export {
  MUX_TIMESCALE,
  UNSUPPORTED_ENCODER,
  UNSUPPORTED_SOURCE,
  browserProxyEnv,
  computeProxySize,
  encoderCodecString,
  muxMp4,
  runProxyJob,
  type DecoderLike,
  type EncodedChunkLike,
  type EncoderLike,
  type FrameLike,
  type MuxSample,
  type MuxTrack,
  type ProxyEnv,
  type ProxyJobResult,
  type ScaleContextLike,
} from './proxy-worker.ts';
