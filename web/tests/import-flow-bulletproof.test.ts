// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/**
 * Import bulletproofing (Fase 7+).
 *
 * The bug reports this suite locks down: "arrastro el vídeo y no pasa nada",
 * "pulso Importar y no se abre nada" and "salta a la URL del archivo". The
 * guarantees under test:
 *
 * 1. Optimistic import — the library card exists synchronously (< 10 ms),
 *    before any probing, and is enriched in the background.
 * 2. Window-wide drop capture — a drop anywhere in the page reaches the
 *    importer exactly once and never navigates away.
 * 3. Strict probe timeout — a file whose metadata never answers still ends
 *    up in the library with the documented provisional values.
 * 4. The one global `<input type="file">`, attached to the document (a
 *    detached input does not reliably fire `change`).
 * 5. The service worker ignores `blob:` / `data:` / `file:` requests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MediaPool, placeholderThumbnail } from '../src/media/media-pool.ts';
import { MediaDecoder, METADATA_PROBE_TIMEOUT_MS, PROBE_FALLBACK, probeMediaMetadata } from '../src/media/decoder.ts';
import { mediaKindOf } from '../src/media/import/format-support.ts';
import { GLOBAL_DRAG_CLASS, installGlobalDrop, type GlobalDragTarget } from '../src/ui/global-drop.ts';
import {
  disposeGlobalFileInput,
  GLOBAL_FILE_INPUT_ID,
  installGlobalFileInput,
  openGlobalFilePicker,
} from '../src/ui/global-file-input.ts';
import { markDropHandled, type DragEventLike } from '../src/ui/timeline/file-drop.ts';

/** A file that looks like media (its bytes are never decoded in jsdom). */
function mediaFile(name = 'clip.mp4', type = 'video/mp4', size = 64): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1_700_000_000_000 });
}

/** A drag/drop event carrying `files` (jsdom has no `DataTransfer`). */
function dragEvent(type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', files: File[] = [], types: string[] = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types, dropEffect: '', items: files },
  });
  return event;
}

/** A target double that records listeners and can fire them (no DOM). */
function fakeTarget() {
  const listeners = new Map<string, ((event: DragEventLike) => void)[]>();
  const target: GlobalDragTarget = {
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
    },
  };
  const fire = (type: string, event: DragEventLike): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return { target, listeners, fire };
}

describe('importación optimista', () => {
  it('la tarjeta aparece antes de que la sonda termine (< 10 ms)', async () => {
    const pool = new MediaPool();
    const added: string[] = [];
    const updated: string[] = [];
    pool.onMediaAdded = (asset) => added.push(asset.id);
    pool.onMediaUpdated = (asset) => updated.push(asset.id);

    const started = performance.now();
    const result = pool.addFiles([mediaFile('rapido.mp4')]);
    const elapsed = performance.now() - started;

    // The synchronous half: nothing awaited, card already listed.
    expect(elapsed).toBeLessThan(10);
    expect(added).toHaveLength(1);
    const listed = pool.listMedia();
    expect(listed).toHaveLength(1);
    const shell = listed[0]!;
    expect(shell.name).toBe('rapido.mp4');
    expect(shell.type).toBe('video');
    expect(shell.fileSize).toBe(64);
    expect(shell.status).toBe('processing');
    expect(shell.duration.asNumber()).toBe(0);
    expect(shell.width).toBe(PROBE_FALLBACK.width);
    expect(shell.thumbnailUrl.startsWith('data:image/svg+xml')).toBe(true);
    expect(result.accepted.map((entry) => entry.asset.id)).toEqual([shell.id]);

    // The asynchronous half: same card, enriched, and the UI was told.
    await result.ready;
    const ready = pool.get(shell.id)!;
    expect(pool.listMedia()).toHaveLength(1);
    expect(ready.status).not.toBe('processing');
    expect(updated).toContain(shell.id);
    pool.destroy();
  });

  it('no acepta lo que no es medio y lo devuelve para avisar', async () => {
    const pool = new MediaPool();
    const result = pool.addFiles([
      mediaFile('setup.exe', 'application/octet-stream'),
      mediaFile('proyecto.zip', 'application/zip'),
      mediaFile('sin-extension', ''),
      mediaFile('ok.mov', ''),
    ]);
    expect(result.rejected.map((file) => file.name)).toEqual(['setup.exe', 'proyecto.zip', 'sin-extension']);
    expect(result.accepted.map((entry) => entry.asset.name)).toEqual(['ok.mov']);
    expect(pool.listMedia()).toHaveLength(1);
    await result.ready;
    pool.destroy();
  });

  it('addMedia devuelve el mismo id del drop y no lo importa dos veces', async () => {
    const pool = new MediaPool();
    const [entry] = pool.addFiles([mediaFile('unico.mp4')]).accepted;
    const id = entry!.asset.id;
    const asset = await pool.addMedia(entry!.file, id, 'unico.mp4');
    expect(asset.id).toBe(id);
    expect(pool.listMedia()).toHaveLength(1);
    pool.destroy();
  });
});

