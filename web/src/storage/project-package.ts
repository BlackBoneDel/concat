// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the portable project package (`.concatpkg.zip`):
 *
 * ```
 * manifest.json           format, version, entries with size/CRC-32/SHA-256
 * project.concat.json     the document in `concat.json` wire form (toDocument)
 * media/<id>/<name>       original media from OPFS (optional)
 * fonts/<file>            custom fonts (OPFS /fonts/)
 * luts/<id>.cube          session LUTs referenced by clips
 * ```
 *
 * Everything is produced and read locally; nothing leaves the browser.
 * The Rust editor saves `concat.json` next to the media folder
 * (`concat-host/src/project.rs`); the package bundles that layout in a file.
 */

import type { Json } from '../model/wire.ts';
import { projectFonts } from '../editor/text-operations.ts';
import { EFFECTS_KEY, parseClipEffects } from '../media/clip-effects.ts';
import { fromDocument, toDocument, type DocumentSettings, type ProjectDocument } from '../model/document.ts';
import type { CustomFont } from '../render/advanced-text.ts';
import { restorePersistedFonts, withPersistableFonts } from './font-persistence.ts';
import { fontFileName } from './font-store.ts';
import { checksumBlob, readZip, ZipWriter } from './zip.ts';

/** Package format id written in the manifest. */
export const PACKAGE_FORMAT = 'concat-project-package';
/** Package format version. */
export const PACKAGE_VERSION = 1;
/** Suggested file extension. */
export const PACKAGE_EXTENSION = '.concatpkg.zip';

/** One file in the manifest. */
export interface PackageEntry {
  path: string;
  kind: 'project' | 'media' | 'font' | 'lut';
  /** Media id / font path / LUT id the entry belongs to. */
  ref: string | null;
  size: number;
  crc32: number;
  sha256: string;
}

/** `manifest.json`. */
export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  version: number;
  name: string;
  createdAt: string;
  generator: string;
  includesMedia: boolean;
  entries: PackageEntry[];
}

/** Where the builder reads assets from. */
export interface PackageAssetSource {
  /** The stored original of a media id. */
  readMedia(id: string): Promise<Blob | null>;
  /** The bytes of a project font. */
  readFont(font: CustomFont): Promise<Blob | null>;
  /** `.cube` text of a session LUT (built-ins return null: every build has them). */
  lutCube(id: string): string | null;
}

/** Builder options. */
export interface BuildPackageOptions {
  includeMedia?: boolean;
  signal?: AbortSignal;
  /** 0..1 plus the file being packed. */
  onProgress?: (ratio: number, label: string) => void;
  now?: Date;
}

/** What {@link buildProjectPackage} returns. */
export interface BuiltPackage {
  blob: Blob;
  manifest: PackageManifest;
  /** Assets referenced by the project that could not be read. */
  missing: string[];
}

/** What {@link readProjectPackage} returns. */
export interface OpenedPackage {
  name: string;
  document: ProjectDocument;
  manifest: PackageManifest;
  /** media id → file (with its original name). */
  media: Map<string, File>;
  /** font path (as stored in the document) → bytes. */
  fonts: Map<string, Blob>;
  /** LUT id → `.cube` text. */
  luts: Map<string, string>;
  /** Checksum mismatches or missing entries (empty when intact). */
  problems: string[];
}

/** A package error with a user-facing Spanish message. */
export class PackageError extends Error {
  /**
   * @param message what went wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = 'PackageError';
  }
}

/**
 * A file-system-safe single path segment.
 * @param name any name.
 * @returns the sanitized segment (never empty).
 */
export function safeSegment(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim();
  return (cleaned === '' ? 'archivo' : cleaned).slice(0, 120);
}

/**
 * LUT ids referenced by clip effects (`clip.extra.effects.lut`).
 * @param document the project.
 * @returns unique ids.
 */
export function referencedLuts(document: ProjectDocument): string[] {
  const ids = new Set<string>();
  for (const timeline of document.timelines) {
    for (const clip of timeline.clips) {
      const raw = clip.extra[EFFECTS_KEY];
      if (raw === undefined) continue;
      const lut = parseClipEffects(raw).lut;
      if (lut) ids.add(lut.id);
    }
  }
  return [...ids];
}

/**
 * Builds a package.
 * @param document the project.
 * @param settings name and frame settings (as for `toDocument`).
 * @param source where media/fonts/LUTs come from.
 * @param options media inclusion, progress, abort.
 * @returns the archive, its manifest and what was missing.
 */
export async function buildProjectPackage(
  document: ProjectDocument,
  settings: DocumentSettings,
  source: PackageAssetSource,
  options: BuildPackageOptions = {},
): Promise<BuiltPackage> {
  const includeMedia = options.includeMedia ?? true;
  const zip = new ZipWriter();
  const entries: PackageEntry[] = [];
  const missing: string[] = [];
  const modified = options.now ?? new Date();
  const check = (): void => {
    if (options.signal?.aborted) throw new PackageError('Empaquetado cancelado.');
  };

  const jobs: { path: string; kind: PackageEntry['kind']; ref: string | null; label: string; load: () => Promise<Blob | null> }[] = [];
  const wire = JSON.stringify(toDocument(settings, withPersistableFonts(document)), null, 2);
  jobs.push({ path: 'project.concat.json', kind: 'project', ref: null, label: 'project.concat.json', load: async () => new Blob([wire], { type: 'application/json' }) });
  if (includeMedia) {
    for (const item of document.media) {
      jobs.push({ path: `media/${safeSegment(item.id)}/${safeSegment(item.name)}`, kind: 'media', ref: item.id, label: item.name, load: () => source.readMedia(item.id) });
    }
  }
  for (const font of projectFonts(document)) {
    jobs.push({ path: `fonts/${safeSegment(fontFileName(font.path))}`, kind: 'font', ref: font.path, label: font.family, load: () => source.readFont(font) });
  }
  for (const id of referencedLuts(document)) {
    const cube = source.lutCube(id);
    if (cube === null) continue;
    jobs.push({ path: `luts/${safeSegment(id)}.cube`, kind: 'lut', ref: id, label: id, load: async () => new Blob([cube], { type: 'text/plain' }) });
  }

  const totalBytes = Math.max(1, jobs.length);
  for (const [index, job] of jobs.entries()) {
    check();
    options.onProgress?.(index / totalBytes, job.label);
    let data: Blob | null;
    try {
      data = await job.load();
    } catch {
      data = null;
    }
    if (!data) {
      missing.push(job.label);
      continue;
    }
    const { crc, sha256 } = await checksumBlob(data, options.signal);
    check();
    try {
      await zip.add({ path: job.path, data, crc, modified });
    } catch (error) {
      throw new PackageError(error instanceof Error ? error.message : String(error));
    }
    entries.push({ path: job.path, kind: job.kind, ref: job.ref, size: data.size, crc32: crc, sha256 });
  }

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    name: settings.name,
    createdAt: modified.toISOString(),
    generator: 'Concat web',
    includesMedia: includeMedia,
    entries,
  };
  await zip.add({ path: 'manifest.json', data: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), modified });
  options.onProgress?.(1, 'manifest.json');
  return { blob: zip.finish(), manifest, missing };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntryKind(value: unknown): value is PackageEntry['kind'] {
  return value === 'project' || value === 'media' || value === 'font' || value === 'lut';
}

