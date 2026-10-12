// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 8: titles for the toolbar's Text button. A text clip is a
 * {@link DocumentClip} of kind `text` carrying a {@link TextStyle}; it lives
 * on a video lane (titles are composited over the picture) and is inserted
 * through {@link InsertClipOperation}, so it undoes like any other edit.
 */

import { Rational } from '../../core/rational.ts';
import { InsertClipOperation, newId, type EditOperation } from '../../editor/operations.ts';
import { blankClip, defaultTextStyle, type DocumentClip } from '../../model/document.ts';

/** How long a freshly added title lasts, in seconds. */
export const DEFAULT_TEXT_DURATION = 3;

/** The copy of a brand-new title. */
export const DEFAULT_TEXT_CONTENT = 'Tu texto aquí';

/** Options of {@link buildTextClip}. */
export interface TextClipOptions {
  /** The lane it lands on. */
  trackId: string;
  /** Where it starts, in timeline seconds. */
  startSeconds: number;
  /** How long it lasts, in seconds ({@link DEFAULT_TEXT_DURATION}). */
  durationSeconds?: number;
  /** The copy shown on screen. */
  content?: string;
  /** The clip name (the copy, trimmed to 40 characters). */
  name?: string;
  /** A fixed clip id (tests); a fresh one otherwise. */
  id?: string;
}

/**
 * Builds a ready-to-insert title clip.
 * @param options lane, start, duration, copy.
 * @returns the clip.
 */
export function buildTextClip(options: TextClipOptions): DocumentClip {
  const content = options.content ?? DEFAULT_TEXT_CONTENT;
  const duration = Math.max(0.1, options.durationSeconds ?? DEFAULT_TEXT_DURATION);
  const name = options.name ?? content.slice(0, 40);
  const clip = blankClip(options.id ?? newId('c-'), options.trackId, 'text', name, options.startSeconds, duration);
  clip.text = { ...defaultTextStyle(), content };
  return clip;
}

/**
 * The undoable insert for a title clip.
 * @param clip the clip from {@link buildTextClip}.
 * @returns the operation.
 */
export function insertTextClipOperation(clip: DocumentClip): EditOperation {
  return new InsertClipOperation(clip, clip.trackId, Rational.approximate(clip.start) ?? Rational.ZERO, 'overwrite');
}
