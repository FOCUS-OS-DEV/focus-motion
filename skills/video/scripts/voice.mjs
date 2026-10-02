#!/usr/bin/env node
// voice.mjs: checks a voice recording, and prepares it for a video: silences shortened, a light clean-up,
// loudness -16 LUFS. The recording itself is never changed; prep writes a new 48 kHz mono WAV.
//
// Usage:
//   node voice.mjs measure <file>
//   node voice.mjs prep <in> [<in2> ...] -o <out.wav> [--cut 3.1-7.8,2:0-1.4] [--no-tighten] [--max-gap 0.22] [--no-polish]
//   node voice.mjs words <words.json> [<words2.json> ...] --map <out.cuts.json> -o <words-out.json> [--snap] [--voice <wav>]
//   node voice.mjs words <words.json> --voice <voice.wav> --snap -o <words-out.json>
//
//   measure   Loudness, noise floor, clipping and the long silences, with a verdict: good, usable or poor.
//   prep      files       several recordings (one take per paragraph) join in the order given, 0.5 s apart.
//             --cut       removes stretches, in seconds of the recording (a false start, a repeated line). Each edge
//                         moves to the quietest spot within 0.15 s, so a word is never clipped. With several files,
//                         2:0-1.4 means seconds 0 to 1.4 of the second file; a range with no number is in the first.
//             tighten     every silence is shortened: breaks between sentences to --max-gap (0.22 s), short pauses
//                         to about 0.13 s, with 10 ms fades at each cut. Off by default in a footage project,
//                         where the sound has to stay in sync with the picture.
//             polish      light only: pops on "p" and "b" pulled down, rumble out, a touch of warmth, a small mud
//                         cut, a soft de-esser, 2:1 compression. --no-polish keeps the recorded sound.
//             always      loudness -16 LUFS, and the exact cut map next to the output: <out>.cuts.json.
//             "features" in the project's project.json sets the defaults (voicePolish, voiceTighten); a flag wins.
//             An older output moves to _versions/.
//   words     Moves word times from the recording onto the prepared voice through the cut map, so a transcript of
//             the recording (and the user's corrections to it) serves the final voice. With several recordings, give
//             one words file per recording, in the same order. Words that were cut out are dropped and listed.
//             --snap  transcript times can be off by about a tenth of a second. Each word start moves onto the clear
//                     start nearby in the voice (a quiet gap, then a rise), at most 0.15 s; words that run into each
//                     other keep their time. A moved word keeps its listed times in "listed", so snapping again
//                     changes nothing. The voice is the WAV next to the map (audio/voice.cuts.json ->
//                     audio/voice.wav) unless --voice names it. Without --map, only the snap runs, on words that
//                     already match the voice.
//
// Example:
//   node voice.mjs prep "my video/source/audio/take.m4a" -o "my video/audio/voice.wav" --cut 0-4.2
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, out, note, die, fwd, readJson, writeJson, ffmpeg, mediaInfo } from './lib/common.mjs';
import {
  SR, readWav, writeWav, withTempDir, decodeAudio, measureLoudness, normalizeLoudness, integratedLoudness, samplePeakDb,
  frameLevels, percentile, butterworth, butterworthBand, applyFilter, zeroPhase, fromDb,
} from './lib/wav.mjs';

const HOP = 0.01;                 // the analysis frame, seconds
const FADE = Math.round(0.010 * SR);
const TARGET_LUFS = -16;
const CEILING = -2;               // dBTP for the voice file; the mix has its own limiter
const WORK_LUFS = -28;            // the level the clean-up chain was tuned at; every recording is brought here first
const LONG_SILENCE = 0.45;        // longer than this is a break between sentences
const JOIN_GAP = 0.5;             // silence between recordings joined into one voice
const MIN_RUN = 0.18;             // shorter silences are left alone
const CHAIN = [
  'highpass=f=70:poles=2',                                             // rumble out
  'equalizer=f=140:t=q:w=0.8:g=1.5',                                   // a touch of warmth
  'equalizer=f=350:t=q:w=1.2:g=-1.5',                                  // a small mud cut
  'deesser=i=0.35:m=0.5:f=0.5',                                        // soft de-esser
  'acompressor=threshold=-22dB:ratio=2:attack=15:release=200:makeup=2', // 2:1, only the loud syllables
  'loudnorm=I=-16:TP=-2:LRA=7',                                        // evens the level from sentence to sentence
].join(',');

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// ---------- analysis ----------
// Frame levels and the line between voice and silence. The line sits 14 dB above the quiet tenth of the frames,
// and never lower than 18 dB under the loud speech: in a very quiet room a breath in a pause is silence too.
// When the background comes within 12 dB of the loud speech, pauses cannot be told from soft words.
export function analyse(x) {
  const levels = frameLevels(x, SR, HOP);
  let floor = percentile(levels, 10);
  if (floor < -90) {
    // long stretches of digital silence (joined takes): look at what was actually recorded
    const real = levels.filter((v) => v > -90);
    if (real.length) floor = percentile(real, 10);
  }
  const loud = percentile(levels, 95);
  return { levels, floor, loud, threshold: Math.max(floor + 14, loud - 18), clear: floor + 14 <= loud - 12 };
}

