// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** AudioMixer: track gains, mute/solo, clip scheduling and the VU meter. */

import { describe, expect, it } from 'vitest';
import {
  AudioMixer,
  type AnalyserLike,
  type AudioGraphContext,
  type BufferLike,
  type GainLike,
  type ParamLike,
  type SourceLike,
} from '../src/player/audio-mixer.ts';

/** An `AudioParam` double that records its automation. */
class FakeParam implements ParamLike {
  value = 1;
  events: { kind: string; value: number; time: number }[] = [];

  setValueAtTime(value: number, time: number): void {
    this.events.push({ kind: 'set', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ kind: 'ramp', value, time });
  }
}

/** A gain double. */
class FakeGain implements GainLike {
  gain = new FakeParam();
  connected: unknown[] = [];
  disconnected = 0;

  connect(destination: unknown): void {
    this.connected.push(destination);
  }

  disconnect(): void {
    this.disconnected += 1;
  }
}

/** An analyser double with a fixed level. */
class FakeAnalyser implements AnalyserLike {
  fftSize = 1024;
  samples = new Float32Array(1024);
  connected: unknown[] = [];
  disconnected = 0;

  constructor() {
    this.samples.fill(0.5);
  }

  getFloatTimeDomainData(target: Float32Array): void {
    target.set(this.samples.subarray(0, target.length));
  }

  connect(destination: unknown): void {
    this.connected.push(destination);
  }

  disconnect(): void {
    this.disconnected += 1;
  }
}

/** A source double: records start/stop and its schedule. */
class FakeSource implements SourceLike {
  buffer: BufferLike | null = null;
  playbackRate = new FakeParam();
  started: { when: number; offset: number; duration: number | undefined } | null = null;
  stopped = false;
  connected: unknown[] = [];
  disconnected = 0;

  start(when?: number, offset?: number, duration?: number): void {
    this.started = { when: when ?? 0, offset: offset ?? 0, duration };
  }

  stop(): void {
    this.stopped = true;
  }

  connect(destination: unknown): void {
    this.connected.push(destination);
  }

  disconnect(): void {
    this.disconnected += 1;
  }
}

/** A context double that hands out the doubles above. */
class FakeContext implements AudioGraphContext {
  currentTime = 10;
  destination: unknown = { isDestination: true };
  gains: FakeGain[] = [];
  analysers: FakeAnalyser[] = [];
  sources: FakeSource[] = [];

