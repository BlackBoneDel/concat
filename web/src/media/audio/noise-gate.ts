// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Noise gate with attack / hold / release and a range (floor) control.
 *
 * Per sample: a peak detector (instant rise, 10 ms fall) feeds a three-state
 * gate — open while the envelope is above threshold, held open for `hold`
 * after it drops, then closing towards the floor. The gain moves with
 * one-pole attack/release smoothing so it never clicks.
 *
 * The exact same step function runs offline ({@link processGate}) and inside
 * the realtime `AudioWorkletProcessor`: the worklet source embeds
 * `gateStep.toString()`, so the two cannot drift apart. The worklet module is
 * a Blob URL (no network) revoked right after `addModule`.
 */

import { copyChannels, createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';
import { clampParam, dbToGain, linkedPeak, timeCoefficient } from './dynamics.ts';

/** Gate settings. */
export interface NoiseGateParams {
  /** dBFS, −100…0. */
  threshold: number;
  /** Milliseconds, 0.1…200. */
  attack: number;
  /** Milliseconds, 0…2000. */
  hold: number;
  /** Milliseconds, 1…5000. */
  release: number;
  /** Attenuation when closed, dB, −100…0 (−100 ≈ silence). */
  range: number;
}

/** A dialogue-cleanup default. */
export const DEFAULT_NOISE_GATE: Readonly<NoiseGateParams> = Object.freeze({ threshold: -50, attack: 1, hold: 50, release: 120, range: -80 });

/**
 * Clamps every parameter into range.
 * @param params candidate.
 * @returns valid parameters.
 */
export function sanitizeGate(params: Partial<Record<keyof NoiseGateParams, unknown>>): NoiseGateParams {
  return {
    threshold: clampParam(params.threshold, -100, 0, DEFAULT_NOISE_GATE.threshold),
    attack: clampParam(params.attack, 0.1, 200, DEFAULT_NOISE_GATE.attack),
    hold: clampParam(params.hold, 0, 2000, DEFAULT_NOISE_GATE.hold),
    release: clampParam(params.release, 1, 5000, DEFAULT_NOISE_GATE.release),
    range: clampParam(params.range, -100, 0, DEFAULT_NOISE_GATE.range),
  };
}

/** Mutable per-stream gate state. */
export interface GateState {
  env: number;
  gain: number;
  hold: number;
}

/** Precomputed per-sample-rate coefficients. */
export interface GateCoefficients {
  threshold: number;
  floor: number;
  attack: number;
  release: number;
  detector: number;
  holdSamples: number;
}

/**
 * Coefficients for a sample rate.
 * @param params settings.
 * @param sampleRate samples per second.
 * @returns the coefficients.
 */
export function gateCoefficients(params: NoiseGateParams, sampleRate: number): GateCoefficients {
  const p = sanitizeGate(params);
  return {
    threshold: dbToGain(p.threshold),
    floor: p.range <= -100 ? 0 : dbToGain(p.range),
    attack: timeCoefficient(p.attack / 1000, sampleRate),
    release: timeCoefficient(p.release / 1000, sampleRate),
    detector: timeCoefficient(0.01, sampleRate),
    holdSamples: Math.round((p.hold / 1000) * sampleRate),
  };
}

/**
 * One gate step. Self-contained on purpose: its source is embedded verbatim
 * in the AudioWorklet module.
 * @param s state (mutated).
 * @param level |x| of this frame (stereo-linked).
 * @param c coefficients.
 * @returns the gain for this frame.
 */
export function gateStep(s: GateState, level: number, c: GateCoefficients): number {
  s.env = level > s.env ? level : s.env * c.detector;
  let target: number;
  if (s.env >= c.threshold) {
    s.hold = c.holdSamples;
    target = 1;
  } else if (s.hold > 0) {
    s.hold -= 1;
    target = 1;
  } else {
    target = c.floor;
  }
  const k = target > s.gain ? c.attack : c.release;
  s.gain = target + (s.gain - target) * k;
  return s.gain;
}

/**
 * Gates a buffer offline.
 * @param buffer the source.
 * @param params settings.
 * @returns the gated buffer and its gain curve.
 */
export function processGate(buffer: AudioBufferLike, params: NoiseGateParams): { buffer: AudioBufferLike; gain: Float32Array } {
  const c = gateCoefficients(params, buffer.sampleRate);
  const channels = copyChannels(buffer);
  const peak = linkedPeak(channels);
  const gain = new Float32Array(peak.length);
  const state: GateState = { env: 0, gain: c.floor, hold: 0 };
  for (let i = 0; i < peak.length; i += 1) {
    const g = gateStep(state, peak[i]!, c);
    gain[i] = g;
    for (const channel of channels) channel[i] = channel[i]! * g;
  }
  return { buffer: createAudioBuffer(channels, buffer.sampleRate), gain };
}

/** The name the worklet processor registers. */
export const GATE_PROCESSOR = 'concat-noise-gate';

/**
 * Source of the AudioWorklet module. Receives coefficients through
 * `processorOptions` and updates through the port.
 * @returns JavaScript source.
 */
export function gateWorkletSource(): string {
  return `
const gateStep = ${gateStep.toString()};
class ConcatNoiseGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.c = options.processorOptions.coefficients;
    this.s = { env: 0, gain: this.c.floor, hold: 0 };
    this.port.onmessage = (event) => { this.c = event.data; };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let level = 0;
      for (let ch = 0; ch < input.length; ch++) {
        const v = Math.abs(input[ch][i]);
        if (v > level) level = v;
      }
      const g = gateStep(this.s, level, this.c);
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = (input[ch] || input[0])[i] * g;
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(GATE_PROCESSOR)}, ConcatNoiseGate);
`;
}

/** The slice of `AudioContext` the realtime gate needs. */
export interface WorkletContextLike {
  readonly sampleRate: number;
  audioWorklet?: { addModule(url: string): Promise<void> };
}

/** Contexts whose worklet module is already registered. */
const registered = new WeakSet<object>();

/**
 * Registers the gate processor on a context (once).
 * @param context an `AudioContext`.
 * @returns false when the platform has no AudioWorklet (callers bake offline instead).
 */
export async function ensureGateWorklet(context: WorkletContextLike): Promise<boolean> {
  if (registered.has(context)) return true;
  if (!context.audioWorklet || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([gateWorkletSource()], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
    registered.add(context);
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Whether the gate worklet is ready on a context (sync check for graph building).
 * @param context the context.
 * @returns true once {@link ensureGateWorklet} succeeded.
 */
export function gateWorkletReady(context: object): boolean {
  return registered.has(context);
}
