// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The service bag every panel talks through — one interface, no hidden
 * globals. `main.ts` builds the concrete services; panels receive this.
 */

import type { MediaPool } from '../media/media-pool.ts';
import type { PreviewPlayer } from '../player/player.ts';
import type { EditorSession } from '../session/editor-session.ts';
import type { History } from '../session/history.ts';
import type { MediaStore } from '../storage/media-store.ts';
import type { ProjectStore } from '../storage/project-store.ts';
import type { UserSettings } from '../storage/settings-store.ts';
import type { Notifications } from './notifications.ts';
import type { ThemeManager } from './theme-manager.ts';
import type { KeyboardShortcuts } from './shortcuts.ts';

/** What the shell wires together. */
export interface AppContext {
  session: EditorSession;
  player: PreviewPlayer;
  pool: MediaPool;
  mediaStore: MediaStore;
  projectStore: ProjectStore;
  history: History;
  notifications: Notifications;
  theme: ThemeManager;
  shortcuts: KeyboardShortcuts;
  settings: UserSettings;
  /** The open project's record id, or `null` before the first save. */
  projectId: string | null;

  /** Imports local files into the library and OPFS. */
  importFiles(files: File[]): Promise<void>;
  /** Saves the project (Ctrl+S path). */
  saveProject(): Promise<void>;
  /** Loads a project by record id. */
  openProject(id: string): Promise<void>;
  /** Adds a library item to the timeline at the playhead. */
  addMediaToTimeline(mediaId: string): void;
  /** Selects a clip (or clears the selection). */
  selectClip(docClipId: string | null): void;
  /** The selected clip id. */
  readonly selectedClipId: string | null;
  /** Schedules a debounced preview re-render. */
  requestRender(): void;
  /** Schedules a debounced autosave. */
  requestAutosave(): void;
  /** Persists settings after a change. */
  saveSettings(): void;
}
