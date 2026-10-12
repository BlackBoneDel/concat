// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** WebVTT parsing: header, blocks, settings, cue-text tags, karaoke. */

import { describe, expect, it } from 'vitest';
import { VTT_SAMPLE } from './f4-helpers.ts';
import { SubtitleParseError } from '../src/media/subtitles/types.ts';
import { parseCueSettings, parseVTT, parseVttCueText, vttPlainText } from '../src/media/subtitles/vtt-parser.ts';


describe('parseVTT', () => {
  it('reads header, metadata, STYLE, REGION, NOTE and cues', () => {
    const track = parseVTT(VTT_SAMPLE);
    expect(track.warnings).toEqual([]);
    expect(track.header).toBe('Película');
    expect(track.metadata).toEqual(['Kind: captions', 'Language: es']);
    expect(track.styles).toEqual(['::cue(.amarillo) { color: yellow; }']);
    expect(track.regions).toEqual([{ id: 'abajo', settings: 'id:abajo width:40% lines:3 regionanchor:0%,100% viewportanchor:10%,90% scroll:up' }]);
    expect(track.notes).toEqual(['NOTE Traducción revisada']);
    expect(track.cues).toEqual([
      { id: 'intro', startMs: 1000, endMs: 2500, text: '<v Ana>Hola</v> <c.amarillo>amigo</c>', settings: 'line:90% align:center' },
      { id: '', startMs: 3000, endMs: 5000, text: '<i>Segunda</i>\nlínea', settings: 'region:abajo' },
    ]);
  });

  it('requires the WEBVTT header', () => {
    expect(() => parseVTT('1\n00:00:01.000 --> 00:00:02.000\nx')).toThrow(SubtitleParseError);
    expect(() => parseVTT('WEBVTTX\n')).toThrow(/Línea 1: Falta la cabecera WEBVTT/);
    expect(parseVTT('\uFEFFWEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nok').cues[0]!.startMs).toBe(1000);
  });

  it('is partial: bad cues are skipped with warnings, the rest imports', () => {
    const text = `WEBVTT

00:00:01.000 --> 00:00:02.000 vertical:xx size:150% align:middle
uno

roto
sin tiempos

00:00:04.000 --> 00:00:03.000
al revés

00:00:05,000 --> 00:00:06,000
coma

00:00:07.000 --> 00:00:08.000
siete
00:00:08.000 --> 00:00:09.000
pegado

STYLE
p { color: red }

00:00:00.500 --> 00:00:00.900
antes
`;
    const track = parseVTT(text);
    expect(track.cues.map((c) => c.text)).toEqual(['uno', 'coma', 'siete', 'pegado', 'antes']);
    expect(track.cues[0]!.settings).toBe('align:middle');
    const messages = track.warnings.map((w) => `${w.line}:${w.message}`);
    expect(messages).toContain('3:Ajuste de subtítulo inválido: "vertical:xx"');
    expect(messages).toContain('3:Ajuste de subtítulo inválido: "size:150%"');
    expect(messages.some((m) => m.startsWith('6:Bloque sin línea de tiempos'))).toBe(true);
    expect(messages.some((m) => m.startsWith('9:') && m.includes('no es posterior'))).toBe(true);
    expect(messages).toContain('12:Marca de tiempo con formato no estándar');
    expect(messages).toContain('17:Falta una línea en blanco entre subtítulos');
    expect(messages.some((m) => m.includes('STYLE después'))).toBe(true);
    expect(messages.some((m) => m.includes('orden cronológico'))).toBe(true);
  });

  it('skips REGION without id and cues inside the header', () => {
    const track = parseVTT('WEBVTT\n00:00:01.000 --> 00:00:02.000\n\nREGION\nwidth:40%\n\nNOTE\nvarias\nlíneas\n');
    expect(track.regions).toEqual([]);
    expect(track.notes).toEqual(['NOTE\nvarias\nlíneas']);
    expect(track.warnings.map((w) => w.message)).toEqual([
      'Falta una línea en blanco tras la cabecera; el subtítulo se ignora',
      'REGION sin id; se ignora',
    ]);
  });
});

describe('cue settings', () => {
  it('parses every setting', () => {
    const { settings, canonical } = parseCueSettings('vertical:rl line:-2 position:30%,line-left size:50% align:end region:r1');
    expect(canonical).toBe('vertical:rl line:-2 position:30%,line-left size:50% align:end region:r1');
    expect(settings).toEqual({
      vertical: 'rl',
      line: { value: -2, percent: false, align: 'start' },
      position: { value: 30, align: 'line-left' },
      size: 50,
      align: 'end',
      region: 'r1',
    });
    expect(parseCueSettings('line:10%,center').settings.line).toEqual({ value: 10, percent: true, align: 'center' });
    expect(parseCueSettings('line:120% position:abc').canonical).toBe('');
  });
});

describe('cue text', () => {
  it('maps c/i/b/u/v/lang/ruby to spans', () => {
    const { spans, voice } = parseVttCueText('<v.loud Ana María>Hola <b>fuerte</b></v> <c.a.b>clase</c> <u>sub</u> <lang en><i>hi</i></lang> <ruby>漢<rt>kan</rt></ruby> &amp;');
    expect(voice).toBe('Ana María');
    expect(spans[0]).toMatchObject({ text: 'Hola ', voice: 'Ana María', classes: ['loud'] });
    expect(spans.find((s) => s.text === 'fuerte')?.bold).toBe(true);
    expect(spans.find((s) => s.text === 'clase')?.classes).toEqual(['a', 'b']);
    expect(spans.find((s) => s.text === 'sub')?.underline).toBe(true);
    expect(spans.find((s) => s.text === 'hi')?.italic).toBe(true);
    expect(spans.find((s) => s.text === '漢')?.ruby).toBe('kan');
    expect(spans[spans.length - 1]!.text).toBe(' &');
    expect(vttPlainText('<ruby>漢<rt>kan</rt></ruby><unknown>x</unknown>')).toBe('漢x');
  });

  it('splits karaoke timestamps', () => {
    const { karaoke } = parseVttCueText('Nun<00:00:01.250>ca <00:00:01.500>jamás', 1000);
    expect(karaoke).toEqual([
      { atMs: 1000, text: 'Nun' },
      { atMs: 1250, text: 'ca ' },
      { atMs: 1500, text: 'jamás' },
    ]);
    expect(parseVttCueText('', 42).karaoke).toEqual([{ atMs: 42, text: '' }]);
  });
});
