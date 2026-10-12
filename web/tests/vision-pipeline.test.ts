// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/**
 * The picture-effects pipeline: clip effects JSON, the CPU reference
 * (`processPixels`), the WebGL2 renderer (against a recording GL double),
 * the processor's Canvas 2D fallback and the compositor hook.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import type { Clip } from '../src/core/timeline.ts';
import {
  EFFECTS_VERSION,
  emptyClipEffects,
  hasAudioEffects,
  hasVisualEffects,
  parseClipEffects,
  serializeClipEffects,
  type ClipEffects,
} from '../src/media/clip-effects.ts';
import { DEFAULT_CHROMA_KEY } from '../src/media/vision/chroma-key.ts';
import { EFFECT_UNIFORMS, GL, GLVisionRenderer, buildProgram, type GLLike } from '../src/media/vision/chroma-shader.ts';
import { NEUTRAL_GRADING } from '../src/media/vision/color-grading.ts';
import { builtinLut, generateLut } from '../src/media/vision/lut-loader.ts';
import { VisionProcessor, processPixels } from '../src/media/vision/vision-processor.ts';
import {
  VisionPipeline,
  getVisionHook,
  renderFrame,
  setVisionHook,
  type FramePool,
  type RenderContext2D,
  type RenderImage,
  type RenderTarget,
} from '../src/render/index.ts';
import { EditorSession } from '../src/session/editor-session.ts';
import type { MediaItem } from '../src/model/document.ts';
import { solid } from './f4-helpers.ts';

const withEffects = (patch: Partial<ClipEffects>): ClipEffects => ({ ...emptyClipEffects(), ...patch });
const chroma = withEffects({ chromaKey: { ...DEFAULT_CHROMA_KEY } });

afterEach(() => setVisionHook(null));

describe('clip effects JSON', () => {
  it('serialises only what is set and parses leniently', () => {
    expect(serializeClipEffects(emptyClipEffects())).toBeNull();
    const effects = withEffects({ chromaKey: { ...DEFAULT_CHROMA_KEY, color: [0, 0, 255] }, lut: { id: 'builtin:warm', strength: 0.5 }, splitView: true });
    const json = serializeClipEffects(effects)!;
    expect(json['version']).toBe(EFFECTS_VERSION);
    expect(Object.keys(json).sort()).toEqual(['chromaKey', 'lut', 'splitView', 'version']);
    expect(parseClipEffects(JSON.parse(JSON.stringify(json)))).toEqual(effects);
    const lenient = parseClipEffects({ chromaKey: { similarity: 9 }, lut: { id: '', strength: 1 }, spill: { amount: 7 }, colorGrading: { exposure: 1 }, junk: 1 });
    expect(lenient.chromaKey).toBeNull();
    expect(lenient.lut).toBeNull();
    expect(lenient.spill?.amount).toBe(1);
    expect(lenient.colorGrading?.exposure).toBe(1);
    expect(parseClipEffects('nope')).toEqual(emptyClipEffects());
    expect(parseClipEffects([1, 2])).toEqual(emptyClipEffects());
  });

  it('tells visual from audio effects', () => {
    expect(hasVisualEffects(emptyClipEffects())).toBe(false);
    expect(hasVisualEffects(withEffects({ colorGrading: { ...NEUTRAL_GRADING } }))).toBe(false);
    expect(hasVisualEffects(withEffects({ colorGrading: { ...NEUTRAL_GRADING, saturation: 0 } }))).toBe(true);
    expect(hasVisualEffects(withEffects({ lut: { id: 'x', strength: 0 } }))).toBe(false);
    expect(hasVisualEffects(withEffects({ feather: { enabled: true, radius: 0, choke: 0 } }))).toBe(false);
    expect(hasVisualEffects(chroma)).toBe(true);
    expect(hasAudioEffects(chroma)).toBe(false);
    const audio = parseClipEffects({ audio: { preservePitch: true } });
    expect(hasAudioEffects(audio)).toBe(true);
  });
});

