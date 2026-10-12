// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The UI module: shell, panels and chrome. */
export { createEditorLayout, type EditorLayout } from './editor-layout.ts';
export { HeaderBar } from './header-bar.ts';
export { MediaPanel } from './media-panel.ts';
export { PreviewPanel } from './preview-panel.ts';
export { TimelinePanel } from './timeline-panel.ts';
export { InspectorPanel } from './inspector-panel.ts';
export { Notifications, type NotificationOptions, type NotificationType } from './notifications.ts';
export { Modal, type ModalButtons } from './modal.ts';
export { ThemeManager, THEMES, type ThemeName, type ThemePalette } from './theme-manager.ts';
export { KeyboardShortcuts, DEFAULT_SHORTCUTS, type ShortcutCombo, type ShortcutHandler } from './shortcuts.ts';
export type { AppContext } from './app-context.ts';
