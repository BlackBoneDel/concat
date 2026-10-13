// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 7: document-level UI events shared between panels, so a panel can
 * follow another without importing it.
 */

/** Dispatched by the preview panel on every playhead move (detail: seconds). */
export const PLAYHEAD_EVENT = 'playhead-changed';

/**
 * Fase 8: dispatched by the timeline toolbar's mute button; the preview panel
 * owns the audio state and flips it when it hears this.
 */
export const PREVIEW_MUTE_EVENT = 'preview-mute-toggle';

/**
 * Fase 8: the media panel's Text tab asks the timeline for a title at the
 * playhead (detail: the copy). The timeline panel owns the edit.
 */
export const REQUEST_ADD_TEXT_EVENT = 'request-add-text';
