// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 audio effects as Web Audio node graphs, chained in series after the
 * Fase 4 per-clip chain (EQ/dynamics) and before the track fader.
 *
 * - **Delay**: `in → DelayNode → Gain(feedback) ⟲ DelayNode` (the feedback
 *   loop), `DelayNode → Gain(mix) → out`, dry path `in → Gain(1 − mix) → out`.
 *   time 10–2000 ms, feedback 0–0.95 (never 1: the loop must decay), mix 0–1.
 * - **Reverb**: `ConvolverNode` fed with a synthetic IR
 *   (`reverb-ir-generator.ts`, generated asynchronously; the wet path is
 *   silent for the few ms until the tail is ready), wet/dry by `mix`.
 * - **Chorus**: a short `DelayNode` whose `delayTime` is swept by an LFO
 *   (`OscillatorNode → Gain(depth) → delayTime`), wet/dry by `mix`.
 *
 * Node types are structural (the slice used), so tests drive the graphs with
 * doubles and a real `AudioContext` satisfies them as-is.
 */

import type { AudioEffectInstance } from './effects-stack.ts';
import { effectIsNeutral } from './effects-stack.ts';
import type { ImpulseResponse, ReverbIrParams } from './reverb-ir-generator.ts';

/** An `AudioParam` slice. */
export interface FxParamLike {
  value: number;
  setValueAtTime?(value: number, time: number): unknown;
}

/** Any node: connect/disconnect. */
export interface FxNodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

/** A `GainNode` slice. */
export interface FxGainLike extends FxNodeLike {
  gain: FxParamLike;
}

/** A `DelayNode` slice. */
export interface FxDelayLike extends FxNodeLike {
  delayTime: FxParamLike;
}

/** A `ConvolverNode` slice. */
export interface FxConvolverLike extends FxNodeLike {
  buffer: unknown;
  normalize: boolean;
}

/** An `OscillatorNode` slice. */
export interface FxOscillatorLike extends FxNodeLike {
  frequency: FxParamLike;
  type: string;
  start(when?: number): void;
  stop(when?: number): void;
}

/** A buffer the convolver can take. */
export interface FxBufferLike {
  getChannelData?(channel: number): Float32Array;
  copyToChannel?(source: Float32Array<ArrayBuffer>, channel: number): void;
}

/** The context slice the chains need. */
export interface FxAudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  createGain(): FxGainLike;
  createDelay(maxDelayTime?: number): FxDelayLike;
  createConvolver(): FxConvolverLike;
  createOscillator(): FxOscillatorLike;
  createBuffer(channels: number, length: number, sampleRate: number): FxBufferLike;
}

/**
 * Whether a context can build the Fase 5 chains.
 * @param context anything (the mixer passes its graph context).
 * @returns true when every factory is present.
 */
export function isFxAudioContext(context: unknown): context is FxAudioContextLike {
  if (typeof context !== 'object' || context === null) return false;
  return ['createGain', 'createDelay', 'createConvolver', 'createOscillator', 'createBuffer'].every(
    (name) => typeof Reflect.get(context, name) === 'function',
  ) && typeof Reflect.get(context, 'sampleRate') === 'number';
}

/** One built effect: input/output nodes and a disposer. */
export interface FxUnit {
  input: FxNodeLike;
  output: FxNodeLike;
  dispose(): void;
}

/** Where reverb tails come from (async, cached). */
export interface IrSource {
  get(params: ReverbIrParams): Promise<ImpulseResponse>;
}

/** A dry/wet pair around a wet sub-graph. */
function wetDry(ctx: FxAudioContextLike, mix: number): { input: FxGainLike; output: FxGainLike; dry: FxGainLike; wet: FxGainLike } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const m = Math.min(1, Math.max(0, mix));
  dry.gain.value = 1 - m;
  wet.gain.value = m;
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  return { input, output, dry, wet };
}

/**
 * Delay with feedback loop.
 * @param ctx the audio context.
 * @param params time (ms), feedback, mix.
 * @returns the unit.
 */
export function createDelayEffect(ctx: FxAudioContextLike, params: { time: number; feedback: number; mix: number }): FxUnit {
  const io = wetDry(ctx, params.mix);
  const delay = ctx.createDelay(2.5);
  delay.delayTime.value = Math.min(2000, Math.max(10, params.time)) / 1000;
  const feedback = ctx.createGain();
  feedback.gain.value = Math.min(0.95, Math.max(0, params.feedback));
  io.input.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay); // the loop: each echo is `feedback` times the last
  delay.connect(io.wet);
  const nodes: FxNodeLike[] = [io.input, io.output, io.dry, io.wet, delay, feedback];
  return { input: io.input, output: io.output, dispose: () => nodes.forEach((node) => node.disconnect()) };
}

/**
 * Copies an IR into a context buffer.
 * @param ctx the audio context.
 * @param ir the tail.
 * @returns the buffer, or `null` when it cannot be filled.
 */
export function irToBuffer(ctx: FxAudioContextLike, ir: ImpulseResponse): FxBufferLike | null {
  const length = ir.channels[0]?.length ?? 0;
  if (length === 0) return null;
  const buffer = ctx.createBuffer(ir.channels.length, length, ir.sampleRate);
  ir.channels.forEach((data, channel) => {
    if (typeof buffer.copyToChannel === 'function') buffer.copyToChannel(new Float32Array(data), channel);
    else buffer.getChannelData?.(channel).set(data);
  });
  return buffer;
}

