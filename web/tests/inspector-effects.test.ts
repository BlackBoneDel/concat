// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors
// @vitest-environment jsdom

/** Fase 4 inspector sections: one undoable edit per committed change. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipEffectsOf } from '../src/editor/effect-operations.ts';
import type { EditOperation } from '../src/editor/operations.ts';
import { LutLibrary } from '../src/media/vision/lut-library.ts';
import { BUILTIN_LUTS } from '../src/media/vision/lut-loader.ts';
import { blankClip, defaultTextStyle } from '../src/model/document.ts';
import { ClipInspector } from '../src/ui/inspector/clip-inspector.ts';
import { audioFxSection, chromaKeySection, colorGradingSection, subtitlesSection } from '../src/ui/inspector/index.ts';
import { setMediaTools, type MediaTools } from '../src/ui/media-tools.ts';
import { clipById, makeSession, snap } from './f3-helpers.ts';

function hostFor(session: ReturnType<typeof makeSession>): { getDocument: () => typeof session.document; run: (op: EditOperation) => void; ops: number } {
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

function input(root: HTMLElement, label: string): HTMLInputElement {
  const el = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no control ${label}`);
  return el;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const el = [...root.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!el) throw new Error(`no button ${text}`);
  return el;
}

function tools(overrides: Partial<MediaTools> = {}): MediaTools {
  return {
    luts: new LutLibrary(),
    notify: vi.fn(),
    pickColor: async () => ([10, 200, 30] as [number, number, number]),
    browseLuts: async () => BUILTIN_LUTS[0] ?? null,
    proxiesEnabled: false,
    toggleProxies: vi.fn(),
    proxyState: () => ({ status: 'none', progress: 0, error: null }),
    generateProxy: vi.fn(),
    deleteProxy: vi.fn(),
    openProxyManager: vi.fn(),
    metadata: async () => null,
    openRelink: vi.fn(),
    importFolder: vi.fn(),
    importSubtitles: async () => undefined,
    exportSubtitles: vi.fn(),
    importLut: async () => null,
    clearProxies: async () => undefined,
    offlineIds: new Set<string>(),
    ...overrides,
  };
}

afterEach(() => setMediaTools(null));

describe('chroma key section', () => {
  it('commits sliders on change only, as single undoable edits', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const host = hostFor(session);
    const before = snap(session.document);
    const root = chromaKeySection(host, clipById(session, 'c1'));
    const enable = input(root, 'Chroma key activo');
    enable.checked = true;
    enable.dispatchEvent(new Event('change'));
    expect(host.ops).toBe(1);
    expect(clipEffectsOf(session.document, 'c1').chromaKey?.enabled).toBe(true);

    const fresh = chromaKeySection(host, clipById(session, 'c1'));
    const similarity = input(fresh, 'Similitud');
    similarity.value = '0.6';
    similarity.dispatchEvent(new Event('input'));
    similarity.dispatchEvent(new Event('input'));
    expect(host.ops).toBe(1);
    similarity.dispatchEvent(new Event('change'));
    expect(host.ops).toBe(2);
    expect(clipEffectsOf(session.document, 'c1').chromaKey?.similarity).toBeCloseTo(0.6);
    session.undo();
    session.undo();
    expect(snap(session.document)).toBe(before);
  });

  it('uses the eyedropper from the media tools', async () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const host = hostFor(session);
    setMediaTools(tools());
    const root = chromaKeySection(host, clipById(session, 'c1'));
    buttonByText(root, 'Cuentagotas').click();
    await vi.waitFor(() => expect(host.ops).toBe(1));
    expect(clipEffectsOf(session.document, 'c1').chromaKey?.color).toEqual([10, 200, 30] as [number, number, number]);
  });
});

describe('color grading section', () => {
  it('picks a LUT from the browser and sets its strength', async () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const host = hostFor(session);
    setMediaTools(tools());
    const root = colorGradingSection(host, clipById(session, 'c1'));
    const lut = BUILTIN_LUTS[0]!;
    expect([...root.querySelectorAll('option')].some((o) => o.value === lut.id)).toBe(true);
    buttonByText(root, 'Explorar…').click();
    await vi.waitFor(() => expect(clipEffectsOf(session.document, 'c1').lut?.id).toBe(lut.id));
    const again = colorGradingSection(host, clipById(session, 'c1'));
    const strength = input(again, 'Intensidad LUT');
    strength.value = '0.5';
    strength.dispatchEvent(new Event('change'));
    expect(clipEffectsOf(session.document, 'c1').lut?.strength).toBeCloseTo(0.5);
  });
});

describe('audio fx section', () => {
  it('toggles the compressor and resets everything', () => {
    const session = makeSession([{ start: 0, duration: 2, kind: 'audio' }]);
    const host = hostFor(session);
    const root = audioFxSection(host, clipById(session, 'c1'));
    const comp = input(root, 'Compresor');
    comp.checked = true;
    comp.dispatchEvent(new Event('change'));
    expect(clipEffectsOf(session.document, 'c1').audio?.compressor).not.toBeNull();
    const fresh = audioFxSection(host, clipById(session, 'c1'));
    buttonByText(fresh, 'Restablecer audio').click();
    expect('effects' in clipById(session, 'c1').extra).toBe(false);
  });
});

describe('subtitles section', () => {
  it('is only shown for text clips and edits the cue text', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const host = hostFor(session);
    expect(subtitlesSection(host, clipById(session, 'c1'))).toBeNull();
    const text = blankClip('t1', 'T1', 'text', 'Sub', 3, 1);
    text.text = { ...defaultTextStyle(), content: 'Hola' };
    session.document.timelines[0]!.clips.push(text);
    session.history.rebase(session.document);
    const root = subtitlesSection(host, clipById(session, 't1'));
    expect(root).not.toBeNull();
    const area = root!.querySelector('textarea')!;
    area.value = 'Adiós';
    area.dispatchEvent(new Event('change'));
    expect(clipById(session, 't1').text?.content).toBe('Adiós');
  });
});

describe('ClipInspector integration', () => {
  it('appends the Fase 4 sections by clip kind and keeps open state', () => {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 0, duration: 2, kind: 'audio', trackId: 'A1' }]);
    const inspector = new ClipInspector({
      getDocument: () => session.document,
      run: (op) => {
        session.run(op);
      },
      playheadSeconds: () => 0,
      markers: () => [],
      refresh: () => undefined,
    } as ConstructorParameters<typeof ClipInspector>[0]);
    inspector.show('c1');
    const el = inspector.element;
    expect(el.querySelector('.fx-chroma')).not.toBeNull();
    expect(el.querySelector('.fx-color')).not.toBeNull();
    expect(el.querySelector('.fx-audio')).not.toBeNull();
    const chroma = el.querySelector<HTMLDetailsElement>('.fx-chroma')!;
    chroma.open = true;
    inspector.show('c1');
    expect(inspector.element.querySelector<HTMLDetailsElement>('.fx-chroma')!.open).toBe(true);
    inspector.show('c2');
    expect(inspector.element.querySelector('.fx-chroma')).toBeNull();
    expect(inspector.element.querySelector('.fx-audio')).not.toBeNull();
  });
});
