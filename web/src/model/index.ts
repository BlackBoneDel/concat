// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The `concat.json` document schema — the web port of the `concat-project`
 * crate's `model.rs` and `doc.rs`. Re-exported whole so the app and the tests
 * speak to one surface.
 */

export * from './wire.ts';
export * from './document.ts';
