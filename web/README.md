# Concat Web — Fase 2: compositor, reproductor y shell del editor

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

## Test & coverage (Fase 2 modules)

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
| 2 | Compositor, playback, editor shell, local storage | **this document** |
| 3 | Interactive multitrack timeline (ripple, snap, zoom polish) | next |
| 4 | Media pipeline polish (WebM/MKV demux, waveforms, proxies) | |
| 5 | Effects & keyframes in the UI | |
| 6 | Export pipeline (MP4/WebM, local) | |

## License

AGPL-3.0-or-later, same as Concat. SPDX headers are carried on every file.
