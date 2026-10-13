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
