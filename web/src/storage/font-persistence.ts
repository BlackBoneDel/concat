// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: keeps the Fase 5 custom-font list across `toDocument`/
 * `fromDocument`. The fonts live in `doc.extra.fonts`, but `fonts` is a
 * writer-owned top-level key of `concat.json` (`doc::WRITER_OWNED`), so the
 * writer drops it. They travel instead under `extra.customFonts`, which the
 * wire format preserves like any unknown key, and are put back on load.
 */

import type { ProjectDocument } from '../model/document.ts';
import { FONTS_KEY } from '../render/advanced-text.ts';
import type { Json } from '../model/wire.ts';

/** The preserved key. */
export const PERSISTED_FONTS_KEY = 'customFonts';

/**
 * A shallow copy whose `extra` carries the font list under the preserved key.
 * @param document the live document (not mutated).
 * @returns the document to hand to `toDocument`.
 */
export function withPersistableFonts(document: ProjectDocument): ProjectDocument {
  const fonts: Json | undefined = document.extra[FONTS_KEY];
  if (!Array.isArray(fonts) || fonts.length === 0) return document;
  return { ...document, extra: { ...document.extra, [PERSISTED_FONTS_KEY]: fonts } };
}

/**
 * Moves a preserved font list back to `extra.fonts` (in place).
 * @param document a document from `fromDocument`.
 * @returns the same document.
 */
export function restorePersistedFonts(document: ProjectDocument): ProjectDocument {
  const stored: Json | undefined = document.extra[PERSISTED_FONTS_KEY];
  if (stored === undefined) return document;
  const { [PERSISTED_FONTS_KEY]: _moved, ...rest } = document.extra;
  void _moved;
  document.extra = Array.isArray(stored) && rest[FONTS_KEY] === undefined ? { ...rest, [FONTS_KEY]: stored } : rest;
  return document;
}