  createGain(): GainLike {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createAnalyser(): AnalyserLike {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }

  createBufferSource(): SourceLike {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

const buffer: BufferLike = { duration: 8 };

function makeMixer(): { mixer: AudioMixer; context: FakeContext } {
  const context = new FakeContext();
  return { mixer: new AudioMixer(context), context };
}

describe('AudioMixer tracks', () => {
  it('routes track gains to the master through the analyser', () => {
    const { mixer, context } = makeMixer();
    mixer.addTrack('V1', buffer);
    mixer.setTrackVolume('V1', 1.5);
    // Master gain → analyser → destination.
    expect(context.gains[0]!.connected).toContain(context.analysers[0]);
    expect(context.analysers[0]!.connected).toContain(context.destination);
  });

  it('sets the track fader', () => {
    const { mixer, context } = makeMixer();
    mixer.addTrack('V1', buffer);
    const trackGain = context.gains[1]!;
    mixer.setTrackVolume('V1', 0.25);
    expect(trackGain.gain.value).toBeCloseTo(0.25, 6);
    mixer.setTrackVolume('V1', -2);
    expect(trackGain.gain.value).toBe(0);
  });

  it('mute silences the track and keeps its level', () => {
    const { mixer, context } = makeMixer();
    mixer.addTrack('V1', buffer);
    mixer.setTrackVolume('V1', 0.8);
    mixer.setTrackMute('V1', true);
    expect(context.gains[1]!.gain.value).toBe(0);
    mixer.setTrackMute('V1', false);
    expect(context.gains[1]!.gain.value).toBeCloseTo(0.8, 6);
  });

  it('any solo silences the rest', () => {
    const { mixer, context } = makeMixer();
    mixer.addTrack('V1', buffer);
    mixer.addTrack('V2', buffer);
    mixer.setTrackSolo('V2', true);
    expect(context.gains[1]!.gain.value).toBe(0);
    expect(context.gains[2]!.gain.value).toBe(1);
    mixer.setTrackSolo('V2', false);
    expect(context.gains[1]!.gain.value).toBe(1);
  });

  it('removeTrack tears the sources down', () => {
    const { mixer, context } = makeMixer();
    mixer.addTrack('V1', buffer);
    mixer.startAll(0);
    expect(context.sources).toHaveLength(1);
    mixer.removeTrack('V1');
    expect(mixer.sourceCount).toBe(0);
    expect(context.sources[0]!.stopped).toBe(true);
  });
});

describe('AudioMixer clip sources', () => {
  it('starts at the right offset when the playhead is inside the clip', () => {
    const { mixer, context } = makeMixer();
    mixer.addClipSource('V1', 'c1', {
      timelineStart: 2,
      sourceOffset: 1,
      duration: 5,
      buffer,
      volume: 0.5,
      fadeIn: 0,
      fadeOut: 0,
      rate: 1,
    });
    mixer.startAll(3.5);
    const source = context.sources[0]!;
    // Into the clip by 1.5s → source offset 1 + 1.5.
    expect(source.started!.offset).toBeCloseTo(2.5, 6);
    // Remaining 3.5s of the clip.
    expect(source.started!.duration).toBeCloseTo(3.5, 6);
  });

  it('does not start clips that already ended', () => {
    const { mixer, context } = makeMixer();
    mixer.addClipSource('V1', 'c1', {
      timelineStart: 0,
      sourceOffset: 0,
      duration: 2,
      buffer,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      rate: 1,
    });
    mixer.startAll(5);
    // An ended clip schedules no node at all.
    expect(context.sources).toHaveLength(0);
  });

  it('delays clips that sit ahead of the playhead', () => {
    const { mixer, context } = makeMixer();
    mixer.addClipSource('V1', 'c1', {
      timelineStart: 4,
      sourceOffset: 0,
      duration: 4,
      buffer,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      rate: 1,
    });
    mixer.startAll(0);
    // Context clock is 10; the clip starts 4 timeline seconds later.
    expect(context.sources[0]!.started!.when).toBeCloseTo(14, 6);
    expect(context.sources[0]!.started!.offset).toBeCloseTo(0, 6);
    expect(context.sources[0]!.started!.duration).toBeCloseTo(4, 6);
  });

  it('applies fade ramps around the clip', () => {
    const { mixer, context } = makeMixer();
    mixer.addClipSource('V1', 'c1', {
      timelineStart: 0,
      sourceOffset: 0,
      duration: 10,
      buffer,
      volume: 1,
      fadeIn: 1,
      fadeOut: 2,
      rate: 1,
    });
    mixer.startAll(0);
    // Gains: master(0), track(1), the clip's own ride(2).
    const gain = context.gains[2]!;
    const kinds = gain.gain.events.map((event) => event.kind);
    expect(kinds).toContain('ramp');
    // Ramp up to unity at 1s (context time 10), ramp to zero at 10s.
    const ramps = gain.gain.events.filter((event) => event.kind === 'ramp');
    expect(ramps[0]!.value).toBe(1);
    expect(ramps[0]!.time).toBeCloseTo(11, 6);
    expect(ramps[1]!.value).toBe(0);
    expect(ramps[1]!.time).toBeCloseTo(20, 6);
  });

  it('sets the playback rate from the spec', () => {
    const { mixer, context } = makeMixer();
    mixer.addClipSource('V1', 'c1', {
      timelineStart: 0,
      sourceOffset: 0,
      duration: 4,
      buffer,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      rate: 2,
    });
    mixer.startAll(0);
    expect(context.sources[0]!.playbackRate.value).toBe(2);
  });

  it('stopAll stops and clears the schedule', () => {
    const { mixer, context } = makeMixer();
    mixer.addClipSource('V1', 'c1', {
      timelineStart: 0,
      sourceOffset: 0,
      duration: 4,
      buffer,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      rate: 1,
    });
    mixer.startAll(0);
    mixer.stopAll();
    expect(context.sources[0]!.stopped).toBe(true);
    // Sources stay registered but stopped, ready for startAll again.
    expect(mixer.sourceCount).toBe(1);
    mixer.startAll(0);
    expect(context.sources).toHaveLength(2);
  });

  it('removeClipSource drops one clip only', () => {
    const { mixer, context } = makeMixer();
    mixer.addClipSource('V1', 'c1', {
      timelineStart: 0,
      sourceOffset: 0,
      duration: 4,
      buffer,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      rate: 1,
    });
    mixer.addClipSource('V1', 'c2', {
      timelineStart: 4,
      sourceOffset: 0,
      duration: 4,
      buffer,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      rate: 1,
    });
    mixer.startAll(0);
    mixer.removeClipSource('c1');
    expect(mixer.sourceCount).toBe(1);
    expect(context.sources[0]!.stopped).toBe(true);
    expect(context.sources[1]!.stopped).toBe(false);
  });
});

describe('AudioMixer master', () => {
  it('sets the master volume', () => {
    const { mixer, context } = makeMixer();
    mixer.setMasterVolume(0.4);
    expect(context.gains[0]!.gain.value).toBeCloseTo(0.4, 6);
  });

  it('reads the RMS level', () => {
    const { mixer, context } = makeMixer();
    context.analysers[0]!.samples.fill(0.5);
    expect(mixer.masterLevel).toBeCloseTo(0.5, 6);
    context.analysers[0]!.samples.fill(-1);
    expect(mixer.masterLevel).toBeCloseTo(1, 6);
  });

  it('exposes the context clock', () => {
    const { mixer, context } = makeMixer();
    context.currentTime = 42;
    expect(mixer.now).toBe(42);
  });
});
