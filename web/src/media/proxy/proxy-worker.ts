// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The proxy pipeline that runs inside `workers/proxy-worker.ts`:
 *
 *   MP4Demuxer → VideoDecoder → OffscreenCanvas (scale) → VideoEncoder → MP4 mux
 *
 * Messages (via `workers/worker-client.ts`): request `generate` with
 * `{ sourceFile, config }`; replies `{ type: 'progress', value }` at most every
 * 500 ms, `{ type: 'complete', result: { blob, width, height, duration } }`,
 * or `{ type: 'error', message }`.
 *
 * Every WebCodecs object is reached through the injectable {@link ProxyEnv},
 * so the whole pipeline is testable with doubles and every decoder, encoder
 * and frame is closed on every path (success, error, cancel).
 *
 * The muxer ({@link muxMp4}) writes a progressive ISO-BMFF file (ISO/IEC
 * 14496-12) with one video track: `ftyp`, `mdat`, then `moov` with
 * `stts/ctts/stss/stsz/stsc/stco` — readable by browsers and by Concat's own
 * `MP4Demuxer`. Proxies are video-only: sound always comes from the original.
 */

import { MP4Demuxer, type DemuxTrack } from '../demuxer.ts';
import type { ProxyConfig } from './proxy-queue.ts';

// -- sizing ----------------------------------------------------------------

/**
 * The proxy size: fits inside the target box, keeps the exact source aspect
 * (to the nearest even pixel — encoders need even dimensions) and never
 * upscales.
 * @param sourceWidth source pixels.
 * @param sourceHeight source pixels.
 * @param target the bounding box.
 * @returns even width/height.
 */
export function computeProxySize(
  sourceWidth: number,
  sourceHeight: number,
  target: { width: number; height: number },
): { width: number; height: number } {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return { width: even(target.width), height: even(target.height) };
  const scale = Math.min(1, target.width / sourceWidth, target.height / sourceHeight);
  return {
    width: Math.max(2, even(sourceWidth * scale)),
    height: Math.max(2, even(sourceHeight * scale)),
  };
}

/** Nearest even integer. */
function even(value: number): number {
  return Math.round(value / 2) * 2;
}

/**
 * The WebCodecs codec string for a proxy config.
 * @param config the target.
 * @param width encoded width.
 * @param height encoded height.
 * @returns e.g. `avc1.42E01F`.
 */
export function encoderCodecString(config: ProxyConfig, width: number, height: number): string {
  const pixels = width * height;
  switch (config.codec) {
    case 'vp9':
      return pixels <= 518_400 ? 'vp09.00.21.08' : pixels <= 2_073_600 ? 'vp09.00.31.08' : 'vp09.00.41.08';
    case 'av1':
      return pixels <= 2_073_600 ? 'av01.0.04M.08' : 'av01.0.08M.08';
    case 'avc':
    default: {
      // Constrained Baseline; level 3.0 / 3.1 / 4.0 by frame size.
      const level = pixels <= 414_720 ? '1E' : pixels <= 921_600 ? '1F' : '28';
      return `avc1.42E0${level}`;
    }
  }
}

// -- MP4 muxing ------------------------------------------------------------

/** One encoded sample handed to the muxer. */
export interface MuxSample {
  data: Uint8Array;
  /** Presentation time, microseconds. */
  timestamp: number;
  /** Microseconds. */
  duration: number;
  key: boolean;
}

/** The single video track of a proxy. */
export interface MuxTrack {
  /** WebCodecs codec string (`avc1.*`, `vp09.*`, `av01.*`). */
  codec: string;
  /** Codec configuration record (`avcC` / `av1C` payload), if any. */
  description: Uint8Array | null;
  width: number;
  height: number;
  samples: MuxSample[];
}

/** Media timescale of muxed proxies (ticks per second). */
export const MUX_TIMESCALE = 90_000;

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff);
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value | 0);
  return out;
}

function fourcc(type: string): Uint8Array {
  return encoder.encode(type.slice(0, 4).padEnd(4, ' '));
}

