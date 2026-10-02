/* captions.js: word-synced captions for a Focus Motion scene. A plain browser script; it needs only GSAP.
 *
 * Usage, inside a scene's index.html, after the scene's own timeline is registered:
 *   <script src="assets/words.js"></script>       window.FM_WORDS = [{ "text": "שלום", "start": 0.42, "end": 0.80 }]
 *   <script src="assets/captions.js"></script>
 *   <script>
 *     FocusCaptions.add(window.__timelines["main"], window.FM_WORDS, { mode: "highlight" });
 *   </script>
 *
 * Example: the same words, revealed one by one, three words a line, near the top:
 *   <style>.fm-cap { --cap-y: 22%; }</style>
 *   FocusCaptions.add(tl, words, { mode: "reveal", maxChars: 14 });
 *
 * Times are the scene's own seconds (0 is the scene's first frame). The words are grouped into short cues that break
 * at sentence ends and pauses, never inside a word. Each cue is laid out in at most `lines` lines that the script
 * chooses itself (the browser never wraps). Right-to-left text is detected per cue; the words stay plain inline text,
 * so the browser's own bidi keeps Latin words, numbers and punctuation in their correct places inside a Hebrew line.
 *
 * Determinism: nothing runs on real time. The DOM is built once, every change is a GSAP tween or set on the timeline
 * at a fixed time, and the state of any frame depends only on that frame's time, in any seek order.
 *
 * Every look comes from CSS variables on .fm-cap (defaults in brackets):
 *   --cap-y (74%)  --cap-left / --cap-right (the safe zone)  --cap-font (the scene font)  --cap-size (72px)
 *   --cap-weight (800)  --cap-line-height (1.18)  --cap-color (#fff)  --cap-active-color (#ffe14d)
 *   --cap-past-color (= --cap-color)  --cap-active-bg (none: a box behind the spoken word)  --cap-stroke-width (0)
 *   --cap-stroke-color  --cap-shadow (none)  --cap-bg (none: a box behind each line)  --cap-pad  --cap-radius  --cap-z (50)
 */
