// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 presets: built-ins, user storage, capture, and ApplyPreset as one undo step. */

import { describe, expect, it } from 'vitest';
import { clipStackOf, AddVideoEffectOperation, AddAudioEffectOperation } from '../src/editor/effects-operations.ts';
import { AddKeyframeOperation, EditError } from '../src/editor/operations.ts';
import { UpdateTextStylesOperation } from '../src/editor/text-operations.ts';
import { ADVANCED_TEXT_KEY, parseAdvancedText } from '../src/render/advanced-text.ts';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import {
  ApplyPresetOperation,
  BUILTIN_PRESETS,
  CINEMATIC_TITLE,
  FADE_IN,
  NEON_GLOW,
  PresetManager,
  SLIDE_LEFT,
  TYPEWRITER,
  USER_PRESETS_STORE,
  ZOOM_IN_BLUR,
  hasContent,
  parsePresetData,
  parseUserPreset,
  presetIncompatibility,
  presetKeyAt,
  presetKeyValue,
} from '../src/presets/index.ts';
import { clipById, r, snap } from './f3-helpers.ts';
import { makeF5Session } from './f5-helpers.ts';

function manager(kv = new MemoryKeyValue()) {
  let id = 0;
  let now = 1000;
  return { kv, presets: new PresetManager(kv, () => (now += 1), () => `p${(id += 1)}`) };
}

describe('preset helpers', () => {
  it('maps seconds (from the start or the end) to clip fractions', () => {
    expect(presetKeyAt({ property: 'opacity', value: 0, ease: [0, 0, 1, 1], seconds: 0.5 }, 2)).toBe(0.25);
    expect(presetKeyAt({ property: 'opacity', value: 0, ease: [0, 0, 1, 1], seconds: 0.5, fromEnd: true }, 2)).toBe(0.75);
    expect(presetKeyAt({ property: 'opacity', value: 0, ease: [0, 0, 1, 1], seconds: 9 }, 2)).toBe(1);
    expect(presetKeyAt({ property: 'opacity', value: 0, ease: [0, 0, 1, 1], at: 1.5 }, 2)).toBe(1);
  });

  it('values are relative to the clip constant', () => {
    expect(presetKeyValue('scale', 2, 1.25)).toBe(2.5);
    expect(presetKeyValue('opacity', 0.5, 1)).toBe(0.5);
    expect(presetKeyValue('offsetX', 0.2, -1)).toBeCloseTo(-0.8);
  });

  it('checks preset type against clip kind', () => {
    const session = makeF5Session();
    const video = clipById(session, 'c1');
    const audio = clipById(session, 'c2');
    const text = clipById(session, 'c3');
    expect(presetIncompatibility('text', video)).toMatch(/texto/);
    expect(presetIncompatibility('text', text)).toBeNull();
    expect(presetIncompatibility('video', audio)).toMatch(/audio/);
    expect(presetIncompatibility('audio', text)).toMatch(/audio/);
    expect(presetIncompatibility('color', text)).toMatch(/color/i);
    expect(presetIncompatibility('video', text)).toBeNull();
  });

  it('parses stored presets defensively', () => {
    expect(parseUserPreset({ id: 'x', name: 'n', type: 'video', data: {}, createdAt: 1 })).toMatchObject({ id: 'x', type: 'video' });
    expect(parseUserPreset({ id: 'x', name: 'n', type: 'warp', data: {} })).toBeNull();
    expect(parseUserPreset(null)).toBeNull();
    const data = parsePresetData({ keys: [{ property: 'blur', value: 1, ease: [0, 0, 1, 1], at: 0 }, { property: 'scale', value: 2, ease: [5, 0, -1, 1], at: 0 }] });
    expect(data.keys).toHaveLength(1);
    expect(data.keys![0]!.ease).toEqual([1, 0, 0, 1]);
    expect(hasContent({})).toBe(false);
    expect(hasContent(FADE_IN.data)).toBe(true);
  });

  it('ships the requested built-ins', () => {
    const names = BUILTIN_PRESETS.map((preset) => preset.name);
    for (const name of ['Fade In', 'Zoom In', 'Slide Left', 'Slide Right', 'Bounce', 'Typewriter', 'Cinematic Title', 'Neon Glow']) expect(names).toContain(name);
    expect(new Set(BUILTIN_PRESETS.map((preset) => preset.id)).size).toBe(BUILTIN_PRESETS.length);
    for (const preset of BUILTIN_PRESETS) {
      // Stored copies never claim to be built-in.
      const { builtin, ...stored } = preset;
      expect(builtin).toBe(true);
      expect(parseUserPreset(preset)).toEqual(stored);
    }
  });
});

