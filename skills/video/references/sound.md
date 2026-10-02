# Sound: effects, music, the mix

Read this before you place sound in the scenes and before the first mix. `<SKILL>` is the folder that holds
`SKILL.md`, `<project>` is the project folder. Every tool prints one JSON line.

## What is optional, and what to ask

| Part | Default | Before you use it |
|---|---|---|
| Sound effects | on | Nothing to ask. Name the big ones in the plan. If the user turns them off, set `"sfx": false` |
| Music | off | Only a file the user brings and is allowed to use (their own, bought, or licensed for this use). Ask once, in your own words, for example `יש לכם מוזיקה שמותר לכם להשתמש בה בסרטון?` Never find, download or generate music |
| Voice | the recording, lightly cleaned | See `references/voice.md` |

The choices live in `project.json` under `features`, for example `{ "sfx": true, "music": false }`. A missing key, or
no `features` at all, means the default. A flag on the command line always wins over `features`.

## The effects

Thirteen sounds, synthesized in code by Focus AI Academy, in `assets/sfx/` (48 kHz, described in `sfx.json`).

| Kind | What it is | Use it for |
|---|---|---|
| `hit` | a short punch: a crack over a low thump | a word or a number that slams in, a hard cut |
| `impact` | a big deep boom with a long tail | the one or two biggest moments of the video |
| `sub` | a low drop, felt more than heard | under a `hit` or an `impact` at the same time, for weight |
| `whoosh` | a rush of air that peaks on the cue | a fast move, a whip, a slide in, a change of scene |
| `rise` | a riser that climbs into the cue and stops on it | the build into a reveal; the cue is the reveal |
| `pop` | a small round blip | an icon, a bubble, a card or a word that appears |
| `tick` | a tiny high tick | a counter step, a check mark, a small step in an interface |
| `click` | a double click | a button or a cursor press |
| `key` | one keyboard key | typing: one cue per burst of letters, 0.15 to 0.25 s apart |
| `glitch` | a digital stutter | a glitch transition, an error, something that breaks on screen |
| `shatter` | glass breaking | the old way smashed; once in a video at most |
| `ding` | a bright bell | a success, a notification, a right answer |
| `sparkle` | a glitter of small chimes | the reveal of something precious, a shine on a logo |

How to place them:
- **Two to six per scene.** Sound marks the moments that matter. A cue on every element is noise.
- **The time of a cue is the moment of the event:** the frame where the thing lands. On the `voice` and `footage`
  tracks that is the start of the spoken word in `audio/words.json`. A `whoosh` and a `rise` are built to arrive at
  that time; they start before it by themselves.
- **Gain** from 0.3 to 1: small sounds 0.3 to 0.5, accents 0.5 to 0.7, peaks 0.8 to 1.
- **A peak** stacks two or three sounds at one time: `impact` + `sub`, or `hit` + `sub`, with `shatter` for a break.
  Keep `impact`, `sub` and `shatter` for the two or three peaks of the plan.
- **At most one `whoosh` per scene.** The cuts between scenes get theirs from `--seams`.
- **Leave air before the biggest peak.** A second with no effects makes it land harder.
- **Stereo is automatic.** Sweeps cross the field and alternate direction, small sounds alternate right and left, the
  big hits stay in the centre. A `"pan"` from -1 (left) to 1 (right) on a cue fixes its side, or a sweep's direction.

## Cue files

- `scenes/<id>/cues.json`, in seconds of the scene. Write them while you build the scene; they move with the scene
  when the scene list changes.
- `audio/cues.json`, in seconds of the video, for the few cues that belong to no scene.

```json
[{ "t": 1.25, "kind": "hit", "gain": 0.8 }, { "t": 2.1, "kind": "whoosh", "gain": 0.5, "pan": -1 }]
```

A cue with an unknown kind, no time, or a time outside its scene is left out and listed in `sfx.skipped` in the
result. Fix it and mix again.

## Music

- Only the user's file, from `source/audio/` (`project.mjs ingest` puts it there). Any common audio format works.
- `--music-start <seconds>`: where in the track to start, to skip an intro or to begin on the strong part.
- `--hit <seconds>`: the second of the video where a strong beat should land, usually the biggest peak. The start
  moves by at most two beats, so that a real beat sits exactly there. The beats come from the engine, checked against
  the real bass hits; without the engine a built-in detector finds them. `music.hit` in the result names the beat.
- `--music-lufs -24` (the default): the level of the music before it goes under the voice. With no voice the music
  carries the video: it is not ducked, and the master raises the whole mix to the target anyway.
- `--duck 0.7` (the default): how far the music drops while the voice speaks, from 0 to 1. Use 0.5 for a video led
  by the music, 0.85 when every word must be clear.
- The music fades in over 0.4 s and out over the last 1.5 s. A track shorter than the video starts again from its
  top (`music.loops` says where); a track that runs out within the last 1.5 s simply ends.
- The options are saved in `audio/mix.json`, so a plain `mix.mjs "<project>"` repeats them. `--no-music` takes the
  music out and forgets it.

## The mix

```
node "<SKILL>/scripts/mix.mjs" "<project>"
node "<SKILL>/scripts/mix.mjs" "<project>" --music "source/audio/<track file>" --hit 12.4 --seams
node "<SKILL>/scripts/mix.mjs" "<project>" --no-music --no-seams
node "<SKILL>/scripts/mix.mjs" "<project>" --no-voice
```

- It finds the parts by itself: the cues from the cue files, the voice in `audio/voice.wav`, the music of the last
  run. Any subset works: effects only, voice only, voice and music, all three.
- The effects are summed on their cues. The voice goes in the centre as it is, and the effects dip a little under
  it. The music sits under the voice.
- The master is -14 LUFS with true peaks at most -1 dBTP. A test copy is encoded to AAC the way the cut is, and the
  limit comes down until that copy reads -0.7 dBTP or lower, so the cut passes the gate.
- `--seams` adds a soft whoosh on every cut between scenes that has no whoosh within 0.3 s. Use it for hard cuts in a
  fast video, leave it out of a calm one. It is remembered like the music; `--no-seams` turns it off.
- `--sfx-gain` sets the overall level of the effects: 1.25 by default, 1 is calmer, 1.5 is hotter.
- `--no-voice` mixes without the voice, for example to hear the effects before the voice exists. `--no-sfx` mixes
  without the effects.
- `-o <file>` writes somewhere other than `audio/mix.wav`.
- The output is `audio/mix.wav`: 48 kHz, 24-bit stereo, exactly as long as the video (the end of the last scene).
  Then run `assemble.mjs`.

Read the result: `ok`, `loudness` (`lufs`, `truePeak`, `truePeakAac`), `sfx.skipped`, `music.hit` and `notes`. A note
tells you when the voice is longer than the video (make the last scene longer), when the music loops, or when the
voice was not prepared with `voice.mjs` (it gets a plain gain to -16 LUFS in the mix).

Mix again whenever the cues, the scene timing, the voice or the music change. The gate (`check.mjs`, see
`references/review.md`) then measures the finished cut: loudness, true peak, audio length, and long pauses in the voice.