// The pauses the gate (check.mjs) would report in a finished voice: more than 14 dB under the loud speech for
// longer than `min` seconds, between the first word and the last.
export function pausesLeft(x, min = LONG_SILENCE) {
  const levels = frameLevels(x, SR, HOP);
  const heard = levels.filter((v) => v > -100);
  if (!heard.length) return [];
  const line = percentile(heard, 95) - 14;
  let first = 0, last = levels.length - 1;
  while (first < levels.length && levels[first] < line) first++;
  while (last > first && levels[last] < line) last--;
  return quietRuns(levels.subarray(first, last + 1), line).filter((r) => (r.to - r.from) * HOP > min)
    .map((r) => ({ start: round((first + r.from) * HOP, 2), end: round((first + r.to) * HOP, 2), seconds: round((r.to - r.from) * HOP, 2) }));
}

// Runs of quiet frames: [{ from, to }] in frame numbers, `to` exclusive.
export function quietRuns(levels, threshold) {
  const runs = [];
  for (let i = 0; i < levels.length;) {
    if (levels[i] < threshold) {
      let j = i;
      while (j < levels.length && levels[j] < threshold) j++;
      runs.push({ from: i, to: j });
      i = j;
    } else i++;
  }
  return runs;
}

// The stretches to remove so every silence is short: [[fromSample, toSample], ...].
// The middle of each silence goes; a little air stays on both sides, so breaths at the edges of words survive.
export function tightenCuts(x, { maxGap = 0.22, shortGap = 0.13, threshold } = {}) {
  const levels = frameLevels(x, SR, HOP);
  const cuts = [];
  for (const { from, to } of quietRuns(levels, threshold)) {
    const run = (to - from) * HOP;
    if (run < MIN_RUN) continue;
    let a, b;
    if (from === 0) { a = 0; b = Math.trunc((to * HOP - 0.10) * SR); }                    // the lead-in: 0.1 s stays
    else if (to === levels.length) { a = Math.trunc((from * HOP + maxGap) * SR); b = x.length; } // the tail: one gap stays
    else {
      const keep = run > LONG_SILENCE ? maxGap : shortGap;
      a = Math.trunc((from * HOP + keep / 2) * SR);
      b = Math.trunc((to * HOP - keep / 2) * SR);
    }
    if (b - a > 2 * FADE) cuts.push([a, b]);
  }
  return cuts;
}

// ---------- editing ----------
// A cut list in samples -> the pieces that stay, as [from, to] in samples of the same timeline.
export function keepPieces(length, cuts) {
  const pieces = [];
  let at = 0;
  for (const [a, b] of cuts.slice().sort((p, q) => p[0] - q[0])) {
    if (a > at) pieces.push([at, Math.min(a, length)]);
    at = Math.max(at, b);
  }
  if (at < length) pieces.push([at, length]);
  return pieces;
}

// Pieces of the source joined into one signal, with a 10 ms fade on both sides of every join.
export function joinPieces(x, pieces) {
  const total = pieces.reduce((s, [a, b]) => s + (b - a), 0);
  const y = new Float32Array(total);
  let at = 0;
  pieces.forEach(([a, b], k) => {
    const len = b - a;
    y.set(x.subarray(a, b), at);
    if (len > FADE) {
      const fadeIn = k > 0 || a > 0;                              // something was removed before this piece
      const fadeOut = k < pieces.length - 1 || b < x.length;      // something is removed after it
      if (fadeIn) for (let i = 0; i < FADE; i++) y[at + i] *= i / (FADE - 1);
      if (fadeOut) for (let i = 0; i < FADE; i++) y[at + len - FADE + i] *= 1 - i / (FADE - 1);
    }
    at += len;
  });
  return y;
}

// Pieces given on the timeline of an already-edited signal -> the same pieces on the source timeline.
export function throughPieces(base, pieces) {
  const res = [];
  for (const [a, b] of pieces) {
    let at = 0;
    for (const [s, e] of base) {
      const len = e - s;
      const from = Math.max(a, at), to = Math.min(b, at + len);
      if (to > from) res.push([s + (from - at), s + (to - at)]);
      at += len;
    }
  }
  // neighbours that touch on the source are one piece again
  return res.reduce((acc, p) => {
    const last = acc[acc.length - 1];
    if (last && last[1] === p[0]) last[1] = p[1]; else acc.push([...p]);
    return acc;
  }, []);
}

// The quietest 10 ms within reach of t: where a cut does the least harm.
function quietest(levels, t, reach = 0.15) {
  const a = Math.max(0, Math.round((t - reach) / HOP)), b = Math.min(levels.length - 1, Math.round((t + reach) / HOP));
  let best = a;
  for (let i = a; i <= b; i++) if (levels[i] < levels[best]) best = i;
  return (best + 0.5) * HOP;
}

