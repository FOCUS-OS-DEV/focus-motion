// Helpers for the quality tools (sheet.mjs and check.mjs): streaming frame statistics, the detectors that run on
// them, audio measurements, a label font and filter escaping for ffmpeg's drawtext, and a static scanner for scene
// HTML. Node 20+, built-in modules only. ffmpeg always runs with an argument array.
//
// Usage:   import { videoSignals, deadStretches, scanScene } from './lib/quality.mjs';
// Example: const sig = await videoSignals('cut.mp4', { width: 1080, height: 1920 });
//          const dead = deadStretches(sig);          // [{ t, t_end, seconds, frozen }]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SKILL_ROOT, IS_WIN, IS_MAC, findTool, fwd, readJson, die, run } from './common.mjs';

// ---------- thresholds ----------
// Calibrated on our own production cuts (a rejected one and the approved one). check.mjs --help explains them.
export const THRESHOLDS = {
  analysisFps: 30,            // every video is analysed at 30 fps, so the numbers below mean the same at any fps
  analysisShortSide: 135,     // grey analysis frame: 1080x1920 becomes 135x240
  deadSmooth: 0.2,            // seconds of averaging of the frame difference
  deadDiff: 0.6,              // mean absolute difference between two frames (0..255) below which nothing happens
  deadRun: 0.7,               // seconds the averaged difference must stay low (about 0.8 s of picture time)
  deadFail: 1.8,              // from this length a dead stretch is a FAIL, under it a WARN
  frozenDiff: 0.02,           // median difference under this: the picture does not move at all
  exemptTail: 1.5,            // the last seconds of the video may hold still
  flashJump: 0.02,            // a brightness jump: the mean of the frame moves by more than 2 % of full scale
  flashWindow: 1.0,           // seconds
  flashMax: 3,                // more jumps than this inside one window is a FAIL
  blackPixel: 0.03,           // a pixel under 3 % of full scale is black (a #0a0a0a background is not)
  blackRatio: 0.995,          // a frame with this share of black pixels is a black frame
  lufsTarget: -14,
  lufsTolerance: 1,
  truePeakMax: -1,            // dBTP of the mix
  truePeakCodecAllowance: 0.5, // AAC raises the measured peak a little, so the cut may read up to -0.5
  avLengthTolerance: 0.2,     // seconds between the audio and the video length
  durationTolerance: 0.2,     // seconds between the video and the scene list
  voiceSilence: 0.45,         // seconds of silence inside the voice
};

export const round = (x, digits = 2) => {
  const m = 10 ** digits;
  return Math.round(x * m) / m;
};

// ---------- programs ----------
export function tool(name) {
  const p = findTool(name);
  if (!p) die(`${name} was not found. Run the doctor: node "${fwd(path.join(SKILL_ROOT, 'scripts', 'doctor.mjs'))}"`, 3);
  return p;
}

// Prints the comment block at the top of a tool file (its usage) and exits. --help goes to stdout with exit 0;
// a bad call goes to stderr with exit 2, so stdout stays free for the one JSON line.
export function printUsage(fileUrl, code = 0) {
  const lines = fs.readFileSync(new URL(fileUrl), 'utf8').split(/\r?\n/);
  const block = [];
  for (const line of lines) {
    if (line.startsWith('#!')) continue;
    if (!line.startsWith('//')) break;
    block.push(line.replace(/^\/\/ ?/, ''));
  }
  (code === 0 ? process.stdout : process.stderr).write(block.join('\n') + '\n');
  process.exit(code);
}

// Runs ffmpeg and streams its stdout to onData(chunk). Resolves with { code, stderr }.
function pipeFfmpeg(args, onData) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', failed = null;
    child.stdout.on('data', (chunk) => {
      if (failed) return;
      try { onData(chunk); } catch (e) { failed = e; child.kill(); }
    });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2e5) stderr = stderr.slice(-1e5); });
    child.on('error', (e) => reject(new Error(`cannot start ffmpeg: ${e.message}`)));
    child.on('close', (code) => (failed ? reject(failed) : resolve({ code: code ?? 1, stderr })));
  });
}

const lastLines = (text, n = 4) => text.trim().split(/\r?\n/).slice(-n).join(' | ');

