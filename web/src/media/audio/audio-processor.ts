// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The audio-effects orchestrator.
 *
 * - **Offline** work (EBU R128 measurement, time stretch with preserved
 *   pitch, semitone shifts, full effect renders) runs in the DSP worker
 *   (`workers/pitch-worker.ts`) — or inline when workers are unavailable —
 *   and returns new buffers.
 * - **Realtime** playback gets a Web Audio node chain per clip
 *   ({@link AudioProcessor.buildRealtimeChain}) that the mixer inserts
 *   between the clip gain and the track gain (`player/audio-mixer.ts`,
 *   "Fase 4 hook").
 * - Variants that Web Audio cannot do live (pitch-preserving speed,
 *   transposition) are pre-rendered once per (buffer, rate, semitones) and
 *   cached; {@link AudioProcessor.variantFor} returns them synchronously once
 *   ready and `onVariantReady` lets the player reschedule.
 */

import { WorkerClient } from '../../workers/worker-client.ts';
import { type AudioEffects, isNeutralAudio, renderAudioEffects } from './audio-effects.ts';
import { createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';
import { createChannelRouting, type RoutingFactory, type RoutingNodeLike } from './channel-splitter.ts';
import { createCompressorChain } from './compressor.ts';
import { dbToGain, type CompressorNodeLike, type GainNodeLike } from './dynamics.ts';
import { Equalizer, type BiquadNodeLike } from './equalizer.ts';
import { createLimiterChain, type WaveShaperLike } from './limiter.ts';
import { GATE_PROCESSOR, gateCoefficients, gateWorkletReady } from './noise-gate.ts';
import { createPitchHandlers } from './pitch-worker.ts';
import { measureChannels, type LoudnessResult } from './normalizer.ts';

export {
  PlainAudioBuffer,
  copyChannels,
  createAudioBuffer,
  deinterleave,
  type AudioBufferLike,
} from './audio-buffer.ts';

/** The slice of `AudioContext` the realtime chain needs. */
export interface FxContextLike extends RoutingFactory {
  readonly sampleRate: number;
  createGain(): GainNodeLike & RoutingNodeLike;
  createBiquadFilter(): BiquadNodeLike;
  createDynamicsCompressor(): CompressorNodeLike;
  createWaveShaper(): WaveShaperLike;
}

/**
 * Narrows an audio context to {@link FxContextLike}.
 * @param context anything (the mixer's context).
 * @returns true when every factory exists.
 */
export function isFxContext(context: unknown): context is FxContextLike {
  if (typeof context !== 'object' || context === null) return false;
  return ['createGain', 'createBiquadFilter', 'createDynamicsCompressor', 'createWaveShaper', 'createChannelSplitter', 'createChannelMerger'].every(
    (name) => typeof Reflect.get(context, name) === 'function',
  );
}

/** A realtime chain the mixer splices in. */
export interface RealtimeChain {
  /** Connect the clip gain here. */
  input: unknown;
  /** Connects the chain's tail to the track gain. */
  connect(destination: unknown): void;
  /** Disconnects every node. */
  dispose(): void;
}

/** A pre-rendered variant request. */
export interface VariantSpec {
  /** Speed factor (1 = unchanged). */
  rate: number;
  preservePitch: boolean;
  semitones: number;
}

/** Options of {@link AudioProcessor}. */
export interface AudioProcessorOptions {
  /** RPC client of the DSP worker; a default module worker otherwise. */
  client?: WorkerClient;
}

/** Splits a buffer into copied channels. */
function channelsOf(buffer: AudioBufferLike): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) out.push(new Float32Array(buffer.getChannelData(c)));
  return out;
}

/** Cache key of a variant. */
function variantKey(spec: VariantSpec): string {
  return `${spec.rate.toFixed(6)}|${spec.preservePitch ? 1 : 0}|${spec.semitones}`;
}

/** Audio effects orchestration: worker jobs, variant cache, realtime chains. */
export class AudioProcessor {
  private readonly client: WorkerClient;
  private readonly variants = new WeakMap<object, Map<string, AudioBufferLike>>();
  private readonly inflight = new WeakMap<object, Map<string, Promise<AudioBufferLike>>>();
  /** Called when a requested variant finishes rendering. */
  onVariantReady: (() => void) | null = null;

  /**
   * @param options worker client override (tests).
   */
  constructor(options: AudioProcessorOptions = {}) {
    this.client =
      options.client ??
      new WorkerClient(() =>
        typeof Worker === 'undefined' ? null : new Worker(new URL('../../workers/pitch-worker.ts', import.meta.url), { type: 'module' }),
      );
  }

  /**
   * Measures EBU R128 loudness (worker, or inline fallback).
   * @param buffer the audio.
   * @returns the measurement.
   */
  async measureLoudness(buffer: AudioBufferLike): Promise<LoudnessResult> {
    const channels = channelsOf(buffer);
    if (this.client.available) {
      return this.client.request<LoudnessResult>('loudness', { channels, sampleRate: buffer.sampleRate }, channels.map((c) => c.buffer));
    }
    return measureChannels(channels, buffer.sampleRate);
  }

