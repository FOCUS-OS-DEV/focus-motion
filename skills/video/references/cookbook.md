# Cookbook: proven techniques

Each file in `assets/cookbook/` is one small technique, written as a complete scene with the plumbing of
`assets/template/scene/index.html`, rendered and checked frame by frame. They are techniques, not designs: take the
mechanism, adapt it to the moment in the plan and restyle it to the plan's look (palette, fonts, sizes, timing, words);
never paste one unchanged. Read only the snippet you need. To see one run, copy it over a fresh scene's `index.html`
(the scene's `assets/` already holds `gsap.min.js` and the font) and lint, snapshot or render as usual.

## How every snippet is built

- The header comment says what the technique is, how it works, what to change, and the traps.
- The knobs sit at the top: colours in `:root` (`--bg`, `--ink`, `--accent`, `--accent-2`), then a
  `// ---- restyle here` block with the words, sizes and times. Times are seconds from the scene's first frame.
- `later(sel, from, to, at)` is `tl.fromTo` with `immediateRender: false`. Use it for a second tween on the same
  element, and for anything that must not show before its time (rings, flashes, ripples).
- `frame(t, i)` returns the time of a whole frame, a hair early. Hard cuts, shakes and swaps are written there, so
  each one shows on exactly the frames it should.
- Whatever is drawn per frame (typing, counters, falling pieces) hangs on a clock object, `set t(v) { draw(v) }`,
  moved by one tween. Any frame can then be asked for in any order and comes out the same.

## Facts checked in the engine

- The font file is not loaded yet when the scene's script runs. Text measured at that moment is measured in a
  fallback font (764 px instead of 1023 px for the same word). Measure inside `document.fonts.ready.then(...)`.
- `will-change: transform` on a wrapper that scales makes its text blurry. Without it, text stays sharp at 9 times.
- On an SVG element with `pathLength`, a dash offset written as CSS (`strokeDashoffset`) does not draw. Set
  `stroke-dasharray="1 1"` as an attribute and tween `attr: { "stroke-dashoffset": ... }`.
- Elements timed with `class="clip"` and `data-start` that hold children make the lint ask for separate files.
  Shots that live in one file are switched from the timeline instead (`hard-cuts-inside-a-scene`).
- A GSAP `scale` on a shape inside an SVG moves the shape off its place unless the tween also has
  `transformOrigin: "50% 50%"`. Simpler: tween the shape's own attributes, `attr: { r }`.

## Words and numbers

| id | file | what it does | a director reaches for it when |
|---|---|---|---|
| words-on-voice | `words-on-voice.html` | every spoken word lands on its own frame, with five different safe entrances; a finished phrase clears for the next | a voice track: the hook, or any line that carries the video |
| fit-and-hero-word | `fit-and-hero-word.html` | sizes each line to fill the safe width after the font loads; one hero word with a gradient on every letter | a title or a key line must be as big as the frame allows |
| strike-through | `strike-through.html` | a line is drawn across a word on a beat, two frames of shake, the word dims, its replacement lands | a contrast: the old way against the new one |
| typing-caret | `typing-caret.html` | Hebrew typed into a field in reading order, caret on the left, the send button wakes and is pressed | someone asks, searches or writes a request |
| number-roll | `number-roll.html` | an odometer that rolls column by column to a value, and a plain count-up that lands exactly | a number is the point: a price, a result, a percentage |
| stamp-slam | `stamp-slam.html` | a stamp falls and lands on the beat, the page gives, two frames of shake, a ring of ink | a verdict: approved, rejected, done, generic |
| banner-words | `banner-words.html` | a banner takes its words one by one and pulses on each; pills arrive for the next words | a list or a slogan spoken word by word |

## Camera and cuts

| id | file | what it does | a director reaches for it when |
|---|---|---|---|
| camera-wrapper | `camera-wrapper.html` | one constant push on a wrapper, a far layer that moves less, a kick on the hit | every scene: this is the camera |
| hard-cuts-inside-a-scene | `hard-cuts-inside-a-scene.html` | full-frame shots switched by hard cuts on words, each with its own motion | a fast run of words or ideas, one shot per word |
| swap-transitions | `swap-transitions.html` | the content of a frame changes four ways: swipe, zoom through, 3D flip, iris | a screen or a card shows one result after another |
| carry-across-a-cut | `carry-across-a-cut.html` | an element survives a hard cut: it launches out of one shot and docks in the next as a title | two scenes or shots must read as one film |

## Interfaces and objects

| id | file | what it does | a director reaches for it when |
|---|---|---|---|
| phone-with-live-screen | `phone-with-live-screen.html` | a CSS phone turning in 3D while its screen counts, fills and gets a notification | an app or a product on a phone |
| ui-builds-itself | `ui-builds-itself.html` | blocks snap into dashed drop zones one by one, then come alive | "we build it": an app, a dashboard, a page made in front of the viewer |
| chart-draws | `chart-draws.html` | bars grow, a line draws across them right to left, the value lands with the line | growth, results, a trend |
| cursor-click | `cursor-click.html` | a pointer travels on a curve, presses with a ripple, the button turns to its done state | a decision or an action on screen: approve, send, start |
| terminal-prompt | `terminal-prompt.html` | a terminal window, a typed request, an Enter flash, progress lines and a running bar | a tool or an agent is asked to do something and starts |
| keys-press | `keys-press.html` | keyboard keys: a hover that is not a press, then two keys pressed and held together | a shortcut or a key moment ("before you press Enter") |
| checklist-ticks | `checklist-ticks.html` | plan lines write in, tick one by one, an approve button is pressed | a plan, steps, a list that gets confirmed |
| progress-and-strip | `progress-and-strip.html` | a bar fills left to right and lights up the items under it as it passes them | work being done, a build, a render, a journey of steps |
| card-with-rows | `card-with-rows.html` | a document card writes its rows over placeholders; a badge ticks like an odometer | an invoice, a report, a summary that fills itself |

## Effects, footage and characters

| id | file | what it does | a director reaches for it when |
|---|---|---|---|
| particles-to-shape | `particles-to-shape.html` | seeded dots swarm through the frame, then gather into a ring that locks with a pulse | scattered parts becoming one thing: a team, a product, a decision |
| shatter | `shatter.html` | a card cracks for two frames, then breaks into seeded pieces that fly from the hit and fall | breaking with the old way, on the hit word of a peak |
| tear-in-two | `tear-in-two.html` | a paper card torn along a ragged line, the halves open and fall, scraps flutter | throwing away a draft, a price or a plan, then the new line |
| confetti-burst | `confetti-burst.html` | a badge fills, a check draws, paper pieces burst up and drift down with drag and gravity | the one celebration of a video: done, launched, approved |
| shockwave-and-glow | `shockwave-and-glow.html` | a ring closes in, the word slams, two rings race out, a glow blooms and settles | dressing the single biggest hit of a scene |
| cubes-3d | `cubes-3d.html` | real six-faced cubes tumble in orbit, lock into a grid, then burst around a word | building blocks, a system coming together, a tech product beat |
| light-sweep | `light-sweep.html` | one slanted band of light crosses a mark and its name, masked to the shapes | the final lockup or the name, once it has settled |
| ring-draws | `ring-draws.html` | an outline draws around the chosen card and locks, then a check draws in a ring | picking one option out of several, a confirmation |
| waveform | `waveform.html` | bars pulse with seeded levels, a play head runs left to right, a counter and rings | anything about voice, audio, a podcast or a recording |
| tilted-wall | `tilted-wall.html` | a floor of tiles tilted in 3D, rows sliding against each other, a slow push, a headline | an endless amount of content or options behind one line |
| conveyor | `conveyor.html` | a belt on one speed profile carries tiles, they drop off the end, one stops in the centre and is picked | many tools or choices passing by and the right one selected |
| clone-to-grid | `clone-to-grid.html` | one card multiplies into a row, then a grid, then a wall, with a stamp over it | sameness and scale: "everyone posts the same thing" |
| grain-and-vignette | `grain-and-vignette.html` | one static grain layer drawn once and darkened corners, outside the camera | finishing a flat or gradient look so it feels filmed, on any scene |
| motion-streaks | `motion-streaks.html` | sub-frame ghosts and a streak behind one or two very fast moves, clean at rest | a whip-fast entrance in a scene that must stay sharp otherwise |
| clip-in-a-card | `clip-in-a-card.html` | a muted clip plays in a rounded card with a play badge, its last frame takes over and keeps moving | showing a real short clip of the user's work inside a designed frame |
| text-behind-a-person | `text-behind-a-person.html` | plate, words, then the person's cutout on top, so words rise from behind them | a title that lives in the user's own footage, on a talking shot |
| photo-pile | `photo-pile.html` | photos burst into a pile with depth and parallax, each with a slow Ken Burns, then snap into a strip | "Your material": many real photos becoming one edit |
| viewfinder | `viewfinder.html` | a camera screen over footage: corners, thirds, blinking REC, a frame-exact timecode, a focus box that locks | opening on raw footage, filming, "this was shot on a phone" |
| video-strips-plane | `video-strips-plane.html` | three strips of clips on one tilted plane, rounded tile masks, rows sliding under a push | showing a whole body of video work at once, in motion |
| simple-character | `simple-character.html` | a friendly SVG character breathes, blinks, crouches, jumps a step with squash and stretch, lands in dust | a metaphor figure that levels up, tries, succeeds or reacts |
| crowd-silhouettes | `crowd-silhouettes.html` | heads and shoulders seen from behind rise into the frame, lit by the screen they watch | an audience, a class, a launch event or a presentation |
