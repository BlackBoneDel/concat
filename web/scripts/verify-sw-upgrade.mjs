#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Service-worker upgrade path, in a real Chromium: a visitor who has the
 * previous build installed receives the new one, and only the new caches
 * survive.
 *
 *   previous build (e.g. `git archive <old-sha> web` + `npx vite build`)  →  CONCAT_PREVIOUS_DIST
 *   current build  (`npm run build`)                                        →  web/dist
 *
 * The script serves the previous build under `/concat/`, lets the page
 * install its service worker, switches the server to the current build,
 * checks that the new worker waits instead of taking over, posts
 * `SKIP_WAITING` (what the «Recargar» banner does) and then checks that the
 * caches of the previous version have been deleted.
 *
 * Usage:
 *   CONCAT_PREVIOUS_DIST=/path/old/dist CONCAT_CHROMIUM=/path/chrome \
 *   CONCAT_PUPPETEER=/path/to/puppeteer-core.js node scripts/verify-sw-upgrade.mjs
 *
 * `puppeteer-core` is resolved the same way as in verify-production.mjs and is
 * not a dependency of the project.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CURRENT = process.env.CONCAT_DIST ? resolve(process.env.CONCAT_DIST) : resolve(HERE, '..', 'dist');
const PREVIOUS = process.env.CONCAT_PREVIOUS_DIST ? resolve(process.env.CONCAT_PREVIOUS_DIST) : '';
const PREFIX = '/concat/';
const PORT = Number(process.env.CONCAT_UPGRADE_PORT ?? 4291);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
};

if (!PREVIOUS || !existsSync(join(PREVIOUS, 'sw.js')) || !existsSync(join(CURRENT, 'sw.js'))) {
  console.error('Necesito CONCAT_PREVIOUS_DIST (build anterior) y un build actual con sw.js (npm run build).');
  process.exit(2);
}

async function loadPuppeteer() {
  for (const candidate of [process.env.CONCAT_PUPPETEER, 'puppeteer-core'].filter(Boolean)) {
    try {
      const module = await import(candidate);
      return module.default ?? module;
    } catch {
      // try the next one
    }
  }
  return null;
}

const puppeteer = await loadPuppeteer();
if (!puppeteer) {
  console.error('puppeteer-core no está disponible (ver la cabecera de este script).');
  process.exit(2);
}

// Which build the server is currently answering with.
let active = PREVIOUS;
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (url === '/__switch') {
    active = new URL(req.url ?? '/', 'http://x').searchParams.get('to') === 'current' ? CURRENT : PREVIOUS;
    res.end('ok');
    return;
  }
  if (!url.startsWith(PREFIX)) {
    res.writeHead(404);
    res.end('outside the sub-path');
    return;
  }
  let relative = url.slice(PREFIX.length);
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  const file = join(active, normalize(relative));
  if (!file.startsWith(active) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
});

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

await new Promise((done) => server.listen(PORT, '127.0.0.1', done));
const base = `http://127.0.0.1:${PORT}${PREFIX}`;
const browser = await puppeteer.launch({
  ...(process.env.CONCAT_CHROMIUM ? { executablePath: process.env.CONCAT_CHROMIUM } : {}),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const cacheKeys = () => page.evaluate(() => caches.keys());
const waitFor = (fn, timeout = 60000) => page.waitForFunction(fn, { timeout, polling: 500 });

try {
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const before = await cacheKeys();
  check('visitante con el build anterior: su caché existe', before.some((key) => key.startsWith('concat-web-')), JSON.stringify(before));

  // The new build is published: the browser looks for a new worker.
  await fetch(`http://127.0.0.1:${PORT}/__switch?to=current`);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((registration) => registration.update()));
  await waitFor(() => navigator.serviceWorker.getRegistration().then((registration) => Boolean(registration?.waiting)))
    .catch(() => undefined);
  const waiting = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting?.scriptURL ?? null);
  check('la versión nueva espera: no toma el control sin que el usuario lo pida', typeof waiting === 'string' && waiting.endsWith('/concat/sw.js'), String(waiting));
  const during = await cacheKeys();
  check('mientras espera, la caché anterior sigue viva', before.every((key) => during.includes(key)), JSON.stringify(during));

  // «Recargar» in the update banner.
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting?.postMessage({ type: 'SKIP_WAITING' }));
  await waitFor(() => navigator.serviceWorker.getRegistration().then((registration) => !registration?.waiting && Boolean(registration?.active)))
    .catch(() => undefined);
  await new Promise((done) => setTimeout(done, 1500));
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const after = await cacheKeys();
  const version = /-v(\d+)-/.exec(after[0] ?? '')?.[1];
  check('tras activar: solo quedan cachés de la versión nueva', after.length > 0 && after.every((key) => key.includes(`-v${version}-`)) && !after.some((key) => before.includes(key)), JSON.stringify(after));
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  check('la página nueva la controla el service worker', controlled);
  check('sin errores de página durante la actualización', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} comprobaciones`);
process.exit(passed === results.length ? 0 : 1);
