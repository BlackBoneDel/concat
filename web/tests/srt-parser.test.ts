// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** SubRip parsing: tolerant, partial, with line-numbered warnings. */

import { describe, expect, it } from 'vitest';
import { parseSRT, parseSrtMarkup, srtPlainText } from '../src/media/subtitles/srt-parser.ts';
import { decodeEntities, formatTimestamp, parseTimestamp } from '../src/media/subtitles/types.ts';

const SAMPLE = `1
00:00:01,000 --> 00:00:02,500
Hola, mundo.

2
00:00:03,000 --> 00:00:05,250
<i>Segunda</i> línea
con dos renglones
`;

describe('parseSRT', () => {
  it('reads counters, timings and multi-line text', () => {
    const track = parseSRT(SAMPLE);
    expect(track.warnings).toEqual([]);
    expect(track.cues).toEqual([
      { id: '1', startMs: 1000, endMs: 2500, text: 'Hola, mundo.', settings: '' },
      { id: '2', startMs: 3000, endMs: 5250, text: '<i>Segunda</i> línea\ncon dos renglones', settings: '' },
    ]);
  });

  it('accepts BOM, CRLF, dots, missing hours, coordinates and missing counters', () => {
    const text = '\uFEFF1\r\n00:01,5 --> 00:02.250 X1:10 X2:20\r\nA\r\n\r\n\r\n00:00:03,000-->00:00:04,000\r\nB\r\n';
    const track = parseSRT(text);
    expect(track.cues.map((c) => [c.startMs, c.endMs, c.text])).toEqual([[1500, 2250, 'A'], [3000, 4000, 'B']]);
    expect(track.cues[1]!.id).toBe('');
  });

  it('keeps going after broken blocks, reporting their lines', () => {
    const text = `1
00:00:01,000 --> 00:00:02,000
ok

2
esto no es un tiempo
roto

3
00:00:05,000 --> 00:00:04,000
al revés

4
00:00:61,000 --> 00:00:62,000
segundos imposibles

x
00:00:06,000 --> 00:00:07,000
contador raro

6
00:00:06,500 --> 00:00:08,000
se solapa

7
00:00:09,000 --> 00:00:10,000
`;
    const track = parseSRT(text);
    expect(track.cues.map((c) => c.text)).toEqual(['ok', 'contador raro', 'se solapa', '']);
    const byLine = Object.fromEntries(track.warnings.map((w) => [w.line, w.message]));
    expect(byLine[6]).toMatch(/Línea de tiempos inválida/);
    expect(byLine[10]).toMatch(/no es posterior/);
    expect(byLine[14]).toMatch(/Marca de tiempo inválida/);
    expect(byLine[17]).toMatch(/Número de subtítulo inválido/);
    expect(byLine[21]).toMatch(/se solapa/);
    expect(byLine[26]).toMatch(/sin texto/);
  });

  it('warns when nothing is usable, stays quiet on empty files', () => {
    expect(parseSRT('basura\nsin tiempos').warnings.map((w) => w.message)).toContain('No se encontró ningún subtítulo válido');
    expect(parseSRT('   \n\n').warnings).toEqual([]);
  });
});

describe('SRT markup', () => {
  it('maps b/i/u/font color (and brace forms) to spans', () => {
    const spans = parseSrtMarkup('<b>Fuerte</b> {i}cursiva{/i} <u>sub</u> <font color="#ff0000">rojo <b>y</b></font> fin &amp; más');
    expect(spans.find((s) => s.text === 'Fuerte')?.bold).toBe(true);
    expect(spans.find((s) => s.text === 'cursiva')?.italic).toBe(true);
    expect(spans.find((s) => s.text === 'sub')?.underline).toBe(true);
    expect(spans.find((s) => s.text === 'rojo ')?.color).toBe('#ff0000');
    const y = spans.find((s) => s.text === 'y')!;
    expect(y.bold && y.color === '#ff0000').toBe(true);
    expect(spans[spans.length - 1]!.text).toBe(' fin & más');
    expect(spans[spans.length - 1]!.color).toBeNull();
    expect(srtPlainText('<font color=blue><x>raro</x></font>')).toBe('raro');
    expect(parseSrtMarkup('<b>sin cerrar').every((s) => s.bold)).toBe(true);
  });
});

describe('timestamps and entities', () => {
  it('formats and parses both dialects', () => {
    expect(formatTimestamp(3_723_004, ',')).toBe('01:02:03,004');
    expect(formatTimestamp(-5, '.')).toBe('00:00:00.000');
    expect(parseTimestamp('01:02:03,004')).toBe(3_723_004);
    expect(parseTimestamp('02:03.4')).toBe(123_400);
    expect(parseTimestamp('00:00:01,000', true)).toBeNull();
    expect(parseTimestamp('100:00:00.000', true)).toBe(360_000_000);
    expect(parseTimestamp('nada')).toBeNull();
    expect(decodeEntities('&lt;&#65;&#x42;&nbsp;&desconocida;')).toBe('<AB\u00a0&desconocida;');
  });
});
