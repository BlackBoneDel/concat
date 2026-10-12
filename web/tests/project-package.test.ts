// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 6: ZIP + SHA-256 primitives and the project package round trip. */

import { describe, expect, it } from 'vitest';
import { emptyClipEffects, EFFECTS_KEY, serializeClipEffects } from '../src/media/clip-effects.ts';
import { FONTS_KEY } from '../src/render/advanced-text.ts';
import { buildProjectPackage, PackageError, parseManifest, readProjectPackage, referencedLuts, safeSegment, type PackageAssetSource } from '../src/storage/project-package.ts';
import { checksumBlob, crc32, readZip, Sha256, ZipWriter } from '../src/storage/zip.ts';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import { ProjectStore } from '../src/storage/project-store.ts';
import { makeSession } from './f3-helpers.ts';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

describe('zip primitives', () => {
  it('computes CRC-32 and SHA-256 test vectors', async () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(text('6789'), crc32(text('12345')))).toBe(0xcbf43926);
    expect(new Sha256().hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(text('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const long = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(new Sha256().update(text(long)).hex()).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    const split = new Sha256().update(text(long.slice(0, 30))).update(text(long.slice(30)));
    expect(split.hex()).toBe(split.hex());
    expect(split.hex()).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(() => split.update(text('x'))).toThrow();
    const sums = await checksumBlob(new Blob([text('abc')]));
    expect(sums.sha256.startsWith('ba7816bf')).toBe(true);
    expect(sums.crc).toBe(crc32(text('abc')));
  });

  it('writes and reads a stored archive with UTF-8 names', async () => {
    const zip = new ZipWriter();
    await zip.add({ path: 'a.txt', data: new Blob(['hola']) });
    await zip.add({ path: 'carpeta/ñandú.bin', data: new Blob([new Uint8Array([1, 2, 3])]) });
    await expect(zip.add({ path: 'a.txt', data: new Blob(['x']) })).rejects.toThrow('duplicada');
    await expect(zip.add({ path: '../evil', data: new Blob(['x']) })).rejects.toThrow();
    await expect(zip.add({ path: '/abs', data: new Blob(['x']) })).rejects.toThrow();
    const blob = zip.finish();
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    expect([...head]).toEqual([0x50, 0x4b, 3, 4]);
    const entries = await readZip(blob);
    expect(entries.map((e) => e.path)).toEqual(['a.txt', 'carpeta/ñandú.bin']);
    expect(await entries[0]!.data.text()).toBe('hola');
    expect(entries[1]!.crc).toBe(crc32(new Uint8Array([1, 2, 3])));
    await expect(readZip(new Blob(['no es zip']))).rejects.toThrow('ZIP');
  });

  it('sanitizes path segments', () => {
    expect(safeSegment('a/b:c*?.mp4')).toBe('a_b_c__.mp4');
    expect(safeSegment('..')).toBe('_');
    expect(safeSegment('')).toBe('archivo');
  });
});

describe('project package', () => {
  function fixture() {
    const session = makeSession([{ start: 0, duration: 2 }, { start: 0, duration: 1, kind: 'audio', trackId: 'T3' }]);
    const doc = session.document;
    doc.extra[FONTS_KEY] = [{ id: 'f1', family: 'Mi Fuente', fileName: 'mi.woff2', path: '/fonts/f1.woff2', format: 'woff2' }];
    doc.timelines[0]!.clips[0]!.extra[EFFECTS_KEY] = serializeClipEffects({ ...emptyClipEffects(), lut: { id: 'file:look:abc', strength: 1 } }) ?? {};
    session.history.rebase(doc);
    const files = new Map<string, Blob>([
      ['m1', new Blob([new Uint8Array(5000).fill(7)])],
      ['mA', new Blob([new Uint8Array(300).fill(3)])],
    ]);
    const source: PackageAssetSource = {
      readMedia: async (id) => files.get(id) ?? null,
      readFont: async () => new Blob([new Uint8Array([0x77, 0x4f, 0x46, 0x32])]),
      lutCube: (id) => (id === 'file:look:abc' ? 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n' : null),
    };
    return { session, source, files };
  }

  it('finds referenced LUTs', () => {
    expect(referencedLuts(fixture().session.document)).toEqual(['file:look:abc']);
  });

  it('round-trips document, media, fonts and LUTs with verified checksums', async () => {
    const { session, source } = fixture();
    const progress: number[] = [];
    const built = await buildProjectPackage(session.document, session.documentSettings(), source, { onProgress: (ratio) => progress.push(ratio), now: new Date('2026-10-12T12:00:00Z') });
    expect(built.missing).toEqual(['m2.mp4']);
    expect(built.manifest.entries.map((e) => e.kind)).toEqual(['project', 'media', 'media', 'font', 'lut']);
    expect(built.manifest.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256))).toBe(true);
    expect(progress.at(-1)).toBe(1);

    const opened = await readProjectPackage(built.blob);
    expect(opened.problems).toEqual([]);
    expect(opened.name).toBe(session.documentSettings().name);
    expect(opened.document.timelines[0]!.clips.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(opened.document.media.map((m) => m.id)).toEqual(['m1', 'm2', 'mA']);
    expect(opened.media.get('m1')!.size).toBe(5000);
    expect(opened.media.get('m1')!.name).toBe('m1.mp4');
    expect(opened.fonts.get('/fonts/f1.woff2')!.size).toBe(4);
    expect(opened.document.extra[FONTS_KEY]).toEqual(session.document.extra[FONTS_KEY]);
    expect(opened.luts.get('file:look:abc')).toContain('LUT_3D_SIZE 2');
    expect(opened.manifest.createdAt).toBe('2026-10-12T12:00:00.000Z');
  });

  it('can skip media', async () => {
    const { session, source } = fixture();
    const built = await buildProjectPackage(session.document, session.documentSettings(), source, { includeMedia: false });
    expect(built.manifest.includesMedia).toBe(false);
    const opened = await readProjectPackage(built.blob);
    expect(opened.media.size).toBe(0);
  });

  it('detects corruption and rejects foreign archives', async () => {
    const { session, source } = fixture();
    const built = await buildProjectPackage(session.document, session.documentSettings(), source);
    const bytes = new Uint8Array(await built.blob.arrayBuffer());
    // Flip one byte of the first media payload (5000 × 0x07).
    const at = bytes.findIndex((value, index) => value === 7 && bytes[index + 1] === 7 && bytes[index + 2] === 7);
    bytes[at + 10] = 8;
    const opened = await readProjectPackage(new Blob([bytes]));
    expect(opened.problems.some((p) => p.includes('Checksum') && p.includes('media/'))).toBe(true);
    expect(opened.media.has('m1')).toBe(false);

    const foreign = new ZipWriter();
    await foreign.add({ path: 'manifest.json', data: new Blob(['{"format":"otro"}']) });
    await expect(readProjectPackage(foreign.finish())).rejects.toBeInstanceOf(PackageError);
    const empty = new ZipWriter();
    await empty.add({ path: 'x.txt', data: new Blob(['x']) });
    await expect(readProjectPackage(empty.finish())).rejects.toThrow('manifest');
    await expect(readProjectPackage(new Blob(['basura']))).rejects.toBeInstanceOf(PackageError);
    expect(() => parseManifest({ format: 'concat-project-package', version: 99 })).toThrow(PackageError);
    expect(parseManifest({ format: 'concat-project-package', version: 1, entries: [{ path: 1 }, null] }).entries).toEqual([]);
  });

  it('cancels', async () => {
    const { session, source } = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(buildProjectPackage(session.document, session.documentSettings(), source, { signal: abort.signal })).rejects.toBeInstanceOf(PackageError);
  });
});

describe('font persistence hook', () => {
  it('keeps custom fonts across ProjectStore save/load', async () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const fonts = [{ id: 'f9', family: 'Otra', fileName: 'o.ttf', path: '/fonts/f9.ttf', format: 'truetype' }];
    session.document.extra[FONTS_KEY] = fonts;
    const store = new ProjectStore(new MemoryKeyValue());
    const record = await store.saveProject(session.document, session.documentSettings());
    expect(session.document.extra['customFonts']).toBeUndefined();
    const loaded = await store.loadProject(record.id);
    expect(loaded!.document.extra[FONTS_KEY]).toEqual(fonts);
    expect(loaded!.document.extra['customFonts']).toBeUndefined();
  });
});