function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const payload = concat(body);
  return concat([u32(payload.length + 8), fourcc(type), payload]);
}

function fullBox(type: string, version: number, flags: number, ...body: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u8(flags >>> 16), u8(flags >>> 8), u8(flags), ...body);
}

/** The 3×3 unity matrix of `mvhd`/`tkhd`. */
function unityMatrix(): Uint8Array {
  return concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
}

/** The codec configuration box of the sample entry. */
function codecConfigBox(track: MuxTrack): { entryType: string; config: Uint8Array } {
  const codec = track.codec;
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) {
    return { entryType: 'avc1', config: box('avcC', track.description ?? defaultAvcC(codec)) };
  }
  if (codec.startsWith('vp09')) {
    // vp09.PP.LL.DD → VPCodecConfigurationRecord (VP9 ISO-BMFF binding §2.2).
    const [, profile = '00', level = '31', depth = '08'] = codec.split('.');
    const bitDepth = Number(depth) || 8;
    return {
      entryType: 'vp09',
      config: fullBox(
        'vpcC',
        1,
        0,
        u8(Number(profile) || 0),
        u8(Number(level) || 31),
        u8((bitDepth << 4) | (1 << 1) | 0), // 4:2:0 colocated, limited range
        u8(1),
        u8(1),
        u8(1), // BT.709 primaries / transfer / matrix
        u16(0),
      ),
    };
  }
  if (codec.startsWith('av01')) {
    return { entryType: 'av01', config: box('av1C', track.description ?? defaultAv1C(codec)) };
  }
  throw new Error(`Códec no soportado por el muxer: ${codec}`);
}

/** A minimal `avcC` from the codec string (no SPS/PPS: decoders need the real one). */
function defaultAvcC(codec: string): Uint8Array {
  const hex = codec.split('.')[1] ?? '42E01F';
  const profile = Number.parseInt(hex.slice(0, 2), 16) || 0x42;
  const compat = Number.parseInt(hex.slice(2, 4), 16) || 0;
  const level = Number.parseInt(hex.slice(4, 6), 16) || 0x1f;
  return Uint8Array.of(1, profile, compat, level, 0xff, 0xe0, 0x00);
}

/** A minimal `av1C` (AV1 ISO-BMFF §2.3) from the codec string. */
function defaultAv1C(codec: string): Uint8Array {
  const [, profile = '0', levelTier = '04M', depth = '08'] = codec.split('.');
  const level = Number.parseInt(levelTier, 10) || 4;
  const highTier = levelTier.endsWith('H') ? 1 : 0;
  const highBitDepth = Number(depth) > 8 ? 1 : 0;
  return Uint8Array.of(0x81, ((Number(profile) & 0x7) << 5) | (level & 0x1f), (highTier << 7) | (highBitDepth << 6) | 0x0c, 0);
}

/** Run-length `(count, delta)` pairs. */
function runLengths(values: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last && last[1] === value) last[0] += 1;
    else out.push([1, value]);
  }
  return out;
}

/**
 * Writes one video track as a progressive MP4.
 * @param track codec, size and encoded samples in decode order.
 * @returns the file bytes.
 */
