// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 6: export dialog, shortcut sheet, storage manager, package dialog and services. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { createProductionServices, hasWebCodecsEncoder, type ProductionHost } from '../src/app/production.ts';
import { ExportController } from '../src/export/export-controller.ts';
import { InstallPrompt } from '../src/pwa/install-prompt.ts';
import { actionToast } from '../src/ui/action-toast.ts';
import { downloadBlob, DOWNLOAD_REVOKE_MS } from '../src/ui/download.ts';
import { EXPORT_ERROR_HINTS, openExportModal, saveWithPicker, savePicker, type ExportModalHost } from '../src/ui/modals/export-modal.ts';
import { packageFileName, openProjectPackageModal } from '../src/ui/modals/project-package-modal.ts';
import { filterShortcuts, openShortcutsModal, SHORTCUT_GROUPS } from '../src/ui/modals/shortcuts-modal.ts';
import { confirmSteps, openStorageManagerModal, type StorageManagerSource } from '../src/ui/modals/storage-manager-modal.ts';
import { Notifications } from '../src/ui/notifications.ts';
import { getProductionServices, setProductionServices } from '../src/ui/production-services.ts';
import { makeSession } from './f3-helpers.ts';
import { FakeMedia, FakeSurface, FakeVideoEncoder, FakeAudioEncoder, FakeOfflineContext } from './f6-helpers.ts';

const flush = async (times = 20): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`sin botón ${label}`);
  return found;
}

const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  created.length = 0;
  revoked.length = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => { const url = `blob:${created.length}`; created.push(url); return url; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => revoked.push(url) });
  HTMLAnchorElement.prototype.click = () => undefined;
  localStorage.clear();
});

afterEach(() => {
  setProductionServices(null);
  vi.useRealTimers();
});

type TestHost = ExportModalHost & { notes: string[]; confirmAnswer: boolean };

function exportHost(overrides: Partial<ExportModalHost> = {}): TestHost {
  const session = makeSession([{ start: 0, duration: 1 }]);
  const media = new FakeMedia();
  media.originals.add('m1');
  const notes: string[] = [];
  const host: TestHost = {
    notes,
    confirmAnswer: true,
    createController: () =>
      new ExportController({
        getDocument: () => session.document,
        media,
        createSurface: (w, h) => new FakeSurface(w, h),
        composite: async () => undefined,
        createVideoEncoder: (callbacks) => new FakeVideoEncoder(callbacks),
        isVideoConfigSupported: async () => true,
        createAudioEncoder: (callbacks) => new FakeAudioEncoder(callbacks),
        isAudioConfigSupported: async () => true,
        createOfflineContext: (c, l, r) => new FakeOfflineContext(c, l, r),
        hasWebCodecs: () => true,
        yieldToUi: async () => undefined,
      }),
    projectName: () => 'Mi vídeo',
    timelineSeconds: () => 1,
    markedRange: () => null,
    sequence: () => ({ width: 64, height: 36, fps: 10 }),
    webCodecs: true,
    ffmpeg: false,
    notify: (_kind, title) => void notes.push(title),
    confirm: async (): Promise<boolean> => host.confirmAnswer,
    ...overrides,
  };
  return host;
}

