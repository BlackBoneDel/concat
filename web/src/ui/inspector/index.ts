// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The dynamic inspector: shows the project sheet with no selection, the
 * clip sheet with one clip, and the batch sheet with many.
 */

import type { ProjectDocument } from '../../model/document.ts';
import { currentTimeline, type EditOperation } from '../../editor/operations.ts';
import { ClipInspector, type InspectorOptions } from './clip-inspector.ts';
import { MultiInspector } from './multi-inspector.ts';
import { ProjectInspector } from './project-inspector.ts';

/** What the whole inspector column needs. */
export interface DynamicInspectorOptions {
  getDocument(): ProjectDocument;
  run(op: EditOperation): void;
  playheadSeconds(): number;
  markers(): import('../../editor/operations.ts').MarkerData[];
  /** The selected clip ids right now. */
  selectionIds(): string[];
  /** After a document change, the host rebuilds what it needs. */
  onDocumentChanged(): void;
}

/** The inspector that switches sheets with the selection. */
export class DynamicInspector {
  readonly element: HTMLElement;
  private readonly project: ProjectInspector;
  private readonly clip: ClipInspector;
  private readonly multi: MultiInspector;
  private readonly options: DynamicInspectorOptions;

  /**
   * @param options host wiring.
   */
  constructor(options: DynamicInspectorOptions) {
    this.options = options;
    this.element = document.createElement('div');
    this.element.className = 'inspector-body';
    const refresh = (): void => {
      this.show();
      options.onDocumentChanged();
    };
    const shared = {
      getDocument: options.getDocument,
      run: options.run,
      refresh,
    };
    this.project = new ProjectInspector(shared);
    this.clip = new ClipInspector({
      ...shared,
      playheadSeconds: options.playheadSeconds,
      markers: options.markers,
    });
    this.multi = new MultiInspector(shared);
    this.element.append(this.project.element, this.clip.element, this.multi.element);
    this.show();
  }

  /** Picks the right sheet for the current selection. */
  show(): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const selection = [...this.options.selectionIds()];
    if (selection.length === 0) {
      this.project.element.hidden = false;
      this.project.show();
      this.clip.element.hidden = true;
      this.multi.element.hidden = true;
    } else if (selection.length === 1) {
      this.project.element.hidden = true;
      this.clip.element.hidden = false;
      this.clip.show(selection[0]!);
      this.multi.element.hidden = true;
    } else {
      this.project.element.hidden = true;
      this.clip.element.hidden = true;
      this.multi.element.hidden = false;
      this.multi.show(selection.filter((id) =>
        timeline.clips.some((candidate) => candidate.id === id),
      ));
    }
    void doc;
  }
}

export { ClipInspector, type InspectorOptions } from './clip-inspector.ts';
export { MultiInspector, type MultiInspectorOptions } from './multi-inspector.ts';
export {
  ProjectInspector,
  type ProjectInspectorOptions,
} from './project-inspector.ts';
export { chromaKeySection } from './chroma-key-section.ts';
export { colorGradingSection } from './color-grading-section.ts';
export { audioFxSection } from './audio-fx-section.ts';
export { subtitlesSection } from './subtitles-section.ts';
export { editEffects, type EffectSectionHost } from './effect-host.ts';
// Fase 5
export { BezierEditor, BEZIER_CANVAS_SIZE, BEZIER_PRESET_BUTTONS, canvasToCurve, curveToCanvas, moveHandle, nearestHandle } from './bezier-editor.ts';
export { keyframeCurveSection, type KeyframeCurveHost } from './keyframe-curve-section.ts';
export { dropIndex, effectsStackSection, slotToIndex, type EffectsStackHost } from './effects-stack-section.ts';
export { SYSTEM_FONT_FAMILIES, textAdvancedSection, toHexColor, withAlphaOf, type TextAdvancedHost } from './text-advanced-section.ts';
export { compatibleTypes, PRESET_TYPE_LABELS, presetsSection, type PresetsHost } from './presets-section.ts';
