// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The preview player: clock, render loop and audio, in one place.
 *
 * The clock is an anchor pair — a wall time and the timeline instant it
 * stood at — so rounding never accumulates (the `Rational.approximate` seam
 * is crossed once per read, not once per frame). Every frame is composited by
 * `renderFrame`, every audible clip is scheduled through `AudioMixer` from
 * the engine's own `source_time_at` / `gain_at`, and a drift check re-syncs
 * the mix when picture and sound separate by more than 50 ms.
 */

import { Rational } from '../core/rational.ts';
import { renderFrame, type RenderTarget } from '../render/index.ts';
import { MISSING_MEDIA_COLORS } from '../render/compositor.ts';
import type { EditorSession } from '../session/editor-session.ts';
import { currentTimeline } from '../editor/operations.ts';
import type { MediaPool } from '../media/media-pool.ts';
import { AudioMixer, type AudioGraphContext, type BufferLike } from './audio-mixer.ts';

/** Player state reported to the UI. */
export type PlayerState = 'playing' | 'paused' | 'stopped';

/** Options for {@link PreviewPlayer.constructor}. */
export interface PreviewPlayerOptions {
  /** The surface to paint. */
  canvas: RenderTarget;
  /** The editing session (engine timeline + clip audio). */
  session: EditorSession;
  /** Where frames and audio come from. */
  mediaPool: MediaPool;
  /** Web Audio for the mix; `null` plays silent. */
  audioContext?: AudioGraphContext | null;
}

/** How often the audio drift check runs, in seconds. */
const DRIFT_CHECK_SECONDS = 5;
/** Picture and sound may separate by this much before a re-sync. */
const DRIFT_TOLERANCE_SECONDS = 0.05;