describe('export modal', () => {
  it('runs an export end to end and offers the download', async () => {
    const host = exportHost();
    const closed = openExportModal(host);
    await flush(2);
    const dialog = document.querySelector('.export-modal')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.querySelector('.export-estimate')!.textContent).toContain('10 fotogramas');
    const name = dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(name.value).toBe('Mi vídeo');
    // Backdrop clicks never close it.
    document.querySelector('.modal-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.export-modal')).not.toBeNull();
    // The sequence is 64×36 at 10 fps; switch the preset to custom-sized output.
    const preset = dialog.querySelector('select')!;
    expect(preset.value).toBe('custom');
    button('Exportar').click();
    await flush(60);
    expect(dialog.querySelector('.export-summary')!.textContent).toContain('Mi vídeo.mp4');
    expect(host.notes).toContain('Exportación completada');
    button('Descargar').click();
    expect(created).toHaveLength(1);
    expect(localStorage.getItem('concat.export.last')).toContain('presetId');
    button('Cerrar').click();
    await closed;
    expect(document.querySelector('.export-modal')).toBeNull();
  });

  it('applies presets, validates and shows the compat warning', async () => {
    const host = exportHost({ webCodecs: false, ffmpeg: false });
    void openExportModal(host);
    await flush(2);
    const dialog = document.querySelector('.export-modal')!;
    expect(dialog.querySelector('.export-compat')!.textContent).toContain('Chrome');
    expect(button('Exportar').disabled).toBe(true);
    const preset = dialog.querySelector('select')!;
    preset.value = 'gif-short';
    preset.dispatchEvent(new Event('change'));
    expect(button('Exportar').disabled).toBe(false);
    const width = dialog.querySelectorAll<HTMLInputElement>('input[type="number"]')[1]!;
    expect(width.value).toBe('480');
    width.value = '5';
    width.dispatchEvent(new Event('change'));
    expect(preset.value).toBe('custom');
    expect(dialog.querySelector('.export-problems')!.classList.contains('is-error')).toBe(true);
    expect(button('Exportar').disabled).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.export-modal')).toBeNull();
  });

  it('confirms before cancelling and shows errors with hints', async () => {
    let release: (() => void) | null = null;
    const session = makeSession([{ start: 0, duration: 1 }]);
    const media = new FakeMedia();
    media.originals.add('m1');
    const host = exportHost({
      markedRange: () => ({ start: Rational.ZERO, end: Rational.fromInt(1) }),
      createController: () =>
        new ExportController({
          getDocument: () => session.document,
          media,
          createSurface: (w, h) => new FakeSurface(w, h),
          composite: () => new Promise<void>((resolve) => (release = resolve)),
          createVideoEncoder: (callbacks) => new FakeVideoEncoder(callbacks),
          isVideoConfigSupported: async () => true,
          createAudioEncoder: (callbacks) => new FakeAudioEncoder(callbacks),
          isAudioConfigSupported: async () => true,
          createOfflineContext: (c, l, r) => new FakeOfflineContext(c, l, r),
          hasWebCodecs: () => true,
          yieldToUi: async () => undefined,
        }),
    });
    void openExportModal(host);
    await flush(2);
    const dialog = document.querySelector('.export-modal')!;
    const select = dialog.querySelectorAll('select');
    expect([...select].some((s) => s.value === 'marked')).toBe(true);
    button('Exportar').click();
    await flush(5);
    expect(dialog.querySelector('.export-preview')).not.toBeNull();
    expect(dialog.querySelector<HTMLButtonElement>('.modal-close')!.hidden).toBe(true);
    host.confirmAnswer = false;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(2);
    expect(document.querySelector('.export-modal')).not.toBeNull();
    host.confirmAnswer = true;
    button('Cancelar exportación').click();
    await flush(2);
    const held: { fn: (() => void) | null } = { fn: release };
    held.fn?.();
    await flush(10);
    expect(host.notes).toContain('Exportación cancelada');
    expect(dialog.querySelector('.export-estimate')).not.toBeNull();

    const failing = exportHost({ createController: () => new ExportController({ getDocument: () => makeSession([]).document, media, hasWebCodecs: () => true }) });
    document.body.innerHTML = '<div id="modal-root"></div>';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    void openExportModal(failing);
    await flush(2);
    button('Exportar').click();
    await flush(10);
    expect(document.querySelector('.export-error-title')!.textContent).toContain('Faltan medios');
    expect(document.body.textContent).toContain(EXPORT_ERROR_HINTS.NO_MEDIA);
    button('Volver a los ajustes').click();
    expect(document.querySelector('.export-estimate')).not.toBeNull();
  });

  it('downloads with delayed revoke and saves through the picker', async () => {
    const timers: [() => void, number][] = [];
    const url = downloadBlob(new Blob(['x']), 'a.mp4', (fn, ms) => timers.push([fn, ms]));
    expect(timers[0]![1]).toBe(DOWNLOAD_REVOKE_MS);
    expect(revoked).toEqual([]);
    timers[0]![0]();
    expect(revoked).toEqual([url]);

    expect(savePicker()).toBeNull();
    const written: Blob[] = [];
    const handle = { createWritable: async () => ({ write: async (b: Blob) => void written.push(b), close: async () => undefined }) };
    const picker = vi.fn(async (options: { types: { accept: Record<string, string[]> }[] }) => {
      expect(options.types[0]!.accept['video/mp4']).toEqual(['.mp4']);
      return handle;
    });
    const ok = await saveWithPicker(picker, new Blob(['v']), 'v.mp4', 'video/mp4');
    expect(picker).toHaveBeenCalledOnce();
    expect(ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(await saveWithPicker(async () => { throw new DOMException('no', 'AbortError'); }, new Blob(), 'v.mp4', 'video/mp4')).toBe(false);
  });
});

describe('shortcuts modal', () => {
  it('filters accent-insensitively and renders groups', () => {
    expect(filterShortcuts(SHORTCUT_GROUPS, 'exportacion').flatMap((g) => g.entries.map((e) => e.keys))).toContain('Ctrl+E');
    expect(filterShortcuts(SHORTCUT_GROUPS, 'zzz')).toEqual([]);
    expect(filterShortcuts(SHORTCUT_GROUPS, '').length).toBe(SHORTCUT_GROUPS.length);
    const dialog = openShortcutsModal();
    expect(dialog.element.querySelectorAll('section').length).toBe(SHORTCUT_GROUPS.length);
    const search = dialog.element.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'cuchilla';
    search.dispatchEvent(new Event('input'));
    expect(dialog.element.querySelectorAll('dd').length).toBe(1);
    search.value = 'nada-coincide';
    search.dispatchEvent(new Event('input'));
    expect(dialog.element.textContent).toContain('Ningún atajo');
    dialog.close();
  });
});

