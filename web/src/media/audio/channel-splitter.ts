// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Channel routing: split, merge, mono fold-down, swap, and per-channel picks.
 *
 * Offline functions work on {@link AudioBufferLike}; {@link createChannelRouting}
 * builds the matching realtime graph from `ChannelSplitterNode`/`ChannelMergerNode`.
 * The equal-power pan law follows the Web Audio spec's `StereoPannerNode`.
 */

import { createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';

/** How a clip's channels are routed. */
export type ChannelMode = 'stereo' | 'mono' | 'left' | 'right' | 'swap';

/** Every mode, in UI order. */
export const CHANNEL_MODES: readonly ChannelMode[] = ['stereo', 'mono', 'left', 'right', 'swap'];

/** Spanish UI labels. */
export const CHANNEL_MODE_LABELS: Readonly<Record<ChannelMode, string>> = {
  stereo: 'Estéreo',
  mono: 'Mono (suma)',
  left: 'Solo izquierdo',
  right: 'Solo derecho',
  swap: 'Intercambiar L/R',
};

/** Narrows a value to a mode. */
export function isChannelMode(value: unknown): value is ChannelMode {
  return typeof value === 'string' && (CHANNEL_MODES as readonly string[]).includes(value);
}

/**
 * One mono buffer per channel.
 * @param buffer the source.
 * @returns mono buffers.
 */
export function splitChannels(buffer: AudioBufferLike): AudioBufferLike[] {
  const out: AudioBufferLike[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) out.push(createAudioBuffer([new Float32Array(buffer.getChannelData(c))], buffer.sampleRate));
  return out;
}

/**
 * Joins mono buffers into one multichannel buffer (padding shorter ones).
 * @param buffers inputs (same sample rate).
 * @returns the merged buffer.
 */
export function mergeChannels(buffers: readonly AudioBufferLike[]): AudioBufferLike {
  const first = buffers[0];
  if (!first) throw new RangeError('No hay canales que unir');
  if (buffers.some((b) => b.sampleRate !== first.sampleRate)) throw new RangeError('Frecuencias de muestreo distintas');
  const length = Math.max(...buffers.map((b) => b.length));
  const channels: Float32Array[] = [];
  for (const b of buffers) {
    for (let c = 0; c < b.numberOfChannels; c += 1) {
      const data = new Float32Array(length);
      data.set(b.getChannelData(c));
      channels.push(data);
    }
  }
  return createAudioBuffer(channels, first.sampleRate);
}

/**
 * Averages every channel into one.
 * @param buffer the source.
 * @returns mono samples.
 */
export function downmixToMono(buffer: AudioBufferLike): Float32Array {
  const out = new Float32Array(buffer.length);
  const n = buffer.numberOfChannels;
  for (let c = 0; c < n; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i += 1) out[i] = out[i]! + data[i]! / n;
  }
  return out;
}

/**
 * Applies a routing mode, always returning stereo (mono sources are doubled).
 * @param buffer the source.
 * @param mode routing.
 * @returns the routed stereo buffer.
 */
export function applyChannelMode(buffer: AudioBufferLike, mode: ChannelMode): AudioBufferLike {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  switch (mode) {
    case 'stereo':
      return createAudioBuffer([new Float32Array(left), new Float32Array(right)], buffer.sampleRate);
    case 'mono': {
      const mono = downmixToMono(buffer);
      return createAudioBuffer([mono, new Float32Array(mono)], buffer.sampleRate);
    }
    case 'left':
      return createAudioBuffer([new Float32Array(left), new Float32Array(left)], buffer.sampleRate);
    case 'right':
      return createAudioBuffer([new Float32Array(right), new Float32Array(right)], buffer.sampleRate);
    case 'swap':
      return createAudioBuffer([new Float32Array(right), new Float32Array(left)], buffer.sampleRate);
  }
}

/**
 * Equal-power stereo pan.
 * @param buffer the source (mono or stereo).
 * @param pan −1 (left) … +1 (right).
 * @returns the panned stereo buffer.
 */
export function panStereo(buffer: AudioBufferLike, pan: number): AudioBufferLike {
  const p = Math.min(1, Math.max(-1, Number.isFinite(pan) ? pan : 0));
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const outL = new Float32Array(buffer.length);
  const outR = new Float32Array(buffer.length);
  if (buffer.numberOfChannels === 1) {
    const x = (p + 1) / 2;
    const gl = Math.cos((x * Math.PI) / 2);
    const gr = Math.sin((x * Math.PI) / 2);
    for (let i = 0; i < outL.length; i += 1) {
      outL[i] = left[i]! * gl;
      outR[i] = left[i]! * gr;
    }
  } else {
    // Web Audio StereoPanner, stereo input.
    const x = p <= 0 ? p + 1 : p;
    const gl = Math.cos((x * Math.PI) / 2);
    const gr = Math.sin((x * Math.PI) / 2);
    for (let i = 0; i < outL.length; i += 1) {
      if (p <= 0) {
        outL[i] = left[i]! + right[i]! * gl;
        outR[i] = right[i]! * gr;
      } else {
        outL[i] = left[i]! * gl;
        outR[i] = right[i]! + left[i]! * gr;
      }
    }
  }
  return createAudioBuffer([outL, outR], buffer.sampleRate);
}

/** The node slice routing needs. */
export interface RoutingNodeLike {
  connect(destination: unknown, output?: number, input?: number): unknown;
  disconnect(): void;
}

/** Factories for the realtime graph. */
export interface RoutingFactory {
  createChannelSplitter(outputs: number): RoutingNodeLike;
  createChannelMerger(inputs: number): RoutingNodeLike;
  createGain(): RoutingNodeLike & { gain: { value: number } };
}

/**
 * Builds the realtime routing for a mode.
 * @param factory the audio context.
 * @param mode routing.
 * @returns input/output nodes and a disposer.
 */
export function createChannelRouting(factory: RoutingFactory, mode: ChannelMode): { input: RoutingNodeLike; output: RoutingNodeLike; dispose(): void } {
  const splitter = factory.createChannelSplitter(2);
  const merger = factory.createChannelMerger(2);
  const extra: RoutingNodeLike[] = [];
  switch (mode) {
    case 'stereo':
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 1, 1);
      break;
    case 'swap':
      splitter.connect(merger, 0, 1);
      splitter.connect(merger, 1, 0);
      break;
    case 'left':
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 0, 1);
      break;
    case 'right':
      splitter.connect(merger, 1, 0);
      splitter.connect(merger, 1, 1);
      break;
    case 'mono': {
      const sum = factory.createGain();
      sum.gain.value = 0.5;
      splitter.connect(sum, 0);
      splitter.connect(sum, 1);
      sum.connect(merger, 0, 0);
      sum.connect(merger, 0, 1);
      extra.push(sum);
      break;
    }
  }
  return {
    input: splitter,
    output: merger,
    dispose: () => {
      splitter.disconnect();
      merger.disconnect();
      for (const node of extra) node.disconnect();
    },
  };
}
