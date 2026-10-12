// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors
// @vitest-environment jsdom

/** Eyedropper: native API when present, click-on-preview fallback, Escape cancels. */

import { afterEach, describe, expect, it } from 'vitest';
import { Eyedropper, type EyedropperCanvas } from '../src/media/vision/eyedropper.ts';
import type { PixelReader } from '../src/media/vision/chroma-key.ts';

function fakeCanvas(): EyedropperCanvas & { click(x: number, y: number): void } {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    width: 4,
    height: 4,
    style: { cursor: 'default' },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    click(x, y) {
      for (const l of [...listeners]) l(new MouseEvent('click', { clientX: x, clientY: y }));
    },
  };
}

const reader: PixelReader = {
  canvas: { width: 4, height: 4 },
  getImageData: (_x, _y, w, h) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) data.set([10, 200, 30, 255], i);
    return { data, width: w, height: h };
  },
};

afterEach(() => {
  Reflect.deleteProperty(window, 'EyeDropper');
});

describe('Eyedropper', () => {
  it('samples the clicked pixel and restores the cursor', async () => {
    const canvas = fakeCanvas();
    const dropper = new Eyedropper();
    const pending = dropper.pick(canvas, reader, { useNative: false });
    expect(dropper.active).toBe(true);
    expect(canvas.style.cursor).toBe('crosshair');
    canvas.click(20, 20);
    expect(await pending).toEqual([10, 200, 30]);
    expect(canvas.style.cursor).toBe('default');
    expect(dropper.active).toBe(false);
  });

  it('cancels with Escape or cancel()', async () => {
    const canvas = fakeCanvas();
    const dropper = new Eyedropper();
    const first = dropper.pick(canvas, reader, { useNative: false });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await first).toBeNull();
    const second = dropper.pick(canvas, reader, { useNative: false });
    dropper.cancel();
    expect(await second).toBeNull();
  });

  it('uses window.EyeDropper when available', async () => {
    Reflect.set(window, 'EyeDropper', class { open(): Promise<{ sRGBHex: string }> { return Promise.resolve({ sRGBHex: '#00ff80' }); } });
    expect(await new Eyedropper().pick(fakeCanvas(), reader)).toEqual([0, 255, 128]);
    Reflect.set(window, 'EyeDropper', class { open(): Promise<{ sRGBHex: string }> { return Promise.reject(new Error('abort')); } });
    expect(await new Eyedropper().pick(fakeCanvas(), reader)).toBeNull();
  });
});