// ---------- pops on "p" and "b" ----------
// A pop is a burst under 80 Hz that is louder than the voice band (150 to 1200 Hz) at that moment and loud in
// absolute terms. For those few hundredths of a second everything under 120 Hz is pulled down, until the burst
// sits 10 dB under the voice. Ordinary words keep their lows. The filters are zero-phase, so the two parts add
// back to the original exactly wherever nothing is pulled down. Expects the voice at about -28 LUFS.
export function tamePops(x, { trigger = 2, floor = -50, keepUnder = 10, maxCut = 24, release = 0.045 } = {}) {
  const n = x.length;
  const hop = Math.round(0.005 * SR);
  const low = zeroPhase(x, butterworth('low', 4, 80));
  const cut = zeroPhase(x, butterworth('low', 4, 120));
  const band = applyFilter(x, butterworthBand(4, 150, 1200));
  const frames = Math.floor(n / hop);
  const level = (y) => {
    const o = new Float64Array(frames);
    for (let f = 0, p = 0; f < frames; f++) {
      let s = 0;
      for (let i = 0; i < hop; i++, p++) s += y[p] * y[p];
      o[f] = 20 * Math.log10(Math.sqrt(s / hop) + 1e-9);
    }
    return o;
  };
  const L = level(low), V = level(band);
  const want = new Float64Array(frames);
  for (let f = 0; f < frames; f++) if (L[f] > V[f] + trigger && L[f] > floor) want[f] = Math.min(maxCut, Math.max(0, L[f] - (V[f] - keepUnder)));
  for (let f = 0; f < frames - 1; f++) if (want[f + 1] > want[f]) want[f] = want[f + 1];   // start one frame early
  const smooth = new Float64Array(frames);
  const rel = Math.exp(-0.005 / release);
  let acc = 0;
  for (let f = 0; f < frames; f++) { acc = want[f] > acc ? want[f] : rel * acc + (1 - rel) * want[f]; smooth[f] = acc; }
  // the gain per sample, then a 1 ms average so it never steps
  const gain = new Float32Array(n);
  for (let i = 0; i < n; i++) gain[i] = 10 ** (-smooth[Math.min(frames - 1, Math.floor(i / hop))] / 20);
  const y = new Float32Array(n);
  const win = 48, half = 24;
  let sum = 0;
  for (let i = -half; i < win - half; i++) sum += i >= 0 && i < n ? gain[i] : 0;
  for (let i = 0; i < n; i++) {
    const g = sum / win;
    y[i] = x[i] - cut[i] + cut[i] * g;
    const leave = i - half, enter = i - half + win;
    sum += (enter >= 0 && enter < n ? gain[enter] : 0) - (leave >= 0 && leave < n ? gain[leave] : 0);
  }
  const events = [];
  for (let f = 0; f < frames; f++) {
    if (smooth[f] <= 3) continue;
    let g = f, top = 0;
    while (g < frames && smooth[g] > 3) { if (smooth[g] > top) top = smooth[g]; g++; }
    events.push({ t: round(f * 0.005), seconds: round((g - f) * 0.005), cutDb: round(top, 1) });
    f = g;
  }
  return { samples: y, events };
}

// ---------- measure ----------
// Counts the places where the recording sits flat on its ceiling (clipping), on the file's own samples.
async function clipCount(file) {
  const r = await ffmpeg(['-nostdin', '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-af', 'astats=measure_perchannel=none', '-f', 'null', '-']);
  const pick = (re) => { const m = r.stderr.slice(r.stderr.lastIndexOf('Overall')).match(re); return m ? Number(m[1]) : NaN; };
  return { places: pick(/Peak count:\s+([\d.]+)/), flat: pick(/Flat factor:\s+([\d.]+|-?inf|nan)/i) };
}

