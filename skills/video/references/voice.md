# The voice: recording, preparing, locking

For the `voice` track, and for a voice clean-up as a single job. The voice is prepared and locked before any scene is
built, because every scene is timed to its words. `<SKILL>` is the folder that holds `SKILL.md`, `<project>` is the
project folder. Every tool prints one JSON line.

## What is optional

| Step | Default | How to change it |
|---|---|---|
| Removing a false start or a repeated line | only what the user approved | `--cut` |
| Shortening the silences | on in a `voice` project, off in a `footage` project (sound and picture stay in sync) | `--no-tighten` or `--tighten`, or `"voiceTighten": false` in `features` |
| The light clean-up | on | The user may ask for the recording as it is: `--no-polish`, or `"voicePolish": false` in `features` |
| Loudness -16 LUFS | always | The mix expects it |

A flag on the command line wins over `features`. A missing key means the default.

## 1. Ask for the recording

If there is no recording yet, ask for one in plain Hebrew, in your own words, with the two or three tips that matter
for this user. For example:

> עכשיו צריך את הקול שלכם. הקליטו את הטקסט בטלפון, בחדר שקט, עם הטלפון קרוב לפה. אפשר להקליט כל פסקה בנפרד,
> ואם טעיתם פשוט תתחילו את המשפט מההתחלה. את השקטים ואת החזרות אני מוריד.

Tips to choose from:
- A quiet room with the door and the windows closed, no fan or air conditioner. A room with a sofa, curtains or a
  carpet sounds better than an empty one.
- The phone about a hand's width from the mouth, a little to the side, so "פ" and "ב" do not blow into it.
- One take per paragraph is fine. After a mistake, pause and say the sentence again from its start.
- A little slower and livelier than in a conversation.
- Give the original file from the recorder app. A voice note sent through a messaging app is compressed.

Any audio or video file works. `project.mjs ingest` copies it into `source/audio/`.

## 2. Measure

```
node "<SKILL>/scripts/voice.mjs" measure "<file>"
```

`verdict` is `good`, `usable` or `poor`, and `problems` says why, in English, for you. Tell the user in one sentence.
- `good`: go on.
- `usable`: go on, and say once what would make the next recording better.
- `poor` (a loud background, distortion, almost no voice): ask for a new recording with the one tip that fixes it.
  If the user prefers to go on, go on.

The other fields: `loudness` (LUFS), `truePeak`, `snr` (the voice above the background, in dB), `clipped`, and
`silences` longer than 0.45 s.

## 3. The transcript of the recording

Transcribe the recording itself, before it is prepared, with `scripts/transcribe.mjs` (its `--help` has the usage),
into `<project>/work/words-raw.json`. With several recordings, transcribe each one into its own words file. The user
then approves the text once, and false starts and repeated lines show up in it.

Show the text. Mark what you propose to take out (a false start, the first reading of a line said twice), and ask
`התמלול נכון? תקנו שמות ומילים אם צריך.` Apply the corrections with the transcribe tool's `fix`.

## 4. Prepare

```
node "<SKILL>/scripts/voice.mjs" prep "<project>/source/audio/<file>" -o "<project>/audio/voice.wav"
node "<SKILL>/scripts/voice.mjs" prep "<project>/source/audio/<file>" -o "<project>/audio/voice.wav" --cut 0-2.3,41.2-44
node "<SKILL>/scripts/voice.mjs" prep "<project>/source/audio/<part 1>" "<project>/source/audio/<part 2>" -o "<project>/audio/voice.wav" --cut 2:0-1.4
```

- In order: the approved cuts; every silence shortened (breaks between sentences to 0.22 s, short pauses to about
  0.13 s, with 10 ms fades); the light clean-up; loudness -16 LUFS. It writes `audio/voice.wav` (48 kHz, mono) and
  the exact cut map `audio/voice.cuts.json`. An older `voice.wav` and its map move to `_versions/`.
- Several recordings join in the order given. In `--cut`, `2:0-1.4` means seconds 0 to 1.4 of the second recording;
  a range with no number is in the first one.
- `--cut` ranges are seconds of the recording, read from the raw transcript: from the start of the first word to take
  out to the start of the first word to keep. Each edge moves to the quietest moment within 0.15 s.
- The light clean-up is a ruling from production: pops on "פ" and "ב" pulled down, rumble out, a touch of warmth, a
  small cut in the muddy lows, a soft de-esser, gentle 2:1 compression. Never add noise reduction, a gate, brightness
  or reverb: on a real voice they sound like echo or harshness.
- `--no-polish` keeps the recorded sound: no EQ, no compression, no de-esser. The loudest peaks are still held by a
  fast limiter to reach the loudness. On a very peaky recording that limiter works hard, and the light clean-up
  usually sounds better.
- `--max-gap 0.3` leaves longer breaks for a calm video. The default, 0.22, suits a fast reel.
- With a loud background the silences stay as they are, and a note says so: pauses cannot be told from soft words.
- Read the result: `seconds`, `removedSeconds`, `silencesShortened`, `popsTamed`, `loudness`, `pausesLeft` (the
  pauses the gate would still report) and `notes`.

On the `footage` track the voice comes from the clips (`work/voice-raw.wav`, see `references/footage.md`). Prepare it
the same way: the silences stay, and the clean-up and the loudness apply.

For a voice clean-up as a single job: prepare the file, then give the user both the original and the prepared file
to compare.

## 5. Move the words onto the prepared voice

```
node "<SKILL>/scripts/voice.mjs" words "<project>/work/words-raw.json" --map "<project>/audio/voice.cuts.json" -o "<project>/audio/words.json"
```

The approved words, with the user's corrections, move onto the prepared voice; nothing is transcribed again. Words
inside a cut are dropped and listed in `dropped`: check that they are exactly the ones you meant to take out. With
several recordings, give one words file per recording, in the same order as in `prep`.

## 6. Lock the voice

Once `audio/voice.wav` and `audio/words.json` exist and the user approved the text, the voice is locked. Build the
scenes on `audio/words.json`.

After that, do not prepare the voice again: every scene, cue and caption is timed to it. If the user later wants a
change in the voice (a new take, a line out), say in one line that the scenes after that point will be re-timed. Then
prepare again, move the words again, and re-time what comes after the change.
