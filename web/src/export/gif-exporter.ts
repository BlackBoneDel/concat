// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: an animated GIF encoder written for this project (GIF89a, no
 * dependencies). Each frame gets its own palette — median cut over a 15-bit
 * histogram, up to 256 colours — optional Floyd–Steinberg error diffusion,
 * and variable-width LZW. The NETSCAPE2.0 extension makes it loop. Frame
 * delays follow the export clock: frame N ends at `round((N+1)·100/fps)`
 * centiseconds, so the long-run rate is exact even when `1000/fps` is not a
 * whole number of hundredths.
 *
 * The desktop app has no GIF path (`src/crates/concat-export/src/lib.rs`
 * only writes video files); this is the web build's addition.
 */

import { PacketStore } from './packet-store.ts';
import { ExportError, type GifOptions } from './types.ts';

/** GIFs longer than this get a size warning. */
export const GIF_WARN_SECONDS = 30;

/** A quantized palette: RGB triplets, at most 256. */
export interface Palette {
  colors: Uint8Array;
  size: number;
}

/**
 * The nominal per-frame delay in milliseconds: `round(1000 / fps)`.
 * @param fps frames per second.
 * @returns milliseconds.
 */
export function frameDelayMs(fps: number): number {
  return Math.round(1000 / Math.max(0.001, fps));
}

/**
 * Delay of frame `index` in GIF centiseconds (cumulative rounding, ≥ 2 so
 * browsers do not clamp it to 100 ms).
 * @param index 0-based frame index.
 * @param fps frames per second.
 * @returns centiseconds.
 */
export function frameDelayCentiseconds(index: number, fps: number): number {
  // Fase 7 hook (QA): 0/negative/NaN fps would write NaN into the header.
  if (!(fps > 0) || !Number.isFinite(fps)) return 2;
  const at = (n: number): number => Math.round((n * 100) / fps);
  return Math.max(2, at(index + 1) - at(index));
}

/**
 * A warning for long GIFs (they get very large).
 * @param seconds the export duration.
 * @returns the message, or `null` up to {@link GIF_WARN_SECONDS}.
 */
export function gifDurationWarning(seconds: number): string | null {
  if (seconds <= GIF_WARN_SECONDS) return null;
  return `El GIF dura ${Math.round(seconds)} s; por encima de ${GIF_WARN_SECONDS} s el archivo puede ser enorme. Considera MP4/WebM o acortar el rango.`;
}

/** 15-bit bin of an RGB colour. */
function binOf(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/** A median-cut box over histogram bins. */
interface Box {
  bins: number[];
  count: number;
}

/**
 * Median-cut quantization of RGBA pixels.
 * @param rgba the pixels.
 * @param maxColors 2..256.
 * @returns the palette.
 */
export function quantize(rgba: Uint8ClampedArray, maxColors = 256): Palette {
  const histogram = new Uint32Array(32768);
  for (let i = 0; i < rgba.length; i += 4) {
    const bin = binOf(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
    histogram[bin] = (histogram[bin] ?? 0) + 1;
  }
  const used: number[] = [];
  let total = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    const count = histogram[bin] ?? 0;
    if (count > 0) {
      used.push(bin);
      total += count;
    }
  }
  const limit = Math.max(2, Math.min(256, Math.floor(maxColors)));
  const boxes: Box[] = [{ bins: used, count: total }];
  const channel = (bin: number, c: number): number => (c === 0 ? bin >> 10 : c === 1 ? (bin >> 5) & 31 : bin & 31);
  while (boxes.length < limit) {
    let pick = -1;
    let best = 0;
    let axis = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const candidate = boxes[i];
      if (!candidate || candidate.bins.length < 2) continue;
      for (let c = 0; c < 3; c += 1) {
        let lo = 31;
        let hi = 0;
        for (const bin of candidate.bins) {
          const value = channel(bin, c);
          if (value < lo) lo = value;
          if (value > hi) hi = value;
        }
        const score = (hi - lo) * Math.sqrt(candidate.count);
        if (score > best) {
          best = score;
          pick = i;
          axis = c;
        }
      }
    }
    if (pick < 0) break;
    const target = boxes[pick];
    if (!target) break;
    target.bins.sort((a, b) => channel(a, axis) - channel(b, axis));
    let running = 0;
    let split = 1;
    for (let i = 0; i < target.bins.length - 1; i += 1) {
      running += histogram[target.bins[i] ?? 0] ?? 0;
      split = i + 1;
      if (running * 2 >= target.count) break;
    }
    const left = target.bins.slice(0, split);
    const right = target.bins.slice(split);
    const sum = (bins: number[]): number => bins.reduce((acc, bin) => acc + (histogram[bin] ?? 0), 0);
    boxes.splice(pick, 1, { bins: left, count: sum(left) }, { bins: right, count: sum(right) });
  }
  const colors = new Uint8Array(Math.max(2, boxes.length) * 3);
  boxes.forEach((entry, index) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (const bin of entry.bins) {
      const count = histogram[bin] ?? 0;
      r += ((bin >> 10) * 8 + 4) * count;
      g += (((bin >> 5) & 31) * 8 + 4) * count;
      b += ((bin & 31) * 8 + 4) * count;
      weight += count;
    }
    if (weight > 0) {
      colors[index * 3] = Math.round(r / weight);
      colors[index * 3 + 1] = Math.round(g / weight);
      colors[index * 3 + 2] = Math.round(b / weight);
    }
  });
  return { colors, size: Math.max(2, boxes.length) };
}

