// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 presets: built-in motion/title looks plus the user's own, stored in
 * IndexedDB `ConcatProjectDB.user_presets` (memory fallback in private
 * windows), and applied to a clip as **one undoable operation**
 * ({@link ApplyPresetOperation}, run through the session history).
 *
 * A preset may carry keyframes (values relative to the clip's own constant:
 * factors for scale/opacity/volume, offsets for position/rotation), video and
 * audio effects (appended to the stacks), title styles and a colour grade.
 */

import { clampBezier } from '../editor/keyframe-operations.ts';
import { AddAudioEffectOperation, AddVideoEffectOperation, clipStackOf } from '../editor/effects-operations.ts';
import { cloneDocument, EditError, requireClip, newId, type EditOperation } from '../editor/operations.ts';
import { RestoreTextOperation, UpdateTextStylesOperation, type TextStylePatch } from '../editor/text-operations.ts';
import { EFFECTS_KEY, EFFECTS_VERSION } from '../media/clip-effects.ts';
import { sanitizeGrading } from '../media/vision/color-grading.ts';
import type { ClipKey, DocumentClip, ProjectDocument } from '../model/document.ts';
import { clipConstant } from '../model/document.ts';
import { KeyEase, type Json, type JsonObject, type KeyProperty } from '../model/wire.ts';
import { ADVANCED_TEXT_KEY, parseAdvancedText } from '../render/advanced-text.ts';
import type { KeyValue } from '../storage/idb.ts';
import { MOTION_PRESETS } from './motion-presets.ts';
import { parseUserPreset, type PresetData, type PresetKey, type PresetType, type UserPreset } from './preset-types.ts';
import { TEXT_PRESETS } from './text-presets.ts';

/** IndexedDB database and store of user presets. */
export const PRESETS_DB_NAME = 'ConcatProjectDB';
export const USER_PRESETS_STORE = 'user_presets';
/** Schema version that added `user_presets` to `ConcatProjectDB`. */
export const PRESETS_DB_VERSION = 3;

/** Every built-in preset. */
export const BUILTIN_PRESETS: readonly UserPreset[] = Object.freeze([...MOTION_PRESETS, ...TEXT_PRESETS]);

/**
 * Whether a preset type fits a clip kind.
 * @param type the preset type.
 * @param clip the target clip.
 * @returns an error message, or `null` when compatible.
 */
export function presetIncompatibility(type: PresetType, clip: DocumentClip): string | null {
  switch (type) {
    case 'text':
      return clip.kind === 'text' ? null : 'Los presets de texto solo se aplican a clips de texto';
    case 'audio':
      return clip.kind === 'video' || clip.kind === 'audio' ? null : 'Este clip no tiene audio';
    case 'color':
      return clip.kind === 'video' || clip.kind === 'image' ? null : 'El color solo se aplica a vídeo o imagen';
    case 'video':
      return clip.kind === 'audio' ? 'Un clip de audio no admite presets de vídeo' : null;
  }
}

/** Fraction of the clip where a preset key lands. */
export function presetKeyAt(key: PresetKey, duration: number): number {
  if (key.seconds !== undefined) {
    const fraction = key.seconds / Math.max(1e-9, duration);
    return Math.min(1, Math.max(0, key.fromEnd ? 1 - fraction : fraction));
  }
  return Math.min(1, Math.max(0, key.at ?? 0));
}

/** Preset values are relative: factors for scale/opacity/volume, offsets otherwise. */
export function presetKeyValue(property: KeyProperty, constant: number, value: number): number {
  return property === 'scale' || property === 'opacity' || property === 'volume' ? constant * value : constant + value;
}

/** The parts of a clip a preset can touch, captured for undo. */
interface ClipLook {
  keys: ClipKey[];
  effects: Json | undefined;
}

function captureLook(clip: DocumentClip): ClipLook {
  const effects = clip.extra[EFFECTS_KEY];
  return {
    keys: clip.keys.map((key) => ({ ...key, ease: new KeyEase(key.ease.points) })),
    effects: effects === undefined ? undefined : structuredClone(effects),
  };
}

