// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Proxy persistence policy over `storage/proxy-store.ts`:
 *
 * - files in OPFS `proxies/<proxyId>.<ext>`, metadata in `ConcatProxyDB.proxies`;
 * - a SHA-256 checksum per proxy, verified on load (a corrupt proxy is
 *   deleted and reported missing so it gets regenerated);
 * - a total size budget (5 GB by default) enforced by LRU eviction on
 *   `lastAccess`;
 * - cleanup of proxies whose media no longer exists.
 */

import { Rational } from '../../core/rational.ts';
import {
  type ProxyFileBackend,
  type ProxyRecord,
  ProxyRecordStore,
} from '../../storage/proxy-store.ts';
import { computeSHA256Inline } from '../relink/hash-validator.ts';

/** Default proxy budget: 5 GB. */
export const DEFAULT_PROXY_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

/** A generated proxy as the rest of the app sees it. */
export interface ProxyMetadata {
  mediaId: string;
  proxyId: string;
  opfsPath: string;
  resolution: { width: number; height: number };
  duration: Rational;
  fileSize: number;
  generatedAt: number;
  checksum: string;
  /** Container of the proxy file. */
  container: 'mp4' | 'webm';
  /** Last read, for LRU. */
  lastAccess: number;
}

/** Options for {@link ProxyStore}. */
export interface ProxyStoreOptions {
  /** Total bytes proxies may use. */
  limitBytes?: number;
  /** Hash function (injectable for tests); SHA-256 hex by default. */
  hash?: (blob: Blob) => Promise<string>;
  /** Clock (injectable for tests). */
  now?: () => number;
}

/** Converts a stored record to metadata. */
function toMetadata(record: ProxyRecord): ProxyMetadata {
  return {
    mediaId: record.mediaId,
    proxyId: record.proxyId,
    opfsPath: record.opfsPath,
    resolution: { width: record.width, height: record.height },
    duration: Rational.approximate(record.durationSeconds) ?? Rational.ZERO,
    fileSize: record.fileSize,
    generatedAt: record.generatedAt,
    checksum: record.checksum,
    container: record.container,
    lastAccess: record.lastAccess,
  };
}

/** Converts metadata to a stored record. */
function toRecord(meta: ProxyMetadata): ProxyRecord {
  return {
    mediaId: meta.mediaId,
    proxyId: meta.proxyId,
    opfsPath: meta.opfsPath,
    width: meta.resolution.width,
    height: meta.resolution.height,
    durationSeconds: meta.duration.asNumber(),
    fileSize: meta.fileSize,
    generatedAt: meta.generatedAt,
    lastAccess: meta.lastAccess,
    checksum: meta.checksum,
    container: meta.container,
  };
}

/** Error raised when the budget cannot fit a proxy even after eviction. */
export class ProxyQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyQuotaError';
  }
}

/** The proxy library. */
export class ProxyStore {
  private readonly records: ProxyRecordStore;
  private readonly files: ProxyFileBackend;
  private limitBytes: number;
  private readonly hash: (blob: Blob) => Promise<string>;
  private readonly now: () => number;

  /**
   * @param records metadata store.
   * @param files file backend (OPFS or memory).
   * @param options budget, hash and clock.
   */
  constructor(records: ProxyRecordStore, files: ProxyFileBackend, options: ProxyStoreOptions = {}) {
    this.records = records;
    this.files = files;
    this.limitBytes = options.limitBytes ?? DEFAULT_PROXY_LIMIT_BYTES;
    this.hash = options.hash ?? ((blob) => computeSHA256Inline(blob));
    this.now = options.now ?? (() => Date.now());
  }

  /** The current budget in bytes. */
  get limit(): number {
    return this.limitBytes;
  }

  /**
   * Changes the budget and evicts down to it.
   * @param bytes the new budget (> 0).
   * @returns the media ids evicted.
   */
  async setLimit(bytes: number): Promise<string[]> {
    if (!(bytes > 0)) throw new RangeError('El límite de proxies debe ser positivo');
    this.limitBytes = bytes;
    return this.evictToFit(0);
  }

