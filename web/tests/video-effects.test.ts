// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 video effects: CPU kernels (blur/vignette/pixelate/noise/glitch) and the Canvas 2D engine. */

import { describe, expect, it } from 'vitest';
import { createVideoEffect, type VideoEffectInstance } from '../src/media/effects/effects-stack.ts';
import {
  EFFECT_FRAGMENT_SHADERS,
  applyVideoEffectCpu,
  gaussianBlur,
  gaussianKernel,
  glitch,
  glitchBandOffset,
  hash3,
  noise,
  noiseFrame,
  pixelate,
  pixelateRows,
  smoothstep,
  vignette,
  vignetteFactor,
  type PixelImage,
} from '../src/media/effects/video-effects.ts';
import {
  VideoEffectsEngine,
  activePasses,
  getVideoEffectsHook,
  setVideoEffectsHook,
  type EffectSurface,
  type Effects2DContext,
} from '../src/render/video-effects-engine.ts';
import { solid } from './f4-helpers.ts';

function image(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(fill(x, y), (y * width + x) * 4);
  }
  return { data, width, height };
}

function px(img: PixelImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.slice(i, i + 4));
}

describe('gaussian blur', () => {
  it('kernel is normalised and symmetric', () => {
    const k = gaussianKernel(6);
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(k[0]).toBeCloseTo(k[k.length - 1]!, 7);
    expect(k.length).toBe(2 * Math.ceil(3 * 3) + 1);
  });

  it('spreads an edge in two passes and preserves flat areas', () => {
    const img = image(21, 21, (x) => (x < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    gaussianBlur(img, 4);
    expect(px(img, 0, 10)[0]).toBeLessThan(2);
    expect(px(img, 20, 10)[0]).toBeGreaterThan(253);
    const mid = px(img, 10, 10)[0]!;
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(255);
    // Vertical pass: every row identical.
    expect(px(img, 9, 0)).toEqual(px(img, 9, 20));
  });

  it('does not bleed transparent black into colour (premultiplied)', () => {
    const img = image(9, 1, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    gaussianBlur(img, 3);
    const [r, , , a] = px(img, 4, 0);
    expect(a).toBeGreaterThan(0);
    expect(r).toBeGreaterThan(250);
  });

  it('radius 0 is a no-op', () => {
    const img = image(3, 3, (x) => [x * 100, 0, 0, 255]);
    const before = img.data.slice();
    gaussianBlur(img, 0);
    expect(img.data).toEqual(before);
  });
});

describe('vignette', () => {
  it('leaves the centre and darkens the corners', () => {
    const params = { radius: 0.75, softness: 0.45, amount: 0.8 };
    expect(vignetteFactor(0.5, 0.5, 16 / 9, params)).toBe(1);
    expect(vignetteFactor(0, 0, 16 / 9, params)).toBeCloseTo(0.2, 5);
    const img = image(32, 18, () => [200, 200, 200, 255]);
    vignette(img, params);
    expect(px(img, 16, 9)[0]).toBe(200);
    expect(px(img, 0, 0)[0]).toBeLessThan(60);
    expect(px(img, 0, 0)[3]).toBe(255);
  });

  it('smoothstep is clamped and handles degenerate edges', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0.5, 0.5, 0.6)).toBe(1);
  });
});

describe('pixelate', () => {
  it('floor(uv·blocks)/blocks: every cell takes its centre colour', () => {
    const img = image(8, 4, (x, y) => [x * 30, y * 60, 0, 255]);
    pixelate(img, 2);
    expect(pixelateRows(2, 8, 4)).toBe(1);
    // Left cell centre x=2 (uv 0.25 → px 2), right x=6; one row → y=2.
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) expect(px(img, x, y)).toEqual([60, 120, 0, 255]);
      for (let x = 4; x < 8; x += 1) expect(px(img, x, y)).toEqual([180, 120, 0, 255]);
    }
  });
});

describe('noise', () => {
  it('is deterministic per frame and animates with time', () => {
    expect(hash3(1, 2, 3)).toBe(hash3(1, 2, 3));
    expect(hash3(1, 2, 3)).not.toBe(hash3(1, 2, 4));
    expect(noiseFrame(1, 24)).toBe(24);
    expect(noiseFrame(1, 0)).toBe(0);
    const a = image(16, 16, () => [128, 128, 128, 255]);
    const b = image(16, 16, () => [128, 128, 128, 255]);
    const c = image(16, 16, () => [128, 128, 128, 255]);
    noise(a, { amount: 0.5, speed: 24 }, 0.01);
    noise(b, { amount: 0.5, speed: 24 }, 0.02);
    noise(c, { amount: 0.5, speed: 24 }, 1);
    expect(a.data).toEqual(b.data); // same frame (0.01·24 and 0.02·24 floor to 0)
    expect(a.data).not.toEqual(c.data);
    // Monochrome grain.
    const [r, g, bl] = px(c, 3, 3);
    expect(r).toBe(g);
    expect(g).toBe(bl);
  });
});

