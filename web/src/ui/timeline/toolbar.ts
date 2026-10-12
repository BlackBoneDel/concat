// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The timeline toolbar: tool switcher (V C B N Y U), snapping toggle,
 * edit actions (split, delete, duplicate, group, link), marker add,
 * undo/redo and the zoom control.
 *
 * Fase 7 hook: every button is a `.concat-icon-btn` with an inline SVG glyph
 * from `ui/components/icons.ts` and a native tooltip ("Cuchilla (C)").
 */

import type { ToolId } from './types.ts';
import { iconButton, setPressed, type IconName } from '../components/icons.ts';

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
export const TOOL_BUTTONS: readonly { id: ToolId; icon: IconName; key: string; label: string }[] = [
  { id: 'select', icon: 'select', key: 'V', label: 'Selección' },
  { id: 'blade', icon: 'split', key: 'C', label: 'Cuchilla (Split)' },
  { id: 'ripple', icon: 'ripple', key: 'B', label: 'Ripple' },
  { id: 'roll', icon: 'roll', key: 'U', label: 'Roll' },
  { id: 'slip', icon: 'slip', key: 'N', label: 'Slip' },
  { id: 'slide', icon: 'slide', key: 'Y', label: 'Slide' },
  { id: 'pen', icon: 'pen', key: 'P', label: 'Pluma (keyframes)' },
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

    for (const tool of TOOL_BUTTONS) {
      const button = this.button(tool.icon, tool.label, tool.key, () => actions.setTool(tool.id));
      button.classList.add(`tl-tool-${tool.id}`);
      setPressed(button, tool.id === 'select');
      this.toolButtons.set(tool.id, button);
      this.element.appendChild(button);
    }
    this.element.appendChild(this.divider());

    this.snapButton = this.button('magnet', 'Snapping magnético', 'S', () => actions.toggleSnapping());
    setPressed(this.snapButton, true);
    this.element.appendChild(this.snapButton);

    this.element.append(
      this.button('split', 'Dividir en el playhead', 'Ctrl+K', () => actions.splitAtPlayhead()),
      this.button('trash', 'Eliminar selección', 'Supr', () => actions.deleteSelection()),
      this.button('duplicate', 'Duplicar', 'Ctrl+D', () => actions.duplicateSelection()),
      this.button('group', 'Agrupar', 'Ctrl+G', () => actions.groupSelection()),
      this.button('link', 'Vincular vídeo y audio', 'Ctrl+L', () => actions.linkSelection()),
      this.button('marker', 'Añadir marcador', 'M', () => actions.addMarker()),
    );
    this.element.appendChild(this.divider());

    this.element.append(
      this.button('videoPlus', 'Añadir pista de vídeo', undefined, () => actions.addTrack('video')),
      this.button('audioPlus', 'Añadir pista de audio', undefined, () => actions.addTrack('audio')),
    );
    this.element.appendChild(this.divider());

    this.undoButton = this.button('undo', 'Deshacer', 'Ctrl+Z', () => actions.undo());
    this.redoButton = this.button('redo', 'Rehacer', 'Ctrl+Y', () => actions.redo());
    this.element.append(this.undoButton, this.redoButton);
    if (zoomSlot) this.element.appendChild(zoomSlot);
  }

  /** Marks the active tool and toggle states. */
  setTool(tool: ToolId, snapping: boolean, canUndo: boolean, canRedo: boolean): void {
    for (const [id, button] of this.toolButtons) setPressed(button, id === tool);
    setPressed(this.snapButton, snapping);
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
  }

  /**
   * Makes a toolbar icon button.
   * @param glyph the SVG icon.
   * @param label accessible name.
   * @param shortcut key shown in the tooltip.
   * @param onClick the action.
   * @returns the button.
   */
  private button(glyph: IconName, label: string, shortcut: string | undefined, onClick: () => void): HTMLButtonElement {
    return iconButton({ icon: glyph, label, shortcut, className: 'tl-tool-btn', onClick: () => onClick(), signal: this.abort.signal });
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
