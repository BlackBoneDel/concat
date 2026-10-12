// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Audio waveform generation for the timeline's audio clips.
 *
 * Peaks (min/max pairs per bucket) are computed off the main thread in
 * {@link ./waveform-worker.ts}, cached in the `waveforms` store of
 * `ConcatMediaDB`, and picked per zoom level through
 * {@link getBestWaveform}. Without `Worker` (tests, old engines) the same
 * math runs inline — the output is identical.
 */

import { openKeyValue, type KeyValue } from '../storage/idb.ts';

/** One resolution of peaks for one media. */
export interface WaveformData {
  mediaId: string;
  /** Audio samples per min/max bucket. */
  samplesPerPixel: number;
  /** Pairs `[min, max, min, max, …]`, one pair per bucket. */
  data: Float32Array;
  /** Seconds the peaks cover. */
  duration: number;
  /** Channels that were mixed down (always stored mono). */
  channels: number;
}

/** The resolutions generated on import, coarsest last. */
export const WAVEFORM_RESOLUTIONS: readonly number[] = [128, 512, 2048];

/** Message the generator sends the worker. */
interface WorkerRequest {
  samples: Float32Array;
  samplesPerPixel: number;
}

/** Message the worker answers with. */
interface WorkerResponse {
  data: Float32Array;
}

/**
 * Peaks of one audio buffer.
 * @param audioBuffer the decoded audio.
 * @param samplesPerPixel bucket size in samples.
 * @param mediaId id to stamp on the result.
 * @returns the peaks (not yet cached).
 */
export function computeWaveform(
  audioBuffer: AudioBuffer,
  samplesPerPixel: number,
  mediaId = '',
): WaveformData {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / channels;
  }
  return {
    mediaId,
    samplesPerPixel,
    data: peaksOf(mono, samplesPerPixel),
    duration: audioBuffer.duration,
    channels,
  };
}

/**
 * Min/max pairs of a mono signal.
 * @param samples the mono mix.
 * @param samplesPerPixel bucket size.
 * @returns `2 * ceil(n / spp)` floats.
 */
export function peaksOf(samples: Float32Array, samplesPerPixel: number): Float32Array {
  const step = Math.max(1, Math.trunc(samplesPerPixel));
  const buckets = Math.max(1, Math.ceil(samples.length / step));
  const out = new Float32Array(buckets * 2);
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = bucket * step;
    const to = Math.min(samples.length, from + step);
    let min = 0;
    let max = 0;
    if (to > from) {
      min = samples[from] ?? 0;
      max = min;
      for (let i = from; i < to; i += 1) {
        const value = samples[i] ?? 0;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    out[bucket * 2] = min;
    out[bucket * 2 + 1] = max;
  }
  return out;
}

/** Mixes an AudioBuffer to one mono channel (the worker's input). */
export function toMono(audioBuffer: AudioBuffer): Float32Array {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / channels;
  }
  return mono;
}

/** Runs the peak math in a worker, or inline when workers are missing. */
async function computePeaks(samples: Float32Array, samplesPerPixel: number): Promise<Float32Array> {
  if (typeof Worker === 'undefined') {
    return peaksOf(samples, samplesPerPixel);
  }
  return new Promise<Float32Array>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./waveform-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(peaksOf(samples, samplesPerPixel));
      return;
    }
    const message: WorkerRequest = { samples, samplesPerPixel };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      resolve(event.data.data);
      worker.terminate();
    };
    worker.onerror = () => {
      resolve(peaksOf(samples, samplesPerPixel));
      worker.terminate();
    };
    worker.postMessage(message);
  });
}

/** The waveform cache (IndexedDB `ConcatMediaDB` store `waveforms`). */
export class WaveformCache {
  private backend: KeyValue | null = null;

  /** Opens the cache lazily; memory fallback when IndexedDB is gone. */
  private async store(): Promise<KeyValue> {
    if (!this.backend) {
      this.backend = await openKeyValue('ConcatMediaDB', ['files', 'waveforms']);
    }
    return this.backend;
  }

  /**
   * @param mediaId the media.
   * @param samplesPerPixel the resolution.
   * @returns the cached peaks, or `null`.
   */
  async get(mediaId: string, samplesPerPixel: number): Promise<WaveformData | null> {
    const backend = await this.store();
    const key = cacheKey(mediaId, samplesPerPixel);
    const raw = await backend.get<WaveformData>('waveforms', key);
    if (!raw || !(raw.data instanceof Float32Array)) return null;
    return raw;
  }

  /**
   * Stores peaks for later.
   * @param data the peaks to remember.
   */
  async put(data: WaveformData): Promise<void> {
    const backend = await this.store();
    await backend.put('waveforms', cacheKey(data.mediaId, data.samplesPerPixel), data);
  }

  /** Forgets one media's peaks. */
  async delete(mediaId: string): Promise<void> {
    const backend = await this.store();
    for (const samplesPerPixel of WAVEFORM_RESOLUTIONS) {
      await backend.delete('waveforms', cacheKey(mediaId, samplesPerPixel));
    }
  }
}

/** The one cache of the app. */
export const waveformCache = new WaveformCache();

/** The cache key of one resolution. */
function cacheKey(mediaId: string, samplesPerPixel: number): string {
  return `${mediaId}_${samplesPerPixel}`;
}

/**
 * Generates (or returns cached) peaks at one resolution.
 * @param audioBuffer the decoded audio.
 * @param samplesPerPixel bucket size.
 * @param mediaId id to stamp and cache under.
 * @returns the peaks.
 */
export async function generateWaveform(
  audioBuffer: AudioBuffer,
  samplesPerPixel: number,
  mediaId = '',
): Promise<WaveformData> {
  const cached = mediaId !== '' ? await waveformCache.get(mediaId, samplesPerPixel) : null;
  if (cached) return cached;
  const mono = toMono(audioBuffer);
  const data = await computePeaks(mono, samplesPerPixel);
  const result: WaveformData = {
    mediaId,
    samplesPerPixel,
    data,
    duration: audioBuffer.duration,
    channels: audioBuffer.numberOfChannels,
  };
  if (mediaId !== '') await waveformCache.put(result);
  return result;
}

/**
 * Generates every resolution at once (the import path).
 * @param audioBuffer the decoded audio.
 * @param resolutions bucket sizes to build.
 * @param mediaId id to stamp and cache under.
 * @returns one entry per resolution.
 */
export async function generateWaveformMultiRes(
  audioBuffer: AudioBuffer,
  resolutions: number[] = [...WAVEFORM_RESOLUTIONS],
  mediaId = '',
): Promise<WaveformData[]> {
  const out: WaveformData[] = [];
  for (const samplesPerPixel of resolutions) {
    out.push(await generateWaveform(audioBuffer, samplesPerPixel, mediaId));
  }
  return out;
}

/**
 * The peaks that suit the current zoom.
 * @param mediaId the media.
 * @param pixelsPerSecond current timeline zoom.
 * @returns the best cached resolution, or `null` when none is generated yet.
 */
export async function getBestWaveform(
  mediaId: string,
  pixelsPerSecond: number,
): Promise<WaveformData | null> {
  // More pixels per second ⇒ more detail (smaller buckets).
  const wanted = pixelsPerSecond >= 150 ? 128 : pixelsPerSecond >= 50 ? 512 : 2048;
  const direct = await waveformCache.get(mediaId, wanted);
  if (direct) return direct;
  for (const samplesPerPixel of WAVEFORM_RESOLUTIONS) {
    const fallback = await waveformCache.get(mediaId, samplesPerPixel);
    if (fallback) return fallback;
  }
  return null;
}