export async function measure(file) {
  const info = await mediaInfo(file);
  if (!info.hasAudio) die(`there is no sound in ${fwd(file)}`, 2);
  const audio = await decodeAudio(file);
  const mono = audio.channels.length === 1 ? audio.channels[0]
    : Float32Array.from(audio.channels[0], (v, i) => (v + audio.channels[1][i]) / 2);
  const seconds = mono.length / SR;
  if (seconds < 0.5) die(`the recording is only ${round(seconds, 2)} s long`, 1);
  const a = analyse(mono);
  // The voice: the frames within 20 dB of the loud speech. The background: the quietest third of a second that
  // was really recorded (digital silence between joined takes does not count).
  let speechPower = 0, speechFrames = 0;
  for (const v of a.levels) if (v >= a.loud - 20) { speechPower += 10 ** (v / 10); speechFrames++; }
  const speechLevel = speechFrames ? 10 * Math.log10(speechPower / speechFrames) : -Infinity;
  let noiseFloor = Infinity;
  const span = 30;
  for (let i = 0; i + span <= a.levels.length; i++) {
    const w = a.levels.subarray(i, i + span);
    if (w.some((v) => v <= -90)) continue;
    const mid = percentile(w, 50);
    if (mid < noiseFloor) noiseFloor = mid;
  }
  if (!Number.isFinite(noiseFloor)) noiseFloor = a.floor;
  const snr = speechLevel - noiseFloor;
  // With a loud background the line between voice and silence means nothing, so no silences are reported.
  const silences = !a.clear ? [] : quietRuns(a.levels, a.threshold).filter((r) => (r.to - r.from) * HOP >= LONG_SILENCE)
    .map((r) => ({ start: round(r.from * HOP, 2), end: round(r.to * HOP, 2), seconds: round((r.to - r.from) * HOP, 2) }));
  const loud = await measureLoudness(file);
  const peak = samplePeakDb(audio.channels);
  const clip = await clipCount(file);
  const clipped = peak > -0.3 && clip.places >= 4 ? clip.places : 0;

  const problems = [];
  let verdict = 'good';
  const worse = (v) => { if (v === 'poor' || verdict === 'good') verdict = v; };
  if (!speechFrames || speechLevel < -60) { worse('poor'); problems.push('no voice was found in the file'); }
  else {
    if (clipped >= 20) { worse('poor'); problems.push(`the recording is distorted: it hits its ceiling in ${clipped} places. Record again a little further from the microphone or speak softer`); }
    else if (clipped) { worse('usable'); problems.push(`the recording touches its ceiling in ${clipped} places; a few loud syllables may sound rough`); }
    else if (peak > -0.1) { worse('usable'); problems.push('the loudest moments reach full scale; listen for distortion'); }
    if (snr < 20) { worse('poor'); problems.push(`the background is loud: the voice is only ${Math.round(snr)} dB above it. Record in a quiet room, with the microphone closer`); }
    else if (snr < 30) { worse('usable'); problems.push(`some background noise: the voice is ${Math.round(snr)} dB above it. Closer to the microphone would be cleaner`); }
    if (speechLevel < -42) { worse('usable'); problems.push('the voice was recorded very quietly; the microphone was probably far. Closer gives a fuller sound'); }
  }
  return {
    file: fwd(file), seconds: round(seconds, 2), sampleRate: info.sampleRate, channels: info.channels,
    loudness: loud.I, truePeak: loud.TP, peak: round(peak, 1),
    speechLevel: round(speechLevel, 1), noiseFloor: round(noiseFloor, 1), snr: round(snr, 1), clipped,
    silences, longestSilence: silences.reduce((m, s) => Math.max(m, s.seconds), 0),
    pausesClear: a.clear, verdict, problems,
  };
}

// ---------- prep ----------
// --cut ranges -> [{ file, a, b, from, to }]: `from`/`to` count on the joined timeline of all the recordings.
function parseCuts(text, sources) {
  if (text === undefined) return [];
  if (text === true || text === '') die('--cut needs ranges in seconds, for example --cut 3.1-7.8,12-13.4', 2);
  return String(text).split(',').map((part) => {
    const m = part.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (!m) die(`--cut: "${part}" is not a range like 3.1-7.8 (or 2:3.1-7.8 for the second recording)`, 2);
    const file = m[1] ? Number(m[1]) : 1, a = Number(m[2]), b = Number(m[3]);
    const src = sources[file - 1];
    if (!src) die(`--cut: "${part}" names recording ${file}, but only ${sources.length} recording(s) were given`, 2);
    if (!(b > a)) die(`--cut: the range ${part} ends before it starts`, 2);
    if (a >= src.seconds) die(`--cut: the range ${part} starts after the end of the recording (${round(src.seconds, 2)} s)`, 2);
    return { file, a, b: Math.min(b, src.seconds), from: src.start + a, to: src.start + Math.min(b, src.seconds) };
  }).sort((p, q) => p.from - q.from);
}

// The project a file belongs to: the nearest folder above it that holds a project.json.
function projectOf(file) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, 'project.json');
    if (fs.existsSync(f)) return { root: dir, project: readJson(f, {}) || {} };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// An older output is kept: it moves to _versions/ of the project (or next to the output), named by its own time.
function shelve(file, home) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(home, '_versions');
  fs.mkdirSync(dir, { recursive: true });
  const t = fs.statSync(file).mtime;
  const p2 = (v) => String(v).padStart(2, '0');
  const stamp = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
  const ext = path.extname(file), base = path.basename(file, ext);
  let to = path.join(dir, `${base}-${stamp}${ext}`);
  for (let k = 2; fs.existsSync(to); k++) to = path.join(dir, `${base}-${stamp}-${k}${ext}`);
  fs.renameSync(file, to);
  return to;
}

