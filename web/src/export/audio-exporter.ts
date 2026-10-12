// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the offline audio mix of an export. The same {@link AudioMixer}
 * the player uses — with the process-wide effects resolver, so the whole
 * Fase 4/5 stack (EQ, compressor, reverb, pitch, fades…) is in the file —
 * runs on an `OfflineAudioContext` (48 kHz stereo by default) faster than
 * real time.
 *
 * Long exports render in windows (60 s by default) so a 10-minute mix never
 * holds one 230 MB buffer: each window starts a second early (pre-roll) to
 * warm filter state and reverb tails, and that second is discarded. Without
 * `OfflineAudioContext` a plain mix (volume, fades, speed; no effects) is
 * computed by hand.
 *
 * Port of `src/crates/concat-export/src/lib.rs::audio_pieces` (which clips
 * contribute sound: unmuted audio clips and the sound of unmuted video).
 */

import { Rational } from '../core/rational.ts';
import { AudioMixer, type AudioGraphContext, type BufferLike, type ClipSourceSpec } from '../player/audio-mixer.ts';
import type { EditorSession } from '../session/editor-session.ts';
import { trackAudible } from './export-document.ts';
import { ExportError, throwIfAborted } from './types.ts';

/** A decoded buffer with samples (an `AudioBuffer` or a test double). */
export interface PcmBufferLike extends BufferLike {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** An offline context: the mixer's graph plus `startRendering`. */
export interface OfflineContextLike extends AudioGraphContext {
  startRendering(): Promise<PcmBufferLike>;
}

/** Builds an offline context, or `null` when the browser has none. */
export type OfflineContextFactory = (channels: number, length: number, sampleRate: number) => OfflineContextLike | null;

/** One clip of the mix with its lane and key. */
export interface AudioClipSource {
  trackId: string;
  key: string;
  spec: ClipSourceSpec;
}

/** A rendered stretch of the mix. */
export interface AudioWindow {
  /** One plane per channel. */
  planes: Float32Array[];
  /** Index of the window's first sample frame in the export. */
  offsetFrames: number;
}

/** Options of {@link AudioExporter}. */
export interface AudioExporterOptions {
  sampleRate?: number;
  channels?: number;
  /** Seconds per offline render window (60). */
  windowSeconds?: number;
  /** Seconds rendered before each window and discarded (1). */
  prerollSeconds?: number;
  /** Offline context factory (tests inject doubles). */
  createContext?: OfflineContextFactory;
  signal?: AbortSignal;
}

/** Samples per encoder block. */
export const AUDIO_BLOCK_FRAMES = 1024;

/**
 * The browser's offline context, made safe for the mixer: `startAll` calls
 * `resume()`, which an offline context that has not started rejects, so the
 * instance gets a resolved no-op `resume` of its own.
 * @param channels channel count.
 * @param length sample frames.
 * @param sampleRate Hz.
 * @returns the context, or `null` without Web Audio.
 */
export function browserOfflineContext(channels: number, length: number, sampleRate: number): OfflineContextLike | null {
  if (typeof OfflineAudioContext === 'undefined') return null;
  const context = new OfflineAudioContext(channels, Math.max(1, length), sampleRate);
  Object.defineProperty(context, 'resume', { value: () => Promise.resolve(), configurable: true });
  return context;
}

/**
 * The clips that make sound in an export session: audio and video clips on
 * audible lanes (mute/solo), with their decoded buffers.
 * @param session the export session (snapshot).
 * @param getBuffer decoded audio of a media path (`null` = no audio).
 * @returns the mix sources.
 */
export async function collectAudioClips(
  session: EditorSession,
  getBuffer: (path: string) => Promise<BufferLike | null>,
): Promise<AudioClipSource[]> {
  const tracks = session.timeline.tracks;
  const audible = new Set(tracks.filter((track) => trackAudible(track, tracks)).map((track) => track.id));
  const out: AudioClipSource[] = [];
  for (const clip of session.clips()) {
    if (clip.kind !== 'audio' && clip.kind !== 'video') continue;
    if (!audible.has(clip.docTrackId) || !clip.media.path) continue;
    const buffer = await getBuffer(clip.media.path);
    if (!buffer) continue;
    out.push({
      trackId: clip.docTrackId,
      key: clip.docId,
      spec: {
        timelineStart: clip.start.asNumber(),
        sourceOffset: clip.source_start.asNumber(),
        duration: clip.duration.asNumber(),
        buffer,
        volume: clip.gainAt(clip.start),
        fadeIn: clip.audioFadeIn,
        fadeOut: clip.audioFadeOut,
        rate: clip.speed.asNumber(),
      },
    });
  }
  return out;
}

/**
 * Whether a buffer carries samples the manual mix can read.
 * @param buffer the buffer.
 * @returns the narrowed buffer check.
 */
export function isPcmBuffer(buffer: BufferLike): buffer is PcmBufferLike {
  return (
    'getChannelData' in buffer &&
    typeof buffer.getChannelData === 'function' &&
    'numberOfChannels' in buffer &&
    'sampleRate' in buffer &&
    'length' in buffer
  );
}

/**
 * The hand mix: linear-interpolated resampling, clip volume and linear
 * fades, summed and clamped to [-1, 1]. No effects.
 * @param clips the sources.
 * @param windowStart timeline second of sample 0.
 * @param frames sample frames to produce.
 * @param sampleRate output Hz.
 * @param channels output channels.
 * @returns one plane per channel.
 */
export function mixManually(
  clips: readonly AudioClipSource[],
  windowStart: number,
  frames: number,
  sampleRate: number,
  channels: number,
): Float32Array[] {
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  const windowEnd = windowStart + frames / sampleRate;
  for (const { spec } of clips) {
    if (!isPcmBuffer(spec.buffer)) continue;
    const clipEnd = spec.timelineStart + spec.duration;
    if (clipEnd <= windowStart || spec.timelineStart >= windowEnd) continue;
    const buffer = spec.buffer;
    const sources = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const first = Math.max(0, Math.ceil((spec.timelineStart - windowStart) * sampleRate));
    const last = Math.min(frames, Math.ceil((clipEnd - windowStart) * sampleRate));
    for (let i = first; i < last; i += 1) {
      const t = windowStart + i / sampleRate;
      const into = t - spec.timelineStart;
      let gain = Math.max(0, spec.volume);
      if (spec.fadeIn > 0 && into < spec.fadeIn) gain *= into / spec.fadeIn;
      const left = clipEnd - t;
      if (spec.fadeOut > 0 && left < spec.fadeOut) gain *= Math.max(0, left / spec.fadeOut);
      if (gain === 0) continue;
      const position = (spec.sourceOffset + into * spec.rate) * buffer.sampleRate;
      const index = Math.floor(position);
      if (index < 0 || index >= buffer.length) continue;
      const frac = position - index;
      for (let c = 0; c < channels; c += 1) {
        let sample: number;
        if (channels === 1 && sources.length > 1) {
          sample = 0;
          for (const source of sources) sample += lerp(source, index, frac);
          sample /= sources.length;
        } else {
          const source = sources[Math.min(c, sources.length - 1)];
          sample = source ? lerp(source, index, frac) : 0;
        }
        const plane = planes[c];
        if (plane) plane[i] = (plane[i] ?? 0) + sample * gain;
      }
    }
  }
  for (const plane of planes) {
    for (let i = 0; i < plane.length; i += 1) plane[i] = Math.max(-1, Math.min(1, plane[i] ?? 0));
  }
  return planes;
}

/** Linear interpolation inside a plane (holds the last sample). */
function lerp(source: Float32Array, index: number, frac: number): number {
  const a = source[index] ?? 0;
  const b = source[index + 1] ?? a;
  return a + (b - a) * frac;
}

/** Renders the export mix window by window. */
export class AudioExporter {
  readonly sampleRate: number;
  readonly channels: number;
  private readonly windowSeconds: number;
  private readonly prerollSeconds: number;
  private readonly createContext: OfflineContextFactory;
  private readonly signal: AbortSignal | undefined;
  /** `true` once a window fell back to the hand mix (effects skipped). */
  usedManualMix = false;