describe('storage manager', () => {
  function source(answers: boolean[]): StorageManagerSource & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      estimate: async () => ({ usage: 1024 * 1024, quota: 10 * 1024 * 1024 }),
      breakdown: async () => [{ id: 'media', label: 'Medios originales', bytes: 2048, count: 2 }],
      persisted: async () => false,
      requestPersist: async () => {
        calls.push('persist');
        return true;
      },
      clearProxies: async () => void calls.push('proxies'),
      clearWaveforms: async () => void calls.push('waveforms'),
      clearOrphans: async () => {
        calls.push('orphans');
        return 3;
      },
      clearAll: async () => void calls.push('all'),
      confirm: async () => answers.shift() ?? false,
      notify: (_k, title) => void calls.push(`notify:${title}`),
    };
  }

  it('needs both confirmations for data-losing actions', async () => {
    expect(await confirmSteps(source([true]), 'a', 'b', 'c')).toBe(true);
    expect(await confirmSteps(source([true, false]), 'a', 'b', 'c', { title: 'x', message: 'y', label: 'z' })).toBe(false);
    expect(await confirmSteps(source([false]), 'a', 'b', 'c', { title: 'x', message: 'y', label: 'z' })).toBe(false);
  });

  it('shows usage and runs actions after confirming', async () => {
    const src = source([true, true, true, false, true, true]);
    const dialog = openStorageManagerModal(src);
    await flush(5);
    expect(dialog.element.textContent).toContain('10 %');
    expect(dialog.element.querySelector('tbody')!.textContent).toContain('Medios originales');
    button('Borrar proxies').click();
    await flush(5);
    button('Borrar medios huérfanos').click();
    await flush(5);
    button('Borrar todo').click();
    await flush(5);
    expect(src.calls.filter((c) => !c.startsWith('notify'))).toEqual(['proxies', 'orphans']);
    button('Borrar formas de onda').click();
    await flush(5);
    button('Hacer persistente').click();
    await flush(5);
    expect(src.calls).toContain('waveforms');
    expect(src.calls).toContain('persist');
    dialog.close();
  });
});

describe('project package modal and services', () => {
  it('names packages safely and exports through the dialog', async () => {
    expect(packageFileName('a/b')).toBe('a_b.concatpkg.zip');
    expect(packageFileName('  ')).toBe('proyecto.concatpkg.zip');
    const session = makeSession([{ start: 0, duration: 1 }]);
    const notes: string[] = [];
    const dialog = openProjectPackageModal({
      getDocument: () => session.document,
      settings: () => session.documentSettings(),
      assets: { readMedia: async () => new Blob([new Uint8Array(4)]), readFont: async () => null, lutCube: () => null },
      install: async () => undefined,
      confirm: async () => true,
      notify: (_k, title) => void notes.push(title),
    });
    button('Exportar paquete').click();
    await flush(40);
    expect(created).toHaveLength(1);
    expect(notes).toContain('Paquete exportado');
    dialog.close();
  });

  it('wires the production services', async () => {
    const session = makeSession([]);
    const notes: string[] = [];
    const host: ProductionHost = {
      getDocument: () => session.document,
      documentSettings: () => session.documentSettings(),
      projectName: () => 'P',
      timelineSeconds: () => 0,
      clipCount: () => 0,
      markedRange: () => null,
      sequence: () => ({ width: 64, height: 36, fps: 30 }),
      media: new FakeMedia(),
      ffmpeg: () => null,
      assets: { readMedia: async () => null, readFont: async () => null, lutCube: () => null },
      installPackage: async () => undefined,
      storage: { estimate: async () => null, breakdown: async () => [], persisted: async () => false, requestPersist: async () => false, clearProxies: async () => undefined, clearWaveforms: async () => undefined, clearOrphans: async () => 0, clearAll: async () => undefined },
      install: new InstallPrompt(null),
      notify: (_k, title) => void notes.push(title),
      confirm: async () => true,
    };
    const services = createProductionServices(host);
    setProductionServices(services);
    expect(getProductionServices()).toBe(services);
    expect(services.canExport()).toBe(false);
    services.openExport();
    expect(notes).toContain('Nada que exportar');
    expect(services.canInstall()).toBe(false);
    services.install();
    services.openShortcuts();
    await flush(40);
    expect(document.querySelector('.shortcuts-modal')).not.toBeNull();
    services.openStorageManager();
    services.openProjectPackage();
    await flush(40);
    expect(document.querySelector('.storage-modal')).not.toBeNull();
    expect(document.querySelector('.package-modal')).not.toBeNull();
    expect(hasWebCodecsEncoder()).toBe(false);
  });

  it('decorates toasts with an action', () => {
    const stack = document.createElement('div');
    document.body.appendChild(stack);
    let ran = 0;
    const toast = actionToast(new Notifications(stack), { title: 'Nueva versión', actionLabel: 'Recargar', onAction: () => (ran += 1) });
    toast.querySelector<HTMLButtonElement>('.toast-action')!.click();
    expect(ran).toBe(1);
    expect(stack.contains(toast)).toBe(false);
  });
});
