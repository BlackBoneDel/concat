# Concat Web — Fase 5: keyframes visuales, efectos, titulación y presets

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
4. **Editor shell** — header 48px + media panel 250px + preview canvas +
   inspector 280px + timeline 250px, all resizable, dark/light/cyberpunk
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
| 5 | Visual keyframes, video/audio effect stacks, advanced titling, presets | **this document** |
| 6 | Export pipeline (MP4/WebM, local) | |

## License

AGPL-3.0-or-later, same as Concat. SPDX headers are carried on every file.
