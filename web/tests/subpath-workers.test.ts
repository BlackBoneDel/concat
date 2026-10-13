// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name === 'vendor') return [];
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

it('every Worker uses a literal new URL(relative source, import.meta.url) and module type', () => {
  let workers = 0;
  for (const file of sources(resolve('src'))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'Worker') {
        workers++;
        const url = node.arguments?.[0];
        expect(url && ts.isNewExpression(url), file).toBe(true);
        if (!url || !ts.isNewExpression(url)) return;
        expect(url.expression.getText(source), file).toBe('URL');
        const path = url.arguments?.[0];
        expect(path && ts.isStringLiteral(path), file).toBe(true);
        if (!path || !ts.isStringLiteral(path)) return;
        expect(path.text, file).toMatch(/^\.\.?\//);
        expect(existsSync(resolve(dirname(file), path.text)), file).toBe(true);
        expect(url.arguments?.[1]?.getText(source), file).toBe('import.meta.url');
        expect(node.arguments?.[1]?.getText(source), file).toMatch(/type:\s*['"]module['"]/);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(workers).toBeGreaterThanOrEqual(8);
});
