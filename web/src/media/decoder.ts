// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Local media decoding: WebCodecs first, media elements as the fallback.
 *
 * - Video: `VideoDecoder` fed from {@link MP4Demuxer} for H.264/HEVC in
 *   MP4/MOV; everything else (and every browser without WebCodecs) runs on a
 *   hidden `<video>` element the compositor draws live.
 * - Audio: `AudioDecoder` from the demuxed AAC track, falling back to
 *   `AudioContext.decodeAudioData` on the whole file.
 * - Images: `createImageBitmap`.
 *
 * Frames pass through an LRU cache so scrubbing over the same stretch is
 * instant; every `VideoFrame`/`ImageBitmap` the cache evicts is closed — the
 * whole module's memory contract.
 */

import { FrameRate } from '../core/time.ts';
import { Rational } from '../core/rational.ts';
import { intrinsicSize, type RenderImage } from '../render/types.ts';
import { MP4Demuxer, detectContainer, type ContainerKind, type DemuxTrack } from './demuxer.ts';

/** Everything a probe found out about a file. */
export interface MediaInfo {
  id: string;
  type: 'video' | 'audio' | 'image';
  duration: Rational;
  width: number;
  height: number;
  fps: FrameRate;
  videoCodec: string;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
  fileSize: number;
  container: ContainerKind;
}

/** How many frames the cache holds before the oldest are closed. */
const FRAME_CACHE_LIMIT = 30;

/** A cache entry: a decoded frame and when it was last used. */
interface CacheEntry {
  image: RenderImage;
  lastUsed: number;
}

/**
 * Decodes one local file. Construct with the file and its id, then
 * {@link MediaDecoder.init} once.
 */
export class MediaDecoder {
  readonly id: string;
  private readonly file: File | Blob;
  private info: MediaInfo | null = null;
  private demuxer: MP4Demuxer | null = null;
  private container: ContainerKind = 'unknown';
  private videoTrack: DemuxTrack | null = null;
  private audioTrack: DemuxTrack | null = null;
  private videoDecoder: VideoDecoder | null = null;
  private element: HTMLVideoElement | null = null;
  private elementUrl: string | null = null;
  private readonly frameCache = new Map<number, CacheEntry>();
  private audioBuffer: AudioBuffer | null | undefined;
  private closed = false;
  private serial: Promise<unknown> = Promise.resolve();

  /**
   * @param file the local file.
   * @param id the asset id this decoder serves.
   */
  constructor(file: File | Blob, id: string) {
    this.file = file;
    this.id = id;
  }

  /**
   * Detects the container and probes the tracks.
   * @returns the probed metadata.
   */
  async init(): Promise<MediaInfo> {
    if (this.info) return this.info;
    this.container = await detectContainer(this.file);
    const type = this.container === 'png' || this.container === 'jpeg' || this.container === 'webp' || this.container === 'gif'
      ? 'image'
      : this.container === 'wav' || this.container === 'mp3' || this.container === 'ogg' || this.container === 'flac'
        ? 'audio'
        : 'video';

    let width = 0;
    let height = 0;
    let fps = FrameRate.THIRTY;
    let durationSeconds = 0;
    let videoCodec = '';
    let audioCodec = '';
    let sampleRate = 0;
    let channels = 0;

    if (this.container === 'mp4' || this.container === 'mov') {
      const buffer = await this.file.arrayBuffer();
      this.demuxer = MP4Demuxer.open(buffer);
      if (this.demuxer) {
        this.videoTrack = this.demuxer.tracks.find((track) => track.kind === 'video') ?? null;
        this.audioTrack = this.demuxer.tracks.find((track) => track.kind === 'audio') ?? null;
        for (const track of this.demuxer.tracks) {
          durationSeconds = Math.max(durationSeconds, track.duration);
        }
        if (this.videoTrack) {
          width = this.videoTrack.width;
          height = this.videoTrack.height;
          videoCodec = this.videoTrack.codec;
          fps = rateOf(this.videoTrack);
        }
        if (this.audioTrack) {
          audioCodec = this.audioTrack.codec;
          sampleRate = this.audioTrack.sampleRate;
          channels = this.audioTrack.channels;
        }
      }
    }

    if (type === 'image') {
      const bitmap = await this.decodeStill();
      if (bitmap) {
        const size = intrinsicSize(bitmap);
        width = size.width;
        height = size.height;
        closeImage(bitmap);
      }
      durationSeconds = 0;
      fps = FrameRate.THIRTY;
    } else if (durationSeconds === 0) {
      // Probe duration through a media element (webm, wav, mp3, ...).
      const probe = await probeElement(this.file, type);
      width = probe.width || width;
      height = probe.height || height;
      durationSeconds = probe.duration || durationSeconds;
      fps = probe.fps ?? fps;
      if (probe.width > 0) width = probe.width;
      if (probe.height > 0) height = probe.height;
    }

    this.info = {
      id: this.id,
      type: type === 'image' ? 'image' : this.videoTrack || width > 0 ? 'video' : 'audio',
      duration: Rational.approximate(durationSeconds) ?? Rational.ZERO,
      width,
      height,
      fps,
      videoCodec,
      audioCodec,
      audioSampleRate: sampleRate,
      audioChannels: channels,
      fileSize: this.file.size,
      container: this.container,
    };
    return this.info;
  }

