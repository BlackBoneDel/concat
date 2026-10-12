// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 synthetic reverb tails: envelope, damping, determinism, worker/sliced paths, cache. */

import { describe, expect, it, vi } from 'vitest';
import {
  REVERB_IR_REQUEST,
  ReverbIrProvider,
  createReverbHandlers,
  dampingCutoff,
  decayTau,
  generateImpulseResponse,
  generateImpulseResponseSliced,
  irCacheKey,
  mulberry32,
  normalizeIrParams,
  reverbDuration,
} from '../src/media/effects/reverb-ir-generator.ts';
import { linkedWorker, rms } from './f4-helpers.ts';

const SR = 8000;

/** Mean |x| over a window (envelope estimate). */
function level(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += Math.abs(data[i]!);
  return sum / (to - from);
}

/** Mean |first difference|: high-frequency content. */
function roughness(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from + 1; i < to; i += 1) sum += Math.abs(data[i]! - data[i - 1]!);
  return sum / (to - from - 1);
}

describe('reverb parameters', () => {
  it('room size maps 0.05→0.3 s and 1→5 s; τ gives −60 dB at the end', () => {
    expect(reverbDuration(0.05)).toBeCloseTo(0.3);
    expect(reverbDuration(1)).toBeCloseTo(5);
    expect(reverbDuration(9)).toBeCloseTo(5);
    const tau = decayTau(2);
    expect(Math.exp(-2 / tau)).toBeCloseTo(0.001, 6);
    expect(dampingCutoff(0)).toBe(18000);
    expect(dampingCutoff(1)).toBe(1500);
  });

  it('normalises bad input', () => {
    expect(normalizeIrParams({ sampleRate: 10, roomSize: Number.NaN, damping: 4, channels: 7 })).toEqual({
      sampleRate: 48000,
      roomSize: 0.5,
      damping: 1,
      channels: 2,
      seed: 1,
    });
    expect(irCacheKey({ sampleRate: 48000, roomSize: 0.501, damping: 0.4 })).toBe(irCacheKey({ sampleRate: 48000, roomSize: 0.499, damping: 0.4 }));
  });

  it('mulberry32 is deterministic and uniform-ish', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(values.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()));
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(Math.max(...values)).toBeLessThan(1);
  });
});

