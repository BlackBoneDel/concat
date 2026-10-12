// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 effect stacks: ordered, per-clip lists of video and audio effects.
 *
 * Stored inside the Fase 4 effects object (`clip.extra.effects`) under two
 * extra keys so the Rust schema stays untouched and older builds keep the
 * keys verbatim:
 *
 * ```json
 * "effects": { "version": 1, "chromaKey": {…},
 *              "stack": [{ "id": "fx1", "type": "blur", "enabled": true, "params": { "radius": 8 } }],
 *              "audioStack": [{ "id": "fx2", "type": "reverb", "enabled": true, "params": {…} }] }
 * ```
 *
 * The parameter tables below are the single source of truth for ranges and
 * defaults: parsing clamps every number into them, the inspector builds its
 * sliders from them and the operations validate against them. Mirrors the
 * declarative filter catalogue of `concat-effects/src/looks.rs` (named
 * parameters with min/max/default), with the stack order being the order of
 * application (`AppliedFilter` list in `model.rs`).
 */

import type { Json, JsonObject } from '../../model/wire.ts';

/** `clip.extra.effects` sub-key of the video stack. */
export const VIDEO_STACK_KEY = 'stack';
/** `clip.extra.effects` sub-key of the audio stack. */
export const AUDIO_STACK_KEY = 'audioStack';

/** The video effects of the stack. */
export type VideoEffectType = 'blur' | 'vignette' | 'pixelate' | 'noise' | 'glitch';
/** The audio effects of the stack. */
export type AudioEffectType = 'delay' | 'reverb' | 'chorus';
/** Which stack an effect lives in. */
export type StackKind = 'video' | 'audio';

/** One effect of a stack. */
export interface EffectInstance<T extends string = string> {
  /** Stable id inside the clip (operations address effects by it). */
  id: string;
  type: T;
  /** Bypassed effects stay in the stack but do nothing. */
  enabled: boolean;
  /** Every parameter of the type, clamped into its range. */
  params: Record<string, number>;
}

/** A video effect instance. */
export type VideoEffectInstance = EffectInstance<VideoEffectType>;
/** An audio effect instance. */
export type AudioEffectInstance = EffectInstance<AudioEffectType>;

/** A numeric parameter's range and default. */
export interface EffectParamDef {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Display unit (`px`, `ms`, `%`…). */
  unit: string;
}

/** A catalogue entry. */
export interface EffectDef<T extends string> {
  type: T;
  label: string;
  params: readonly EffectParamDef[];
}

function param(name: string, label: string, min: number, max: number, step: number, value: number, unit = ''): EffectParamDef {
  return Object.freeze({ name, label, min, max, step, default: value, unit });
}

/** Video catalogue, in menu order. */
export const VIDEO_EFFECT_DEFS: Readonly<Record<VideoEffectType, EffectDef<VideoEffectType>>> = Object.freeze({
  blur: { type: 'blur', label: 'Desenfoque gaussiano', params: [param('radius', 'Radio', 0, 64, 0.5, 6, 'px')] },
  vignette: {
    type: 'vignette',
    label: 'Viñeta',
    params: [
      param('radius', 'Radio', 0.1, 1.5, 0.01, 0.75),
      param('softness', 'Suavidad', 0.01, 1, 0.01, 0.45),
      param('amount', 'Intensidad', 0, 1, 0.01, 0.8),
    ],
  },
  pixelate: { type: 'pixelate', label: 'Pixelado', params: [param('blocks', 'Bloques', 4, 400, 1, 64)] },
  noise: {
    type: 'noise',
    label: 'Ruido',
    params: [param('amount', 'Cantidad', 0, 1, 0.01, 0.2), param('speed', 'Velocidad', 0, 60, 1, 24, 'fps')],
  },
  glitch: {
    type: 'glitch',
    label: 'Glitch',
    params: [
      param('amount', 'Intensidad', 0, 1, 0.01, 0.5),
      param('rgbShift', 'Desplazamiento RGB', 0, 0.05, 0.001, 0.012),
      param('bands', 'Bandas', 1, 40, 1, 12),
      param('speed', 'Velocidad', 0, 30, 1, 10, 'Hz'),
    ],
  },
});

