// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 titling renderer — the second pass of `concat-text`'s job, on top
 * of Fase 2's `text-renderer.ts` (which still draws titles without an
 * advanced style, byte-for-byte as before).
 *
 * Adds, per `clip.extra.advanced_text` ({@link AdvancedTextStyle}):
 * - a **background plate** measured with `measureText` over the full text
 *   (so it does not jump while a typewriter reveals), padded and drawn with
 *   `roundRect` (manual arcs where the API is missing);
 * - **drop shadow** (`shadowColor/Blur/OffsetX/OffsetY`) and an outer **glow**;
 * - **gradient fill** when `fill` is an array (linear, along `gradientAngle`);
 * - **stroke** drawn under the fill;
 * - the **typewriter**: `progress = (time − start) / typewriterDuration`,
 *   showing `substring(0, ⌊progress · length⌋)` code points. Lines are wrapped
 *   on the full text first, so revealed words never re-flow.
 *
 * Sizes are fractions of the frame height, like `model.rs`'s `TextStyle`.
 */

import type { Clip } from '../core/timeline.ts';
import type { TextStyle } from '../model/document.ts';
import type { AdvancedTextStyle } from './advanced-text.ts';
import type { RenderContext2D } from './types.ts';

/** The optional canvas features the engine uses when present. */
export interface TextEngineContext extends RenderContext2D {
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  createLinearGradient?(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
  roundRect?(x: number, y: number, w: number, h: number, radii: number): void;
}

/** What the compositor asks per text clip. */
export interface TextEngineHook {
  /**
   * @param clip the engine clip.
   * @returns the advanced style and the custom family to use, or `null`
   *   when the clip has no advanced style (Fase 2 renderer).
   */
  resolve(clip: Clip): { advanced: AdvancedTextStyle; fontFamily: string | null } | null;
}

let textHook: TextEngineHook | null = null;

/**
 * Installs (or clears) the process-wide titling hook.
 * @param hook the hook, or `null`.
 */
export function setTextEngineHook(hook: TextEngineHook | null): void {
  textHook = hook;
}

/** The installed titling hook, if any. */
export function getTextEngineHook(): TextEngineHook | null {
  return textHook;
}

/**
 * Typewriter progress.
 * @param localTime seconds since the clip started (`time − start`).
 * @param duration seconds to reveal everything.
 * @returns `0..1`.
 */
export function typewriterProgress(localTime: number, duration: number): number {
  if (!(duration > 0)) return 1;
  return Math.min(1, Math.max(0, localTime / duration));
}

/**
 * The visible prefix of a text.
 * @param content the full text.
 * @param localTime seconds since the clip started.
 * @param duration seconds to reveal everything.
 * @returns `content.substring(0, ⌊progress · length⌋)` over code points.
 */
export function typewriterText(content: string, localTime: number, duration: number): string {
  const chars = Array.from(content);
  const count = Math.floor(typewriterProgress(localTime, duration) * chars.length);
  return chars.slice(0, count).join('');
}

/**
 * Reveals `count` code points across already-wrapped lines (line breaks and
 * the spaces wrapping consumed count as one character each).
 * @param lines the wrapped full text.
 * @param count visible characters.
 * @returns the visible part of every line (empty strings for hidden lines).
 */
export function revealLines(lines: readonly string[], count: number): string[] {
  let left = Math.max(0, count);
  return lines.map((line, index) => {
    const chars = Array.from(line);
    const shown = chars.slice(0, left).join('');
    left -= chars.length + (index < lines.length - 1 ? 1 : 0);
    left = Math.max(0, left);
    return shown;
  });
}

/** Word-wraps text to `maxWidth` pixels with the context's current font. */
export function wrapText(ctx: Pick<RenderContext2D, 'measureText'>, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (maxWidth <= 0 || ctx.measureText(paragraph).width <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidth || line === '') line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}

/** A rectangle in the clip's frame space (origin = picture centre). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The background plate: the widest measured line plus padding.
 * @param widest widest line in pixels (measureText).
 * @param blockHeight lines × line height.
 * @param padX horizontal padding (px).
 * @param padY vertical padding (px).
 * @returns the plate, centred on the origin.
 */
export function backgroundBox(widest: number, blockHeight: number, padX: number, padY: number): Box {
  return { x: -widest / 2 - padX, y: -blockHeight / 2 - padY, w: widest + padX * 2, h: blockHeight + padY * 2 };
}

/**
 * Endpoints of a linear gradient through a box at an angle.
 * @param box the area to cover.
 * @param angleDeg 0 = left→right, 90 = top→bottom.
 * @returns `[x0, y0, x1, y1]`.
 */
export function gradientEndpoints(box: Box, angleDeg: number): [number, number, number, number] {
  const a = (angleDeg * Math.PI) / 180;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // Half the projection of the box on the direction: the gradient spans it exactly.
  const half = (Math.abs(Math.cos(a)) * box.w + Math.abs(Math.sin(a)) * box.h) / 2;
  const dx = Math.cos(a) * half;
  const dy = Math.sin(a) * half;
  return [cx - dx, cy - dy, cx + dx, cy + dy];
}

/** A rounded rectangle path (manual arcs when `roundRect` is missing). */
function plate(ctx: TextEngineContext, box: Box, radius: number): void {
  const r = Math.max(0, Math.min(radius, box.w / 2, box.h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(box.x, box.y, box.w, box.h, r);
    return;
  }
  const { x, y, w, h } = box;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

function setShadow(ctx: TextEngineContext, color: string, blur: number, x: number, y: number): void {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = x;
  ctx.shadowOffsetY = y;
}

function clearShadow(ctx: TextEngineContext): void {
  setShadow(ctx, 'rgba(0,0,0,0)', 0, 0, 0);
}

/** Options of {@link renderAdvancedText}. */
export interface AdvancedTextOptions {
  /** Seconds since the clip started (typewriter, caret blink). */
  localTime: number;
  /** A custom family that overrides the base family (font manager). */
  fontFamily?: string | null;
}

/** What was drawn (tests, hit-testing). */
export interface TextRenderResult {
  /** The visible text after the typewriter. */
  visible: string;
  /** The plate, when drawn. */
  box: Box | null;
  lines: string[];
}

/**
 * Draws a title with its advanced style, centred on the origin of the
 * clip's transformed space (as every clip's content is).
 * @param ctx the drawing surface.
 * @param style the base style (content, family, size, alignment, wrap).
 * @param advanced the advanced style.
 * @param frameWidth output width (fractional sizing).
 * @param frameHeight output height.
 * @param options local time and custom family.
 * @returns what was drawn.
 */
export function renderAdvancedText(
  ctx: TextEngineContext,
  style: TextStyle,
  advanced: AdvancedTextStyle,
  frameWidth: number,
  frameHeight: number,
  options: AdvancedTextOptions,
): TextRenderResult {
  const family = options.fontFamily ? `"${options.fontFamily.replace(/"/g, '')}", ${style.fontFamily}` : style.fontFamily;
  const fontPx = style.fontSize * frameHeight;
  ctx.font = `${style.italic ? 'italic ' : ''}${style.fontWeight} ${fontPx}px ${family}`;
  ctx.letterSpacing = `${style.tracking * frameHeight}px`;
  ctx.textBaseline = 'middle';
  // Lines are drawn from the left edge of their *full* width, so a line the
  // typewriter is revealing grows in place instead of re-centring.
  ctx.textAlign = 'left';

  const lineHeight = style.lineHeight * fontPx;
  const maxWidth = style.maxWidth > 0 ? style.maxWidth * frameWidth : 0;
  const lines = wrapText(ctx, style.content, maxWidth);
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width);
  const blockHeight = lines.length * lineHeight;
  const firstY = -blockHeight / 2 + lineHeight / 2;
  const lineStarts = lines.map((line) => {
    const w = ctx.measureText(line).width;
    return style.align === 'left' ? -widest / 2 : style.align === 'right' ? widest / 2 - w : -w / 2;
  });

  // Typewriter: reveal over the wrapped full text.
  const total = Array.from(style.content).length;
  const tw = advanced.typewriter;
  const progress = tw.enabled ? typewriterProgress(options.localTime, tw.duration) : 1;
  const count = Math.floor(progress * total);
  const shownLines = tw.enabled ? revealLines(lines, count) : lines;
  const visible = tw.enabled ? typewriterText(style.content, options.localTime, tw.duration) : style.content;

  const baseAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.globalAlpha = baseAlpha * style.opacity;

  // 1. Plate behind everything.
  let box: Box | null = null;
  if (advanced.background.enabled) {
    const bg = advanced.background;
    box = backgroundBox(widest, blockHeight, bg.paddingX * frameHeight, bg.paddingY * frameHeight);
    ctx.save();
    ctx.globalAlpha = baseAlpha * style.opacity * bg.opacity;
    ctx.fillStyle = bg.color;
    plate(ctx, box, bg.radius * frameHeight);
    ctx.fill();
    ctx.restore();
  }

  // 2. Fill style: solid or gradient over the text block.
  const textBox: Box = { x: -widest / 2, y: -blockHeight / 2, w: Math.max(1, widest), h: Math.max(1, blockHeight) };
  let fill: string | CanvasGradient = typeof advanced.fill === 'string' ? advanced.fill : advanced.fill[0] ?? style.color;
  if (Array.isArray(advanced.fill) && advanced.fill.length >= 2 && typeof ctx.createLinearGradient === 'function') {
    const [x0, y0, x1, y1] = gradientEndpoints(textBox, advanced.gradientAngle);
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    advanced.fill.forEach((stop, index, stops) => gradient.addColorStop(index / (stops.length - 1), stop));
    fill = gradient;
  }

  const drawLines = (paint: (text: string, x: number, y: number) => void): void => {
    shownLines.forEach((line, index) => {
      if (line !== '') paint(line, lineStarts[index] ?? 0, firstY + index * lineHeight);
    });
  };

  // 3. Glow: a coloured zero-offset shadow, painted twice for density.
  if (advanced.glow.enabled && advanced.glow.blur > 0) {
    ctx.save();
    ctx.fillStyle = fill;
    setShadow(ctx, advanced.glow.color, advanced.glow.blur * frameHeight, 0, 0);
    for (let pass = 0; pass < 2; pass += 1) drawLines((text, x, y) => ctx.fillText(text, x, y));
    ctx.restore();
  }

  // 4. Stroke under the fill (twice the width: the fill covers the inner half).
  if (advanced.stroke.enabled && advanced.stroke.width > 0) {
    ctx.save();
    if (advanced.shadow.enabled) {
      const sh = advanced.shadow;
      setShadow(ctx, sh.color, sh.blur * frameHeight, sh.offsetX * frameHeight, sh.offsetY * frameHeight);
    }
    ctx.lineWidth = advanced.stroke.width * frameHeight * 2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = advanced.stroke.color;
    drawLines((text, x, y) => ctx.strokeText(text, x, y));
    ctx.restore();
  }

  // 5. Fill, with the drop shadow unless the stroke already cast it.
  ctx.save();
  if (advanced.shadow.enabled && !(advanced.stroke.enabled && advanced.stroke.width > 0)) {
    const sh = advanced.shadow;
    setShadow(ctx, sh.color, sh.blur * frameHeight, sh.offsetX * frameHeight, sh.offsetY * frameHeight);
  } else {
    clearShadow(ctx);
  }
  ctx.fillStyle = fill;
  drawLines((text, x, y) => ctx.fillText(text, x, y));
  ctx.restore();

  // 6. Caret: blinks at 2 Hz while typing, then disappears.
  if (tw.enabled && tw.cursor && progress < 1 && Math.floor(options.localTime * 4) % 2 === 0) {
    let lineIndex = 0;
    shownLines.forEach((line, index) => {
      if (line !== '') lineIndex = index;
    });
    const shownWidth = ctx.measureText(shownLines[lineIndex] ?? '').width;
    const start = lineStarts[lineIndex] ?? 0;
    ctx.fillStyle = typeof advanced.fill === 'string' ? advanced.fill : advanced.fill[0] ?? style.color;
    ctx.fillRect(start + shownWidth + fontPx * 0.05, firstY + lineIndex * lineHeight - fontPx * 0.45, Math.max(1, fontPx * 0.06), fontPx * 0.9);
  }

  ctx.restore();
  ctx.letterSpacing = '0px';
  return { visible, box, lines: shownLines };
}
