// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import {
  CONTAINER_AUDIO_CODECS,
  EXPORT_ERROR_MESSAGES,
  EXPORT_MIME_TYPES,
  ExportError,
  defaultExportConfig,
  exportFileName,
  frameRateOf,
  isExportError,
  throwIfAborted,
  toExportError,
  validateExportConfig,
} from '../src/export/types.ts';
import { EXPORT_PRESETS, applyPreset, estimateOutputBytes, getPresetById } from '../src/export/export-presets.ts';
import {
  estimateAudioBytes,
  estimateContainerOverhead,
  estimateGifBytes,
  estimateStreamBytes,
  estimateTotalBytes,
  estimateVideoBytes,
  formatBitrate,
  formatBytes,
  formatEta,
} from '../src/export/bitrate-estimator.ts';
import { FrameClock, roundRational } from '../src/export/frame-clock.ts';

const r = (n: number, d = 1): Rational => Rational.new(n, d);

describe('export types', () => {
  it('ExportError carries code, message and cause', () => {
    const cause = new Error('x');
    const error = new ExportError('MUX_FAILED', undefined, cause);
    expect(error.code).toBe('MUX_FAILED');
    expect(error.message).toBe(EXPORT_ERROR_MESSAGES.MUX_FAILED);
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
    expect(isExportError(error)).toBe(true);
    expect(isExportError(new Error('no'))).toBe(false);
    expect(new ExportError('NO_MEDIA', 'falta a.mp4').message).toBe('falta a.mp4');
  });

  it('toExportError maps abort, memory, unsupported and unknown', () => {
    const abort = new Error('stop');
    abort.name = 'AbortError';
    expect(toExportError(abort).code).toBe('ABORTED');
    expect(toExportError(new RangeError('Array buffer allocation failed')).code).toBe('OUT_OF_MEMORY');
    const unsupported = new Error('codec');
    unsupported.name = 'NotSupportedError';
    expect(toExportError(unsupported).code).toBe('ENCODER_UNSUPPORTED');
    expect(toExportError('boom').code).toBe('UNKNOWN');
    expect(toExportError('boom').message).toBe('boom');
    const same = new ExportError('INVALID_RANGE');
    expect(toExportError(same)).toBe(same);
  });

  it('throwIfAborted throws only for aborted signals', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(ExportError);
  });

  it('default config is valid and every code has a message', () => {
    expect(validateExportConfig(defaultExportConfig())).toEqual([]);
    for (const code of ['ABORTED', 'ENCODER_UNSUPPORTED', 'MUX_FAILED', 'OUT_OF_MEMORY', 'NO_MEDIA', 'INVALID_RANGE', 'UNKNOWN'] as const) {
      expect(EXPORT_ERROR_MESSAGES[code].length).toBeGreaterThan(5);
    }
    expect(EXPORT_MIME_TYPES.webm).toBe('video/webm');
    expect(CONTAINER_AUDIO_CODECS.gif).toEqual(['none']);
  });

  it('validates sizes, parity, rates, codecs, bitrates and ranges', () => {
    const base = defaultExportConfig();
    expect(validateExportConfig({ ...base, width: 1921 }).join()).toMatch(/pares/);
    expect(validateExportConfig({ ...base, width: 8 }).join()).toMatch(/resolución/);
    expect(validateExportConfig({ ...base, format: 'gif', width: 481, height: 271 })).toEqual([]);
    expect(validateExportConfig({ ...base, frameRate: { num: 0, den: 1 } }).join()).toMatch(/fracción/);
    expect(validateExportConfig({ ...base, frameRate: { num: 240, den: 1 } }).join()).toMatch(/120/);
    expect(validateExportConfig({ ...base, format: 'gif', frameRate: { num: 60, den: 1 } }).join()).toMatch(/50/);
    expect(validateExportConfig({ ...base, format: 'webm' }).join()).toMatch(/vídeo h264-high/);
    expect(validateExportConfig({ ...base, format: 'webm', videoCodec: 'vp9' }).join()).toMatch(/audio aac/);
    expect(validateExportConfig({ ...base, videoBitrate: 10 }).join()).toMatch(/vídeo debe/);
    expect(validateExportConfig({ ...base, audioBitrate: 10 }).join()).toMatch(/audio debe/);
    expect(validateExportConfig({ ...base, audioCodec: 'none', audioBitrate: 10 })).toEqual([]);
    expect(validateExportConfig({ ...base, sampleRate: 22050 }).join()).toMatch(/muestreo/);
    expect(validateExportConfig({ ...base, channels: 6 }).join()).toMatch(/Canales/);
    expect(validateExportConfig({ ...base, keyframeInterval: 0 }).join()).toMatch(/keyframes/);
    expect(validateExportConfig({ ...base, range: { start: r(2), end: r(1) } }).join()).toMatch(/rango/);
    expect(validateExportConfig({ ...base, format: 'gif', gif: { dither: false, loop: 0, maxColors: 1 } }).join()).toMatch(/paleta/);
  });

  it('frameRateOf and exportFileName', () => {
    expect(frameRateOf({ num: 30000, den: 1001 })?.equals(r(30000, 1001))).toBe(true);
    expect(frameRateOf({ num: 29.97, den: 1 })).toBeNull();
    expect(exportFileName({ ...defaultExportConfig(), fileName: 'mi/video:final.mp4' })).toBe('mi-video-final.mp4');
    expect(exportFileName({ ...defaultExportConfig(), fileName: '   ', format: 'gif' })).toBe('concat-export.gif');
  });
});

