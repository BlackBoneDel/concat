// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the export path for browsers without WebCodecs encoders (older
 * Firefox/Safari). Rendered frames are JPEG-encoded into a single MJPEG
 * stream (sealed `Blob` batches, never one big array), the mix becomes a
 * 16-bit WAV, and the local FFmpeg.wasm core of Fase 4 (worker, vendored,
 * no network) encodes H.264/AAC MP4 or VP9/Opus WebM. Slower than
 * WebCodecs, but it is the same render.
 *
 * This is literally the desktop pipeline: `src/crates/concat-export/src/
 * lib.rs` pipes raw frames into an `ffmpeg` process with libx264.
 */

import { PacketStore } from './packet-store.ts';
import { ExportError, type ExportConfig } from './types.ts';

/** What the fallback needs from FFmpeg (`FFmpegFallback` satisfies it). */
export interface FFmpegExecutor {
  execute(
    args: string[],
    inputs: { name: string; data: Blob }[],
    outputs: string[],
  ): Promise<{ ret: number; logs: string[]; files: Record<string, Uint8Array> }>;
  terminate(): void;
  onProgress: ((value: number) => void) | null;
}

const FRAMES_NAME = 'frames.mjpeg';
const AUDIO_NAME = 'audio.wav';

/**
 * The ffmpeg arguments of a fallback export.
 * @param config the export configuration.
 * @param hasAudio whether a WAV input is present.
 * @returns argv and the output name.
 */
export function buildFallbackArgs(config: ExportConfig, hasAudio: boolean): { args: string[]; output: string } {
  if (config.format === 'gif') throw new ExportError('ENCODER_UNSUPPORTED', 'El GIF no usa FFmpeg.');
  const output = `out.${config.format}`;
  const rate = `${config.frameRate.num}/${config.frameRate.den}`;
  const fps = config.frameRate.num / config.frameRate.den;
  const gop = Math.max(1, Math.round(config.keyframeInterval * fps));
  const kbps = Math.round(config.videoBitrate / 1000);
  const args = ['-nostdin', '-y', '-f', 'image2pipe', '-framerate', rate, '-c:v', 'mjpeg', '-i', `/input/${FRAMES_NAME}`];
  if (hasAudio) args.push('-i', `/input/${AUDIO_NAME}`);
  args.push('-map', '0:v:0');
  if (hasAudio) args.push('-map', '1:a:0');
  args.push('-r', rate, '-g', String(gop), '-pix_fmt', 'yuv420p');
  args.push('-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`);
  if (config.format === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast');
    args.push('-profile:v', config.videoCodec === 'h264-baseline' ? 'baseline' : 'high');
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', `${Math.round(config.audioBitrate / 1000)}k`);
    args.push('-movflags', '+faststart');
  } else {
    args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '0');
    if (hasAudio) args.push('-c:a', 'libopus', '-b:a', `${Math.round(config.audioBitrate / 1000)}k`);
  }
  // The WAV is already at the output rate and layout: no resampling filter.
  if (hasAudio) args.push('-shortest');
  args.push(`/output/${output}`);
  return { args, output };
}

/**
 * A 16-bit PCM WAV of float planes.
 * @param planes one plane per channel.
 * @param sampleRate Hz.
 * @returns the WAV file.
 */
