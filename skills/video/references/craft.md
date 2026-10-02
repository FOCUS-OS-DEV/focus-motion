# Craft: how each moment is made well

The plan chooses the moments. This file is about executing them. Read it before building scenes, and again before
the self-review.

## 1. Readable before impressive

- One idea on screen at a time, and one place for the eye. At most two things move at once.
- Pause on any frame: a viewer can tell what it says.
- Fast is fine. Busy is not. A new beat replaces the previous one; it does not pile on top of it.

## 2. Every movement has a job

A movement directs the eye, shows a change, carries the viewer across a cut, or gives something character. Before
adding one, finish the sentence "this moves because...". If you cannot, leave it out.

## 3. Nothing dies

- **Holds keep moving.** No frame stays identical for more than about ten frames, except the final hold. A held
  element keeps a slow push or drift of one to three percent.
- **The first frame is already alive.** It is the thumbnail and the hook. Never open on an empty stage or a fade
  from black.
- **The last frame is complete.** Everything has landed, reads clearly and is well composed.

## 4. Timing

- **Entrances** take 0.15 to 0.35 seconds. Exits are quicker than entrances.
- **Staggers.** Elements that enter together start one or two frames apart, in reading order.
- **Big moves** follow four steps:
  1. a small pull the other way for a few frames;
  2. the move itself;
  3. a slight overshoot;
  4. a settle.
- **Eases.** Use eases with character: `back.out`, `expo.out`, `power3.out`, `elastic.out` with a low amplitude. A
  linear ease is for constant drifts only.
- **With a voice.** The event starts on the frame where the word starts. Put the sound cue at the same time.
- **Reading time.** Count about a third of a second per word plus half a second. A three-word phrase stays at least
  a second and a half.

## 5. Peaks are taken all the way

A peak moment gets every layer of care:
1. **Before.** The frame clears and leans toward what is coming.
2. **The hit.** It lands exactly on the beat or the word, with a sound.
3. **The reaction.** The camera kicks, nearby elements respond, and something small rewards a second viewing.
4. **After.** It settles into a clean, readable frame and holds.

If a peak looks like the supporting moments around it, it is not finished.

## 6. The camera

- Each scene has one continuous camera move, such as a slow push, a drift or a parallax. It lives on a wrapper
  element that holds the whole scene.
- A hit may add a short kick of a few percent.
- Cuts land on a word or a beat. Use hard cuts by default. A transition needs a reason.

## 7. What crosses a cut

Scenes should read as one film. Something carries across each cut: a colour, a shape, a direction of travel, or an
object that becomes another. Vary the energy, because quiet stretches make the peaks land.

## 8. Screens, cards and anything "inside"

Whatever sits inside a phone, a browser, a card or a video tile must be alive: designed content with a few large
elements that keep moving. Never use a still screenshot full of small text, or a photo of people standing idle.

## 9. Real material

When the words are about the user's own product, people or work, show the real thing.
- Ask for photos, clips or screens.
- Give each one a frame and a slow move.
- Prefer moments where something is happening.
- Convert phone clips to standard colour first (`references/footage.md`). One HDR clip turns a whole scene burnt
  and red.

## 10. Type

- **Sizes at 1080 wide:**
  - A hero word fills most of the safe width, usually 200 to 500 px.
  - Supporting text is at least 90 px.
  - Text that belongs to a mocked interface may be smaller.
- **How much.** No more than about six words on screen at once.
- **Contrast.** A phrase gets one clear hierarchy through weight and size.
- **Variety.** Change how words enter: rise, land from slightly larger, slide, turn, grow. The same entrance on every
  word reads as a template.
- **Hebrew.** `references/hebrew.md` applies to every Hebrew word.

## 11. Colour and depth

- **Palette only.** Every colour on screen comes from the approved palette.
- **Text over a busy background** gets a soft patch behind it, or the background dims while the text is up.
- **Grain or texture** is one static layer over everything. It is never placed inside something that scales.
- **Fast moves** look better with real motion blur. Ask the renderer for it on those scenes (`references/build.md`).

## 12. Safe areas

Platforms draw their own interface over the video. Text and important objects stay inside the clean area.
Backgrounds may fill the frame.

| Format | Clean area |
|---|---|
| Reel, story, short (1080x1920) | below y 250 and above y 1560. Below y 1150, also keep x under 940, because the buttons sit on the right. Keep about 80 px from the sides |
| Square (1080x1080) | 65 px from every edge |
| Wide (1920x1080) | 115 px from the sides, 65 px from the top and bottom |

## 13. Light

Keep full-frame brightness jumps to at most three in any second, and never strobe the whole frame. This follows the
accessibility guidance on flashing content.

## 14. Avoid

- Decoration with no meaning: floating icons, shapes that drift for no reason.
- Placeholder content in interfaces.
- Emoji as graphics.
- A logo or trademark the user did not provide or ask for.
- Any fact, number or name the user did not give.
