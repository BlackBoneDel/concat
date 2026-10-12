// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: orchestrates one export end to end —
 * `preparing → rendering → encoding-audio → muxing → finalizing → done`
 * (or `cancelled` / `error`). It snapshots the document, forces original
 * media quality for the duration, opens the encoders (checking support
 * first), streams rendered frames through the video encoder into the muxer
 * (≤ 2 frames alive, each closed right after `encode`), renders and
 * encodes the offline mix, and finalizes the container. Browsers without
 * WebCodecs go through the FFmpeg.wasm fallback; GIF goes through the own
 * GIF encoder.
 *
 * Every exit path — success, cancel, error — closes encoders, disposes the
 * renderer surface, drops buffered packets on failure, releases preview
 * bitmaps and restores proxy playback. Port of the single-flight
 * `Exporter` of `src/crates/concat-host/src/export.rs` (`begin`, `cancel`,
 * `is_busy`, progress reported per frame and stage).
 */

import { Rational } from '../core/rational.ts';
import type { ProjectDocument } from '../model/document.ts';
import type { BufferLike } from '../player/audio-mixer.ts';
import type { FramePool } from '../render/types.ts';
import { AudioEncoderPool, type AudioEncoderFactory, type AudioSupportProbe } from './audio-encoder-pool.ts';
import { AudioExporter, audioBlocks, collectAudioClips, type AudioClipSource, type OfflineContextFactory } from './audio-exporter.ts';
import { exportSession, snapshotForExport } from './export-document.ts';
import { FFmpegMuxFallback, type FFmpegExecutor } from './ffmpeg-mux-fallback.ts';
import { GifEncoder, frameDelayCentiseconds, gifDurationWarning } from './gif-exporter.ts';
import { Mp4MuxerAdapter } from './mp4-muxer-adapter.ts';
import { OfflineRenderer, type CompositeFn, type RenderedFrame, type SurfaceFactory } from './offline-renderer.ts';
import {
  EXPORT_MIME_TYPES,
  ExportError,
  exportFileName,
  frameRateOf,
  toExportError,
  validateExportConfig,
  type AudioTrackInfo,
  type ExportConfig,
  type ExportPhase,
  type ExportProgress,
  type ExportResult,
  type MuxerAdapter,
  type VideoTrackInfo,
} from './types.ts';
import { VideoEncoderPool, type VideoEncoderFactory, type VideoSupportProbe } from './video-encoder-pool.ts';
import { WebmMuxerAdapter } from './webm-muxer-adapter.ts';

/** The media side the controller reads (Fase 4 `MediaPool` satisfies it). */
export interface ExportMediaSource {
  exportFrames(allowProxyFallback: boolean): FramePool;
  hasOriginal(id: string): boolean;
  hasProxy(id: string): boolean;
  forceOriginalQuality(enabled: boolean): void;
  getAudioBuffer(id: string): Promise<BufferLike | null>;
}

/** Everything the controller depends on; tests inject doubles. */
export interface ExportEnvironment {
  /** The live document (snapshotted at start). */
  getDocument(): ProjectDocument;
  media: ExportMediaSource;
  /** The session in/out range, when marked. */
  getRange?(): { start: Rational; end: Rational } | null;
  /** The FFmpeg runner for the no-WebCodecs fallback. */
  getFFmpeg?(): FFmpegExecutor | null;
  createSurface?: SurfaceFactory;
  composite?: CompositeFn;
  createVideoEncoder?: VideoEncoderFactory;
  isVideoConfigSupported?: VideoSupportProbe;
  createAudioEncoder?: AudioEncoderFactory;
  isAudioConfigSupported?: AudioSupportProbe;
  createOfflineContext?: OfflineContextFactory;
  /** Whether WebCodecs video encoding exists (defaults to `VideoEncoder` presence or an injected factory). */
  hasWebCodecs?(): boolean;
  /** Milliseconds clock (`performance.now`). */
  now?(): number;
  /** Lets the UI breathe between frames. */
  yieldToUi?(): Promise<void>;
}

/** Progress listener. */
export type ExportProgressListener = (progress: ExportProgress) => void;

/** Share of the bar each stage owns. */
const STAGE_SHARE = { render: 0.85, audio: 0.1, mux: 0.05 } as const;

/** Milliseconds between preview refreshes. */
const PREVIEW_INTERVAL_MS = 1000;

