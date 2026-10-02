#!/usr/bin/env node
// sheet.mjs: a contact sheet of a video, with the time written under every tile, for Claude to look at.
//
// Usage:
//   node sheet.mjs <video> --every 0.5                  a tile every half second (the default mode)
//   node sheet.mjs <video> --at 1.2,3.4,7.9             tiles at exact times
//   node sheet.mjs <video> --words audio/words.json     one tile shortly after each word starts
//   Options: [--range a-b] [--after 0.1] [--cols 8] [--width 270] [--out file.jpg] [--frames dir]
//
//   --range a-b   only this stretch of the video, in seconds (with --every the last frame of the stretch is added)
//   --after s     with --words: how long after the word start the frame is taken (default 0.1)
//   --cols        tiles per row (default 8)
//   --width       tile width in px (default 270; made smaller when the row would pass 2000 px)
//   --out, -o     the sheet, .jpg or .png. A sheet that needs several pages becomes file-01.jpg, file-02.jpg, ...
//                 Default: <project>/work/sheet-<mode>.jpg when the video sits in a project, otherwise a file in
//                 the system temp folder. An existing sheet with the same name is replaced.
//   --frames dir  also write the frame of every tile at full size: dir/frame-0041.500.png
//
// Every page stays inside 2000 x 2000 px so it can be read as an image. The label under a tile is the real time of
// that frame, in seconds. stdout carries one JSON line:
//   { video, mode, count, pages, sheets: [...], tile: { width, height }, cols, labels, tiles: [{ t, page, row, col }] }
// With --words every tile also has { word, start }, and with --frames { frame }.
//
// Example:
//   node sheet.mjs "launch/launch-v1.mp4" --every 0.5 --range 40-52 --out "launch/work/sheet-flow.jpg"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, out, note, die, fwd, readJson, mediaInfo, ffprobeJson, run } from './lib/common.mjs';
import { tool, printUsage, filter, labelFont, round } from './lib/quality.mjs';

const MAX_SIDE = 2000;      // px, both ways: a larger image is shrunk or refused when Claude reads it
const MAX_TILES = 60;       // per page, keeps the ffmpeg command short
const MAX_PAGES = 20;
const GAP = 4;              // px between tiles
const BACK = '0x15151b';

const args = parseArgs(process.argv.slice(2), { booleans: ['help'], aliases: { o: 'out', h: 'help' } });
if (args.help) printUsage(import.meta.url);
if (!args._[0]) printUsage(import.meta.url, 2);

const video = path.resolve(args._[0]);
if (!fs.existsSync(video)) die(`video not found: ${fwd(video)}`, 2);
const ffmpegPath = tool('ffmpeg');
const info = await mediaInfo(video).catch((e) => die(e.message, 1));
if (!info.hasVideo) die(`no video stream in ${fwd(video)}`, 2);
const lastLines = (text, n = 3) => text.trim().split(/\r?\n/).slice(-n).join(' | ');

const number = (value, name, { min = -Infinity, max = Infinity, fallback } = {}) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value === true || !Number.isFinite(n) || n < min || n > max) die(`--${name} needs a number from ${min} to ${max}`, 2);
  return n;
};

// ---------- the frames to show ----------
// The nearest common frame rate when the file's own number is within a tenth of a percent of it (30.001 is 30).
const COMMON_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 120];
const nearest = COMMON_FPS.reduce((a, b) => (Math.abs(b - info.fps) < Math.abs(a - info.fps) ? b : a));
const fps = Math.abs(nearest - info.fps) / nearest < 0.001 ? nearest : info.fps || 30;
// The time of the last frame comes from the video stream itself: the file can be longer than its picture.
const probe = await ffprobeJson(video).catch((e) => die(e.message, 1));
const stream = probe.streams.find((s) => s.codec_type === 'video');
const streamEnd = Number(stream.duration) > 0
  ? Math.max(0, Number(stream.start_time) - Number(probe.format?.start_time) || 0) + Number(stream.duration)
  : info.duration;
const lastTime = Math.max(0, Math.min(streamEnd, info.frames ? info.frames / fps : Infinity) - 1 / fps);
// The frame on screen at time t. Any time at or past the last frame means the last frame.
const frameAt = (t) => {
  if (t >= lastTime - 1e-4) return { key: 'last', t: lastTime };
  const n = Math.max(0, Math.floor(t * fps + 1e-6));
  return { key: n, t: n / fps };
};

