// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Every edit operation: `apply` works, `inverse(apply(doc))` restores the
 * document exactly, and invalid inputs throw `EditError` without touching
 * anything.
 */

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { Transform } from '../src/core/timeline.ts';
import {
  AddKeyframeOperation,
  AddMarkerOperation,
  AddTrackOperation,
  AddTransitionOperation,
  CompoundOperation,
  DeleteClipOperation,
  DeleteClipsOperation,
  DeleteTrackOperation,
  DuplicateClipOperation,
  EditError,
  GroupClipsOperation,
  InsertClipOperation,
  LinkClipsOperation,
  MergeClipsOperation,
  MoveClipOperation,
  MoveKeyframeOperation,
  RemoveKeyframeOperation,
  RemoveMarkerOperation,
  RemoveTransitionOperation,
  RenameTrackOperation,
  ReorderTracksOperation,
  RippleEditOperation,
  RollEditOperation,
  SetClipPropertyOperation,
  SetCropOperation,
  SetSpeedOperation,
  SetTrackPropertyOperation,
  SetTransformOperation,
  SetTransitionPropertyOperation,
  SlideClipOperation,
  SlipClipOperation,
  SplitClipOperation,
  ToggleClipEnabledOperation,
  TrimClipOperation,
  UngroupClipsOperation,
  UnlinkClipsOperation,
  UpdateMarkerOperation,
  clipEnabled,
  currentTimeline,
  keyframeId,
  readMarkers,
  requireClip,
} from '../src/editor/operations.ts';
import { blankClip } from '../src/model/document.ts';
import { KeyEase } from '../src/model/wire.ts';
import { clipById, makeSession, r, snap } from './f3-helpers.ts';

interface OpLike {
  apply(doc: Parameters<typeof snap>[0]): Parameters<typeof snap>[0];
  inverse(before: Parameters<typeof snap>[0]): OpLike;
}

/** apply + inverse must restore exactly. */
function expectRoundTrip(before: Parameters<typeof snap>[0], op: OpLike): void {
  const after = op.apply(before);
  const restored = op.inverse(before).apply(after);
  expect(snap(restored)).toBe(snap(before));
}

describe('operations: move / trim / split / merge', () => {
  it('MoveClipOperation aplica y revierte', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = session.document;
    const op = new MoveClipOperation('c1', 'T1', 'T2', r(0), r(3));
    expectRoundTrip(before, op);
    const after = op.apply(before);
    expect(requireClip(after, 'c1').trackId).toBe('T2');
    expect(requireClip(after, 'c1').start).toBeCloseTo(3, 6);
  });

  it('MoveClipOperation rechaza pistas inexistentes', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const op = new MoveClipOperation('c1', 'T1', 'T99', r(0), r(1));
    expect(() => op.apply(session.document)).toThrow(EditError);
  });

  it('TrimClipOperation recorta el borde y revierte', () => {
    const session = makeSession([{ start: 1, duration: 3 }]);
    const before = session.document;
    const op = new TrimClipOperation('c1', 'in', r(1), r(2));
    expectRoundTrip(before, op);
    expect(requireClip(op.apply(before), 'c1').start).toBeCloseTo(2, 6);
  });

  it('TrimClipOperation rechaza duraciones imposibles', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const op = new TrimClipOperation('c1', 'in', r(0), r(5));
    expect(() => op.apply(session.document)).toThrow(EditError);
  });

  it('SplitClipOperation parte y MergeClipsOperation junta', () => {
    const session = makeSession([{ start: 0, duration: 4 }]);
    const before = session.document;
    const op = new SplitClipOperation('c1', r(1.5), 'c-tail');
    const after = op.apply(before);
    expect(currentTimeline(after).clips).toHaveLength(2);
    expectRoundTrip(before, op);
    const merge = new MergeClipsOperation('c1', 'c-tail');
    const merged = merge.apply(after);
    expect(currentTimeline(merged).clips).toHaveLength(1);
  });

  it('SplitClipOperation reparte el origen con la velocidad', () => {
    const session = makeSession([{ start: 0, duration: 4 }]);
    const clip = clipById(session, 'c1');
    clip.speed = 2;
    clip.sourceStart = 1;
    const after = new SplitClipOperation('c1', r(1), 'c-tail').apply(session.document);
    const tail = requireClip(after, 'c-tail');
    expect(tail.sourceStart).toBeCloseTo(1 + 1 * 2, 6);
    expect(tail.duration).toBeCloseTo(3, 6);
  });
});

