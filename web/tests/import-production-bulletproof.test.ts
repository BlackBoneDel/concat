// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/**
 * Regression suite for the production import bugs (GitHub Pages, build under
 * `/concat/`):
 *
 * - a dropped MP4/WebM/MP3 that "did nothing" — the card only appeared after
 *   the whole probe finished, or never;
 * - an empty file or a `.exe` that created a phantom asset with `0.0s · 0×0`;
 * - an import that hung forever because a metadata probe never answered;
 * - a `currentTime = NaN` that threw and killed the thumbnail.
 *
 * These tests fail against the previous implementation: there the pool only
 * published an asset after `await decoder.init()` and after the thumbnail
 * decode, so `onMediaAdded` did not exist, an empty file was imported as a
 * 0-second video and the probe had no deadline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import {
  LARGE_FILE_BYTES,
  METADATA_TIMEOUT_MS,
  MediaDecoder,
  clampSeekTime,
  finiteDuration,
  readFileBytes,
  seekElement,
} from '../src/media/decoder.ts';
import { MediaImportError, MediaPool, PROBE_TIMEOUT_MS, planImport } from '../src/media/media-pool.ts';
import { MemoryThumbnailStore, placeholderThumbnail } from '../src/media/thumbnail.ts';

/** A tiny file with the given name/size/type. */
function fileOf(name: string, type = 'video/webm', bytes = 64): File {
  return new File([new Uint8Array(bytes)], name, { type, lastModified: 1_700_000_000_000 });
}

/** The pool with a fresh in-memory thumbnail cache. */
function makePool(): MediaPool {
  return new MediaPool({ thumbnailStore: new MemoryThumbnailStore() });
}