// ---------- streaming frame statistics ----------
// Size of the analysis frame: the short side becomes 135 px (1080x1920 -> 135x240, 1920x1080 -> 240x135).
export function analysisSize(width, height, shortSide = THRESHOLDS.analysisShortSide) {
  const k = shortSide / Math.min(width, height);
  return { width: Math.max(2, Math.round(width * k)), height: Math.max(2, Math.round(height * k)) };
}

// Decodes the video once at low resolution and calls onLuma(yPlane, index) for every frame. ffmpeg sends raw
// yuv420p in limited range (16..235) whatever the source was, so the numbers mean the same on every ffmpeg
// version. Only one frame is in memory at a time.
export async function scanLuma(file, { width, height, fps }, onLuma) {
  const ySize = width * height;
  const frameSize = ySize + 2 * ((width + 1) >> 1) * ((height + 1) >> 1);
  const frame = Buffer.allocUnsafe(frameSize);
  const yPlane = frame.subarray(0, ySize);
  let filled = 0, index = 0;
  const r = await pipeFfmpeg(['-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale=${width}:${height}:flags=bicubic:out_range=tv,format=yuv420p`,
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], (chunk) => {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(frameSize - filled, chunk.length - off);
      chunk.copy(frame, filled, off, off + n);
      filled += n; off += n;
      if (filled === frameSize) { filled = 0; onLuma(yPlane, index++); }
    }
  });
  if (index === 0) throw new Error(`ffmpeg could not decode ${fwd(file)}: ${lastLines(r.stderr) || 'no frames'}`);
  return { frames: index, complete: r.code === 0, stderr: r.stderr };
}

// Per-frame numbers for the video checks, in 0..255 units (full range), at THRESHOLDS.analysisFps:
//   mean[i]  mean brightness of frame i
//   diff[i]  mean absolute difference between frame i and frame i-1 (diff[0] = 0)
//   dark[i]  share of the pixels of frame i that are black
export async function videoSignals(file, { width, height }, T = THRESHOLDS) {
  const fps = T.analysisFps;
  const size = analysisSize(width, height, T.analysisShortSide);
  const pixels = size.width * size.height;
  const scale = 255 / 219;                         // limited range -> full range
  const darkCode = 16 + T.blackPixel * 219;        // the black level in limited-range codes
  let cap = 4096, n = 0;
  let mean = new Float32Array(cap), diff = new Float32Array(cap), dark = new Float32Array(cap);
  const prev = Buffer.alloc(pixels);
  const r = await scanLuma(file, { ...size, fps }, (y, i) => {
    if (i >= cap) {
      cap *= 2;
      const grow = (a) => { const b = new Float32Array(cap); b.set(a); return b; };
      mean = grow(mean); diff = grow(diff); dark = grow(dark);
    }
    let sum = 0, ad = 0, dk = 0;
    for (let p = 0; p < pixels; p++) {
      const v = y[p];
      sum += v;
      const d = v - prev[p];
      ad += d < 0 ? -d : d;
      if (v <= darkCode) dk++;
    }
    mean[i] = Math.max(0, (sum / pixels - 16) * scale);
    diff[i] = i === 0 ? 0 : (ad / pixels) * scale;
    dark[i] = dk / pixels;
    y.copy(prev);
    n = i + 1;
  });
  return { fps, frames: n, seconds: n / fps, size, complete: r.complete,
    mean: mean.subarray(0, n), diff: diff.subarray(0, n), dark: dark.subarray(0, n) };
}

// ---------- detectors ----------
// Dead stretches. The frame difference is averaged over 0.2 s (a centred window), and a stretch is reported when
// the average stays under `deadDiff` for `deadRun` seconds or more. A slow drift or a breathing scale stays under
// the threshold on purpose: ambient motion is not an event. `exemptTail` seconds at the end are not checked.
export function deadStretches(sig, { exemptTail = THRESHOLDS.exemptTail, ...over } = {}) {
  const T = { ...THRESHOLDS, ...over };
  const { fps, frames: n, diff } = sig;
  const win = Math.max(1, Math.round(T.deadSmooth * fps)), half = Math.floor(win / 2);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (i === 0 ? 0 : diff[i]);
  const low = (i) => {                             // is the averaged difference around frame i under the threshold
    const a = Math.max(1, i - half), b = Math.min(n, i - half + win);
    return b > a && (pre[b] - pre[a]) / (b - a) < T.deadDiff;
  };
  const minRun = Math.max(1, Math.round(T.deadRun * fps));
  const limit = n - Math.round(exemptTail * fps);  // the first exempt frame
  const out = [];
  let i = 1;
  while (i < n) {
    if (!low(i)) { i++; continue; }
    let j = i;
    while (j < n && low(j)) j++;
    const end = Math.min(j, limit);                // differences i..end-1 are low: frames i-1..end-1 look the same
    if (end - i >= minRun) {
      const vals = Array.from(diff.subarray(i, end)).sort((a, b) => a - b);
      out.push({
        t: round((i - 1) / fps), t_end: round((end - 1) / fps), seconds: round((end - i) / fps),
        frozen: vals[vals.length >> 1] < T.frozenDiff,
      });
    }
    i = j;
  }
  return out;
}

