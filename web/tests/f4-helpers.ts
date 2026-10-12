// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Shared fixtures for the Fase-4 suites. */

import { serveWorker, type WorkerLike, type WorkerScopeLike } from '../src/workers/worker-client.ts';
import { PlainAudioBuffer } from '../src/media/audio/audio-processor.ts';

/**
 * An in-process worker pair: what the client posts reaches a served scope.
 * @param handlers the worker handlers.
 * @returns the client-side worker and a termination counter.
 */
export function linkedWorker(handlers: Parameters<typeof serveWorker>[1]): { worker: WorkerLike; terminated: () => number } {
  let terminated = 0;
  const scope: WorkerScopeLike = {
    onmessage: null,
    postMessage: (message) => {
      queueMicrotask(() => worker.onmessage?.(new MessageEvent('message', { data: message })));
    },
  };
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      queueMicrotask(() => scope.onmessage?.(new MessageEvent('message', { data: message })));
    },
    terminate: () => {
      terminated += 1;
    },
  };
  serveWorker(scope, handlers);
  return { worker, terminated: () => terminated };
}

/**
 * A sine tone.
 * @param frequency Hz.
 * @param seconds length.
 * @param sampleRate rate.
 * @param amplitude peak amplitude.
 * @returns the samples.
 */
export function tone(frequency: number, seconds: number, sampleRate = 48000, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return out;
}

/**
 * A plain audio buffer from channels.
 * @param channels per-channel samples.
 * @param sampleRate rate.
 * @returns the buffer.
 */
export function bufferOf(channels: Float32Array[], sampleRate = 48000): PlainAudioBuffer {
  return new PlainAudioBuffer(channels, sampleRate);
}

/**
 * Dominant frequency by zero-crossing rate (robust for clean tones).
 * @param samples the signal.
 * @param sampleRate rate.
 * @returns Hz.
 */
export function zeroCrossingFrequency(samples: Float32Array, sampleRate: number): number {
  let crossings = 0;
  const from = Math.floor(samples.length * 0.1);
  const to = Math.floor(samples.length * 0.9);
  for (let i = from + 1; i < to; i += 1) {
    if ((samples[i - 1]! < 0 && samples[i]! >= 0) || (samples[i - 1]! >= 0 && samples[i]! < 0)) crossings += 1;
  }
  return (crossings / 2) * (sampleRate / (to - from));
}

/** RMS of a signal. */
export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** RGBA pixel buffer filled with one colour. */
export function solid(width: number, height: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) out.set(rgba, i * 4);
  return out;
}

/** A canonical WebVTT file exercising every block type. */
export const VTT_SAMPLE = `WEBVTT Película
Kind: captions
Language: es

STYLE
::cue(.amarillo) { color: yellow; }

REGION
id:abajo width:40% lines:3 regionanchor:0%,100% viewportanchor:10%,90% scroll:up

NOTE Traducción revisada

intro
00:00:01.000 --> 00:00:02.500 line:90% align:center
<v Ana>Hola</v> <c.amarillo>amigo</c>

00:00:03.000 --> 00:00:05.000 region:abajo
<i>Segunda</i>
línea
`;

// -- a tiny valid H.264 MP4 (same shape as boot.test.ts) ---------------------

function cat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

function mp4Box(type: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, body.length + 8);
  header.set(Uint8Array.from([...type].map((c) => c.charCodeAt(0))), 4);
  return cat(header, body);
}

const fullBox = (type: string, body: Uint8Array): Uint8Array => mp4Box(type, cat([0, 0, 0, 0], body));
const u16 = (v: number): Uint8Array => Uint8Array.from([(v >> 8) & 0xff, v & 0xff]);
const u32 = (v: number): Uint8Array => Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/**
 * A minimal demuxable H.264 MP4 (6 frames at 30 fps).
 * @param width picture width.
 * @param height picture height.
 * @param name file name.
 * @returns the file.
 */
export function tinyMp4(width = 640, height = 360, name = 'clip.mp4'): File {
  const avc1 = mp4Box('avc1', cat(
    new Uint8Array(6), u16(1), new Uint8Array(16), u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x0018), [0xff, 0xff],
    mp4Box('avcC', Uint8Array.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00])),
  ));
  const n = 6;
  const trak = mp4Box('trak', cat(
    fullBox('tkhd', cat(u32(0), u32(0), u32(1), u32(0), u32(n), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), new Uint8Array(36), u32(width << 16), u32(height << 16))),
    mp4Box('mdia', cat(
      fullBox('mdhd', cat(u32(0), u32(0), u32(30), u32(n), u16(0x55c4), u16(0))),
      fullBox('hdlr', cat(u32(0), ascii('vide'), new Uint8Array(12), [0])),
      mp4Box('minf', mp4Box('stbl', cat(
        fullBox('stsd', cat(u32(1), avc1)),
        fullBox('stts', cat(u32(n), ...Array.from({ length: n }, () => cat(u32(1), u32(1))))),
        fullBox('stsc', cat(u32(1), u32(1), u32(n), u32(1))),
        fullBox('stsz', cat(u32(0), u32(n), ...Array.from({ length: n }, () => u32(10)))),
        fullBox('stco', cat(u32(1), u32(0))),
      ))),
    )),
  ));
  const bytes = cat(mp4Box('ftyp', cat(ascii('isom'), u32(0x200), ascii('isomiso2avc1'))), mp4Box('moov', trak), mp4Box('mdat', new Uint8Array(n * 10)));
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new File([copy], name, { type: 'video/mp4', lastModified: 1700000000000 });
}
