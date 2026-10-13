# Playback and timeline tools

How the web editor plays media and what each timeline control does, for
people building or debugging it. It describes the code paths as they are
now, and the pitfalls each path has hit.

## Playback

- `PreviewPlayer.play()` (`web/src/player/player.ts`) resumes the
  `AudioContext` **synchronously**, inside the click that called it. Browsers
  accept a resume only from the user's own task; resuming after an `await`
  leaves the context suspended and the sound silent.
- `setOutputVolume(v)` sets the master gain (clamped to 0..1). The preview
  slider and its mute button call it.
- Lane mute and solo are mirrored onto the mixer by `syncTrackStates()`. It runs
  at the end of `buildAudio()` and on every `requestRender()`, so a change takes
  effect without a seek.

## Video frames

- `MediaDecoder.getFrame()` (`web/src/media/decoder.ts`) uses WebCodecs
  (`VideoDecoder`) for MP4 and falls back to a `<video>` element.
- Forward playback feeds only the samples after the last one fed. A seek
  backwards, or a jump into a GOP the decoder has not reached, calls
  `resetPipeline()` and starts at that keyframe.
- Do not call `flush()` on the hot path. After a flush, WebCodecs requires a
  keyframe before the next chunk, and forward playback would fail. The queue
  is drained with `decodeQueueSize`; `flush()` is only the end-of-media fallback.
- After `reset()` the decoder is **unconfigured**. Call `configure()` again
  (the stored `decoderConfig`), or the next `decode()` throws.
- `decodeRange()` shares the decoder, so it runs in the same queue as
  `getFrame()` (`enqueue`). Otherwise a reset in one can abort a flush in the
  other.
- The compositor (`web/src/render/compositor.ts`) resolves every frame first
  (`prefetchFrames`, one request at a time) and only then paints the background.
  Painting first left black on screen for the whole decode time.

## Timeline tools

- **Split** (Ctrl+K, toolbar): `EditSession.splitClipsAt(t, clipIds)` cuts every
  clip under the instant, or only the selected ones, in one gesture. One Ctrl+Z
  restores all of them. A cut within one frame of a clip edge is refused.
- **Mute / solo / lock** are track properties (`SetTrackPropertyOperation`).
  Mute and solo reach the audio through `syncTrackStates()`.
- **Undo and redo** use one history (`EditSession.history`). Do not add a second
  undo stack.
- **Edit keys belong to the timeline keyboard layer** (`ui/interactions/keyboard-shortcuts.ts`).
  `main.ts` must not bind them as well: each key would fire twice. `main.ts`
  keeps the app-level keys (save, import, proxy, export, I/O, help).
- Keys are ignored while a text field has focus or a `.modal-backdrop` is open.

## Key map

- The prompt that drove this work asked for **M = mute**. The code maps **M
  to add-marker** and **S to snap toggle**. Mute is on the track's button. The
  mapping is not changed here; if M should mute, it is a separate decision.

## Troubleshooting

- *Space does nothing*: check that focus is not in the timecode field, and that
  no dialog is open.
- *Video frames are black*: check the console for `DataError` from
  `VideoDecoder.decode`. A key-frame error means a decoder was not reset and
  reconfigured after a flush.
- *No sound after pressing Play*: check `AudioContext.state` after the click.
  It must be `running`.
