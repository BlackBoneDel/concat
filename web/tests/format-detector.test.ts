// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Magic-byte container/codec sniffing and the native-vs-FFmpeg decision. */

import { describe, expect, it } from 'vitest';
import { FormatDetector, ebmlDocType, sniffCodecs, sniffContainer } from '../src/media/ffmpeg/format-detector.ts';
import {
  capabilitiesOf,
  detectCapabilities,
  extensionOf,
  kindByExtension,
  supportFor,
} from '../src/media/import/format-support.ts';
import { muxMp4 } from '../src/media/proxy/proxy-worker.ts';

const enc = new TextEncoder();

function bytes(...parts: (string | number[] | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const arrays = parts.map((part) => (typeof part === 'string' ? Uint8Array.from([...part].map((c) => c.charCodeAt(0))) : Uint8Array.from(part)));
  const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  return out;
}

function le32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** An EBML header with DocType + a CodecID payload. */
function ebml(docType: string, ...codecIds: string[]): Uint8Array<ArrayBuffer> {
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f], [0x42, 0x86, 0x81, 1], [0x42, 0x82, 0x80 | docType.length], docType, ...codecIds.flatMap((id) => [[0x86, 0x80 | id.length], id]));
}

function avi(handler: string, compression: string, waveTag: number): Uint8Array<ArrayBuffer> {
  return bytes(
    'RIFF', le32(1000), 'AVI ', 'LIST', le32(200), 'hdrl',
    'strh', le32(56), 'vids', handler, new Array(48).fill(0),
    'strf', le32(40), le32(40), le32(640), le32(480), [1, 0, 24, 0], compression,
    'strh', le32(56), 'auds', [0, 0, 0, 0], new Array(48).fill(0),
    'strf', le32(18), [waveTag & 0xff, waveTag >> 8], [2, 0],
  );
}

function flv(videoCodec: number, audioFormat: number): Uint8Array<ArrayBuffer> {
  const tag = (type: number, first: number): number[] => [type, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, first, ...be32(12)];
  return bytes('FLV', [1, 5], be32(9), be32(0), tag(9, 0x10 | videoCodec), tag(8, audioFormat << 4));
}

describe('sniffContainer', () => {
  it('detects every container by magic bytes, not extension', () => {
    expect(sniffContainer(bytes([0, 0, 0, 24], 'ftypisom'))).toBe('mp4');
    expect(sniffContainer(bytes([0, 0, 0, 24], 'ftypqt  '))).toBe('mov');
    expect(sniffContainer(bytes([0, 0, 0, 8], 'wide'))).toBe('mov');
    expect(sniffContainer(ebml('webm', 'V_VP9'))).toBe('webm');
    expect(sniffContainer(ebml('matroska', 'V_MPEGH/ISO/HEVC'))).toBe('mkv');
    expect(sniffContainer(avi('XVID', 'XVID', 0x55))).toBe('avi');
    expect(sniffContainer(flv(7, 10))).toBe('flv');
    expect(sniffContainer(bytes('OggS', [0, 2]))).toBe('ogg');
    expect(sniffContainer(bytes('RIFF', le32(4), 'WAVE'))).toBe('unknown');
    expect(sniffContainer(new Uint8Array(0))).toBe('unknown');
    expect(ebmlDocType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0x42, 0x82, 0x04], 'test'))).toBe('');
  });
});

describe('sniffCodecs', () => {
  it('reads Matroska CodecIDs, AVI fourccs/wave tags, FLV tags and Ogg packets', () => {
    expect(sniffCodecs('mkv', ebml('matroska', 'V_MPEGH/ISO/HEVC', 'A_AC3'))).toEqual({ video: 'hevc', audio: 'ac3' });
    expect(sniffCodecs('webm', ebml('webm', 'V_AV1', 'A_OPUS'))).toEqual({ video: 'av1', audio: 'opus' });
    expect(sniffCodecs('avi', avi('XVID', 'XVID', 0x55))).toEqual({ video: 'mpeg4', audio: 'mp3' });
    expect(sniffCodecs('avi', avi('    ', 'MJPG', 0x1))).toEqual({ video: 'mjpeg', audio: 'pcm' });
    expect(sniffCodecs('flv', flv(7, 10))).toEqual({ video: 'h264', audio: 'aac' });
    expect(sniffCodecs('flv', flv(4, 2))).toEqual({ video: 'vp6', audio: 'mp3' });
    expect(sniffCodecs('ogg', bytes('OggS', '\x80theora', 'OpusHead'))).toEqual({ video: 'theora', audio: 'opus' });
    expect(sniffCodecs('ogg', bytes('OggS', '\x01vorbis'))).toEqual({ video: '', audio: 'vorbis' });
    expect(sniffCodecs('unknown', new Uint8Array(4))).toEqual({ video: '', audio: '' });
  });

  it('reads MP4 sample entries (head or tail)', () => {
    const mp4 = muxMp4({
      codec: 'avc1.42E01F', description: Uint8Array.of(1, 0x42, 0xe0, 0x1f, 0xff, 0xe0, 0), width: 64, height: 64,
      samples: [{ data: new Uint8Array(4), timestamp: 0, duration: 33_333, key: true }],
    });
    expect(sniffCodecs('mp4', mp4)).toEqual({ video: 'h264', audio: '' });
  });
});