describe('export presets', () => {
  it('ships the eight presets with the documented numbers', () => {
    expect(EXPORT_PRESETS.map((p) => p.id)).toEqual([
      'youtube-1080p', 'youtube-4k', 'tiktok-reels', 'instagram-square', 'pro-60fps', 'web-low', 'gif-short', 'master-prores-like',
    ]);
    const k4 = applyPreset('youtube-4k');
    expect([k4.width, k4.height, k4.videoBitrate, k4.audioBitrate]).toEqual([3840, 2160, 20_000_000, 320_000]);
    const tiktok = applyPreset('tiktok-reels');
    expect([tiktok.width, tiktok.height, tiktok.videoBitrate]).toEqual([1080, 1920, 6_000_000]);
    const square = applyPreset('instagram-square');
    expect([square.width, square.height, square.videoBitrate]).toEqual([1080, 1080, 5_000_000]);
    const pro = applyPreset('pro-60fps');
    expect([pro.frameRate.num, pro.videoBitrate, pro.audioBitrate]).toEqual([60, 12_000_000, 320_000]);
    const web = applyPreset('web-low');
    expect([web.format, web.videoCodec, web.audioCodec, web.height, web.videoBitrate, web.audioBitrate]).toEqual(['webm', 'vp9', 'opus', 720, 2_000_000, 128_000]);
    const gif = applyPreset('gif-short');
    expect([gif.format, gif.width, gif.height, gif.frameRate.num, gif.audioCodec]).toEqual(['gif', 480, 270, 12, 'none']);
    const master = applyPreset('master-prores-like');
    expect([master.videoBitrate, master.audioBitrate]).toEqual([15_000_000, 320_000]);
    for (const preset of EXPORT_PRESETS) expect(validateExportConfig(applyPreset(preset))).toEqual([]);
  });

  it('getPresetById / applyPreset keep range and file name', () => {
    expect(getPresetById('nope')).toBeNull();
    expect(() => applyPreset('nope')).toThrow(/desconocido/);
    const base = { ...defaultExportConfig(), fileName: 'clip', range: { start: r(1), end: r(3) } };
    const applied = applyPreset('web-low', base);
    expect(applied.fileName).toBe('clip');
    expect(applied.range?.end.equals(r(3))).toBe(true);
    expect(applied.presetId).toBe('web-low');
    applied.frameRate.num = 1;
    expect(getPresetById('web-low')?.config.frameRate?.num).toBe(30);
  });

  it('estimateOutputBytes accepts ids, presets and configs', () => {
    const bytes = estimateOutputBytes('youtube-1080p', 60);
    expect(bytes).toBeGreaterThan(60_000_000);
    expect(bytes).toBeLessThan(62_000_000);
    expect(estimateOutputBytes(EXPORT_PRESETS[0]!, 60)).toBe(bytes);
    expect(estimateOutputBytes(applyPreset('youtube-1080p'), 60)).toBe(bytes);
    expect(estimateOutputBytes('gif-short', 5)).toBeGreaterThan(100_000);
  });
});

