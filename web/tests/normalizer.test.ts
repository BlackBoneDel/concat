// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** EBU R128 / BS.1770-4 loudness and normalisation. */

import { describe, expect, it } from 'vitest';
import {
  AudioNormalizer,
  LOUDNESS_TARGETS,
  channelWeights,
  kWeightingFilters,
  measureChannels,
  normalizationGain,
  truePeakOf,
} from '../src/media/audio/normalizer.ts';
import { bufferOf, tone } from './f4-helpers.ts';

const A23 = 10 ** (-23 / 20);

describe('EBU R128 measurement', () => {
  it('reproduces the BS.1770 48 kHz K-weighting table', () => {
    const [shelf, hp] = kWeightingFilters(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 9);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 9);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 9);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 9);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 9);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 9);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 9);
  });

  it('measures a stereo 1 kHz sine at −23 dBFS as −23.0 LUFS (±0.1)', () => {
    const sine = tone(1000, 20, 48000, A23);
    const m = measureChannels([sine, new Float32Array(sine)], 48000);
    expect(Math.abs(m.integrated - -23)).toBeLessThan(0.1);
    expect(Math.abs(m.momentaryMax - -23)).toBeLessThan(0.1);
    expect(Math.abs(m.shortTermMax - -23)).toBeLessThan(0.1);
    expect(m.range).toBeLessThan(0.1);
    expect(m.samplePeak).toBeCloseTo(-23, 1);
  });

  it('works at 44.1 kHz and for mono (−3 dB vs stereo)', () => {
    const m = measureChannels([tone(1000, 10, 44100, A23)], 44100);
    expect(Math.abs(m.integrated - -26.01)).toBeLessThan(0.1);
  });

  it('gates silence and quiet passages (absolute −70, relative −10 LU)', () => {
    expect(measureChannels([new Float32Array(48000 * 2)], 48000).integrated).toBe(-Infinity);
    // 10 s at −23 then 10 s at −60: the quiet half is below the relative gate.
    const loud = tone(1000, 10, 48000, A23);
    const quiet = tone(1000, 10, 48000, 10 ** (-60 / 20));
    const joined = new Float32Array(loud.length + quiet.length);
    joined.set(loud);
    joined.set(quiet, loud.length);
    const m = measureChannels([joined, new Float32Array(joined)], 48000);
    expect(Math.abs(m.integrated - -23)).toBeLessThan(0.2);
    expect(m.range).toBeGreaterThan(0);
  });

  it('computes LRA between percentiles of short-term loudness', () => {
    const a = tone(1000, 10, 48000, A23);
    const b = tone(1000, 10, 48000, 10 ** (-33 / 20));
    const joined = new Float32Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    const m = measureChannels([joined, new Float32Array(joined)], 48000);
    expect(m.range).toBeGreaterThan(8);
    expect(m.range).toBeLessThan(11);
  });

  it('detects inter-sample peaks with 4× oversampling', () => {
    const q = new Float32Array(4800);
    for (let i = 0; i < q.length; i += 1) q[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
    expect(20 * Math.log10(truePeakOf(q))).toBeGreaterThan(-0.3); // sample peak is −3 dB
    expect(Math.max(...q)).toBeLessThan(0.71);
  });

  it('weights channels like BS.1770', () => {
    expect(channelWeights(2)).toEqual([1, 1]);
    expect(channelWeights(6)).toEqual([1, 1, 1, 0, 1.41, 1.41]);
  });
});

describe('AudioNormalizer', () => {
  it('normalises to −14 LUFS respecting the true-peak ceiling', () => {
    const normalizer = new AudioNormalizer();
    const quiet = bufferOf([tone(1000, 5, 48000, 0.05), tone(1000, 5, 48000, 0.05)]);
    const { buffer, gainDb } = normalizer.normalize(quiet, { mode: 'loudness', target: LOUDNESS_TARGETS.streaming });
    expect(gainDb).toBeGreaterThan(0);
    expect(Math.abs(normalizer.measure(buffer).integrated - -14)).toBeLessThan(0.1);
    // A hot signal is capped by the −1 dBTP ceiling instead.
    const hot = bufferOf([tone(1000, 5, 48000, 0.7), tone(1000, 5, 48000, 0.7)]);
    const capped = normalizer.normalize(hot, { mode: 'loudness', target: 0, truePeakCeiling: -1 });
    expect(normalizer.measure(capped.buffer).truePeak).toBeLessThanOrEqual(-0.95);
  });

  it('peak-normalises and leaves silence alone', () => {
    const normalizer = new AudioNormalizer();
    const { buffer } = normalizer.normalize(bufferOf([tone(1000, 1, 48000, 0.25)]), { mode: 'peak', target: -1 });
    expect(normalizer.measure(buffer).samplePeak).toBeCloseTo(-1, 2);
    const silent = normalizer.measure(bufferOf([new Float32Array(48000)]));
    expect(normalizationGain(silent, { mode: 'loudness', target: -23 })).toBe(0);
    expect(normalizationGain(silent, { mode: 'peak', target: -1 })).toBe(0);
  });
});