(function () {
  'use strict';
  var RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  var SENTENCE_END = /[.?!\u2026]["'\u05F4\u201D)]*$/;
  var DEFAULTS = {
    mode: 'highlight',   // 'highlight': the cue appears whole, the spoken word changes colour; 'reveal': words appear as spoken
    maxWords: 6,         // words per cue
    maxChars: 18,        // characters per line
    lines: 2,            // lines per cue
    pause: 0.6,          // a silence longer than this starts a new cue (seconds)
    lead: 0.05,          // a cue appears this much before its first word
    hold: 0.3,           // and stays this long after its last word, unless the next cue comes first
    enter: 0.14,         // entrance: a short rise with the opacity coming up
    exit: 0.12,
    rise: 14,            // pixels
    parent: '#root',
    dir: 'auto',         // 'auto', 'rtl' or 'ltr'
    offset: 0            // seconds added to every word time
  };

  var CSS = [
    '.fm-cap { position: absolute; top: var(--cap-y, 74%); height: 0; left: var(--cap-left, var(--safe-left, 80px));',
    '  right: var(--cap-right, var(--safe-right-low, 140px)); z-index: var(--cap-z, 50); pointer-events: none; }',
    '.fm-cap-cue { position: absolute; left: 0; right: 0; top: 0; transform: translateY(-50%); }',
    '.fm-cap-in { display: flex; flex-direction: column; align-items: center; font-family: var(--cap-font, inherit);',
    '  font-size: var(--cap-size, 72px); font-weight: var(--cap-weight, 800); line-height: var(--cap-line-height, 1.18); }',
    '.fm-cap-line { display: block; white-space: nowrap; text-align: center; letter-spacing: 0; hyphens: none;',
    '  color: var(--cap-color, #ffffff); background: var(--cap-bg, transparent); padding: var(--cap-pad, 0 0.12em);',
    '  border-radius: var(--cap-radius, 0.16em); text-shadow: var(--cap-shadow, none);',
    '  -webkit-text-stroke: var(--cap-stroke-width, 0px) var(--cap-stroke-color, transparent); paint-order: stroke fill; }',
    '.fm-cap-w { border-radius: 0.14em; }',
    '.fm-cap-w[data-s="1"] { color: var(--cap-active-color, #ffe14d); background: var(--cap-active-bg, transparent);',
    '  box-shadow: 0 0 0 0.08em var(--cap-active-bg, transparent); }',
    '.fm-cap-w[data-s="2"] { color: var(--cap-past-color, var(--cap-color, #ffffff)); }'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById('fm-cap-style')) return;
    var s = document.createElement('style');
    s.id = 'fm-cap-style';
    s.textContent = CSS;
    // First in <head>, so the scene's own rules for .fm-cap win.
    document.head.insertBefore(s, document.head.firstChild);
  }

  function merge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b || {}) if (b[k] !== undefined) o[k] = b[k]; return o; }
  function chars(ws) { var n = 0; for (var i = 0; i < ws.length; i++) n += ws[i].text.length; return n + Math.max(0, ws.length - 1); }

  // The fewest lines these words need when each line holds at most maxChars (a longer single word gets its own line).
  function linesNeeded(ws, maxChars) {
    var lines = 0, cur = -1;
    for (var i = 0; i < ws.length; i++) {
      var l = ws[i].text.length;
      if (cur >= 0 && cur + 1 + l <= maxChars) cur += 1 + l;
      else { lines++; cur = l; }
    }
    return lines;
  }

  // Words -> cues: [[word, ...], ...].
  function group(words, o) {
    var cues = [], cur = [], soft = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i], prev = cur[cur.length - 1];
      var hard = prev && (w.start - prev.end > o.pause || SENTENCE_END.test(prev.text));
      var full = prev && (cur.length >= o.maxWords || linesNeeded(cur.concat([w]), o.maxChars) > o.lines);
      if (prev && (hard || full)) { cues.push(cur); soft.push(Boolean(full && !hard)); cur = []; }
      cur.push(w);
    }
    if (cur.length) { cues.push(cur); soft.push(false); }
    // A single word after a cue that ended only because it was full reads badly: give it the word before it.
    for (var j = 1; j < cues.length; j++) {
      var a = cues[j - 1], b = cues[j];
      if (soft[j - 1] && b.length === 1 && a.length >= 3) {
        var moved = [a[a.length - 1], b[0]];
        if (linesNeeded(moved, o.maxChars) <= o.lines) { b.unshift(a.pop()); }
      }
    }
    return cues;
  }

  // One cue -> lines, as balanced as possible: the longest line is as short as it can be.
  function splitLines(ws, o) {
    var n = ws.length, count = Math.min(o.lines, Math.max(1, linesNeeded(ws, o.maxChars)));
    if (count === 1 || n === 1) return [ws];
    var memo = {};
    function best(i, l) {                       // { cost, cuts } for words i.. in l lines
      var key = i + ':' + l;
      if (memo[key]) return memo[key];
      var r;
      if (l === 1) r = { cost: chars(ws.slice(i)), cuts: [] };
      else {
        r = { cost: Infinity, cuts: [] };
        for (var j = i + 1; j <= n - (l - 1); j++) {
          var rest = best(j, l - 1), here = chars(ws.slice(i, j));
          var c = Math.max(here, rest.cost) + (j - i === 1 && n > 2 ? 0.5 : 0); // a lone word on a line costs a little
          if (c < r.cost) r = { cost: c, cuts: [j].concat(rest.cuts) };
        }
      }
      memo[key] = r;
      return r;
    }
    var cuts = best(0, count).cuts, out = [], from = 0;
    for (var k = 0; k <= cuts.length; k++) { var to = k < cuts.length ? cuts[k] : n; out.push(ws.slice(from, to)); from = to; }
    return out;
  }

  // Shrinks a cue whose widest line does not fit between the side margins. Layout only, never timing.
  function fit(box, cues) {
    var max = box.getBoundingClientRect().width;
    if (!max) return;
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      c.inner.style.fontSize = '';
      var widest = 0;
      for (var j = 0; j < c.lineEls.length; j++) widest = Math.max(widest, c.lineEls[j].getBoundingClientRect().width);
      if (widest > max) c.inner.style.fontSize = 'calc(var(--cap-size, 72px) * ' + Math.max(0.55, (max / widest) * 0.98).toFixed(3) + ')';
    }
  }

  /**
   * Builds the captions and puts their tweens on `tl` at position 0.
   * Returns { el, cues: [{ start, end, text, lines }], timeline }.
   */
  function add(tl, words, options) {
    var o = merge(DEFAULTS, options);
    if (!tl || typeof tl.add !== 'function') throw new Error('FocusCaptions.add: the first argument is the scene timeline');
    var parent = typeof o.parent === 'string' ? document.querySelector(o.parent) : o.parent;
    if (!parent) throw new Error('FocusCaptions.add: no element ' + o.parent);
    var list = [];
    for (var i = 0; i < (words || []).length; i++) {
      var w = words[i], text = String(w.text == null ? w.word : w.text).trim();
      if (text && isFinite(w.start) && isFinite(w.end)) list.push({ text: text, start: +w.start + o.offset, end: Math.max(+w.end, +w.start) + o.offset });
    }
    list.sort(function (a, b) { return a.start - b.start; });
    injectStyle();
    var box = document.createElement('div');
    box.className = 'fm-cap';
    box.setAttribute('data-mode', o.mode);
    box.setAttribute('aria-hidden', 'true');
    parent.appendChild(box);
    var sub = gsap.timeline();
    var groups = group(list, o), cues = [];

    // DOM: .fm-cap > .fm-cap-cue > .fm-cap-in > .fm-cap-line > span.fm-cap-w (inline text, spaces between words)
    for (var g = 0; g < groups.length; g++) {
      var ws = groups[g], cueText = ws.map(function (x) { return x.text; }).join(' ');
      var dir = o.dir === 'auto' ? (RTL.test(cueText) ? 'rtl' : 'ltr') : o.dir;
      var cue = document.createElement('div'), inner = document.createElement('div');
      cue.className = 'fm-cap-cue';
      inner.className = 'fm-cap-in';
      inner.setAttribute('dir', dir);
      cue.appendChild(inner);
      var lines = splitLines(ws, o), lineEls = [], wordEls = [];
      for (var l = 0; l < lines.length; l++) {
        var line = document.createElement('div');
        line.className = 'fm-cap-line';
        for (var k = 0; k < lines[l].length; k++) {
          if (k) line.appendChild(document.createTextNode(' '));
          var span = document.createElement('span');
          span.className = 'fm-cap-w';
          span.setAttribute('data-s', '0');
          span.textContent = lines[l][k].text;
          line.appendChild(span);
          wordEls.push(span);
        }
        inner.appendChild(line);
        lineEls.push(line);
      }
      box.appendChild(cue);
      gsap.set(inner, { autoAlpha: 0, y: 0 });
      if (o.mode === 'reveal') gsap.set(wordEls, { opacity: 0 });
      cues.push({ words: ws, inner: inner, lineEls: lineEls, wordEls: wordEls, start: ws[0].start, end: ws[ws.length - 1].end,
        text: cueText, lines: lines.map(function (x) { return x.map(function (y) { return y.text; }).join(' '); }) });
    }

    // Timing: when each cue is on screen, and the state of each word.
    var shownUntil = 0, direct = false;                // direct: the cue before is replaced, not faded out
    for (var c = 0; c < cues.length; c++) {
      var q = cues[c], next = cues[c + 1];
      var tIn = Math.max(0, q.start - o.lead, shownUntil);
      var nextIn = next ? Math.max(0, next.start - o.lead) : Infinity;
      if (direct) {
        sub.set(q.inner, { autoAlpha: 1 }, tIn);
        sub.fromTo(q.inner, { y: o.rise * 0.5 }, { y: 0, duration: o.enter, ease: 'power2.out', immediateRender: false }, tIn);
      } else {
        sub.fromTo(q.inner, { autoAlpha: 0, y: o.rise }, { autoAlpha: 1, y: 0, duration: o.enter, ease: 'power2.out', immediateRender: false }, tIn);
      }
      var natural = q.end + o.hold;
      if (natural + o.exit <= nextIn) {
        sub.fromTo(q.inner, { autoAlpha: 1 }, { autoAlpha: 0, duration: o.exit, ease: 'power1.in', immediateRender: false }, natural);
        shownUntil = natural + o.exit;
        direct = false;
      } else {
        sub.set(q.inner, { autoAlpha: 0 }, nextIn);
        shownUntil = nextIn;
        direct = true;
      }
      for (var n = 0; n < q.words.length; n++) {
        var word = q.words[n], el = q.wordEls[n], after = q.words[n + 1];
        if (o.mode === 'reveal') {
          sub.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.08, ease: 'none', immediateRender: false }, Math.max(tIn, word.start - 0.03));
        }
        sub.set(el, { attr: { 'data-s': 1 } }, Math.max(tIn, word.start));
        if (after) sub.set(el, { attr: { 'data-s': 2 } }, Math.max(tIn, after.start));
      }
    }
    tl.add(sub, 0);

    fit(box, cues);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fit(box, cues); });
    return {
      el: box, timeline: sub,
      cues: cues.map(function (x) { return { start: x.start, end: x.end, text: x.text, lines: x.lines }; })
    };
  }

  window.FocusCaptions = { add: add, group: group, splitLines: splitLines, version: 1 };
})();
