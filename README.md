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

> **Early build.** Trimming, reframing and layout compositing work end to end. Captions,
> music and multi-clip editing are not built yet — see the roadmap.

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

## Roadmap

| Milestone | What lands | Status |
| --- | --- | --- |
| M1 | Load · preview · trim · reframe · export | ✅ |
| M1.5 | Multi-region layout compositor, packaged installer | ✅ |
| M2 | Whisper auto-captions, running locally | ⬜ |
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

## How it works

- **Electron + React + TypeScript** for the shell and UI.
- **FFmpeg** does all cutting, scaling, compositing and encoding. It is bundled and spawned
  from the main process; the renderer never touches it.
- Layout export builds a `split` / `crop` / `scale` / `overlay` filter graph, one branch per
  region, composited onto a generated canvas.
- Rounded corners come from a generated alpha mask that is rendered once and cached — the
  per-pixel expression that draws one is far too slow to run per frame.
- The renderer has no Node access; it talks to the main process over a narrow preload bridge
  (`src/preload/index.ts`).

## Development

```bash
npm install
npm run setup:ffmpeg
npm run dev
```

`setup:ffmpeg` fetches a static FFmpeg build into `resources/bin` so nothing needs installing
system-wide. If FFmpeg is already on your `PATH`, FlowClip uses that instead.

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
