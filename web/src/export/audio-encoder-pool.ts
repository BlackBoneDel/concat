// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the WebCodecs audio encoder of an export — AAC-LC (`mp4a.40.2`)
 * for MP4, Opus for WebM. The mix arrives as float planes; each block
 * becomes an `f32-planar` `AudioData` that is encoded and closed at once.
 * Chunks are copied into owned bytes for the muxer, and
 * `decoderConfig.description` (AudioSpecificConfig / OpusHead) is kept.
 *
 * Desktop equivalent: the AAC stage of `src/crates/concat-export/src/lib.rs`
 * (`audio_pieces` mixed and encoded by FFmpeg).
 */

import { copyBytes } from './video-encoder-pool.ts';
import { ExportError, toExportError, type EncodedPacket, type ExportAudioCodec } from './types.ts';

/** One block of planar audio. */
export interface PlanarBlock {
  format: 'f32-planar';
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  /** Microseconds. */
  timestamp: number;
  /** Planes back to back (channel 0, then 1, …). */
  data: Float32Array<ArrayBuffer>;
}

/** What the pool needs from an `AudioEncoder`. */
export interface AudioEncoderLike {
  readonly encodeQueueSize: number;
  configure(config: AudioEncoderConfig): void;
  encodeBlock(block: PlanarBlock): void;
  flush(): Promise<void>;
  close(): void;
}

/** Callbacks a factory wires in. */
export interface AudioEncoderCallbacks {
  output(packet: EncodedPacket, description: Uint8Array<ArrayBuffer> | null): void;
  error(error: Error): void;
}

/** Creates an encoder. */
export type AudioEncoderFactory = (callbacks: AudioEncoderCallbacks) => AudioEncoderLike;

/** Asks whether a configuration is supported. */
export type AudioSupportProbe = (config: AudioEncoderConfig) => Promise<boolean>;

/** Options of {@link AudioEncoderPool}. */
export interface AudioEncoderPoolOptions {
  codec: Exclude<ExportAudioCodec, 'none'>;
  sampleRate: number;
  channels: number;
  bitrate: number;
  onPacket: (packet: EncodedPacket) => void;
  createEncoder?: AudioEncoderFactory;
  isConfigSupported?: AudioSupportProbe;
  signal?: AbortSignal;
}

/**
 * The WebCodecs codec string of a choice.
 * @param codec `aac` or `opus`.
 * @returns `mp4a.40.2` or `opus`.
 */
export function audioCodecString(codec: Exclude<ExportAudioCodec, 'none'>): string {
  return codec === 'aac' ? 'mp4a.40.2' : 'opus';
}

/**
 * The browser `AudioEncoder`, wrapped.
 * @param callbacks output and error sinks.
 * @returns the encoder.
 */
export function browserAudioEncoder(callbacks: AudioEncoderCallbacks): AudioEncoderLike {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    throw new ExportError('ENCODER_UNSUPPORTED', 'Este navegador no ofrece WebCodecs (AudioEncoder).');
  }
  const encoder = new AudioEncoder({
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
    encodeBlock(block): void {
      const audio = new AudioData(block);
      try {
        encoder.encode(audio);
      } finally {
        audio.close();
      }
    },
    flush: () => encoder.flush(),
    close(): void {
      if (encoder.state !== 'closed') encoder.close();
    },
  };
}

/**
 * The browser support check.
 * @param config the configuration.
 * @returns whether it is supported.
 */
export async function browserAudioSupport(config: AudioEncoderConfig): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    return (await AudioEncoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

/** One export's audio encoder. */
export class AudioEncoderPool {
  private readonly options: AudioEncoderPoolOptions;
  private encoder: AudioEncoderLike | null = null;
  private failure: Error | null = null;
  /** The codec description once reported. */
  description: Uint8Array<ArrayBuffer> | null = null;
  /** Sample frames handed to the encoder. */
  framesIn = 0;

  /**
   * @param options codec, format, sink and factories.
   */
  constructor(options: AudioEncoderPoolOptions) {
    this.options = options;
  }

  /** The WebCodecs codec string. */
  get codec(): string {
    return audioCodecString(this.options.codec);
  }

  /**
   * The encoder configuration. AAC's WebCodecs default bitstream format is
   * raw `aac` (description = AudioSpecificConfig), what the MP4 `esds` needs.
   * @returns the config.
   */
  buildConfig(): AudioEncoderConfig {
    return {
      codec: this.codec,
      sampleRate: this.options.sampleRate,
      numberOfChannels: this.options.channels,
      bitrate: this.options.bitrate,
    };
  }

  /**
   * Checks support and creates the encoder.
   * @throws ExportError `ENCODER_UNSUPPORTED`.
   */
  async open(): Promise<void> {
    const config = this.buildConfig();
    const supported = await (this.options.isConfigSupported ?? browserAudioSupport)(config);
    if (!supported) {
      throw new ExportError(
        'ENCODER_UNSUPPORTED',
        `El navegador no puede codificar audio ${this.options.codec.toUpperCase()} a ${this.options.sampleRate} Hz. Prueba ${this.options.codec === 'aac' ? 'Opus (WebM)' : 'AAC (MP4)'} o exporta sin audio.`,
      );
    }
    const encoder = (this.options.createEncoder ?? browserAudioEncoder)({
      output: (packet, description) => {
        if (description) this.description = description;
        this.options.onPacket(packet);
      },
      error: (error) => {
        this.failure = error;
      },
    });
    try {
      encoder.configure(config);
    } catch (error) {
      encoder.close();
      throw new ExportError('ENCODER_UNSUPPORTED', `No se pudo configurar el audio: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    this.encoder = encoder;
  }

  /**
   * Encodes one block of planes.
   * @param planes one plane per channel, equal lengths.
   * @param timestamp microseconds.
   */
  async encodePlanar(planes: readonly Float32Array[], timestamp: number): Promise<void> {
    const encoder = this.encoder;
    if (!encoder) throw new ExportError('UNKNOWN', 'El codificador de audio no está abierto.');
    this.check();
    const frames = planes[0]?.length ?? 0;
    if (frames === 0) return;
    const channels = this.options.channels;
    const data = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c += 1) {
      const plane = planes[Math.min(c, planes.length - 1)];
      if (plane) data.set(plane.subarray(0, frames), c * frames);
    }
    while (encoder.encodeQueueSize > 8) {
      this.check();
      await new Promise<void>((resolve) => setTimeout(resolve, 4));
    }
    try {
      encoder.encodeBlock({ format: 'f32-planar', sampleRate: this.options.sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp, data });
    } catch (error) {
      throw toExportError(error);
    }
    this.framesIn += frames;
  }

  /** Emits pending chunks. */
  async flush(): Promise<void> {
    if (!this.encoder) return;
    try {
      await this.encoder.flush();
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
      // Already closed.
    }
    this.encoder = null;
  }

  private check(): void {
    if (this.options.signal?.aborted) throw new ExportError('ABORTED');
    if (this.failure) throw toExportError(this.failure);
  }
}
