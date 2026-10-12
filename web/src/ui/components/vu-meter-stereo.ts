// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Stereo VU meter of the master bus. The mixer's master gain is tapped
 * (`addMasterTap`) into a ChannelSplitter feeding one AnalyserNode per
 * channel; every animation frame reads the time-domain samples and shows
 * the sample peak in dBFS, a peak-hold tick (1.5 s) and a clip LED that
 * stays lit 2 s whenever a channel reaches 0 dBFS. Drawn on one Canvas 2D
 * with the theme's CSS variables; the level maths are pure and testable.
 */

import type { AnalyserLike, GainLike } from '../../player/audio-mixer.ts';

/** Floor of the scale (anything quieter reads as silence). */
export const VU_MIN_DB = -60;
/** Peak-hold time. */
export const PEAK_HOLD_MS = 1500;
/** How long the clip LED stays lit after a 0 dBFS sample. */
export const CLIP_HOLD_MS = 2000;
/** Release of the bar (dB per second) — attack is instant. */
export const VU_RELEASE_DB_PER_S = 24;
/** Fall of the peak-hold tick after its hold time (dB per second). */
export const PEAK_FALL_DB_PER_S = 18;

/**
 * Linear amplitude → dBFS, floored at {@link VU_MIN_DB}.
 * @param amplitude absolute sample value (1 = full scale).
 * @returns decibels relative to full scale.
 */
export function toDbfs(amplitude: number): number {
  if (!(amplitude > 0)) return VU_MIN_DB;
  return Math.max(VU_MIN_DB, 20 * Math.log10(amplitude));
}

/**
 * dBFS → bar fill 0..1 (linear in dB over the meter range).
 * @param db decibels.
 * @returns the fraction of the bar.
 */
export function dbToFraction(db: number): number {
  return Math.min(1, Math.max(0, (db - VU_MIN_DB) / -VU_MIN_DB));
}

/**
 * The sample peak of a block.
 * @param samples time-domain samples.
 * @returns max |x|.
 */
export function blockPeak(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i] ?? 0);
    if (v > peak) peak = v;
  }
  return peak;
}

/** What one channel shows. */
export interface ChannelReading {
  /** Bar level (dBFS, with release ballistics). */
  level: number;
  /** Peak-hold tick (dBFS). */
  peak: number;
  /** Whether the clip LED is lit. */
  clipping: boolean;
}

/** Ballistics of one channel: instant attack, linear release, peak hold, clip latch. */
export class ChannelMeter {
  private level = VU_MIN_DB;
  private peak = VU_MIN_DB;
  private peakAt = -Infinity;
  private clipAt = -Infinity;
  private lastAt: number | null = null;

  /**
   * Feeds one block.
   * @param samples the channel's time-domain samples.
   * @param nowMs timestamp of the block (ms).
   * @returns the reading after the block.
   */
  process(samples: ArrayLike<number>, nowMs: number): ChannelReading {
    return this.feed(blockPeak(samples), nowMs);
  }

  /**
   * Feeds a block peak directly.
   * @param amplitude linear block peak.
   * @param nowMs timestamp (ms).
   * @returns the reading.
   */
  feed(amplitude: number, nowMs: number): ChannelReading {
    const dt = this.lastAt === null ? 0 : Math.max(0, nowMs - this.lastAt) / 1000;
    this.lastAt = nowMs;
    const db = toDbfs(amplitude);
    this.level = db >= this.level ? db : Math.max(db, this.level - VU_RELEASE_DB_PER_S * dt);
    if (db >= this.peak) {
      this.peak = db;
      this.peakAt = nowMs;
    } else if (nowMs - this.peakAt > PEAK_HOLD_MS) {
      this.peak = Math.max(this.level, this.peak - PEAK_FALL_DB_PER_S * dt);
    }
    if (db >= 0) this.clipAt = nowMs;
    return this.reading(nowMs);
  }