export function muxMp4(track: MuxTrack): Uint8Array {
  if (track.samples.length === 0) throw new Error('No hay muestras para multiplexar');
  const toTicks = (us: number): number => Math.round((us * MUX_TIMESCALE) / 1e6);

  // Decode times: the sorted presentation times, so cts - dts >= 0.
  const pts = track.samples.map((sample) => toTicks(sample.timestamp));
  const firstPts = Math.min(...pts);
  const sortedPts = [...pts].sort((a, b) => a - b);
  const dts = sortedPts.map((value) => value - firstPts);
  const lastDuration = Math.max(1, toTicks(track.samples[track.samples.length - 1]!.duration));
  const deltas = dts.map((value, index) => (index + 1 < dts.length ? dts[index + 1]! - value : lastDuration));
  const offsets = pts.map((value, index) => value - firstPts - dts[index]!);
  const totalTicks = dts[dts.length - 1]! + lastDuration;
  const durationMs = Math.round((totalTicks * 1000) / MUX_TIMESCALE);

  const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));
  const payload = concat(track.samples.map((sample) => sample.data));
  const mdatHeaderSize = 8;
  const chunkOffset = ftyp.length + mdatHeaderSize;
  const mdat = concat([u32(payload.length + mdatHeaderSize), fourcc('mdat'), payload]);

  const { entryType, config } = codecConfigBox(track);
  const sampleEntry = box(
    entryType,
    new Uint8Array(6),
    u16(1), // data reference index
    new Uint8Array(16),
    u16(track.width),
    u16(track.height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    new Uint8Array(32), // compressor name
    u16(0x0018),
    u16(0xffff),
    config,
  );

  const stsd = fullBox('stsd', 0, 0, u32(1), sampleEntry);
  const sttsRuns = runLengths(deltas);
  const stts = fullBox('stts', 0, 0, u32(sttsRuns.length), ...sttsRuns.flatMap(([count, delta]) => [u32(count), u32(delta)]));
  const needsCtts = offsets.some((offset) => offset !== 0);
  const cttsRuns = runLengths(offsets);
  const ctts = needsCtts
    ? fullBox('ctts', 0, 0, u32(cttsRuns.length), ...cttsRuns.flatMap(([count, offset]) => [u32(count), i32(offset)]))
    : new Uint8Array(0);
  const keyIndices = track.samples.flatMap((sample, index) => (sample.key ? [index + 1] : []));
  const stss = fullBox('stss', 0, 0, u32(keyIndices.length), ...keyIndices.map((index) => u32(index)));
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(track.samples.length), u32(1));
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(track.samples.length), ...track.samples.map((sample) => u32(sample.data.length)));
  const stco = fullBox('stco', 0, 0, u32(1), u32(chunkOffset));
  const stbl = box('stbl', stsd, stts, ctts, stss, stsc, stsz, stco);

  const vmhd = fullBox('vmhd', 0, 1, new Uint8Array(8));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const minf = box('minf', vmhd, dinf, stbl);
  const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), new Uint8Array(12), encoder.encode('Concat proxy\0'));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(MUX_TIMESCALE), u32(totalTicks), u16(0x55c4), u16(0));
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = fullBox(
    'tkhd',
    0,
    3,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(durationMs),
    new Uint8Array(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    unityMatrix(),
    u32(track.width << 16),
    u32(track.height << 16),
  );
  const trak = box('trak', tkhd, mdia);
  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(1000),
    u32(durationMs),
    u32(0x00010000),
    u16(0x0100),
    new Uint8Array(10),
    unityMatrix(),
    new Uint8Array(24),
    u32(2),
  );
  const moov = box('moov', mvhd, trak);
  return concat([ftyp, mdat, moov]);
}

// -- the pipeline -----------------------------------------------------------

