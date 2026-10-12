// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Shared Fase 5 test fixtures: sessions, a recording 2D context, a fake AudioContext. */

import { defaultTextStyle } from '../src/model/document.ts';
import type { EditSession } from '../src/session/edit-session.ts';
import type { TextEngineContext } from '../src/render/text-engine.ts';
import type { RenderImage } from '../src/render/types.ts';
import { makeSession } from './f3-helpers.ts';

/** c1 video 0–2 s, c2 audio 2–5 s, c3 text 5–9 s (with a default style). */
export function makeF5Session(): EditSession {
  const session = makeSession([
    { start: 0, duration: 2 },
    { start: 2, duration: 3, kind: 'audio' },
    { start: 5, duration: 4, kind: 'text' },
  ]);
  const text = session.document.timelines[0]!.clips.find((clip) => clip.id === 'c3')!;
  text.text = { ...defaultTextStyle(), content: 'Hola mundo', shadow: false };
  session.history.rebase(session.document);
  return session;
}

/** One recorded canvas call. */
export interface Call {
  name: string;
  args: unknown[];
  /** Context state at call time. */
  state: { fillStyle: unknown; strokeStyle: unknown; shadowColor: string | undefined; shadowBlur: number | undefined; globalAlpha: number; lineWidth: number; textAlign: string };
}

/** A 2D context that records calls; `measureText` = 10 px per code point. */
export class RecordingContext implements TextEngineContext {
  readonly calls: Call[] = [];
  readonly gradients: { args: number[]; stops: [number, string][] }[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineJoin: 'round' | 'bevel' | 'miter' = 'miter';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  letterSpacing = '0px';
  shadowColor: string | undefined = 'rgba(0,0,0,0)';
  shadowBlur: number | undefined = 0;
  shadowOffsetX: number | undefined = 0;
  shadowOffsetY: number | undefined = 0;
  private readonly stack: Partial<RecordingContext>[] = [];
  /** Set false to emulate a canvas without `roundRect`/gradients. */
  readonly withRoundRect: boolean;
  readonly withGradient: boolean;

  constructor(options: { roundRect?: boolean; gradient?: boolean } = {}) {
    this.withRoundRect = options.roundRect ?? true;
    this.withGradient = options.gradient ?? true;
    if (!this.withRoundRect) this.roundRect = undefined;
    if (!this.withGradient) this.createLinearGradient = undefined;
  }

  private record(name: string, args: unknown[]): void {
    this.calls.push({
      name,
      args,
      state: {
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        shadowColor: this.shadowColor,
        shadowBlur: this.shadowBlur,
        globalAlpha: this.globalAlpha,
        lineWidth: this.lineWidth,
        textAlign: this.textAlign,
      },
    });
  }

  /** Calls of one name. */
  named(name: string): Call[] {
    return this.calls.filter((call) => call.name === name);
  }

  save(): void {
    this.stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, shadowColor: this.shadowColor, shadowBlur: this.shadowBlur, shadowOffsetX: this.shadowOffsetX, shadowOffsetY: this.shadowOffsetY });
    this.record('save', []);
  }
  restore(): void {
    Object.assign(this, this.stack.pop() ?? {});
    this.record('restore', []);
  }
  setTransform(...args: number[]): void {
    this.record('setTransform', args);
  }
  translate(x: number, y: number): void {
    this.record('translate', [x, y]);
  }
  rotate(angle: number): void {
    this.record('rotate', [angle]);
  }
  scale(x: number, y: number): void {
    this.record('scale', [x, y]);
  }
  clearRect(...args: number[]): void {
    this.record('clearRect', args);
  }
  fillRect(...args: number[]): void {
    this.record('fillRect', args);
  }
  drawImage(image: RenderImage, ...args: number[]): void {
    this.record('drawImage', [image, ...args]);
  }
  beginPath(): void {
    this.record('beginPath', []);
  }
  moveTo(x: number, y: number): void {
    this.record('moveTo', [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.record('lineTo', [x, y]);
  }
  closePath(): void {
    this.record('closePath', []);
  }
  arc(...args: number[]): void {
    this.record('arc', args);
  }
  rect(...args: number[]): void {
    this.record('rect', args);
  }
  fill(): void {
    this.record('fill', []);
  }
  stroke(): void {
    this.record('stroke', []);
  }
  fillText(text: string, x: number, y: number): void {
    this.record('fillText', [text, x, y]);
  }
  strokeText(text: string, x: number, y: number): void {
    this.record('strokeText', [text, x, y]);
  }
  measureText(text: string): { width: number } {
    return { width: Array.from(text).length * 10 };
  }
  roundRect?: (x: number, y: number, w: number, h: number, r: number) => void = (x, y, w, h, r) => {
    this.record('roundRect', [x, y, w, h, r]);
  };
  createLinearGradient?: (x0: number, y0: number, x1: number, y1: number) => CanvasGradient = (x0, y0, x1, y1) => {
    const entry = { args: [x0, y0, x1, y1], stops: [] as [number, string][] };
    this.gradients.push(entry);
    return { addColorStop: (offset: number, color: string) => entry.stops.push([offset, color]) };
  };
}

/** A fake `AudioParam`. */
export class FakeParam {
  value: number;
  readonly events: [string, number, number][] = [];
  constructor(value: number) {
    this.value = value;
  }
  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push(['set', value, time]);
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push(['ramp', value, time]);
  }
}