// Runs of black frames: [{ t, t_end, frames, atStart, atEnd }].
export function blackRuns(sig, T = THRESHOLDS) {
  const { fps, frames: n, dark } = sig;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (dark[i] < T.blackRatio) continue;
    let j = i;
    while (j < n && dark[j] >= T.blackRatio) j++;
    out.push({ t: round(i / fps), t_end: round(j / fps), frames: j - i, atStart: i === 0, atEnd: j === n });
    i = j;
  }
  return out;
}

// Flashing. A jump is a step of the mean brightness between two frames of more than `flashJump` of full scale.
// Steps in the same direction with no opposite step between them count once: a fast fade, or words that build up
// one after another, is one jump. What counts is the picture going brighter, darker, brighter. More than
// `flashMax` jumps inside any `flashWindow` seconds is a burst.
// Returns { peak, bursts: [{ t, t_end, jumps }] }; peak is the largest count found in one window.
export function flashBursts(sig, T = THRESHOLDS) {
  const { fps, frames: n, mean } = sig;
  const level = T.flashJump * 255, span = T.flashWindow * fps;
  const steps = [];
  for (let i = 1; i < n; i++) {
    const d = mean[i] - mean[i - 1];
    if (d > level || d < -level) steps.push({ i, up: d > 0 });
  }
  const bursts = [];
  let peak = 0;
  for (let a = 0; a < steps.length; a++) {
    let jumps = 0, last = a;
    for (let b = a; b < steps.length && steps[b].i - steps[a].i < span; b++) {
      if (b === a || steps[b].up !== steps[b - 1].up) jumps++;
      last = b;
    }
    peak = Math.max(peak, jumps);
    if (jumps <= T.flashMax) continue;
    const t = round(steps[a].i / fps), tEnd = round(steps[last].i / fps);
    const prev = bursts[bursts.length - 1];
    if (prev && t <= prev.t_end) { prev.t_end = Math.max(prev.t_end, tEnd); prev.jumps = Math.max(prev.jumps, jumps); }
    else bursts.push({ t, t_end: tEnd, jumps });
  }
  return { peak, bursts };
}