/** Nearest-palette lookup cached per 15-bit bin. */
class PaletteMapper {
  private readonly cache = new Int16Array(32768).fill(-1);

  constructor(private readonly palette: Palette) {}

  nearest(r: number, g: number, b: number): number {
    const bin = binOf(r, g, b);
    const cached = this.cache[bin] ?? -1;
    if (cached >= 0) return cached;
    const { colors, size } = this.palette;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < size; i += 1) {
      const dr = (colors[i * 3] ?? 0) - r;
      const dg = (colors[i * 3 + 1] ?? 0) - g;
      const db = (colors[i * 3 + 2] ?? 0) - b;
      const distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    this.cache[bin] = best;
    return best;
  }
}

/**
 * Maps pixels to palette indices, optionally with Floyd–Steinberg.
 * @param rgba the pixels.
 * @param width frame width.
 * @param height frame height.
 * @param palette the palette.
 * @param dither error diffusion on/off.
 * @returns one index per pixel.
 */
export function indexPixels(rgba: Uint8ClampedArray, width: number, height: number, palette: Palette, dither: boolean): Uint8Array {
  const mapper = new PaletteMapper(palette);
  const out = new Uint8Array(width * height);
  if (!dither) {
    for (let p = 0, i = 0; p < out.length; p += 1, i += 4) out[p] = mapper.nearest(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
    return out;
  }
  let current = new Float32Array((width + 2) * 3);
  let next = new Float32Array((width + 2) * 3);
  const { colors } = palette;
  for (let y = 0; y < height; y += 1) {
    next.fill(0);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const e = (x + 1) * 3;
      const r = clamp255((rgba[i] ?? 0) + (current[e] ?? 0));
      const g = clamp255((rgba[i + 1] ?? 0) + (current[e + 1] ?? 0));
      const b = clamp255((rgba[i + 2] ?? 0) + (current[e + 2] ?? 0));
      const index = mapper.nearest(r, g, b);
      out[y * width + x] = index;
      const errors = [r - (colors[index * 3] ?? 0), g - (colors[index * 3 + 1] ?? 0), b - (colors[index * 3 + 2] ?? 0)];
      for (let c = 0; c < 3; c += 1) {
        const error = errors[c] ?? 0;
        current[e + 3 + c] = (current[e + 3 + c] ?? 0) + (error * 7) / 16;
        next[e - 3 + c] = (next[e - 3 + c] ?? 0) + (error * 3) / 16;
        next[e + c] = (next[e + c] ?? 0) + (error * 5) / 16;
        next[e + 3 + c] = (next[e + 3 + c] ?? 0) + error / 16;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }
  return out;
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/**
 * GIF LZW compression (variable code width up to 12 bits, clear on a full
 * table), packed into ≤ 255-byte sub-blocks with the terminator.
 * @param indices palette indices.
 * @param minCodeSize LZW minimum code size (2..8).
 * @returns the image data sub-blocks.
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array<ArrayBuffer> {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const dictionary = new Map<number, number>();
  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  emit(clear);
  if (indices.length > 0) {
    let prefix = indices[0] ?? 0;
    for (let i = 1; i < indices.length; i += 1) {
      const k = indices[i] ?? 0;
      const key = prefix * 256 + k;
      const known = dictionary.get(key);
      if (known !== undefined) {
        prefix = known;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        dictionary.set(key, next);
        next += 1;
        if (next > 1 << codeSize && codeSize < 12) codeSize += 1;
      } else {
        emit(clear);
        dictionary.clear();
        codeSize = minCodeSize + 1;
        next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix);
  }
  emit(eoi);
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);
  const blocks = Math.ceil(bytes.length / 255);
  const out = new Uint8Array(1 + bytes.length + blocks + 1);
  let o = 0;
  out[o++] = minCodeSize;
  for (let start = 0; start < bytes.length; start += 255) {
    const chunk = bytes.slice(start, start + 255);
    out[o++] = chunk.length;
    out.set(chunk, o);
    o += chunk.length;
  }
  out[o] = 0;
  return out;
}

/** Streaming GIF89a encoder. */
export class GifEncoder {
  readonly width: number;
  readonly height: number;
  private readonly options: GifOptions;
  private readonly store: PacketStore;
  private frames = 0;
  private finished: Blob | null = null;

  /**
   * @param width frame width (1..65535).
   * @param height frame height (1..65535).
   * @param options palette, dithering and loop.
   * @param store byte store (tests pass a small-batch one).
   */
  constructor(width: number, height: number, options: GifOptions, store: PacketStore = new PacketStore()) {
    if (!(width >= 1 && width <= 65535 && height >= 1 && height <= 65535)) throw new ExportError('INVALID_RANGE', 'Tamaño de GIF inválido.');
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.options = options;
    this.store = store;
    this.store.append(this.header());
  }

  /** Frames written. */
  get frameCount(): number {
    return this.frames;
  }

  /** Bytes so far. */
  get bytesWritten(): number {
    return this.store.size;
  }

  /**
   * Quantizes and appends one frame.
   * @param rgba `width × height × 4` bytes.
   * @param delayCs display time in centiseconds.
   */
  addFrame(rgba: Uint8ClampedArray, delayCs: number): void {
    if (this.finished) throw new ExportError('MUX_FAILED', 'El GIF ya está finalizado.');
    if (rgba.length < this.width * this.height * 4) throw new ExportError('MUX_FAILED', 'Fotograma GIF incompleto.');
    const palette = quantize(rgba, this.options.maxColors);
    const indices = indexPixels(rgba, this.width, this.height, palette, this.options.dither);
    const bits = Math.max(1, Math.ceil(Math.log2(palette.size)));
    const tableSize = 1 << bits;
    const header = new Uint8Array(8 + 10 + tableSize * 3);
    let o = 0;
    const delay = Math.max(0, Math.min(65535, Math.round(delayCs)));
    // Graphic Control Extension: disposal 1 (leave in place), no transparency.
    header.set([0x21, 0xf9, 0x04, 0x04, delay & 0xff, delay >> 8, 0x00, 0x00], o);
    o += 8;
    // Image Descriptor with a local colour table.
    header.set([0x2c, 0, 0, 0, 0, this.width & 0xff, this.width >> 8, this.height & 0xff, this.height >> 8, 0x80 | (bits - 1)], o);
    o += 10;
    header.set(palette.colors.subarray(0, palette.size * 3), o);
    this.store.append(header);
    this.store.append(lzwEncode(indices, Math.max(2, bits)));
    this.frames += 1;
  }

  /**
   * Writes the trailer.
   * @returns the GIF `Blob`.
   */
  finish(): Blob {
    if (this.finished) return this.finished;
    if (this.frames === 0) throw new ExportError('MUX_FAILED', 'El GIF no tiene fotogramas.');
    this.store.append(new Uint8Array([0x3b]));
    this.finished = new Blob([this.store.finish()], { type: 'image/gif' });
    return this.finished;
  }

  /** Drops the buffered bytes. */
  abort(): void {
    this.store.clear();
  }

  private header(): Uint8Array<ArrayBuffer> {
    const loop = Math.max(0, Math.min(65535, Math.round(this.options.loop)));
    const out = new Uint8Array(6 + 7 + 19);
    out.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    // Logical screen: no global colour table, 8-bit colour resolution.
    out.set([this.width & 0xff, this.width >> 8, this.height & 0xff, this.height >> 8, 0x70, 0, 0], 6);
    out.set([0x21, 0xff, 0x0b, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 0x03, 0x01, loop & 0xff, loop >> 8, 0x00], 13);
    return out;
  }
}
