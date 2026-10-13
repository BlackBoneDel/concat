// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/**
 * Fase 8 · zona 3 — the CapCut-style HUD, wired: the library tabs and their
 * tree, the toolbar groups and the hand tool, the text button, the preview
 * header, the editable project name and the Details panel's Modify switch.
 * These suites drive the real panels over the fake app of `f8-helpers.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPanel } from '../src/ui/media-panel.ts';
import { TimelinePanel } from '../src/ui/timeline-panel.ts';
import { HeaderBar } from '../src/ui/header-bar.ts';
import { PreviewPanel } from '../src/ui/preview-panel.ts';
import { InspectorPanel } from '../src/ui/inspector-panel.ts';
import { REQUEST_ADD_TEXT_EVENT } from '../src/ui/ui-events.ts';
import { createFakeApp, fakeAsset, mediaItem, stubRect, type FakeApp } from './f8-helpers.ts';

/** Mounts the four panels of the shell the way `main.ts` does. */
function mountShell(fake: FakeApp) {
  document.body.innerHTML =
    '<div id="app" class="app"><header id="header-bar"></header></div>' +
    '<aside id="media-panel"></aside><section id="preview-panel"></section>' +
    '<section id="timeline-panel"></section><aside id="inspector-panel"></aside>';
  const headerRoot = document.getElementById('header-bar') as HTMLElement;
  const mediaRoot = document.getElementById('media-panel') as HTMLElement;
  const previewRoot = document.getElementById('preview-panel') as HTMLElement;
  const timelineRoot = document.getElementById('timeline-panel') as HTMLElement;
  const inspectorRoot = document.getElementById('inspector-panel') as HTMLElement;
  const rect = { left: 220, top: 300, width: 900, height: 420 };
  stubRect(mediaRoot, { left: 0, top: 48, width: 300, height: 600 });
  stubRect(timelineRoot, rect);
  stubRect(previewRoot, { left: 306, top: 48, width: 900, height: 240 });
  stubRect(inspectorRoot, { left: 1212, top: 48, width: 320, height: 600 });
  const header = new HeaderBar(headerRoot, fake.ctx);
  const media = new MediaPanel(mediaRoot, fake.ctx);
  const preview = new PreviewPanel(previewRoot, fake.ctx);
  const timeline = new TimelinePanel(timelineRoot, fake.ctx);
  const inspector = new InspectorPanel(inspectorRoot, fake.ctx);
  const content = timelineRoot.querySelector('.tl-content-wrap');
  if (content) stubRect(content, rect);
  return { header, media, preview, timeline, inspector, headerRoot, mediaRoot, previewRoot, timelineRoot, inspectorRoot };
}

describe('Fase 8 · panel de medios estilo CapCut', () => {
  let fake: FakeApp;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    fake = createFakeApp();
    fake.session.addMediaItem(mediaItem({ id: 'm-1', name: 'uno.mp4', duration: 10 }));
    fake.pool.add(fakeAsset({ id: 'm-1', name: 'uno.mp4', durationSeconds: 10 }));
    fake.pool.add(fakeAsset({ id: 'm-2', name: 'voz.mp3', durationSeconds: 4, type: 'audio' }));
  });

  it('la biblioteca tiene las seis pestañas y arranca en Medios', () => {
    const { mediaRoot } = mountShell(fake);
    const tabs = [...mediaRoot.querySelectorAll<HTMLButtonElement>('.panel-tab')];
    expect(tabs.map((tab) => tab.dataset['tab'])).toEqual([
      'media',
      'text',
      'transitions',
      'effects',
      'filters',
      'templates',
    ]);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.classList.contains('is-active')).toBe(true);
    expect(mediaRoot.querySelector('.media-import-btn')?.textContent).toContain('Importar');
  });

  it('el árbol cuenta los medios por tipo y filtra la rejilla', () => {
    const { mediaRoot } = mountShell(fake);
    const counts = [...mediaRoot.querySelectorAll<HTMLElement>('.media-count')].map((node) => node.textContent);
    expect(counts).toEqual(['2', '1', '1', '0']);

    const audio = mediaRoot.querySelector<HTMLButtonElement>('.media-tree-item[data-filter="audio"]')!;
    audio.click();
    expect(audio.getAttribute('aria-pressed')).toBe('true');
    const cards = [...mediaRoot.querySelectorAll<HTMLElement>('.media-card')];
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelector('.media-name')?.textContent).toBe('voz.mp3');
  });

  it('la tarjeta lleva la insignia de duración', () => {
    const { mediaRoot } = mountShell(fake);
    const badge = mediaRoot.querySelector('.media-card .media-duration-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('10s');
  });

  it('la pestaña Texto lista los títulos y pide uno al timeline', () => {
    const { mediaRoot } = mountShell(fake);
    const heard = vi.fn();
    document.addEventListener(REQUEST_ADD_TEXT_EVENT, heard);
    mediaRoot.querySelector<HTMLButtonElement>('.panel-tab[data-tab="text"]')!.click();
    const rows = mediaRoot.querySelectorAll('.media-catalog-row');
    expect(rows.length).toBeGreaterThan(0);
    (rows[0]!.querySelector('.media-catalog-action') as HTMLButtonElement).click();
    expect(heard).toHaveBeenCalledTimes(1);
    document.removeEventListener(REQUEST_ADD_TEXT_EVENT, heard);
  });

  it('Transiciones, Efectos, Filtros y Plantillas muestran su catálogo', () => {
    const { mediaRoot } = mountShell(fake);
    for (const [tab, needle] of [
      ['transitions', 'Fundido cruzado'],
      ['effects', 'Blur'],
      ['filters', 'Filtros'],
      ['templates', 'Plantillas'],
    ] as const) {
      mediaRoot.querySelector<HTMLButtonElement>(`.panel-tab[data-tab="${tab}"]`)!.click();
      expect((mediaRoot.querySelector('.media-catalog') as HTMLElement | null)?.hidden).toBe(false);
      expect(mediaRoot.querySelector('.media-catalog')?.textContent ?? '').toContain(needle);
    }
  });
});

describe('Fase 8 · barra de herramientas estilo CapCut', () => {
  let fake: FakeApp;

  beforeEach(() => {
    document.body.innerHTML = '';
    fake = createFakeApp();
    fake.session.addMediaItem(mediaItem({ id: 'm-1', name: 'uno.mp4', duration: 10 }));
  });

  it('la barra agrupa los controles y usa los ganchos del HUD', () => {
    const { timelineRoot } = mountShell(fake);
    const bar = timelineRoot.querySelector('.tl-toolbar')!;
    expect(bar.querySelector('.tl-toolbar-left')).not.toBeNull();
    expect(bar.querySelector('.tl-toolbar-right')).not.toBeNull();
    expect(bar.querySelectorAll('.timeline-toolbar-btn').length).toBeGreaterThan(8);
    expect(bar.querySelectorAll('.timeline-toolbar-separator').length).toBeGreaterThan(2);
    expect(bar.querySelector('.tl-cursor-indicator')?.textContent).toContain('Selección');
    expect(bar.querySelector('.tl-tool-text')).not.toBeNull();
    expect(bar.querySelector('.tl-tool-hand')).not.toBeNull();
  });

  it('el imán se marca activo (verde) y se refleja en el botón', () => {
    const { timelineRoot } = mountShell(fake);
    const snap = timelineRoot.querySelector<HTMLButtonElement>('.timeline-toolbar-snap')!;
    expect(snap.classList.contains('snap-active')).toBe(true);
    snap.click();
    expect(snap.classList.contains('snap-active')).toBe(false);
    expect(fake.session.snapping.enabled).toBe(false);
  });

  it('la mano (H) pasa la superficie a modo arrastre', () => {
    const { timelineRoot } = mountShell(fake);
    const hand = timelineRoot.querySelector<HTMLButtonElement>('.tl-tool-hand')!;
    hand.click();
    expect(hand.classList.contains('active')).toBe(true);
    expect(timelineRoot.querySelector('.tl-scroll')?.classList.contains('is-hand')).toBe(true);
    expect(timelineRoot.querySelector('.tl-cursor-label')?.textContent).toBe('Mano');
  });

  it('el botón Texto crea un clip de texto en el playhead', () => {
    const { timelineRoot } = mountShell(fake);
    timelineRoot.querySelector<HTMLButtonElement>('.tl-tool-text')!.click();
    const clips = fake.session.document.timelines[0]!.clips;
    const text = clips.find((clip) => clip.kind === 'text');
    expect(text).toBeDefined();
    expect(text!.text?.content).toBeTruthy();
    expect(text!.duration).toBeCloseTo(3, 6);
    expect(text!.trackId).toBe(fake.session.document.timelines[0]!.tracks[0]!.id);
  });

  it('el botón de mute avisa al monitor', () => {
    const { timelineRoot } = mountShell(fake);
    const heard = vi.fn();
    document.addEventListener('preview-mute-toggle', heard);
    timelineRoot.querySelector<HTMLButtonElement>('.tl-tool-mute')!.click();
    expect(heard).toHaveBeenCalledTimes(1);
    document.removeEventListener('preview-mute-toggle', heard);
  });
});

describe('Fase 8 · cabecera, monitor y panel Detalles', () => {
  let fake: FakeApp;

  beforeEach(() => {
    document.body.innerHTML = '';
    fake = createFakeApp();
  });

  it('el nombre del proyecto se edita en el sitio', () => {
    const { headerRoot } = mountShell(fake);
    let changes = 0;
    document.addEventListener('project-changed', () => {
      changes += 1;
    });
    headerRoot.querySelector<HTMLElement>('.header-project')!.click();
    const input = headerRoot.querySelector<HTMLInputElement>('.header-project-input')!;
    expect(input).not.toBeNull();
    input.value = 'Documental Arequipa';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(fake.session.name).toBe('Documental Arequipa');
    expect(fake.session.dirty).toBe(true);
    expect(changes).toBe(1);
    expect(headerRoot.querySelector('.header-project')?.textContent).toBe('Documental Arequipa');
  });

  it('Escape cancela el renombrado', () => {
    const { headerRoot } = mountShell(fake);
    const before = fake.session.name;
    headerRoot.querySelector<HTMLElement>('.header-project')!.click();
    const input = headerRoot.querySelector<HTMLInputElement>('.header-project-input')!;
    input.value = 'no debería guardarse';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(fake.session.name).toBe(before);
  });

  it('el conmutador de paneles pliega los laterales', () => {
    const { headerRoot } = mountShell(fake);
    const toggle = headerRoot.querySelector<HTMLButtonElement>('.header-panel-toggle')!;
    toggle.click();
    expect(document.getElementById('app')?.classList.contains('panels-hidden')).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(document.getElementById('app')?.classList.contains('panels-hidden')).toBe(false);
  });

  it('el monitor muestra formato y fps del proyecto', () => {
    const { previewRoot } = mountShell(fake);
    expect(previewRoot.querySelector('.preview-header .panel-title')?.textContent).toBe('Previsualización');
    expect(previewRoot.querySelector('.preview-meta')?.textContent).toBe('1920×1080 · 30 fps');
  });

  it('Detalles ofrece Modificar solo sin selección y cambia la hoja', () => {
    const { inspectorRoot, timelineRoot } = mountShell(fake);
    void timelineRoot;
    const modify = inspectorRoot.querySelector<HTMLButtonElement>('.inspector-modify')!;
    expect(inspectorRoot.querySelector('.panel-title')?.textContent).toBe('Detalles');
    expect(modify.hidden).toBe(false);
    // Con el proyecto en modo lectura las medidas son texto; Modificar las convierte en campos.
    expect(inspectorRoot.querySelector('.field-readonly')).not.toBeNull();
    modify.click();
    expect(modify.getAttribute('aria-pressed')).toBe('true');
    expect(inspectorRoot.querySelector<HTMLInputElement>('input[type="number"]')).not.toBeNull();
    // La sección de contenido sigue contando el material del proyecto.
    expect(inspectorRoot.textContent).toContain('Contenido');
  });
});
