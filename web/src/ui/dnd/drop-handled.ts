// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * One drag of an internal drag & drop is handled by exactly one zone. The
 * timeline marks the drop as it happens so a window-level handler (the OS
 * file-drop guard) can tell an already-consumed drop from a stray one and
 * never double-process the same event.
 */

/** Events already claimed by a drop zone. */
const handled = new WeakSet<object>();

/**
 * Claims a drop event.
 * @param event the event being handled.
 */
export function markDropHandled(event: object): void {
  handled.add(event);
}

/**
 * Whether a drop event was already handled by a more specific zone.
 * @param event the event to test (accepts `null`/undefined).
 * @returns `true` when some zone consumed it.
 */
export function wasDropHandled(event: object | null | undefined): boolean {
  return event !== null && event !== undefined && handled.has(event);
}
