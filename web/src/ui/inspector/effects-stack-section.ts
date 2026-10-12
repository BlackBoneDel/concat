// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Inspector: the clip's effect stacks (video: blur, vignette, pixelate,
 * noise, glitch; audio: delay, reverb, chorus). Effects apply top to bottom;
 * rows reorder by drag & drop (or Alt+↑/↓ from the keyboard), toggle
 * (bypass), expand to their parameters, and remove. Every change is one
 * history step through the Fase 5 operations.
 */

import {
  AddAudioEffectOperation,
  AddVideoEffectOperation,
  RemoveVideoEffectOperation,
  ReorderVideoEffectsOperation,
  ToggleEffectOperation,
  UpdateEffectParamOperation,
  clipStackOf,
} from '../../editor/effects-operations.ts';
import type { EditOperation } from '../../editor/operations.ts';
import {
  AUDIO_EFFECT_TYPES,
  VIDEO_EFFECT_TYPES,
  effectDef,
  type EffectInstance,
  type StackKind,
} from '../../media/effects/effects-stack.ts';
import type { DocumentClip, ProjectDocument } from '../../model/document.ts';
import { button, group, slider, subheading } from './fields.ts';

/** What the section needs. */
export interface EffectsStackHost {
  getDocument(): ProjectDocument;
  run(op: EditOperation): void;
}

/** MIME type of a dragged effect row (never leaves the page). */
const DRAG_TYPE = 'application/x-concat-effect';

/**
 * Where a drop at `clientY` lands among rows.
 * @param rows the row rectangles (top, height), in order.
 * @param clientY pointer y.
 * @returns insertion index `0..rows.length`.
 */
export function dropIndex(rows: readonly { top: number; height: number }[], clientY: number): number {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (clientY < row.top + row.height / 2) return i;
  }
  return rows.length;
}

/**
 * The final index of an item moved from `from` to insertion slot `slot`
 * (slots count positions *between* items, so moving down skips itself).
 * @param from current index.
 * @param slot insertion slot from {@link dropIndex}.
 * @returns the index to pass to the reorder operation.
 */
export function slotToIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

function paramFormatter(unit: string): (value: number) => string {
  return (value) => {
    const rounded = Math.round(value * 100) / 100;
    if (unit === '%') return `${Math.round(value * 100)} %`;
    return unit ? `${rounded} ${unit}` : String(rounded);
  };
}

function effectRow(host: EffectsStackHost, clip: DocumentClip, fx: EffectInstance, index: number, total: number, open: Set<string>): HTMLElement {
  const def = effectDef(fx.type);
  const row = document.createElement('li');
  row.className = `fx-stack-row${fx.enabled ? '' : ' is-bypassed'}`;
  row.draggable = true;
  row.dataset['effectId'] = fx.id;
  row.setAttribute('aria-label', `${def?.label ?? fx.type}, posición ${index + 1} de ${total}`);

  const head = document.createElement('div');
  head.className = 'fx-stack-head';
  const grip = document.createElement('span');
  grip.className = 'fx-stack-grip';
  grip.textContent = '≡';
  grip.title = 'Arrastra para reordenar (Alt+↑/↓ con el teclado)';
  grip.setAttribute('aria-hidden', 'true');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = fx.enabled;
  toggle.setAttribute('aria-label', `${fx.enabled ? 'Desactivar' : 'Activar'} ${def?.label ?? fx.type}`);
  toggle.addEventListener('change', () => host.run(new ToggleEffectOperation(clip.id, fx.id, toggle.checked)));
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'fx-stack-title';
  title.textContent = `${index + 1}. ${def?.label ?? fx.type}`;
  title.setAttribute('aria-expanded', String(open.has(fx.id)));
  title.addEventListener('keydown', (event) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const target = event.key === 'ArrowUp' ? index - 1 : index + 1;
    if (target >= 0 && target < total) host.run(new ReorderVideoEffectsOperation(clip.id, fx.id, target));
  });
  const remove = button('×', () => host.run(new RemoveVideoEffectOperation(clip.id, fx.id)), `Quitar ${def?.label ?? fx.type}`, 'btn btn-ghost btn-small fx-stack-remove');
  remove.setAttribute('aria-label', `Quitar ${def?.label ?? fx.type}`);
  head.append(grip, toggle, title, remove);
  row.appendChild(head);

  const params = document.createElement('div');
  params.className = 'fx-stack-params';
  params.hidden = !open.has(fx.id);
  for (const p of def?.params ?? []) {
    params.appendChild(
      slider(p.label, fx.params[p.name] ?? p.default, { min: p.min, max: p.max, step: p.step }, (value) =>
        host.run(new UpdateEffectParamOperation(clip.id, fx.id, p.name, value)), paramFormatter(p.unit)),
    );
  }
  row.appendChild(params);
  title.addEventListener('click', () => {
    params.hidden = !params.hidden;
    title.setAttribute('aria-expanded', String(!params.hidden));
    if (params.hidden) open.delete(fx.id);
    else open.add(fx.id);
  });
  return row;
}

