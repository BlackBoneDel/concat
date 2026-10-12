// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 font registration: turns stored font bytes into a usable CSS family
 * with the CSS Font Loading API (`new FontFace(family, bytes)` →
 * `face.load()` → `document.fonts.add(face)`), once per font id.
 *
 * Bytes always come from the local {@link FontStore} (OPFS) — no URL is ever
 * given to `FontFace`, so no request can leave the browser.
 */

import type { CustomFont } from './advanced-text.ts';

/** The slice of a `FontFace` the loader uses. */
export interface FontFaceLike {
  readonly family: string;
  load(): Promise<FontFaceLike>;
}

/** The slice of `document.fonts`. */
export interface FontSetLike {
  add(face: FontFaceLike): unknown;
  delete(face: FontFaceLike): unknown;
}

/** Platform hooks (tests inject doubles). */
export interface FontLoaderEnv {
  createFace(family: string, data: ArrayBuffer): FontFaceLike;
  fonts: FontSetLike;
}

/** Where the bytes come from. */
export interface FontBytesSource {
  read(font: Pick<CustomFont, 'path'>): Promise<ArrayBuffer | null>;
}

/** The real browser environment, or `null` without the Font Loading API. */
export function browserFontEnv(): FontLoaderEnv | null {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !('fonts' in document)) return null;
  const fonts = document.fonts;
  return {
    createFace: (family, data) => new FontFace(family, data),
    fonts: {
      add: (face) => (face instanceof FontFace ? fonts.add(face) : undefined),
      delete: (face) => (face instanceof FontFace ? fonts.delete(face) : false),
    },
  };
}

/** Registers project fonts with the document. */
export class FontLoader {
  private readonly source: FontBytesSource;
  private readonly env: FontLoaderEnv | null;
  private readonly faces = new Map<string, FontFaceLike>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly failures = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  /**
   * @param source the font byte store.
   * @param env platform hooks (default: the browser's).
   */
  constructor(source: FontBytesSource, env: FontLoaderEnv | null = browserFontEnv()) {
    this.source = source;
    this.env = env;
  }

  /** Whether the Font Loading API is available. */
  get supported(): boolean {
    return this.env !== null;
  }

  /**
   * Loads a font once (concurrent calls share the work).
   * @param font the project entry.
   * @returns `true` when the family is usable.
   */
  ensure(font: CustomFont): Promise<boolean> {
    if (this.faces.has(font.id)) return Promise.resolve(true);
    const running = this.pending.get(font.id);
    if (running) return running;
    const job = this.load(font).finally(() => this.pending.delete(font.id));
    this.pending.set(font.id, job);
    return job;
  }

  /**
   * Loads every font of a project (failures are recorded, never thrown).
   * @param fonts the project's fonts.
   * @returns how many are usable.
   */
  async loadAll(fonts: readonly CustomFont[]): Promise<number> {
    const results = await Promise.all(fonts.map((font) => this.ensure(font)));
    return results.filter(Boolean).length;
  }

  /** Whether a font id is registered. */
  isLoaded(fontId: string): boolean {
    return this.faces.has(fontId);
  }

  /** Why a font failed to load, if it did. */
  failure(fontId: string): string | null {
    return this.failures.get(fontId) ?? null;
  }

  /**
   * Unregisters a font.
   * @param fontId the font.
   */
  unload(fontId: string): void {
    const face = this.faces.get(fontId);
    if (face) this.env?.fonts.delete(face);
    this.faces.delete(fontId);
  }

  /**
   * Subscribes to "a font became usable" (re-render titles).
   * @param listener callback.
   * @returns unsubscribe.
   */
  onLoad(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async load(font: CustomFont): Promise<boolean> {
    if (!this.env) {
      this.failures.set(font.id, 'Este navegador no admite la API de carga de fuentes');
      return false;
    }
    try {
      const data = await this.source.read(font);
      if (!data) throw new Error('El archivo de la fuente ya no está en el almacenamiento local');
      const face = await this.env.createFace(font.family, data).load();
      this.env.fonts.add(face);
      this.faces.set(font.id, face);
      this.failures.delete(font.id);
      for (const listener of this.listeners) listener();
      return true;
    } catch (error) {
      this.failures.set(font.id, error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}
