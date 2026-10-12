// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The storage module: IndexedDB, OPFS media, projects, settings. */
export {
  IndexedDbKeyValue,
  MemoryKeyValue,
  openDatabase,
  openKeyValue,
  type KeyValue,
} from './idb.ts';
export {
  MediaStore,
  PROJECT_DB_NAME,
  PROJECT_STORE_NAME,
  type MediaRecord,
  type StorageUsage,
} from './media-store.ts';
export {
  ProjectStore,
  type ProjectRecord,
  type ProjectSummary,
} from './project-store.ts';
export {
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings,
  saveSettings,
  type SettingsStorage,
  type UserSettings,
} from './settings-store.ts';
export {
  MemoryProxyFiles,
  OpfsProxyFiles,
  PROXY_DB_NAME,
  PROXY_DIR,
  PROXY_STORE_NAME,
  ProxyRecordStore,
  isProxyRecord,
  openProxyStorage,
  type ProxyFileBackend,
  type ProxyRecord,
} from './proxy-store.ts';
