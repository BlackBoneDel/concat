// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 7: the editor's icon set — inline SVG only, no font, no library, no
 * network. Every glyph is drawn on a 24×24 grid with a 2 px round stroke in
 * `currentColor`, so icons inherit the theme through CSS `color` (the three
 * palettes of `theme-manager.ts`) and stay crisp at any zoom.
 *
 * Two outputs share one table: {@link icon} builds a live `SVGSVGElement`
 * (what the UI uses — no `innerHTML`, CSP-friendly) and {@link iconMarkup}
 * returns the equivalent string (docs, tests, static HTML). Decorative icons
 * are `aria-hidden`; pass a `label` for a standalone, announced icon.
 * {@link iconButton} is the standard `.concat-icon-btn` control.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One SVG child element: tag plus attributes. */
type Shape = readonly [tag: 'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'polygon', attributes: Readonly<Record<string, string | number>>];

const path = (d: string, extra: Record<string, string | number> = {}): Shape => ['path', { d, ...extra }];
const circle = (cx: number, cy: number, r: number, extra: Record<string, string | number> = {}): Shape => ['circle', { cx, cy, r, ...extra }];
const rect = (x: number, y: number, width: number, height: number, rx = 0, extra: Record<string, string | number> = {}): Shape => ['rect', { x, y, width, height, rx, ...extra }];
const line = (x1: number, y1: number, x2: number, y2: number): Shape => ['line', { x1, y1, x2, y2 }];
const polyline = (points: string): Shape => ['polyline', { points }];
const polygon = (points: string, extra: Record<string, string | number> = {}): Shape => ['polygon', { points, ...extra }];

/**
 * An 8-tooth cog outline centred on (12, 12): teeth alternate between the
 * outer and the root radius with flat tops, which reads as a gear at 14 px.
 * @returns the path data.
 */
function gearPath(): string {
  const teeth = 8;
  const outer = 10;
  const root = 7.6;
  const half = Math.PI / teeth;
  const points: string[] = [];
  for (let i = 0; i < teeth; i += 1) {
    const centre = (i / teeth) * Math.PI * 2;
    const angles = [centre - half * 0.95, centre - half * 0.45, centre + half * 0.45, centre + half * 0.95];
    const radii = [root, outer, outer, root];
    for (let k = 0; k < 4; k += 1) {
      const a = angles[k] ?? 0;
      const r = radii[k] ?? root;
      points.push(`${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`);
    }
  }
  return `M${points.join('L')}Z`;
}

const DIAMOND = 'M12 2.5 21.5 12 12 21.5 2.5 12Z';
const SPEAKER = '11 5 6 9 2 9 2 15 6 15 11 19 11 5';
const LOCK_BODY = rect(4, 11, 16, 10, 2);

/** Every glyph, by name. */
const ICONS = {
  // -- playback --------------------------------------------------------------
  play: [polygon('7 4 20 12 7 20 7 4', { fill: 'currentColor' })],
  pause: [rect(6, 4, 4, 16, 1, { fill: 'currentColor' }), rect(14, 4, 4, 16, 1, { fill: 'currentColor' })],
  stop: [rect(5, 5, 14, 14, 2, { fill: 'currentColor' })],
  skipBack: [polygon('19 20 9 12 19 4 19 20'), line(5, 19, 5, 5)],
  skipForward: [polygon('5 4 15 12 5 20 5 4'), line(19, 5, 19, 19)],
  stepBack: [polyline('16 18 10 12 16 6'), line(6, 6, 6, 18)],
  stepForward: [polyline('8 6 14 12 8 18'), line(18, 6, 18, 18)],
  loop: [path('m17 2 4 4-4 4'), path('M3 11v-1a4 4 0 0 1 4-4h14'), path('m7 22-4-4 4-4'), path('M21 13v1a4 4 0 0 1-4 4H3')],
  // -- timeline tools ----------------------------------------------------------
  select: [path('M5 3v16l4.5-4.5 3 6.5 2.6-1.2-3-6.3H18Z')],
  split: [circle(6, 6, 3), circle(6, 18, 3), line(20, 4, 8.12, 15.88), line(14.47, 14.48, 20, 20), line(8.12, 8.12, 12, 12)],
  ripple: [line(12, 4, 12, 20), path('M2 12h7'), path('m6 9 3 3-3 3'), path('M22 12h-7'), path('m18 9-3 3 3 3')],
  roll: [line(12, 3, 12, 21), path('M4 12h16'), path('m7 9-3 3 3 3'), path('m17 9 3 3-3 3')],
  slip: [rect(3, 6, 18, 12, 2), path('M8 12h8'), path('m10 10-2 2 2 2'), path('m14 10 2 2-2 2')],
  slide: [line(3, 7, 3, 21), line(21, 7, 21, 21), rect(7, 10, 10, 9, 1.5), path('M8 5h8'), path('m10 3-2 2 2 2'), path('m14 3 2 2-2 2')],
  pen: [path('M12 20h9'), path('M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z')],
  magnet: [path('M4 3h5v9a3 3 0 0 0 6 0V3h5v9a8 8 0 0 1-16 0Z'), path('M4 8h5'), path('M15 8h5')],
  // -- track controls ----------------------------------------------------------
  eye: [path('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z'), circle(12, 12, 3)],
  eyeOff: [
    path('M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a13.2 13.2 0 0 1-1.67 2.68'),
    path('M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.39-1.61'),
    path('M14.12 14.12a3 3 0 1 1-4.24-4.24'),
    line(2, 2, 22, 22),
  ],
  lock: [LOCK_BODY, path('M8 11V7a4 4 0 0 1 8 0v4')],
  unlock: [LOCK_BODY, path('M8 11V7a4 4 0 0 1 7.9-.9')],
  volumeOn: [polygon(SPEAKER), path('M15.5 8.5a5 5 0 0 1 0 7'), path('M19 5a10 10 0 0 1 0 14')],
  volumeMute: [polygon(SPEAKER), line(22, 9, 16, 15), line(16, 9, 22, 15)],
  headphones: [
    path('M3 18v-6a9 9 0 0 1 18 0v6'),
    path('M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z'),
    path('M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3Z'),
  ],
  collapse: [path('m7 20 5-5 5 5'), path('m7 4 5 5 5-5')],
  expand: [path('m7 15 5 5 5-5'), path('m7 9 5-5 5 5')],
  arrowUp: [path('M12 19V5'), path('m5 12 7-7 7 7')],
  arrowDown: [path('M12 5v14'), path('m19 12-7 7-7-7')],
  chevronDown: [path('m6 9 6 6 6-6')],
  chevronUp: [path('m18 15-6-6-6 6')],
  chevronRight: [path('m9 18 6-6-6-6')],
  videoPlus: [rect(2, 6, 14, 12, 2), path('m16 10 6-3.5v11L16 14'), path('M9 9v6'), path('M6 12h6')],
  audioPlus: [path('M2 10v4'), path('M6 7v10'), path('M10 4v16'), path('M14 9v6'), path('M19 8v6'), path('M16 11h6')],
  // -- inspector / editing -----------------------------------------------------
  keyframeEmpty: [path(DIAMOND)],
  keyframeFilled: [path(DIAMOND, { fill: 'currentColor' })],
  keyframeAdd: [path('M10 5.5 16.5 12 10 18.5 3.5 12Z'), path('M19 3v6'), path('M16 6h6')],
  link: [path('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'), path('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71')],
  unlink: [
    path('m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71'),
    path('m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71'),
    path('M8 2v3'),
    path('M2 8h3'),
    path('M16 22v-3'),
    path('M22 16h-3'),
  ],
  group: [rect(3, 3, 11, 11, 2), rect(10, 10, 11, 11, 2)],
  duplicate: [rect(9, 9, 12, 12, 2), path('M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1')],
  marker: [path('M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z'), circle(12, 10, 3)],
  trash: [path('M3 6h18'), path('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'), path('M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'), line(10, 11, 10, 17), line(14, 11, 14, 17)],
  grip: [
    circle(9, 5, 1, { fill: 'currentColor' }),
    circle(9, 12, 1, { fill: 'currentColor' }),
    circle(9, 19, 1, { fill: 'currentColor' }),
    circle(15, 5, 1, { fill: 'currentColor' }),
    circle(15, 12, 1, { fill: 'currentColor' }),
    circle(15, 19, 1, { fill: 'currentColor' }),
  ],
  music: [path('M9 18V5l12-2v13'), circle(6, 18, 3), circle(18, 16, 3)],
  // -- Fase 8: HUD estilo CapCut ------------------------------------------------
  hand: [
    path('M18 11V6a2 2 0 0 0-4 0v5'),
    path('M14 10V4a2 2 0 0 0-4 0v2'),
    path('M10 10.5V6a2 2 0 0 0-4 0v8'),
    path('M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8v-1a2 2 0 0 1 4 0'),
  ],
  text: [path('M4 7V5h16v2'), path('M12 5v14'), path('M9 19h6')],
  cursor: [path('M4 3l7.5 17 2.3-6.7 6.7-2.3Z')],
  film: [rect(2.5, 4, 19, 16, 2), line(7, 4, 7, 20), line(17, 4, 17, 20), line(2.5, 9, 21.5, 9), line(2.5, 15, 21.5, 15)],
  sparkles: [
    path('M11 3l1.9 4.6L17.5 9.5l-4.6 1.9L11 16l-1.9-4.6L4.5 9.5l4.6-1.9Z'),
    path('M19 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z'),
  ],
  sliders: [
    line(4, 21, 4, 14),
    line(4, 10, 4, 3),
    line(12, 21, 12, 12),
    line(12, 8, 12, 3),
    line(20, 21, 20, 16),
    line(20, 12, 20, 3),
    line(1, 14, 7, 14),
    line(9, 8, 15, 8),
    line(17, 16, 23, 16),
  ],
  layers: [polygon('12 2 2 7 12 12 22 7 12 2'), polyline('2 17 12 22 22 17'), polyline('2 12 12 17 22 12')],
  layoutGrid: [rect(3, 3, 7, 7, 1), rect(14, 3, 7, 7, 1), rect(14, 14, 7, 7, 1), rect(3, 14, 7, 7, 1)],
  folder: [path('M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z')],
  panelLeft: [rect(3, 3, 18, 18, 2), line(9, 3, 9, 21)],
  // -- system ------------------------------------------------------------------
  settings: [path(gearPath()), circle(12, 12, 3)],
  export: [path('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), polyline('17 8 12 3 7 8'), line(12, 3, 12, 15)],
  sun: [
    circle(12, 12, 4),
    path('M12 2v2'),
    path('M12 20v2'),
    path('m4.93 4.93 1.41 1.41'),
    path('m17.66 17.66 1.41 1.41'),
    path('M2 12h2'),
    path('M20 12h2'),
    path('m6.34 17.66-1.41 1.41'),
    path('m19.07 4.93-1.41 1.41'),
  ],
  moon: [path('M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z')],
  zap: [polygon('13 2 3 14 12 14 11 22 21 10 12 10 13 2')],
  menu: [line(4, 6, 20, 6), line(4, 12, 20, 12), line(4, 18, 20, 18)],
  keyboard: [rect(2, 6, 20, 12, 2), path('M6 10h.01'), path('M10 10h.01'), path('M14 10h.01'), path('M18 10h.01'), path('M8 14h8')],
  undo: [path('M9 14 4 9l5-5'), path('M4 9h10.5a5.5 5.5 0 0 1 0 11H11')],
  redo: [path('m15 14 5-5-5-5'), path('M20 9H9.5a5.5 5.5 0 0 0 0 11H13')],
  save: [path('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z'), polyline('17 21 17 13 7 13 7 21'), polyline('7 3 7 8 15 8')],
  plus: [path('M12 5v14'), path('M5 12h14')],
  minus: [path('M5 12h14')],
  zoomIn: [circle(11, 11, 7), line(21, 21, 16.65, 16.65), path('M11 8v6'), path('M8 11h6')],
  zoomOut: [circle(11, 11, 7), line(21, 21, 16.65, 16.65), path('M8 11h6')],
  fit: [path('M8 3H5a2 2 0 0 0-2 2v3'), path('M21 8V5a2 2 0 0 0-2-2h-3'), path('M3 16v3a2 2 0 0 0 2 2h3'), path('M16 21h3a2 2 0 0 0 2-2v-3')],
  check: [polyline('20 6 9 17 4 12')],
  close: [path('M18 6 6 18'), path('m6 6 12 12')],
  alert: [path('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z'), path('M12 9v4'), path('M12 17h.01')],
} as const satisfies Record<string, readonly Shape[]>;

/** A glyph name. */
export type IconName = keyof typeof ICONS;

/** Every glyph name, in table order (tests, docs, pickers). */
export const ICON_NAMES: readonly IconName[] = Object.freeze(Object.keys(ICONS).filter((name): name is IconName => name in ICONS));

/** Options of {@link icon} / {@link iconMarkup}. */
export interface IconOptions {
  /** Pixel size (width = height). 18 by default. */
  size?: number;
  /** An accessible name: the icon becomes `role="img"` instead of hidden. */
  label?: string;
  /** Extra classes. */
  className?: string;
  /** Stroke width on the 24-unit grid. 2 by default. */
  strokeWidth?: number;
}

/**
 * `keyframeFilled` → `keyframe-filled`, for the per-icon class.
 * @param name the glyph.
 * @returns the kebab-case form.
 */
export function iconSlug(name: IconName): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** The root attributes shared by both outputs. */
function rootAttributes(name: IconName, options: IconOptions): [string, string][] {
  const size = String(options.size ?? 18);
  const classes = ['concat-icon', `concat-icon-${iconSlug(name)}`, options.className ?? ''].filter(Boolean).join(' ');
  const attributes: [string, string][] = [
    ['width', size],
    ['height', size],
    ['viewBox', '0 0 24 24'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', String(options.strokeWidth ?? 2)],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
    ['class', classes],
    ['focusable', 'false'],
    ['data-icon', name],
  ];
  if (options.label) attributes.push(['role', 'img'], ['aria-label', options.label]);
  else attributes.push(['aria-hidden', 'true']);
  return attributes;
}

/**
 * Builds a live SVG icon.
 * @param name the glyph.
 * @param options size, label, classes.
 * @returns the `<svg>` element.
 */
export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of rootAttributes(name, options)) svg.setAttribute(key, value);
  if (options.label) {
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = options.label;
    svg.appendChild(title);
  }
  for (const [tag, attributes] of ICONS[name]) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, String(value));
    svg.appendChild(child);
  }
  return svg;
}