describe('FormatDetector', () => {
  it('detects from a Blob and decides native vs fallback per engine', async () => {
    const chrome = new FormatDetector(capabilitiesOf('chromium'));
    const firefox = new FormatDetector(capabilitiesOf('firefox'));
    const safari = new FormatDetector(capabilitiesOf('safari'));
    const mkvHevc = await chrome.detect(new Blob([ebml('matroska', 'V_MPEGH/ISO/HEVC', 'A_AAC')]));
    expect(mkvHevc).toMatchObject({ container: 'mkv', videoCodec: 'hevc', audioCodec: 'aac' });
    expect(mkvHevc.magicBytes.length).toBe(16);
    expect(chrome.needsFallback(mkvHevc)).toBe(true);
    const webmAv1 = await chrome.detect(new Blob([ebml('webm', 'V_AV1', 'A_OPUS')]));
    expect(chrome.canHandleNatively(webmAv1)).toBe(true);
    expect(firefox.canHandleNatively(webmAv1)).toBe(true);
    expect(safari.canHandleNatively(webmAv1)).toBe(false);
    const aviFile = await chrome.detect(new Blob([avi('XVID', 'XVID', 0x55)]));
    expect(chrome.needsFallback(aviFile)).toBe(true);
    const hevcMp4 = { container: 'mp4' as const, videoCodec: 'hevc', audioCodec: 'aac', magicBytes: new Uint8Array(0) };
    expect(safari.canHandleNatively(hevcMp4)).toBe(true);
    expect(chrome.canHandleNatively(hevcMp4)).toBe(false);
    expect(chrome.canHandleNatively({ ...hevcMp4, container: 'unknown' })).toBe(false);
    expect(chrome.canHandleNatively({ ...hevcMp4, videoCodec: 'h264', audioCodec: 'dts' })).toBe(false);
    expect(chrome.caps.videoEncoder).toBe(true);
  });

  it('reads the MP4 tail when moov is at the end', async () => {
    const mp4 = muxMp4({
      codec: 'avc1.42E01F', description: Uint8Array.of(1, 0x42, 0xe0, 0x1f, 0xff, 0xe0, 0), width: 64, height: 64,
      samples: [{ data: new Uint8Array(20_000), timestamp: 0, duration: 33_333, key: true }],
    });
    const copy = new Uint8Array(mp4.length);
    copy.set(mp4);
    const format = await new FormatDetector(capabilitiesOf('chromium')).detect(new Blob([copy.buffer]));
    expect(format).toMatchObject({ container: 'mp4', videoCodec: 'h264' });
  });
});

describe('format-support', () => {
  it('maps extensions and probes capabilities', () => {
    expect(extensionOf('Clip.MKV')).toBe('mkv');
    expect(extensionOf('noext')).toBe('');
    expect(kindByExtension('a.srt')).toBe('subtitle');
    expect(kindByExtension('a.cube')).toBe('lut');
    expect(kindByExtension('a.flac')).toBe('audio');
    expect(kindByExtension('a.png')).toBe('image');
    expect(kindByExtension('a.mts')).toBe('video');
    expect(kindByExtension('a.txt')).toBe('other');
    expect(supportFor('firefox').videoEncoder).toBe(false);
    const probe = { canPlayType: (type: string) => (type.includes('webm') || type.includes('avc1') ? 'probably' : '') };
    const caps = detectCapabilities(probe);
    expect(caps.video.has('vp9')).toBe(true);
    expect(caps.video.has('hevc')).toBe(false);
    expect(caps.containers.has('webm')).toBe(true);
    const silent = detectCapabilities({ canPlayType: () => '' });
    expect(silent.video.has('h264')).toBe(true); // baseline when the probe answers nothing
    expect(detectCapabilities(null).audio.has('aac')).toBe(true);
    void enc;
  });
});
