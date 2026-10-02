# Build: writing and rendering scenes

The contract between a scene, the tools and the engine (HyperFrames 0.8.106, pinned). Every fact here was measured.
Tools print one JSON line on stdout and notes on stderr. Exit 0 ok, 1 failed, 2 bad usage, 3 missing dependency.

## Setup

```
node "<SKILL>/scripts/doctor.mjs" --write --selftest
```
- Checks Node 20+, ffmpeg and ffprobe (plus `zscale` and `tonemap` for HDR clips), the engine and its browser, free
  disk and memory. Each item in `missing` carries the install command for this OS (winget, brew, apt).
- GSAP is not shipped: the doctor downloads the pinned file once into `~/.focus-motion/vendor/gsap.min.js` (size and
  hash checked). `add-scene` copies it into each scene's `assets/`, so renders never need the network.
- `--selftest` renders `assets/examples/hello` and checks 120 frames, yuv420p, bt709 (about 20 s). Show the user
  `selftest.video`. `--write` saves `~/.focus-motion/state.json`. `--with-transcribe` adds the Python check.

## The project folder

```
node "<SKILL>/scripts/project.mjs" init my-video --format reel --track idea --title "סרטון בדיקה"
node "<SKILL>/scripts/project.mjs" ingest my-video "חומרים מהלקוח"
```
- `init` makes `source/{video,photos,audio,brand,other}/`, `work/`, `audio/`, `scenes/`, `renders/`, `_versions/`
  and `project.json`. The name is lowercase English with hyphens; the Hebrew name goes in `--title`.
- `project.json` keeps `fonts` (default `["Rubik"]`) and `features`, which Claude edits by hand. A missing key is
  never an error. The keys and what each controls are in `references/conversation.md` (the extras table).
  Defaults: idea and voice have no captions and no cuts; footage has both; `voiceTighten` is on for voice only; `sfx` and `lookTest`
  are on, `music` is off, `voicePolish` is on for voice and footage.
- `ingest` copies files and whole folders (`--move` only when the user asks) into `source/<type>/`, by extension and
  probe (an mp4 with only sound goes to audio). Names are made safe, Hebrew kept: `צילום #2 & גרסה.mov` becomes
  `צילום-2-גרסה.mov`, a clash gets `-2`. `--as brand` files a logo. A second ingest of the same files skips them.
  It merges `source/media.json` (`file, type, original, bytes, duration, width, height, fps, rotation, hdr,
  hasAudio`) and returns `counts`, `videoSeconds` and `flags`: `hdr`, `noAudio`, `rotated`, `large` (1 GB+).

## Scenes

```
node "<SKILL>/scripts/project.mjs" add-scene my-video s01 --duration 3
node "<SKILL>/scripts/project.mjs" add-scene my-video s02 --duration 2.5 --fonts "Rubik,Fredoka"
node "<SKILL>/scripts/project.mjs" set-scenes my-video scenes.json
node "<SKILL>/scripts/project.mjs" status my-video
```
- `add-scene` copies `assets/template/scene`, fills the size, id, length, fonts and safe zone, and appends the scene
  to the list. `--kind footage` makes a transparent overlay scene over `work/base/<id>.mp4`.
- `set-scenes` takes a JSON array of `{id, start, end, kind?, clip?, overlay?, note?}`. Scenes must start at 0 and be
  contiguous; on any error nothing changes. The old list goes to `_versions/`. It warns when a scene's
  `data-duration` no longer fits its slot.
- `status` lists every scene: `exists`, `rendered`, `stale` (and why), `quality` (draft or final), plus `features`,
  `needRender`, the current cut and its notes count.

A scene is `scenes/<id>/index.html` with `assets/`. Fonts: `assets/fonts/fonts.json` lists Rubik (default), Heebo
(clean sans), Assistant (humanist), Fredoka (wide display, `font-stretch` 75 to 125%), Frank Ruhl Libre (serif),
Playpen Sans Hebrew (hand), all with Latin. Your own font: `--fonts "Brand=source/brand/Brand.otf"`.

## Rules for index.html (each one broke a render or a lint when ignored)

- Root: `<div id="root" data-composition-id="main" data-start="0" data-duration="<s>" data-width data-height>`.
  The engine renders `ceil(duration x fps)` frames, so write `data-duration` and `DUR` as frames divided by fps,
  rounded DOWN to 4 decimals: 170 frames at 30 fps is `5.6666`. Rounded up (`5.667`) it renders 171.
