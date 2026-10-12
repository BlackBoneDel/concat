// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The clip inspector: name/state, audio, transform, speed, transition and
 * keyframes (◆) of the selected clip. Every field goes through history.
 */

import { Rational } from '../../core/rational.ts';
import { Transform } from '../../core/timeline.ts';
import type { ProjectDocument } from '../../model/document.ts';
import {
  AddKeyframeOperation,
  AddTransitionOperation,
  clipEnabled,
  currentTimeline,
  keyframeId,
  RemoveKeyframeOperation,
  RemoveTransitionOperation,
  SetClipPropertyOperation,
  SetSpeedOperation,
  SetTransformOperation,
  SetTransitionPropertyOperation,
  ToggleClipEnabledOperation,
  TRANSITION_KINDS,
  type EditOperation,
  type MarkerData,
  type TransitionKind,
} from '../../editor/operations.ts';
import { KeyEase, type KeyProperty } from '../../model/wire.ts';
import type { DocumentClip } from '../../model/document.ts';
import { audioFxSection } from './audio-fx-section.ts';
import { chromaKeySection } from './chroma-key-section.ts';
import { colorGradingSection } from './color-grading-section.ts';
import { subtitlesSection } from './subtitles-section.ts';
import { keyframeSelection, type KeyframeRef } from '../timeline/keyframe-track.ts';
import type { BezierEditor } from './bezier-editor.ts';
import { effectsStackSection } from './effects-stack-section.ts';
import { keyframeCurveSection } from './keyframe-curve-section.ts';
import { presetsSection } from './presets-section.ts';
import { textAdvancedSection } from './text-advanced-section.ts';
import type { PresetManager } from '../../presets/preset-manager.ts';
import { getStudioServices } from '../studio-services.ts';

/** What the inspector needs from its host. */
export interface InspectorOptions {
  getDocument(): ProjectDocument;
  run(op: EditOperation): void;
  playheadSeconds(): number;
  markers(): MarkerData[];
  /** Refreshes the inspector after a document change. */
  refresh(): void;
  /** Fase 5: user/built-in presets (section hidden without it). */
  presets?: PresetManager;
  /** Fase 5: opens the font manager from the titling section. */
  openFontManager?(): void;
  /** Fase 5: live curve preview on the timeline while a Bézier handle drags. */
  previewKeyframeCurve?(clipId: string, ref: KeyframeRef, curve: readonly number[] | null): void;
  /** Fase 5: failure report (toast) for async preset work. */
  onError?(error: unknown): void;
}

/** The clip property sheet. */
export class ClipInspector {
  readonly element: HTMLElement;
  private readonly options: InspectorOptions;
  private clipId = '';
  /** Fase 4: which effect groups the user left open (survives re-renders). */
  private readonly openGroups = new Map<string, boolean>();
  /** Fase 5: effect rows whose parameters are expanded. */
  private readonly openEffects = new Set<string>();
  /** Fase 5: the live Bézier editor (disposed on every rebuild). */
  private bezier: BezierEditor | null = null;
  private readonly unsubscribeKeyframes: () => void;

  /**
   * @param options host wiring.
   */
  constructor(options: InspectorOptions) {
    this.options = options;
    this.element = document.createElement('div');
    this.element.className = 'inspector-section';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Inspector de clip');
    // Fase 5: picking a ◆ in the timeline shows its curve here.
    this.unsubscribeKeyframes = keyframeSelection.subscribe(() => {
      if (!this.element.hidden && this.clipId) this.show(this.clipId);
    });
  }

  /** Releases the keyframe subscription and the Bézier editor. */
  dispose(): void {
    this.unsubscribeKeyframes();
    this.bezier?.dispose();
    this.bezier = null;
  }

