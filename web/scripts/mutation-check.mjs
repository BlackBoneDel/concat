#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Mutation check of the import/timeline guards.
 *
 * A green suite only proves that the tests pass on the code as written. This
 * script removes one guard at a time from the source, runs the tests that are
 * supposed to protect it, and requires them to go red. Every source file is
 * restored after each mutation, even when the run throws.
 *
 *   cd web && node scripts/mutation-check.mjs
 *
 * Exit code 0 means every mutation was caught and the baseline was green.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** One guard, the exact text that implements it, what replaces it, and the tests that must catch it. */
const MUTATIONS = [
  {
    id: 'M1',
    what: 'Quitar la guarda de currentTime no finito (seekElement)',
    file: 'src/media/decoder.ts',
    from: 'const target = Number.isFinite(time) && time > 0 ? time : 0;',
    to: 'const target = time;',
    tests: ['tests/import-production-bulletproof.test.ts'],
  },
  {
    id: 'M2',
    what: 'Quitar preventDefault en el drop global',
    file: 'src/ui/global-drop.ts',
    from: '      event.preventDefault();\n      event.stopPropagation();\n      mine.add(event);',
    to: '      event.stopPropagation();\n      mine.add(event);',
    tests: ['tests/global-drop-and-file-input.test.ts'],
  },
  {
    id: 'M3',
    what: 'Quitar preventDefault en el dragover global',
    file: 'src/ui/global-drop.ts',
    from: "      event.preventDefault();\n      event.stopPropagation();\n      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';",
    to: "      event.stopPropagation();\n      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';",
    tests: ['tests/global-drop-and-file-input.test.ts'],
  },
  {
    id: 'M4',
    what: 'No insertar el clip al soltar una tarjeta sobre el timeline (insertClipFromMedia)',
    file: 'src/ui/timeline-panel.ts',
    from: 'const clipId = session.insertClipFromMedia(payload.mediaId, trackId, atTime, mode, {',
    to: "const clipId = ((..._a: unknown[]) => 'x')(payload.mediaId, trackId, atTime, mode, {",
    tests: ['tests/drag-drop-timeline.test.ts', 'tests/timeline-dnd-media.test.ts'],
  },
  {
    id: 'M5',
    what: 'Quitar la redirección audio ↔ vídeo a una pista compatible',
    file: 'src/ui/timeline/media-drop.ts',
    from: 'if (trackId !== null && options.trackKind && kindOf(trackId) !== wanted) {',
    to: 'if (trackId !== null && false) {',
    tests: ['tests/drag-drop-timeline.test.ts', 'tests/timeline-dnd-media.test.ts'],
  },
  {
    id: 'M6',
    what: 'Quitar view.updatePlayhead() del bucle rAF (playhead de la vista parado)',
    file: 'src/ui/timeline-panel.ts',
    from: '      this.view.updatePlayhead();\n      if (x < 0',
    to: '      void 0;\n      if (x < 0',
    tests: ['tests/timeline-dnd-media.test.ts'],
  },
];

/** Runs vitest on the given files and returns the names of the failing tests. */
function runTests(files) {
  const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files], {
    cwd: WEB,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const failed = [...new Set([...output.matchAll(/^ FAIL\s+(.+)$/gm)].map((match) => match[1].trim()))];
  return { status: run.status, failed };
}

const allTests = [...new Set(MUTATIONS.flatMap((mutation) => mutation.tests))];
const baseline = runTests(allTests);
console.log(`BASELINE  exit=${baseline.status}  fallos=${baseline.failed.length}`);
let allCaught = baseline.status === 0;

for (const mutation of MUTATIONS) {
  const path = resolve(WEB, mutation.file);
  const original = readFileSync(path, 'utf8');
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    console.log(`${mutation.id}  el texto a mutar aparece ${occurrences} veces (se esperaba 1): ${mutation.file}`);
    allCaught = false;
    continue;
  }
  let result;
  try {
    writeFileSync(path, original.replace(mutation.from, mutation.to), 'utf8');
    result = runTests(mutation.tests);
  } finally {
    writeFileSync(path, original, 'utf8');
  }
  const caught = result.status !== 0 && result.failed.length > 0;
  allCaught &&= caught;
  console.log(`${mutation.id}  ${caught ? 'CAZADA' : 'NO CAZADA'}  ${mutation.what}  (${result.failed.length} tests rojos)`);
  for (const name of result.failed) console.log(`        ✗ ${name}`);
}

console.log(allCaught ? '\nTodas las mutaciones cazadas y la base en verde.' : '\nAlguna mutación sobrevivió o la base no está en verde.');
process.exit(allCaught ? 0 : 1);
