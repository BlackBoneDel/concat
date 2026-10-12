// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Media persistence: the file bytes in the Origin Private File System (a
 * real file per asset — `File` objects become unusable across sessions and
 * IndexedDB does not take huge blobs reliably), and the metadata in
 * IndexedDB.
 *
 * OPFS is mandatory on import: every asset is copied to `media/<id>` before
 * the import resolves. Browsers without OPFS (or private windows that block
 * it) keep an in-memory mirror for the session and say so — never a silent
 * dependency on the original `File`.
 */

import { Rational } from '../core/rational.ts';
import type { MediaInfo } from '../media/decoder.ts';
import type { KeyValue } from './idb.ts';

/** What IndexedDB keeps about each file. */
export interface MediaRecord {
  id: string;
  name: string;
  /** The OPFS path, always `media/<id>`. */
  path: string;
  type: 'video' | 'audio' | 'image';
  duration: Rational;
  width: number;
  height: number;
  fps: import('../core/time.ts').FrameRate;
  codec: string;
  fileSize: number;
  importedAt: number;
}

/** Aggregate storage figures for the settings panel. */
export interface StorageUsage {
  mediaBytes: number;
  mediaCount: number;
  projectCount: number;
}

const MEDIA_DIR = 'media';
const MEDIA_STORE = 'files';
const PROJECT_DB = 'ConcatProjectDB';
const PROJECT_STORE = 'projects';

/** Local file persistence over OPFS + IndexedDB. */
export class MediaStore {
  private readonly backend: KeyValue;
  private readonly memoryBlobs = new Map<string, { blob: Blob; record: MediaRecord }>();
  private opfs: FileSystemDirectoryHandle | null = null;
  private opfsChecked = false;

  /**
   * @param backend the IndexedDB slice holding metadata.
   */
  constructor(backend: KeyValue) {
    this.backend = backend;
  }

  /** Whether OPFS is actually usable here. */
  async hasOpfs(): Promise<boolean> {
    return (await this.opfsRoot()) !== null;
  }

  /**
   * Copies the file into OPFS and records its metadata — the one import
   * path. Resolves only when the bytes are safely stored (or the in-memory
   * fallback has them).
   * @param file the file being imported.
   * @param info the probed metadata.
   * @param id the asset id.
   * @param name the library display name.
   * @returns the stored record.
   */
  async importFile(file: File | Blob, info: MediaInfo, id: string, name: string): Promise<MediaRecord> {
    const path = `${MEDIA_DIR}/${id}`;
    const record: MediaRecord = {
      id,
      name,
      path,
      type: info.type,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      codec: info.videoCodec || info.audioCodec,
      fileSize: file.size,
      importedAt: Date.now(),
    };

    const root = await this.opfsRoot();
    const stored = root ? await this.writeToOpfs(root, id, file) : false;
    if (!stored) {
      // Fallback for browsers/private modes without a usable OPFS write
      // path — notably Safari 17, which exposes `navigator.storage
      // .getDirectory()` but no `createWritable()` on the main thread:
      // keep the bytes in memory for this session and report the degraded
      // mode through `hasOpfs` (the UI warns once on boot).
      this.memoryBlobs.set(id, { blob: file, record });
      this.opfs = null;
    }
    await this.backend.put(MEDIA_STORE, id, record);
    return record;
  }

  /**
   * Writes one asset's bytes into OPFS.
   * @param root the OPFS root.
   * @param id the asset id (the file name under `media/`).
   * @param file the bytes.
   * @returns `false` when the write path is missing or failed — the caller
   * falls back to the in-memory mirror.
   */
  private async writeToOpfs(root: FileSystemDirectoryHandle, id: string, file: Blob): Promise<boolean> {
    try {
      const directory = await root.getDirectoryHandle(MEDIA_DIR, { create: true });
      const handle = await directory.getFileHandle(id, { create: true });
      // Safari 17: OPFS exists but `createWritable` is worker-only —
      // feature-detect instead of throwing a TypeError mid-import.
      if (typeof handle.createWritable !== 'function') return false;
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The stored bytes of an asset.
   * @param id the asset id.
   * @returns the file as a `Blob`, or `null` when it is gone.
   */
  async readFile(id: string): Promise<Blob | null> {
    const root = await this.opfsRoot();
    if (root) {
      try {
        const directory = await root.getDirectoryHandle(MEDIA_DIR);
        const handle = await directory.getFileHandle(id);
        return await handle.getFile();
      } catch {
        return this.memoryBlobs.get(id)?.blob ?? null;
      }
    }
    return this.memoryBlobs.get(id)?.blob ?? null;
  }

  /** The record of an asset. */
  async get(id: string): Promise<MediaRecord | undefined> {
    return this.backend.get<MediaRecord>(MEDIA_STORE, id);
  }

  /** Every stored asset, newest first. */
  async list(): Promise<MediaRecord[]> {
    const all = await this.backend.getAll<MediaRecord>(MEDIA_STORE);
    return all.sort((a, b) => b.importedAt - a.importedAt);
  }

  /**
   * Deletes an asset: bytes and record.
   * @param id the asset id.
   */
  async deleteFile(id: string): Promise<void> {
    const root = await this.opfsRoot();
    if (root) {
      try {
        const directory = await root.getDirectoryHandle(MEDIA_DIR);
        await directory.removeEntry(id);
      } catch {
        // Already gone.
      }
    }
    this.memoryBlobs.delete(id);
    await this.backend.delete(MEDIA_STORE, id);
  }

  /** Wipes the media library. */
  async clearAll(): Promise<void> {
    const records = await this.list();
    for (const record of records) await this.deleteFile(record.id);
    this.memoryBlobs.clear();
    await this.backend.clear(MEDIA_STORE);
  }

  /**
   * Bytes in use and counts — the settings panel's usage line.
   * @param projectBackend the project database to count.
   * @returns the aggregate.
   */
  async getStorageUsage(projectBackend?: KeyValue): Promise<StorageUsage> {
    const media = await this.list();
    const mediaBytes = media.reduce((sum, record) => sum + record.fileSize, 0);
    return {
      mediaBytes,
      mediaCount: media.length,
      projectCount: projectBackend ? await projectBackend.count(PROJECT_STORE) : 0,
    };
  }

  /** The OPFS root, memoized; `null` when unavailable. */
  private async opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
    if (this.opfsChecked) return this.opfs;
    this.opfsChecked = true;
    try {
      if (
        typeof navigator !== 'undefined' &&
        'storage' in navigator &&
        navigator.storage.getDirectory
      ) {
        this.opfs = await navigator.storage.getDirectory();
      }
    } catch {
      this.opfs = null;
    }
    return this.opfs;
  }
}

/** The project store name and object store, shared with ProjectStore. */
export const PROJECT_DB_NAME = PROJECT_DB;
export const PROJECT_STORE_NAME = PROJECT_STORE;