describe('processPixels (CPU reference)', () => {
  it('keys, grades and looks up in order', () => {
    const px = new Uint8ClampedArray([0, 255, 0, 255, 200, 50, 50, 255]);
    processPixels(px, 2, 1, withEffects({ chromaKey: { ...DEFAULT_CHROMA_KEY }, colorGrading: { ...NEUTRAL_GRADING, saturation: 0 } }), null);
    expect(px[3]).toBe(0);
    expect(px[4]).toBe(px[5]);
    const inv = generateLut('inv', 'inv', 2, (r, g, b) => [1 - r, 1 - g, 1 - b]);
    const looked = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    processPixels(looked, 1, 2, withEffects({ lut: { id: 'inv', strength: 1 }, splitView: true }), inv);
    // Split view: the LUT only affects the right half (1 px wide → column 0 is the left).
    expect(looked[0]).toBe(0);
    const full = new Uint8ClampedArray([0, 0, 0, 255]);
    processPixels(full, 1, 1, withEffects({ lut: { id: 'inv', strength: 1 } }), inv);
    expect(full[0]).toBe(255);
  });

  it('runs luma key and feather', () => {
    const px = solid(8, 1, [255, 255, 255, 255]);
    px.set([0, 0, 0, 255], 0);
    processPixels(px, 8, 1, withEffects({ lumaKey: { enabled: true, min: 0.1, max: 1, smoothness: 0, invert: false }, feather: { enabled: true, radius: 2, choke: 0 } }), null);
    expect(px[3]).toBeLessThan(255);
    expect(px[7 * 4 + 3]).toBe(255);
  });
});

/** A WebGL2 double that records calls and hands out tokens. */
class RecordingGL implements GLLike<string> {
  calls: string[] = [];
  created = 0;
  deleted = 0;
  failCompile = false;
  lost = false;
  private obj(kind: string): { kind: string; n: number } {
    this.created += 1;
    return { kind, n: this.created };
  }
  private log(name: string): void {
    this.calls.push(name);
  }
  createShader(type: number): WebGLShader | null { this.log(`createShader:${type}`); return this.obj('shader'); }
  shaderSource(): void { this.log('shaderSource'); }
  compileShader(): void { this.log('compileShader'); }
  getShaderParameter(): unknown { return !this.failCompile; }
  getShaderInfoLog(): string | null { return 'ERROR: 0:1: syntax'; }
  deleteShader(): void { this.log('deleteShader'); }
  createProgram(): WebGLProgram | null { return this.obj('program'); }
  attachShader(): void { this.log('attachShader'); }
  linkProgram(): void { this.log('linkProgram'); }
  getProgramParameter(): unknown { return true; }
  getProgramInfoLog(): string | null { return ''; }
  useProgram(): void { this.log('useProgram'); }
  deleteProgram(): void { this.deleted += 1; this.log('deleteProgram'); }
  getUniformLocation(_p: WebGLProgram, name: string): WebGLUniformLocation | null { return { name }; }
  uniform1i(): void { this.log('uniform1i'); }
  uniform1f(): void { this.log('uniform1f'); }
  uniform2f(): void { this.log('uniform2f'); }
  uniformMatrix3fv(): void { this.log('uniformMatrix3fv'); }
  createVertexArray(): WebGLVertexArrayObject | null { return this.obj('vao'); }
  bindVertexArray(): void { this.log('bindVertexArray'); }
  deleteVertexArray(): void { this.deleted += 1; }
  createTexture(): WebGLTexture | null { return this.obj('texture'); }
  bindTexture(target: number): void { this.log(`bindTexture:${target}`); }
  activeTexture(unit: number): void { this.log(`activeTexture:${unit - GL.TEXTURE0}`); }
  texParameteri(): void { this.log('texParameteri'); }
  pixelStorei(): void { this.log('pixelStorei'); }
  texImage2D(...args: unknown[]): void { this.log(`texImage2D:${args.length}`); }
  texImage3D(...args: unknown[]): void { this.log(`texImage3D:${String(args[2])}`); }
  deleteTexture(texture: WebGLTexture | null): void { if (texture) this.deleted += 1; }
  createFramebuffer(): WebGLFramebuffer | null { return this.obj('framebuffer'); }
  bindFramebuffer(_t: number, fb: WebGLFramebuffer | null): void { this.log(fb ? 'bindFramebuffer:target' : 'bindFramebuffer:canvas'); }
  framebufferTexture2D(): void { this.log('framebufferTexture2D'); }
  deleteFramebuffer(): void { this.deleted += 1; }
  viewport(): void { this.log('viewport'); }
  clearColor(): void { this.log('clearColor'); }
  clear(): void { this.log('clear'); }
  drawArrays(): void { this.log('drawArrays'); }
  isContextLost(): boolean { return this.lost; }
}

