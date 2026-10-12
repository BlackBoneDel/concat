// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** SelectionManager and ClipboardManager. */

import { describe, expect, it, vi } from 'vitest';
import { SelectionManager, markerAt } from '../src/editor/selection.ts';
import { ClipboardManager } from '../src/editor/clipboard.ts';
import { EditError, GroupClipsOperation, LinkClipsOperation, currentTimeline } from '../src/editor/operations.ts';
import { makeSession, r } from './f3-helpers.ts';

describe('SelectionManager', () => {
  it('selectClip / isSelected / clearSelection', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 2, duration: 1 }]);
    const selection = new SelectionManager();
    selection.selectClip('c1', false, session.document);
    expect(selection.isSelected('c1')).toBe(true);
    expect(selection.selectionCount).toBe(1);
    selection.clearSelection();
    expect(selection.hasSelection).toBe(false);
  });

  it('selectClip aditivo acumula', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 2, duration: 1 }]);
    const selection = new SelectionManager();
    selection.selectClip('c1', false, session.document);
    selection.selectClip('c2', true, session.document);
    expect(selection.selectionCount).toBe(2);
  });

  it('toggleClip alterna', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const selection = new SelectionManager();
    selection.toggleClip('c1', session.document);
    expect(selection.isSelected('c1')).toBe(true);
    selection.toggleClip('c1', session.document);
    expect(selection.isSelected('c1')).toBe(false);
  });

  it('selectClips expande grupos y links', () => {
    const session = makeSession([
      { start: 0, duration: 1 },
      { start: 2, duration: 1 },
      { start: 4, duration: 1 },
    ]);
    const doc = session.document;
    const selection = new SelectionManager();
    const grouped = new GroupClipsOperation(['c1', 'c2'], 'g-1').apply(doc);
    const linked = new LinkClipsOperation(['c1', 'c3'], 'l-1').apply(grouped);
    selection.selectClips(['c1'], false, linked);
    expect(selection.isSelected('c2')).toBe(true);
    expect(selection.isSelected('c3')).toBe(true);
  });

  it('selectRange toma el intervalo', () => {
    const session = makeSession([
      { start: 0, duration: 1 },
      { start: 2, duration: 1 },
      { start: 4, duration: 1 },
    ]);
    const selection = new SelectionManager();
    selection.selectRange(r(1.5), r(5), ['T1'], session.document, false);
    expect(selection.isSelected('c1')).toBe(false);
    expect(selection.isSelected('c2')).toBe(true);
    expect(selection.isSelected('c3')).toBe(true);
  });

  it('selectAll / selectAllInTrack', () => {
    const session = makeSession([
      { start: 0, duration: 1 },
      { trackId: 'T2', start: 0, duration: 1 },
    ]);
    const selection = new SelectionManager();
    selection.selectAll(session.document);
    expect(selection.selectionCount).toBe(2);
    selection.clearSelection();
    selection.selectAllInTrack('T1', session.document);
    expect(selection.selectionCount).toBe(1);
    expect(selection.isSelected('c1')).toBe(true);
  });

  it('selectionBounds devuelve el intervalo', () => {
    const session = makeSession([{ start: 1, duration: 2 }, { start: 5, duration: 1 }]);
    const selection = new SelectionManager();
    selection.selectClips(['c1', 'c2'], false, session.document);
    const bounds = selection.selectionBounds(session.document);
    expect(bounds).not.toBeNull();
    expect(bounds!.start.asNumber()).toBeCloseTo(1, 6);
    expect(bounds!.end.asNumber()).toBeCloseTo(6, 6);
  });

  it('onSelectionChanged avisa', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const selection = new SelectionManager();
    const spy = vi.fn();
    selection.onSelectionChanged = spy;
    selection.selectClip('c1', false, session.document);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]![0].has('c1')).toBe(true);
  });

  it('selectedClipIds expone el conjunto', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const selection = new SelectionManager();
    selection.selectClips(['c1'], false, session.document);
    expect([...selection.selectedClipIds]).toEqual(['c1']);
  });

  it('markerAt encuentra el marker más cercano', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const markers = [
      { id: 'm-1', time: r(3), label: 'a', color: '#fff', note: '' },
      { id: 'm-2', time: r(8), label: 'b', color: '#fff', note: '' },
    ];
    void session;
    expect(markerAt(markers, r(3.02))?.id).toBe('m-1');
    expect(markerAt(markers, r(7.5), 0.6)?.id).toBe('m-2');
    expect(markerAt(markers, r(5))).toBeNull();
  });
});