  /**
   * @param options rate, channels, windowing, context factory and abort signal.
   */
  constructor(options: AudioExporterOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48_000;
    this.channels = options.channels ?? 2;
    this.windowSeconds = Math.max(1, options.windowSeconds ?? 60);
    this.prerollSeconds = Math.max(0, options.prerollSeconds ?? 1);
    this.createContext = options.createContext ?? browserOfflineContext;
    this.signal = options.signal;
  }

  /**
   * Sample frames of `[start, end)`: `floor((end - start) * sampleRate)`.
   * @param start range start.
   * @param end range end.
   * @returns the frame count.
   */
  totalFrames(start: Rational, end: Rational): number {
    if (end.compare(start) <= 0) throw new ExportError('INVALID_RANGE');
    return Number(end.sub(start).mul(Rational.fromInt(this.sampleRate)).floor());
  }

  /**
   * Renders the mix of `[start, end)` as consecutive windows.
   * @param clips the sources ({@link collectAudioClips}).
   * @param start range start.
   * @param end range end.
   * @yields windows in order; their planes are fresh arrays the caller owns.
   */
  async *render(clips: readonly AudioClipSource[], start: Rational, end: Rational): AsyncGenerator<AudioWindow> {
    const total = this.totalFrames(start, end);
    const windowFrames = Math.round(this.windowSeconds * this.sampleRate);
    const startSeconds = start.asNumber();
    for (let offset = 0; offset < total; offset += windowFrames) {
      throwIfAborted(this.signal);
      const frames = Math.min(windowFrames, total - offset);
      const windowStart = startSeconds + offset / this.sampleRate;
      const planes = await this.renderWindow(clips, windowStart, frames);
      yield { planes, offsetFrames: offset };
    }
  }

