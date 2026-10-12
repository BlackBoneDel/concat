// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import { Animation, Ease, Key, KeyTrack } from '../src/core/animate.ts';
import { Rational } from '../src/core/rational.ts';
import { FrameRate } from '../src/core/time.ts';
import {
  Blend,
  Clip,
  MediaRef,
  Timeline,
  Track,
  TrackKind,
  Transform,
} from '../src/core/timeline.ts';

const seconds = (value: bigint) => Rational.fromInt(value);

function fixture() {
  const timeline = Timeline.hd();
  const track = timeline.addTrack(new Track('V1', TrackKind.Video));
  const clip = timeline.addClip(
    track,
    new Clip(new MediaRef('a.mp4'), seconds(2n), seconds(3n)),
  );
  return { timeline, track, clip: clip! };
}

describe('Clip', () => {
  it('maps timeline time to source time — the Rust test, ported', () => {
    const { timeline, clip: clipId } = fixture();
    const clip = timeline.clip(clipId)!;
    expect(clip.sourceTimeAt(seconds(2n))!.equals(seconds(0n))).toBe(true);
    // Halfway into the clip at 3.5 s is 1.5 s into the source.
    expect(clip.sourceTimeAt(Rational.new(7n, 2n))!.equals(Rational.new(3n, 2n))).toBe(true);
    // Off screen: no source time.
    expect(clip.sourceTimeAt(seconds(1n))).toBeNull();
    expect(clip.sourceTimeAt(seconds(5n))).toBeNull();
  });

  it('speed is the only definition of retiming', () => {
    const clip = new Clip(new MediaRef('a.mp4'), seconds(0n), seconds(2n), {
      speed: Rational.fromInt(2n),
    });
    // Two timeline seconds at double speed consume four source seconds.
    expect(clip.sourceDuration().equals(seconds(4n))).toBe(true);
    expect(clip.sourceTimeAt(Rational.new(1n, 1n))!.equals(Rational.new(2n, 1n))).toBe(true);
    expect(clip.isPaced()).toBe(true);
  });

  it('a hold maps every instant to one source frame', () => {
    const clip = new Clip(new MediaRef('a.mp4'), seconds(0n), seconds(3n), {
      sourceStart: Rational.new(5n, 2n),
      hold: true,
    });
    expect(clip.sourceTimeAt(seconds(1n))!.equals(Rational.new(5n, 2n))).toBe(true);
    expect(clip.sourceTimeAt(seconds(2n))!.equals(Rational.new(5n, 2n))).toBe(true);
    expect(clip.isPaced()).toBe(false);
  });

  it('fades ramp opacity in and out and multiply the clip opacity', () => {
    const clip = new Clip(new MediaRef('a.mp4'), seconds(0n), seconds(4n), {
      opacity: 0.5,
      videoFadeIn: Rational.ONE,
      videoFadeOut: Rational.ONE,
    });
    expect(clip.videoFadeFactor(Rational.ZERO)).toBeCloseTo(0, 12);
    expect(clip.videoFadeFactor(Rational.new(1n, 2n))).toBeCloseTo(0.5, 12);
    expect(clip.videoFadeFactor(Rational.new(3n, 2n))).toBe(1);
    expect(clip.videoFadeFactor(Rational.new(7n, 2n))).toBeCloseTo(0.5, 12);
    expect(clip.videoFadeFactor(Rational.fromInt(4n))).toBe(0);
  });

  it('fractionAt is 0..=1 inside the clip and zero outside', () => {
    const { timeline, clip: clipId } = fixture();
    const clip = timeline.clip(clipId)!;
    expect(clip.fractionAt(seconds(2n))).toBe(0);
    expect(clip.fractionAt(Rational.new(7n, 2n))).toBeCloseTo(0.5, 12);
    expect(clip.fractionAt(seconds(5n))).toBe(1);
    expect(clip.fractionAt(seconds(0n))).toBe(0);
  });

  it('an animation moves the transform and the opacity at a fraction', () => {
    const ride = new KeyTrack([new Key(0, 1, Ease.LINEAR), new Key(1, 3, Ease.LINEAR)]);
    const clip = new Clip(new MediaRef('a.mp4'), seconds(0n), seconds(2n), {
      transform: new Transform(2, 0, 0, 0, 1, 1),
      animation: new Animation(ride),
    });
    // At the clip's end the scale factor is 3: 2 * 3 over the base placement.
    expect(clip.transformAt(seconds(2n)).scale).toBeCloseTo(6, 12);
    expect(clip.transformAt(seconds(0n)).scale).toBeCloseTo(2, 12);
  });
});

