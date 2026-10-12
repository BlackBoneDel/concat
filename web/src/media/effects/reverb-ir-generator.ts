// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Synthetic reverb impulse responses, generated in RAM (no IR files, no
 * network): decorrelated white noise per channel × an exponential decay
 * `e^(−t/τ)`, through a one-pole low-pass whose cutoff falls over the tail
 * (air and walls absorb highs first — "damping").
 *
 * - `roomSize` (0.05–1) sets the RT60 from 0.3 s to 5 s; τ = RT60 / ln(1000),
 *   so the tail is −60 dB at RT60.
 * - `damping` (0–1) lowers the cutoff from 18 kHz to 1.5 kHz and makes it
 *   fall faster along the tail.
 * - `mix` is applied by the effect chain (dry/wet gains), not baked in.
 *
 * {@link generateImpulseResponse} is the pure kernel (worker + tests);
 * {@link generateImpulseResponseAsync} never blocks the UI: it runs in the
 * reverb worker, or — without workers — in slices yielding to the event loop.
 */

import { WorkerClient, type WorkerHandler, type WorkerLike } from '../../workers/worker-client.ts';

/** Inputs of the generator. */
export interface ReverbIrParams {
  sampleRate: number;
  /** 0.05–1. */
  roomSize: number;
  /** 0–1. */
  damping: number;
  /** 1 or 2 (default 2). */
  channels?: number;
  /** PRNG seed (deterministic output). */
  seed?: number;
}

/** A generated IR: one Float32Array per channel. */
export interface ImpulseResponse {
  sampleRate: number;
  channels: Float32Array[];
  /** Seconds (= RT60). */
  duration: number;
}

/** RT60 in seconds for a room size. */
export function reverbDuration(roomSize: number): number {
  const size = Math.min(1, Math.max(0.05, Number.isFinite(roomSize) ? roomSize : 0.5));
  return 0.3 + (size - 0.05) * (4.7 / 0.95);
}

/** Decay constant τ so the envelope is −60 dB (×0.001) at `duration`. */
export function decayTau(duration: number): number {
  return duration / Math.log(1000);
}

/** Starting low-pass cutoff for a damping amount (Hz). */
export function dampingCutoff(damping: number): number {
  const d = Math.min(1, Math.max(0, Number.isFinite(damping) ? damping : 0.5));
  return 18000 + (1500 - 18000) * d;
}

/** mulberry32: small, fast, deterministic PRNG in `[0, 1)`. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Validates and completes parameters. */
export function normalizeIrParams(params: ReverbIrParams): Required<ReverbIrParams> {
  const sampleRate = Number.isFinite(params.sampleRate) && params.sampleRate >= 8000 ? Math.min(192000, params.sampleRate) : 48000;
  return {
    sampleRate,
    roomSize: Math.min(1, Math.max(0.05, Number.isFinite(params.roomSize) ? params.roomSize : 0.5)),
    damping: Math.min(1, Math.max(0, Number.isFinite(params.damping) ? params.damping : 0.5)),
    channels: params.channels === 1 ? 1 : 2,
    seed: Number.isFinite(params.seed) ? (params.seed ?? 1) : 1,
  };
}

/** Per-channel generator state (lets the async path work in slices). */
interface ChannelState {
  data: Float32Array;
  random: () => number;
  lowpass: number;
}

function prepare(p: Required<ReverbIrParams>): { states: ChannelState[]; length: number; duration: number } {
  const duration = reverbDuration(p.roomSize);
  const length = Math.max(1, Math.round(duration * p.sampleRate));
  const states: ChannelState[] = [];
  for (let c = 0; c < p.channels; c += 1) {
    states.push({ data: new Float32Array(length), random: mulberry32(p.seed * 7919 + c * 104729), lowpass: 0 });
  }
  return { states, length, duration };
}

/** Fills samples `[from, to)` of every channel. */
function fill(p: Required<ReverbIrParams>, states: ChannelState[], length: number, duration: number, from: number, to: number): void {
  const tau = decayTau(duration);
  const cutoff0 = dampingCutoff(p.damping);
  const fadeIn = Math.max(1, Math.round(0.002 * p.sampleRate)); // 2 ms: no click at the onset
  for (const state of states) {
    for (let n = from; n < to; n += 1) {
      const t = n / p.sampleRate;
      // Cutoff falls along the tail, faster with more damping.
      const cutoff = Math.max(200, cutoff0 * (1 - 0.7 * p.damping * (n / length)));
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / p.sampleRate);
      const white = state.random() * 2 - 1;
      state.lowpass += a * (white - state.lowpass);
      const envelope = Math.exp(-t / tau) * Math.min(1, n / fadeIn);
      state.data[n] = state.lowpass * envelope;
    }
  }
  void duration;
}

