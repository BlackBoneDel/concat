// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The audio half of a clip's effects (`clip.extra.effects.audio`), its JSON
 * (de)serialisation, and the offline render chain.
 *
 * Fase 4 stores effects in `clip.extra['effects']`; Fase 5 migrates them to
 * the keyframable effect stack (see `media/clip-effects.ts`).
 *
 * Chain order (offline and realtime): channel routing → gate → EQ →
 * compressor → normalisation gain → limiter. Speed (with/without pitch
 * preservation) and semitone transposition are buffer-level transforms
 * applied before the chain.
 */

import { applyChannelMode, isChannelMode, type ChannelMode } from './channel-splitter.ts';
import { processCompressor, sanitizeCompressor, type CompressorParams } from './compressor.ts';
import { Equalizer, parseBands, type EqBand } from './equalizer.ts';
import { isFadeCurve, type FadeCurve } from './fader-curves.ts';
import { processLimiter, sanitizeLimiter, type LimiterParams } from './limiter.ts';
import { processGate, sanitizeGate, type NoiseGateParams } from './noise-gate.ts';
import { AudioNormalizer, type NormalizeOptions } from './normalizer.ts';
import { shiftPitchChannels } from './pitch-shift.ts';
import { createAudioBuffer, copyChannels, type AudioBufferLike } from './audio-buffer.ts';
import { dbToGain } from './dynamics.ts';

/** Loudness normalisation of a clip; `gainDb` caches the measured result. */
export interface NormalizeEffect extends NormalizeOptions {
  /** Gain computed by the last measurement, or `null` until measured. */
  gainDb: number | null;
}

/** Every audio effect of one clip. */
export interface AudioEffects {
  eq: EqBand[] | null;
  compressor: CompressorParams | null;
  limiter: LimiterParams | null;
  gate: NoiseGateParams | null;
  normalize: NormalizeEffect | null;
  channelMode: ChannelMode;
  /** Keep pitch when the clip's speed ≠ 1. */
  preservePitch: boolean;
  /** Transposition, −24…+24 semitones. */
  semitones: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
}

/** No processing at all. */
export const DEFAULT_AUDIO_EFFECTS: Readonly<AudioEffects> = Object.freeze({
  eq: null,
  compressor: null,
  limiter: null,
  gate: null,
  normalize: null,
  channelMode: 'stereo',
  preservePitch: false,
  semitones: 0,
  fadeInCurve: 'linear',
  fadeOutCurve: 'linear',
});

/** A fresh mutable copy of the defaults. */
export function defaultAudioEffects(): AudioEffects {
  return { ...DEFAULT_AUDIO_EFFECTS };
}

/** Reads a plain object field. */
function field(record: object, key: string): unknown {
  return Reflect.get(record, key);
}

/** An object or `null`. */
function objectOrNull(value: unknown): object | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/**
 * Parses audio effects from JSON, clamping every value.
 * @param value anything (usually `clip.extra.effects.audio`).
 * @returns valid effects (defaults for missing/invalid fields).
 */
export function parseAudioEffects(value: unknown): AudioEffects {
  const record = objectOrNull(value);
  if (!record) return defaultAudioEffects();
  const eq = field(record, 'eq');
  const compressor = objectOrNull(field(record, 'compressor'));
  const limiter = objectOrNull(field(record, 'limiter'));
  const gate = objectOrNull(field(record, 'gate'));
  const normalize = objectOrNull(field(record, 'normalize'));
  const semitones = Number(field(record, 'semitones'));
  let normalizeEffect: NormalizeEffect | null = null;
  if (normalize) {
    const mode = field(normalize, 'mode') === 'peak' ? 'peak' : 'loudness';
    const target = Number(field(normalize, 'target'));
    const gainDb = field(normalize, 'gainDb');
    const ceiling = Number(field(normalize, 'truePeakCeiling'));
    normalizeEffect = {
      mode,
      target: Number.isFinite(target) ? Math.min(0, Math.max(-60, target)) : mode === 'peak' ? -1 : -23,
      truePeakCeiling: Number.isFinite(ceiling) ? Math.min(0, Math.max(-20, ceiling)) : -1,
      gainDb: typeof gainDb === 'number' && Number.isFinite(gainDb) ? Math.max(-60, Math.min(60, gainDb)) : null,
    };
  }
  const channelMode = field(record, 'channelMode');
  const fadeIn = field(record, 'fadeInCurve');
  const fadeOut = field(record, 'fadeOutCurve');
  return {
    eq: Array.isArray(eq) ? parseBands(eq) : null,
    compressor: compressor ? sanitizeCompressor(toPartial(compressor)) : null,
    limiter: limiter ? sanitizeLimiter(toPartial(limiter)) : null,
    gate: gate ? sanitizeGate(toPartial(gate)) : null,
    normalize: normalizeEffect,
    channelMode: isChannelMode(channelMode) ? channelMode : 'stereo',
    preservePitch: field(record, 'preservePitch') === true,
    semitones: Number.isFinite(semitones) ? Math.max(-24, Math.min(24, Math.round(semitones))) : 0,
    fadeInCurve: isFadeCurve(fadeIn) ? fadeIn : 'linear',
    fadeOutCurve: isFadeCurve(fadeOut) ? fadeOut : 'linear',
  };
}

/** Object → string-keyed record of unknowns. */
function toPartial(record: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = value;
  return out;
}

/**
 * Whether effects do nothing (so the mixer can skip building a chain).
 * @param effects the effects.
 * @returns true when every effect is off.
 */
export function isNeutralAudio(effects: AudioEffects): boolean {
  return (
    (effects.eq === null || new Equalizer(effects.eq).isFlat) &&
    effects.compressor === null &&
    effects.limiter === null &&
    effects.gate === null &&
    (effects.normalize === null || !effects.normalize.gainDb) &&
    effects.channelMode === 'stereo' &&
    effects.semitones === 0
  );
}

/**
 * Renders the effect chain offline (export, bounce, tests).
 * @param buffer the source (already speed-processed).
 * @param effects the effects.
 * @returns the processed buffer.
 */
export function renderAudioEffects(buffer: AudioBufferLike, effects: AudioEffects): AudioBufferLike {
  let current: AudioBufferLike = buffer;
  if (effects.semitones !== 0) current = createAudioBuffer(shiftPitchChannels(copyChannels(current), effects.semitones), current.sampleRate);
  if (effects.channelMode !== 'stereo') current = applyChannelMode(current, effects.channelMode);
  if (effects.gate) current = processGate(current, effects.gate).buffer;
  if (effects.eq && effects.eq.length > 0) current = new Equalizer(effects.eq).process(current);
  if (effects.compressor) current = processCompressor(current, effects.compressor).buffer;
  if (effects.normalize) {
    const normalizer = new AudioNormalizer();
    if (effects.normalize.gainDb !== null) {
      const g = dbToGain(effects.normalize.gainDb);
      current = createAudioBuffer(copyChannels(current).map((channel) => channel.map((v) => v * g)), current.sampleRate);
    } else {
      current = normalizer.normalize(current, effects.normalize).buffer;
    }
  }
  if (effects.limiter) current = processLimiter(current, effects.limiter).buffer;
  return current;
}