/** Structural `VideoFrame`. */
export interface FrameLike {
  readonly timestamp: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

/** Structural `EncodedVideoChunk`. */
export interface EncodedChunkLike {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  copyTo(destination: Uint8Array): void;
}

/** Structural `VideoDecoder`. */
export interface DecoderLike {
  readonly decodeQueueSize: number;
  configure(config: { codec: string; description?: Uint8Array; optimizeForLatency?: boolean }): void;
  decode(chunk: { type: 'key' | 'delta'; timestamp: number; duration: number; data: Uint8Array }): void;
  flush(): Promise<void>;
  close(): void;
}

/** Structural `VideoEncoder`. */
export interface EncoderLike {
  readonly encodeQueueSize: number;
  configure(config: {
    codec: string;
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
    avc?: { format: 'avc' };
    latencyMode?: 'quality' | 'realtime';
  }): void;
  encode(frame: FrameLike, options: { keyFrame: boolean }): void;
  flush(): Promise<void>;
  close(): void;
}

/** Structural 2D context of the scaling canvas. */
export interface ScaleContextLike {
  drawImage(image: FrameLike, dx: number, dy: number, dw: number, dh: number): void;
}

/** Everything the pipeline needs from the platform. */
export interface ProxyEnv {
  createDecoder(output: (frame: FrameLike) => void, error: (error: Error) => void): DecoderLike;
  createEncoder(
    output: (chunk: EncodedChunkLike, description: Uint8Array | null) => void,
    error: (error: Error) => void,
  ): EncoderLike;
  /** Is this encoder config supported? */
  isEncoderSupported(config: { codec: string; width: number; height: number; bitrate: number; framerate: number }): Promise<boolean>;
  /** A canvas of the target size, its context, and a frame factory over it. */
  createScaler(width: number, height: number): { context: ScaleContextLike; snapshot(timestamp: number, duration: number): FrameLike };
  now(): number;
}

/** Result of a proxy job. */
export interface ProxyJobResult {
  blob: Blob;
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  codec: string;
}

/** Error code when the container cannot be demuxed in the worker. */
export const UNSUPPORTED_SOURCE = 'unsupported-source';
/** Error code when the encoder config is not supported. */
export const UNSUPPORTED_ENCODER = 'unsupported-encoder';

/** Progress interval (ms). */
const PROGRESS_MS = 500;

/** Waits until a codec queue drains below `limit`. */
async function drain(queue: () => number, limit: number): Promise<void> {
  while (queue() > limit) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs one proxy job end to end.
 * @param source the original file.
 * @param config the target.
 * @param env platform objects.
 * @param onProgress progress 0..1, at most every 500 ms.
 * @param isCancelled polled between samples.
 * @returns the muxed proxy.
 */
export async function runProxyJob(
  source: Blob,
  config: ProxyConfig,
  env: ProxyEnv,
  onProgress: (value: number) => void = () => undefined,
  isCancelled: () => boolean = () => false,
): Promise<ProxyJobResult> {
  const demuxer = MP4Demuxer.open(await source.arrayBuffer());
  const track: DemuxTrack | undefined = demuxer?.tracks.find((candidate) => candidate.kind === 'video');
  if (!demuxer || !track || track.description === null) throw new Error(UNSUPPORTED_SOURCE);

  const size = computeProxySize(track.width, track.height, config.resolution);
  const codec = encoderCodecString(config, size.width, size.height);
  const encoderConfig = {
    codec,
    width: size.width,
    height: size.height,
    bitrate: config.bitrate,
    framerate: config.fps,
  };
  if (!(await env.isEncoderSupported(encoderConfig))) throw new Error(UNSUPPORTED_ENCODER);

  const samples: MuxSample[] = [];
  let description: Uint8Array | null = null;
  let failure: Error | null = null;
  const pendingFrames: FrameLike[] = [];

  const encoderInstance = env.createEncoder(
    (chunk, chunkDescription) => {
      if (chunkDescription && !description) description = chunkDescription;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? Math.round(1e6 / config.fps),
        key: chunk.type === 'key',
      });
    },
    (error) => {
      failure = error;
    },
  );
  const decoderInstance = env.createDecoder(
    (frame) => pendingFrames.push(frame),
    (error) => {
      failure = error;
    },
  );
  const scaler = env.createScaler(size.width, size.height);
  const frameStep = 1e6 / config.fps;
  const keyEvery = Math.max(1, Math.round(config.fps * 2));
  let nextOutput = 0;
  let encoded = 0;

  const encodePending = (): void => {
    for (const frame of pendingFrames.splice(0)) {
      try {
        if (frame.timestamp + 1 >= nextOutput) {
          scaler.context.drawImage(frame, 0, 0, size.width, size.height);
          const scaled = scaler.snapshot(Math.round(nextOutput), Math.round(frameStep));
          try {
            encoderInstance.encode(scaled, { keyFrame: encoded % keyEvery === 0 });
          } finally {
            scaled.close();
          }
          encoded += 1;
          nextOutput += frameStep;
          // A source slower than the target repeats nothing: catch up.
          while (nextOutput + frameStep <= frame.timestamp) nextOutput += frameStep;
        }
      } finally {
        frame.close();
      }
    }
  };

