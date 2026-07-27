# FlowClip

Local, private clip editor for making viral shorts — TikTok, YouTube Shorts, Reels.

Sibling project to [FlowLocal](https://github.com/HaytonsGB/FlowLocal); same idea, for video
instead of voice: everything runs on your machine, nothing is uploaded, nothing is metered,
no subscription.

## Download

Grab the latest installer from the
[Releases page](https://github.com/HaytonsGB/FlowClip/releases/latest).

FFmpeg is bundled, so there is nothing else to install. Windows may warn that the publisher
is unknown — the installer is not code signed. Choose **More info → Run anyway** if you are
happy to.

> **Early build.** Trimming, layout compositing and captions work end to end. Music and
> multi-clip editing are not built yet — see the roadmap.

## What it does today

**Trim** — open a video, scrub a filmstrip timeline, drag in/out handles, and preview the
selection on loop before exporting. Trims that need no reframing use a stream copy, so they
are near-instant and lossless.

**Layout** — the interesting part. Rather than cropping a 16:9 gameplay clip down to a
vertical slice and throwing most of the frame away, you compose the output from **regions**:
take the facecam from one corner, the gameplay from the middle, the minimap from another,
and stack them into a 9:16 canvas. Each layer has:

- **Fill or Fit** — crop the layer to its slot, or keep the whole frame intact
- **Blurred backdrop** — fitted layers sit on a blurred copy of themselves instead of black bars
- **Rounded corners and borders**
- **Reorderable z-order**, snapping to edges and centre lines, and arrow-key nudging

Layout presets solve themselves against the canvas you pick: a stack on 9:16, a larger
gameplay band on 1:1, and full-screen gameplay with picture-in-picture insets on 16:9.

The output preview is a canvas replaying the same maths FFmpeg will apply, so what you
arrange is what renders.

**Captions** — transcribed on your machine with whisper.cpp. Nothing is uploaded, and there
is no per-minute charge. You get word-level timings, so the caption pops word by word rather
than sitting there as a block of subtitle. Four styles, a colour picker for the spoken word,
and the caption block is dragged into place on the output like any other layer.

The transcript is editable line by line — rewrite a line and it keeps its timing, with the
words re-spaced across it. You can also write captions from scratch: **Add line** drops one at
the playhead, so a clip with no speech at all can still be captioned.

Voice activity detection is on by default. Without it whisper spreads word timings across
silence — given three seconds of quiet before speech it puts the first word at 0:00, so the
opening caption sits on screen before anyone talks.

## Roadmap

| Milestone | What lands | Status |
| --- | --- | --- |
| M1 | Load · preview · trim · reframe · export | ✅ |
| M1.5 | Multi-region layout compositor, packaged installer | ✅ |
| M2 | Local Whisper captions, styled and editable | ✅ |
| M3 | Multi-clip timeline, media pool, music & SFX | ⬜ |
| M4 | Text, meme and sticker overlays | ⬜ |
| M5 | Transitions, effects, export presets | ⬜ |

## Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause (loops inside the trimmed selection) |
| `I` / `O` | Set clip in / out point at the playhead |
| `←` `→` | Step one frame — or nudge the selected box in Layout |
| `Shift` + arrows | Jump 5 seconds — or nudge a box further |
| `Shift` + drag | Resize a layout box keeping its shape |
| `Enter` | Commit a caption line you are editing |

## How it works

- **Electron + React + TypeScript** for the shell and UI.
- **FFmpeg** does all cutting, scaling, compositing and encoding. It is bundled and spawned
  from the main process; the renderer never touches it.
- Layout export builds a `split` / `crop` / `scale` / `overlay` filter graph, one branch per
  region, composited onto a generated canvas.
- Rounded corners come from a generated alpha mask that is rendered once and cached — the
  per-pixel expression that draws one is far too slow to run per frame.
- **whisper.cpp** transcribes locally; captions are burned in as an ASS track, one event per
  word so the timing is exactly what whisper reported. A word stays on screen until the next
  one begins, otherwise the line blinks out during every pause between words.
- The renderer has no Node access; it talks to the main process over a narrow preload bridge
  (`src/preload/index.ts`).

## Development

```bash
npm install
npm run setup:ffmpeg
npm run setup:whisper
npm run dev
```

`setup:ffmpeg` fetches a static FFmpeg build into `resources/bin` so nothing needs installing
system-wide. If FFmpeg is already on your `PATH`, FlowClip uses that instead.

`setup:whisper` fetches whisper.cpp into `resources/whisper` and prunes it — the release
archive is 68 MB of server, streaming and test binaries plus a 49 MB OpenBLAS that made no
measurable difference here (1.60s vs 1.63s on an 11s clip), so only what `whisper-cli` loads
is kept, taking it under 10 MB. Speech models are downloaded on first use rather than
bundled.

## Building the installer

```bash
npm run dist
```

Output lands in `release/`. Two things that will bite you on Windows:

- **Close any running FlowClip first.** A running copy holds `d3dcompiler_47.dll` open, and
  the build fails with `Access is denied` while clearing `release/win-unpacked`.
- **`win.signAndEditExecutable` is off deliberately.** electron-builder otherwise downloads a
  toolchain whose archive contains macOS symlinks, which Windows refuses to create without
  Developer Mode or elevation — and it re-downloads to a fresh directory each attempt, so a
  partial cache never helps. `scripts/after-pack.cjs` stamps the icon and version metadata
  with `rcedit` instead, which needs no download.

The multi-size `.ico` is built by `scripts/make-ico.mjs` rather than an image library, because
generated ICOs are routinely rejected by Explorer when the directory entries are subtly wrong.

## Licence

FlowClip's own source is [MIT](LICENSE).

The installer redistributes **FFmpeg** under the **GPL v3**. FlowClip invokes it as a separate
executable and contains no FFmpeg code, so the two remain separate works. The GPL build is
used because H.264 export depends on `libx264`, which LGPL builds omit. Source and build
scripts: [FFmpeg](https://github.com/FFmpeg/FFmpeg),
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds). Full details in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
