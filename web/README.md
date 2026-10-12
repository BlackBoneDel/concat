# Concat Web — Fase 1: core model & project schema

Port of [`jub0t/Concat`](https://github.com/jub0t/Concat) (the open-source,
cross-platform video editor) to a **100% local web application**. No servers,
no uploads, no telemetry: the edit never leaves the user's browser.

**Fase 1 delivers** the foundation every later phase builds on:

1. The **engine model** — a faithful TypeScript port of the `concat-core`
   crate: exact rational time, generational arenas, keyframe animation,
   speed curves, and the timeline graph (tracks, clips, transforms, blends).
2. The **project schema** — a faithful port of `concat-project`'s
   `model.rs`/`doc.rs`: the `concat.json` document with its tolerant reader,
   migration table, settle pass and writer.
3. The web project skeleton (Vite + TypeScript + Vitest), the boot screen that
   exercises the model in the browser, and unit tests ported from the Rust
   test suites.

## Running it

```bash
cd web
npm install
npm test          # model test suites (ported from the Rust tests)
npm run dev       # boot screen on http://localhost:5173
npm run build     # static bundle in web/dist — open it from anywhere
```

Everything is local: the only dependency installs are dev tooling (TypeScript,
Vite, Vitest). The app itself makes no network requests.

## Structure

```
web/
├── index.html            boot screen (the editor shell arrives with Fase 2)
├── package.json          dev tooling only
├── tsconfig.json         strict TypeScript
├── vite.config.ts        dev server + build + vitest
├── src/
│   ├── main.ts           boot: builds a project, round-trips concat.json
│   ├── styles.css        boot screen styles (editor chrome is Fase 2)
│   ├── assets/           logo mark
│   ├── core/             ← port of the concat-core crate
│   │   ├── rational.ts   exact rational seconds (bigint, i64 contract)
│   │   ├── time.ts       FrameRate, TimeRange (half-open intervals)
│   │   ├── arena.ts      generational Arena<T> + Id<T> handles
│   │   ├── animate.ts    Ease, cubic-bezier solver, KeyTrack, Animation
│   │   ├── retime.ts     SpeedCurve (speed that changes over a clip)
│   │   ├── timeline.ts   Clip, Transform, Blend, Track, Timeline, Project
│   │   └── index.ts
│   └── model/            ← port of concat-project (model.rs + doc.rs)
│       ├── wire.ts       tolerant JSON readers, enums, ranges, KeyEase
│       ├── document.ts   concat.json shape + migrate → parse → settle
│       └── index.ts
└── tests/                unit tests, several ported 1:1 from Rust
```

## Rust → TypeScript mapping

Every engine type and method keeps its Rust name and contract (comments cite
the source file). Two renames, both forced by one TypeScript namespace:

| Rust (`concat-core`) | TypeScript | Why |
|---|---|---|
| `animate::Track` | `KeyTrack` | `timeline::Track` also exists |
| `timeline::Clip` fields (`source_start`, …) | same snake_case fields | kept verbatim so diffs against the Rust stay trivial |

Faithfulness details worth knowing:

- **`Rational` uses `bigint`.** The Rust type computes in `i128` and stores
  `i64`; `number` (f64) would reintroduce exactly the frame drift the module
  exists to prevent. `checkedNew` still refuses values outside `i64`, so a
  future WASM bridge sees identical data. Conversions to `number` happen only
  at the edges (`asNumber`, `approximate`).
- **`Clip::source_time_at` is one function** in both languages — the affine
  map every trim, ripple, slip and retime agrees on.
- **The document reader degrades, never crashes.** Missing fields take the
  struct's `Default` (which is `Clip::blank`), lists keep the entries that
  parse, unknown fields round-trip through each struct's `extra` map, an
  unknown clip kind falls back to `video` (and settles away if its media is
  gone), a document from a later build is refused, and a document that is not
  an object — or has no timeline with a lane — fails the load. Exactly the
  standing rules of `doc.rs`.
- **`settle` runs the full tidy pass** (`ranges::*`, `wrap_rotation`,
  crop/cutout/key clamping, key sorting) so nothing an edit could not have
  produced survives a load — including hostile hand-edits (NaN, Infinity,
  durations of zero).

## Phases (from the port plan)

| Fase | Scope | Status |
|---|---|---|
| 1 | Project structure, Timeline/Clip/Track/Project schema | **this document** |
| 2 | Canvas engine & preview playback (WebGPU/WebGL2 compositor) | next |
| 3 | Interactive multitrack timeline (drag, split, snapping, zoom) | |
| 4 | Media pipeline (WebCodecs / OPFS / IndexedDB) | |
| 5 | Effects & keyframes in the UI | |
| 6 | Export pipeline (MP4/WebM, local) | |

Later phases plug into this model without rewriting it: the compositor will
read `Clip.transform_at` / `opacity_at` / `video_fade_factor`, the mixer will
read `Animation.volume_at` and `SpeedCurve.pieces`, and the file layer already
speaks the same `concat.json` the desktop app writes.

## License

AGPL-3.0-or-later, same as Concat. SPDX headers are carried on every file.
