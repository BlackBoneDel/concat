// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5: keyframe lane geometry, ◆ drag with playhead snapping, segment bending. */

import { describe, expect, it } from 'vitest';
import { AddKeyframeOperation, keyframeId } from '../src/editor/operations.ts';
import { BEZIER_PRESETS } from '../src/editor/keyframe-operations.ts';
import type { EditSession } from '../src/session/edit-session.ts';
import {
  KEYFRAME_LANE_HEIGHT,
  LANE_PADDING,
  atToLaneX,
  hitKeyframe,
  keyframeNodes,
  laneYToPercent,
  segmentAt,
  valueToLaneY,
  type LaneRect,
} from '../src/ui/timeline/keyframe-node.ts';
import {
  KeyframeSelectionStore,
  defaultLaneProperty,
  hitKeyframeLane,
  lanePropertiesFor,
  laneRectFor,
  nextLaneProperty,
  sampleLaneCurve,
  withPreview,
} from '../src/ui/timeline/keyframe-track.ts';
import { KEYFRAME_SNAP_PX, KeyframeDrag, snapToPlayhead } from '../src/ui/interactions/keyframe-drag.ts';
import { CurveDrag, bendOfCurve, curveFromBend } from '../src/ui/interactions/curve-drag.ts';
import { clipById, r } from './f3-helpers.ts';
import { makeF5Session } from './f5-helpers.ts';

const LANE: LaneRect = { x: 0, y: 0, w: 200, h: 64 };

/** c1 (video, 0–2 s) with opacity keys at 0.5 s (0.2) and 1.5 s (0.8). */
function keyedSession(): EditSession {
  const session = makeF5Session();
  expect(session.run(new AddKeyframeOperation('c1', 'opacity', r(0.5), 0.2))).toBe(true);
  expect(session.run(new AddKeyframeOperation('c1', 'opacity', r(1.5), 0.8))).toBe(true);
  return session;
}

describe('keyframe-node geometry', () => {
  it('maps values to lane y (100 % on top) and back', () => {
    expect(valueToLaneY('opacity', 1, LANE)).toBeCloseTo(LANE_PADDING);
    expect(valueToLaneY('opacity', 0, LANE)).toBeCloseTo(LANE.h - LANE_PADDING);
    expect(laneYToPercent(valueToLaneY('opacity', 0.25, LANE), LANE)).toBeCloseTo(25);
    expect(laneYToPercent(-50, LANE)).toBe(100);
    expect(laneYToPercent(500, LANE)).toBe(0);
    expect(atToLaneX(0.5, { ...LANE, x: 10 })).toBe(110);
  });

  it('builds sorted nodes, hits diamonds and finds segments', () => {
    const clip = clipById(keyedSession(), 'c1');
    const nodes = keyframeNodes(clip, 'opacity', LANE);
    expect(nodes.map((node) => node.x)).toEqual([50, 150]);
    expect(nodes[0]!.id).toBe(keyframeId('opacity', 0.25));
    expect(hitKeyframe(nodes, 51, nodes[0]!.y + 1)?.id).toBe(nodes[0]!.id);
    expect(hitKeyframe(nodes, 100, 0)).toBeNull();
    expect(segmentAt(nodes, 100)?.to.id).toBe(nodes[1]!.id);
    expect(segmentAt(nodes, 20)).toBeNull();
    expect(keyframeNodes(clip, 'scale', LANE)).toEqual([]);
  });
});

