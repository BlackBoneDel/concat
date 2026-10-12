// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 1 boot screen.
 *
 * Builds a project with the core model, edits it the way the engine would,
 * round-trips it through the `concat.json` document schema, and reports what
 * happened. This is the model proving itself in the browser — the editor
 * canvas, timeline and media pipeline arrive with Fases 2–6.
 */

import {
  Blend,
  Clip,
  FrameRate,
  MediaRef,
  Project,
  Rational,
  SpeedCurve,
  Timeline,
  Track,
  TrackKind,
} from './core/index.ts';
import {
  createProjectDocument,
  documentSettingsVideo,
  fromDocument,
  toDocument,
  blankClip,
  type DocumentSettings,
} from './model/index.ts';

/** Builds a small three-clip timeline through the engine model. */
function buildEngineProject(): Project {
  const timeline = new Timeline(1920, 1080, FrameRate.THIRTY);
  const videoLane = timeline.addTrack(new Track('V1', TrackKind.Video));
  const audioLane = timeline.addTrack(new Track('A1', TrackKind.Audio));

  // 0s..3s of footage, then a two-second overlap with a fade — the shape a
  // cross-dissolve takes in the engine model.
  const intro = new Clip(new MediaRef('footage/intro.mp4'), Rational.fromInt(0n), Rational.fromInt(3n));
  const bRoll = new Clip(new MediaRef('footage/broll.mp4'), Rational.fromInt(2n), Rational.fromInt(3n), {
    videoFadeIn: Rational.new(1n, 2n),
    blend: Blend.Normal,
    opacity: 1,
  });
  const music = new Clip(new MediaRef('audio/theme.mp3'), Rational.fromInt(0n), Rational.fromInt(6n), {
    sourceStart: Rational.new(10n, 1n),
    speed: Rational.ONE,
    retime: SpeedCurve.new([
      [0, 1],
      [1, 1],
    ]),
    hold: false,
  });

  timeline.addClip(videoLane, intro);
  timeline.addClip(videoLane, bRoll);
  timeline.addClip(audioLane, music);
  return new Project('Fase 1 demo', timeline);
}

/** Puts the same edit through the document schema and reads it back. */
function roundTripDocument(): { json: unknown; reopened: ReturnType<typeof fromDocument> } {
  const settings: DocumentSettings = {
    name: 'Fase 1 demo',
    width: 1920,
    height: 1080,
    rateNum: 30,
    rateDen: 1,
  };
  const project = createProjectDocument(documentSettingsVideo(settings));
  const timeline = project.timelines[0]!;
  timeline.clips.push(
    { ...blankClip('c1', 'T1', 'video', 'intro', 0, 3), mediaId: 'm1' },
    { ...blankClip('c2', 'T1', 'video', 'broll', 2, 3), mediaId: 'm2', fadeIn: 0.5 },
  );
  project.media.push({
    id: 'm1',
    path: 'footage/intro.mp4',
    name: 'intro.mp4',
    duration: 12,
    kind: 'video',
    width: 1920,
    height: 1080,
    frameRate: 30,
    frameRateFraction: '30/1',
    videoCodec: 'h264',
    audioCodec: 'aac',
    hasAudio: true,
    audioTracks: [],
    slot: false,
    origin: null,
    colorRange: null,
    colorSpace: 'sdr',
    extra: {},
  });
  project.media.push({
    id: 'm2',
    path: 'footage/broll.mp4',
    name: 'broll.mp4',
    duration: 9,
    kind: 'video',
    width: 1920,
    height: 1080,
    frameRate: 30,
    frameRateFraction: '30/1',
    videoCodec: 'h264',
    audioCodec: null,
    hasAudio: false,
    audioTracks: [],
    slot: false,
    origin: null,
    colorRange: null,
    colorSpace: 'sdr',
    extra: {},
  });

  const json = toDocument(settings, project);
  return { json, reopened: fromDocument(json) };
}

/** Renders the report into the page. */
function report(): string {
  const lines: string[] = [];

  const project = buildEngineProject();
  const { timeline } = project;
  const duration = timeline.duration();
  const seconds = duration.asNumber();

  lines.push(`project        ${project.name}`);
  lines.push(`frame          ${timeline.width}x${timeline.height} @ ${timeline.frame_rate.toString()}`);
  lines.push(`tracks         ${timeline.trackIds().length}`);
  lines.push(`clips          ${timeline.clipCount()}`);
  lines.push(`duration       ${duration.toString()} s (${seconds.toFixed(3)})`);
  lines.push(`frames         ${timeline.frameCount()}`);

  // The affine map every trim and retime agrees on, proven at 1.5 s.
  const at = Rational.new(3n, 2n);
  const firstLane = timeline.trackIds()[0]!;
  const clipId = timeline.clipOnTrackAt(firstLane, at);
  const clip = clipId ? timeline.clip(clipId) : undefined;
  if (clip) {
    const source = clip.sourceTimeAt(at);
    lines.push(
      `source time    t=3/2 → ${source ? `${source.toString()} s in ${clip.media.path}` : 'none'}`,
    );
    lines.push(`fade factor    ${clip.videoFadeFactor(at).toFixed(3)}`);
  }

  const { json, reopened } = roundTripDocument();
  const text = JSON.stringify(json);
  lines.push('');
  lines.push(`document       concat.json written (${text.length} bytes)`);
  if (reopened) {
    const reopenedTimeline = reopened.timelines[0]!;
    const clipList = reopenedTimeline.clips.map((entry) => entry.id).join(', ');
    lines.push(`<span class="ok">reopen         ok</span> — ${reopened.media.length} media, clips: [${clipList}]`);
    lines.push(`<span class="dim">settle kept every clip whose track and media exist; numbers were tidied.</span>`);
  } else {
    lines.push('reopen         FAILED');
  }

  return lines.join('\n');
}

function boot(): void {
  // The model is importable outside a browser (tests, tooling); only the
  // report needs a DOM.
  if (typeof document === 'undefined') return;
  const body = document.getElementById('report-body');
  if (!body) return;
  try {
    body.innerHTML = report();
  } catch (error) {
    body.textContent = `Boot failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

boot();
