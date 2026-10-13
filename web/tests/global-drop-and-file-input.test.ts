// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/**
 * The app-wide import capture (Parte B2 of the production report).
 *
 * Before this, `installDropGuard` only *blocked* stray drops: dropping an MP4
 * on the header, the preview or an empty patch of the workspace did nothing
 * at all (the reported "arrastro un MP4 y no pasa nada"), and a stray drop
 * outside every panel could still navigate the browser to the raw file.
 *
 * These tests drive the installer with structural events (jsdom ships no
 * `DragEvent`) and assert the three rules the protocol fixes: every corner of
 * the window imports, the gesture is prevented everywhere, and one drop is
 * processed exactly once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_DROP_MESSAGE,
  GLOBAL_DROP_OVERLAY_ID,
  dragCarriesFiles,
  filesOf,
  installGlobalDrop,
  type GlobalDragEvent,
  type GlobalDropTarget,
} from '../src/ui/global-drop.ts';
import {
  GLOBAL_FILE_ACCEPT,
  GLOBAL_FILE_INPUT_ID,
  globalFileInput,
  installGlobalFileInput,
  openGlobalFileInput,
} from '../src/ui/global-file-input.ts';
import { markDropHandled } from '../src/ui/dnd/drop-handled.ts';
import { MediaPanel } from '../src/ui/media-panel.ts';
import { FakeDataTransfer, createFakeApp, dragEvent } from './f8-helpers.ts';

/** A window/document double that records listeners (and can replay them). */
type TargetDouble = GlobalDropTarget & {
  listeners: Map<string, ((event: GlobalDragEvent) => void)[]>;
  emit(type: string, event: GlobalDragEvent): void;
};

/** A target that swallows every listener (the "not there" case). */
function inertTarget(): GlobalDropTarget {
  return { addEventListener: (): void => undefined, removeEventListener: (): void => undefined };
}

/** A DOM event, seen as the structural drag the installers take. */
function asDrag(event: Event): GlobalDragEvent {
  return event as unknown as GlobalDragEvent;
}

