// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Marker editing: a modal that renames, recolors and annotates a marker,
 * or deletes it. Everything runs through history.
 */

import { Rational } from '../../core/rational.ts';
import {
  AddMarkerOperation,
  RemoveMarkerOperation,
  UpdateMarkerOperation,
  type EditOperation,
  type MarkerData,
} from '../../editor/operations.ts';
import { Modal } from '../modal.ts';

/** Preset marker colors (CSS-independent swatches). */
export const MARKER_COLORS: readonly string[] = [
  '#ffd166',
  '#4c8dff',
  '#2ecc71',
  '#e74c3c',
  '#b46cc8',
  '#f39c12',
];

/** Opens the editor for one marker. */
export function openMarkerEditor(
  marker: MarkerData,
  run: (op: EditOperation) => void,
): void {
  const content = document.createElement('div');
  content.className = 'marker-editor';

  const labelRow = document.createElement('label');
  labelRow.className = 'field-row';
  const labelTitle = document.createElement('span');
  labelTitle.textContent = 'Etiqueta';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'input';
  labelInput.value = marker.label;
  labelInput.setAttribute('aria-label', 'Etiqueta del marker');
  labelRow.append(labelTitle, labelInput);

  const noteRow = document.createElement('label');
  noteRow.className = 'field-row';
  const noteTitle = document.createElement('span');
  noteTitle.textContent = 'Nota';
  const noteInput = document.createElement('textarea');
  noteInput.className = 'input';
  noteInput.value = marker.note;
  noteInput.setAttribute('aria-label', 'Nota del marker');
  noteRow.append(noteTitle, noteInput);

  const colorRow = document.createElement('div');
  colorRow.className = 'field-row';
  const colorTitle = document.createElement('span');
  colorTitle.textContent = 'Color';
  colorRow.appendChild(colorTitle);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'input-color';
  colorInput.value = marker.color === '' ? MARKER_COLORS[0]! : marker.color;
  colorInput.setAttribute('aria-label', 'Color del marker');
  colorRow.appendChild(colorInput);
  for (const preset of MARKER_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = preset;
    swatch.setAttribute('aria-label', `Color ${preset}`);
    swatch.addEventListener('click', () => {
      colorInput.value = preset;
    });
    colorRow.appendChild(swatch);
  }

  const timeRow = document.createElement('div');
  timeRow.className = 'field-row';
  const timeTitle = document.createElement('span');
  timeTitle.textContent = 'Tiempo (s)';
  const timeInput = document.createElement('input');
  timeInput.type = 'number';
  timeInput.className = 'input';
  timeInput.step = '0.01';
  timeInput.min = '0';
  timeInput.value = marker.time.asNumber().toFixed(2);
  timeInput.setAttribute('aria-label', 'Tiempo del marker en segundos');
  timeRow.append(timeTitle, timeInput);

  content.append(labelRow, noteRow, colorRow, timeRow);

  const modal = new Modal('Editar marker', content, {
    confirmLabel: 'Guardar',
    cancelLabel: 'Cancelar',
    onConfirm: () => {
      const newTime = Math.max(0, Number(timeInput.value) || 0);
      const updated = {
        label: labelInput.value.trim(),
        note: noteInput.value,
        color: colorInput.value,
      };
      const oldTime = marker.time.asNumber();
      if (Math.abs(newTime - oldTime) > 1e-6) {
        // Time change: re-add at the new time, keep the id.
        run(new RemoveMarkerOperation(marker.id));
        run(new AddMarkerOperation(Rational.approximate(newTime) ?? Rational.ZERO, updated.label, updated.color, marker.id));
      } else {
        run(new UpdateMarkerOperation(marker.id, { ...marker }, { ...marker, ...updated }));
      }
      void modal;
    },
    danger: true,
  });
}
