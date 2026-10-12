// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Proxy orchestration: decides which media need a proxy, queues jobs (max 2
 * at once by default), runs each one in its own worker
 * (`workers/proxy-worker.ts`, killed on completion or cancel), falls back to
 * FFmpeg (VP8/WebM, see `media/ffmpeg/`) when WebCodecs cannot encode the
 * target or demux the source, retries a failed job once, and stores the
 * result through {@link ProxyStore} with its SHA-256.
 *
 * Port note: equivalent to the proxy stage of `concat-media` in the Rust
 * original — preview decodes the light file, export the original.
 */

import { Rational } from '../../core/rational.ts';
import type { MediaInfo } from '../decoder.ts';
import { WorkerClient } from '../../workers/worker-client.ts';
import type { ProxyMetadata, ProxyStore } from './proxy-store.ts';
import type { ProxyConfig, ProxyGenerationJob, ProxyPriority, ProxyQueue } from './proxy-queue.ts';
import {
  browserProxyEnv,
  computeProxySize,
  runProxyJob,
  UNSUPPORTED_ENCODER,
  UNSUPPORTED_SOURCE,
  type ProxyJobResult,
} from './proxy-worker.ts';

/** Default proxy: 1280×720 @ 30 fps, 2 Mbps, AVC (widest compatibility). */
export const DEFAULT_PROXY_CONFIG: ProxyConfig = Object.freeze({
  resolution: Object.freeze({ width: 1280, height: 720 }),
  bitrate: 2_000_000,
  fps: 30,
  codec: 'avc',
});

/** Low proxy: 640×360 @ 24 fps, 800 kbps. */
export const LOW_PROXY_CONFIG: ProxyConfig = Object.freeze({
  resolution: Object.freeze({ width: 640, height: 360 }),
  bitrate: 800_000,
  fps: 24,
  codec: 'avc',
});

/** Bitrate above which a proxy is generated automatically (8 Mbps). */
export const AUTO_PROXY_BITRATE = 8_000_000;

/** Codecs that always get a proxy (heavy to decode or not decodable everywhere). */
export const HEAVY_CODECS: readonly string[] = ['hevc', 'av1', 'prores'];

/** Lifecycle of a media's proxy. */
export type ProxyStatus = 'none' | 'pending' | 'generating' | 'ready' | 'error';

/** Runs one job; injectable so tests and alternative engines can plug in. */
export type ProxyRunner = (
  job: ProxyGenerationJob,
  onProgress: (value: number) => void,
  registerCancel: (cancel: () => void) => void,
) => Promise<ProxyJobResult>;

/** Something that can transcode a blob into a playable proxy (FFmpeg). */
export interface ProxyTranscoder {
  transcode(
    input: Blob,
    output: { format: 'webm'; videoCodec: 'libvpx'; width: number; height: number; fps: number; videoBitrate: number; audio: false },
  ): Promise<Blob>;
}

/** Options for {@link ProxyGenerator}. */
export interface ProxyGeneratorOptions {
  /** Main runner (worker + WebCodecs by default). */
  runner?: ProxyRunner;
  /** FFmpeg fallback; when absent, unsupported jobs fail. */
  transcoder?: ProxyTranscoder | null;
  /** Probes source size for the FFmpeg path. */
  probeSize?: (file: Blob) => Promise<{ width: number; height: number; duration: number }>;
}

/**
 * Normalizes a codec string to a family name.
 * @param codec e.g. `hvc1.1.6.L93.B0`, `av01.0.08M.08`, `apch`.
 * @returns `hevc`, `av1`, `prores`, `h264`, `vp9`, `vp8` or the input lowercased.
 */
