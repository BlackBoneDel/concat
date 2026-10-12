// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 custom font files: bytes in OPFS under `/fonts/<uuid>.<ext>`
 * (in-memory when OPFS is unavailable), described in the project by a
 * {@link CustomFont} entry (`doc.extra.fonts`, added by `AddCustomFontOperation`).
 *
 * Nothing leaves the browser: fonts are never fetched, only read from the
 * user's own files. The container is validated by its magic bytes — a file
 * named `.ttf` that is not a font is refused.
 */

import { detectFontFormat, familyFromFileName, type CustomFont, type FontFormat } from '../render/advanced-text.ts';

/** OPFS directory of font files. */
export const FONTS_DIR = 'fonts';
/** Largest font file accepted. */
export const MAX_FONT_BYTES = 20 * 1024 * 1024;

const EXTENSION: Readonly<Record<FontFormat, string>> = Object.freeze({ truetype: 'ttf', opentype: 'otf', woff: 'woff', woff2: 'woff2' });

/** Where font bytes go. */
export interface FontFileBackend {
  write(name: string, blob: Blob): Promise<void>;
  read(name: string): Promise<Blob | null>;
  delete(name: string): Promise<void>;
}

/** In-memory font files (tests, private windows). */
export class MemoryFontFiles implements FontFileBackend {
  private readonly files = new Map<string, Blob>();

  async write(name: string, blob: Blob): Promise<void> {
    this.files.set(name, blob);
  }

  async read(name: string): Promise<Blob | null> {
    return this.files.get(name) ?? null;
  }

  async delete(name: string): Promise<void> {
    this.files.delete(name);
  }

  /** Stored file count. */
  get size(): number {
    return this.files.size;
  }
}

/** OPFS `/fonts/` with an in-memory fallback. */
export class OpfsFontFiles implements FontFileBackend {
  private root: FileSystemDirectoryHandle | null = null;
  private checked = false;
  private readonly memory = new MemoryFontFiles();

  async write(name: string, blob: Blob): Promise<void> {
    const dir = await this.directory();
    if (!dir) return this.memory.write(name, blob);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }
  }

  async read(name: string): Promise<Blob | null> {
    const dir = await this.directory();
    if (!dir) return this.memory.read(name);
    try {
      return await (await dir.getFileHandle(name)).getFile();
    } catch {
      return null;
    }
  }

  async delete(name: string): Promise<void> {
    const dir = await this.directory();
    if (!dir) return this.memory.delete(name);
    try {
      await dir.removeEntry(name);
    } catch {
      // Already gone.
    }
  }

  private async directory(): Promise<FileSystemDirectoryHandle | null> {
    if (this.checked) return this.root;
    this.checked = true;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
        this.root = await (await navigator.storage.getDirectory()).getDirectoryHandle(FONTS_DIR, { create: true });
      }
    } catch {
      this.root = null;
    }
    return this.root;
  }
}

/** The file name part of `/fonts/<name>`. */
export function fontFileName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Validation failure of a font file. */
export class FontFileError extends Error {
  override readonly name = 'FontFileError';
}

/** Adds, reads and deletes font files. */
export class FontStore {
  private readonly files: FontFileBackend;
  private readonly makeId: () => string;

  /**
   * @param files byte backend (OPFS in the app).
   * @param makeId id factory (defaults to `crypto.randomUUID`).
   */
  constructor(files: FontFileBackend = new OpfsFontFiles(), makeId: () => string = () => crypto.randomUUID()) {
    this.files = files;
    this.makeId = makeId;
  }

  /**
   * Validates and stores a font file.
   * @param file a `.ttf`/`.otf`/`.woff`/`.woff2` file.
   * @returns the project entry to add with `AddCustomFontOperation`.
   * @throws FontFileError for empty, oversized or non-font files.
   */
  async add(file: Blob & { name: string }): Promise<CustomFont> {
    if (file.size === 0) throw new FontFileError(`${file.name}: archivo vacío`);
    if (file.size > MAX_FONT_BYTES) throw new FontFileError(`${file.name}: supera ${MAX_FONT_BYTES / 1024 / 1024} MB`);
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const format = detectFontFormat(head, file.name);
    if (!format) throw new FontFileError(`${file.name}: no es una fuente TrueType/OpenType/WOFF/WOFF2`);
    const id = this.makeId();
    const name = `${id}.${EXTENSION[format]}`;
    await this.files.write(name, file);
    return { id, family: familyFromFileName(file.name, id), fileName: file.name, path: `/${FONTS_DIR}/${name}`, format };
  }

  /**
   * The bytes of a stored font.
   * @param font the project entry.
   * @returns the bytes, or `null` when the file is gone.
   */
  async read(font: Pick<CustomFont, 'path'>): Promise<ArrayBuffer | null> {
    const blob = await this.files.read(fontFileName(font.path));
    return blob ? blob.arrayBuffer() : null;
  }

  /**
   * Deletes a font file.
   * @param font the project entry.
   */
  async delete(font: Pick<CustomFont, 'path'>): Promise<void> {
    await this.files.delete(fontFileName(font.path));
  }
}
