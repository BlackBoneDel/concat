// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/// <reference types="vitest/config" />
import { createReadStream, cpSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** Where vendored third-party runtime files live (FFmpeg.wasm, …). */
const VENDOR_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/vendor');

/** Content types of the vendored files. */
const VENDOR_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * Serves `src/vendor/**` verbatim at `/vendor/**` in dev and copies it to
 * `dist/vendor/` on build — so FFmpeg.wasm loads from the app's own origin
 * (never a CDN) and is never transformed or inlined by the bundler.
 */
function vendorAssets(): Plugin {
  let outDir = 'dist';
  let building = false;
  return {
    name: 'concat-vendor-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      // Vitest also "closes the bundle" (with a dummy outDir): copy only on real builds.
      building = config.command === 'build' && !process.env['VITEST'];
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        const at = url.indexOf('/vendor/');
        if (at < 0) {
          next();
          return;
        }
        const relative = normalize(decodeURIComponent(url.slice(at + '/vendor/'.length)));
        const file = join(VENDOR_DIR, relative);
        if (!file.startsWith(VENDOR_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', VENDOR_TYPES[extname(file)] ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(file).size));
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (building && existsSync(VENDOR_DIR)) cpSync(VENDOR_DIR, join(outDir, 'vendor'), { recursive: true });
    },
  };
}

// Local-only by design: the whole app runs in the user's browser and this
// dev server binds to 0.0.0.0 so sandboxed previews can reach it. No CDN,
// no analytics, no external requests from the app itself.
export default defineConfig({
  base: './',
  plugins: [vendorAssets()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The Arena live preview runs under *.e2b.app; accept it alongside
    // localhost. The app itself still talks to nothing but itself.
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
