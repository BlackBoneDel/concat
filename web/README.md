# Concat Web — editor de vídeo 100% local (Fases 1–8)

Port of [`jub0t/Concat`](https://github.com/jub0t/Concat) (the open-source,
cross-platform video editor) to a **100% local web application**. No servers,
no uploads, no telemetry: the edit never leaves the user's browser.

**Fase 2 delivers** the working editor:

1. **Compositor** — `renderFrame` paints a `Timeline` instant on canvas,
   bottom-first lanes, and every per-clip number comes from the engine
   model's own `source_time_at` / `transform_at` / `opacity_at` /
   `video_fade_factor`.
2. **Local media** — a minimal MP4 demuxer feeds **WebCodecs**
   (`VideoDecoder`/`AudioDecoder`); every other container and every browser
   without WebCodecs falls back to a hidden `<video>` element. Images decode
   with `createImageBitmap`; thumbnails are generated and cached.
3. **Preview player** — play/pause/seek/step/scrub over a `requestAnimationFrame`
   clock, `HH:MM:SS:FF` timecode with drop-frame 29.97/59.94, and a multitrack
   `AudioMixer` (mute/solo/VU/fades) re-synced on drift.
4. **Editor shell** — header 48px + media panel 300px + preview canvas +
   inspector 320px + timeline 320px, all resizable, dark/light/cyberpunk
   themes, toast notifications, modal dialogs, full keyboard shortcuts.
5. **Local storage** — OPFS for the file bytes (mandatory on import),
   IndexedDB (`ConcatMediaDB` / `ConcatProjectDB`) for metadata and projects,
   `localStorage` for settings, autosave every 30s.

**Fase 3 delivers** the professional editing layer:

1. **Edit engine** — `editor/operations.ts` with 35 reversible operations
   (`apply`/`inverse`/`merge`), every one validated (`EditError` → toast) and
   pure: no operation mutates its input. Everything lives in `extra` maps the
   model round-trips: markers, groups/links, clip enabled/color, track
   name/lock/solo.
2. **EditHistory** — ≥500 steps, atomic transactions (one undo per drag
   gesture, Escape cancels), 300ms move/trim and 500ms property merge.
3. **Selection / clipboard** — click, Ctrl toggle, Shift ranges, marquee;
   copy/cut/paste with fresh ids, group/link structure preserved, missing
   media lands disabled + red.
4. **Snapping** — magnetic, ON by default, 10px threshold, `S` toggles,
   Shift suppresses; priority playhead > markers > clip edges > seconds >
   bounds, with visual guides.
5. **Interactive timeline** — two stacked canvases (ruler + content), no DOM
   per clip, virtualized tracks, 10–500 px/s zoom + minimap, tools V/C/B/N/Y/U
   (select, blade, ripple, roll, slip, slide), insert/overwrite, groups
   (Ctrl+G), video+audio links (Ctrl+L), per-track mute/solo/lock/visible/
   rename/reorder/collapse.
6. **Waveforms & thumbnails** — min/max peaks in a Web Worker at 128/512/2048
   samples per bucket, cached in the `waveforms` store of `ConcatMediaDB`,
   resolution picked per zoom; clip faces carry live thumbnails.
7. **Transitions & markers** — crossfade/dissolve/fades/wipes/slides with
   adjustable duration on the cut that flows *into* a clip; markers with
   label/color/note edited from a modal.
8. **Dynamic inspector** — project sheet (no selection), clip sheet (name,
   audio, transform, speed, transition, keyframes ◆) and batch sheet
   (2+ clips), every field a history step.
9. **Rhythm** — autosave every 30s + restore on reopen, undo per gesture,
   real-time canvas preview, all colors from theme variables, full keyboard
   shortcuts that never fire while typing.

## Production import/timeline fixes

