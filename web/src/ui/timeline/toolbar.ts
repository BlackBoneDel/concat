// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The timeline toolbar: tool switcher (V C B N Y U), snapping toggle,
 * edit actions (split, delete, duplicate, group, link), marker add,
 * undo/redo and the zoom control.
 */

import type { ToolId } from './types.ts';

/** The actions the toolbar buttons trigger. */
export interface ToolbarActions {
  setTool(tool: ToolId): void;
  toggleSnapping(): void;
  splitAtPlayhead(): void;
  deleteSelection(): void;
  duplicateSelection(): void;
  groupSelection(): void;
  linkSelection(): void;
  addMarker(): void;
  undo(): void;
  redo(): void;
  addTrack(kind: 'video' | 'audio'): void;
}

/** One tool's button metadata. */
const TOOL_BUTTONS: { id: ToolId; label: string; key: string; title: string }[] = [
  { id: 'select', label: '⬚', key: 'V', title: 'Selección (V)' },
  { id: 'blade', label: '✂', key: 'C', title: 'Cuchilla (C)' },
  { id: 'ripple', label: '⇢', key: 'B', title: 'Ripple (B)' },
  { id: 'roll', label: '⇔', key: 'U', title: 'Roll (U)' },
  { id: 'slip', label: '⇤⇥', key: 'N', title: 'Slip (N)' },
  { id: 'slide', label: '⇥⇤', key: 'Y', title: 'Slide (Y)' },
  { id: 'pen', label: '✎', key: 'P', title: 'Pluma (P)' },
];

/** The toolbar row. */
export class Toolbar {
  readonly element: HTMLElement;
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  private readonly snapButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly abort = new AbortController();

  /**
   * @param actions button wiring.
   * @param zoomSlot element to append at the end (the zoom control).
   */
  constructor(actions: ToolbarActions, zoomSlot?: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'tl-toolbar';
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', 'Herramientas del timeline');
    const signal = this.abort.signal;

    for (const tool of TOOL_BUTTONS) {
      const button = this.button(tool.label, tool.title);
      button.addEventListener('click', () => actions.setTool(tool.id), { signal });
      this.toolButtons.set(tool.id, button);
      this.element.appendChild(button);
    }
    this.element.appendChild(this.divider());

    this.snapButton = this.button('🧲', 'Snapping magnético (S)');
    this.snapButton.setAttribute('aria-pressed', 'true');
    this.snapButton.addEventListener('click', () => actions.toggleSnapping(), { signal });
    this.element.appendChild(this.snapButton);

    const split = this.button('✂', 'Dividir en el playhead (Ctrl+K)');
    split.addEventListener('click', () => actions.splitAtPlayhead(), { signal });
    const del = this.button('🗑', 'Eliminar selección (Supr)');
    del.addEventListener('click', () => actions.deleteSelection(), { signal });
    const dup = this.button('⧉', 'Duplicar (Ctrl+D)');
    dup.addEventListener('click', () => actions.duplicateSelection(), { signal });
    const group = this.button('▦', 'Agrupar (Ctrl+G)');
    group.addEventListener('click', () => actions.groupSelection(), { signal });
    const link = this.button('🔗', 'Vincular video+audio (Ctrl+L)');
    link.addEventListener('click', () => actions.linkSelection(), { signal });
    const marker = this.button('📍', 'Añadir marker (M)');
    marker.addEventListener('click', () => actions.addMarker(), { signal });
    this.element.append(split, del, dup, group, link, marker);
    this.element.appendChild(this.divider());

    const addVideo = this.button('＋V', 'Añadir pista de video');
    addVideo.addEventListener('click', () => actions.addTrack('video'), { signal });
    const addAudio = this.button('＋A', 'Añadir pista de audio');
    addAudio.addEventListener('click', () => actions.addTrack('audio'), { signal });
    this.element.append(addVideo, addAudio);
    this.element.appendChild(this.divider());

    this.undoButton = this.button('↶', 'Deshacer (Ctrl+Z)');
    this.undoButton.addEventListener('click', () => actions.undo(), { signal });
    this.redoButton = this.button('↷', 'Rehacer (Ctrl+Y)');
    this.redoButton.addEventListener('click', () => actions.redo(), { signal });
    this.element.append(this.undoButton, this.redoButton);
    if (zoomSlot) this.element.appendChild(zoomSlot);
  }

  /** Marks the active tool and toggle states. */
  setTool(tool: ToolId, snapping: boolean, canUndo: boolean, canRedo: boolean): void {
    for (const [id, button] of this.toolButtons) {
      button.setAttribute('aria-pressed', String(id === tool));
      button.classList.toggle('active', id === tool);
    }
    this.snapButton.setAttribute('aria-pressed', String(snapping));
    this.snapButton.classList.toggle('active', snapping);
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
  }

  /** Makes a toolbar button. */
  private button(label: string, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost tl-tool-btn';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
  }

  /** A separator. */
  private divider(): HTMLElement {
    const divider = document.createElement('span');
    divider.className = 'tl-toolbar-divider';
    divider.setAttribute('aria-hidden', 'true');
    return divider;
  }

  /** Removes listeners and the element. */
  dispose(): void {
    this.abort.abort();
    this.element.remove();
  }
}