describe('GLVisionRenderer', () => {
  it('draws one pass without feather and three with it', () => {
    const gl = new RecordingGL();
    const renderer = new GLVisionRenderer(gl);
    renderer.render('frame', 64, 32, chroma, null);
    expect(gl.calls.filter((c) => c === 'drawArrays')).toHaveLength(1);
    expect(gl.calls).toContain('bindFramebuffer:canvas');
    gl.calls = [];
    renderer.render('frame', 64, 32, withEffects({ chromaKey: { ...DEFAULT_CHROMA_KEY }, feather: { enabled: true, radius: 4, choke: 0 } }), null);
    expect(gl.calls.filter((c) => c === 'drawArrays')).toHaveLength(3);
    expect(gl.calls.filter((c) => c === 'framebufferTexture2D')).toHaveLength(2);
    expect(gl.calls[gl.calls.length - 1]).toBe('drawArrays');
    // Same size again: targets are reused.
    gl.calls = [];
    renderer.render('frame', 64, 32, withEffects({ feather: { enabled: true, radius: 4, choke: 0 } }), null);
    expect(gl.calls).not.toContain('framebufferTexture2D');
  });

  it('uploads a LUT once as RGBA16F on texture unit 1', () => {
    const gl = new RecordingGL();
    const renderer = new GLVisionRenderer(gl);
    const warm = builtinLut('builtin:warm')!;
    const fx = withEffects({ lut: { id: warm.id, strength: 0.7 } });
    renderer.render('frame', 8, 8, fx, warm);
    renderer.render('frame', 8, 8, fx, warm);
    expect(gl.calls.filter((c) => c.startsWith('texImage3D'))).toEqual([`texImage3D:${GL.RGBA16F}`]);
    expect(gl.calls).toContain('activeTexture:1');
    expect(EFFECT_UNIFORMS).toContain('u_lutStrength');
  });

  it('frees every object and refuses to render afterwards', () => {
    const gl = new RecordingGL();
    const renderer = new GLVisionRenderer(gl);
    renderer.render('frame', 16, 16, withEffects({ feather: { enabled: true, radius: 2, choke: 0 } }), builtinLut('builtin:bw') ?? null);
    renderer.render('frame', 16, 16, withEffects({ lut: { id: 'builtin:bw', strength: 1 } }), builtinLut('builtin:bw')!);
    renderer.dispose();
    // 2 programs + vao + source texture + lut texture + 2×(texture+framebuffer).
    expect(gl.deleted).toBe(9);
    renderer.dispose();
    expect(gl.deleted).toBe(9);
    expect(() => renderer.render('frame', 16, 16, chroma, null)).toThrow(/liberado/);
  });

  it('reports shader compile errors', () => {
    const gl = new RecordingGL();
    gl.failCompile = true;
    expect(() => buildProgram(gl, 'vs', 'fs')).toThrow(/Error al compilar shader: ERROR: 0:1: syntax/);
    expect(gl.calls).toContain('deleteShader');
  });
});