/** requestAnimationFrame with a node-safe fallback for tests. */
let fallbackHandle = 1;
const fallbackTimers = new Map<number, ReturnType<typeof setTimeout>>();
const raf: (callback: (timestamp: number) => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => {
        const handle = fallbackHandle++;
        fallbackTimers.set(
          handle,
          setTimeout(() => {
            fallbackTimers.delete(handle);
            callback(performance.now());
          }, 16),
        );
        return handle;
      };

const cancelRaf: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (handle) => cancelAnimationFrame(handle)
    : (handle) => {
        const timer = fallbackTimers.get(handle);
        if (timer !== undefined) {
          clearTimeout(timer);
          fallbackTimers.delete(handle);
        }
      };

/** The preview player over one session. */
export class PreviewPlayer {
  /** Fired after every rendered frame while playing or scrubbing. */
  onTimeUpdate: ((time: Rational) => void) | null = null;
  /** Fired when play/pause/stop changes the state. */
  onStateChanged: ((state: PlayerState) => void) | null = null;
  /**
   * Fase 7: fired once per failing media id (`mediaId` set) and for any
   * other render/audio failure (`mediaId` null). The loop never stops.
   */
  onRenderError: ((error: unknown, mediaId: string | null) => void) | null = null;

  private readonly canvas: RenderTarget;
  private readonly session: EditorSession;
  private readonly mediaPool: MediaPool;
  private readonly mixer: AudioMixer | null;
  private state: PlayerState = 'stopped';
  private anchorWall = 0;
  private anchorTime: Rational = Rational.ZERO;
  private position: Rational = Rational.ZERO;
  private rate = 1;
  private loopRegion: { start: Rational; end: Rational } | null = null;
  private rafHandle = 0;
  private lastDriftCheck = 0;
  private audioAnchor: { contextTime: number; timelineTime: number } | null = null;
  private destroyed = false;
  /** Fase 7: renders are serialized — one painting, at most one queued. */
  private renderChain: Promise<void> = Promise.resolve();
  private pendingRenders = 0;
  /** Fase 7: media ids already reported as failing. */
  private readonly failedMedia = new Set<string>();
  /** Last mute/solo applied per lane, so syncs only touch changed lanes. */
  private readonly trackFlags = new Map<string, string>();

  /**
   * @param options the surfaces and data to play.
   */
  constructor(options: PreviewPlayerOptions) {
    this.canvas = options.canvas;
    this.session = options.session;
    this.mediaPool = options.mediaPool;
    this.mixer = options.audioContext ? new AudioMixer(options.audioContext) : null;
  }

  /** Where the playhead sits. */
  get currentTime(): Rational {
    return this.position;
  }

  /** Jumps without playing; renders the frame. */
  set currentTime(time: Rational) {
    this.seekTo(time);
  }

  /** True while the loop runs. */
  get isPlaying(): boolean {
    return this.state === 'playing';
  }

  /** The length of the edit. */
  get duration(): Rational {
    return this.session.duration();
  }

  /** The current playback rate multiplier. */
  get playbackRate(): number {
    return this.rate;
  }

  /** The loop region, or `null`. */
  get loop(): { start: Rational; end: Rational } | null {
    return this.loopRegion;
  }

  /** The master level of the mix, `0..1`. */
  get level(): number {
    return this.mixer?.masterLevel ?? 0;
  }

  /** The audio context's wall clock, or `null` when playing silent. */
  private audioNow(): number | null {
    return this.mixer ? this.mixer.now : null;
  }

  /**
   * Sets the preview's output level (the transport slider / mute button).
   * @param volume 0..1; 0 silences the mix without stopping the clock.
   */
  setOutputVolume(volume: number): void {
    this.mixer?.setMasterVolume(Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0);
  }

  /**
   * Mirrors the document's lane flags onto the mix: `muted` and the `solo`
   * extra. Cheap and idempotent — the app calls it after every edit, so a
   * mute or solo toggled during playback silences its lane at once, without a
   * seek or a rebuild of the schedule. Before this existed nothing in the app
   * called `AudioMixer.setTrackMute`, so the lane flags never reached the audio.
   */
  syncTrackStates(): void {
    const mixer = this.mixer;
    if (!mixer) return;
    for (const track of currentTimeline(this.session.document).tracks) {
      const muted = track.muted;
      const solo = track.extra['solo'] === true;
      mixer.ensureTrack(track.id);
      const key = `${muted}/${solo}`;
      if (this.trackFlags.get(track.id) === key) continue;
      this.trackFlags.set(track.id, key);
      mixer.setTrackMute(track.id, muted);
      mixer.setTrackSolo(track.id, solo);
      console.info(`[AudioMixer] track trackId=${track.id} muted=${muted} solo=${solo}`);
    }
  }

  /** Starts (or resumes) playback. */
  play(): void {
    if (this.destroyed || this.state === 'playing') return;
    if (this.position.compare(this.duration) >= 0) this.position = Rational.ZERO;
    this.state = 'playing';
    // Autoplay policy: resume inside the user's gesture, before any await.
    this.mixer?.resume();
    this.anchorWall = performance.now();
    this.anchorTime = this.position;
    this.lastDriftCheck = this.anchorWall;
    this.onStateChanged?.('playing');
    this.buildAudio().then(() => {
      if (this.state === 'playing') {
        this.mixer?.startAll(this.position.asNumber());
        const now = this.audioNow();
        this.audioAnchor = {
          contextTime: now ?? 0,
          timelineTime: this.position.asNumber(),
        };
      }
    }).catch((error: unknown) => {
      // Fase 7 hook (QA): a dead audio buffer must not become an unhandled
      // rejection; the picture keeps playing silent.
      this.onRenderError?.(error, null);
    });
    this.rafHandle = raf(this.loopFrame);
  }

  /** Pauses, keeping the position. */
  pause(): void {
    if (this.state !== 'playing') return;
    this.position = this.clockNow();
    this.state = 'paused';
    cancelRaf(this.rafHandle);
    this.mixer?.stopAll();
    this.audioAnchor = null;
    void this.renderOnce();
    this.onStateChanged?.('paused');
    this.onTimeUpdate?.(this.position);
  }

  /** Stops and rewinds to zero. */
  stop(): void {
    cancelRaf(this.rafHandle);
    this.mixer?.stopAll();
    this.audioAnchor = null;
    this.state = 'stopped';
    this.position = Rational.ZERO;
    void this.renderOnce();
    this.onStateChanged?.('stopped');
    this.onTimeUpdate?.(this.position);
  }

  /**
   * Jumps to `time`, re-rendering and re-syncing audio.
   * @param time the instant to show.
   */
  seekTo(time: Rational): void {
    const clamped = time.compare(Rational.ZERO) < 0
      ? Rational.ZERO
      : time.compare(this.duration) > 0
        ? this.duration
        : time;
    this.position = clamped;
    this.anchorWall = performance.now();
    this.anchorTime = clamped;
    if (this.state === 'playing') {
      this.mixer?.startAll(clamped.asNumber());
      const now = this.audioNow();
      this.audioAnchor =
        now === null ? null : { contextTime: now, timelineTime: clamped.asNumber() };
    }
    void this.renderOnce().then(() => this.onTimeUpdate?.(this.position));
  }

  /** Advances exactly one output frame. */
  stepForward(): void {
    const frame = this.session.engine.frame_rate.frameDuration();
    this.pause();
    this.seekTo(this.position.add(frame));
  }

  /** Retreats exactly one output frame. */
  stepBackward(): void {
    const frame = this.session.engine.frame_rate.frameDuration();
    this.pause();
    this.seekTo(this.position.sub(frame));
  }

  /**
   * Sets the playback rate: 0.25 … 4.
   * @param rate the multiplier.
   */
  setPlaybackRate(rate: number): void {
    this.rate = Math.max(0.25, Math.min(4, rate));
    if (this.state === 'playing') this.seekTo(this.clockNow());
  }

  /**
   * Loops `start..end` when the playhead reaches `end`.
   * @param start loop start.
   * @param end loop end.
   */
  setLoop(start: Rational, end: Rational): void {
    this.loopRegion =
      start.compare(end) < 0 ? { start, end } : { start: end, end: start };
  }

  /** Removes the loop region. */
  clearLoop(): void {
    this.loopRegion = null;
  }

  /**
   * Paints the current frame once — scrubbing, seeks, edits.
   *
   * Fase 7 hook (QA): never rejects and never overlaps. A slow decode used
   * to let the next rAF tick start a second composite on the same canvas
   * (interleaved draws); now one render paints while at most one more waits
   * and reads the *latest* position when it starts. A failing clip draws a
   * red "Media Missing" card; any other failure paints an error frame.
   * @returns resolves once the latest requested frame is on the canvas.
   */
  renderOnce(): Promise<void> {
    if (this.pendingRenders >= 2) return this.renderChain;
    this.pendingRenders += 1;
    this.renderChain = this.renderChain
      .then(() => this.paint())
      .finally(() => {
        this.pendingRenders -= 1;
      });
    return this.renderChain;
  }

  /** Forgets reported media failures (after a relink). */
  clearMediaErrors(): void {
    this.failedMedia.clear();
  }

  /** One composite, errors contained. */
  private async paint(): Promise<void> {
    if (this.destroyed) return;
    try {
      await renderFrame(this.session.engine, this.position, this.canvas, this.mediaPool, {
        missingMedia: 'slate',
        onMediaError: (mediaId, error) => {
          if (this.failedMedia.has(mediaId)) return;
          this.failedMedia.add(mediaId);
          this.onRenderError?.(error, mediaId);
        },
      });
    } catch (error) {
      this.paintErrorFrame();
      this.onRenderError?.(error, null);
    }
  }

  /** Fase 7: a full red frame when the composite itself failed. */
  private paintErrorFrame(): void {
    try {
      const ctx = this.canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = MISSING_MEDIA_COLORS.fill;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = MISSING_MEDIA_COLORS.text;
      ctx.font = `600 ${Math.max(12, Math.round(this.canvas.height / 16))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Error de previsualización', this.canvas.width / 2, this.canvas.height / 2);
    } catch {
      // The surface itself is gone (context lost): nothing left to paint.
    }
  }

  /** Frees the loop and the mix. */
  destroy(): void {
    this.destroyed = true;
    cancelRaf(this.rafHandle);
    this.mixer?.stopAll();
    this.onTimeUpdate = null;
    this.onStateChanged = null;
  }

  // -- internals -----------------------------------------------------------

  /** The timeline instant the clock stands at right now. */
  private clockNow(): Rational {
    if (this.state !== 'playing') return this.position;
    const elapsed = ((performance.now() - this.anchorWall) / 1000) * this.rate;
    return this.anchorTime.add(Rational.approximate(elapsed) ?? Rational.ZERO);
  }

  /** One rAF tick: advance, render, schedule the next. */
  private readonly loopFrame = (): void => {
    if (this.destroyed || this.state !== 'playing') return;
    const now = this.clockNow();

    const loop = this.loopRegion;
    if (loop && now.compare(loop.end) >= 0) {
      this.seekTo(loop.start);
    } else if (now.compare(this.duration) >= 0) {
      this.position = this.duration;
      this.pause();
      return;
    } else {
      this.position = now;
    }

    void this.renderOnce();
    this.onTimeUpdate?.(this.position);
    this.maybeResyncAudio();
    this.rafHandle = raf(this.loopFrame);
  };

  /** Re-schedules every audible clip at the current position. */
  private async buildAudio(): Promise<void> {
    const mixer = this.mixer;
    if (!mixer) return;
    mixer.stopAll();
    for (const clip of this.session.clips()) {
      if (clip.kind === 'text' || clip.kind === 'shape' || clip.kind === 'layer') continue;
      const buffer: BufferLike | null = await this.mediaPool.getAudioBuffer(clip.media.path);
      if (!buffer) continue;
      const start = clip.start.asNumber();
      const duration = clip.duration.asNumber();
      mixer.addClipSource(clip.docTrackId, clip.docId, {
        timelineStart: start,
        sourceOffset: clip.source_start.asNumber(),
        duration,
        buffer,
        volume: clip.gainAt(clip.start),
        fadeIn: clip.audioFadeIn,
        fadeOut: clip.audioFadeOut,
        rate: clip.speed.asNumber() * this.rate,
      });
    }
    this.syncTrackStates();
  }

  /** Picture/sound drift check; re-syncs when they separate. */
  private maybeResyncAudio(): void {
    const anchor = this.audioAnchor;
    const mixer = this.mixer;
    if (!anchor || !mixer) return;
    const wall = performance.now();
    if (wall - this.lastDriftCheck < DRIFT_CHECK_SECONDS * 1000) return;
    this.lastDriftCheck = wall;
    const audioElapsed = mixer.now - anchor.contextTime;
    const expected = anchor.timelineTime + audioElapsed;
    const drift = Math.abs(this.clockNow().asNumber() - expected);
    if (drift > DRIFT_TOLERANCE_SECONDS) {
      mixer.startAll(this.clockNow().asNumber());
      this.audioAnchor = {
        contextTime: mixer.now,
        timelineTime: this.clockNow().asNumber(),
      };
    }
  }
}
