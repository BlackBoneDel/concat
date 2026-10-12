// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Relinking offline media.
 *
 * Port of the idea behind the Rust editor's "missing media" flow
 * (`concat-project` keeps `MediaItem.path`; a moved file leaves clips
 * pointing at nothing). Here bytes live in OPFS, so media goes offline when
 * OPFS was cleared or a project was opened on another machine.
 *
 * Candidates are scored:
 *
 * | criterion   | weight | rule                                         |
 * |-------------|--------|----------------------------------------------|
 * | name        | 0.4    | same name 1, same stem 0.9, else similarity  |
 * | duration    | 0.3    | within ±1 frame of the original              |
 * | resolution  | 0.1    | same width × height                          |
 * | hash        | 0.2    | SHA-256 equals the one recorded at import    |
 *
 * A hash match is proof: the score is 1.0. Without a recorded hash the
 * other weights are renormalised over 0.8, so a perfect metadata match can
 * still auto-relink. Scores above {@link AUTO_RELINK_THRESHOLD} relink
 * automatically; the rest go to the relink dialog. Relinking only swaps
 * the media entry's file fields: every clip, trim and effect is preserved,
 * and it is one undoable {@link RelinkMediaOperation}.
 */

import { cloneDocument, CompoundOperation, EditError, type EditOperation } from '../../editor/operations.ts';
import type { MediaItem, ProjectDocument } from '../../model/document.ts';
import type { JsonObject } from '../../model/wire.ts';
import { MediaDecoder } from '../decoder.ts';
import { extensionOf } from '../import/format-support.ts';
import type { ScannedFile } from './folder-scanner.ts';

/** Score weights. */
export const RELINK_WEIGHTS = Object.freeze({ name: 0.4, duration: 0.3, resolution: 0.1, hash: 0.2 });
/** Scores strictly above this relink without asking. */
export const AUTO_RELINK_THRESHOLD = 0.8;
/** `MediaItem.extra` keys written at import. */
export const HASH_KEY = 'sha256';
export const SIZE_KEY = 'fileSize';

/** An offline media entry. */
export interface MissingMedia {
  item: MediaItem;
  /** Clips (all timelines) that use it. */
  usedBy: number;
}

/** What a probe reports about a candidate. */
export interface CandidateProbe {
  duration: number | null;
  width: number;
  height: number;
}

/** Per-criterion scores, each 0–1 (hash `null` = not compared). */
export interface ScoreBreakdown {
  name: number;
  duration: number;
  resolution: number;
  hash: number | null;
}

/** A ranked candidate file. */
export interface RelinkCandidate {
  file: File;
  path: string;
  score: number;
  breakdown: ScoreBreakdown;
  hashMatch: boolean;
}

/** A decided relink. */
export interface RelinkAssignment {
  mediaId: string;
  file: File;
  path: string;
  score: number;
}

/** Hashing dependency (the HashValidator). */
export interface Hasher {
  computeSHA256(file: File | Blob, onProgress?: (p: number) => void): Promise<string>;
}

/** Options of {@link Relinker}. */
export interface RelinkerOptions {
  /** Metadata probe (defaults to a {@link MediaDecoder} probe). */
  probe?: (file: File) => Promise<CandidateProbe | null>;
  /** SHA-256 provider; without it hashes are never compared. */
  hasher?: Hasher | null;
  /** Auto-relink threshold (default 0.8). */
  autoThreshold?: number;
}

/** Default probe through the decoder (closed right after). */
async function decoderProbe(file: File): Promise<CandidateProbe | null> {
  const decoder = new MediaDecoder(file, 'relink-probe');
  try {
    const info = await decoder.init();
    return { duration: info.duration.asNumber(), width: info.width, height: info.height };
  } catch {
    return null;
  } finally {
    decoder.close();
  }
}

