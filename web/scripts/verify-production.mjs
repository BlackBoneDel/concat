#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Production verification of the editor, served as GitHub Pages serves it:
 * `web/dist` under the `/concat/` sub-path, in a real Chromium.
 *
 * `npm test` runs in jsdom, where there is no `<video>`, no OPFS, no service
 * worker and no real `DataTransfer` — everything import-related is a double
 * there. This script is the check that the *built* app works where the bugs
 * were reported: relative worker URLs, the base-path service worker, the
 * persistent file input, the window-wide drop, the library cards and the
 * timeline drop.
 *
 * Usage:
 *   cd web
 *   npm run build
 *   CONCAT_CHROMIUM=/path/to/chrome node scripts/verify-production.mjs
 *
 * `puppeteer-core` is imported on demand and is deliberately **not** a
 * dependency of the project (it would pull a driver into every `npm ci` for
 * a check that only release verification runs). Install it next to the repo
 * (`npm i --no-save puppeteer-core`) or point `CONCAT_PUPPETEER` at an
 * existing installation.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIST = resolve(HERE, '..', 'dist');
const PREFIX = '/concat/';
const PORT = Number(process.env.CONCAT_E2E_PORT ?? 4183);

/** Content types for the handful of extensions the build emits. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const results = [];
let failures = 0;

/** Records one check. */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** A tiny static server that refuses to serve anything outside `PREFIX`. */
function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (!url.startsWith(PREFIX)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`outside ${PREFIX}: ${url}`);
      return;
    }
    let relative = url.slice(PREFIX.length);
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const file = join(DIST, normalize(relative));
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`not found: ${url}`);
      return;
    }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('content-length', String(statSync(file).size));
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('service-worker-allowed', PREFIX);
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(PORT, '0.0.0.0', () => done(server)));
}

/** Loads puppeteer-core from wherever it can be found. */
async function loadPuppeteer() {
  const candidates = [process.env.CONCAT_PUPPETEER, 'puppeteer-core', 'puppeteer'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const module = await import(candidate);
      return module.default ?? module;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

/** The fixtures the checks import: real files on disk and blobs in the page. */
async function makeFixtures(page, dir) {
  return page.evaluate(async () => {
    /** Records a canvas for `seconds` and returns the blob. */
    const record = async (mimeType, seconds) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      let ac = null;
      let osc = null;
      if (mimeType.includes('webm')) {
        ac = new AudioContext();
        osc = ac.createOscillator();
        const dest = ac.createMediaStreamDestination();
        osc.frequency.value = 440;
        osc.connect(dest);
        osc.start();
        for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
      const start = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          const t = (performance.now() - start) / 1000;
          ctx.fillStyle = `hsl(${(t * 90) % 360} 80% 50%)`;
          ctx.fillRect(0, 0, 320, 180);
          ctx.fillStyle = '#000';
          ctx.font = '20px sans-serif';
          ctx.fillText(`t=${t.toFixed(1)}`, 12, 100);
          if (t < seconds) requestAnimationFrame(tick);
          else resolve();
        };
        tick();
      });
      recorder.stop();
      await new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      if (osc) osc.stop();
      if (ac) await ac.close();
      return new Blob(chunks, { type: mimeType });
    };

    /** A 1-second 44.1 kHz mono WAV. */
    const wav = (seconds = 1) => {
      const rate = 44100;
      const frames = rate * seconds;
      const buffer = new ArrayBuffer(44 + frames * 2);
      const view = new DataView(buffer);
      const ascii = (at, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      view.setUint32(4, 36 + frames * 2, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      ascii(36, 'data');
      view.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i += 1) view.setInt16(44 + i * 2, Math.sin((i / rate) * 440 * 2 * Math.PI) * 20000, true);
      return new Blob([buffer], { type: 'audio/wav' });
    };

    const fixtures = {
      webm: await record('video/webm;codecs="vp8,opus"', 2),
      wav: wav(1),
      mp4: MediaRecorder.isTypeSupported('video/mp4;codecs="avc1.42E01E"')
        ? await record('video/mp4;codecs="avc1.42E01E"', 2)
        : null,
      mp4av1: MediaRecorder.isTypeSupported('video/mp4;codecs="av01.0.04M.08"')
        ? await record('video/mp4;codecs="av01.0.04M.08"', 2)
        : null,
    };
    window.__concatE2e = { blobs: fixtures, bytes: {} };
    for (const [name, blob] of Object.entries(fixtures)) {
      if (blob) window.__concatE2e.bytes[name] = [...new Uint8Array(await blob.arrayBuffer())];
    }
    return {
      webm: fixtures.webm?.size ?? 0,
      wav: fixtures.wav?.size ?? 0,
      mp4: fixtures.mp4?.size ?? 0,
      mp4av1: fixtures.mp4av1?.size ?? 0,
    };
  });
}