export function codecFamily(codec: string): string {
  const value = codec.toLowerCase();
  if (value.startsWith('hvc1') || value.startsWith('hev1') || value === 'hevc' || value === 'h265') return 'hevc';
  if (value.startsWith('av01') || value === 'av1') return 'av1';
  if (value.startsWith('ap') && ['apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x'].includes(value.slice(0, 4))) return 'prores';
  if (value.includes('prores')) return 'prores';
  if (value.startsWith('avc1') || value.startsWith('avc3') || value === 'h264') return 'h264';
  if (value.startsWith('vp09') || value === 'vp9') return 'vp9';
  if (value.startsWith('vp8') || value === 'vp8') return 'vp8';
  return value;
}

/** Throws when a config is out of range. */
function validateConfig(config: ProxyConfig): void {
  const { width, height } = config.resolution;
  if (!(width >= 16 && height >= 16 && width <= 7680 && height <= 4320)) throw new RangeError('Resolución de proxy inválida');
  if (!(config.bitrate >= 100_000 && config.bitrate <= 100_000_000)) throw new RangeError('Bitrate de proxy inválido');
  if (!(config.fps >= 1 && config.fps <= 120)) throw new RangeError('FPS de proxy inválidos');
}

/** A job that is waiting for its result. */
interface Waiter {
  resolve(meta: ProxyMetadata): void;
  reject(error: Error): void;
}

/** Proxy orchestrator. */
export class ProxyGenerator {
  private readonly store: ProxyStore;
  private readonly queue: ProxyQueue;
  private readonly runner: ProxyRunner;
  private readonly transcoder: ProxyTranscoder | null;
  private readonly probeSize: ((file: Blob) => Promise<{ width: number; height: number; duration: number }>) | null;
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly cancels = new Map<string, () => void>();
  private readonly cancelled = new Set<string>();
  private readonly lastJobs = new Map<string, ProxyGenerationJob>();
  private readonly statuses = new Map<string, ProxyStatus>();
  private readonly progress = new Map<string, number>();
  private readonly errors = new Map<string, string>();

  /** Progress of a running job, 0..1. */
  onProgress: ((mediaId: string, progress: number) => void) | null = null;
  /** A proxy was stored. */
  onComplete: ((mediaId: string, metadata: ProxyMetadata) => void) | null = null;
  /** A job failed for good (after its retry). */
  onError: ((mediaId: string, error: Error) => void) | null = null;
  /** Any status change (for the media panel and the proxy modal). */
  onStatusChange: ((mediaId: string, status: ProxyStatus) => void) | null = null;

  /**
   * @param store persistence.
   * @param queue priority queue with the concurrency limit.
   * @param options runner/fallback overrides.
   */
  constructor(store: ProxyStore, queue: ProxyQueue, options: ProxyGeneratorOptions = {}) {
    this.store = store;
    this.queue = queue;
    this.runner = options.runner ?? workerRunner;
    this.transcoder = options.transcoder ?? null;
    this.probeSize = options.probeSize ?? null;
  }

  /**
   * Whether a media should get a proxy automatically: ≥ 1920×1080 pixels,
   * > 8 Mbps, or a heavy codec (HEVC, AV1, ProRes).
   * @param mediaInfo the probe.
   * @returns `true` to generate.
   */
  shouldGenerateProxy(mediaInfo: MediaInfo): boolean {
    if (mediaInfo.type !== 'video') return false;
    if (mediaInfo.width * mediaInfo.height >= 1920 * 1080) return true;
    const seconds = mediaInfo.duration.asNumber();
    if (seconds > 0 && (mediaInfo.fileSize * 8) / seconds > AUTO_PROXY_BITRATE) return true;
    return HEAVY_CODECS.includes(codecFamily(mediaInfo.videoCodec));
  }

  /**
   * Queues a job and resolves when its proxy is stored.
   * @param job what to generate.
   * @returns the stored metadata.
   */
  generate(job: ProxyGenerationJob): Promise<ProxyMetadata> {
    validateConfig(job.config);
    this.cancelled.delete(job.mediaId);
    this.lastJobs.set(job.mediaId, job);
    const promise = new Promise<ProxyMetadata>((resolve, reject) => {
      const list = this.waiters.get(job.mediaId) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(job.mediaId, list);
    });
    if (!this.queue.isActive(job.mediaId)) {
      this.queue.enqueue(job);
      this.setStatus(job.mediaId, 'pending');
    }
    this.pump();
    return promise;
  }