  try {
    encoderInstance.configure({
      ...encoderConfig,
      latencyMode: 'quality',
      ...(config.codec === 'avc' ? { avc: { format: 'avc' as const } } : {}),
    });
    decoderInstance.configure({ codec: track.codec, description: track.description, optimizeForLatency: false });
    let lastReport = env.now();
    const total = track.samples.length;
    for (let index = 0; index < total; index += 1) {
      if (isCancelled()) throw new Error('Generación de proxy cancelada');
      if (failure) throw failure;
      const sample = track.samples[index]!;
      decoderInstance.decode({
        type: sample.key ? 'key' : 'delta',
        timestamp: Math.round(sample.cts * 1e6),
        duration: Math.round(sample.duration * 1e6),
        data: demuxer.sampleBytes(track, index),
      });
      encodePending();
      await drain(() => decoderInstance.decodeQueueSize, 16);
      await drain(() => encoderInstance.encodeQueueSize, 16);
      const now = env.now();
      if (now - lastReport >= PROGRESS_MS) {
        lastReport = now;
        onProgress((index + 1) / total);
      }
    }
    await decoderInstance.flush();
    encodePending();
    await encoderInstance.flush();
    if (failure) throw failure;
    onProgress(1);
  } finally {
    for (const frame of pendingFrames.splice(0)) frame.close();
    safeClose(decoderInstance);
    safeClose(encoderInstance);
  }

  if (samples.length === 0) throw new Error('El codificador no produjo muestras');
  const bytes = muxMp4({ codec, description, width: size.width, height: size.height, samples });
  const blobPart = new Uint8Array(bytes.length);
  blobPart.set(bytes);
  return {
    blob: new Blob([blobPart.buffer], { type: 'video/mp4' }),
    width: size.width,
    height: size.height,
    duration: track.duration,
    codec,
  };
}

/** Closes a codec, ignoring "already closed". */
function safeClose(codec: { close(): void }): void {
  try {
    codec.close();
  } catch {
    // Already closed.
  }
}

/**
 * The real WebCodecs environment (worker or window), or `null` when the
 * platform lacks `VideoEncoder`/`VideoDecoder`/`OffscreenCanvas`.
 * @returns the env.
 */
export function browserProxyEnv(): ProxyEnv | null {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }
  return {
    createDecoder: (output, error) => {
      const decoder = new VideoDecoder({
        output: (frame) => output(frame),
        error: (event) => error(new Error(event.message)),
      });
      return {
        get decodeQueueSize() {
          return decoder.decodeQueueSize;
        },
        configure: (config) => decoder.configure(config),
        decode: (chunk) => decoder.decode(new EncodedVideoChunk(chunk)),
        flush: () => decoder.flush(),
        close: () => decoder.close(),
      };
    },
    createEncoder: (output, error) => {
      const videoEncoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const raw = metadata?.decoderConfig?.description;
          let description: Uint8Array | null = null;
          if (raw instanceof ArrayBuffer) description = new Uint8Array(raw.slice(0));
          else if (raw && ArrayBuffer.isView(raw)) {
            description = new Uint8Array(raw.byteLength);
            description.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
          }
          output(chunk, description);
        },
        error: (event) => error(new Error(event.message)),
      });
      return {
        get encodeQueueSize() {
          return videoEncoder.encodeQueueSize;
        },
        configure: (config) => videoEncoder.configure(config),
        encode: (frame, options) => {
          if (frame instanceof VideoFrame) videoEncoder.encode(frame, options);
        },
        flush: () => videoEncoder.flush(),
        close: () => videoEncoder.close(),
      };
    },
    isEncoderSupported: async (config) => {
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        return support.supported === true;
      } catch {
        return false;
      }
    },
    createScaler: (width, height) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('OffscreenCanvas 2D no disponible');
      return {
        context: {
          drawImage: (image, dx, dy, dw, dh) => {
            if (image instanceof VideoFrame) context.drawImage(image, dx, dy, dw, dh);
          },
        },
        snapshot: (timestamp, duration) => new VideoFrame(canvas, { timestamp, duration }),
      };
    },
    now: () => Date.now(),
  };
}
