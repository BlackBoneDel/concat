// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Brick-wall look-ahead limiter. */

import { describe, expect, it } from 'vitest';
import { dbToGain } from '../src/media/audio/dynamics.ts';
import { clipCurve, createLimiterChain, processLimiter, sanitizeLimiter, slidingMin } from '../src/media/audio/limiter.ts';
import { bufferOf, tone } from './f4-helpers.ts';

describe('processLimiter', () => {
  it('never lets a sample exceed the ceiling', () => {
    const x = tone(100, 1, 48000, 1.8);
    for (let i = 20000; i < 20010; i += 1) x[i] = 3; // spikes
    const out = processLimiter(bufferOf([x, new Float32Array(x)]), { ceiling: -1, lookahead: 5, release: 50 });
    const ceiling = dbToGain(-1);
    for (let c = 0; c < 2; c += 1) {
      for (const v of out.buffer.getChannelData(c)) expect(Math.abs(v)).toBeLessThanOrEqual(ceiling + 1e-7);
    }
  });

  it('starts reducing before the peak (look-ahead) and recovers after (release)', () => {
    const x = new Float32Array(48000).fill(0.1);
    x[24000] = 2;
    const { gain } = processLimiter(bufferOf([x]), { ceiling: -1, lookahead: 5, release: 20 });
    expect(gain[24000]).toBeLessThanOrEqual(dbToGain(-1) / 2 + 1e-7);
    expect(gain[24000 - 120]).toBeLessThan(1); // 2.5 ms earlier
    expect(gain[24000 - 600]).toBe(1); // outside look-ahead (2 × radius)
    expect(gain[47999]).toBeGreaterThan(0.99);
  });

  it('is transparent below the ceiling', () => {
    const x = tone(440, 0.5, 48000, 0.5);
    const out = processLimiter(bufferOf([x]), { ceiling: -1, lookahead: 0, release: 100 }).buffer.getChannelData(0);
    expect(Array.from(out)).toEqual(Array.from(x));
  });

  it('computes sliding minima in O(n)', () => {
    expect(Array.from(slidingMin(Float32Array.of(5, 3, 4, 1, 6, 7, 8), 1))).toEqual([3, 3, 1, 1, 1, 6, 7]);
    expect(Array.from(slidingMin(Float32Array.of(2, 1), 0))).toEqual([2, 1]);
  });

  it('sanitises and builds the realtime compressor + clipper', () => {
    expect(sanitizeLimiter({ ceiling: 3, lookahead: 50, release: 0 })).toEqual({ ceiling: 0, lookahead: 20, release: 1 });
    const curve = clipCurve(0.5, 5);
    expect(Array.from(curve)).toEqual([-0.5, -0.5, 0, 0.5, 0.5]);
    const param = () => ({ value: 0 });
    const compressor = { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect: () => undefined, disconnect: () => undefined };
    const shaper: { curve: Float32Array | null; oversample: OverSampleType; connect: () => undefined; disconnect: () => undefined } = {
      curve: null, oversample: 'none', connect: () => undefined, disconnect: () => undefined,
    };
    const chain = createLimiterChain(() => compressor, () => shaper, { ceiling: -1, lookahead: 5, release: 100 });
    expect(compressor.ratio.value).toBe(20);
    expect(compressor.knee.value).toBe(0);
    expect(shaper.oversample).toBe('4x');
    expect(Math.max(...shaper.curve!)).toBeCloseTo(dbToGain(-1), 6);
    chain.dispose();
  });
});
