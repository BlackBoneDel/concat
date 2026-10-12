// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * End-to-end editing through `EditSession`: the high-level commands, one
 * history step per gesture, Escape-safe transactions, and the Fase-3
 * integration flow (drag → undo → redo).
 */

import { describe, expect, it } from 'vitest';
import {
  currentTimeline,
  requireClip,
  transitionIdOf,
} from '../src/editor/operations.ts';
import { EditSession } from '../src/session/edit-session.ts';
import { clipById, clipsOf, makeMedia, makeSession, r, snap } from './f3-helpers.ts';

describe('EditSession: alto nivel', () => {
  it('moveClip mueve y es un solo paso de undo', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = snap(session.document);
    session.moveClip('c1', 'T2', 3);
    expect(clipById(session, 'c1').trackId).toBe('T2');
    expect(clipById(session, 'c1').start).toBeCloseTo(3, 6);
    session.undo();
    expect(snap(session.document)).toBe(before);
    session.redo();
    expect(clipById(session, 'c1').start).toBeCloseTo(3, 6);
  });

  it('trimClip recorta un borde', () => {
    const session = makeSession([{ start: 1, duration: 3 }]);
    session.trimClip('c1', 'out', 3);
    expect(clipById(session, 'c1').duration).toBeCloseTo(2, 6);
    session.trimClip('c1', 'in', 2);
    expect(clipById(session, 'c1').start).toBeCloseTo(2, 6);
    expect(clipById(session, 'c1').duration).toBeCloseTo(1, 6);
  });

  it('splitClip parte y devuelve el id de la cola', () => {
    const session = makeSession([{ start: 0, duration: 4 }]);
    const tailId = session.splitClip('c1', 2);
    expect(tailId).not.toBeNull();
    expect(clipsOf(session)).toHaveLength(2);
    expect(clipById(session, tailId!).start).toBeCloseTo(2, 6);
    // Undo merges back.
    session.undo();
    expect(clipsOf(session)).toHaveLength(1);
  });

  it('splitClip rechaza cortes fuera del clip', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    expect(session.splitClip('c1', 5)).toBeNull();
    expect(session.splitClip('c1', 0.001)).toBeNull();
  });

  it('deleteClips lift y ripple', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 1, duration: 1 }]);
    session.deleteClips(['c1'], 'ripple');
    expect(clipsOf(session)).toHaveLength(1);
    expect(clipById(session, 'c2').start).toBeCloseTo(0, 6);
    session.undo();
    expect(clipsOf(session)).toHaveLength(2);
  });

  it('insertClip inserta con modo insert/overwrite', () => {
    const session = makeSession([{ start: 2, duration: 1 }]);
    const clip = session.makeClip('m1', 'T1', 0);
    clip.duration = 1;
    session.insertClip(clip, 'insert');
    expect(clipsOf(session)).toHaveLength(2);
    expect(clipById(session, 'c1').start).toBeCloseTo(3, 6);
  });

  it('addTrack / deleteTrack', () => {
    const session = makeSession([]);
    const id = session.addTrack('audio');
    expect(id).toMatch(/^T-/);
    expect(currentTimeline(session.document).tracks).toHaveLength(5);
    session.deleteTrack(id!);
    expect(currentTimeline(session.document).tracks).toHaveLength(4);
  });

  it('group / ungroup / link / unlink', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 2, duration: 1 }]);
    session.groupClips(['c1', 'c2']);
    expect(clipById(session, 'c1').extra['groupId']).toBeDefined();
    session.ungroupClips(['c1']);
    expect(clipById(session, 'c1').extra['groupId']).toBeUndefined();
    session.linkClips(['c1', 'c2']);
    expect(clipById(session, 'c1').extra['linkId']).toBeDefined();
    session.unlinkClips(['c1']);
    expect(clipById(session, 'c1').extra['linkId']).toBeUndefined();
  });

  it('addMarker + markers() + undo', () => {
    const session = makeSession([]);
    const id = session.addMarker(5, 'Acto 2', '#123456');
    expect(id).not.toBeNull();
    expect(session.markers()).toHaveLength(1);
    expect(session.markers()[0]!.label).toBe('Acto 2');
    session.undo();
    expect(session.markers()).toHaveLength(0);
  });

  it('setClipProperty + toggleClipEnabled', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    session.setClipProperty('c1', 'volume', 0.5);
    expect(clipById(session, 'c1').volume).toBeCloseTo(0.5, 6);
    session.setClipProperty('c1', 'name', 'Renombrado');
    expect(clipById(session, 'c1').name).toBe('Renombrado');
    session.toggleClipEnabled('c1');
    expect(clipById(session, 'c1').extra['enabled']).toBe(false);
  });

  it('setSpeed y setTransition', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    session.setTransition('c2', 'crossfade', 0.8);
    expect(clipById(session, 'c2').transitionIn?.id).toBe('crossfade');
    session.setTransition('c2', null);
    expect(clipById(session, 'c2').transitionIn).toBeNull();
    session.setSpeed('c1', 2);
    expect(clipById(session, 'c1').speed).toBe(2);
  });

  it('addKeyframe guarda la fracción y se puede deshacer', () => {
    const session = makeSession([{ start: 0, duration: 4 }]);
    session.addKeyframe('c1', 'opacity', 0.5, 0.25);
    const keys = clipById(session, 'c1').keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.at).toBeCloseTo(0.5, 6);
    expect(keys[0]!.value).toBeCloseTo(0.25, 6);
    session.undo();
    expect(clipById(session, 'c1').keys).toHaveLength(0);
  });

  it('copy / cut / paste con ids nuevos', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    session.copyClips(['c1']);
    session.pasteClips(5, 'T1', 'overwrite');
    expect(clipsOf(session)).toHaveLength(2);
    const pasted = clipsOf(session).find((clip) => clip.id !== 'c1');
    expect(pasted!.id).not.toBe('c1');
    expect(pasted!.start).toBeCloseTo(5, 6);
    session.cutClips(['c1']);
    expect(clipsOf(session)).toHaveLength(1);
  });

  it('duplicateClips copia tras el original', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    session.duplicateClips(['c1']);
    expect(clipsOf(session)).toHaveLength(2);
    const copy = clipsOf(session).find((clip) => clip.id !== 'c1');
    expect(copy!.start).toBeCloseTo(2, 6);
    session.undo();
    expect(clipsOf(session)).toHaveLength(1);
  });
});