/** Peak-normalises every channel together to 0.9. */
function normalize(states: ChannelState[]): void {
  let peak = 0;
  for (const { data } of states) for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]!));
  if (peak <= 0) return;
  const gain = 0.9 / peak;
  for (const { data } of states) for (let i = 0; i < data.length; i += 1) data[i] = data[i]! * gain;
}

/**
 * Generates an impulse response synchronously (worker / tests).
 * @param params sample rate, room size, damping.
 * @returns the IR.
 */
export function generateImpulseResponse(params: ReverbIrParams): ImpulseResponse {
  const p = normalizeIrParams(params);
  const { states, length, duration } = prepare(p);
  fill(p, states, length, duration, 0, length);
  normalize(states);
  return { sampleRate: p.sampleRate, channels: states.map((s) => s.data), duration };
}

/** Samples per slice in the main-thread fallback (~5 ms of work). */
const SLICE = 16384;

/**
 * Generates an IR without blocking: slices of {@link SLICE} samples with a
 * macrotask yield between them.
 * @param params generator inputs.
 * @param signal aborts the job.
 * @returns the IR.
 */
export async function generateImpulseResponseSliced(params: ReverbIrParams, signal?: AbortSignal): Promise<ImpulseResponse> {
  const p = normalizeIrParams(params);
  const { states, length, duration } = prepare(p);
  for (let from = 0; from < length; from += SLICE) {
    if (signal?.aborted) throw new DOMException('IR cancelado', 'AbortError');
    fill(p, states, length, duration, from, Math.min(length, from + SLICE));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  normalize(states);
  return { sampleRate: p.sampleRate, channels: states.map((s) => s.data), duration };
}

/** Worker request type. */
export const REVERB_IR_REQUEST = 'reverb-ir';

/** Handlers served by `workers/reverb-worker.ts`. */
export function createReverbHandlers(): Record<string, WorkerHandler> {
  return {
    [REVERB_IR_REQUEST]: (payload, tools) => {
      const params = isIrParams(payload) ? payload : { sampleRate: 48000, roomSize: 0.5, damping: 0.5 };
      const result = generateImpulseResponse(params);
      // Move the tails instead of copying seconds of float samples.
      for (const channel of result.channels) tools.transfer.push(channel.buffer);
      return result;
    },
  };
}

function isIrParams(value: unknown): value is ReverbIrParams {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'sampleRate') === 'number';
}

function isImpulseResponse(value: unknown): value is ImpulseResponse {
  if (typeof value !== 'object' || value === null) return false;
  const channels: unknown = Reflect.get(value, 'channels');
  return Array.isArray(channels) && channels.every((c) => c instanceof Float32Array) && typeof Reflect.get(value, 'sampleRate') === 'number';
}

/** Cache key of an IR (rounded so slider jitter reuses tails). */
export function irCacheKey(params: ReverbIrParams): string {
  const p = normalizeIrParams(params);
  return `${p.sampleRate}:${p.channels}:${p.roomSize.toFixed(2)}:${p.damping.toFixed(2)}:${p.seed}`;
}

/** Async, cached IR provider: worker first, sliced main-thread fallback. */
export class ReverbIrProvider {
  private readonly cache = new Map<string, Promise<ImpulseResponse>>();
  private readonly client: WorkerClient | null;
  private readonly maxEntries: number;

  /**
   * @param workerFactory spawns the reverb worker (`null` = sliced fallback).
   * @param maxEntries cached tails kept (LRU by insertion).
   */
  constructor(workerFactory: (() => WorkerLike | null) | null = defaultWorkerFactory, maxEntries = 8) {
    this.client = workerFactory ? new WorkerClient(workerFactory) : null;
    this.maxEntries = maxEntries;
  }

  /**
   * The IR for a parameter set (generated once, then cached).
   * @param params generator inputs.
   * @returns the IR.
   */
  get(params: ReverbIrParams): Promise<ImpulseResponse> {
    const key = irCacheKey(params);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const job = this.generate(params).catch((error: unknown) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, job);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return job;
  }

  /** Stops the worker (it also stops itself after 30 s idle). */
  dispose(): void {
    this.client?.terminate('Generador de reverb cerrado');
    this.cache.clear();
  }

  private async generate(params: ReverbIrParams): Promise<ImpulseResponse> {
    if (this.client) {
      try {
        const reply = await this.client.request<unknown>(REVERB_IR_REQUEST, normalizeIrParams(params));
        if (isImpulseResponse(reply)) return reply;
      } catch {
        // Worker unavailable: fall through to the sliced path.
      }
    }
    return generateImpulseResponseSliced(params);
  }
}

function defaultWorkerFactory(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../../workers/reverb-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}
