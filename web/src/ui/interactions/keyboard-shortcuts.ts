// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Timeline keyboard shortcuts. Keys never fire while an input, textarea or
 * contentEditable element has focus, so typing is always safe.
 */

import type { ToolId } from '../timeline/types.ts';

/** The actions keys can trigger. */
export interface ShortcutActions {
  /** Switches the active tool. */
  setTool(tool: ToolId): void;
  /** Toggles snapping. */
  toggleSnapping(): void;
  /** Toggles play/pause. */
  togglePlayback(): void;
  /** Moves the playhead home. */
  goHome(): void;
  /** Moves the playhead to the end. */
  goEnd(): void;
  /** Step one frame backward. */
  stepBackward(): void;
  /** Step one frame forward. */
  stepForward(): void;
  /** Splits at the playhead. */
  splitAtPlayhead(): void;
  /** Deletes the selection (lift). */
  deleteSelection(): void;
  /** Ripple-deletes the selection. */
  rippleDeleteSelection(): void;
  /** Duplicates the selection. */
  duplicateSelection(): void;
  /** Selects every clip. */
  selectAll(): void;
  /** Deselects everything. */
  selectNone(): void;
  /** Groups the selection. */
  groupSelection(): void;
  /** Ungroups the selection. */
  ungroupSelection(): void;
  /** Links the selection. */
  linkSelection(): void;
  /** Unlinks the selection. */
  unlinkSelection(): void;
  /** Copies the selection. */
  copy(): void;
  /** Cuts the selection. */
  cut(): void;
  /** Pastes at the playhead. */
  paste(): void;
  /** Undo. */
  undo(): void;
  /** Redo. */
  redo(): void;
  /** Adds a marker at the playhead. */
  addMarker(): void;
  /** Zooms the timeline in. */
  zoomIn(): void;
  /** Zooms the timeline out. */
  zoomOut(): void;
  /** Zooms to fit. */
  zoomFit(): void;
  /** Toggles clip enabled. */
  toggleEnabled(): void;
  /** Saves the project (Ctrl+S). */
  saveProject(): void;
}

/** True when a keystroke belongs to text editing, not the timeline. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable;
}

/** Wires global keys to actions; `dispose` removes the listener. */
export function installKeyboardShortcuts(
  actions: ShortcutActions,
): { dispose(): void } {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    // Dialogs own the keyboard while they are open.
    if (typeof document !== 'undefined' && document.querySelector('.modal-backdrop') !== null) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (ctrl) {
      switch (key) {
        case 'z':
          event.preventDefault();
          if (event.shiftKey) actions.redo();
          else actions.undo();
          return;
        case 'y':
          event.preventDefault();
          actions.redo();
          return;
        case 'c':
          event.preventDefault();
          actions.copy();
          return;
        case 'x':
          event.preventDefault();
          actions.cut();
          return;
        case 'v':
          event.preventDefault();
          actions.paste();
          return;
        case 'a':
          event.preventDefault();
          actions.selectAll();
          return;
        case 'd':
          event.preventDefault();
          actions.duplicateSelection();
          return;
        case 'g':
          event.preventDefault();
          if (event.shiftKey) actions.ungroupSelection();
          else actions.groupSelection();
          return;
        case 'l':
          event.preventDefault();
          if (event.shiftKey) actions.unlinkSelection();
          else actions.linkSelection();
          return;
        case 'k':
          event.preventDefault();
          actions.splitAtPlayhead();
          return;
        case '=':
        case '+':
          event.preventDefault();
          actions.zoomIn();
          return;
        case '-':
          event.preventDefault();
          actions.zoomOut();
          return;
        case '0':
          event.preventDefault();
          actions.zoomFit();
          return;
        case 's':
          // Ctrl+S is the app-level 'save' action: handled there, once.
          event.preventDefault();
          return;
        default:
          return;
      }
    }
    switch (key) {
      case 'v':
        actions.setTool('select');
        break;
      case 'c':
        actions.setTool('blade');
        break;
      case 'b':
        actions.setTool('ripple');
        break;
      case 'n':
        actions.setTool('slip');
        break;
      case 'y':
        actions.setTool('slide');
        break;
      case 'u':
        actions.setTool('roll');
        break;
      case 'p':
        actions.setTool('pen');
        break;
      case 'h':
        actions.setTool('hand');
        break;
      case 's':
        actions.toggleSnapping();
        break;
      case ' ':
        event.preventDefault();
        actions.togglePlayback();
        break;
      case 'home':
        event.preventDefault();
        actions.goHome();
        break;
      case 'end':
        event.preventDefault();
        actions.goEnd();
        break;
      case 'arrowleft':
        event.preventDefault();
        actions.stepBackward();
        break;
      case 'arrowright':
        event.preventDefault();
        actions.stepForward();
        break;
      case 'm':
        actions.addMarker();
        break;
      case 'e':
        actions.toggleEnabled();
        break;
      case 'escape':
        actions.selectNone();
        break;
      case 'delete':
      case 'backspace':
        event.preventDefault();
        if (event.shiftKey) actions.rippleDeleteSelection();
        else actions.deleteSelection();
        break;
      default:
        break;
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return {
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
