// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Title rendering for text clips — the first pass of `concat-text`'s job.
 *
 * Sizes are fractions of the frame height and the block is placed by its
 * alignment, exactly as `model.rs`'s `TextStyle` documents ("sizes as
 * fractions of the frame"). The full line-shaping pipeline (rustybuzz,
 * plates, colour emoji) is Fase 5; this draws laid-out lines on the 2D
 * canvas with word-wrap, stroke, shadow and background plate.
 */

import type { TextStyle } from '../model/index.ts';
import type { RenderContext2D } from './types.ts';

/** Where and how a text block sits, computed once per frame. */
interface TextLayout {
  font: string;
  lineHeight: number;
  lines: string[];
  align: CanvasTextAlign;
}

/** Word-wraps `text` to `maxWidth` pixels using the context's font. */
function wrapLines(ctx: RenderContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (maxWidth <= 0 || ctx.measureText(paragraph).width <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidth || line === '') {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}

/** The layout of a title against a frame. */
function layout(ctx: RenderContext2D, style: TextStyle, frameWidth: number, frameHeight: number): TextLayout {
  const font = `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize * frameHeight}px ${style.fontFamily}`;
  ctx.font = font;
  const maxWidth = style.maxWidth > 0 ? style.maxWidth * frameWidth : 0;
  return {
    font,
    lineHeight: style.lineHeight * style.fontSize * frameHeight,
    lines: wrapLines(ctx, style.content, maxWidth),
    align: style.align === 'left' ? 'left' : style.align === 'right' ? 'right' : 'center',
  };
}

/**
 * Draws a text clip's overlay in frame space. The caller has already set the
 * clip's transform and blend; this paints the block centred on the origin of
 * that space (the picture centre), as every clip's content is.
 * @param ctx the drawing surface, in the clip's transformed space.
 * @param style the title's styling.
 * @param frameWidth output frame width (for fractional sizing).
 * @param frameHeight output frame height.
 */
export function renderTextClip(
  ctx: RenderContext2D,
  style: TextStyle,
  frameWidth: number,
  frameHeight: number,
): void {
  const { font, lineHeight, lines, align } = layout(ctx, style, frameWidth, frameHeight);
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = `${style.tracking * frameHeight}px`;

  const blockHeight = lines.length * lineHeight;
  const firstY = -blockHeight / 2 + lineHeight / 2;

  // The background plate, behind the glyphs.
  if (style.background !== '') {
    let widest = 0;
    for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width);
    const padX = style.backgroundPaddingX * frameHeight;
    const padY = style.backgroundPaddingY * frameHeight;
    const radius = style.backgroundRadius * frameHeight;
    ctx.save();
    ctx.fillStyle = style.background;
    roundedRect(
      ctx,
      -widest / 2 - padX,
      -blockHeight / 2 - padY,
      widest + padX * 2,
      blockHeight + padY * 2,
      radius,
    );
    ctx.fill();
    ctx.restore();
  }

  // Drop shadow.
  if (style.shadow) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    for (let i = 0; i < lines.length; i += 1) {
      const y = firstY + i * lineHeight + Math.max(1, style.fontSize * frameHeight * 0.04);
      ctx.fillText(lines[i]!, 0, y);
    }
    ctx.restore();
  }

  // Outline, then fill.
  if (style.strokeWidth > 0) {
    ctx.lineWidth = style.strokeWidth * frameHeight;
    ctx.strokeStyle = style.strokeColor;
    ctx.lineJoin = 'round';
    for (let i = 0; i < lines.length; i += 1) {
      ctx.strokeText(lines[i]!, 0, firstY + i * lineHeight);
    }
  }
  ctx.fillStyle = style.color;
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i]!, 0, firstY + i * lineHeight);
  }
  ctx.letterSpacing = '0px';
}

/** A rounded rectangle path. */
function roundedRect(
  ctx: RenderContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
  ctx.lineTo(x + radius, y + h);
  ctx.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + radius);
  ctx.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}
