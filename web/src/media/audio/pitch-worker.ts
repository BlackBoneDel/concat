// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Handlers of the audio DSP worker (`workers/pitch-worker.ts`): time
 * stretch / pitch shift, EBU R128 measurement, and the offline effect chain.
 * Channels travel as transferred `Float32Array`s both ways.
 */

import type { HandlerTools, WorkerHandler } from '../../workers/worker-client.ts';
import { renderAudioEffects, parseAudioEffects } from './audio-effects.ts';
import { PlainAudioBuffer } from './audio-buffer.ts';
import { measureChannels } from './normalizer.ts';
import { processChannels, shiftPitchChannels } from './pitch-shift.ts';

/** Planar audio on the wire. */
export interface ChannelsPayload {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * Validates planar audio from a message.
 * @param payload anything.
 * @returns the channels.
 */
export function readChannels(payload: unknown): ChannelsPayload {
  if (typeof payload !== 'object' || payload === null) throw new TypeError('Carga de audio inválida');
  const channels: unknown = Reflect.get(payload, 'channels');
  const sampleRate: unknown = Reflect.get(payload, 'sampleRate');
  if (!Array.isArray(channels) || channels.length === 0 || !channels.every((c) => c instanceof Float32Array)) {
    throw new TypeError('Se esperaban canales Float32Array');
  }
  if (typeof sampleRate !== 'number' || !(sampleRate > 0)) throw new TypeError('sampleRate inválido');
  const list: Float32Array[] = channels.filter((c): c is Float32Array => c instanceof Float32Array);
  return { channels: list, sampleRate };
}

/** Marks channel buffers for transfer. */
function transferAll(channels: Float32Array[], tools: HandlerTools): Float32Array[] {
  for (const channel of channels) tools.transfer.push(channel.buffer);
  return channels;
}

/**
 * The worker's handlers.
 * @returns `stretch`, `loudness` and `render`.
 */
export function createPitchHandlers(): Record<string, WorkerHandler> {
  return {
    stretch: (payload, tools) => {
      const { channels } = readChannels(payload);
      const rate = Number(Reflect.get(payload as object, 'rate'));
      const preservePitch = Reflect.get(payload as object, 'preservePitch') === true;
      const semitones = Number(Reflect.get(payload as object, 'semitones') ?? 0);
      let out = Math.abs(rate - 1) < 1e-9 ? channels.map((c) => new Float32Array(c)) : processChannels(channels, { rate, preservePitch });
      if (semitones) out = shiftPitchChannels(out, semitones);
      tools.progress(1);
      return transferAll(out, tools);
    },
    loudness: (payload) => {
      const { channels, sampleRate } = readChannels(payload);
      return measureChannels(channels, sampleRate);
    },
    render: (payload, tools) => {
      const { channels, sampleRate } = readChannels(payload);
      const effects = parseAudioEffects(Reflect.get(payload as object, 'effects'));
      const result = renderAudioEffects(new PlainAudioBuffer(channels, sampleRate), effects);
      const out: Float32Array[] = [];
      for (let c = 0; c < result.numberOfChannels; c += 1) out.push(new Float32Array(result.getChannelData(c)));
      return transferAll(out, tools);
    },
  };
}
