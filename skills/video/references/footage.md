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

One service gets only its steps: captions only is the last section; a transcript only is steps 1 to 3 and the export.

## 1. Normalize

```
node "<SKILL>/scripts/footage.mjs" normalize-all "<project>"
```
- Every video in `source/media.json` that needs it gets `work/norm/<name>.mp4`: rotation applied, HDR (HLG or PQ)
  tone-mapped to SDR BT.709, constant frame rate at the project fps, H.264, AAC at 48 kHz, camera metadata (location
  included) dropped. A second run skips what is done; a clip that needs nothing reports `"no need"` and its `use` path.
- One file: `node "<SKILL>/scripts/footage.mjs" normalize "<file>"`. Facts only: `probe "<file>"` (`needsNormalize`,
  `reasons`). About one second of work per second of phone footage. Nothing uses `source/` clips directly.

## 2. Transcribe

```
node "<SKILL>/scripts/transcribe.mjs" "<project>/work/norm/<name>.mp4" -o "<project>/work/words/<name>.json"
```
- The words file takes the clip's name, in `work/words/`, where `cut` looks for it.
- First time on a computer: exit code 3 and the `install` commands. Run them (`setup`, plus `setup --gpu` on Windows
  or Linux with an NVIDIA card). The Hebrew model, 1.6 GB, downloads on the first transcript.
- Measured: an NVIDIA card does 30 s of speech in 2.3 s, the processor in 26 s. Loading the model adds about 10 s.
- `--script "<file.txt>"`: names and spelling come from the text the speaker read. `--srt`, `--vtt`, `--txt` <file>: those files too.

## 3. Approval 1: the transcript

Show the `text` and ask `התמלול נכון? תקנו שמות ומילים אם צריך.` English names often come back in Latin letters or
misheard ("Cloud Code" for קלוד קוד). Write the corrected text to a file and run:
```
node "<SKILL>/scripts/transcribe.mjs" fix "<project>/work/words/<name>.json" --text "<project>/work/fixed.txt"
```
The times stay. The reply lists `replaced`, `inserted` and `removed`; the previous file moves to `_versions/`.

## 4. The cut list, and approval 2

`edl.json` at the project root. Times are seconds of the source; cuts land on whole frames.
```json
{ "segments": [ { "id": "s01", "src": "work/norm/a.mp4", "in": 1.2, "out": 6.8 },
                { "id": "s02", "src": "work/norm/b.mp4", "in": 0, "out": 4.5, "fit": "blur" } ] }
```
- Neighbouring segments with the same `id` become one scene; an id may not come back later in the list. Optional:
  `fit` (`cover`, `contain`, `blur` for a landscape clip in a vertical video), `focus` [x, y] from 0 to 1 for the
  crop, `zoom`, `video: false` (its sound only), or `{ "id", "duration" }` for silence.
- A proposal from the transcript (speech stays, pauses over 0.5 s go). `--split` gives each stretch its own scene,
  for graphics per stretch. For several clips, write the list yourself in the order of the story.
  ```
  node "<SKILL>/scripts/footage.mjs" edl "<project>" "<project>/work/norm/<name>.mp4" --split
  ```
- Approval 2: what stays, what goes, the seconds saved: `ככה חותכים?`. The numbers without writing anything:
  `node "<SKILL>/scripts/footage.mjs" cut "<project>" --dry-run`.

## 5. Cut

```
node "<SKILL>/scripts/footage.mjs" cut "<project>" --set-scenes
```
Writes `work/base/<id>.mp4` (exactly the planned frames, at the project size, starting on the exact source frame),
`work/voice-raw.wav` (mono, for the voice tools), `work/audio-raw.wav` (stereo, the original sound), `audio/words.json`
on the new timeline, and the scene list into `project.json`.

## 6. Captions

```
node "<SKILL>/scripts/footage.mjs" captions "<project>" s01 --position bottom
```
- Creates `scenes/s01` if it is missing (a transparent stage), and adds a caption block between
  `<!-- captions:start` and `<!-- captions:end -->` with `assets/words.js` (scene seconds) and `assets/captions.js`.