  /**
   * Shows one clip.
   * @param clipId the clip.
   */
  show(clipId: string): void {
    this.rememberOpenGroups();
    this.bezier?.dispose();
    this.bezier = null;
    this.clipId = clipId;
    const doc = this.options.getDocument();
    const clip = currentTimeline(doc).clips.find((candidate) => candidate.id === clipId);
    this.element.textContent = '';
    if (!clip) {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;

    this.section('General', [
      this.textField('Nombre', clip.name, (value) =>
        this.options.run(new SetClipPropertyOperation(clipId, 'name', clip.name, value)),
      ),
      this.checkField('Habilitado', clipEnabled(clip), (value) =>
        this.options.run(new ToggleClipEnabledOperation(clipId)),
      ),
      this.colorField('Etiqueta de color', clip.extra['colorLabel'], (value) =>
        this.options.run(new SetClipPropertyOperation(clipId, 'color_label', clip.extra['colorLabel'] ?? '', value)),
      ),
    ]);

    this.section('Audio', [
      this.numberField('Volumen', clip.volume, 0, 2, 0.01, (value) =>
        this.options.run(new SetClipPropertyOperation(clipId, 'volume', clip.volume, value)),
      ),
      this.numberField('Fade in (s)', clip.fadeIn, 0, 30, 0.1, (value) =>
        this.options.run(new SetClipPropertyOperation(clipId, 'fade_in', clip.fadeIn, value)),
      ),
      this.numberField('Fade out (s)', clip.fadeOut, 0, 30, 0.1, (value) =>
        this.options.run(new SetClipPropertyOperation(clipId, 'fade_out', clip.fadeOut, value)),
      ),
      this.numberField('Pan', typeof clip.extra['pan'] === 'number' ? clip.extra['pan'] : 0, -1, 1, 0.01, (value) =>
        this.options.run(new SetClipPropertyOperation(clipId, 'pan', clip.extra['pan'] ?? 0, value)),
      ),
    ]);

    const oldTransform = new Transform(clip.scale, clip.offsetX, clip.offsetY, clip.rotation, clip.stretchX, clip.stretchY);
    const setTransform = (field: 'scale' | 'offsetX' | 'offsetY' | 'rotation', value: number): void => {
      const next = new Transform(
        field === 'scale' ? value : clip.scale,
        field === 'offsetX' ? value : clip.offsetX,
        field === 'offsetY' ? value : clip.offsetY,
        field === 'rotation' ? value : clip.rotation,
        clip.stretchX,
        clip.stretchY,
      );
      this.options.run(new SetTransformOperation(clipId, oldTransform, next));
    };
    this.section('Transformación', [
      this.numberField('Escala', clip.scale, 0.01, 10, 0.01, (value) => setTransform('scale', value)),
      this.numberField('Offset X', clip.offsetX, -2, 2, 0.01, (value) => setTransform('offsetX', value)),
      this.numberField('Offset Y', clip.offsetY, -2, 2, 0.01, (value) => setTransform('offsetY', value)),
      this.numberField('Rotación (°)', clip.rotation, -360, 360, 1, (value) => setTransform('rotation', value)),
      this.numberField('Opacidad', clip.opacity, 0, 1, 0.01, (value) =>
        this.options.run(new SetClipPropertyOperation(clipId, 'opacity', clip.opacity, value)),
      ),
    ]);

    this.section('Velocidad', [
      this.numberField('Speed ×', clip.speed, 0.1, 8, 0.05, (value) =>
        this.options.run(new SetSpeedOperation(clipId, clip.speed, value, clip.preservePitch)),
      ),
    ]);

    this.buildTransitionSection(clip.transitionIn ? { ...clip.transitionIn } : null);
    this.buildKeyframeSection(clip.keys);
    // Fase 4: keying, colour/LUT, audio effects and subtitle text.
    this.buildMediaSections(clip);
  }

  /** Fase 4 sections, by clip kind (effects live in `clip.extra.effects`). */
  private buildMediaSections(clip: DocumentClip): void {
    const host = { getDocument: () => this.options.getDocument(), run: (op: EditOperation) => this.options.run(op) };
    const sections: (HTMLElement | null)[] = [];
    // Fase 5: the selected keyframe's curve sits right after the ◆ list.
    sections.push(
      keyframeCurveSection(
        {
          run: host.run,
          preview: (id, ref, curve) => {
            if (this.options.previewKeyframeCurve) this.options.previewKeyframeCurve(id, ref, curve);
            else getStudioServices()?.previewKeyframeCurve(id, ref, curve);
          },
        },
        clip,
        keyframeSelection.get(),
        (editor) => {
          this.bezier = editor;
        },
      ),
    );
    if (clip.kind === 'video' || clip.kind === 'image') sections.push(chromaKeySection(host, clip), colorGradingSection(host, clip));
    if (clip.kind === 'video' || clip.kind === 'audio') sections.push(audioFxSection(host, clip));
    sections.push(subtitlesSection(host, clip));
    // Fase 5: effect stacks, advanced titling and presets.
    sections.push(effectsStackSection(host, clip, this.openEffects));
    sections.push(textAdvancedSection({ ...host, openFontManager: () => this.openFontManager() }, clip));
    const presets = this.options.presets ?? getStudioServices()?.presets ?? null;
    if (presets) {
      sections.push(presetsSection({ ...host, presets, onError: (error) => this.reportError(error) }, clip));
    }
    for (const section of sections) {
      if (!section) continue;
      const key = [...section.classList].find((name) => name.startsWith('fx-') && name !== 'fx-group');
      const open = key ? this.openGroups.get(key) : undefined;
      if (open !== undefined && section instanceof HTMLDetailsElement) section.open = open;
      this.element.appendChild(section);
    }
  }

  /** Routes an async failure to the host (or the toast service / console). */
  private reportError(error: unknown): void {
    const studio = getStudioServices();
    if (this.options.onError) this.options.onError(error);
    else if (studio) studio.reportError('Presets', error);
    else console.error(error);
  }

  /** Opens the font manager through the host or the installed services. */
  private openFontManager(): void {
    if (this.options.openFontManager) this.options.openFontManager();
    else getStudioServices()?.openFontManager();
  }

  /** Records the open state of the effect groups before a rebuild. */
  private rememberOpenGroups(): void {
    for (const details of this.element.querySelectorAll('details.fx-group')) {
      const key = [...details.classList].find((name) => name.startsWith('fx-') && name !== 'fx-group');
      if (key && details instanceof HTMLDetailsElement) this.openGroups.set(key, details.open);
    }
  }

  /** Groups a set of fields under a heading. */
  private section(title: string, fields: HTMLElement[]): void {
    const box = document.createElement('div');
    box.className = 'inspector-group';
    const heading = document.createElement('h3');
    heading.className = 'inspector-group-title';
    heading.textContent = title;
    box.appendChild(heading);
    for (const field of fields) box.appendChild(field);
    this.element.appendChild(box);
  }

  /** A labeled text field. */
  private textField(label: string, value: string, commit: (value: string) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'field-row';
    const title = document.createElement('span');
    title.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.value = value;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => commit(input.value.trim()));
    row.append(title, input);
    return row;
  }

