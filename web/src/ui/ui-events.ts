// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 7: document-level UI events shared between panels, so a panel can
 * follow another without importing it.
 */

/** Dispatched by the preview panel on every playhead move (detail: seconds). */
export const PLAYHEAD_EVENT = 'playhead-changed';
