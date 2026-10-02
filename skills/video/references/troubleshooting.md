# When something fails

Read the tool's error line first. Most failures name their own fix. Fix what you can without the user. Involve the
user only for a step that really needs them, and give one instruction at a time.

## Installation

| What you see | Cause and fix |
|---|---|
| A tool exits with code 3 | A program is missing. Run `node "<SKILL>/scripts/doctor.mjs"` and use the command it gives |
| `node` or `ffmpeg` not found right after installing | The session started before the install. The tools also search the usual install folders, so run the doctor again. If it still fails, ask the user to restart Claude Code |
| A download fails with a certificate or TLS error | A security program inspects the connection. Run the command again with the environment variable `NODE_OPTIONS=--use-system-ca` |
| The engine's browser download stalls | Run `node "<SKILL>/scripts/doctor.mjs"` again; it starts the download again. On a company network, ask the user whether a proxy is needed |
| macOS opens a dialog about developer tools | Tell the user to press Install and wait until it finishes, then continue |
| `pip` reports an externally managed environment | Install only inside the private environment, with `~/.focus-motion/venv`'s own Python |

## Rendering

| What you see | Cause and fix |
|---|---|
| A render sits at zero frames for minutes | The machine is short on memory. Stop that render only, and run the scene again with `--workers 1`. Ask the user to close heavy apps if it repeats |
| A frame is blank or the scene is missing | A script error in the scene. Run `scene.mjs check <project> <id>` and read the first error |
| Text shows in the wrong font, or as boxes | The family has no `@font-face` in this scene, or the font has no Hebrew. See `references/hebrew.md` |
| A scene's colours look burnt, red or washed out | A phone clip in HDR was used directly. Convert it first (`references/footage.md`) and render the scene again |
| Two renders of the same scene differ | Something in the scene depends on real time or on randomness. See the repeatability rules in `references/build.md` |
| The first frame of a scene is empty | Elements start invisible and enter later. Set a complete starting state, so that frame 0 already shows the scene |
| A very fast move shows several ghost copies | Render that scene with motion blur: `render.mjs <project> <id> --mblur <id>` |

## Sound and sync

| What you see | Cause and fix |
|---|---|
| Events drift away from the words over time | The clip has a variable frame rate. Normalize it, transcribe the normalized file, and use those times |
| The transcript skipped a sentence | Speech recognition can drop a repeated or quiet sentence. Compare with the recording's length, and transcribe the missing stretch on its own |
| The voice sounds echoing or harsh after clean-up | The clean-up was too strong for this recording. Use the untouched recording with loudness only (`voice.mjs prep --no-polish`) |
| The video is much louder or quieter than others | The gate's loudness check failed. Run the mix again; it masters to the level social platforms expect |

## The review page

| What you see | Cause and fix |
|---|---|
| The page does not load | The server stopped. Run `review-notes.mjs serve "<video>"` again; the open tab reconnects. The server's log is `review-notes-<port>.log` in the system's temp folder |
| The page shows an old cut | Run `serve` with the new file. It switches the open page |
| The port is taken by another program | `serve` moves to the next free port and prints it. Use the printed address |
| The user's notes are missing | Read `<video>.notes.json` next to the video. Notes are saved on every change |

## Files and folders

| What you see | Cause and fix |
|---|---|
| A file cannot be replaced | A player still has it open. Write the new cut under the next version number instead of overwriting |
| Tools fail inside a cloud-synced folder | The sync program locks files while it uploads. Create the project in a plain local folder |
| A path with spaces or Hebrew breaks a command | Put the path in double quotes. The tools themselves handle such paths |

## If nothing here fits

Say plainly what failed and what you tried. Offer the smallest way forward: skip the optional step, lower the
quality for this round, or continue without the extra. Never tell the user it worked when it did not.