let span = [0, Infinity];   // what the caller asked for
if (args.range !== undefined) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(String(args.range));
  if (!m || Number(m[2]) <= Number(m[1])) die('--range needs two times in seconds, the first smaller: --range 40-52', 2);
  span = [Number(m[1]), Number(m[2])];
  if (span[0] > lastTime) die(`--range starts at ${span[0]} s but the video is ${round(info.duration)} s long`, 2);
}
const inSpan = (t) => t >= span[0] - 1e-6 && t <= span[1] + 1e-6;

const modes = ['every', 'at', 'words'].filter((k) => args[k] !== undefined);
if (modes.length > 1) die('use one of --every, --at, --words', 2);
const mode = modes[0] || 'every';
let wanted = [];            // [{ t, word?, start? }]
if (mode === 'every') {
  const step = number(args.every, 'every', { min: 0.01, max: 3600, fallback: 0.5 });
  const end = Math.min(span[1], lastTime);
  for (let k = 0; span[0] + k * step <= end + 1e-6; k++) wanted.push({ t: span[0] + k * step });
  wanted.push({ t: end });
} else if (mode === 'at') {
  wanted = String(args.at).split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ t: Number(s) }));
  if (!wanted.length || wanted.some((w) => !Number.isFinite(w.t) || w.t < 0)) die('--at needs times in seconds: --at 1.2,3.4', 2);
  wanted = wanted.filter((w) => inSpan(w.t));
} else {
  const after = number(args.after, 'after', { min: 0, max: 5, fallback: 0.1 });
  const file = path.resolve(String(args.words));
  if (args.words === true || !fs.existsSync(file)) die(`words file not found: ${fwd(file)}`, 2);
  let words;
  try { words = readJson(file); } catch (e) { die(e.message, 2); }
  if (!Array.isArray(words)) die(`${fwd(file)} is not a list of words: [{ "text": "...", "start": 0.42, "end": 0.80 }]`, 2);
  for (const w of words) {
    const start = Number(w?.start);
    if (w?.start === undefined || !Number.isFinite(start) || !inSpan(start)) continue;
    wanted.push({ t: start + after, word: String(w.text ?? w.word ?? ''), start: round(start, 3) });
  }
}

// One tile per frame: two times that fall on the same frame share it.
const byFrame = new Map();
for (const w of wanted.sort((a, b) => a.t - b.t)) {
  const f = frameAt(w.t);
  if (!byFrame.has(f.key)) byFrame.set(f.key, { t: f.t, ...(w.word !== undefined ? { word: w.word, start: w.start } : {}) });
  else if (w.word !== undefined) byFrame.get(f.key).word += ` ${w.word}`;
}
const targets = [...byFrame.values()];
if (!targets.length) die(mode === 'words' ? 'no word starts inside this range' : 'no frames inside this range', 2);

// ---------- layout ----------
const even = (n) => Math.max(2, 2 * Math.round(n / 2));
const turned = Math.abs(info.rotation) % 180 === 90;
const srcW = turned ? info.height : info.width, srcH = turned ? info.width : info.height;
const cols = Math.min(Math.round(number(args.cols, 'cols', { min: 1, max: 24, fallback: 8 })), targets.length);
const fontSize = (w) => Math.min(36, Math.max(14, Math.round(w * 0.1)));
const stripFor = (w) => even(fontSize(w) + 10);
let tileW = even(number(args.width, 'width', { min: 48, max: MAX_SIDE, fallback: 270 }));
tileW = Math.min(tileW, 2 * Math.floor((MAX_SIDE - (cols - 1) * GAP) / cols / 2));
if (tileW * srcH / srcW + stripFor(tileW) > MAX_SIDE) tileW = 2 * Math.floor((MAX_SIDE - 46) * srcW / srcH / 2);
const tileH = even(tileW * srcH / srcW);
const strip = stripFor(tileW);
const cellH = tileH + strip;
const rowsPerPage = Math.max(1, Math.min(Math.floor((MAX_SIDE + GAP) / (cellH + GAP)), Math.floor(MAX_TILES / cols) || 1));
const perPage = rowsPerPage * cols;
const pageCount = Math.ceil(targets.length / perPage);
if (pageCount > MAX_PAGES) die(`${targets.length} tiles need ${pageCount} pages; narrow it with --range, or use a larger --every`, 2);