describe('glitch', () => {
  it('splits RGB channels horizontally', () => {
    const img = image(20, 4, (x) => (x === 10 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    glitch(img, { amount: 1, rgbShift: 0.1, bands: 1, speed: 0 }, 0);
    const offset = Math.round(glitchBandOffset(0, 0, 1) * 20);
    const red = Array.from({ length: 20 }, (_, x) => px(img, x, 0)[0]).indexOf(255);
    const blue = Array.from({ length: 20 }, (_, x) => px(img, x, 0)[2]).indexOf(255);
    expect(red).toBe(10 + offset - 2);
    expect(blue).toBe(10 + offset + 2);
  });

  it('band offsets stay within ±5 % · amount', () => {
    for (let band = 0; band < 50; band += 1) expect(Math.abs(glitchBandOffset(band, 3, 0.8))).toBeLessThanOrEqual(0.04);
    expect(glitchBandOffset(1, 1, 0)).toBe(0);
  });
});

describe('dispatcher and shaders', () => {
  it('applies effects by type and ignores unknown ones', () => {
    const img = image(4, 4, () => [100, 100, 100, 255]);
    applyVideoEffectCpu(img, { type: 'warp', params: {} }, 0);
    expect(px(img, 0, 0)).toEqual([100, 100, 100, 255]);
    applyVideoEffectCpu(img, { type: 'vignette', params: { amount: 1, radius: 0.1, softness: 0.05 } }, 0);
    expect(px(img, 0, 0)[0]).toBe(0);
  });

  it('ships one fragment shader per effect', () => {
    for (const source of Object.values(EFFECT_FRAGMENT_SHADERS)) expect(source).toMatch(/^#version 300 es/);
    expect(EFFECT_FRAGMENT_SHADERS.pixelate).toContain('floor');
  });
});

/** A fake 2D context over a pixel buffer (nearest-neighbour drawImage). */
class Fake2D implements Effects2DContext {
  pixels: PixelImage;
  imageSmoothingEnabled = false;
  readonly ops: string[] = [];
  private currentFilter = 'none';
  constructor(
    private readonly surface: EffectSurface,
    private readonly registry: Map<object, Fake2D>,
    private readonly withFilter: boolean,
  ) {
    this.pixels = { data: new Uint8ClampedArray(surface.width * surface.height * 4), width: surface.width, height: surface.height };
    registry.set(surface, this);
  }
  /** Like Safari: without filter support, writes are ignored. */
  get filter(): string {
    return this.withFilter ? this.currentFilter : '';
  }
  set filter(value: string) {
    if (this.withFilter) this.currentFilter = value;
  }
  private sync(): void {
    if (this.pixels.width !== this.surface.width || this.pixels.height !== this.surface.height) {
      this.pixels = { data: new Uint8ClampedArray(this.surface.width * this.surface.height * 4), width: this.surface.width, height: this.surface.height };
    }
  }
  drawImage(image: object, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    this.sync();
    this.ops.push(`draw:${this.filter}`);
    const src = this.registry.get(image)?.pixels;
    if (!src) return;
    const blur = /^blur\(([\d.]+)px\)$/.exec(this.filter);
    if (blur) {
      // CSS blur(σ) ≈ the CPU kernel with radius 2σ.
      const copy = { data: src.data.slice(), width: src.width, height: src.height };
      gaussianBlur(copy, Number(blur[1]) * 2);
      const saved = this.currentFilter;
      this.currentFilter = 'none';
      const temp = new Map(this.registry);
      const ghost = document.createElement('canvas');
      ghost.width = src.width;
      ghost.height = src.height;
      const ghostCtx = new Fake2D(ghost, temp, false);
      ghostCtx.pixels = copy;
      this.registry.set(ghost, ghostCtx);
      this.drawImage(ghost, sx, sy, sw, sh, dx, dy, dw, dh);
      this.registry.delete(ghost);
      this.currentFilter = saved;
      return;
    }
    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        const fx = Math.min(src.width - 1, Math.floor(sx + ((x + 0.5) / dw) * sw));
        const fy = Math.min(src.height - 1, Math.floor(sy + ((y + 0.5) / dh) * sh));
        const s = (fy * src.width + fx) * 4;
        this.pixels.data.set(src.data.slice(s, s + 4), ((dy + y) * this.pixels.width + dx + x) * 4);
      }
    }
  }
  getImageData(x: number, y: number, w: number, h: number): PixelImage {
    this.sync();
    this.ops.push('get');
    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row += 1) {
      const start = ((y + row) * this.pixels.width + x) * 4;
      out.set(this.pixels.data.slice(start, start + w * 4), row * w * 4);
    }
    return { data: out, width: w, height: h };
  }
  putImageData(image: PixelImage, x: number, y: number): void {
    this.sync();
    this.ops.push('put');
    for (let row = 0; row < image.height; row += 1) {
      this.pixels.data.set(image.data.slice(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * this.pixels.width + x) * 4);
    }
  }
  clearRect(): void {
    this.sync();
    this.pixels.data.fill(0);
  }
}

