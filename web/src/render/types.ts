// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Structural types the render module draws through.
 *
 * They are the *subset* of the DOM canvas types the compositor uses, so real
 * canvases satisfy them as-is and tests can stand up recording doubles
 * without a cast anywhere.
 */

/** Something the compositor can blit: a decoded frame, a bitmap, a still,
 * a live video element or a canvas. */
export type RenderImage =
  | ImageBitmap
  | VideoFrame
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | OffscreenCanvas;

/** The 2D drawing surface the compositor paints on. */
export interface RenderContext2D {
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: RenderImage, dx: number, dy: number): void;
  drawImage(image: RenderImage, dx: number, dy: number, dw: number, dh: number): void;
  drawImage(
    image: RenderImage,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: 'round' | 'bevel' | 'miter';
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  font: string;
  textAlign: string;
  textBaseline: string;
  letterSpacing: string;
}

/** A canvas (or offscreen canvas) the compositor renders into. */
export interface RenderTarget {
  width: number;
  height: number;
  getContext(type: '2d'): RenderContext2D | null;
}

/** Where the compositor gets decoded frames. Implemented by `MediaPool`. */
export interface FramePool {
  /** The picture at `sourceTime` of the media `id`, or `null` while it is
   * still decoding. Live video elements may be returned as-is. */
  getFrame(id: string, sourceTime: import('../core/rational.ts').Rational): Promise<RenderImage | null>;
  /** Intrinsic pixel size of the media, for aspect-fitting. */
  getSize(id: string): { width: number; height: number } | null;
}

/** The intrinsic pixel size of any drawable. */
export function intrinsicSize(image: RenderImage): { width: number; height: number } {
  if ('displayWidth' in image) {
    return { width: image.displayWidth, height: image.displayHeight };
  }
  if ('videoWidth' in image) {
    return { width: image.videoWidth, height: image.videoHeight };
  }
  return { width: image.width, height: image.height };
}

/** A point in frame space. */
export interface Point {
  x: number;
  y: number;
}