/** Audio catalogue, in menu order. */
export const AUDIO_EFFECT_DEFS: Readonly<Record<AudioEffectType, EffectDef<AudioEffectType>>> = Object.freeze({
  delay: {
    type: 'delay',
    label: 'Delay',
    params: [
      param('time', 'Tiempo', 10, 2000, 1, 350, 'ms'),
      param('feedback', 'Realimentación', 0, 0.95, 0.01, 0.35),
      param('mix', 'Mezcla', 0, 1, 0.01, 0.35),
    ],
  },
  reverb: {
    type: 'reverb',
    label: 'Reverb',
    params: [
      param('roomSize', 'Tamaño de sala', 0.05, 1, 0.01, 0.5),
      param('damping', 'Amortiguación', 0, 1, 0.01, 0.4),
      param('mix', 'Mezcla', 0, 1, 0.01, 0.3),
    ],
  },
  chorus: {
    type: 'chorus',
    label: 'Chorus',
    params: [
      param('rate', 'Velocidad', 0.05, 8, 0.01, 1.2, 'Hz'),
      param('depth', 'Profundidad', 0, 10, 0.1, 3, 'ms'),
      param('delay', 'Retardo base', 5, 40, 0.5, 18, 'ms'),
      param('mix', 'Mezcla', 0, 1, 0.01, 0.5),
    ],
  },
});

/** Every video effect type, in menu order. */
export const VIDEO_EFFECT_TYPES: readonly VideoEffectType[] = Object.freeze(['blur', 'vignette', 'pixelate', 'noise', 'glitch']);
/** Every audio effect type, in menu order. */
export const AUDIO_EFFECT_TYPES: readonly AudioEffectType[] = Object.freeze(['delay', 'reverb', 'chorus']);

/** Narrows a string to a video effect type. */
export function isVideoEffectType(value: string): value is VideoEffectType {
  return (VIDEO_EFFECT_TYPES as readonly string[]).includes(value);
}

/** Narrows a string to an audio effect type. */
export function isAudioEffectType(value: string): value is AudioEffectType {
  return (AUDIO_EFFECT_TYPES as readonly string[]).includes(value);
}

/**
 * The catalogue entry of any effect type.
 * @param type a video or audio effect type.
 * @returns its definition, or `null` for unknown types.
 */
export function effectDef(type: string): EffectDef<string> | null {
  if (isVideoEffectType(type)) return VIDEO_EFFECT_DEFS[type];
  if (isAudioEffectType(type)) return AUDIO_EFFECT_DEFS[type];
  return null;
}

/**
 * Clamps one parameter into its declared range.
 * @param def the parameter definition.
 * @param value any value (non-finite becomes the default).
 * @returns the clamped number.
 */
export function clampParam(def: EffectParamDef, value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return def.default;
  return Math.min(def.max, Math.max(def.min, n));
}

/**
 * A full, clamped parameter set for a type.
 * @param def the catalogue entry.
 * @param overrides values to use instead of the defaults.
 * @returns every declared parameter.
 */
export function resolveParams(def: EffectDef<string>, overrides: Readonly<Record<string, unknown>> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.name] = p.name in overrides ? clampParam(p, overrides[p.name]) : p.default;
  return out;
}

let idCounter = 0;

/**
 * A fresh effect id, unique within the session (and practically globally).
 * @returns e.g. `fx-lq3k2-7`.
 */