/** Default UI yield: a macrotask. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The single-flight export orchestrator. */
export class ExportController {
  private readonly env: ExportEnvironment;
  private readonly listeners = new Set<ExportProgressListener>();
  private abort: AbortController | null = null;
  private currentPhase: ExportPhase = 'idle';
  private lastPreview: ImageBitmap | null = null;
  private disposed = false;

  /**
   * @param env document, media and injectable factories.
   */
  constructor(env: ExportEnvironment) {
    this.env = env;
  }

  /** The current stage. */
  get phase(): ExportPhase {
    return this.currentPhase;
  }

  /** Whether an export is running. */
  get running(): boolean {
    return this.abort !== null;
  }

  /**
   * Subscribes to progress.
   * @param listener called on every report.
   * @returns unsubscribe.
   */
  onProgress(listener: ExportProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cancels the running export (no-op when idle). */
  cancel(): void {
    this.abort?.abort();
  }

  /** Cancels and drops every listener. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.listeners.clear();
    this.lastPreview?.close();
    this.lastPreview = null;
  }

  /**
   * Runs one export.
   * @param config the configuration.
   * @returns the file.
   * @throws ExportError for every failure (`ABORTED` when cancelled).
   */
  async start(config: ExportConfig): Promise<ExportResult> {
    if (this.disposed) throw new ExportError('UNKNOWN', 'El controlador de exportación está cerrado.');
    if (this.abort) throw new ExportError('UNKNOWN', 'Ya hay una exportación en curso.');
    const abort = new AbortController();
    this.abort = abort;
    const signal = abort.signal;
    const now = this.env.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const startedAt = now();
    const warnings: string[] = [];
    const cleanups: (() => void)[] = [];
    this.env.media.forceOriginalQuality(true);
    cleanups.push(() => this.env.media.forceOriginalQuality(false));
    try {
      this.report({ phase: 'preparing', message: 'Preparando la exportación…' });
      const problems = validateExportConfig(config);
      if (problems.length > 0) throw new ExportError('INVALID_RANGE', problems.join(' '));
      const fps = frameRateOf(config.frameRate);
      if (!fps) throw new ExportError('INVALID_RANGE', 'Frecuencia de fotogramas inválida.');

      const snapshot = snapshotForExport(this.env.getDocument(), { burnSubtitles: config.burnSubtitles });
      const session = exportSession(snapshot);
      if (session.clips().length === 0) throw new ExportError('NO_MEDIA', 'La línea de tiempo está vacía: añade clips antes de exportar.');
      const duration = session.duration();
      const range = config.range ?? this.env.getRange?.() ?? { start: Rational.ZERO, end: duration };
      if (range.end.compare(range.start) <= 0 || range.start.isNegative()) {
        throw new ExportError('INVALID_RANGE', 'El rango de exportación está vacío o invertido.');
      }
      const seconds = range.end.sub(range.start).asNumber();
      if (config.format === 'gif') {
        const warning = gifDurationWarning(seconds);
        if (warning) warnings.push(warning);
      }


      const audioClips =
        config.format === 'gif' || config.audioCodec === 'none'
          ? []
          : await collectAudioClips(session, (path) => this.env.media.getAudioBuffer(path));

      let blob: Blob;
      let encoder: ExportResult['encoder'];
      if (config.format === 'gif') {
        blob = await this.runGif(config, range, snapshot, signal, now, cleanups);
        encoder = 'gif';
      } else {
        const webCodecs = this.env.hasWebCodecs?.() ?? (typeof VideoEncoder !== 'undefined' || this.env.createVideoEncoder !== undefined);
        const ffmpeg = this.env.getFFmpeg?.() ?? null;
        if (webCodecs) {
          try {
            blob = await this.runWebCodecs(config, snapshot, audioClips, range, signal, now, cleanups, warnings);
            encoder = 'webcodecs';
          } catch (error) {
            const typed = toExportError(error);
            if (typed.code !== 'ENCODER_UNSUPPORTED' || !ffmpeg) throw typed;
            warnings.push(`WebCodecs no admite esta configuración (${typed.message}); se usó FFmpeg.wasm.`);
            blob = await this.runFFmpeg(config, snapshot, range, audioClips, ffmpeg, signal, now, cleanups, warnings);
            encoder = 'ffmpeg';
          }
        } else if (ffmpeg) {
          warnings.push('Este navegador no tiene WebCodecs: se exportó con FFmpeg.wasm (más lento).');
          blob = await this.runFFmpeg(config, snapshot, range, audioClips, ffmpeg, signal, now, cleanups, warnings);
          encoder = 'ffmpeg';
        } else {
          throw new ExportError(
            'ENCODER_UNSUPPORTED',
            'Este navegador no puede codificar vídeo (sin WebCodecs ni FFmpeg). Usa Chrome/Edge 113+ o exporta como GIF.',
          );
        }
      }

      this.report({ phase: 'finalizing', ratio: 0.995, message: 'Finalizando…', bytesWritten: blob.size });
      const totalFrames = Number(range.end.sub(range.start).mul(fps).floor());
      const result: ExportResult = {
        blob,
        fileName: exportFileName(config),
        mimeType: EXPORT_MIME_TYPES[config.format],
        duration: Rational.fromInt(totalFrames).div(fps).asNumber(),
        frames: totalFrames,
        elapsedMs: Math.max(0, now() - startedAt),
        encoder,
        warnings,
      };
      this.report({ phase: 'done', ratio: 1, frame: totalFrames, totalFrames, message: 'Exportación completada.', bytesWritten: blob.size, etaSeconds: 0 });
      return result;
    } catch (error) {
      const typed = signal.aborted ? new ExportError('ABORTED') : toExportError(error);
      this.report({ phase: typed.code === 'ABORTED' ? 'cancelled' : 'error', message: typed.message });
      throw typed;
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (cleanupError) {
          console.warn('Limpieza de exportación', cleanupError);
        }
      }
      this.abort = null;
    }
  }

