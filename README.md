# FlowClip

Local, private clip editor for making viral shorts — TikTok, YouTube Shorts, Reels.
Sibling project to [FlowLocal](https://github.com/HaytonsGB/FlowLocal); same idea, for video
instead of voice: everything runs on your machine, nothing is uploaded, no subscription.

## Status

**Milestone 1 — foundation.** Open a video, scrub it, set in/out points, pick a social
aspect ratio, export with ffmpeg.

Roadmap:

| Milestone | What lands |
| --- | --- |
| **M1** ✅ | Load · preview · trim · reframe · export |
| M2 | Whisper auto-captions with viral styling |
| M3 | Multi-clip timeline, music & SFX tracks |
| M4 | Text, meme and sticker overlays |
| M5 | Transitions, effects, export presets, installer |

## Setup

```bash
npm install
npm run setup:ffmpeg
npm run dev
```

`setup:ffmpeg` downloads a static ffmpeg/ffprobe build into `resources/bin` so you don't
have to install it system-wide. If ffmpeg is already on your PATH, FlowClip will use that
instead and you can skip the step.

## Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause (loops inside the trimmed selection) |
| `I` / `O` | Set clip in / out point at the playhead |
| `←` / `→` | Step one frame |
| `Shift` + `←` / `→` | Jump 5 seconds |

## How it works

- **Electron + React + TypeScript** — the shell and UI.
- **ffmpeg** — all cutting, scaling and encoding. Bundled, never called from the renderer.
- **Aspect presets** scale-to-cover then centre-crop, so vertical exports fill the frame
  instead of letterboxing.
- Trims that don't need reframing use `-c copy` (stream copy) — near-instant, no quality loss.

The renderer has no Node access; it talks to the main process over a narrow preload bridge
(`src/preload/index.ts`).

## Licence

MIT. ffmpeg is downloaded separately under its own licence (GPL for the build used here).
