// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Deep metadata: probe + sniffing + ISO-BMFF atoms. */

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { FrameRate } from '../src/core/time.ts';
import type { MediaInfo } from '../src/media/decoder.ts';
import { FormatDetector } from '../src/media/ffmpeg/format-detector.ts';
import { capabilitiesOf } from '../src/media/import/format-support.ts';
import { MetadataExtractor, aspectRatio, needsProxy, parseMp4Atoms, readMp4Atoms } from '../src/media/import/metadata-extractor.ts';

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(body.length + 8), ...Array.from(type, (c) => c.charCodeAt(0) & 255), ...body];
}

/** `tkhd` v0 with a rotation matrix and a width. */
function tkhd(degrees: number, width: number): number[] {
  const rad = (degrees * Math.PI) / 180;
  const fixed = (v: number): number[] => u32(Math.round(v * 65536) >>> 0);
  const matrix = [...fixed(Math.cos(rad)), ...fixed(Math.sin(rad)), ...u32(0), ...fixed(-Math.sin(rad)), ...fixed(Math.cos(rad)), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
  return box('tkhd', [0, 0, 0, 3], u32(0), u32(0), u32(1), u32(0), u32(0), new Array(16).fill(0), matrix, u32(width * 65536), u32(720 * 65536));
}

/** A minimal MP4: ftyp + moov(mvhd, audio trak, video trak, udta/meta/ilst/©too) + mdat. */
function sampleMp4(): Uint8Array<ArrayBuffer> {
  const created = 2_082_844_800 + Date.UTC(2024, 4, 17, 10, 30) / 1000;
  const mvhd = box('mvhd', [0, 0, 0, 0], u32(created), u32(created), u32(1000), u32(12_500), new Array(80).fill(0));
  const encoder = box('\u00a9too', box('data', u32(1), u32(0), Array.from(new TextEncoder().encode('Lavf60.3.100'))));
  const udta = box('udta', box('meta', [0, 0, 0, 0], box('hdlr', new Array(25).fill(0)), box('ilst', encoder)));
  const moov = box('moov', mvhd, box('trak', tkhd(0, 0)), box('trak', tkhd(90, 1280)), udta);
  const bytes = [...box('ftyp', Array.from('isom', (c) => c.charCodeAt(0)), u32(512), Array.from('isomavc1', (c) => c.charCodeAt(0))), ...box('mdat', new Array(64).fill(7)), ...moov];
  return new Uint8Array(bytes);
}

function info(partial: Partial<MediaInfo>): MediaInfo {
  return {
    id: 'x', type: 'video', duration: Rational.approximate(12.5) ?? Rational.ZERO, width: 1280, height: 720, fps: FrameRate.THIRTY,
    videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.2', audioSampleRate: 48000, audioChannels: 2, fileSize: 0, container: 'mp4',
    ...partial,
  };
}

describe('parseMp4Atoms', () => {
  it('reads creation time, duration, rotation and encoder (moov at the end)', async () => {
    const bytes = sampleMp4();
    const moovAt = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'moov') - 4;
    const atoms = parseMp4Atoms(bytes.subarray(moovAt));
    expect(atoms).toEqual({ creationTime: '2024-05-17T10:30:00.000Z', durationSeconds: 12.5, rotation: 90, encoder: 'Lavf60.3.100' });
    expect(await readMp4Atoms(new Blob([bytes]))).toEqual(atoms);
  });

  it('is empty for other data', async () => {
    expect(parseMp4Atoms(new Uint8Array([1, 2, 3]))).toEqual({ creationTime: null, durationSeconds: null, rotation: 0, encoder: null });
    expect((await readMp4Atoms(new Blob([new Uint8Array(32)]))).creationTime).toBeNull();
    expect((await readMp4Atoms(new Blob([new Uint8Array(box('free', [1]))]))).encoder).toBeNull();
  });
});

describe('MetadataExtractor', () => {
  const detector = new FormatDetector(capabilitiesOf('chromium'));

  it('merges probe, sniffing and atoms', async () => {
    const extractor = new MetadataExtractor({ detector, probe: async () => info({}) });
    const file = new File([sampleMp4()], 'toma.mp4', { type: 'video/mp4', lastModified: 1_700_000_000_000 });
    const meta = await extractor.extract(file);
    expect(meta).toMatchObject({
      name: 'toma.mp4', extension: 'mp4', mimeType: 'video/mp4', kind: 'video', container: 'mp4',
      duration: 12.5, width: 1280, height: 720, aspectRatio: '16:9', fps: 30,
      audioSampleRate: 48000, audioChannels: 2, creationTime: '2024-05-17T10:30:00.000Z', rotation: 90,
      encoder: 'Lavf60.3.100', lastModified: 1_700_000_000_000, needsProxy: false,
    });
    expect(meta.bitrate).toBe(Math.round((file.size * 8) / 12.5));
    expect(meta.nativelySupported).toBe(true);
  });

  it('handles probe failures, audio and non-media files', async () => {
    const failing = new MetadataExtractor({ detector, probe: async () => { throw new Error('x'); } });
    const meta = await failing.extract(new File([sampleMp4()], 'roto.mp4'));
    expect(meta.width).toBe(0);
    expect(meta.duration).toBe(12.5); // from mvhd
    expect(meta.fps).toBeNull();
    const audio = new MetadataExtractor({ detector, probe: async () => info({ type: 'audio', width: 0, height: 0 }) });
    const a = await audio.extract(new File(['RIFF'], 'voz.wav'));
    expect(a.kind).toBe('audio');
    expect(a.aspectRatio).toBe('');
    expect(a.fps).toBeNull();
    let probed = 0;
    const lazy = new MetadataExtractor({ detector, probe: async () => { probed += 1; return null; } });
    const sub = await lazy.extract(new File(['1\n'], 'subs.srt'));
    expect(sub.kind).toBe('subtitle');
    expect(probed).toBe(0);
    const given = await lazy.extract(new File(['x'], 'c.mp4'), info({ width: 3840, height: 2160 }));
    expect(given.needsProxy).toBe(true);
    expect(probed).toBe(0);
  });
});

describe('helpers', () => {
  it('reduces ratios and applies the proxy policy', () => {
    expect(aspectRatio(1920, 1080)).toBe('16:9');
    expect(aspectRatio(1080, 1920)).toBe('9:16');
    expect(aspectRatio(4096, 2160)).toBe('256:135');
    expect(aspectRatio(0, 10)).toBe('');
    const base = { kind: 'video' as const, width: 1280, height: 720, duration: 10, size: 1_000_000, videoCodec: 'avc1' };
    expect(needsProxy(base)).toBe(false);
    expect(needsProxy({ ...base, width: 1920, height: 1080 })).toBe(true);
    expect(needsProxy({ ...base, size: 20_000_000 })).toBe(true);
    expect(needsProxy({ ...base, videoCodec: 'hvc1.1.6.L93' })).toBe(true);
    expect(needsProxy({ ...base, kind: 'audio' })).toBe(false);
  });
});
