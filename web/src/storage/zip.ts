// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: a dependency-free ZIP writer/reader (APPNOTE 6.3, "stored"
 * entries, UTF-8 names, CRC-32) plus an incremental SHA-256 for package
 * checksums. Media are already compressed, so storing avoids recompressing
 * gigabytes; the writer streams entries as `Blob` slices, so the output
 * references the source blobs instead of copying them into memory.
 * The Rust editor has no package format; this is web-only.
 */

/** Bytes read per step while hashing. */
const CHUNK = 4 * 1024 * 1024;
/** Largest entry/archive a 32-bit ZIP can describe. */
export const ZIP32_LIMIT = 0xffff_ffff;

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const out = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    out[n] = c >>> 0;
  }
  crcTable = out;
  return out;
}

/**
 * Continues a CRC-32 over `bytes`.
 * @param bytes the data.
 * @param crc the running value (start with 0).
 * @returns the updated CRC.
 */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const t = table();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) c = (t[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** An incremental SHA-256 (FIPS 180-4). */
export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private used = 0;
  private length = 0;
  private done = false;

  /**
   * Feeds bytes.
   * @param bytes the data.
   * @returns this.
   */
  update(bytes: Uint8Array): this {
    if (this.done) throw new Error('Sha256 ya finalizado');
    this.length += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(64 - this.used, bytes.length - offset);
      this.block.set(bytes.subarray(offset, offset + take), this.used);
      this.used += take;
      offset += take;
      if (this.used === 64) {
        this.compress();
        this.used = 0;
      }
    }
    return this;
  }

  /**
   * Finishes the hash.
   * @returns the lowercase hex digest.
   */
  hex(): string {
    if (!this.done) {
      const bits = this.length * 8;
      this.block[this.used] = 0x80;
      this.used += 1;
      if (this.used > 56) {
        this.block.fill(0, this.used);
        this.compress();
        this.used = 0;
      }
      this.block.fill(0, this.used, 56);
      const view = new DataView(this.block.buffer);
      view.setUint32(56, Math.floor(bits / 0x1_0000_0000));
      view.setUint32(60, bits >>> 0);
      this.compress();
      this.done = true;
    }
    return [...this.h].map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  private compress(): void {
    const w = this.w;
    const b = this.block;
    for (let i = 0; i < 16; i += 1) w[i] = (((b[i * 4] ?? 0) << 24) | ((b[i * 4 + 1] ?? 0) << 16) | ((b[i * 4 + 2] ?? 0) << 8) | (b[i * 4 + 3] ?? 0)) >>> 0;
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, h] = [this.h[0] ?? 0, this.h[1] ?? 0, this.h[2] ?? 0, this.h[3] ?? 0, this.h[4] ?? 0, this.h[5] ?? 0, this.h[6] ?? 0, this.h[7] ?? 0];
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    const values = [a, bb, c, d, e, f, g, h];
    for (let i = 0; i < 8; i += 1) this.h[i] = ((this.h[i] ?? 0) + (values[i] ?? 0)) >>> 0;
  }
}

/**
 * CRC-32 and SHA-256 of a blob, read in 4 MiB chunks.
 * @param blob the data.
 * @param signal optional abort signal.
 * @returns both checksums.
 */
export async function checksumBlob(blob: Blob, signal?: AbortSignal): Promise<{ crc: number; sha256: string }> {
  const sha = new Sha256();
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
    crc = crc32(bytes, crc);
    sha.update(bytes);
  }
  return { crc, sha256: sha.hex() };
}

/** One archive member for {@link ZipWriter}. */
export interface ZipInput {
  path: string;
  data: Blob;
  /** Precomputed CRC-32 (computed when omitted). */
  crc?: number;
  modified?: Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Builds a stored ZIP as a list of blob parts. */
export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly central: Uint8Array<ArrayBuffer>[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private count = 0;

  /**
   * Adds one entry.
   * @param input path, data and optional CRC.
   * @throws Error on duplicate paths, unsafe names or > 4 GiB entries.
   */
  async add(input: ZipInput): Promise<void> {
    const path = input.path.replace(/\\/g, '/');
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Ruta de ZIP no válida: ${input.path}`);
    if (this.names.has(path)) throw new Error(`Entrada duplicada en el ZIP: ${path}`);
    if (input.data.size > ZIP32_LIMIT || this.offset + input.data.size > ZIP32_LIMIT) {
      throw new Error('El paquete supera 4 GB (límite del formato ZIP sin ZIP64). Exporta sin medios o reduce el proyecto.');
    }
    this.names.add(path);
    const name = encoder.encode(path);
    const crc = input.crc ?? (await checksumBlob(input.data)).crc;
    const { time, date } = dosTime(input.modified ?? new Date());
    const size = input.data.size;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, this.offset, true);
    entry.set(name, 46);

    this.parts.push(local, input.data);
    this.central.push(entry);
    this.offset += local.length + size;
    this.count += 1;
  }

  /**
   * Writes the central directory.
   * @returns the archive.
   */
  finish(): Blob {
    const centralSize = this.central.reduce((sum, entry) => sum + entry.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end], { type: 'application/zip' });
  }
}

/** One member found by {@link readZip}. */
export interface ZipEntry {
  path: string;
  size: number;
  crc: number;
  /** The stored bytes (a slice of the archive, no copy). */
  data: Blob;
}

/**
 * Lists a stored ZIP's members via its central directory.
 * @param archive the archive.
 * @returns entries in directory order.
 * @throws Error on malformed archives or compressed members.
 */
export async function readZip(archive: Blob): Promise<ZipEntry[]> {
  const tailSize = Math.min(archive.size, 22 + 0xffff);
  const tail = new Uint8Array(await archive.slice(archive.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('No es un archivo ZIP válido (falta el directorio central).');
  const ev = new DataView(tail.buffer, tail.byteOffset + eocd, 22);
  const count = ev.getUint16(10, true);
  const centralSize = ev.getUint32(12, true);
  const centralOffset = ev.getUint32(16, true);
  if (centralOffset + centralSize > archive.size) throw new Error('ZIP truncado.');
  const central = new Uint8Array(await archive.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const cv = new DataView(central.buffer);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > central.length || cv.getUint32(p, true) !== 0x02014b50) throw new Error('Directorio central del ZIP dañado.');
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    const size = cv.getUint32(p + 20, true);
    const nameLength = cv.getUint16(p + 28, true);
    const extraLength = cv.getUint16(p + 30, true);
    const commentLength = cv.getUint16(p + 32, true);
    const localOffset = cv.getUint32(p + 42, true);
    const path = decoder.decode(central.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/')) continue;
    if (method !== 0) throw new Error(`«${path}» está comprimido; solo se admiten paquetes de Concat (sin compresión).`);
    const header = new DataView(await archive.slice(localOffset, localOffset + 30).arrayBuffer());
    if (header.byteLength < 30 || header.getUint32(0, true) !== 0x04034b50) throw new Error(`Cabecera local dañada en «${path}».`);
    const start = localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (start + size > archive.size) throw new Error(`«${path}» está truncado.`);
    entries.push({ path, size, crc, data: archive.slice(start, start + size) });
  }
  return entries;
}
