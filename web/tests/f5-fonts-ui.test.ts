// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors
// @vitest-environment jsdom

/** Fase 5: the font manager dialog, OPFS font files and Bézier pointer editing. */

import { afterEach, describe, expect, it } from 'vitest';
import { BEZIER_PRESETS } from '../src/editor/keyframe-operations.ts';
import { AddCustomFontOperation, projectFonts } from '../src/editor/text-operations.ts';
import type { EditOperation } from '../src/editor/operations.ts';
import { FontLoader, type FontFaceLike, type FontLoaderEnv } from '../src/render/font-loader.ts';
import { FontStore, MemoryFontFiles, OpfsFontFiles } from '../src/storage/font-store.ts';
import { openFontManager } from '../src/ui/components/font-manager-modal.ts';
import { BezierEditor, curveToCanvas } from '../src/ui/inspector/bezier-editor.ts';
import { makeF5Session } from './f5-helpers.ts';

function fontEnv(gate: Promise<void> = Promise.resolve()): FontLoaderEnv {
  return {
    createFace: (family) => {
      const face: FontFaceLike = { family, load: () => gate.then(() => face) };
      return face;
    },
    fonts: { add: () => undefined, delete: () => true },
  };
}

const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 9, 9, 9, 9]);

afterEach(() => {
  document.body.textContent = '';
});

describe('font manager dialog', () => {
  it('lists project fonts, shows load state, removes them and closes cleanly', async () => {
    const session = makeF5Session();
    const store = new FontStore(new MemoryFontFiles(), () => 'f1');
    const font = await store.add(new File([TTF], 'Titular.ttf'));
    session.run(new AddCustomFontOperation(font));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = new FontLoader(store, fontEnv(gate));
    const errors: unknown[] = [];
    const closed = openFontManager({
      getDocument: () => session.document,
      run: (op: EditOperation) => session.run(op),
      store,
      loader,
      onError: (error) => errors.push(error),
    });
    const dialog = document.querySelector<HTMLElement>('.font-manager-modal')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('.font-meta')!.textContent).toContain('cargando');
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.querySelector('.font-meta')!.textContent).toContain('cargada');
    expect(document.querySelector<HTMLElement>('.font-sample')!.style.fontFamily).toContain(font.family);
    document.querySelector<HTMLButtonElement>('[aria-label="Quitar la fuente Titular.ttf del proyecto"]')!.click();
    expect(projectFonts(session.document)).toEqual([]);
    expect(document.querySelector('.font-list')!.textContent).toContain('aún no tiene fuentes');
    const close = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cerrar')!;
    close.click();
    await closed;
    expect(document.querySelector('.font-manager-modal')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('imports picked files through the hidden input', async () => {
    const session = makeF5Session();
    let n = 0;
    const store = new FontStore(new MemoryFontFiles(), () => `id${(n += 1)}`);
    const loader = new FontLoader(store, fontEnv());
    const closed = openFontManager({ getDocument: () => session.document, run: (op) => session.run(op), store, loader, onError: () => undefined });
    const input = document.querySelector<HTMLInputElement>('.font-manager-modal input[type="file"]')!;
    expect(input.accept).toContain('.woff2');
    Object.defineProperty(input, 'files', { value: [new File([TTF], 'Uno.ttf'), new File([TTF], 'Dos.otf')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(projectFonts(session.document).map((f) => f.fileName)).toEqual(['Uno.ttf', 'Dos.otf']);
    expect(document.querySelector('[role="status"]')!.textContent).toContain('2 fuente(s)');
    expect(document.querySelectorAll('.font-row')).toHaveLength(2);
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cerrar')!.click();
    await closed;
  });
});

describe('OpfsFontFiles', () => {
  it('writes, reads and deletes under /fonts/ in OPFS', async () => {
    const files = new Map<string, Blob>();
    const fontsDir = {
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (!files.has(name) && !options?.create) throw new Error('missing');
        return {
          createWritable: async () => ({ write: async (blob: Blob) => void files.set(name, blob), close: async () => undefined }),
          getFile: async () => files.get(name)!,
        };
      },
      removeEntry: async (name: string) => {
        if (!files.delete(name)) throw new Error('missing');
      },
    };
    const dirs: string[] = [];
    const storage = { getDirectory: async () => ({ getDirectoryHandle: async (name: string) => (dirs.push(name), fontsDir) }) };
    Object.defineProperty(navigator, 'storage', { value: storage, configurable: true });
    try {
      const backend = new OpfsFontFiles();
      await backend.write('a.ttf', new Blob([TTF]));
      expect(dirs).toEqual(['fonts']);
      expect((await backend.read('a.ttf'))?.size).toBe(TTF.length);
      expect(await backend.read('nope.ttf')).toBeNull();
      await backend.delete('a.ttf');
      await backend.delete('a.ttf');
      expect(files.size).toBe(0);
    } finally {
      Reflect.deleteProperty(navigator, 'storage');
    }
  });

  it('falls back to memory without OPFS', async () => {
    const backend = new OpfsFontFiles();
    await backend.write('b.woff2', new Blob([TTF]));
    expect((await backend.read('b.woff2'))?.size).toBe(TTF.length);
    await backend.delete('b.woff2');
    expect(await backend.read('b.woff2')).toBeNull();
  });
});

function pointer(type: string, clientX: number, clientY: number): Event {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

describe('BezierEditor pointer editing', () => {
  it('drags a handle with live previews, then commits once on release', () => {
    const changes: [number[], boolean][] = [];
    const editor = new BezierEditor({ curve: BEZIER_PRESETS.easeInOut, onChange: (curve, final) => changes.push([[...curve], final]) });
    document.body.appendChild(editor.element);
    const canvas = editor.element.querySelector('canvas')!;
    const p1 = curveToCanvas(BEZIER_PRESETS.easeInOut[0], BEZIER_PRESETS.easeInOut[1]);
    // Hover → grab cursor; far away → default.
    canvas.dispatchEvent(pointer('pointermove', p1.px, p1.py));
    expect(canvas.style.cursor).toBe('grab');
    canvas.dispatchEvent(pointer('pointermove', 2, 2));
    expect(canvas.style.cursor).toBe('default');
    // Miss → no drag.
    canvas.dispatchEvent(pointer('pointerdown', 2, 2));
    canvas.dispatchEvent(pointer('pointerup', 2, 2));
    expect(changes).toEqual([]);
    canvas.dispatchEvent(pointer('pointerdown', p1.px, p1.py));
    const target = curveToCanvas(1.4, 1.2);
    canvas.dispatchEvent(pointer('pointermove', target.px, target.py));
    canvas.dispatchEvent(pointer('pointerup', target.px, target.py));
    expect(changes.map(([, final]) => final)).toEqual([false, true]);
    const [x1, y1] = changes[1]![0];
    expect(x1).toBe(1);
    expect(y1).toBeCloseTo(1.2);
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(changes).toHaveLength(3);
    editor.dispose();
    canvas.dispatchEvent(pointer('pointerdown', p1.px, p1.py));
    expect(changes).toHaveLength(3);
  });
});