// ---------- audio ----------
// Integrated loudness (LUFS) and true peak (dBTP) of the first audio stream, measured with ffmpeg's ebur128.
export async function measureLoudness(file) {
  const r = await run(tool('ffmpeg'), ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-']);
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const i = /Integrated loudness:\s*I:\s*(-?[\d.]+)\s*LUFS/.exec(summary);
  const p = /True peak:\s*Peak:\s*(-?[\d.]+|-?inf)\s*dBFS/.exec(summary);
  if (r.code !== 0 || !i) throw new Error(`could not measure the loudness of ${fwd(file)}: ${lastLines(r.stderr)}`);
  const peak = p ? (/inf/.test(p[1]) ? -Infinity : Number(p[1])) : null;
  return { lufs: Number(i[1]), truePeak: peak };
}

// Silences inside a voice file. The level is measured every 10 ms. The loud parts of the speech (the 95th
// percentile) are the reference, and a moment is silent when it is more than 14 dB under them: a breath in a pause
// counts as silence, a soft word does not. Silence before the first word and after the last one is not reported.
export async function voiceSilences(file, minSeconds = THRESHOLDS.voiceSilence) {
  const rate = 16000, hop = 160;                   // 10 ms
  let cap = 8192, n = 0, acc = 0, cnt = 0, odd = null;
  let db = new Float32Array(cap);
  const push = (sample) => {
    acc += sample * sample;
    if (++cnt === hop) {
      if (n >= cap) { cap *= 2; const b = new Float32Array(cap); b.set(db); db = b; }
      db[n++] = 10 * Math.log10(acc / hop / (32768 * 32768) + 1e-12);
      acc = 0; cnt = 0;
    }
  };
  const r = await pipeFfmpeg(['-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], (chunk) => {
    let off = 0;
    if (odd !== null && chunk.length) { push(((chunk[0] << 8) | odd) << 16 >> 16); odd = null; off = 1; }
    for (; off + 1 < chunk.length; off += 2) push(chunk.readInt16LE(off));
    if (off < chunk.length) odd = chunk[off];
  });
  if (n === 0) throw new Error(`could not read the audio of ${fwd(file)}: ${lastLines(r.stderr) || 'no samples'}`);
  const levels = db.subarray(0, n);
  const heard = Array.from(levels).filter((v) => v > -100).sort((a, b) => a - b);   // without digital silence
  if (!heard.length) return { seconds: round(n * 0.01), speechDb: null, thresholdDb: null, silences: [] };
  const speech = heard[Math.floor(0.95 * (heard.length - 1))];
  const threshold = speech - 14;
  let first = 0, last = n - 1;
  while (first < n && levels[first] < threshold) first++;
  while (last > first && levels[last] < threshold) last--;
  const silences = [];
  for (let i = first; i <= last; i++) {
    if (levels[i] >= threshold) continue;
    let j = i;
    while (j <= last && levels[j] < threshold) j++;
    if ((j - i) * 0.01 > minSeconds) silences.push({ t: round(i * 0.01), t_end: round(j * 0.01), seconds: round((j - i) * 0.01) });
    i = j;
  }
  return { seconds: round(n * 0.01), speechDb: round(speech, 1), thresholdDb: round(threshold, 1), silences };
}

// ---------- ffmpeg filter text ----------
// A value inside a filter passes two parsers: the option parser (\ ' :) and the filtergraph parser (\ ' , ; [ ]).
export const escOption = (s) => String(s).replace(/[\\':]/g, '\\$&');
export const escGraph = (s) => String(s).replace(/[\\',;[\]]/g, '\\$&');
// filter('drawtext', { text: '1.50', x: 4 }) -> one filter, safe to join with commas into a chain.
export const filter = (name, opts = {}) => {
  const body = Object.entries(opts).map(([k, v]) => `${k}=${escOption(v)}`).join(':');
  return escGraph(body ? `${name}=${body}` : name);
};

// The font that labels the contact sheet. First choice: Rubik from the skill's assets/fonts. Then another font of
// the skill that carries Latin digits, then a system font. FOCUS_MOTION_LABEL_FONT overrides all of them.
// Returns { file, dir, name } or null. The caller starts ffmpeg inside `dir` and gives it only `name`, so the
// font path needs no escaping (a Windows drive colon must be escaped twice inside a filter) and does not depend on
// how an ffmpeg build opens paths with Hebrew letters.
export function labelFont() {
  const pick = (file) => ({ file, dir: path.dirname(file), name: path.basename(file) });
  const usable = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  if (process.env.FOCUS_MOTION_LABEL_FONT && usable(process.env.FOCUS_MOTION_LABEL_FONT)) return pick(path.resolve(process.env.FOCUS_MOTION_LABEL_FONT));
  const dir = path.join(SKILL_ROOT, 'assets', 'fonts');
  const own = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(p, depth + 1); } else if (/\.(ttf|otf)$/i.test(e.name) && !/italic/i.test(e.name)) own.push(p);
    }
  };
  walk(dir, 0);
  own.sort();
  const rubik = own.find((p) => /^rubik/i.test(path.basename(p)));
  if (rubik) return pick(rubik);
  // fonts.json lists the families; one that carries Latin has the digits the labels need.
  let listed = readJson(path.join(dir, 'fonts.json'), null);
  if (listed && !Array.isArray(listed)) listed = listed.fonts || listed.families || Object.values(listed);
  for (const f of Array.isArray(listed) ? listed : []) {
    if (!f || typeof f !== 'object' || !(f.latin ?? f.hasLatin)) continue;
    const names = [f.file, ...(Array.isArray(f.files) ? f.files : [])].map((x) => (typeof x === 'string' ? x : x?.file));
    const name = names.find((x) => typeof x === 'string' && !/italic/i.test(x));
    const hit = name && own.find((p) => path.basename(p) === path.basename(name));
    if (hit) return pick(hit);
  }
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const system = IS_WIN
    ? ['arial.ttf', 'segoeui.ttf', 'tahoma.ttf', 'verdana.ttf', 'consola.ttf'].map((f) => path.join(win, 'Fonts', f))
    : IS_MAC
      ? ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf',
        '/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/Geneva.ttf']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSans.ttf', '/usr/share/fonts/noto/NotoSans-Regular.ttf'];
  const sys = system.find(usable);
  if (sys) return pick(sys);
  return own.length ? pick(own[0]) : null;
}

// ---------- static scan of a scene's index.html ----------
const HEBREW_DASH = /[\u05D0-\u05EA][\u0591-\u05C7]*["'\u05F3\u05F4)\]]*\s*[-\u2010-\u2015]+\s*["'\u05F3\u05F4(\[]*[\u05D0-\u05EA]/g;
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset', 'revert', 'revert-layer',
  '-apple-system', 'blinkmacsystemfont', 'caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar']);