describe('PresetManager storage', () => {
  it('lists built-ins first, then user presets in creation order', async () => {
    const { presets } = manager();
    await presets.save('Mío B', 'video', FADE_IN.data);
    await presets.save('  Mío A  ', 'text', TYPEWRITER.data);
    const all = await presets.list();
    expect(all.slice(0, BUILTIN_PRESETS.length)).toEqual([...BUILTIN_PRESETS]);
    expect(all.slice(BUILTIN_PRESETS.length).map((p) => p.name)).toEqual(['Mío B', 'Mío A']);
    expect((await presets.list('text')).map((p) => p.id)).toContain('p2');
    expect((await presets.list('text')).every((p) => p.type === 'text')).toBe(true);
  });

  it('validates names and content, truncates to 64 chars, notifies', async () => {
    const { presets } = manager();
    let changes = 0;
    const off = presets.onChange(() => (changes += 1));
    await expect(presets.save('   ', 'video', FADE_IN.data)).rejects.toThrow(EditError);
    await expect(presets.save('vacío', 'video', {})).rejects.toThrow(/vacío/);
    const saved = await presets.save('x'.repeat(100), 'video', FADE_IN.data);
    expect(saved.name).toHaveLength(64);
    expect(changes).toBe(1);
    off();
    await presets.delete(saved.id);
    expect(changes).toBe(1);
    expect(await presets.get(saved.id)).toBeNull();
  });

  it('built-ins are read-only; get finds both kinds; junk rows are skipped', async () => {
    const { presets, kv } = manager();
    await expect(presets.delete(FADE_IN.id)).rejects.toThrow(/integrados/);
    expect(await presets.get(FADE_IN.id)).toBe(FADE_IN);
    await kv.put(USER_PRESETS_STORE, 'junk', { nope: true });
    expect(await presets.list()).toHaveLength(BUILTIN_PRESETS.length);
  });
});

