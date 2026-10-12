// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Inspector: the selected keyframe (◆ picked in the timeline's lane) — its
 * time/value and the Bézier curve it is approached through.
 */

import {
  KEYFRAME_VALUE_RANGES,
  MoveKeyframeValueOperation,
  UpdateKeyframeCurveOperation,
  clampBezier,
} from '../../editor/keyframe-operations.ts';
import { keyframeId, type EditOperation } from '../../editor/operations.ts';
import type { DocumentClip } from '../../model/document.ts';
import { LANE_LABELS, type KeyframeRef } from '../timeline/keyframe-track.ts';
import { BezierEditor } from './bezier-editor.ts';
import { group, number } from './fields.ts';

/** What the section needs. */
export interface KeyframeCurveHost {
  run(op: EditOperation): void;
  /** Live preview of a curve while its handle drags (no history). */
  preview?(clipId: string, ref: KeyframeRef, curve: readonly number[] | null): void;
}

/**
 * Builds the section, or `null` when no key of this clip is selected.
 * @param host inspector host.
 * @param clip the inspected clip.
 * @param selected the selected keyframe.
 * @param keep receives the editor so the inspector can dispose it.
 * @returns the section.
 */
export function keyframeCurveSection(host: KeyframeCurveHost, clip: DocumentClip, selected: KeyframeRef | null, keep: (editor: BezierEditor) => void): HTMLElement {
  const hint = document.createElement('p');
  hint.className = 'fx-hint';
  const key = selected && selected.clipId === clip.id
    ? clip.keys.find((item) => item.property === selected.property && keyframeId(item.property, item.at) === selected.keyframeId)
    : undefined;
  if (!selected || !key) {
    hint.textContent = 'Abre los keyframes del clip con ⏷ en el timeline y selecciona un ◆ para editar su curva. Doble clic en la sub-pista añade un keyframe.';
    return group('Curva del keyframe', false, [hint], 'fx-keyframe-hint');
  }
  const [lo, hi] = KEYFRAME_VALUE_RANGES[key.property];
  hint.textContent = `${LANE_LABELS[key.property]} en ${(clip.start + key.at * clip.duration).toFixed(2)} s. La curva define cómo se llega a este keyframe desde el anterior.`;
  const editor = new BezierEditor({
    curve: clampBezier(key.ease.points),
    onChange: (curve, final) => {
      if (final) {
        host.preview?.(clip.id, selected, null);
        host.run(new UpdateKeyframeCurveOperation(clip.id, key.property, selected.keyframeId, curve));
      } else {
        host.preview?.(clip.id, selected, curve);
      }
    },
  });
  keep(editor);
  const isFirst = !clip.keys.some((item) => item.property === key.property && item.at < key.at);
  const notes: HTMLElement[] = [];
  if (isFirst) {
    const note = document.createElement('p');
    note.className = 'fx-hint';
    note.textContent = 'Es el primer keyframe: su curva solo se nota si añades uno anterior.';
    notes.push(note);
  }
  return group('Curva del keyframe', true, [
    hint,
    number(`Valor (${lo}…${hi})`, Math.round(key.value * 1000) / 1000, { min: lo, max: hi, step: key.property === 'rotation' ? 1 : 0.01 }, (value) =>
      host.run(new MoveKeyframeValueOperation(clip.id, key.property, selected.keyframeId, value)),
    ),
    editor.element,
    ...notes,
  ], 'fx-keyframe-curve');
}