  /**
   * One window: offline graph with pre-roll, or the hand mix.
   * @param clips the sources.
   * @param windowStart timeline second of the first kept sample.
   * @param frames sample frames to keep.
   * @returns one plane per channel.
   */
  async renderWindow(clips: readonly AudioClipSource[], windowStart: number, frames: number): Promise<Float32Array[]> {
    const preroll = Math.min(this.prerollSeconds, windowStart);
    const prerollFrames = Math.round(preroll * this.sampleRate);
    const renderStart = windowStart - prerollFrames / this.sampleRate;
    const renderEnd = windowStart + frames / this.sampleRate;
    const active = clips.filter(({ spec }) => spec.timelineStart < renderEnd && spec.timelineStart + spec.duration > renderStart);
    if (active.length === 0) return Array.from({ length: this.channels }, () => new Float32Array(frames));
    const context = this.createContext(this.channels, prerollFrames + frames, this.sampleRate);
    if (!context) {
      this.usedManualMix = true;
      return mixManually(active, windowStart, frames, this.sampleRate, this.channels);
    }
    const mixer = new AudioMixer(context);
    try {
      for (const clip of active) mixer.addClipSource(clip.trackId, clip.key, clip.spec);
      mixer.startAll(renderStart);
      const rendered = await context.startRendering();
      const planes: Float32Array[] = [];
      for (let c = 0; c < this.channels; c += 1) {
        const source = rendered.getChannelData(Math.min(c, rendered.numberOfChannels - 1));
        const plane = new Float32Array(frames);
        plane.set(source.subarray(prerollFrames, prerollFrames + frames));
        planes.push(plane);
      }
      return planes;
    } finally {
      mixer.stopAll();
    }
  }
}

/**
 * Splits a window into encoder blocks of {@link AUDIO_BLOCK_FRAMES}.
 * @param window the rendered window.
 * @param sampleRate Hz (for timestamps).
 * @param blockFrames frames per block.
 * @yields `{ planes, frames, timestamp }` with timestamps in microseconds.
 */
export function* audioBlocks(
  window: AudioWindow,
  sampleRate: number,
  blockFrames = AUDIO_BLOCK_FRAMES,
): Generator<{ planes: Float32Array[]; frames: number; timestamp: number }> {
  const length = window.planes[0]?.length ?? 0;
  for (let offset = 0; offset < length; offset += blockFrames) {
    const frames = Math.min(blockFrames, length - offset);
    const planes = window.planes.map((plane) => plane.subarray(offset, offset + frames));
    const timestamp = Math.round(((window.offsetFrames + offset) * 1_000_000) / sampleRate);
    yield { planes, frames, timestamp };
  }
}