const NETWORK_URL = /^\s*(?:https?:)?\/\//i;
const ASSET_EXT = /\.(?:m?js|css|png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|aac|woff2?|ttf|otf|json)(?:[?#]\S*)?$/i;
const TIMER_CALLS = [
  [/\bMath\s*\.\s*random\s*\(/g, 'Math.random(', 'use the seeded random helper of the template'],
  [/\bsetTimeout\s*\(/g, 'setTimeout(', 'put it on the GSAP timeline'],
  [/\bsetInterval\s*\(/g, 'setInterval(', 'put it on the GSAP timeline'],
  [/\brequestAnimationFrame\s*\(/g, 'requestAnimationFrame(', 'put it on the GSAP timeline'],
];

const blankRange = (chars, a, b) => { for (let k = a; k < b; k++) if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' '; };
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\r\n]/g, ' '));
const cleanFamily = (s) => s.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
const short = (s, n = 60) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}...` : t; };

// Splits JavaScript into code, comments and strings. Returns two views of the same length as the source
// (`code`: comments and string contents blanked, `bare`: only comments blanked) and the list of string contents.
export function lexJs(src) {
  const n = src.length, code = src.split(''), bare = src.split(''), strings = [];
  const str = (a, b) => { strings.push({ start: a, value: src.slice(a, b) }); blankRange(code, a, b); };
  const stack = [];
  let i = 0, last = '', depth = 0;
  const regexAllowed = () => last === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(last)
    || /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(last);
  const template = (from) => {                     // reads template text from `from` up to the closing ` or a ${
    let k = from;
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '`') { str(from, k); last = 'str'; return k + 1; }
      if (src[k] === '$' && src[k + 1] === '{') { str(from, k); stack.push(depth); depth = 0; last = '{'; return k + 2; }
      k++;
    }
    str(from, n);
    return n;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { let e = src.indexOf('\n', i); if (e < 0) e = n; blankRange(code, i, e); blankRange(bare, i, e); i = e; continue; }
    if (c === '/' && d === '*') { let e = src.indexOf('*/', i + 2); e = e < 0 ? n : e + 2; blankRange(code, i, e); blankRange(bare, i, e); i = e; continue; }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
      str(i + 1, Math.min(k, n)); i = k + 1; last = 'str'; continue;
    }
    if (c === '`') { i = template(i + 1); continue; }
    if (c === '{') { depth++; last = c; i++; continue; }
    if (c === '}') {
      if (depth === 0 && stack.length) { depth = stack.pop(); i = template(i + 1); continue; }
      depth = Math.max(0, depth - 1); last = c; i++; continue;
    }
    if (c === '/') {
      if (!regexAllowed()) { last = c; i++; continue; }
      let k = i + 1, cls = false;
      while (k < n && src[k] !== '\n') {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '[') cls = true; else if (src[k] === ']') cls = false; else if (src[k] === '/' && !cls) break;
        k++;
      }
      blankRange(code, i + 1, Math.min(k, n)); i = k + 1;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      last = 'regex'; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$\u00a0-\uffff]/.test(c)) { let k = i + 1; while (k < n && /[\w$\u00a0-\uffff]/.test(src[k])) k++; last = src.slice(i, k); i = k; continue; }
    if (/[0-9]/.test(c)) { let k = i + 1; while (k < n && /[\w.]/.test(src[k])) k++; last = 'num'; i = k; continue; }
    last = c; i++;
  }
  return { code: code.join(''), bare: bare.join(''), strings };
}