  // -- pipelines -------------------------------------------------------------

  private async runWebCodecs(
    config: ExportConfig,
    snapshot: ProjectDocument,
    audioClips: AudioClipSource[],
    range: { start: Rational; end: Rational },
    signal: AbortSignal,
    now: () => number,
    cleanups: (() => void)[],
    warnings: string[],
  ): Promise<Blob> {
    const video: VideoTrackInfo = { codec: '', width: config.width, height: config.height, frameRate: config.frameRate, description: null };
    const withAudio = config.audioCodec !== 'none';
    const audio: AudioTrackInfo | null = withAudio
      ? { codec: config.audioCodec === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: config.sampleRate, channels: config.channels, description: null }
      : null;
    const muxer: MuxerAdapter =
      config.format === 'mp4'
        ? new Mp4MuxerAdapter({ video, audio, audioBitrate: config.audioBitrate })
        : new WebmMuxerAdapter({ video, audio });
    let finished = false;
    cleanups.push(() => {
      if (!finished) muxer.abort();
    });

    const videoPool = new VideoEncoderPool(config, {
      createEncoder: this.env.createVideoEncoder,
      isConfigSupported: this.env.isVideoConfigSupported,
      onPacket: (packet) => muxer.addVideoPacket(packet),
      signal,
    });
    cleanups.push(() => videoPool.close());
    const audioPool =
      config.audioCodec === 'none'
        ? null
        : new AudioEncoderPool({
            codec: config.audioCodec,
            sampleRate: config.sampleRate,
            channels: config.channels,
            bitrate: config.audioBitrate,
            onPacket: (packet) => muxer.addAudioPacket(packet),
            createEncoder: this.env.createAudioEncoder,
            isConfigSupported: this.env.isAudioConfigSupported,
            signal,
          });
    if (audioPool) cleanups.push(() => audioPool.close());
    const renderer = this.makeRenderer(config, range, snapshot, signal, 'frames');
    cleanups.push(() => renderer.dispose());

    const selection = await videoPool.open();
    if (audioPool) await audioPool.open();
    await renderer.prepare();

    const total = renderer.totalFrames;
    const renderStart = now();
    let lastPreviewAt = -Infinity;
    let lastYield = now();
    for await (const frame of renderer.renderAll()) {
      try {
        if (frame.frame) await videoPool.encode(frame.frame, frame.keyFrame);
      } finally {
        frame.release();
      }
      lastPreviewAt = await this.reportFrame(frame, total, renderStart, now, lastPreviewAt, renderer, muxer.bytesWritten);
      if (now() - lastYield > 32) {
        await (this.env.yieldToUi ?? macrotask)();
        lastYield = now();
      }
    }
    await videoPool.flush();
    muxer.setVideoTrack({ ...video, codec: selection.codec, description: videoPool.description });

    if (audioPool && audio) {
      this.report({ phase: 'encoding-audio', ratio: STAGE_SHARE.render, frame: total, totalFrames: total, message: 'Mezclando y codificando el audio…', bytesWritten: muxer.bytesWritten });
      const exporter = new AudioExporter({ sampleRate: config.sampleRate, channels: config.channels, createContext: this.env.createOfflineContext, signal });
      const totalSamples = exporter.totalFrames(range.start, range.end);
      for await (const window of exporter.render(audioClips, range.start, range.end)) {
        for (const block of audioBlocks(window, config.sampleRate)) await audioPool.encodePlanar(block.planes, block.timestamp);
        const done = window.offsetFrames + (window.planes[0]?.length ?? 0);
        this.report({
          phase: 'encoding-audio',
          ratio: STAGE_SHARE.render + STAGE_SHARE.audio * Math.min(1, done / Math.max(1, totalSamples)),
          frame: total,
          totalFrames: total,
          message: 'Mezclando y codificando el audio…',
          bytesWritten: muxer.bytesWritten,
        });
        await (this.env.yieldToUi ?? macrotask)();
      }
      await audioPool.flush();
      if (exporter.usedManualMix) warnings.push('Sin OfflineAudioContext: el audio se mezcló sin efectos.');
      muxer.setAudioTrack({ ...audio, description: audioPool.description });
    }

    this.report({ phase: 'muxing', ratio: STAGE_SHARE.render + STAGE_SHARE.audio, frame: total, totalFrames: total, message: 'Empaquetando el archivo…', bytesWritten: muxer.bytesWritten });
    if (signal.aborted) throw new ExportError('ABORTED');
    let blob: Blob;
    try {
      blob = muxer.finalize();
    } catch (error) {
      const typed = toExportError(error);
      throw typed.code === 'UNKNOWN' ? new ExportError('MUX_FAILED', typed.message, error) : typed;
    }
    finished = true;
    return blob;
  }

