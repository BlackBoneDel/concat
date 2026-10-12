// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The inspector: property editing for the selected clip, and the project's
 * own settings when nothing is selected.
 *
 * Every edit mutates the document's `DocumentClip` (or the timeline's
 * `VideoSettings`) and runs one `commit()`: history snapshot, engine rebuild,
 * preview re-render, autosave. Number fields validate inline with
 * `input.reportValidity()` (constraint `min`/`max`/`step`).
 */

import type { DocumentClip } from '../model/document.ts';
import type { AppContext } from './app-context.ts';

/** The right panel of the shell. */
export class InspectorPanel {
  private readonly root: HTMLElement;
  private readonly ctx: AppContext;
  private readonly body: HTMLElement;
  private historyPushed = false;

  /**
   * @param root the panel element.
   * @param ctx the app services.
   */
  constructor(root: HTMLElement, ctx: AppContext) {
    this.root = root;
    this.ctx = ctx;

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h2');
    title.className = 'panel-title';
    title.textContent = 'Inspector';
    header.appendChild(title);
    this.root.appendChild(header);

    this.body = document.createElement('div');
    this.body.className = 'inspector-body';
    this.root.appendChild(this.body);
    this.body.addEventListener('focusin', () => {
      if (!this.historyPushed) {
        this.ctx.history.push(this.ctx.session.document, this.ctx.session.documentSettings());
        this.historyPushed = true;
      }
    });
    this.body.addEventListener('focusout', () => {
      this.historyPushed = false;
    });

    document.addEventListener('selection-changed', () => this.refresh());
    this.refresh();
  }

  /** Rebuilds the form for the current selection. */
  refresh(): void {
    this.body.replaceChildren();
    const clip = this.currentClip();
    if (clip) this.buildClipForm(clip);
    else this.buildProjectForm();
  }

  private currentClip(): DocumentClip | null {
    const id = this.ctx.selectedClipId;
    if (!id) return null;
    return this.ctx.session.timeline.clips.find((clip) => clip.id === id) ?? null;
  }

  // -- clip form -----------------------------------------------------------

  private buildClipForm(clip: DocumentClip): void {
    const heading = document.createElement('div');
    heading.className = 'inspector-heading';
    heading.textContent = clip.name === '' ? `Clip ${clip.id}` : clip.name;
    this.body.appendChild(heading);

    const info = this.section('Posición');
    this.numberField(info, 'Inicio (s)', clip.start, 0, 36000, 0.01, (value) => {
      clip.start = value;
    });
    this.numberField(info, 'Duración (s)', clip.duration, 1 / 60, 36000, 0.01, (value) => {
      clip.duration = value;
    });
    this.numberField(info, 'Entrada en origen (s)', clip.sourceStart, 0, 36000, 0.01, (value) => {
      clip.sourceStart = value;
    });
    this.numberField(info, 'Velocidad', clip.speed, 0.0625, 16, 0.01, (value) => {
      clip.speed = value;
    });

    const transform = this.section('Transformación');
    this.numberField(transform, 'Escala', clip.scale, 0.01, 10, 0.01, (value) => {
      clip.scale = value;
    });
    this.numberField(transform, 'Desplazamiento X', clip.offsetX, -4, 4, 0.01, (value) => {
      clip.offsetX = value;
    });
    this.numberField(transform, 'Desplazamiento Y', clip.offsetY, -4, 4, 0.01, (value) => {
      clip.offsetY = value;
    });
    this.numberField(transform, 'Rotación (°)', clip.rotation, -360, 360, 1, (value) => {
      clip.rotation = value;
    });
    this.numberField(transform, 'Estirar X', clip.stretchX, 0.1, 8, 0.01, (value) => {
      clip.stretchX = value;
    });
    this.numberField(transform, 'Estirar Y', clip.stretchY, 0.1, 8, 0.01, (value) => {
      clip.stretchY = value;
    });

    const look = this.section('Composición');
    this.numberField(look, 'Opacidad', clip.opacity, 0, 1, 0.01, (value) => {
      clip.opacity = value;
    });
    this.selectField(look, 'Modo de fusión', clip.blend === '' ? 'normal' : clip.blend,
      ['normal', 'multiply', 'screen', 'add', 'lighten', 'darken'], (value) => {
        clip.blend = value;
      });

    const audio = this.section('Audio');
    this.numberField(audio, 'Volumen', clip.volume, 0, 2, 0.01, (value) => {
      clip.volume = value;
    });
    this.numberField(audio, 'Fade in (s)', clip.fadeIn, 0, 30, 0.05, (value) => {
      clip.fadeIn = value;
    });
    this.numberField(audio, 'Fade out (s)', clip.fadeOut, 0, 30, 0.05, (value) => {
      clip.fadeOut = value;
    });

    const crop = this.section('Recorte');
    const cropValue = clip.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const setCrop = (field: 'left' | 'top' | 'right' | 'bottom', value: number): void => {
      clip.crop = { ...cropValue, ...clip.crop, [field]: value };
    };
    this.numberField(crop, 'Izquierda', cropValue.left, 0, 0.9, 0.01, (value) => setCrop('left', value));
    this.numberField(crop, 'Superior', cropValue.top, 0, 0.9, 0.01, (value) => setCrop('top', value));
    this.numberField(crop, 'Derecha', cropValue.right, 0, 0.9, 0.01, (value) => setCrop('right', value));
    this.numberField(crop, 'Inferior', cropValue.bottom, 0, 0.9, 0.01, (value) => setCrop('bottom', value));
  }