describe('importación a prueba de balas (Parte B del informe de producción)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('la tarjeta optimista se emite de forma SÍNCRONA, antes de cualquier await', async () => {
    const pool = makePool();
    const seen: string[] = [];
    pool.setImportListeners({
      onMediaAdded: (asset) => seen.push(`${asset.status}:${asset.type}`),
    });

    let called = false;
    const promise = pool.addMedia(fileOf('clip.webm'), 'm1', 'clip.webm').then(() => {
      called = true;
    });
    // No `await` between: the listener must already have run.
    expect(seen).toEqual(['processing:video']);
    expect(called).toBe(false);

    const assets = pool.listMedia();
    expect(assets).toHaveLength(1);
    expect(assets[0]!.status).toBe('processing');
    expect(assets[0]!.duration.isZero()).toBe(true);
    // A face from the first millisecond: an inline SVG placeholder carrying
    // the file's name, never an empty `src`.
    expect(assets[0]!.thumbnailUrl.startsWith('data:image/svg+xml')).toBe(true);
    const svg = decodeURIComponent(assets[0]!.thumbnailUrl);
    expect(svg).toContain('clip');
    expect(svg).toContain('.webm');

    await promise;
  });

  it('el archivo vacío se rechaza con un error tipado y sin crear asset', async () => {
    const pool = makePool();
    const empty = new File([], 'vacio.mp4', { type: 'video/mp4' });
    await expect(pool.addMedia(empty, 'm2', 'vacio.mp4')).rejects.toBeInstanceOf(MediaImportError);
    await expect(pool.addMedia(empty, 'm3', 'vacio.mp4')).rejects.toMatchObject({ code: 'empty', fileName: 'vacio.mp4' });
    expect(pool.listMedia()).toHaveLength(0);
    expect(pool.get('m2')).toBeUndefined();
  });

  it('un archivo que no es medio (exe/zip/pdf) se rechaza y no deja asset fantasma', async () => {
    const pool = makePool();
    for (const [name, type] of [
      ['evil.exe', 'application/octet-stream'],
      ['backup.zip', 'application/zip'],
      ['contrato.pdf', 'application/pdf'],
      ['sin-extension', ''],
    ] as const) {
      const file = new File([new Uint8Array([0x4d, 0x5a])], name, { type });
      await expect(pool.addMedia(file, `x-${name}`, name)).rejects.toMatchObject({ code: 'unsupported' });
    }
    expect(pool.listMedia()).toHaveLength(0);
  });

  it('la clasificación previa (MIME/extensión) cubre los formatos del protocolo', () => {
    expect(planImport({ name: 'a.MP4', size: 10, type: '' })).toEqual({ ok: true, kind: 'video' });
    expect(planImport({ name: 'a.mov', size: 10, type: '' })).toEqual({ ok: true, kind: 'video' });
    expect(planImport({ name: 'a.mkv', size: 10, type: '' })).toEqual({ ok: true, kind: 'video' });
    expect(planImport({ name: 'a.webm', size: 10, type: '' })).toEqual({ ok: true, kind: 'video' });
    expect(planImport({ name: 'voz.mp3', size: 10, type: '' })).toEqual({ ok: true, kind: 'audio' });
    expect(planImport({ name: 'voz.wav', size: 10, type: '' })).toEqual({ ok: true, kind: 'audio' });
    expect(planImport({ name: 'sin.nombre', size: 10, type: 'video/mp4' })).toEqual({ ok: true, kind: 'video' });
    expect(planImport({ name: 'foto.png', size: 10, type: '' })).toEqual({ ok: true, kind: 'image' });
    expect(planImport({ name: 'x.exe', size: 10, type: '' })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(planImport({ name: 'x.mp4', size: 0, type: 'video/mp4' })).toMatchObject({ ok: false, code: 'empty' });
  });

  it('una sonda que no responde se corta sola y deja el asset USABLE (no cuelga)', async () => {
    vi.useFakeTimers();
    const pool = makePool();
    let settled = 0;
    pool.setImportListeners({
      onMediaUpdated: (asset) => {
        settled += 1;
        expect(asset.status === 'ready' || asset.status === 'error').toBe(true);
      },
    });
    // A WebM in jsdom: `detectContainer` reads the bytes but no element ever
    // fires `loadedmetadata`, which is exactly the reported hang.
    const promise = pool.addMedia(fileOf('colgado.webm', 'video/webm', 4096), 'm4', 'colgado.webm');
    await vi.advanceTimersByTimeAsync(Math.max(PROBE_TIMEOUT_MS, METADATA_TIMEOUT_MS) + 100);
    const asset = await promise;
    expect(settled).toBe(1);
    expect(pool.listMedia()).toHaveLength(1);
    expect(asset.id).toBe('m4');
    // The card stays, with the fallback metadata the bundle could get.
    expect(['ready', 'error']).toContain(asset.status);
    await pool.whenReady('m4');
  });

  it('cuando la miniatura no se puede generar queda el placeholder con el motivo', async () => {
    const pool = makePool();
    // A real PNG signature: the container probe must classify it as an image
    // (jsdom then cannot decode it, which is the point of the test).
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    const asset = await pool.addMedia(new File([png], 'foto.png', { type: 'image/png' }), 'm5', 'foto.png');
    // jsdom cannot decode any image (no canvas/ImageBitmap): the fallback art
    // must be a placeholder, and the asset must survive.
    expect(pool.get('m5')).toBeDefined();
    expect(asset.thumbnailUrl.startsWith('data:image/svg+xml')).toBe(true);
    expect(asset.status).toBe('ready');
    expect(asset.statusMessage).toBe('Miniatura no disponible');
  });

  it('nunca se asigna un currentTime no finito (la causa del cuelgue de miniaturas)', () => {
    // The old clamp `Math.min(Math.max(0, t), duration - 0.001)` turned a NaN
    // duration into a NaN seek target, which throws in every engine.
    expect(Number.isFinite(clampSeekTime(NaN, 10))).toBe(true);
    expect(Number.isFinite(clampSeekTime(5, NaN))).toBe(true);
    expect(Number.isFinite(clampSeekTime(5, Infinity))).toBe(true);
    expect(Number.isFinite(clampSeekTime(Infinity, Infinity))).toBe(true);
    expect(clampSeekTime(Infinity, Infinity)).toBe(0);
    expect(clampSeekTime(NaN, NaN)).toBe(0);
    expect(clampSeekTime(-4, 10)).toBe(0);
    expect(clampSeekTime(50, 10)).toBeCloseTo(9.999, 3);
    expect(clampSeekTime(3, Number.MAX_VALUE)).toBe(3);
    // The duration the probe may believe in is always finite or zero.
    expect(finiteDuration(NaN)).toBe(0);
    expect(finiteDuration(Infinity)).toBe(0);
    expect(finiteDuration(-1)).toBe(0);
    expect(finiteDuration(2.5)).toBe(2.5);
  });

  it('el placeholder SVG es un data: URL con el nombre y la extensión', () => {
    const url = placeholderThumbnail('Vacaciones & playa.mp4', 'video', 'Procesando…');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const svg = decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length));
    expect(svg).toContain('Vacaciones &amp; playa');
    expect(svg).toContain('.mp4');
    expect(svg).toContain('VIDEO');
    expect(svg).toContain('Procesando…');
    // Without a note the extension is what the second line shows.
    expect(decodeURIComponent(placeholderThumbnail('corto.mp4', 'video'))).toContain('.mp4');
    expect(svg).toContain('width="160" height="90"');
  });

  it('el decoder libera sus URLs de objeto (sonda y elemento) al cerrar', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    let counter = 0;
    // jsdom ships no blob-URL implementation at all, so the double is
    // installed on the class itself (`vi.spyOn` needs the method to exist).
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (): string => {
        counter += 1;
        const url = `blob:http://localhost/mock-${counter}`;
        created.push(url);
        return url;
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: (url: string): void => {
        revoked.push(String(url));
      },
    });
    try {
      // The probe's own deadline is what settles it: no element in jsdom ever
      // fires `loadedmetadata`, so the module's timeout is the only way out —
      // the path that used to leave the blob URL (and the loader) alive.
      vi.useFakeTimers();
      const decoder = new MediaDecoder(fileOf('clip.webm'), 'd1');
      const init = decoder.init();
      await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS + 100);
      const info = await init;
      // The abandoned probe settles after the deadline — jsdom reports no
      // duration at all, so the reveal-duration step runs too — and releases
      // its element and URL; nothing it created may survive it.
      await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS * 2 + 500);
      vi.useRealTimers();
      expect(created.length).toBeGreaterThan(0);
      expect([...revoked].sort()).toEqual([...created].sort());
      expect(info.fileSize).toBe(64);
      decoder.close();
      expect([...revoked].sort()).toEqual([...created].sort());
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('seekElement nunca escribe un currentTime no finito (el throw que mataba la miniatura)', async () => {
    // A stand-in element: jsdom's <video> has no layout and its `currentTime`
    // setter refuses anything before metadata, which is exactly the state the
    // guard exists for. The stand-in records whatever is assigned.
    const assigned: number[] = [];
    const listeners = new Map<string, () => void>();
    const element = {
      duration: Number.NaN,
      get currentTime(): number {
        return assigned.at(-1) ?? 0;
      },
      set currentTime(value: number) {
        // A real engine throws on NaN: emulate it, so an unguarded write
        // fails loudly instead of being recorded quietly.
        if (!Number.isFinite(value)) throw new TypeError('currentTime: NaN');
        assigned.push(value);
      },
      addEventListener(type: string, listener: () => void): void {
        listeners.set(type, listener);
      },
      removeEventListener(type: string): void {
        listeners.delete(type);
      },
    } as unknown as HTMLVideoElement;

    // 1. A NaN duration (OBS WebM) must not become a NaN seek target.
    const first = seekElement(element, Number.NaN);
    expect(assigned).toEqual([0]);
    listeners.get('seeked')?.();
    await first;

    // 2. A negative instants maps to 0; a real one is honoured as given.
    await seekElement(element, -5);
    expect(assigned).toEqual([0, 0]);
    const seeked = seekElement(element, 1.25);
    listeners.get('seeked')?.();
    await seeked;
    expect(assigned.at(-1)).toBe(1.25);
  });

  it('un archivo de más de 768 MB se lee por trozos (una asignación huge puede fallar)', async () => {
    // A blob double: 800 MB declared, sliced in 64 MiB pieces, each slice a
    // few bytes. The real file never exists — what is asserted is the *shape*
    // of the read: no single `arrayBuffer()` of the whole thing.
    const size = LARGE_FILE_BYTES + 32 * 1024 * 1024;
    const slices: { start: number; end: number }[] = [];
    let wholeReads = 0;
    const big = {
      size,
      async arrayBuffer(): Promise<ArrayBuffer> {
        wholeReads += 1;
        throw new Error('asignación enorme');
      },
      slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } {
        slices.push({ start, end });
        return { arrayBuffer: async (): Promise<ArrayBuffer> => new Uint8Array(end - start > 8 ? 8 : end - start).buffer };
      },
    } as unknown as Blob;

    const bytes = await readFileBytes(big);
    expect(wholeReads).toBe(0);
    expect(bytes.byteLength).toBe(size);
    expect(slices.length).toBe(Math.ceil(size / (64 * 1024 * 1024)));
    expect(slices[0]!.start).toBe(0);
    expect(slices.at(-1)!.end).toBe(size);
    // Small files keep the single read: chunking is a limit guard, not a tax.
    await readFileBytes(new Blob([new Uint8Array(16)]));
  });

  it('removeMedia cierra el decoder y deja la biblioteca consistente', async () => {
    const pool = makePool();
    await pool.addMedia(fileOf('temporal.webm'), 'm7', 'temporal.webm');
    await pool.whenReady('m7');
    expect(pool.getDecoder('m7')).not.toBeNull();
    pool.removeMedia('m7');
    expect(pool.getDecoder('m7')).toBeNull();
    expect(pool.listMedia()).toHaveLength(0);
    expect(pool.get('m7')).toBeUndefined();
  });

  it('un audio importado resume su detalle sin «0×0» y con la duración del fallback', async () => {
    const pool = makePool();
    const asset = await pool.addMedia(fileOf('voz.mp3', 'audio/mpeg', 128), 'm8', 'voz.mp3');
    expect(asset.type).toBe('audio');
    // Audio has no picture: no thumbnail URL at all (the card draws a glyph).
    expect(asset.thumbnailUrl).toBe('');
    expect(asset.duration.compare(Rational.ZERO) >= 0).toBe(true);
  });
});
