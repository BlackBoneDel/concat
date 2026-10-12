// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the WebCodecs video encoder of an export. It picks the first codec
 * string the browser accepts (`VideoEncoder.isConfigSupported` before
 * anything is created), sized to the H.264/VP9/AV1 level the frame needs;
 * keeps the encoder queue short (back-pressure: `encode` waits while more
 * than `maxQueue` frames are pending, so frames never pile up in GPU
 * memory); copies every chunk into owned bytes for the muxer; and captures
 * `decoderConfig.description` (avcC / av1C).
 *
 * The desktop equivalent is the x264/x265 pipe of
 * `src/crates/concat-export/src/lib.rs` (`ExportRequest::codec`, `preset`,
 * `bitrate_kbps`); WebCodecs is bitrate-driven with `latencyMode: 'quality'`.
 */

import type { ExportFrameLike } from './offline-renderer.ts';
import { ExportError, frameRateOf, toExportError, type EncodedPacket, type ExportConfig, type ExportVideoCodec } from './types.ts';

/** What the pool needs from a `VideoEncoder` (tests pass doubles). */
export interface VideoEncoderLike {
  readonly encodeQueueSize: number;
  configure(config: VideoEncoderConfig): void;
  encode(frame: ExportFrameLike, options: { keyFrame: boolean }): void;
  flush(): Promise<void>;
  close(): void;
  /** Subscribes to queue drains (the `dequeue` event), when supported. */
  onDequeue?(listener: () => void): void;
}

/** Callbacks a factory wires into the encoder. */
export interface VideoEncoderCallbacks {
  output(packet: EncodedPacket, description: Uint8Array<ArrayBuffer> | null): void;
  error(error: Error): void;
}

/** Creates an encoder. */
export type VideoEncoderFactory = (callbacks: VideoEncoderCallbacks) => VideoEncoderLike;

/** Asks whether a configuration is supported. */
export type VideoSupportProbe = (config: VideoEncoderConfig) => Promise<boolean>;

/** The chosen configuration. */
export interface VideoEncoderSelection {
  codec: string;
  config: VideoEncoderConfig;
}

/** Options of {@link VideoEncoderPool}. */
export interface VideoEncoderPoolOptions {
  createEncoder?: VideoEncoderFactory;
  isConfigSupported?: VideoSupportProbe;
  /** Frames allowed in the encoder queue before `encode` waits (4). */
  maxQueue?: number;
  onPacket: (packet: EncodedPacket) => void;
  signal?: AbortSignal;
}

/**
 * Copies any buffer source into an owned `Uint8Array`.
 * @param source an ArrayBuffer, SharedArrayBuffer or view.
 * @returns a fresh copy.
 */