/** Restores keys, effects and text exactly (inverse of {@link ApplyPresetOperation}). */
export class RestoreClipLookOperation implements EditOperation {
  readonly name = 'RestoreClipLook';
  readonly timestamp = Date.now();
  readonly clipId: string;
  private readonly look: ClipLook;
  private readonly text: RestoreTextOperation;

  constructor(clipId: string, clip: DocumentClip) {
    this.clipId = clipId;
    this.look = captureLook(clip);
    const advanced = clip.extra[ADVANCED_TEXT_KEY];
    this.text = new RestoreTextOperation(clipId, clip.text ? { ...clip.text } : null, advanced === undefined ? undefined : structuredClone(advanced));
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const next = this.text.apply(doc);
    const clip = requireClip(next, this.clipId);
    clip.keys = this.look.keys.map((key) => ({ ...key, ease: new KeyEase(key.ease.points) }));
    if (this.look.effects === undefined) {
      const { [EFFECTS_KEY]: _removed, ...rest } = clip.extra;
      void _removed;
      clip.extra = rest;
    } else {
      clip.extra = { ...clip.extra, [EFFECTS_KEY]: structuredClone(this.look.effects) };
    }
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    return new RestoreClipLookOperation(this.clipId, requireClip(doc, this.clipId));
  }

  describe(): string {
    return `Restaurar aspecto de ${this.clipId}`;
  }
}

/** ApplyPreset(clipId, preset): one undo step for the whole look. */
export class ApplyPresetOperation implements EditOperation {
  readonly name = 'ApplyPreset';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly preset: UserPreset;
  /** Effect ids minted once, so redo recreates the same ids. */
  private readonly videoIds: string[];
  private readonly audioIds: string[];

  constructor(clipId: string, preset: UserPreset) {
    this.clipId = clipId;
    this.preset = structuredClone(preset);
    this.videoIds = (preset.data.videoEffects ?? []).map(() => newId('fx-'));
    this.audioIds = (preset.data.audioEffects ?? []).map(() => newId('fx-'));
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const problem = presetIncompatibility(this.preset.type, clip);
    if (problem) throw new EditError(problem);
    const data = this.preset.data;
    let next = cloneDocument(doc);

    if (data.keys && data.keys.length > 0) next = this.applyKeys(next, data.keys);
    if (clip.kind !== 'audio') {
      (data.videoEffects ?? []).forEach((fx, index) => {
        const id = this.videoIds[index]!;
        next = new AddVideoEffectOperation(this.clipId, fx.type, fx.params, { effectId: id }).apply(next);
        if (fx.enabled === false) next = disableEffect(next, this.clipId, id, 'video');
      });
    }
    if (clip.kind === 'video' || clip.kind === 'audio') {
      (data.audioEffects ?? []).forEach((fx, index) => {
        const id = this.audioIds[index]!;
        next = new AddAudioEffectOperation(this.clipId, fx.type, fx.params, { effectId: id }).apply(next);
        if (fx.enabled === false) next = disableEffect(next, this.clipId, id, 'audio');
      });
    }
    if (data.text && clip.kind === 'text') {
      next = new UpdateTextStylesOperation(this.clipId, {
        ...(data.text.base ? { base: data.text.base } : {}),
        advanced: data.text.advanced ?? {},
      }).apply(next);
    }
    if (data.color && (clip.kind === 'video' || clip.kind === 'image')) next = this.applyColor(next, data.color);
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    return new RestoreClipLookOperation(this.clipId, requireClip(doc, this.clipId));
  }

  describe(): string {
    return `Preset «${this.preset.name}» en ${this.clipId}`;
  }