describe('integración gesto → undo → redo', () => {
  it('un arrastre (transacción) es un solo paso', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    const before = snap(session.document);
    // Drag gesture: buffered ops until pointerup.
    session.beginGesture('Mover clips');
    session.moveClip('c1', 'T1', 1);
    session.moveClip('c2', 'T1', 3);
    session.commitGesture();
    expect(clipById(session, 'c1').start).toBeCloseTo(1, 6);
    expect(clipById(session, 'c2').start).toBeCloseTo(3, 6);
    // ONE undo takes both back.
    session.undo();
    expect(snap(session.document)).toBe(before);
    session.redo();
    expect(clipById(session, 'c1').start).toBeCloseTo(1, 6);
    expect(clipById(session, 'c2').start).toBeCloseTo(3, 6);
  });

  it('Escape (cancelGesture) descarta el arrastre entero', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = snap(session.document);
    session.beginGesture('Mover');
    session.moveClip('c1', 'T1', 5);
    session.cancelGesture();
    expect(snap(session.document)).toBe(before);
  });

  it('flujo completo: media → split → mover → transición → undo ×3', () => {
    const session = new EditSession();
    session.addMediaItem(makeMedia('m1', 4));
    const clip = session.makeClip('m1', 'T1', 0);
    session.insertClip(clip, 'insert');
    expect(clipsOf(session)).toHaveLength(1);
    const clipId = clipsOf(session)[0]!.id;

    session.splitClip(clipId, 2);
    expect(clipsOf(session)).toHaveLength(2);
    const tail = clipsOf(session).find((item) => item.id !== clipId)!;

    // Move both halves to T2, still adjacent, so the cut can wear a transition.
    session.moveClip(tail.id, 'T2', 2);
    session.moveClip(clipId, 'T2', 0);
    expect(requireClip(session.document, tail.id).trackId).toBe('T2');

    session.setTransition(tail.id, 'wipe-left', 1);
    expect(requireClip(session.document, tail.id).transitionIn?.id).toBe('wipe-left');

    session.undo(); // transition
    expect(requireClip(session.document, tail.id).transitionIn).toBeNull();
    session.undo(); // move head
    session.undo(); // move tail
    expect(requireClip(session.document, tail.id).trackId).toBe('T1');
    session.undo(); // split
    expect(clipsOf(session)).toHaveLength(1);
    session.redo();
    session.redo();
    session.redo();
    session.redo();
    expect(requireClip(session.document, tail.id).transitionIn?.id).toBe('wipe-left');
  });

  it('operación inválida: toast y documento intacto', () => {
    const errors: string[] = [];
    const session = makeSession([{ start: 0, duration: 2 }], {
      onError: (message) => errors.push(message),
    });
    const before = snap(session.document);
    session.moveClip('c1', 'T-NOPE', 3);
    expect(errors.length).toBeGreaterThan(0);
    expect(snap(session.document)).toBe(before);
  });

  it('snap engine integrado: candidatos del documento', () => {
    const session = makeSession([{ start: 1, duration: 2 }]);
    session.addMarker(3, 'marca');
    const candidates = session.snapping.computeCandidates(
      session.document,
      [],
      r(0.5),
      session.markers(),
    );
    expect(candidates.some((entry) => entry.kind === 'marker')).toBe(true);
    expect(candidates.some((entry) => entry.clipId === 'c1')).toBe(true);
    const result = session.snapping.snap(r(1.02), 100, candidates);
    expect(result.snappedTo?.kind).toBe('clip-start');
    void transitionIdOf;
  });
});
