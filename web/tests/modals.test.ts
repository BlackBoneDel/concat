// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors
// @vitest-environment jsdom

/** Fase 4 dialogs: focus trap, keyboard, cleanup and their workflows. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderScanner } from '../src/media/relink/folder-scanner.ts';
import { Relinker, type RelinkAssignment } from '../src/media/relink/relinker.ts';
import { BUILTIN_LUTS } from '../src/media/vision/lut-loader.ts';
import { Dialog, formatBytes, openBulkImportModal, openLutBrowser, openProxyModal, openRelinkModal, progressBar, type ProxyModalSource } from '../src/ui/modals/index.ts';
import type { ProxyState } from '../src/ui/media-tools.ts';
import { makeMedia } from './f3-helpers.ts';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function key(target: Element, name: string, shiftKey = false): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }));
}

function byText(text: string): HTMLButtonElement {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!el) throw new Error(`no button ${text}`);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('Dialog', () => {
  it('is labelled, traps Tab, closes on Escape, restores focus and runs cleanups', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const dialog = new Dialog({ title: 'Prueba', description: 'Descripción' });
    const a = dialog.addButton('A', () => undefined);
    const b = dialog.addButton('B', () => undefined);
    const cleanup = vi.fn();
    dialog.onClose(cleanup);
    await flush();
    const el = dialog.element;
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent).toBe('Prueba');
    expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).toBe('Descripción');
    expect(el.contains(document.activeElement)).toBe(true);
    b.focus();
    key(b, 'Tab');
    expect(document.activeElement).toBe(dialog.focusables()[0]);
    dialog.focusables()[0]!.focus();
    key(document.activeElement!, 'Tab', true);
    expect(document.activeElement).toBe(b);
    expect(a.isConnected).toBe(true);
    key(b, 'Escape');
    await dialog.closed;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(el.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
    const late = vi.fn();
    dialog.onClose(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it('formats bytes and progress', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    const bar = progressBar('x');
    bar.set(0.42);
    expect(bar.element.getAttribute('aria-valuenow')).toBe('42');
    bar.set(3);
    expect(bar.element.getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('LUT browser', () => {
  it('moves with the arrows and applies with Enter', async () => {
    const pending = openLutBrowser({ luts: BUILTIN_LUTS, currentId: null });
    await flush();
    const list = document.querySelector('[role="listbox"]')!;
    expect(list.querySelectorAll('[role="option"]').length).toBe(BUILTIN_LUTS.length);
    key(list, 'ArrowRight');
    expect(list.querySelector('[aria-selected="true"]')?.id).toBe('lut-option-1');
    key(list, 'ArrowLeft');
    key(list, 'ArrowLeft');
    expect(list.getAttribute('aria-activedescendant')).toBe('lut-option-0');
    key(list, 'End');
    key(list, 'Enter');
    expect((await pending)?.id).toBe(BUILTIN_LUTS[BUILTIN_LUTS.length - 1]!.id);
    expect(document.querySelector('.lut-browser')).toBeNull();
  });

  it('resolves null on Escape and adds imported LUTs', async () => {
    const extra = { ...BUILTIN_LUTS[0]!, id: 'session:mine', title: 'Mío' };
    const pending = openLutBrowser({ luts: BUILTIN_LUTS.slice(0, 2), currentId: BUILTIN_LUTS[1]!.id, importLut: async () => extra });
    await flush();
    expect(document.querySelector('[aria-selected="true"]')?.id).toBe('lut-option-1');
    const input = document.querySelector<HTMLInputElement>('.lut-browser input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'mine.cube')] });
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(document.querySelectorAll('[role="option"]').length).toBe(3);
    expect(document.querySelector('[aria-selected="true"] .lut-name')?.textContent).toBe('Mío');
    key(document.querySelector('[role="listbox"]')!, 'Escape');
    expect(await pending).toBeNull();
  });
});

describe('proxy manager', () => {
  it('renders states, reacts to progress and unsubscribes on close', async () => {
    const states = new Map<string, ProxyState>([['m1', { status: 'none', progress: 0, error: null }]]);
    let listener: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const source: ProxyModalSource = {
      assets: () => [{ id: 'm1', name: 'clip.mp4', width: 3840, height: 2160, recommended: true }],
      state: (id) => states.get(id) ?? { status: 'none', progress: 0, error: null },
      generate: vi.fn((id: string) => states.set(id, { status: 'generating', progress: 0.25, error: null })),
      remove: vi.fn(),
      clearAll: vi.fn(async () => undefined),
      usage: async () => ({ bytes: 1024 ** 3, limit: 5 * 1024 ** 3 }),
      subscribe: (fn) => {
        listener = fn;
        return unsubscribe;
      },
    };
    const closed = openProxyModal(source);
    await flush();
    expect(document.querySelector('.proxy-modal .fx-note')?.textContent).toContain('1.0 GB de 5.0 GB');
    byText('Generar recomendados').click();
    expect(source.generate).toHaveBeenCalledWith('m1', 'default');
    listener!();
    expect(document.querySelector('.proxy-row.status-generating [role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
    states.set('m1', { status: 'error', progress: 0, error: 'sin códec' });
    listener!();
    expect(document.querySelector('.proxy-status')?.textContent).toBe('Error: sin códec');
    byText('Cerrar').click();
    await closed;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('relink dialog', () => {
  it('scans a folder, preselects automatic matches and applies them', async () => {
    const item = { ...makeMedia('m1', 4), name: 'toma1.mp4', path: 'toma1.mp4' };
    const scanner = new FolderScanner();
    const file = new File(['abc'], 'toma1.mp4');
    vi.spyOn(scanner, 'pickAndScan').mockResolvedValue([{ file, path: 'f/toma1.mp4' }, { file: new File(['z'], 'otra.mp4'), path: 'f/otra.mp4' }]);
    const relinker = new Relinker({ probe: async () => ({ duration: 4, width: 640, height: 360 }) });
    const applied: RelinkAssignment[][] = [];
    const done = openRelinkModal({ missing: [{ item, usedBy: 2 }], relinker, scanner, apply: async (a) => { applied.push(a); }, onError: (e) => { throw e; } });
    await flush();
    expect(byText('Aplicar').disabled).toBe(true);
    byText('Buscar en carpeta…').click();
    await vi.waitFor(() => expect(byText('Aplicar').disabled).toBe(false));
    expect(document.querySelector('.relink-badge')?.textContent).toBe('Automático');
    byText('Aplicar').click();
    expect(await done).toBe(1);
    expect(applied[0]?.[0]).toMatchObject({ mediaId: 'm1', path: 'f/toma1.mp4' });
  });
});

describe('bulk import dialog', () => {
  it('validates concurrency, imports and reports groups', async () => {
    const scanner = new FolderScanner();
    vi.spyOn(scanner, 'pickAndScan').mockResolvedValue([
      { file: new File(['a'], 'a.mp4'), path: 'd/a.mp4' },
      { file: new File(['b'], 'b.wav'), path: 'd/b.wav' },
    ]);
    const onDone = vi.fn();
    const closed = openBulkImportModal<string>({
      scanner,
      importOne: async ({ file }) => {
        if (file.name === 'b.wav') throw new Error('roto');
        return file.name;
      },
      onDone,
    });
    await flush();
    byText('Elegir carpeta…').click();
    await vi.waitFor(() => expect(byText('Importar').disabled).toBe(false));
    const concurrency = document.querySelector<HTMLInputElement>('.bulk-form input[type="number"]')!;
    concurrency.value = '12';
    byText('Importar').click();
    await flush();
    expect(document.querySelector('.bulk-import-modal [aria-live]')?.textContent).toContain('entre 1 y 8');
    concurrency.value = '2';
    byText('Importar').click();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onDone.mock.calls[0]?.[1]).toEqual({ completed: 1, failed: 1, cancelled: false });
    expect(document.querySelectorAll('.bulk-log li').length).toBe(2);
    byText('Cerrar').click();
    await closed;
  });
});
