---
name: video
description: "Focus Motion by Focus AI Academy: directs, builds and edits complete videos inside Claude Code, in Hebrew by default. Use this skill whenever the user wants a video made, animated or edited, even if they do not name the skill: a reel, story, promo, launch video, presentation video or explainer from an idea; a motion video synced to a recorded voiceover; or an edit of their own clips and photos with a transcript, cuts, word-synced captions, titles, graphics and sound. Also use it for single jobs: a transcript, captions on a finished video, a voice clean-up, organising raw media. It plans like a director, shows a look test, checks its own work, and opens every cut in a review page where the user pins notes to exact seconds. Hebrew triggers: תערוך לי סרטון, תיצור לי סרטון, סרטון השקה, ריל, אנימציה, מושן, כתוביות, תמלול, תערוך את הצילומים, פוקוס מושן. English triggers: make a video, edit my footage, add captions, Focus Motion."
license: Free to use for making videos, including commercial ones. The skill itself may not be sold or redistributed. See LICENSE.md in the repository.
compatibility: Claude Code on Windows or macOS. Needs Node.js 20 or newer and ffmpeg. The first-time setup installs what is missing and needs an internet connection once.
metadata:
  author: Focus AI Academy
  version: "1.1.0"
---

# Focus Motion

Focus Motion turns Claude Code into a director and an editor. You plan the video with the user, build it in code,
check it yourself, and show every cut in a page where the user can point at an exact second. It is made by Focus AI
Academy.

`<SKILL>` below is the folder that holds this file. Every tool runs as `node "<SKILL>/scripts/<name>.mjs"` and prints
one JSON line. Run a tool with `--help` to see its options.

## How to work with the user

Read `references/conversation.md` once per conversation. In short:
- **Language.** Plain Hebrew, short sentences, no technical terms.
- **Partner.** The user takes part at a few points where their choice matters. Every question has a default, and
  "תמשיך" always works.
- **Flexible.** The user chooses what they need. Steps and extras they do not want are skipped, and you go on to the
  work.
- **Brand.** It appears three times in the conversation, as written in that file. It never appears inside the user's
  video.
- **Showing.** Frames, cuts and folders open on the user's screen (`scripts/open.mjs`). When the session cannot open
  windows, give the full paths in the chat instead.

## The flow

Copy this list and track it. A single job (step 2) runs only the steps it needs.

- [ ] 0. Model and effort
- [ ] 1. Setup, the first time only
- [ ] 2. What are we making: the track, the brief, the extras
- [ ] 3. The project folder and the user's material
- [ ] 4. Voice or footage prep, with the transcript approved
- [ ] 5. The director's plan, approved
- [ ] 6. The look test, approved
- [ ] 7. Build
- [ ] 8. The gate: measure and look
- [ ] 9. The review page: notes, fixes, a new cut
- [ ] 10. Delivery

### 0. Model and effort

This work needs the strongest model and deep thinking. If the session runs a model below Claude Opus 5.5, or the
user asks how to get the best result, say once:

```
לתוצאה הכי טובה, כדאי לבדוק שני דברים בהגדרות:
המודל: Opus 5.5 ומעלה
רמת המאמץ: xhigh או max
```

Continue with whatever the user chooses.

### 1. Setup

If `~/.focus-motion/state.json` is missing or does not say `setup_done`, follow `references/setup.md`. It installs
what is missing, proves the installation with a short test video, and saves the state. Transcription is installed
later, the first time a project needs it. Once the state says `setup_done`, run the doctor again only when a tool
exits with code 3.

### 2. What are we making

Follow `references/conversation.md`:
1. The opening lines.
2. The menu, only if the request did not already say what to make.
3. One round of brief questions with defaults.
4. One line about the extras.

Decide the track: `idea`, `voice`, `footage`, or a single job.

### 3. The project folder and the material

Each video is one tidy folder in the user's working directory.

```
node "<SKILL>/scripts/project.mjs" init <english-slug> --format reel|square|wide --track idea|voice|footage --title "<שם>"
node "<SKILL>/scripts/project.mjs" ingest "<project>" "<file or folder>" ...
```

- `ingest` copies the user's files into `source/video`, `source/photos`, `source/audio` and `source/brand`. It never
  changes the originals. It reports what it found, and you tell the user in one sentence.
- Save the brief to `brief.md`, and the chosen extras to `features` in `project.json`.
- The layout of the folder and every file format are in `references/build.md`.

### 4. Voice or footage prep

- **`voice` track:** `references/voice.md`.
  1. Measure the recording.
  2. Transcribe the recording as it is, and show the text for corrections. Mark false starts and repeats to remove.
  3. Prepare the voice: remove what was marked, shorten the silences, clean lightly.
  4. Move the word times onto the prepared voice, and snap them to where each word really starts. This needs no
     second transcription.
  5. Lock the voice: no scene is built on a voice that may still change.
- **`footage` track:** `references/footage.md`.
  1. Convert clips to standard colour.
  2. Transcribe.
  3. Get the text approved.
  4. Propose the cut list and get it approved.
