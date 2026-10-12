// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 4 edits the core operation set does not cover: per-clip effects
 * (`clip.extra.effects`, see `media/clip-effects.ts` — Fase 5 migrates them
 * to the native `videoEffects`/`filters` lists) and subtitle/title text.
 *
 * Both have exact inverses (the previous JSON is restored verbatim, a key
 * that did not exist is removed again), so undo returns the identical
 * document — the same contract as `editor/operations.ts`.
 */

import { cloneDocument, EditError, requireClip, type EditOperation } from './operations.ts';
import type { ProjectDocument, TextStyle } from '../model/document.ts';
import type { Json } from '../model/wire.ts';
import { EFFECTS_KEY, parseClipEffects, serializeClipEffects, type ClipEffects } from '../media/clip-effects.ts';

/**
 * The effects of a clip in a document.
 * @param doc the project.
 * @param clipId the clip.
 * @returns its parsed effects (empty when none).
 */
export function clipEffectsOf(doc: ProjectDocument, clipId: string): ClipEffects {
  return parseClipEffects(requireClip(doc, clipId).extra[EFFECTS_KEY]);
}

/** Sets (or clears) a clip's effects JSON. */
export class SetClipEffectsOperation implements EditOperation {
  readonly name = 'SetClipEffects';
  readonly timestamp = Date.now();
  readonly clipId: string;
  /** The JSON to store; `undefined` removes the key. */
  private readonly value: Json | undefined;

  /**
   * @param clipId the clip.
   * @param effects new effects (null/empty removes the key), or `{ raw }`
   *   — exact JSON to restore (`undefined` = no key), used by inverses.
   */
  constructor(clipId: string, effects: ClipEffects | null | { raw: Json | undefined }) {
    this.clipId = clipId;
    if (effects !== null && 'raw' in effects) this.value = effects.raw;
    else this.value = effects ? serializeClipEffects(effects) ?? undefined : undefined;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const clip = requireClip(next, this.clipId);
    if (this.value === undefined) {
      const { [EFFECTS_KEY]: _removed, ...rest } = clip.extra;
      void _removed;
      clip.extra = rest;
    } else {
      clip.extra = { ...clip.extra, [EFFECTS_KEY]: structuredClone(this.value) };
    }
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const previous = requireClip(doc, this.clipId).extra[EFFECTS_KEY];
    return new SetClipEffectsOperation(this.clipId, { raw: previous === undefined ? undefined : structuredClone(previous) });
  }

  describe(): string {
    return `Efectos de ${this.clipId}`;
  }
}

/**
 * Builds an effects edit from a mutation of the current effects.
 * @param doc the project.
 * @param clipId the clip.
 * @param mutate changes a copy of the effects.
 * @returns the operation.
 */
export function updateClipEffects(doc: ProjectDocument, clipId: string, mutate: (effects: ClipEffects) => void): SetClipEffectsOperation {
  const effects = clipEffectsOf(doc, clipId);
  mutate(effects);
  return new SetClipEffectsOperation(clipId, effects);
}

/** Replaces a text clip's style (content, font, colour…). */
export class SetClipTextOperation implements EditOperation {
  readonly name = 'SetClipText';
  readonly timestamp = Date.now();
  readonly clipId: string;
  private readonly style: TextStyle;

  /**
   * @param clipId a text clip.
   * @param style the full new style.
   */
  constructor(clipId: string, style: TextStyle) {
    this.clipId = clipId;
    this.style = { ...style };
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const current = requireClip(doc, this.clipId);
    if (current.kind !== 'text') throw new EditError('Solo los clips de texto tienen texto');
    const next = cloneDocument(doc);
    requireClip(next, this.clipId).text = { ...this.style };
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const current = requireClip(doc, this.clipId);
    if (!current.text) throw new EditError('El clip no tiene texto');
    return new SetClipTextOperation(this.clipId, current.text);
  }

  describe(): string {
    return `Texto de ${this.clipId}`;
  }
}
