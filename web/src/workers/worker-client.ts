// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The tiny RPC layer every Fase-4 worker speaks.
 *
 * Main thread: {@link WorkerClient} posts `{ id, type, payload }` requests and
 * resolves on `{ id, type: 'complete', result }`, rejects on
 * `{ id, type: 'error', message }`, and forwards `{ id, type: 'progress',
 * value }` to the caller. The worker is created lazily and terminated after
 * `idleMs` without work (30 s by default — the memory contract of Fase 4).
 *
 * Worker side: {@link serveWorker} installs the matching `onmessage` loop.
 *
 * When `Worker` does not exist (tests, very old engines) the factory returns
 * `null` and callers run the very same function inline.
 */

/** The slice of `Worker` the client uses — real workers satisfy it. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** Messages a worker sends back. */
export type WorkerReply =
  | { id: number; type: 'progress'; value: number }
  | { id: number; type: 'complete'; result: unknown }
  | { id: number; type: 'error'; message: string };

/** A request on the wire. */
export interface WorkerRequest {
  id: number;
  type: string;
  payload: unknown;
}

/** One outstanding request. */
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress: ((value: number) => void) | undefined;
}

/** Default idle time before a worker is terminated. */
export const WORKER_IDLE_MS = 30_000;

/** A lazily spawned, idle-terminated worker with request/response RPC. */
export class WorkerClient {
  private readonly factory: () => WorkerLike | null;
  private readonly idleMs: number;
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private spawnFailed = false;

  /**
   * @param factory creates the worker; returns `null` when workers are unavailable.
   * @param idleMs milliseconds without work before the worker is terminated.
   */
  constructor(factory: () => WorkerLike | null, idleMs = WORKER_IDLE_MS) {
    this.factory = factory;
    this.idleMs = idleMs;
  }

  /** `true` when a worker can be (or already is) running. */
  get available(): boolean {
    if (this.worker) return true;
    if (this.spawnFailed) return false;
    return this.ensure() !== null;
  }

  /** `true` while a worker instance is alive. */
  get alive(): boolean {
    return this.worker !== null;
  }

  /**
   * Sends one request.
   * @param type the operation name.
   * @param payload structured-cloneable arguments.
   * @param transfer buffers to move instead of copy.
   * @param onProgress progress callback, 0..1.
   * @returns the worker's result.
   */
  request<T>(type: string, payload: unknown, transfer: Transferable[] = [], onProgress?: (value: number) => void): Promise<T> {
    const worker = this.ensure();
    if (!worker) return Promise.reject(new Error('Web Workers no disponibles'));
    this.clearIdle();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress,
      });
      const message: WorkerRequest = { id, type, payload };
      worker.postMessage(message, transfer);
    });
  }

  /**
   * Rejects every pending request and kills the worker now.
   * @param reason the rejection message.
   */
  terminate(reason = 'Worker terminado'): void {
    this.clearIdle();
    for (const entry of this.pending.values()) entry.reject(new Error(reason));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  // -- internals -----------------------------------------------------------

  private ensure(): WorkerLike | null {
    if (this.worker) return this.worker;
    if (this.spawnFailed) return null;
    let worker: WorkerLike | null = null;
    try {
      worker = this.factory();
    } catch {
      worker = null;
    }
    if (!worker) {
      this.spawnFailed = true;
      return null;
    }
    worker.onmessage = (event: MessageEvent) => this.handle(event.data);
    worker.onerror = (event: ErrorEvent) => {
      const message = event.message || 'Error en el worker';
      for (const entry of this.pending.values()) entry.reject(new Error(message));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private handle(data: unknown): void {
    if (!isReply(data)) return;
    const entry = this.pending.get(data.id);
    if (!entry) return;
    if (data.type === 'progress') {
      entry.onProgress?.(data.value);
      return;
    }
    this.pending.delete(data.id);
    if (data.type === 'complete') entry.resolve(data.result);
    else entry.reject(new Error(data.message));
    if (this.pending.size === 0) this.armIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) {
        this.worker?.terminate();
        this.worker = null;
      }
    }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** Narrowing guard for worker replies. */
function isReply(data: unknown): data is WorkerReply {
  if (typeof data !== 'object' || data === null) return false;
  const id: unknown = Reflect.get(data, 'id');
  const type: unknown = Reflect.get(data, 'type');
  return typeof id === 'number' && (type === 'progress' || type === 'complete' || type === 'error');
}

/** Narrowing guard for worker requests. */
export function isWorkerRequest(data: unknown): data is WorkerRequest {
  if (typeof data !== 'object' || data === null) return false;
  return typeof Reflect.get(data, 'id') === 'number' && typeof Reflect.get(data, 'type') === 'string';
}

/** What a worker handler receives besides the payload. */
export interface HandlerTools {
  /** Reports progress 0..1 (throttled by the caller as it sees fit). */
  progress(value: number): void;
  /** Buffers to transfer with the result. */
  transfer: Transferable[];
}

/** A worker-side operation. */
export type WorkerHandler = (payload: unknown, tools: HandlerTools) => Promise<unknown> | unknown;

/** The global scope of a dedicated worker — the slice we need. */
export interface WorkerScopeLike {
  postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/**
 * Installs the request loop inside a worker.
 * @param scope the worker global (`self`).
 * @param handlers one handler per request type.
 */
export function serveWorker(scope: WorkerScopeLike, handlers: Record<string, WorkerHandler>): void {
  scope.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isWorkerRequest(data)) return;
    const handler = handlers[data.type];
    if (!handler) {
      scope.postMessage({ id: data.id, type: 'error', message: `Operación desconocida: ${data.type}` });
      return;
    }
    const tools: HandlerTools = {
      progress: (value) => scope.postMessage({ id: data.id, type: 'progress', value }),
      transfer: [],
    };
    Promise.resolve()
      .then(() => handler(data.payload, tools))
      .then(
        (result) => scope.postMessage({ id: data.id, type: 'complete', result }, { transfer: tools.transfer }),
        (error: unknown) =>
          scope.postMessage({
            id: data.id,
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          }),
      );
  };
}
