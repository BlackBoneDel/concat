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
import type { AudioBufferLike } from './audio/audio-buffer.ts';

/**
 * Fase 4: the slow path for files the browser cannot decode natively
 * (MKV/AVI/FLV, HEVC in Chromium, …). Implemented by
 * `media/ffmpeg/ffmpeg-fallback.ts`; kept structural so this module never
 * imports the FFmpeg worker eagerly.
 */
export interface MediaFallback {
  /** Probes streams/duration. */
  probe(file: Blob): Promise<{
    duration: Rational;
    streams: { type: 'video' | 'audio' | 'subtitle'; codec: string; width?: number; height?: number; fps?: number; sampleRate?: number; channels?: number }[];
  }>;
  /** Re-encodes to something a `<video>` element plays (WebM VP8/Vorbis). */
  conformForPreview(file: Blob, size: { width: number; height: number }): Promise<Blob>;
  /** Decodes the audio track to planar float PCM. */
  extractAudio(file: Blob): Promise<AudioBufferLike>;
}

/** Options for {@link MediaDecoder.constructor}. */
export interface MediaDecoderOptions {
  /** FFmpeg fallback used only when the native paths fail. */
  fallback?: MediaFallback | null;
}

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
  /** Fase 4: true when the metadata (and playback) come from the FFmpeg fallback. */
  viaFallback?: boolean;
}

/** How many frames the cache holds before the oldest are closed. */
const FRAME_CACHE_LIMIT = 30;

/**
 * The hard budget of every metadata step (element probe, duration reveal,
 * FFmpeg probe). Past this the file is declared "metadata unknown" and the
 * import continues with the fallbacks — the library card never spins forever.
 */
export const METADATA_TIMEOUT_MS = 2000;

/**
 * Above this size the file is read in slices instead of one `arrayBuffer()`:
 * engines cap a single allocation, and a 1 GB import must not die as an
 * out-of-memory abort when the bytes can be read perfectly well in pieces.
 */
export const LARGE_FILE_BYTES = 768 * 1024 * 1024;

/** Slice size of the chunked read (64 MiB). */
const READ_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Reads a blob into memory.
 * @param file the file (or any blob).
 * @returns its bytes.
 */
export async function readFileBytes(file: Blob): Promise<ArrayBuffer> {
  if (file.size <= LARGE_FILE_BYTES) return file.arrayBuffer();
  const bytes = new Uint8Array(file.size);
  for (let offset = 0; offset < file.size; offset += READ_CHUNK_BYTES) {
    const end = Math.min(file.size, offset + READ_CHUNK_BYTES);
    bytes.set(new Uint8Array(await file.slice(offset, end).arrayBuffer()), offset);
  }
  return bytes.buffer;
}

/** What a probe that timed out leaves behind. */
const EMPTY_PROBE = { width: 0, height: 0, duration: 0, fps: null } as const;

/**
 * Awaits `promise` with a deadline; on timeout or rejection the fallback
 * stands in. Nothing here may reject: probing is best-effort by definition.
 * @param promise the probe.
 * @param ms the budget.
 * @param fallback the value to use when the budget runs out.
 * @returns the probe's answer or the fallback.
 */
function timeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = globalThis.setTimeout(() => finish(fallback), ms);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        finish(value);
      },
      () => {
        globalThis.clearTimeout(timer);
        finish(fallback);
      },
    );
  });
}

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
  /** Index of the last sample fed to the live decoder; -1 when none is running. */
  private fedUpTo = -1;
  /** Decoded frames not yet handed out, in presentation order. Owned here. */
  private ready: VideoFrame[] = [];
  /** The configuration the live decoder was given; reset() needs it again. */
  private decoderConfig: VideoDecoderConfig | null = null;
  private audioBuffer: AudioBuffer | null | undefined;
  private closed = false;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly fallback: MediaFallback | null;
  /** The blob the fallback `<video>` element plays (the original or a conformed copy). */
  private playable: Blob | null = null;
  private conforming: Promise<Blob | null> | null = null;

  /**
   * @param file the local file.
   * @param id the asset id this decoder serves.
   * @param options Fase 4: optional FFmpeg fallback.
   */
  constructor(file: File | Blob, id: string, options: MediaDecoderOptions = {}) {
    this.file = file;
    this.id = id;
    this.fallback = options.fallback ?? null;
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
      try {
        const buffer = await readFileBytes(this.file);
        this.demuxer = MP4Demuxer.open(buffer);
      } catch {
        // A truncated/corrupt MP4 must not abort the import: the asset still
        // lands in the library and its card falls back to the placeholder.
        this.demuxer = null;
      }
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
      const bitmap = await timeout(this.decodeStill(), METADATA_TIMEOUT_MS, null);
      if (bitmap) {
        const size = intrinsicSize(bitmap);
        width = size.width;
        height = size.height;
        closeImage(bitmap);
      }
      durationSeconds = 0;
      fps = FrameRate.THIRTY;
    } else if (durationSeconds === 0) {
      // Probe duration through a media element (webm, wav, mp3, ...). The
      // budget is hard: a file whose element never fires `loadedmetadata`
      // must not hold the import hostage.
      const probe = await timeout(probeElement(this.file, type), METADATA_TIMEOUT_MS, EMPTY_PROBE);
      width = probe.width || width;
      height = probe.height || height;
      durationSeconds = probe.duration || durationSeconds;
      fps = probe.fps ?? fps;
    }

    // Fase 4 hook: nothing native could read the file → ask FFmpeg.
    let viaFallback = false;
    if (type !== 'image' && durationSeconds === 0 && width === 0 && this.fallback) {
      try {
        const probe = await timeout(this.fallback.probe(this.file), METADATA_TIMEOUT_MS, null);
        if (probe) {
          const video = probe.streams.find((stream) => stream.type === 'video');
          const audio = probe.streams.find((stream) => stream.type === 'audio');
          durationSeconds = probe.duration.asNumber();
          width = video?.width ?? 0;
          height = video?.height ?? 0;
          videoCodec = video?.codec ?? '';
          audioCodec = audio?.codec ?? '';
          sampleRate = audio?.sampleRate ?? 0;
          channels = audio?.channels ?? 0;
          if (video?.fps) fps = FrameRate.checked(Math.round(video.fps * 1000), 1000) ?? fps;
          viaFallback = durationSeconds > 0 || width > 0;
        }
      } catch {
        // FFmpeg unavailable or the file is unreadable: keep the empty probe.
      }
    }

    this.info = {
      id: this.id,
      viaFallback,
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
    // The decoder is shared with getFrame: run inside the same queue so a
    // reset here can never abort a flush there.
    const frames = await this.enqueue(async (): Promise<VideoFrame[]> => {
      const chunks = this.videoTrack;
      const demuxer = this.demuxer;
      const decoder = this.ensureVideoDecoder();
      if (!chunks || !demuxer || !decoder) return [];
      const from = MP4Demuxer.sampleAt(chunks, start.asNumber());
      const to = MP4Demuxer.sampleAt(chunks, end.asNumber());
      const keyFrom = MP4Demuxer.keyframeBefore(chunks, from);
      this.resetPipeline();
      for (let i = keyFrom; i <= to && i < chunks.samples.length; i += 1) {
        decoder.decode(this.encodedChunk(chunks, i, demuxer));
      }
      await decoder.flush();
      const out = [...this.pending];
      this.pending.length = 0;
      return out;
    });
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
          const buffer = await context.decodeAudioData(await readFileBytes(this.file));
          this.audioBuffer = buffer;
        } finally {
          void context.close();
        }
      }
    } catch {
      this.audioBuffer = null;
    }
    if (!this.audioBuffer && this.fallback && this.info?.audioCodec !== '') {
      // Fase 4 hook: FFmpeg decodes the audio the browser could not.
      try {
        this.audioBuffer = toAudioBuffer(await this.fallback.extractAudio(this.file));
      } catch {
        this.audioBuffer = null;
      }
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
    for (const frame of this.ready) frame.close();
    this.ready = [];
    this.fedUpTo = -1;
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
    this.playable = null;
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
      const config: VideoDecoderConfig = {
        codec: track.codec,
        description: track.description ?? undefined,
        optimizeForLatency: true,
      };
      decoder.configure(config);
      this.decoderConfig = config;
      this.videoDecoder = decoder;
      return decoder;
    } catch {
      return null;
    }
  }

  /** Frames decoded since the last reset of the pipeline. */
  private pending: VideoFrame[] = [];

  /**
   * Returns the frame at `time` from the live decoder. Playing forward feeds
   * only the samples after the last fed one, so each frame costs one decode,
   * not a re-decode from the keyframe. A seek backwards, or a jump into a GOP
   * the decoder has not reached, restarts at that GOP's keyframe.
   *
   * `flush()` is avoided on this path: WebCodecs then requires a keyframe
   * before the next chunk, which would break forward playback. The decoder's
   * queue is drained instead; `flush()` is the last resort at the end of the
   * media, and the next request then restarts at a keyframe.
   */
  private async decodeFrameWebCodecs(time: number): Promise<RenderImage | null> {
    const track = this.videoTrack;
    const demuxer = this.demuxer;
    const decoder = this.ensureVideoDecoder();
    if (!track || !demuxer || !decoder) return null;
    const target = MP4Demuxer.sampleAt(track, time);
    const gopStart = MP4Demuxer.keyframeBefore(track, target);
    if (this.fedUpTo < 0 || target < this.fedUpTo || gopStart > this.fedUpTo) {
      this.resetPipeline();
      this.fedUpTo = gopStart - 1;
    }
    const last = track.samples.length - 1;
    // Two samples of look-ahead cover B-frame reordering; more if needed.
    this.feedThrough(Math.min(last, target + 2));
    await this.drainDecoder();
    let chosen = this.pickFrame(time);
    while (!chosen && this.fedUpTo < last) {
      this.feedThrough(Math.min(last, this.fedUpTo + 4));
      await this.drainDecoder();
      chosen = this.pickFrame(time);
    }
    if (!chosen) {
      // End of the media (or a stuck decoder): flush once, then restart on the next call.
      try {
        await decoder.flush();
      } catch {
        this.dropDecoder();
        return null;
      }
      this.ready.push(...this.pending);
      this.pending.length = 0;
      this.fedUpTo = -1;
      chosen = this.pickFrame(time);
    }
    return chosen;
  }

  /** Feeds every sample up to and including `end` that is not yet fed. */
  private feedThrough(end: number): void {
    const track = this.videoTrack;
    const demuxer = this.demuxer;
    const decoder = this.videoDecoder;
    if (!track || !demuxer || !decoder) return;
    for (let i = this.fedUpTo + 1; i <= end; i += 1) {
      decoder.decode(this.encodedChunk(track, i, demuxer));
    }
    this.fedUpTo = Math.max(this.fedUpTo, end);
  }

  /** Waits until the decoder has consumed its queue and its outputs have landed. */
  private async drainDecoder(): Promise<void> {
    const decoder = this.videoDecoder;
    for (let spin = 0; decoder && decoder.decodeQueueSize > 0 && spin < 2000; spin += 1) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 2));
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    this.ready.push(...this.pending);
    this.pending.length = 0;
  }

  /**
   * Picks the frame for `time` from the decoded ones, closing the stale ones.
   * The frame at or just after the instant; else the last one before it.
   */
  private pickFrame(time: number): VideoFrame | null {
    const sorted = this.ready.sort((a, b) => a.timestamp - b.timestamp);
    const atOrAfter = sorted.find((frame) => frame.timestamp / 1e6 >= time - 1e-3) ?? null;
    const before = sorted.filter((frame) => frame.timestamp / 1e6 < time - 1e-3).pop() ?? null;
    const chosen = atOrAfter ?? before;
    if (!chosen) return null;
    // Frames older than the chosen one are never needed again going forward.
    const keep: VideoFrame[] = [];
    for (const frame of sorted) {
      if (frame === chosen) continue;
      if (frame.timestamp < chosen.timestamp) frame.close();
      else keep.push(frame);
    }
    this.ready = keep;
    return chosen;
  }

  /** Discards every decoded frame and the decoder's queue; keeps the decoder. */
  private resetPipeline(): void {
    for (const frame of this.ready) frame.close();
    this.ready = [];
    for (const frame of this.pending) frame.close();
    this.pending.length = 0;
    const decoder = this.videoDecoder;
    if (decoder && decoder.state !== 'closed' && this.decoderConfig) {
      // Per WebCodecs, reset() leaves the decoder "unconfigured": configure it
      // again, or the next decode() throws InvalidStateError.
      if (decoder.state === 'configured') decoder.reset();
      decoder.configure(this.decoderConfig);
    }
    this.fedUpTo = -1;
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
    if (this.info?.viaFallback && !this.playable) {
      // Fase 4 hook: conform once to WebM the element can play.
      this.playable = await this.conformOnce();
      if (!this.playable || this.closed) return null;
    }
    const element = this.ensureElement();
    if (!element) return null;
    // Fase 7+: WebM/MKV files (OBS recordings, live-muxed streams) report
    // `NaN`/`Infinity` durations — clamping against those produced
    // `currentTime = NaN`, which throws and killed every thumbnail.
    const clamped = clampSeekTime(time, element.duration);
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
    this.elementUrl = URL.createObjectURL(this.playable ?? this.file);
    video.src = this.elementUrl;
    this.element = video;
    return video;
  }

  /** Runs the FFmpeg preview conform at most once. */
  private conformOnce(): Promise<Blob | null> {
    if (!this.conforming) {
      const fallback = this.fallback;
      const info = this.info;
      this.conforming = fallback && info
        ? fallback.conformForPreview(this.file, { width: info.width, height: info.height }).catch(() => null)
        : Promise.resolve(null);
    }
    return this.conforming;
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
    if (this.videoDecoder && this.videoDecoder.state !== 'closed') this.videoDecoder.close();
    this.videoDecoder = null;
    for (const frame of this.ready) frame.close();
    this.ready = [];
    this.fedUpTo = -1;
  }
}

