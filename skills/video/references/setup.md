# First-time setup

You install. The user only approves. `<SKILL>` is the folder that holds `SKILL.md`.

## When to run it

Run the doctor at the start of the first project on a machine, and again whenever a tool reports a missing
dependency (exit code 3):

```
node "<SKILL>/scripts/doctor.mjs"
```

It prints one JSON line. Each item is `ok` or missing, and each missing item comes with the exact command for this
operating system. If `~/.focus-motion/state.json` already says `setup_done` and the doctor finds nothing missing, skip
this file.

If `node` itself is not found, install it first:
- Windows: `winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements`
- macOS: `brew install node`

Then ask the user to close and reopen Claude Code once, so the new program is found.

## What gets installed, said honestly before starting

Tell the user in one short message. Use plain words: "הכלי שמחבר את הסרטון", not program names.

| What | Why | Where |
|---|---|---|
| Node.js, if missing | runs the tools | the computer |
| ffmpeg, if missing | joins frames and sound into a video | the computer |
| The video engine and its browser, about 200 MB | draws every frame | the engine's own cache folder |
| A settings folder | remembers the setup and the brand kit | `~/.focus-motion` |

Example opening:

```
לפני הסרטון הראשון צריך להתקין פעם אחת כמה כלים חינמיים. אני מתקין הכול, ואתם רק מאשרים.
זה לוקח כמה דקות. להתחיל?
```

Detect the operating system from the environment. Do not ask.

## The steps

Do one step at a time. For each: one sentence on what happens now, the command, then check that it worked.

1. **Install what the doctor listed,** with the commands it gave.
   - On Windows a newly installed program may not be found until Claude Code restarts. The tools also look in the
     usual install folders, so run the doctor again before asking for a restart.
2. **Run the doctor with the self-test:**
   ```
   node "<SKILL>/scripts/doctor.mjs" --selftest --write
   ```
   It renders a four second test video and checks it. On success it saves the state file and returns the path of the
   video.
3. **Show the proof.** Open the test video (`node "<SKILL>/scripts/open.mjs" "<path>"`) and say:
   ```
   הכול מותקן ועובד. מתחילים.
   ```
   Then continue straight to the user's request.

## Transcription, only when a project needs it

The `voice` and `footage` tracks, and the transcript and captions jobs, need speech recognition. It is a larger
install, so do it the first time it is needed and not before.

```
node "<SKILL>/scripts/doctor.mjs" --with-transcribe
```

Tell the user first:

```
כדי לתמלל צריך להתקין פעם אחת כלי זיהוי דיבור. הוא רץ על המחשב שלכם, בלי לשלוח את ההקלטה לשום מקום.
ההורדה היא בערך גיגה וחצי, ולוקחת כמה דקות. להתקין?
```

Then run the commands the doctor gives: Python if missing, a private environment in `~/.focus-motion/venv`, and the
speech library. The speech model downloads the first time a transcript is made.

If the user declines, offer the alternatives: they can paste the text themselves, or the video is made without
word-level sync.

## Removing everything

If asked, delete `~/.focus-motion`. That holds the settings, the speech model and the private Python environment.

The engine sits in npm's cache, and its browser in `~/.cache/puppeteer`. Other programs may share both folders, so
leave them unless the user asks, and then name the folders before deleting them. Node, ffmpeg and Python stay,
because other programs may use them.

## When setup fails

Read the error. Fix what is yours to fix, and try once more. Then see `references/troubleshooting.md`. Give the user
one instruction at a time, and only when the step really needs them. Examples are approving a system dialog or
restarting Claude Code.
