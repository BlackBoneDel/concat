// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 titling: background plate, shadow/stroke/glow, gradient fill, typewriter, text ops, fonts. */

import { describe, expect, it, vi } from 'vitest';
import { AddCustomFontOperation, RemoveCustomFontOperation, UpdateTextStylesOperation, projectFonts } from '../src/editor/text-operations.ts';
import { defaultTextStyle, type TextStyle } from '../src/model/document.ts';
import {
  ADVANCED_TEXT_KEY,
  defaultAdvancedText,
  detectFontFormat,
  familyFromFileName,
  mergeAdvancedText,
  parseAdvancedText,
  parseFonts,
  sanitizeColor,
  sanitizeFill,
  serializeAdvancedText,
  type AdvancedTextStyle,
  type CustomFont,
} from '../src/render/advanced-text.ts';
import { FontLoader, type FontFaceLike } from '../src/render/font-loader.ts';
import {
  backgroundBox,
  gradientEndpoints,
  renderAdvancedText,
  revealLines,
  typewriterProgress,
  typewriterText,
  wrapText,
} from '../src/render/text-engine.ts';
import { FontFileError, FontStore, MAX_FONT_BYTES, MemoryFontFiles, fontFileName } from '../src/storage/font-store.ts';
import { clipById, snap } from './f3-helpers.ts';
import { RecordingContext, makeF5Session } from './f5-helpers.ts';

const W = 1000;
const H = 500;

function style(content = 'Hola', patch: Partial<TextStyle> = {}): TextStyle {
  return { ...defaultTextStyle(), content, fontSize: 0.1, maxWidth: 0, shadow: false, ...patch };
}

function advanced(patch: Parameters<typeof mergeAdvancedText>[1] = {}): AdvancedTextStyle {
  return mergeAdvancedText(defaultAdvancedText(), patch);
}

describe('typewriter', () => {
  it('progress = (time − start) / duration, clamped', () => {
    expect(typewriterProgress(-1, 2)).toBe(0);
    expect(typewriterProgress(1, 2)).toBe(0.5);
    expect(typewriterProgress(5, 2)).toBe(1);
    expect(typewriterProgress(0, 0)).toBe(1);
  });

  it('reveals a substring over code points (2 s for the whole text)', () => {
    expect(typewriterText('abcd', 0, 2)).toBe('');
    expect(typewriterText('abcd', 1, 2)).toBe('ab');
    expect(typewriterText('abcd', 1.99, 2)).toBe('abc');
    expect(typewriterText('abcd', 2, 2)).toBe('abcd');
    expect(typewriterText('🎬ñé', 1, 3)).toBe('🎬');
  });

  it('reveals wrapped lines in order', () => {
    expect(revealLines(['ab', 'cd'], 3)).toEqual(['ab', '']);
    expect(revealLines(['ab', 'cd'], 4)).toEqual(['ab', 'c']);
    expect(revealLines(['ab', 'cd'], 99)).toEqual(['ab', 'cd']);
  });

  it('draws only the visible prefix at a local time', () => {
    const ctx = new RecordingContext();
    const result = renderAdvancedText(ctx, style('abcdef'), advanced({ typewriter: { enabled: true, duration: 2 } }), W, H, { localTime: 1 });
    expect(result.visible).toBe('abc');
    expect(ctx.named('fillText').map((c) => c.args[0])).toEqual(['abc']);
    // The partial line starts where the full line would (no re-centring).
    expect(ctx.named('fillText')[0]!.args[1]).toBe(-30);
  });

  it('blinks a caret while typing only', () => {
    const typing = new RecordingContext();
    renderAdvancedText(typing, style('abcd'), advanced({ typewriter: { enabled: true, duration: 2, cursor: true } }), W, H, { localTime: 0.1 });
    expect(typing.named('fillRect')).toHaveLength(1);
    const done = new RecordingContext();
    renderAdvancedText(done, style('abcd'), advanced({ typewriter: { enabled: true, duration: 2, cursor: true } }), W, H, { localTime: 3 });
    expect(done.named('fillRect')).toHaveLength(0);
  });
});

