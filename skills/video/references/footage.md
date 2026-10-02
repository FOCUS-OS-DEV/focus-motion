# Footage: the user's clips, from the files to the cut

The `footage` track, and the single jobs "a transcript" and "captions on a finished video". `<SKILL>` is the folder of
`SKILL.md`, `<project>` is the project folder. Every tool prints one JSON line: read `ok`, `error` and `warnings`.

## What the user chooses

Only normalizing always runs. The rest follows `features` in `project.json`, set in the brief with one question each:

| Step | Runs when | Ask in the brief (default) |
|---|---|---|
| Normalize the clips | always | nothing |
| Transcript | cuts or captions are on, or a transcript was asked for | nothing before; approval 1 after it |
| Cuts | `features.cuts` | `לחתוך שתיקות וטעויות, או להשאיר את הצילום כמו שהוא?` (לחתוך) |
| Captions | `features.captions` | `כתוביות על הסרטון? איפה במסך: למטה, באמצע או למעלה?` (למטה) |
| Graphics over the footage | `features.graphics` | `להוסיף כותרות או גרפיקה מעל הצילום?` (רק איפה שזה מוסיף) |

One service gets only its steps: captions only is the last section; a transcript only is steps 1 and 2 and the export.

## 1. Normalize

```
node "<SKILL>/scripts/footage.mjs" normalize-all "<project>"
```
- Every video in `source/media.json` that needs it gets `work/norm/<name>.mp4`: rotated, HDR tone-mapped to SDR BT.709,
  constant fps, H.264, AAC 48 kHz, no camera metadata. A second run skips what is done; `"no need"` gives its `use` path.
- One file: `normalize "<file>"`. Facts only: `probe "<file>"`. Nothing uses `source/` clips directly.

## 2. Transcribe, and approval 1

```
node "<SKILL>/scripts/transcribe.mjs" "<project>/work/norm/<name>.mp4" -o "<project>/work/words/<name>.json"
```
- The words file takes the clip's name, in `work/words/`, where `cut` looks for it. Exit code 3: see `references/setup.md`.
- `--script "<file.txt>"` when the speaker read a text: matched words take its spelling, names included.
- Show the `text`: `התמלול נכון? תקנו שמות ומילים אם צריך.` English names often come back in Latin letters or
  misheard ("Cloud Code" for קלוד קוד). Write the corrected text to a file; the times stay, and the reply lists
  `replaced`, `inserted` and `removed`:
  `node "<SKILL>/scripts/transcribe.mjs" fix "<project>/work/words/<name>.json" --text "<project>/work/fixed.txt"`.

## 3. The cut list, and approval 2

`edl.json` at the project root. Times are seconds of the source; cuts land on whole frames.
```json
{ "segments": [ { "id": "s01", "src": "work/norm/a.mp4", "in": 1.2, "out": 6.8 },
                { "id": "s02", "src": "work/norm/b.mp4", "in": 0, "out": 4.5, "fit": "blur" } ] }
```
- Neighbouring segments with the same `id` are one scene; an id may not come back later. Optional: `fit` (`cover`,
  `contain`, `blur` for a landscape clip in a vertical video), `focus` [x, y] for the crop, `zoom`, `video: false`
  (its sound only), or `{ "id", "duration" }` for silence.
- The proposal from the transcript: speech stays, pauses over 0.5 s go, each edge moves to the quietest moment within
  0.15 s (80 ms clear of the listed words), and the last stretch keeps up to 1.5 s after the last word (`--tail`) for
  a closing title, stopping before the next sound. `--split` gives each piece its own scene.
  `node "<SKILL>/scripts/footage.mjs" edl "<project>" "<project>/work/norm/<name>.mp4" --split`
- Hesitations hide inside a word ("ש... עושה", a held "וההה" before a word): the model writes clean text and stretches
  the word over them. A word longer than its letters need (0.09 s a letter + 0.35 s) gets cuts inside it, kept only
  if the recogniser still hears every word whole in the spliced sound: half a minute on an NVIDIA card, a few minutes
  without (`--no-check` skips it). They are in `stretched`, and in `removed` as "hesitation inside".
- Approval 2: show `removed` (what goes, and why) and the seconds saved: `ככה חותכים?`. The numbers alone:
  `node "<SKILL>/scripts/footage.mjs" cut "<project>" --dry-run`.

## 4. Cut, and the voice

```
node "<SKILL>/scripts/footage.mjs" cut "<project>" --set-scenes
```
- Writes `work/base/<id>.mp4` (exact frames, project size), `work/voice-raw.wav` (mono), `work/audio-raw.wav` (the
  original stereo sound), `audio/words.json` on the new timeline, and the scene list into `project.json`.
- The voice of a footage edit stays in sync with the picture, so it is cleaned but never tightened:
  ```
  node "<SKILL>/scripts/voice.mjs" prep "<project>/work/voice-raw.wav" -o "<project>/audio/voice.wav"
  ```
  A recording that `voice.mjs measure` calls poor cannot be recorded again here: polish lightly, go on, and tell the
  user once. Word starts can be a tenth of a second off; this moves them onto the sound (in a noisy room, maybe none):
  ```
  node "<SKILL>/scripts/voice.mjs" words "<project>/audio/words.json" --voice "<project>/audio/voice.wav" --snap -o "<project>/audio/words.json"
  ```

## 5. Captions

```
node "<SKILL>/scripts/footage.mjs" captions "<project>" s01 --position bottom
```
- Creates `scenes/s01` if it is missing (a transparent stage), and adds a caption block between
  `<!-- captions:start` and `<!-- captions:end -->`, with `assets/words.js` (scene seconds) and `assets/captions.js`.
