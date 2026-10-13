// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Execute the real public worker, rather than just checking source strings. */
function harness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const put = vi.fn(async () => undefined);
  const cached = { ok: true, status: 200 };
  const match = vi.fn(async () => cached);
  const keys = vi.fn(async () => ['concat-v7-old', 'concat-runtime-v7-old', 'unrelated']);
  const remove = vi.fn(async (_key: string) => true);
  const claim = vi.fn(async () => undefined);
  const fetch = vi.fn(async (_request: unknown) => ({ ok: true, status: 200, type: 'basic', clone: () => ({}) }));
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    URL, Request, Response, fetch,
    self: {
      location: { origin: 'https://blackbonedel.github.io' },
      registration: { scope: 'https://blackbonedel.github.io/concat/' },
      clients: { claim },
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    },
    caches: { open: async () => ({ put }), match, keys, delete: remove },
  });
  function dispatch(url: string, method = 'GET', range = false) {
    const respondWith = vi.fn();
    listeners.get('fetch')!({ request: { url, method, mode: 'cors', headers: { has: () => range } }, respondWith });
    return respondWith;
  }
  return { listeners, put, match, remove, claim, fetch, cached, dispatch };
}

describe('service worker under /concat/', () => {
  it.each(['blob:https://blackbonedel.github.io/id', 'data:text/plain,hello', 'file:///tmp/video.mp4',
    'https://example.com/concat/a.js', 'https://blackbonedel.github.io/assets/a.js',
    'https://blackbonedel.github.io/concat-other/a.js'])('bypasses %s', (url) => {
    const sw = harness();
    expect(sw.dispatch(url)).not.toHaveBeenCalled();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('bypasses non-GET and range requests', () => {
    const sw = harness();
    expect(sw.dispatch('https://blackbonedel.github.io/concat/a.js', 'POST')).not.toHaveBeenCalled();
    expect(sw.dispatch('https://blackbonedel.github.io/concat/a.js', 'GET', true)).not.toHaveBeenCalled();
  });

  it.each([404, 500, 206])('never caches HTTP %s', async (status) => {
    const sw = harness();
    const response = { ok: status < 400, status, type: 'basic', clone: () => ({}) };
    sw.fetch.mockResolvedValue(response);
    const event = sw.dispatch('https://blackbonedel.github.io/concat/assets/a.js');
    expect(await event.mock.calls[0]![0]).toBe(response);
    expect(sw.put).not.toHaveBeenCalled();
    expect(sw.match).not.toHaveBeenCalled();
  });

  it('caches a successful same-origin response', async () => {
    const sw = harness();
    await sw.dispatch('https://blackbonedel.github.io/concat/assets/a.js').mock.calls[0]![0];
    expect(sw.put).toHaveBeenCalledOnce();
  });

  it('falls back to cache only when the network fails', async () => {
    const sw = harness();
    sw.fetch.mockRejectedValue(new Error('offline'));
    expect(await sw.dispatch('https://blackbonedel.github.io/concat/assets/a.js').mock.calls[0]![0]).toBe(sw.cached);
  });

  it('activation deletes old concat caches but leaves other applications alone', async () => {
    const sw = harness();
    const waitUntil = vi.fn();
    sw.listeners.get('activate')!({ waitUntil });
    await waitUntil.mock.calls[0]![0];
    expect(sw.remove.mock.calls.map(([key]) => key)).toEqual(['concat-v7-old', 'concat-runtime-v7-old']);
    expect(sw.claim).toHaveBeenCalledOnce();
  });
});
