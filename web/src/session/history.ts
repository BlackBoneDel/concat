// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Undo/redo for the document: a snapshot stack in wire form. Cheap (the
 * documents are small) and honest — every mutation that matters calls
 * {@link History.push} first, and undo/redo round-trips through
 * `toDocument`/`fromDocument` like every other load.
 */

import { fromDocument, toDocument } from '../model/document.ts';
import type { ProjectDocument } from '../model/index.ts';
import type { Json } from '../model/wire.ts';

/** How many states each side keeps. */
const LIMIT = 100;

/** Snapshot history of one document. */
export class History {
  private undoStack: Json[] = [];
  private redoStack: Json[] = [];

  /**
   * Records the *current* state before a mutation.
   * @param document the state about to change.
   * @param settings the manifest fields (`toDocument` needs them).
   */
  push(document: ProjectDocument, settings: { name: string; width: number; height: number; rateNum: number; rateDen: number }): void {
    this.undoStack.push(toDocument(settings, document));
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Whether an undo is available. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether a redo is available. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Steps back.
   * @param current the state to save for redo.
   * @returns the restored document, or `null`.
   */
  undo(current: ProjectDocument, settings: { name: string; width: number; height: number; rateNum: number; rateDen: number }): ProjectDocument | null {
    const previous = this.undoStack.pop();
    if (previous === undefined) return null;
    this.redoStack.push(toDocument(settings, current));
    return fromDocument(previous);
  }

  /**
   * Steps forward again.
   * @param current the state to save for undo.
   * @returns the restored document, or `null`.
   */
  redo(current: ProjectDocument, settings: { name: string; width: number; height: number; rateNum: number; rateDen: number }): ProjectDocument | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(toDocument(settings, current));
    return fromDocument(next);
  }

  /** Forgets everything (new project, load). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