/** Writes the fixture blobs to disk so the picker can be driven with real files. */
async function writeFixtures(page, dir, sizes) {
  const bytes = await page.evaluate(() => window.__concatE2e.bytes);
  const paths = {};
  for (const [name, data] of Object.entries(bytes)) {
    const path = join(dir, `${name}.${name === 'wav' ? 'wav' : name.startsWith('mp4') ? 'mp4' : 'webm'}`);
    writeFileSync(path, Buffer.from(data));
    paths[name] = path;
  }
  writeFileSync(join(dir, 'vacio.mp4'), Buffer.alloc(0));
  writeFileSync(join(dir, 'notas.exe'), Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]));
  paths.empty = join(dir, 'vacio.mp4');
  paths.garbage = join(dir, 'notas.exe');
  for (const size of Object.values(sizes)) check('fixture generado', size > 0, `${size} bytes`);
  return paths;
}

/** Imports files by driving the persistent input (`change` → app). */
async function importThroughInput(page, paths) {
  await page.evaluate(() => {
    window.__concatE2e.cards = document.querySelectorAll('.media-card').length;
  });
  const element = await page.$('#concat-global-file-input');
  if (!element) return false;
  await element.uploadFile(...paths);
  return true;
}

/** Waits for a predicate evaluated in the page. */
async function waitFor(page, fn, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The library's visible state. */
const CARDS = () => ({
  cards: [...document.querySelectorAll('.media-card')].map((card) => ({
    name: card.querySelector('.media-name')?.textContent ?? '',
    detail: card.querySelector('.media-detail')?.textContent ?? '',
    status: card.dataset.status ?? '',
    thumb: card.querySelector('.media-thumb img')?.getAttribute('src')?.slice(0, 12) ?? '',
  })),
  toasts: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent ?? ''),
});