/** Base name of a `/`- or `\`-separated path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** Stem normalised for comparison: lowercase, no extension, no copy markers or separators. */
export function normalizedStem(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
  return stem
    .replace(/\s*\(\d+\)$/, '')
    .replace(/[\s_-]*(copy|copia|copie|kopie)(\s*\d+)?$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Levenshtein distance (two-row DP).
 * @param a first string.
 * @param b second string.
 * @returns edit distance.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * Name criterion.
 * @param expected the original file name or path.
 * @param candidate the candidate's name.
 * @returns 0–1.
 */
export function nameScore(expected: string, candidate: string): number {
  const a = baseName(expected).toLowerCase();
  const b = baseName(candidate).toLowerCase();
  if (a === b) return 1;
  const sa = normalizedStem(a);
  const sb = normalizedStem(b);
  if (sa !== '' && sa === sb) return extensionOf(a) === extensionOf(b) ? 0.95 : 0.9;
  const longest = Math.max(sa.length, sb.length);
  if (longest === 0) return 0;
  return Math.max(0, 0.85 * (1 - levenshtein(sa, sb) / longest));
}

/**
 * Duration criterion: within one frame.
 * @param expected seconds (null = unknown).
 * @param actual seconds (null = unknown).
 * @param fps the original frame rate (30 when unknown).
 * @returns 1 or 0.
 */
export function durationScore(expected: number | null, actual: number | null, fps: number): number {
  if (expected === null || actual === null || !Number.isFinite(expected) || !Number.isFinite(actual)) return 0;
  const frame = 1 / (fps > 0 ? fps : 30);
  return Math.abs(expected - actual) <= frame + 1e-6 ? 1 : 0;
}

/**
 * Resolution criterion.
 * @param item the original.
 * @param probe the candidate.
 * @returns 1 or 0.
 */
export function resolutionScore(item: Pick<MediaItem, 'width' | 'height'>, probe: CandidateProbe | null): number {
  if (!probe) return 0;
  return (item.width ?? 0) === probe.width && (item.height ?? 0) === probe.height ? 1 : 0;
}

/**
 * Combines criteria into the final score.
 * @param breakdown per-criterion scores.
 * @returns 0–1 (1 on a hash match).
 */
export function combineScore(breakdown: ScoreBreakdown): number {
  const w = RELINK_WEIGHTS;
  if (breakdown.hash === 1) return 1;
  const base = w.name * breakdown.name + w.duration * breakdown.duration + w.resolution * breakdown.resolution;
  if (breakdown.hash === null) return base / (w.name + w.duration + w.resolution);
  return base + w.hash * breakdown.hash;
}

/** The recorded hash of a media entry, if any. */
export function recordedHash(item: MediaItem): string | null {
  const value = item.extra[HASH_KEY];
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

/** The recorded byte size of a media entry, if any. */
export function recordedSize(item: MediaItem): number | null {
  const value = item.extra[SIZE_KEY];
  return typeof value === 'number' && value > 0 ? value : null;
}

/** Finds and scores replacements for offline media. */
export class Relinker {
  private readonly probe: (file: File) => Promise<CandidateProbe | null>;
  private readonly hasher: Hasher | null;
  readonly autoThreshold: number;
  private readonly probeCache = new WeakMap<File, Promise<CandidateProbe | null>>();
  private readonly hashCache = new WeakMap<File, Promise<string | null>>();

  /**
   * @param options probe, hasher, threshold.
   */
  constructor(options: RelinkerOptions = {}) {
    this.probe = options.probe ?? decoderProbe;
    this.hasher = options.hasher ?? null;
    this.autoThreshold = options.autoThreshold ?? AUTO_RELINK_THRESHOLD;
  }

  /**
   * Lists media whose bytes are gone.
   * @param doc the project.
   * @param exists whether the bytes of an item are available.
   * @returns offline entries with their usage count.
   */
  async detectMissing(doc: ProjectDocument, exists: (item: MediaItem) => Promise<boolean>): Promise<MissingMedia[]> {
    const usage = new Map<string, number>();
    for (const timeline of doc.timelines) {
      for (const clip of timeline.clips) {
        if (clip.mediaId !== '') usage.set(clip.mediaId, (usage.get(clip.mediaId) ?? 0) + 1);
      }
    }
    const missing: MissingMedia[] = [];
    for (const item of doc.media) {
      let ok = false;
      try {
        ok = await exists(item);
      } catch {
        ok = false;
      }
      if (!ok) missing.push({ item, usedBy: usage.get(item.id) ?? 0 });
    }
    return missing;
  }

  private probeOf(file: File): Promise<CandidateProbe | null> {
    let cached = this.probeCache.get(file);
    if (!cached) {
      cached = this.probe(file).catch(() => null);
      this.probeCache.set(file, cached);
    }
    return cached;
  }

  private hashOf(file: File): Promise<string | null> {
    if (!this.hasher) return Promise.resolve(null);
    let cached = this.hashCache.get(file);
    if (!cached) {
      cached = this.hasher.computeSHA256(file).catch(() => null);
      this.hashCache.set(file, cached);
    }
    return cached;
  }

  /**
   * Scores one candidate.
   * @param item the offline entry.
   * @param candidate the file found by a scan.
   * @returns the scored candidate.
   */
  async scoreCandidate(item: MediaItem, candidate: ScannedFile): Promise<RelinkCandidate> {
    const name = nameScore(item.name || item.path, candidate.file.name);
    const probe = await this.probeOf(candidate.file);
    const breakdown: ScoreBreakdown = {
      name: Math.max(name, nameScore(item.path, candidate.file.name)),
      duration: durationScore(item.duration ?? null, probe?.duration ?? null, item.frameRate ?? 30),
      resolution: resolutionScore(item, probe),
      hash: null,
    };
    const expected = recordedHash(item);
    const size = recordedSize(item);
    // Hash only plausible candidates: same size when known, else a decent name.
    if (expected && this.hasher && (size === null ? breakdown.name >= 0.5 : size === candidate.file.size)) {
      const actual = await this.hashOf(candidate.file);
      breakdown.hash = actual === null ? null : actual === expected ? 1 : 0;
    } else if (expected && this.hasher && size !== null) {
      breakdown.hash = 0; // a different size can never hash the same
    }
    return { file: candidate.file, path: candidate.path, score: combineScore(breakdown), breakdown, hashMatch: breakdown.hash === 1 };
  }

  /**
   * Ranks every candidate for one entry.
   * @param item the offline entry.
   * @param files the scanned files.
   * @param limit how many to keep (default 5).
   * @returns candidates, best first.
   */
  async rankCandidates(item: MediaItem, files: readonly ScannedFile[], limit = 5): Promise<RelinkCandidate[]> {
    const kindOk = files.filter((f) => {
      const ext = extensionOf(f.file.name);
      return ext !== '' && (item.kind !== 'image' || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext));
    });
    const scored: RelinkCandidate[] = [];
    for (const file of kindOk) scored.push(await this.scoreCandidate(item, file));
    return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }

  /**
   * Matches every offline entry against the scanned files.
   * @param missing offline entries.
   * @param files scanned files.
   * @param onProgress done/total.
   * @returns the automatic assignments (score above threshold, each file
   *   used once) and the entries that need a human, with their candidates.
   */
  async match(
    missing: readonly MissingMedia[],
    files: readonly ScannedFile[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ auto: RelinkAssignment[]; manual: { missing: MissingMedia; candidates: RelinkCandidate[] }[] }> {
    const ranked: { missing: MissingMedia; candidates: RelinkCandidate[] }[] = [];
    for (const [index, entry] of missing.entries()) {
      ranked.push({ missing: entry, candidates: await this.rankCandidates(entry.item, files) });
      onProgress?.(index + 1, missing.length);
    }
    // Greedy by best score so two entries never claim one file.
    const claims = ranked
      .map((entry) => ({ entry, best: entry.candidates[0] }))
      .filter((c): c is { entry: typeof c.entry; best: RelinkCandidate } => c.best !== undefined && c.best.score > this.autoThreshold)
      .sort((a, b) => b.best.score - a.best.score);
    const used = new Set<File>();
    const auto: RelinkAssignment[] = [];
    const autoIds = new Set<string>();
    for (const { entry, best } of claims) {
      if (used.has(best.file)) continue;
      used.add(best.file);
      autoIds.add(entry.missing.item.id);
      auto.push({ mediaId: entry.missing.item.id, file: best.file, path: best.path, score: best.score });
    }
    const manual = ranked
      .filter((entry) => !autoIds.has(entry.missing.item.id))
      .map((entry) => ({ ...entry, candidates: entry.candidates.filter((c) => !used.has(c.file)) }));
    return { auto, manual };
  }

  /**
   * The undoable edit for a set of relinks.
   * @param assignments decided relinks.
   * @param hashes optional fresh digests by media id.
   * @returns one operation (compound when several).
   */
  buildOperation(assignments: readonly RelinkAssignment[], hashes: ReadonlyMap<string, string> = new Map()): EditOperation {
    const ops = assignments.map((a) => new RelinkMediaOperation(a.mediaId, {
      path: a.path,
      name: a.file.name,
      fileSize: a.file.size,
      sha256: hashes.get(a.mediaId) ?? null,
    }));
    return ops.length === 1 ? ops[0]! : new CompoundOperation('Volver a vincular medios', ops);
  }
}

/** File fields a relink rewrites. */
export interface RelinkPatch {
  path: string;
  name: string;
  fileSize: number;
  sha256: string | null;
}

/**
 * Points a media entry at a new file. Clips are untouched, so trims,
 * keyframes and effects survive. Inverse restores the exact previous entry.
 */
export class RelinkMediaOperation implements EditOperation {
  readonly name = 'RelinkMedia';
  readonly timestamp = Date.now();
  readonly mediaId: string;
  private readonly patch: RelinkPatch | null;
  private readonly restore: MediaItem | null;

  /**
   * @param mediaId the entry.
   * @param patch new file fields.
   * @param restore (internal) exact entry to put back — used by the inverse.
   */
  constructor(mediaId: string, patch: RelinkPatch | null, restore: MediaItem | null = null) {
    this.mediaId = mediaId;
    this.patch = patch;
    this.restore = restore ? structuredClone(restore) : null;
  }

  apply(doc: ProjectDocument): ProjectDocument {
    const index = doc.media.findIndex((item) => item.id === this.mediaId);
    if (index < 0) throw new EditError(`El medio ${this.mediaId} no existe`);
    const next = cloneDocument(doc);
    if (this.restore) {
      next.media[index] = structuredClone(this.restore);
      return next;
    }
    const patch = this.patch!;
    const item = next.media[index]!;
    const extra: JsonObject = { ...item.extra, [SIZE_KEY]: patch.fileSize, relinkedFrom: item.path };
    if (patch.sha256) extra[HASH_KEY] = patch.sha256;
    next.media[index] = { ...item, path: patch.path, name: patch.name, extra };
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const before = doc.media.find((item) => item.id === this.mediaId);
    if (!before) throw new EditError(`El medio ${this.mediaId} no existe`);
    return new RelinkMediaOperation(this.mediaId, null, before);
  }

  describe(): string {
    return `Volver a vincular ${this.mediaId}`;
  }
}
