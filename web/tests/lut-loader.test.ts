// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** `.cube` parsing (port of concat-effects/src/cube.rs) and built-in looks. */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_LUTS,
  LARGEST_TABLE,
  LutParseError,
  builtinLut,
  generateLut,
  loadCubeFile,
  parseCube,
  toCube,
} from '../src/media/vision/lut-loader.ts';

/** Identity table text (cube.rs `identity`). */
export function identityCube(n: number, header = ''): string {
  let text = `TITLE "id"\n${header}LUT_3D_SIZE ${n}\n# rows\n`;
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const s = 1 / (n - 1);
        text += `${r * s} ${g * s} ${b * s}\n`;
      }
    }
  }
  return text;
}

describe('parseCube', () => {
  it('reads TITLE, size and rows (red fastest)', () => {
    const lut = parseCube(identityCube(2), 'test.cube');
    expect(lut.title).toBe('id');
    expect(lut.size).toBe(2);
    expect(Array.from(lut.data.subarray(0, 6))).toEqual([0, 0, 0, 1, 0, 0]);
    expect(lut.id).toMatch(/^file:test\.cube:[0-9a-f]{8}$/);
  });

  it('tolerates BOM, comments, CRLF and foreign keywords', () => {
    const text = '\uFEFF# made by a tool\r\nLUT_IN_VIDEO_RANGE\r\n' + identityCube(2).replace(/\n/g, '\r\n').replace('0 0 0', '0 0 0 # first');
    const lut = parseCube(text, 'x.cube');
    expect(lut.size).toBe(2);
    expect(lut.data[0]).toBe(0);
  });

  it('rescales DOMAIN_MIN/MAX and LUT_3D_INPUT_RANGE', () => {
    const text = 'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n' + '2 2 2\n'.repeat(8);
    expect(parseCube(text).data[0]).toBe(1);
    const range = 'LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE -1 1\n' + '0 0 0\n'.repeat(8);
    expect(parseCube(range).data[0]).toBe(0.5);
  });

  it('reports errors with the line number', () => {
    const cases: [string, RegExp][] = [
      ['LUT_1D_SIZE 1024\n', /Línea 1: es una tabla 1D/],
      ['LUT_3D_SIZE x\n', /Línea 1: LUT_3D_SIZE necesita un número/],
      ['LUT_3D_SIZE 1\n', /Línea 1: .*fuera de rango/],
      ['TITLE "a"\nLUT_3D_SIZE 2\n0 0\n', /Línea 3: se esperaban tres números/],
      ['LUT_3D_SIZE 2\nDOMAIN_MIN 0 0\n', /Línea 2: DOMAIN_MIN necesita tres números/],
      ['0 0 0\n', /Línea 1: datos antes de LUT_3D_SIZE/],
      ['TITLE "nothing"\n', /falta LUT_3D_SIZE/],
      ['LUT_3D_SIZE 2\n0 0 0\n', /1 filas para una tabla de 2 por lado, que necesita 8/],
    ];
    for (const [text, pattern] of cases) {
      expect(() => parseCube(text)).toThrow(pattern);
    }
    try {
      parseCube('LUT_3D_SIZE 2\n0 0 a\n');
    } catch (error) {
      expect(error).toBeInstanceOf(LutParseError);
      expect((error as LutParseError).line).toBe(2);
    }
  });

  it('refuses tables above the renderer budget (cube.rs a_table_past_the_budget_is_refused)', () => {
    const size = LARGEST_TABLE + 1;
    const text = `LUT_3D_SIZE ${size}\n` + '0 0 0\n'.repeat(size ** 3);
    expect(() => parseCube(text)).toThrow(new RegExp(String(size)));
  });

  it('round-trips through toCube', () => {
    const warm = builtinLut('builtin:warm')!;
    const again = parseCube(toCube(warm), 'warm.cube');
    expect(again.size).toBe(warm.size);
    for (let i = 0; i < warm.data.length; i += 97) expect(again.data[i]).toBeCloseTo(warm.data[i]!, 5);
    expect(again.title).toBe('Cálido');
  });

  it('loads files and rejects other extensions', async () => {
    const lut = await loadCubeFile(new File([identityCube(3)], 'look.CUBE'));
    expect(lut.size).toBe(3);
    await expect(loadCubeFile(new File(['x'], 'look.txt'))).rejects.toThrow(/no es un archivo .cube/);
  });
});

describe('built-in looks', () => {
  it('ships valid 17³ tables with unique ids', () => {
    expect(BUILTIN_LUTS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(BUILTIN_LUTS.map((l) => l.id)).size).toBe(BUILTIN_LUTS.length);
    for (const lut of BUILTIN_LUTS) {
      expect(lut.size).toBe(17);
      expect(lut.data.length).toBe(17 ** 3 * 3);
      expect(lut.data.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    }
    const bw = builtinLut('builtin:bw')!;
    const i = ((5 * 17 + 10) * 17 + 3) * 3;
    expect(bw.data[i]).toBe(bw.data[i + 1]);
    expect(builtinLut('nope')).toBeUndefined();
    expect(generateLut('x', 'x', 2, (r, g, b) => [b, g, r]).data[3]).toBe(0);
  });
});