- One GSAP timeline, `gsap.timeline({ paused: true })`, at `window.__timelines["main"]`. The engine seeks it frame
  by frame. No `Math.random()` (use the template's seeded `rnd()`), no timers, no `requestAnimationFrame`, no
  `repeat: -1`, no CSS transitions or animations.
- The first `fromTo` of an element keeps the default `immediateRender`: its from-values paint at time 0, so an
  entrance at 1.7 s stays hidden until then. With `immediateRender: false` there, our example showed its subtitle
  from frame 0. Every later `fromTo` on the same element takes `immediateRender: false` or goes on a wrapper,
  otherwise its from-values also paint at time 0 (lint: `gsap_repeated_fromto_without_baseline`).
- SVG: grow shapes through attributes (`attr: { r }`, width, height); a GSAP `scale` moves an SVG child off its
  place. Draw lines by tweening `attr: { "stroke-dashoffset": ... }`, not the CSS `strokeDashoffset`.
- No `will-change: transform` on text that scales: it renders blurred. Without it text stays sharp at 9 times.
- Several shots in one file: switch them on the timeline (opacity or visibility at the cut). `class="clip"` on an
  element with children makes lint ask for separate files.
- `dir="rtl"` goes on text elements. On `<html>` it is a lint error: the video renders blank.
- Measure text inside `document.fonts.ready.then(...)`, before the timeline is built: at script time the font has not
  loaded (a word measured 764 px instead of 1023 px).
- Every asset is local under `assets/`. A missing `<img>` is a lint error; a missing font file is not, and only
  `check` (below) reports the 404.
- Frame 0 already shows something moving, the last frame is complete, no fades to or from black: scenes are cut hard.
- Safe zone (the template's `--safe-*` variables, the same numbers as craft.md): reel 250 top, 360 bottom (keep
  above y 1560), 80 sides, and 140 on the right from y 1150 down, where the platform's buttons sit. Square 80 all
  round. Wide 80 top, 110 bottom, 120 sides. Nothing measures this for you: check the peak frames at full size.

Video inside a scene: `<video id="v1" class="clip" src="assets/clip.mp4" muted playsinline data-start="0"
data-duration="2.5" data-media-start="0.5">`. Without `id` lint says `media_missing_id` (it renders frozen); without
`muted` it says `video_missing_muted`. Nesting inside moving or 3D containers works. Measured on a frame-numbered clip:
`data-media-start="0.5"` shows clip frame 15 on scene frame 0, and the two stay frame-locked. No `<audio>`: sound comes
from `cues.json` (scene-local seconds) and the mix.

## Render

```
node "<SKILL>/scripts/render.mjs" my-video s02 --draft
node "<SKILL>/scripts/render.mjs" my-video --changed
node "<SKILL>/scripts/render.mjs" my-video s01 --mblur s01
```
- One scene at a time, in list order; a second render in the same project is refused. Lint runs first and a lint
  error stops that scene (`lint` in its row). Output is forced SDR and checked: size, fps, frame count, yuv420p,
  bt709. A failed or stalled render (nothing printed for 3 minutes) is retried once with `--low-memory-mode`.
- `--draft` captures at half the frame rate with 2 browsers, a light encode and no `check`, then repeats frames up
  to the project rate. Measured on a changed 6 s scene: draft 19.4 s and 19.5 s, final 42.6 s and 40.0 s.
- Final is the default (`--final` says it explicitly). It runs the engine's `check` first, caches the result by the
  scene's hash, and returns it as `gate` (grouped by code, 3 examples each). Gate findings never stop a render.
- `--changed` skips scenes whose render matches the scene folder, the footage clip, fps and size. A final run
  re-renders draft scenes; a draft run accepts finals. `renders/renders.json` records quality, motion blur,
  frames, the engine's phase times and the gate.
- `--mblur` renders at 4x the fps and blends each 4 sub-frames into one (a real shutter). The scene keeps it on
  later renders until `--mblur none`. A 3 s scene took 38 s. Separate copies appear once the blended samples sit
  more than about 4 px apart, so choose by the fastest move's speed in px per frame:

  | Fastest move | Do |
  |---|---|
  | up to about 16 px per frame (480 px/s) | `--mblur <id>` |
  | about 20 to 50 px per frame | `--mblur <id> --shutter 0.5`: the 4 samples cover half the frame. The render takes twice as long |
  | above about 60 px per frame | no blur helps: keep it sharp, use the streaks technique (`cookbook.md`), or shorten the move |

  `--mblur-samples 8` gives the softest look up to 32 px per frame, at the same cost as the half shutter. Look at
  the fastest frame at full size before keeping a blurred render.
- **Large CSS blurs are slow.** One `filter: blur(30px)` on a 620x1300 shadow made a frame capture take 5 minutes
  instead of 8 s. Draw soft shadows and glows with a radial gradient or a blurred image file instead.
- **Decorative layers and the engine's check.** The check treats any layer drawn from an image (`url(...)`) as
  opaque, so a grain texture "hides" every word. Keep a full-frame texture's strength in the layer's own `opacity`,
  under 0.6. A decorative copy of a text (a shine, a glow copy) gets `data-layout-ignore aria-hidden="true"`.
  `data-layout-allow-occlusion` goes on the covered text, never on the layer that covers it.
- **Comments in scene script files are `//` lines.** A block comment at the top of a script file breaks the
  engine's check and its snapshots, while the render still works.
- **A known lint false alarm.** `overlapping_gsap_tweens` fires on a loop that tweens one proxy object at several
  different times. When the times really differ, ignore it.
- Footage scenes: with `overlay: true` render calls `footage.mjs overlay <project> <id>` (plus `--draft`,
  `--workers`); with `overlay: false` it conforms the clip itself to the project size, fps and bt709.
- `--workers n` sets the engine's browsers. The engine's own choice (5 here) spent up to 18 s just starting them.

## Assemble

```
node "<SKILL>/scripts/assemble.mjs" my-video --no-audio
node "<SKILL>/scripts/assemble.mjs" my-video --no-audio --bump
```
- Each render is trimmed, or its last frame held, to its slot's exact frame count, then joined and muxed with
  `audio/mix.wav` (or `--audio file`) as AAC 256k 48 kHz, padded or cut to the picture, with `+faststart`.
- Writes `<name>-v<version>.mp4` at the root and checks frames, size, fps, yuv420p, bt709 and sound before it does.
  `--bump` raises `version` (only if the current version has a cut) and moves older cuts and notes to `_versions/`.
- JSON: `quality` (final, draft or mixed), per scene `held` and `cut` frames, `audio.difference`, `moved`,
  `warnings` (stale renders, mixed quality, a short or long render or sound).

## Which engine command to trust for what

Run the engine only through the tools: `scene.mjs lint|check|frames`, `render.mjs`, `doctor.mjs`. They start the
pinned version with its telemetry, update checks and add-on installs switched off. A bare `npx hyperframes` does
none of that.

```
node "<SKILL>/scripts/scene.mjs" lint my-video s01
node "<SKILL>/scripts/scene.mjs" check my-video s01
node "<SKILL>/scripts/scene.mjs" frames my-video s01 --at 0.5,1.8,0.5
```

| Engine command | Catches | Time | Verdict |
|---|---|---|---|
| `lint` | dir on html, missing `<img>` file, video without `muted` or `id`, GSAP baseline traps | 0.4 to 2 s | Always. Errors are real. |
| `check` | lint, plus script errors, GSAP targets not found, 404s (fonts too), text outside its box or the frame, overlapping text, WCAG contrast | 8 to 40 s | Before final renders. Runtime findings are real. Layout and contrast are noisy on busy scenes. |
| `validate`, `inspect` | subsets of `check` | 5 to 48 s | Deprecated; `validate` once timed out where `check` worked. Not used. |
| `snapshot` (`scene.mjs frames`) | PNG frames at given times, plus a contact sheet | 5 to 15 s | For looking at frames and for seek safety. |

- `check` on a scene whose timeline has no motion yet (the bare template) reports `sweep_static`: the timeline did
  not advance. It disappears once the scene moves.

- On our tests `check` found two real bugs: a GSAP target that did not exist and two text blocks overlapping at
  0.5 s. On a busy production scene (rolling digit strips) it gave 7 layout errors, 64 info items and 97 contrast
  errors for digits caught mid-roll. Look at the frame before acting on a layout or contrast finding.
- Seek safety in about 10 s: `scene.mjs frames my-video s01 --at 1.0,2.0,1.0`. With a repeated time the JSON has
  `same`, which must be `true`. The two captures of 1.0 are then identical, or differ only by a level of rounding in
  a few pixels (45 dB PSNR or more; `repeats` gives the number). A real timing bug gives far less.
- For the finished cut use `check.mjs` and `sheet.mjs` (the gate and contact sheets), and `review-notes.mjs` for the
  user's notes pinned to seconds. Ready techniques (fitting a word, shatter, words on the voice): `cookbook.md`.
