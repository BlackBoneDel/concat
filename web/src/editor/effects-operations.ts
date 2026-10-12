// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 effect-stack edits: add, remove, reorder, bypass and tweak the
 * video/audio effects of a clip (`clip.extra.effects.stack` /
 * `.audioStack`, see `media/effects/effects-stack.ts`).
 *
 * Every operation rewrites only its own stack key and keeps the rest of the
 * effects object (Fase 4 keys, unknown keys) verbatim. The inverse restores
 * the previous `extra.effects` JSON exactly, so undo returns the identical
 * document — the contract of `editor/operations.ts` (port of the
 * `Edit`/`undo` pairing of `concat-core/src/edit.rs`).
 */

import type { ProjectDocument } from '../model/document.ts';
import type { Json, JsonObject } from '../model/wire.ts';
import { EFFECTS_KEY, EFFECTS_VERSION } from '../media/clip-effects.ts';
import {
  AUDIO_STACK_KEY,
  VIDEO_STACK_KEY,
  createAudioEffect,
  createVideoEffect,
  effectDef,
  isAudioEffectType,
  isVideoEffectType,
  moveItem,
  newEffectId,
  parseAudioStack,
  parseVideoStack,
  clampParam,
  serializeStack,
  type EffectInstance,
  type StackKind,
} from '../media/effects/effects-stack.ts';
import { SetClipEffectsOperation } from './effect-operations.ts';
import { cloneDocument, EditError, requireClip, type EditOperation } from './operations.ts';

/** How long consecutive param edits of one knob merge into one undo step. */
const PARAM_MERGE_WINDOW_MS = 600;

function rawEffects(doc: ProjectDocument, clipId: string): JsonObject | null {
  const raw = requireClip(doc, clipId).extra[EFFECTS_KEY];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null;
}

/**
 * The parsed stack of one kind.
 * @param doc the project.
 * @param clipId the clip.
 * @param kind `video` or `audio`.
 * @returns the instances (empty when none).
 */
export function clipStackOf(doc: ProjectDocument, clipId: string, kind: StackKind): EffectInstance[] {
  const raw = rawEffects(doc, clipId);
  if (!raw) return [];
  return kind === 'video' ? parseVideoStack(raw[VIDEO_STACK_KEY]) : parseAudioStack(raw[AUDIO_STACK_KEY]);
}

/**
 * Finds which stack holds an effect.
 * @param doc the project.
 * @param clipId the clip.
 * @param effectId the effect.
 * @returns the stack kind and index, or `null`.
 */
export function locateEffect(doc: ProjectDocument, clipId: string, effectId: string): { kind: StackKind; index: number; effect: EffectInstance } | null {
  for (const kind of ['video', 'audio'] as const) {
    const stack = clipStackOf(doc, clipId, kind);
    const index = stack.findIndex((fx) => fx.id === effectId);
    const effect = stack[index];
    if (effect) return { kind, index, effect };
  }
  return null;
}

/**
 * Writes one stack back into a copy of the document.
 * @param doc the project (not mutated).
 * @param clipId the clip.
 * @param kind which stack.
 * @param stack the new list (empty removes the key).
 * @returns the new document.
 */
export function withStack(doc: ProjectDocument, clipId: string, kind: StackKind, stack: readonly EffectInstance[]): ProjectDocument {
  const next = cloneDocument(doc);
  const clip = requireClip(next, clipId);
  const current = rawEffects(next, clipId);
  const effects: JsonObject = current ? { ...current } : { version: EFFECTS_VERSION };
  const key = kind === 'video' ? VIDEO_STACK_KEY : AUDIO_STACK_KEY;
  if (stack.length > 0) effects[key] = serializeStack(stack);
  else delete effects[key];
  const meaningful = Object.keys(effects).some((name) => name !== 'version');
  if (meaningful) {
    clip.extra = { ...clip.extra, [EFFECTS_KEY]: effects };
  } else {
    const { [EFFECTS_KEY]: _dropped, ...rest } = clip.extra;
    void _dropped;
    clip.extra = rest;
  }
  return next;
}

