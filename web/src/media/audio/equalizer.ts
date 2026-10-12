// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Parametric equalizer: a chain of biquads.
 *
 * The default five bands mirror a broadcast voice preset — high-pass 80 Hz,
 * peaks at 250 Hz / 1 kHz / 4 kHz and a 12 kHz high shelf. Realtime playback
 * builds one `BiquadFilterNode` per enabled band; offline renders run the
 * same RBJ coefficients (`biquad.ts`) so both paths sound identical.
 */

import { copyChannels, createAudioBuffer, type AudioBufferLike } from './audio-buffer.ts';
import { biquadMagnitude, biquadProcess, designBiquad, type BiquadType } from './biquad.ts';

/** One EQ band. */
export interface EqBand {
  type: BiquadType;
  /** Hz, 20–20000. */
  frequency: number;
  /** dB, −24…+24 (ignored by pass/notch types). */
  gain: number;
  /** 0.1–100. */
  q: number;
  enabled: boolean;
}

/** Valid ranges. */
export const EQ_LIMITS = Object.freeze({ minFrequency: 20, maxFrequency: 20000, minQ: 0.1, maxQ: 100, minGain: -24, maxGain: 24 });

/** The default five bands. */
export const DEFAULT_EQ_BANDS: readonly EqBand[] = Object.freeze([
  { type: 'highpass', frequency: 80, gain: 0, q: 0.707, enabled: true },
  { type: 'peaking', frequency: 250, gain: 0, q: 1, enabled: true },
  { type: 'peaking', frequency: 1000, gain: 0, q: 1, enabled: true },
  { type: 'peaking', frequency: 4000, gain: 0, q: 1, enabled: true },
  { type: 'highshelf', frequency: 12000, gain: 0, q: 0.707, enabled: true },
] satisfies EqBand[]);

const TYPES: readonly BiquadType[] = ['highpass', 'lowpass', 'peaking', 'lowshelf', 'highshelf', 'notch', 'bandpass'];

/** Narrows a value to a filter type. */
function isBiquadType(value: unknown): value is BiquadType {
  return typeof value === 'string' && (TYPES as readonly string[]).includes(value);
}

/**
 * Validates one band, throwing a Spanish message on bad input.
 * @param band the candidate.
 * @returns the band.
 */
export function validateBand(band: EqBand): EqBand {
  if (!TYPES.includes(band.type)) throw new RangeError(`Tipo de filtro desconocido: ${String(band.type)}`);
  if (!(band.frequency >= EQ_LIMITS.minFrequency && band.frequency <= EQ_LIMITS.maxFrequency)) {
    throw new RangeError(`Frecuencia fuera de rango (20–20000 Hz): ${band.frequency}`);
  }
  if (!(band.q >= EQ_LIMITS.minQ && band.q <= EQ_LIMITS.maxQ)) throw new RangeError(`Q fuera de rango (0.1–100): ${band.q}`);
  if (!(band.gain >= EQ_LIMITS.minGain && band.gain <= EQ_LIMITS.maxGain)) throw new RangeError(`Ganancia fuera de rango (±24 dB): ${band.gain}`);
  return band;
}

/**
 * Reads bands from JSON, dropping invalid ones.
 * @param value anything.
 * @returns valid bands.
 */
export function parseBands(value: unknown): EqBand[] {
  if (!Array.isArray(value)) return [];
  const out: EqBand[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const band: EqBand = {
      type: isBiquadType(record['type']) ? record['type'] : 'peaking',
      frequency: Number(record['frequency']),
      gain: Number(record['gain'] ?? 0),
      q: Number(record['q'] ?? 1),
      enabled: record['enabled'] !== false,
    };
    try {
      out.push(validateBand(band));
    } catch {
      // Invalid band: skipped.
    }
  }
  return out;
}

/** The slice of `BiquadFilterNode` the equalizer drives. */
export interface BiquadNodeLike {
  type: BiquadFilterType;
  frequency: { value: number };
  Q: { value: number };
  gain: { value: number };
  connect(destination: unknown): unknown;
  disconnect(): void;
}

/** A parametric equalizer. */
export class Equalizer {
  private readonly bandList: EqBand[];

  /**
   * @param bands initial bands (validated; defaults to {@link DEFAULT_EQ_BANDS}).
   */
  constructor(bands: readonly EqBand[] = DEFAULT_EQ_BANDS) {
    this.bandList = bands.map((band) => validateBand({ ...band }));
  }

  /** A copy of the bands. */
  get bands(): EqBand[] {
    return this.bandList.map((band) => ({ ...band }));
  }

  /**
   * Updates one band.
   * @param index band index.
   * @param patch fields to change.
   */
  setBand(index: number, patch: Partial<EqBand>): void {
    const band = this.bandList[index];
    if (!band) throw new RangeError(`Banda ${index} inexistente`);
    this.bandList[index] = validateBand({ ...band, ...patch });
  }

  /** True when no enabled band changes the signal. */
  get isFlat(): boolean {
    return this.bandList.every((band) => !band.enabled || ((band.type === 'peaking' || band.type.endsWith('shelf')) && band.gain === 0));
  }

  /**
   * Combined magnitude in dB at each frequency (for the EQ curve UI).
   * @param frequencies Hz.
   * @param sampleRate samples per second.
   * @returns dB per frequency.
   */
  frequencyResponse(frequencies: readonly number[], sampleRate: number): number[] {
    const coefficients = this.active().map((band) => designBiquad(band.type, band.frequency, band.q, band.gain, sampleRate));
    return frequencies.map((f) => 20 * Math.log10(coefficients.reduce((m, c) => m * biquadMagnitude(c, f, sampleRate), 1)));
  }

  /**
   * Filters a buffer offline.
   * @param buffer the source.
   * @returns a new, equalised buffer.
   */
  process(buffer: AudioBufferLike): AudioBufferLike {
    const channels = copyChannels(buffer);
    for (const band of this.active()) {
      const c = designBiquad(band.type, band.frequency, band.q, band.gain, buffer.sampleRate);
      for (const channel of channels) biquadProcess(channel, c);
    }
    return createAudioBuffer(channels, buffer.sampleRate);
  }

  /**
   * Builds the realtime node chain.
   * @param create factory for `BiquadFilterNode`s (`() => ctx.createBiquadFilter()`).
   * @returns the nodes in order (connect yourself, or use the first/last).
   */
  createNodes<N extends BiquadNodeLike>(create: () => N): N[] {
    const nodes = this.active().map((band) => {
      const node = create();
      node.type = band.type;
      node.frequency.value = band.frequency;
      node.Q.value = band.q;
      node.gain.value = band.gain;
      return node;
    });
    for (let i = 0; i + 1 < nodes.length; i += 1) nodes[i]!.connect(nodes[i + 1]!);
    return nodes;
  }

  private active(): EqBand[] {
    return this.bandList.filter((band) => band.enabled);
  }
}