  private async runGif(
    config: ExportConfig,
    range: { start: Rational; end: Rational },
    snapshot: ProjectDocument,
    signal: AbortSignal,
    now: () => number,
    cleanups: (() => void)[],
  ): Promise<Blob> {
    const renderer = this.makeRenderer(config, range, snapshot, signal, 'pixels');
    cleanups.push(() => renderer.dispose());
    await renderer.prepare();
    const gif = new GifEncoder(config.width, config.height, config.gif);
    let finished = false;
    cleanups.push(() => {
      if (!finished) gif.abort();
    });
    const fps = config.frameRate.num / config.frameRate.den;
    const total = renderer.totalFrames;
    const renderStart = now();
    let lastPreviewAt = -Infinity;
    for await (const frame of renderer.renderAll()) {
      try {
        if (frame.pixels) gif.addFrame(frame.pixels, frameDelayCentiseconds(frame.index, fps));
      } finally {
        frame.release();
      }
      lastPreviewAt = await this.reportFrame(frame, total, renderStart, now, lastPreviewAt, renderer, gif.bytesWritten);
      await (this.env.yieldToUi ?? macrotask)();
    }
    this.report({ phase: 'muxing', ratio: 0.97, frame: total, totalFrames: total, message: 'Escribiendo el GIF…', bytesWritten: gif.bytesWritten });
    const blob = gif.finish();
    finished = true;
    return blob;
  }