export async function prep(inFiles, outFile, opts = {}) {
  const inputs = Array.isArray(inFiles) ? inFiles : [inFiles];
  const home = projectOf(outFile) || projectOf(inputs[0]);
  const features = home?.project?.features && typeof home.project.features === 'object' ? home.project.features : {};
  const footage = home?.project?.track === 'footage';
  const polish = opts.polish !== undefined ? opts.polish : features.voicePolish !== false;
  const tighten = opts.tighten !== undefined ? opts.tighten : !footage && features.voiceTighten !== false;
  const maxGap = opts.maxGap ?? 0.22;
  const shortGap = maxGap === 0.22 ? 0.13 : round(maxGap * 0.59, 3);
  const notes = [];

  // The recordings, joined in order with a short silence between them (10 ms fades at their edges).
  const parts = [];
  for (const f of inputs) parts.push((await decodeAudio(f, { channels: 1 })).channels[0]);
  const gap = parts.length > 1 ? Math.round(JOIN_GAP * SR) : 0;
  const x = new Float32Array(parts.reduce((t, q) => t + q.length, 0) + gap * (parts.length - 1));
  const sources = [];
  let pos = 0;
  parts.forEach((q, k) => {
    if (k) pos += gap;
    x.set(q, pos);
    if (parts.length > 1 && q.length > 2 * FADE) {
      for (let i = 0; i < FADE; i++) { const g = i / (FADE - 1); x[pos + i] *= g; x[pos + q.length - 1 - i] *= g; }
    }
    sources.push({ file: fwd(inputs[k]), start: round(pos / SR, 5), seconds: round(q.length / SR, 5) });
    pos += q.length;
  });
  const seconds = x.length / SR;
  if (seconds < 0.5) die(`the recording is only ${round(seconds, 2)} s long`, 1);

  // 1. The stretches the caller wants out, each edge moved to the quietest spot nearby.
  const first = analyse(x);
  const asked = parseCuts(opts.cut, sources);
  const cutReport = [];
  const userCuts = asked.map((c) => {
    const src = sources[c.file - 1];
    const from = c.a <= 0.02 ? src.start : quietest(first.levels, c.from);
    const to = c.b >= src.seconds - 0.02 ? src.start + src.seconds : quietest(first.levels, c.to);
    if (to - from < 0.05) die(`--cut ${c.a}-${c.b}: nothing is left of this range once its edges move to quiet spots`, 2);
    cutReport.push({ ...(sources.length > 1 ? { file: c.file } : {}), asked: [c.a, c.b], used: [round(from - src.start), round(to - src.start)] });
    return [Math.round(from * SR), Math.min(x.length, Math.round(to * SR))];
  });
  let pieces = keepPieces(x.length, userCuts);
  if (!pieces.length) die('--cut removes the whole recording', 2);

  // 2. Every silence shortened.
  let silenceCuts = 0;
  let threshold = null;
  if (tighten) {
    const y = joinPieces(x, pieces);
    const a = analyse(y);
    threshold = a.threshold;
    if (!a.clear) {
      notes.push(`the silences were left as they are: the background is too close to the voice (${Math.round(a.loud - a.floor)} dB apart) to tell pauses from soft words`);
    } else {
      const cuts = tightenCuts(y, { maxGap, shortGap, threshold: a.threshold });
      silenceCuts = cuts.length;
      pieces = throughPieces(pieces, keepPieces(y.length, cuts));
    }
  } else if (footage && opts.tighten === undefined) {
    notes.push('silences were not shortened: in a footage project the sound stays in sync with the picture');
  }
  let voice = joinPieces(x, pieces);
  const editedSeconds = voice.length / SR;
  if (editedSeconds < 0.3) die('nothing is left of the recording after the cuts', 1);
  const loudIn = integratedLoudness([voice]);
  if (!Number.isFinite(loudIn)) die('the recording is silent', 1);

  // 3. The sound, and 4. the loudness.
  let pops = [];
  let final = null;
  await withTempDir(async (dir) => {
    const a = path.join(dir, 'edit.wav'), b = path.join(dir, 'out.wav');
    if (polish) {
      const g = fromDb(WORK_LUFS - loudIn);
      for (let i = 0; i < voice.length; i++) voice[i] *= g;
      const tamed = tamePops(voice);
      pops = tamed.events;
      writeWav(a, [tamed.samples], SR, { bits: 32 });
      await ffmpeg(['-v', 'error', '-nostdin', '-i', a, '-af', CHAIN, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_f32le', b]);
      const done = readWav(b).channels[0];
      // the leveller lands near its target, not on it: one plain gain finishes the job
      const trim = fromDb(TARGET_LUFS - integratedLoudness([done]));
      for (let i = 0; i < done.length; i++) done[i] *= trim;
      writeWav(a, [done], SR, { bits: 32 });
      final = await normalizeLoudness(a, b, { target: TARGET_LUFS, ceiling: CEILING, maxTruePeak: CEILING + 0.5, measured: { I: TARGET_LUFS, TP: samplePeakDb([done]) + 0.5 } });
    } else {
      writeWav(a, [voice], SR, { bits: 32 });
      final = await normalizeLoudness(a, b, { target: TARGET_LUFS, ceiling: CEILING, maxTruePeak: CEILING + 0.5, measured: { I: loudIn, TP: samplePeakDb([voice]) + 0.5 } });
      if (final.limited) notes.push('the loudest peaks were held by a limiter to reach the loudness; nothing else in the sound was changed');
    }
    const shelf = home?.root || path.dirname(outFile);
    const old = shelve(outFile, shelf);
    const mapFile = outFile.replace(/\.[^.\\/]+$/, '') + '.cuts.json';
    shelve(mapFile, shelf);
    if (old) note(`the older ${path.basename(outFile)} moved to ${fwd(old)}`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.copyFileSync(b, outFile);

    // The exact map: what stayed, where it came from and where it sits now. Seconds.
    let at = 0;
    const kept = pieces.map(([s, e]) => { const o = { src: [round(s / SR, 5), round(e / SR, 5)], out: [round(at / SR, 5), round((at + e - s) / SR, 5)] }; at += e - s; return o; });
    const removed = keepPieces(x.length, pieces).map(([s, e]) => [round(s / SR, 5), round(e / SR, 5)]);
    const head = {
      sources, sourceSeconds: round(seconds, 5), seconds: round(editedSeconds, 5),
      tighten: tighten ? { maxGap, shortGap, thresholdDb: threshold === null ? null : round(threshold, 1) } : null,
      cuts: cutReport,
    };
    // one line per piece, so the file reads like a table
    const rows = (list) => (list.length ? `[\n${list.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]` : '[]');
    fs.writeFileSync(mapFile, `{\n${Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')},\n`
      + `  "removed": ${rows(removed)},\n  "kept": ${rows(kept)}\n}\n`, 'utf8');
    final.mapFile = mapFile;
  });

  // What is left: the pauses the gate would still report in the finished file.
  const check = readWav(outFile).channels[0];
  const left = pausesLeft(check);
  if (left.length) notes.push(`${left.length} pause${left.length > 1 ? 's' : ''} over ${LONG_SILENCE} s remain${left.length > 1 ? '' : 's'}; the gate will mention ${left.length > 1 ? 'them' : 'it'}`);
  return {
    out: fwd(outFile), cutMap: fwd(final.mapFile),
    seconds: round(check.length / SR, 2), sourceSeconds: round(seconds, 2), removedSeconds: round(seconds - editedSeconds, 2),
    cuts: cutReport, silencesShortened: silenceCuts, tightened: tighten && silenceCuts > 0, polished: polish,
    popsTamed: pops.length, loudness: final.after.I, truePeak: final.after.TP, pausesLeft: left, notes,
  };
}

// ---------- words ----------
// Moves word times from the recording's timeline onto the prepared voice, through the map prep wrote. A time inside
// a removed stretch moves to the nearest edge that stayed: a word cut out completely is dropped, a word a cut
// touches keeps what is left of it.
export function mapWords(words, map) {
  const kept = (map.kept || []).map((k) => ({ s0: k.src[0], s1: k.src[1], o0: k.out[0], o1: k.out[1] }));
  if (!kept.length) throw new Error('the cut map lists no kept pieces');
  const at = (t, side) => {
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      if (t < k.s0) return side === 'start' ? k.o0 : (i ? kept[i - 1].o1 : 0);
      if (t <= k.s1) return k.o0 + (t - k.s0);
    }
    return kept[kept.length - 1].o1;
  };
  const moved = [], dropped = [];
  for (const w of words) {
    const s = Number(w?.start), e = Number(w?.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) { dropped.push({ text: w?.text ?? '', reason: 'no times' }); continue; }
    const ns = at(s, 'start'), ne = at(Math.max(s, e), 'end');
    if (ne - ns < 0.02) { dropped.push({ text: w.text, start: round(s, 3), end: round(e, 3) }); continue; }
    moved.push({ ...w, start: round(ns, 3), end: round(ne, 3) });
  }
  return { words: moved, dropped };
}

// ---------- word onsets ----------
// Transcript times can be off by a tenth of a second either way. These two functions find where words really start
// in the voice, and move each listed start onto the clearest start nearby.

// Every clear start in a voice: a gap at least 15 dB under the loud speech, then within 60 ms a rise of 12 dB or more
// into real speech. The start is the moment the rise passes a third of the way up. [{ t, depth, rise }]: `depth` is
// how far the gap sits under the speech, `rise` how far the level climbs out of it.
export function findOnsets(voice) {
  const hop = Math.round(0.005 * SR), win = Math.round(0.010 * SR);
  const x = applyFilter(voice, butterworth('high', 2, 100));         // rumble cannot fill a gap
  const n = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const L = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = 0, p = f * hop; i < win; i++, p++) sum += x[p] * x[p];
    L[f] = 10 * Math.log10(sum / win + 1e-12);
  }
  const heard = L.filter((v) => v > -90);
  if (!heard.length) return [];
  const speech = percentile(heard, 95);
  const onsets = [];
  for (let m = 1; m < n - 1; m++) {
    if (L[m] > L[m - 1] || L[m] > L[m + 1] || L[m] > speech - 15) continue;   // a quiet local low
    let peak = -Infinity;
    for (let k = m + 1; k <= Math.min(n - 1, m + 12); k++) if (L[k] > peak) peak = L[k];
    const rise = peak - L[m];
    if (rise < 12 || peak < speech - 14) continue;
    const line = L[m] + rise / 3;
    let k = m + 1;
    while (k < n && L[k] < line) k++;
    const t = round((k * hop + win / 2) / SR, 3);
    const o = { t, depth: round(speech - L[m], 1), rise: round(rise, 1) };
    const last = onsets[onsets.length - 1];
    if (last && t - last.t < 0.03) { if (o.depth + o.rise > last.depth + last.rise) onsets[onsets.length - 1] = o; continue; }
    onsets.push(o);
  }
  return onsets;
}