const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The same icon as markup.
 * @param name the glyph.
 * @param options size, label, classes.
 * @returns an `<svg …>…</svg>` string with the xmlns set.
 */
export function iconMarkup(name: IconName, options: IconOptions = {}): string {
  const attributes = [['xmlns', SVG_NS], ...rootAttributes(name, options)]
    .map(([key, value]) => `${key}="${escapeAttribute(value ?? '')}"`)
    .join(' ');
  const title = options.label ? `<title>${escapeAttribute(options.label)}</title>` : '';
  const children = ICONS[name]
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([key, value]) => `${key}="${escapeAttribute(String(value))}"`).join(' ')}/>`)
    .join('');
  return `<svg ${attributes}>${title}${children}</svg>`;
}

/**
 * Fase 8: shorthand for a live SVG icon at a given size — what the HUD's
 * builders use when they only need the glyph.
 * @param name the glyph.
 * @param size pixel size (18 by default).
 * @returns the `<svg>` element.
 */
export function createIconElement(name: IconName, size = 18): SVGSVGElement {
  return icon(name, { size });
}

/** Options of {@link iconButton}. */
export interface IconButtonOptions {
  icon: IconName;
  /** Accessible name and tooltip ("Cuchilla"). */
  label: string;
  /** Shown in the tooltip: "Cuchilla (C)". */
  shortcut?: string;
  onClick?: (event: MouseEvent) => void;
  /** Extra classes (e.g. the Fase 3 hooks tests and CSS rely on). */
  className?: string;
  /** Renders as a toggle (`aria-pressed`). */
  pressed?: boolean;
  /** Icon pixel size; 18 by default. */
  size?: number;
  /** Visible text next to the icon. */
  text?: string;
  signal?: AbortSignal;
}

/**
 * The tooltip text: label plus shortcut.
 * @param label the action.
 * @param shortcut the key, if any.
 * @returns e.g. "Cuchilla (C)".
 */
export function tooltipFor(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/**
 * The standard icon button (`.concat-icon-btn`).
 * @param options glyph, label, shortcut, handler.
 * @returns the button.
 */
export function iconButton(options: IconButtonOptions): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['concat-icon-btn', options.text ? 'has-text' : '', options.className ?? ''].filter(Boolean).join(' ');
  button.title = tooltipFor(options.label, options.shortcut);
  button.setAttribute('aria-label', options.label);
  if (options.shortcut) button.setAttribute('aria-keyshortcuts', options.shortcut.replace(/Ctrl/g, 'Control'));
  if (options.pressed !== undefined) setPressed(button, options.pressed);
  button.appendChild(icon(options.icon, { size: options.size }));
  if (options.text) {
    const text = document.createElement('span');
    text.className = 'concat-icon-btn-text';
    text.textContent = options.text;
    button.appendChild(text);
  }
  if (options.onClick) button.addEventListener('click', options.onClick, options.signal ? { signal: options.signal } : undefined);
  return button;
}

/**
 * Swaps the glyph of an icon button (play ↔ pause, eye ↔ eye-off), keeping
 * any text label.
 * @param button the button.
 * @param name the new glyph.
 */
export function setButtonIcon(button: HTMLElement, name: IconName): void {
  const current = button.querySelector('svg.concat-icon');
  if (current?.getAttribute('data-icon') === name) return;
  const size = Number(current?.getAttribute('width') ?? 18) || 18;
  const next = icon(name, { size });
  if (current) current.replaceWith(next);
  else button.prepend(next);
}

/**
 * Reflects a toggle: `aria-pressed` and the `.active` class together.
 * @param button the toggle.
 * @param pressed its state.
 */
export function setPressed(button: HTMLElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', String(pressed));
  button.classList.toggle('active', pressed);
}
