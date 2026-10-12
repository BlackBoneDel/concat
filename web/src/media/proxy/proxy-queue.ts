// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The background proxy queue: jobs wait by priority (high → normal → low,
 * FIFO inside a priority), at most `maxConcurrent` run at once (2 by default,
 * configurable 1–4), and one media never has two jobs.
 */

/** Target settings of a proxy. */
export interface ProxyConfig {
  resolution: { width: number; height: number };
  /** Bits per second. */
  bitrate: number;
  fps: number;
  codec: 'avc' | 'vp9' | 'av1';
}

/** Job priority. */
export type ProxyPriority = 'high' | 'normal' | 'low';

/** One proxy to generate. */
export interface ProxyGenerationJob {
  mediaId: string;
  sourceFile: File | Blob;
  config: ProxyConfig;
  priority: ProxyPriority;
}

/** Numeric rank of a priority (lower runs first). */
const RANK: Record<ProxyPriority, number> = { high: 0, normal: 1, low: 2 };

/** A waiting job and its arrival order. */
interface Waiting {
  job: ProxyGenerationJob;
  seq: number;
}

/** Priority queue with concurrency accounting. */
export class ProxyQueue {
  private readonly waiting: Waiting[] = [];
  private readonly running = new Map<string, ProxyGenerationJob>();
  private concurrency: number;
  private seq = 0;

  /**
   * @param maxConcurrent jobs allowed to run at once (1–4).
   */
  constructor(maxConcurrent = 2) {
    this.concurrency = clampConcurrency(maxConcurrent);
  }

  /**
   * Adds a job; a job for a media already waiting replaces it (keeping the
   * higher priority), a media already running is ignored.
   * @param job the job.
   */
  enqueue(job: ProxyGenerationJob): void {
    if (this.running.has(job.mediaId)) return;
    const existing = this.waiting.findIndex((entry) => entry.job.mediaId === job.mediaId);
    if (existing >= 0) {
      const previous = this.waiting[existing]!;
      const priority = RANK[job.priority] < RANK[previous.job.priority] ? job.priority : previous.job.priority;
      this.waiting[existing] = { job: { ...job, priority }, seq: previous.seq };
    } else {
      this.waiting.push({ job, seq: this.seq });
      this.seq += 1;
    }
    this.sort();
  }

  /**
   * Takes the next job when a slot is free, marking it active.
   * @returns the job, or `null` (queue empty or all slots busy).
   */
  dequeue(): ProxyGenerationJob | null {
    if (this.running.size >= this.concurrency) return null;
    const next = this.waiting.shift();
    if (!next) return null;
    this.running.set(next.job.mediaId, next.job);
    return next.job;
  }

  /**
   * Marks an active job as finished (success or failure), freeing its slot.
   * @param mediaId the job's media.
   * @returns `true` when it was active.
   */
  complete(mediaId: string): boolean {
    return this.running.delete(mediaId);
  }

  /**
   * Drops a waiting or active job.
   * @param mediaId the job's media.
   * @returns `true` when a job was found.
   */
  cancel(mediaId: string): boolean {
    const index = this.waiting.findIndex((entry) => entry.job.mediaId === mediaId);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      return true;
    }
    return this.running.delete(mediaId);
  }

  /**
   * Changes the priority of a waiting job.
   * @param mediaId the job's media.
   * @param newPriority the new priority.
   */
  reorder(mediaId: string, newPriority: ProxyPriority): void {
    const entry = this.waiting.find((candidate) => candidate.job.mediaId === mediaId);
    if (!entry) return;
    entry.job = { ...entry.job, priority: newPriority };
    this.sort();
  }

  /** Waiting jobs in run order. */
  get pending(): ProxyGenerationJob[] {
    return this.waiting.map((entry) => entry.job);
  }

  /** Jobs currently running. */
  get active(): ProxyGenerationJob[] {
    return [...this.running.values()];
  }

  /** Concurrency limit. */
  get maxConcurrent(): number {
    return this.concurrency;
  }

  /**
   * Sets the concurrency limit.
   * @param n 1–4 (clamped).
   */
  setMaxConcurrent(n: number): void {
    this.concurrency = clampConcurrency(n);
  }

  /** `true` when a media has a waiting or running job. */
  has(mediaId: string): boolean {
    return this.running.has(mediaId) || this.waiting.some((entry) => entry.job.mediaId === mediaId);
  }

  /** `true` when a media's job is running. */
  isActive(mediaId: string): boolean {
    return this.running.has(mediaId);
  }

  private sort(): void {
    this.waiting.sort((a, b) => RANK[a.job.priority] - RANK[b.job.priority] || a.seq - b.seq);
  }
}

/** Clamps a concurrency to 1–4. */
function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.min(4, Math.max(1, Math.round(n)));
}
