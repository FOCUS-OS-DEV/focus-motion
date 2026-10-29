# Sound: music, effects, the mix

Read this before you place sound in the scenes and before the first mix. `<SKILL>` is the folder that holds
`SKILL.md`, `<project>` is the project folder. Every tool prints one JSON line.

The rule of this file: **music carries the feeling, effects only point at moments.** A soundtrack made of effects,
with a boom on every cut, is the most common complaint about generated videos. Few, small and quiet effects under a
pleasant track sound professional.

## What is optional, and what to ask

| Part | Default | Before you use it |
|---|---|---|
| Music | off until the user brings a track | Recommend it at the brief (question 6 in `references/conversation.md`). A file the user may use: their own, bought, licensed, or downloaded by the user from a free library under a clear licence. For a reel, music can also be added in the app at upload. Never generate music, and never download a track yourself without the user's pick |
| Sound effects | on, soft | Nothing to ask. Name the few you use in the plan. If the user turns them off, set `"sfx": false` |
| Sound style | `soft` | `punchy` (booms, crashes, glitches at full strength) only when the user asked for a video that hits hard: set `"sound": "punchy"` |
| Voice | the recording, lightly cleaned | See `references/voice.md` |

`mix.mjs` reads three keys of `features` in `project.json`: `sfx`, `music` and `sound`, for example
`{ "sfx": true, "music": true, "sound": "soft" }`. A missing key, or no `features` at all, means the default. A flag on
the command line always wins over `features`.

## Where music comes from

Offer these, in this order, once at the brief:
1. **The user's own file**, or a track they bought or licensed.
2. **A free library with a clear licence,** downloaded by the user, who checks its licence page: for example the
   YouTube Audio Library, Pixabay Music or Mixkit. Ask for a calm track without a vocal for a video with a voice.
3. **Music added on the platform at upload.** Instagram and TikTok have their own licensed libraries, and a reel with
   a track from them is fine to publish. Then deliver the cut with the voice and a few soft effects and no music, say
   so in one line, and remind the user to add the track in the app.

Put the file in `source/audio/` (`project.mjs ingest` does it) and mix with `--music`.

## The effects

Thirteen sounds, synthesized in code by Focus AI Academy, in `assets/sfx/` (48 kHz, described in `sfx.json`). The soft
sound plays a softer copy of each light effect (rounder highs, shorter tails) and leaves the heavy ones out.

| Kind | What it is | Use it for | Sound |
|---|---|---|---|
| `pop` | a small round blip | an icon, a bubble, a card or a word that appears | soft and punchy |
| `tick` | a tiny tick | a counter step, a check mark, a small step in an interface | soft and punchy |
| `click` | a double click | a button or a cursor press | soft and punchy |
| `key` | one keyboard key | typing: one cue per burst of letters, 0.15 to 0.25 s apart | soft and punchy |
| `ding` | a bell | a success, a notification, a right answer | soft and punchy |
| `sparkle` | a glitter of small chimes | the reveal of something precious, a shine on a logo | soft and punchy |
| `whoosh` | a rush of air that peaks on the cue | a fast move, a slide in, a change of scene | soft and punchy |
| `rise` | a riser that climbs into the cue and stops on it | the build into a reveal; the cue is the reveal | soft and punchy |
| `hit` | a short punch: a crack over a low thump | a word that slams in | punchy only |
| `impact` | a big deep boom with a long tail | the one biggest moment | punchy only |
| `sub` | a low drop, felt more than heard | under a `hit` or an `impact`, for weight | punchy only |
| `glitch` | a digital stutter | something that breaks on screen | punchy only |
| `shatter` | glass breaking | the old way smashed, once in a video at most | punchy only |

How to place them:
- **One to three per scene.** Sound marks the moments that matter: the thing the viewer must notice. A cue on every
  element is noise. A burst of `key` or `tick` cues counts as one.
- **Small sounds first:** `pop`, `click`, `key`, `ding`. A `whoosh` at most once a scene, on a real move.
- **The time of a cue is the moment of the event:** the frame where the thing lands. On the `voice` and `footage`
  tracks that is the start of the spoken word in `audio/words.json`. A `whoosh` and a `rise` are built to arrive at
  that time; they start before it by themselves.
- **Gain** from 0.3 to 0.6: small sounds 0.3 to 0.4, accents 0.5 to 0.6.
- **Heavy sounds only in the punchy sound,** and then only on the one to three peaks of the plan: `impact` + `sub`,
  or `hit` + `sub`. The soft sound leaves them out and the result says so in `notes`.
- **Leave air.** Seconds with only music and voice are good; the music fills them.
- **Stereo is automatic.** Sweeps cross the field and alternate direction, small sounds alternate right and left, the
  big hits stay in the centre. A `"pan"` from -1 (left) to 1 (right) on a cue fixes its side, or a sweep's direction.

## Cue files

- `scenes/<id>/cues.json`, in seconds of the scene. Write them while you build the scene; they move with the scene
  when the scene list changes.
- `audio/cues.json`, in seconds of the video, for the few cues that belong to no scene.

