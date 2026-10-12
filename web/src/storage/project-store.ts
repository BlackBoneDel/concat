// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Project persistence in IndexedDB (`ConcatProjectDB`, store `projects`).
 *
 * A record is `{name, document}` as the spec sketches: the project name also
 * rides in the wire document's `name` field (the model's writer-owned mirror),
 * and the document is stored in its wire form through
 * {@link toDocument}/{@link fromDocument} — so reopening goes through the same
 * migrate/parse/settle pipeline as loading a file.
 */

import { fromDocument, toDocument, type DocumentSettings } from '../model/document.ts';
import type { ProjectDocument } from '../model/index.ts';
import type { Json } from '../model/wire.ts';
import { openKeyValue, type KeyValue } from './idb.ts';
import { PROJECT_DB_NAME, PROJECT_STORE_NAME } from './media-store.ts';

/** The persisted shape of a project. */
export interface ProjectRecord {
  id: string;
  name: string;
  /** The document in `concat.json` wire form. */
  document: Json;
  lastModified: number;
  fileSize: number;
}

/** The project list line the UI shows. */
export interface ProjectSummary {
  id: string;
  name: string;
  lastModified: number;
  fileSize: number;
}

/** The application's project store. */
export class ProjectStore {
  private readonly backend: KeyValue;

  /**
   * @param backend the IndexedDB slice holding projects.
   */
  constructor(backend: KeyValue) {
    this.backend = backend;
  }

  /**
   * Opens the real project database (memory fallback if IndexedDB is gone).
   * @returns a working store and its backend.
   */
  static async open(): Promise<{ store: ProjectStore; backend: KeyValue }> {
    const backend = await openKeyValue(PROJECT_DB_NAME, [PROJECT_STORE_NAME]);
    return { store: new ProjectStore(backend), backend };
  }

  /**
   * Saves (or overwrites) a project — the `Ctrl+S` path.
   * @param document the current document.
   * @param settings the manifest fields around it (name, frame, rate).
   * @param id the record id (minted when omitted).
   * @returns the saved record.
   */
  async saveProject(
    document: ProjectDocument,
    settings: DocumentSettings,
    id?: string,
  ): Promise<ProjectRecord> {
    const wire = toDocument(settings, document);
    const record: ProjectRecord = {
      id: id ?? crypto.randomUUID(),
      name: settings.name,
      document: wire,
      lastModified: Date.now(),
      fileSize: JSON.stringify(wire).length,
    };
    await this.backend.put(PROJECT_STORE_NAME, record.id, record);
    return record;
  }

  /**
   * Loads a project back into a working document.
   * @param id the record id.
   * @returns the name and document, or `null` when missing or corrupt.
   */
  async loadProject(id: string): Promise<{ name: string; document: ProjectDocument } | null> {
    const record = await this.backend.get<ProjectRecord>(PROJECT_STORE_NAME, id);
    if (!record) return null;
    try {
      const document = fromDocument(record.document);
      if (!document) return null;
      return { name: record.name, document };
    } catch {
      return null;
    }
  }

  /** Every project, newest first. */
  async listProjects(): Promise<ProjectSummary[]> {
    const records = await this.backend.getAll<ProjectRecord>(PROJECT_STORE_NAME);
    return records
      .map((record) => ({
        id: record.id,
        name: record.name,
        lastModified: record.lastModified,
        fileSize: record.fileSize,
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  /**
   * Deletes a project record.
   * @param id the record id.
   */
  async deleteProject(id: string): Promise<void> {
    await this.backend.delete(PROJECT_STORE_NAME, id);
  }

  /** Wipes the project list. */
  async clearAll(): Promise<void> {
    await this.backend.clear(PROJECT_STORE_NAME);
  }
}
