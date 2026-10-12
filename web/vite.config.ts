// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Local-only by design: the whole app runs in the user's browser and this
// dev server binds to 0.0.0.0 so sandboxed previews can reach it. No CDN,
// no analytics, no external requests from the app itself.
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The Arena live preview runs under *.e2b.app; accept it alongside
    // localhost. The app itself still talks to nothing but itself.
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
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
