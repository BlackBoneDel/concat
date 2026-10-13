// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The multitrack audio mixer.
 *
 * Every clip of the edit becomes a scheduled `AudioBufferSourceNode`; tracks
 * own gain/mute/solo nodes and everything lands on one master gain feeding an
 * `AnalyserNode` for the VU meter. The structural node types below are the
 * exact slice of Web Audio this mixer touches — a real `AudioContext` satisfies
 * them as-is, and tests drive it with doubles.
 */

/** A decoded buffer: enough for the mixer. */
export interface BufferLike {
  readonly duration: number;
}

/** The `AudioParam` operations the mixer schedules. */
export interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  /** Fase 4 hook: curved fades (optional so older doubles keep working). */
  setValueCurveAtTime?(values: Float32Array, startTime: number, duration: number): void;
}

/** A gain node. */
export interface GainLike {
  gain: ParamLike;
  connect(destination: unknown): void;
  disconnect(): void;
}

/** The analyser that feeds the VU meter. */
export interface AnalyserLike {
  fftSize: number;
  getFloatTimeDomainData(samples: Float32Array): void;
  connect(destination: unknown): void;
  disconnect(): void;
}

/** A scheduled buffer source. */
export interface SourceLike {
  buffer: BufferLike | null;
  playbackRate: ParamLike;
  start(when?: number, offset?: number, duration?: number): void;
  stop(): void;
  connect(destination: unknown): void;
  disconnect(): void;
}

/** The slice of Web Audio the mixer uses. */
export interface AudioGraphContext {
  readonly currentTime: number;
  readonly destination: unknown;
  createGain(): GainLike;
  createAnalyser(): AnalyserLike;
  createBufferSource(): SourceLike;
  resume?(): Promise<void>;
}

/** One clip of the mix. */
export interface ClipSourceSpec {
  /** Where the clip sits on the timeline, in seconds. */
  timelineStart: number;
  /** Seconds into the source buffer where the clip begins. */
  sourceOffset: number;
  /** How long the clip runs on the timeline, in seconds. */
  duration: number;
  /** The decoded audio. */
  buffer: BufferLike;
  /** Linear gain of the clip (document `volume`, animated). */
  volume: number;
  /** Seconds of ramp-in from silence. */
  fadeIn: number;
  /** Seconds of ramp-out to silence. */
  fadeOut: number;
  /** Playback rate: source seconds per timeline second. */
  rate: number;
}

/**
 * Fase 4 hook: per-clip audio effects. The resolver may swap the buffer for
 * a pre-rendered variant (pitch-preserving speed, transposition), supply a
 * node chain spliced between the clip gain and the track gain, and shape
 * the fades with curve tables.
 */
export interface AudioFxResolution {
  /** Replacement buffer (already time-stretched / transposed). */
  buffer?: BufferLike;
  /** Multiplies `spec.rate` (e.g. 1/speed for a pre-stretched buffer). */
  rateScale?: number;
  /** Multiplies `spec.sourceOffset` (same reason). */
  offsetScale?: number;
  /** Effect chain: connect the clip gain to `input`, the chain to the track. */
  chain?: { input: unknown; connect(destination: unknown): void; dispose(): void } | null;
  /** Fade-in gain curve, 0→1 (scaled by the clip volume). */
  fadeInCurve?: Float32Array | null;
  /** Fade-out gain curve, 1→0 (scaled by the clip volume). */
  fadeOutCurve?: Float32Array | null;
}

/** Fase 4 hook: resolves the effects of one clip at scheduling time. */
export type AudioFxResolver = (key: string, spec: ClipSourceSpec, context: AudioGraphContext) => AudioFxResolution | null;

// Fase 4 hook: process-wide resolver, so the player (which owns its mixer
// privately) picks effects up without changes. Installed by `main.ts`.
let defaultFxResolver: AudioFxResolver | null = null;

/**
 * Fase 4 hook: installs the resolver every mixer uses unless it has its own.
 * @param resolver the resolver, or `null` to restore Fase 2 behaviour.
 */
export function setDefaultAudioFxResolver(resolver: AudioFxResolver | null): void {
  defaultFxResolver = resolver;
}

// Fase 5 hook: taps on the master bus (the stereo VU meter's splitter +
// analysers). Each listener receives the master gain of every new mixer and
// of the live ones at install time.
type MasterTap = (master: GainLike, context: AudioGraphContext) => void;
const masterTaps = new Set<MasterTap>();
const liveMasters: { master: GainLike; context: AudioGraphContext }[] = [];

/**
 * Fase 5 hook: observes the master bus of every mixer (post-fader).
 * @param tap called with the master gain node and its context.
 * @returns unsubscribe.
 */