// Moves word starts onto clear starts in the voice. Each word either keeps its listed time or takes one start within
// `reach` seconds, and the words stay in order, so a word can never take its neighbour's start. A start is worth
// taking when its evidence beats the bar: a deep, quiet gap and a steep rise, less the distance moved (a later start
// costs more than an earlier one, because a picture that lands after its word looks late). Words that run into each
// other with no gap keep their listed time. The choice is made for the whole sentence at once. Returns the words
// (starts moved, the end of the word before trimmed when needed) and the list of moves. A changed word keeps its
// listed times as `listed: [start, end]`, and a later snap starts from those, so snapping twice changes nothing.
export function snapOnsets(words, onsets, { reach = 0.155, bar = 33 } = {}) {
  const n = words.length;
  const options = [];
  let j0 = 0;
  const anchor = words.map((w) => (Array.isArray(w.listed) ? [Number(w.listed[0]), Number(w.listed[1])] : [Number(w.start), Number(w.end)]));
  for (let i = 0; i < n; i++) {
    const [t, e] = anchor[i];
    const list = [{ t, v: 0, snap: false }];
    while (j0 < onsets.length && onsets[j0].t < t - reach) j0++;
    for (let j = j0; j < onsets.length && onsets[j].t <= t + reach; j++) {
      const o = onsets[j], d = o.t - t;
      if (o.t > e - 0.04) continue;
      const v = o.depth + 0.5 * o.rise - (d > 0 ? 35 : 20) * Math.abs(d) - bar;
      if (v <= 0) continue;
      if (Math.abs(d) < 0.005) list[0].v = Math.max(list[0].v, v);   // already on a clear start: staying is worth as much
      else list.push({ t: o.t, v, snap: true });
    }
    options.push(list);
  }
  // Best total for the words so far, ending with each option of the current word.
  const total = [], back = [];
  for (let i = 0; i < n; i++) {
    total.push(options[i].map(() => -Infinity));
    back.push(options[i].map(() => -1));
    options[i].forEach((o, k) => {
      if (i === 0) { total[i][k] = o.v; return; }
      options[i - 1].forEach((p, q) => {
        if (total[i - 1][q] === -Infinity) return;
        if ((p.snap || o.snap) && p.t + 0.03 > o.t) return;     // the words stay in order
        if (total[i - 1][q] + o.v > total[i][k]) { total[i][k] = total[i - 1][q] + o.v; back[i][k] = q; }
      });
    });
  }
  const pick = new Array(n).fill(0);
  if (n) {
    let k = total[n - 1].indexOf(Math.max(...total[n - 1]));
    for (let i = n - 1; i >= 0; i--) { pick[i] = k; k = back[i][k]; }
  }
  const outWords = words.map((w, i) => {
    const { listed, ...rest } = w;
    return { ...rest, start: anchor[i][0], end: anchor[i][1] };
  });
  const moves = [];
  for (let i = 0; i < n; i++) {
    const o = options[i][pick[i]];
    if (!o.snap) continue;
    outWords[i].start = o.t;
    if (i && outWords[i - 1].end > o.t) outWords[i - 1].end = o.t;
    moves.push({ text: words[i].text, from: round(anchor[i][0], 3), to: o.t });
  }
  outWords.forEach((w, i) => { if (w.start !== anchor[i][0] || w.end !== anchor[i][1]) w.listed = [anchor[i][0], anchor[i][1]]; });
  return { words: outWords, moves };
}