/**
 * Planar PCM → a real `AudioBuffer` (the mixer needs one).
 * @param source decoded samples.
 * @returns the buffer, or `null` where Web Audio is missing.
 */
function toAudioBuffer(source: AudioBufferLike): AudioBuffer | null {
  if (typeof AudioBuffer === 'undefined' || source.length === 0) return null;
  const buffer = new AudioBuffer({ length: source.length, numberOfChannels: source.numberOfChannels, sampleRate: source.sampleRate });
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    buffer.copyToChannel(Float32Array.from(source.getChannelData(channel)), channel);
  }
  return buffer;
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
/**
 * Seeks a media element and resolves when it lands (or after 250 ms).
 *
 * Exported because it is the exact place where a non-finite `currentTime`
 * used to be assigned; the regression suite drives it with a stand-in
 * element to prove `NaN` never reaches the property.
 * @param element the media element.
 * @param time the wanted instant; non-finite values are clamped to 0.
 * @returns a promise that settles on `seeked` (or the timeout).
 */
export function seekElement(element: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      element.removeEventListener('seeked', done);
      resolve();
    };
    element.addEventListener('seeked', done);
    // Fase 7+: never assign a non-finite `currentTime` (throws in every
    // engine); elements without metadata yet also refuse the seek, which
    // the timeout below absorbs.
    const target = Number.isFinite(time) && time > 0 ? time : 0;
    try {
      element.currentTime = target;
    } catch {
      // Not seekable yet: resolve through the timeout.
    }
    // Some browsers fire nothing when the seek is a no-op.
    globalThis.setTimeout(done, 250);
  });
}

