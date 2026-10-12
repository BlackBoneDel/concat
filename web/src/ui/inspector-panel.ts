// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The inspector panel (Fase 3): project sheet, clip sheet or batch sheet
 * depending on the selection. Every edit runs through the session history.
 */

import { DynamicInspector } from './inspector/index.ts';
import type { AppContext } from './app-context.ts';

/** The dynamic inspector panel. */
export class InspectorPanel {
  private readonly root: HTMLElement;
  private readonly abort = new AbortController();
  private inspector: DynamicInspector | null = null;

  /**
   * @param root the panel root (`#inspector-panel`).
   * @param app the service bag.
   */
  constructor(root: HTMLElement, app: AppContext) {
    this.root = root;
    this.root.textContent = '';
    this.root.className = 'inspector-panel';
    const session = app.editSession;
    if (!session) {
      const message = document.createElement('p');
      message.className = 'panel-empty';
      message.textContent = 'Sesión de edición no disponible.';
      this.root.appendChild(message);
      return;
    }
    const heading = document.createElement('h2');
    heading.className = 'panel-title';
    heading.textContent = 'Inspector';
    this.root.appendChild(heading);
    this.inspector = new DynamicInspector({
      getDocument: () => session.document,
      run: (op) => {
        session.run(op);
        this.inspector?.show();
        app.requestRender();
        app.requestAutosave();
      },
      playheadSeconds: () => app.player.currentTime.asNumber(),
      markers: () => session.markers(),
      selectionIds: () => [...session.selection.selectedClipIds],
      onDocumentChanged: () => {
        this.inspector?.show();
        app.requestRender();
        app.requestAutosave();
      },
    });
    this.root.appendChild(this.inspector.element);
    const signal = this.abort.signal;
    document.addEventListener('selection-changed', () => this.inspector?.show(), { signal });
    document.addEventListener('timeline-changed', () => this.inspector?.show(), { signal });
    document.addEventListener('project-changed', () => this.inspector?.show(), { signal });
    document.addEventListener('session-reset', () => this.inspector?.show(), { signal });
    this.inspector.show();
  }

  /** Public refresh (app events). */
  refresh(): void {
    this.inspector?.show();
  }

  /** Tears the panel down. */
  dispose(): void {
    this.abort.abort();
    this.inspector = null;
    this.root.textContent = '';
  }
}
