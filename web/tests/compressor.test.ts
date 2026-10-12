// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Feed-forward compressor (Giannoulis et al. 2012). */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPRESSOR,
  compressorCurve,
  createCompressorChain,
  processCompressor,
  sanitizeCompressor,
} from '../src/media/audio/compressor.ts';
import { dbToGain, gainToDb, timeCoefficient } from '../src/media/audio/dynamics.ts';
import { bufferOf, rms, tone } from './f4-helpers.ts';

const P = { threshold: -20, ratio: 4, knee: 0, attack: 0.001, release: 0.05, makeupGain: 0 };

describe('static curve', () => {
  it('is unity below threshold and 1/ratio above', () => {
    expect(compressorCurve(-30, P)).toBe(-30);
    expect(compressorCurve(-20, P)).toBe(-20);
    expect(compressorCurve(-4, P)).toBeCloseTo(-16, 12);
    expect(compressorCurve(0, { ...P, ratio: 20 })).toBeCloseTo(-19, 12);
  });

  it('rounds the corner with a quadratic soft knee', () => {
    const soft = { ...P, knee: 10 };
    expect(compressorCurve(-26, soft)).toBe(-26); // below knee
    expect(compressorCurve(-20, soft)).toBeCloseTo(-20 + ((0.25 - 1) * 25) / 20, 12);
    expect(compressorCurve(-14, soft)).toBeCloseTo(-20 + 6 / 4, 12); // above knee
    // Continuous at both knee edges.
    expect(compressorCurve(-25.0001, soft)).toBeCloseTo(compressorCurve(-24.9999, soft), 3);
    expect(compressorCurve(-15.0001, soft)).toBeCloseTo(compressorCurve(-14.9999, soft), 3);
  });
});

describe('processCompressor', () => {
  it('reduces a loud tone by the expected amount and leaves quiet ones alone', () => {
    const loud = tone(1000, 1, 48000, dbToGain(-4)); // peak −4 dBFS → 16 dB over → −12 dB GR
    const { buffer, reduction } = processCompressor(bufferOf([loud]), P);
    const steady = rms(buffer.getChannelData(0), 24000, 48000) / rms(loud, 24000, 48000);
    expect(gainToDb(steady)).toBeCloseTo(-12, 0);
    expect(reduction[40000]).toBeCloseTo(-12, 0);
    const quiet = tone(1000, 0.2, 48000, dbToGain(-30));
    const untouched = processCompressor(bufferOf([quiet]), P).buffer.getChannelData(0);
    expect(Math.max(...untouched.map((v, i) => Math.abs(v - quiet[i]!)))).toBeLessThan(1e-6);
  });

  it('applies make-up gain and links stereo detection', () => {
    const left = tone(1000, 0.5, 48000, dbToGain(-4));
    const right = new Float32Array(left.length);
    const out = processCompressor(bufferOf([left, right]), { ...P, makeupGain: 6 }).buffer;
    expect(Math.max(...out.getChannelData(1))).toBe(0);
    const ratio = rms(out.getChannelData(0), 12000, 24000) / rms(left, 12000, 24000);
    expect(gainToDb(ratio)).toBeCloseTo(-6, 0);
  });

  it('sanitises parameters and builds the realtime chain', () => {
    expect(sanitizeCompressor({ ratio: 100, threshold: 'x', attack: -1 })).toEqual({ ...DEFAULT_COMPRESSOR, ratio: 20, attack: 0 });
    const log: string[] = [];
    const param = () => ({ value: 0 });
    const compressor = { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect: () => log.push('c->g'), disconnect: () => log.push('xc') };
    const gain = { gain: param(), connect: () => undefined, disconnect: () => log.push('xg') };
    const chain = createCompressorChain(() => compressor, () => gain, { ...P, makeupGain: 6 });
    expect(compressor.threshold.value).toBe(-20);
    expect(compressor.ratio.value).toBe(4);
    expect(gain.gain.value).toBeCloseTo(dbToGain(6), 9);
    chain.dispose();
    expect(log).toEqual(['c->g', 'xc', 'xg']);
    expect(timeCoefficient(0, 48000)).toBe(0);
    expect(gainToDb(0)).toBe(-200);
  });
});