  /** The probed metadata; `init` first. */
  get mediaInfo(): MediaInfo | null {
    return this.info;
  }

  /**
   * The picture at `time`, or `null` when none could be produced yet.
   * WebCodecs frames are cached; the fallback path returns its live video
   * element, already seeked.
   * @param time seconds into the media.
   * @returns a drawable frame.
   */
  async getFrame(time: Rational): Promise<RenderImage | null> {
    if (this.closed) return null;
    await this.init();
    const info = this.info!;
    if (info.type === 'image') {
      return this.decodeStill();
    }
    if (info.type === 'audio') return null;
    return this.enqueue(async () => {
      const key = Math.round(time.asNumber() * 1e6);
      const cached = this.frameCache.get(key);
      if (cached) {
        cached.lastUsed = Date.now();
        return cached.image;
      }
      if (this.canUseWebCodecs()) {
        const frame = await this.decodeFrameWebCodecs(time.asNumber());
        if (frame) {
          this.putInCache(key, frame);
          return frame;
        }
        // A decode failure falls through to the element path.
      }
      return this.getFrameFromElement(time.asNumber());
    });
  }

  /**
   * Decodes every frame from `start` to `end` — filmstrips and thumbnails.
   * The caller owns the returned frames and must `close()` them.
   * @param start seconds into the media.
   * @param end seconds into the media.
   * @yields decoded frames in presentation order.
   */
  async *decodeRange(start: Rational, end: Rational): AsyncGenerator<RenderImage> {
    await this.init();
    const info = this.info!;
    if (info.type === 'image') {
      const still = await this.decodeStill();
      if (still) yield still;
      return;
    }
    if (!this.canUseWebCodecs()) {
      // Element path: step in 1/fps increments and draw.
      const fps = info.fps.fps().asNumber() || 30;
      const step = 1 / fps;
      for (let t = start.asNumber(); t < end.asNumber(); t += step) {
        const frame = await this.getFrameFromElement(t);
        if (frame) yield frame;
      }
      return;
    }
    const chunks = this.videoTrack!;
    const demuxer = this.demuxer!;
    const from = MP4Demuxer.sampleAt(chunks, start.asNumber());
    const to = MP4Demuxer.sampleAt(chunks, end.asNumber());
    const keyFrom = MP4Demuxer.keyframeBefore(chunks, from);
    const decoder = this.ensureVideoDecoder();
    if (!decoder) return;
    this.pending.length = 0;
    for (let i = keyFrom; i <= to && i < chunks.samples.length; i += 1) {
      decoder.decode(this.encodedChunk(chunks, i, demuxer));
    }
    await decoder.flush();
    const frames = [...this.pending];
    this.pending.length = 0;
    for (const frame of frames) {
      if (frame.timestamp / 1e6 >= start.asNumber() - 1e-6 && frame.timestamp / 1e6 < end.asNumber()) {
        yield frame;
      } else {
        frame.close();
      }
    }
  }

  /**
   * The whole audio track as an `AudioBuffer`, decoded once and kept.
   * @returns the mixed-down buffer, or `null` when the file has no sound.
   */
  async getAudioBuffer(): Promise<AudioBuffer | null> {
    if (this.closed) return null;
    await this.init();
    if (this.audioBuffer !== undefined) return this.audioBuffer;
    this.audioBuffer = null;
    try {
      if (this.audioTrack && typeof AudioDecoder !== 'undefined') {
        this.audioBuffer = await this.decodeAudioWebCodecs(this.audioTrack);
      }
      if (!this.audioBuffer && typeof AudioContext !== 'undefined') {
        const context = new AudioContext();
        try {
          const buffer = await context.decodeAudioData(await this.file.arrayBuffer());
          this.audioBuffer = buffer;
        } finally {
          void context.close();
        }
      }
    } catch {
      this.audioBuffer = null;
    }
    return this.audioBuffer;
  }