describe('ApplyPresetOperation', () => {
  it('Zoom In + Blur: keys + effect in ONE undo step', async () => {
    const session = makeF5Session();
    const { presets } = manager();
    const before = snap(session.document);
    const depth = session.history.undoStack.length;
    expect(await presets.apply(session, ZOOM_IN_BLUR.id, 'c1')).toBe(true);
    expect(session.history.undoStack.length).toBe(depth + 1);
    const clip = clipById(session, 'c1');
    const scale = clip.keys.filter((key) => key.property === 'scale');
    expect(scale.map((key) => [key.at, key.value])).toEqual([[0, 1], [1, 1.25]]);
    expect(scale[1]!.ease.points).toEqual([0.42, 0, 0.58, 1]);
    const stack = clipStackOf(session.document, 'c1', 'video');
    expect(stack.map((fx) => [fx.type, fx.params['radius']])).toEqual([['blur', 4]]);
    session.undo();
    expect(snap(session.document)).toBe(before);
    session.redo();
    expect(clipStackOf(session.document, 'c1', 'video')[0]!.id).toBe(stack[0]!.id); // redo keeps ids
  });

  it('replaces keys of the same property, keeps others, appends effects', () => {
    const session = makeF5Session();
    session.run(new AddKeyframeOperation('c1', 'opacity', r(0.5), 0.3));
    session.run(new AddKeyframeOperation('c1', 'rotation', r(0.5), 45));
    session.run(new AddVideoEffectOperation('c1', 'vignette', {}, { effectId: 'v' }));
    session.run(new ApplyPresetOperation('c1', FADE_IN));
    const keys = clipById(session, 'c1').keys;
    expect(keys.filter((k) => k.property === 'opacity').map((k) => [k.at, k.value])).toEqual([[0, 0], [0.25, 1]]);
    expect(keys.filter((k) => k.property === 'rotation')).toHaveLength(1);
    session.run(new ApplyPresetOperation('c1', ZOOM_IN_BLUR));
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.type)).toEqual(['vignette', 'blur']);
  });

  it('scales relative values by the clip constant', () => {
    const session = makeF5Session();
    clipById(session, 'c1').offsetX = 0.2;
    session.history.rebase(session.document);
    session.run(new ApplyPresetOperation('c1', SLIDE_LEFT));
    const keys = clipById(session, 'c1').keys.filter((k) => k.property === 'offsetX');
    expect(keys[0]!.value).toBeCloseTo(1.2);
    expect(keys[1]!.value).toBeCloseTo(0.2);
    expect(keys[1]!.at).toBeCloseTo(0.3);
  });

  it('text presets restyle titles (and only titles)', () => {
    const session = makeF5Session();
    const before = snap(session.document);
    session.run(new ApplyPresetOperation('c3', CINEMATIC_TITLE));
    const clip = clipById(session, 'c3');
    expect(clip.text!.content).toBe('Hola mundo');
    expect(clip.text!.fontFamily).toContain('Georgia');
    const adv = parseAdvancedText(clip.extra[ADVANCED_TEXT_KEY])!;
    expect(adv.fill).toEqual(['#f7e7b4', '#c9a24a', '#8a6a22']);
    expect(adv.shadow.enabled).toBe(true);
    expect(clip.keys.filter((k) => k.property === 'opacity')).toHaveLength(2);
    session.undo();
    expect(snap(session.document)).toBe(before);
    const errors: string[] = [];
    session.onError = (message) => errors.push(message);
    expect(session.run(new ApplyPresetOperation('c1', NEON_GLOW))).toBe(false);
    expect(errors[0]).toMatch(/texto/);
  });

  it('typewriter preset reveals over 2 s', () => {
    const session = makeF5Session();
    session.run(new ApplyPresetOperation('c3', TYPEWRITER));
    const adv = parseAdvancedText(clipById(session, 'c3').extra[ADVANCED_TEXT_KEY])!;
    expect(adv.typewriter).toEqual({ enabled: true, duration: 2, cursor: true });
  });

  it('colour presets set the Fase 4 grade, keeping the stack', async () => {
    const session = makeF5Session();
    session.run(new AddVideoEffectOperation('c1', 'noise', {}, { effectId: 'n' }));
    const { presets } = manager();
    const saved = await presets.save('Cálido', 'color', { color: { colorGrading: { temperature: 5200, saturation: 1.2 } } });
    await presets.apply(session, saved.id, 'c1');
    const effects = clipById(session, 'c1').extra['effects'];
    expect(effects).toMatchObject({ colorGrading: { temperature: 5200, saturation: 1.2, exposure: 0 } });
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.id)).toEqual(['n']);
    await expect(presets.apply(session, 'nope', 'c1')).rejects.toThrow(/No existe/);
  });

  it('capture → save → apply round-trips a look onto another clip', async () => {
    const session = makeF5Session();
    session.run(new AddKeyframeOperation('c1', 'scale', r(0), 1));
    session.run(new AddKeyframeOperation('c1', 'scale', r(2), 1.5));
    session.run(new AddVideoEffectOperation('c1', 'pixelate', { blocks: 20 }));
    session.run(new AddAudioEffectOperation('c2', 'delay', { time: 500 }));
    session.run(new UpdateTextStylesOperation('c3', { advanced: { glow: { enabled: true } } }));
    const { presets } = manager();
    const video = presets.capture(session.document, 'c1', 'video');
    expect(video.keys?.map((k) => [k.at, k.value])).toEqual([[0, 1], [1, 1.5]]);
    expect(video.videoEffects).toEqual([{ type: 'pixelate', params: { blocks: 20 } }]);
    expect(presets.capture(session.document, 'c2', 'audio').audioEffects?.[0]?.params['time']).toBe(500);
    const text = presets.capture(session.document, 'c3', 'text');
    expect(text.text?.advanced?.glow?.enabled).toBe(true);
    expect(text.text?.base).not.toHaveProperty('content');
    const saved = await presets.save('Mi look', 'video', video);
    const copy = makeF5Session();
    await presets.apply(copy, saved.id, 'c1');
    expect(clipById(copy, 'c1').keys.map((k) => k.value)).toEqual([1, 1.5]);
    expect(clipStackOf(copy.document, 'c1', 'video')[0]!.type).toBe('pixelate');
  });
});
