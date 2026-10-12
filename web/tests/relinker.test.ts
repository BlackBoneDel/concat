// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Relinking: offline detection, scoring, auto/manual split, undoable edit. */

import { describe, expect, it } from 'vitest';
import type { ScannedFile } from '../src/media/relink/folder-scanner.ts';
import {
  AUTO_RELINK_THRESHOLD,
  RelinkMediaOperation,
  Relinker,
  combineScore,
  durationScore,
  levenshtein,
  nameScore,
  normalizedStem,
  recordedHash,
  resolutionScore,
  type CandidateProbe,
} from '../src/media/relink/relinker.ts';
import { clipsOf, makeMedia, makeSession, snap } from './f3-helpers.ts';

const HASH_A = 'a'.repeat(64);
const scanned = (name: string, body = 'x', path = `D/${name}`): ScannedFile => ({ file: new File([body], name), path });

/** Probe table by file name. */
function probes(table: Record<string, CandidateProbe>): (file: File) => Promise<CandidateProbe | null> {
  return async (file) => table[file.name] ?? null;
}

describe('criteria', () => {
  it('scores names', () => {
    expect(nameScore('media/Clip01.mp4', 'clip01.MP4')).toBe(1);
    expect(nameScore('Clip01.mp4', 'Clip01.mov')).toBe(0.9);
    expect(nameScore('Clip01.mp4', 'Clip01 (2).mp4')).toBe(0.95);
    expect(nameScore('entrevista_final.mp4', 'entrevista-final copia.mp4')).toBe(0.95);
    expect(nameScore('Clip01.mp4', 'Clip02.mp4')).toBeGreaterThan(0.6);
    expect(nameScore('Clip01.mp4', 'Clip02.mp4')).toBeLessThan(0.9);
    expect(nameScore('playa.mp4', 'xyz.mp4')).toBeLessThan(0.3);
    expect(nameScore('---.mp4', '___.mov')).toBe(0);
    expect(normalizedStem('C:\\cosas\\Mi Clip (3).MP4')).toBe('miclip');
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('scores duration within one frame and resolution exactly', () => {
    expect(durationScore(10, 10 + 1 / 30, 30)).toBe(1);
    expect(durationScore(10, 10.05, 30)).toBe(0);
    expect(durationScore(10, 10.03, 0)).toBe(1);
    expect(durationScore(null, 10, 30)).toBe(0);
    expect(resolutionScore({ width: 1920, height: 1080 }, { duration: 1, width: 1920, height: 1080 })).toBe(1);
    expect(resolutionScore({ width: 1920, height: 1080 }, { duration: 1, width: 1280, height: 720 })).toBe(0);
    expect(resolutionScore({ width: 1, height: 1 }, null)).toBe(0);
  });

  it('weights 0.4/0.3/0.1/0.2, hash match is proof, no hash renormalises', () => {
    expect(combineScore({ name: 1, duration: 1, resolution: 1, hash: 0 })).toBeCloseTo(0.8, 9);
    expect(combineScore({ name: 0, duration: 0, resolution: 0, hash: 1 })).toBe(1);
    expect(combineScore({ name: 1, duration: 1, resolution: 1, hash: null })).toBeCloseTo(1, 9);
    expect(combineScore({ name: 1, duration: 0, resolution: 0, hash: null })).toBeCloseTo(0.5, 9);
    expect(combineScore({ name: 0.5, duration: 1, resolution: 0, hash: 0 })).toBeCloseTo(0.5, 9);
  });
});

describe('Relinker', () => {
  it('detects offline media with usage counts', async () => {
    const session = makeSession([{ start: 0 }, { start: 2 }, { kind: 'audio', trackId: 'T2' }]);
    const relinker = new Relinker({ probe: probes({}) });
    const missing = await relinker.detectMissing(session.document, async (item) => item.id === 'm2');
    expect(missing.map((m) => [m.item.id, m.usedBy])).toEqual([['m1', 2], ['mA', 1]]);
    const failing = await relinker.detectMissing(session.document, async () => { throw new Error('opfs'); });
    expect(failing).toHaveLength(3);
  });

  it('ranks candidates and splits auto from manual', async () => {
    const item = { ...makeMedia('m1', 4), name: 'playa.mp4', path: 'media/playa.mp4' };
    const other = { ...makeMedia('m2', 2), name: 'montaña.mp4', path: 'media/montaña.mp4' };
    const relinker = new Relinker({
      probe: probes({
        'playa.mp4': { duration: 4, width: 640, height: 360 },
        'playa_v2.mp4': { duration: 9, width: 1280, height: 720 },
        'montana-final.mp4': { duration: 2.5, width: 640, height: 360 },
      }),
    });
    const files = [scanned('playa_v2.mp4'), scanned('playa.mp4'), scanned('montana-final.mp4'), scanned('foto.png')];
    const ranked = await relinker.rankCandidates(item, files);
    expect(ranked[0]!.file.name).toBe('playa.mp4');
    expect(ranked[0]!.score).toBeCloseTo(1, 9);
    expect(ranked[0]!.breakdown).toEqual({ name: 1, duration: 1, resolution: 1, hash: null });
    const progress: string[] = [];
    const { auto, manual } = await relinker.match([{ item, usedBy: 1 }, { item: other, usedBy: 1 }], files, (d, t) => progress.push(`${d}/${t}`));
    expect(auto.map((a) => [a.mediaId, a.file.name])).toEqual([['m1', 'playa.mp4']]);
    expect(manual.map((m) => m.missing.item.id)).toEqual(['m2']);
    expect(manual[0]!.candidates[0]!.file.name).toBe('montana-final.mp4');
    expect(manual[0]!.candidates[0]!.score).toBeLessThanOrEqual(AUTO_RELINK_THRESHOLD);
    expect(manual[0]!.candidates.some((c) => c.file.name === 'playa.mp4')).toBe(false);
    expect(progress).toEqual(['1/2', '2/2']);
    // Images only consider image files.
    const still = { ...makeMedia('i1', 1, 'image'), name: 'foto.png' };
    expect((await relinker.rankCandidates(still, files)).map((c) => c.file.name)).toEqual(['foto.png']);
  });

  it('a hash match wins over any name, hashing only same-size files', async () => {
    const item = { ...makeMedia('m1'), name: 'original.mp4', extra: { sha256: HASH_A, fileSize: 3 } };
    expect(recordedHash(item)).toBe(HASH_A);
    const hashed: string[] = [];
    const relinker = new Relinker({
      probe: probes({}),
      hasher: {
        computeSHA256: async (file) => {
          hashed.push((file as File).name);
          return (file as File).name === 'renombrado.bin' ? HASH_A : 'b'.repeat(64);
        },
      },
    });
    const files = [scanned('original.mp4', 'xxxx'), scanned('renombrado.bin', 'abc'), scanned('otro.mp4', 'def')];
    const { auto } = await relinker.match([{ item, usedBy: 1 }], files);
    expect(auto[0]!.file.name).toBe('renombrado.bin');
    expect(auto[0]!.score).toBe(1);
    expect(hashed.sort()).toEqual(['otro.mp4', 'renombrado.bin']);
    const ranked = await relinker.rankCandidates(item, files);
    expect(ranked.find((c) => c.file.name === 'original.mp4')!.breakdown.hash).toBe(0);
    expect(hashed).toHaveLength(2); // cached
  });

  it('two entries never claim the same file', async () => {
    const a = { ...makeMedia('a'), name: 'clip.mp4' };
    const b = { ...makeMedia('b'), name: 'clip.mp4' };
    const relinker = new Relinker({ probe: probes({ 'clip.mp4': { duration: 4, width: 1920, height: 1080 } }) });
    const { auto, manual } = await relinker.match([{ item: a, usedBy: 1 }, { item: b, usedBy: 1 }], [scanned('clip.mp4')]);
    expect(auto).toHaveLength(1);
    expect(manual[0]!.candidates).toEqual([]);
  });
});

describe('RelinkMediaOperation', () => {
  it('swaps file fields, preserves every clip edit and undoes exactly', () => {
    const session = makeSession([{ start: 1, duration: 2 }]);
    const clip = clipsOf(session)[0]!;
    clip.opacity = 0.5;
    clip.extra = { effects: { version: 1, lut: { id: 'builtin:warm', strength: 1 } } };
    session.history.rebase(session.document);
    const before = snap(session.document);
    const clipsBefore = JSON.stringify(clipsOf(session));
    const relinker = new Relinker({ probe: probes({}) });
    const op = relinker.buildOperation([{ mediaId: 'm1', file: new File(['abc'], 'nuevo.mp4'), path: 'Disco/nuevo.mp4', score: 1 }], new Map([['m1', HASH_A]]));
    expect(session.run(op)).toBe(true);
    const media = session.document.media.find((m) => m.id === 'm1')!;
    expect(media.path).toBe('Disco/nuevo.mp4');
    expect(media.name).toBe('nuevo.mp4');
    expect(media.extra).toMatchObject({ sha256: HASH_A, fileSize: 3, relinkedFrom: 'media/m1' });
    expect(JSON.stringify(clipsOf(session))).toBe(clipsBefore);
    session.undo();
    expect(snap(session.document)).toBe(before);
    const many = relinker.buildOperation([
      { mediaId: 'm1', file: new File(['a'], 'x.mp4'), path: 'x.mp4', score: 1 },
      { mediaId: 'm2', file: new File(['b'], 'y.mp4'), path: 'y.mp4', score: 1 },
    ]);
    expect(session.run(many)).toBe(true);
    session.undo();
    expect(snap(session.document)).toBe(before);
    expect(session.run(new RelinkMediaOperation('nope', { path: '', name: '', fileSize: 0, sha256: null }))).toBe(false);
  });
});