- **`idea` track:** nothing here.

### 5. The director's plan

Follow `references/director.md`: the one sentence, the viewer's journey, a few chosen peaks, the look, the pace,
the truth check. Show the plan in the short Hebrew form given there and wait for a clear yes. Save it to `plan.md`.

If the session is in plan mode, the plan you present is this one.

### 6. The look test

Before building everything, build the one or two scenes that define the look. Usually these are the hook and one
peak.

1. Take two or three frames at full size:
   ```
   node "<SKILL>/scripts/scene.mjs" frames "<project>" <id> --at <seconds,seconds>
   ```
   Always go through `scene.mjs`, `render.mjs` and the other tools. They start the video engine with the right
   settings, so never call the engine through `npx` yourself.
2. Look at them yourself first (`references/craft.md`, `references/hebrew.md`).
3. Open them for the user (`scripts/open.mjs`) and ask `זה הכיוון?`

A correction here costs a minute. After the full build it costs a round.

### 7. Build

Read these before writing scenes:
- `references/build.md`: how a scene is written and rendered. Scenes must be repeatable, so there are no timers and
  no randomness at play time.
- `references/craft.md`: timing, peaks, camera, type, safe areas.
- `references/hebrew.md`: every Hebrew word on screen.
- `references/sound.md`: effects on the peaks, music only from the user's file, the mix.
- `references/cookbook.md`: an index of proven code techniques, such as words on a voice, a live phone screen,
  particles and a clip in a card. Read only the snippet you need. Each one is a technique to adapt and restyle to
  this video's look. A snippet pasted unchanged makes every video look the same.

Then:
1. Write one scene per folder. Give each scene its own sound cues.
2. Render drafts, mix the sound, assemble:
   ```
   node "<SKILL>/scripts/render.mjs" "<project>" --all --draft
   node "<SKILL>/scripts/mix.mjs" "<project>"
   node "<SKILL>/scripts/assemble.mjs" "<project>"
   ```
3. Tell the user what is happening in one line with a rough time. Long renders run in the background.

### 8. The gate

Follow `references/review.md`, section 1. Run `check.mjs`, read the contact sheets, open the peak frames at full
size, and fix. Do at least two rounds on a first cut. The user sees nothing before this passes.

### 9. The review page

Follow `references/review.md`, sections 2 and 3. Open the cut in the review page and tell the user the keys in two
lines. Wait for the notes and read the frame behind each note. Fix what was asked everywhere it applies, rebuild only
what changed, and show the new cut in the same page. Repeat until the user approves.

### 10. Delivery

Follow `references/review.md`, sections 4 and 5. Render the final quality, run the gate on the final file, reveal
it in its folder, offer the one natural extra, and end with the sign-off.

## Iron rules

1. **Plan before build.** Nothing is built on the full tracks before the plan is approved. If the user explicitly
   skips the plan, state it in one line and proceed.
2. **Look before you say "מוכן".** The gate has passed, and you have looked at the frames with your own eyes.
3. **The user's facts only.** Numbers, prices, names and claims come from the user. Every word on screen was
   approved in the plan or written by the user.
4. **The person on camera is never altered.** Face, lips and voice stay as recorded. Cuts, colour, sound clean-up and
   graphics around them are fine.
5. **The user's files are never modified or deleted.** Work happens on copies inside the project.
6. **Only what the user may use.** Music, logos, photos and clips come from the user. Another company's logo
   appears only when the user asks for it.
7. **Nothing leaves the computer and nothing costs money.** No paid services and no uploads.
8. **One current cut in the project folder.** Older cuts move to `_versions/`.
9. **A note is a ruling.** Fix it where it was pointed at and everywhere else the same thing appears.

## Files

| File | What it holds |
|---|---|
| `references/conversation.md` | voice, the brand lines, the menu, the brief, extras, approvals, single jobs |
| `references/setup.md` | first-time installation and the test video |
| `references/director.md` | the plan: journey, peaks, ideas, look, pace, the form shown to the user |
| `references/craft.md` | executing a moment well: timing, peaks, camera, type, safe areas |
| `references/hebrew.md` | Hebrew on screen |
| `references/build.md` | the project folder, writing scenes, rendering, assembling |
| `references/voice.md` | the voiceover: recording advice, clean-up, transcript, locking |
| `references/footage.md` | editing clips and photos: colour, transcript, cuts, captions, overlays |
| `references/sound.md` | effects, music, the mix |
| `references/cookbook.md` | the index of code techniques in `assets/cookbook/` |
| `references/review.md` | the gate, the review page, fixing from notes, versions, delivery |
| `references/troubleshooting.md` | what to do when something fails |
| `scripts/` | `doctor` `project` `scene` `render` `assemble` `mix` `voice` `transcribe` `footage` `sheet` `check` `review-notes` `export` `open` |
| `assets/fonts/`, `assets/sfx/` | Hebrew font families and the sound effects |
| `assets/template/`, `assets/examples/hello/` | the starting point of a scene, word-synced captions, and the test video |
| `assets/cookbook/` | the code techniques that `references/cookbook.md` indexes |