/** Shared inverse: restore the exact previous effects JSON. */
abstract class StackOperation implements EditOperation {
  abstract readonly name: string;
  readonly timestamp = Date.now();
  readonly clipId: string;

  protected constructor(clipId: string) {
    this.clipId = clipId;
  }

  abstract apply(doc: ProjectDocument): ProjectDocument;
  abstract describe(): string;

  inverse(doc: ProjectDocument): EditOperation {
    const previous: Json | undefined = requireClip(doc, this.clipId).extra[EFFECTS_KEY];
    return new SetClipEffectsOperation(this.clipId, { raw: previous === undefined ? undefined : structuredClone(previous) });
  }
}

/** AddVideoEffect(clipId, effectType, defaultParams). */
export class AddVideoEffectOperation extends StackOperation {
  readonly name: string = 'AddVideoEffect';
  readonly effectType: string;
  readonly effectId: string;
  readonly params: Readonly<Record<string, number>>;
  readonly index: number | null;

  /**
   * @param clipId the clip.
   * @param effectType a {@link VideoEffectType}.
   * @param defaultParams parameter overrides (clamped).
   * @param options explicit id (presets/tests) and insertion index (default: end).
   */
  constructor(clipId: string, effectType: string, defaultParams: Readonly<Record<string, number>> = {}, options: { effectId?: string; index?: number } = {}) {
    super(clipId);
    this.effectType = effectType;
    this.params = { ...defaultParams };
    this.effectId = options.effectId ?? newEffectId();
    this.index = options.index ?? null;
  }

  /** The stack this op targets. */
  protected get kind(): StackKind {
    return 'video';
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    if (this.kind === 'video' && clip.kind === 'audio') throw new EditError('Un clip de audio no admite efectos de vídeo');
    if (this.kind === 'audio' && (clip.kind === 'text' || clip.kind === 'shape' || clip.kind === 'image')) {
      throw new EditError('Este clip no tiene audio');
    }
    let effect: EffectInstance;
    if (this.kind === 'video') {
      if (!isVideoEffectType(this.effectType)) throw new EditError(`Efecto de vídeo desconocido: ${this.effectType}`);
      effect = createVideoEffect(this.effectType, this.params, this.effectId);
    } else {
      if (!isAudioEffectType(this.effectType)) throw new EditError(`Efecto de audio desconocido: ${this.effectType}`);
      effect = createAudioEffect(this.effectType, this.params, this.effectId);
    }
    const stack = clipStackOf(doc, this.clipId, this.kind);
    if (stack.some((fx) => fx.id === this.effectId)) throw new EditError(`El efecto ${this.effectId} ya existe`);
    const at = this.index === null ? stack.length : Math.min(stack.length, Math.max(0, this.index));
    stack.splice(at, 0, effect);
    return withStack(doc, this.clipId, this.kind, stack);
  }

  describe(): string {
    return `Añadir efecto ${this.effectType}`;
  }
}

/** Same as {@link AddVideoEffectOperation}, on the audio stack. */
export class AddAudioEffectOperation extends AddVideoEffectOperation {
  override readonly name: string = 'AddAudioEffect';

  protected override get kind(): StackKind {
    return 'audio';
  }
}

/** RemoveVideoEffect(clipId, effectId) — works on either stack. */
export class RemoveVideoEffectOperation extends StackOperation {
  readonly name: string = 'RemoveVideoEffect';
  readonly effectId: string;

  constructor(clipId: string, effectId: string) {
    super(clipId);
    this.effectId = effectId;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const found = locateEffect(doc, this.clipId, this.effectId);
    if (!found) throw new EditError(`No existe el efecto ${this.effectId}`);
    const stack = clipStackOf(doc, this.clipId, found.kind).filter((fx) => fx.id !== this.effectId);
    return withStack(doc, this.clipId, found.kind, stack);
  }

