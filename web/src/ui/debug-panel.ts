// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 7+: the `?debug=1` diagnostics panel.
 *
 * Import problems in the wild are browser problems (Safari without
 * `createWritable`, WebM without a duration, a stale service-worker cache,
 * IndexedDB blocked in private mode). Loading the app with `?debug=1`
 * mounts a floating panel that reports exactly that: engine, codec
 * capabilities, WebCodecs, OPFS, IndexedDB, the storage estimate, the
 * service worker and its cache keys — everything support needs in one
 * screenshot. All environment access goes through {@link DebugEnvironment}
 * so the panel is testable in node/jsdom.
 */

import { detectCapabilities, type EngineName, type PlayTypeProbe } from '../media/import/format-support.ts';
import { SW_CACHE_VERSION } from '../pwa/sw-register.ts';

/** Whether the diagnostics panel should mount for this query string. */
export function debugEnabled(search: string): boolean {
  try {
    return new URLSearchParams(search).get('debug') === '1';
  } catch {
    return false;
  }
}

/**
 * The engine a user-agent string describes.
 * @param userAgent `navigator.userAgent`.
 * @returns `firefox`, `chromium` or `safari` (Chromium is the default).
 */
export function detectEngineName(userAgent: string): EngineName {
  if (/Firefox\//.test(userAgent)) return 'firefox';
  // Chrome and Edge both carry `Chrome/`; Safari never does.
  if (/Chrome\/|Chromium\//.test(userAgent)) return 'chromium';
  if (/Safari\//.test(userAgent)) return 'safari';
  return 'chromium';
}

/** The slice of `navigator.storage` the panel reads. */
export interface DebugStorageManager {
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  getDirectory?(): Promise<unknown>;
}

/** The slice of the service-worker container the panel reads. */
export interface DebugServiceWorker {
  controller: unknown;
  getRegistrations?(): Promise<unknown[]>;
}

/** Everything the panel probes, injectable for tests. */
export interface DebugEnvironment {
  userAgent: string;
  /** A `canPlayType` probe (defaults to a fresh `<video>` where possible). */
  probe?: PlayTypeProbe | null;
  storage?: DebugStorageManager | null;
  indexedDb: boolean;
  serviceWorker?: DebugServiceWorker | null;
  /** The live cache-storage keys (defaults to `caches.keys()`). */
  cacheKeys?: () => Promise<string[]>;
  webcodecs: { videoDecoder: boolean; videoEncoder: boolean };
}

/** What the panel shows. */
export interface DebugInfo {
  userAgent: string;
  engine: EngineName;
  videoDecoder: boolean;
  videoEncoder: boolean;
  containers: string[];
  video: string[];
  audio: string[];
  opfs: boolean;
  /** `createWritable` on OPFS file handles (missing on Safari 17). */
  opfsWritable: boolean | 'unknown';
  indexedDb: boolean;
  estimate: { usage: number; quota: number } | null;
  serviceWorker: { supported: boolean; controlled: boolean; registrations: number };
  cacheVersion: string;
  caches: string[];
}

/** The structural OPFS slices the panel probes (handles vary per engine). */
interface ProbeFileHandle {
  createWritable?: unknown;
}
interface ProbeDirectory {
  getFileHandle?(name: string, options?: { create?: boolean }): Promise<ProbeFileHandle>;
  removeEntry?(name: string): Promise<void>;
}
interface ProbeRoot {
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<ProbeDirectory>;
}

/** Builds the environment from the real browser globals. */
export function browserDebugEnvironment(): DebugEnvironment {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    userAgent: nav?.userAgent ?? '',
    probe: typeof document !== 'undefined' ? (document.createElement('video') as unknown as PlayTypeProbe) : null,
    storage: (nav?.storage as DebugStorageManager | undefined) ?? null,
    indexedDb: typeof indexedDB !== 'undefined',
    serviceWorker: (nav?.serviceWorker as DebugServiceWorker | undefined) ?? null,
    cacheKeys: typeof caches !== 'undefined' ? () => caches.keys() : async () => [],
    webcodecs: {
      videoDecoder: typeof VideoDecoder !== 'undefined',
      videoEncoder: typeof VideoEncoder !== 'undefined',
    },
  };
}

/**
 * Probes the environment once.
 * @param env the (injectable) browser slices.
 * @returns everything the panel renders.
 */
export async function collectDiagnostics(env: DebugEnvironment): Promise<DebugInfo> {
  const capabilities = detectCapabilities(env.probe ?? null);
  let opfs = false;
  let opfsWritable: boolean | 'unknown' = 'unknown';
  if (env.storage && typeof env.storage.getDirectory === 'function') {
    try {
      const root = (await env.storage.getDirectory()) as ProbeRoot | null;
      opfs = root !== null && root !== undefined;
      // Safari 17 exposes the OPFS root but not `createWritable` on the
      // main thread — the exact gap that broke imports.
      if (opfs && root && typeof root.getDirectoryHandle === 'function') {
        const directory = await root.getDirectoryHandle('media', { create: true });
        if (typeof directory.getFileHandle === 'function') {
          const handle = await directory.getFileHandle('.concat-probe', { create: true });
          opfsWritable = typeof handle.createWritable === 'function';
          try {
            await directory.removeEntry?.('.concat-probe');
          } catch {
            // A leftover probe file is harmless.
          }
        }
      }
    } catch {
      opfs = false;
      opfsWritable = false;
    }
  }
  let estimate: { usage: number; quota: number } | null = null;
  if (env.storage && typeof env.storage.estimate === 'function') {
    try {
      const value = await env.storage.estimate();
      estimate = { usage: value.usage ?? 0, quota: value.quota ?? 0 };
    } catch {
      estimate = null;
    }
  }
  let registrations = 0;
  let controlled = false;
  const supported = env.serviceWorker !== null && env.serviceWorker !== undefined;
  if (env.serviceWorker) {
    controlled = env.serviceWorker.controller !== null && env.serviceWorker.controller !== undefined;
    if (typeof env.serviceWorker.getRegistrations === 'function') {
      try {
        registrations = (await env.serviceWorker.getRegistrations()).length;
      } catch {
        registrations = 0;
      }
    }
  }
  let cacheNames: string[] = [];
  if (env.cacheKeys) {
    try {
      cacheNames = await env.cacheKeys();
    } catch {
      cacheNames = [];
    }
  }
  return {
    userAgent: env.userAgent,
    engine: detectEngineName(env.userAgent),
    videoDecoder: env.webcodecs.videoDecoder,
    videoEncoder: env.webcodecs.videoEncoder,
    containers: [...capabilities.containers].sort(),
    video: [...capabilities.video].sort(),
    audio: [...capabilities.audio].sort(),
    opfs,
    opfsWritable,
    indexedDb: env.indexedDb,
    estimate,
    serviceWorker: { supported, controlled, registrations },
    cacheVersion: SW_CACHE_VERSION,
    caches: cacheNames,
  };
}

/** Human-readable yes/no for the panel rows. */
function yesNo(value: boolean | 'unknown'): string {
  return value === 'unknown' ? 'n/d' : value ? 'sí' : 'no';
}

/** Megabytes, for the estimate row. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Renders the panel into `host`.
 * @param host where the panel is appended (`document.body` in the app).
 * @param info the collected diagnostics.
 * @returns the panel element.
 */
export function renderDebugPanel(host: HTMLElement, info: DebugInfo): HTMLElement {
  const panel = host.ownerDocument.createElement('div');
  panel.className = 'debug-panel';
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', 'Diagnóstico');

  const title = host.ownerDocument.createElement('div');
  title.className = 'debug-panel-title';
  title.textContent = `Diagnóstico (cache ${info.cacheVersion})`;
  panel.appendChild(title);

  const close = host.ownerDocument.createElement('button');
  close.type = 'button';
  close.className = 'debug-panel-close';
  close.textContent = '×';
  close.addEventListener('click', () => panel.remove());
  title.appendChild(close);

  const rows: [string, string][] = [
    ['Motor', info.engine],
    ['UA', info.userAgent],
    ['WebCodecs', `dec ${yesNo(info.videoDecoder)} · enc ${yesNo(info.videoEncoder)}`],
    ['Contenedores', info.containers.join(', ') || '—'],
    ['Vídeo', info.video.join(', ') || '—'],
    ['Audio', info.audio.join(', ') || '—'],
    ['OPFS', `${yesNo(info.opfs)} (escritura: ${yesNo(info.opfsWritable)})`],
    ['IndexedDB', yesNo(info.indexedDb)],
    ['Almacenamiento', info.estimate ? `${megabytes(info.estimate.usage)} / ${megabytes(info.estimate.quota)}` : 'n/d'],
    ['Service worker', `${info.serviceWorker.supported ? `sí (${info.serviceWorker.registrations} reg., controla: ${yesNo(info.serviceWorker.controlled)})` : 'no'}`],
    ['Caches', info.caches.join(', ') || '—'],
  ];
  const list = host.ownerDocument.createElement('dl');
  for (const [label, value] of rows) {
    const dt = host.ownerDocument.createElement('dt');
    dt.textContent = label;
    const dd = host.ownerDocument.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  panel.appendChild(list);
  host.appendChild(panel);
  return panel;
}

/**
 * The app entry point: mounts the panel when (and only when) the URL asks
 * for `?debug=1`.
 * @param host where the panel is appended.
 * @param search the query string (defaults to `location.search`).
 * @param env the environment (defaults to the real browser globals).
 * @returns the panel, or `null` when debugging is off.
 */
export async function mountDebugPanel(
  host: HTMLElement,
  search: string = typeof location !== 'undefined' ? location.search : '',
  env: DebugEnvironment = browserDebugEnvironment(),
): Promise<HTMLElement | null> {
  if (!debugEnabled(search)) return null;
  const info = await collectDiagnostics(env);
  return renderDebugPanel(host, info);
}