describe('sonda de metadatos con timeout estricto', () => {
  /**
   * Replaces the DOM bits the probe uses with an element that never answers
   * (`loadedmetadata` and `error` both stay silent, the classic hung MP4)
   * and restores everything afterwards.
   */
  function withSilentMediaElement<T>(
    run: (released: string[]) => Promise<T>,
    options: { throwsOnCreate?: boolean } = {},
  ): Promise<T> {
    const released: string[] = [];
    const originalCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
      createOptions?: ElementCreationOptions,
    ) => {
      if (tag !== 'video' && tag !== 'audio') return originalCreate(tag, createOptions);
      if (options.throwsOnCreate) throw new Error('documento sin elementos de medio');
      const element = {
        src: '',
        preload: '',
        duration: Number.NaN,
        videoWidth: 0,
        videoHeight: 0,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        removeAttribute: (name: string) => void released.push(name),
        load: () => undefined,
      };
      return element as unknown as HTMLElement;
    }) as typeof document.createElement);
    const createUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:silencioso', configurable: true });
    const revokeUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true });
    return run(released).finally(() => {
      createSpy.mockRestore();
      if (createUrl) Object.defineProperty(URL, 'createObjectURL', createUrl);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (revokeUrl) Object.defineProperty(URL, 'revokeObjectURL', revokeUrl);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    });
  }

  it('probeMediaMetadata responde con el fallback (10 s, 1920×1080) sin colgarse', async () => {
    await withSilentMediaElement(async (released) => {
      const started = Date.now();
      const info = await probeMediaMetadata(mediaFile('colgado.mp4'), { id: 'p1', type: 'video', timeoutMs: 40 });
      expect(Date.now() - started).toBeLessThan(500);
      expect(info.type).toBe('video');
      expect(info.duration.asNumber()).toBeCloseTo(PROBE_FALLBACK.durationSeconds, 5);
      expect(info.width).toBe(PROBE_FALLBACK.width);
      expect(info.height).toBe(PROBE_FALLBACK.height);
      // The element was released, so the hung load does not leak.
      expect(released).toContain('src');
    });
  });

  it('MediaDecoder.init() también resuelve, sin inventar metadatos', async () => {
    await withSilentMediaElement(async () => {
      const decoder = new MediaDecoder(mediaFile('colgado2.mp4'), 'd1', { probeTimeoutMs: 40 });
      const info = await decoder.init();
      // The decoder stays honest (provisional values are a library decision);
      // what matters is that it answered at all.
      expect(info.width).toBe(0);
      expect(info.duration.asNumber()).toBe(0);
      decoder.close();
    });
  });

  it('el medio sigue en la biblioteca con metadatos provisionales', async () => {
    const pool = new MediaPool({ probeTimeoutMs: 40 });
    const result = pool.addFiles([mediaFile('roto.mp4')]);
    const enriched = await result.ready;
    const id = result.accepted[0]!.asset.id;
    const asset = pool.get(id)!;
    expect(pool.listMedia().map((item) => item.id)).toEqual([id]);
    expect(enriched.map((item) => item.id)).toEqual([id]);
    expect(asset.status).toBe('error');
    expect(asset.statusMessage).toBeTruthy();
    expect(asset.duration.asNumber()).toBeCloseTo(PROBE_FALLBACK.durationSeconds, 5);
    expect(asset.width).toBe(PROBE_FALLBACK.width);
    expect(asset.thumbnailUrl.startsWith('data:image/svg+xml')).toBe(true);
    pool.destroy();
  });

  it('un documento que rechaza crear el elemento tampoco rompe el import', async () => {
    await withSilentMediaElement(
      async (released) => {
        const pool = new MediaPool({ probeTimeoutMs: 30 });
        const result = pool.addFiles([mediaFile('raro.mp4')]);
        const [asset] = await result.ready; // never rejects
        expect(asset!.status).toBe('error');
        expect(asset!.duration.asNumber()).toBeCloseTo(PROBE_FALLBACK.durationSeconds, 5);
        expect(asset!.width).toBe(PROBE_FALLBACK.width);
        expect(pool.listMedia()).toHaveLength(1);
        expect(released).toEqual([]); // nothing was built, so nothing to release
        pool.destroy();
      },
      { throwsOnCreate: true },
    );
  });

  it('el timeout por defecto es de dos segundos', () => {
    expect(METADATA_PROBE_TIMEOUT_MS).toBe(2000);
  });
});

