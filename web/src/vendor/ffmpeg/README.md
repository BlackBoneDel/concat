# FFmpeg.wasm (vendored)

Concat loads FFmpeg.wasm **only from this directory**, served at
`/vendor/ffmpeg/` by the dev server and copied to `dist/vendor/ffmpeg/` on
build (see the `concat-vendor-assets` plugin in `web/vite.config.ts`). The app
never fetches it from a CDN.

| File | Origin | SHA-256 |
| --- | --- | --- |
| `ffmpeg-core.js` | `@ffmpeg/core@0.12.10` → `dist/esm/ffmpeg-core.js` | `67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3` |
| `ffmpeg-core.wasm` | `@ffmpeg/core@0.12.10` → `dist/esm/ffmpeg-core.wasm` | `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7` |

## What this build is

- **FFmpeg 5.1.4** (libavcodec 59.37.100, libavformat 59.27.100), single
  thread (no `SharedArrayBuffer`, so no COOP/COEP headers are needed).
- Licence: **GPL-2.0-or-later** (compatible with Concat's AGPL-3.0-or-later).
- Configure line embedded in the binary includes `--enable-gpl --enable-libx264
  --enable-libx265 --enable-libvpx --enable-libmp3lame --enable-libtheora
  --enable-libvorbis --enable-libopus --enable-zlib --enable-libwebp
  --enable-libfreetype --enable-libfribidi --enable-libass --enable-libzimg`.
- Memory: 32 MB initial heap, grows on demand (declared maximum 2 GB). These
  limits are compiled into the binary; Concat keeps inputs out of the heap by
  mounting them with WORKERFS and unloads the worker after 2 minutes idle.

### Known deviation from the Fase 4 spec

The spec asked for an FFmpeg **6.x** build **without libx264**. No such
prebuilt exists on the registries reachable from the build environment, and
producing one requires the Emscripten toolchain (not available offline).
This official build is vendored instead. Concat **never invokes libx264 or
libx265**: every encode the app requests uses `libvpx` (VP8/VP9) for video and
`libvorbis`/`libopus`/PCM for audio (`media/ffmpeg/ffmpeg-fallback.ts`,
`buildTranscodeArgs`). To swap in a custom LGPL/6.x build, replace the two
files below with any `@ffmpeg/core`-compatible ESM build (it must export
`createFFmpegCore` as default and honour the `mainScriptUrlOrBlob` hash with
`{ wasmURL }`), then update the hashes above.

## Updating

```bash
cd /tmp
curl -sL https://registry.npmjs.org/@ffmpeg/core/-/core-<version>.tgz | tar xz
cp package/dist/esm/ffmpeg-core.js package/dist/esm/ffmpeg-core.wasm \
   <repo>/web/src/vendor/ffmpeg/
sha256sum <repo>/web/src/vendor/ffmpeg/ffmpeg-core.*   # update the table
cd <repo>/web && npm test
```

The wrapper only relies on: `exec(...args)`, `ffprobe(...args)`, `ret`,
`reset()`, `setLogger`, `setProgress`, `setTimeout` and the Emscripten `FS`
(`writeFile`, `readFile`, `unlink`, `mkdir`, `rmdir`, `mount`, `unmount`,
`filesystems.WORKERFS`) — checked at load time by `isFFmpegCore`.
