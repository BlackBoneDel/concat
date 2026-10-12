// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 video effects — the pixel maths, twice: CPU functions over RGBA
 * buffers (Canvas 2D fallback, export, tests) and the GLSL ES 3.0 fragment
 * shaders the WebGL2 engine runs. Both use the same integer hash, so noise
 * and glitch bands land on the same pixels on either backend.
 *
 * Effects (parameters in `effects-stack.ts`):
 * - **Gaussian blur**: separable, two passes (horizontal then vertical), σ = radius / 2,
 *   kernel truncated at 3σ and renormalised (edges clamp).
 * - **Vignette**: aspect-correct distance from the centre, darkened by
 *   `amount · smoothstep(radius − softness, radius, d)`.
 * - **Pixelate**: `uv' = floor(uv · blocks) / blocks` (square cells: the
 *   vertical block count follows the aspect ratio), sampled at cell centres.
 * - **Noise**: monochrome grain from `hash(x, y, floor(time · speed))`.
 * - **Glitch**: per-frame horizontal band offsets + RGB channel split.
 *
 * The approach follows `concat-effects/src/shader.rs` (one full-screen pass per
 * effect, ping-pong between two targets).
 */

/** A mutable RGBA image (ImageData-compatible). */
export interface PixelImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * 32-bit integer hash → `[0, 1)`. Same constants as the GLSL `hash3`.
 * @param x integer.
 * @param y integer.
 * @param z integer (frame / band seed).
 * @returns a uniform pseudo-random number.
 */
export function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/**
 * Normalised 1-D Gaussian kernel.
 * @param radius blur radius in pixels (σ = radius / 2).
 * @returns weights from −half to +half (sum = 1).
 */
export function gaussianKernel(radius: number): Float32Array {
  const sigma = Math.max(0.01, radius / 2);
  const half = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(half * 2 + 1);
  let sum = 0;
  for (let i = -half; i <= half; i += 1) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + half] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] = kernel[i]! / sum;
  return kernel;
}

/** One separable pass (premultiplied so transparent pixels do not bleed dark). */
function blurPass(src: Float32Array, dst: Float32Array, width: number, height: number, kernel: Float32Array, horizontal: boolean): void {
  const half = (kernel.length - 1) >> 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = -half; k <= half; k += 1) {
        const sx = horizontal ? Math.min(width - 1, Math.max(0, x + k)) : x;
        const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + k));
        const i = (sy * width + sx) * 4;
        const w = kernel[k + half]!;
        r += src[i]! * w;
        g += src[i + 1]! * w;
        b += src[i + 2]! * w;
        a += src[i + 3]! * w;
      }
      const o = (y * width + x) * 4;
      dst[o] = r;
      dst[o + 1] = g;
      dst[o + 2] = b;
      dst[o + 3] = a;
    }
  }
}

/**
 * Two-pass Gaussian blur, in place.
 * @param image the picture.
 * @param radius pixels (0 = untouched).
 */
export function gaussianBlur(image: PixelImage, radius: number): void {
  if (!(radius >= 0.25)) return;
  const { data, width, height } = image;
  const n = width * height * 4;
  const a = new Float32Array(n);
  // Premultiply.
  for (let i = 0; i < n; i += 4) {
    const alpha = data[i + 3]! / 255;
    a[i] = data[i]! * alpha;
    a[i + 1] = data[i + 1]! * alpha;
    a[i + 2] = data[i + 2]! * alpha;
    a[i + 3] = data[i + 3]!;
  }
  const b = new Float32Array(n);
  const kernel = gaussianKernel(radius);
  blurPass(a, b, width, height, kernel, true);
  blurPass(b, a, width, height, kernel, false);
  for (let i = 0; i < n; i += 4) {
    const alpha = a[i + 3]!;
    const inv = alpha > 0 ? 255 / alpha : 0;
    data[i] = a[i]! * inv;
    data[i + 1] = a[i + 1]! * inv;
    data[i + 2] = a[i + 2]! * inv;
    data[i + 3] = alpha;
  }
}

/** GLSL-style smoothstep. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Vignette darkening factor at a pixel centre (1 = untouched).
 * @param u horizontal position 0..1.
 * @param v vertical position 0..1.
 * @param aspect width / height.
 * @param params radius/softness/amount.
 * @returns the multiplier.
 */
export function vignetteFactor(u: number, v: number, aspect: number, params: { radius: number; softness: number; amount: number }): number {
  // Distance normalised so the corner is 1 whatever the aspect.
  const dx = (u - 0.5) * aspect;
  const dy = v - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy) / Math.sqrt(0.25 * aspect * aspect + 0.25);
  return 1 - params.amount * smoothstep(params.radius - params.softness, params.radius, d);
}

/**
 * Vignette, in place.
 * @param image the picture.
 * @param params radius (0.1–1.5), softness, amount.
 */