describe('keyframe-track helpers', () => {
  it('offers properties by clip kind and cycles through them', () => {
    const session = keyedSession();
    expect(lanePropertiesFor(clipById(session, 'c2'))).toEqual(['volume']);
    expect(lanePropertiesFor(clipById(session, 'c3'))).not.toContain('volume');
    expect(defaultLaneProperty(clipById(session, 'c1'))).toBe('opacity');
    expect(nextLaneProperty(clipById(session, 'c1'), 'opacity')).toBe('scale');
    expect(nextLaneProperty(clipById(session, 'c2'), 'volume')).toBe('volume');
  });

  it('applies a gesture ghost without touching the document', () => {
    const clip = clipById(keyedSession(), 'c1');
    const id = keyframeId('opacity', 0.75);
    const ghost = withPreview(clip, { clipId: 'c1', property: 'opacity', keyframeId: id, value: 0.1, curve: BEZIER_PRESETS.easeIn });
    const moved = ghost.keys.find((key) => key.at === 0.75)!;
    expect(moved.value).toBe(0.1);
    expect([...moved.ease.points]).toEqual([...BEZIER_PRESETS.easeIn]);
    expect(clip.keys.find((key) => key.at === 0.75)!.value).toBe(0.8);
    expect(withPreview(clip, null)).toBe(clip);
    expect(withPreview(clip, { clipId: 'other', property: 'opacity', keyframeId: id })).toBe(clip);
  });

  it('samples the interpolated curve through core/animate', () => {
    const clip = clipById(keyedSession(), 'c1');
    const points = sampleLaneCurve(clip, 'opacity', LANE, 10);
    expect(points[0]![1]).toBeCloseTo(valueToLaneY('opacity', 0.2, LANE));
    expect(points[points.length - 1]![1]).toBeCloseTo(valueToLaneY('opacity', 0.8, LANE));
    const mid = points.find(([x]) => x === 100)!;
    expect(mid[1]).toBeCloseTo(valueToLaneY('opacity', 0.5, LANE));
  });

  it('hit-tests expanded lanes only', () => {
    const session = keyedSession();
    const clips = session.document.timelines[0]!.clips;
    const c1 = clipById(session, 'c1');
    const layouts = [{ trackId: c1.trackId, y: 0, height: 96 + KEYFRAME_LANE_HEIGHT, collapsed: false, keyframeLane: KEYFRAME_LANE_HEIGHT }];
    const viewport = { pixelsPerSecond: 100, scrollTime: 0, scrollTop: 0, width: 800, height: 400 };
    const lane = laneRectFor(0, 200, layouts[0]!, viewport);
    expect(lane.y).toBe(96);
    const state = { expanded: new Set(['c1']), property: () => 'opacity' as const };
    const node = keyframeNodes(c1, 'opacity', lane)[0]!;
    const hit = hitKeyframeLane(clips, layouts, viewport, state, node.x, node.y);
    expect(hit?.node?.id).toBe(node.id);
    const segment = hitKeyframeLane(clips, layouts, viewport, state, 100, lane.y + lane.h - 3);
    expect(segment?.segment?.to.at).toBe(0.75);
    expect(hitKeyframeLane(clips, layouts, viewport, { ...state, expanded: new Set<string>() }, node.x, node.y)).toBeNull();
    expect(hitKeyframeLane(clips, layouts, viewport, state, node.x, 10)).toBeNull();
  });

  it('notifies keyframe selection changes once', () => {
    const store = new KeyframeSelectionStore();
    const seen: (string | null)[] = [];
    const off = store.subscribe((ref) => seen.push(ref?.keyframeId ?? null));
    store.set({ clipId: 'c1', property: 'opacity', keyframeId: 'k' });
    store.set({ clipId: 'c1', property: 'opacity', keyframeId: 'k' });
    store.set(null);
    off();
    store.set({ clipId: 'c1', property: 'opacity', keyframeId: 'z' });
    expect(seen).toEqual(['k', null]);
  });
});