/**
 * Convolution reverb with a synthetic tail.
 * @param ctx the audio context.
 * @param params roomSize, damping, mix.
 * @param irs the tail provider.
 * @param onError reports a failed tail (the effect stays dry).
 * @returns the unit.
 */
export function createReverbEffect(ctx: FxAudioContextLike, params: { roomSize: number; damping: number; mix: number }, irs: IrSource, onError?: (error: unknown) => void): FxUnit {
  const io = wetDry(ctx, params.mix);
  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  io.input.connect(convolver);
  convolver.connect(io.wet);
  let disposed = false;
  irs.get({ sampleRate: ctx.sampleRate, roomSize: params.roomSize, damping: params.damping, channels: 2 }).then(
    (ir) => {
      if (disposed) return;
      const buffer = irToBuffer(ctx, ir);
      if (buffer) convolver.buffer = buffer;
    },
    (error: unknown) => onError?.(error),
  );
  const nodes: FxNodeLike[] = [io.input, io.output, io.dry, io.wet, convolver];
  return {
    input: io.input,
    output: io.output,
    dispose: () => {
      disposed = true;
      nodes.forEach((node) => node.disconnect());
    },
  };
}

/**
 * Chorus: an LFO-swept short delay.
 * @param ctx the audio context.
 * @param params rate (Hz), depth (ms), delay (ms), mix.
 * @returns the unit.
 */
export function createChorusEffect(ctx: FxAudioContextLike, params: { rate: number; depth: number; delay: number; mix: number }): FxUnit {
  const io = wetDry(ctx, params.mix);
  const delay = ctx.createDelay(0.1);
  const base = Math.min(40, Math.max(5, params.delay)) / 1000;
  const depth = Math.min(10, Math.max(0, params.depth)) / 1000;
  // Keep the swept delay positive: base − depth ≥ 1 ms.
  delay.delayTime.value = Math.max(base, depth + 0.001);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = Math.min(8, Math.max(0.05, params.rate));
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = depth;
  lfo.connect(lfoGain);
  lfoGain.connect(delay.delayTime);
  io.input.connect(delay);
  delay.connect(io.wet);
  lfo.start(ctx.currentTime);
  const nodes: FxNodeLike[] = [io.input, io.output, io.dry, io.wet, delay, lfoGain, lfo];
  return {
    input: io.input,
    output: io.output,
    dispose: () => {
      try {
        lfo.stop();
      } catch {
        // Already stopped.
      }
      nodes.forEach((node) => node.disconnect());
    },
  };
}

/** The realtime chain the mixer splices in (same shape as Fase 4's). */
export interface AudioStackChain {
  input: unknown;
  connect(destination: unknown): void;
  dispose(): void;
}

/**
 * Builds a clip's audio stack in series.
 * @param ctx the audio context.
 * @param stack the effects in signal order.
 * @param irs reverb tail provider.
 * @param onError reports async failures.
 * @returns the chain, or `null` when nothing is active.
 */
export function buildAudioStackChain(ctx: FxAudioContextLike, stack: readonly AudioEffectInstance[], irs: IrSource, onError?: (error: unknown) => void): AudioStackChain | null {
  const active = stack.filter((fx) => fx.enabled && !effectIsNeutral(fx));
  if (active.length === 0) return null;
  const head = ctx.createGain();
  let tail: FxNodeLike = head;
  const units: FxUnit[] = [];
  for (const fx of active) {
    const p = fx.params;
    let unit: FxUnit;
    switch (fx.type) {
      case 'delay':
        unit = createDelayEffect(ctx, { time: p['time'] ?? 350, feedback: p['feedback'] ?? 0.35, mix: p['mix'] ?? 0.35 });
        break;
      case 'reverb':
        unit = createReverbEffect(ctx, { roomSize: p['roomSize'] ?? 0.5, damping: p['damping'] ?? 0.4, mix: p['mix'] ?? 0.3 }, irs, onError);
        break;
      case 'chorus':
        unit = createChorusEffect(ctx, { rate: p['rate'] ?? 1.2, depth: p['depth'] ?? 3, delay: p['delay'] ?? 18, mix: p['mix'] ?? 0.5 });
        break;
      default:
        continue;
    }
    tail.connect(unit.input);
    tail = unit.output;
    units.push(unit);
  }
  const end = tail;
  return {
    input: head,
    connect: (destination) => {
      end.connect(destination);
    },
    dispose: () => {
      head.disconnect();
      for (const unit of units) unit.dispose();
    },
  };
}

/**
 * Two chains in series (Fase 4 chain → Fase 5 stack).
 * @param first the upstream chain (or null).
 * @param second the downstream chain (or null).
 * @returns the composite, or whichever exists.
 */
export function chainInSeries(first: AudioStackChain | null, second: AudioStackChain | null): AudioStackChain | null {
  if (!first) return second;
  if (!second) return first;
  first.connect(second.input);
  return {
    input: first.input,
    connect: (destination) => second.connect(destination),
    dispose: () => {
      first.dispose();
      second.dispose();
    },
  };
}
