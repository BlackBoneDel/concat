// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Low-level proxy persistence: the proxy files live in OPFS under
 * `proxies/<proxyId>.<ext>` and their metadata in the `proxies` store of the
 * `ConcatProxyDB` IndexedDB database. Browsers without OPFS keep the bytes in
 * memory for the session (the same degradation `media-store.ts` uses).
 *
 * The policy layer — checksums, LRU eviction, cleanup — is
 * `media/proxy/proxy-store.ts`.
 */

import { openKeyValue, type KeyValue } from './idb.ts';

/** IndexedDB database of proxy metadata. */
export const PROXY_DB_NAME = 'ConcatProxyDB';
/** Object store inside {@link PROXY_DB_NAME}. */
export const PROXY_STORE_NAME = 'proxies';
/** OPFS directory of proxy files. */
export const PROXY_DIR = 'proxies';

/** What IndexedDB keeps per proxy (plain data: structured-cloneable). */
export interface ProxyRecord {
  mediaId: string;
  proxyId: string;
  /** `proxies/<proxyId>.<ext>`. */
  opfsPath: string;
  width: number;
  height: number;
  /** Seconds. */
  durationSeconds: number;
  fileSize: number;
  generatedAt: number;
  /** Last time the proxy was read — LRU key. */
  lastAccess: number;
  /** SHA-256 hex of the file. */
  checksum: string;
  /** Container of the file. */
  container: 'mp4' | 'webm';
}

/** Where proxy bytes go. */
export interface ProxyFileBackend {
  write(path: string, blob: Blob): Promise<void>;
  read(path: string): Promise<Blob | null>;
  delete(path: string): Promise<void>;
}

/** In-memory proxy files (tests, private windows). */
export class MemoryProxyFiles implements ProxyFileBackend {
  private readonly files = new Map<string, Blob>();

  async write(path: string, blob: Blob): Promise<void> {
    this.files.set(path, blob);
  }

  async read(path: string): Promise<Blob | null> {
    return this.files.get(path) ?? null;
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  /** How many files are held. */
  get size(): number {
    return this.files.size;
  }
}

/** OPFS-backed proxy files with an in-memory fallback. */
export class OpfsProxyFiles implements ProxyFileBackend {
  private root: FileSystemDirectoryHandle | null = null;
  private checked = false;
  private readonly memory = new MemoryProxyFiles();

  /** `true` when OPFS is usable. */
  async hasOpfs(): Promise<boolean> {
    return (await this.directory()) !== null;
  }

  async write(path: string, blob: Blob): Promise<void> {
    const dir = await this.directory();
    if (!dir) {
      await this.memory.write(path, blob);
      return;
    }
    const handle = await dir.getFileHandle(fileName(path), { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }
  }

  async read(path: string): Promise<Blob | null> {
    const dir = await this.directory();
    if (!dir) return this.memory.read(path);
    try {
      const handle = await dir.getFileHandle(fileName(path));
      return await handle.getFile();
    } catch {
      return null;
    }
  }

  async delete(path: string): Promise<void> {
    const dir = await this.directory();
    if (!dir) {
      await this.memory.delete(path);
      return;
    }
    try {
      await dir.removeEntry(fileName(path));
    } catch {
      // Already gone.
    }
  }

  private async directory(): Promise<FileSystemDirectoryHandle | null> {
    if (this.checked) return this.root;
    this.checked = true;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
        const top = await navigator.storage.getDirectory();
        this.root = await top.getDirectoryHandle(PROXY_DIR, { create: true });
      }
    } catch {
      this.root = null;
    }
    return this.root;
  }
}

/** The file name part of `proxies/<name>`. */
function fileName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Typed access to the proxy metadata store. */
export class ProxyRecordStore {
  private readonly backend: KeyValue;

  /**
   * @param backend an IndexedDB (or memory) key/value backend with the `proxies` store.
   */
  constructor(backend: KeyValue) {
    this.backend = backend;
  }

  /** The record of a media id. */
  async get(mediaId: string): Promise<ProxyRecord | undefined> {
    const value = await this.backend.get<unknown>(PROXY_STORE_NAME, mediaId);
    return isProxyRecord(value) ? value : undefined;
  }

  /** Every valid record. */
  async list(): Promise<ProxyRecord[]> {
    const all = await this.backend.getAll<unknown>(PROXY_STORE_NAME);
    return all.filter(isProxyRecord);
  }

  /** Writes a record keyed by its media id. */
  async put(record: ProxyRecord): Promise<void> {
    await this.backend.put(PROXY_STORE_NAME, record.mediaId, record);
  }

  /** Deletes a record. */
  async delete(mediaId: string): Promise<void> {
    await this.backend.delete(PROXY_STORE_NAME, mediaId);
  }

  /** Deletes every record. */
  async clear(): Promise<void> {
    await this.backend.clear(PROXY_STORE_NAME);
  }
}

/**
 * Structural check of a stored record (IndexedDB may hold anything).
 * @param value what was read.
 * @returns `true` for a well-formed record.
 */
export function isProxyRecord(value: unknown): value is ProxyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const numbers = ['width', 'height', 'durationSeconds', 'fileSize', 'generatedAt', 'lastAccess'];
  const strings = ['mediaId', 'proxyId', 'opfsPath', 'checksum'];
  for (const key of numbers) {
    if (typeof Reflect.get(value, key) !== 'number') return false;
  }
  for (const key of strings) {
    if (typeof Reflect.get(value, key) !== 'string') return false;
  }
  const container: unknown = Reflect.get(value, 'container');
  return container === 'mp4' || container === 'webm';
}

/**
 * Opens the real proxy storage (IndexedDB + OPFS), degrading to memory.
 * @returns the record store and the file backend.
 */
export async function openProxyStorage(): Promise<{ records: ProxyRecordStore; files: OpfsProxyFiles }> {
  const backend = await openKeyValue(PROXY_DB_NAME, [PROXY_STORE_NAME]);
  return { records: new ProxyRecordStore(backend), files: new OpfsProxyFiles() };
}
