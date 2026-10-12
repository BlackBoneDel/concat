// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Cues → title clips on dedicated lanes, as one undoable operation. */

import { describe, expect, it } from 'vitest';
import { assignLanes, buildSubtitleImport, cueLook, subtitleStyle, subtitlesToClips, SUBTITLE_OFFSET_Y } from '../src/media/subtitles/subtitle-to-clips.ts';
import { clipsToSubtitles, toSRT } from '../src/media/subtitles/subtitle-writer.ts';
import { parseSRT } from '../src/media/subtitles/srt-parser.ts';
import type { SubtitleCue } from '../src/media/subtitles/types.ts';
import { clipsOf, makeSession, snap } from './f3-helpers.ts';

const cue = (startMs: number, endMs: number, text: string, settings = ''): SubtitleCue => ({ id: '', startMs, endMs, text, settings });

describe('assignLanes', () => {
  it('packs non-overlapping cues on one lane and spills overlaps', () => {
    expect(assignLanes([cue(0, 1000, 'a'), cue(1000, 2000, 'b'), cue(1500, 2500, 'c'), cue(1600, 1700, 'd'), cue(2500, 3000, 'e')])).toEqual([0, 0, 1, 2, 0]);
    expect(assignLanes([])).toEqual([]);
  });
});

describe('cueLook', () => {
  it('places subtitles bottom-centre and carries whole-cue styles', () => {
    const base = subtitleStyle();
    const plain = cueLook(cue(0, 1, 'hola'), 'srt', base);
    expect(plain.offsetX).toBe(0);
    expect(plain.offsetY).toBe(SUBTITLE_OFFSET_Y);
    expect(plain.style.content).toBe('hola');
    expect(plain.style.align).toBe('center');
    const styled = cueLook(cue(0, 1, '<b><i><font color="#ffff00">todo</font></i></b>'), 'srt', base);
    expect(styled.style.fontWeight).toBe(700);
    expect(styled.style.italic).toBe(true);
    expect(styled.style.color).toBe('#ffff00');
    const mixed = cueLook(cue(0, 1, '<b>medio</b> normal'), 'srt', base);
    expect(mixed.style.fontWeight).toBe(base.fontWeight);
  });

  it('honours VTT line/position/align/size', () => {
    const base = subtitleStyle();
    const top = cueLook(cue(0, 1, 'x', 'line:10% position:25% align:start size:40%'), 'vtt', base);
    expect(top.offsetY).toBeCloseTo(-0.4, 9);
    expect(top.offsetX).toBeCloseTo(-0.25, 9);
    expect(top.style.align).toBe('left');
    expect(top.style.maxWidth).toBe(0.4);
    expect(cueLook(cue(0, 1, 'x', 'line:0'), 'vtt', base).offsetY).toBeCloseTo(-0.45, 9);
    expect(cueLook(cue(0, 1, 'x', 'line:-1 align:right'), 'vtt', base).offsetY).toBeCloseTo(0.45, 9);
    expect(cueLook(cue(0, 1, 'x', 'align:end'), 'vtt', base).style.align).toBe('right');
    expect(cueLook(cue(0, 1, '<v Ana>hola</v>'), 'vtt', base).style.content).toBe('hola');
  });
});

describe('subtitlesToClips', () => {
  it('builds text clips with timing, offset, style and source', () => {
    const { lanes, trackIds } = subtitlesToClips([cue(1000, 2500, 'uno'), cue(2000, 3000, 'dos')], {
      format: 'srt',
      trackIds: ['S1'],
      offsetSeconds: 10,
      style: { fontSize: 0.07 },
      makeId: (i) => `s${i}`,
    });
    expect(trackIds[0]).toBe('S1');
    expect(trackIds).toHaveLength(2);
    const [first] = lanes[0]!;
    expect(first).toMatchObject({ id: 's0', trackId: 'S1', kind: 'text', start: 11, duration: 1.5, name: 'uno' });
    expect(first!.text!.fontSize).toBe(0.07);
    expect(first!.extra['subtitle']).toEqual({ format: 'srt', text: 'uno', id: '', settings: '', index: 1 });
    expect(lanes[1]![0]!.trackId).toBe(trackIds[1]);
    const tiny = subtitlesToClips([cue(0, 1, '')], { format: 'srt' }).lanes[0]![0]!;
    expect(tiny.duration).toBeCloseTo(1 / 60, 9);
    expect(tiny.name).toBe('Subtítulo 1');
  });
});

describe('buildSubtitleImport', () => {
  it('adds lanes on top and clips in one undoable step, exporting back exactly', () => {
    const session = makeSession([{ start: 0, duration: 4 }]);
    const before = snap(session.document);
    const srt = `1
00:00:00,500 --> 00:00:01,750
Hola

2
00:00:01,000 --> 00:00:02,000
<i>a la vez</i>

3
00:00:02,000 --> 00:00:03,333
Adiós
`;
    const track = parseSRT(srt);
    const { operation, trackIds, clipIds } = buildSubtitleImport(track.cues, { format: 'srt', trackIds: ['SUB1', 'SUB2'] });
    expect(session.run(operation)).toBe(true);
    const tracks = session.document.timelines[0]!.tracks;
    expect(tracks.slice(0, 2).map((t) => [t.id, t.extra['name']])).toEqual([['SUB1', 'Subtítulos 1'], ['SUB2', 'Subtítulos 2']]);
    expect(trackIds).toEqual(['SUB1', 'SUB2']);
    const subs = clipsOf(session).filter((c) => clipIds.includes(c.id));
    expect(subs).toHaveLength(3);
    expect(subs.filter((c) => c.trackId === 'SUB2').map((c) => c.text!.content)).toEqual(['a la vez']);
    // Exact export of what was imported.
    expect(toSRT(clipsToSubtitles(clipsOf(session), 'srt', true))).toBe(srt);
    session.undo();
    expect(snap(session.document)).toBe(before);
  });
});
