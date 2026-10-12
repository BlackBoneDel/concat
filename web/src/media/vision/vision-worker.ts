// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Off-main-thread CPU vision: chroma/luma key, spill, feather, grading and
 * LUT over raw RGBA — the path used where no GPU frame loop exists (LUT
 * browser previews, offline export, thumbnails). The realtime preview stays
 * on WebGL2 in {@link VisionProcessor} (synchronous, per frame).
 *
 * Without `Worker` (tests, old engines) the same handlers run inline.
 */

import { WorkerClient, type HandlerTools, type WorkerHandler } from '../../workers/worker-client.ts';
import { parseClipEffects, serializeClipEffects, type ClipEffects } from '../clip-effects.ts';
import type { Lut3D } from './lut-loader.ts';
import { processPixels } from './vision-processor.ts';

/** Wire form of a LUT. */
interface WireLut {
  id: string;
  title: string;
  size: number;
  data: Float32Array;
}

function readLut(value: unknown): Lut3D | null {
  if (typeof value !== 'object' || value === null) return null;
  const size = Number(Reflect.get(value, 'size'));
  const data: unknown = Reflect.get(value, 'data');
  if (!(data instanceof Float32Array) || !Number.isInteger(size) || size < 2 || data.length !== size * size * size * 3) {
    throw new RangeError('LUT inválida en el worker de visión');
  }
  return { id: String(Reflect.get(value, 'id')), title: String(Reflect.get(value, 'title')), size, data };
}

/**
 * The worker's handlers (`process`).
 * @returns handler table.
 */
export function createVisionHandlers(): Record<string, WorkerHandler> {
  return {
    process: (payload: unknown, tools: HandlerTools) => {
      if (typeof payload !== 'object' || payload === null) throw new TypeError('Petición de visión inválida');
      const pixels: unknown = Reflect.get(payload, 'pixels');
      const width = Number(Reflect.get(payload, 'width'));
      const height = Number(Reflect.get(payload, 'height'));
      if (!(pixels instanceof Uint8ClampedArray) || !(width > 0 && height > 0) || pixels.length !== width * height * 4) {
        throw new RangeError('Tamaño de imagen inválido');
      }
      const effects = parseClipEffects(Reflect.get(payload, 'effects'));
      processPixels(pixels, width, height, effects, readLut(Reflect.get(payload, 'lut')));
      tools.progress(1);
      tools.transfer.push(pixels.buffer);
      return pixels;
    },
  };
}

/** Async CPU vision over a worker. */
export class VisionWorkerClient {
  private readonly client: WorkerClient;
  private readonly inline = createVisionHandlers();

  /**
   * @param client RPC client override (tests).
   */
  constructor(client?: WorkerClient) {
    this.client = client ?? new WorkerClient(() =>
      typeof Worker === 'undefined' ? null : new Worker(new URL('../../workers/chroma-worker.ts', import.meta.url), { type: 'module' }));
  }

  /**
   * Processes RGBA pixels (the input buffer is transferred: do not reuse it).
   * @param pixels RGBA bytes.
   * @param width image width.
   * @param height image height.
   * @param effects clip effects.
   * @param lut resolved LUT for `effects.lut`, if any.
   * @returns the processed pixels.
   */
  async process(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, effects: ClipEffects, lut: Lut3D | null = null): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const wireLut: WireLut | null = lut ? { id: lut.id, title: lut.title, size: lut.size, data: new Float32Array(lut.data) } : null;
    const payload = { pixels, width, height, effects: serializeClipEffects(effects), lut: wireLut };
    if (this.client.available) {
      const out = await this.client.request<unknown>('process', payload, wireLut ? [pixels.buffer, wireLut.data.buffer] : [pixels.buffer]);
      if (!(out instanceof Uint8ClampedArray)) throw new Error('Respuesta de visión inválida');
      return out.buffer instanceof ArrayBuffer ? new Uint8ClampedArray(out.buffer, out.byteOffset, out.length) : new Uint8ClampedArray(out);
    }
    const out = await Promise.resolve(this.inline['process']!(payload, { progress: () => undefined, transfer: [] }));
    if (!(out instanceof Uint8ClampedArray)) throw new Error('Respuesta de visión inválida');
    return pixels;
  }
}
