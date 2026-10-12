// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Entry point of the proxy worker: `generate` runs
 * `media/proxy/proxy-worker.ts`'s pipeline (decode → scale → encode → mux)
 * and transfers the proxy blob back.
 */

import { browserProxyEnv, runProxyJob } from '../media/proxy/proxy-worker.ts';
import type { ProxyConfig } from '../media/proxy/proxy-queue.ts';
import { serveWorker } from './worker-client.ts';

/** Reads the `generate` payload without trusting its shape. */
function readPayload(payload: unknown): { sourceFile: Blob; config: ProxyConfig } {
  if (typeof payload !== 'object' || payload === null) throw new Error('Petición de proxy inválida');
  const sourceFile: unknown = Reflect.get(payload, 'sourceFile');
  const config: unknown = Reflect.get(payload, 'config');
  if (!(sourceFile instanceof Blob)) throw new Error('Falta el archivo fuente');
  if (typeof config !== 'object' || config === null) throw new Error('Falta la configuración');
  const resolution: unknown = Reflect.get(config, 'resolution');
  const width = typeof resolution === 'object' && resolution !== null ? Reflect.get(resolution, 'width') : undefined;
  const height = typeof resolution === 'object' && resolution !== null ? Reflect.get(resolution, 'height') : undefined;
  const bitrate: unknown = Reflect.get(config, 'bitrate');
  const fps: unknown = Reflect.get(config, 'fps');
  const codec: unknown = Reflect.get(config, 'codec');
  if (typeof width !== 'number' || typeof height !== 'number' || typeof bitrate !== 'number' || typeof fps !== 'number') {
    throw new Error('Configuración de proxy inválida');
  }
  const family = codec === 'vp9' || codec === 'av1' ? codec : 'avc';
  return { sourceFile, config: { resolution: { width, height }, bitrate, fps, codec: family } };
}

serveWorker(self, {
  generate: async (payload, tools) => {
    const { sourceFile, config } = readPayload(payload);
    const env = browserProxyEnv();
    if (!env) throw new Error('WebCodecs no disponible');
    return runProxyJob(sourceFile, config, env, (value) => tools.progress(value));
  },
});
