// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/** PreviewPlayer: clock, seek, stepping and state transitions. */

import { describe, expect, it } from 'vitest';
import { PreviewPlayer } from '../src/player/player.ts';
import { Rational } from '../src/core/rational.ts';
import { FrameRate } from '../src/core/time.ts';
import { EditorSession } from '../src/session/editor-session.ts';
import { MediaPool } from '../src/media/media-pool.ts';
import type { RenderContext2D, RenderTarget } from '../src/render/types.ts';

class FakeContext implements RenderContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineJoin: 'round' | 'bevel' | 'miter' = 'miter';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  font = '';
  textAlign = 'center';
  textBaseline = 'middle';
  letterSpacing = '0px';
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  translate(): void {}
  rotate(): void {}
  scale(): void {}
  clearRect(): void {}
  fillRect(): void {}
  drawImage(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void {}
  rect(): void {}
  fill(): void {}
  stroke(): void {}
  fillText(): void {}
  strokeText(): void {}
  measureText(text: string): { width: number } {
    return { width: text.length };
  }
}

class FakeTarget implements RenderTarget {
  width = 640;
  height = 360;
  renders = 0;
  private readonly ctx = new FakeContext();

  getContext(): RenderContext2D {
    this.renders += 1;
    return this.ctx;
  }
}

function makePlayer(): {
  player: PreviewPlayer;
  session: EditorSession;
  target: FakeTarget;
  states: string[];
  times: number[];
} {
  const session = new EditorSession();
  // A 4s edit from one clip.
  session.addMediaItem({
    id: 'm1',
    path: 'media/m1',
    name: 'clip',
    duration: 4,
    kind: 'video',
    width: 640,
    height: 360,
    frameRate: 30,
    frameRateFraction: '30/1',
    videoCodec: 'h264',
    audioCodec: null,
    hasAudio: true,
    audioTracks: [],
    slot: false,
    origin: null,
    colorRange: null,
    colorSpace: 'sdr',
    extra: {},
  });
  session.addClipAt('m1', Rational.ZERO);
  const target = new FakeTarget();
  const player = new PreviewPlayer({
    canvas: target,
    session,
    mediaPool: new MediaPool(),
    audioContext: null,
  });
  const states: string[] = [];
  const times: number[] = [];
  player.onStateChanged = (state) => states.push(state);
  player.onTimeUpdate = (time) => times.push(time.asNumber());
  return { player, session, target, states, times };
}

describe('PreviewPlayer', () => {
  it('reports the session duration and starts stopped', () => {
    const { player, session } = makePlayer();
    expect(player.isPlaying).toBe(false);
    expect(player.duration.asNumber()).toBeCloseTo(session.duration().asNumber(), 6);
    expect(player.currentTime.asNumber()).toBe(0);
    player.destroy();
  });

  it('seeks, clamps and notifies', async () => {
    const { player, target, times } = makePlayer();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    player.seekTo(Rational.approximate(1.5) ?? Rational.ZERO);
    await settle();
    expect(player.currentTime.asNumber()).toBeCloseTo(1.5, 6);
    expect(target.renders).toBeGreaterThan(0);

    player.seekTo(Rational.fromInt(100n));
    await settle();
    expect(player.currentTime.asNumber()).toBeCloseTo(player.duration.asNumber(), 6);

    player.seekTo(Rational.approximate(-5) ?? Rational.ZERO);
    await settle();
    expect(player.currentTime.asNumber()).toBe(0);
    expect(times.length).toBeGreaterThanOrEqual(2);
    player.destroy();
  });

  it('steps exactly one frame at a time', () => {
    const { player, session } = makePlayer();
    const frame = session.frameRate.frameDuration();
    player.stepForward();
    expect(player.currentTime.asNumber()).toBeCloseTo(frame.asNumber(), 6);
    player.stepForward();
    expect(player.currentTime.asNumber()).toBeCloseTo(frame.asNumber() * 2, 6);
    player.stepBackward();
    expect(player.currentTime.asNumber()).toBeCloseTo(frame.asNumber(), 6);
    player.destroy();
  });

  it('plays and pauses through the state hook', async () => {
    const { player, states } = makePlayer();
    player.play();
    expect(player.isPlaying).toBe(true);
    expect(states).toContain('playing');
    player.pause();
    expect(player.isPlaying).toBe(false);
    expect(states).toContain('paused');
    player.stop();
    expect(states).toContain('stopped');
    expect(player.currentTime.asNumber()).toBe(0);
    player.destroy();
  });

  it('clamps the playback rate', () => {
    const { player } = makePlayer();
    player.setPlaybackRate(100);
    expect(player.playbackRate).toBe(4);
    player.setPlaybackRate(0.01);
    expect(player.playbackRate).toBe(0.25);
    player.setPlaybackRate(1.5);
    expect(player.playbackRate).toBe(1.5);
    player.destroy();
  });

  it('sets and clears the loop region', () => {
    const { player } = makePlayer();
    player.setLoop(Rational.fromInt(2n), Rational.fromInt(1n));
    expect(player.loop).not.toBeNull();
    // Backwards input is normalised.
    expect(player.loop!.start.asNumber()).toBe(1);
    expect(player.loop!.end.asNumber()).toBe(2);
    player.clearLoop();
    expect(player.loop).toBeNull();
    player.destroy();
  });

  it('renders once on demand', async () => {
    const { player, target } = makePlayer();
    const before = target.renders;
    await player.renderOnce();
    expect(target.renders).toBeGreaterThan(before);
    player.destroy();
  });

  it('is silent without an audio context', () => {
    const { player } = makePlayer();
    expect(player.level).toBe(0);
    player.destroy();
    // destroy is idempotent and safe to call twice.
    player.destroy();
    expect(player.isPlaying).toBe(false);
  });

  it('keeps the frame rate exact at 30 fps', () => {
    const { player, session } = makePlayer();
    expect(session.frameRate.fps().asNumber()).toBeCloseTo(30, 6);
    expect(FrameRate.THIRTY.frameDuration().asNumber()).toBeCloseTo(1 / 30, 6);
    void player;
  });

  it('keeps its position across play and pause', async () => {
    const { player } = makePlayer();
    player.seekTo(Rational.approximate(1) ?? Rational.ZERO);
    player.play();
    await new Promise((resolve) => setTimeout(resolve, 40));
    player.pause();
    // The clock advanced at least the seek position.
    expect(player.currentTime.asNumber()).toBeGreaterThanOrEqual(1);
    expect(player.isPlaying).toBe(false);
    player.destroy();
  });

  it('re-anchors the clock on seek while playing', async () => {
    const { player } = makePlayer();
    player.play();
    player.seekTo(Rational.approximate(2) ?? Rational.ZERO);
    expect(player.currentTime.asNumber()).toBeCloseTo(2, 6);
    expect(player.isPlaying).toBe(true);
    player.stop();
    player.destroy();
  });
});