  /**
   * Cancels a waiting or running job.
   * @param mediaId the media.
   */
  async cancel(mediaId: string): Promise<void> {
    this.cancelled.add(mediaId);
    this.queue.cancel(mediaId);
    this.cancels.get(mediaId)?.();
    this.cancels.delete(mediaId);
    this.settle(mediaId, new Error('Generación de proxy cancelada'));
    this.setStatus(mediaId, (await this.store.get(mediaId)) ? 'ready' : 'none');
    this.pump();
  }

  /**
   * Deletes and regenerates a media's proxy with high priority.
   * @param mediaId the media (must have been generated before in this session).
   * @returns the new metadata.
   */
  async regenerate(mediaId: string): Promise<ProxyMetadata> {
    const job = this.lastJobs.get(mediaId);
    if (!job) throw new Error('No hay archivo fuente registrado para regenerar este proxy');
    await this.store.delete(mediaId);
    return this.generate({ ...job, priority: 'high' });
  }

  /**
   * Registers the source of a media without generating (enables regenerate).
   * @param mediaId the media.
   * @param sourceFile the original.
   * @param config the target.
   */
  registerSource(mediaId: string, sourceFile: File | Blob, config: ProxyConfig = DEFAULT_PROXY_CONFIG): void {
    if (!this.lastJobs.has(mediaId)) this.lastJobs.set(mediaId, { mediaId, sourceFile, config, priority: 'normal' });
  }

  /**
   * The OPFS path of a media's proxy.
   * @param mediaId the media.
   * @returns `proxies/<id>.<ext>` or `null`.
   */
  async getProxyPath(mediaId: string): Promise<string | null> {
    return (await this.store.get(mediaId))?.opfsPath ?? null;
  }

  /** The status of a media's proxy (as known this session). */
  statusOf(mediaId: string): ProxyStatus {
    return this.statuses.get(mediaId) ?? 'none';
  }

  /** The progress of a media's job, 0..1. */
  progressOf(mediaId: string): number {
    return this.progress.get(mediaId) ?? 0;
  }

  /** The last error message of a media's job. */
  errorOf(mediaId: string): string | null {
    return this.errors.get(mediaId) ?? null;
  }

  /**
   * Marks a media as having a stored proxy (restored at boot).
   * @param mediaId the media.
   */
  markReady(mediaId: string): void {
    this.setStatus(mediaId, 'ready');
  }

  /**
   * Marks a media as having no proxy (after a delete).
   * @param mediaId the media.
   */
  markNone(mediaId: string): void {
    this.setStatus(mediaId, 'none');
  }

  /** Priority change of a waiting job. */
  reprioritize(mediaId: string, priority: ProxyPriority): void {
    this.queue.reorder(mediaId, priority);
  }

  // -- internals -----------------------------------------------------------

  private pump(): void {
    for (;;) {
      const job = this.queue.dequeue();
      if (!job) return;
      void this.execute(job);
    }
  }

  private async execute(job: ProxyGenerationJob): Promise<void> {
    const { mediaId } = job;
    this.setStatus(mediaId, 'generating');
    this.progress.set(mediaId, 0);
    const report = (value: number): void => {
      this.progress.set(mediaId, value);
      this.onProgress?.(mediaId, value);
    };
    try {
      const result = await this.attempt(job, report);
      if (this.cancelled.has(mediaId)) return;
      const container = result.blob.type.includes('webm') ? 'webm' : 'mp4';
      const meta = await this.store.save(mediaId, result.blob, {
        width: result.width,
        height: result.height,
        duration: Rational.approximate(result.duration) ?? Rational.ZERO,
        container,
      });
      this.errors.delete(mediaId);
      this.setStatus(mediaId, 'ready');
      this.onComplete?.(mediaId, meta);
      this.settle(mediaId, meta);
    } catch (error) {
      if (this.cancelled.has(mediaId)) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.errors.set(mediaId, failure.message);
      this.setStatus(mediaId, 'error');
      this.onError?.(mediaId, failure);
      this.settle(mediaId, failure);
    } finally {
      this.cancels.delete(mediaId);
      this.queue.complete(mediaId);
      this.pump();
    }
  }

