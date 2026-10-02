# The gate and the review loop

Two things protect the result: a check you run before the user sees anything, and a page where the user points at
exact moments. `<SKILL>` is the folder that holds `SKILL.md`. `<project>` is the project folder.

## 1. The gate: before the user sees a cut

Run it after every assembly. Nothing is shown before it passes and before you have looked at the frames yourself.

1. **Measure.**
   ```
   node "<SKILL>/scripts/check.mjs" "<project>"
   ```
   It takes a few seconds and prints one JSON line. `ok` is true when there is no `FAIL`. Fix every `FAIL`. Read
   every `WARN` and fix it, or know why it is acceptable. The tool checks:
   - black frames, stretches where nothing changes, and flashing;
   - size, frame rate, length and colour format;
   - loudness (-14 LUFS), true peak, and that sound and picture have the same length;
   - long silences in the voice;
   - the scene sources: a hyphen between Hebrew words, files loaded from the internet, CSS animation, text in a
     font with no `@font-face`, a video without `muted`, anything random or endless.

   Each finding carries a time and a scene, or a file and a line. Exit codes: 0 passed, 1 at least one `FAIL`, 2 a
   wrong call or no cut yet, 3 ffmpeg is missing.

   Two shorter forms:
   - Before rendering, check only the scene sources. This is fast and needs no video:
     ```
     node "<SKILL>/scripts/check.mjs" "<project>" --only scenes
     ```
   - After rendering one scene, check that render alone. The tool knows the scene from the file name:
     ```
     node "<SKILL>/scripts/check.mjs" "<project>" --video "<project>/renders/s03.mp4"
     ```

   **A stretch where nothing happens.**
   - Make a sheet of that stretch and look at it before deciding:
     ```
     node "<SKILL>/scripts/sheet.mjs" "<video>" --every 0.25 --range <t-0.5>-<t_end+0.5>
     ```
   - A `WARN` on a pause the plan asks for, such as a breath after a peak, may stay.
   - A `FAIL` (1.8 seconds or more) is always fixed.
   - "Frozen" means nothing moves at all. Usually a scene's render is shorter than its slot, or its timeline ends
     early.
2. **Look at the flow.**
   ```
   node "<SKILL>/scripts/sheet.mjs" "<video>" --every 0.5
   ```
   Every page holds at most 60 frames, so a long video gives several pages. Read every path listed in `sheets` with
   the Read tool. The number under each frame is its time in the video. Check that:
   - something changes between neighbouring tiles;
   - the order of events matches the plan;
   - nothing is left over from a previous moment.
3. **Look at the hits.** Take frames on the word starts, or at the times of the planned hits:
   ```
   node "<SKILL>/scripts/sheet.mjs" "<video>" --words "<project>/audio/words.json"
   node "<SKILL>/scripts/sheet.mjs" "<video>" --at 1.2,3.4,7.9 --frames "<project>/work/frames"
   ```
   With `--words`, each frame is taken a tenth of a second after a word starts, and the JSON names the word.
   `--frames` also saves every frame at full size. Open the full-size frames of the peaks. For each one, check:
   - every word is readable on a phone, spelled exactly, in the correct direction;
   - nothing is cut, overlapping or touching, and everything important is inside the safe area;
   - the colours are the approved ones;
   - the frame matches what the plan promised for that moment;
   - a peak looks like a peak (`references/craft.md`, section 5).
4. **Fix and run again.** Do at least two full rounds on a first cut.
   - A problem in the plan itself gets the smallest fix that works. Tell the user in one line when you show the cut.

## 2. The review page

Every cut is shown in the review page. The user watches, pins notes to exact seconds and marks stretches.

1. **Open it.**
   ```
   node "<SKILL>/scripts/review-notes.mjs" serve "<video>" --open
   ```
   - The page runs as its own small server on this computer, so the command returns at once.
   - It prints one JSON line with `url`, `port`, `notes` and `pid`. If the port is taken, the next free one is used;
     use the printed address.
   - If a page is already open, the same command switches it to the new cut and the open tab reloads by itself.
     Never open a second tab.
2. **Tell the user how it works,** once per project:
   ```
   הגרסה פתוחה בדף ההערות. מקש N עוצר ופותח הערה על הרגע הזה. המקשים I ואחריו O מסמנים קטע שלם.
   כשתסיימו, לחצו בדף על "סיימתי, אפשר לתקן", או כתבו לי כאן.
   ```
3. **Wait for the notes.** Run this in the background. It ends when the user presses the button or the D key:
   ```
   node "<SKILL>/scripts/review-notes.mjs" wait --port <port> --timeout 1500
   ```
   - It prints the notes, each with `t`, an optional `t_end` for a stretch, and `text`.
   - If it times out (exit code 2), or the user writes in the chat instead, read `<video>.notes.json` directly.
   - With no notes and a clear "מאשר", go to delivery.
4. **See what they saw.**
   ```
   node "<SKILL>/scripts/review-notes.mjs" frames "<video>"
   ```
   It writes one frame per note, and two for a stretch: its start and its end. Read each frame next to its note
   before changing anything.

## 3. Fixing from notes

- **A note is a ruling.** Fix the moment it points at. Then fix every other place in the video with the same
  problem. If a title is "too small" in one scene, it is too small in all of them.
- **Find the scene.** The note's time falls inside one scene of `project.json`. Subtract the scene's `start` to get
  the time inside the scene.
- **Change only what the notes ask.** A note that says to remove something removes it. It is not an invitation to
  redesign the scene.
- **An unclear note** gets one short question. A clear one gets fixed without discussion.
- **Words and facts.** New text on screen comes from the user's note or from words they already approved.

Then rebuild only what changed:

```
node "<SKILL>/scripts/render.mjs" "<project>" --changed --draft
node "<SKILL>/scripts/mix.mjs" "<project>"          (only if the sound or the timing changed)
node "<SKILL>/scripts/assemble.mjs" "<project>" --bump
node "<SKILL>/scripts/check.mjs" "<project>"
node "<SKILL>/scripts/review-notes.mjs" serve "<new video>"
```

Tell the user in two or three lines what changed, note by note. Then wait again.

## 4. Versions

- The project root holds exactly one cut, the current one, with its notes file. `--bump` moves the older cut to
  `_versions/`.
- Iterations render as drafts, which are fast.
- When the user approves, render everything once at full quality, assemble, run the gate, and deliver that file:
  ```
  node "<SKILL>/scripts/render.mjs" "<project>" --all --final
  node "<SKILL>/scripts/assemble.mjs" "<project>" --bump
  node "<SKILL>/scripts/check.mjs" "<project>"
  ```

## 5. Delivery

1. Check that the file exists and plays from start to end: the gate passed on the final file.
2. Give the full path. Open the folder with the file selected:
   ```
   node "<SKILL>/scripts/open.mjs" "<video>" --reveal
   ```
3. Offer the natural extra once: a cover image, a smaller copy for messaging apps, or a subtitles file
   (`scripts/export.mjs`).
4. Stop the review page's server, once the user has no more notes:
   ```
   node "<SKILL>/scripts/review-notes.mjs" stop --port <port>
   ```
5. End with the sign-off line from `references/conversation.md`.