  private applyKeys(doc: ProjectDocument, keys: readonly PresetKey[]): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    const properties = new Set(keys.map((key) => key.property));
    const kept = clip.keys.filter((key) => !properties.has(key.property));
    const added: ClipKey[] = [];
    for (const key of keys) {
      const at = presetKeyAt(key, clip.duration);
      const value = presetKeyValue(key.property, clipConstant(clip, key.property), key.value);
      // Two preset keys at the same instant: the later one wins.
      const existing = added.findIndex((item) => item.property === key.property && Math.abs(item.at - at) < 1e-9);
      const entry: ClipKey = { property: key.property, at, value, ease: new KeyEase(clampBezier(key.ease)) };
      if (existing >= 0) added[existing] = entry;
      else added.push(entry);
    }
    clip.keys = [...kept, ...added].sort((a, b) => (a.property === b.property ? a.at - b.at : a.property.localeCompare(b.property)));
    return doc;
  }

  private applyColor(doc: ProjectDocument, color: NonNullable<PresetData['color']>): ProjectDocument {
    const next = cloneDocument(doc);
    const clip = requireClip(next, this.clipId);
    const current = clip.extra[EFFECTS_KEY];
    const effects: JsonObject =
      typeof current === 'object' && current !== null && !Array.isArray(current) ? { ...current } : { version: EFFECTS_VERSION };
    if (color.colorGrading) {
      const grading: JsonObject = {};
      for (const [key, value] of Object.entries(sanitizeGrading(color.colorGrading))) {
        if (typeof value === 'number' && Number.isFinite(value)) grading[key] = value;
      }
      effects['colorGrading'] = grading;
    }
    if (color.lut === null) delete effects['lut'];
    else if (color.lut) effects['lut'] = { id: color.lut.id, strength: color.lut.strength };
    clip.extra = { ...clip.extra, [EFFECTS_KEY]: effects };
    return next;
  }
}

function disableEffect(doc: ProjectDocument, clipId: string, effectId: string, kind: 'video' | 'audio'): ProjectDocument {
  const next = cloneDocument(doc);
  const clip = requireClip(next, clipId);
  const effects = clip.extra[EFFECTS_KEY];
  if (typeof effects !== 'object' || effects === null || Array.isArray(effects)) return next;
  const key = kind === 'video' ? 'stack' : 'audioStack';
  const list = effects[key];
  if (!Array.isArray(list)) return next;
  effects[key] = list.map((entry) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) && entry['id'] === effectId ? { ...entry, enabled: false } : entry,
  );
  return next;
}

/** What {@link PresetManager.apply} runs operations through. */
export interface PresetSession {
  run(op: EditOperation): boolean;
}

/** Lists, stores and applies presets. */
export class PresetManager {
  private readonly kv: KeyValue;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly listeners = new Set<() => void>();

  /**
   * @param kv the key/value backend (`ConcatProjectDB` in the app).
   * @param now clock (tests).
   * @param makeId id factory (tests).
   */
  constructor(kv: KeyValue, now: () => number = () => Date.now(), makeId: () => string = () => crypto.randomUUID()) {
    this.kv = kv;
    this.now = now;
    this.makeId = makeId;
  }

  /** Built-in presets, optionally of one type. */
  builtins(type?: PresetType): UserPreset[] {
    return BUILTIN_PRESETS.filter((preset) => !type || preset.type === type);
  }

  /**
   * Every preset: built-ins first, then the user's, oldest first.
   * @param type filter.
   * @returns the presets.
   */
  async list(type?: PresetType): Promise<UserPreset[]> {
    const stored = await this.kv.getAll<unknown>(USER_PRESETS_STORE);
    const user = stored
      .map(parseUserPreset)
      .filter((preset): preset is UserPreset => preset !== null && (!type || preset.type === type))
      .sort((a, b) => a.createdAt - b.createdAt);
    return [...this.builtins(type), ...user];
  }

  /**
   * One preset by id.
   * @param id the preset.
   * @returns it, or `null`.
   */
  async get(id: string): Promise<UserPreset | null> {
    const builtin = BUILTIN_PRESETS.find((preset) => preset.id === id);
    if (builtin) return builtin;
    return parseUserPreset(await this.kv.get<unknown>(USER_PRESETS_STORE, id));
  }

  /**
   * Stores a new user preset.
   * @param name display name (1–64 chars).
   * @param type preset type.
   * @param data the payload.
   * @returns the stored preset.
   */
  async save(name: string, type: PresetType, data: PresetData): Promise<UserPreset> {
    const trimmed = name.trim();
    if (trimmed === '') throw new EditError('El preset necesita un nombre');
    if (!hasContent(data)) throw new EditError('El preset está vacío');
    const preset: UserPreset = { id: this.makeId(), name: trimmed.slice(0, 64), type, data: structuredClone(data), createdAt: this.now() };
    await this.kv.put(USER_PRESETS_STORE, preset.id, preset);
    this.emit();
    return preset;
  }

