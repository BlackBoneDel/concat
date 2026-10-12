// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The editor shell: header + media | preview/timeline | inspector, with
 * draggable resizers between the zones. Panel sizes live in CSS variables
 * and persist through the settings.
 */

import type { AppContext } from './app-context.ts';

/** The composed shell: the elements the panels fill. */
export interface EditorLayout {
  header: HTMLElement;
  mediaPanel: HTMLElement;
  previewPanel: HTMLElement;
  timelinePanel: HTMLElement;
  inspectorPanel: HTMLElement;
}

/**
 * Builds the shell inside `root` and wires its resizers.
 * @param root the `#app` element.
 * @param ctx the app services (resizers persist into `settings`).
 * @returns the panel elements.
 */
export function createEditorLayout(root: HTMLElement, ctx: AppContext): EditorLayout {
  root.replaceChildren();
  root.className = 'app';

  const header = document.createElement('header');
  header.id = 'header-bar';
  header.className = 'header-bar';
  root.appendChild(header);

  const workspace = document.createElement('div');
  workspace.className = 'workspace';
  root.appendChild(workspace);

  const mediaPanel = document.createElement('aside');
  mediaPanel.id = 'media-panel';
  mediaPanel.className = 'panel panel-media';

  const mediaResizer = resizer('media', ctx);
  const center = document.createElement('div');
  center.className = 'center-column';

  const previewPanel = document.createElement('section');
  previewPanel.id = 'preview-panel';
  previewPanel.className = 'panel panel-preview';

  const timelineResizer = resizer('timeline', ctx);
  const timelinePanel = document.createElement('section');
  timelinePanel.id = 'timeline-panel';
  timelinePanel.className = 'panel panel-timeline';

  center.appendChild(previewPanel);
  center.appendChild(timelineResizer);
  center.appendChild(timelinePanel);

  const inspectorResizer = resizer('inspector', ctx);
  const inspectorPanel = document.createElement('aside');
  inspectorPanel.id = 'inspector-panel';
  inspectorPanel.className = 'panel panel-inspector';

  workspace.appendChild(mediaPanel);
  workspace.appendChild(mediaResizer);
  workspace.appendChild(center);
  workspace.appendChild(inspectorResizer);
  workspace.appendChild(inspectorPanel);

  applySizes(ctx);
  return { header, mediaPanel, previewPanel, timelinePanel, inspectorPanel };
}

/** One draggable resizer that owns a CSS variable. */
function resizer(zone: 'media' | 'inspector' | 'timeline', ctx: AppContext): HTMLElement {
  const handle = document.createElement('div');
  handle.className = `resizer resizer-${zone}`;
  handle.title = 'Arrastra para redimensionar';

  handle.addEventListener('pointerdown', (event) => {
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = ctx.settings.panelSizes[zone];
    const isVertical = zone === 'timeline';

    const move = (moveEvent: PointerEvent): void => {
      const delta = isVertical ? moveEvent.clientY - startY : startX - moveEvent.clientX;
      const min = isVertical ? 120 : zone === 'media' ? 150 : 180;
      const max = isVertical ? 800 : 600;
      ctx.settings.panelSizes[zone] = Math.max(min, Math.min(max, startSize + delta));
      applySizes(ctx);
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      ctx.saveSettings();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });

  return handle;
}

/** Pushes the panel sizes into the CSS variables. */
function applySizes(ctx: AppContext): void {
  const style = document.documentElement.style;
  style.setProperty('--media-w', `${ctx.settings.panelSizes.media}px`);
  style.setProperty('--inspector-w', `${ctx.settings.panelSizes.inspector}px`);
  style.setProperty('--timeline-h', `${ctx.settings.panelSizes.timeline}px`);
}
