// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors
// @vitest-environment jsdom

/** Fase 5 inspector: Bézier editor, effect stack, advanced titling, presets, VU widget. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipStackOf } from '../src/editor/effects-operations.ts';
import { BEZIER_PRESETS, BEZIER_Y_LIMIT } from '../src/editor/keyframe-operations.ts';
import { AddKeyframeOperation, keyframeId, type EditOperation } from '../src/editor/operations.ts';
import { AddVideoEffectOperation } from '../src/editor/effects-operations.ts';
import { ADVANCED_TEXT_KEY, parseAdvancedText } from '../src/render/advanced-text.ts';
import { PresetManager } from '../src/presets/preset-manager.ts';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import type { EditSession } from '../src/session/edit-session.ts';
import {
  BEZIER_CANVAS_SIZE,
  BezierEditor,
  canvasToCurve,
  curveToCanvas,
  moveHandle,
  nearestHandle,
} from '../src/ui/inspector/bezier-editor.ts';
import { ClipInspector } from '../src/ui/inspector/clip-inspector.ts';
import { dropIndex, effectsStackSection, slotToIndex } from '../src/ui/inspector/effects-stack-section.ts';
import { keyframeCurveSection } from '../src/ui/inspector/keyframe-curve-section.ts';
import { compatibleTypes, presetsSection } from '../src/ui/inspector/presets-section.ts';
import { textAdvancedSection, toHexColor, withAlphaOf } from '../src/ui/inspector/text-advanced-section.ts';
import { VuMeterStereo } from '../src/ui/components/vu-meter-stereo.ts';
import { keyframeSelection } from '../src/ui/timeline/keyframe-track.ts';
import { setStudioServices } from '../src/ui/studio-services.ts';
import { clipById, r } from './f3-helpers.ts';
import { FakeAudioContext, FakeNode, makeF5Session } from './f5-helpers.ts';

function hostFor(session: EditSession): { getDocument: () => EditSession['document']; run: (op: EditOperation) => void; ops: number } {
  const host = {
    ops: 0,
    getDocument: () => session.document,
    run: (op: EditOperation): void => {
      host.ops += 1;
      session.run(op);
    },
  };
  return host;
}

function control<T extends HTMLElement = HTMLInputElement>(root: HTMLElement, label: string): T {
  const el = root.querySelector<T>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no control ${label}`);
  return el;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const el = [...root.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!el) throw new Error(`no button ${text}`);
  return el;
}

function change(el: HTMLInputElement | HTMLSelectElement, value: string | boolean): void {
  if (typeof value === 'boolean' && el instanceof HTMLInputElement) el.checked = value;
  else el.value = String(value);
  el.dispatchEvent(new Event('change'));
}

afterEach(() => {
  keyframeSelection.set(null);
  setStudioServices(null);
});

describe('Bézier editor maths', () => {
  it('round-trips canvas ↔ curve coordinates', () => {
    const { px, py } = curveToCanvas(0.25, 0.75);
    const back = canvasToCurve(px, py);
    expect(back.x).toBeCloseTo(0.25);
    expect(back.y).toBeCloseTo(0.75);
    const origin = curveToCanvas(0, 0);
    const corner = curveToCanvas(1, 1);
    expect(origin.px).toBeLessThan(corner.px);
    expect(origin.py).toBeGreaterThan(corner.py);
  });

  it('clamps x to [0,1] and leaves y free within the editor limit', () => {
    expect(canvasToCurve(-500, 0).x).toBe(0);
    expect(canvasToCurve(5000, 0).x).toBe(1);
    expect(Math.abs(canvasToCurve(0, -100000).y)).toBeLessThanOrEqual(BEZIER_Y_LIMIT);
    const moved = moveHandle(BEZIER_PRESETS.linear, 1, 1.7, -0.4);
    expect(moved[0]).toBe(1);
    expect(moved[1]).toBeCloseTo(-0.4);
    const second = moveHandle(BEZIER_PRESETS.linear, 2, -2, 1.4);
    expect(second[2]).toBe(0);
    expect(second[3]).toBeCloseTo(1.4);
  });

  it('finds the handle under the pointer', () => {
    const curve = BEZIER_PRESETS.easeInOut;
    const p1 = curveToCanvas(curve[0], curve[1]);
    const p2 = curveToCanvas(curve[2], curve[3]);
    expect(nearestHandle(curve, p1.px + 3, p1.py)).toBe(1);
    expect(nearestHandle(curve, p2.px, p2.py - 3)).toBe(2);
    expect(nearestHandle(curve, BEZIER_CANVAS_SIZE / 2, 2)).toBeNull();
  });
});

describe('BezierEditor widget', () => {
  it('applies presets and keyboard nudges with clamping', () => {
    const changes: [number[], boolean][] = [];
    const editor = new BezierEditor({ curve: BEZIER_PRESETS.linear, onChange: (curve, final) => changes.push([[...curve], final]) });
    expect(editor.element.querySelector('canvas')?.width).toBeGreaterThanOrEqual(BEZIER_CANVAS_SIZE);
    buttonByText(editor.element, 'Ease-In').click();
    expect([...editor.value()]).toEqual([...BEZIER_PRESETS.easeIn]);
    expect(changes.at(-1)).toEqual([[...BEZIER_PRESETS.easeIn], true]);
    const canvas = editor.element.querySelector('canvas')!;
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    for (let i = 0; i < 12; i += 1) canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true }));
    expect(editor.value()[2]).toBe(1);
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(editor.value()[3]).toBeCloseTo(1.01);
    editor.set([0.5, 9, 0.5, -9]);
    expect(editor.value()[1]).toBe(BEZIER_Y_LIMIT);
    expect(editor.value()[3]).toBe(-BEZIER_Y_LIMIT);
    editor.dispose();
  });
});

describe('keyframe curve section', () => {
  it('shows a hint without a selected key, and edits the selected key', () => {
    const session = makeF5Session();
    session.run(new AddKeyframeOperation('c1', 'opacity', r(0.5), 0.2));
    session.run(new AddKeyframeOperation('c1', 'opacity', r(1.5), 0.8));
    const host = hostFor(session);
    const kept: BezierEditor[] = [];
    const empty = keyframeCurveSection(host, clipById(session, 'c1'), null, (e) => kept.push(e));
    expect(empty.textContent).toContain('⏷');
    expect(kept).toHaveLength(0);
    const previews: (readonly number[] | null)[] = [];
    const ref = { clipId: 'c1', property: 'opacity' as const, keyframeId: keyframeId('opacity', 0.75) };
    const section = keyframeCurveSection({ ...host, preview: (_id, _ref, curve) => previews.push(curve) }, clipById(session, 'c1'), ref, (e) => kept.push(e));
    expect(kept).toHaveLength(1);
    buttonByText(section, 'Ease-Out').click();
    expect([...clipById(session, 'c1').keys.find((k) => k.at === 0.75)!.ease.points]).toEqual([...BEZIER_PRESETS.easeOut]);
    expect(previews).toEqual([null]);
    const value = section.querySelector<HTMLInputElement>('input[type="number"]')!;
    change(value, '0.4');
    expect(clipById(session, 'c1').keys.find((k) => k.at === 0.75)!.value).toBeCloseTo(0.4);
    kept.forEach((editor) => editor.dispose());
  });
});

describe('effects stack section', () => {
  it('computes drop slots and final indices', () => {
    const rows = [{ top: 0, height: 20 }, { top: 20, height: 20 }, { top: 40, height: 20 }];
    expect(dropIndex(rows, 5)).toBe(0);
    expect(dropIndex(rows, 25)).toBe(1);
    expect(dropIndex(rows, 59)).toBe(3);
    expect(slotToIndex(0, 3)).toBe(2);
    expect(slotToIndex(2, 0)).toBe(0);
    expect(slotToIndex(1, 1)).toBe(1);
  });

  it('adds, edits, toggles, reorders and removes effects — one undo step each', () => {
    const session = makeF5Session();
    const host = hostFor(session);
    const open = new Set<string>();
    const build = (): HTMLElement => effectsStackSection(host, clipById(session, 'c1'), open)!;
    let el = build();
    change(control<HTMLSelectElement>(el, 'Efecto de vídeo a añadir'), 'blur');
    buttonByText(el, 'Añadir').click();
    el = build();
    change(control<HTMLSelectElement>(el, 'Efecto de vídeo a añadir'), 'vignette');
    buttonByText(el, 'Añadir').click();
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.type)).toEqual(['blur', 'vignette']);
    el = build();
    expect(el.querySelectorAll('.fx-stack-row')).toHaveLength(2);
    // Param slider of the blur.
    change(control(el, 'Radio'), '20');
    expect(clipStackOf(session.document, 'c1', 'video')[0]!.params['radius']).toBe(20);
    // Bypass the vignette.
    el = build();
    change(control(el, 'Desactivar Viñeta'), false);
    expect(clipStackOf(session.document, 'c1', 'video')[1]!.enabled).toBe(false);
    // Alt+↑ moves the vignette to the top.
    el = build();
    const vignetteTitle = [...el.querySelectorAll<HTMLButtonElement>('.fx-stack-title')].find((b) => b.textContent?.includes('Viñeta'))!;
    vignetteTitle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }));
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.type)).toEqual(['vignette', 'blur']);
    session.undo();
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.type)).toEqual(['blur', 'vignette']);
    el = build();
    buttonByText(el, '×').click();
    expect(clipStackOf(session.document, 'c1', 'video')).toHaveLength(1);
    expect(host.ops).toBe(6);
  });

  it('reorders by drag & drop', () => {
    const session = makeF5Session();
    session.run(new AddVideoEffectOperation('c1', 'blur'));
    session.run(new AddVideoEffectOperation('c1', 'vignette'));
    session.run(new AddVideoEffectOperation('c1', 'noise'));
    const el = effectsStackSection(hostFor(session), clipById(session, 'c1'), new Set())!;
    document.body.appendChild(el);
    const list = el.querySelector('.fx-stack-list')!;
    const rows = [...el.querySelectorAll<HTMLElement>('.fx-stack-row')];
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: i * 30, height: 30, bottom: i * 30 + 30, left: 0, right: 100, width: 100, x: 0, y: i * 30, toJSON: () => ({}) });
    });
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: 'all', dropEffect: 'none', setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' };
    const fire = (target: Element, type: string, clientY = 0): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'clientY', { value: clientY });
      target.dispatchEvent(event);
    };
    fire(rows[0]!, 'dragstart');
    fire(list, 'dragover', 85);
    expect(list.querySelector('.fx-stack-drop')).not.toBeNull();
    fire(list, 'drop', 85);
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.type)).toEqual(['vignette', 'noise', 'blur']);
    expect(list.querySelector('.fx-stack-drop')).toBeNull();
    el.remove();
  });

  it('offers audio effects to audio clips and nothing video-only', () => {
    const session = makeF5Session();
    const host = hostFor(session);
    const el = effectsStackSection(host, clipById(session, 'c2'), new Set())!;
    expect(el.querySelector('[aria-label="Efecto de vídeo a añadir"]')).toBeNull();
    change(control<HTMLSelectElement>(el, 'Efecto de audio a añadir'), 'reverb');
    buttonByText(el, 'Añadir').click();
    expect(clipStackOf(session.document, 'c2', 'audio').map((fx) => fx.type)).toEqual(['reverb']);
    expect(effectsStackSection(host, clipById(session, 'c3'), new Set())).toBeNull();
  });
});

describe('advanced titling section', () => {
  it('normalises colours for <input type=color> and keeps alpha', () => {
    expect(toHexColor('#abc')).toBe('#aabbcc');
    expect(toHexColor('#A1B2C3FF')).toBe('#a1b2c3');
    expect(toHexColor('rgba(255, 0, 16, 0.5)')).toBe('#ff0010');
    expect(toHexColor('tomato', '#123456')).toBe('#123456');
    expect(withAlphaOf('#ff0000', 'rgba(0,0,0,0.6)')).toBe('rgba(255,0,0,0.6)');
    expect(withAlphaOf('#ff0000', '#000000')).toBe('#ff0000');
  });

  it('edits stroke, shadow, background and typewriter of a text clip', () => {
    const session = makeF5Session();
    const host = { ...hostFor(session), openFontManager: vi.fn() };
    const build = (): HTMLElement => textAdvancedSection(host, clipById(session, 'c3'))!;
    expect(textAdvancedSection(host, clipById(session, 'c1'))).toBeNull();
    let el = build();
    change(control(el, 'Borde'), true);
    el = build();
    change(control(el, 'Sombra'), true);
    el = build();
    change(control(el, 'Caja de fondo'), true);
    el = build();
    change(control(el, 'Revelar letra a letra'), true);
    el = build();
    change(control(el, 'Duración'), '2');
    el = build();
    change(control(el, 'Color de sombra'), '#ff0000');
    const adv = parseAdvancedText(clipById(session, 'c3').extra[ADVANCED_TEXT_KEY])!;
    expect(adv.stroke.enabled).toBe(true);
    expect(adv.shadow.enabled).toBe(true);
    expect(adv.shadow.color).toBe('rgba(255,0,0,0.6)');
    expect(adv.background.enabled).toBe(true);
    expect(adv.typewriter).toMatchObject({ enabled: true, duration: 2 });
    buttonByText(build(), 'Gestionar fuentes…').click();
    expect(host.openFontManager).toHaveBeenCalledOnce();
    buttonByText(build(), 'Quitar estilo avanzado').click();
    expect(clipById(session, 'c3').extra[ADVANCED_TEXT_KEY]).toBeUndefined();
  });

  it('switches to a gradient fill and to a built-in family', () => {
    const session = makeF5Session();
    const host = { ...hostFor(session), openFontManager: () => undefined };
    let el = textAdvancedSection(host, clipById(session, 'c3'))!;
    change(control(el, 'Degradado'), true);
    el = textAdvancedSection(host, clipById(session, 'c3'))!;
    expect(control(el, 'Color 2')).toBeTruthy();
    expect(Array.isArray(parseAdvancedText(clipById(session, 'c3').extra[ADVANCED_TEXT_KEY])!.fill)).toBe(true);
    change(control<HTMLSelectElement>(el, 'Fuente'), 'sys:system-ui, sans-serif');
    expect(clipById(session, 'c3').text?.fontFamily).toBe('system-ui, sans-serif');
  });
});

describe('presets section', () => {
  it('lists compatible types per clip kind', () => {
    const session = makeF5Session();
    expect(compatibleTypes(clipById(session, 'c1'))).toEqual(['video', 'audio', 'color']);
    expect(compatibleTypes(clipById(session, 'c2'))).toEqual(['audio']);
    expect(compatibleTypes(clipById(session, 'c3'))).toEqual(['video', 'text']);
  });

  it('applies a built-in preset (undoable) and saves/deletes a user preset', async () => {
    const session = makeF5Session();
    const presets = new PresetManager(new MemoryKeyValue(), () => 1, () => 'user-1');
    const errors: unknown[] = [];
    const host = { ...hostFor(session), presets, onError: (error: unknown) => errors.push(error) };
    const el = presetsSection(host, clipById(session, 'c1'))!;
    expect(el.textContent).not.toContain('Typewriter');
    buttonByText(el, 'Zoom In + Desenfoque').click();
    expect(clipById(session, 'c1').keys.some((key) => key.property === 'scale')).toBe(true);
    expect(clipStackOf(session.document, 'c1', 'video').map((fx) => fx.type)).toContain('blur');
    session.undo();
    expect(clipById(session, 'c1').keys).toHaveLength(0);
    // Save the current look as a colour-less motion preset.
    buttonByText(el, 'Zoom In').click();
    const name = control(el, 'Nombre del nuevo preset');
    name.value = 'Mi zoom';
    buttonByText(el, 'Guardar preset').click();
    await vi.waitFor(async () => expect((await presets.list('video')).some((p) => p.name === 'Mi zoom')).toBe(true));
    const fresh = presetsSection(host, clipById(session, 'c1'))!;
    await vi.waitFor(() => expect(fresh.querySelector('[aria-label="Borrar el preset «Mi zoom»"]')).not.toBeNull());
    fresh.querySelector<HTMLButtonElement>('[aria-label="Borrar el preset «Mi zoom»"]')!.click();
    await vi.waitFor(async () => expect(await presets.get('user-1')).toBeNull());
    expect(errors).toEqual([]);
  });

  it('reports an empty capture instead of saving it', () => {
    const session = makeF5Session();
    const errors: unknown[] = [];
    const host = { ...hostFor(session), presets: new PresetManager(new MemoryKeyValue()), onError: (error: unknown) => errors.push(error) };
    const el = presetsSection(host, clipById(session, 'c2'))!;
    buttonByText(el, 'Guardar preset').click();
    expect(errors).toHaveLength(1);
  });
});

describe('ClipInspector Fase 5 integration', () => {
  it('adds the F5 sections and follows the keyframe selection', () => {
    const session = makeF5Session();
    session.run(new AddKeyframeOperation('c1', 'opacity', r(1), 0.5));
    const presets = new PresetManager(new MemoryKeyValue());
    const fontManager = vi.fn();
    setStudioServices({ presets, openFontManager: fontManager, previewKeyframeCurve: () => undefined, reportError: () => undefined });
    const inspector = new ClipInspector({
      getDocument: () => session.document,
      run: (op) => {
        session.run(op);
      },
      playheadSeconds: () => 0,
      markers: () => [],
      refresh: () => undefined,
    });
    inspector.show('c1');
    const el = inspector.element;
    expect(el.querySelector('.fx-stack')).not.toBeNull();
    expect(el.querySelector('.fx-presets')).not.toBeNull();
    expect(el.querySelector('.fx-keyframe-hint')).not.toBeNull();
    keyframeSelection.set({ clipId: 'c1', property: 'opacity', keyframeId: keyframeId('opacity', 0.5) });
    expect(inspector.element.querySelector('.fx-keyframe-curve canvas')).not.toBeNull();
    inspector.show('c3');
    expect(inspector.element.querySelector('.fx-text-advanced')).not.toBeNull();
    buttonByText(inspector.element, 'Gestionar fuentes…').click();
    expect(fontManager).toHaveBeenCalledOnce();
    inspector.dispose();
    keyframeSelection.set(null);
  });
});

describe('VuMeterStereo widget', () => {
  it('taps every master, animates with rAF and lights the clip LED', () => {
    const frames: ((time: number) => void)[] = [];
    let tap: ((master: FakeNode, context: unknown) => void) | null = null;
    const meter = new VuMeterStereo({
      addMasterTap: (fn) => {
        tap = fn;
        return () => {
          tap = null;
        };
      },
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => undefined,
    });
    const context = new FakeAudioContext();
    tap!(new FakeNode('gain'), context);
    const [left, right] = context.of('analyser');
    left!.samples = new Float32Array([1.0]);
    right!.samples = new Float32Array([0.1]);
    frames.shift()!(16);
    const [ledL, ledR] = [...meter.element.querySelectorAll('.vu-clip-led')];
    expect(ledL!.classList.contains('is-clipping')).toBe(true);
    expect(ledR!.classList.contains('is-clipping')).toBe(false);
    expect(meter.element.querySelector('canvas')!.getAttribute('aria-label')).toContain('L 0 dBFS');
    expect(frames).toHaveLength(1);
    (ledL as HTMLButtonElement).click();
    left!.samples = new Float32Array([0.2]);
    frames.shift()!(40);
    expect(ledL!.classList.contains('is-clipping')).toBe(false);
    meter.attach(new FakeNode('gain'), {});
    meter.dispose();
    expect(tap).toBeNull();
    frames.shift()?.(60);
    expect(frames).toHaveLength(0);
  });
});