  /** Frees decoders, frames, and the fallback element. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.frameCache.values()) closeImage(entry.image);
    this.frameCache.clear();
    this.videoDecoder?.close();
    this.videoDecoder = null;
    if (this.element) {
      this.element.removeAttribute('src');
      this.element.load();
      this.element = null;
    }
    if (this.elementUrl) {
      URL.revokeObjectURL(this.elementUrl);
      this.elementUrl = null;
    }
    this.audioBuffer = undefined;
  }

  // -- internals -----------------------------------------------------------

  /** WebCodecs can serve this file when the demuxer found a video track. */
  private canUseWebCodecs(): boolean {
    return (
      this.videoTrack !== null &&
      this.demuxer !== null &&
      this.videoTrack.codec !== '' &&
      this.videoTrack.description !== null &&
      typeof VideoDecoder !== 'undefined'
    );
  }

  /** Runs `fn` alone: the decoder objects are single-threaded. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.serial.then(fn, fn);
    this.serial = run.catch(() => undefined);
    return run;
  }

  /** Creates (once) the `VideoDecoder` for the demuxed track. */
  private ensureVideoDecoder(): VideoDecoder | null {
    if (this.videoDecoder) return this.videoDecoder;
    const track = this.videoTrack;
    if (!track || typeof VideoDecoder === 'undefined') return null;
    try {
      const decoder = new VideoDecoder({
        output: (frame) => this.pending.push(frame),
        error: () => this.dropDecoder(),
      });
      decoder.configure({
        codec: track.codec,
        description: track.description ?? undefined,
        optimizeForLatency: true,
      });
      this.videoDecoder = decoder;
      return decoder;
    } catch {
      return null;
    }
  }

  /** Frames decoded since the last reset of the pipeline. */
  private pending: VideoFrame[] = [];

  /** Decodes forward from the keyframe before `time` and returns that frame. */
  private async decodeFrameWebCodecs(time: number): Promise<RenderImage | null> {
    const track = this.videoTrack;
    const demuxer = this.demuxer;
    const decoder = this.ensureVideoDecoder();
    if (!track || !demuxer || !decoder) return null;
    const target = MP4Demuxer.sampleAt(track, time);
    const from = MP4Demuxer.keyframeBefore(track, target);
    this.pending.length = 0;
    const end = Math.min(track.samples.length - 1, target + 2);
    for (let i = from; i <= end; i += 1) {
      decoder.decode(this.encodedChunk(track, i, demuxer));
    }
    await decoder.flush();
    const frames = [...this.pending];
    this.pending.length = 0;
    // Prefer the first frame at or after the target; else the last one
    // before it. Everything else is closed — the cache holds at most one.
    const atOrAfter = frames
      .filter((frame) => frame.timestamp / 1e6 >= time - 1e-3)
      .sort((a, b) => a.timestamp - b.timestamp);
    const before = frames
      .filter((frame) => frame.timestamp / 1e6 < time - 1e-3)
      .sort((a, b) => b.timestamp - a.timestamp);
    const chosen = atOrAfter[0] ?? before[0] ?? null;
    for (const frame of frames) {
      if (frame !== chosen) frame.close();
    }
    return chosen;
  }

  /** One sample as a coded chunk. */
  private encodedChunk(
    track: DemuxTrack,
    index: number,
    demuxer: MP4Demuxer,
  ): EncodedVideoChunk {
    const sample = track.samples[index]!;
    return new EncodedVideoChunk({
      type: sample.key ? 'key' : 'delta',
      timestamp: sample.cts * 1e6,
      duration: sample.duration * 1e6,
      data: demuxer.sampleBytes(track, index),
    });
  }

  /** Decodes the demuxed audio track through `AudioDecoder`. */
  private async decodeAudioWebCodecs(track: DemuxTrack): Promise<AudioBuffer | null> {
    const demuxer = this.demuxer;
    if (!demuxer || typeof AudioDecoder === 'undefined') return null;
    const chunks: AudioData[] = [];
    const decoder = new AudioDecoder({
      output: (data) => chunks.push(data),
      error: () => undefined,
    });
    try {
      decoder.configure({
        codec: track.codec,
        sampleRate: track.sampleRate,
        numberOfChannels: track.channels,
        description: track.description ?? undefined,
      });
      for (let i = 0; i < track.samples.length; i += 1) {
        const sample = track.samples[i]!;
        decoder.decode(
          new EncodedAudioChunk({
            type: sample.key ? 'key' : 'delta',
            timestamp: sample.cts * 1e6,
            data: demuxer.sampleBytes(track, i),
          }),
        );
      }
      await decoder.flush();
    } catch {
      decoder.close();
      return null;
    }
    decoder.close();
    if (chunks.length === 0) return null;
    const rate = chunks[0]!.sampleRate || track.sampleRate || 48000;
    const channels = chunks[0]!.numberOfChannels || track.channels || 2;
    let total = 0;
    for (const chunk of chunks) total += chunk.numberOfFrames;
    const context = new AudioContext({ sampleRate: rate });
    const buffer = context.createBuffer(channels, Math.max(1, total), rate);
    void context.close();
    const planes = new Float32Array(chunks[0]!.numberOfFrames * channels);
    let writeAt = 0;
    for (const chunk of chunks) {
      const frames = chunk.numberOfFrames;
      chunk.copyTo(planes, { planeIndex: 0, format: 'f32-planar' });
      for (let channel = 0; channel < channels; channel += 1) {
        const target = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
        target.set(planes.subarray(channel * frames, (channel + 1) * frames), writeAt);
      }
      writeAt += frames;
      chunk.close();
    }
    return buffer;
  }

