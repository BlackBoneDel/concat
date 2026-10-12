// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * A thin promise wrapper over IndexedDB — the engine behind the media,
 * project and thumbnail stores. Everything the rest of the app sees goes
 * through the {@link KeyValue} interface, so stores can be tested against a
 * memory backend and swapped for the real database without a cast.
 */

/** A namespaced key/value slice. */
export interface KeyValue {
  get<T>(store: string, key: string): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  put<T>(store: string, key: string, value: T): Promise<void>;
  delete(store: string, key: string): Promise<void>;
  count(store: string): Promise<number>;
  clear(store: string): Promise<void>;
}

/** An in-memory {@link KeyValue} — tests and private-mode fallback. */
export class MemoryKeyValue implements KeyValue {
  private readonly data = new Map<string, Map<string, unknown>>();

  private bucket(store: string): Map<string, unknown> {
    let found = this.data.get(store);
    if (!found) {
      found = new Map();
      this.data.set(store, found);
    }
    return found;
  }

  async get<T>(store: string, key: string): Promise<T | undefined> {
    return this.bucket(store).get(key) as T | undefined;
  }

  async getAll<T>(store: string): Promise<T[]> {
    return [...this.bucket(store).values()] as T[];
  }

  async put<T>(store: string, key: string, value: T): Promise<void> {
    this.bucket(store).set(key, value);
  }

  async delete(store: string, key: string): Promise<void> {
    this.bucket(store).delete(key);
  }

  async count(store: string): Promise<number> {
    return this.bucket(store).size;
  }

  async clear(store: string): Promise<void> {
    this.bucket(store).clear();
  }
}

/** Opens (and upgrades) an IndexedDB database. */
export async function openDatabase(
  name: string,
  version: number,
  stores: string[],
): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name, version);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** An IndexedDB-backed {@link KeyValue}. */
export class IndexedDbKeyValue implements KeyValue {
  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  /**
   * Opens `name`, creating `stores` as needed.
   * @param name database name.
   * @param version schema version.
   * @param stores object store names.
   * @returns the backend, or `null` when IndexedDB is unavailable.
   */
  static async open(name: string, version: number, stores: string[]): Promise<IndexedDbKeyValue | null> {
    const db = await openDatabase(name, version, stores);
    return db ? new IndexedDbKeyValue(db) : null;
  }

  private run<T>(
    store: string,
    mode: IDBTransactionMode,
    body: (objectStore: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(store, mode);
      const request = body(transaction.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexeddb error'));
    });
  }

  async get<T>(store: string, key: string): Promise<T | undefined> {
    return this.run<T | undefined>(store, 'readonly', (objectStore) => objectStore.get(key));
  }

  async getAll<T>(store: string): Promise<T[]> {
    return this.run<T[]>(store, 'readonly', (objectStore) => objectStore.getAll());
  }

  async put<T>(store: string, key: string, value: T): Promise<void> {
    await this.run(store, 'readwrite', (objectStore) => objectStore.put(value, key));
  }

  async delete(store: string, key: string): Promise<void> {
    await this.run(store, 'readwrite', (objectStore) => objectStore.delete(key));
  }

  async count(store: string): Promise<number> {
    return this.run(store, 'readonly', (objectStore) => objectStore.count());
  }

  async clear(store: string): Promise<void> {
    await this.run(store, 'readwrite', (objectStore) => objectStore.clear());
  }
}

/**
 * Opens the real backend or falls back to memory — every store in this module
 * goes through this so the app degrades in private windows instead of dying.
 * @param name database name.
 * @param stores object store names.
 * @returns a working backend.
 */
export async function openKeyValue(name: string, stores: string[]): Promise<KeyValue> {
  return (await IndexedDbKeyValue.open(name, 2, stores)) ?? new MemoryKeyValue();
}
