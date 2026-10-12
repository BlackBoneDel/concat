// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The cubic-bezier editor of a keyframe: a 150×150 Canvas 2D graph with the
 * fixed endpoints P0(0,0) and P3(1,1) and two draggable handles P1/P2.
 * x1/x2 are clamped into [0, 1] (a timing function must be monotonic in
 * time); y1/y2 stay free (overshoot/anticipation) within ±3. Presets:
 * Linear, Ease-In, Ease-Out, Ease-In-Out and Hold.
 *
 * Keyboard: Tab focuses the canvas, 1/2 pick a handle, arrows nudge it
 * (Shift = ×10), Enter commits.
 */

import { BEZIER_PRESETS, BEZIER_Y_LIMIT, clampBezier, evaluateBezier, presetOf, type CubicBezier } from '../../editor/keyframe-operations.ts';

/** Canvas size in CSS pixels. */
export const BEZIER_CANVAS_SIZE = 150;
/** Inner margin so overshooting handles stay visible. */
const MARGIN = 14;
/** The y window drawn: y ∈ [−0.5, 1.5]. */
const Y_MIN = -0.5;
const Y_MAX = 1.5;

/** Preset buttons, in order. */
export const BEZIER_PRESET_BUTTONS: readonly { id: keyof typeof BEZIER_PRESETS; label: string }[] = Object.freeze([
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease-In' },
  { id: 'easeOut', label: 'Ease-Out' },
  { id: 'easeInOut', label: 'Ease-In-Out' },
  { id: 'hold', label: 'Hold' },
]);

/**
 * Curve space → canvas pixels.
 * @param x time progress.
 * @param y value progress.
 * @param size canvas size (CSS px).
 * @returns pixel coordinates (y grows downwards).
 */
export function curveToCanvas(x: number, y: number, size = BEZIER_CANVAS_SIZE): { px: number; py: number } {
  const inner = size - MARGIN * 2;
  return { px: MARGIN + x * inner, py: MARGIN + (1 - (y - Y_MIN) / (Y_MAX - Y_MIN)) * inner };
}

/**
 * Canvas pixels → curve space (x clamped to [0,1], y within the editor limit).
 * @param px pixel x.
 * @param py pixel y.
 * @param size canvas size (CSS px).
 * @returns the curve point.
 */
export function canvasToCurve(px: number, py: number, size = BEZIER_CANVAS_SIZE): { x: number; y: number } {
  const inner = size - MARGIN * 2;
  const x = (px - MARGIN) / inner;
  const y = Y_MIN + (1 - (py - MARGIN) / inner) * (Y_MAX - Y_MIN);
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(BEZIER_Y_LIMIT, Math.max(-BEZIER_Y_LIMIT, y)),
  };
}

/**
 * Moves one handle of a curve, re-clamping it.
 * @param curve the curve.
 * @param handle 1 (P1) or 2 (P2).
 * @param x new x.
 * @param y new y.
 * @returns the clamped curve.
 */
export function moveHandle(curve: CubicBezier, handle: 1 | 2, x: number, y: number): CubicBezier {
  return clampBezier(handle === 1 ? [x, y, curve[2], curve[3]] : [curve[0], curve[1], x, y]);
}

/** Which handle is nearer a pixel (within 12 px), if any. */
export function nearestHandle(curve: CubicBezier, px: number, py: number, size = BEZIER_CANVAS_SIZE): 1 | 2 | null {
  const p1 = curveToCanvas(curve[0], curve[1], size);
  const p2 = curveToCanvas(curve[2], curve[3], size);
  const d1 = Math.hypot(p1.px - px, p1.py - py);
  const d2 = Math.hypot(p2.px - px, p2.py - py);
  const best = d1 <= d2 ? 1 : 2;
  return Math.min(d1, d2) <= 12 ? best : null;
}

/** Colours the editor reads from the theme's CSS variables. */
interface EditorColors {
  bg: string;
  grid: string;
  curve: string;
  handle: string;
  text: string;
}

function themeColors(element: HTMLElement): EditorColors {
  const style = getComputedStyle(element);
  const pick = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: pick('--bg-input', '#141417'),
    grid: pick('--border', '#2c2c32'),
    curve: pick('--accent', '#4c8dff'),
    handle: pick('--warning', '#e0a030'),
    text: pick('--text-muted', '#8c8c94'),
  };
}

/** Options of {@link BezierEditor}. */
export interface BezierEditorOptions {
  /** Initial curve. */
  curve: CubicBezier;
  /**
   * Called while dragging (`final = false`) and on release/preset (`final = true`).
   * Only final changes should reach history.
   */
  onChange(curve: CubicBezier, final: boolean): void;
}

/** The Bézier editor widget. */
export class BezierEditor {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly readout: HTMLOutputElement;
  private readonly presetButtons = new Map<string, HTMLButtonElement>();
  private readonly options: BezierEditorOptions;
  private curve: CubicBezier;
  private dragging: 1 | 2 | null = null;
  private focusedHandle: 1 | 2 = 1;
  private frame = 0;
  private readonly abort = new AbortController();