- `--position bottom|middle|top`. `--mode highlight` (the cue appears whole, the spoken word changes colour) or
  `reveal` (words appear as spoken). `--max-words 6`, `--max-chars` per line (16 on a reel), `--lines 2`. A cue that
  starts in the first 0.6 s of the scene is already on frame 0, which may be the thumbnail.
- The look is CSS variables in the block: `--cap-y`, `--cap-size` (90 px at 1080), `--cap-weight`, `--cap-color`,
  `--cap-active-color`, `--cap-active-bg` (a box behind the spoken word), `--cap-bg` (behind each line),
  `--cap-stroke-width`, `--cap-shadow`, `--cap-font`. Edit them in place; `captions` again keeps the block unless
  `--rewire`.
- In a scene you write yourself: `FocusCaptions.add(window.__timelines["main"], words, options)`, options `mode`,
  `maxWords`, `maxChars`, `lines`, `pause`, `lead`, `hold`, `firstAt`. Comments in scene scripts are `//` lines: a
  block comment at the top of a script file breaks the engine's check (the render still works).

## 6. Graphics over the footage, and the look test

```
node "<SKILL>/scripts/footage.mjs" frames "<project>" s01 --at 0.5,1.8
node "<SKILL>/scripts/footage.mjs" overlay "<project>" s01
```
- `frames` is the look test of a footage scene: the scene's graphics at those times over the base clip's own frames,
  as PNGs in `work/frames/<id>-over/`, in about 15 s and with no render. `scene.mjs frames` shows them on nothing.
- `overlay` renders the scene alone as transparent frames and lays them over `work/base/<id>.mp4`. `render.mjs` runs
  it for every footage scene with `"overlay": true`, after the engine's check on a final render. The footage never
  enters the engine: that is why it is fast and why its colours cannot change (bit for bit with `--crf 0`). Measured
  at 1080x1920: 6 s of graphics took 25 to 55 s in the engine, plus 3 to 10 s to composite.
- The scene must be transparent; an opaque one is refused. `--draft` for a quick look, `--workers 1` if memory is short.

## 7. Covering a cut, and footage inside a scene

- **A cutaway: another clip or a photo over a cut while the voice goes on.** Split the stretches (`edl --split`) so
  each cut starts a scene. The cover opens the next scene on its first frame, full frame, so the face never jumps,
  and leaves on a word (a `tl.set` to hidden, or the clip's `data-duration`). Cut the clip with:
  ```
  node "<SKILL>/scripts/footage.mjs" trim "<project>/work/norm/<clip>.mp4" --from 2 --to 3.2 -o "<project>/scenes/s02/assets/cover.mp4"
  ```
  In the scene, as a direct child of the root, sized to the full frame: `<video class="clip" src="assets/cover.mp4"
  muted playsinline data-start="0" data-duration="1.2" data-media-start="0">`. A photo is an `<img>` made with
  `still`. A full-frame cutaway of 1 to 2 s is fine: a 5.8 s scene opening on a 1.2 s cutaway took 111 s, check included.
- **Text behind a person**, on the same fast route: cut the person out of the base clip, and add the cutout to the
  scene's entry in `project.json` as `"subject": "work/s01-subject.webm"`. The graphics go over the clip and the
  person back on top. It runs on the processor with about 1.5 GB of memory: keep such shots short.
  ```
  node "<SKILL>/scripts/footage.mjs" matte "<project>/work/base/s01.mp4" -o "<project>/work/s01-subject.webm"
  ```
- **A small clip in a card or a phone:** the same `<video class="clip">`, about 300 px wide, 2 to 3 s, at most four
  in a scene. **A photo:** `node "<SKILL>/scripts/footage.mjs" still "<photo>" --width 1080 -o "<project>/scenes/s01/assets/<name>.jpg"`.

## Captions only: a finished video in, the same video out with captions

```
node "<SKILL>/scripts/project.mjs" init <slug> --format reel --track footage --title "<שם>"
node "<SKILL>/scripts/project.mjs" ingest "<project>" "<video>"
node "<SKILL>/scripts/footage.mjs" probe "<project>/source/video/<file>"
node "<SKILL>/scripts/transcribe.mjs" "<project>/source/video/<file>" -o "<project>/work/words/<name>.json"
node "<SKILL>/scripts/footage.mjs" cut "<project>" --whole "<project>/source/video/<file>"
node "<SKILL>/scripts/footage.mjs" captions "<project>" s01 --position bottom
node "<SKILL>/scripts/footage.mjs" overlay "<project>" s01
node "<SKILL>/scripts/footage.mjs" mux "<project>/renders/s01.mp4" --audio "<project>/work/audio-raw.wav" -o "<project>/<slug>-v1.mp4"
```
- `<name>` is the file name without its extension. Approval 1 follows the transcript; ask about the position before
  `captions`. If `probe` reports `needsNormalize`, normalize first and use `work/norm/<name>.mp4` from then on.
- Choose `--format` by the video's shape and its frame rate with `--fps` (another shape: set `width` and `height`).
- Subtitle files instead of, or with, burned-in captions:
  `node "<SKILL>/scripts/transcribe.mjs" export "<project>/audio/words.json" --srt "<project>/<slug>.srt"`.
  Hebrew lines that hold Latin words, digits or punctuation get invisible direction marks, because players built on
  libass (mpv, burned-in subtitles) show such lines left to right otherwise. `--marks never` writes plain text.