  /**
   * The current reading without new input.
   * @param nowMs timestamp (ms).
   * @returns the reading.
   */
  reading(nowMs: number): ChannelReading {
    return { level: this.level, peak: this.peak, clipping: nowMs - this.clipAt < CLIP_HOLD_MS };
  }

  /** Clears the clip LED and the peak tick. */
  resetClip(): void {
    this.clipAt = -Infinity;
    this.peak = this.level;
    this.peakAt = -Infinity;
  }
}

/** A channel splitter. */
export interface SplitterLike {
  connect(destination: unknown, output?: number, input?: number): unknown;
  disconnect(): void;
}

/** The slice of an AudioContext the meter needs. */
export interface MeterAudioContext {
  createChannelSplitter(channels?: number): SplitterLike;
  createAnalyser(): AnalyserLike;
}

/**
 * Whether a mixer context can host the stereo meter.
 * @param context the mixer's context.
 * @returns the narrowed context.
 */
export function isMeterContext(context: unknown): context is MeterAudioContext {
  return typeof context === 'object' && context !== null &&
    typeof Reflect.get(context, 'createChannelSplitter') === 'function' &&
    typeof Reflect.get(context, 'createAnalyser') === 'function';
}

/** Taps a master bus: splitter → L/R analysers. */
export class StereoTap {
  readonly left: AnalyserLike;
  readonly right: AnalyserLike;
  private readonly splitter: SplitterLike;
  private readonly bufferL: Float32Array<ArrayBuffer>;
  private readonly bufferR: Float32Array<ArrayBuffer>;

  /**
   * @param master the master gain (post-fader).
   * @param context its context.
   * @param fftSize samples per read (power of two).
   */
  constructor(master: GainLike, context: MeterAudioContext, fftSize = 1024) {
    this.splitter = context.createChannelSplitter(2);
    this.left = context.createAnalyser();
    this.right = context.createAnalyser();
    this.left.fftSize = fftSize;
    this.right.fftSize = fftSize;
    master.connect(this.splitter);
    this.splitter.connect(this.left, 0);
    this.splitter.connect(this.right, 1);
    this.bufferL = new Float32Array(fftSize);
    this.bufferR = new Float32Array(fftSize);
  }

  /**
   * Reads both channels' latest samples.
   * @returns the [left, right] sample blocks.
   */
  read(): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
    this.left.getFloatTimeDomainData(this.bufferL);
    this.right.getFloatTimeDomainData(this.bufferR);
    return [this.bufferL, this.bufferR];
  }

  /** Disconnects the tap from the bus. */
  dispose(): void {
    try {
      this.splitter.disconnect();
      this.left.disconnect();
      this.right.disconnect();
    } catch {
      // Already torn down with its context.
    }
  }
}

/** Options of {@link VuMeterStereo}. */
export interface VuMeterOptions {
  /** Subscribes to master buses (normally `addMasterTap`). */
  addMasterTap(tap: (master: GainLike, context: unknown) => void): () => void;
  /** Frame scheduler (tests). */
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  width?: number;
  height?: number;
}

/** The meter widget (canvas + two clip LEDs). */
export class VuMeterStereo {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly leds: [HTMLButtonElement, HTMLButtonElement];
  private readonly meters: [ChannelMeter, ChannelMeter] = [new ChannelMeter(), new ChannelMeter()];
  private readonly requestFrame: (callback: (time: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly unsubscribe: () => void;
  private tap: StereoTap | null = null;
  private frame: number | null = null;
  private lastLabelAt = -Infinity;
  private disposed = false;

  /**
   * @param options wiring.
   */
  constructor(options: VuMeterOptions) {
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.element = document.createElement('div');
    this.element.className = 'vu-meter';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Medidor de nivel estéreo del máster');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vu-meter-canvas';
    this.canvas.width = options.width ?? 140;
    this.canvas.height = options.height ?? 22;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Nivel: silencio');
    const led = (side: string): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vu-clip-led';
      button.textContent = side;
      button.title = `Clip ${side} (clic para reiniciar)`;
      button.setAttribute('aria-label', `Indicador de saturación ${side === 'L' ? 'izquierdo' : 'derecho'}`);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => this.resetClips());
      return button;
    };
    this.leds = [led('L'), led('R')];
    const ledBox = document.createElement('div');
    ledBox.className = 'vu-clip-leds';
    ledBox.append(...this.leds);
    this.element.append(this.canvas, ledBox);
    this.unsubscribe = options.addMasterTap((master, context) => this.attach(master, context));
  }