describe('background plate', () => {
  it('is measureText width + padding, drawn with roundRect', () => {
    expect(backgroundBox(100, 40, 10, 5)).toEqual({ x: -60, y: -25, w: 120, h: 50 });
    const ctx = new RecordingContext();
    const result = renderAdvancedText(
      ctx,
      style('Hola mundo'),
      advanced({ background: { enabled: true, color: '#112233', paddingX: 0.02, paddingY: 0.01, radius: 0.01, opacity: 0.5 } }),
      W,
      H,
      { localTime: 0 },
    );
    // 10 code points × 10 px, padding 10/5 px, one line of 1.2 × 50 px.
    const lineHeight = defaultTextStyle().lineHeight * 50;
    expect(result.box).toEqual({ x: -60, y: -lineHeight / 2 - 5, w: 120, h: lineHeight + 10 });
    const round = ctx.named('roundRect');
    expect(round).toHaveLength(1);
    expect(round[0]!.args).toEqual([-60, -lineHeight / 2 - 5, 120, lineHeight + 10, 5]);
    const fill = ctx.named('fill')[0]!;
    expect(fill.state.fillStyle).toBe('#112233');
    expect(fill.state.globalAlpha).toBeCloseTo(0.5);
    // The plate is painted before any glyph.
    expect(ctx.calls.indexOf(fill)).toBeLessThan(ctx.calls.indexOf(ctx.named('fillText')[0]!));
  });

  it('falls back to arcs without roundRect', () => {
    const ctx = new RecordingContext({ roundRect: false });
    renderAdvancedText(ctx, style('x'), advanced({ background: { enabled: true } }), W, H, { localTime: 0 });
    expect(ctx.named('arc')).toHaveLength(4);
    expect(ctx.named('closePath')).toHaveLength(1);
  });
});

describe('shadow, stroke, glow and fill', () => {
  it('casts the drop shadow from the fill when there is no stroke', () => {
    const ctx = new RecordingContext();
    renderAdvancedText(ctx, style(), advanced({ shadow: { enabled: true, color: '#ff0000', blur: 0.02, offsetX: 0.01, offsetY: 0.01 } }), W, H, { localTime: 0 });
    const text = ctx.named('fillText')[0]!;
    expect(text.state.shadowColor).toBe('#ff0000');
    expect(text.state.shadowBlur).toBe(10);
  });

  it('strokes under the fill at twice the width and moves the shadow to the stroke', () => {
    const ctx = new RecordingContext();
    renderAdvancedText(
      ctx,
      style(),
      advanced({ stroke: { enabled: true, color: '#000000', width: 0.004 }, shadow: { enabled: true, color: '#00ff00' } }),
      W,
      H,
      { localTime: 0 },
    );
    const stroke = ctx.named('strokeText')[0]!;
    const fill = ctx.named('fillText')[0]!;
    expect(stroke.state.lineWidth).toBe(4);
    expect(stroke.state.shadowColor).toBe('#00ff00');
    expect(fill.state.shadowColor).toBe('rgba(0,0,0,0)');
    expect(ctx.calls.indexOf(stroke)).toBeLessThan(ctx.calls.indexOf(fill));
  });

  it('glow paints twice with a zero-offset coloured shadow', () => {
    const ctx = new RecordingContext();
    renderAdvancedText(ctx, style(), advanced({ glow: { enabled: true, color: '#00e5ff', blur: 0.04 } }), W, H, { localTime: 0 });
    const glows = ctx.named('fillText').filter((c) => c.state.shadowColor === '#00e5ff');
    expect(glows).toHaveLength(2);
    expect(glows[0]!.state.shadowBlur).toBe(20);
  });

  it('uses a linear gradient when fill is an array', () => {
    const ctx = new RecordingContext();
    renderAdvancedText(ctx, style('abcd'), advanced({ fill: ['#ff0000', '#00ff00', '#0000ff'], gradientAngle: 0 }), W, H, { localTime: 0 });
    expect(ctx.gradients).toHaveLength(1);
    expect(ctx.gradients[0]!.stops).toEqual([[0, '#ff0000'], [0.5, '#00ff00'], [1, '#0000ff']]);
    expect(ctx.gradients[0]!.args).toEqual([-20, 0, 20, 0]);
    expect(typeof ctx.named('fillText')[0]!.state.fillStyle).toBe('object');
  });

  it('falls back to the first stop without gradients', () => {
    const ctx = new RecordingContext({ gradient: false });
    renderAdvancedText(ctx, style(), advanced({ fill: ['#abcdef', '#000000'] }), W, H, { localTime: 0 });
    expect(ctx.named('fillText')[0]!.state.fillStyle).toBe('#abcdef');
  });

  it('gradient endpoints span the box at any angle', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(gradientEndpoints(box, 90).map((v) => Math.round(v) + 0)).toEqual([50, 0, 50, 50]);
  });

  it('prefers a custom family and honours alignment and wrapping', () => {
    const ctx = new RecordingContext();
    renderAdvancedText(ctx, style('aa bb', { align: 'left', maxWidth: 0.003 }), advanced(), W, H, { localTime: 0, fontFamily: 'Mi"Fuente' });
    expect(ctx.font).toContain('"MiFuente"');
    const xs = ctx.named('fillText').map((c) => c.args[1]);
    expect(xs).toEqual([-10, -10]);
    expect(wrapText(ctx, 'uno dos tres', 70)).toEqual(['uno dos', 'tres']);
    expect(wrapText(ctx, '', 10)).toEqual(['']);
  });
});

