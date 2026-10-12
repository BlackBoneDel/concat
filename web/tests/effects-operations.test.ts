// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 effect-stack operations: add/remove/reorder/param/toggle, exact undo, F4 coexistence. */

import { describe, expect, it } from 'vitest';
import {
  AddAudioEffectOperation,
  AddVideoEffectOperation,
  RemoveVideoEffectOperation,
  ReorderVideoEffectsOperation,
  ToggleEffectOperation,
  UpdateEffectParamOperation,
  clipStackOf,
  locateEffect,
} from '../src/editor/effects-operations.ts';
import { SetClipEffectsOperation, clipEffectsOf } from '../src/editor/effect-operations.ts';
import { EditError } from '../src/editor/operations.ts';
import { parseClipEffects, serializeClipEffects } from '../src/media/clip-effects.ts';
import {
  VIDEO_EFFECT_DEFS,
  clampParam,
  createVideoEffect,
  effectIsNeutral,
  moveItem,
  parseVideoStack,
  stackIsActive,
  stacksOf,
} from '../src/media/effects/effects-stack.ts';
import { clipById, snap } from './f3-helpers.ts';
import { makeF5Session } from './f5-helpers.ts';

describe('effect stack model', () => {
  it('fills defaults, clamps params and drops unknown entries', () => {
    const stack = parseVideoStack([
      { id: 'a', type: 'blur', params: { radius: 999 } },
      { id: 'b', type: 'warp' },
      'junk',
      { id: 'a', type: 'vignette', enabled: false, params: { amount: Number.NaN } },
    ]);
    expect(stack).toHaveLength(2);
    expect(stack[0]).toMatchObject({ id: 'a', type: 'blur', enabled: true, params: { radius: 64 } });
    expect(stack[1]!.id).not.toBe('a'); // duplicate ids are re-minted
    expect(stack[1]).toMatchObject({ type: 'vignette', enabled: false, params: { amount: 0.8, radius: 0.75, softness: 0.45 } });
  });

  it('clamps, detects neutral effects and reorders lists', () => {
    const radius = VIDEO_EFFECT_DEFS.blur.params[0]!;
    expect(clampParam(radius, -5)).toBe(0);
    expect(clampParam(radius, 'x')).toBe(radius.default);
    expect(effectIsNeutral(createVideoEffect('blur', { radius: 0 }))).toBe(true);
    expect(effectIsNeutral(createVideoEffect('pixelate'))).toBe(false);
    expect(stackIsActive([{ ...createVideoEffect('noise'), enabled: false }])).toBe(false);
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -4)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a'], 3, 0)).toEqual(['a']);
    expect(stacksOf(null)).toEqual({ video: [], audio: [] });
  });

  it('Fase 4 effects keep the stacks through parse/serialize', () => {
    const raw = { version: 1, chromaKey: { enabled: true, keyColor: [0, 255, 0], similarity: 0.4, smoothness: 0.08 }, stack: [{ id: 'x', type: 'blur', params: { radius: 3 } }], audioStack: [{ id: 'y', type: 'delay' }] };
    const parsed = parseClipEffects(raw);
    expect(parsed.stack?.[0]?.id).toBe('x');
    expect(parsed.audioStack?.[0]?.type).toBe('delay');
    const json = serializeClipEffects(parsed)!;
    expect(json['stack']).toEqual([{ id: 'x', type: 'blur', enabled: true, params: { radius: 3 } }]);
    expect(Array.isArray(json['audioStack'])).toBe(true);
  });
});

