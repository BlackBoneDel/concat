// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the export dialog. Four views on one accessible dialog:
 *
 * - **config** — preset, container/codecs, size, rate, bitrates, range,
 *   subtitles burn-in, proxy fallback (off), hardware preference, GIF
 *   options, file name and a live size estimate;
 * - **running** — ≤ 480 px preview, progress bar, phase/fps/ETA/bytes, an
 *   `aria-live` status and a confirmed cancel;
 * - **done** — summary, download (the ObjectURL is revoked 60 s later) and
 *   "save as" through `showSaveFilePicker` when the browser has it;
 * - **error** — the reason, what to try, and a way back to the settings.
 *
 * The dialog never closes on a backdrop click; Escape closes the config /
 * done / error views and asks before cancelling a running export.
 * Loaded on demand (its own chunk with `src/export/`).
 */

import { Rational } from '../../core/rational.ts';
import { estimateTotalBytes, formatBitrate, formatBytes, formatEta } from '../../export/bitrate-estimator.ts';
import type { ExportController } from '../../export/export-controller.ts';
import { applyPreset, EXPORT_PRESETS, getPresetById } from '../../export/export-presets.ts';
import { gifDurationWarning } from '../../export/gif-exporter.ts';
import {
  CONTAINER_AUDIO_CODECS,
  CONTAINER_VIDEO_CODECS,
  defaultExportConfig,
  EXPORT_ERROR_MESSAGES,
  toExportError,
  validateExportConfig,
  type ExportAudioCodec,
  type ExportConfig,
  type ExportError,
  type ExportFormat,
  type ExportHardware,
  type ExportPhase,
  type ExportProgress,
  type ExportResult,
  type ExportVideoCodec,
} from '../../export/types.ts';
import { downloadBlob } from '../download.ts';
import { Dialog, progressBar } from './dialog.ts';

export { downloadBlob, DOWNLOAD_REVOKE_MS } from '../download.ts';

/** What the dialog needs from the app. */
export interface ExportModalHost {
  /** A fresh controller (the dialog disposes it on close). */
  createController(): ExportController;
  projectName(): string;
  /** Timeline length in seconds. */
  timelineSeconds(): number;
  /** The marked in/out range, when one is set. */
  markedRange(): { start: Rational; end: Rational } | null;
  /** The sequence frame settings (default output size). */
  sequence(): { width: number; height: number; fps: number };
  /** WebCodecs video encoding is available. */
  webCodecs: boolean;
  /** The FFmpeg.wasm fallback is available. */
  ffmpeg: boolean;
  notify(kind: 'success' | 'error' | 'info' | 'warning', title: string, message: string): void;
  confirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
}

/** localStorage key of the last settings. */
const LAST_KEY = 'concat.export.last';
const VIDEO_CODEC_LABEL: Record<ExportVideoCodec, string> = {
  'h264-high': 'H.264 High',
  'h264-baseline': 'H.264 Baseline (máxima compatibilidad)',
  vp9: 'VP9',
  av1: 'AV1',
};
const AUDIO_CODEC_LABEL: Record<ExportAudioCodec, string> = { aac: 'AAC', opus: 'Opus', none: 'Sin audio' };
const FORMAT_LABEL: Record<ExportFormat, string> = { mp4: 'MP4', webm: 'WebM', gif: 'GIF animado' };
const PHASE_LABEL: Record<ExportPhase, string> = {
  idle: 'En espera',
  preparing: 'Preparando',
  rendering: 'Renderizando vídeo',
  'encoding-audio': 'Codificando audio',
  muxing: 'Empaquetando',
  finalizing: 'Finalizando',
  done: 'Completado',
  cancelled: 'Cancelado',
  error: 'Error',
};
const FPS_CHOICES: readonly { label: string; num: number; den: number }[] = [
  { label: '12', num: 12, den: 1 },
  { label: '15', num: 15, den: 1 },
  { label: '23,976', num: 24000, den: 1001 },
  { label: '24', num: 24, den: 1 },
  { label: '25', num: 25, den: 1 },
  { label: '29,97', num: 30000, den: 1001 },
  { label: '30', num: 30, den: 1 },
  { label: '50', num: 50, den: 1 },
  { label: '60', num: 60, den: 1 },
];
const AUDIO_BITRATES = [96_000, 128_000, 160_000, 192_000, 256_000, 320_000];

