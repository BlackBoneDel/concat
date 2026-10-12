// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The left column: one header per track with rename, kind badge,
 * mute/solo/lock/visibility toggles, collapse and reorder arrows. Heights
 * always match the content canvas, so the two columns scroll as one.
 */

import type { ProjectDocument } from '../../model/document.ts';
import {
  currentTimeline,
  ReorderTracksOperation,
  RenameTrackOperation,
  SetTrackPropertyOperation,
  trackKindOf,
  type EditOperation,
  type TrackKind,
} from '../../editor/operations.ts';

/** What a header needs from its host. */
export interface TrackHeaderOptions {
  getDocument(): ProjectDocument;
  /** Runs one operation through history. */
  run(op: EditOperation): void;
  /** Asks the panel to relayout (collapse/expand changes heights). */
  relayout(): void;
}

/** One track header row. */
export class TrackHeader {
  readonly element: HTMLElement;
  private readonly options: TrackHeaderOptions;
  private readonly trackId: string;

  /**
   * @param trackId the track this header shows.
   * @param options host wiring.
   */
  constructor(trackId: string, options: TrackHeaderOptions) {
    this.trackId = trackId;
    this.options = options;
    this.element = document.createElement('div');
    this.element.className = 'tl-track-header';
    this.element.dataset['trackId'] = trackId;
    this.build();
    this.refresh();
  }

  /** Rebuilds the row from the document. */
  refresh(): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const track = timeline.tracks.find((candidate) => candidate.id === this.trackId);
    if (!track) return;
    const kind: TrackKind = trackKindOf(doc, track);
    const name = typeof track.extra['name'] === 'string' ? track.extra['name'] : track.id;
    const locked = track.extra['locked'] === true;
    const collapsed = track.extra['collapsed'] === true;
    this.element.dataset['kind'] = kind;
    this.element.dataset['locked'] = locked ? 'true' : 'false';
    this.element.dataset['collapsed'] = collapsed ? 'true' : 'false';
    const nameEl = this.element.querySelector('.tl-track-name');
    if (nameEl instanceof HTMLElement && document.activeElement !== nameEl) {
      nameEl.textContent = name;
    }
    const mute = this.element.querySelector('.tl-toggle-mute');
    const solo = this.element.querySelector('.tl-toggle-solo');
    const lock = this.element.querySelector('.tl-toggle-lock');
    const visible = this.element.querySelector('.tl-toggle-visible');
    if (mute instanceof HTMLButtonElement) mute.setAttribute('aria-pressed', String(track.muted));
    if (solo instanceof HTMLButtonElement) {
      solo.setAttribute('aria-pressed', String(track.extra['solo'] === true));
    }
    if (lock instanceof HTMLButtonElement) lock.setAttribute('aria-pressed', String(locked));
    if (visible instanceof HTMLButtonElement) {
      visible.setAttribute('aria-pressed', String(track.visible));
    }
    this.element.style.height = collapsed ? '24px' : kind === 'audio' ? '72px' : '96px';
  }

  /** Builds the static DOM. */
  private build(): void {
    const kindBadge = document.createElement('span');
    kindBadge.className = 'tl-track-kind';
    kindBadge.setAttribute('aria-hidden', 'true');
    const name = document.createElement('div');
    name.className = 'tl-track-name';
    name.textContent = this.trackId;
    name.setAttribute('role', 'textbox');
    name.setAttribute('aria-label', 'Nombre de la pista');
    name.title = 'Doble clic para renombrar';
    name.addEventListener('dblclick', () => this.beginRename(name));

    const buttons = document.createElement('div');
    buttons.className = 'tl-track-buttons';
    buttons.append(
      this.toggleButton('tl-toggle-visible', 'Ocultar/mostrar video', '👁', () => this.toggle('visible')),
      this.toggleButton('tl-toggle-mute', 'Silenciar', 'M', () => this.toggle('mute')),
      this.toggleButton('tl-toggle-solo', 'Solo', 'S', () => this.toggle('solo')),
      this.toggleButton('tl-toggle-lock', 'Bloquear', '🔒', () => this.toggle('lock')),
      this.actionButton('tl-collapse', 'Contraer', '–', () => this.collapse()),
      this.actionButton('tl-move-up', 'Subir pista', '↑', () => this.move(-1)),
      this.actionButton('tl-move-down', 'Bajar pista', '↓', () => this.move(1)),
    );
    this.element.append(kindBadge, name, buttons);
    this.element.setAttribute('role', 'group');
  }

  /** Makes a toggle button. */
  private toggleButton(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tl-track-btn ${className}`;
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', onClick);
    return button;
  }

  /** Makes a plain action button. */
  private actionButton(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tl-track-btn ${className}`;
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  /** Runs a toggle through history. */
  private toggle(which: 'mute' | 'solo' | 'lock' | 'visible'): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const track = timeline.tracks.find((candidate) => candidate.id === this.trackId);
    if (!track) return;
    if (track.extra['locked'] === true && which !== 'lock') return;
    switch (which) {
      case 'mute':
        this.options.run(
          new SetTrackPropertyOperation(this.trackId, 'muted', track.muted, !track.muted),
        );
        break;
      case 'solo':
        this.options.run(
          new SetTrackPropertyOperation(
            this.trackId,
            'solo',
            track.extra['solo'] ?? false,
            !(track.extra['solo'] === true),
          ),
        );
        break;
      case 'lock':
        this.options.run(
          new SetTrackPropertyOperation(
            this.trackId,
            'locked',
            track.extra['locked'] ?? false,
            !(track.extra['locked'] === true),
          ),
        );
        break;
      case 'visible':
        this.options.run(
          new SetTrackPropertyOperation(this.trackId, 'hidden', !track.visible, track.visible),
        );
        break;
      default:
        break;
    }
    this.refresh();
  }

  /** Collapses/expands the track. */
  private collapse(): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const track = timeline.tracks.find((candidate) => candidate.id === this.trackId);
    if (!track) return;
    const next = !(track.extra['collapsed'] === true);
    track.extra['collapsed'] = next; // visual-only geometry, kept in extra
    this.refresh();
    this.options.relayout();
  }

  /** Moves the track up/down the stack. */
  private move(direction: -1 | 1): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const index = timeline.tracks.findIndex((candidate) => candidate.id === this.trackId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= timeline.tracks.length) return;
    this.options.run(new ReorderTracksOperation(this.trackId, index, target));
  }

  /** Inline rename. */
  private beginRename(nameEl: HTMLElement): void {
    const doc = this.options.getDocument();
    const timeline = currentTimeline(doc);
    const track = timeline.tracks.find((candidate) => candidate.id === this.trackId);
    if (!track) return;
    const oldName = typeof track.extra['name'] === 'string' ? track.extra['name'] : track.id;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tl-track-rename';
    input.value = oldName;
    input.setAttribute('aria-label', 'Nuevo nombre de la pista');
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = (): void => {
      const newName = input.value.trim();
      if (newName !== '' && newName !== oldName) {
        this.options.run(new RenameTrackOperation(this.trackId, oldName, newName));
      }
      input.replaceWith(nameEl);
      this.refresh();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        input.value = oldName;
        input.blur();
      }
    });
  }

  /** Frees listeners (element removal is the caller's job). */
  dispose(): void {
    this.element.remove();
  }
}

/** Loads `currentTimeline` for consumers. */
export { currentTimeline };
