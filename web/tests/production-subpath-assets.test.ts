// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Parte B5/C — the production sub-path contract.
 *
 * `blackbonedel.github.io/concat/` serves the app from a **sub-path**, not from
 * the domain root. Every absolute `/asset.js`, `/ffmpeg-core.wasm` or
 * `new Worker('/worker.js')` is a 404 there, and a service worker registered at
 * the wrong scope stops controlling the page on the next hard reload.
 *
 * `tests/subpath-workers.test.ts` already walks the AST of every `new Worker`
 * (relative literal + `type: 'module'` + the file exists). This suite covers
 * the rest of the contract: the Vite base, the vendored FFmpeg URLs, the SW
 * registration, the SW's own bypass/caching rules and the static HTML/manifest
 * that ship with the build. If a future refactor reintroduces an absolute path,
 * one of these tests turns red before the deploy does.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB = resolve('.');
const read = (path: string): string => readFileSync(resolve(WEB, path), 'utf8');

/** Every `.ts`/`.tsx` under `src` (vendored code excluded). */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name === 'vendor') return [];
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const SRC_FILES = sources(resolve(WEB, 'src'));

describe('base de Vite y rutas del sub-path', () => {
  it("vite declara base: './' (el build se sirve bajo /concat/)", () => {
    const config = read('vite.config.ts');
    expect(config).toMatch(/base:\s*'\.\/'/);
    expect(config).not.toMatch(/base:\s*'\/'/);
  });

  it('ninguna URL literal absoluta de assets en src/', () => {
    // Only real string literals count: the file headers legitimately *describe*
    // the vendored `/vendor/ffmpeg/` directory in prose.
    const forbidden = /^\/(assets|workers?|vendor|icons|src|ffmpeg)\//;
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) && forbidden.test(node.text)) offenders.push(`${file}: ${node.text}`);
        if (ts.isNoSubstitutionTemplateLiteral(node) && forbidden.test(node.text)) offenders.push(`${file}: ${node.text}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });

  it('ningún Worker se construye desde una ruta absoluta', () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node) && node.expression.getText(source) === 'Worker') {
          const first = node.arguments?.[0];
          if (first && ts.isStringLiteral(first) && first.text.startsWith('/')) offenders.push(`${file}:${first.text}`);
        }
        // `new URL('/x', base)` throws away the sub-path: guard it too.
        if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL') {
          const first = node.arguments?.[0];
          if (first && ts.isStringLiteral(first) && first.text.startsWith('/')) offenders.push(`${file}:URL ${first.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });

  it('las URLs del core vendido de FFmpeg salen de import.meta.env.BASE_URL', () => {
    const source = read('src/media/ffmpeg/ffmpeg-fallback.ts');
    expect(source).toContain('import.meta.env.BASE_URL');
    // Never a hard-coded absolute core path in a string literal (the header
    // comment is prose, so parse instead of grepping).
    const ast = ts.createSourceFile('ffmpeg-fallback.ts', source, ts.ScriptTarget.Latest, true);
    const absolutes: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && node.text.startsWith('/vendor/')) absolutes.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(absolutes).toEqual([]);
  });

  it('el index.html enlaza todo en relativo', () => {
    const html = read('index.html');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]!);
    expect(urls.length).toBeGreaterThan(2);
    for (const url of urls) {
      expect(url.startsWith('/'), url).toBe(false);
    }
    expect(html).toContain('src="./src/main.ts"');
  });

  it('el manifest usa alcance y start_url relativos', () => {
    const manifest = JSON.parse(read('public/manifest.json')) as {
      start_url: string;
      scope: string;
      id: string;
      icons: { src: string }[];
    };
    expect(manifest.start_url.startsWith('/')).toBe(false);
    expect(manifest.scope.startsWith('/')).toBe(false);
    expect(manifest.id.startsWith('/')).toBe(false);
    for (const icon of manifest.icons) expect(icon.src.startsWith('/'), icon.src).toBe(false);
  });

  it('el build, cuando existe, no deja rutas absolutas ni placeholders', () => {
    if (!existsSync(resolve(WEB, 'dist/index.html'))) return;
    const html = read('dist/index.html');
    expect(html).toMatch(/(?:src|href)="\.\/assets\//);
    expect(html).not.toMatch(/(?:src|href)="\/assets\//);
    expect(html).not.toMatch(/\/src\/main\.ts/);
    const sw = read('dist/sw.js');
    expect(sw).not.toContain('__CONCAT_BUILD_ID__');
    expect(sw).toContain('CACHEABLE_PROTOCOLS');
  });
});

