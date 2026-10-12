// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 titling edits: the base {@link TextStyle} of a text clip together
 * with its advanced style (`clip.extra.advanced_text`), and the project's
 * custom fonts (`doc.extra.fonts`).
 *
 * Inverses snapshot the previous JSON verbatim, so undo is exact — the same
 * contract as every operation in `editor/operations.ts`.
 */

import type { ProjectDocument, TextStyle } from '../model/document.ts';
import { defaultTextStyle } from '../model/document.ts';
import type { Json } from '../model/wire.ts';
import {
  ADVANCED_TEXT_KEY,
  FONTS_KEY,
  defaultAdvancedText,
  mergeAdvancedText,
  parseAdvancedText,
  parseFonts,
  serializeAdvancedText,
  type AdvancedTextPatch,
  type CustomFont,
} from '../render/advanced-text.ts';
import { cloneDocument, EditError, requireClip, type EditOperation } from './operations.ts';

/** Base-style fields a patch may change (content included). */
export type TextStylePatch = Partial<TextStyle>;

/** What {@link UpdateTextStylesOperation} changes. */
export interface TextStylesChange {
  /** Fields of the base `TextStyle`. */
  base?: TextStylePatch;
  /** Fields of `extra.advanced_text`; `null` removes the advanced style. */
  advanced?: AdvancedTextPatch | null;
}

/** Validates a base-style patch (numbers finite, ranges sane). */
function applyBasePatch(style: TextStyle, patch: TextStylePatch): TextStyle {
  const out: TextStyle = { ...style };
  const num = (value: number | undefined, lo: number, hi: number, current: number): number =>
    value === undefined ? current : Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : current;
  if (patch.content !== undefined) out.content = String(patch.content);
  if (patch.fontFamily !== undefined && patch.fontFamily.trim() !== '') out.fontFamily = patch.fontFamily;
  out.fontSize = num(patch.fontSize, 0.005, 1, out.fontSize);
  out.fontWeight = num(patch.fontWeight, 100, 900, out.fontWeight);
  if (patch.italic !== undefined) out.italic = patch.italic;
  if (patch.color !== undefined) out.color = patch.color;
  if (patch.align !== undefined) out.align = patch.align;
  out.opacity = num(patch.opacity, 0, 1, out.opacity);
  out.strokeWidth = num(patch.strokeWidth, 0, 0.1, out.strokeWidth);
  if (patch.strokeColor !== undefined) out.strokeColor = patch.strokeColor;
  if (patch.shadow !== undefined) out.shadow = patch.shadow;
  if (patch.background !== undefined) out.background = patch.background;
  out.backgroundRadius = num(patch.backgroundRadius, 0, 0.2, out.backgroundRadius);
  out.backgroundPaddingX = num(patch.backgroundPaddingX, 0, 0.3, out.backgroundPaddingX);
  out.backgroundPaddingY = num(patch.backgroundPaddingY, 0, 0.3, out.backgroundPaddingY);
  out.lineHeight = num(patch.lineHeight, 0.5, 4, out.lineHeight);
  out.tracking = num(patch.tracking, -0.05, 0.2, out.tracking);
  out.maxWidth = num(patch.maxWidth, 0, 1, out.maxWidth);
  out.maxHeight = num(patch.maxHeight, 0, 1, out.maxHeight);
  return out;
}

/** UpdateTextStyles(clipId, { base, advanced }). */
export class UpdateTextStylesOperation implements EditOperation {
  readonly name = 'UpdateTextStyles';
  readonly timestamp = Date.now();
  readonly clipId: string;
  readonly change: TextStylesChange;

  /**
   * @param clipId a text clip.
   * @param change the base/advanced fields to set.
   */
  constructor(clipId: string, change: TextStylesChange) {
    this.clipId = clipId;
    this.change = structuredClone(change);
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const clip = requireClip(doc, this.clipId);
    if (clip.kind !== 'text') throw new EditError('Solo los clips de texto tienen estilos de texto');
    const next = cloneDocument(doc);
    const target = requireClip(next, this.clipId);
    if (this.change.base) target.text = applyBasePatch(target.text ?? defaultTextStyle(), this.change.base);
    if (this.change.advanced === null) {
      const { [ADVANCED_TEXT_KEY]: _removed, ...rest } = target.extra;
      void _removed;
      target.extra = rest;
    } else if (this.change.advanced) {
      const current = parseAdvancedText(target.extra[ADVANCED_TEXT_KEY]) ?? defaultAdvancedText();
      target.extra = { ...target.extra, [ADVANCED_TEXT_KEY]: serializeAdvancedText(mergeAdvancedText(current, this.change.advanced)) };
    }
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const clip = requireClip(doc, this.clipId);
    const raw = clip.extra[ADVANCED_TEXT_KEY];
    return new RestoreTextOperation(this.clipId, clip.text ? { ...clip.text } : null, raw === undefined ? undefined : structuredClone(raw));
  }

