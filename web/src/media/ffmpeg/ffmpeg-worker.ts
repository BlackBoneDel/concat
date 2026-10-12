// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The FFmpeg.wasm side of the fallback, run by `workers/ffmpeg-worker.ts`.
 *
 * It loads the vendored single-thread core (`/vendor/ffmpeg/ffmpeg-core.js`
 * + `.wasm`, FFmpeg 5.1.4 from `@ffmpeg/core` 0.12.10 — see
 * `src/vendor/ffmpeg/README.md`) and serves two requests:
 *
 * - `load` `{ coreURL, wasmURL }` — instantiates the core once;
 * - `exec` `{ args, inputs, outputs, timeoutMs, probe }` — mounts the input
 *   blobs read-only through WORKERFS (no copy into the wasm heap; MEMFS
 *   `writeFile` when WORKERFS is missing), runs `ffmpeg` (or `ffprobe`),
 *   returns the exit code, the log and the requested output files, then
 *   deletes everything it created.
 *
 * The core is reached through {@link FFmpegCore}, a structural slice of the
 * Emscripten module, validated by {@link isFFmpegCore} — no casts.
 */

import type { HandlerTools, WorkerHandler } from '../../workers/worker-client.ts';

/** The Emscripten FS calls used. */
export interface FFmpegFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  mkdir(path: string): void;
  rmdir(path: string): void;
  mount(type: unknown, options: unknown, mountPoint: string): void;
  unmount(mountPoint: string): void;
  filesystems: Record<string, unknown>;
}

/** The slice of the `@ffmpeg/core` module used. */
export interface FFmpegCore {
  exec(...args: string[]): number;
  ffprobe(...args: string[]): number;
  reset(): void;
  setLogger(logger: (data: { type: string; message: string }) => void): void;
  setProgress(handler: (data: { progress: number; time: number }) => void): void;
  setTimeout(ms: number): void;
  readonly ret: number;
  readonly FS: FFmpegFS;
}

/**
 * Structural guard for the instantiated core.
 * @param value what `createFFmpegCore()` resolved to.
 * @returns `true` when every used member exists.
 */
export function isFFmpegCore(value: unknown): value is FFmpegCore {
  if (typeof value !== 'object' || value === null) return false;
  for (const name of ['exec', 'ffprobe', 'reset', 'setLogger', 'setProgress', 'setTimeout']) {
    if (typeof Reflect.get(value, name) !== 'function') return false;
  }
  const fs: unknown = Reflect.get(value, 'FS');
  if (typeof fs !== 'object' || fs === null) return false;
  for (const name of ['writeFile', 'readFile', 'unlink', 'mkdir', 'rmdir', 'mount', 'unmount']) {
    if (typeof Reflect.get(fs, name) !== 'function') return false;
  }
  return typeof Reflect.get(fs, 'filesystems') === 'object';
}

/** An input file of an `exec` request. */
export interface ExecInput {
  name: string;
  data: Blob;
}

/** The `exec` request. */
export interface ExecRequest {
  args: string[];
  inputs: ExecInput[];
  outputs: string[];
  timeoutMs: number;
  probe: boolean;
}

/** The `exec` result. */
export interface ExecResult {
  ret: number;
  logs: string[];
  files: Record<string, Uint8Array>;
}

/** Directory where inputs are mounted. */
export const INPUT_DIR = '/input';
/** Directory where outputs are written. */
export const OUTPUT_DIR = '/output';

/** Loads the core from the vendored URLs. */
export type CoreLoader = (coreURL: string, wasmURL: string) => Promise<FFmpegCore>;

/**
 * The real loader: dynamic-imports the vendored ESM core and instantiates it.
 * The wasm URL travels in the `mainScriptUrlOrBlob` hash, the hook the
 * `@ffmpeg/core` build reads in its `locateFile`.
 */
export const importCore: CoreLoader = async (coreURL, wasmURL) => {
  const mod: unknown = await import(/* @vite-ignore */ coreURL);
  const factory: unknown = typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'default') : undefined;
  if (typeof factory !== 'function') throw new Error('ffmpeg-core.js no exporta createFFmpegCore');
  const hash = btoa(JSON.stringify({ wasmURL, workerURL: '' }));
  const instance: unknown = await Reflect.apply(factory, undefined, [{ mainScriptUrlOrBlob: `${coreURL}#${hash}` }]);
  if (!isFFmpegCore(instance)) throw new Error('El núcleo de FFmpeg no tiene la API esperada');
  return instance;
};