/** Suggestions per error code. */
export const EXPORT_ERROR_HINTS: Readonly<Record<ExportError['code'], string>> = Object.freeze({
  ABORTED: 'Puedes volver a exportar cuando quieras.',
  ENCODER_UNSUPPORTED: 'Prueba H.264 Baseline, una resolución menor u otro contenedor. Chrome/Edge 113+ codifican por hardware; en otros navegadores se usa FFmpeg.wasm o el GIF.',
  MUX_FAILED: 'Vuelve a intentarlo; si persiste, exporta en otro contenedor (MP4 ↔ WebM).',
  OUT_OF_MEMORY: 'Cierra otras pestañas, baja la resolución o exporta por partes con puntos de entrada/salida (I / O).',
  NO_MEDIA: 'Vuelve a vincular los originales (Archivo → Medios sin conexión) o activa «usar proxies si falta el original».',
  INVALID_RANGE: 'Revisa los puntos de entrada/salida (I / O) y los ajustes de tamaño y fotogramas.',
  UNKNOWN: 'Vuelve a intentarlo. Los detalles están en la consola del navegador.',
});

/** A save-picker function (File System Access API). */
/** The part of a `FileSystemFileHandle` the save path needs. */
export interface SaveHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

/** `showSaveFilePicker`, narrowed to what the dialog uses. */
export type SavePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle>;

function isSavePicker(value: unknown): value is SavePicker {
  return typeof value === 'function';
}

/**
 * The browser's save picker, when present.
 * @returns the bound picker, or `null`.
 */
export function savePicker(): SavePicker | null {
  if (typeof window === 'undefined') return null;
  const picker: unknown = Reflect.get(window, 'showSaveFilePicker');
  return isSavePicker(picker) ? (options) => picker.call(window, options) : null;
}

/**
 * Writes a blob through the save picker.
 * @param picker the picker.
 * @param blob the file.
 * @param fileName suggested name.
 * @param mimeType for the type filter.
 * @returns `true` when written, `false` when the user dismissed the picker.
 */
export async function saveWithPicker(picker: SavePicker, blob: Blob, fileName: string, mimeType: string): Promise<boolean> {
  const extension = fileName.slice(fileName.lastIndexOf('.'));
  let handle: SaveHandle;
  try {
    handle = await picker({ suggestedName: fileName, types: [{ description: 'Vídeo exportado', accept: { [mimeType]: [extension] } }] });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    throw error;
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return true;
}

/** Reads the remembered settings (never the range). */
function loadLast(base: ExportConfig): ExportConfig {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return base;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return base;
    const presetId = Reflect.get(parsed, 'presetId');
    if (typeof presetId === 'string' && getPresetById(presetId)) return applyPreset(presetId, base);
    return base;
  } catch {
    return base;
  }
}

function saveLast(config: ExportConfig): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ presetId: config.presetId }));
  } catch {
    // Private mode: nothing to remember.
  }
}