The deployed editor (**<https://blackbonedel.github.io/concat/>**) failed at the
one gesture everything else depends on: bringing footage in. These are the
fixes, what they changed, and how to verify them without trusting the unit
suite.

**What was broken**

- Dropping a file anywhere except the timeline or the library grid did
  *nothing* (the old app-wide guard only blocked navigation). Letting go just
  outside a panel could still open the raw file and lose the session.
- The **Importar** button created a detached `<input type="file">` kept alive
  only by the closure of the click handler: a GC between the click and the
  selection, or Safari/iOS (which refuses to open a picker for an input outside
  the document), made the button look dead. Picking the same file twice never
  fired `change` at all.
- The library card appeared only after the whole probe finished — or never,
  when the metadata probe hung. An empty file or a `.exe` produced a phantom
  asset (`0.0s · 0×0`) with a success toast, and a `currentTime = NaN` threw
  inside the thumbnail path.
- During playback the playhead *line* advanced while the timeline's own
  playhead stayed frozen: two elements, only one of them updated per frame.

**The fixes** (`src/ui/global-drop.ts`, `src/ui/global-file-input.ts`,
`src/media/media-pool.ts`, `src/media/decoder.ts`, `src/media/thumbnail.ts`,
`src/ui/timeline-panel.ts`, `src/ui/timeline/media-drop.ts`)

- `installGlobalDrop` captures `dragenter`/`dragover`/`dragleave`/`drop` on
  **both** `window` and `document`, calls `preventDefault()` +
  `stopPropagation()`, sets `dropEffect = 'copy'`, shows the *«Suelta los
  archivos para importar…»* overlay and imports. `markDropHandled` guarantees
  one drop is processed once; the internal `application/x-concat-media` drag
  never triggers a re-import.
- One permanent `#concat-global-file-input` (`multiple`, media + subtitle + LUT
  `accept`) in `document.body` is the single door for the panel button,
  *Archivo → Importar medios*, `Ctrl+I` and the subtitle pickers; `input.value`
  is cleared after every `change`.
- `MediaPool.addMedia` validates size and container **before** touching the
  pool, registers the asset synchronously as `status: 'processing'` with a
  160×90 SVG placeholder, emits `onMediaAdded` (the card is on screen in a few
  milliseconds) and finishes OPFS → IndexedDB → memory plus the 2000 ms probe
  in the background, emitting `onMediaUpdated`. Empty files and unsupported
  bytes are refused with a toast and no asset.
- The decoder never assigns a non-finite `currentTime`, releases
  `src`/`load()`/`revokeObjectURL`/`VideoFrame`/`AudioContext` in `finally`,
  chains WebCodecs → media element → FFmpeg → minimal metadata, and reads
  files over 768 MB in 64 MiB slices.
- A media card dropped on a lane of the other kind lands on the first lane of
  its own kind (or a new one) instead of failing with an `EditError`, and the
  timeline playhead advances with playback.
- The service worker bypasses `blob:`/`data:`/`file:`/`chrome-extension:`,
  never caches 404/500 or `range` requests, registers as `${BASE_URL}sw.js`
  with the `/concat/` scope, and the cache schema is now `v10`.
- `ci.yml` no longer runs for `web/**`-only changes, the Windows desktop entry
  is `continue-on-error` (documented desktop debt) and every job has a hard
  `timeout-minutes`; `deploy-gh-pages.yml` runs `npm test` and
  `npm run typecheck` before publishing, so it is the source of truth for the
  web editor.

**Verifying it**

Node 22 (`web/.nvmrc`, `engines` in `package.json`). jsdom 30 does not load
on Node 20, and the deploy workflow runs the same version.

```bash
cd web
npm ci
npm test            # 101 files, 1046 tests, incl. the regression suites below
npm run typecheck   # tsc --noEmit, 0 errors
npm run build       # emits dist/ with relative asset URLs

# The real check: the built app served the way GitHub Pages serves it, under
# /concat/, driven in Chromium (dispatches a synthetic WebM/MP4/WAV, drops
# them on the library, the timeline and the background, presses play).
CONCAT_CHROMIUM=/path/to/chrome node scripts/verify-production.mjs

# Service-worker upgrade: a visitor with the previous build gets this one, and
# only the new caches survive. Needs a build of the previous commit.
CONCAT_PREVIOUS_DIST=/path/to/previous/dist CONCAT_CHROMIUM=/path/to/chrome \
  node scripts/verify-sw-upgrade.mjs

# Mutation check: removes one import/timeline guard at a time and requires the
# tests that protect it to go red.
node scripts/mutation-check.mjs
```

`puppeteer-core` is not a project dependency; the two browser scripts load it
from `CONCAT_PUPPETEER` or from a `--no-save` install.

Regression coverage: `tests/import-production-bulletproof.test.ts`,
`tests/global-drop-and-file-input.test.ts`, `tests/timeline-dnd-media.test.ts`,
`tests/production-subpath-assets.test.ts`, `tests/pwa-register.test.ts`,
`tests/service-worker-fetch.test.ts` and `tests/ci-workflow-guards.test.ts`
(the last one pins the Node version the deploy runs on).

## Fase 8 — arrastrar y soltar de verdad, tiras de miniaturas y HUD estilo CapCut

### El fallo crítico: una tarjeta de la biblioteca no llegaba a la timeline

Arrastrar un medio desde el panel izquierdo **no insertaba nada**: el panel
publicaba el arrastre pero la timeline no lo escuchaba. Ahora las tarjetas son
fuentes de arrastre reales (`draggable`, `effectAllowed = 'copy'`, fantasma
propio escalado que se elimina en el siguiente *tick* y clase
`media-card--dragging` mientras dura el gesto) y el panel de la timeline es la
zona de destino:

| Parte | Qué hace |
|---|---|
| `ui/dnd/media-drag.ts` | escribe `application/x-concat-media` (id), `application/x-concat-media-type`, `application/x-concat-media-duration` (racional como cadena) y `text/plain`; `readMediaDrag` valida lo que llega |
| `ui/timeline/coord-utils.ts` | `pixelsToTime`, `timeToPixels`, `getTrackAtY`, `layoutRects` y `localPoint`: una sola aritmética de punteros, siempre contra el zoom y el scroll vivos |
| `ui/timeline/media-drop.ts` | `dragenter`/`dragover`/`dragleave`/`drop` con clase `timeline-drop-active`, previsualización verde translúcida del clip que va a caer y guía magenta del imán; `Escape` cancela |
| `ui/timeline/drop-preview.ts` | dibuja el fantasma: ancho = duración × px/s, alto de la pista, borde #4caf50; línea discontinua y pista nueva cuando el puntero está fuera de los carriles |
| `EditSession.insertClipFromMedia(mediaId, trackId, atTime, mode)` | construye el `DocumentClip` (uuid nuevo, tipo vídeo/audio, nombre, `media_ref`, `start_time`, `source_start`, `source_duration`, transform por defecto, opacidad 1, `enabled`, `extra {}`) y ejecuta `InsertClipOperation` |

Reglas del destino: el clip cae en el carril bajo el puntero; si no hay ninguno
se **crea una pista** al final (vídeo salvo que el medio sea audio) y se dibuja
al borde inferior. `Shift` desactiva el imán; por defecto imanta a playhead,
marcadores, bordes de clip, segundos y límites con la guía magenta. Al soltar:
un paso de historial, `toast` de éxito y `console.info('[TimelineDrop] …')`; si
la pista rechaza el clip, el error se informa sin romper nada. El evento se marca
con `markDropHandled` para que la guardia global de archivos del PR #4 no lo
procese dos veces.

### Tiras de miniaturas dentro de los clips

- `media/thumbnail-strip.ts` genera una tira de 4–40 fotogramas **equidistantes**
  (uno cada 1,5 s, 160×90, `ImageBitmap`) y la guarda en el almacén
  `thumbnail_strips` de `ConcatMediaDB` (v4) con degradado a memoria; la
  generación cede el hilo entre fotogramas para no bloquear la interfaz.
- El clip de vídeo pinta la tira **solo a partir de 20 px/s**; por debajo usa la
  miniatura única, y mientras la tira se construye dibuja un marcador de posición
  a cuadros (nunca un hueco vacío). Los fotogramas se indexan por tiempo de
  origen, así que al recortar o acelerar el clip la tira sigue a la imagen.
- `MediaPool` publica `media-strips-changed` cuando una tira está lista o cambia
  el vínculo del medio, y la timeline se repinta sola.

### Clips: aspecto profesional

| Rasgo | Valor |
|---|---|
| Cuerpo | degradado por tipo (`#2b4a7a`→`#1e3a66` en vídeo, `#2d5a3d`→`#1e4027` en audio, violeta en imagen) con borde superior de 2 px |
| Nombre | barra opaca de 18 px (`rgba(0,0,0,0.4)`), texto blanco de 11 px con sombra y puntos suspensivos |
| Tipo | icono vectorial dibujado en el canvas (película, onda, imagen, «T», capa) |
| Selección | borde de 2 px `#ff3b3b`… `--clip-selected-border` (`#ffeb3b`) con resplandor |
| Bloqueado | rayado diagonal; deshabilitado, opacidad 0.4; fades dibujados como rampas |

### HUD estilo CapCut

- **Retícula**: cabecera de 48 px, columnas de 300 px (medios) y 320 px
  (detalles), timeline de 320 px, todo redimensionable como en la Fase 2.
- **Paleta** (`theme-manager.ts`, tema oscuro): `#181818` de fondo, `#232323` de
  panel, acento lima `#c4f000`, reproducción `#4caf50`, selección `#ffeb3b`,
  playhead `#ff3838`. Los alias que el CSS usaba sin definir
  (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--accent-primary`,
  `--text-primary`, `--text-tertiary`…) ahora existen en los tres temas.
- **Cabecera**: menús Archivo/Edición/**Ver**, nombre de proyecto editable en el
  sitio (Enter guarda, Escape cancela), píldora «Guardado / Cambios sin guardar»,
  iconos de ajustes y de plegado de paneles, y un botón **Exportar** lima.
- **Biblioteca**: pestañas Medios, Texto, Transiciones, Efectos, Filtros y
  Plantillas; árbol plegable con recuentos por tipo; botón Importar a todo lo
  ancho; rejilla de 3 columnas con insignia de duración; catálogos reales
  (`TEXT_PRESETS`, `TRANSITION_KINDS`, efectos, LUTs de la biblioteca,
  `MOTION_PRESETS`), y el botón «Añadir» de un título crea el clip en el
  playhead.
- **Monitor**: cabecera con título, resolución · fps y engranaje.
- **Timeline**: barra agrupada (añadir pista · deshacer/rehacer · dividir ·
  borrar · herramientas V/C/B/N/U/Y/P · mano H · imán S · texto · mute),
  indicador de cursor, zoom y ajuste; `.timeline-toolbar-btn` con estados
  hover/activo, imán en verde cuando está armado y separadores
  `.timeline-toolbar-separator`. El botón de mano arrastra la vista (cursor
  `grab`), y el ruler oscuro marca segundos con ticks cortos y los pasos
  etiquetados con ticks largos bajo un playhead rojo de 2 px con triángulo.
- **Detalles**: cabecera propia, secciones Proyecto / Timeline / Contenido
  (pistas, clips, duración, recuento de medios) y botón **Modificar** que
  convierte las cifras del proyecto en campos editables.
- Sin emojis en `src/`: todo glifo es SVG (`icon`, `iconButton`,
  `createIconElement`), con las invariantes del set de la Fase 7 verificadas por
  `tests/icons-complete.test.ts`.

### Métricas (Fase 8)

| Métrica | Valor |
|---|---|
| Tests | **956 / 94 archivos**, 0 fallos (892 del tronco + 64 nuevos) |
| Typecheck | `npm run typecheck` sin errores |
| Bundle principal | **171,28 KB gzip** (< 180 KB) — +12 KB sobre el tronco |
| CSS | 39,72 KB (7,79 KB gzip) |

Suites nuevas: `tests/drag-drop-timeline.test.ts` (15),
`tests/clip-renderer-thumbnails.test.ts` (16),
`tests/timeline-coords.test.ts` (12), `tests/hud-shell.test.ts` (15) e
`tests/icons-complete.test.ts` (6).

## Fase 7 — sistema de iconos SVG, HUD profesional y QA

### Iconos (`src/ui/components/icons.ts`)

Ya no queda ningún emoji en la interfaz. Todos los glifos son SVG inline
dibujados sobre una rejilla de 24×24, con trazo `currentColor` de 2 px y
extremos redondeados. No se usa ninguna librería de iconos.

| API | Uso |
|---|---|
| `icon(name, {size, label, className, strokeWidth})` | `<svg class="concat-icon concat-icon-<kebab>">`, oculto a lectores salvo con `label` |
| `iconMarkup(name, …)` | la misma salida como cadena con `xmlns` (para HTML estático) |
| `iconButton({icon, label, shortcut, pressed, text, onClick, signal})` | `.concat-icon-btn` con `title="Label (K)"`, `aria-label` y `aria-keyshortcuts` |
| `setPressed(btn, on)` / `setButtonIcon(btn, name)` | conmutadores (`.active` + `aria-pressed`) e intercambio de glifo (play ↔ pause, eye ↔ eye-off) |

Grupos de iconos:

- **Reproducción**: play, pause, stop, skipBack/Forward, stepBack/Forward y loop.
- **Herramientas**: select, split, ripple, roll, slip, slide, pen y magnet.
- **Pista**: eye/eyeOff, lock/unlock, volumeOn/Mute y headphones.
- **Inspector**: keyframeEmpty/Filled/Add, link/unlink, group y marker.
- **Sistema**: settings, export, sun, moon, zap, menu, keyboard, undo/redo y save.

Dónde se aplican:

- Barra de herramientas y zoom.
- Cabeceras de pista: los toggles inactivos bajan de opacidad; mute se marca en rojo, solo y oculto en ámbar.
- HUD de transporte, con tres zonas: timecode | controles centrados con play destacado | bucle + volumen.
- Cabecera, con el icono del tema según el tema activo.
- Inspector:
  - El rombo de keyframe pasa de vacío a relleno en color de acento cuando hay una key en el instante del playhead. Se sincroniza con el evento `playhead-changed`.
  - Pulsarlo añade o quita esa key.
- Grip del stack de efectos, modales y panel de medios.

Hallazgo de QA: el CSS de Fases 3–6 usaba 11 variables que nunca se habían
definido (`--accent-primary`, `--bg-hover`, `--text-primary`…). Por eso el
marquee, la herramienta activa y varios toggles se pintaban sin color. Ahora
son alias de las variables de los tres temas.

### QA de casos límite y estrés

| Escenario | Antes | Ahora |
|---|---|---|
| Clip de 1 fotograma + crossfade de 1 s | `SetTransitionProperty` aceptaba cualquier duración, y un proyecto editado a mano dejaba una rampa de alpha de 1 s en un clip de 33 ms | `EditError` («no puede durar más que el clip más corto»); `EditorClip` limita `videoFadeIn` a la duración del clip |
| Split en `t = 0` / `t = duración` / a 1 µs del borde | el borde exacto ya se rechazaba, pero a 1 µs quedaba un clip «fantasma» | `EditError` claro; ninguna mitad dura menos de `MIN_CLIP_DURATION` |
| Export 0×0 o 0 fps | se validaba, pero después de pasar el pool a originales | la validación ocurre antes de tocar nada; `VideoEncoderPool` y los retardos GIF también se protegen (defensa en profundidad) |
| Drag + 5 × Ctrl+Z | al soltar se aplicaban operaciones calculadas sobre un documento ya deshecho | el `DragManager` guarda el documento del gesto y llama a `cancel()` si el historial cambia (también desde `onEdited`) |
| Export abortado a los 100 ms × 10 | — | sin cambios: 0 frames sin `close()`, superficies y codificadores liberados en cada intento |
| Medio borrado durante PLAY | el rechazo de `getFrame` quedaba sin capturar en `void renderOnce()` | se dibuja una tarjeta roja «Media Missing», salta un aviso por medio con «Volver a vincular» y el bucle rAF sigue vivo |
| Decodificación lenta durante PLAY | dos composites podían entrelazarse en el mismo canvas | los renders se serializan: uno pinta y, como mucho, otro espera la última posición |

Tests nuevos:

- `tests/edge-cases.test.ts` (23).
- `tests/stress.test.ts` (11).
- `tests/f7-icons.test.ts` (12). Incluye una guardia que falla si vuelve a aparecer un emoji en `src/`.

### Métricas (Fase 7)

| Métrica | Valor |
|---|---|
| Tests | 845 / 89 archivos (799 previos intactos salvo 1 selector de DOM) |
| Bundle principal | 158,94 KB gzip (< 180 KB) |

## Fase 6 — exportación offline, PWA instalable y pulido de producción

Concat exporta en el propio navegador: no sube nada a ningún servidor.
La pestaña renderiza cada fotograma a partir de los **originales**, los codifica
con WebCodecs y los multiplexa con muxers MP4, WebM y GIF propios. Todo ese
código está en `src/export/` y se carga bajo demanda.

| Módulo | Qué hace |
|---|---|
| `types.ts` | `ExportConfig`/`ExportProgress`/`ExportResult`, `ExportError` con los códigos `ABORTED`, `ENCODER_UNSUPPORTED`, `MUX_FAILED`, `OUT_OF_MEMORY`, `NO_MEDIA`, `INVALID_RANGE` y `UNKNOWN`, y validación de la configuración. |
| `export-presets.ts` | YouTube 1080p y 4K, TikTok/Reels 9:16, Instagram 1:1, Pro 60 fps, Web ligero (WebM VP9 + Opus), GIF corto y Máster 15 Mbps. Incluye `applyPreset` y `estimateOutputBytes`. |
| `bitrate-estimator.ts` | Tamaño estimado y helpers `formatBytes` («12.4 MB») y `formatEta` («00:03:21»). |
| `frame-clock.ts` | Reloj **solo con `Rational`**: `totalFrames = floor((fin − inicio) · fps)` y el timestamp en µs se deriva del índice del fotograma, sin acumular deriva. |
| `offline-renderer.ts` | Renderiza en `OffscreenCanvas` con el compositor de la Fase 2. Hace letterbox, quema los subtítulos y crea `VideoFrame` con el timestamp en µs. La vista previa mide ≤ 480 px y nunca hay más de 2 fotogramas en vuelo. |
| `audio-exporter.ts` | `OfflineAudioContext` a 48 kHz estéreo con todo el stack de efectos de audio de la Fase 5. |
| `video-encoder-pool.ts` / `audio-encoder-pool.ts` | Codecs `avc1.42E01E`/`avc1.640028`, `vp09.00.10.08` y `av01.0.04M.08`, siempre comprobados con `isConfigSupported`. Usan `latencyMode: 'quality'` y un keyframe cada 2 s. Audio en `mp4a.40.2` y `opus`. |
| `mp4-muxer-adapter.ts`, `webm-muxer-adapter.ts`, `packet-store.ts` | Muxers propios (sin dependencias). Los paquetes se guardan en streaming, en trozos, y se ensamblan al final. |
| `gif-exporter.ts` | Escribe GIF89a con paleta de 256 colores, Floyd-Steinberg opcional y `delay = round(1000/fps)`. Avisa si el clip pasa de 30 s. |
| `ffmpeg-mux-fallback.ts` | Usa el FFmpeg.wasm local de la Fase 4 cuando faltan WebCodecs (Firefox/Safari). |
| `export-controller.ts` | Recorre las fases preparando → renderizando → codificando audio → multiplexando → finalizando → hecho/cancelado/error. Calcula la ETA como fotogramas restantes / max(fps, 0,01). `dispose()` libera todo. |

**Memoria y cancelación.** Cada `VideoFrame`, `AudioData` e `ImageBitmap` se
cierra en cuanto deja de usarse, y los encoders reciben contrapresión. El
`AbortController` llega a todas las etapas: al cancelar se cierran los
encoders, se termina el worker de FFmpeg y se libera la calidad «original»
forzada del pool. No quedan workers huérfanos ni locks de OPFS. Si de un medio
**solo existe el proxy**, el export falla con `NO_MEDIA`. La opción «usar
proxies si falta el original» existe, pero viene desactivada.

**Diálogo de exportación (Ctrl/Cmd+E).**
- Vistas: configuración → progreso (vista previa, fps, ETA y fase anunciada por `aria-live`) → hecho o error.
- El error viene con una sugerencia según su código.
- Rango: toda la línea de tiempo o entrada/salida, que se marcan con **I** y **O** y se borran con **Alt+X**. El rango marcado aparece como insignia en la cabecera.
- Descarga: con `showSaveFilePicker` si está disponible; si no, con `<a download>`, y la URL se revoca a los 60 s.
- Cancelar pide confirmación. Un clic fuera nunca cierra el diálogo. Tiene focus trap.
- Recuerda el último preset (`localStorage`).

### Matriz de compatibilidad (Fase 6)

| Navegador | MP4 H.264 + AAC | WebM VP9/AV1 + Opus | GIF | Instalación PWA |
|---|---|---|---|---|
| Chrome / Edge 113+ | WebCodecs (hardware si existe) | WebCodecs | ✔ | ✔ (botón y menú Archivo) |
| Firefox 120+ | FFmpeg.wasm (más lento) | FFmpeg.wasm (VP8/VP9 + Opus) | ✔ | — (funciona offline igualmente) |
| Safari 17+ | WebCodecs parcial o FFmpeg.wasm | según `isConfigSupported` | ✔ | «Añadir a pantalla de inicio» |

El diálogo comprueba la configuración antes de empezar y avisa con un mensaje
claro cuando el navegador no puede codificarla.

### PWA

- `public/manifest.json`: standalone, `theme_color #14161b`, iconos 192/512 y *maskable*, y *file handler* para `.concatpkg.zip`.
- `public/sw.js` es **network-first**. Solo atiende los GET del mismo origen e ignora las peticiones con `Range`. Si no hay red, sirve la copia en caché y, para las navegaciones, `index.html` o, en su defecto, `offline.html`.
- El build sustituye `__CONCAT_BUILD_ID__` y la lista de precache con los archivos reales del bundle; el plugin es `pwaPrecache` en `vite.config.ts`. Vite copia `public/` a `dist/`.
- `src/pwa/sw-register.ts` solo registra el SW en producción. Si hay una versión nueva, muestra un toast «Nueva versión disponible · Recargar» que guarda el proyecto antes de aplicar `SKIP_WAITING`. También avisa con «Listo sin conexión».
- `src/pwa/install-prompt.ts` captura `beforeinstallprompt` y ofrece «Instalar» en un toast y en el menú Archivo.

### Paquete de proyecto (`.concatpkg.zip`)

En Archivo → Paquete de proyecto se genera un ZIP propio (CRC-32 + SHA-256,
`src/storage/zip.ts`) con este contenido:
- `project.concat.json`;
- `media/` (opcional);
- `fonts/`;
- `luts/` (`.cube`);
- `manifest.json` con los checksums.

Al abrirlo se verifican los checksums. Después se importan los medios a
OPFS y se instalan las fuentes y los LUTs antes de cargar el proyecto. Las
fuentes personalizadas también se conservan al guardar con normalidad
(`font-persistence.ts`).

### Gestor de almacenamiento

Archivo → Almacenamiento local muestra:
- uso y cuota (`navigator.storage.estimate`);
- el desglose de medios, proxies, fuentes, formas de onda y proyectos;
- el botón «Hacer persistente».

Las acciones de borrado piden confirmación:
- **Borrar proxies** y **borrar formas de onda** se regeneran solos, así que piden **una** confirmación.
- **Borrar medios huérfanos** (los que no usa el proyecto abierto ni ningún proyecto guardado) y **borrar todo** piden **doble confirmación**.

### Atajos (pulsa `?`)

| Atajo | Acción |
|---|---|
| Ctrl/Cmd+E | Exportar vídeo |
| I / O | Punto de entrada / salida de exportación |
| Alt+X | Borrar entrada/salida |
| ? | Hoja de atajos con buscador |
| Espacio, ←/→ | Reproducción y paso a paso |
| V, C, B, N, Y, U | Herramientas de la línea de tiempo |
| Ctrl+Z / Ctrl+Shift+Z | Deshacer / rehacer |
| Ctrl+Shift+P | Previsualizar con proxies (Fase 4) |

La lista completa está en el propio diálogo (`ui/modals/shortcuts-modal.ts`).

### Tests y métricas (Fase 6)

- **799 tests en 86 archivos.** Los 696 previos siguen sin cambios. Las suites nuevas son `export-basics`, `export-muxers`, `export-gif`, `export-pipeline`, `export-controller`, `export-browser`, `export-ui`, `project-package` y `pwa-register`.
- Cobertura de `src/export/`: **97,4 % de líneas / 86,1 % de ramas** (`npx vitest run --coverage`).
- Bundle inicial: **≈153 KB gzip** (< 180 KB). Exportación, GIF, paquete y diálogos van en chunks bajo demanda.

### Checklist demo de la Fase 6

1. Importa un vídeo, ponlo en la línea de tiempo y pulsa **Ctrl+E**. Elige «YouTube 1080p» → Exportar. Verás la vista previa, los fps y la ETA, y al terminar podrás descargar el `.mp4`.
2. Marca **I** y **O**, elige «Entrada/salida» en el rango y exporta con el preset «GIF corto».
3. Empieza una exportación y pulsa Escape: pide confirmación y, al aceptar, se cancela sin dejar recursos colgados.
4. Archivo → Paquete de proyecto → Exportar. Luego ábrelo en otra ventana privada con «Abrir paquete».
5. Archivo → Almacenamiento local. Borra los proxies (una confirmación) y comprueba que «Borrar todo» pide dos.
6. `npm run build && npx vite preview --host 0.0.0.0`: instala la app, desconecta la red y recarga; el editor sigue funcionando.

## Fase 5 — keyframes visuales, stack de efectos, titulación avanzada y presets

Todo sigue siendo local: las fuentes viven en OPFS (`/fonts/<uuid>.<ext>`),
el impulso de la reverb se sintetiza en RAM dentro de un Web Worker y los
presets se guardan en `ConcatProjectDB.user_presets`. Ningún módulo F1–F4 cambió
de arquitectura: todo entra como `EditOperation` nuevas y en `extra`
(`clip.extra.effects.stack/audioStack`, `clip.extra.advanced_text`,
`doc.extra.fonts`) con lectores estrictos que toleran claves desconocidas.

| Área | Módulos | Notas |
|---|---|---|
| Operaciones | `editor/effects-operations.ts`, `editor/keyframe-operations.ts`, `editor/text-operations.ts` | `AddVideoEffect`, `RemoveVideoEffect`, `ReorderVideoEffects`, `UpdateEffectParam` (fusión 600 ms), `ToggleEffect`; `UpdateKeyframeCurve` (cubic-bezier con x∈[0,1], y libre ±3), `MoveKeyframeValue`; `UpdateTextStyles`, `AddCustomFont`/`RemoveCustomFont`. Todas reversibles y validadas (`EditError` → toast). |
| Keyframes en el timeline | `ui/timeline/keyframe-track.ts`, `keyframe-node.ts`, `ui/interactions/keyframe-drag.ts`, `curve-drag.ts` | Botón **⏷** en la cara del clip abre una sub-pista de 64 px: línea central, curva interpolada con `core/animate.ts` (`KeyTrack`/`bezierYAtX`) y rombos ◆. Arrastre horizontal = tiempo `Rational` con imán al playhead (8 px, `Alt` lo desactiva), vertical = valor 0–100 % del rango de la propiedad, `Shift` bloquea el eje. Arrastrar un tramo lo curva (ease-in/out). Doble clic añade un ◆; clic en la etiqueta cambia de propiedad. Un gesto = un paso de historial. |
| Editor Bézier | `ui/inspector/bezier-editor.ts`, `keyframe-curve-section.ts` | Canvas 150×150, P0(0,0)–P3(1,1), x1/x2 limitados a [0,1], y libre (ventana −0,5…1,5); presets Linear / Ease-In / Ease-Out / Ease-In-Out / Hold; teclado (1/2 elige asa, flechas, `Shift` ×10, Enter); vista previa en vivo sobre la sub-pista. |
| Stack de efectos | `media/effects/*`, `render/video-effects-engine.ts`, `ui/inspector/effects-stack-section.ts` | Vídeo: desenfoque gaussiano de 2 pasadas, viñeta (radio/suavidad), pixelado `floor(uv·bloques)/bloques`, ruido animado por tiempo, glitch (desplazamiento RGB + bandas). WebGL2 con ping-pong de FBO; fallback Canvas 2D (`ctx.filter` o CPU). Orden en el compositor: Source → Crop → Chroma (F4) → **Stack (F5)** → Color (F4) → Transform → Blend/Opacidad. Audio: delay (10–2000 ms, feedback ≤0,95, mix), reverb (Convolver + IR sintético), chorus; en serie tras la cadena F4 del `AudioMixer`. Filas reordenables con arrastrar y soltar o `Alt+↑/↓`, bypass y ×. |
| Reverb IR | `media/effects/reverb-ir-generator.ts`, `workers/reverb-worker.ts` | Ruido blanco × e^(−t/τ) con low-pass de un polo (damping) por canal; `roomSize` fija el RT60 (0,3–5 s, τ = RT60 / ln 1000). Worker con transferencia de buffers y fallback asíncrono troceado; caché LRU de 8 colas. |
| Titulación | `render/text-engine.ts`, `render/advanced-text.ts`, `render/font-loader.ts`, `storage/font-store.ts`, `ui/inspector/text-advanced-section.ts`, `ui/components/font-manager-modal.ts` | Caja de fondo (`measureText` + padding + `roundRect`), borde, sombra, brillo, relleno sólido o degradado (si `fill` es un array), máquina de escribir `progress = (t − inicio)/duración` sobre los code points con cursor opcional. Fuentes `.ttf/.otf/.woff/.woff2` validadas por magic bytes, guardadas en OPFS y registradas con `FontFace` + `document.fonts.add`. |
| Presets | `presets/*`, `ui/inspector/presets-section.ts` | Integrados: Fade In, Zoom In, Zoom In + Desenfoque, Slide Left/Right, Bounce, Typewriter, Cinematic Title, Neon Glow. Propios (`UserPreset{id,name,type,data}`) capturados del clip. Aplicar es una sola `ApplyPresetOperation` (deshacible). |
| VU estéreo | `ui/components/vu-meter-stereo.ts`, hook `addMasterTap` en `player/audio-mixer.ts` | Máster → `ChannelSplitter` → 2 `AnalyserNode`; pico en dBFS (−60…0), peak-hold 1,5 s, LED de clip 2 s (clic para reiniciar), bucle `requestAnimationFrame`, colores de las variables del tema. |

### Compatibilidad (Fase 5)

| Capacidad | Chrome/Edge 113+ | Firefox 120+ | Safari 17+ |
|---|---|---|---|
| Stack de vídeo (WebGL2) | ✅ | ✅ | ✅ (Canvas 2D si no hay contexto) |
| Desenfoque Canvas 2D | `ctx.filter` | `ctx.filter` | CPU (sin `ctx.filter`) |
| `FontFace` / `document.fonts` | ✅ | ✅ | ✅ |
| `ConvolverNode` / `ChannelSplitter` | ✅ | ✅ | ✅ |
| `roundRect` (caja de texto) | ✅ | ✅ (112+) | ✅ (16+); trazado manual si falta |
| Fuentes en OPFS | ✅ | ✅ | ✅ (memoria de sesión si OPFS falla) |

### Notas de diseño

- **Una sola conexión IndexedDB v3** (`projects` + `user_presets`) compartida
  por `ProjectStore` y `PresetManager`: abrir otra conexión a otra versión
  quedaría bloqueada.
- **Keys absolutos**: `key.ease` es la curva con la que se *llega* a ese key
  desde el anterior; por eso el primer ◆ avisa de que su curva no tiene efecto.
- **Bundle**: el motor de efectos de vídeo (shaders + kernels de CPU), el
  gestor de fuentes y los diálogos de la Fase 4 se cargan bajo demanda
  (`import()`), lo que mantiene el chunk principal por debajo de 150 KB gzip.
  Hasta que llega el motor, los frames se pintan sin stack, igual que en la Fase 4.
- **Deshacer**: `Ctrl+Z` y el botón ↶ de la cabecera recorren la historia de
  la sesión de edición, que incluye inspector, timeline, presets y fuentes.

### Tests (Fase 5)

**696 tests en 77 suites, 0 fallos** (los 550 de F1–F4 intactos + 146 nuevos):
operaciones de efectos, matemática Bézier y clamp, motor de texto (caja de
fondo, typewriter, degradado, sombra), efectos de vídeo (CPU/Canvas 2D),
efectos de audio y cadena en serie, IR de reverb (decay, damping,
determinismo, worker), presets (IDB, aplicar + deshacer), sub-pista de
keyframes, arrastre con imán, curvas, editor Bézier (puntero y teclado),
secciones del inspector, gestor de fuentes y VU meter.
`npm run typecheck` sin errores; `npm run build` → chunk principal 148 KB gzip.

### Checklist demo de la Fase 5

1. Clip de vídeo → **⏷** en su esquina: se abre la sub-pista. Doble clic añade ◆; arrástralos (imán al playhead, `Alt` sin imán, `Shift` bloquea eje).
2. Selecciona un ◆ → inspector **Curva del keyframe**: arrastra las asas (x no sale de [0,1], y sí) o usa los presets.
3. Clip de texto → **Titulación avanzada**: borde, sombra, caja de fondo; **Máquina de escribir** con duración 2 s.
4. **Gestionar fuentes…** → añade un `.ttf` → elígelo en *Fuente*.
5. Clip de vídeo → **Stack de efectos**: añade Desenfoque y Viñeta, reordénalos arrastrando (o `Alt+↑/↓`).
6. Reproduce: el **VU** estéreo de la cabecera marca L/R, mantiene el pico 1,5 s y enciende el LED si llega a 0 dBFS.
7. Clip de audio → Stack → **Reverb** (tamaño de sala, damping, mezcla).
8. **Presets** → «Zoom In + Desenfoque» y después `Ctrl+Z`: el clip vuelve a su estado anterior en un solo paso.

## Fase 4 — pipeline de medios avanzado

El equivalente web de `concat-media` / `concat-speech` / `concat-effects`
(`src/crates/*`). Todo corre en el navegador: FFmpeg.wasm se sirve desde
`/vendor/ffmpeg/` (mismo origen, sin CDN) y solo se carga si WebCodecs falla.

| Área | Módulos | Notas |
|---|---|---|
| Proxies | `media/proxy/*`, `storage/proxy-store.ts`, `workers/proxy-worker.ts` | Auto si ≥1920×1080, >8 Mbps o HEVC/AV1/ProRes. 1280×720@30 2 Mbps H.264 (bajo: 640×360@24 800 Kbps), aspecto exacto. Cola con prioridades (2 en paralelo, 1–4), cancelar/reordenar, 1 reintento. OPFS `/proxies/{id}.mp4` + IDB `ConcatProxyDB.proxies`, SHA-256, LRU de 5 GB, limpieza de huérfanos. Botón **Proxy** / `Ctrl+Shift+P`. La exportación lee siempre el original (`MediaPool.originalFrames()`). |
| FFmpeg | `media/ffmpeg/*`, `workers/ffmpeg-worker.ts`, `vendor/ffmpeg/` | `@ffmpeg/core` 0.12.10 de un solo hilo (sin SharedArrayBuffer). Probe, decodificación a frames, extracción de audio, transcodificación. Se descarga tras 2 min sin uso. `FormatDetector` identifica el contenedor por magic bytes (16 KB). |
| Audio | `media/audio/*`, `workers/pitch-worker.ts` | Pitch/stretch 0,25–4× (PSOLA + phase vocoder), EBU R128 (BS.1770-4, bloques de 400 ms, gates −70/−10), EQ de 5 bandas Biquad, compresor / limitador con lookahead / puerta (AudioWorklet), curvas de fade, enrutado de canales. Hook en `player/audio-mixer.ts`. |
| Visión | `media/vision/*`, `render/vision-pipeline.ts`, `workers/chroma-worker.ts` | Chroma key (distancia YUV), supresión de derrame, luma key, feather de bordes, color grading de 12 parámetros en luz lineal, LUT `.cube` 3D con interpolación trilineal, cuentagotas. WebGL2 con fallback a Canvas 2D; worker de CPU para trabajo offline (previsualizaciones de LUT, exportación). |
| Subtítulos | `media/subtitles/*` | SRT/VTT (BOM, etiquetas, cue settings, STYLE/REGION/NOTE, karaoke), parseo parcial con avisos, round-trip exacto, pistas dedicadas abajo al centro. |
| Relink | `media/relink/*`, `workers/scanner-worker.ts` | Puntuación: nombre 0,4 · duración ±1 frame 0,3 · resolución 0,1 · hash 0,2 (si el hash coincide, 1,0). Automático si >0,8. Mantiene id y ediciones; es una sola operación deshacible. |
| Importación | `media/import/*` | `BulkImporter` (AsyncGenerator, 1–8 en paralelo, agrupación, cancelable) y `MetadataExtractor` (lectura de moov: rotación, encoder, fecha). |
| UI | `ui/inspector/*-section.ts`, `ui/modals/*`, `ui/media-context-menu.ts`, `app/*` | Secciones de chroma, color/LUT (intensidad, vista dividida), audio FX y subtítulos. Diálogos accesibles (focus trap, ARIA, Escape, restauración del foco), navegador de LUTs con flechas + Enter, menú contextual de medios, insignia "P". |

Los efectos se guardan en `clip.extra.effects` (versionado). En la Fase 5
pasarán a un modelo propio; el lector ya tolera claves desconocidas.

### Matriz de compatibilidad

| Capacidad | Chrome/Edge 113+ | Firefox 120+ | Safari 17+ |
|---|---|---|---|
| Decodificación (WebCodecs) | ✅ | ✅ (130+); antes, fallback `<video>`/FFmpeg | ✅ (vídeo); audio vía Web Audio |
| Codificación de proxies | WebCodecs H.264 | FFmpeg.wasm (WebM VP8) | WebCodecs H.264 (FFmpeg si falla) |
| HEVC / ProRes / AVI / FLV | Proxy vía FFmpeg | Proxy vía FFmpeg | HEVC nativo; el resto vía FFmpeg |
| OPFS | ✅ | ✅ | ✅ |
| WebGL2 (visión) | ✅ | ✅ | ✅ (fallback Canvas 2D si no hay contexto) |
| AudioWorklet (puerta) | ✅ | ✅ | ✅ |
| File System Access (carpetas) | ✅ | ❌ → `<input webkitdirectory>` | ❌ → `<input webkitdirectory>` |
| EyeDropper API | ✅ | ❌ → clic en la previsualización | ❌ → clic en la previsualización |

### Módulos auxiliares (no listados en el manifiesto)

`workers/worker-client.ts` (RPC + cierre por inactividad a los 30 s),
`editor/effect-operations.ts`, `media/import/format-support.ts`,
`media/audio/{fft,biquad,dynamics,audio-buffer,audio-effects}.ts`,
`media/clip-effects.ts`, `media/vision/{color-space,lut-library,vision-worker}.ts`,
`media/relink/scanner-handlers.ts`, `ui/media-tools.ts` (registro de servicios para la UI),
`ui/inspector/{fields,effect-host}.ts`, `ui/modals/dialog.ts`,
`app/{media-toolkit,effect-resolvers}.ts`.

### Notas de diseño

- **Relink sin hash**: si un candidato no tiene hash comparable, el resto de
  pesos se renormaliza (÷0,8) para que una coincidencia perfecta de nombre,
  duración y resolución siga pudiendo superar 0,8.
- **Feather**: en GPU es un desenfoque separable del alfa; en CPU el
  `blurPlane` usa clamp-to-edge (no conserva energía en los bordes).
- **Subtítulos**: el marcado original del cue va en `clip.extra.subtitle`,
  así que exportar al mismo formato es byte a byte idéntico.
- **FFmpeg**: el core precompilado tiene memoria fija, así que el
  escalado 512 MB→1 GB del enunciado no es posible en runtime; documentado en
  `vendor/ffmpeg/README.md`.
- **Previsualización vs exportación**: el preview usa el proxy si existe y
  está activado; la exportación usa `MediaPool.originalFrames()`.

### Checklist demo de la Fase 4

1. Importa un vídeo 1080p o 4K: aparece la insignia **P** con su progreso y luego "Proxy listo".
2. `Ctrl+Shift+P` alterna previsualización proxy/original (botón **Proxy** en la cabecera).
3. Clic derecho en un medio: metadatos, proxy 720p/360p, borrar proxy, volver a vincular, eliminar de OPFS.
4. Inspector de un clip de vídeo → **Chroma key**: cuentagotas sobre el fondo verde y ajusta similitud/suavidad.
5. **Color** → Explorar… (flechas + Enter), intensidad y vista dividida; Archivo → Cargar LUT… con un `.cube` (los errores indican la línea).
6. Clip de audio → **Efectos de audio**: EQ, compresor, normalizar EBU R128, tono.
7. Archivo → Importar subtítulos (`.srt`/`.vtt`) → pista nueva; Exportar SRT/VTT.
8. Archivo → Importar carpeta… (concurrencia, agrupación, cancelar).
9. Abre un proyecto cuyos medios no estén en OPFS → "Medios sin conexión…" → Buscar en carpeta → Aplicar.

## Running it

```bash
cd web
npm install
npm test                # 200 tests: engine + Fase 2 modules
npx vitest run --coverage
npm run dev             # editor on http://localhost:5173
npm run build           # static bundle in web/dist — open it from anywhere
```

Everything is local: the only dependency installs are dev tooling (TypeScript,
Vite, Vitest, jsdom, coverage). The app itself makes no network requests.

## The demo checklist (Fase 2 acceptance)

In the running app, all offline:

1. The complete layout renders — header, media panel, preview, inspector,
   timeline; drag the panel edges to resize.
2. Drop an MP4 on the media panel (or `+ Importar`) — its thumbnail appears.
3. Double-click the item — a clip lands on the timeline at the playhead.
4. Press Space (or ▶) — the video plays on the preview canvas.
5. Press Space again — it pauses where it stands.
6. Drag/click the scrub bar or the ruler — the playhead seeks, the frame
   follows.
7. The timecode display updates live (`HH:MM:SS:FF`; `HH:MM:SS;FF` on NTSC
   rates) and accepts a typed jump.
8. Audio plays in sync (mute/solo/VU on the track headers).
9. `Ctrl+S` — "Guardado" toast; the save state reads *Guardado*.
10. Reload the page — the library comes back from OPFS; `Archivo → Abrir`
    reopens the saved project with its clips.
11. Cut the wire: nothing breaks, nothing phones home.

`tests/boot.test.ts` runs this same checklist automatically in jsdom.

## Structure

```
web/
├── index.html            the editor shell mounts into #app
├── src/
│   ├── main.ts           EditorApp: wires every service and flow
│   ├── styles.css        themable chrome (variables set by ThemeManager)
│   ├── editor/           Fase 3: the edit engine
│   │   ├── operations.ts     35 reversible ops + EditError + helpers
│   │   ├── history.ts        EditHistory: undo/redo, transactions, merge
│   │   ├── selection.ts      SelectionManager + marker hit-testing
│   │   ├── clipboard.ts      copy/cut/paste with fresh identities
│   │   └── snapping.ts       SnapEngine: candidates + priority + threshold
│   ├── session/edit-session.ts EditSession: high-level commands over it all
│   ├── core/             ← port of the concat-core crate (Fase 1, untouched)
│   │   ├── rational.ts   exact rational seconds (bigint, i64 contract)
│   │   ├── time.ts       FrameRate, TimeRange
│   │   ├── arena.ts      generational Arena<T> + Id<T>
│   │   ├── animate.ts    Ease, KeyTrack, Animation
│   │   ├── retime.ts     SpeedCurve
│   │   └── timeline.ts   Clip, Transform, Blend, Track, Timeline
│   ├── model/            ← port of concat-project (Fase 1, untouched)
│   │   ├── wire.ts       tolerant readers, enums, KeyEase
│   │   └── document.ts   concat.json: migrate → parse → settle → write
│   ├── session/          document ⇄ engine bridge (touches neither core nor model)
│   │   ├── editor-clip.ts    EditorClip: doc extras + keyed base + Animation ride
│   │   ├── editor-session.ts EditorSession: document, engine Timeline, rebuild()
│   │   └── history.ts        undo/redo snapshots in wire form
│   ├── render/           the compositor
│   │   ├── compositor.ts     renderFrame: bottom-first, four engine calls
│   │   ├── transform.ts      fitRect, transformMatrix, inversion, hit-test
│   │   ├── blend.ts          Blend → globalCompositeOperation
│   │   ├── text-renderer.ts  titles: wrap, stroke, shadow, plate
│   │   └── types.ts          RenderContext2D/RenderTarget/RenderImage/FramePool
│   ├── media/            local media pipeline
│   │   ├── demuxer.ts        container sniffing + MP4/MOV sample tables
│   │   ├── waveform-generator.ts  peaks (min/max) + IndexedDB cache
│   │   ├── waveform-worker.ts     the worker behind them
│   │   ├── decoder.ts        WebCodecs first, <video> fallback, LRU frame cache
│   │   ├── thumbnail.ts      scaled stills + cache
│   │   └── media-pool.ts     MediaPool: decoders, frames, thumbnails
│   ├── player/           playback
│   │   ├── timecode.ts       HH:MM:SS:FF, drop-frame 29.97/59.94
│   │   ├── audio-mixer.ts    multitrack mix: mute/solo/VU/fades
│   │   └── player.ts         PreviewPlayer: clock, render loop, drift resync
│   ├── storage/          persistence
│   │   ├── idb.ts            promise wrapper + in-memory fallback
│   │   ├── media-store.ts    OPFS bytes + IndexedDB metadata
│   │   ├── project-store.ts  ConcatProjectDB records {name, document}
│   │   └── settings-store.ts localStorage settings
│   └── ui/               the shell
│       ├── timeline/         Fase 3: view, ruler, clip/transitions/waveform
│       │                     renderers, toolbar, minimap, zoom, menus…
│       ├── interactions/     drag-manager, clip/trim/split/selection drags,
│       │                     keyboard-shortcuts
│       ├── inspector/        clip / project / multi sheets
│       ├── editor-layout.ts  workspace grid + resizers
│       ├── header-bar.ts     menus, save state, undo/redo, settings modal
│       ├── media-panel.ts    import + library
│       ├── preview-panel.ts  canvas, transport, timecode, scrub
│       ├── timeline-panel.ts lanes, clips, playhead, drag/trim
│       ├── inspector-panel.ts clip & project properties
│       ├── notifications.ts  toasts + confirmations
│       ├── modal.ts          dialogs
│       ├── theme-manager.ts  dark / light / cyberpunk
│       └── shortcuts.ts      keyboard bindings
└── tests/                200 tests (Fase 1 suites + Fase 2 modules)
```

## Fase 2 architecture notes

- **`core/` and `model/` are read-only.** The session layer extends the
  engine's `Clip` (`EditorClip`) and re-derives the engine `Timeline` after
  every document mutation (`EditorSession.rebuild`): the document is the one
  source of truth, the engine is pure derivation.
- **Document keys are absolute** and ride over a neutral keyed base (scale/
  opacity/volume base 1, offsets/rotation base 0) through the engine's own
  `Animation` — the product is identical to `transform_at`/`opacity_at`/`volume_at`.
- **`fade_in`/`fade_out` in `concat.json` are *audio* ramps**; the picture
  fade comes from `transition_in.duration` (`videoFadeIn`).
- **WebCodecs first**: `'VideoDecoder' in window` + a demuxed `avc1/avc3/
  hvc1/hev1` track feeds `VideoDecoder`; everything else uses the media
  element path. Audio prefers `AudioDecoder` over `decodeAudioData`.
- **OPFS is mandatory on import** — the file bytes are copied to `media/<id>`
  before the import resolves; a browser without OPFS keeps a session mirror
  and says so, never a silent dependence on the original `File`.
- **Every decoded frame is closed** (`frame.close()`, LRU eviction, decoder
  teardown on `destroy`), Object URLs are revoked.
- **Render types are structural subsets** of Canvas 2D, so tests drive the
  compositor with recording doubles and zero casts. Strict TypeScript
  throughout: no `any`, no `@ts-ignore`, no `as unknown as`.

## Test & coverage

**303 tests, 27 suites, 0 failures** (200 from Fase 1–2 kept green + 103 new).
Fase-3 suites cover `apply` + `inverse` round-trips of every operation,
history transactions/merge, selection, clipboard, snapping, waveforms and the
integration flow (drag → undo → redo).

Fase 3 modules (lines covered):

| Module | Lines |
|---|---|
| `editor/snapping.ts` | 100% |
| `session/edit-session.ts` | 94% |
| `editor/selection.ts` | 97% |
| `editor/history.ts` | 89% |
| `editor/operations.ts` | 86% |
| `editor/clipboard.ts` | 86% |
| **`editor/` aggregate** | **87.5%** |

Fase 2 modules (lines covered):

| Module | Lines |
|---|---|
| `render/compositor.ts` | 100% |
| `render/transform.ts` | 100% |
| `player/timecode.ts` | 100% |
| `session/history.ts` | 100% |
| `storage/media-store.ts` | 99% |
| `player/audio-mixer.ts` | 99% |
| `media/media-pool.ts` | 91% |
| `storage/project-store.ts` | 89% |
| `media/demuxer.ts` | 82% |

(The DOM-coupled seams — `decoder.ts` WebCodecs branches, `thumbnail.ts`
canvas paths, the real IndexedDB adapter and the `ui/` widgets — are exercised
through `tests/boot.test.ts` and by hand in the browser.)

## Rust → TypeScript mapping (Fase 1, still current)

| Rust (`concat-core`) | TypeScript | Why |
|---|---|---|
| `animate::Track` | `KeyTrack` | `timeline::Track` also exists |
| `timeline::Clip` fields (`source_start`, …) | same snake_case fields | kept verbatim so diffs against the Rust stay trivial |

Faithfulness details worth knowing:

- **`Rational` uses `bigint`.** The Rust type computes in `i128` and stores
  `i64`; `number` (f64) would reintroduce exactly the frame drift the module
  exists to prevent.
- **`Clip::source_time_at` is one function** in both languages — the affine
  map every trim, ripple, slip and retime agrees on.
- **The document reader degrades, never crashes** and **`settle` runs the
  full tidy pass** — exactly the standing rules of `doc.rs`.

## Phases

| Fase | Scope | Status |
|---|---|---|
| 1 | Core model & project schema | done (`web/tests`, `web/README` history) |
| 2 | Compositor, playback, editor shell, local storage | done (`web/tests`, history below) |
| 3 | Interactive multitrack timeline with professional editing | done |
| 4 | Advanced media pipeline: proxies, FFmpeg fallback, audio/vision, subtitles, relinking | done |
| 5 | Visual keyframes, video/audio effect stacks, advanced titling, presets | done |
| 6 | Offline export MP4/WebM/GIF, installable PWA, project packages, storage manager | done |
| 7 | SVG icon system, pro HUD redesign, edge-case & stress QA | **done — this document** |

## License

AGPL-3.0-or-later, same as Concat. SPDX headers are carried on every file.
