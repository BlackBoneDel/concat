// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The proxy priority queue. */

import { describe, expect, it } from 'vitest';
import { ProxyQueue, type ProxyGenerationJob, type ProxyPriority } from '../src/media/proxy/proxy-queue.ts';
import { DEFAULT_PROXY_CONFIG } from '../src/media/proxy/proxy-generator.ts';

function job(mediaId: string, priority: ProxyPriority = 'normal'): ProxyGenerationJob {
  return { mediaId, sourceFile: new Blob(['x']), config: DEFAULT_PROXY_CONFIG, priority };
}

describe('ProxyQueue', () => {
  it('orders by priority then FIFO and caps concurrency at 2 by default', () => {
    const queue = new ProxyQueue();
    queue.enqueue(job('low', 'low'));
    queue.enqueue(job('n1'));
    queue.enqueue(job('high', 'high'));
    queue.enqueue(job('n2'));
    expect(queue.pending.map((entry) => entry.mediaId)).toEqual(['high', 'n1', 'n2', 'low']);
    expect(queue.dequeue()?.mediaId).toBe('high');
    expect(queue.dequeue()?.mediaId).toBe('n1');
    expect(queue.dequeue()).toBeNull();
    expect(queue.active.map((entry) => entry.mediaId)).toEqual(['high', 'n1']);
    expect(queue.complete('high')).toBe(true);
    expect(queue.dequeue()?.mediaId).toBe('n2');
  });

  it('dedupes by media keeping the higher priority and ignores running media', () => {
    const queue = new ProxyQueue(1);
    queue.enqueue(job('a', 'low'));
    queue.enqueue(job('b'));
    queue.enqueue(job('a', 'high'));
    expect(queue.pending.map((entry) => `${entry.mediaId}:${entry.priority}`)).toEqual(['a:high', 'b:normal']);
    queue.dequeue();
    queue.enqueue(job('a'));
    expect(queue.pending).toHaveLength(1);
    expect(queue.has('a')).toBe(true);
    expect(queue.isActive('a')).toBe(true);
  });

  it('cancels waiting and active jobs; reorders', () => {
    const queue = new ProxyQueue(1);
    queue.enqueue(job('a'));
    queue.enqueue(job('b'));
    queue.enqueue(job('c'));
    queue.dequeue();
    expect(queue.cancel('b')).toBe(true);
    expect(queue.cancel('a')).toBe(true);
    expect(queue.cancel('zzz')).toBe(false);
    queue.enqueue(job('d'));
    queue.reorder('d', 'high');
    queue.reorder('missing', 'high');
    expect(queue.pending.map((entry) => entry.mediaId)).toEqual(['d', 'c']);
  });

  it('clamps concurrency to 1..4', () => {
    const queue = new ProxyQueue(9);
    expect(queue.maxConcurrent).toBe(4);
    queue.setMaxConcurrent(0);
    expect(queue.maxConcurrent).toBe(1);
    queue.setMaxConcurrent(Number.NaN);
    expect(queue.maxConcurrent).toBe(2);
  });
});
