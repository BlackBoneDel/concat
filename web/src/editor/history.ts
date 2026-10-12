// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The undo/redo engine: every edit lands here as an {@link EditOperation},
 * gets its inverse recorded, and becomes one step of the history. Gestures
 * (drags) wrap several ops in a transaction so the whole gesture is one undo
 * step; rapid same-field edits merge into one another.
 */

import type { ProjectDocument } from '../model/document.ts';
import {
  CompoundOperation,
  EditError,
  cloneDocument,
  type EditOperation,
} from './operations.ts';

/** One line of the history list. */
export interface HistoryEntry {
  name: string;
  description: string;
  timestamp: number;
}

/** A stored undo step. */
interface UndoStep {
  operation: EditOperation;
  inverse: EditOperation;
}

/** Long, bounded, transactional undo/redo over one document. */
export class EditHistory {
  /** Fired after the document changes (execute/undo/redo/commit). */
  onChange: ((doc: ProjectDocument, op: EditOperation | null) => void) | null = null;
  /** Fired when a transaction commits as one unit. */
  onTransactionCommitted: ((name: string, opsCount: number) => void) | null = null;

  private doc: ProjectDocument;
  private readonly maxSize: number;
  private undoSteps: UndoStep[] = [];
  private redoSteps: UndoStep[] = [];
  private transactionName: string | null = null;
  private transactionBuffer: EditOperation[] = [];

  /**
   * @param initialDoc the document the history starts from.
   * @param maxSize how many undo steps to keep (500 by default).
   */
  constructor(initialDoc: ProjectDocument, maxSize = 500) {
    this.doc = cloneDocument(initialDoc);
    this.maxSize = Math.max(1, maxSize);
  }

  /** The current document. */
  get currentDoc(): ProjectDocument {
    return this.doc;
  }

  /** The undo steps, oldest first. */
  get undoStack(): ReadonlyArray<EditOperation> {
    return this.undoSteps.map((step) => step.operation);
  }

  /** The redo steps, oldest first. */
  get redoStack(): ReadonlyArray<EditOperation> {
    return this.redoSteps.map((step) => step.operation);
  }

  /** True when a transaction is collecting ops. */
  isInTransaction(): boolean {
    return this.transactionName !== null;
  }

  /**
   * Runs one edit.
   * @param op the operation to apply.
   * @throws EditError when the operation is invalid (nothing changes).
   */
  execute(op: EditOperation): void {
    if (this.isInTransaction()) {
      // Buffer only: the transaction commits atomically.
      this.transactionBuffer.push(op);
      return;
    }
    const inverse = op.inverse(this.doc);
    const next = op.apply(this.doc);
    this.doc = next;

    // Merge rapid same-gesture edits into the top step.
    const top = this.undoSteps[this.undoSteps.length - 1];
    if (top && top.operation.merge) {
      const merged = top.operation.merge(op);
      if (merged) {
        top.operation = merged;
        top.inverse = new CompoundOperation('undo:merged', [inverse, top.inverse]);
        this.redoSteps = [];
        this.onChange?.(this.doc, merged);
        return;
      }
    }

    this.undoSteps.push({ operation: op, inverse });
    if (this.undoSteps.length > this.maxSize) this.undoSteps.shift();
    this.redoSteps = [];
    this.onChange?.(this.doc, op);
  }

  /**
   * Steps back one undo unit.
   * @returns the restored document, or `null` when there is nothing to undo.
   */
  undo(): ProjectDocument | null {
    if (this.isInTransaction()) this.cancelTransaction();
    const step = this.undoSteps.pop();
    if (!step) return null;
    this.doc = step.inverse.apply(this.doc);
    this.redoSteps.push(step);
    this.onChange?.(this.doc, step.operation);
    return this.doc;
  }

  /**
   * Steps forward one redo unit.
   * @returns the restored document, or `null` when there is nothing to redo.
   */
  redo(): ProjectDocument | null {
    if (this.isInTransaction()) this.cancelTransaction();
    const step = this.redoSteps.pop();
    if (!step) return null;
    this.doc = step.operation.apply(this.doc);
    this.undoSteps.push(step);
    this.onChange?.(this.doc, step.operation);
    return this.doc;
  }

  /** True when a step can be undone. */
  canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  /** True when a step can be redone. */
  canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  /** Forgets everything (new project, load). */
  clear(): void {
    this.undoSteps = [];
    this.redoSteps = [];
    this.transactionName = null;
    this.transactionBuffer = [];
  }

  /**
   * Re-bases the history on a document that changed outside it (project
   * load, media import): new baseline, stacks forgotten.
   * @param doc the new starting document.
   */
  rebase(doc: ProjectDocument): void {
    this.clear();
    this.doc = cloneDocument(doc);
  }

  /**
   * Starts collecting ops into one undo unit.
   * @param name the gesture name ("Move clips", …).
   */
  beginTransaction(name: string): void {
    if (this.isInTransaction()) this.commitTransaction();
    this.transactionName = name;
    this.transactionBuffer = [];
  }

  /**
   * Applies the buffered ops as one compound step.
   * @throws EditError when any op fails; the document stays untouched.
   */
  commitTransaction(): void {
    const name = this.transactionName;
    const buffer = this.transactionBuffer;
    this.transactionName = null;
    this.transactionBuffer = [];
    if (!name || buffer.length === 0) return;

    // Build the compound and its exact inverse, applying as we go so each
    // op validates against the state it will really see.
    const inverses: EditOperation[] = [];
    let state = this.doc;
    try {
      for (const operation of buffer) {
        inverses.unshift(operation.inverse(state));
        state = operation.apply(state);
      }
    } catch (error) {
      // Nothing was applied — the document is intact.
      this.onChange?.(this.doc, null);
      if (error instanceof EditError) throw error;
      throw new EditError(error instanceof Error ? error.message : String(error));
    }
    this.doc = state;
    const operation = new CompoundOperation(name, buffer);
    this.undoSteps.push({ operation, inverse: new CompoundOperation(`undo:${name}`, inverses) });
    if (this.undoSteps.length > this.maxSize) this.undoSteps.shift();
    this.redoSteps = [];
    this.onTransactionCommitted?.(name, buffer.length);
    this.onChange?.(this.doc, operation);
  }

  /** Drops the buffered ops without touching the document. */
  cancelTransaction(): void {
    this.transactionName = null;
    this.transactionBuffer = [];
    this.onChange?.(this.doc, null);
  }

  /**
   * The visible history, newest first.
   * @returns name, description and time of each undo step.
   */
  getHistoryList(): HistoryEntry[] {
    return this.undoSteps
      .map((step) => ({
        name: step.operation.name,
        description: step.operation.describe(),
        timestamp: step.operation.timestamp,
      }))
      .reverse();
  }
}