function stackList(host: EffectsStackHost, clip: DocumentClip, kind: StackKind, open: Set<string>): HTMLElement {
  const stack = clipStackOf(host.getDocument(), clip.id, kind);
  const list = document.createElement('ol');
  list.className = 'fx-stack-list';
  list.setAttribute('aria-label', kind === 'video' ? 'Efectos de vídeo, en orden de aplicación' : 'Efectos de audio, en orden de señal');
  stack.forEach((fx, index) => list.appendChild(effectRow(host, clip, fx, index, stack.length, open)));
  if (stack.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'fx-hint';
    empty.textContent = 'Sin efectos.';
    list.appendChild(empty);
  }

  // Drag & drop reordering (HTML5 DnD; the data never leaves the page).
  let draggedId = '';
  const marker = document.createElement('li');
  marker.className = 'fx-stack-drop';
  marker.setAttribute('aria-hidden', 'true');
  const rows = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('.fx-stack-row')];
  list.addEventListener('dragstart', (event) => {
    const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.fx-stack-row') : null;
    if (!row || !event.dataTransfer) return;
    draggedId = row.dataset['effectId'] ?? '';
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_TYPE, draggedId);
    row.classList.add('is-dragging');
  });
  list.addEventListener('dragover', (event) => {
    if (!draggedId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const all = rows();
    const slot = dropIndex(all.map((row) => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    }), event.clientY);
    const before = all[slot] ?? null;
    if (before) list.insertBefore(marker, before);
    else list.appendChild(marker);
  });
  const finish = (): void => {
    marker.remove();
    for (const row of rows()) row.classList.remove('is-dragging');
  };
  list.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && list.contains(event.relatedTarget)) return;
    marker.remove();
  });
  list.addEventListener('drop', (event) => {
    event.preventDefault();
    const id = draggedId;
    draggedId = '';
    const all = rows();
    const slot = all.findIndex((row) => row.previousElementSibling === marker);
    const insertion = slot === -1 ? all.length : slot;
    finish();
    const from = stack.findIndex((fx) => fx.id === id);
    if (from === -1) return;
    const to = slotToIndex(from, insertion);
    if (to !== from) host.run(new ReorderVideoEffectsOperation(clip.id, id, to));
  });
  list.addEventListener('dragend', () => {
    draggedId = '';
    finish();
  });
  return list;
}

function addRow(host: EffectsStackHost, clip: DocumentClip, kind: StackKind): HTMLElement {
  const row = document.createElement('div');
  row.className = 'fx-actions';
  const picker = document.createElement('select');
  picker.className = 'input';
  picker.setAttribute('aria-label', kind === 'video' ? 'Efecto de vídeo a añadir' : 'Efecto de audio a añadir');
  const types = kind === 'video' ? VIDEO_EFFECT_TYPES : AUDIO_EFFECT_TYPES;
  for (const type of types) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = effectDef(type)?.label ?? type;
    picker.appendChild(option);
  }
  const add = button('Añadir', () => {
    const op = kind === 'video' ? new AddVideoEffectOperation(clip.id, picker.value) : new AddAudioEffectOperation(clip.id, picker.value);
    host.run(op);
  }, kind === 'video' ? 'Añadir efecto de vídeo al final del stack' : 'Añadir efecto de audio al final de la cadena', 'btn btn-secondary btn-small');
  row.append(picker, add);
  return row;
}

/**
 * Builds the stack section for a clip (`null` for kinds without effects).
 * @param host inspector host.
 * @param clip the clip.
 * @param open ids of rows whose parameters are expanded (kept across rebuilds).
 * @returns the section.
 */
export function effectsStackSection(host: EffectsStackHost, clip: DocumentClip, open: Set<string>): HTMLElement | null {
  const children: HTMLElement[] = [];
  // Titles are drawn by the text engine; the stack runs on media pictures.
  const hasVideo = clip.kind === 'video' || clip.kind === 'image';
  const hasAudio = clip.kind === 'video' || clip.kind === 'audio';
  if (!hasVideo && !hasAudio) return null;
  let count = 0;
  if (hasVideo) {
    children.push(subheading('Vídeo'), stackList(host, clip, 'video', open), addRow(host, clip, 'video'));
    count += clipStackOf(host.getDocument(), clip.id, 'video').length;
  }
  if (hasAudio) {
    children.push(subheading('Audio'), stackList(host, clip, 'audio', open), addRow(host, clip, 'audio'));
    count += clipStackOf(host.getDocument(), clip.id, 'audio').length;
  }
  return group(count > 0 ? `Stack de efectos (${count})` : 'Stack de efectos', count > 0, children, 'fx-stack');
}
