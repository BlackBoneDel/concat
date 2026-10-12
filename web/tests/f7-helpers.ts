// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 7: shared doubles for the edge-case and stress suites. */

import type { Rational } from '../src/core/rational.ts';
import type { FramePool, RenderContext2D, RenderImage, RenderTarget } from '../src/render/index.ts';

/** One recorded draw call. */
export interface DrawCall {
  op: string;
  args: number[];
  text?: string;
  alpha: number;
  fill: string;
}

/** A 2D context double that records every call with the current alpha/fill. */
export class RecordingContext2D implements RenderContext2D {
  calls: DrawCall[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineJoin: 'round' | 'bevel' | 'miter' = 'miter';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  font = '';
  textAlign = 'center';
  textBaseline = 'middle';
  letterSpacing = '0px';

  private log(op: string, args: number[], text?: string): void {
    this.calls.push({ op, args, text, alpha: this.globalAlpha, fill: typeof this.fillStyle === 'string' ? this.fillStyle : '' });
  }

  save(): void {
    this.log('save', []);
  }
  restore(): void {
    this.log('restore', []);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.log('setTransform', [a, b, c, d, e, f]);
  }
  translate(x: number, y: number): void {
    this.log('translate', [x, y]);
  }
  rotate(angle: number): void {
    this.log('rotate', [angle]);
  }
  scale(x: number, y: number): void {
    this.log('scale', [x, y]);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.log('clearRect', [x, y, w, h]);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.log('fillRect', [x, y, w, h]);
  }
  drawImage(image: RenderImage, ...rest: number[]): void {
    void image;
    this.log('drawImage', rest);
  }
  beginPath(): void {
    this.log('beginPath', []);
  }
  moveTo(x: number, y: number): void {
    this.log('moveTo', [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.log('lineTo', [x, y]);
  }
  closePath(): void {
    this.log('closePath', []);
  }
  arc(x: number, y: number, r: number, start: number, end: number): void {
    this.log('arc', [x, y, r, start, end]);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.log('rect', [x, y, w, h]);
  }
  fill(): void {
    this.log('fill', []);
  }
  stroke(): void {
    this.log('stroke', []);
  }
  fillText(text: string, x: number, y: number): void {
    this.log('fillText', [x, y], text);
  }
  strokeText(text: string, x: number, y: number): void {
    this.log('strokeText', [x, y], text);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 8 };
  }
}

/** A render target backed by a {@link RecordingContext2D}. */
export class RecordingTarget implements RenderTarget {
  readonly ctx = new RecordingContext2D();
  constructor(public width = 640, public height = 360) {}
  getContext(): RenderContext2D {
    return this.ctx;
  }
}

/** A frame pool whose media can be "deleted" at runtime (needs jsdom). */
export class DeletableFramePool implements FramePool {
  readonly deleted = new Set<string>();
  readonly requested: { id: string; at: number }[] = [];
  failures = 0;

  async getFrame(id: string, sourceTime: Rational): Promise<RenderImage | null> {
    this.requested.push({ id, at: sourceTime.asNumber() });
    if (this.deleted.has(id)) {
      this.failures += 1;
      throw new DOMException(`El archivo de ${id} ya no existe`, 'NotFoundError');
    }
    // A real DOM image stands in for a decoded frame (jsdom suites only).
    return document.createElement('img');
  }

  getSize(id: string): { width: number; height: number } | null {
    void id;
    return { width: 1920, height: 1080 };
  }
}
