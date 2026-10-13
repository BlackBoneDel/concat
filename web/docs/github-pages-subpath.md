# GitHub Pages: rutas bajo `/concat/`

## Contrato de rutas

- `vite.config.ts` mantiene `base: './'`, `worker.format: 'es'`,
  `build.assetsDir: 'assets'` y el polyfill de module preload.
- Las ocho instanciaciones de Workers ya usan
  `new Worker(new URL('…worker.ts', import.meta.url), { type: 'module' })`.
  `tests/subpath-workers.test.ts` comprueba el AST de **todos** los fuentes
  (incluidos proxy, FFmpeg, waveform, scanner, pitch, chroma y reverb),
  verifica que el destino existe y rechaza rutas de raíz o URLs dinámicas.
  Pitch se instancia en `audio/audio-processor.ts`; el escaneo en
  `relink/folder-scanner.ts` (no hay `auto-scanner.ts`).
- El plugin de vendor conserva la copia de `src/vendor/` a `dist/vendor/`.
  FFmpeg usa `import.meta.env.BASE_URL` con barra final normalizada.
  **Una base `./` debe resolverse contra `document.baseURI`, no contra
  `window.location.origin`**: de lo contrario se pierde `/concat/`.
  Una base absoluta `/concat/` también está cubierta por tests.
- El script y scope del Service Worker usan esa misma base de Vite.
  Manifest, iconos y shell siguen siendo relativos al directorio de la app.
- Las cachés son `concat-web-v8-<build>` y `concat-runtime-v8-<build>`.
  Se conserva el identificador de build para distinguir despliegues.
  Al activar el SW se eliminan las cachés `concat-*` anteriores.
  Se conserva el flujo existente de aviso de actualización / `SKIP_WAITING`.
- El SW solo intercepta GET HTTP(S) del mismo origen **dentro de su scope**.
  No intercepta `blob:`, `data:`, `file:`, rangos ni otros proyectos Pages.
  Solo guarda respuestas basic HTTP 200; 404, 500, parciales y respuestas
  opacas nunca se guardan. Los errores HTTP se devuelven sin sustituirlos
  por una entrada antigua; solo un fallo de red activa el fallback offline.

## Verificación del build (2026-10-13)

```sh
cd web
npm ci
npm test
npm run typecheck
npm run build
npx vite preview --outDir dist --base /concat/ --host 0.0.0.0 --port 4173
```

Resultados:

- **96 archivos de tests, 979 tests aprobados**, sin errores no manejados.
- Typecheck y build aprobados. Persisten avisos no fatales de jsdom sobre
  canvas/navegación y el aviso de Vite de un chunk mayor de 500 kB.
- Prueba de navegador automatizada con Chromium/Playwright sobre
  `http://localhost:4173/concat/`, sin desactivar la seguridad web:
  - Arranque del shell sin `.boot-error` ni errores JavaScript.
  - Todos los JS y CSS emitidos, core JS y WASM con HTTP 200 y tipos distintos
    de HTML; comprobados los bytes mágicos del WASM.
  - El Worker FFmpeg importa el core ESM, instancia WASM y responde
    `{ type: 'complete', result: true }` al mensaje `load`.
  - El Worker waveform devuelve los picos esperados de una señal de prueba.
  - Importación mediante el selector de archivos de un WebM VP8 real,
    generado localmente con canvas + MediaRecorder: se muestran duración,
    resolución y miniatura decodificada de 160×90.
  - Se añade el vídeo al timeline y el botón Reproducir cambia a Pausar.
  - Los Workers observados (FFmpeg, waveform y scanner durante importación)
    cargan exclusivamente desde `/concat/assets/`.
  - Registro activo: `/concat/sw.js`; scope `/concat/`; cachés v8.
  - Ninguna respuesta HTTP de error durante el recorrido.

Los tests ejecutan además el `public/sw.js` real en un contexto aislado para
verificar que HTTP 404/500/206 no se cachean, que los esquemas locales y las
URLs fuera del scope se omiten y que la activación elimina las cachés v7.

Los binarios del navegador y el vídeo de prueba son temporales y no se
incluyen en Git. La verificación usa el build local montado bajo el subpath;
no sustituye la comprobación del despliegue real tras fusionar el PR.

## Sesión de fix final (2026-10-13): deploy, SW v10 y verificación

### Por qué fallaba el deploy de `main`

`Deploy Concat Web to GitHub Pages` falló en el step **Test (vitest)** a los
~33 s del merge de PR #7, y Pages no se actualizó. Los logs del job no son
accesibles desde el sandbox, así que se reprodujo el step en local:

- Node 22.22.3 (el que tiene el repo en `.nvmrc`): **101 ficheros, 1042
  tests, todos en verde**.
- Node 20.20.2 (el que fijaba el workflow): **10 tests fallan** en
  `opfs-media-store.test.ts` con `webidl.util.markAsUncloneable is not a
  function`, y vitest pierde 25 ficheros de test (`1 failed | 75 passed de 76`).

Causa: `jsdom@30.1.2` declara `engines.node` `^22.22.2 || ^24.15.0 || >=26`.
El workflow usaba `node-version: 20`. El fix está en `deploy-gh-pages.yml`
(Node desde `web/.nvmrc`, `npm ci` estricto, verificación del build antes de
publicar); `tests/ci-workflow-guards.test.ts` lo fija para que no vuelva.

### Verificación de producción (Chromium headless, `dist` bajo `/concat/`)

| Comprobación | Resultado |
|---|---|
| `scripts/verify-production.mjs` (import WebM/MP4/WAV/no-media, drag→timeline, audio→pista de audio, playhead, drop global, recarga con SW) | **32/32 PASS** |
| `scripts/verify-sw-upgrade.mjs` (v9 instalada → v10 en espera → `SKIP_WAITING` → solo cachés v10) | **6/6 PASS** |
| `scripts/mutation-check.mjs` (6 guardas de import/timeline) | **6/6 cazadas**, base en verde |

La línea base de `verify-production.mjs` antes de tocar nada ya daba 32/32:
en el código de `main` la importación, la tarjeta optimista (<10 ms), el drop
global, el drag→timeline y el playhead funcionan en producción. Lo que fallaba
era el deploy, no el editor.

### Service worker v10

- `CACHE_VERSION = 'v10'` en `public/sw.js` y `SW_CACHE_VERSION` en
  `src/pwa/sw-register.ts`. La activación borra todas las cachés `concat-*`
  que no sean las de la versión vigente.
- El SW se mantiene **network-first** para todo el origen, incluidos los
  assets con hash. Un cache-first para `/assets/` se probó y se revirtió:
  `tests/service-worker-fetch.test.ts` fija que una respuesta 404/500 no
  consulta la caché y que la caché solo sirve como respaldo ante fallo de
  red. Cambiar eso es una decisión de diseño aparte.
- `SKIP_WAITING` sigue disparándolo la página (botón «Recargar» del aviso).
  No se hace `skipWaiting()` en `install`: recargaría la pestaña sin avisar.