export function copyBytes(source: AllowSharedBufferSource): Uint8Array<ArrayBuffer> {
  const view = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

/** H.264 levels: `[level_idc, max frame macroblocks, max macroblocks/s]`. */
const H264_LEVELS: readonly [number, number, number][] = [
  [0x1e, 1620, 40500],
  [0x1f, 3600, 108000],
  [0x20, 5120, 216000],
  [0x28, 8192, 245760],
  [0x2a, 8704, 522240],
  [0x32, 22080, 589824],
  [0x33, 36864, 983040],
  [0x34, 36864, 2073600],
  [0x3c, 139264, 4177920],
];

/**
 * The smallest H.264 level for a frame size and rate.
 * @param width pixels.
 * @param height pixels.
 * @param fps frames per second.
 * @returns `level_idc` as two hex digits.
 */
export function h264Level(width: number, height: number, fps: number): string {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = frame * fps;
  const level = H264_LEVELS.find(([, maxFrame, maxRate]) => frame <= maxFrame && rate <= maxRate) ?? H264_LEVELS[H264_LEVELS.length - 1];
  return (level?.[0] ?? 0x34).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * The AV1 `seq_level_idx` for a frame size and rate.
 * @param width pixels.
 * @param height pixels.
 * @param fps frames per second.
 * @returns two decimal digits.
 */
export function av1Level(width: number, height: number, fps: number): string {
  const pixels = width * height;
  const rate = pixels * fps;
  const levels: [number, number, number][] = [
    [4, 665_856, 24_969_600],
    [5, 1_065_024, 39_938_400],
    [8, 2_359_296, 77_856_768],
    [9, 2_359_296, 155_713_536],
    [12, 8_912_896, 273_715_200],
    [13, 8_912_896, 547_430_400],
    [14, 8_912_896, 1_094_860_800],
  ];
  const level = levels.find(([, maxPixels, maxRate]) => pixels <= maxPixels && rate <= maxRate) ?? levels[levels.length - 1];
  return String(level?.[0] ?? 13).padStart(2, '0');
}

/**
 * The VP9 level for a frame size and rate.
 * @param width pixels.
 * @param height pixels.
 * @param fps frames per second.
 * @returns two decimal digits (`10` = level 1.0).
 */
export function vp9Level(width: number, height: number, fps: number): string {
  const pixels = width * height;
  const rate = pixels * fps;
  const levels: [string, number, number][] = [
    ['10', 36_864, 829_440],
    ['20', 122_880, 4_608_000],
    ['21', 245_760, 9_216_000],
    ['30', 552_960, 20_736_000],
    ['31', 983_040, 36_864_000],
    ['40', 2_228_224, 83_558_400],
    ['41', 2_228_224, 160_432_128],
    ['50', 8_912_896, 311_951_360],
    ['51', 8_912_896, 588_251_136],
    ['52', 8_912_896, 1_176_502_272],
  ];
  const level = levels.find(([, maxPixels, maxRate]) => pixels <= maxPixels && rate <= maxRate) ?? levels[levels.length - 1];
  return level?.[0] ?? '51';
}

/**
 * Codec strings to try, best first. The reference strings
 * (`avc1.42E01E`, `avc1.640028`, `vp09.00.10.08`, `av01.0.04M.08`) lead
 * when the frame fits their level; the level-sized variant follows.
 * @param codec the codec choice.
 * @param width pixels.
 * @param height pixels.
 * @param fps frames per second.
 * @returns unique codec strings.
 */
export function videoCodecCandidates(codec: ExportVideoCodec, width: number, height: number, fps: number): string[] {
  const out: string[] = [];
  const level = h264Level(width, height, fps);
  const fits = (reference: string): boolean => Number.parseInt(reference, 16) >= Number.parseInt(level, 16);
  switch (codec) {
    case 'h264-baseline':
      if (fits('1E')) out.push('avc1.42E01E');
      out.push(`avc1.42E0${level}`, `avc1.4D40${level}`);
      break;
    case 'h264-high':
      if (fits('28')) out.push('avc1.640028');
      out.push(`avc1.6400${level}`, `avc1.4D40${level}`, `avc1.42E0${level}`);
      break;
    case 'vp9':
      out.push('vp09.00.10.08', `vp09.00.${vp9Level(width, height, fps)}.08`);
      break;
    case 'av1': {
      const av1 = av1Level(width, height, fps);
      if (Number(av1) <= 4) out.push('av01.0.04M.08');
      out.push(`av01.0.${av1}M.08`);
      break;
    }
  }
  return [...new Set(out)];
}

/**
 * The browser `VideoEncoder`, wrapped.
 * @param callbacks output and error sinks.
 * @returns the encoder.
 * @throws ExportError `ENCODER_UNSUPPORTED` without WebCodecs.
 */
export function browserVideoEncoder(callbacks: VideoEncoderCallbacks): VideoEncoderLike {
  if (typeof VideoEncoder === 'undefined') throw new ExportError('ENCODER_UNSUPPORTED', webCodecsHint());
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const description = metadata?.decoderConfig?.description;
      callbacks.output(
        { data, timestamp: chunk.timestamp, duration: chunk.duration ?? 0, keyFrame: chunk.type === 'key' },
        description ? copyBytes(description) : null,
      );
    },
    error: (error) => callbacks.error(error),
  });
  return {
    get encodeQueueSize(): number {
      return encoder.encodeQueueSize;
    },
    configure: (config) => encoder.configure(config),
    encode(frame, options): void {
      if (!(frame instanceof VideoFrame)) throw new ExportError('ENCODER_UNSUPPORTED', 'El codificador necesita un VideoFrame.');
      encoder.encode(frame, options);
    },
    flush: () => encoder.flush(),
    close(): void {
      if (encoder.state !== 'closed') encoder.close();
    },
    onDequeue(listener): void {
      encoder.addEventListener('dequeue', listener);
    },
  };
}

/**
 * The browser's support check (false without WebCodecs or on rejection).
 * @param config the configuration.
 * @returns whether it is supported.
 */
export async function browserVideoSupport(config: VideoEncoderConfig): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const result = await VideoEncoder.isConfigSupported(config);
    return result.supported === true;
  } catch {
    return false;
  }
}

/**
 * The message shown when WebCodecs is missing.
 * @returns a user-facing hint.
 */
export function webCodecsHint(): string {
  return 'Este navegador no ofrece WebCodecs (VideoEncoder). Usa Chrome/Edge 113+ para exportar MP4/WebM por hardware, o el modo compatible con FFmpeg (más lento).';
}

/** One export's video encoder. */
export class VideoEncoderPool {
  private readonly config: ExportConfig;
  private readonly options: VideoEncoderPoolOptions;
  private readonly maxQueue: number;
  private encoder: VideoEncoderLike | null = null;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private selected: VideoEncoderSelection | null = null;
  /** `decoderConfig.description` once the encoder reported it. */
  description: Uint8Array<ArrayBuffer> | null = null;
  /** Frames handed to the encoder. */
  framesIn = 0;
  /** Chunks received. */
  packetsOut = 0;