// The first family of a font-family value, with var(--x) resolved. Returns null when it cannot be known.
function firstFamily(value, vars, hops = 0) {
  const v = value.replace(/!important/i, '').trim();
  const viaVar = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)/.exec(v);
  if (viaVar) {
    if (hops > 4) return null;
    const known = vars.get(viaVar[1]);
    if (known) return firstFamily(known, vars, hops + 1);
    return viaVar[2] ? firstFamily(viaVar[2].replace(/\)\s*$/, ''), vars, hops + 1) : null;
  }
  const first = /^(?:"([^"]*)"|'([^']*)'|([^,]+))/.exec(v);
  if (!first) return null;
  const name = cleanFamily(first[1] ?? first[2] ?? first[3] ?? '');
  return name && !/[(){}$<>+=]/.test(name) ? name : null;
}

// The family list inside a `font:` shorthand (everything after the size), or null.
function shorthandFamily(value) {
  const m = /(?:^|\s)(?:\d*\.?\d+(?:px|pt|em|rem|%|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pc)|(?:xx?-)?(?:small|large)|medium|larger|smaller|calc\([^)]*\)|var\([^)]*\))(?:\s*\/\s*[^\s,]+)?\s+(\S[\s\S]*)$/i.exec(value.trim());
  return m ? m[1] : null;
}

