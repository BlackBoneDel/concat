// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Preset data model (Fase 5) and its lenient reader. Presets live in
 * IndexedDB (`ConcatProjectDB.user_presets`) and may come from older builds
 * or hand edits, so every field is validated on read.
 */

import { clampBezier, type CubicBezier } from '../editor/keyframe-operations.ts';
import type { TextStylePatch } from '../editor/text-operations.ts';
import { KeyProperty } from '../model/wire.ts';
import type { AdvancedTextPatch } from '../render/advanced-text.ts';

/** What a preset targets (and which clips accept it). */
export type PresetType = 'video' | 'audio' | 'text' | 'color';

/** One key of a motion preset. Time is `at` (fraction) or `seconds`. */
export interface PresetKey {
  property: KeyProperty;
  value: number;
  ease: CubicBezier;
  /** Fraction of the clip, 0..1. */
  at?: number;
  /** Seconds from the clip's start (or from its end with `fromEnd`). */
  seconds?: number;
  fromEnd?: boolean;
}

/** One effect of a preset (ids are minted when applied). */
export interface PresetEffect {
  type: string;
  params: Record<string, number>;
  enabled?: boolean;
}

/** Colour preset payload (Fase 4 grading + LUT). */
export interface PresetColor {
  colorGrading?: Record<string, number>;
  lut?: { id: string; strength: number } | null;
}

/** Everything a preset may carry. */
export interface PresetData {
  keys?: PresetKey[];
  videoEffects?: PresetEffect[];
  audioEffects?: PresetEffect[];
  text?: { base?: TextStylePatch; advanced?: AdvancedTextPatch };
  color?: PresetColor;
}

/** A stored preset. */
export interface UserPreset {
  id: string;
  name: string;
  type: PresetType;
  data: PresetData;
  /** Built-ins ship with the app and cannot be deleted. */
  builtin?: boolean;
  /** ms since epoch. */
  createdAt: number;
}

/** The accepted preset types. */
export const PRESET_TYPES: readonly PresetType[] = Object.freeze(['video', 'audio', 'text', 'color']);

function rec(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = v;
  return out;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const r = rec(value);
  if (!r) return out;
  for (const [key, v] of Object.entries(r)) {
    const n = finite(v);
    if (n !== null) out[key] = n;
  }
  return out;
}

function parseKeys(value: unknown): PresetKey[] {
  if (!Array.isArray(value)) return [];
  const out: PresetKey[] = [];
  for (const raw of value) {
    const r = rec(raw);
    if (!r) continue;
    const property = KeyProperty.fromName(typeof r['property'] === 'string' ? r['property'] : '');
    const v = finite(r['value']);
    if (!property || v === null) continue;
    const ease = Array.isArray(r['ease']) ? clampBezier(r['ease'].map((n) => (typeof n === 'number' ? n : Number.NaN))) : clampBezier([0, 0, 1, 1]);
    const key: PresetKey = { property, value: v, ease };
    const at = finite(r['at']);
    const seconds = finite(r['seconds']);
    if (seconds !== null) {
      key.seconds = Math.max(0, seconds);
      if (r['fromEnd'] === true) key.fromEnd = true;
    } else {
      key.at = at === null ? 0 : Math.min(1, Math.max(0, at));
    }
    out.push(key);
  }
  return out;
}

function parseEffects(value: unknown): PresetEffect[] {
  if (!Array.isArray(value)) return [];
  const out: PresetEffect[] = [];
  for (const raw of value) {
    const r = rec(raw);
    if (!r || typeof r['type'] !== 'string') continue;
    out.push({ type: r['type'], params: numbers(r['params']), ...(r['enabled'] === false ? { enabled: false } : {}) });
  }
  return out;
}

/**
 * Reads preset data (unknown fields dropped, numbers validated).
 * @param value stored JSON.
 * @returns the data.
 */
export function parsePresetData(value: unknown): PresetData {
  const r = rec(value) ?? {};
  const data: PresetData = {};
  const keys = parseKeys(r['keys']);
  if (keys.length > 0) data.keys = keys;
  const video = parseEffects(r['videoEffects']);
  if (video.length > 0) data.videoEffects = video;
  const audio = parseEffects(r['audioEffects']);
  if (audio.length > 0) data.audioEffects = audio;
  const text = rec(r['text']);
  if (text) {
    const base = rec(text['base']);
    const advanced = rec(text['advanced']);
    data.text = {};
    if (base) {
      const patch: TextStylePatch = {};
      Object.assign(patch, base);
      data.text.base = patch;
    }
    if (advanced) {
      const patch: AdvancedTextPatch = {};
      Object.assign(patch, advanced);
      data.text.advanced = patch;
    }
  }
  const color = rec(r['color']);
  if (color) {
    data.color = {};
    if (rec(color['colorGrading'])) data.color.colorGrading = numbers(color['colorGrading']);
    const lut = rec(color['lut']);
    if (lut && typeof lut['id'] === 'string') data.color.lut = { id: lut['id'], strength: Math.min(1, Math.max(0, finite(lut['strength']) ?? 1)) };
    else if (color['lut'] === null) data.color.lut = null;
  }
  return data;
}

/**
 * Reads a stored preset.
 * @param value stored JSON.
 * @returns the preset, or `null` when unusable.
 */
export function parseUserPreset(value: unknown): UserPreset | null {
  const r = rec(value);
  if (!r) return null;
  const id = r['id'];
  const name = r['name'];
  const type = r['type'];
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name.trim() === '') return null;
  if (typeof type !== 'string' || !(PRESET_TYPES as readonly string[]).includes(type)) return null;
  const presetType = PRESET_TYPES.find((candidate) => candidate === type) ?? 'video';
  return { id, name: name.slice(0, 64), type: presetType, data: parsePresetData(r['data']), createdAt: finite(r['createdAt']) ?? 0 };
}