/** A fake Web Audio node graph that records connections. */
export class FakeNode {
  readonly kind: string;
  readonly connections: unknown[] = [];
  disconnected = 0;
  gain = new FakeParam(1);
  delayTime = new FakeParam(0);
  frequency = new FakeParam(440);
  playbackRate = new FakeParam(1);
  fftSize = 2048;
  /** Samples `getFloatTimeDomainData` returns (analysers). */
  samples: Float32Array = new Float32Array(0);
  type = 'sine';
  buffer: { readonly duration: number } | null = null;
  normalize = false;
  started = false;
  stopped = false;
  readonly maxDelay: number | undefined;

  constructor(kind: string, maxDelay?: number) {
    this.kind = kind;
    this.maxDelay = maxDelay;
  }
  connect(destination: unknown, output?: number): void {
    this.connections.push(output === undefined ? destination : [destination, output]);
  }
  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(0);
    target.set(this.samples.subarray(0, target.length));
  }
  disconnect(): void {
    this.disconnected += 1;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

/** A fake buffer for convolvers. */
export class FakeBuffer {
  readonly data: Float32Array[];
  readonly sampleRate: number;
  readonly duration: number;
  constructor(channels: number, length: number, sampleRate: number) {
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
  }
  copyToChannel(source: Float32Array, channel: number): void {
    this.data[channel]!.set(source);
  }
  getChannelData(channel: number): Float32Array {
    return this.data[channel]!;
  }
}

/** Narrows a node's buffer to the fake buffer (throws otherwise). */
export function fakeBuffer(value: unknown): FakeBuffer {
  if (!(value instanceof FakeBuffer)) throw new Error('not a FakeBuffer');
  return value;
}

/** A fake AudioContext with the Fase 5 factories. */
export class FakeAudioContext {
  readonly sampleRate = 48000;
  currentTime = 0;
  state = 'running';
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];

  private make(kind: string, maxDelay?: number): FakeNode {
    const node = new FakeNode(kind, maxDelay);
    this.nodes.push(node);
    return node;
  }
  createGain(): FakeNode {
    return this.make('gain');
  }
  createDelay(max?: number): FakeNode {
    return this.make('delay', max);
  }
  createConvolver(): FakeNode {
    return this.make('convolver');
  }
  createOscillator(): FakeNode {
    return this.make('oscillator');
  }
  createAnalyser(): FakeNode {
    return this.make('analyser');
  }
  createBufferSource(): FakeNode {
    return this.make('source');
  }
  createChannelSplitter(): FakeNode {
    return this.make('splitter');
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }
  /** Nodes of one kind. */
  of(kind: string): FakeNode[] {
    return this.nodes.filter((node) => node.kind === kind);
  }
}