function harness(withFilter = false) {
  const registry = new Map<object, Fake2D>();
  const created: EffectSurface[] = [];
  const engine = new VideoEffectsEngine({
    forceCanvas2d: true,
    createSurface: (w, h) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      created.push(canvas);
      return canvas;
    },
    context2d: (surface) => registry.get(surface) ?? new Fake2D(surface, registry, withFilter),
  });
  const source = document.createElement('canvas');
  source.width = 40;
  source.height = 20;
  const sourceCtx = new Fake2D(source, registry, false);
  sourceCtx.pixels.data.set(solid(40, 20, [200, 100, 50, 255]));
  return { engine, registry, source, created };
}

describe('VideoEffectsEngine (Canvas 2D backend)', () => {
  it('returns null for an empty or all-bypassed stack', () => {
    const { engine, source } = harness();
    expect(engine.apply(source, { sx: 0, sy: 0, sw: 40, sh: 20 }, [], 0)).toBeNull();
    const off: VideoEffectInstance = { ...createVideoEffect('vignette'), enabled: false };
    expect(engine.apply(source, { sx: 0, sy: 0, sw: 40, sh: 20 }, [off, createVideoEffect('blur', { radius: 0 })], 0)).toBeNull();
    expect(activePasses([off])).toEqual([]);
  });

  it('crops the source and runs ImageData effects in order', () => {
    const { engine, registry, source } = harness();
    const out = engine.apply(source, { sx: 10, sy: 5, sw: 20, sh: 10 }, [createVideoEffect('vignette', { amount: 1, radius: 0.5, softness: 0.1 })], 0);
    expect(engine.backend).toBe('canvas2d');
    expect(out).not.toBeNull();
    const ctx = registry.get(out!)!;
    expect(ctx.pixels.width).toBe(20);
    expect(px(ctx.pixels, 10, 5)).toEqual([200, 100, 50, 255]);
    expect(px(ctx.pixels, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(ctx.ops.filter((op) => op === 'get')).toHaveLength(1);
  });

  it('order matters: blur→vignette ≠ vignette→blur', () => {
    const blur = createVideoEffect('blur', { radius: 4 });
    const vig = createVideoEffect('vignette', { amount: 1 });
    const a = harness();
    const b = harness();
    for (const h of [a, b]) {
      const pixels = h.registry.get(h.source)!.pixels;
      pixels.data.set(image(40, 20, (x) => (x % 8 < 4 ? [255, 255, 255, 255] : [0, 0, 0, 255])).data);
    }
    const outA = a.engine.apply(a.source, { sx: 0, sy: 0, sw: 40, sh: 20 }, [blur, vig], 0)!;
    const pixelsA = a.registry.get(outA)!.pixels.data.slice();
    const outB = b.engine.apply(b.source, { sx: 0, sy: 0, sw: 40, sh: 20 }, [vig, blur], 0)!;
    expect(b.registry.get(outB)!.pixels.data).not.toEqual(pixelsA);
  });

  it('uses ctx.filter blur when the platform supports it', () => {
    const { engine, registry, source } = harness(true);
    engine.apply(source, { sx: 0, sy: 0, sw: 40, sh: 20 }, [createVideoEffect('blur', { radius: 10 })], 0);
    const filtered = [...registry.values()].flatMap((ctx) => ctx.ops).filter((op) => op === 'draw:blur(5px)');
    expect(filtered).toHaveLength(1);
  });

  it('blurs big radii on a downscaled copy without ctx.filter', () => {
    const { engine, registry, source } = harness(false);
    const out = engine.apply(source, { sx: 0, sy: 0, sw: 40, sh: 20 }, [createVideoEffect('blur', { radius: 24 })], 0)!;
    // A flat picture stays flat after blurring.
    expect(px(registry.get(out)!.pixels, 20, 10)).toEqual([200, 100, 50, 255]);
  });

  it('reports "none" without surfaces, and dispose resets', () => {
    const engine = new VideoEffectsEngine({ forceCanvas2d: true, createSurface: () => null });
    const canvas = document.createElement('canvas');
    expect(engine.apply(canvas, { sx: 0, sy: 0, sw: 4, sh: 4 }, [createVideoEffect('noise')], 0)).toBeNull();
    expect(engine.backend).toBe('none');
    engine.dispose();
    expect(engine.backend).toBeNull();
  });

  it('installs and clears the global hook', () => {
    const hook = { resolve: () => null, apply: () => null };
    setVideoEffectsHook(hook);
    expect(getVideoEffectsHook()).toBe(hook);
    setVideoEffectsHook(null);
    expect(getVideoEffectsHook()).toBeNull();
  });
});