describe('generateImpulseResponse', () => {
  const ir = generateImpulseResponse({ sampleRate: SR, roomSize: 0.4, damping: 0.3 });

  it('has the RT60 length, 2 channels and a 0.9 peak', () => {
    expect(ir.duration).toBeCloseTo(reverbDuration(0.4));
    expect(ir.channels).toHaveLength(2);
    expect(ir.channels[0]!.length).toBe(Math.round(ir.duration * SR));
    const peak = Math.max(...ir.channels.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    expect(peak).toBeCloseTo(0.9, 5);
    expect(ir.channels[0]).not.toEqual(ir.channels[1]); // decorrelated stereo
  });

  it('decays exponentially: ≈ −60 dB over the tail', () => {
    const data = ir.channels[0]!;
    const n = data.length;
    const win = Math.round(n * 0.05);
    const head = level(data, Math.round(0.01 * SR), Math.round(0.01 * SR) + win);
    const tail = level(data, n - win, n);
    const db = 20 * Math.log10(tail / head);
    expect(db).toBeLessThan(-45);
    expect(db).toBeGreaterThan(-75);
    // Monotone on average: quarter levels strictly decrease.
    const quarters = [0, 1, 2, 3].map((q) => rms(data, Math.round((q * n) / 4), Math.round(((q + 1) * n) / 4)));
    for (let q = 1; q < 4; q += 1) expect(quarters[q]!).toBeLessThan(quarters[q - 1]!);
  });

  it('fades in over 2 ms (no click) ', () => {
    expect(ir.channels[0]![0]).toBe(0);
  });

  it('damping removes high frequencies', () => {
    const bright = generateImpulseResponse({ sampleRate: 48000, roomSize: 0.1, damping: 0 }).channels[0]!;
    const dark = generateImpulseResponse({ sampleRate: 48000, roomSize: 0.1, damping: 1 }).channels[0]!;
    const span = (d: Float32Array) => roughness(d, 200, 4000) / level(d, 200, 4000);
    expect(span(dark)).toBeLessThan(span(bright) * 0.6);
  });

  it('is deterministic per seed', () => {
    const a = generateImpulseResponse({ sampleRate: SR, roomSize: 0.2, damping: 0.5, seed: 7 });
    const b = generateImpulseResponse({ sampleRate: SR, roomSize: 0.2, damping: 0.5, seed: 7 });
    const c = generateImpulseResponse({ sampleRate: SR, roomSize: 0.2, damping: 0.5, seed: 8 });
    expect(a.channels[0]).toEqual(b.channels[0]);
    expect(a.channels[0]).not.toEqual(c.channels[0]);
    expect(generateImpulseResponse({ sampleRate: SR, roomSize: 0.2, damping: 0.5, channels: 1 }).channels).toHaveLength(1);
  });

  it('the sliced async path equals the sync one and can be aborted', async () => {
    const params = { sampleRate: SR, roomSize: 0.9, damping: 0.2 };
    const sync = generateImpulseResponse(params);
    const sliced = await generateImpulseResponseSliced(params);
    expect(sliced.channels[0]).toEqual(sync.channels[0]);
    expect(sliced.channels[1]).toEqual(sync.channels[1]);
    const controller = new AbortController();
    controller.abort();
    await expect(generateImpulseResponseSliced(params, controller.signal)).rejects.toThrow(/cancelado/);
  });
});

describe('ReverbIrProvider', () => {
  it('generates in the worker, transferring the tails', async () => {
    const handlers = createReverbHandlers();
    const handler = vi.fn(handlers[REVERB_IR_REQUEST]!);
    const { worker } = linkedWorker({ [REVERB_IR_REQUEST]: handler });
    const provider = new ReverbIrProvider(() => worker);
    const ir = await provider.get({ sampleRate: SR, roomSize: 0.1, damping: 0.5 });
    expect(handler).toHaveBeenCalledOnce();
    expect(ir.channels[0]).toEqual(generateImpulseResponse({ sampleRate: SR, roomSize: 0.1, damping: 0.5 }).channels[0]);
    provider.dispose();
  });

  it('caches by rounded parameters and evicts the oldest (LRU)', async () => {
    const provider = new ReverbIrProvider(null, 2);
    const a1 = provider.get({ sampleRate: SR, roomSize: 0.1, damping: 0.1 });
    expect(provider.get({ sampleRate: SR, roomSize: 0.1001, damping: 0.1 })).toBe(a1);
    const b = provider.get({ sampleRate: SR, roomSize: 0.2, damping: 0.1 });
    provider.get({ sampleRate: SR, roomSize: 0.1, damping: 0.1 }); // touch a → b is now oldest
    provider.get({ sampleRate: SR, roomSize: 0.3, damping: 0.1 });
    expect(provider.get({ sampleRate: SR, roomSize: 0.1, damping: 0.1 })).toBe(a1);
    expect(provider.get({ sampleRate: SR, roomSize: 0.2, damping: 0.1 })).not.toBe(b);
    await a1;
    provider.dispose();
  });

  it('falls back to the sliced path when the worker fails', async () => {
    const { worker } = linkedWorker({
      [REVERB_IR_REQUEST]: () => {
        throw new Error('sin memoria');
      },
    });
    const provider = new ReverbIrProvider(() => worker);
    const ir = await provider.get({ sampleRate: SR, roomSize: 0.05, damping: 0 });
    expect(ir.channels[0]!.length).toBe(Math.round(0.3 * SR));
  });

  it('the worker handler tolerates junk payloads', () => {
    const transfer: Transferable[] = [];
    const result = createReverbHandlers()[REVERB_IR_REQUEST]!('junk', { progress: () => undefined, transfer });
    expect(transfer.length).toBe(2);
    expect(result).toHaveProperty('sampleRate', 48000);
  });
});