export function newEffectId(): string {
  idCounter += 1;
  return `fx-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Builds a video effect with defaults.
 * @param type the effect.
 * @param overrides parameter values.
 * @param id explicit id (tests, presets).
 * @returns the instance.
 */
export function createVideoEffect(type: VideoEffectType, overrides: Readonly<Record<string, unknown>> = {}, id = newEffectId()): VideoEffectInstance {
  return { id, type, enabled: true, params: resolveParams(VIDEO_EFFECT_DEFS[type], overrides) };
}

/**
 * Builds an audio effect with defaults.
 * @param type the effect.
 * @param overrides parameter values.
 * @param id explicit id.
 * @returns the instance.
 */
export function createAudioEffect(type: AudioEffectType, overrides: Readonly<Record<string, unknown>> = {}, id = newEffectId()): AudioEffectInstance {
  return { id, type, enabled: true, params: resolveParams(AUDIO_EFFECT_DEFS[type], overrides) };
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = v;
  return out;
}

function parseList<T extends string>(value: unknown, narrow: (type: string) => type is T, defs: Readonly<Record<T, EffectDef<T>>>): EffectInstance<T>[] {
  if (!Array.isArray(value)) return [];
  const out: EffectInstance<T>[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = record(raw);
    if (!entry) continue;
    const type = typeof entry['type'] === 'string' ? entry['type'] : '';
    if (!narrow(type)) continue; // unknown effects are dropped, never crash
    let id = typeof entry['id'] === 'string' && entry['id'] !== '' ? entry['id'] : newEffectId();
    if (seen.has(id)) id = newEffectId();
    seen.add(id);
    out.push({ id, type, enabled: entry['enabled'] !== false, params: resolveParams(defs[type], record(entry['params']) ?? {}) });
  }
  return out;
}

/**
 * Parses a stored video stack (lenient: bad entries are dropped).
 * @param value the JSON array.
 * @returns the instances, in application order.
 */
export function parseVideoStack(value: unknown): VideoEffectInstance[] {
  return parseList(value, isVideoEffectType, VIDEO_EFFECT_DEFS);
}

/**
 * Parses a stored audio stack.
 * @param value the JSON array.
 * @returns the instances, in signal order.
 */
export function parseAudioStack(value: unknown): AudioEffectInstance[] {
  return parseList(value, isAudioEffectType, AUDIO_EFFECT_DEFS);
}

/**
 * Serialises a stack for the document.
 * @param stack the instances.
 * @returns the JSON array.
 */
export function serializeStack(stack: readonly EffectInstance[]): Json[] {
  return stack.map((fx): JsonObject => {
    const params: JsonObject = {};
    for (const [key, value] of Object.entries(fx.params)) params[key] = Number.isFinite(value) ? value : 0;
    return { id: fx.id, type: fx.type, enabled: fx.enabled, params };
  });
}

/**
 * The stacks stored in a raw `extra.effects` value.
 * @param effects the raw JSON (anything).
 * @returns both stacks (empty when absent).
 */
export function stacksOf(effects: unknown): { video: VideoEffectInstance[]; audio: AudioEffectInstance[] } {
  const obj = record(effects);
  return {
    video: obj ? parseVideoStack(obj[VIDEO_STACK_KEY]) : [],
    audio: obj ? parseAudioStack(obj[AUDIO_STACK_KEY]) : [],
  };
}

/** True when any effect of the stack would change the output. */
export function stackIsActive(stack: readonly EffectInstance[]): boolean {
  return stack.some((fx) => fx.enabled && !effectIsNeutral(fx));
}

/**
 * Whether an enabled effect is a no-op with its current parameters.
 * @param fx the effect.
 * @returns true when it can be skipped.
 */
export function effectIsNeutral(fx: EffectInstance): boolean {
  const p = fx.params;
  switch (fx.type) {
    case 'blur':
      return (p['radius'] ?? 0) < 0.25;
    case 'vignette':
    case 'noise':
    case 'glitch':
      return (p['amount'] ?? 0) <= 0;
    case 'pixelate':
      return false;
    case 'delay':
    case 'reverb':
    case 'chorus':
      return (p['mix'] ?? 0) <= 0;
    default:
      return true;
  }
}

/**
 * Moves an element of a list to a new index (clamped), returning a copy.
 * @param list the list.
 * @param from current index.
 * @param to destination index.
 * @returns the reordered copy.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  const target = Math.min(out.length, Math.max(0, to));
  if (item !== undefined) out.splice(target, 0, item);
  return out;
}