  describe(): string {
    return `Quitar efecto ${this.effectId}`;
  }
}

/** Alias for the audio stack (same behaviour: effects are found by id). */
export class RemoveAudioEffectOperation extends RemoveVideoEffectOperation {
  override readonly name: string = 'RemoveAudioEffect';
}

/** ReorderVideoEffects(clipId, effectId, newIndex) — order = application order. */
export class ReorderVideoEffectsOperation extends StackOperation {
  readonly name: string = 'ReorderVideoEffects';
  readonly effectId: string;
  readonly newIndex: number;

  constructor(clipId: string, effectId: string, newIndex: number) {
    super(clipId);
    this.effectId = effectId;
    this.newIndex = Math.trunc(newIndex);
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const found = locateEffect(doc, this.clipId, this.effectId);
    if (!found) throw new EditError(`No existe el efecto ${this.effectId}`);
    const stack = clipStackOf(doc, this.clipId, found.kind);
    return withStack(doc, this.clipId, found.kind, moveItem(stack, found.index, this.newIndex));
  }

  describe(): string {
    return `Reordenar efecto ${this.effectId}`;
  }
}

/** Alias for the audio stack. */
export class ReorderAudioEffectsOperation extends ReorderVideoEffectsOperation {
  override readonly name: string = 'ReorderAudioEffects';
}

/** UpdateEffectParam(clipId, effectId, paramName, value) — clamped to the declared range. */
export class UpdateEffectParamOperation extends StackOperation {
  readonly name = 'UpdateEffectParam';
  readonly effectId: string;
  readonly paramName: string;
  readonly value: number;

  constructor(clipId: string, effectId: string, paramName: string, value: number) {
    super(clipId);
    this.effectId = effectId;
    this.paramName = paramName;
    this.value = value;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const found = locateEffect(doc, this.clipId, this.effectId);
    if (!found) throw new EditError(`No existe el efecto ${this.effectId}`);
    const def = effectDef(found.effect.type)?.params.find((p) => p.name === this.paramName);
    if (!def) throw new EditError(`El efecto ${found.effect.type} no tiene el parámetro ${this.paramName}`);
    if (!Number.isFinite(this.value)) throw new EditError(`Valor inválido para ${this.paramName}`);
    const stack = clipStackOf(doc, this.clipId, found.kind).map((fx) =>
      fx.id === this.effectId ? { ...fx, params: { ...fx.params, [this.paramName]: clampParam(def, this.value) } } : fx,
    );
    return withStack(doc, this.clipId, found.kind, stack);
  }

  /** Slider drags on one knob fuse into one undo step. */
  merge(next: EditOperation): EditOperation | null {
    if (
      next instanceof UpdateEffectParamOperation &&
      next.clipId === this.clipId &&
      next.effectId === this.effectId &&
      next.paramName === this.paramName &&
      next.timestamp - this.timestamp <= PARAM_MERGE_WINDOW_MS
    ) {
      return next;
    }
    return null;
  }

  describe(): string {
    return `Ajustar ${this.paramName} de ${this.effectId}`;
  }
}

/** Bypasses (or re-enables) one effect. */
export class ToggleEffectOperation extends StackOperation {
  readonly name = 'ToggleEffect';
  readonly effectId: string;
  readonly enabled: boolean;

  constructor(clipId: string, effectId: string, enabled: boolean) {
    super(clipId);
    this.effectId = effectId;
    this.enabled = enabled;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const found = locateEffect(doc, this.clipId, this.effectId);
    if (!found) throw new EditError(`No existe el efecto ${this.effectId}`);
    const stack = clipStackOf(doc, this.clipId, found.kind).map((fx) => (fx.id === this.effectId ? { ...fx, enabled: this.enabled } : fx));
    return withStack(doc, this.clipId, found.kind, stack);
  }

  describe(): string {
    return `${this.enabled ? 'Activar' : 'Desactivar'} efecto ${this.effectId}`;
  }
}
