// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The multi-selection inspector: one batch edit applied to every selected
 * clip in a single history step (color label, enabled, volume, fades).
 */

import type { ProjectDocument } from '../../model/document.ts';
import {
  CompoundOperation,
  currentTimeline,
  SetClipPropertyOperation,
  ToggleClipEnabledOperation,
  type EditOperation,
} from '../../editor/operations.ts';

/** What the multi inspector needs. */
export interface MultiInspectorOptions {
  getDocument(): ProjectDocument;
  run(op: EditOperation): void;
  refresh(): void;
}

/** The batch property sheet. */
export class MultiInspector {
  readonly element: HTMLElement;
  private readonly options: MultiInspectorOptions;
  private clipIds: string[] = [];

  /**
   * @param options host wiring.
   */
  constructor(options: MultiInspectorOptions) {
    this.options = options;
    this.element = document.createElement('div');
    this.element.className = 'inspector-section';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Inspector de selección múltiple');
  }

  /**
   * Shows batch controls for a selection.
   * @param clipIds the selected clips (2+).
   */
  show(clipIds: string[]): void {
    this.clipIds = [...clipIds];
    this.element.textContent = '';
    const heading = document.createElement('h3');
    heading.className = 'inspector-group-title';
    heading.textContent = `${clipIds.length} clips seleccionados`;
    this.element.appendChild(heading);

    this.element.appendChild(
      this.buttonRow('Habilitar/deshabilitar todos', () => {
        const ops: EditOperation[] = this.clipIds.map((id) => new ToggleClipEnabledOperation(id));
        this.options.run(new CompoundOperation('Alternar clips', ops));
      }),
    );
    this.element.appendChild(
      this.buttonRow('Etiqueta roja', () => this.batchColor('#e74c3c')),
    );
    this.element.appendChild(
      this.buttonRow('Etiqueta azul', () => this.batchColor('#4c8dff')),
    );
    this.element.appendChild(
      this.buttonRow('Volumen 100%', () => this.batchNumber('volume', 1)),
    );
    this.element.appendChild(
      this.buttonRow('Fundidos a 0.5s', () => {
        const ops: EditOperation[] = [];
        const doc = this.options.getDocument();
        const timeline = currentTimeline(doc);
        for (const id of this.clipIds) {
          const clip = timeline.clips.find((candidate) => candidate.id === id);
          if (!clip) continue;
          ops.push(new SetClipPropertyOperation(id, 'fade_in', clip.fadeIn, 0.5));
          ops.push(new SetClipPropertyOperation(id, 'fade_out', clip.fadeOut, 0.5));
        }
        this.options.run(new CompoundOperation('Fundidos', ops));
      }),
    );
    this.element.appendChild(
      this.buttonRow('Quitar etiqueta de color', () => this.batchColor('')),
    );
  }

  /** Applies one color to the whole selection in one step. */
  private batchColor(value: string): void {
    const ops: EditOperation[] = this.clipIds.map(
      (id) => new SetClipPropertyOperation(id, 'color_label', '', value),
    );
    this.options.run(new CompoundOperation('Etiqueta de color', ops));
    this.options.refresh();
  }

  /** Applies one numeric property to the whole selection in one step. */
  private batchNumber(property: 'volume' | 'opacity', value: number): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const ops: EditOperation[] = [];
    for (const id of this.clipIds) {
      const clip = timeline.clips.find((candidate) => candidate.id === id);
      if (!clip) continue;
      const old = property === 'volume' ? clip.volume : clip.opacity;
      ops.push(new SetClipPropertyOperation(id, property, old, value));
    }
    this.options.run(new CompoundOperation(`Cambiar ${property}`, ops));
    this.options.refresh();
  }

  /** A full-width action button. */
  private buttonRow(label: string, onClick: () => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'field-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost';
    button.textContent = label;
    button.addEventListener('click', onClick);
    row.appendChild(button);
    return row;
  }
}
