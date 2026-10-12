// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Parametric EQ over RBJ biquads. */

import { describe, expect, it } from 'vitest';
import { biquadMagnitude, designBiquad } from '../src/media/audio/biquad.ts';
import { DEFAULT_EQ_BANDS, Equalizer, parseBands, validateBand, type BiquadNodeLike } from '../src/media/audio/equalizer.ts';
import { bufferOf, rms, tone } from './f4-helpers.ts';

const SR = 48000;

describe('biquad design', () => {
  it('matches cookbook responses at key frequencies', () => {
    const peak = designBiquad('peaking', 1000, 1, 6, SR);
    expect(20 * Math.log10(biquadMagnitude(peak, 1000, SR))).toBeCloseTo(6, 6);
    const hp = designBiquad('highpass', 80, Math.SQRT1_2, 0, SR);
    expect(20 * Math.log10(biquadMagnitude(hp, 80, SR))).toBeCloseTo(-3.01, 1);
    expect(biquadMagnitude(hp, 10000, SR)).toBeCloseTo(1, 3);
    const lp = designBiquad('lowpass', 1000, Math.SQRT1_2, 0, SR);
    expect(biquadMagnitude(lp, 10, SR)).toBeCloseTo(1, 3);
    const shelf = designBiquad('highshelf', 12000, Math.SQRT1_2, 6, SR);
    expect(20 * Math.log10(biquadMagnitude(shelf, 20000, SR))).toBeGreaterThan(5);
    const low = designBiquad('lowshelf', 100, Math.SQRT1_2, -6, SR);
    expect(20 * Math.log10(biquadMagnitude(low, 20, SR))).toBeLessThan(-5);
    const notch = designBiquad('notch', 1000, 10, 0, SR);
    expect(biquadMagnitude(notch, 1000, SR)).toBeLessThan(1e-6);
    const band = designBiquad('bandpass', 1000, 1, 0, SR);
    expect(biquadMagnitude(band, 1000, SR)).toBeCloseTo(1, 6);
  });
});

describe('Equalizer', () => {
  it('ships the HP80 / 250 / 1k / 4k / shelf 12k default and is flat by default', () => {
    const eq = new Equalizer();
    expect(eq.bands.map((b) => [b.type, b.frequency])).toEqual([
      ['highpass', 80], ['peaking', 250], ['peaking', 1000], ['peaking', 4000], ['highshelf', 12000],
    ]);
    expect(eq.isFlat).toBe(false); // the high-pass always shapes
    expect(new Equalizer(DEFAULT_EQ_BANDS.slice(1)).isFlat).toBe(true);
  });

  it('boosts a 1 kHz tone by 6 dB offline and cuts rumble with the high-pass', () => {
    const eq = new Equalizer(DEFAULT_EQ_BANDS);
    eq.setBand(2, { gain: 6 });
    const out = eq.process(bufferOf([tone(1000, 1)]));
    const ratio = rms(out.getChannelData(0), 9600, 48000) / rms(tone(1000, 1), 9600, 48000);
    expect(20 * Math.log10(ratio)).toBeCloseTo(6, 0);
    const rumble = eq.process(bufferOf([tone(20, 2)]));
    expect(rms(rumble.getChannelData(0), 48000, 96000)).toBeLessThan(0.354 * 0.1);
    const response = eq.frequencyResponse([1000, 20], SR);
    expect(response[0]).toBeCloseTo(6, 0);
    expect(response[1]).toBeLessThan(-20);
  });

  it('validates frequency 20–20000 Hz, Q 0.1–100 and gain ±24', () => {
    expect(() => validateBand({ type: 'peaking', frequency: 10, gain: 0, q: 1, enabled: true })).toThrow(/20–20000/);
    expect(() => validateBand({ type: 'peaking', frequency: 30000, gain: 0, q: 1, enabled: true })).toThrow();
    expect(() => validateBand({ type: 'peaking', frequency: 1000, gain: 0, q: 0.05, enabled: true })).toThrow(/Q/);
    expect(() => validateBand({ type: 'peaking', frequency: 1000, gain: 0, q: 101, enabled: true })).toThrow();
    expect(() => validateBand({ type: 'peaking', frequency: 1000, gain: 30, q: 1, enabled: true })).toThrow(/24/);
    const eq = new Equalizer();
    expect(() => eq.setBand(9, { gain: 1 })).toThrow(/inexistente/);
    expect(() => eq.setBand(1, { q: 0 })).toThrow();
  });

  it('parses bands from JSON dropping invalid entries', () => {
    const bands = parseBands([{ type: 'lowpass', frequency: 5000, q: 0.7 }, { frequency: 5 }, null, { type: 'weird', frequency: 400, gain: 3 }]);
    expect(bands).toEqual([
      { type: 'lowpass', frequency: 5000, gain: 0, q: 0.7, enabled: true },
      { type: 'peaking', frequency: 400, gain: 3, q: 1, enabled: true },
    ]);
    expect(parseBands('nope')).toEqual([]);
  });

  it('builds a connected BiquadFilterNode chain for enabled bands', () => {
    const connections: [number, number][] = [];
    let id = 0;
    const make = (): BiquadNodeLike & { id: number } => {
      const node = {
        id: id++,
        type: 'peaking' as BiquadFilterType,
        frequency: { value: 0 },
        Q: { value: 0 },
        gain: { value: 0 },
        connect: (dest: unknown) => {
          if (typeof dest === 'object' && dest !== null && 'id' in dest && typeof dest.id === 'number') connections.push([node.id, dest.id]);
          return dest;
        },
        disconnect: () => undefined,
      };
      return node;
    };
    const eq = new Equalizer(DEFAULT_EQ_BANDS);
    eq.setBand(3, { enabled: false });
    const nodes = eq.createNodes(make);
    expect(nodes.map((n) => n.frequency.value)).toEqual([80, 250, 1000, 12000]);
    expect(nodes[0]!.type).toBe('highpass');
    expect(connections).toEqual([[0, 1], [1, 2], [2, 3]]);
  });
});
