// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Noise gate offline + its AudioWorklet twin. */

import { describe, expect, it } from 'vitest';
import {
  GATE_PROCESSOR,
  ensureGateWorklet,
  gateCoefficients,
  gateStep,
  gateWorkletReady,
  gateWorkletSource,
  processGate,
  sanitizeGate,
  type GateCoefficients,
  type GateState,
} from '../src/media/audio/noise-gate.ts';
import { bufferOf, rms, tone } from './f4-helpers.ts';

const PARAMS = { threshold: -40, attack: 1, hold: 20, release: 30, range: -80 };

function burstWithNoise(): Float32Array {
  const x = new Float32Array(48000);
  for (let i = 0; i < x.length; i += 1) x[i] = 0.001 * Math.sin(i * 1.7); // −60 dB hiss
  const burst = tone(440, 0.25, 48000, 0.5);
  x.set(burst, 12000);
  return x;
}

describe('processGate', () => {
  it('silences noise below threshold and passes signal above it', () => {
    const x = burstWithNoise();
    const { buffer, gain } = processGate(bufferOf([x]), PARAMS);
    const out = buffer.getChannelData(0);
    expect(rms(out, 0, 10000)).toBeLessThan(1e-6);
    expect(rms(out, 14000, 22000)).toBeCloseTo(rms(x, 14000, 22000), 3);
    expect(gain[18000]).toBeCloseTo(1, 3);
    // Hold keeps it open 20 ms after the burst, then it releases.
    expect(gain[24000 + 480]).toBeGreaterThan(0.9);
    expect(gain[40000]).toBeLessThan(0.01);
  });

  it('respects the range (partial attenuation)', () => {
    const x = burstWithNoise();
    const { gain } = processGate(bufferOf([x]), { ...PARAMS, range: -20 });
    expect(gain[5000]).toBeCloseTo(0.1, 2);
  });

  it('sanitises parameters', () => {
    expect(sanitizeGate({ threshold: 10, attack: 0, hold: -5, release: 1e9, range: -200 })).toEqual({
      threshold: 0, attack: 0.1, hold: 0, release: 5000, range: -100,
    });
    expect(gateCoefficients({ ...PARAMS, range: -100 }, 48000).floor).toBe(0);
  });
});

describe('AudioWorklet twin', () => {
  it('embeds the very same step function and processes identically', () => {
    const source = gateWorkletSource();
    expect(source).toContain(GATE_PROCESSOR);
    let Processor: (new (options: { processorOptions: { coefficients: GateCoefficients } }) => {
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    }) | null = null;
    class FakeBase {
      port: { onmessage: ((event: { data: GateCoefficients }) => void) | null } = { onmessage: null };
    }
    const register = (_name: string, ctor: typeof Processor) => {
      Processor = ctor;
    };
    new Function('AudioWorkletProcessor', 'registerProcessor', source)(FakeBase, register);
    expect(Processor).not.toBeNull();
    const coefficients = gateCoefficients(PARAMS, 48000);
    const processor = new Processor!({ processorOptions: { coefficients } });
    const x = burstWithNoise();
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) {
      const input = [x.subarray(i, i + 128)];
      const output = [new Float32Array(input[0]!.length)];
      expect(processor.process([input], [output])).toBe(true);
      out.set(output[0]!, i);
    }
    const offline = processGate(bufferOf([x]), PARAMS).buffer.getChannelData(0);
    for (let i = 0; i < x.length; i += 997) expect(out[i]).toBeCloseTo(offline[i]!, 6);
    expect(processor.process([[]], [[]])).toBe(true);
  });

  it('steps through open → hold → release', () => {
    const c = gateCoefficients({ ...PARAMS, hold: 0.0625 }, 16000); // 1 sample hold
    const s: GateState = { env: 0, gain: 0, hold: 0 };
    gateStep(s, 1, c);
    expect(s.hold).toBe(1);
    gateStep(s, 0, { ...c, detector: 0 });
    expect(s.hold).toBe(0);
  });

  it('registers the worklet once and reports unsupported platforms', async () => {
    expect(await ensureGateWorklet({ sampleRate: 48000 })).toBe(false);
    const modules: string[] = [];
    const original = URL.createObjectURL;
    const revoked: string[] = [];
    URL.createObjectURL = () => 'blob:gate';
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => revoked.push(url);
    try {
      const context = { sampleRate: 48000, audioWorklet: { addModule: async (url: string) => void modules.push(url) } };
      expect(await ensureGateWorklet(context)).toBe(true);
      expect(await ensureGateWorklet(context)).toBe(true);
      expect(modules).toEqual(['blob:gate']);
      expect(revoked).toEqual(['blob:gate']);
      expect(gateWorkletReady(context)).toBe(true);
      const failing = { sampleRate: 48000, audioWorklet: { addModule: async () => Promise.reject(new Error('x')) } };
      expect(await ensureGateWorklet(failing)).toBe(false);
    } finally {
      URL.createObjectURL = original;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