  private async runFFmpeg(
    config: ExportConfig,
    snapshot: ProjectDocument,
    range: { start: Rational; end: Rational },
    audioClips: AudioClipSource[],
    ffmpeg: FFmpegExecutor,
    signal: AbortSignal,
    now: () => number,
    cleanups: (() => void)[],
    warnings: string[],
  ): Promise<Blob> {
    const renderer = this.makeRenderer(config, range, snapshot, signal, 'jpeg');
    cleanups.push(() => renderer.dispose());
    await renderer.prepare();
    const fallback = new FFmpegMuxFallback(config, ffmpeg, signal);
    const total = renderer.totalFrames;
    const renderStart = now();
    let lastPreviewAt = -Infinity;
    for await (const frame of renderer.renderAll()) {
      try {
        if (frame.jpeg) await fallback.addFrame(frame.jpeg);
      } finally {
        frame.release();
      }
      lastPreviewAt = await this.reportFrame(frame, total, renderStart, now, lastPreviewAt, renderer, fallback.bytesWritten);
      await (this.env.yieldToUi ?? macrotask)();
    }
    if (config.audioCodec !== 'none') {
      this.report({ phase: 'encoding-audio', ratio: STAGE_SHARE.render, frame: total, totalFrames: total, message: 'Mezclando el audio…', bytesWritten: fallback.bytesWritten });
      const exporter = new AudioExporter({ sampleRate: config.sampleRate, channels: config.channels, createContext: this.env.createOfflineContext, signal });
      for await (const window of exporter.render(audioClips, range.start, range.end)) fallback.addAudio(window.planes);
      if (exporter.usedManualMix) warnings.push('Sin OfflineAudioContext: el audio se mezcló sin efectos.');
    }
    this.report({ phase: 'muxing', ratio: STAGE_SHARE.render + STAGE_SHARE.audio, frame: total, totalFrames: total, message: 'Codificando con FFmpeg.wasm…', bytesWritten: fallback.bytesWritten });
    return fallback.finalize((value) =>
      this.report({
        phase: 'muxing',
        ratio: STAGE_SHARE.render + STAGE_SHARE.audio + STAGE_SHARE.mux * value,
        frame: total,
        totalFrames: total,
        message: `Codificando con FFmpeg.wasm… ${Math.round(value * 100)} %`,
        bytesWritten: fallback.bytesWritten,
      }),
    );
  }

  private makeRenderer(
    config: ExportConfig,
    range: { start: Rational; end: Rational },
    snapshot: ProjectDocument,
    signal: AbortSignal,
    output: 'frames' | 'pixels' | 'jpeg',
  ): OfflineRenderer {
    return new OfflineRenderer(
      {
        document: snapshot,
        frames: this.env.media.exportFrames(config.allowProxyFallback),
        hasMedia: (path) => this.env.media.hasOriginal(path) || (config.allowProxyFallback && this.env.media.hasProxy(path)),
      },
      { config: { ...config, burnSubtitles: true }, range, signal, output, createSurface: this.env.createSurface, composite: this.env.composite },
    );
  }

  // -- progress --------------------------------------------------------------

  /**
   * Reports a rendered frame; refreshes the preview at most once a second.
   * @returns the time of the last preview.
   */
  private async reportFrame(
    frame: RenderedFrame,
    total: number,
    renderStart: number,
    now: () => number,
    lastPreviewAt: number,
    renderer: OfflineRenderer,
    bytesWritten: number,
  ): Promise<number> {
    const done = frame.index + 1;
    const elapsed = Math.max(0.001, (now() - renderStart) / 1000);
    const fps = done / elapsed;
    const remaining = total - done;
    let previewAt = lastPreviewAt;
    let preview: ImageBitmap | null = null;
    const at = now();
    if (at - lastPreviewAt >= PREVIEW_INTERVAL_MS || done === total) {
      preview = await renderer.preview();
      previewAt = at;
    }
    this.report({
      phase: 'rendering',
      frame: done,
      totalFrames: total,
      ratio: STAGE_SHARE.render * (done / Math.max(1, total)),
      fps,
      etaSeconds: remaining / Math.max(fps, 0.01),
      bytesWritten,
      preview,
      message: `Renderizando fotograma ${done} de ${total}…`,
    });
    return previewAt;
  }

  private report(partial: Partial<ExportProgress> & { phase: ExportPhase }): void {
    this.currentPhase = partial.phase;
    if (partial.preview) {
      // The previous preview is released once a newer one replaces it.
      this.lastPreview?.close();
      this.lastPreview = partial.preview;
    }
    const progress: ExportProgress = {
      phase: partial.phase,
      frame: partial.frame ?? 0,
      totalFrames: partial.totalFrames ?? 0,
      ratio: Math.max(0, Math.min(1, partial.ratio ?? 0)),
      fps: partial.fps ?? 0,
      etaSeconds: partial.etaSeconds ?? null,
      bytesWritten: partial.bytesWritten ?? 0,
      preview: partial.preview ?? null,
      message: partial.message ?? '',
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(progress);
      } catch (error) {
        console.warn('Listener de progreso de exportación', error);
      }
    }
  }
}
