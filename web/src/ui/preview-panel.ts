// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The preview panel: the render canvas, transport, live timecode and scrub
 * bar. Scrubbing maps pointer position to timeline time and seeks the
 * player; the timecode display offers an editable `HH:MM:SS:FF` field that
 * accepts a typed jump.
 */

import { Rational } from '../core/rational.ts';
import type { AppContext } from './app-context.ts';
import { formatTimecode, parseTimecode, isDropFrameRate } from '../player/timecode.ts';

/** The centre-top panel of the shell. */
export class PreviewPanel {
  private readonly root: HTMLElement;
  private readonly ctx: AppContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly timecodeInput: HTMLInputElement;
  private readonly playButton: HTMLButtonElement;
  private readonly scrub: HTMLElement;
  private readonly scrubFill: HTMLElement;
  private readonly volume: HTMLInputElement;
  private readonly quality: HTMLSelectElement;
  private rafSync = 0;

  /**
   * @param root the panel element.
   * @param ctx the app services.
   */
  constructor(root: HTMLElement, ctx: AppContext) {
    this.root = root;
    this.ctx = ctx;

    // -- stage
    const stage = document.createElement('div');
    stage.className = 'preview-stage';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'preview-canvas';
    this.canvas.width = 960;
    this.canvas.height = 540;
    stage.appendChild(this.canvas);
    this.root.appendChild(stage);

    // -- scrub bar
    this.scrub = document.createElement('div');
    this.scrub.className = 'scrub-bar';
    this.scrub.title = 'Clic para saltar, arrastra para navegar';
    this.scrubFill = document.createElement('div');
    this.scrubFill.className = 'scrub-fill';
    this.scrub.appendChild(this.scrubFill);
    this.root.appendChild(this.scrub);
    this.wireScrub();

    // -- transport
    const transport = document.createElement('div');
    transport.className = 'transport';

    const left = document.createElement('div');
    left.className = 'transport-group';
    left.appendChild(this.button('⏮', 'Inicio (Home)', () => this.goStart()));
    left.appendChild(this.button('◀|', 'Fotograma anterior (←)', () => this.ctx.player.stepBackward()));
    this.playButton = this.button('▶', 'Reproducir / Pausar (Espacio)', () => this.togglePlay());
    this.playButton.classList.add('transport-play');
    left.appendChild(this.playButton);
    left.appendChild(this.button('|▶', 'Fotograma siguiente (→)', () => this.ctx.player.stepForward()));
    left.appendChild(this.button('⏹', 'Detener', () => this.ctx.player.stop()));

    this.timecodeInput = document.createElement('input');
    this.timecodeInput.className = 'timecode-input';
    this.timecodeInput.value = '00:00:00:00';
    this.timecodeInput.title = 'Timecode — escribe HH:MM:SS:FF y pulsa Intro';
    this.timecodeInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const fps = this.ctx.session.frameRate;
      const parsed = parseTimecode(this.timecodeInput.value, fps);
      if (parsed) {
        this.ctx.player.seekTo(parsed);
      } else {
        this.timecodeInput.value = formatTimecode(this.ctx.player.currentTime, fps);
        this.ctx.notifications.warning('Timecode no válido', 'Usa el formato HH:MM:SS:FF.');
      }
    });
    left.appendChild(this.timecodeInput);
    transport.appendChild(left);

    const right = document.createElement('div');
    right.className = 'transport-group';

    const volumeLabel = document.createElement('span');
    volumeLabel.className = 'transport-label';
    volumeLabel.textContent = '🔊';
    right.appendChild(volumeLabel);
    this.volume = document.createElement('input');
    this.volume.type = 'range';
    this.volume.min = '0';
    this.volume.max = '1';
    this.volume.step = '0.01';
    this.volume.value = String(this.ctx.settings.volume);
    this.volume.className = 'transport-volume';
    this.volume.addEventListener('input', () => {
      this.ctx.settings.volume = Number(this.volume.value);
      this.ctx.saveSettings();
    });
    right.appendChild(this.volume);

    this.quality = document.createElement('select');
    this.quality.className = 'transport-quality';
    for (const [value, label] of [
      ['full', 'Calidad 100%'],
      ['half', 'Calidad 50%'],
      ['quarter', 'Calidad 25%'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.quality.appendChild(option);
    }
    this.quality.value = this.ctx.settings.previewQuality;
    this.quality.addEventListener('change', () => {
      this.ctx.settings.previewQuality = this.quality.value as 'full' | 'half' | 'quarter';
      this.ctx.saveSettings();
      this.sizeCanvas();
      this.ctx.requestRender();
    });
    right.appendChild(this.quality);
    transport.appendChild(right);

    this.root.appendChild(transport);

    // -- player events
    this.ctx.player.onTimeUpdate = (time) => this.syncTime(time);
    this.ctx.player.onStateChanged = (state) => {
      this.playButton.textContent = state === 'playing' ? '⏸' : '▶';
      this.playButton.title = state === 'playing' ? 'Pausar (Espacio)' : 'Reproducir (Espacio)';
    };
    this.sizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.sizeCanvas()).observe(stage);
    }
    this.syncTime(Rational.ZERO);
  }

  /** The stage canvas the player renders into. */
  get renderCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Called when the project's rate or size changes. */
  syncTime(time: Rational): void {
    const fps = this.ctx.session.frameRate;
    const drop = isDropFrameRate(fps);
    this.timecodeInput.value = formatTimecode(time, fps, drop);
    const duration = this.ctx.session.duration();
    const fraction = duration.asNumber() > 0 ? time.asNumber() / duration.asNumber() : 0;
    this.scrubFill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  }

  // -- internals -----------------------------------------------------------

  private togglePlay(): void {
    if (this.ctx.player.isPlaying) this.ctx.player.pause();
    else this.ctx.player.play();
  }

  private goStart(): void {
    this.ctx.player.seekTo(Rational.ZERO);
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-icon';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }

  /** Canvas backing store = project frame × quality scale, aspect kept. */
  private sizeCanvas(): void {
    const video = this.ctx.session.video;
    const quality = this.ctx.settings.previewQuality;
    const scale = quality === 'full' ? 1 : quality === 'half' ? 0.5 : 0.25;
    this.canvas.width = Math.max(16, Math.round(video.width * scale));
    this.canvas.height = Math.max(9, Math.round(video.height * scale));
    void this.ctx.player.renderOnce();
  }

  /** Pointer scrubbing on the bar. */
  private wireScrub(): void {
    const seekAt = (clientX: number): void => {
      const rect = this.scrub.getBoundingClientRect();
      const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      const duration = this.ctx.session.duration();
      this.ctx.player.seekTo(duration.mul(Rational.approximate(Math.min(1, Math.max(0, fraction))) ?? Rational.ZERO));
    };
    this.scrub.addEventListener('pointerdown', (event) => {
      this.scrub.setPointerCapture(event.pointerId);
      seekAt(event.clientX);
    });
    this.scrub.addEventListener('pointermove', (event) => {
      if (this.scrub.hasPointerCapture(event.pointerId)) seekAt(event.clientX);
    });
    this.scrub.addEventListener('pointerup', (event) => {
      this.scrub.releasePointerCapture(event.pointerId);
    });
    this.scrub.addEventListener('pointercancel', (event) => {
      this.scrub.releasePointerCapture(event.pointerId);
    });
  }
}