  /**
   * Deletes a user preset (built-ins are read-only).
   * @param id the preset.
   */
  async delete(id: string): Promise<void> {
    if (BUILTIN_PRESETS.some((preset) => preset.id === id)) throw new EditError('Los presets integrados no se pueden borrar');
    await this.kv.delete(USER_PRESETS_STORE, id);
    this.emit();
  }

  /**
   * Captures a clip's current look as preset data.
   * @param doc the project.
   * @param clipId the clip.
   * @param type what to capture.
   * @returns the payload.
   */
  capture(doc: ProjectDocument, clipId: string, type: PresetType): PresetData {
    const clip = requireClip(doc, clipId);
    const effects = (kind: 'video' | 'audio') =>
      clipStackOf(doc, clipId, kind).map((fx) => ({ type: fx.type, params: { ...fx.params }, ...(fx.enabled ? {} : { enabled: false }) }));
    switch (type) {
      case 'video': {
        const keys = clip.keys
          .filter((key) => key.property !== 'volume')
          .map((key): PresetKey => {
            const constant = clipConstant(clip, key.property);
            const relative =
              key.property === 'scale' || key.property === 'opacity'
                ? constant !== 0 ? key.value / constant : key.value
                : key.value - constant;
            return { property: key.property, at: key.at, value: relative, ease: clampBezier(key.ease.points) };
          });
        const videoEffects = effects('video');
        return { ...(keys.length > 0 ? { keys } : {}), ...(videoEffects.length > 0 ? { videoEffects } : {}) };
      }
      case 'audio': {
        const audioEffects = effects('audio');
        return audioEffects.length > 0 ? { audioEffects } : {};
      }
      case 'text': {
        const advanced = parseAdvancedText(clip.extra[ADVANCED_TEXT_KEY]);
        // Everything but the words: a title preset restyles, never retypes.
        let base: TextStylePatch | undefined;
        if (clip.text) {
          const { content: _content, ...style } = clip.text;
          void _content;
          base = style;
        }
        return { text: { ...(base ? { base } : {}), ...(advanced ? { advanced: { ...advanced, fontId: advanced.fontId } } : {}) } };
      }
      case 'color': {
        const raw = clip.extra[EFFECTS_KEY];
        const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
        const grading = record['colorGrading'];
        const lut = record['lut'];
        const out: PresetData = { color: {} };
        if (typeof grading === 'object' && grading !== null && !Array.isArray(grading)) {
          const values: Record<string, number> = {};
          for (const [key, value] of Object.entries(grading)) if (typeof value === 'number') values[key] = value;
          out.color!.colorGrading = values;
        }
        if (typeof lut === 'object' && lut !== null && !Array.isArray(lut) && typeof lut['id'] === 'string') {
          out.color!.lut = { id: lut['id'], strength: typeof lut['strength'] === 'number' ? lut['strength'] : 1 };
        }
        return out;
      }
    }
  }

  /**
   * Applies a preset to a clip as one undo step.
   * @param session where the operation runs (history).
   * @param presetId the preset.
   * @param clipId the clip.
   * @returns whether the edit was applied.
   */
  async apply(session: PresetSession, presetId: string, clipId: string): Promise<boolean> {
    const preset = await this.get(presetId);
    if (!preset) throw new EditError(`No existe el preset ${presetId}`);
    return session.run(new ApplyPresetOperation(clipId, preset));
  }

  /**
   * Subscribes to list changes.
   * @param listener callback.
   * @returns unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Whether preset data would change anything. */
export function hasContent(data: PresetData): boolean {
  return Boolean(
    (data.keys && data.keys.length > 0) ||
      (data.videoEffects && data.videoEffects.length > 0) ||
      (data.audioEffects && data.audioEffects.length > 0) ||
      (data.text && (data.text.base || data.text.advanced)) ||
      (data.color && (data.color.colorGrading || data.color.lut !== undefined)),
  );
}