  /**
   * Renders speed/pitch changes.
   * @param buffer the source.
   * @param spec rate, mode and transposition.
   * @returns the new buffer.
   */
  async renderVariant(buffer: AudioBufferLike, spec: VariantSpec): Promise<AudioBufferLike> {
    const channels = channelsOf(buffer);
    const payload = { channels, sampleRate: buffer.sampleRate, rate: spec.rate, preservePitch: spec.preservePitch, semitones: spec.semitones };
    const handlers = createPitchHandlers();
    const out = this.client.available
      ? await this.client.request<Float32Array[]>('stretch', payload, channels.map((c) => c.buffer))
      : await Promise.resolve(handlers['stretch']!(payload, { progress: () => undefined, transfer: [] }));
    if (!Array.isArray(out) || !out.every((c) => c instanceof Float32Array)) throw new Error('Respuesta de audio inválida');
    return createAudioBuffer(out.filter((c): c is Float32Array => c instanceof Float32Array), buffer.sampleRate);
  }

  /**
   * Renders the whole effect chain offline (export).
   * @param buffer the source.
   * @param effects the effects.
   * @returns the processed buffer.
   */
  async renderEffects(buffer: AudioBufferLike, effects: AudioEffects): Promise<AudioBufferLike> {
    if (!this.client.available) return renderAudioEffects(buffer, effects);
    const channels = channelsOf(buffer);
    const out = await this.client.request<Float32Array[]>('render', { channels, sampleRate: buffer.sampleRate, effects }, channels.map((c) => c.buffer));
    return createAudioBuffer(out, buffer.sampleRate);
  }

  /**
   * A cached variant, or `null` (and a background render is started).
   * @param buffer the source buffer (identity is the cache key).
   * @param spec the variant.
   * @returns the ready buffer or `null`.
   */
  variantFor(buffer: AudioBufferLike, spec: VariantSpec): AudioBufferLike | null {
    const key = variantKey(spec);
    const ready = this.variants.get(buffer)?.get(key);
    if (ready) return ready;
    void this.requestVariant(buffer, spec).catch(() => undefined);
    return null;
  }

  /**
   * Renders (once) and caches a variant.
   * @param buffer the source buffer.
   * @param spec the variant.
   * @returns the rendered buffer.
   */
  requestVariant(buffer: AudioBufferLike, spec: VariantSpec): Promise<AudioBufferLike> {
    const key = variantKey(spec);
    const ready = this.variants.get(buffer)?.get(key);
    if (ready) return Promise.resolve(ready);
    let pending = this.inflight.get(buffer);
    if (!pending) {
      pending = new Map();
      this.inflight.set(buffer, pending);
    }
    const existing = pending.get(key);
    if (existing) return existing;
    const job = this.renderVariant(buffer, spec).then(
      (result) => {
        let map = this.variants.get(buffer);
        if (!map) {
          map = new Map();
          this.variants.set(buffer, map);
        }
        map.set(key, result);
        pending?.delete(key);
        this.onVariantReady?.();
        return result;
      },
      (error: unknown) => {
        pending?.delete(key);
        throw error instanceof Error ? error : new Error(String(error));
      },
    );
    pending.set(key, job);
    return job;
  }

  /**
   * Builds the realtime node chain for a clip's effects.
   * @param context the mixer's audio context.
   * @param effects the clip's effects.
   * @returns the chain, or `null` when nothing needs processing or the context lacks the nodes.
   */
  buildRealtimeChain(context: unknown, effects: AudioEffects): RealtimeChain | null {
    if (!isFxContext(context)) return null;
    const live: AudioEffects = { ...effects, semitones: 0 }; // transposition is a pre-rendered variant
    if (isNeutralAudio(live)) return null;
    const nodes: { connect(destination: unknown): unknown; disconnect(): void }[] = [];
    const disposers: (() => void)[] = [];
    const input = context.createGain();
    let tail: { connect(destination: unknown): unknown } = input;
    nodes.push(input);
    const append = (head: unknown, newTail: { connect(destination: unknown): unknown }): void => {
      tail.connect(head);
      tail = newTail;
    };
    if (live.channelMode !== 'stereo') {
      const routing = createChannelRouting(context, live.channelMode);
      append(routing.input, routing.output);
      disposers.push(routing.dispose);
    }
    if (live.gate && gateWorkletReady(context) && typeof AudioWorkletNode !== 'undefined' && typeof BaseAudioContext !== 'undefined' && context instanceof BaseAudioContext) {
      const node = new AudioWorkletNode(context, GATE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { coefficients: gateCoefficients(live.gate, context.sampleRate) },
      });
      append(node, node);
      nodes.push(node);
    }
    if (live.eq && live.eq.length > 0) {
      const eqNodes = new Equalizer(live.eq).createNodes(() => context.createBiquadFilter());
      const first = eqNodes[0];
      const last = eqNodes[eqNodes.length - 1];
      if (first && last) {
        append(first, last);
        nodes.push(...eqNodes);
      }
    }
    if (live.compressor) {
      const chain = createCompressorChain(() => context.createDynamicsCompressor(), () => context.createGain(), live.compressor);
      append(chain.input, chain.output);
      disposers.push(chain.dispose);
    }
    if (live.normalize?.gainDb) {
      const gain = context.createGain();
      gain.gain.value = dbToGain(live.normalize.gainDb);
      append(gain, gain);
      nodes.push(gain);
    }
    if (live.limiter) {
      const chain = createLimiterChain(() => context.createDynamicsCompressor(), () => context.createWaveShaper(), live.limiter);
      append(chain.input, chain.output);
      disposers.push(chain.dispose);
    }
    const end = tail;
    return {
      input,
      connect: (destination) => {
        end.connect(destination);
      },
      dispose: () => {
        for (const node of nodes) node.disconnect();
        for (const dispose of disposers) dispose();
      },
    };
  }

  /** Terminates the worker. */
  terminate(): void {
    this.client.terminate('Procesador de audio cerrado');
  }
}