describe('advanced text model', () => {
  it('sanitises colours and fills', () => {
    expect(sanitizeColor('#fff', 'x')).toBe('#fff');
    expect(sanitizeColor('url(javascript:1)', '#000')).toBe('#000');
    expect(sanitizeFill(['#f00'], '#fff')).toBe('#f00');
    expect(sanitizeFill(['#f00', 'url(x)', '#00f'], '#fff')).toEqual(['#f00', '#00f']);
  });

  it('round-trips through JSON and ignores garbage', () => {
    const style_ = advanced({ fill: ['#111111', '#222222'], typewriter: { enabled: true, duration: 3 } });
    expect(parseAdvancedText(JSON.parse(JSON.stringify(serializeAdvancedText(style_))))).toEqual(style_);
    expect(parseAdvancedText('nope')).toBeNull();
    expect(parseAdvancedText({ stroke: { width: -4 } })!.stroke.width).toBeGreaterThanOrEqual(0);
  });
});

describe('text operations', () => {
  it('UpdateTextStyles patches base + advanced and undoes exactly', () => {
    const session = makeF5Session();
    const before = snap(session.document);
    session.run(new UpdateTextStylesOperation('c3', { base: { fontSize: 5, align: 'left' }, advanced: { shadow: { enabled: true } } }));
    const clip = clipById(session, 'c3');
    expect(clip.text!.fontSize).toBe(1);
    expect(clip.text!.align).toBe('left');
    expect(parseAdvancedText(clip.extra[ADVANCED_TEXT_KEY])!.shadow.enabled).toBe(true);
    session.undo();
    expect(snap(session.document)).toBe(before);
  });

  it('removes the advanced style with null and rejects non-text clips', () => {
    const session = makeF5Session();
    session.run(new UpdateTextStylesOperation('c3', { advanced: { background: { enabled: true } } }));
    session.run(new UpdateTextStylesOperation('c3', { advanced: null }));
    expect(clipById(session, 'c3').extra[ADVANCED_TEXT_KEY]).toBeUndefined();
    expect(() => new UpdateTextStylesOperation('c1', { base: { fontSize: 0.1 } }).apply(session.document)).toThrow(/texto/);
  });

  it('merges typing bursts, deep-merging advanced groups', () => {
    const a = new UpdateTextStylesOperation('c3', { advanced: { stroke: { enabled: true } } });
    const b = new UpdateTextStylesOperation('c3', { advanced: { stroke: { width: 0.01 } }, base: { color: '#fff' } });
    const merged = a.merge(b);
    expect(merged).toBeInstanceOf(UpdateTextStylesOperation);
    expect((merged as UpdateTextStylesOperation).change).toEqual({ base: { color: '#fff' }, advanced: { stroke: { enabled: true, width: 0.01 } } });
    expect(a.merge(new UpdateTextStylesOperation('c9', {}))).toBeNull();
  });

  it('Add/RemoveCustomFont keep the project font list', () => {
    const session = makeF5Session();
    const font: CustomFont = { id: 'f1', family: 'Mi Fuente f1', fileName: 'mi.ttf', path: '/fonts/f1.ttf', format: 'truetype' };
    session.run(new AddCustomFontOperation(font));
    expect(projectFonts(session.document)).toEqual([font]);
    expect(session.run(new AddCustomFontOperation(font))).toBe(false);
    session.run(new RemoveCustomFontOperation('f1'));
    expect(projectFonts(session.document)).toEqual([]);
    session.undo();
    expect(projectFonts(session.document)).toEqual([font]);
    expect(parseFonts([{ id: 'x', family: 'y', path: 'z', format: 'svg' }])).toEqual([]);
  });
});