  /** @param options initial curve and change callback. */
  constructor(options: BezierEditorOptions) {
    this.options = options;
    this.curve = clampBezier(options.curve);
    this.element = document.createElement('div');
    this.element.className = 'bezier-editor';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bezier-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.style.width = `${BEZIER_CANVAS_SIZE}px`;
    this.canvas.style.height = `${BEZIER_CANVAS_SIZE}px`;
    this.readout = document.createElement('output');
    this.readout.className = 'bezier-readout';
    const presets = document.createElement('div');
    presets.className = 'bezier-presets';
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', 'Curvas predefinidas');
    for (const preset of BEZIER_PRESET_BUTTONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-small';
      button.textContent = preset.label;
      button.addEventListener('click', () => this.set(BEZIER_PRESETS[preset.id], true), { signal: this.abort.signal });
      this.presetButtons.set(preset.id, button);
      presets.appendChild(button);
    }
    this.element.append(this.canvas, this.readout, presets);
    const signal = this.abort.signal;
    this.canvas.addEventListener('pointerdown', this.onPointerDown, { signal });
    this.canvas.addEventListener('pointermove', this.onPointerMove, { signal });
    this.canvas.addEventListener('pointerup', this.onPointerUp, { signal });
    this.canvas.addEventListener('pointercancel', this.onPointerUp, { signal });
    this.canvas.addEventListener('keydown', this.onKeyDown, { signal });
    this.paint();
  }

  /** The current (clamped) curve. */
  value(): CubicBezier {
    return this.curve;
  }

  /**
   * Replaces the curve.
   * @param curve new control points (clamped).
   * @param notify whether to report it as a final change.
   */
  set(curve: readonly number[], notify = false): void {
    this.curve = clampBezier(curve);
    this.schedulePaint();
    if (notify) this.options.onChange(this.curve, true);
  }

  /** Removes listeners and the pending frame. */
  dispose(): void {
    this.abort.abort();
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private point(event: PointerEvent): { px: number; py: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? BEZIER_CANVAS_SIZE / rect.width : 1;
    return { px: (event.clientX - rect.left) * scale, py: (event.clientY - rect.top) * scale };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const { px, py } = this.point(event);
    const handle = nearestHandle(this.curve, px, py);
    if (!handle) return;
    this.dragging = handle;
    this.focusedHandle = handle;
    this.canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) {
      const { px, py } = this.point(event);
      this.canvas.style.cursor = nearestHandle(this.curve, px, py) ? 'grab' : 'default';
      return;
    }
    const { px, py } = this.point(event);
    const { x, y } = canvasToCurve(px, py);
    this.curve = moveHandle(this.curve, this.dragging, x, y);
    this.schedulePaint();
    this.options.onChange(this.curve, false);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = null;
    if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.options.onChange(this.curve, true);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === '1' || event.key === '2') {
      this.focusedHandle = event.key === '1' ? 1 : 2;
      this.schedulePaint();
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      this.options.onChange(this.curve, true);
      event.preventDefault();
      return;
    }
    const step = event.shiftKey ? 0.1 : 0.01;
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
    if (dx === 0 && dy === 0) return;
    event.preventDefault();
    const h = this.focusedHandle;
    const x = (h === 1 ? this.curve[0] : this.curve[2]) + dx;
    const y = (h === 1 ? this.curve[1] : this.curve[3]) + dy;
    this.curve = moveHandle(this.curve, h, x, y);
    this.schedulePaint();
    this.options.onChange(this.curve, true);
  };

  private schedulePaint(): void {
    if (this.frame !== 0) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.paint();
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    const [x1, y1, x2, y2] = this.curve;
    const text = `cubic-bezier(${[x1, y1, x2, y2].map((v) => Math.round(v * 100) / 100).join(', ')})`;
    this.readout.textContent = text;
    const preset = presetOf(this.curve);
    for (const [id, button] of this.presetButtons) button.setAttribute('aria-pressed', String(id === preset));
    this.canvas.setAttribute('aria-label', `Curva de interpolación ${text}. Teclas 1 y 2 eligen el manejador, flechas lo mueven.`);
    const ctx = typeof this.canvas.getContext === 'function' ? this.canvas.getContext('2d') : null;
    if (!ctx) return;
    const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    const size = BEZIER_CANVAS_SIZE;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = themeColors(this.element);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, size, size);
    // Unit square and diagonal.
    const p0 = curveToCanvas(0, 0);
    const p3 = curveToCanvas(1, 1);
    ctx.strokeStyle = colors.grid;
    ctx.strokeRect(p0.px, p3.py, p3.px - p0.px, p0.py - p3.py);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(p0.px, p0.py);
    ctx.lineTo(p3.px, p3.py);
    ctx.stroke();
    ctx.setLineDash([]);
    // Handles' arms.
    const h1 = curveToCanvas(x1, y1);
    const h2 = curveToCanvas(x2, y2);
    ctx.strokeStyle = colors.handle;
    ctx.beginPath();
    ctx.moveTo(p0.px, p0.py);
    ctx.lineTo(h1.px, h1.py);
    ctx.moveTo(p3.px, p3.py);
    ctx.lineTo(h2.px, h2.py);
    ctx.stroke();
    // The eased curve, sampled through the engine solver (preview = export).
    ctx.strokeStyle = colors.curve;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 60; i += 1) {
      const t = i / 60;
      const { px, py } = curveToCanvas(t, evaluateBezier(this.curve, t));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    // Endpoints and handles.
    ctx.fillStyle = colors.text;
    for (const p of [p0, p3]) {
      ctx.beginPath();
      ctx.arc(p.px, p.py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    [h1, h2].forEach((p, index) => {
      ctx.beginPath();
      ctx.arc(p.px, p.py, this.focusedHandle === index + 1 ? 6 : 5, 0, Math.PI * 2);
      ctx.fillStyle = colors.handle;
      ctx.fill();
      ctx.strokeStyle = colors.bg;
      ctx.stroke();
    });
  }
}