  /**
   * Taps a (new) master bus; the previous tap is released.
   * @param master the master gain.
   * @param context its context.
   */
  attach(master: GainLike, context: unknown): void {
    if (this.disposed || !isMeterContext(context)) return;
    this.tap?.dispose();
    try {
      this.tap = new StereoTap(master, context);
    } catch (error) {
      this.tap = null;
      console.warn('Medidor VU no disponible', error);
      return;
    }
    if (this.frame === null) this.frame = this.requestFrame((time) => this.tick(time));
  }

  /** Clears both clip LEDs. */
  resetClips(): void {
    for (const meter of this.meters) meter.resetClip();
  }

  /** Stops the loop and disconnects from the bus. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.tap?.dispose();
    this.tap = null;
  }

  private tick(time: number): void {
    this.frame = null;
    if (this.disposed || !this.tap) return;
    const [l, r] = this.tap.read();
    const peakL = blockPeak(l);
    const peakR = blockPeak(r);
    const readings = [this.meters[0].feed(peakL, time), this.meters[1].feed(peakR, time)] as const;
    this.draw(readings);
    readings.forEach((reading, index) => {
      const led = this.leds[index];
      if (!led) return;
      led.classList.toggle('is-clipping', reading.clipping);
      led.setAttribute('aria-pressed', String(reading.clipping));
    });
    // The text alternative changes at most twice a second.
    if (time - this.lastLabelAt > 500) {
      this.lastLabelAt = time;
      const fmt = (db: number): string => (db <= VU_MIN_DB ? '−∞' : `${Math.round(db)}`);
      this.canvas.setAttribute('aria-label', `Nivel: L ${fmt(readings[0].level)} dBFS, R ${fmt(readings[1].level)} dBFS`);
    }
    this.frame = this.requestFrame((next) => this.tick(next));
  }

  private draw(readings: readonly [ChannelReading, ChannelReading]): void {
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = this.canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const style = getComputedStyle(this.element);
    const pick = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
    const bg = pick('--bg-input', '#222');
    const ok = pick('--success', '#3ecf8e');
    const warn = pick('--warning', '#f5a524');
    const hot = pick('--danger', '#f04848');
    const tick = pick('--text', '#fff');
    const { width, height } = this.canvas;
    const gap = 2;
    const barH = (height - gap) / 2;
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, ok);
    gradient.addColorStop(dbToFraction(-12), ok);
    gradient.addColorStop(dbToFraction(-6), warn);
    gradient.addColorStop(dbToFraction(-1), hot);
    gradient.addColorStop(1, hot);
    readings.forEach((reading, index) => {
      const y = index * (barH + gap);
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, width, barH);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, y, width * dbToFraction(reading.level), barH);
      if (reading.peak > VU_MIN_DB) {
        ctx.fillStyle = reading.peak >= 0 ? hot : tick;
        ctx.fillRect(Math.min(width - 2, width * dbToFraction(reading.peak)), y, 2, barH);
      }
    });
    // Scale ticks at −48/−24/−12/−6/0 dB.
    ctx.fillStyle = bg;
    for (const db of [-48, -24, -12, -6]) ctx.fillRect(Math.round(width * dbToFraction(db)), 0, 1, height);
  }
}