/**
 * Validates a parsed manifest.
 * @param value parsed JSON.
 * @returns the manifest.
 * @throws PackageError when it is not a Concat manifest.
 */
export function parseManifest(value: unknown): PackageManifest {
  if (!isRecord(value) || value['format'] !== PACKAGE_FORMAT) throw new PackageError('El archivo no es un paquete de proyecto de Concat.');
  const version = value['version'];
  if (typeof version !== 'number' || version > PACKAGE_VERSION) throw new PackageError('El paquete es de una versión más reciente de Concat.');
  const rawEntries = Array.isArray(value['entries']) ? value['entries'] : [];
  const entries: PackageEntry[] = [];
  for (const raw of rawEntries) {
    if (!isRecord(raw)) continue;
    const { path, kind, ref, size, crc32, sha256 } = raw;
    if (typeof path !== 'string' || !isEntryKind(kind) || typeof size !== 'number' || typeof crc32 !== 'number' || typeof sha256 !== 'string') continue;
    entries.push({ path, kind, ref: typeof ref === 'string' ? ref : null, size, crc32, sha256 });
  }
  return {
    format: PACKAGE_FORMAT,
    version,
    name: typeof value['name'] === 'string' ? value['name'] : 'Proyecto',
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
    generator: typeof value['generator'] === 'string' ? value['generator'] : '',
    includesMedia: value['includesMedia'] === true,
    entries,
  };
}

/**
 * Opens a package and verifies every checksum.
 * @param archive the `.zip`.
 * @param options abort signal.
 * @returns the document and its assets.
 * @throws PackageError when the archive or the project is unreadable.
 */
export async function readProjectPackage(archive: Blob, options: { signal?: AbortSignal } = {}): Promise<OpenedPackage> {
  let files;
  try {
    files = await readZip(archive);
  } catch (error) {
    throw new PackageError(error instanceof Error ? error.message : String(error));
  }
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get('manifest.json');
  if (!manifestEntry) throw new PackageError('El paquete no tiene manifest.json.');
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(await manifestEntry.data.text());
  } catch {
    throw new PackageError('manifest.json no es JSON válido.');
  }
  const manifest = parseManifest(manifestJson);

  const problems: string[] = [];
  const media = new Map<string, File>();
  const fonts = new Map<string, Blob>();
  const luts = new Map<string, string>();
  let documentText: string | null = null;
  for (const entry of manifest.entries) {
    if (options.signal?.aborted) throw new PackageError('Apertura cancelada.');
    const file = byPath.get(entry.path);
    if (!file) {
      problems.push(`Falta ${entry.path}`);
      continue;
    }
    const { crc, sha256 } = await checksumBlob(file.data, options.signal);
    if (crc !== entry.crc32 || sha256 !== entry.sha256 || file.size !== entry.size) {
      problems.push(`Checksum incorrecto en ${entry.path}`);
      continue;
    }
    switch (entry.kind) {
      case 'project':
        documentText = await file.data.text();
        break;
      case 'media': {
        const name = entry.path.split('/').pop() ?? 'medio';
        if (entry.ref) media.set(entry.ref, new File([file.data], name));
        break;
      }
      case 'font':
        if (entry.ref) fonts.set(entry.ref, file.data);
        break;
      case 'lut':
        if (entry.ref) luts.set(entry.ref, await file.data.text());
        break;
    }
  }
  if (documentText === null) throw new PackageError(problems.length > 0 ? `El proyecto está dañado: ${problems.join('; ')}` : 'El paquete no contiene project.concat.json.');
  let wire: Json;
  try {
    wire = JSON.parse(documentText);
  } catch {
    throw new PackageError('project.concat.json no es JSON válido.');
  }
  const parsed = fromDocument(wire);
  const document = parsed ? restorePersistedFonts(parsed) : null;
  if (!document) throw new PackageError('project.concat.json no es un proyecto de Concat legible (¿versión más reciente?).');
  const name = isRecord(wire) && typeof wire['name'] === 'string' ? wire['name'] : manifest.name;
  return { name, document, manifest, media, fonts, luts, problems };
}