describe('fonts', () => {
  const ttf = (name = 'Mi Fuente.ttf') => new File([new Uint8Array([0, 1, 0, 0, 9, 9])], name);

  it('detects containers by magic bytes only', () => {
    expect(detectFontFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), 'a')).toBe('woff2');
    expect(detectFontFormat(new Uint8Array([0x4f, 0x54, 0x54, 0x4f]), 'a')).toBe('opentype');
    expect(detectFontFormat(new Uint8Array([0, 1, 0, 0]), 'a')).toBe('truetype');
    expect(detectFontFormat(new Uint8Array([1, 2, 3, 4]), 'x.ttf')).toBeNull();
    expect(familyFromFileName('Mi<b>Fuente.ttf', 'abcd1234')).toBe('Mi b Fuente abcd');
  });

  it('FontStore stores /fonts/<uuid>.ttf and validates', async () => {
    const files = new MemoryFontFiles();
    const store = new FontStore(files, () => 'uuid-1');
    const font = await store.add(ttf());
    expect(font).toMatchObject({ id: 'uuid-1', path: '/fonts/uuid-1.ttf', format: 'truetype', fileName: 'Mi Fuente.ttf' });
    expect(fontFileName(font.path)).toBe('uuid-1.ttf');
    expect(new Uint8Array((await store.read(font))!)).toEqual(new Uint8Array([0, 1, 0, 0, 9, 9]));
    await store.delete(font);
    expect(await store.read(font)).toBeNull();
    await expect(store.add(new File([], 'vacia.ttf'))).rejects.toThrow(FontFileError);
    await expect(store.add(new File([new Uint8Array([1, 2, 3, 4])], 'falsa.ttf'))).rejects.toThrow(/no es una fuente/);
    await expect(store.add(new File([new Uint8Array(MAX_FONT_BYTES + 1)], 'enorme.ttf'))).rejects.toThrow(/supera/);
  });

  it('FontLoader registers FontFaces once and notifies', async () => {
    const files = new MemoryFontFiles();
    const store = new FontStore(files, () => 'f1');
    const font = await store.add(ttf());
    const added: FontFaceLike[] = [];
    const deleted: FontFaceLike[] = [];
    const createFace = vi.fn((family: string) => {
      const face: FontFaceLike = { family, load: async () => face };
      return face;
    });
    const loader = new FontLoader(store, { createFace, fonts: { add: (f) => added.push(f), delete: (f) => deleted.push(f) } });
    const onLoad = vi.fn();
    loader.onLoad(onLoad);
    const [a, b] = await Promise.all([loader.ensure(font), loader.ensure(font)]);
    expect(a && b).toBe(true);
    expect(createFace).toHaveBeenCalledTimes(1);
    expect(createFace.mock.calls[0]![0]).toBe(font.family);
    expect(loader.isLoaded('f1')).toBe(true);
    expect(onLoad).toHaveBeenCalledTimes(1);
    loader.unload('f1');
    expect(deleted).toHaveLength(1);
    expect(loader.isLoaded('f1')).toBe(false);
  });

  it('FontLoader records failures instead of throwing', async () => {
    const loader = new FontLoader(new FontStore(new MemoryFontFiles()), {
      createFace: () => ({ family: 'X', load: () => Promise.reject(new Error('corrupta')) }),
      fonts: { add: () => undefined, delete: () => undefined },
    });
    const font: CustomFont = { id: 'gone', family: 'X', fileName: 'x.ttf', path: '/fonts/gone.ttf', format: 'truetype' };
    expect(await loader.loadAll([font])).toBe(0);
    expect(loader.failure('gone')).toMatch(/almacenamiento/);
    expect(new FontLoader(new FontStore(new MemoryFontFiles()), null).supported).toBe(false);
  });
});
