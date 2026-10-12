// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Writers: canonical output and exact round-trips. */

import { describe, expect, it } from 'vitest';
import { blankClip, defaultTextStyle } from '../src/model/document.ts';
import { parseSRT } from '../src/media/subtitles/srt-parser.ts';
import { decodeSubtitleBytes, detectSubtitleFormat, loadSubtitleFile, parseSubtitles } from '../src/media/subtitles/subtitle-parser.ts';
import { clipsToSubtitles, convertMarkup, subtitleSourceOf, toSRT, toVTT, writeTrack } from '../src/media/subtitles/subtitle-writer.ts';
import { parseVTT } from '../src/media/subtitles/vtt-parser.ts';
import { VTT_SAMPLE } from './f4-helpers.ts';

const CANONICAL_SRT = `1
00:00:01,000 --> 00:00:02,500
Hola, <b>mundo</b>.

2
01:02:03,004 --> 01:02:04,999
<i>dos</i>
líneas
`;

describe('toSRT / toVTT', () => {
  it('round-trips canonical SRT byte for byte', () => {
    expect(toSRT(parseSRT(CANONICAL_SRT).cues)).toBe(CANONICAL_SRT);
    expect(toSRT([])).toBe('');
  });

  it('round-trips canonical VTT byte for byte (blocks included)', () => {
    expect(writeTrack(parseVTT(VTT_SAMPLE), 'vtt')).toBe(VTT_SAMPLE);
  });

  it('parse(write(cues)) returns the same cues across formats', () => {
    const srt = parseSRT(CANONICAL_SRT);
    const asVtt = parseVTT(writeTrack(srt, 'vtt'));
    expect(asVtt.cues.map((c) => [c.startMs, c.endMs, c.text])).toEqual(srt.cues.map((c) => [c.startMs, c.endMs, c.text]));
    const vtt = parseVTT(VTT_SAMPLE);
    const asSrt = parseSRT(writeTrack(vtt, 'srt'));
    expect(asSrt.cues.map((c) => c.text)).toEqual(['Ana: Hola amigo', '<i>Segunda</i>\nlínea']);
    expect(parseVTT(toVTT(asVtt.cues)).cues).toEqual(asVtt.cues);
  });

  it('translates markup between dialects', () => {
    expect(convertMarkup('<font color="red">rojo</font> <B>b</B> {i}c{/i}', 'srt', 'vtt')).toBe('rojo <b>b</b> <i>c</i>');
    expect(convertMarkup('<c.x>a</c> <ruby>漢<rt>kan</rt></ruby> <00:00:01.000><b.y>b</b>', 'vtt', 'srt')).toBe('a 漢 <b>b</b>');
    expect(convertMarkup('igual', 'vtt', 'vtt')).toBe('igual');
  });

  it('escapes payloads that would break VTT', () => {
    const out = toVTT([{ id: 'a --> b', startMs: 0, endMs: 1000, text: 'x --> y\n\nz', settings: '' }]);
    const back = parseVTT(out);
    expect(back.cues).toHaveLength(1);
    expect(back.cues[0]!.id).toBe('');
    expect(back.warnings).toEqual([]);
  });
});

describe('clipsToSubtitles', () => {
  it('exports text clips in time order with their original markup', () => {
    const a = blankClip('a', 'T1', 'text', 'a', 2, 1.5);
    a.text = { ...defaultTextStyle(), content: 'Hola mundo' };
    a.extra = { subtitle: { format: 'srt', text: '<b>Hola</b> mundo', id: '7', settings: '' } };
    const b = blankClip('b', 'T1', 'text', 'b', 0.25, 1);
    b.text = { ...defaultTextStyle(), content: 'Título <libre>' };
    const edited = blankClip('c', 'T1', 'text', 'c', 5, 1);
    edited.text = { ...defaultTextStyle(), content: 'Cambiado' };
    edited.extra = { subtitle: { format: 'vtt', text: '<i>Original</i>', id: 'x', settings: 'line:10%' } };
    const off = blankClip('d', 'T1', 'text', 'd', 7, 1);
    off.text = { ...defaultTextStyle(), content: 'apagado' };
    off.extra = { enabled: false };
    const video = blankClip('v', 'T1', 'video', 'v', 0, 9);
    const cues = clipsToSubtitles([a, b, edited, off, video], 'srt');
    expect(cues.map((c) => [c.startMs, c.endMs, c.text])).toEqual([
      [250, 1250, 'Título &lt;libre&gt;'],
      [2000, 3500, '<b>Hola</b> mundo'],
      [5000, 6000, 'Cambiado'],
    ]);
    expect(clipsToSubtitles([a, b], 'vtt', true).map((c) => c.id)).toEqual(['7']);
    expect(clipsToSubtitles([edited], 'vtt')[0]!.settings).toBe('line:10%');
    expect(subtitleSourceOf(video)).toBeNull();
    video.extra = { subtitle: 'raro' };
    expect(subtitleSourceOf(video)).toBeNull();
  });
});

describe('subtitle files', () => {
  it('detects formats and decodes encodings', async () => {
    expect(detectSubtitleFormat('WEBVTT\n')).toBe('vtt');
    expect(detectSubtitleFormat('\uFEFFWEBVTT')).toBe('vtt');
    expect(detectSubtitleFormat('1\n00:00')).toBe('srt');
    expect(detectSubtitleFormat('WEBVTT', 'a.SRT')).toBe('srt');
    expect(parseSubtitles(CANONICAL_SRT, 'x.srt').format).toBe('srt');
    expect(decodeSubtitleBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
    expect(decodeSubtitleBytes(new TextEncoder().encode('ñandú'))).toBe('ñandú');
    expect(decodeSubtitleBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe('A');
    expect(decodeSubtitleBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x42]))).toBe('B');
    const track = await loadSubtitleFile(new File([VTT_SAMPLE], 'peli.vtt'));
    expect(track.cues).toHaveLength(2);
    await expect(loadSubtitleFile(new File(['x'], 'peli.ass'))).rejects.toThrow(/no es un archivo .srt ni .vtt/);
  });
});