  // -- project form --------------------------------------------------------

  private buildProjectForm(): void {
    const heading = document.createElement('div');
    heading.className = 'inspector-heading';
    heading.textContent = 'Proyecto';
    this.body.appendChild(heading);
    const video = this.ctx.session.video;

    const section = this.section('Ajustes');
    this.textField(section, 'Nombre', this.ctx.session.name, (value) => {
      this.ctx.session.rename(value);
    });
    this.numberField(section, 'Ancho', video.width, 16, 7680, 2, (value) => {
      video.width = Math.round(value);
    });
    this.numberField(section, 'Alto', video.height, 16, 4320, 2, (value) => {
      video.height = Math.round(value);
    });
    this.numberField(section, 'FPS numerador', video.rateNum, 1, 240, 1, (value) => {
      video.rateNum = Math.round(value);
    });
    this.numberField(section, 'FPS denominador', video.rateDen, 1, 1001, 1, (value) => {
      video.rateDen = Math.round(value);
    });

    const hint = document.createElement('p');
    hint.className = 'inspector-hint';
    hint.textContent = 'Selecciona un clip en el timeline para editar sus propiedades.';
    this.body.appendChild(hint);
  }

  // -- field builders ------------------------------------------------------

  private section(title: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'inspector-section';
    const heading = document.createElement('h3');
    heading.className = 'inspector-section-title';
    heading.textContent = title;
    section.appendChild(heading);
    this.body.appendChild(section);
    return section;
  }

  private numberField(
    section: HTMLElement,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
  ): void {
    const row = document.createElement('label');
    row.className = 'field-row';
    const text = document.createElement('span');
    text.className = 'field-label';
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'field-input';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Math.round(value * 10000) / 10000);
    input.addEventListener('input', () => {
      if (!input.reportValidity()) return;
      onChange(Number(input.value));
      this.commit();
    });
    row.appendChild(text);
    row.appendChild(input);
    section.appendChild(row);
  }

  private textField(section: HTMLElement, label: string, value: string, onChange: (value: string) => void): void {
    const row = document.createElement('label');
    row.className = 'field-row';
    const text = document.createElement('span');
    text.className = 'field-label';
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-input';
    input.value = value;
    input.addEventListener('input', () => {
      onChange(input.value);
      this.commit();
    });
    row.appendChild(text);
    row.appendChild(input);
    section.appendChild(row);
  }

  private selectField(
    section: HTMLElement,
    label: string,
    value: string,
    options: readonly string[],
    onChange: (value: string) => void,
  ): void {
    const row = document.createElement('label');
    row.className = 'field-row';
    const text = document.createElement('span');
    text.className = 'field-label';
    text.textContent = label;
    const select = document.createElement('select');
    select.className = 'field-input';
    for (const optionValue of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionValue;
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener('change', () => {
      onChange(select.value);
      this.commit();
    });
    row.appendChild(text);
    row.appendChild(select);
    section.appendChild(row);
  }

  /** One landed edit: engine, preview, autosave. */
  private commit(): void {
    this.ctx.session.rebuild();
    this.ctx.session.dirty = true;
    this.ctx.requestRender();
    this.ctx.requestAutosave();
  }
}
