// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Speed with/without pitch preservation (port of Rust `speed_filters`). */

import { describe, expect, it } from 'vitest';
import { FFT, hann } from '../src/media/audio/fft.ts';
import {
  PitchShifter,
  checkRate,
  processChannels,
  resample,
  shiftPitchChannels,
  timeStretch,
} from '../src/media/audio/pitch-shift.ts';
import { bufferOf, rms, tone, zeroCrossingFrequency } from './f4-helpers.ts';

const SR = 48000;

describe('PitchShifter', () => {
  it('440 Hz at 2× without preservation becomes 880 Hz and half as long', () => {
    const out = new PitchShifter().process(bufferOf([tone(440, 1)]), { rate: 2, preservePitch: false });
    expect(out.length).toBe(SR / 2);
    expect(zeroCrossingFrequency(out.getChannelData(0), SR)).toBeCloseTo(880, -1);
  });

  it('440 Hz at 2× with preservation stays at 440 Hz and is half as long', () => {
    const out = new PitchShifter().process(bufferOf([tone(440, 2)]), { rate: 2, preservePitch: true });
    expect(out.length).toBe(SR);
    expect(Math.abs(zeroCrossingFrequency(out.getChannelData(0), SR) - 440)).toBeLessThan(3);
    // Energy preserved (no window modulation): RMS of a 0.5 sine is 0.354.
    expect(rms(out.getChannelData(0), 4800, 43200)).toBeCloseTo(0.354, 1);
  });

  it('slows down to 0.5× with and without preservation', () => {
    const x = tone(440, 1);
    const tape = resample(x, 0.5);
    expect(tape.length).toBe(2 * SR);
    expect(zeroCrossingFrequency(tape, SR)).toBeCloseTo(220, -1);
    const stretched = timeStretch(x, 0.5);
    expect(stretched.length).toBe(2 * SR);
    expect(Math.abs(zeroCrossingFrequency(stretched, SR) - 440)).toBeLessThan(3);
  });

  it('covers the full 0.25–4× range and rejects outside it', () => {
    const x = tone(300, 0.5);
    for (const rate of [0.25, 4]) {
      const [out] = processChannels([x], { rate, preservePitch: true });
      expect(out!.length).toBe(Math.round(x.length / rate));
    }
    expect(() => checkRate(0.2)).toThrow(/0.25–4/);
    expect(() => checkRate(4.5)).toThrow();
    expect(() => checkRate(Number.NaN)).toThrow();
  });

  it('is an identity at 1× and handles empty input', () => {
    const x = tone(440, 0.1);
    expect(Array.from(timeStretch(x, 1))).toEqual(Array.from(x));
    expect(timeStretch(new Float32Array(0), 2).length).toBe(0);
    expect(resample(new Float32Array(0), 2).length).toBe(0);
  });

  it('transposes by semitones keeping the duration', () => {
    const shifter = new PitchShifter();
    const up = shifter.shift(bufferOf([tone(440, 1)]), 12);
    expect(up.length).toBe(SR);
    expect(Math.abs(zeroCrossingFrequency(up.getChannelData(0), SR) - 880)).toBeLessThan(8);
    const same = shiftPitchChannels([tone(440, 0.1)], 0);
    expect(same[0]!.length).toBe(4800);
    expect(() => shiftPitchChannels([tone(440, 0.1)], 30)).toThrow(/semitonos/);
  });

  it('runs faster than half real time', () => {
    const x = tone(440, 10);
    const t0 = performance.now();
    timeStretch(x, 1.5);
    const elapsed = (performance.now() - t0) / 1000;
    expect(elapsed).toBeLessThan(5); // 10 s of audio < 0.5× real time
  });
});

describe('FFT', () => {
  it('round-trips and finds a bin', () => {
    const fft = new FFT(64);
    const re = new Float64Array(64);
    const im = new Float64Array(64);
    for (let i = 0; i < 64; i += 1) re[i] = Math.cos((2 * Math.PI * 4 * i) / 64);
    const copy = Float64Array.from(re);
    fft.transform(re, im);
    expect(re[4]).toBeCloseTo(32, 6);
    expect(Math.abs(re[5]!)).toBeLessThan(1e-9);
    fft.transform(re, im, true);
    for (let i = 0; i < 64; i += 1) expect(re[i]).toBeCloseTo(copy[i]!, 9);
    expect(() => new FFT(100)).toThrow();
    const w = hann(4);
    expect(Array.from(w)).toEqual([0, 0.5, 1, 0.5].map((v) => expect.closeTo(v, 12)));
  });
});