  /** The hidden `<video>` element path. */
  private async getFrameFromElement(time: number): Promise<RenderImage | null> {
    const element = this.ensureElement();
    if (!element) return null;
    const clamped = Math.min(Math.max(0, time), Math.max(0, element.duration - 0.001));
    if (element.readyState < 2 || Math.abs(element.currentTime - clamped) > 0.02) {
      await seekElement(element, clamped);
    }
    return element;
  }

  private ensureElement(): HTMLVideoElement | null {
    if (this.element) return this.element;
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    this.elementUrl = URL.createObjectURL(this.file);
    video.src = this.elementUrl;
    this.element = video;
    return video;
  }

  private async decodeStill(): Promise<RenderImage | null> {
    if (typeof createImageBitmap === 'undefined') return null;
    try {
      return await createImageBitmap(this.file);
    } catch {
      return null;
    }
  }

  private putInCache(key: number, image: RenderImage): void {
    this.frameCache.set(key, { image, lastUsed: Date.now() });
    while (this.frameCache.size > FRAME_CACHE_LIMIT) {
      let oldestKey: number | null = null;
      let oldest = Infinity;
      for (const [entryKey, entry] of this.frameCache) {
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestKey = entryKey;
        }
      }
      if (oldestKey === null) break;
      const evicted = this.frameCache.get(oldestKey);
      this.frameCache.delete(oldestKey);
      if (evicted) closeImage(evicted.image);
    }
  }

  private dropDecoder(): void {
    this.videoDecoder = null;
  }
}

/** Closes a frame when it is closeable (never a live element). */
function closeImage(image: RenderImage): void {
  if ('close' in image && typeof image.close === 'function') {
    try {
      image.close();
    } catch {
      // Already closed — fine.
    }
  }
}

/** The display rate of a demuxed video track. */
function rateOf(track: DemuxTrack): FrameRate {
  const first = track.samples[0];
  if (first && first.duration > 0) {
    const uniform = track.samples.every((sample) => sample.duration === first.duration);
    if (uniform) {
      const exact = FrameRate.checked(Math.round(track.timescale), Math.round(first.duration * track.timescale));
      if (exact) return exact;
    }
  }
  const fps = track.duration > 0 ? track.samples.length / track.duration : 30;
  return FrameRate.checked(Math.round(fps * 1000), 1000) ?? FrameRate.THIRTY;
}

/** Waits for one `seeked` event. */
function seekElement(element: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      element.removeEventListener('seeked', done);
      resolve();
    };
    element.addEventListener('seeked', done);
    element.currentTime = time;
    // Some browsers fire nothing when the seek is a no-op.
    globalThis.setTimeout(done, 250);
  });
}

/** Element probe for containers without a demuxer: size, duration, rate. */
async function probeElement(
  file: File | Blob,
  type: 'video' | 'audio' | 'image',
): Promise<{ width: number; height: number; duration: number; fps: FrameRate | null }> {
  if (typeof document === 'undefined' || type === 'image' || typeof URL.createObjectURL !== 'function') {
    return { width: 0, height: 0, duration: 0, fps: null };
  }
  const url = URL.createObjectURL(file);
  try {
    const element = document.createElement(type === 'audio' ? 'audio' : 'video');
    element.preload = 'metadata';
    element.src = url;
    await new Promise<void>((resolve) => {
      const done = () => {
        element.removeEventListener('loadedmetadata', done);
        resolve();
      };
      element.addEventListener('loadedmetadata', done);
      globalThis.setTimeout(done, 3000);
    });
    return {
      width: 'videoWidth' in element ? element.videoWidth : 0,
      height: 'videoHeight' in element ? element.videoHeight : 0,
      duration: Number.isFinite(element.duration) ? element.duration : 0,
      fps: null,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
