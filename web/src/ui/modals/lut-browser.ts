// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * LUT browser: built-in looks and session `.cube` files with previews.
 * Keyboard: arrows move, Enter applies, Escape cancels. Previews are a
 * reference strip graded through each LUT on the CPU; their ObjectURLs are
 * revoked when the dialog closes.
 */

import { applyLut, sampleLut } from '../../media/vision/lut-applier.ts';
import type { Lut3D } from '../../media/vision/lut-loader.ts';
import { Dialog } from './dialog.ts';

/** Preview strip size. */
const PREVIEW_W = 96;
const PREVIEW_H = 40;

/** The reference strip: hue sweep (x) over a luminance ramp (y). */
export function referenceStrip(width = PREVIEW_W, height = PREVIEW_H): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const light = 1 - y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const h = (x / width) * 6;
      const c = 0.8;
      const k = c * (1 - Math.abs((h % 2) - 1));
      const [r, g, b] = h < 1 ? [c, k, 0] : h < 2 ? [k, c, 0] : h < 3 ? [0, c, k] : h < 4 ? [0, k, c] : h < 5 ? [k, 0, c] : [c, 0, k];
      const mix = (v: number): number => Math.round(255 * Math.min(1, (v * 0.7 + 0.15) * light * 1.2));
      out.set([mix(r), mix(g), mix(b), 255], (y * width + x) * 4);
    }
  }
  return out;
}

/**
 * A CSS gradient approximating a LUT (fallback when no canvas exists).
 * @param lut the LUT.
 * @returns a `linear-gradient(...)` value.
 */
export function lutGradient(lut: Lut3D): string {
  const stops: string[] = [];
  for (let i = 0; i <= 6; i += 1) {
    const t = i / 6;
    const [r, g, b] = sampleLut(lut, t, t * 0.8 + 0.1, 1 - t);
    stops.push(`rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** Options of {@link openLutBrowser}. */
export interface LutBrowserOptions {
  luts: readonly Lut3D[];
  currentId: string | null;
  /** Loads a `.cube` from disk (returns the added LUT). */
  importLut?: (file: File) => Promise<Lut3D | null>;
  /** Grades the reference strip off the main thread (vision worker). */
  render?: (pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, lut: Lut3D) => Promise<Uint8ClampedArray<ArrayBuffer>>;
}

/**
 * Opens the browser.
 * @param options LUTs, current selection, import hook.
 * @returns the chosen LUT, or null when cancelled.
 */
export function openLutBrowser(options: LutBrowserOptions): Promise<Lut3D | null> {
  const dialog = new Dialog({
    title: 'Explorador de LUTs',
    description: 'Flechas para moverse, Enter para aplicar, Esc para cancelar.',
    className: 'lut-browser',
  });
  const urls: string[] = [];
  dialog.onClose(() => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.length = 0;
  });
  let luts = [...options.luts];
  let chosen: Lut3D | null = null;
  let index = Math.max(0, luts.findIndex((lut) => lut.id === options.currentId));

  const list = document.createElement('div');
  list.className = 'lut-grid';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'LUTs disponibles');
  list.tabIndex = 0;
  dialog.body.appendChild(list);

  const preview = (lut: Lut3D, target: HTMLElement): void => {
    target.style.backgroundImage = lutGradient(lut);
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const context = ctx;
    const graded = options.render
      ? options.render(referenceStrip(), PREVIEW_W, PREVIEW_H, lut)
      : Promise.resolve(referenceStrip()).then((pixels) => {
        applyLut(pixels, lut, 1);
        return pixels;
      });
    void graded.then((pixels) => {
      if (!dialog.isOpen) return;
      context.putImageData(new ImageData(pixels, PREVIEW_W, PREVIEW_H), 0, 0);
      canvas.toBlob((blob) => {
        if (!blob || !dialog.isOpen) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        target.style.backgroundImage = `url("${url}")`;
      });
    }).catch((error: unknown) => console.warn('Vista previa de LUT no disponible', error));
  };

  const choose = (): void => {
    chosen = luts[index] ?? null;
    dialog.close();
  };

  const render = (): void => {
    list.replaceChildren();
    luts.forEach((lut, i) => {
      const option = document.createElement('div');
      option.className = `lut-option${i === index ? ' selected' : ''}`;
      option.id = `lut-option-${i}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(i === index));
      const swatch = document.createElement('div');
      swatch.className = 'lut-swatch';
      preview(lut, swatch);
      const name = document.createElement('span');
      name.className = 'lut-name';
      name.textContent = lut.title || lut.id;
      const meta = document.createElement('span');
      meta.className = 'lut-meta';
      meta.textContent = `${lut.size}³${lut.id.startsWith('builtin:') ? ' · integrada' : ''}`;
      option.append(swatch, name, meta);
      option.addEventListener('click', () => {
        index = i;
        update();
      });
      option.addEventListener('dblclick', () => {
        index = i;
        choose();
      });
      list.appendChild(option);
    });
    update();
  };

  const update = (): void => {
    list.querySelectorAll('.lut-option').forEach((el, i) => {
      el.classList.toggle('selected', i === index);
      el.setAttribute('aria-selected', String(i === index));
    });
    list.setAttribute('aria-activedescendant', `lut-option-${index}`);
    list.querySelector('.lut-option.selected')?.scrollIntoView?.({ block: 'nearest' });
  };

  const columns = (): number => {
    const first = list.querySelector<HTMLElement>('.lut-option');
    const width = first?.offsetWidth ?? 0;
    return width > 0 ? Math.max(1, Math.floor(list.clientWidth / width)) : 1;
  };

  list.addEventListener('keydown', (event) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns(), Home: -luts.length, End: luts.length };
    const delta = step[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      index = Math.min(luts.length - 1, Math.max(0, index + delta));
      update();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose();
    }
  });

  if (options.importLut) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cube';
    input.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file || !options.importLut) return;
      void options.importLut(file).then((lut) => {
        if (!lut || !dialog.isOpen) return;
        luts = [...luts.filter((l) => l.id !== lut.id), lut];
        index = luts.length - 1;
        render();
      });
    });
    dialog.body.appendChild(input);
    dialog.addButton('Cargar .cube…', () => input.click());
  }
  dialog.addButton('Cancelar', () => dialog.close());
  dialog.addButton('Aplicar', choose, 'primary');
  render();
  queueMicrotask(() => list.focus());
  return dialog.closed.then(() => chosen);
}