describe('captura global de drag & drop', () => {
  it('un drop sobre el body llega al importador exactamente una vez', () => {
    const received: File[][] = [];
    const handle = installGlobalDrop({ onFiles: (files) => received.push(files) });
    try {
      const file = mediaFile('soltado.mp4');
      const event = dragEvent('drop', [file]);
      document.body.dispatchEvent(event);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual([file]);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it('ilumina la página mientras el arrastre trae archivos y la apaga al soltar', () => {
    const handle = installGlobalDrop({ onFiles: () => undefined });
    try {
      const over = dragEvent('dragover');
      document.body.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      expect(document.documentElement.classList.contains(GLOBAL_DRAG_CLASS)).toBe(true);

      const drop = dragEvent('drop', [mediaFile()]);
      document.body.dispatchEvent(drop);
      expect(document.documentElement.classList.contains(GLOBAL_DRAG_CLASS)).toBe(false);
    } finally {
      handle.dispose();
    }
  });

  it('ignora los drags internos y los drops que un panel ya consumió', () => {
    const received: File[][] = [];
    const handle = installGlobalDrop({ onFiles: (files) => received.push(files) });
    try {
      const internal = dragEvent('dragover', [], ['text/plain']);
      document.body.dispatchEvent(internal);
      expect(received).toHaveLength(0);
      expect(internal.defaultPrevented).toBe(true); // still: no navigation

      const consumed = dragEvent('drop', [mediaFile('del-timeline.mp4')]);
      markDropHandled(consumed as unknown as DragEventLike);
      document.body.dispatchEvent(consumed);
      expect(received).toHaveLength(0);
    } finally {
      handle.dispose();
    }
  });

  it('instala y retira los listeners en cada destino', () => {
    const first = fakeTarget();
    const second = fakeTarget();
    const received: DragEventLike[] = [];
    const handle = installGlobalDrop({
      targets: [first.target, second.target],
      classRoot: null,
      onFiles: (files, event) => received.push(event),
    });
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      expect(first.listeners.get(type)).toHaveLength(1);
    }
    first.fire('drop', {
      dataTransfer: { files: [mediaFile('uno.mp4')], types: ['Files'], dropEffect: '' },
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    expect(received).toHaveLength(1);
    handle.dispose();
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      expect(first.listeners.get(type)).toHaveLength(0);
      expect(second.listeners.get(type)).toHaveLength(0);
    }
  });
});

describe('input global de archivos', () => {
  it('vive en el documento, limpia su valor y dispara la importación', () => {
    const received: File[][] = [];
    const input = installGlobalFileInput({ onFiles: (files) => received.push(files) });
    try {
      expect(input.id).toBe(GLOBAL_FILE_INPUT_ID);
      expect(document.body.contains(input)).toBe(true);
      expect(input.multiple).toBe(true);
      expect(input.accept).toContain('video/*');
      expect(input.accept).toContain('.mov');
      expect(input.hidden).toBe(true);

      const file = mediaFile('elegido.mp4');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
      expect(received).toEqual([[file]]);
      // Clearing the value is what allows picking the same file again.
      expect(input.value).toBe('');

      Object.defineProperty(input, 'files', { value: [], configurable: true });
      input.dispatchEvent(new Event('change'));
      expect(received).toHaveLength(1);

      expect(openGlobalFilePicker()).toBe(true);
    } finally {
      disposeGlobalFileInput();
    }
    expect(document.getElementById(GLOBAL_FILE_INPUT_ID)).toBeNull();
    expect(openGlobalFilePicker()).toBe(false);
  });

  it('reutiliza el input ya instalado en lugar de duplicarlo', () => {
    const first = installGlobalFileInput({ onFiles: () => undefined });
    const second = installGlobalFileInput({ onFiles: () => undefined });
    try {
      expect(second).toBe(first);
      expect(document.querySelectorAll(`#${GLOBAL_FILE_INPUT_ID}`)).toHaveLength(1);
    } finally {
      disposeGlobalFileInput();
    }
  });
});

describe('clasificación de archivos y miniatura de reserva', () => {
  it('mediaKindOf mira el MIME primero y la extensión después', () => {
    expect(mediaKindOf('camara.mov')).toBe('video');
    expect(mediaKindOf('beats.mp3', '')).toBe('audio');
    expect(mediaKindOf('pantalla.webm', 'video/webm')).toBe('video');
    expect(mediaKindOf('cualquier.cosa', 'image/png')).toBe('image');
    expect(mediaKindOf('setup.exe')).toBeNull();
    expect(mediaKindOf('proyecto.zip', 'application/zip')).toBeNull();
    expect(mediaKindOf('subtitulos.srt')).toBeNull();
  });

  it('la miniatura de reserva es un SVG de datos con el nombre del archivo', () => {
    const url = placeholderThumbnail('video', 'mi clip.mp4');
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(url)).toContain('mi clip.mp4');
    expect(placeholderThumbnail('audio', 'voz.wav')).not.toBe(url);
    expect(placeholderThumbnail('image', 'foto.png').startsWith('data:image/svg+xml')).toBe(true);
  });
});

describe('el service worker ignora los esquemas locales', () => {
  // jsdom rewrites `import.meta.url` to an http URL, so resolve with __dirname.
  const sw = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');

  it('deja pasar blob:, data:, file: y chrome-extension:', () => {
    expect(sw).toContain("raw.startsWith('blob:')");
    expect(sw).toContain("raw.startsWith('data:')");
    expect(sw).toContain("raw.startsWith('file:')");
    expect(sw).toContain("raw.includes('chrome-extension:')");
    // The bypass comes before any cache work, and only http(s) reaches it.
    const fetchAt = sw.indexOf("addEventListener('fetch'");
    const guardAt = sw.indexOf("raw.startsWith('blob:')");
    const respondAt = sw.indexOf('event.respondWith(networkFirst(request))');
    expect(fetchAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(fetchAt);
    expect(respondAt).toBeGreaterThan(guardAt);
    expect(sw).toContain("url.protocol !== 'http:' && url.protocol !== 'https:'");
  });
});

// -- the wired app ---------------------------------------------------------

describe('la app entera captura el archivo', () => {
  let app: import('../src/main.ts').EditorApp | null = null;

  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const main = await import('../src/main.ts');
    app = main.app;
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it('monta el input global dentro del documento', () => {
    expect(document.getElementById(GLOBAL_FILE_INPUT_ID)).not.toBeNull();
    expect(document.getElementById(GLOBAL_FILE_INPUT_ID)?.getAttribute('type')).toBe('file');
  });

  it('un drop en cualquier parte crea la tarjeta al instante', () => {
    const event = dragEvent('drop', [mediaFile('directo.mp4')]);
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const assets = app!.pool.listMedia();
    expect(assets.some((asset) => asset.name === 'directo.mp4')).toBe(true);
    const cards = [...document.querySelectorAll('.media-card')];
    expect(cards.some((card) => (card.textContent ?? '').includes('directo.mp4'))).toBe(true);
  });

  it('avisa con un toast de lo que no es medio y no lo mete en la biblioteca', () => {
    const event = dragEvent('drop', [mediaFile('virus.exe', 'application/x-msdownload')]);
    document.body.dispatchEvent(event);
    const warnings = [...document.querySelectorAll('.toast-warning')].map((toast) => toast.textContent ?? '');
    expect(warnings.some((text) => text.includes("El archivo 'virus.exe' no es un medio de audio, video o imagen válido."))).toBe(true);
    expect(app!.pool.listMedia().some((asset) => asset.name === 'virus.exe')).toBe(false);
  });

  it('el botón del panel usa el input global (no uno suelto)', () => {
    const global = document.getElementById(GLOBAL_FILE_INPUT_ID);
    const spy = vi.spyOn(global as HTMLInputElement, 'click').mockImplementation(() => undefined);
    try {
      document.dispatchEvent(new CustomEvent('open-import'));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
