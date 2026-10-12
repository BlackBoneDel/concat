// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The waveform worker: min/max peaks of a mono signal, off the UI thread.
 * Speaks the `WorkerRequest`/`WorkerResponse` protocol of
 * `./waveform-generator.ts`.
 */

/** The request shape. */
interface WorkerRequest {
  samples: Float32Array;
  samplesPerPixel: number;
}

/** Min/max pairs of a mono signal (identical to `peaksOf` on the main thread). */
function peaksOf(samples: Float32Array, samplesPerPixel: number): Float32Array {
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

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { samples, samplesPerPixel } = event.data;
  const data = peaksOf(samples, samplesPerPixel);
  self.postMessage({ data }, { transfer: [data.buffer] });
};