describe('service worker: registro y reglas de caché', () => {
  it('se registra en ${BASE_URL}sw.js con el scope del sub-path', () => {
    const source = read('src/pwa/sw-register.ts');
    expect(source).toContain('${baseUrl}sw.js');
    expect(source).toMatch(/scope:\s*baseUrl/);
    expect(source).toContain('import.meta.env.BASE_URL');
  });

  it('la versión de caché del registro coincide con la del sw.js', () => {
    const register = read('src/pwa/sw-register.ts');
    const declared = register.match(/export const SW_CACHE_VERSION = '([^']+)'/)?.[1];
    expect(declared).toBe('v9');
    const sw = read('public/sw.js');
    expect(sw).toMatch(new RegExp(`const CACHE_VERSION = '${declared}'`));
    expect(sw).toContain('concat-web-${CACHE_VERSION}-${BUILD_ID}');
  });

  it('el sw ignora blob:/data:/file:/chrome-extension: (los medios no entran en la caché)', () => {
    const sw = read('public/sw.js');
    expect(sw).toMatch(/CACHEABLE_PROTOCOLS\s*=\s*\[\s*'http:',\s*'https:'\s*\]/);
    expect(sw).toMatch(/if \(!CACHEABLE_PROTOCOLS\.includes\(url\.protocol\)\) return;/);
    // The bypass must sit *before* the origin test, or blob: (same origin) leaks in.
    const bypass = sw.indexOf('CACHEABLE_PROTOCOLS.includes(url.protocol)');
    const origin = sw.indexOf('url.origin !== self.location.origin');
    expect(bypass).toBeGreaterThan(-1);
    expect(origin).toBeGreaterThan(bypass);
  });

  it('nunca cachea 404/500 ni respuestas parciales', () => {
    const sw = read('public/sw.js');
    expect(sw).toMatch(/response\.ok && response\.status === 200/);
    expect(sw).toMatch(/request\.headers\.has\('range'\)/);
    expect(sw).toMatch(/request\.method !== 'GET'/);
  });

  it('toma el control de la página nueva y libera la vieja (skipWaiting + clients.claim)', () => {
    const sw = read('public/sw.js');
    expect(sw).toContain('clients.claim()');
    expect(sw).toContain('skipWaiting');
    expect(sw).toMatch(/SKIP_WAITING/);
  });

  it('la activación borra solo las cachés de este proyecto', () => {
    const sw = read('public/sw.js');
    expect(sw).toMatch(/key\.startsWith\('concat-'\)/);
  });
});

describe('Parte B · el cableado del import está instalado en main.ts', () => {
  const main = read('src/main.ts');

  it('main instala el capturador global y el input de archivos persistente', () => {
    expect(main).toContain('installGlobalDrop(');
    expect(main).toContain('installGlobalFileInput(');
    expect(main).toContain('installFileDrop(');
    expect(main).toContain('installDropGuard()');
  });

  it('las tres rutas acaban en importFiles (una sola puerta de entrada)', () => {
    for (const call of ['installGlobalDrop', 'installGlobalFileInput', 'installFileDrop']) {
      const at = main.indexOf(`${call}(`);
      expect(at, call).toBeGreaterThan(-1);
      const slice = main.slice(at, at + 400);
      expect(slice, call).toContain('importFiles(');
    }
  });

  it('el botón del panel de medios y la cabecera abren el input persistente', () => {
    const source = read('src/ui/media-panel.ts');
    expect(source).toContain('openGlobalFileInput');
    expect(main).toContain("addEventListener('open-import'");
  });
});
