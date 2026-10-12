// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The timeline toolbar, restyled as the CapCut-style HUD bar of Fase 8:
 * a left group with the edit actions (add track, undo/redo, split, delete),
 * the tool switcher, the snapping magnet (green while active), text and
 * preview mute; and a right group with the cursor indicator and the zoom
 * controls.
 *
 * Every button is a `.timeline-toolbar-btn` icon button (inline SVG, native
 * tooltip, no emoji anywhere), so the bar reads the same in the three themes.
 * Actions newer than Fase 7 are optional: a host that does not pass them
 * simply gets the button disabled instead of a broken layout.
 */

import type { ToolId } from './types.ts';
import { icon, iconButton, setPressed, type IconName } from '../components/icons.ts';
import { PREVIEW_MUTE_EVENT } from '../ui-events.ts';

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
  /** Fase 8: adds a title clip at the playhead. */
  addText?(): void;
  /** Fase 8: the right group's zoom controls (the zoom slot keeps its slider). */
  zoomIn?(): void;
  zoomOut?(): void;
  zoomFit?(): void;
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

/** The label the cursor indicator shows per tool. */
const TOOL_LABELS: Readonly<Record<ToolId, string>> = {
  select: 'Selección',
  blade: 'Cuchilla',
  ripple: 'Ripple',
  roll: 'Roll',
  slip: 'Slip',
  slide: 'Slide',
  pen: 'Pluma',
  hand: 'Mano',
};

/** The toolbar row. */
export class Toolbar {
  readonly element: HTMLElement;
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  private readonly snapButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly cursorLabel: HTMLElement;
  private readonly cursorIcon: HTMLElement;
  private readonly abort = new AbortController();

  /**
   * @param actions button wiring.
   * @param zoomSlot element to append in the right group (the zoom control).
   */
  constructor(actions: ToolbarActions, zoomSlot?: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'tl-toolbar';
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', 'Herramientas del timeline');

    const left = document.createElement('div');
    left.className = 'tl-toolbar-group tl-toolbar-left';
    const right = document.createElement('div');
    right.className = 'tl-toolbar-group tl-toolbar-right';

    // Add lane, then the history pair.
    const add = this.button('videoPlus', 'Añadir pista de vídeo', undefined, () => actions.addTrack('video'));
    add.classList.add('tl-tool-add');
    const addAudio = this.button('audioPlus', 'Añadir pista de audio', undefined, () => actions.addTrack('audio'));
    addAudio.classList.add('tl-tool-add-audio');
    this.undoButton = this.button('undo', 'Deshacer', 'Ctrl+Z', () => actions.undo());
    this.redoButton = this.button('redo', 'Rehacer', 'Ctrl+Y', () => actions.redo());
    left.append(add, addAudio, this.separator(), this.undoButton, this.redoButton);

    // Split / delete.
    left.append(
      this.separator(),
      this.button('split', 'Dividir en el playhead', 'Ctrl+K', () => actions.splitAtPlayhead()),
      this.button('trash', 'Eliminar selección', 'Supr', () => actions.deleteSelection()),
    );

    // The tool switcher (V C B N U Y P).
    left.appendChild(this.separator());
    for (const tool of TOOL_BUTTONS) {
      const button = this.button(tool.icon, tool.label, tool.key, () => actions.setTool(tool.id));
      button.classList.add(`tl-tool-${tool.id}`);
      setPressed(button, tool.id === 'select');
      this.toolButtons.set(tool.id, button);
      left.appendChild(button);
    }

    // Hand, snapping magnet, text and mute.
    const hand = this.button('hand', 'Mano (desplazar)', 'H', () => actions.setTool('hand'));
    hand.classList.add('tl-tool-hand');
    setPressed(hand, false);
    this.toolButtons.set('hand', hand);
    this.snapButton = this.button('magnet', 'Snapping magnético', 'S', () => actions.toggleSnapping());
    this.snapButton.classList.add('timeline-toolbar-snap');
    setPressed(this.snapButton, true);
    const text = this.button('text', 'Añadir texto', 'T', () => actions.addText?.());
    text.classList.add('tl-tool-text');
    if (!actions.addText) text.disabled = true;
    const mute = this.button('volumeMute', 'Silenciar la previsualización', undefined, () => {
      document.dispatchEvent(new CustomEvent(PREVIEW_MUTE_EVENT));
    });
    mute.classList.add('tl-tool-mute');
    left.append(this.separator(), hand, this.snapButton, text, mute);

    // Right group: what the pointer is doing, then the zoom controls.
    const cursor = document.createElement('span');
    cursor.className = 'tl-cursor-indicator';
    this.cursorIcon = document.createElement('span');
    this.cursorIcon.className = 'tl-cursor-icon';
    this.cursorIcon.appendChild(icon('cursor', { size: 14 }));
    this.cursorLabel = document.createElement('span');
    this.cursorLabel.className = 'tl-cursor-label';
    this.cursorLabel.textContent = TOOL_LABELS.select;
    cursor.append(this.cursorIcon, this.cursorLabel);
    right.appendChild(cursor);
    if (zoomSlot) right.appendChild(zoomSlot);
    else {
      right.append(
        this.button('zoomOut', 'Alejar', 'Ctrl+-', () => actions.zoomOut?.()),
        this.button('fit', 'Ajustar al proyecto', 'Ctrl+0', () => actions.zoomFit?.()),
        this.button('zoomIn', 'Acercar', 'Ctrl+=', () => actions.zoomIn?.()),
      );
    }

    this.element.append(left, right);
  }

  /**
   * Marks the active tool and toggle states.
   * @param tool the current tool.
   * @param snapping whether the magnet is armed.
   * @param canUndo whether Undo has history behind it.
   * @param canRedo whether Redo has history ahead of it.
   */
  setTool(tool: ToolId, snapping: boolean, canUndo: boolean, canRedo: boolean): void {
    for (const [id, button] of this.toolButtons) setPressed(button, id === tool);
    setPressed(this.snapButton, snapping);
    this.snapButton.classList.toggle('snap-active', snapping);
    this.snapButton.title = snapping ? 'Snapping magnético activo (S)' : 'Snapping magnético (S)';
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
    this.cursorLabel.textContent = TOOL_LABELS[tool];
    const glyph: IconName = tool === 'hand' ? 'hand' : tool === 'select' ? 'cursor' : 'sliders';
    this.cursorIcon.replaceChildren(icon(glyph, { size: 14 }));
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
    return iconButton({
      icon: glyph,
      label,
      shortcut,
      className: 'tl-tool-btn timeline-toolbar-btn',
      onClick: () => onClick(),
      signal: this.abort.signal,
    });
  }

  /** A separator between control groups. */
  private separator(): HTMLElement {
    const divider = document.createElement('span');
    divider.className = 'tl-toolbar-divider timeline-toolbar-separator';
    divider.setAttribute('aria-hidden', 'true');
    return divider;
  }

  /** Removes listeners and the element. */
  dispose(): void {
    this.abort.abort();
    this.element.remove();
  }
}