/**
 * The finite, non-negative seek target for `currentTime`.
 *
 * WebM files without a duration in the header (OBS recordings, live-muxed
 * streams) make `element.duration` `NaN` or `Infinity`; the old
 * `Math.min(Math.max(0, t), duration - 0.001)` clamp turned those into
 * `currentTime = NaN`, which throws and aborted thumbnail generation.
 * @param time the wanted instant (seconds); non-finite values map to 0.
 * @param duration the element's duration; non-finite/non-positive means
 * "unknown" and the (sanitized) time is used unclamped.
 * @returns a value that is always safe to assign to `currentTime`.
 */
export function clampSeekTime(time: number, duration: number): number {
  const target = Number.isFinite(time) ? Math.max(0, time) : 0;
  if (!Number.isFinite(duration) || duration <= 0) return target;
  return Math.min(target, Math.max(0, duration - 0.001));
}

/**
 * A duration usable for probing: `Infinity` (stream-shaped WebM/MKV) and
 * `NaN` (metadata not loaded) both mean "unknown" and map to 0.
 * @param value the raw `element.duration`.
 * @returns the finite positive duration, or 0.
 */
export function finiteDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The parts of `HTMLMediaElement` the duration-reveal seek uses. */
export interface DurationProbeElement {
  duration: number;
  currentTime: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Reveals the real duration of files that report `Infinity`/`NaN` (the OBS
 * problem: the muxer never wrote a total duration). Seeking to an absurdly
 * large time forces the element to scan to the end, announcing the real
 * duration through `durationchange`/`seeked`; afterwards the element is
 * rewound to 0.
 * @param element a media element with (or without) a known duration.
 * @param timeoutMs how long to wait for the reveal (default 2.5 s).
 * @returns the discovered finite duration, or 0 when it never appeared.
 */
export function revealDuration(element: DurationProbeElement, timeoutMs = METADATA_TIMEOUT_MS): Promise<number> {
  const known = finiteDuration(element.duration);
  if (known > 0) return Promise.resolve(known);
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (value: number): void => {
      if (settled) return;
      settled = true;
      element.removeEventListener('durationchange', onChange);
      element.removeEventListener('seeked', onChange);
      try {
        element.currentTime = 0;
      } catch {
        // Some elements refuse seeks before metadata — nothing to rewind.
      }
      resolve(value);
    };
    const onChange = (): void => {
      const found = finiteDuration(element.duration);
      if (found > 0) finish(found);
    };
    element.addEventListener('durationchange', onChange);
    element.addEventListener('seeked', onChange);
    globalThis.setTimeout(() => finish(finiteDuration(element.duration)), timeoutMs);
    try {
      // The element clamps the overshoot to the real end of the media.
      element.currentTime = Number.MAX_VALUE;
    } catch {
      finish(finiteDuration(element.duration));
    }
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
  const element = document.createElement(type === 'audio' ? 'audio' : 'video');
  try {
    element.preload = 'metadata';
    element.src = url;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        element.removeEventListener('loadedmetadata', done);
        element.removeEventListener('error', done);
        resolve();
      };
      element.addEventListener('loadedmetadata', done);
      // A file the engine cannot even open fires `error`, not metadata.
      element.addEventListener('error', done);
      globalThis.setTimeout(done, METADATA_TIMEOUT_MS);
    });
    // Fase 7+: OBS/stream-shaped files answer `Infinity` (or `NaN`) here —
    // reveal the real duration with the seek-to-the-end trick instead of
    // importing a 0-second asset.
    let duration = finiteDuration(element.duration);
    if (duration === 0 && !Number.isFinite(element.duration)) {
      duration = await revealDuration(element as unknown as DurationProbeElement);
    }
    return {
      width: 'videoWidth' in element ? element.videoWidth : 0,
      height: 'videoHeight' in element ? element.videoHeight : 0,
      duration,
      fps: null,
    };
  } finally {
    // Cleanup in a fixed order: detach, stop the loader, then free the URL.
    // Leaving the element fetching a revoked blob keeps a decoder alive for
    // the whole session (the reported "import se queda colgado" leak).
    element.removeAttribute('src');
    try {
      element.load();
    } catch {
      // Detached elements may refuse `load()`; nothing to do about it.
    }
    URL.revokeObjectURL(url);
  }
}
