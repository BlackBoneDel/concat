// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Relinking: offline detection, scoring, folder scans and SHA-256. */

export {
  HASH_CHUNK_SIZE,
  HashValidator,
  NATIVE_DIGEST_LIMIT,
  Sha256,
  computeSHA256Inline,
  sha256Native,
  sha256Stream,
  toHex,
} from './hash-validator.ts';
export {
  FolderScanner,
  acceptsFile,
  filterFileList,
  isHiddenName,
  pickDirectoryFallback,
  resolveScanOptions,
  walkDirectory,
  type DirectoryHandleLike,
  type FileHandleLike,
  type ResolvedScanOptions,
  type ScanOptions,
  type ScanProgress,
  type ScannedFile,
} from './folder-scanner.ts';
export { createScannerHandlers } from './scanner-handlers.ts';
export {
  AUTO_RELINK_THRESHOLD,
  HASH_KEY,
  RELINK_WEIGHTS,
  RelinkMediaOperation,
  Relinker,
  SIZE_KEY,
  baseName,
  combineScore,
  durationScore,
  levenshtein,
  nameScore,
  normalizedStem,
  recordedHash,
  recordedSize,
  resolutionScore,
  type CandidateProbe,
  type Hasher,
  type MissingMedia,
  type RelinkAssignment,
  type RelinkCandidate,
  type RelinkPatch,
  type RelinkerOptions,
  type ScoreBreakdown,
} from './relinker.ts';
