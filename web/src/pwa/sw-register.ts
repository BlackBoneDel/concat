// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: service-worker registration. Production builds only (the dev
 * server must never be cached). Reports `onOfflineReady` after the first
 * install and `onNeedRefresh(update)` when a new build is waiting; `update`
 * tells it to take over and reloads once it controls the page.
 */

/**
 * Fase 7+: the cache-schema version stamped into every cache name in
 * `public/sw.js` (`concat-web-v8-<build>`). Bumping it evicts all stale caches
 * of previous deploys on the next activate; the `?debug=1` panel checks the
 * live cache keys against it. Keep in sync with `CACHE_VERSION` in sw.js.
 */
export const SW_CACHE_VERSION = 'v8';

/** The parts of `ServiceWorker` the registrar uses. */
export interface WorkerLike {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}

/** The parts of `ServiceWorkerRegistration` the registrar uses. */
export interface RegistrationLike {
  installing: WorkerLike | null;
  waiting: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
  update(): Promise<unknown>;
}

/** The parts of `ServiceWorkerContainer` the registrar uses. */
export interface ContainerLike {
  controller: unknown;
  register(url: string, options: { scope: string }): Promise<RegistrationLike>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

/** Options of {@link registerServiceWorker}. */
export interface RegisterOptions {
  /** A new version is installed and waiting; call `update` to switch. */
  onNeedRefresh?(update: () => void): void;
  /** The app is now available offline (first install). */
  onOfflineReady?(): void;
  onError?(error: unknown): void;
  /** Defaults to `import.meta.env.PROD`. */
  isProduction?: boolean;
  /** Defaults to `navigator.serviceWorker`. */
  container?: ContainerLike | null;
  /** Defaults to `location.reload()`. */
  reload?(): void;
  /** Script URL, relative to the page (default `${BASE_URL}sw.js`). */
  url?: string;
  /** Milliseconds between update checks (default 1 h; 0 disables). */
  checkInterval?: number;
}

/** What {@link registerServiceWorker} resolves to. */
export interface RegisterResult {
  registration: RegistrationLike | null;
  /** Stops the periodic update checks. */
  dispose(): void;
}

function browserContainer(): ContainerLike | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker;
}

/**
 * Registers `sw.js`.
 * @param options callbacks and injectable environment.
 * @returns the registration (or `null` in dev / unsupported browsers).
 */
export async function registerServiceWorker(options: RegisterOptions = {}): Promise<RegisterResult> {
  const production = options.isProduction ?? import.meta.env.PROD;
  const container = options.container === undefined ? browserContainer() : options.container;
  const none: RegisterResult = { registration: null, dispose: () => undefined };
  if (!production || !container) return none;
  const reload = options.reload ?? (() => location.reload());

  let registration: RegistrationLike;
  try {
    const baseUrl = import.meta.env.BASE_URL.endsWith('/')
      ? import.meta.env.BASE_URL
      : `${import.meta.env.BASE_URL}/`;
    registration = await container.register(options.url ?? `${baseUrl}sw.js`, { scope: baseUrl });
  } catch (error) {
    options.onError?.(error);
    return none;
  }

  let reloading = false;
  let wantsReload = false;
  container.addEventListener('controllerchange', () => {
    if (!wantsReload || reloading) return;
    reloading = true;
    reload();
  });
  const announce = (worker: WorkerLike): void => {
    options.onNeedRefresh?.(() => {
      wantsReload = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };
  const hadController = container.controller !== null && container.controller !== undefined;
  if (registration.waiting && hadController) announce(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'installed') return;
      if (container.controller) announce(worker);
      else options.onOfflineReady?.();
    });
  });

  const interval = options.checkInterval ?? 60 * 60 * 1000;
  const timer = interval > 0 ? setInterval(() => void registration.update().catch(() => undefined), interval) : null;
  return {
    registration,
    dispose: () => {
      if (timer !== null) clearInterval(timer);
    },
  };
}