// ---------- command line ----------
function usage() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const end = lines.findIndex((l, i) => i > 0 && !l.startsWith('//'));
  return lines.slice(1, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['help', 'tighten', 'polish', 'snap'], aliases: { o: 'out', h: 'help' } });
  if (args.help) { process.stdout.write(usage()); return; }
  const [job, file] = args._;
  if (!job || !file || !['measure', 'prep', 'words'].includes(job) || (job === 'measure' && args._.length !== 2)) {
    process.stderr.write(usage()); process.exit(2);
  }
  const inFile = path.resolve(file);
  const inputs = args._.slice(1).map((f) => path.resolve(f));
  for (const f of inputs) if (!fs.existsSync(f)) die(`not found: ${fwd(f)}`, 2);

  if (job === 'measure') { out(await measure(inFile)); return; }

  if (job === 'words') {
    if (args.out === undefined || args.out === true) die('words needs an output file: -o audio/words.json', 2);
    const snap = Boolean(args.snap);
    const hasMap = args.map !== undefined && args.map !== true;
    if (!hasMap && !snap) die('words needs the cut map of the prepared voice (--map audio/voice.cuts.json), or --snap with --voice', 2);
    const dst = path.resolve(String(args.out));
    const files = args._.slice(1).map((f) => path.resolve(f));
    let map = null;
    if (hasMap) {
      const mapFile = path.resolve(String(args.map));
      if (!fs.existsSync(mapFile)) die(`not found: ${fwd(mapFile)}`, 2);
      if (files.some((f) => f.toLowerCase() === dst.toLowerCase())) die('write the moved words to a new file; the input keeps the times of the recording', 2);
      map = readJson(mapFile);
    } else if (files.length > 1) die('without --map, give one words file: the words of the voice named by --voice', 2);
    let voiceFile = null;
    if (snap) {
      if (args.voice !== undefined && args.voice !== true) voiceFile = path.resolve(String(args.voice));
      else if (hasMap) voiceFile = path.resolve(String(args.map)).replace(/\.cuts\.json$/i, '.wav');
      if (!voiceFile) die('--snap needs the prepared voice: --voice audio/voice.wav', 2);
      if (!fs.existsSync(voiceFile)) die(`the voice to snap to was not found: ${fwd(voiceFile)}. Name it with --voice`, 2);
    }
    const offsets = map ? map.sources?.map((q) => q.start) || [0] : [0];
    if (files.length > 1 && files.length !== offsets.length) die(`the cut map joins ${offsets.length} recording(s): give one words file per recording, in the same order`, 2);
    let raw = null;
    const list = [];
    files.forEach((f, k) => {
      raw = readJson(f);
      const ws = Array.isArray(raw) ? raw : Array.isArray(raw?.words) ? raw.words : die(`no list of words in ${fwd(f)}`, 2);
      for (const w of ws) list.push({ ...w, start: Number(w.start) + offsets[k], end: Number(w.end) + offsets[k] });
    });
    let res = map ? mapWords(list, map) : { words: list, dropped: [] };
    let snapped = null;
    if (snap) {
      const v = await decodeAudio(voiceFile, { channels: 1 });
      const sn = snapOnsets(res.words, findOnsets(v.channels[0]));
      res = { ...res, words: sn.words };
      const shifts = sn.moves.map((m) => Math.abs(m.to - m.from)).sort((x, y) => x - y);
      snapped = {
        voice: fwd(voiceFile), moved: sn.moves.length, kept: sn.words.length - sn.moves.length,
        medianShift: shifts.length ? round(shifts[shifts.length >> 1], 3) : 0, moves: sn.moves,
      };
    }
    const home = projectOf(dst);
    const old = shelve(dst, home?.root || path.dirname(dst));
    if (old) note(`the older ${path.basename(dst)} moved to ${fwd(old)}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    writeJson(dst, Array.isArray(raw) || files.length > 1 ? res.words : { ...raw, words: res.words });
    out({ out: fwd(dst), words: res.words.length, dropped: res.dropped, ...(snapped ? { snap: snapped } : {}) });
    return;
  }

  if (args.out === undefined || args.out === true) die('prep needs an output file: -o audio/voice.wav', 2);
  const outFile = path.resolve(String(args.out));
  if (inputs.some((f) => f.toLowerCase() === outFile.toLowerCase())) die('the output would overwrite a recording', 2);
  if (!/\.wav$/i.test(outFile)) die('the output must be a .wav file', 2);
  const home = projectOf(outFile);
  if (home && !path.relative(path.join(home.root, 'source'), outFile).startsWith('..')) die('the output cannot be written into source/, that folder holds the originals', 2);
  let maxGap;
  if (args['max-gap'] !== undefined) {
    maxGap = Number(args['max-gap']);
    if (args['max-gap'] === true || !(maxGap >= 0.1 && maxGap <= 2)) die('--max-gap needs seconds from 0.1 to 2', 2);
  }
  const res = await prep(inputs, outFile, { cut: args.cut, tighten: args.tighten, polish: args.polish, maxGap });
  note(`voice: ${res.sourceSeconds} s -> ${res.seconds} s, ${res.silencesShortened} silences shortened, ${res.loudness} LUFS`);
  out(res);
}

if (process.argv[1] && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))) {
  main().catch((e) => die(e.message));
}