describe('bitrate estimator', () => {
  it('estimates streams and containers', () => {
    expect(estimateStreamBytes(8_000_000, 10)).toBe(10_000_000);
    expect(estimateStreamBytes(0, 10)).toBe(0);
    expect(estimateVideoBytes({ videoBitrate: 1_000_000 }, 8)).toBe(1_000_000);
    expect(estimateAudioBytes({ audioBitrate: 128_000, audioCodec: 'opus' }, 8)).toBe(128_000);
    expect(estimateAudioBytes({ audioBitrate: 128_000, audioCodec: 'none' }, 8)).toBe(0);
    expect(estimateContainerOverhead('mp4', 1, 30)).toBe(4096 + 360);
    expect(estimateContainerOverhead('webm', 1, 30)).toBe(1024 + 480);
    expect(estimateContainerOverhead('gif', 1, 10)).toBe(800 + 190);
    expect(estimateContainerOverhead('mp4', 0, 30)).toBe(0);
    expect(estimateGifBytes(100, 100, 10, false)).toBeLessThan(estimateGifBytes(100, 100, 10, true));
    expect(estimateGifBytes(0, 100, 10, false)).toBe(0);
    const config = defaultExportConfig();
    expect(estimateTotalBytes(config, 10)).toBe(10_000_000 + 240_000 + 4096 + 3600);
  });

  it('formats bytes, ETA and bitrates', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3277)).toBe('3.2 KB');
    expect(formatBytes(13_002_342)).toBe('12.4 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(formatEta(201)).toBe('00:03:21');
    expect(formatEta(3725.4)).toBe('01:02:05');
    expect(formatEta(null)).toBe('--:--:--');
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('--:--:--');
    expect(formatBitrate(8_000_000)).toBe('8 Mbps');
    expect(formatBitrate(2_500_000)).toBe('2.5 Mbps');
    expect(formatBitrate(192_000)).toBe('192 kbps');
    expect(formatBitrate(0)).toBe('0 kbps');
  });
});

describe('frame clock', () => {
  it('counts floor((end-start)*fps) frames', () => {
    expect(new FrameClock(r(0), r(10), r(30)).totalFrames).toBe(300);
    expect(new FrameClock(r(0), r(1), r(30000, 1001)).totalFrames).toBe(29);
    expect(new FrameClock(r(1, 2), r(21, 20), r(10)).totalFrames).toBe(5);
  });

  it('validates the range and rate', () => {
    expect(() => new FrameClock(r(1), r(1), r(30))).toThrow(ExportError);
    expect(() => new FrameClock(r(2), r(1), r(30))).toThrow(/posterior/);
    expect(() => new FrameClock(r(0), r(1), r(0))).toThrow(/positiva/);
    expect(() => new FrameClock(r(0), r(1), r(-1))).toThrow(/positiva/);
    expect(() => new FrameClock(r(-1), r(1), r(30))).toThrow(/antes de 0/);
    expect(() => new FrameClock(r(0), r(1, 100), r(30))).toThrow(/fotograma/);
    try {
      new FrameClock(r(1), r(0), r(30));
    } catch (error) {
      expect(isExportError(error) && error.code).toBe('INVALID_RANGE');
    }
  });

  it('maps indices to exact times and microsecond timestamps', () => {
    const clock = new FrameClock(r(2), r(12), r(30000, 1001));
    expect(clock.timeOf(0).equals(r(2))).toBe(true);
    expect(clock.timeOf(30000).equals(r(2).add(r(1001)))).toBe(true);
    expect(clock.timestampMicros(1)).toBe(33367);
    expect(clock.timestampMicros(299)).toBe(Math.round((299 * 1e6 * 1001) / 30000));
    let sum = 0;
    for (let i = 0; i < 100; i += 1) sum += clock.durationMicros(i);
    expect(sum).toBe(clock.timestampMicros(100));
    expect(clock.frameDuration.equals(r(1001, 30000))).toBe(true);
    expect(clock.duration.equals(r(clock.totalFrames).mul(r(1001, 30000)))).toBe(true);
    expect(() => clock.timeOf(-1)).toThrow(RangeError);
    expect(() => clock.timeOf(1.5)).toThrow(RangeError);
  });

  it('places keyframes every N seconds and iterates frames', () => {
    const clock = new FrameClock(r(0), r(5), r(30));
    expect(clock.keyframeEvery(2)).toBe(60);
    expect(clock.isKeyframe(0, 2)).toBe(true);
    expect(clock.isKeyframe(59, 2)).toBe(false);
    expect(clock.isKeyframe(120, 2)).toBe(true);
    expect(() => new FrameClock(r(0), r(1), r(1, 10))).toThrow(ExportError);
    const frames = [...new FrameClock(r(1), r(2), r(4)).frames()];
    expect(frames.map((f) => f.timestamp)).toEqual([0, 250000, 500000, 750000]);
    expect(frames[3]?.time.equals(r(7, 4))).toBe(true);
    expect(frames.every((f) => f.duration === 250000)).toBe(true);
    expect(roundRational(r(5, 2))).toBe(3);
    expect(roundRational(r(-5, 2))).toBe(-3);
    expect(roundRational(r(7, 3))).toBe(2);
  });
});