  /** A labeled number field. */
  private numberField(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    commit: (value: number) => void,
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'field-row';
    const title = document.createElement('span');
    title.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'input';
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => commit(Number(input.value)));
    row.append(title, input);
    return row;
  }

  /** A labeled checkbox. */
  private checkField(label: string, checked: boolean, commit: (value: boolean) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'field-row';
    const title = document.createElement('span');
    title.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => commit(input.checked));
    row.append(title, input);
    return row;
  }

  /** A color label picker. */
  private colorField(label: string, value: unknown, commit: (value: string) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'field-row';
    const title = document.createElement('span');
    title.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'input-color';
    input.value = typeof value === 'string' && value !== '' ? value : '#4c8dff';
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => commit(input.value));
    row.append(title, input);
    return row;
  }

  /** Transition controls. */
  private buildTransitionSection(transition: { id: string; duration: number } | null): void {
    const group = document.createElement('div');
    group.className = 'inspector-group';
    const heading = document.createElement('h3');
    heading.className = 'inspector-group-title';
    heading.textContent = 'Transición de entrada';
    group.appendChild(heading);

    const select = document.createElement('select');
    select.className = 'input';
    select.setAttribute('aria-label', 'Tipo de transición');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Sin transición';
    select.appendChild(none);
    for (const kind of TRANSITION_KINDS) {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = kind;
      select.appendChild(option);
    }
    select.value = transition?.id ?? '';
    const clipBId = this.clipId;
    select.addEventListener('change', () => {
      const doc = this.options.getDocument();
      const clip = currentTimeline(doc).clips.find((candidate) => candidate.id === clipBId);
      if (!clip) return;
      if (select.value === '') {
        if (clip.transitionIn) {
          this.options.run(new RemoveTransitionOperation(`tr:${clipBId}:in`));
        }
      } else if (clip.transitionIn) {
        this.options.run(
          new SetTransitionPropertyOperation(
            `tr:${clipBId}:in`,
            'kind',
            clip.transitionIn.id,
            select.value,
          ),
        );
      } else {
        // The cut into this clip is the previous clip on the same track.
        const timeline = currentTimeline(doc);
        const prev = timeline.clips
          .filter((candidate) => candidate.trackId === clip.trackId && candidate.id !== clip.id)
          .filter((candidate) => Math.abs(candidate.start + candidate.duration - clip.start) < 1e-6)
          .sort((a, b) => a.start - b.start)
          .pop();
        this.options.run(
          new AddTransitionOperation(
            prev?.id ?? clip.id,
            clipBId,
            select.value as TransitionKind,
            Rational.fromInt(1),
          ),
        );
      }
    });
    group.appendChild(select);

    if (transition) {
      const durationRow = document.createElement('label');
      durationRow.className = 'field-row';
      const title = document.createElement('span');
      title.textContent = 'Duración (s)';
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'input';
      input.min = '0.1';
      input.max = '10';
      input.step = '0.1';
      input.value = String(transition.duration);
      input.setAttribute('aria-label', 'Duración de la transición');
      input.addEventListener('change', () => {
        this.options.run(
          new SetTransitionPropertyOperation(
            `tr:${clipBId}:in`,
            'duration',
            transition.duration,
            Number(input.value),
          ),
        );
      });
      durationRow.append(title, input);
      group.appendChild(durationRow);
    }
    this.element.appendChild(group);
  }

  /** Keyframe (◆) controls per property. */
  private buildKeyframeSection(keys: readonly { property: KeyProperty; at: number; value: number }[]): void {
    const group = document.createElement('div');
    group.className = 'inspector-group';
    const heading = document.createElement('h3');
    heading.className = 'inspector-group-title';
    heading.textContent = 'Keyframes ◆';
    group.appendChild(heading);
    const doc = this.options.getDocument();
    const clip = currentTimeline(doc).clips.find((candidate) => candidate.id === this.clipId);
    if (!clip) return;
    const clipLen = Math.max(1 / 60, clip.duration);
    for (const property of ['opacity', 'volume', 'scale', 'offsetX', 'offsetY', 'rotation'] as const) {
      const row = document.createElement('div');
      row.className = 'field-row keyframe-row';
      const title = document.createElement('span');
      title.textContent = property;
      row.appendChild(title);
      const propertyKeys = keys.filter((key) => key.property === property);
      for (const key of propertyKeys) {
        const diamond = document.createElement('button');
        diamond.type = 'button';
        diamond.className = 'keyframe-diamond';
        diamond.textContent = '◆';
        diamond.title = `${property} @ ${key.at.toFixed(2)}s = ${key.value}`;
        diamond.setAttribute('aria-label', `Keyframe ${property} en ${key.at.toFixed(2)} segundos`);
        diamond.addEventListener('click', () => {
          this.options.run(
            new RemoveKeyframeOperation(this.clipId, property, keyframeId(property, key.at)),
          );
        });
        row.appendChild(diamond);
      }
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn btn-ghost keyframe-add';
      add.textContent = '◆+';
      add.title = `Añadir keyframe de ${property} en el playhead`;
      add.setAttribute('aria-label', `Añadir keyframe de ${property}`);
      add.addEventListener('click', () => {
        // AddKeyframe takes timeline seconds; keys store the clip fraction.
        const local = Math.min(1, Math.max(0, (this.options.playheadSeconds() - clip.start) / clipLen));
        const timelineTime = clip.start + local * clip.duration;
        this.options.run(
          new AddKeyframeOperation(
            this.clipId,
            property,
            Rational.approximate(timelineTime) ?? Rational.ZERO,
            this.constantOf(property),
            KeyEase.LINEAR,
          ),
        );
      });
      row.appendChild(add);
      group.appendChild(row);
    }
    this.element.appendChild(group);
  }

  /** The clip's current constant for a property. */
  private constantOf(property: KeyProperty): number {
    const doc = this.options.getDocument();
    const clip = currentTimeline(doc).clips.find((candidate) => candidate.id === this.clipId);
    if (!clip) return 0;
    switch (property) {
      case 'scale':
        return clip.scale;
      case 'offsetX':
        return clip.offsetX;
      case 'offsetY':
        return clip.offsetY;
      case 'rotation':
        return clip.rotation;
      case 'opacity':
        return clip.opacity;
      case 'volume':
        return clip.volume;
      default:
        return 0;
    }
  }
}