export function vignette(image: PixelImage, params: { radius: number; softness: number; amount: number }): void {
  if (params.amount <= 0) return;
  const { data, width, height } = image;
  const aspect = width / Math.max(1, height);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const f = vignetteFactor((x + 0.5) / width, v, aspect, params);
      const i = (y * width + x) * 4;
      data[i] = data[i]! * f;
      data[i + 1] = data[i + 1]! * f;
      data[i + 2] = data[i + 2]! * f;
    }
  }
}

/**
 * The number of vertical cells for square pixels.
 * @param blocks horizontal cell count.
 * @param width image width.
 * @param height image height.
 * @returns vertical cell count (≥1).
 */
export function pixelateRows(blocks: number, width: number, height: number): number {
  return Math.max(1, Math.round((blocks * height) / Math.max(1, width)));
}

/**
 * Pixelate: every pixel takes the colour at its cell's centre,
 * `uv' = (floor(uv · blocks) + 0.5) / blocks`.
 * @param image the picture (rewritten).
 * @param blocks horizontal cell count.
 */
export function pixelate(image: PixelImage, blocks: number): void {
  const { data, width, height } = image;
  const bx = Math.max(1, Math.round(blocks));
  const by = pixelateRows(bx, width, height);
  const src = data.slice();
  for (let y = 0; y < height; y += 1) {
    const cy = Math.floor(((y + 0.5) / height) * by);
    const sy = Math.min(height - 1, Math.floor(((cy + 0.5) / by) * height));
    for (let x = 0; x < width; x += 1) {
      const cx = Math.floor(((x + 0.5) / width) * bx);
      const sx = Math.min(width - 1, Math.floor(((cx + 0.5) / bx) * width));
      const i = (y * width + x) * 4;
      const s = (sy * width + sx) * 4;
      data[i] = src[s]!;
      data[i + 1] = src[s + 1]!;
      data[i + 2] = src[s + 2]!;
      data[i + 3] = src[s + 3]!;
    }
  }
}

/**
 * The noise frame index: grain changes `speed` times per second.
 * @param time clip-local seconds.
 * @param speed frames per second (0 = static grain).
 * @returns integer seed.
 */
export function noiseFrame(time: number, speed: number): number {
  return speed <= 0 ? 0 : Math.floor(Math.max(0, time) * speed);
}

/**
 * Animated monochrome film grain, in place.
 * @param image the picture.
 * @param params amount 0..1, speed in fps.
 * @param time clip-local seconds.
 */
export function noise(image: PixelImage, params: { amount: number; speed: number }, time: number): void {
  if (params.amount <= 0) return;
  const { data, width, height } = image;
  const frame = noiseFrame(time, params.speed);
  const strength = params.amount * 255;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const n = (hash3(x, y, frame) - 0.5) * strength;
      const i = (y * width + x) * 4;
      data[i] = data[i]! + n;
      data[i + 1] = data[i + 1]! + n;
      data[i + 2] = data[i + 2]! + n;
    }
  }
}

/**
 * The horizontal offset (fraction of the width) of one glitch band.
 * @param band band index.
 * @param frame time seed.
 * @param amount 0..1.
 * @returns offset in −0.05·amount … +0.05·amount, or 0 for a still band.
 */
export function glitchBandOffset(band: number, frame: number, amount: number): number {
  if (hash3(band, frame, 7) >= amount * 0.6) return 0;
  return (hash3(band, frame, 13) - 0.5) * 0.1 * amount;
}

/**
 * Glitch: displaced horizontal bands plus an RGB split, rewritten in place.
 * @param image the picture.
 * @param params amount, rgbShift (fraction of width), bands, speed (Hz).
 * @param time clip-local seconds.
 */
export function glitch(image: PixelImage, params: { amount: number; rgbShift: number; bands: number; speed: number }, time: number): void {
  if (params.amount <= 0) return;
  const { data, width, height } = image;
  const src = data.slice();
  const frame = noiseFrame(time, params.speed);
  const bands = Math.max(1, Math.round(params.bands));
  const shift = params.rgbShift * params.amount * width;
  const sample = (x: number, y: number, channel: number): number => {
    const sx = Math.min(width - 1, Math.max(0, Math.round(x)));
    return src[(y * width + sx) * 4 + channel]!;
  };
  for (let y = 0; y < height; y += 1) {
    const band = Math.floor((y / height) * bands);
    const offset = glitchBandOffset(band, frame, params.amount) * width;
    for (let x = 0; x < width; x += 1) {
      const base = x - offset;
      const i = (y * width + x) * 4;
      data[i] = sample(base + shift, y, 0);
      data[i + 1] = sample(base, y, 1);
      data[i + 2] = sample(base - shift, y, 2);
      data[i + 3] = sample(base, y, 3);
    }
  }
}

/** A video effect as the engines see it. */
export interface VideoEffectPass {
  type: string;
  params: Readonly<Record<string, number>>;
}

