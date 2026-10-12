// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * `.cube` LUT parsing — port of `src/crates/concat-effects/src/cube.rs`.
 *
 * A header of `LUT_3D_SIZE n`, optionally `TITLE`, `DOMAIN_MIN`/`DOMAIN_MAX`
 * (or Resolve's `LUT_3D_INPUT_RANGE`), then n³ rows of three numbers, red
 * changing fastest. A byte-order mark, `#` comments, blank lines and
 * keywords the table does not need are skipped; a domain other than 0..1 is
 * rescaled; anything malformed is a {@link LutParseError} naming the line.
 * Tables above 65 a side are refused (the renderer's upload budget).
 *
 * Also ships the built-in looks, generated procedurally at 17³ so the bundle
 * carries code instead of tables.
 */

import { fromLog, toLog } from './color-grading.ts';
import { linearToSrgb, srgbToLinear } from './color-space.ts';

/** A parsed 3D LUT, values rescaled to the 0..1 domain. */
export interface Lut3D {
  /** Stable id (`builtin:*` or `file:<name>:<hash>`). */
  id: string;
  title: string;
  size: number;
  /** size³ × 3 floats, red fastest. */
  data: Float32Array;
}

/** Largest table side accepted (cube.rs `LARGEST_TABLE`). */
export const LARGEST_TABLE = 65;

/** A `.cube` syntax/semantic error, with its 1-based line when known. */
export class LutParseError extends Error {
  readonly line: number | null;

  /**
   * @param message Spanish description.
   * @param line 1-based line, or null for whole-file errors.
   */
  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `Línea ${line}: ${message}`);
    this.name = 'LutParseError';
    this.line = line;
  }
}

/** FNV-1a over the table, for cache ids. */
function hashTable(data: Float32Array): string {
  let h = 0x811c9dc5;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Parses a number word or throws for that line. */
function num(word: string | undefined, line: number, message: string): number {
  const value = word === undefined ? Number.NaN : Number(word);
  if (!Number.isFinite(value)) throw new LutParseError(message, line);
  return value;
}

/**
 * Parses `.cube` text.
 * @param text file contents.
 * @param name file name (for the id/title fallback).
 * @returns the table.
 */
export function parseCube(text: string, name = 'LUT'): Lut3D {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let size: number | null = null;
  let title = '';
  const domainMin = [0, 0, 0];
  const domainMax = [1, 1, 1];
  const rgb: number[] = [];
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const at = index + 1;
    const raw = lines[index]!;
    const titleMatch = /^\s*TITLE\s+"?([^"]*)"?/.exec(raw);
    if (titleMatch) {
      title = titleMatch[1]!.trim();
      continue;
    }
    const line = raw.split('#')[0]!.trim();
    if (line === '') continue;
    const words = line.split(/\s+/);
    const head = words[0]!;
    switch (head) {
      case 'LUT_1D_SIZE':
        throw new LutParseError('es una tabla 1D; solo se admiten tablas 3D', at);
      case 'LUT_3D_SIZE': {
        const n = num(words[1], at, 'LUT_3D_SIZE necesita un número');
        if (!Number.isInteger(n) || n < 2 || n > 129) throw new LutParseError(`una tabla de ${n} por lado está fuera de rango`, at);
        size = n;
        break;
      }
      case 'DOMAIN_MIN':
      case 'DOMAIN_MAX': {
        const triple = [1, 2, 3].map((i) => num(words[i], at, `${head} necesita tres números`));
        (head === 'DOMAIN_MIN' ? domainMin : domainMax).splice(0, 3, ...triple);
        break;
      }
      case 'LUT_3D_INPUT_RANGE': {
        const lo = num(words[1], at, `${head} necesita dos números`);
        const hi = num(words[2], at, `${head} necesita dos números`);
        domainMin.fill(lo);
        domainMax.fill(hi);
        break;
      }
      default: {
        // Another tool's keyword (e.g. LUT_IN_VIDEO_RANGE): ignored.
        if (/^[A-Za-z]/.test(head) && !Number.isFinite(Number(head))) break;
        if (size === null) throw new LutParseError('datos antes de LUT_3D_SIZE', at);
        for (let i = 0; i < 3; i += 1) rgb.push(num(words[i], at, 'se esperaban tres números'));
      }
    }
  }
  if (size === null) throw new LutParseError('falta LUT_3D_SIZE');
  const expected = size ** 3 * 3;
  if (rgb.length !== expected) {
    throw new LutParseError(`${rgb.length / 3} filas para una tabla de ${size} por lado, que necesita ${expected / 3}`);
  }
  if (size > LARGEST_TABLE) throw new LutParseError(`una tabla de ${size} por lado supera las ${LARGEST_TABLE} que admite el renderizador`);
  const data = new Float32Array(expected);
  for (let i = 0; i < expected; i += 1) {
    const c = i % 3;
    const span = domainMax[c]! - domainMin[c]!;
    data[i] = Math.abs(span) > 1e-7 ? (rgb[i]! - domainMin[c]!) / span : rgb[i]!;
  }
  return { id: `file:${name}:${hashTable(data)}`, title: title || name.replace(/\.cube$/i, ''), size, data };
}