/** A labelled control row. */
function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field-row';
  const id = control.id || `exp-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  const text = document.createElement('label');
  text.className = 'field-label';
  text.htmlFor = id;
  text.textContent = label;
  wrap.append(text, control);
  if (hint) {
    const note = document.createElement('span');
    note.className = 'fx-note';
    note.textContent = hint;
    wrap.appendChild(note);
  }
  return wrap;
}

function select<T extends string>(options: readonly { value: T; label: string; disabled?: boolean }[], value: T): HTMLSelectElement {
  const element = document.createElement('select');
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    item.disabled = option.disabled ?? false;
    element.appendChild(item);
  }
  element.value = value;
  return element;
}

function numberInput(value: number, min: number, max: number, step: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  return input;
}

function checkbox(label: string, checked: boolean): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = document.createElement('label');
  wrap.className = 'field-row field-row-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(input, text);
  return { wrap, input };
}

/**
 * Opens the export dialog.
 * @param host app services.
 * @returns resolves when the dialog closes.
 */
export function openExportModal(host: ExportModalHost): Promise<void> {
  const dialog = new Dialog({
    title: 'Exportar vídeo',
    description: 'Se renderiza en tu navegador a partir de los originales. Nada sale de tu equipo.',
    className: 'export-modal',
    dismissible: false,
  });
  const closeButton = dialog.element.querySelector<HTMLButtonElement>('.modal-close');
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('role', 'status');
  dialog.element.appendChild(live);

  let controller: ExportController | null = null;
  let view: 'config' | 'running' | 'done' | 'error' = 'config';
  const sequence = host.sequence();
  let config: ExportConfig = loadLast({
    ...defaultExportConfig(),
    width: Math.max(16, sequence.width - (sequence.width % 2)),
    height: Math.max(16, sequence.height - (sequence.height % 2)),
    frameRate: sequence.fps === Math.round(sequence.fps) ? { num: Math.max(1, Math.round(sequence.fps)), den: 1 } : { num: Math.round(sequence.fps * 1001), den: 1001 },
    fileName: host.projectName().trim() || 'concat-export',
  });

  const disposeController = (): void => {
    controller?.dispose();
    controller = null;
  };
  dialog.onClose(disposeController);

  const requestCancel = async (): Promise<void> => {
    if (!controller?.running) return;
    const ok = await host.confirm('¿Cancelar la exportación?', 'Se perderá el progreso de esta exportación.', 'Cancelar exportación');
    if (ok) controller?.cancel();
  };

  dialog.element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (view === 'running') void requestCancel();
    else dialog.close();
  });

  const clear = (): void => {
    dialog.body.replaceChildren();
    dialog.footer.replaceChildren();
  };

  const rangeOf = (choice: 'all' | 'marked'): { start: Rational; end: Rational } | null => {
    if (choice === 'marked') return host.markedRange();
    const seconds = host.timelineSeconds();
    return seconds > 0 ? { start: Rational.ZERO, end: Rational.approximate(seconds) ?? Rational.ZERO } : null;
  };

  // -- config ----------------------------------------------------------------

  const showConfig = (): void => {
    view = 'config';
    clear();
    if (closeButton) closeButton.hidden = false;
    const marked = host.markedRange();
    let rangeChoice: 'all' | 'marked' = marked ? 'marked' : 'all';

    const preset = select(
      [...EXPORT_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: 'Personalizado' }],
      config.presetId ?? 'custom',
    );
    const presetHint = document.createElement('p');
    presetHint.className = 'fx-note';
    const format = select((['mp4', 'webm', 'gif'] as const).map((value) => ({ value, label: FORMAT_LABEL[value] })), config.format);
    const videoCodec = document.createElement('select');
    const audioCodec = document.createElement('select');
    const width = numberInput(config.width, 16, 4096, 2);
    const height = numberInput(config.height, 16, 4096, 2);
    const currentRate = `${config.frameRate.num}/${config.frameRate.den}`;
    const fpsChoices = FPS_CHOICES.map((c) => ({ value: `${c.num}/${c.den}`, label: c.label }));
    // The sequence's own rate is always offered, even when unusual (10, 48…).
    if (!fpsChoices.some((c) => c.value === currentRate)) {
      fpsChoices.unshift({ value: currentRate, label: `${(config.frameRate.num / config.frameRate.den).toLocaleString('es', { maximumFractionDigits: 3 })} (secuencia)` });
    }
    const fps = select(fpsChoices, currentRate);
    if (fps.value === '') fps.value = '30/1';
    const videoMbps = numberInput(config.videoBitrate / 1_000_000, 0.2, 100, 0.1);
    const audioRate = select(AUDIO_BITRATES.map((value) => ({ value: String(value), label: formatBitrate(value) })), String(config.audioBitrate));
    if (audioRate.value === '') audioRate.value = '192000';
    const range = select(
      [
        { value: 'all', label: 'Toda la línea de tiempo' },
        { value: 'marked', label: marked ? `Entrada/salida (${formatEta(marked.start.asNumber())} → ${formatEta(marked.end.asNumber())})` : 'Entrada/salida (marca con I / O)', disabled: !marked },
      ],
      rangeChoice,
    );
    const burn = checkbox('Incrustar subtítulos en la imagen', config.burnSubtitles);
    const proxy = checkbox('Usar proxies si falta el original (menor calidad)', config.allowProxyFallback);
    const hardware = select<ExportHardware>(
      [
        { value: 'no-preference', label: 'Automático' },
        { value: 'prefer-hardware', label: 'Preferir hardware (más rápido)' },
        { value: 'prefer-software', label: 'Preferir software (más compatible)' },
      ],
      config.hardwareAcceleration,
    );
    const dither = checkbox('Tramado Floyd–Steinberg (degradados más suaves)', config.gif.dither);
    const fileName = document.createElement('input');
    fileName.type = 'text';
    fileName.maxLength = 120;
    fileName.value = config.fileName;
    fileName.autocomplete = 'off';

    const estimate = document.createElement('p');
    estimate.className = 'export-estimate';
    estimate.setAttribute('aria-live', 'polite');
    const problems = document.createElement('p');
    problems.className = 'export-problems';
    problems.setAttribute('role', 'alert');
    const compat = document.createElement('p');
    compat.className = 'fx-note export-compat';
    if (!host.webCodecs) {
      compat.textContent = host.ffmpeg
        ? 'Este navegador no tiene WebCodecs: MP4/WebM se codificarán con FFmpeg.wasm (más lento). Para máxima velocidad usa Chrome o Edge 113+.'
        : 'Este navegador no puede codificar MP4/WebM. Usa Chrome o Edge 113+, o exporta como GIF.';
    }

    const videoFields = [row('Códec de vídeo', videoCodec), row('Bitrate de vídeo (Mbps)', videoMbps), row('Aceleración', hardware)];
    const audioFields = [row('Audio', audioCodec), row('Bitrate de audio', audioRate)];
    const gifFields = [dither.wrap];

    const fillCodecs = (): void => {
      const f = format.value === 'webm' ? 'webm' : format.value === 'gif' ? 'gif' : 'mp4';
      const vc = CONTAINER_VIDEO_CODECS[f];
      videoCodec.replaceChildren(...vc.map((value) => Object.assign(document.createElement('option'), { value, textContent: VIDEO_CODEC_LABEL[value] })));
      videoCodec.value = vc.includes(config.videoCodec) ? config.videoCodec : (vc[0] ?? 'h264-high');
      const ac = CONTAINER_AUDIO_CODECS[f];
      audioCodec.replaceChildren(...ac.map((value) => Object.assign(document.createElement('option'), { value, textContent: AUDIO_CODEC_LABEL[value] })));
      audioCodec.value = ac.includes(config.audioCodec) ? config.audioCodec : (ac[0] ?? 'none');
      const isGif = f === 'gif';
      for (const field of videoFields) field.hidden = isGif;
      for (const field of audioFields) field.hidden = isGif;
      for (const field of gifFields) field.hidden = !isGif;
    };

    const read = (): ExportConfig => {
      const f: ExportFormat = format.value === 'webm' ? 'webm' : format.value === 'gif' ? 'gif' : 'mp4';
      const [num, den] = fps.value.split('/').map(Number);
      const vc = CONTAINER_VIDEO_CODECS[f].find((value) => value === videoCodec.value) ?? config.videoCodec;
      const ac = CONTAINER_AUDIO_CODECS[f].find((value) => value === audioCodec.value) ?? 'none';
      const hw: ExportHardware = hardware.value === 'prefer-hardware' ? 'prefer-hardware' : hardware.value === 'prefer-software' ? 'prefer-software' : 'no-preference';
      return {
        ...config,
        format: f,
        videoCodec: vc,
        audioCodec: f === 'gif' ? 'none' : ac,
        width: Math.round(Number(width.value)),
        height: Math.round(Number(height.value)),
        frameRate: { num: num ?? 30, den: den ?? 1 },
        videoBitrate: Math.round(Number(videoMbps.value) * 1_000_000),
        audioBitrate: Number(audioRate.value),
        burnSubtitles: burn.input.checked,
        allowProxyFallback: proxy.input.checked,
        hardwareAcceleration: hw,
        gif: { ...config.gif, dither: dither.input.checked },
        fileName: fileName.value.trim() || 'concat-export',
        range: rangeOf(rangeChoice),
      };
    };

    const exportButton = dialog.addButton('Exportar', () => void start(), 'primary');
    const refresh = (): void => {
      const next = read();
      const chosen = next.range;
      const seconds = chosen ? Math.max(0, chosen.end.sub(chosen.start).asNumber()) : 0;
      const frames = Math.floor(seconds * (next.frameRate.num / next.frameRate.den));
      estimate.textContent = `Duración ${formatEta(seconds)} · ${frames.toLocaleString('es')} fotogramas · tamaño estimado ${formatBytes(estimateTotalBytes(next, seconds))}`;
      const issues = validateExportConfig({ ...next, range: chosen });
      if (!chosen || seconds <= 0) issues.push('La línea de tiempo está vacía.');
      const warning = next.format === 'gif' ? gifDurationWarning(seconds) : null;
      problems.textContent = [...issues, ...(warning ? [warning] : [])].join(' ');
      problems.classList.toggle('is-error', issues.length > 0);
      const encoderMissing = next.format !== 'gif' && !host.webCodecs && !host.ffmpeg;
      exportButton.disabled = issues.length > 0 || encoderMissing;
      const p = next.presetId ? getPresetById(next.presetId) : null;
      presetHint.textContent = p ? p.description : 'Ajustes personalizados.';
    };
    const markCustom = (): void => {
      config = { ...read(), presetId: null };
      preset.value = 'custom';
      refresh();
    };

    preset.addEventListener('change', () => {
      if (preset.value === 'custom') {
        config = { ...read(), presetId: null };
      } else {
        config = applyPreset(preset.value, read());
        format.value = config.format;
        width.value = String(config.width);
        height.value = String(config.height);
        fps.value = `${config.frameRate.num}/${config.frameRate.den}`;
        videoMbps.value = String(config.videoBitrate / 1_000_000);
        audioRate.value = String(config.audioBitrate);
        dither.input.checked = config.gif.dither;
        fillCodecs();
      }
      refresh();
    });
    format.addEventListener('change', () => {
      config = { ...read(), presetId: null };
      fillCodecs();
      markCustom();
    });
    for (const input of [videoCodec, audioCodec, width, height, fps, videoMbps, audioRate, hardware]) input.addEventListener('change', markCustom);
    for (const input of [width, height, videoMbps]) input.addEventListener('input', refresh);
    for (const input of [burn.input, proxy.input, dither.input]) input.addEventListener('change', refresh);
    fileName.addEventListener('input', refresh);
    range.addEventListener('change', () => {
      rangeChoice = range.value === 'marked' ? 'marked' : 'all';
      refresh();
    });

    const size = document.createElement('div');
    size.className = 'export-size';
    size.append(row('Ancho', width), row('Alto', height));

    const grid = document.createElement('div');
    grid.className = 'export-grid';
    grid.append(
      row('Preajuste', preset),
      presetHint,
      row('Formato', format),
      ...videoFields,
      size,
      row('Fotogramas por segundo', fps),
      ...audioFields,
      ...gifFields,
      row('Rango', range),
      burn.wrap,
      proxy.wrap,
      row('Nombre del archivo', fileName),
    );
    dialog.body.append(compat, grid, estimate, problems);
    fillCodecs();
    refresh();
    dialog.addButton('Cancelar', () => dialog.close());
    dialog.footer.insertBefore(dialog.footer.lastChild ?? exportButton, exportButton);

    const start = async (): Promise<void> => {
      config = read();
      saveLast(config);
      await run(config);
    };
    queueMicrotask(() => preset.focus());
  };

  // -- running ---------------------------------------------------------------

  const run = async (chosen: ExportConfig): Promise<void> => {
    view = 'running';
    clear();
    if (closeButton) closeButton.hidden = true;
    const canvas = document.createElement('canvas');
    canvas.className = 'export-preview';
    const aspect = chosen.height / chosen.width;
    canvas.width = 320;
    canvas.height = Math.max(1, Math.round(320 * aspect));
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Vista previa del fotograma que se está exportando');
    const bar = progressBar('Progreso de la exportación');
    const phase = document.createElement('p');
    phase.className = 'export-phase';
    const stats = document.createElement('p');
    stats.className = 'export-stats fx-note';
    dialog.body.append(canvas, bar.element, phase, stats);
    const cancel = dialog.addButton('Cancelar exportación', () => void requestCancel(), 'danger');
    queueMicrotask(() => cancel.focus());

    disposeController();
    const active = host.createController();
    controller = active;
    let lastPhase: ExportPhase | null = null;
    let lastAnnounced = -1;
    active.onProgress((progress: ExportProgress) => {
      if (progress.preview) {
        const context = canvas.getContext('2d');
        context?.drawImage(progress.preview, 0, 0, canvas.width, canvas.height);
      }
      const pct = Math.round(progress.ratio * 100);
      bar.set(progress.ratio, `${pct}% · ${PHASE_LABEL[progress.phase]}`);
      phase.textContent = progress.message || PHASE_LABEL[progress.phase];
      const parts = [];
      if (progress.totalFrames > 0) parts.push(`Fotograma ${progress.frame} / ${progress.totalFrames}`);
      if (progress.fps > 0) parts.push(`${progress.fps.toFixed(1)} fps`);
      if (progress.etaSeconds !== null) parts.push(`Restante ${formatEta(progress.etaSeconds)}`);
      if (progress.bytesWritten > 0) parts.push(formatBytes(progress.bytesWritten));
      stats.textContent = parts.join(' · ');
      const decile = Math.floor(pct / 10);
      if (progress.phase !== lastPhase || decile !== lastAnnounced) {
        live.textContent = `${PHASE_LABEL[progress.phase]}: ${pct}%`;
        lastPhase = progress.phase;
        lastAnnounced = decile;
      }
    });
    try {
      const result = await active.start(chosen);
      if (!dialog.isOpen) return;
      showDone(result);
      host.notify('success', 'Exportación completada', `${result.fileName} · ${formatBytes(result.blob.size)}`);
    } catch (error) {
      const typed = toExportError(error);
      if (!dialog.isOpen) return;
      if (typed.code === 'ABORTED') {
        host.notify('info', 'Exportación cancelada', 'No se ha guardado ningún archivo.');
        showConfig();
      } else {
        console.error('Exportación', error);
        showError(typed);
      }
    }
  };

  // -- done ------------------------------------------------------------------

  const showDone = (result: ExportResult): void => {
    view = 'done';
    clear();
    if (closeButton) closeButton.hidden = false;
    live.textContent = 'Exportación completada.';
    const list = document.createElement('dl');
    list.className = 'export-summary';
    const add = (term: string, value: string): void => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    };
    add('Archivo', result.fileName);
    add('Tamaño', formatBytes(result.blob.size));
    add('Duración', `${formatEta(result.duration)} (${result.frames} fotogramas)`);
    add('Tiempo de exportación', formatEta(result.elapsedMs / 1000));
    add('Codificador', result.encoder === 'webcodecs' ? 'WebCodecs (hardware)' : result.encoder === 'ffmpeg' ? 'FFmpeg.wasm' : 'GIF');
    dialog.body.appendChild(list);
    if (result.warnings.length > 0) {
      const warnings = document.createElement('ul');
      warnings.className = 'export-warnings';
      for (const text of result.warnings) warnings.appendChild(Object.assign(document.createElement('li'), { textContent: text }));
      dialog.body.appendChild(warnings);
    }
    const picker = savePicker();
    if (picker) {
      dialog.addButton('Guardar como…', () => {
        void saveWithPicker(picker, result.blob, result.fileName, result.mimeType)
          .then((saved) => {
            if (saved) host.notify('success', 'Archivo guardado', result.fileName);
          })
          .catch((error: unknown) => {
            host.notify('warning', 'No se pudo guardar con el selector', `${error instanceof Error ? error.message : String(error)} — se descargará en su lugar.`);
            downloadBlob(result.blob, result.fileName);
          });
      });
    }
    const download = dialog.addButton('Descargar', () => downloadBlob(result.blob, result.fileName), 'primary');
    dialog.addButton('Exportar otra vez', () => showConfig());
    dialog.addButton('Cerrar', () => dialog.close());
    queueMicrotask(() => download.focus());
  };

  // -- error -----------------------------------------------------------------

  const showError = (error: ExportError): void => {
    view = 'error';
    clear();
    if (closeButton) closeButton.hidden = false;
    const title = document.createElement('p');
    title.className = 'export-error-title';
    title.setAttribute('role', 'alert');
    title.textContent = EXPORT_ERROR_MESSAGES[error.code];
    const detail = document.createElement('p');
    detail.className = 'export-error-detail';
    detail.textContent = error.message === EXPORT_ERROR_MESSAGES[error.code] ? '' : error.message;
    const hint = document.createElement('p');
    hint.className = 'fx-note';
    hint.textContent = EXPORT_ERROR_HINTS[error.code];
    dialog.body.append(title, detail, hint);
    const back = dialog.addButton('Volver a los ajustes', () => showConfig(), 'primary');
    dialog.addButton('Cerrar', () => dialog.close());
    queueMicrotask(() => back.focus());
  };

  showConfig();
  return dialog.closed;
}