/** Pixels behind fake canvases (jsdom has no 2D context). */
const store = new WeakMap<object, { data: Uint8ClampedArray; width: number }>();

function fakeCanvas(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  store.set(canvas, { data: solid(width, height, fill), width });
  const ctx = {
    canvas,
    clearRect(): void {
      store.set(canvas, { data: new Uint8ClampedArray(canvas.width * canvas.height * 4), width: canvas.width });
    },
    drawImage(image: object): void {
      const src = store.get(image);
      if (src) store.set(canvas, { data: src.data.slice(), width: src.width });
    },
    getImageData(): { data: Uint8ClampedArray; width: number; height: number } {
      const own = store.get(canvas)!;
      return { data: own.data.slice(), width: canvas.width, height: canvas.height };
    },
    putImageData(image: { data: Uint8ClampedArray }): void {
      store.set(canvas, { data: image.data.slice(), width: canvas.width });
    },
  };
  Object.defineProperty(canvas, 'getContext', { value: (type: string) => (type === '2d' ? ctx : null) });
  return canvas;
}

describe('VisionProcessor', () => {
  it('falls back to Canvas 2D and processes the pixels', () => {
    const surface = fakeCanvas(2, 2);
    const processor = new VisionProcessor({ createSurface: () => surface });
    const frame = fakeCanvas(2, 2, [0, 255, 0, 255]);
    expect(processor.process(frame, 2, 2, emptyClipEffects())).toBeNull();
    expect(processor.backend).toBeNull();
    const out = processor.process(frame, 2, 2, chroma);
    expect(out).toBe(surface);
    expect(processor.backend).toBe('canvas2d');
    expect(store.get(surface)!.data[3]).toBe(0);
    processor.dispose();
    expect(processor.backend).toBeNull();
  });

  it('resolves built-in and session LUTs', () => {
    const custom = generateLut('file:x', 'x', 2, (r, g, b) => [r, g, b]);
    const processor = new VisionProcessor({ resolveLut: (id) => (id === custom.id ? custom : undefined) });
    expect(processor.lutFor('builtin:warm')?.size).toBe(17);
    expect(processor.lutFor('file:x')).toBe(custom);
    expect(processor.lutFor('missing')).toBeNull();
  });

  it('reports "none" when no canvas can be created', () => {
    const processor = new VisionProcessor({ createSurface: () => null });
    expect(processor.process(fakeCanvas(1, 1), 1, 1, chroma)).toBeNull();
    expect(processor.backend).toBe('none');
  });
});

function mediaItem(id: string): MediaItem {
  return {
    id, path: `media/${id}`, name: id, duration: 6, kind: 'video', width: 1920, height: 1080, frameRate: 30,
    frameRateFraction: '30/1', videoCodec: 'h264', audioCodec: null, hasAudio: false, audioTracks: [], slot: false,
    origin: null, colorRange: null, colorSpace: 'sdr', extra: {},
  };
}

