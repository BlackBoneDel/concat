// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The project inspector: timeline name, frame size and frame rate of the
 * edit. Video settings changes are their own reversible operation so they
 * obey the everything-through-history rule too.
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
    group.appendChild(this.numberRow('Ancho', video.width, 16, 7680, 2, (width) =>
      this.setVideo({ ...video, width: Math.trunc(width) }),
    ));
    group.appendChild(this.numberRow('Alto', video.height, 16, 4320, 2, (height) =>
      this.setVideo({ ...video, height: Math.trunc(height) }),
    ));
    group.appendChild(this.numberRow('FPS', video.rateNum / video.rateDen, 1, 240, 1, (fps) =>
      this.setVideo({ ...video, rateNum: Math.max(1, Math.round(fps)), rateDen: 1 }),
    ));
    this.element.appendChild(group);
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