  /** Runs a job: main runner, FFmpeg fallback on unsupported, one retry. */
  private async attempt(job: ProxyGenerationJob, report: (value: number) => void): Promise<ProxyJobResult> {
    const register = (cancel: () => void): void => {
      this.cancels.set(job.mediaId, cancel);
    };
    let lastError: Error = new Error('Proxy no generado');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.cancelled.has(job.mediaId)) throw new Error('Generación de proxy cancelada');
      try {
        return await this.runner(job, report, register);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.message === UNSUPPORTED_ENCODER || lastError.message === UNSUPPORTED_SOURCE || lastError.message === 'Web Workers no disponibles' || lastError.message === 'WebCodecs no disponible') {
          if (this.transcoder) return this.viaFFmpeg(job, report);
          throw new Error('Este navegador no puede generar el proxy (sin VideoEncoder ni FFmpeg)');
        }
      }
    }
    throw lastError;
  }

  /** The FFmpeg path: VP8/WebM at the target size. */
  private async viaFFmpeg(job: ProxyGenerationJob, report: (value: number) => void): Promise<ProxyJobResult> {
    const transcoder = this.transcoder;
    if (!transcoder) throw new Error('FFmpeg no disponible');
    const source = this.probeSize ? await this.probeSize(job.sourceFile) : { width: 0, height: 0, duration: 0 };
    const size = computeProxySize(source.width, source.height, job.config.resolution);
    report(0.05);
    const blob = await transcoder.transcode(job.sourceFile, {
      format: 'webm',
      videoCodec: 'libvpx',
      width: size.width,
      height: size.height,
      fps: job.config.fps,
      videoBitrate: job.config.bitrate,
      audio: false,
    });
    report(1);
    return { blob, width: size.width, height: size.height, duration: source.duration, codec: 'vp8' };
  }

  private settle(mediaId: string, outcome: ProxyMetadata | Error): void {
    const list = this.waiters.get(mediaId);
    if (!list) return;
    this.waiters.delete(mediaId);
    for (const waiter of list) {
      if (outcome instanceof Error) waiter.reject(outcome);
      else waiter.resolve(outcome);
    }
  }

  private setStatus(mediaId: string, status: ProxyStatus): void {
    this.statuses.set(mediaId, status);
    this.onStatusChange?.(mediaId, status);
  }
}

/**
 * The default runner: one dedicated worker per job (terminated at the end,
 * which also implements cancel); inline WebCodecs when workers are missing.
 */
export const workerRunner: ProxyRunner = async (job, onProgress, registerCancel) => {
  const client = new WorkerClient(() =>
    typeof Worker === 'undefined'
      ? null
      : new Worker(new URL('../../workers/proxy-worker.ts', import.meta.url), { type: 'module' }),
  );
  if (client.available) {
    registerCancel(() => client.terminate('Generación de proxy cancelada'));
    try {
      return await client.request<ProxyJobResult>('generate', { sourceFile: job.sourceFile, config: job.config }, [], onProgress);
    } finally {
      client.terminate();
    }
  }
  const env = browserProxyEnv();
  if (!env) throw new Error('WebCodecs no disponible');
  let cancelled = false;
  registerCancel(() => {
    cancelled = true;
  });
  return runProxyJob(job.sourceFile, job.config, env, onProgress, () => cancelled);
};
