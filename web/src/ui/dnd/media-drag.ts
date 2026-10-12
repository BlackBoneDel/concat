// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The internal media drag & drop protocol: dragging a library card onto the
 * timeline. The payload rides on custom MIME types so a drop inside the app
 * can never be confused with an OS file drop (`Files`) or a text drop; the
 * `text/plain` copy is only there for the browser's native drag feedback.
 *
 * Everything is typed against {@link DataTransferLike} — a structural subset
 * of the DOM `DataTransfer` — so the wiring stays unit-testable in jsdom,
 * which ships neither `DataTransfer` nor `DragEvent`.
 */

import { Rational } from '../../core/rational.ts';

/** The media's id: `application/x-concat-media`. */
export const MEDIA_DRAG_MIME = 'application/x-concat-media';
/** The media's type (video / audio / image). */
export const MEDIA_DRAG_TYPE_MIME = 'application/x-concat-media-type';
/** The media's duration as a `num/den` string. */
export const MEDIA_DRAG_DURATION_MIME = 'application/x-concat-media-duration';
/** The media's display name. */
export const MEDIA_DRAG_NAME_MIME = 'application/x-concat-media-name';

/** Every MIME type the media drag writes. */
export const MEDIA_DRAG_MIMES: readonly string[] = [
  MEDIA_DRAG_MIME,
  MEDIA_DRAG_TYPE_MIME,
  MEDIA_DRAG_DURATION_MIME,
  MEDIA_DRAG_NAME_MIME,
];

/** The drag's fallback duration when the payload does not carry one (seconds). */
export const DEFAULT_DRAG_DURATION = 5;

/** The kind of clip a media drop produces. */
export type MediaDragKind = 'video' | 'audio' | 'image';

/** What a media card puts on the drag. */
export interface MediaDragPayload {
  mediaId: string;
  kind: MediaDragKind;
  /** Seconds; `0` when unknown (an image has no duration). */
  durationSeconds: number;
  name: string;
}

/** The parts of the DOM `DataTransfer` the drag protocol uses. */
export interface DataTransferLike {
  readonly types?: ArrayLike<string> | undefined;
  dropEffect?: string;
  effectAllowed?: string;
  getData?(type: string): string;
  setData?(type: string, value: string): void;
  setDragImage?(image: Element, x: number, y: number): void;
}

/** A drag event carrying a `DataTransfer` (structural, jsdom-friendly). */
export interface MediaDragEventLike {
  dataTransfer?: DataTransferLike | null;
  clientX?: number;
  clientY?: number;
  shiftKey?: boolean;
  target?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

/** `Rational` → the payload's `num/den` string. */
function rationalToText(value: Rational): string {
  return value.isZero() ? '0/1' : value.toString();
}

/**
 * Parses a payload duration back into a `Rational`.
 * @param text the `num/den` string (`''`/garbage falls back to 5 s).
 * @returns the duration, always positive.
 */
export function parseDragDuration(text: string): Rational {
  const parsed = text === '' ? null : Rational.parse(text);
  const seconds = parsed?.asNumber() ?? NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return Rational.fromInt(DEFAULT_DRAG_DURATION);
  return parsed!;
}

/** Whether a data transfer carries an internal media drag. */
export function hasMediaDrag(dataTransfer: DataTransferLike | null | undefined): boolean {
  const types = dataTransfer?.types;
  if (!types) return false;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === MEDIA_DRAG_MIME) return true;
  }
  return false;
}

/**
 * Reads the payload of a media drag.
 * @param dataTransfer the drag's data transfer.
 * @returns the payload, or `null` when this is not a media drag.
 */
export function readMediaDrag(dataTransfer: DataTransferLike | null | undefined): MediaDragPayload | null {
  if (!dataTransfer || !hasMediaDrag(dataTransfer)) return null;
  const read = (type: string): string => {
    try {
      return dataTransfer.getData?.(type) ?? '';
    } catch {
      // Some browsers block getData() until the drop: treat it as missing.
      return '';
    }
  };
  const mediaId = read(MEDIA_DRAG_MIME);
  if (mediaId === '') return null;
  const kindText = read(MEDIA_DRAG_TYPE_MIME);
  const kind: MediaDragKind = kindText === 'audio' || kindText === 'image' ? kindText : 'video';
  return {
    mediaId,
    kind,
    durationSeconds: parseDragDuration(read(MEDIA_DRAG_DURATION_MIME)).asNumber(),
    name: read(MEDIA_DRAG_NAME_MIME) || read('text/plain') || mediaId,
  };
}

/**
 * Writes a media payload onto a drag.
 * @param dataTransfer the drag's data transfer.
 * @param payload what the library card carries.
 * @returns `true` when the payload was written (a browser with a real
 * `DataTransfer`); `false` when the transfer only supports `Files`.
 */
export function writeMediaDrag(
  dataTransfer: DataTransferLike | null | undefined,
  payload: MediaDragPayload,
): boolean {
  if (!dataTransfer?.setData) return false;
  try {
    dataTransfer.setData(MEDIA_DRAG_MIME, payload.mediaId);
    dataTransfer.setData(MEDIA_DRAG_TYPE_MIME, payload.kind);
    dataTransfer.setData(
      MEDIA_DRAG_DURATION_MIME,
      rationalToText(Rational.approximate(payload.durationSeconds) ?? Rational.ZERO),
    );
    dataTransfer.setData(MEDIA_DRAG_NAME_MIME, payload.name);
    dataTransfer.setData('text/plain', payload.name);
    dataTransfer.effectAllowed = 'copy';
    return true;
  } catch {
    // A transfer that only allows `Files` (a real OS drag) — nothing to do.
    return false;
  }
}