describe('Blend', () => {
  it('names and parses every mode, falling back to normal', () => {
    for (const mode of Blend.ALL) {
      expect(Blend.parse(mode)).toBe(mode);
    }
    expect(Blend.parse('nonsense')).toBe('normal');
    expect(Blend.parse(' multiply ')).toBe('multiply');
  });
});

describe('Timeline', () => {
  it('composites tracks bottom-first and finds the clip under the playhead', () => {
    const { timeline, track, clip: clipId } = fixture();
    const onTop = timeline.addTrack(new Track('V2', TrackKind.Video));
    expect(timeline.trackIds()[0]!.equals(track)).toBe(true);
    expect(timeline.trackIds()[1]!.equals(onTop)).toBe(true);

    expect(timeline.clipOnTrackAt(track, seconds(3n))!.equals(clipId)).toBe(true);
    expect(timeline.clipOnTrackAt(track, seconds(1n))).toBeUndefined();
  });

  it('removing a track takes its clips with it', () => {
    const { timeline, track, clip: clipId } = fixture();
    expect(timeline.clipCount()).toBe(1);
    timeline.removeTrack(track);
    expect(timeline.clipCount()).toBe(0);
    expect(timeline.clip(clipId)).toBeUndefined();
  });

  it('removing a clip leaves the lane clean', () => {
    const { timeline, track, clip: clipId } = fixture();
    timeline.removeClip(clipId);
    expect(timeline.clipCount()).toBe(0);
    expect([...timeline.track(track)!.clips()]).toHaveLength(0);
  });

  it('refuses a clip on a stale track handle without leaking it', () => {
    const timeline = Timeline.hd();
    const track = timeline.addTrack(new Track('V1', TrackKind.Video));
    timeline.removeTrack(track);
    const id = timeline.addClip(track, new Clip(new MediaRef('a.mp4'), seconds(0n), seconds(1n)));
    expect(id).toBeUndefined();
    expect(timeline.clipCount()).toBe(0);
  });

  it('duration runs to the last clip and frames count in the output rate', () => {
    const timeline = Timeline.hd();
    const track = timeline.addTrack(new Track('V1', TrackKind.Video));
    timeline.addClip(track, new Clip(new MediaRef('a.mp4'), seconds(0n), seconds(2n)));
    timeline.addClip(track, new Clip(new MediaRef('b.mp4'), seconds(10n), seconds(2n)));
    expect(timeline.duration().equals(seconds(12n))).toBe(true);
    expect(timeline.frameCount()).toBe(360n); // 12 s at 30 fps
  });

  it('the last-added clip wins where lanes overlap, matching a paste', () => {
    const timeline = Timeline.hd();
    const track = timeline.addTrack(new Track('V1', TrackKind.Video));
    const first = timeline.addClip(track, new Clip(new MediaRef('a.mp4'), seconds(0n), seconds(4n)))!;
    const second = timeline.addClip(track, new Clip(new MediaRef('b.mp4'), seconds(2n), seconds(4n)))!;
    expect(timeline.clipOnTrackAt(track, seconds(3n))!.equals(second)).toBe(true);
    expect(timeline.clipOnTrackAt(track, seconds(1n))!.equals(first)).toBe(true);
  });
});

// -- Fase 7+: captura de drops de archivos en el timeline ------------------

import { vi } from 'vitest';
import {
  dragHasFiles,
  installDropGuard,
  installFileDrop,
  type DragEventLike,
  type DropTargetLike,
} from '../src/ui/timeline/file-drop.ts';

