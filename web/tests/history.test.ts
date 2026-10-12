// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The undo/redo snapshot stack. */

import { describe, expect, it } from 'vitest';
import { History } from '../src/session/history.ts';
import {
  createProjectDocument,
  documentSettingsVideo,
  type DocumentSettings,
} from '../src/model/document.ts';

const settings: DocumentSettings = {
  name: 'Proyecto',
  width: 1920,
  height: 1080,
  rateNum: 30,
  rateDen: 1,
};

function fresh(): ReturnType<typeof createProjectDocument> {
  return createProjectDocument(documentSettingsVideo(settings));
}

describe('History', () => {
  it('starts empty', () => {
    const history = new History();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo(fresh(), settings)).toBeNull();
    expect(history.redo(fresh(), settings)).toBeNull();
  });

  it('undo restores the pushed state and redo re-applies', () => {
    const history = new History();
    const v1 = fresh();
    history.push(v1, settings); // state A about to change

    const v2 = fresh();
    v2.timelines[0]!.video.width = 1280;
    expect(history.canUndo).toBe(true);

    const restored = history.undo(v2, settings);
    expect(restored).not.toBeNull();
    expect(restored!.timelines[0]!.video.width).toBe(1920);

    const redone = history.redo(restored!, settings);
    expect(redone).not.toBeNull();
    expect(redone!.timelines[0]!.video.width).toBe(1280);
  });

  it('pushing clears the redo side', () => {
    const history = new History();
    history.push(fresh(), settings);
    const current = fresh();
    history.undo(current, settings);
    expect(history.canRedo).toBe(true);
    history.push(current, settings);
    expect(history.canRedo).toBe(false);
    expect(history.canUndo).toBe(true);
  });

  it('clear forgets both sides', () => {
    const history = new History();
    history.push(fresh(), settings);
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('round-trips clips through undo', () => {
    const history = new History();
    const v1 = fresh();
    // The settle pipeline keeps only clips whose media exists in the bin.
    v1.media.push({
      id: 'm1',
      path: 'media/m1',
      name: 'clip',
      duration: 3,
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
    const timeline = v1.timelines[0]!;
    timeline.clips.push({
      id: 'c1',
      trackId: timeline.tracks[0]!.id,
      mediaId: 'm1',
      name: 'clip',
      kind: 'video',
      start: 2,
      duration: 3,
      sourceStart: 0,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      stretchX: 1,
      stretchY: 1,
      opacity: 1,
      speed: 1,
      speedCurve: null,
      keys: [],
      flipH: false,
      flipV: false,
      blend: '',
      crop: null,
      cutout: null,
      preservePitch: true,
      filters: [],
      videoEffects: [],
      audioStream: null,
      muted: null,
      detachedFrom: null,
      transitionIn: null,
      enhanced: null,
      text: null,
      shape: null,
      extra: {},
    });
    history.push(v1, settings);

    const v2 = fresh(); // clip removed
    const restored = history.undo(v2, settings);
    expect(restored!.timelines[0]!.clips).toHaveLength(1);
    expect(restored!.timelines[0]!.clips[0]!.id).toBe('c1');
  });
});