describe('effect operations', () => {
  it('AddVideoEffect appends with defaults + overrides and undoes exactly', () => {
    const session = makeF5Session();
    const before = snap(session.document);
    expect(session.run(new AddVideoEffectOperation('c1', 'blur', { radius: 10 }, { effectId: 'b1' }))).toBe(true);
    expect(session.run(new AddVideoEffectOperation('c1', 'vignette', {}, { effectId: 'v1' }))).toBe(true);
    const stack = clipStackOf(session.document, 'c1', 'video');
    expect(stack.map((fx) => fx.id)).toEqual(['b1', 'v1']);
    expect(stack[0]!.params['radius']).toBe(10);
    expect(clipById(session, 'c1').extra['effects']).toMatchObject({ version: 1 });
    session.undo();
    session.undo();
    expect(snap(session.document)).toBe(before);
    expect(clipById(session, 'c1').extra['effects']).toBeUndefined();
  });

  it('inserts at an index and rejects bad input', () => {
    const session = makeF5Session();
    session.run(new AddVideoEffectOperation('c1', 'blur', {}, { effectId: 'a' }));
    session.run(new AddVideoEffectOperation('c1', 'noise', {}, { effectId: 'b', index: 0 }));
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.id)).toEqual(['b', 'a']);
    const errors: string[] = [];
    session.onError = (message) => errors.push(message);
    expect(session.run(new AddVideoEffectOperation('c1', 'warp'))).toBe(false);
    expect(session.run(new AddVideoEffectOperation('c1', 'blur', {}, { effectId: 'a' }))).toBe(false);
    expect(session.run(new AddVideoEffectOperation('c2', 'blur'))).toBe(false);
    expect(session.run(new AddAudioEffectOperation('c3', 'reverb'))).toBe(false);
    expect(session.run(new AddAudioEffectOperation('c1', 'bogus'))).toBe(false);
    expect(errors).toHaveLength(5);
  });

  it('ReorderVideoEffects changes application order; Remove deletes by id in either stack', () => {
    const session = makeF5Session();
    for (const [id, type] of [['a', 'blur'], ['b', 'vignette'], ['c', 'pixelate']] as const) {
      session.run(new AddVideoEffectOperation('c1', type, {}, { effectId: id }));
    }
    session.run(new AddAudioEffectOperation('c1', 'reverb', {}, { effectId: 'r' }));
    session.run(new ReorderVideoEffectsOperation('c1', 'a', 2));
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.id)).toEqual(['b', 'c', 'a']);
    session.undo();
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.id)).toEqual(['a', 'b', 'c']);
    session.run(new RemoveVideoEffectOperation('c1', 'r'));
    expect(clipStackOf(session.document, 'c1', 'audio')).toEqual([]);
    expect(locateEffect(session.document, 'c1', 'b')).toMatchObject({ kind: 'video', index: 1 });
    expect(() => new RemoveVideoEffectOperation('c1', 'zzz').apply(session.document)).toThrow(EditError);
    expect(() => new ReorderVideoEffectsOperation('c1', 'zzz', 0).apply(session.document)).toThrow(EditError);
  });

  it('UpdateEffectParam clamps, validates names and merges slider bursts', () => {
    const session = makeF5Session();
    session.run(new AddVideoEffectOperation('c1', 'blur', {}, { effectId: 'a' }));
    const depth = session.history.undoStack.length;
    session.run(new UpdateEffectParamOperation('c1', 'a', 'radius', 20));
    session.run(new UpdateEffectParamOperation('c1', 'a', 'radius', 500));
    expect(clipStackOf(session.document, 'c1', 'video')[0]!.params['radius']).toBe(64);
    expect(session.history.undoStack.length).toBe(depth + 1);
    session.undo();
    expect(clipStackOf(session.document, 'c1', 'video')[0]!.params['radius']).toBe(6);
    expect(() => new UpdateEffectParamOperation('c1', 'a', 'nope', 1).apply(session.document)).toThrow(/no tiene el parámetro/);
    expect(() => new UpdateEffectParamOperation('c1', 'a', 'radius', Number.NaN).apply(session.document)).toThrow(EditError);
    expect(() => new UpdateEffectParamOperation('c1', 'x', 'radius', 1).apply(session.document)).toThrow(EditError);
    const first = new UpdateEffectParamOperation('c1', 'a', 'radius', 1);
    expect(first.merge(new UpdateEffectParamOperation('c1', 'a', 'other', 1))).toBeNull();
  });

  it('Toggle bypasses an effect; Fase 4 edits keep the stack', () => {
    const session = makeF5Session();
    session.run(new AddVideoEffectOperation('c1', 'blur', {}, { effectId: 'a' }));
    session.run(new ToggleEffectOperation('c1', 'a', false));
    expect(clipStackOf(session.document, 'c1', 'video')[0]!.enabled).toBe(false);
    const effects = clipEffectsOf(session.document, 'c1');
    effects.colorGrading = null;
    effects.splitView = true;
    session.run(new SetClipEffectsOperation('c1', effects));
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.id)).toEqual(['a']);
    expect(new ToggleEffectOperation('c1', 'a', true).describe()).toContain('Activar');
  });
});