/** A drop-target double that records listeners, classes and events. */
function fakeDropTarget() {
  const listeners = new Map<string, ((event: DragEventLike) => void)[]>();
  const classes = new Set<string>();
  const target: DropTargetLike = {
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
    },
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
    },
  };
  const fire = (type: string, event: DragEventLike): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return { target, listeners, classes, fire };
}

function dragEvent(init: { files?: File[]; types?: string[]; clientX?: number; clientY?: number } = {}): DragEventLike & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
} {
  return {
    dataTransfer: { files: init.files ?? [], types: init.types ?? ['Files'], dropEffect: '' },
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe('installFileDrop (timeline)', () => {
  it('dragover con archivos previene el default y ofrece copy', () => {
    const { target, fire } = fakeDropTarget();
    installFileDrop(target, { onFiles: () => undefined });
    const event = dragEvent();
    fire('dragover', event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer!.dropEffect).toBe('copy');
  });

  it('dragenter/dragleave equilibran la clase de hover', () => {
    const { target, classes, fire } = fakeDropTarget();
    installFileDrop(target, { onFiles: () => undefined });
    fire('dragenter', dragEvent());
    fire('dragenter', dragEvent()); // nested element
    expect(classes.has('drag-over')).toBe(true);
    fire('dragleave', dragEvent());
    expect(classes.has('drag-over')).toBe(true); // still inside
    fire('dragleave', dragEvent());
    expect(classes.has('drag-over')).toBe(false);
  });

  it('drop entrega los archivos y el punto relativo al panel', () => {
    const { target, classes, fire } = fakeDropTarget();
    const dropped: { files: File[]; point: { x: number; y: number } }[] = [];
    installFileDrop(target, { onFiles: (files, point) => dropped.push({ files, point }) });
    fire('dragenter', dragEvent());
    const file = new File(['video'], 'obs-recording.webm');
    const event = dragEvent({ files: [file], clientX: 250, clientY: 130 });
    fire('drop', event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.files).toEqual([file]);
    // rect left/top = 100/50 → the point is local to the panel.
    expect(dropped[0]!.point).toEqual({ x: 150, y: 80 });
    expect(classes.has('drag-over')).toBe(false);
  });

  it('ignora los drags internos (sin tipo Files)', () => {
    const { target, fire } = fakeDropTarget();
    const onFiles = vi.fn();
    installFileDrop(target, { onFiles });
    const over = dragEvent({ types: ['text/plain'] });
    fire('dragover', over);
    fire('drop', dragEvent({ types: ['text/plain'], files: [new File(['x'], 'x.mp4')] }));
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(onFiles).not.toHaveBeenCalled();
    expect(dragHasFiles(dragEvent({ types: [] }))).toBe(false);
  });

  it('dispose retira todos los listeners', () => {
    const { target, listeners, fire } = fakeDropTarget();
    const onFiles = vi.fn();
    const handle = installFileDrop(target, { onFiles });
    expect(listeners.get('drop')).toHaveLength(1);
    handle.dispose();
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      expect(listeners.get(type)).toHaveLength(0);
    }
    fire('drop', dragEvent({ files: [new File(['x'], 'x.mp4')] }));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('installDropGuard bloquea la navegación solo para drags de archivos', () => {
    const listeners = new Map<string, ((event: DragEventLike) => void)[]>();
    const guard = installDropGuard({
      addEventListener: (type, listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      removeEventListener: (type, listener) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
      },
    });
    const fire = (type: string, event: DragEventLike): void => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    const fileDrop = dragEvent();
    fire('drop', fileDrop);
    expect(fileDrop.preventDefault).toHaveBeenCalled(); // no navigation
    const internal = dragEvent({ types: ['text/plain'] });
    fire('dragover', internal);
    expect(internal.preventDefault).not.toHaveBeenCalled();
    guard.dispose();
    const after = dragEvent();
    fire('drop', after);
    expect(after.preventDefault).not.toHaveBeenCalled();
  });
});