/**
 * Applies one effect on the CPU.
 * @param image the picture (modified in place).
 * @param effect the effect and its parameters.
 * @param time clip-local seconds (noise/glitch).
 * @param scale how many source pixels one image pixel stands for (blur radius
 *   is in source pixels; the engine may blur a downscaled copy).
 */
export function applyVideoEffectCpu(image: PixelImage, effect: VideoEffectPass, time: number, scale = 1): void {
  const p = effect.params;
  switch (effect.type) {
    case 'blur':
      gaussianBlur(image, (p['radius'] ?? 0) / Math.max(1e-6, scale));
      break;
    case 'vignette':
      vignette(image, { radius: p['radius'] ?? 0.75, softness: p['softness'] ?? 0.45, amount: p['amount'] ?? 0.8 });
      break;
    case 'pixelate':
      pixelate(image, p['blocks'] ?? 64);
      break;
    case 'noise':
      noise(image, { amount: p['amount'] ?? 0.2, speed: p['speed'] ?? 24 }, time);
      break;
    case 'glitch':
      glitch(image, { amount: p['amount'] ?? 0.5, rgbShift: p['rgbShift'] ?? 0.012, bands: p['bands'] ?? 12, speed: p['speed'] ?? 10 }, time);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// GLSL ES 3.00 — one full-screen pass per effect (ping-pong in the engine).
// ---------------------------------------------------------------------------

/** Shared vertex shader: a full-screen triangle pair with uv in 0..1 (top-left origin). */
export const EFFECT_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
uniform float u_flipY; // -1 when rendering into a framebuffer texture
out vec2 v_uv;
void main() {
  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  gl_Position = vec4(a_position.x, a_position.y * u_flipY, 0.0, 1.0);
}`;

const HASH_GLSL = `
float hash3(uint x, uint y, uint z) {
  uint h = x * 374761393u + y * 668265263u + z * 1274126177u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h) / 4294967296.0;
}`;

/** Fragment shaders by effect (`blur` runs twice with `u_direction`). */
export const EFFECT_FRAGMENT_SHADERS: Readonly<Record<'blur' | 'vignette' | 'pixelate' | 'noise' | 'glitch', string>> = Object.freeze({
  blur: `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform vec2 u_texel;      // 1 / size
uniform vec2 u_direction;  // (1,0) then (0,1)
uniform float u_sigma;
void main() {
  int half_ = int(ceil(u_sigma * 3.0));
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -96; i <= 96; i++) {
    if (i < -half_ || i > half_) continue;
    float w = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    vec4 c = texture(u_image, clamp(v_uv + u_direction * u_texel * float(i), vec2(0.0), vec2(1.0)));
    sum += vec4(c.rgb * c.a, c.a) * w;
    total += w;
  }
  sum /= total;
  outColor = sum.a > 0.0 ? vec4(sum.rgb / sum.a, sum.a) : vec4(0.0);
}`,
  vignette: `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform float u_aspect;
uniform float u_radius;
uniform float u_softness;
uniform float u_amount;
void main() {
  vec4 c = texture(u_image, v_uv);
  vec2 d2 = (v_uv - 0.5) * vec2(u_aspect, 1.0);
  float d = length(d2) / sqrt(0.25 * u_aspect * u_aspect + 0.25);
  float f = 1.0 - u_amount * smoothstep(u_radius - u_softness, u_radius, d);
  outColor = vec4(c.rgb * f, c.a);
}`,
  pixelate: `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform vec2 u_blocks;  // cells across, cells down
void main() {
  vec2 cell = (floor(v_uv * u_blocks) + 0.5) / u_blocks;
  outColor = texture(u_image, cell);
}`,
  noise: `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform vec2 u_size;
uniform float u_amount;
uniform float u_frame;
${HASH_GLSL}
void main() {
  vec4 c = texture(u_image, v_uv);
  uvec2 p = uvec2(floor(v_uv * u_size));
  float n = hash3(p.x, p.y, uint(u_frame)) - 0.5;
  outColor = vec4(clamp(c.rgb + n * u_amount, 0.0, 1.0), c.a);
}`,
  glitch: `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform float u_amount;
uniform float u_shift;
uniform float u_bands;
uniform float u_frame;
${HASH_GLSL}
void main() {
  uint band = uint(floor(v_uv.y * u_bands));
  uint frame = uint(u_frame);
  float offset = 0.0;
  if (hash3(band, frame, 7u) < u_amount * 0.6) offset = (hash3(band, frame, 13u) - 0.5) * 0.1 * u_amount;
  float x = v_uv.x - offset;
  float s = u_shift * u_amount;
  float r = texture(u_image, vec2(clamp(x + s, 0.0, 1.0), v_uv.y)).r;
  vec4 g = texture(u_image, vec2(clamp(x, 0.0, 1.0), v_uv.y));
  float b = texture(u_image, vec2(clamp(x - s, 0.0, 1.0), v_uv.y)).b;
  outColor = vec4(r, g.g, b, g.a);
}`,
});