- `--position bottom|middle|top`. `--mode highlight` (the cue appears whole, the spoken word changes colour) or
  `reveal` (words appear as spoken). `--max-words 6`, `--max-chars` per line (18 on a reel), `--lines 2`.
- The look is CSS variables in the block: `--cap-y`, `--cap-size`, `--cap-weight`, `--cap-color`,
  `--cap-active-color`, `--cap-active-bg` (a box behind the spoken word), `--cap-bg` (behind each line),
  `--cap-stroke-width`, `--cap-shadow`, `--cap-font`. Edit them in place; `captions` again keeps the block unless
  `--rewire`. In a scene you write yourself: `FocusCaptions.add(window.__timelines["main"], words, options)`.
- Hebrew: each cue reads right to left, the helper chooses the lines and never breaks a word, and Latin words,
  numbers and punctuation keep their places.

## 7. Graphics over the footage: the overlay

```
node "<SKILL>/scripts/footage.mjs" overlay "<project>" s01
```
- `render.mjs` runs this for every footage scene with `"overlay": true`; by hand only for a single job. `--draft` for a
  quick look, `--workers 1` when memory is short (a stalled render is retried that way by itself).
- The scene renders alone as transparent frames, and ffmpeg lays them over `work/base/<id>.mp4`. The footage never
  enters the engine: that is why it is fast, and why its colours cannot change. Where the graphics are transparent
  the pixels are the clip's own (bit for bit with `--crf 0`; at the default CRF 16 only encode noise).
- The scene must be transparent (`background: transparent` on html, body and the root); an opaque one is refused.
- Measured at 1080x1920: 6 s of graphics took 25 to 38 s in the engine, plus 3 to 8 s to composite.

## 8. Footage inside a scene

- **Text behind a person**, on the same fast route: cut the person out of the base clip and add the cutout to the
  scene's entry in `project.json` as `"subject": "work/s01-subject.webm"`. The graphics go over the clip, and the
  person goes back on top of them. It runs on the processor with about 1.5 GB of memory: keep such shots short.
  ```
  node "<SKILL>/scripts/footage.mjs" matte "<project>/work/base/s01.mp4" -o "<project>/work/s01-subject.webm"
  ```
- **A clip inside a card, a phone or a frame**: a `<video>` element in the scene with `class="clip"`, `muted`,
  `playsinline`, `data-start`, `data-duration` and `data-media-start`, made from a normalized file. Each one slows
  the render: 2 to 3 s long, about 300 px wide, H.264, at most four in a scene.
- **Photos** go into scenes as images. A JPEG the engine loads, at a sensible size:
  `node "<SKILL>/scripts/footage.mjs" still "<photo>" --width 1080 -o "<project>/scenes/s01/assets/<name>.jpg"`
  (`--at <seconds>` takes one frame of a clip instead, in true colours even from an HDR file).

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
- Choose `--format` by the video's shape and keep its frame rate with `--fps`; for another shape, set `width` and
  `height` in `project.json` to its size before `cut`. The sound stays the original (lag 0 ms). 6 s took about 70 s.
- Subtitle files instead of, or with, burned-in captions:
  `node "<SKILL>/scripts/transcribe.mjs" export "<project>/audio/words.json" --srt "<project>/<slug>.srt"`.
  Hebrew lines that hold Latin words, digits or punctuation get invisible direction marks, because players built on
  libass (mpv, burned-in subtitles) show such lines left to right otherwise. `--marks never` writes plain text.

## When something is off

| What you see | Cause and fix |
|---|---|
| Burnt, reddish colours | An HDR clip was used directly. Normalize it and use `work/norm/` |
| Captions drift away from the words | The words came from the raw clip (variable frame rate). Transcribe the normalized file |
| `overlay` refuses the scene as opaque | Set `background: transparent` on html, body and the root |