export function encodeWav(planes: readonly Float32Array[], sampleRate: number): Blob {
  const channels = Math.max(1, planes.length);
  const frames = planes[0]?.length ?? 0;
  const bytes = frames * channels * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const sample = Math.max(-1, Math.min(1, planes[c]?.[i] ?? 0));
      view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Collects frames and audio, then encodes with FFmpeg.wasm. */
export class FFmpegMuxFallback {
  private readonly config: ExportConfig;
  private readonly executor: FFmpegExecutor;
  private readonly signal: AbortSignal | undefined;
  private readonly frames = new PacketStore();
  private readonly audioParts: Float32Array[][] = [];
  private frameCount = 0;
  private aborted = false;

  /**
   * @param config the export configuration.
   * @param executor the FFmpeg runner (Fase 4 `FFmpegFallback`).
   * @param signal abort signal (terminates the worker).
   */
  constructor(config: ExportConfig, executor: FFmpegExecutor, signal?: AbortSignal) {
    this.config = config;
    this.executor = executor;
    this.signal = signal;
    signal?.addEventListener('abort', () => this.abort(), { once: true });
  }

  /** JPEG bytes collected. */
  get bytesWritten(): number {
    return this.frames.size;
  }

  /** Frames collected. */
  get framesAdded(): number {
    return this.frameCount;
  }

  /**
   * Appends one JPEG frame.
   * @param jpeg the frame.
   */
  async addFrame(jpeg: Blob): Promise<void> {
    if (this.aborted) throw new ExportError('ABORTED');
    this.frames.append(new Uint8Array(await jpeg.arrayBuffer()));
    this.frameCount += 1;
  }

  /**
   * Appends a window of the mix.
   * @param planes one plane per channel.
   */
  addAudio(planes: Float32Array[]): void {
    if (this.aborted) throw new ExportError('ABORTED');
    this.audioParts.push(planes);
  }

  /**
   * Runs FFmpeg.
   * @param onProgress encode progress 0..1.
   * @returns the encoded file.
   */
  async finalize(onProgress?: (value: number) => void): Promise<Blob> {
    if (this.aborted) throw new ExportError('ABORTED');
    if (this.frameCount === 0) throw new ExportError('MUX_FAILED', 'No hay fotogramas que codificar.');
    const inputs = [{ name: FRAMES_NAME, data: this.frames.finish() }];
    const hasAudio = this.config.audioCodec !== 'none' && this.audioParts.length > 0;
    if (hasAudio) inputs.push({ name: AUDIO_NAME, data: encodeWav(joinPlanes(this.audioParts, this.config.channels), this.config.sampleRate) });
    const { args, output } = buildFallbackArgs(this.config, hasAudio);
    this.executor.onProgress = onProgress ?? null;
    let result: { ret: number; logs: string[]; files: Record<string, Uint8Array> };
    try {
      result = await this.executor.execute(args, inputs, [output]);
    } catch (error) {
      if (this.aborted || this.signal?.aborted) throw new ExportError('ABORTED');
      throw new ExportError('ENCODER_UNSUPPORTED', `FFmpeg no está disponible: ${error instanceof Error ? error.message : String(error)}`, error);
    } finally {
      this.executor.onProgress = null;
    }
    if (this.aborted) throw new ExportError('ABORTED');
    const bytes = result.files[output];
    if (result.ret !== 0 || !bytes || bytes.byteLength === 0) {
      const tail = result.logs.filter((line) => line.trim() !== '').slice(-3).join(' · ');
      throw new ExportError('MUX_FAILED', `FFmpeg falló (${result.ret}): ${tail || 'sin salida'}`);
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy], { type: this.config.format === 'mp4' ? 'video/mp4' : 'video/webm' });
  }

  /** Stops FFmpeg and drops everything. Idempotent. */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.frames.clear();
    this.audioParts.length = 0;
    this.executor.terminate();
  }
}

/** Concatenates windows into one plane per channel. */
function joinPlanes(parts: readonly Float32Array[][], channels: number): Float32Array[] {
  const length = parts.reduce((sum, planes) => sum + (planes[0]?.length ?? 0), 0);
  const out = Array.from({ length: channels }, () => new Float32Array(length));
  let offset = 0;
  for (const planes of parts) {
    const frames = planes[0]?.length ?? 0;
    for (let c = 0; c < channels; c += 1) {
      const plane = planes[Math.min(c, planes.length - 1)];
      if (plane) out[c]?.set(plane.subarray(0, frames), offset);
    }
    offset += frames;
  }
  return out;
}