describe('operations: insert / delete / duplicate', () => {
  it('InsertClipOperation inserta y revierte', () => {
    const session = makeSession([{ start: 2, duration: 1 }]);
    const before = session.document;
    const clip = blankClip('cNew', 'T1', 'video', 'nuevo', 0, 1.5);
    clip.mediaId = 'm1';
    const op = new InsertClipOperation(clip, 'T1', r(0), 'insert');
    const after = op.apply(before);
    expect(currentTimeline(after).clips).toHaveLength(2);
    expect(requireClip(after, 'c1').start).toBeCloseTo(3.5, 6); // pushed
    expectRoundTrip(before, op);
  });

  it('InsertClipOperation overwrite recorta lo que pisa', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const clip = blankClip('cNew', 'T1', 'video', 'nuevo', 0, 1);
    clip.mediaId = 'm1';
    const after = new InsertClipOperation(clip, 'T1', r(0.5), 'overwrite').apply(session.document);
    const victim = requireClip(after, 'c1');
    expect(victim.start).toBeCloseTo(0, 6);
    expect(victim.duration).toBeCloseTo(0.5, 6);
  });

  it('InsertClipOperation rechaza un clip de audio en pista de video', () => {
    const session = makeSession([]);
    const clip = blankClip('cA', 'T1', 'audio', 'a', 0, 1);
    clip.mediaId = 'mA';
    const op = new InsertClipOperation(clip, 'T1', r(0), 'overwrite');
    expect(() => op.apply(session.document)).toThrow(EditError);
  });

  it('DeleteClipOperation levanta y revierte', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 2, duration: 1 }]);
    const before = session.document;
    const op = new DeleteClipOperation('c1', 'lift');
    const after = op.apply(before);
    expect(currentTimeline(after).clips).toHaveLength(1);
    expectRoundTrip(before, op);
  });

  it('DeleteClipOperation ripple cierra el hueco', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 1, duration: 1 }]);
    const after = new DeleteClipOperation('c1', 'ripple').apply(session.document);
    expect(requireClip(after, 'c2').start).toBeCloseTo(0, 6);
  });

  it('DeleteClipsOperation borra varios de golpe y revierte', () => {
    const session = makeSession([
      { start: 0, duration: 1 },
      { start: 1, duration: 1 },
      { start: 2, duration: 1 },
    ]);
    const before = session.document;
    const op = new DeleteClipsOperation(['c1', 'c3'], 'lift');
    expectRoundTrip(before, op);
    expect(currentTimeline(op.apply(before)).clips).toHaveLength(1);
  });

  it('DuplicateClipOperation copia tras el original y revierte', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = session.document;
    const op = new DuplicateClipOperation('c1', 'T1', r(2), 'c-dup');
    const after = op.apply(before);
    expect(currentTimeline(after).clips).toHaveLength(2);
    expect(requireClip(after, 'c-dup').start).toBeCloseTo(2, 6);
    expectRoundTrip(before, op);
  });
});

describe('operations: ripple / roll / slip / slide', () => {
  it('RippleEditOperation mueve el borde y la cola', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 1, duration: 1 }]);
    const before = session.document;
    const op = new RippleEditOperation('c1', 'out', r(0.5));
    const after = op.apply(before);
    expect(requireClip(after, 'c1').duration).toBeCloseTo(1.5, 6);
    expect(requireClip(after, 'c2').start).toBeCloseTo(1.5, 6);
    expectRoundTrip(before, op);
  });

  it('RollEditOperation mueve el corte entre dos clips', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    const before = session.document;
    const op = new RollEditOperation('c1', 'c2', r(0.25));
    const after = op.apply(before);
    expect(requireClip(after, 'c1').duration).toBeCloseTo(2.25, 6);
    expect(requireClip(after, 'c2').start).toBeCloseTo(2.25, 6);
    expectRoundTrip(before, op);
  });

  it('SlipClipOperation desplaza el origen sin mover el clip', () => {
    const session = makeSession([{ start: 1, duration: 2 }]);
    const before = session.document;
    const op = new SlipClipOperation('c1', r(0.5));
    const after = op.apply(before);
    expect(requireClip(after, 'c1').start).toBeCloseTo(1, 6);
    expect(requireClip(after, 'c1').sourceStart).toBeCloseTo(0.5, 6);
    expectRoundTrip(before, op);
  });

  it('SlideClipOperation mueve el clip sobre los vecinos', () => {
    const session = makeSession([
      { start: 0, duration: 2 },
      { start: 2, duration: 2 },
      { start: 4, duration: 2 },
    ]);
    const before = session.document;
    const op = new SlideClipOperation('c2', r(0.5));
    const after = op.apply(before);
    expect(requireClip(after, 'c2').start).toBeCloseTo(2.5, 6);
    expect(requireClip(after, 'c1').duration).toBeCloseTo(2.5, 6);
    expect(requireClip(after, 'c3').start).toBeCloseTo(4.5, 6);
    expectRoundTrip(before, op);
  });
});