/**
 * Reads and parses a `.cube` file.
 * @param file the user's file.
 * @returns the table.
 */
export async function loadCubeFile(file: File): Promise<Lut3D> {
  if (!/\.cube$/i.test(file.name)) throw new LutParseError(`«${file.name}» no es un archivo .cube`);
  if (file.size > 64 * 1024 * 1024) throw new LutParseError('el archivo LUT es demasiado grande (máx. 64 MB)');
  return parseCube(await file.text(), file.name);
}

/**
 * Serialises a table as `.cube` text (round-trips with {@link parseCube}).
 * @param lut the table.
 * @returns file contents.
 */
export function toCube(lut: Lut3D): string {
  const rows: string[] = [`TITLE "${lut.title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${lut.size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < lut.data.length; i += 3) rows.push(`${lut.data[i]!.toFixed(6)} ${lut.data[i + 1]!.toFixed(6)} ${lut.data[i + 2]!.toFixed(6)}`);
  return `${rows.join('\n')}\n`;
}

/**
 * Builds a table from a colour transform.
 * @param id table id.
 * @param title display name.
 * @param size side.
 * @param transform maps display-referred RGB 0..1 to RGB.
 * @returns the table.
 */
export function generateLut(id: string, title: string, size: number, transform: (r: number, g: number, b: number) => [number, number, number]): Lut3D {
  const data = new Float32Array(size ** 3 * 3);
  let i = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const out = transform(r / (size - 1), g / (size - 1), b / (size - 1));
        data[i] = out[0];
        data[i + 1] = out[1];
        data[i + 2] = out[2];
        i += 3;
      }
    }
  }
  return { id, title, size, data };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Contrast in log about grey, display in/out. */
function logContrast(v: number, amount: number): number {
  const l = toLog(srgbToLinear(v));
  return clamp01(linearToSrgb(fromLog(0.4135884 + (l - 0.4135884) * amount)));
}

/** The built-in looks, all 17³. */
export const BUILTIN_LUTS: readonly Lut3D[] = Object.freeze([
  generateLut('builtin:identity', 'Neutro (identidad)', 17, (r, g, b) => [r, g, b]),
  generateLut('builtin:warm', 'Cálido', 17, (r, g, b) => [clamp01(r * 1.06 + 0.02), clamp01(g * 1.01), clamp01(b * 0.9)]),
  generateLut('builtin:cool', 'Frío', 17, (r, g, b) => [clamp01(r * 0.92), clamp01(g * 1.0), clamp01(b * 1.08 + 0.02)]),
  generateLut('builtin:bw', 'Blanco y negro', 17, (r, g, b) => {
    const y = logContrast(luma(r, g, b), 1.15);
    return [y, y, y];
  }),
  generateLut('builtin:teal-orange', 'Teal & Orange', 17, (r, g, b) => {
    const y = luma(r, g, b);
    // Shadows towards teal, highlights/skin towards orange.
    const t = clamp01((y - 0.25) / 0.5);
    const tr = (1 - t) * -0.05 + t * 0.06;
    const tb = (1 - t) * 0.06 + t * -0.07;
    return [clamp01(logContrast(r, 1.1) + tr), clamp01(logContrast(g, 1.1) + (1 - t) * 0.02), clamp01(logContrast(b, 1.1) + tb)];
  }),
  generateLut('builtin:vintage', 'Vintage', 17, (r, g, b) => {
    const fade = (v: number): number => 0.08 + v * 0.84;
    const y = luma(r, g, b);
    return [clamp01(fade(y + (r - y) * 0.7) * 1.04), clamp01(fade(y + (g - y) * 0.7)), clamp01(fade(y + (b - y) * 0.7) * 0.88)];
  }),
  generateLut('builtin:punch', 'Alto contraste', 17, (r, g, b) => [logContrast(r, 1.3), logContrast(g, 1.3), logContrast(b, 1.3)]),
  generateLut('builtin:bleach', 'Bleach bypass', 17, (r, g, b) => {
    const y = luma(r, g, b);
    const mix = (v: number): number => clamp01(logContrast(y + (v - y) * 0.45, 1.25));
    return [mix(r), mix(g), mix(b)];
  }),
]);

/**
 * A built-in table by id.
 * @param id `builtin:*`.
 * @returns the table, or undefined.
 */
export function builtinLut(id: string): Lut3D | undefined {
  return BUILTIN_LUTS.find((lut) => lut.id === id);
}