describe('ClipboardManager', () => {
  it('copy / paste pone copias con ids nuevos', () => {
    const session = makeSession([{ start: 1, duration: 2 }, { start: 4, duration: 1 }]);
    const clipboard = new ClipboardManager();
    clipboard.copy(['c1', 'c2'], session.document);
    expect(clipboard.hasContent).toBe(true);
    expect(clipboard.clipboardSize).toBe(2);
    const op = clipboard.paste(r(10), 'T1', session.document, 'overwrite');
    const after = op.apply(session.document);
    const clips = currentTimeline(after).clips;
    expect(clips).toHaveLength(4);
    const ids = clips.map((clip) => clip.id);
    expect(new Set(ids).size).toBe(4);
    // Relative offsets preserved (c1 at +0, c2 at +3).
    const pasted = clips.filter((clip) => !['c1', 'c2'].includes(clip.id)).sort((a, b) => a.start - b.start);
    expect(pasted[0]!.start).toBeCloseTo(10, 6);
    expect(pasted[1]!.start).toBeCloseTo(13, 6);
  });

  it('cut devuelve la op de borrado y copia', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 2, duration: 1 }]);
    const clipboard = new ClipboardManager();
    const op = clipboard.cut(['c1'], session.document);
    const after = op.apply(session.document);
    expect(currentTimeline(after).clips).toHaveLength(1);
    expect(clipboard.clipboardSize).toBe(1);
  });

  it('paste conserva grupos con ids frescos', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 2, duration: 1 }]);
    const grouped = new GroupClipsOperation(['c1', 'c2'], 'g-1').apply(session.document);
    const clipboard = new ClipboardManager();
    clipboard.copy(['c1', 'c2'], grouped);
    const op = clipboard.paste(r(10), 'T1', grouped, 'overwrite');
    const after = op.apply(grouped);
    const pasted = currentTimeline(after).clips.filter((clip) => clip.extra['groupId'] === 'g-1');
    expect(pasted).toHaveLength(2);
    const newGroup = currentTimeline(after).clips
      .filter((clip) => !['c1', 'c2'].includes(clip.id))
      .map((clip) => clip.extra['groupId']);
    expect(newGroup[0]).toMatch(/^g-/);
    expect(newGroup[0]).not.toBe('g-1');
  });

  it('paste con medio faltante lo marca deshabilitado', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const clipboard = new ClipboardManager();
    clipboard.copy(['c1'], session.document);
    const stripped = JSON.parse(JSON.stringify(session.document)) as typeof session.document;
    stripped.media = [];
    const op = clipboard.paste(r(5), 'T1', stripped, 'overwrite');
    const after = op.apply(stripped);
    const pasted = currentTimeline(after).clips.find((clip) => clip.start > 4);
    expect(pasted?.extra['missing']).toBe(true);
    expect(pasted?.extra['enabled']).toBe(false);
  });

  it('paste vacío lanza EditError', () => {
    const session = makeSession([]);
    const clipboard = new ClipboardManager();
    expect(() => clipboard.paste(r(0), 'T1', session.document)).toThrow(EditError);
  });

  it('clear vacía el portapapeles', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const clipboard = new ClipboardManager();
    clipboard.copy(['c1'], session.document);
    clipboard.clear();
    expect(clipboard.hasContent).toBe(false);
  });
});