describe('operations: tracks', () => {
  it('AddTrackOperation crea y revierte', () => {
    const session = makeSession([]);
    const before = session.document;
    const op = new AddTrackOperation('audio', 0, 'Música', 'T-NEW');
    const after = op.apply(before);
    expect(currentTimeline(after).tracks).toHaveLength(5);
    expect(currentTimeline(after).tracks[0]!.id).toBe('T-NEW');
    expectRoundTrip(before, op);
  });

  it('DeleteTrackOperation borra la pista y sus clips', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { trackId: 'T2', start: 0, duration: 1 }]);
    const before = session.document;
    const op = new DeleteTrackOperation('T1');
    const after = op.apply(before);
    expect(currentTimeline(after).clips).toHaveLength(1);
    expectRoundTrip(before, op);
  });

  it('RenameTrackOperation renombra y revierte', () => {
    const session = makeSession([]);
    const before = session.document;
    const op = new RenameTrackOperation('T1', 'T1', 'Video principal');
    const after = op.apply(before);
    expect(currentTimeline(after).tracks[0]!.extra['name']).toBe('Video principal');
    expectRoundTrip(before, op);
  });

  it('ReorderTracksOperation reordena y revierte', () => {
    const session = makeSession([]);
    const before = session.document;
    const op = new ReorderTracksOperation('T4', 3, 0);
    const after = op.apply(before);
    expect(currentTimeline(after).tracks[0]!.id).toBe('T4');
    expectRoundTrip(before, op);
  });

  it('SetTrackPropertyOperation mutea y revierte', () => {
    const session = makeSession([]);
    const before = session.document;
    const op = new SetTrackPropertyOperation('T1', 'muted', false, true);
    const after = op.apply(before);
    expect(currentTimeline(after).tracks[0]!.muted).toBe(true);
    expectRoundTrip(before, op);
  });

  it('SetTrackPropertyOperation hidden oculta el video', () => {
    const session = makeSession([]);
    const after = new SetTrackPropertyOperation('T1', 'hidden', false, true).apply(session.document);
    expect(currentTimeline(after).tracks[0]!.visible).toBe(false);
  });
});

describe('operations: groups / links', () => {
  it('GroupClipsOperation agrupa y revierte', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 2, duration: 1 }]);
    const before = session.document;
    const op = new GroupClipsOperation(['c1', 'c2'], 'g-1');
    const after = op.apply(before);
    expect(requireClip(after, 'c1').extra['groupId']).toBe('g-1');
    expectRoundTrip(before, op);
  });

  it('UngroupClipsOperation deshace el grupo', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 2, duration: 1 }]);
    const grouped = new GroupClipsOperation(['c1', 'c2'], 'g-1').apply(session.document);
    const op = new UngroupClipsOperation('g-1');
    const after = op.apply(grouped);
    expect(requireClip(after, 'c1').extra['groupId']).toBeUndefined();
    expectRoundTrip(grouped, op);
  });

  it('LinkClipsOperation vincula y UnlinkClipsOperation suelta', () => {
    const session = makeSession([
      { start: 0, duration: 2 },
      { kind: 'audio', trackId: 'T3', start: 0, duration: 2 },
    ]);
    const before = session.document;
    const link = new LinkClipsOperation(['c1', 'c2'], 'l-1');
    const linked = link.apply(before);
    expect(requireClip(linked, 'c1').extra['linkId']).toBe('l-1');
    expectRoundTrip(before, link);
    const unlink = new UnlinkClipsOperation('l-1');
    expectRoundTrip(linked, unlink);
  });
});

describe('operations: transitions', () => {
  it('AddTransitionOperation cuelga la transición en el clip B y revierte', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    const before = session.document;
    const op = new AddTransitionOperation('c1', 'c2', 'crossfade', r(1));
    const after = op.apply(before);
    expect(requireClip(after, 'c2').transitionIn?.id).toBe('crossfade');
    expectRoundTrip(before, op);
  });

  it('RemoveTransitionOperation la quita y revierte', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    const added = new AddTransitionOperation('c1', 'c2', 'dissolve', r(1)).apply(session.document);
    const op = new RemoveTransitionOperation('tr:c2:in');
    expectRoundTrip(added, op);
  });

  it('SetTransitionPropertyOperation cambia duración y tipo', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    const added = new AddTransitionOperation('c1', 'c2', 'crossfade', r(1)).apply(session.document);
    const op = new SetTransitionPropertyOperation('tr:c2:in', 'duration', 1, 2);
    const after = op.apply(added);
    expect(requireClip(after, 'c2').transitionIn?.duration).toBe(2);
    expectRoundTrip(added, op);
    const kindOp = new SetTransitionPropertyOperation('tr:c2:in', 'kind', 'crossfade', 'wipe-left');
    expect(requireClip(kindOp.apply(added), 'c2').transitionIn?.id).toBe('wipe-left');
    expectRoundTrip(added, kindOp);
  });
});

