// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 6: service-worker registration, install prompt and the public PWA files. */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallPrompt, type PromptTarget } from '../src/pwa/install-prompt.ts';
import { registerServiceWorker, type ContainerLike, type RegistrationLike, type WorkerLike } from '../src/pwa/sw-register.ts';

class FakeWorker implements WorkerLike {
  state = 'installing';
  messages: unknown[] = [];
  private listeners: (() => void)[] = [];
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  addEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.push(listener);
  }
  become(state: string): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeRegistration implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  updates = 0;
  private listeners: (() => void)[] = [];
  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.push(listener);
  }
  async update(): Promise<void> {
    this.updates += 1;
  }
  found(worker: FakeWorker): void {
    this.installing = worker;
    for (const listener of this.listeners) listener();
  }
}

class FakeContainer implements ContainerLike {
  controller: unknown = null;
  registered: { url: string; scope: string }[] = [];
  registration = new FakeRegistration();
  fail = false;
  private listeners: (() => void)[] = [];
  async register(url: string, options: { scope: string }): Promise<RegistrationLike> {
    if (this.fail) throw new Error('bloqueado');
    this.registered.push({ url, scope: options.scope });
    return this.registration;
  }
  addEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.push(listener);
  }
  takeOver(): void {
    this.controller = {};
    for (const listener of this.listeners) listener();
  }
}