  /**
   * Stores a freshly generated proxy, replacing any previous one.
   * @param mediaId the source media.
   * @param blob the proxy bytes.
   * @param info resolution, duration and container.
   * @returns the stored metadata.
   * @throws ProxyQuotaError when the proxy alone exceeds the budget.
   */
  async save(
    mediaId: string,
    blob: Blob,
    info: { width: number; height: number; duration: Rational; container: 'mp4' | 'webm'; proxyId?: string },
  ): Promise<ProxyMetadata> {
    if (blob.size > this.limitBytes) {
      throw new ProxyQuotaError(`El proxy (${blob.size} B) supera el límite de ${this.limitBytes} B`);
    }
    await this.delete(mediaId);
    await this.evictToFit(blob.size);
    const proxyId = info.proxyId ?? `px-${mediaId}-${this.now().toString(36)}`;
    const opfsPath = `proxies/${proxyId}.${info.container}`;
    const checksum = await this.hash(blob);
    await this.files.write(opfsPath, blob);
    const now = this.now();
    const meta: ProxyMetadata = {
      mediaId,
      proxyId,
      opfsPath,
      resolution: { width: info.width, height: info.height },
      duration: info.duration,
      fileSize: blob.size,
      generatedAt: now,
      checksum,
      container: info.container,
      lastAccess: now,
    };
    await this.records.put(toRecord(meta));
    return meta;
  }

  /**
   * The metadata of a media's proxy.
   * @param mediaId the source media.
   * @returns metadata or `null`.
   */
  async get(mediaId: string): Promise<ProxyMetadata | null> {
    const record = await this.records.get(mediaId);
    return record ? toMetadata(record) : null;
  }

  /**
   * Reads a proxy, touching its LRU stamp.
   * @param mediaId the source media.
   * @param validate verify the checksum (a mismatch deletes the proxy).
   * @returns the bytes, or `null` when missing or corrupt.
   */
  async load(mediaId: string, validate = true): Promise<Blob | null> {
    const record = await this.records.get(mediaId);
    if (!record) return null;
    const blob = await this.files.read(record.opfsPath);
    if (!blob) {
      await this.records.delete(mediaId);
      return null;
    }
    if (validate) {
      const checksum = await this.hash(blob);
      if (checksum !== record.checksum) {
        await this.delete(mediaId);
        return null;
      }
    }
    await this.records.put({ ...record, lastAccess: this.now() });
    return blob;
  }

  /**
   * Deletes a media's proxy (file + record).
   * @param mediaId the source media.
   * @returns `true` when something was deleted.
   */
  async delete(mediaId: string): Promise<boolean> {
    const record = await this.records.get(mediaId);
    if (!record) return false;
    await this.files.delete(record.opfsPath);
    await this.records.delete(mediaId);
    return true;
  }

  /** Every stored proxy. */
  async list(): Promise<ProxyMetadata[]> {
    return (await this.records.list()).map(toMetadata);
  }

  /** Bytes used by every proxy. */
  async usage(): Promise<number> {
    return (await this.records.list()).reduce((sum, record) => sum + record.fileSize, 0);
  }

  /**
   * Removes proxies whose media is gone.
   * @param existingMediaIds the media still in the library.
   * @returns the removed media ids.
   */
  async cleanup(existingMediaIds: Iterable<string>): Promise<string[]> {
    const keep = new Set(existingMediaIds);
    const removed: string[] = [];
    for (const record of await this.records.list()) {
      if (!keep.has(record.mediaId)) {
        await this.delete(record.mediaId);
        removed.push(record.mediaId);
      }
    }
    return removed;
  }

  /** Deletes every proxy. */
  async clear(): Promise<number> {
    const all = await this.records.list();
    for (const record of all) await this.files.delete(record.opfsPath);
    await this.records.clear();
    return all.length;
  }

  /**
   * Evicts least-recently-used proxies until `incomingBytes` fit the budget.
   * @param incomingBytes bytes about to be written.
   * @returns the evicted media ids.
   */
  async evictToFit(incomingBytes: number): Promise<string[]> {
    const records = (await this.records.list()).sort((a, b) => a.lastAccess - b.lastAccess);
    let used = records.reduce((sum, record) => sum + record.fileSize, 0);
    const evicted: string[] = [];
    for (const record of records) {
      if (used + incomingBytes <= this.limitBytes) break;
      await this.delete(record.mediaId);
      used -= record.fileSize;
      evicted.push(record.mediaId);
    }
    return evicted;
  }
}