  /** Typing/slider bursts on the same clip fuse into one step. */
  merge(next: EditOperation): EditOperation | null {
    if (!(next instanceof UpdateTextStylesOperation) || next.clipId !== this.clipId || next.timestamp - this.timestamp > 600) return null;
    const base = this.change.base || next.change.base ? { ...this.change.base, ...next.change.base } : undefined;
    let advanced: AdvancedTextPatch | null | undefined;
    if (next.change.advanced === null || (next.change.advanced === undefined && this.change.advanced === null)) advanced = null;
    else if (this.change.advanced || next.change.advanced) advanced = deepMerge(this.change.advanced ?? {}, next.change.advanced ?? {});
    const merged = new UpdateTextStylesOperation(this.clipId, { ...(base ? { base } : {}), ...(advanced !== undefined ? { advanced } : {}) });
    return merged;
  }

  describe(): string {
    return `Estilo de texto de ${this.clipId}`;
  }
}

function deepMerge(a: AdvancedTextPatch, b: AdvancedTextPatch): AdvancedTextPatch {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key];
    out[key] =
      typeof value === 'object' && value !== null && !Array.isArray(value) && typeof prev === 'object' && prev !== null && !Array.isArray(prev)
        ? { ...prev, ...value }
        : value;
  }
  const result: AdvancedTextPatch = {};
  Object.assign(result, out);
  return result;
}

/** Restores a text clip's base style and raw advanced JSON (inverse). */
export class RestoreTextOperation implements EditOperation {
  readonly name = 'RestoreText';
  readonly timestamp = Date.now();
  readonly clipId: string;
  private readonly text: TextStyle | null;
  private readonly raw: Json | undefined;

  constructor(clipId: string, text: TextStyle | null, raw: Json | undefined) {
    this.clipId = clipId;
    this.text = text;
    this.raw = raw;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    requireClip(doc, this.clipId);
    const next = cloneDocument(doc);
    const clip = requireClip(next, this.clipId);
    clip.text = this.text ? { ...this.text } : null;
    if (this.raw === undefined) {
      const { [ADVANCED_TEXT_KEY]: _removed, ...rest } = clip.extra;
      void _removed;
      clip.extra = rest;
    } else {
      clip.extra = { ...clip.extra, [ADVANCED_TEXT_KEY]: structuredClone(this.raw) };
    }
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const clip = requireClip(doc, this.clipId);
    const raw = clip.extra[ADVANCED_TEXT_KEY];
    return new RestoreTextOperation(this.clipId, clip.text ? { ...clip.text } : null, raw === undefined ? undefined : structuredClone(raw));
  }

  describe(): string {
    return `Restaurar texto de ${this.clipId}`;
  }
}

/**
 * The project's custom fonts.
 * @param doc the project.
 * @returns the font list.
 */
export function projectFonts(doc: ProjectDocument): CustomFont[] {
  return parseFonts(doc.extra[FONTS_KEY]);
}

function withFonts(doc: ProjectDocument, fonts: CustomFont[]): ProjectDocument {
  const next = cloneDocument(doc);
  if (fonts.length === 0) {
    const { [FONTS_KEY]: _removed, ...rest } = next.extra;
    void _removed;
    next.extra = rest;
  } else {
    next.extra = { ...next.extra, [FONTS_KEY]: fonts.map((font) => ({ ...font })) };
  }
  return next;
}

/** AddCustomFont(font): registers an OPFS font file with the project. */
export class AddCustomFontOperation implements EditOperation {
  readonly name = 'AddCustomFont';
  readonly timestamp = Date.now();
  readonly font: CustomFont;
  private readonly index: number | null;

  /**
   * @param font the stored font (bytes already in OPFS).
   * @param index list position (inverses restore the original order).
   */
  constructor(font: CustomFont, index: number | null = null) {
    this.font = { ...font };
    this.index = index;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    if (parseFonts([this.font]).length !== 1) throw new EditError('Fuente inválida');
    const fonts = projectFonts(doc);
    if (fonts.some((font) => font.id === this.font.id)) throw new EditError(`La fuente ${this.font.family} ya está en el proyecto`);
    const at = this.index === null ? fonts.length : Math.min(fonts.length, Math.max(0, this.index));
    fonts.splice(at, 0, this.font);
    return withFonts(doc, fonts);
  }

  inverse(): EditOperation {
    return new RemoveCustomFontOperation(this.font.id);
  }

  describe(): string {
    return `Añadir fuente ${this.font.family}`;
  }
}

/** Removes a font from the project (titles fall back to their base family). */
export class RemoveCustomFontOperation implements EditOperation {
  readonly name = 'RemoveCustomFont';
  readonly timestamp = Date.now();
  readonly fontId: string;

  constructor(fontId: string) {
    this.fontId = fontId;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const fonts = projectFonts(doc);
    if (!fonts.some((font) => font.id === this.fontId)) throw new EditError(`No existe la fuente ${this.fontId}`);
    return withFonts(doc, fonts.filter((font) => font.id !== this.fontId));
  }

  inverse(doc: ProjectDocument): EditOperation {
    const fonts = projectFonts(doc);
    const index = fonts.findIndex((item) => item.id === this.fontId);
    const font = fonts[index];
    if (!font) throw new EditError(`No existe la fuente ${this.fontId}`);
    return new AddCustomFontOperation(font, index);
  }

  describe(): string {
    return `Quitar fuente ${this.fontId}`;
  }
}
