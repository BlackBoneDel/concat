// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The title renderer: layout, wrapping, stroke, shadow and plate. */

import { describe, expect, it } from 'vitest';
import { renderTextClip, type RenderContext2D } from '../src/render/index.ts';
import { defaultTextStyle, type TextStyle } from '../src/model/document.ts';

/** A draw recorder. */
class FakeContext implements RenderContext2D {
  calls: { op: string; text?: string; args: number[] }[] = [];
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
  /** Character-pixel width used by measureText. */
  glyphWidth = 10;

  private log(op: string, args: number[], text?: string): void {
    this.calls.push({ op, args, text });
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

  drawImage(): void {
    this.log('drawImage', []);
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
    return { width: text.length * this.glyphWidth };
  }
}

function style(overrides: Partial<TextStyle> = {}): TextStyle {
  return { ...defaultTextStyle(), ...overrides };
}

describe('renderTextClip', () => {
  it('draws one centred line', () => {
    const ctx = new FakeContext();
    renderTextClip(ctx, style({ content: 'Hola', shadow: false }), 1920, 1080);
    const fills = ctx.calls.filter((call) => call.op === 'fillText');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.text).toBe('Hola');
    // The single line sits vertically centred on the origin.
    expect(fills[0]!.args[1]).toBeCloseTo(0, 6);
  });

  it('keeps explicit line breaks', () => {
    const ctx = new FakeContext();
    renderTextClip(ctx, style({ content: 'Línea uno\nLínea dos', shadow: false }), 1920, 1080);
    const fills = ctx.calls.filter((call) => call.op === 'fillText');
    expect(fills).toHaveLength(2);
    expect(fills[1]!.args[1]).toBeGreaterThan(fills[0]!.args[1]!);
  });

  it('wraps long lines at maxWidth', () => {
    const ctx = new FakeContext();
    // Each glyph is 10px: 30 glyphs per line at maxWidth 300.
    renderTextClip(
      ctx,
      style({ content: 'aaa bbb ccc ddd eee fff', maxWidth: 0.25 }),
      1920,
      1080,
    );
    const fills = ctx.calls.filter((call) => call.op === 'fillText');
    expect(fills.length).toBeGreaterThan(1);
  });

  it('strokes the outline before the fill', () => {
    const ctx = new FakeContext();
    renderTextClip(ctx, style({ content: 'Borde', strokeWidth: 0.01 }), 1920, 1080);
    const order = ctx.calls.map((call) => call.op);
    expect(order.indexOf('strokeText')).toBeLessThan(order.lastIndexOf('fillText'));
  });

  it('paints the shadow and the plate behind the glyphs', () => {
    const ctx = new FakeContext();
    renderTextClip(
      ctx,
      style({ content: 'Placa', shadow: true, background: '#222222' }),
      1920,
      1080,
    );
    expect(ctx.calls.some((call) => call.op === 'fill')).toBe(true);
    // Shadow fill happens before the final fill.
    const fills = ctx.calls.filter((call) => call.op === 'fillText');
    expect(fills.length).toBeGreaterThanOrEqual(2);
  });

  it('respects the alignment setting', () => {
    const ctx = new FakeContext();
    renderTextClip(ctx, style({ content: 'Izquierda', align: 'left' }), 1920, 1080);
    expect(ctx.textAlign).toBe('left');
  });
});
