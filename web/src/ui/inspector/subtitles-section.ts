// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Inspector: subtitle cue text, size and position of a subtitle clip. */

import { SetClipTextOperation } from '../../editor/effect-operations.ts';
import { SetTransformOperation } from '../../editor/operations.ts';
import { Transform } from '../../core/timeline.ts';
import { subtitleSourceOf } from '../../media/subtitles/subtitle-writer.ts';
import { SUBTITLE_OFFSET_Y } from '../../media/subtitles/subtitle-to-clips.ts';
import type { DocumentClip } from '../../model/document.ts';
import type { EffectSectionHost } from './effect-host.ts';
import { actions, button, check, group, slider } from './fields.ts';

/**
 * Builds the subtitle section (text clips only).
 * @param host inspector host.
 * @param clip a text clip.
 * @returns the section, or null for non-text clips.
 */
export function subtitlesSection(host: EffectSectionHost, clip: DocumentClip): HTMLElement | null {
  if (clip.kind !== 'text' || !clip.text) return null;
  const style = clip.text;
  const source = subtitleSourceOf(clip);
  const area = document.createElement('textarea');
  area.className = 'input fx-textarea';
  area.rows = 3;
  area.value = style.content;
  area.setAttribute('aria-label', 'Texto del subtítulo');
  area.addEventListener('change', () => host.run(new SetClipTextOperation(clip.id, { ...style, content: area.value })));
  const label = document.createElement('label');
  label.className = 'field-row field-column';
  const title = document.createElement('span');
  title.textContent = 'Texto';
  label.append(title, area);
  const info = document.createElement('p');
  info.className = 'fx-note';
  info.textContent = source
    ? `Importado de ${source.format.toUpperCase()}${source.id ? ` (cue ${source.id})` : ''}`
    : 'Título (no importado de un archivo)';
  const transform = (offsetY: number): void => {
    const before = new Transform(clip.scale, clip.offsetX, clip.offsetY, clip.rotation, clip.stretchX, clip.stretchY);
    const after = new Transform(clip.scale, clip.offsetX, offsetY, clip.rotation, clip.stretchX, clip.stretchY);
    host.run(new SetTransformOperation(clip.id, before, after));
  };
  return group(source ? 'Subtítulo' : 'Texto', true, [
    info,
    label,
    slider('Tamaño', style.fontSize, { min: 0.02, max: 0.15, step: 0.005 }, (v) => host.run(new SetClipTextOperation(clip.id, { ...style, fontSize: v })), (v) => `${Math.round(v * 1000) / 10}%`),
    check('Cursiva', style.italic, (on) => host.run(new SetClipTextOperation(clip.id, { ...style, italic: on }))),
    check('Fondo', style.background !== '', (on) => host.run(new SetClipTextOperation(clip.id, { ...style, background: on ? 'rgba(0, 0, 0, 0.6)' : '' }))),
    slider('Posición vertical', clip.offsetY, { min: -0.5, max: 0.5, step: 0.01 }, transform, (v) => `${Math.round((v + 0.5) * 100)}%`),
    actions(button('Abajo al centro', () => transform(SUBTITLE_OFFSET_Y), 'Colocar en el tercio inferior')),
  ], 'fx-subtitles');
}