export function addMasterTap(tap: MasterTap): () => void {
  masterTaps.add(tap);
  for (const live of liveMasters) tap(live.master, live.context);
  return () => masterTaps.delete(tap);
}

/** A scheduled clip and its live nodes. */
interface ScheduledSource {
  key: string;
  trackId: string;
  spec: ClipSourceSpec;
  source: SourceLike | null;
  gain: GainLike | null;
  /** Fase 4 hook: the effect chain disposer of the running source. */
  disposeFx?: (() => void) | null;
}

/** Multitrack mixer over one audio context. */
export class AudioMixer {
  private readonly context: AudioGraphContext;
  private readonly master: GainLike;
  private readonly analyser: AnalyserLike;
  private readonly tracks = new Map<string, { gain: GainLike; volume: number; muted: boolean; solo: boolean }>();
  private readonly sources = new Map<string, ScheduledSource>();
  private readonly levelBuffer: Float32Array;
  private started = false;
  // Fase 4 hook: per-clip effects resolver (null = Fase 2 behaviour).
  private fxResolver: AudioFxResolver | null = null;

  /**
   * @param context the Web Audio context (or a test double).
   */
  constructor(context: AudioGraphContext) {
    this.context = context;
    this.master = context.createGain();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.analyser);
    this.analyser.connect(context.destination);
    this.levelBuffer = new Float32Array(this.analyser.fftSize);
    // Fase 5 hook: let master taps (stereo VU) attach to this bus.
    liveMasters.push({ master: this.master, context });
    if (liveMasters.length > 4) liveMasters.shift();
    for (const tap of masterTaps) tap(this.master, context);
  }

  /**
   * Fase 4 hook: installs (or clears) the per-clip effects resolver. Takes
   * effect for sources started afterwards.
   * @param resolver the resolver, or `null`.
   */
  setAudioFxResolver(resolver: AudioFxResolver | null): void {
    this.fxResolver = resolver;
  }

  /** The audio context the mixer schedules on (Fase 4: effect chains need it). */
  get audioContext(): AudioGraphContext {
    return this.context;
  }

  /**
   * Registers a whole-track buffer at timeline zero — the simple case.
   * @param trackId the lane this belongs to.
   * @param buffer the decoded audio.
   */
  addTrack(trackId: string, buffer: BufferLike): void {
    this.addClipSource(trackId, `track:${trackId}`, {
      timelineStart: 0,
      sourceOffset: 0,
      duration: buffer.duration,
      buffer,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      rate: 1,
    });
    if (!this.tracks.has(trackId)) this.createTrack(trackId);
  }

  /**
   * Schedules one clip of the edit.
   * @param trackId the lane this belongs to.
   * @param key a stable id (the document clip id).
   * @param spec where and how the clip plays.
   */
  addClipSource(trackId: string, key: string, spec: ClipSourceSpec): void {
    if (!this.tracks.has(trackId)) this.createTrack(trackId);
    this.stopSource(key);
    this.sources.set(key, { key, trackId, spec, source: null, gain: null });
    if (this.started) this.startSource(this.sources.get(key)!, this.context.currentTime, 0);
  }

  /** Removes every source of a track. */
  removeTrack(trackId: string): void {
    for (const [key, source] of [...this.sources]) {
      if (source.trackId === trackId) {
        this.stopSource(key);
        this.sources.delete(key);
      }
    }
    const track = this.tracks.get(trackId);
    track?.gain.disconnect();
    this.tracks.delete(trackId);
  }

  /** Removes one clip source. */
  removeClipSource(key: string): void {
    this.stopSource(key);
    this.sources.delete(key);
  }

  /**
   * Sets a track's fader.
   * @param trackId the lane.
   * @param volume 0..2, 1 being unity.
   */
  setTrackVolume(trackId: string, volume: number): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    track.volume = Math.max(0, volume);
    this.refreshTrackGains();
  }

  /** Silences a track without losing its level. */
  setTrackMute(trackId: string, muted: boolean): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    track.muted = muted;
    this.refreshTrackGains();
  }

  /** Solos a track: when any track is soloed, only soloed tracks sound. */
  setTrackSolo(trackId: string, solo: boolean): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    track.solo = solo;
    this.refreshTrackGains();
  }

  /**
   * Resumes the context. Browsers start an `AudioContext` suspended until a
   * user gesture, so the player calls this synchronously from play(); a
   * rejected resume is logged, never thrown into the render loop.
   */
  resume(): void {
    const pending = this.context.resume?.();
    if (!pending) return;
    pending.then(
      () => console.info('[AudioMixer] resumed'),
      (error: unknown) => console.warn('[AudioMixer] resume failed', error),
    );
  }

  /**
   * Sets the master fader.
   * @param volume 0..2, 1 being unity.
   */
  setMasterVolume(volume: number): void {
    this.master.gain.value = Math.max(0, volume);
  }

  /**
   * Starts the whole mix, synchronized to the timeline clock.
   * @param timelineTime where the playhead sits, in seconds.
   */
  startAll(timelineTime: number): void {
    this.stopAll();
    this.started = true;
    void this.context.resume?.();
    for (const source of this.sources.values()) {
      this.startSource(source, this.context.currentTime, timelineTime);
    }
  }

  /** Stops every scheduled source (pause/seek/stop). */
  stopAll(): void {
    this.started = false;
    for (const key of [...this.sources.keys()]) this.stopSource(key);
  }

  /** The audio context's wall clock, in seconds. */
  get now(): number {
    return this.context.currentTime;
  }

  /** The current RMS of the master bus, `0..1` — for the VU meter. */
  get masterLevel(): number {
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (let i = 0; i < this.levelBuffer.length; i += 1) {
      const sample = this.levelBuffer[i]!;
      sum += sample * sample;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuffer.length));
  }

  /** How many clip sources are scheduled. */
  get sourceCount(): number {
    return this.sources.size;
  }

  // -- internals -----------------------------------------------------------

  private createTrack(trackId: string): void {
    const gain = this.context.createGain();
    gain.connect(this.master);
    this.tracks.set(trackId, { gain, volume: 1, muted: false, solo: false });
  }

  /** Solo logic: any solo silences the rest. */
  private refreshTrackGains(): void {
    const anySolo = [...this.tracks.values()].some((track) => track.solo);
    for (const track of this.tracks.values()) {
      const audible = track.solo || (!anySolo && !track.muted);
      track.gain.gain.value = audible ? track.volume : 0;
    }
  }

  /** Starts one source at the right offset, delaying future clips. */
  private startSource(entry: ScheduledSource, when: number, timelineTime: number): void {
    const { spec } = entry;
    const clipEnd = spec.timelineStart + spec.duration;
    if (timelineTime >= clipEnd) return;
    // Fase 4 hook: effects may swap the buffer, rescale time, add a chain.
    let fx: AudioFxResolution | null = null;
    try {
      fx = (this.fxResolver ?? defaultFxResolver)?.(entry.key, spec, this.context) ?? null;
    } catch {
      fx = null;
    }
    const rate = spec.rate * (fx?.rateScale ?? 1);
    const intoClip = Math.max(0, timelineTime - spec.timelineStart);
    const startOffset = spec.sourceOffset * (fx?.offsetScale ?? 1) + intoClip * rate;
    const remaining = spec.duration - intoClip;
    // Clips still ahead on the timeline start later, on the same clock.
    const startAt = when + Math.max(0, spec.timelineStart - timelineTime);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = fx?.buffer ?? spec.buffer;
    source.playbackRate.value = Math.max(0.0625, Math.min(16, rate));
    source.connect(gain);
    const trackInput = this.tracks.get(entry.trackId)?.gain ?? this.master;
    if (fx?.chain) {
      gain.connect(fx.chain.input);
      fx.chain.connect(trackInput);
      entry.disposeFx = fx.chain.dispose;
    } else {
      gain.connect(trackInput);
    }

    // The clip's gain ride: constant volume with its fade ramps.
    const level = Math.max(0, spec.volume);
    const endAt = startAt + remaining;
    const param = gain.gain;
    if (spec.fadeIn > 0 && intoClip < spec.fadeIn) {
      const left = spec.fadeIn - intoClip;
      if (fx?.fadeInCurve && param.setValueCurveAtTime && intoClip === 0) {
        param.setValueCurveAtTime(fx.fadeInCurve.map((v) => v * level), startAt, left);
      } else {
        param.setValueAtTime(0, startAt);
        param.linearRampToValueAtTime(level, startAt + left);
      }
    } else {
      param.setValueAtTime(level, startAt);
    }
    if (spec.fadeOut > 0) {
      const fadeStart = endAt - spec.fadeOut;
      if (fadeStart > startAt) {
        if (fx?.fadeOutCurve && param.setValueCurveAtTime) {
          param.setValueCurveAtTime(fx.fadeOutCurve.map((v) => v * level), fadeStart, spec.fadeOut);
        } else {
          param.setValueAtTime(level, fadeStart);
          param.linearRampToValueAtTime(0, endAt);
        }
      }
    }
    source.start(startAt, startOffset, remaining > 0 ? remaining : undefined);
    entry.source = source;
    entry.gain = gain;
  }

  private stopSource(key: string): void {
    const entry = this.sources.get(key);
    if (!entry?.source) return;
    try {
      entry.source.stop();
    } catch {
      // Not started — fine.
    }
    entry.source.disconnect();
    entry.gain?.disconnect();
    entry.disposeFx?.(); // Fase 4 hook
    entry.disposeFx = null;
    entry.source = null;
    entry.gain = null;
  }
}
