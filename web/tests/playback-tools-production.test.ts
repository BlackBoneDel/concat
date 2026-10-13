// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/**
 * Regression tests for the production playback and timeline-tool bugs: the
 * audio context was resumed too late, the preview level and the lane mute and
 * solo never reached the mix, the playhead split was not one undo step, and
 * every transport key fired twice. Each test drives the real code path (the
 * player, the session, the keyboard layer) — not a getter.
 */

import { describe, expect, it } from 'vitest';
import { PreviewPlayer } from '../src/player/player.ts';
import type { AudioGraphContext, AnalyserLike, GainLike, ParamLike, SourceLike } from '../src/player/audio-mixer.ts';
import { Rational } from '../src/core/rational.ts';
import { EditSession } from '../src/session/edit-session.ts';
import { MediaPool } from '../src/media/media-pool.ts';
import { currentTimeline, SetTrackPropertyOperation } from '../src/editor/operations.ts';
import { installKeyboardShortcuts, type ShortcutActions } from '../src/ui/interactions/keyboard-shortcuts.ts';
import type { FramePool, RenderContext2D, RenderTarget } from '../src/render/types.ts';
import { renderFrame } from '../src/render/compositor.ts';

/** An AudioParam double: the value is all these tests read. */
class Param implements ParamLike {
  value = 1;
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

/** A GainNode double; the context keeps every instance. */
class Gain implements GainLike {
  gain = new Param();
  connect(): void {}
  disconnect(): void {}
}

/** An audio context double: counts resume() calls and keeps the gains. */
class Context implements AudioGraphContext {
  currentTime = 0;
  destination: unknown = {};
  gains: Gain[] = [];
  resumes = 0;
  createGain(): GainLike {
    const gain = new Gain();
    this.gains.push(gain);
    return gain;
  }
  createAnalyser(): AnalyserLike {
    return { fftSize: 1024, getFloatTimeDomainData(): void {}, connect(): void {}, disconnect(): void {} };
  }
  createBufferSource(): SourceLike {
    return {
      buffer: null,
      playbackRate: new Param(),
      start(): void {},
      stop(): void {},
      connect(): void {},
      disconnect(): void {},
    };
  }
  resume(): Promise<void> {
    this.resumes += 1;
    return Promise.resolve();
  }
}

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

class Surface implements RenderTarget {
  width = 320;
  height = 180;
  private readonly ctx = new FakeContext();
  getContext(): RenderContext2D {
    return this.ctx;
  }
}

/** A session with one 4 s clip on the first lane. */
function makeSession(): EditSession {
  const session = new EditSession();
  session.addMediaItem({
    id: 'm1',
    path: 'media/m1',
    name: 'clip',
    duration: 4,
    kind: 'video',
    width: 320,
    height: 180,
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
  // addClipAt writes the base document without the history; the app inserts
  // through an operation. Re-base so the history starts from the same clip.
  session.history.rebase(session.document);
  return session;
}

describe('play() resumes the audio context inside the gesture', () => {
  it('calls resume() synchronously, before any await', () => {
    const context = new Context();
    const player = new PreviewPlayer({ canvas: new Surface(), session: makeSession(), mediaPool: new MediaPool(), audioContext: context });
    player.play();
    // Read at once: the autoplay policy accepts the resume only in the click's
    // own task. The old code resumed after an await, which was too late.
    expect(context.resumes).toBeGreaterThanOrEqual(1);
    player.destroy();
  });

  it('plays silently without an audio context', () => {
    const player = new PreviewPlayer({ canvas: new Surface(), session: makeSession(), mediaPool: new MediaPool(), audioContext: null });
    expect(() => player.play()).not.toThrow();
    player.destroy();
  });
});

describe('the preview level reaches the master bus', () => {
  it('setOutputVolume sets the master gain and clamps to 0..1', () => {
    const context = new Context();
    const player = new PreviewPlayer({ canvas: new Surface(), session: makeSession(), mediaPool: new MediaPool(), audioContext: context });
    const master = context.gains[0]!;
    player.setOutputVolume(0.25);
    expect(master.gain.value).toBeCloseTo(0.25, 6);
    player.setOutputVolume(7);
    expect(master.gain.value).toBe(1);
    player.setOutputVolume(Number.NaN);
    expect(master.gain.value).toBe(0);
    player.destroy();
  });
});

describe('lane mute and solo reach the audio graph', () => {
  it('a muted lane gets gain 0 after syncTrackStates, and unmute restores it', () => {
    const session = makeSession();
    const context = new Context();
    const player = new PreviewPlayer({ canvas: new Surface(), session, mediaPool: new MediaPool(), audioContext: context });
    const lane = currentTimeline(session.document).tracks[0]!;
    expect(context.gains.filter((gain) => gain.gain.value === 0)).toHaveLength(0);
    session.run(new SetTrackPropertyOperation(lane.id, 'muted', false, true));
    player.syncTrackStates();
    expect(context.gains.filter((gain) => gain.gain.value === 0)).toHaveLength(1);
    session.run(new SetTrackPropertyOperation(lane.id, 'muted', true, false));
    player.syncTrackStates();
    expect(context.gains.filter((gain) => gain.gain.value === 0)).toHaveLength(0);
    player.destroy();
  });

  it('solo silences every other lane', () => {
    const session = makeSession();
    const context = new Context();
    const player = new PreviewPlayer({ canvas: new Surface(), session, mediaPool: new MediaPool(), audioContext: context });
    const soloed = currentTimeline(session.document).tracks[0]!;
    const added = session.addTrack('video', 1);
    expect(added).not.toBeNull();
    const laneCount = currentTimeline(session.document).tracks.length;
    expect(laneCount).toBeGreaterThanOrEqual(2);
    session.run(new SetTrackPropertyOperation(soloed.id, 'solo', false, true));
    player.syncTrackStates();
    // Every lane except the soloed one is silenced.
    expect(context.gains.filter((gain) => gain.gain.value === 0)).toHaveLength(laneCount - 1);
    player.destroy();
  });
});

describe('the playhead split is one undo step', () => {
  it('cuts the clip under the playhead and one undo restores the original', () => {
    const session = makeSession();
    const before = currentTimeline(session.document).clips.length;
    expect(session.splitClipsAt(1.5)).toBe(1);
    expect(currentTimeline(session.document).clips.length).toBe(before + 1);
    session.undo();
    expect(currentTimeline(session.document).clips.length).toBe(before);
  });

  it('two lanes under the playhead are cut together and one undo restores both', () => {
    const session = makeSession();
    // A second clip on an audio lane, under the same instant.
    session.addMediaItem({
      id: 'm2',
      path: 'media/m2',
      name: 'voice',
      duration: 4,
      kind: 'audio',
      width: 0,
      height: 0,
      frameRate: 30,
      frameRateFraction: '30/1',
      videoCodec: null,
      audioCodec: 'aac',
      hasAudio: true,
      audioTracks: [],
      slot: false,
      origin: null,
      colorRange: null,
      colorSpace: 'sdr',
      extra: {},
    });
    session.addClipAt('m2', Rational.ZERO);
    session.history.rebase(session.document);
    expect(currentTimeline(session.document).clips.length).toBe(2);
    expect(session.splitClipsAt(1.5)).toBe(2);
    expect(currentTimeline(session.document).clips.length).toBe(4);
    session.undo();
    expect(currentTimeline(session.document).clips.length).toBe(2);
  });

  it('a cut outside every clip is a no-op with no history entry', () => {
    const session = makeSession();
    expect(session.history.canUndo()).toBe(false);
    expect(session.splitClipsAt(10)).toBe(0);
    expect(session.history.canUndo()).toBe(false);
    expect(currentTimeline(session.document).clips.length).toBe(1);
  });

  it('a cut within one frame of an edge is refused', () => {
    const session = makeSession();
    expect(session.splitClipsAt(0.01)).toBe(0);
    expect(session.splitClipsAt(3.99)).toBe(0);
    expect(currentTimeline(session.document).clips.length).toBe(1);
  });

  it('a selection that excludes the clip cuts nothing', () => {
    const session = makeSession();
    expect(session.splitClipsAt(1.5, ['not-a-clip'])).toBe(0);
    expect(currentTimeline(session.document).clips.length).toBe(1);
  });
});

/** Fires a keydown on the target the way the browser does. */
function press(init: KeyboardEventInit, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

/** Action table that counts each call by name. */
function countingActions(): { actions: ShortcutActions; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const count = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };
  const actions: ShortcutActions = {
    setTool: (): void => count('setTool'),
    toggleSnapping: (): void => count('toggleSnapping'),
    togglePlayback: (): void => count('togglePlayback'),
    goHome: (): void => count('goHome'),
    goEnd: (): void => count('goEnd'),
    stepBackward: (): void => count('stepBackward'),
    stepForward: (): void => count('stepForward'),
    splitAtPlayhead: (): void => count('splitAtPlayhead'),
    deleteSelection: (): void => count('deleteSelection'),
    rippleDeleteSelection: (): void => count('rippleDeleteSelection'),
    duplicateSelection: (): void => count('duplicateSelection'),
    selectAll: (): void => count('selectAll'),
    selectNone: (): void => count('selectNone'),
    groupSelection: (): void => count('groupSelection'),
    ungroupSelection: (): void => count('ungroupSelection'),
    linkSelection: (): void => count('linkSelection'),
    unlinkSelection: (): void => count('unlinkSelection'),
    copy: (): void => count('copy'),
    cut: (): void => count('cut'),
    paste: (): void => count('paste'),
    undo: (): void => count('undo'),
    redo: (): void => count('redo'),
    addMarker: (): void => count('addMarker'),
    zoomIn: (): void => count('zoomIn'),
    zoomOut: (): void => count('zoomOut'),
    zoomFit: (): void => count('zoomFit'),
    toggleEnabled: (): void => count('toggleEnabled'),
    saveProject: (): void => count('saveProject'),
  };
  return { actions, calls };
}

describe('transport and edit keys fire exactly once', () => {
  it('Space toggles playback once per press', () => {
    const { actions, calls } = countingActions();
    const keys = installKeyboardShortcuts(actions);
    press({ key: ' ' });
    expect(calls.get('togglePlayback')).toBe(1);
    keys.dispose();
  });

  it('Ctrl+K splits once and Ctrl+Z undoes once', () => {
    const { actions, calls } = countingActions();
    const keys = installKeyboardShortcuts(actions);
    press({ key: 'k', ctrlKey: true });
    press({ key: 'z', ctrlKey: true });
    expect(calls.get('splitAtPlayhead')).toBe(1);
    expect(calls.get('undo')).toBe(1);
    keys.dispose();
  });

  it('keys do not fire while typing in a field', () => {
    const { actions, calls } = countingActions();
    const keys = installKeyboardShortcuts(actions);
    const input = document.createElement('input');
    document.body.appendChild(input);
    press({ key: ' ' }, input);
    expect(calls.get('togglePlayback')).toBeUndefined();
    input.remove();
    keys.dispose();
  });

  it('keys do not fire while a dialog is open', () => {
    const { actions, calls } = countingActions();
    const keys = installKeyboardShortcuts(actions);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    document.body.appendChild(backdrop);
    press({ key: ' ' });
    expect(calls.get('togglePlayback')).toBeUndefined();
    backdrop.remove();
    keys.dispose();
  });

  it('dispose removes the listener', () => {
    const { actions, calls } = countingActions();
    const keys = installKeyboardShortcuts(actions);
    keys.dispose();
    press({ key: ' ' });
    expect(calls.get('togglePlayback')).toBeUndefined();
  });
});

/** A context that records the order of background fills and picture draws. */
class OrderedContext extends FakeContext {
  readonly ops: string[] = [];
  override fillRect(): void {
    this.ops.push('fill');
  }
  override drawImage(): void {
    this.ops.push('draw');
  }
}

describe('the background is painted only once every frame has arrived', () => {
  it('no fill happens before the frame decode resolves (no black flash)', async () => {
    const session = makeSession();
    const context = new OrderedContext();
    const surface: RenderTarget = { width: 320, height: 180, getContext: () => context };
    const pool: FramePool = {
      getFrame: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        context.ops.push('frame');
        return document.createElement('canvas');
      },
      getSize: () => ({ width: 320, height: 180 }),
    };
    await renderFrame(session.engine, Rational.ZERO, surface, pool);
    const firstFill = context.ops.indexOf('fill');
    const frameAt = context.ops.indexOf('frame');
    expect(frameAt).toBeGreaterThanOrEqual(0);
    expect(firstFill).toBeGreaterThan(frameAt);
    expect(context.ops.filter((op) => op === 'draw')).toHaveLength(1);
  });
});
