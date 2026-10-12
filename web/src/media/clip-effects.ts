// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Per-clip effects of Fase 4, stored in `clip.extra['effects']`.
 *
 * Fase 4 keeps them in the document's `extra` map so the Rust schema (and
 * `core/`/`model/`) stay untouched and documents round-trip through older
 * builds. **Fase 5 migrates this object to the keyframable effect stack**;
 * `version` lets that migration recognise it.
 *
 * Every field is optional in JSON; parsing is lenient (an invalid section
 * becomes `null`, never an exception) because documents come from disk.
 */

import type { Json, JsonObject } from '../model/wire.ts';
import { parseAudioEffects, isNeutralAudio, type AudioEffects } from './audio/audio-effects.ts';
import { validateChromaKey, type ChromaKeyParams } from './vision/chroma-key.ts';
import { sanitizeGrading, isNeutralGrading, type ColorGradingParams } from './vision/color-grading.ts';
import { validateFeather, type FeatherParams } from './vision/edge-feather.ts';
import { validateLumaKey, type LumaKeyParams } from './vision/luminance-key.ts';
import type { SpillParams } from './vision/spill-suppression.ts';
import {
  AUDIO_STACK_KEY,
  VIDEO_STACK_KEY,
  parseAudioStack,
  parseVideoStack,
  serializeStack,
  type AudioEffectInstance,
  type VideoEffectInstance,
} from './effects/effects-stack.ts';

/** The `extra` key effects live under. */
export const EFFECTS_KEY = 'effects';
/** Schema version of the Fase 4 effects object. */
export const EFFECTS_VERSION = 1;

/** A LUT reference: built-in id or session-loaded `.cube`. */
export interface LutEffect {
  id: string;
  /** 0–1. */
  strength: number;
}

/** Every effect of one clip. */
export interface ClipEffects {
  chromaKey: ChromaKeyParams | null;
  lumaKey: LumaKeyParams | null;
  spill: SpillParams | null;
  feather: FeatherParams | null;
  colorGrading: ColorGradingParams | null;
  lut: LutEffect | null;
  /** Before/after split view of the grade (preview only). */
  splitView: boolean;
  audio: AudioEffects | null;
  /** Fase 5: the ordered video effect stack (absent = none). */
  stack?: VideoEffectInstance[];
  /** Fase 5: the ordered audio effect stack (absent = none). */
  audioStack?: AudioEffectInstance[];
}

/** No effects. */
export function emptyClipEffects(): ClipEffects {
  return { chromaKey: null, lumaKey: null, spill: null, feather: null, colorGrading: null, lut: null, splitView: false, audio: null };
}

function obj(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = v;
  return out;
}

function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Parses `clip.extra.effects`.
 * @param value the stored JSON (anything).
 * @returns the effects (invalid sections dropped).
 */
export function parseClipEffects(value: unknown): ClipEffects {
  const record = obj(value);
  const out = emptyClipEffects();
  if (!record) return out;
  const chroma = obj(record['chromaKey']);
  if (chroma) out.chromaKey = attempt(() => validateChromaKey(chroma));
  const luma = obj(record['lumaKey']);
  if (luma) out.lumaKey = attempt(() => validateLumaKey({
    enabled: luma['enabled'] !== false,
    min: Number(luma['min'] ?? 0.1),
    max: Number(luma['max'] ?? 1),
    smoothness: Number(luma['smoothness'] ?? 0.05),
    invert: luma['invert'] === true,
  }));
  const spill = obj(record['spill']);
  if (spill) {
    const amount = Number(spill['amount']);
    out.spill = { enabled: spill['enabled'] !== false, amount: Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 1, preserveLuminance: spill['preserveLuminance'] !== false };
  }
  const feather = obj(record['feather']);
  if (feather) out.feather = attempt(() => validateFeather({ enabled: feather['enabled'] !== false, radius: Number(feather['radius'] ?? 2), choke: Number(feather['choke'] ?? 0) }));
  const grading = obj(record['colorGrading']);
  if (grading) out.colorGrading = sanitizeGrading(grading);
  const lut = obj(record['lut']);
  if (lut && typeof lut['id'] === 'string' && lut['id'] !== '') {
    const strength = Number(lut['strength'] ?? 1);
    out.lut = { id: lut['id'], strength: Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1 };
  }
  out.splitView = record['splitView'] === true;
  if (record['audio'] !== undefined && record['audio'] !== null) out.audio = parseAudioEffects(record['audio']);
  // Fase 5: the stacks ride along so Fase 4 edits never drop them.
  const stack = parseVideoStack(record[VIDEO_STACK_KEY]);
  if (stack.length > 0) out.stack = stack;
  const audioStack = parseAudioStack(record[AUDIO_STACK_KEY]);
  if (audioStack.length > 0) out.audioStack = audioStack;
  return out;
}

/** Plain JSON copy of a value made of numbers/strings/booleans/arrays/objects. */
function toJson(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = toJson(v);
    return out;
  }
  return null;
}

/**
 * Serialises effects for `clip.extra.effects` (null sections omitted).
 * @param effects the effects.
 * @returns the JSON object, or `null` when there is nothing to store.
 */
export function serializeClipEffects(effects: ClipEffects): JsonObject | null {
  const out: JsonObject = { version: EFFECTS_VERSION };
  let any = false;
  for (const key of ['chromaKey', 'lumaKey', 'spill', 'feather', 'colorGrading', 'lut', 'audio'] as const) {
    const value = effects[key];
    if (value !== null) {
      out[key] = toJson(value);
      any = true;
    }
  }
  if (effects.splitView) {
    out['splitView'] = true;
    any = true;
  }
  if (effects.stack && effects.stack.length > 0) {
    out[VIDEO_STACK_KEY] = serializeStack(effects.stack);
    any = true;
  }
  if (effects.audioStack && effects.audioStack.length > 0) {
    out[AUDIO_STACK_KEY] = serializeStack(effects.audioStack);
    any = true;
  }
  return any ? out : null;
}

/** True when any picture effect is active. */
export function hasVisualEffects(e: ClipEffects): boolean {
  return Boolean(
    e.chromaKey?.enabled || e.lumaKey?.enabled || e.spill?.enabled || (e.feather?.enabled && (e.feather.radius > 0 || e.feather.choke !== 0)) ||
    (e.colorGrading && !isNeutralGrading(e.colorGrading)) || (e.lut && e.lut.strength > 0),
  );
}

/** True when any audio effect is active. */
export function hasAudioEffects(e: ClipEffects): boolean {
  return e.audio !== null && (!isNeutralAudio(e.audio) || e.audio.preservePitch || e.audio.fadeInCurve !== 'linear' || e.audio.fadeOutCurve !== 'linear');
}