/** Reads an `exec` payload defensively. */
export function readExecRequest(payload: unknown): ExecRequest {
  if (typeof payload !== 'object' || payload === null) throw new Error('Petición FFmpeg inválida');
  const args: unknown = Reflect.get(payload, 'args');
  const inputs: unknown = Reflect.get(payload, 'inputs');
  const outputs: unknown = Reflect.get(payload, 'outputs');
  const timeoutMs: unknown = Reflect.get(payload, 'timeoutMs');
  const probe: unknown = Reflect.get(payload, 'probe');
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) throw new Error('args inválidos');
  const parsedInputs: ExecInput[] = [];
  if (Array.isArray(inputs)) {
    for (const input of inputs) {
      const name: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, 'name') : undefined;
      const data: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, 'data') : undefined;
      if (typeof name !== 'string' || !(data instanceof Blob) || name.includes('/')) throw new Error('Entrada FFmpeg inválida');
      parsedInputs.push({ name, data });
    }
  }
  const parsedOutputs = Array.isArray(outputs) ? outputs.filter((value): value is string => typeof value === 'string' && !value.includes('/')) : [];
  return {
    args,
    inputs: parsedInputs,
    outputs: parsedOutputs,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : -1,
    probe: probe === true,
  };
}

/** Creates a directory, ignoring "exists". */
function ensureDir(fs: FFmpegFS, path: string): void {
  try {
    fs.mkdir(path);
  } catch {
    // Exists.
  }
}

/**
 * The worker handlers over a core loader (the real one or a test double).
 * @param loader instantiates the core.
 * @returns `load` and `exec` handlers for `serveWorker`.
 */
export function createFFmpegHandlers(loader: CoreLoader): Record<string, WorkerHandler> {
  let core: FFmpegCore | null = null;
  let logs: string[] = [];
  let onProgress: ((value: number) => void) | null = null;

  const load: WorkerHandler = async (payload) => {
    if (core) return false;
    const coreURL: unknown = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'coreURL') : undefined;
    const wasmURL: unknown = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'wasmURL') : undefined;
    if (typeof coreURL !== 'string' || typeof wasmURL !== 'string') throw new Error('URLs del núcleo FFmpeg inválidas');
    const instance = await loader(coreURL, wasmURL);
    instance.setLogger((data) => {
      logs.push(data.message);
      if (logs.length > 2000) logs = logs.slice(-1000);
    });
    instance.setProgress((data) => {
      if (Number.isFinite(data.progress)) onProgress?.(Math.min(1, Math.max(0, data.progress)));
    });
    core = instance;
    return true;
  };

  const exec: WorkerHandler = (payload, tools: HandlerTools) => {
    if (!core) throw new Error('FFmpeg no está cargado');
    const request = readExecRequest(payload);
    const fs = core.FS;
    logs = [];
    onProgress = (value) => tools.progress(value);
    ensureDir(fs, INPUT_DIR);
    ensureDir(fs, OUTPUT_DIR);
    const workerfs = fs.filesystems['WORKERFS'];
    let mounted = false;
    const written: string[] = [];
    try {
      if (request.inputs.length > 0) {
        if (workerfs) {
          fs.mount(workerfs, { blobs: request.inputs.map((input) => ({ name: input.name, data: input.data })) }, INPUT_DIR);
          mounted = true;
        } else {
          throw new Error('WORKERFS no disponible');
        }
      }
    } catch {
      mounted = false;
      // MEMFS fallback is async (needs the bytes); handled below.
    }
    const run = async (): Promise<ExecResult> => {
      if (!core) throw new Error('FFmpeg no está cargado');
      if (!mounted) {
        for (const input of request.inputs) {
          const path = `${INPUT_DIR}/${input.name}`;
          fs.writeFile(path, new Uint8Array(await input.data.arrayBuffer()));
          written.push(path);
        }
      }
      core.setTimeout(request.timeoutMs);
      if (request.probe) core.ffprobe(...request.args);
      else core.exec(...request.args);
      const ret = core.ret;
      core.reset();
      const files: Record<string, Uint8Array> = {};
      for (const name of request.outputs) {
        const path = `${OUTPUT_DIR}/${name}`;
        try {
          const data = fs.readFile(path);
          const copy = new Uint8Array(data.length);
          copy.set(data);
          files[name] = copy;
          tools.transfer.push(copy.buffer);
          fs.unlink(path);
        } catch {
          // Not produced (the caller sees it missing and reads the log).
        }
      }
      return { ret, logs: [...logs], files };
    };
    return run().finally(() => {
      onProgress = null;
      if (mounted) {
        try {
          fs.unmount(INPUT_DIR);
        } catch {
          // Already unmounted.
        }
      }
      for (const path of written) {
        try {
          fs.unlink(path);
        } catch {
          // Gone.
        }
      }
    });
  };

  return { load, exec };
}