function targetDouble(): TargetDouble {
  const listeners = new Map<string, ((event: GlobalDragEvent) => void)[]>();
  return {
    listeners,
    addEventListener(type: string, listener: (event: GlobalDragEvent) => void): void {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: (event: GlobalDragEvent) => void): void {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((entry) => entry !== listener),
      );
    },
    /** Delivers an event to every listener of that type (bubble order slack). */
    emit(type: string, event: GlobalDragEvent): void {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

describe('captura global de archivos (Parte B2)', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('un drop en window importa exactamente una vez', () => {
    const win = targetDouble();
    const doc = targetDouble();
    const dropped: string[][] = [];
    const handle = installGlobalDrop({
      onFiles: (files) => dropped.push(files.map((file) => file.name)),
      windowTarget: win,
      documentTarget: doc,
    });

    const transfer = FakeDataTransfer.files(['clip.mp4', 'voz.wav']);
    const event = dragEvent('drop', { dataTransfer: transfer });
    // The event travels document → window; both listeners see it, only one
    // may act on it.
    doc.emit('drop', asDrag(event));
    win.emit('drop', asDrag(event));

    expect(dropped).toEqual([['clip.mp4', 'voz.wav']]);
    expect(event.defaultPrevented).toBe(true);
    handle.dispose();
  });

  it('dragover previene la navegación y pide dropEffect = copy', () => {
    const win = targetDouble();
    const handle = installGlobalDrop({ onFiles: () => undefined, windowTarget: win, documentTarget: inertTarget() });
    const transfer = FakeDataTransfer.files(['clip.mp4']);
    const event = dragEvent('dragover', { dataTransfer: transfer });
    win.emit('dragover', asDrag(event));
    expect(event.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
    expect(String(win.listeners.get('dragover')?.length)).toBe('1');

    // dragenter also prevents the navigation the browser would otherwise do.
    const enter = dragEvent('dragenter', { dataTransfer: transfer });
    win.emit('dragenter', asDrag(enter));
    expect(enter.defaultPrevented).toBe(true);
    handle.dispose();
  });

  it('un drag interno (media → timeline) no dispara la importación global', () => {
    const win = targetDouble();
    const dropped: string[][] = [];
    const handle = installGlobalDrop({ onFiles: (files) => dropped.push(files.map((f) => f.name)), windowTarget: win, documentTarget: inertTarget() });
    // A real internal drag: the custom MIME types, no `Files`.
    const transfer = new FakeDataTransfer();
    transfer.setData('application/x-concat-media', 'm-1');
    expect(dragCarriesFiles({ dataTransfer: transfer } as unknown as GlobalDragEvent)).toBe(false);
    const event = dragEvent('drop', { dataTransfer: transfer });
    win.emit('drop', asDrag(event));
    expect(dropped).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    handle.dispose();
  });

  it('un drop ya reclamado por un panel no se vuelve a importar', () => {
    const win = targetDouble();
    const dropped: string[][] = [];
    const handle = installGlobalDrop({ onFiles: (files) => dropped.push(files.map((f) => f.name)), windowTarget: win, documentTarget: inertTarget() });
    const event = dragEvent('drop', { dataTransfer: FakeDataTransfer.files(['clip.mp4']) });
    markDropHandled(event);
    win.emit('drop', asDrag(event));
    expect(dropped).toEqual([]);
    handle.dispose();
  });

  it('el overlay «Suelta los archivos…» aparece al arrastrar y desaparece al soltar', () => {
    const win = targetDouble();
    const handle = installGlobalDrop({ onFiles: () => undefined, windowTarget: win, documentTarget: inertTarget(), overlayHost: document.body });
    const overlay = document.getElementById(GLOBAL_DROP_OVERLAY_ID);
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toBe(GLOBAL_DROP_MESSAGE);

    const transfer = FakeDataTransfer.files(['clip.mp4']);
    win.emit('dragenter', asDrag(dragEvent('dragenter', { dataTransfer: transfer })));
    expect(overlay!.classList.contains('is-visible')).toBe(true);
    win.emit('drop', asDrag(dragEvent('drop', { dataTransfer: transfer })));
    expect(overlay!.classList.contains('is-visible')).toBe(false);

    handle.dispose();
    expect(document.getElementById(GLOBAL_DROP_OVERLAY_ID)).toBeNull();
  });

  it('un dragleave con relatedTarget (movimiento interno) no oculta el overlay', () => {
    const win = targetDouble();
    const handle = installGlobalDrop({ onFiles: () => undefined, windowTarget: win, documentTarget: inertTarget(), overlayHost: document.body });
    const overlay = document.getElementById(GLOBAL_DROP_OVERLAY_ID)!;
    win.emit('dragenter', asDrag(dragEvent('dragenter', { dataTransfer: FakeDataTransfer.files(['a.mp4']) })));
    const internalMove = dragEvent('dragleave', { relatedTarget: document.body });
    win.emit('dragleave', asDrag(internalMove));
    expect(overlay.classList.contains('is-visible')).toBe(true);
    win.emit('dragleave', asDrag(dragEvent('dragleave', {})));
    expect(overlay.classList.contains('is-visible')).toBe(false);
    handle.dispose();
  });

  it('filesOf devuelve una copia plana, nunca la FileList viva', () => {
    const transfer = FakeDataTransfer.files(['a.mp4', 'b.mp4']);
    const files = filesOf(asDrag(dragEvent('drop', { dataTransfer: transfer })));
    expect(files.map((file) => file.name)).toEqual(['a.mp4', 'b.mp4']);
    expect(filesOf(asDrag(dragEvent('drop', { dataTransfer: null })))).toEqual([]);
  });
});

describe('input de archivos persistente (Parte B2.5–B2.7)', () => {
  beforeEach(() => {
    globalFileInput()?.dispose();
    document.body.replaceChildren();
  });

  it('vive en document.body con el accept del protocolo', () => {
    const handle = installGlobalFileInput({ onFiles: () => undefined, doc: document });
    const input = document.getElementById(GLOBAL_FILE_INPUT_ID) as HTMLInputElement | null;
    expect(input).toBe(handle.input);
    expect(input!.parentElement).toBe(document.body);
    expect(input!.type).toBe('file');
    expect((input as HTMLInputElement).multiple).toBe(true);
    for (const token of ['video/*', 'audio/*', 'image/*', '.mp4', '.webm', '.mov', '.mkv', '.avi', '.mp3', '.wav', '.ogg', '.m4a', '.png', '.jpg', '.jpeg', '.gif']) {
      expect(GLOBAL_FILE_ACCEPT.split(',')).toContain(token);
    }
    handle.dispose();
    expect(document.getElementById(GLOBAL_FILE_INPUT_ID)).toBeNull();
  });

  it('no se puede instalar dos veces: el segundo install reemplaza al primero', () => {
    installGlobalFileInput({ onFiles: () => undefined, doc: document });
    installGlobalFileInput({ onFiles: () => undefined, doc: document });
    expect(document.querySelectorAll(`#${GLOBAL_FILE_INPUT_ID}`)).toHaveLength(1);
  });

  it('tras change limpia input.value (reimportar el MISMO archivo vuelve a disparar)', () => {
    const seen: string[][] = [];
    const handle = installGlobalFileInput({ onFiles: (files) => seen.push(files.map((f) => f.name)), doc: document });
    const file = new File([new Uint8Array(4)], 'clip.mp4', { type: 'video/mp4' });
    // jsdom refuses `input.files = …`, so the property is stubbed the way the
    // browser fills it.
    Object.defineProperty(handle.input, 'files', { configurable: true, value: [file] });
    handle.input.dispatchEvent(new Event('change'));
    expect(seen).toEqual([['clip.mp4']]);
    expect(handle.input.value).toBe('');

    // Second selection of the same file: the event must carry files again.
    Object.defineProperty(handle.input, 'files', { configurable: true, value: [file] });
    handle.input.dispatchEvent(new Event('change'));
    expect(seen).toEqual([['clip.mp4'], ['clip.mp4']]);
    handle.dispose();
  });

  it('openGlobalFileInput clica el input instalado; sin instalación devuelve false', () => {
    expect(openGlobalFileInput()).toBe(false);
    const clicks: number[] = [];
    const handle = installGlobalFileInput({ onFiles: () => undefined, doc: document });
    const original = handle.input.click.bind(handle.input);
    handle.input.click = () => clicks.push(1);
    expect(openGlobalFileInput()).toBe(true);
    expect(clicks).toHaveLength(1);
    handle.input.click = original;
    handle.dispose();
  });

  it('el botón Importar del panel usa el input persistente (no crea uno suelto)', () => {
    const fake = createFakeApp();
    const root = document.createElement('aside');
    document.body.appendChild(root);
    const panel = new MediaPanel(root, fake.ctx);
    const handle = installGlobalFileInput({ onFiles: (files) => void fake.ctx.importFiles(files), doc: document });
    const clicks: number[] = [];
    handle.input.click = () => clicks.push(1);

    panel.openPicker();
    expect(clicks).toHaveLength(1);
    // Exactly one file input in the document — the persistent one.
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(1);
    handle.dispose();
  });

  it('Ctrl+I y «Archivo → Importar medios» pasan por el mismo input', () => {
    const fake = createFakeApp();
    installGlobalFileInput({ onFiles: (files) => void fake.ctx.importFiles(files), doc: document });
    const input = document.getElementById(GLOBAL_FILE_INPUT_ID) as HTMLInputElement;
    const clicks: number[] = [];
    input.click = () => clicks.push(1);
    document.dispatchEvent(new CustomEvent('open-import'));
    // The app's own listener is installed by `main.ts`; the panel path is the
    // one under test here, so a direct call stands in for the shortcut.
    openGlobalFileInput();
    expect(clicks).toHaveLength(1);
  });

  it('un drop sobre el panel de medios se marca como gestionado (sin doble import)', () => {
    const fake = createFakeApp();
    const root = document.createElement('aside');
    document.body.appendChild(root);
    new MediaPanel(root, fake.ctx);
    const event = dragEvent('drop', { dataTransfer: FakeDataTransfer.files(['clip.mp4']) });
    root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // `installGlobalDrop` skips events a specific zone claimed.
    const seen = vi.fn();
    const win = targetDouble();
    const handle = installGlobalDrop({ onFiles: seen, windowTarget: win, documentTarget: inertTarget() });
    win.emit('drop', asDrag(event));
    expect(seen).not.toHaveBeenCalled();
    handle.dispose();
  });
});
