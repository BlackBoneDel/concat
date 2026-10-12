// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** EditHistory: undo/redo, transactions and gesture merging. */

import { describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import {
  CompoundOperation,
  MoveClipOperation,
  SetClipPropertyOperation,
  SplitClipOperation,
} from '../src/editor/operations.ts';
import { EditHistory } from '../src/editor/history.ts';
import { makeSession, r, snap } from './f3-helpers.ts';
import { currentTimeline, requireClip } from '../src/editor/operations.ts';
import type { EditHistory as EditHistoryType } from '../src/editor/history.ts';

/** A clip from the history's current document. */
function clipIn(history: EditHistoryType, id: string) {
  return requireClip(history.currentDoc, id);
}

describe('EditHistory', () => {
  it('execute aplica y registra el paso', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    const before = history.currentDoc;
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)));
    expect(history.undoStack).toHaveLength(1);
    expect(clipIn(history, 'c1').start).toBeCloseTo(1, 6);
    void before;
  });

  it('undo y redo restauran el documento exacto', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    const before = snap(history.currentDoc);
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)));
    const after = snap(history.currentDoc);
    expect(history.undo()).not.toBeNull();
    expect(snap(history.currentDoc)).toBe(before);
    expect(history.redo()).not.toBeNull();
    expect(snap(history.currentDoc)).toBe(after);
  });

  it('deshacer sin pasos devuelve null', () => {
    const session = makeSession([]);
    const history = new EditHistory(session.document);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it('una transacción se deshace como una unidad', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    const before = snap(history.currentDoc);
    history.beginTransaction('Arrastre');
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)));
    history.execute(new SetClipPropertyOperation('c1', 'name', 'clip1', 'Renombrado'));
    expect(history.currentDoc).toBeDefined();
    // Buffered: not applied until commit.
    history.commitTransaction();
    expect(history.undoStack).toHaveLength(1);
    expect(clipIn(history, 'c1').start).toBeCloseTo(1, 6);
    history.undo();
    expect(snap(history.currentDoc)).toBe(before);
  });

  it('cancelTransaction descarta el gesto sin tocar el documento', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    const before = snap(history.currentDoc);
    history.beginTransaction('Arrastre');
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)));
    history.cancelTransaction();
    expect(snap(history.currentDoc)).toBe(before);
    expect(history.undoStack).toHaveLength(0);
  });

  it('merge fusiona ops de gesto seguidas (300ms)', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)));
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(1), r(2)));
    expect(history.undoStack).toHaveLength(1);
    expect(clipIn(history, 'c1').start).toBeCloseTo(2, 6);
    history.undo();
    expect(clipIn(history, 'c1').start).toBeCloseTo(0, 6);
  });

  it('merge de SetClipProperty por 500ms', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    history.execute(new SetClipPropertyOperation('c1', 'opacity', 1, 0.8));
    history.execute(new SetClipPropertyOperation('c1', 'opacity', 0.8, 0.6));
    expect(history.undoStack).toHaveLength(1);
    expect(clipIn(history, 'c1').opacity).toBeCloseTo(0.6, 6);
    history.undo();
    expect(clipIn(history, 'c1').opacity).toBe(1);
  });

  it('sin merge entre clases de op distintas', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)));
    history.execute(new SetClipPropertyOperation('c1', 'opacity', 1, 0.5));
    expect(history.undoStack).toHaveLength(2);
  });

  it('op inválida no toca nada y propaga EditError', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    const before = snap(history.currentDoc);
    expect(() =>
      history.execute(new MoveClipOperation('c1', 'T1', 'T-NOPE', r(0), r(1))),
    ).toThrow();
    expect(snap(history.currentDoc)).toBe(before);
    expect(history.undoStack).toHaveLength(0);
  });

  it('la transacción es atómica: la inversa compuesta deshace todo', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    const history = new EditHistory(session.document);
    const before = snap(history.currentDoc);
    history.beginTransaction('Doble split');
    history.execute(new SplitClipOperation('c1', r(1), 'c-tail1'));
    history.execute(new SplitClipOperation('c2', r(3), 'c-tail2'));
    history.commitTransaction();
    expect(history.currentDoc.timelines[0]!.clips).toHaveLength(4);
    history.undo();
    expect(snap(history.currentDoc)).toBe(before);
  });

  it('maxSize limita el historial a 500 pasos', () => {
    const session = makeSession([{ start: 0, duration: 100 }]);
    const history = new EditHistory(session.document, 500);
    for (let i = 0; i < 520; i += 1) {
      history.execute(
        new SetClipPropertyOperation('c1', 'name', `n${i}`, `n${i + 1}`, ),
      );
    }
    expect(history.undoStack.length).toBeLessThanOrEqual(500);
  });

  it('onChange notifica cada cambio', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    const spy = vi.fn();
    history.onChange = spy;
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)));
    expect(spy).toHaveBeenCalledTimes(1);
    history.beginTransaction('x');
    history.execute(new SetClipPropertyOperation('c1', 'opacity', 1, 0.5));
    history.commitTransaction();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rebase cambia la base y vacía las pilas', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    history.execute(new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)));
    const other = makeSession([{ start: 5, duration: 1 }]);
    history.rebase(other.document);
    expect(history.undoStack).toHaveLength(0);
    expect(history.currentDoc.timelines[0]!.clips[0]!.start).toBeCloseTo(5, 6);
  });

  it('CompoundOperation en una transacción', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const history = new EditHistory(session.document);
    const before = snap(history.currentDoc);
    history.execute(
      new CompoundOperation('combo', [
        new SetClipPropertyOperation('c1', 'opacity', 1, 0.5),
        new SetClipPropertyOperation('c1', 'volume', 1, 0.5),
      ]),
    );
    history.undo();
    expect(snap(history.currentDoc)).toBe(before);
    void Rational.ZERO;
  });
});