```json
[{ "t": 1.25, "kind": "pop", "gain": 0.4 }, { "t": 2.1, "kind": "whoosh", "gain": 0.4, "pan": -1 }]
```

A cue with an unknown kind, no time, or a time outside its scene is left out and listed in `sfx.skipped` in the
result. Fix it and mix again.

## A project's own effects

When the thirteen kinds do not fit a moment (an error, a stamp, paper, a lock, a crowd), put the right recording in
`source/audio/sfx/` of the project (48 kHz) and describe it in `source/audio/sfx/sfx.json`, in the same format as the
engine's: `{ "sounds": { "<name>": { "file": "<name>.wav", "preroll": 0, "level": 0.5, "field": "centre",
"seconds": 0.4 } } }`. The mix merges these kinds with the engine's (a project's name wins), so a cue
`{ "t": 1.2, "kind": "<name>" }` plays it. `"heavy": true` keeps it out of the soft sound. Use only recordings whose
licence allows your videos.

## Music in the mix

- `--music-start <seconds>`: where in the track to start, to skip an intro or to begin on the strong part.
- `--hit <seconds>`: the second of the video where a strong beat should land, usually the biggest moment. The start
  moves by at most two beats, so that a real beat sits exactly there. The beats come from the engine, checked against
  the real bass hits; without the engine a built-in detector finds them. `music.hit` in the result names the beat.
- `--music-lufs -24` (the default): the level of the music before it goes under the voice. With no voice the music
  carries the video: it is not ducked, and the master raises the whole mix to the target anyway.
- `--duck 0.7` (the default): how far the music drops while the voice speaks, from 0 to 1. Use 0.5 for a video led
  by the music, 0.85 when every word must be clear.
- With music, the effects drop to three quarters of their level, so they sit under the music.
- The music fades in over 0.4 s and out over the last 1.5 s. A track shorter than the video starts again from its
  top (`music.loops` says where); a track that runs out within the last 1.5 s simply ends.
- The options are saved in `audio/mix.json`, so a plain `mix.mjs "<project>"` repeats them. `--no-music` takes the
  music out and forgets it.

## No music

- **With a voice:** the voice carries the video. Keep the effects few and soft, and say once, at the plan, that a
  track would lift it, or that one can be added in the app at upload.
- **With no voice and no music,** say at the brief that this video needs a track, and offer the three sources above.
  If the user still wants none, keep it quiet: small sounds on the moments that matter, one `rise` into the main
  reveal, and silence elsewhere. Never fill silence with booms, subs or a whoosh on every cut. The gate warns when the
  soundtrack is effects only.

## The mix

```
node "<SKILL>/scripts/mix.mjs" "<project>"
node "<SKILL>/scripts/mix.mjs" "<project>" --music "source/audio/<track file>" --hit 12.4
node "<SKILL>/scripts/mix.mjs" "<project>" --sound punchy --seams
node "<SKILL>/scripts/mix.mjs" "<project>" --no-music --no-seams
node "<SKILL>/scripts/mix.mjs" "<project>" --no-voice
```

- It finds the parts by itself: the cues from the cue files, the voice in `audio/voice.wav`, the music of the last
  run. Any subset works: effects only, voice only, voice and music, all three.
- The effects are summed on their cues. The voice goes in the centre as it is, and the effects dip a little under
  it. The music sits under the voice, and the effects under the music.
- The master is -14 LUFS with true peaks at most -1 dBTP. A test copy is encoded to AAC the way the cut is, and the
  limit comes down until that copy reads -0.7 dBTP or lower, so the cut passes the gate.
- `--sound soft` (the default) or `--sound punchy`. It is remembered like the music.
- `--seams` adds a soft whoosh on every cut between scenes that has no whoosh within 0.3 s. Use it only for hard cuts
  in a fast punchy video; leave it out of everything else. It is remembered like the music; `--no-seams` turns it off.
- `--sfx-gain` sets the overall level of the effects exactly: 0.8 by default in the soft sound (0.6 with music), 1.25
  in the punchy sound.
- `--no-voice` mixes without the voice, for example to hear the effects before the voice exists. `--no-sfx` mixes
  without the effects.
- `-o <file>` writes somewhere other than `audio/mix.wav`.
- The output is `audio/mix.wav`: 48 kHz, 24-bit stereo, exactly as long as the video (the end of the last scene).
  Then run `assemble.mjs`.

Read the result: `ok`, `loudness` (`lufs`, `truePeak`, `truePeakAac`), `sfx.skipped`, `sfx.heavyLeftOut`, `music.hit`
and `notes`. A note tells you when the soft sound left heavy effects out, when a scene has more than three effects,
when there is no music, when the voice is longer than the video (make the last scene longer), when the music loops,
or when the voice was not prepared with `voice.mjs` (it gets a plain gain to -16 LUFS in the mix).

Mix again whenever the cues, the scene timing, the voice or the music change. The gate (`check.mjs`, see
`references/review.md`) then measures the finished cut: loudness, true peak, audio length, long pauses in the voice,
and from the last mix: more than three heavy effects, more than 24 effects a minute, or a soundtrack of effects only.