describe('operations: markers', () => {
  it('Add / Update / Remove marker con round-trip', () => {
    const session = makeSession([]);
    const before = session.document;
    const add = new AddMarkerOperation(r(5), 'Marca', '#ff0000', 'm-1');
    const withMarker = add.apply(before);
    expect(readMarkers(withMarker)).toHaveLength(1);
    expectRoundTrip(before, add);
    const update = new UpdateMarkerOperation('m-1', { label: 'Marca' }, { label: 'Nueva' });
    const updated = update.apply(withMarker);
    expect(readMarkers(updated)[0]!.label).toBe('Nueva');
    expectRoundTrip(withMarker, update);
    const remove = new RemoveMarkerOperation('m-1');
    expectRoundTrip(withMarker, remove);
  });
});

describe('operations: clip properties / transform / speed / crop', () => {
  it('SetClipPropertyOperation cambia nombre, volumen, fundidos, opacidad', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = session.document;
    for (const [property, oldValue, value] of [
      ['name', 'clip1', 'Otro'],
      ['volume', 1, 0.5],
      ['fade_in', 0, 0.3],
      ['fade_out', 0, 0.4],
      ['opacity', 1, 0.8],
      ['blend', '', 'screen'],
    ] as const) {
      const op = new SetClipPropertyOperation('c1', property, oldValue, value);
      expectRoundTrip(before, op);
    }
    const op = new SetClipPropertyOperation('c1', 'volume', 1, 0.5);
    expect(requireClip(op.apply(before), 'c1').volume).toBe(0.5);
  });

  it('SetClipPropertyOperation enabled vive en extra y Toggle lo invierte', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = session.document;
    const op = new SetClipPropertyOperation('c1', 'enabled', true, false);
    const off = op.apply(before);
    expect(clipEnabled(requireClip(off, 'c1'))).toBe(false);
    expectRoundTrip(before, op);
    const toggle = new ToggleClipEnabledOperation('c1');
    const on = toggle.apply(off);
    expect(clipEnabled(requireClip(on, 'c1'))).toBe(true);
    expectRoundTrip(off, toggle);
  });

  it('SetTransformOperation reemplaza la transformación y revierte', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = session.document;
    const op = new SetTransformOperation('c1', Transform.IDENTITY, new Transform(2, 0.1, -0.2, 15, 1, 1));
    const after = op.apply(before);
    expect(requireClip(after, 'c1').scale).toBe(2);
    expect(requireClip(after, 'c1').rotation).toBe(15);
    expectRoundTrip(before, op);
  });

  it('SetSpeedOperation cambia la velocidad y revierte', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = session.document;
    const op = new SetSpeedOperation('c1', 1, 2, true);
    expect(requireClip(op.apply(before), 'c1').speed).toBe(2);
    expectRoundTrip(before, op);
  });

  it('SetCropOperation recorta y revierte', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = session.document;
    const op = new SetCropOperation('c1', null, { left: 0.1, top: 0, right: 0, bottom: 0.2 });
    const after = op.apply(before);
    expect(requireClip(after, 'c1').crop?.left).toBeCloseTo(0.1, 6);
    expectRoundTrip(before, op);
  });
});

describe('operations: keyframes', () => {
  it('Add / Move / Remove keyframe con round-trip', () => {
    const session = makeSession([{ start: 0, duration: 4 }]);
    const before = session.document;
    const id = keyframeId('opacity', 0.25);
    const add = new AddKeyframeOperation('c1', 'opacity', Rational.approximate(1) ?? Rational.ZERO, 0.5, KeyEase.LINEAR);
    const keyed = add.apply(before);
    expect(requireClip(keyed, 'c1').keys).toHaveLength(1);
    expectRoundTrip(before, add);
    const move = new MoveKeyframeOperation('c1', 'opacity', id, Rational.approximate(1) ?? Rational.ZERO, Rational.approximate(2) ?? Rational.ZERO);
    const moved = move.apply(keyed);
    expect(requireClip(moved, 'c1').keys[0]!.at).toBeCloseTo(0.5, 6);
    expectRoundTrip(keyed, move);
    const remove = new RemoveKeyframeOperation('c1', 'opacity', keyframeId('opacity', 0.5));
    expectRoundTrip(moved, remove);
  });
});

describe('operations: compound', () => {
  it('CompoundOperation aplica y deshace como una unidad', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    const before = session.document;
    const op = new CompoundOperation('combo', [
      new MoveClipOperation('c1', 'T1', 'T1', r(0), r(1)),
      new MoveClipOperation('c2', 'T1', 'T1', r(2), r(3)),
    ]);
    const after = op.apply(before);
    expect(requireClip(after, 'c1').start).toBeCloseTo(1, 6);
    expectRoundTrip(before, op);
    expect(op.describe()).toContain('combo');
  });
});