/** Records which picture each drawImage got. */
class ImageRecorder implements RenderContext2D {
  images: RenderImage[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineJoin: 'round' | 'bevel' | 'miter' = 'miter';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  font = '';
  textAlign = 'center';
  textBaseline = 'middle';
  letterSpacing = '0px';
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  translate(): void {}
  rotate(): void {}
  scale(): void {}
  clearRect(): void {}
  fillRect(): void {}
  drawImage(image: RenderImage): void { this.images.push(image); }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void {}
  rect(): void {}
  fill(): void {}
  stroke(): void {}
  fillText(): void {}
  strokeText(): void {}
  measureText(text: string): { width: number } { return { width: text.length }; }
}

class Target implements RenderTarget {
  width = 640;
  height = 360;
  readonly ctx = new ImageRecorder();
  getContext(): RenderContext2D { return this.ctx; }
}

class Pool implements FramePool {
  readonly frame = fakeCanvas(4, 4, [0, 255, 0, 255]);
  async getFrame(): Promise<RenderImage | null> { return this.frame; }
  getSize(): { width: number; height: number } { return { width: 1920, height: 1080 }; }
}

describe('compositor hook', () => {
  it('draws the source untouched when no hook is installed', async () => {
    const session = new EditorSession();
    session.addMediaItem(mediaItem('m1'));
    session.addClipAt('m1', Rational.ZERO);
    const target = new Target();
    const pool = new Pool();
    expect(getVisionHook()).toBeNull();
    await renderFrame(session.engine, Rational.fromInt(1n), target, pool);
    expect(target.ctx.images).toEqual([pool.frame]);
  });

  it('draws the processed picture with the source size before blending', async () => {
    const session = new EditorSession();
    session.addMediaItem(mediaItem('m1'));
    session.addClipAt('m1', Rational.ZERO);
    const processed = fakeCanvas(1920, 1080);
    const seen: { clip: Clip; w: number; h: number }[] = [];
    setVisionHook({
      process(clip, _source, w, h) {
        seen.push({ clip, w, h });
        return processed;
      },
    });
    const target = new Target();
    await renderFrame(session.engine, Rational.fromInt(1n), target, new Pool());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.w).toBe(1920);
    expect(seen[0]!.h).toBe(1080);
    expect(target.ctx.images).toEqual([processed]);
  });

  it('VisionPipeline resolves effects per clip and can be toggled off', async () => {
    const session = new EditorSession();
    session.addMediaItem(mediaItem('m1'));
    session.addClipAt('m1', Rational.ZERO);
    const surface = fakeCanvas(4, 4);
    const errors: string[] = [];
    let effects: ClipEffects | null = chroma;
    const pipeline = new VisionPipeline(() => effects, {
      processor: new VisionProcessor({ createSurface: () => surface }),
      onError: (e) => errors.push(e.message),
    });
    setVisionHook(pipeline);
    const pool = new Pool();
    const target = new Target();
    await renderFrame(session.engine, Rational.fromInt(1n), target, pool);
    expect(target.ctx.images[0]).toBe(surface);
    expect(pipeline.backend).toBe('canvas2d');

    pipeline.enabled = false;
    await renderFrame(session.engine, Rational.fromInt(1n), target, pool);
    expect(target.ctx.images[1]).toBe(pool.frame);

    pipeline.enabled = true;
    effects = null;
    await renderFrame(session.engine, Rational.fromInt(1n), target, pool);
    expect(target.ctx.images[2]).toBe(pool.frame);
    expect(pipeline.applyEffects(pool.frame, emptyClipEffects(), 4, 4)).toBeNull();
    pipeline.dispose();
    expect(errors).toEqual([]);
  });

  it('reports resolver/processor errors once and draws the original', async () => {
    const errors: string[] = [];
    const pipeline = new VisionPipeline(() => {
      throw new Error('extra corrupto');
    }, { onError: (e) => errors.push(e.message) });
    const session = new EditorSession();
    session.addMediaItem(mediaItem('m1'));
    session.addClipAt('m1', Rational.ZERO);
    setVisionHook(pipeline);
    const pool = new Pool();
    const target = new Target();
    await renderFrame(session.engine, Rational.fromInt(1n), target, pool);
    await renderFrame(session.engine, Rational.fromInt(2n), target, pool);
    expect(target.ctx.images).toEqual([pool.frame, pool.frame]);
    expect(errors).toEqual(['extra corrupto']);

    const broken = new VisionProcessor({
      createSurface: () => {
        throw new Error('sin lienzo');
      },
    });
    const failing = new VisionPipeline(() => chroma, { processor: broken, onError: (e) => errors.push(e.message) });
    expect(failing.applyEffects(pool.frame, chroma, 4, 4)).toBeNull();
    expect(errors).toEqual(['extra corrupto', 'sin lienzo']);
  });
});
