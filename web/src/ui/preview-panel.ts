// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The preview panel: the render canvas, transport, live timecode and scrub
 * bar. Scrubbing maps pointer position to timeline time and seeks the
 * player; the timecode display offers an editable `HH:MM:SS:FF` field that
 * accepts a typed jump.
 *
 * Fase 7 hook: a centred SVG transport (inicio, fotograma −1, play/pausa,
 * fotograma +1, final, detener, bucle) between the timecode and the
 * volume/quality controls; the volume icon mutes and reflects the level.
 * `syncTime` also broadcasts `playhead-changed` so panels (the keyframe
 * toggles of the inspector) can follow the playhead without polling.
 */

import { Rational } from '../core/rational.ts';
import type { AppContext } from './app-context.ts';
import { formatTimecode, parseTimecode, isDropFrameRate } from '../player/timecode.ts';
import { iconButton, setButtonIcon, setPressed, type IconName } from './components/icons.ts';
import { PLAYHEAD_EVENT } from './ui-events.ts';

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
  private readonly loopButton: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private volumeBeforeMute = 1;
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

    // -- transport: [timecode] [centred buttons] [volume · quality]
    const transport = document.createElement('div');
    transport.className = 'transport transport-hud';
    transport.setAttribute('role', 'toolbar');
    transport.setAttribute('aria-label', 'Transporte');

    const left = document.createElement('div');
    left.className = 'transport-group transport-left';
    const center = document.createElement('div');
    center.className = 'transport-group transport-center';
    center.append(
      this.button('skipBack', 'Ir al inicio', 'Inicio', () => this.goStart()),
      this.button('stepBack', 'Fotograma anterior', '←', () => this.ctx.player.stepBackward()),
    );
    this.playButton = this.button('play', 'Reproducir', 'Espacio', () => this.togglePlay());
    this.playButton.classList.add('transport-play', 'is-lg');
    center.append(
      this.playButton,
      this.button('stepForward', 'Fotograma siguiente', '→', () => this.ctx.player.stepForward()),
      this.button('skipForward', 'Ir al final', 'Fin', () => this.goEnd()),
      this.divider(),
      this.button('stop', 'Detener', undefined, () => this.ctx.player.stop()),
    );
    this.loopButton = this.button('loop', 'Reproducción en bucle', undefined, () => this.toggleLoop());
    setPressed(this.loopButton, false);
    center.appendChild(this.loopButton);

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
    transport.append(left, center);

    const right = document.createElement('div');
    right.className = 'transport-group transport-right';

    this.muteButton = this.button('volumeOn', 'Silenciar la previsualización', undefined, () => this.toggleMute());
    this.muteButton.classList.add('transport-mute');
    right.appendChild(this.muteButton);
    this.volume = document.createElement('input');
    this.volume.type = 'range';
    this.volume.min = '0';
    this.volume.max = '1';
    this.volume.step = '0.01';
    this.volume.value = String(this.ctx.settings.volume);
    this.volume.className = 'transport-volume';
    this.volume.setAttribute('aria-label', 'Volumen de la previsualización');
    this.volume.addEventListener('input', () => {
      this.ctx.settings.volume = Number(this.volume.value);
      this.ctx.saveSettings();
      this.syncVolumeIcon();
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
      const playing = state === 'playing';
      setButtonIcon(this.playButton, playing ? 'pause' : 'play');
      this.playButton.title = playing ? 'Pausar (Espacio)' : 'Reproducir (Espacio)';
      this.playButton.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    };
    this.quality.setAttribute('aria-label', 'Calidad de previsualización');
    this.syncVolumeIcon();
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
    // Fase 7 hook: let panels follow the playhead (keyframe toggles).
    document.dispatchEvent(new CustomEvent<number>(PLAYHEAD_EVENT, { detail: time.asNumber() }));
  }

  // -- internals -----------------------------------------------------------

  private togglePlay(): void {
    if (this.ctx.player.isPlaying) this.ctx.player.pause();
    else this.ctx.player.play();
  }

  private goStart(): void {
    this.ctx.player.seekTo(Rational.ZERO);
  }

  private goEnd(): void {
    this.ctx.player.pause();
    this.ctx.player.seekTo(this.ctx.session.duration());
  }

  /** Loops the I/O range when marked, otherwise the whole edit. */
  private toggleLoop(): void {
    const player = this.ctx.player;
    if (player.loop) {
      player.clearLoop();
      setPressed(this.loopButton, false);
      return;
    }
    const edit = this.ctx.editSession;
    const marked = edit && (edit.inPoint !== null || edit.outPoint !== null) ? edit.exportRange() : null;
    const end = this.ctx.session.duration();
    if (!marked && end.isZero()) {
      this.ctx.notifications.info('Nada que repetir', 'Añade clips o marca entrada/salida (I / O).');
      return;
    }
    const range = marked ?? { start: Rational.ZERO, end };
    player.setLoop(range.start, range.end);
    setPressed(this.loopButton, true);
    this.loopButton.title = marked ? 'Bucle de entrada/salida activo' : 'Bucle de toda la línea de tiempo activo';
  }

  /** Mutes/unmutes the preview, remembering the level. */
  private toggleMute(): void {
    const current = Number(this.volume.value);
    if (current > 0) {
      this.volumeBeforeMute = current;
      this.volume.value = '0';
    } else {
      this.volume.value = String(this.volumeBeforeMute > 0 ? this.volumeBeforeMute : 1);
    }
    this.ctx.settings.volume = Number(this.volume.value);
    this.ctx.saveSettings();
    this.syncVolumeIcon();
  }

  private syncVolumeIcon(): void {
    const muted = Number(this.volume.value) <= 0;
    setButtonIcon(this.muteButton, muted ? 'volumeMute' : 'volumeOn');
    setPressed(this.muteButton, muted);
    const label = muted ? 'Activar el sonido de la previsualización' : 'Silenciar la previsualización';
    this.muteButton.title = label;
    this.muteButton.setAttribute('aria-label', label);
  }

  private button(glyph: IconName, label: string, shortcut: string | undefined, onClick: () => void): HTMLButtonElement {
    return iconButton({ icon: glyph, label, shortcut, className: 'transport-btn', onClick: () => onClick() });
  }

  private divider(): HTMLElement {
    const divider = document.createElement('span');
    divider.className = 'transport-divider';
    divider.setAttribute('aria-hidden', 'true');
    return divider;
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
