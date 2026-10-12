// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Audio buffers for the DSP modules.
 *
 * Every offline processor works on {@link AudioBufferLike} — the slice of
 * `AudioBuffer` it reads — so a real `AudioBuffer` goes in as-is and tests
 * (Node has no Web Audio) use {@link PlainAudioBuffer}. {@link createAudioBuffer}
 * returns a real `AudioBuffer` whenever the platform has one, so results can
 * feed an `AudioBufferSourceNode` directly.
 */

/** The slice of `AudioBuffer` the DSP reads. */
export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** A plain, platform-independent audio buffer. */
export class PlainAudioBuffer implements AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  private readonly channels: Float32Array[];

  /**
   * @param channels one array per channel (all the same length).
   * @param sampleRate samples per second.
   */
  constructor(channels: Float32Array[], sampleRate: number) {
    if (channels.length === 0) throw new RangeError('Un buffer necesita al menos un canal');
    if (!(sampleRate > 0)) throw new RangeError('sampleRate debe ser positivo');
    const length = channels[0]!.length;
    if (channels.some((channel) => channel.length !== length)) throw new RangeError('Canales de longitud distinta');
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.length = length;
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  get numberOfChannels(): number {
    return this.channels.length;
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new RangeError(`Canal ${channel} fuera de rango`);
    return data;
  }
}

/**
 * Builds a buffer from channel data: a real `AudioBuffer` when the platform
 * has the constructor, a {@link PlainAudioBuffer} otherwise.
 * @param channels per-channel samples.
 * @param sampleRate samples per second.
 * @returns the buffer.
 */
export function createAudioBuffer(channels: Float32Array[], sampleRate: number): AudioBufferLike {
  const length = Math.max(1, channels[0]?.length ?? 1);
  if (typeof AudioBuffer !== 'undefined') {
    try {
      const buffer = new AudioBuffer({ numberOfChannels: channels.length, length, sampleRate });
      channels.forEach((data, index) => {
        const copy = new Float32Array(length);
        copy.set(data.subarray(0, length));
        buffer.copyToChannel(copy, index);
      });
      return buffer;
    } catch {
      // Out-of-range rate for this engine: keep a plain buffer.
    }
  }
  return new PlainAudioBuffer(channels.map((data) => (data.length === 0 ? new Float32Array(1) : data)), sampleRate);
}

/**
 * Copies every channel of a buffer.
 * @param buffer the source.
 * @returns fresh arrays.
 */
export function copyChannels(buffer: AudioBufferLike): Float32Array[] {
  const out: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    out.push(new Float32Array(buffer.getChannelData(channel)));
  }
  return out;
}

/**
 * Interleaved samples → planar channels.
 * @param interleaved `L R L R …`.
 * @param channels channel count.
 * @returns planar arrays.
 */
export function deinterleave(interleaved: Float32Array, channels: number): Float32Array[] {
  const count = Math.max(1, Math.trunc(channels));
  const frames = Math.floor(interleaved.length / count);
  const out = Array.from({ length: count }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      out[channel]![frame] = interleaved[frame * count + channel]!;
    }
  }
  return out;
}
