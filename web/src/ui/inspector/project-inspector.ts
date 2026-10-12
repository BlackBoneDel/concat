// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The project inspector — the right column's Details sheet (Fase 8):
 * a PROJECT group (name, size, rate), a TIMELINE group (lanes, clips,
 * duration) and a CONTENT group (media counts). With nothing selected the
 * panel's "Modificar" button turns the numbers into editable fields; every
 * commit is its own reversible operation, so the settings obey the
 * everything-through-history rule too.
 */

import type { ProjectDocument, VideoSettings } from '../../model/document.ts';
import { currentTimeline, type EditOperation } from '../../editor/operations.ts';

/** Sets the active timeline's video settings (one history step). */
class SetVideoSettingsOperation implements EditOperation {
  readonly name = 'SetVideoSettings';
  readonly timestamp = Date.now();

  /**
   * @param timelineId the timeline.
   * @param oldSettings previous settings.
   * @param newSettings new settings.
   */
  constructor(
    readonly timelineId: string,
    readonly oldSettings: VideoSettings,
    readonly newSettings: VideoSettings,
  ) {}

  apply(doc: ProjectDocument): ProjectDocument {
    const next: ProjectDocument = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    const timeline = next.timelines.find((candidate) => candidate.id === this.timelineId);
    if (!timeline) throw new Error(`No existe el timeline ${this.timelineId}`);
    timeline.video = { ...this.newSettings };
    return next;
  }

  inverse(): EditOperation {
    return new SetVideoSettingsOperation(this.timelineId, this.newSettings, this.oldSettings);
  }

  describe(): string {
    return 'Cambiar ajustes de video';
  }
}

/** What the project inspector needs. */
export interface ProjectInspectorOptions {
  getDocument(): ProjectDocument;
  run(op: EditOperation): void;
  refresh(): void;
}

/** The project property sheet. */
export class ProjectInspector {
  readonly element: HTMLElement;
  private readonly options: ProjectInspectorOptions;
  /** Fase 8: `true` while the numbers render as fields. */
  private editing = false;

  /**
   * @param options host wiring.
   */
  constructor(options: ProjectInspectorOptions) {
    this.options = options;
    this.element = document.createElement('div');
    this.element.className = 'inspector-section';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Inspector de proyecto');
    this.show();
  }

  /** Fase 8: whether the sheet shows inputs instead of plain values. */
  get isEditing(): boolean {
    return this.editing;
  }

  /**
   * Fase 8: switches between reading and editing the project settings.
   * @param editing `true` for the editable sheet.
   */
  setEditing(editing: boolean): void {
    this.editing = editing;
    this.show();
  }

  /** Rebuilds the sheet from the document. */
  show(): void {
    this.element.textContent = '';
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const video = timeline.video;

    const group = document.createElement('div');
    group.className = 'inspector-group';
    const heading = document.createElement('h3');
    heading.className = 'inspector-group-title';
    heading.textContent = 'Proyecto';
    group.appendChild(heading);

    group.appendChild(this.readonlyRow('Timeline', timeline.name === '' ? timeline.id : timeline.name));
    group.appendChild(
      this.editing
        ? this.numberRow('Ancho', video.width, 16, 7680, 2, (width) =>
            this.setVideo({ ...video, width: Math.trunc(width) }),
          )
        : this.readonlyRow('Ancho', `${video.width} px`),
    );
    group.appendChild(
      this.editing
        ? this.numberRow('Alto', video.height, 16, 4320, 2, (height) =>
            this.setVideo({ ...video, height: Math.trunc(height) }),
          )
        : this.readonlyRow('Alto', `${video.height} px`),
    );
    group.appendChild(
      this.editing
        ? this.numberRow('FPS', video.rateNum / video.rateDen, 1, 240, 1, (fps) =>
            this.setVideo({ ...video, rateNum: Math.max(1, Math.round(fps)), rateDen: 1 }),
          )
        : this.readonlyRow('FPS', `${Math.round(video.rateNum / video.rateDen)} fps`),
    );
    this.element.appendChild(group);

    // Fase 8: the edit's shape, then what the project holds.
    const duration = timeline.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    this.element.appendChild(
      this.section('Timeline', [
        ['Pistas', String(timeline.tracks.length)],
        ['Clips', String(timeline.clips.length)],
        ['Duración', `${duration.toFixed(2)} s`],
      ]),
    );
    const media = doc.media;
    const countOf = (kind: string): number => media.filter((item) => item.kind === kind).length;
    this.element.appendChild(
      this.section('Contenido', [
        ['Vídeo', String(countOf('video'))],
        ['Audio', String(countOf('audio'))],
        ['Imágenes', String(countOf('image'))],
      ]),
    );
  }

  /**
   * One read-only group of label/value rows.
   * @param title the group heading.
   * @param rows the pairs.
   * @returns the group element.
   */
  private section(title: string, rows: readonly (readonly [string, string])[]): HTMLElement {
    const group = document.createElement('div');
    group.className = 'inspector-group';
    const heading = document.createElement('h3');
    heading.className = 'inspector-group-title';
    heading.textContent = title;
    group.appendChild(heading);
    for (const [label, value] of rows) group.appendChild(this.readonlyRow(label, value));
    return group;
  }

  /** Runs the video-settings op. */
  private setVideo(next: VideoSettings): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    this.options.run(new SetVideoSettingsOperation(timeline.id, timeline.video, next));
    this.options.refresh();
  }

  /** A read-only row. */
  private readonlyRow(label: string, value: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'field-row';
    const title = document.createElement('span');
    title.textContent = label;
    const content = document.createElement('span');
    content.className = 'field-readonly';
    content.textContent = value;
    row.append(title, content);
    return row;
  }

  /** A numeric row. */
  private numberRow(
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
}