  /**
   * @param config the export configuration.
   * @param options packet sink, factories and signal.
   */
  constructor(config: ExportConfig, options: VideoEncoderPoolOptions) {
    // Fase 7 hook (QA): defence in depth — a 0×0 frame or a 0/x, x/0 rate
    // must never reach `VideoEncoder.configure` (division by zero in the
    // level tables, a native-side exception or a hung encoder).
    if (!(config.width >= 2 && config.height >= 2) || frameRateOf(config.frameRate) === null) {
      throw new ExportError('INVALID_RANGE', 'Tamaño o frecuencia de fotogramas inválidos para el codificador.');
    }
    this.config = config;
    this.options = options;
    this.maxQueue = Math.max(1, options.maxQueue ?? 4);
  }

  /** The chosen codec (after {@link open}). */
  get selection(): VideoEncoderSelection | null {
    return this.selected;
  }

  /**
   * The encoder configuration for a codec string.
   * @param codec the codec string.
   * @param hardware the acceleration preference.
   * @returns the WebCodecs config.
   */
  buildConfig(codec: string, hardware: HardwareAcceleration): VideoEncoderConfig {
    const { width, height, videoBitrate, frameRate } = this.config;
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: videoBitrate,
      framerate: frameRate.num / frameRate.den,
      latencyMode: 'quality',
      bitrateMode: 'variable',
      hardwareAcceleration: hardware,
      alpha: 'discard',
    };
    if (codec.startsWith('avc1')) config.avc = { format: 'avc' };
    return config;
  }

  /**
   * Finds a supported configuration and creates the encoder.
   * @returns the selection.
   * @throws ExportError `ENCODER_UNSUPPORTED` when nothing is supported.
   */
  async open(): Promise<VideoEncoderSelection> {
    const probe = this.options.isConfigSupported ?? browserVideoSupport;
    const fps = this.config.frameRate.num / this.config.frameRate.den;
    const candidates = videoCodecCandidates(this.config.videoCodec, this.config.width, this.config.height, fps);
    const preferences: HardwareAcceleration[] = [this.config.hardwareAcceleration];
    if (this.config.hardwareAcceleration !== 'no-preference') preferences.push('no-preference');
    for (const codec of candidates) {
      for (const hardware of preferences) {
        if (this.options.signal?.aborted) throw new ExportError('ABORTED');
        const config = this.buildConfig(codec, hardware);
        if (!(await probe(config))) continue;
        const encoder = (this.options.createEncoder ?? browserVideoEncoder)({
          output: (packet, description) => {
            if (description) this.description = description;
            this.packetsOut += 1;
            this.options.onPacket(packet);
            this.notify();
          },
          error: (error) => {
            this.failure = error;
            this.notify();
          },
        });
        try {
          encoder.configure(config);
        } catch (error) {
          encoder.close();
          throw new ExportError('ENCODER_UNSUPPORTED', `No se pudo configurar ${codec}: ${error instanceof Error ? error.message : String(error)}`, error);
        }
        encoder.onDequeue?.(() => this.notify());
        this.encoder = encoder;
        this.selected = { codec, config };
        return this.selected;
      }
    }
    const what = this.config.videoCodec.toUpperCase();
    throw new ExportError(
      'ENCODER_UNSUPPORTED',
      typeof VideoEncoder === 'undefined' && !this.options.isConfigSupported
        ? webCodecsHint()
        : `El navegador no puede codificar ${what} a ${this.config.width}×${this.config.height}. Prueba otro códec, una resolución menor o el modo FFmpeg.`,
    );
  }

  /**
   * Encodes one frame, waiting first while the queue is full. The caller
   * keeps ownership of the frame (close it after this resolves).
   * @param frame the frame.
   * @param keyFrame force a keyframe.
   */
  async encode(frame: ExportFrameLike, keyFrame: boolean): Promise<void> {
    const encoder = this.requireEncoder();
    while (encoder.encodeQueueSize > this.maxQueue) {
      this.check();
      await this.waitForProgress();
    }
    this.check();
    try {
      encoder.encode(frame, { keyFrame });
    } catch (error) {
      throw toExportError(error);
    }
    this.framesIn += 1;
  }

  /** Emits every pending chunk. */
  async flush(): Promise<void> {
    const encoder = this.requireEncoder();
    try {
      await encoder.flush();
    } catch (error) {
      throw toExportError(this.failure ?? error);
    }
    this.check();
  }

  /** Closes the encoder. Idempotent. */
  close(): void {
    try {
      this.encoder?.close();
    } catch {
      // Already closed by an error.
    }
    this.encoder = null;
    this.notify();
  }

  private requireEncoder(): VideoEncoderLike {
    if (!this.encoder) throw new ExportError('UNKNOWN', 'El codificador de vídeo no está abierto.');
    return this.encoder;
  }

  private check(): void {
    if (this.options.signal?.aborted) throw new ExportError('ABORTED');
    if (this.failure) throw toExportError(this.failure);
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private waitForProgress(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, 20);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