describe('registerServiceWorker', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['/concat/', '/concat', './', '/'])('registers within Vite base %s', async (base) => {
    vi.stubEnv('BASE_URL', base);
    const container = new FakeContainer();
    await registerServiceWorker({ isProduction: true, container, checkInterval: 0 });
    const scope = base.endsWith('/') ? base : `${base}/`;
    expect(container.registered).toEqual([{ url: `${scope}sw.js`, scope }]);
  });
  it('does nothing in development or without support', async () => {
    const container = new FakeContainer();
    expect((await registerServiceWorker({ isProduction: false, container })).registration).toBeNull();
    expect(container.registered).toHaveLength(0);
    expect((await registerServiceWorker({ isProduction: true, container: null })).registration).toBeNull();
    // Vitest runs in dev mode: the default is "not production".
    expect((await registerServiceWorker({ container })).registration).toBeNull();
  });

  it('reports offline-ready on the first install', async () => {
    const container = new FakeContainer();
    let ready = 0;
    const result = await registerServiceWorker({ isProduction: true, container, onOfflineReady: () => (ready += 1), checkInterval: 0 });
    expect(container.registered).toEqual([{ url: `${import.meta.env.BASE_URL}sw.js`, scope: import.meta.env.BASE_URL }]);
    const worker = new FakeWorker();
    container.registration.found(worker);
    worker.become('installed');
    expect(ready).toBe(1);
    result.dispose();
  });

  it('offers a refresh for updates and reloads once after skip-waiting', async () => {
    const container = new FakeContainer();
    container.controller = {};
    let update: (() => void) | null = null;
    let reloads = 0;
    await registerServiceWorker({ isProduction: true, container, onNeedRefresh: (fn) => (update = fn), reload: () => (reloads += 1), checkInterval: 0 });
    const worker = new FakeWorker();
    container.registration.found(worker);
    worker.become('installed');
    expect(update).not.toBeNull();
    // A controller change the user did not ask for does not reload.
    container.takeOver();
    expect(reloads).toBe(0);
    update!();
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    container.takeOver();
    container.takeOver();
    expect(reloads).toBe(1);
  });

  it('announces an already waiting worker and survives registration errors', async () => {
    const container = new FakeContainer();
    container.controller = {};
    container.registration.waiting = new FakeWorker();
    let offered = 0;
    await registerServiceWorker({ isProduction: true, container, onNeedRefresh: () => (offered += 1), checkInterval: 0 });
    expect(offered).toBe(1);
    const broken = new FakeContainer();
    broken.fail = true;
    const errors: unknown[] = [];
    const result = await registerServiceWorker({ isProduction: true, container: broken, onError: (e) => errors.push(e) });
    expect(result.registration).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('checks for updates periodically until disposed', async () => {
    const container = new FakeContainer();
    const result = await registerServiceWorker({ isProduction: true, container, checkInterval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    result.dispose();
    const seen = container.registration.updates;
    expect(seen).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.registration.updates).toBe(seen);
  });
});

describe('InstallPrompt', () => {
  class Target implements PromptTarget {
    listeners = new Map<string, ((event: Event) => void)[]>();
    addEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    removeEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
    }
    fire(type: string, event: Event): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  function promptEvent(outcome: 'accepted' | 'dismissed'): Event & { prevented: boolean; prompted: number } {
    const event = Object.assign(new Event('beforeinstallprompt'), {
      prevented: false,
      prompted: 0,
      userChoice: Promise.resolve({ outcome }),
      async prompt(this: { prompted: number }) {
        this.prompted += 1;
      },
    });
    event.preventDefault = () => {
      event.prevented = true;
    };
    return event;
  }

  it('captures the prompt, shows it once and tracks installation', async () => {
    const target = new Target();
    const install = new InstallPrompt(target);
    const changes: boolean[] = [];
    install.onChange(() => changes.push(install.canInstall));
    expect(install.canInstall).toBe(false);
    expect(await install.prompt()).toBe('unavailable');
    target.fire('beforeinstallprompt', new Event('beforeinstallprompt'));
    expect(install.canInstall).toBe(false);
    const event = promptEvent('accepted');
    target.fire('beforeinstallprompt', event);
    expect(event.prevented).toBe(true);
    expect(install.canInstall).toBe(true);
    expect(await install.prompt()).toBe('accepted');
    expect(event.prompted).toBe(1);
    expect(install.canInstall).toBe(false);
    target.fire('beforeinstallprompt', promptEvent('dismissed'));
    target.fire('appinstalled', new Event('appinstalled'));
    expect(install.installed).toBe(true);
    expect(install.canInstall).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
    install.dispose();
    expect(target.listeners.get('beforeinstallprompt')).toEqual([]);
  });
});

describe('public PWA files', () => {
  const read = (path: string): string => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

  it('ships a valid manifest with any + maskable icons', () => {
    const manifest: unknown = JSON.parse(read('manifest.json'));
    expect(manifest).toMatchObject({ short_name: 'Concat', display: 'standalone', start_url: './', scope: './', lang: 'es' });
    const icons = Reflect.get(manifest as object, 'icons');
    expect(Array.isArray(icons)).toBe(true);
    const list = icons as { sizes: string; purpose: string; src: string }[];
    expect(list.filter((icon) => icon.purpose === 'maskable').map((icon) => icon.sizes)).toEqual(['192x192', '512x512']);
    expect(list.filter((icon) => icon.purpose === 'any').map((icon) => icon.sizes)).toEqual(['192x192', '512x512']);
    for (const icon of list) expect(readFileSync(new URL(`../public/${icon.src}`, import.meta.url)).subarray(1, 4).toString()).toBe('PNG');
  });

  it('ships a network-first service worker with build placeholders', () => {
    const sw = read('sw.js');
    expect(sw).toContain('__CONCAT_BUILD_ID__');
    expect(sw).toContain('/*__CONCAT_PRECACHE__*/ []');
    expect(sw).toContain('SKIP_WAITING');
    expect(sw).toMatch(/networkFirst/);
    expect(sw).toContain('offline.html');
    expect(sw).not.toMatch(/https?:\/\//);
    expect(read('offline.html')).toContain('Sin conexión');
  });
});

// -- Fase 7+: invalidación del cache del SW a v8 ---------------------------

import { SW_CACHE_VERSION } from '../src/pwa/sw-register.ts';

describe('service-worker cache v8', () => {
  const readSw = (): string => readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

  it('declara CACHE_VERSION v8', () => {
    expect(readSw()).toMatch(/const CACHE_VERSION = 'v8';/);
    expect(SW_CACHE_VERSION).toBe('v8');
  });

  it('los nombres de cache incluyen la versión y el build id', () => {
    const sw = readSw();
    expect(sw).toContain('concat-web-${CACHE_VERSION}-${BUILD_ID}');
    expect(sw).toContain('concat-runtime-${CACHE_VERSION}-${BUILD_ID}');
  });

  it('activate purga todo cache concat-* que no sea el vigente', () => {
    const sw = readSw();
    expect(sw).toMatch(/const keep = new Set\(\[CACHE, RUNTIME\]\)/);
    expect(sw).toMatch(/key\.startsWith\('concat-'\) && !keep\.has\(key\)/);
  });

  it('SW_CACHE_VERSION coincide con la constante del sw.js publicado', () => {
    expect(readSw()).toContain(`const CACHE_VERSION = '${SW_CACHE_VERSION}';`);
  });
});
