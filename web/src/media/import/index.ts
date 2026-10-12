// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Import: format support matrix, bulk importer, deep metadata. */

export * from './format-support.ts';
export {
  BulkImporter,
  checkConcurrency,
  groupLabel,
  type BulkImportEvent,
  type BulkImportOptions,
  type ImportClassification,
  type ImportGrouping,
  type ImportOne,
  type ImportSource,
} from './bulk-importer.ts';
export {
  MetadataExtractor,
  aspectRatio,
  needsProxy,
  parseMp4Atoms,
  readMp4Atoms,
  type DeepMetadata,
  type MetadataExtractorOptions,
  type Mp4Atoms,
} from './metadata-extractor.ts';