// Scans one scene file. `html` is the text of index.html, `extraCss` the text of the local stylesheets it links
// (only read for their @font-face rules). Returns [{ level, check, line, message }].
export function scanScene(html, { extraCss = [] } = {}) {
  const lineStarts = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const findings = [], seen = new Set();
  const add = (level, check, offset, message) => {
    const line = lineAt(offset), key = `${check}|${line}|${message}`;
    if (!seen.has(key)) { seen.add(key); findings.push({ level, check, line, message }); }
  };

  // 1. Cut the file into markup, scripts and styles. `chars` becomes the markup with the rest blanked.
  const chars = html.split('');
  const scripts = [], styles = [];
  const block = /<!--[\s\S]*?(?:-->|$)|<(script|style|title|textarea)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)(?:<\/\1\s*>|$)/gi;
  for (let m; (m = block.exec(html));) {
    if (!m[1]) { blankRange(chars, m.index, m.index + m[0].length); continue; }
    const start = m.index + 1 + m[1].length + m[2].length + 1;
    blankRange(chars, start, start + m[3].length);
    const tag = m[1].toLowerCase();
    if (tag === 'style') styles.push({ start, text: m[3] });
    if (tag === 'script') {
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[2]);
      if (!/\bsrc\s*=/i.test(m[2]) && (!type || /javascript|ecmascript|module|babel/i.test(type[1]))) scripts.push({ start, text: m[3] });
    }
  }
  const markup = chars.join('');

  // 2. Tags and their attributes.
  const tags = [];
  const tagRe = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*)\s*\/?>/g;
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
  for (let m; (m = tagRe.exec(markup));) {
    const attrs = new Map();
    const base = m.index + 1 + m[1].length;
    for (let a; (a = attrRe.exec(m[2]));) attrs.set(a[1].toLowerCase(), { value: a[2] ?? a[3] ?? a[4] ?? '', offset: base + a.index });
    tags.push({ name: m[1].toLowerCase(), attrs, offset: m.index, end: m.index + m[0].length });
  }

  // 3. Fonts that have an @font-face, and CSS variables, from every stylesheet first.
  const declared = new Set(), vars = new Map();
  const cssBlocks = styles.map((s) => ({ start: s.start, css: stripCssComments(s.text) }));
  const collect = (css) => {
    for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      const fam = /font-family\s*:\s*([^;}]+)/i.exec(m[1]);
      if (fam) declared.add(cleanFamily(fam[1]));
    }
    for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) vars.set(m[1], m[2].trim());
  };
  cssBlocks.forEach((b) => collect(b.css));
  extraCss.forEach((css) => collect(stripCssComments(css)));
  const lexed = scripts.map((s) => ({ start: s.start, ...lexJs(s.text) }));
  for (const js of lexed) for (const m of js.bare.matchAll(/new\s+FontFace\s*\(\s*["'`]([^"'`]+)["'`]/g)) declared.add(cleanFamily(m[1]));

  // 4. Checks that run on any piece of CSS: a style block, a style attribute, or CSS inside a script string.
  const useFont = (value, offset) => {
    const fam = firstFamily(value, vars);
    if (fam && !GENERIC_FONTS.has(fam) && !declared.has(fam)) {
      add('FAIL', 'font-face', offset, `font family "${fam}" is used with no @font-face; the render falls back to a system font`);
    }
  };
  const hebrewDash = (text, offset, where) => {
    for (const m of text.matchAll(HEBREW_DASH)) {
      // Quote the two whole words, not only the letters next to the dash.
      let a = m.index, b = m.index + m[0].length;
      while (a > 0 && /[֑-״]/.test(text[a - 1])) a--;
      while (b < text.length && /[֑-״]/.test(text[b])) b++;
      add('FAIL', 'hebrew-hyphen', offset + m.index, `a hyphen or dash joins two Hebrew words ${where}: "${short(text.slice(a, b), 48)}"; use a space, a comma or a new line`);
    }
  };
  const scanCss = (css, start, { rules }) => {
    const faces = rules ? [...css.matchAll(/@font-face\s*\{[^}]*\}/gi)].map((m) => [m.index, m.index + m[0].length]) : [];
    const inFace = (at) => faces.some(([a, b]) => at >= a && at < b);
    for (const m of css.matchAll(/(^|[;{\s])((?:-(?:webkit|moz|o|ms)-)?(?:transition|animation)(?:-[a-z-]+)?)\s*:\s*([^;}]+)/gi)) {
      if (/^(?:none|initial|unset|inherit|revert|0s)\b/i.test(m[3].trim())) continue;
      add('FAIL', 'css-motion', start + m.index + m[1].length, `CSS ${m[2].toLowerCase()} ("${short(m[3], 36)}") runs on the wall clock, not on the timeline; animate it with GSAP`);
    }
    for (const m of css.matchAll(/@(?:-(?:webkit|moz|o)-)?keyframes\s+([\w-]+)/gi)) {
      add('FAIL', 'css-motion', start + m.index, `CSS @keyframes "${m[1]}" runs on the wall clock, not on the timeline; animate it with GSAP`);
    }
    for (const m of css.matchAll(/(^|[;{\s])font-family\s*:\s*([^;}]+)/gi)) if (!inFace(m.index)) useFont(m[2], start + m.index + m[1].length);
    for (const m of css.matchAll(/(^|[;{\s])font\s*:\s*([^;}]+)/gi)) {
      const fam = shorthandFamily(m[2]);
      if (fam) useFont(fam, start + m.index + m[1].length);
    }
    for (const m of css.matchAll(/url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)/gi)) {
      add('FAIL', 'http-asset', start + m.index, `asset loaded from the network: ${short(m[1], 70)}; copy it into the scene's assets folder`);
    }
    for (const m of css.matchAll(/@import\s+["']\s*((?:https?:)?\/\/[^"')\s;]+)/gi)) {      // @import url(...) is caught above
      add('FAIL', 'http-asset', start + m.index, `stylesheet imported from the network: ${short(m[1], 70)}; copy it into the scene's assets folder`);
    }
    for (const m of css.matchAll(/content\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/gi)) hebrewDash(m[2], start + m.index, 'in CSS content');
  };
  cssBlocks.forEach((b) => scanCss(b.css, b.start, { rules: true }));

  // 5. Markup: video tags, network assets, style attributes, visible text.
  const urlAttrs = new Set(['src', 'href', 'poster', 'srcset', 'data', 'xlink:href', 'data-src', 'data-poster', 'data-composition-src']);
  const textAttrs = new Set(['placeholder', 'value']);       // attributes whose text is drawn on screen
  const text = markup.split('');
  for (const tag of tags) {
    blankRange(text, tag.offset, tag.end);
    if (tag.name === 'video' && !tag.attrs.has('muted')) {
      add('FAIL', 'video-muted', tag.offset, '<video> has no muted attribute; scene videos are silent, the sound comes from the mix');
    }
    for (const [name, attr] of tag.attrs) {
      if (urlAttrs.has(name) && NETWORK_URL.test(name === 'srcset' ? attr.value.split(',').find((u) => NETWORK_URL.test(u)) || '' : attr.value)) {
        if (tag.name === 'a' || tag.name === 'area') continue;
        if (tag.name === 'link' && /canonical|alternate|author|license|help|search|next|prev/i.test(tag.attrs.get('rel')?.value || '')) continue;
        add('FAIL', 'http-asset', attr.offset, `<${tag.name} ${name}> loads from the network: ${short(attr.value, 70)}; copy it into the scene's assets folder`);
      }
      if (name === 'style') scanCss(stripCssComments(attr.value), attr.offset, { rules: false });
      if (textAttrs.has(name) || (name.startsWith('data-') && !urlAttrs.has(name))) hebrewDash(attr.value, attr.offset, `in the ${name} attribute`);
    }
  }
  let visible = text.join('').replace(/<\/[a-zA-Z][^>]*>|<![^>]*>/g, (m) => ' '.repeat(m.length));
  visible = visible.replace(/&(?:ndash|mdash|hyphen|dash|horbar|#821[0-3]|#x201[0-5]);/gi, (m) => '-'.padEnd(m.length, ' '))
    .replace(/&nbsp;|&#160;|&#xa0;|&thinsp;|&ensp;|&emsp;/gi, (m) => ' '.repeat(m.length));
  hebrewDash(visible, 0, 'on screen');

  // 6. Scripts.
  for (const js of lexed) {
    for (const [re, name, fix] of TIMER_CALLS) {
      for (const m of js.code.matchAll(re)) add('FAIL', 'nondeterministic', js.start + m.index, `${name} makes every render different; ${fix}`);
    }
    const endless = 'repeat: -1 never ends, so the scene has no fixed length; repeat a counted number of times';
    for (const m of js.code.matchAll(/\brepeat\s*:\s*-\s*1\b|\.\s*repeat\s*\(\s*-\s*1\s*\)/g)) add('FAIL', 'nondeterministic', js.start + m.index, endless);
    for (const s of js.strings) {                    // the quoted key: { "repeat": -1 }
      const after = s.start + s.value.length + 1;
      if (s.value === 'repeat' && /^\s*:\s*-\s*1\b/.test(js.code.slice(after, after + 12))) add('FAIL', 'nondeterministic', js.start + s.start, endless);
    }
    for (const m of js.code.matchAll(/\.\s*style\s*\.\s*(transition|animation|webkitTransition|webkitAnimation)\w*\s*=(?!=)/g)) {
      add('FAIL', 'css-motion', js.start + m.index, `style.${m[1]} set from script runs on the wall clock, not on the timeline; animate it with GSAP`);
    }
    for (const m of js.bare.matchAll(/\bfont-?[Ff]amily["']?\s*[:=,]\s*(["'`])([^"'`]+)\1/g)) useFont(m[2], js.start + m.index);
    for (const m of js.bare.matchAll(/\.\s*font\s*=\s*(["'`])([^"'`]+)\1/g)) {      // canvas: ctx.font = "700 48px Rubik"
      const fam = shorthandFamily(m[2]);
      if (fam) useFont(fam, js.start + m.index);
    }
    for (const s of js.strings) {
      if (!s.value) continue;
      const at = js.start + s.start;
      const value = s.value.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\[nrt]/g, '  ');
      if (/[\u05D0-\u05EA]/.test(value)) hebrewDash(value.replace(/<[^>]*>/g, ''), at, 'in a script string');
      if (NETWORK_URL.test(value) && !/^\s*(?:https?:)?\/\/www\.w3\.org\//i.test(value) && !/\s/.test(value.trim())) {
        // A URL in a script counts when it names a file, or when the code right before it loads it.
        const before = js.code.slice(Math.max(0, s.start - 60), s.start - 1);
        const loads = /(?:\bsrc|\bhref|\bposter|\burl)\s*[=:]\s*$|(?:\bfetch|\bimport|\bload\w*)\s*\(\s*$|\b(?:from|import)\s*$/i.test(before);
        if (loads || ASSET_EXT.test(value.trim())) {
          add('FAIL', 'http-asset', at, `script loads from the network: ${short(value, 70)}; copy it into the scene's assets folder`);
        }
      }
      if (/<video\b/i.test(value)) for (const m of value.matchAll(/<video\b[^>]*>/gi)) if (!/\smuted\b/i.test(m[0])) add('FAIL', 'video-muted', at + m.index, '<video> built in a script has no muted attribute');
      if (/[:;]/.test(value) && /transition|animation|font|url\(/i.test(value)) scanCss(value, at, { rules: false });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}
