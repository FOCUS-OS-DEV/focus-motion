# Hebrew on screen

These rules come from rendering Hebrew in the engine's browser and checking the frames. They apply to every Hebrew
word in a video, including labels inside mocked interfaces and captions.

## Fonts

- **Use a family that has Hebrew letters.** `assets/fonts/fonts.json` lists what ships with the skill and which
  families also carry Latin.
- **A font without Hebrew fails silently.** The browser swaps in a system font and the frame looks wrong with no
  error.
- **Every family needs an `@font-face`** that points at a file inside the scene's `assets/` folder.

## Direction

- **Hebrew containers** carry `dir="rtl"`. The first word sits on the right.
- **Latin words and numbers inside a Hebrew line** are wrapped in `<bdi>` so punctuation stays on the correct side.
  A label that is all Latin gets `dir="ltr"`.
- **Right to left:** lists, tabs, menus, chat bubbles and charts. The first item or day is on the right.
- **Left to right:** progress bars, loading bars, sliders and media timelines. They fill as in any player.

## How words enter

- **Whole words only.** Never reveal Hebrew text through a mask, a clip, a wipe or a container that opens. Halfway
  through the reveal the letters look like a row of dashes.
- **The frame edge is a mask too.** A slow slide in from outside the frame leaves a stray letter for a moment. Slide
  quickly, or start inside the frame with the opacity rising.
- **Safe entrances:**
  - a short rise with the opacity coming up;
  - landing from slightly larger, up to about 1.3 times;
  - a fast slide;
  - a turn in 3D;
  - growing from a point.
- **Letter by letter:** the rightmost letter comes first, because it is the first one read.
- **Typing:** the letters appear in reading order and the caret sits to the left of the text, where the next letter
  will go.

## Lines and punctuation

- **The browser never wraps a line.** Each line is its own element with `white-space: nowrap`. You decide where
  lines break.
- **Break lines between phrases.** Do not leave a single short word alone on the last line, and do not start a line
  with a Latin word that leaves a Hebrew prefix letter hanging before it.
- **No hyphen or dash between two words** on screen: write a space, a comma or a new line. A prefix letter before a
  number or a Latin word is fine in speech, but on screen prefer wording that avoids it.
- **Closing punctuation** sits at the left end of the line. Check it in a frame: a wrong direction setting moves it
  to the right.

## Engine notes

- **Measure after the fonts load.** The scene script runs before the fonts are ready, and a word measured then has
  the wrong width (one test word read 764 px instead of 1023). Fit words to a width and choose line breaks inside
  `document.fonts.ready.then(...)`.
- **Sharp text when it scales.** Do not put `will-change: transform` on text that grows: the browser then scales a
  blurred bitmap of it.
- **Gradient text.** A gradient fill set on a parent does not reach children that are animated separately. Put the
  gradient on each animated letter or word.
- **Canvas.** Set `ctx.direction = "rtl"` before drawing Hebrew text.
- **SVG.** `text-anchor="middle"` is the safe choice for Hebrew text.

## Check before showing

1. Every word is spelled exactly as the user wrote it and reads right to left.
2. No word is cut by the frame or by another element at any moment of its entrance.
3. No hyphen or dash joins two words.
4. Punctuation is on the correct side.
5. Bars fill left to right. Everything else flows right to left.