async function main() {
  if (!existsSync(DIST)) {
    console.error(`No hay build en ${DIST}: ejecuta \`npm run build\` antes.`);
    process.exit(2);
  }
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) {
    console.error('puppeteer-core no está disponible (ver la cabecera de este script).');
    process.exit(2);
  }
  const executablePath = process.env.CONCAT_CHROMIUM;
  const server = await serve();
  const url = `http://127.0.0.1:${PORT}${PREFIX}`;
  const dir = mkdtempSync(join(tmpdir(), 'concat-e2e-'));

  const browser = await puppeteer.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()} :: ${request.failure()?.errorText}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`);
  });

  try {
    // (1) The app loads under /concat/ with no 404s.
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    check('la app arranca bajo /concat/ sin errores de arranque', (await page.$('.boot-error')) === null);
    check('el shell monta (paneles de medios y timeline)', (await page.$('#media-panel')) !== null && (await page.$('#timeline-panel')) !== null);
    check('no hay 404 ni peticiones fallidas', problems.length === 0, problems.join(' | '));

    // (2) The service worker: scope, cache schema, blob bypass.
    const sw = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const keys = await caches.keys();
      return { scope: registration?.scope ?? null, active: registration?.active?.scriptURL ?? null, keys };
    });
    check('el service worker se registra con scope /concat/', sw.scope === `${url}` && (sw.active ?? '').endsWith('/concat/sw.js'), JSON.stringify(sw));
    check('el esquema de caché es v9', sw.keys.every((key) => key.includes('-v9-')), sw.keys.join(', '));
    const swSource = await (await fetch(`${url}sw.js`)).text();
    check('sw.js no cachea esquemas locales (blob:/data:/file:)', /CACHEABLE_PROTOCOLS/.test(swSource) && /includes\(url\.protocol\)/.test(swSource));
    check('sw.js no cachea respuestas de error', /response\.ok && response\.status === 200/.test(swSource));

    // (3) Fixtures + the persistent input.
    const sizes = await makeFixtures(page, dir);
    const paths = await writeFixtures(page, dir, sizes);
    const input = await page.$('#concat-global-file-input');
    check('el input global existe en el DOM', input !== null);
    const accept = (await page.$eval('#concat-global-file-input', (node) => node.getAttribute('accept'))) ?? '';
    check('el input global acepta vídeo, audio e imagen', accept.includes('video/*') && accept.includes('audio/*') && accept.includes('.mp4') && accept.includes('.mp3'));

    // (4) The Import button opens *that* input (no detached node).
    const picker = await page.evaluate(() => {
      const before = document.querySelectorAll('input[type=file]').length;
      const button = [...document.querySelectorAll('button')].find((node) => /Importar/.test(node.textContent ?? ''));
      let clicked = false;
      const input = document.getElementById('concat-global-file-input');
      const original = input.click.bind(input);
      input.click = () => {
        clicked = true;
      };
      button?.click();
      input.click = original;
      return { clicked, before, after: document.querySelectorAll('input[type=file]').length };
    });
    check('el botón Importar abre el input persistente del DOM', picker.clicked && picker.after === 1, JSON.stringify(picker));

    // (5) Video import through the picker: card, metadata, thumbnail, latency.
    // The clock starts on the capture phase of the picker's own `change`
    // event, so the measurement is the app's work — not the CDP round trip.
    await page.evaluate(() => {
      window.__concatE2e.latency = null;
      window.__concatE2e.firstStatus = null;
      document.addEventListener(
        'change',
        () => {
          const start = performance.now();
          const observer = new MutationObserver(() => {
            const card = document.querySelector('.media-card');
            if (card && window.__concatE2e.latency === null) {
              window.__concatE2e.latency = performance.now() - start;
              window.__concatE2e.firstStatus = card.getAttribute('data-status');
              observer.disconnect();
            }
          });
          observer.observe(document.getElementById('media-panel'), { childList: true, subtree: true });
        },
        true,
      );
    });
    await importThroughInput(page, [paths.webm]);
    const latency = await page.evaluate(() => window.__concatE2e.latency);
    const firstStatus = await page.evaluate(() => window.__concatE2e.firstStatus);
    check('la tarjeta aparece en menos de 10 ms (optimista)', latency !== null && latency < 10, `${latency?.toFixed?.(2)} ms`);
    check('la tarjeta nace en estado «processing» (sin esperar a la sonda)', firstStatus === 'processing', String(firstStatus));
    const webmReady = await waitFor(page, () => {
      const card = document.querySelector('.media-card');
      return card?.dataset.status === 'ready' && /\d+×\d+/.test(card.querySelector('.media-detail')?.textContent ?? '');
    });
    check('el WebM se enriquece con duración y tamaño reales', webmReady, JSON.stringify((await page.evaluate(CARDS)).cards));
    const thumb = await page.$eval('.media-card .media-thumb img', (node) => node.getAttribute('src') ?? '');
    check('el WebM acaba con miniatura real (blob:) o placeholder', thumb.startsWith('blob:') || thumb.startsWith('data:image/svg'), thumb.slice(0, 24));

    // (6) MP4 (H.264 when the build of Chromium can encode it) and audio.
    if (sizes.mp4 > 0) {
      await importThroughInput(page, [paths.mp4]);
      const mp4Ready = await waitFor(
        page,
        () => [...document.querySelectorAll('.media-card')].some((card) => card.dataset.status === 'ready' && /mp4/.test(card.querySelector('.media-name')?.textContent ?? '')),
      );
      check('el MP4 importa con metadatos', mp4Ready, JSON.stringify((await page.evaluate(CARDS)).cards));
    }
    await importThroughInput(page, [paths.wav]);
    const wavReady = await waitFor(
      page,
      () => [...document.querySelectorAll('.media-card')].some((card) => card.dataset.status === 'ready' && /^1\.0s · audio$/.test(card.querySelector('.media-detail')?.textContent ?? '')),
    );
    check('el WAV importa con duración real y sin «0×0»', wavReady, JSON.stringify((await page.evaluate(CARDS)).cards));

    // (7) Empty and non-media files: toast, and never a card.
    const beforeBad = (await page.evaluate(CARDS)).cards.length;
    await importThroughInput(page, [paths.empty, paths.garbage]);
    await waitFor(page, () => [...document.querySelectorAll('.toast')].length > 0, 5000);
    await new Promise((r) => setTimeout(r, 1200));
    const afterBad = await page.evaluate(CARDS);
    const toastText = afterBad.toasts.join(' | ');
    check('un archivo vacío avisa y no crea tarjeta', /vacío/i.test(toastText) && afterBad.cards.length === beforeBad, toastText);
    check('un archivo no-media avisa y no crea tarjeta', /no compatible/i.test(toastText) && afterBad.cards.length === beforeBad, toastText);

    // (8) Media card → timeline (the reported "el clip no aparece").
    const drag = await page.evaluate(async () => {
      const card = [...document.querySelectorAll('.media-card')].find((node) => /webm/.test(node.querySelector('.media-name')?.textContent ?? ''));
      if (!card) return { error: 'sin tarjeta de vídeo' };
      const transfer = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      const types = [...transfer.types];
      const timeline = document.getElementById('timeline-panel');
      const rect = timeline.getBoundingClientRect();
      const options = { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: rect.left + 220, clientY: rect.top + 60 };
      timeline.dispatchEvent(new DragEvent('dragenter', options));
      timeline.dispatchEvent(new DragEvent('dragover', options));
      timeline.dispatchEvent(new DragEvent('drop', options));
      card.dispatchEvent(new DragEvent('dragend', { dataTransfer: transfer, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { types, clips: [...document.querySelectorAll('.tl-clip-list li')].map((node) => node.textContent) };
    });
    check('el dragstart publica application/x-concat-media', (drag.types ?? []).includes('application/x-concat-media'), JSON.stringify(drag.types));
    check('el drop en la timeline inserta un clip visible', (drag.clips ?? []).length === 1, JSON.stringify(drag.clips));

    // (9) An audio card dropped on a video lane lands on an audio lane.
    const audioDrag = await page.evaluate(async () => {
      const card = [...document.querySelectorAll('.media-card')].find((node) => /wav/.test(node.querySelector('.media-name')?.textContent ?? ''));
      if (!card) return { error: 'sin tarjeta de audio' };
      const transfer = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      const timeline = document.getElementById('timeline-panel');
      const rect = timeline.getBoundingClientRect();
      const options = { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: rect.left + 160, clientY: rect.top + 60 };
      for (const type of ['dragenter', 'dragover', 'drop']) timeline.dispatchEvent(new DragEvent(type, options));
      card.dispatchEvent(new DragEvent('dragend', { dataTransfer: transfer, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { clips: [...document.querySelectorAll('.tl-clip-list li')].map((node) => node.textContent) };
    });
    check('el audio cae en una pista de audio (no falla)', (audioDrag.clips ?? []).length === 2, JSON.stringify(audioDrag));

    // (10) Play: the transport answers, the timecode advances and *both*
    // playhead elements follow (the panel's line and the view's).
    const played = await page.evaluate(async () => {
      const play = document.querySelector('.transport-play');
      if (!play) return { error: 'sin botón de play' };
      const left = () => ({
        line: Math.round(document.querySelector('.tl-playhead-line')?.getBoundingClientRect().left ?? -1),
        view: Math.round(document.querySelector('.tl-playhead')?.getBoundingClientRect().left ?? -1),
        timecode: document.querySelector('.timecode-input')?.value ?? '',
      });
      const before = left();
      play.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      const during = left();
      play.click();
      return { before, during };
    });
    const movedBoth =
      played.during !== undefined &&
      played.during.line !== played.before.line &&
      played.during.view === played.during.line;
    check('el play responde: tiempo y playhead avanzan (ambas líneas alineadas)', movedBoth === true, JSON.stringify(played));

    // (11) A dropped OS file anywhere in the app imports.
    const backgroundDrop = await page.evaluate(async () => {
      const bytes = window.__concatE2e.bytes.webm;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'fondo.webm', { type: 'video/webm' }));
      const options = { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: 600, clientY: 300 };
      const app = document.getElementById('app');
      for (const type of ['dragenter', 'dragover']) app.dispatchEvent(new DragEvent(type, options));
      const overlay = document.getElementById('concat-drop-overlay');
      const overlayVisible = document.getElementById('concat-drop-overlay')?.classList.contains('is-visible') ?? false;
      app.dispatchEvent(new DragEvent('drop', options));
      await new Promise((resolve) => setTimeout(resolve, 800));
      const names = [...document.querySelectorAll('.media-name')].map((node) => node.textContent);
      return { overlayVisible, overlayExists: !!overlay, names };
    });
    check('el overlay «Suelta los archivos…» aparece al arrastrar', backgroundDrop.overlayExists && backgroundDrop.overlayVisible === true);
    check('soltar un archivo sobre el fondo de la app lo importa (una sola vez)', backgroundDrop.names.filter((n) => n === 'fondo.webm').length === 1, JSON.stringify(backgroundDrop.names));

    // (12) Reload with the service worker controlling the page and repeat.
    await page.reload({ waitUntil: 'networkidle2' });
    const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    check('tras recargar, el service worker controla la página', controlled);
    const restored = await waitFor(page, () => document.querySelectorAll('.media-card').length >= 4, 20000);
    check('la biblioteca se restaura desde OPFS/IDB tras recargar', restored, JSON.stringify((await page.evaluate(CARDS)).cards));
    const afterReloadProblems = problems.length;
    const freshDrop = await page.evaluate(async () => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'tras-sw.mp4', { type: 'video/mp4' }));
      const options = { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: 400, clientY: 400 };
      document.getElementById('app').dispatchEvent(new DragEvent('drop', options));
      await new Promise((resolve) => setTimeout(resolve, 800));
      return [...document.querySelectorAll('.media-name')].map((node) => node.textContent);
    });
    check('con el SW activo los imports siguen llegando', freshDrop.includes('tras-sw.mp4'), JSON.stringify(freshDrop));
    check('recargar con SW no rompe rutas ni pide 404', problems.length === afterReloadProblems, problems.slice(afterReloadProblems).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('');
  console.log(`${results.length - failures}/${results.length} comprobaciones en ${url}`);
  if (problems.length > 0) console.log(`Avisos de red/consola: ${problems.join(' | ')}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