// ---------- where the sheet goes ----------
function projectRoot(from) {
  let dir = from;
  for (let up = 0; up < 4; up++) {
    if (fs.existsSync(path.join(dir, 'project.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
if (args.out === true) die('--out needs a file name', 2);
if (args.frames === true) die('--frames needs a folder', 2);
let outFile = args.out !== undefined ? path.resolve(String(args.out)) : null;
if (!outFile) {
  const root = projectRoot(path.dirname(video));
  outFile = root
    ? path.join(root, 'work', `sheet-${mode}.jpg`)
    : path.join(os.tmpdir(), 'focus-motion', `sheet-${path.basename(video).replace(/\.[^.]+$/, '')}-${mode}.jpg`);
}
if (!/\.(jpe?g|png)$/i.test(outFile)) outFile += '.jpg';
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const pagePath = (p) => (pageCount === 1 ? outFile : outFile.replace(/(\.[^.]+)$/, `-${String(p + 1).padStart(2, '0')}$1`));
const framesDir = args.frames !== undefined ? path.resolve(String(args.frames)) : null;
if (framesDir) fs.mkdirSync(framesDir, { recursive: true });

// ---------- ffmpeg ----------
// The frame shown for a time is the first one that starts no earlier than half a frame before it. With
// -copyts -start_at_zero the filters see the real time of every frame, counted from the start of the file, also
// after a seek. So the label, which ffmpeg writes from the frame's own time, is true even if a seek lands badly.
const selectFor = (list) => {
  const terms = list.map((x, k) => `eq(selected_n,${k})*(${(x.t - 0.5 / fps).toFixed(5)})`);
  return filter('select', { expr: `lt(selected_n,${list.length})*gte(t,${terms.join('+')})` });
};
const inputFor = (list, seek) => [...(seek ? ['-ss', Math.max(0, list[0].t - 0.25).toFixed(3)] : []),
  '-copyts', '-start_at_zero', '-i', video, '-map', '0:v:0', '-an', '-sn', '-dn'];
const font = labelFont();
const LABEL = '%{eif:floor(floor(t*100+0.5)/100):d}.%{eif:mod(floor(t*100+0.5),100):d:2}';      // 41.50

async function makePage(list, file, withLabels, seek) {
  const rows = Math.ceil(list.length / cols);
  const chain = [selectFor(list), 'showinfo', filter('scale', { w: tileW, h: tileH, flags: 'bicubic' }), 'format=yuv420p',
    filter('pad', { w: tileW, h: cellH, x: 0, y: 0, color: BACK })];
  if (withLabels) {
    const size = fontSize(tileW);
    // A one pixel border in the text colour thickens the digits: the variable font opens at its lightest weight.
    chain.push(filter('drawtext', { fontfile: font.name, text: LABEL, fontsize: size, fontcolor: 'white',
      borderw: size >= 18 ? 1 : 0, bordercolor: 'white', x: 6, y: tileH + Math.round((strip - size) / 2) }));
  }
  chain.push(filter('tile', { layout: `${cols}x${rows}`, nb_frames: list.length, padding: GAP, margin: 0, color: BACK }));
  const quality = /\.png$/i.test(file) ? [] : ['-q:v', '3'];
  const r = await run(ffmpegPath, ['-hide_banner', '-y', '-nostdin', '-nostats', '-loglevel', 'info', ...inputFor(list, seek),
    '-vf', chain.join(','), '-frames:v', '1', ...quality, '-update', '1', file], withLabels ? { cwd: font.dir } : {});
  // showinfo reports the frames that were really taken, with their times.
  const times = [...r.stderr.matchAll(/Parsed_showinfo[^\n]*?\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  return { ok: r.code === 0 && fs.existsSync(file), times, stderr: r.stderr };
}

// A seek is trusted when every tile arrived and the first one is not late. Some containers land a seek on a later
// keyframe, or on nothing near the end of the file; then the page is made again by decoding from the start.
const seekWorked = (list, page) => page.ok && (!page.times.length || (page.times.length >= list.length && page.times[0] - list[0].t < 0.5));

let labels = Boolean(font);
async function pageWithFallbacks(list, file) {
  let seek = list[0].t > 0.25;
  let page = await makePage(list, file, labels, seek);
  const dropLabels = async () => {                 // an ffmpeg without drawtext, or a font it cannot read
    note(`labels failed (${lastLines(page.stderr, 1)}): making the sheet without them`);
    labels = false;
    page = await makePage(list, file, false, seek);
  };
  if (!page.ok && labels && /drawtext|font|freetype/i.test(page.stderr)) await dropLabels();
  if (seek && !seekWorked(list, page)) {
    note('the seek did not land where asked: decoding this page from the start of the file');
    seek = false;
    page = await makePage(list, file, labels, false);
  }
  if (!page.ok && labels) await dropLabels();
  if (!page.ok) die(`ffmpeg could not make the sheet: ${lastLines(page.stderr, 4)}`, 1);
  return { page, seek };
}

// Full-size frames of one page. One pass writes them all; if that pass did not write exactly one file per tile
// (an ffmpeg that repeats frames to fill the gaps), each frame is taken on its own.
async function writeFrames(list, seek) {
  const stamp = `sheet-tmp-${process.pid}`;
  const names = list.map((x) => `frame-${x.t.toFixed(3).padStart(8, '0')}.png`);
  const r = await run(ffmpegPath, ['-hide_banner', '-y', '-nostdin', '-nostats', '-loglevel', 'error', ...inputFor(list, seek),
    '-vf', `${selectFor(list)},setpts=N/(30*TB)`, '-r', '30', '-frames:v', String(list.length), '-start_number', '0', `${stamp}-%05d.png`], { cwd: framesDir });
  const made = fs.readdirSync(framesDir).filter((f) => f.startsWith(`${stamp}-`)).sort();
  if (r.code === 0 && made.length === list.length) {
    made.forEach((f, k) => fs.renameSync(path.join(framesDir, f), path.join(framesDir, names[k])));
  } else {
    made.forEach((f) => { try { fs.unlinkSync(path.join(framesDir, f)); } catch { /* already gone */ } });   // this run's own temp files (not rmSync: it skips Hebrew paths on Windows)
    for (let k = 0; k < list.length; k++) {
      const one = await run(ffmpegPath, ['-hide_banner', '-y', '-nostdin', '-nostats', '-loglevel', 'error', ...inputFor([list[k]], seek),
        '-vf', selectFor([list[k]]), '-frames:v', '1', '-update', '1', path.join(framesDir, names[k])]);
      if (one.code !== 0 || !fs.existsSync(path.join(framesDir, names[k]))) die(`could not write the frame at ${list[k].t.toFixed(2)} s: ${lastLines(one.stderr, 2)}`, 1);
    }
  }
  return names.map((f) => fwd(path.join(framesDir, f)));
}

// ---------- run ----------
if (!font) note('no font found for the labels: the sheet has no times on it, the JSON still lists them in order');
const sheets = [], tiles = [];
for (let p = 0; p < pageCount; p++) {
  const list = targets.slice(p * perPage, (p + 1) * perPage);
  const file = pagePath(p);
  note(`page ${p + 1}/${pageCount}: ${list.length} tiles from ${list[0].t.toFixed(2)} s`);
  const { page, seek } = await pageWithFallbacks(list, file);
  const shown = page.times.length ? list.slice(0, page.times.length) : list;
  shown.forEach((x, k) => { if (page.times[k] !== undefined) x.t = page.times[k]; });
  const frameFiles = framesDir ? await writeFrames(shown, seek) : [];
  shown.forEach((x, k) => tiles.push({
    t: round(x.t), page: p + 1, row: Math.floor(k / cols) + 1, col: (k % cols) + 1,
    ...(x.word !== undefined ? { word: x.word, start: x.start } : {}),
    ...(framesDir ? { frame: frameFiles[k] } : {}),
  }));
  sheets.push(fwd(file));
}

out({
  video: fwd(video), mode, count: tiles.length, pages: sheets.length, sheets,
  tile: { width: tileW, height: tileH }, cols, labels, ...(labels ? { font: font.name } : {}),
  ...(framesDir ? { frames: fwd(framesDir) } : {}), tiles,
});