describe('keyframe drag', () => {
  it('snaps to the playhead within the magnet distance', () => {
    expect(snapToPlayhead(1.0, 1.05, 100)).toEqual({ seconds: 1.05, snapped: true });
    expect(snapToPlayhead(1.0, 1.0 + (KEYFRAME_SNAP_PX + 1) / 100, 100).snapped).toBe(false);
  });

  it('moves a ◆ in time (Rational, snapped) and value (0–100 %) as one undo step', () => {
    const session = keyedSession();
    const clip = clipById(session, 'c1');
    const drag = new KeyframeDrag();
    const id = keyframeId('opacity', 0.25);
    expect(drag.begin({ clip, property: 'opacity', keyframeId: id, lane: LANE, pointerX: 50, pointerY: valueToLaneY('opacity', 0.2, LANE) })).toBe(true);
    expect(drag.update(51, valueToLaneY('opacity', 0.2, LANE), { playheadSeconds: 0, pixelsPerSecond: 100, snap: true })).toBeNull();
    const target = drag.update(100, LANE_PADDING, { playheadSeconds: 1.05, pixelsPerSecond: 100, snap: true })!;
    expect(target.snapped).toBe(true);
    expect(target.time.asNumber()).toBeCloseTo(1.05);
    expect(target.value).toBeCloseTo(1);
    expect(drag.preview()).toMatchObject({ clipId: 'c1', keyframeId: id, snapped: true });
    const result = drag.commit()!;
    expect(drag.active).toBe(false);
    expect(session.run(result.op!)).toBe(true);
    const key = clipById(session, 'c1').keys.find((item) => keyframeId(item.property, item.at) === result.keyframeId)!;
    expect(key.at).toBeCloseTo(0.525);
    expect(key.value).toBeCloseTo(1);
    session.undo();
    expect(clipById(session, 'c1').keys.find((item) => item.at === 0.25)?.value).toBeCloseTo(0.2);
  });

  it('locks the axis with Shift, ignores snapping when disabled and never stacks keys', () => {
    const session = keyedSession();
    const clip = clipById(session, 'c1');
    const drag = new KeyframeDrag();
    const startY = valueToLaneY('opacity', 0.2, LANE);
    drag.begin({ clip, property: 'opacity', keyframeId: keyframeId('opacity', 0.25), lane: LANE, pointerX: 50, pointerY: startY });
    const horizontal = drag.update(90, startY + 4, { playheadSeconds: 0.9, pixelsPerSecond: 100, snap: false, lockAxis: true })!;
    expect(horizontal.snapped).toBe(false);
    expect(horizontal.at).toBeCloseTo(0.45);
    expect(horizontal.value).toBeCloseTo(0.2);
    const vertical = drag.update(52, startY - 30, { playheadSeconds: 0, pixelsPerSecond: 100, snap: false, lockAxis: true })!;
    expect(vertical.at).toBeCloseTo(0.25);
    const collide = drag.update(150, startY, { playheadSeconds: 0, pixelsPerSecond: 100, snap: false })!;
    expect(collide.at).toBeCloseTo(0.25);
    drag.cancel();
    expect(drag.commit()).toBeNull();
  });

  it('treats a press without travel as a click', () => {
    const clip = clipById(keyedSession(), 'c1');
    const drag = new KeyframeDrag();
    const id = keyframeId('opacity', 0.75);
    expect(drag.begin({ clip, property: 'opacity', keyframeId: 'nope', lane: LANE, pointerX: 0, pointerY: 0 })).toBe(false);
    drag.begin({ clip, property: 'opacity', keyframeId: id, lane: LANE, pointerX: 150, pointerY: 20 });
    expect(drag.commit()).toEqual({ op: null, keyframeId: id });
  });
});

describe('curve drag', () => {
  it('bend ↔ curve are exact inverses and stay valid timing functions', () => {
    for (const bend of [-1, -0.5, 0, 0.3, 1]) {
      const curve = curveFromBend(bend);
      expect(curve[0]).toBeGreaterThanOrEqual(0);
      expect(curve[2]).toBeLessThanOrEqual(1);
      expect(bendOfCurve(curve)).toBeCloseTo(bend);
    }
    expect(curveFromBend(0).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.333, 0.333, 0.667, 0.667]);
    expect(bendOfCurve(curveFromBend(Number.NaN))).toBe(0);
    expect(bendOfCurve(curveFromBend(9))).toBe(1);
  });

  it('bends a segment and commits UpdateKeyframeCurve', () => {
    const session = keyedSession();
    const clip = clipById(session, 'c1');
    const nodes = keyframeNodes(clip, 'opacity', LANE);
    const drag = new CurveDrag();
    drag.begin('c1', 'opacity', nodes[0]!, nodes[1]!, LANE, 40);
    expect(drag.active).toBe(true);
    const curve = drag.update(20)!;
    expect(bendOfCurve(curve)).toBeGreaterThan(0);
    expect(drag.preview()?.keyframeId).toBe(nodes[1]!.id);
    const op = drag.commit()!;
    expect(session.run(op)).toBe(true);
    const key = clipById(session, 'c1').keys.find((item) => item.at === 0.75)!;
    expect([...key.ease.points]).toEqual([...curve]);
    // No travel → nothing to commit.
    drag.begin('c1', 'opacity', nodes[0]!, nodes[1]!, LANE, 40);
    expect(drag.commit()).toBeNull();
  });
});
