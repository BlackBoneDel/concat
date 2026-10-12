// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Shared plumbing of the Fase 4 inspector sections. */

import { SetClipEffectsOperation, clipEffectsOf } from '../../editor/effect-operations.ts';
import type { EditOperation } from '../../editor/operations.ts';
import type { ClipEffects } from '../../media/clip-effects.ts';
import type { DocumentClip, ProjectDocument } from '../../model/document.ts';

/** What a section needs. */
export interface EffectSectionHost {
  getDocument(): ProjectDocument;
  run(op: EditOperation): void;
}

/**
 * Applies a mutation to a clip's effects as one undoable edit.
 * @param host the inspector host.
 * @param clip the clip.
 * @param mutate changes a fresh copy.
 */
export function editEffects(host: EffectSectionHost, clip: DocumentClip, mutate: (fx: ClipEffects) => void): void {
  const effects = clipEffectsOf(host.getDocument(), clip.id);
  mutate(effects);
  host.run(new SetClipEffectsOperation(clip.id, effects));
}
