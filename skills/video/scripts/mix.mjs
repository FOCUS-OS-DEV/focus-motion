#!/usr/bin/env node
// mix.mjs: builds the sound of a video. Sound effects on their cues, the voice in the centre, music under the
// voice, all mastered to -14 LUFS with true peaks at most -1 dBTP (and at most -0.7 once encoded to AAC, which
// is checked on a test copy). The result is as long as the video.
//
// Usage:
//   node mix.mjs <project> [--voice <file> | --no-voice]
//                          [--music <file> [--music-start 0] [--hit <seconds>] [--music-lufs -24] [--duck 0.7] | --no-music]
//                          [--no-sfx] [--sfx-gain 1.25] [--seams | --no-seams] [-o audio/mix.wav]
//
//   Every part is optional; the mix is made of what exists.
//   Effects   audio/cues.json plus scenes/<id>/cues.json (scene-local seconds): [{ "t": 12.34, "kind": "hit", "gain": 0.8 }]
//             kinds: hit impact whoosh pop tick click key glitch shatter rise ding sparkle sub. Optional "pan": -1..1.
//             --seams adds a soft whoosh on every scene cut that has no whoosh within 0.3 s.
//   Voice     audio/voice.wav when it exists, untouched and in the centre.
//   Music     --music-start is where the track starts playing. --hit moves that start a little so a strong beat
//             lands on that second of the video. --duck is how far the music drops under the voice (0..1).
//   Memory    the music options and --seams are saved in audio/mix.json; a later plain `mix.mjs <project>` repeats
//             them. A flag on the command line always wins. "features" in project.json can switch music or sfx off.
//   FOCUS_MOTION_BEATS=onsets finds the beats with the built-in detector instead of the engine.
//
// Example:
//   node mix.mjs "my video" --music "source/audio/track.mp3" --hit 12.4 --seams
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SKILL_ROOT, parseArgs, out, note, die, fwd, readJson, writeJson, loadProject, ffmpeg, mediaInfo } from './lib/common.mjs';
import {
  SR, readWav, writeWav, withTempDir, decodeAudio, normalizeLoudness, measureLoudness, integratedLoudness, samplePeakDb,
  percentile, movingAverage, butterworth, applyFilter, fromDb,
} from './lib/wav.mjs';

const SFX_DIR = path.join(SKILL_ROOT, 'assets', 'sfx');
const TARGET_LUFS = -14;      // what social platforms play at
const MAX_TRUE_PEAK = -1;     // dBTP on the WAV master; the AAC encode adds about 0.2 to 0.3 dB, and the gate allows -0.5
const CEILING = -1;           // where the limiter holds the peaks (it looks at the true peaks, at 4x the sample rate)
const AAC_MAX = -0.7;         // dBTP of the AAC test copy; the gate fails a cut above -0.5
const SFX_UNDER_VOICE = 0.3;  // effects drop this much while the voice speaks, so words stay on top
const SEAM = { gain: 0.4, clear: 0.3 };
const VOICE_LUFS = -16;       // the level voice.mjs prep delivers; the effects and the music are balanced against it
const MUSIC_FADE_OUT = 1.5;   // seconds
const DEFAULTS = { musicStart: 0, musicLufs: -24, duck: 0.7 };

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// ---------- the effects library ----------
export function loadSfx(dir = SFX_DIR) {
  const meta = readJson(path.join(dir, 'sfx.json'));
  const cache = new Map();
  const file = (name) => {
    if (!cache.has(name)) {
      const w = readWav(path.join(dir, name));
      if (w.sampleRate !== SR) throw new Error(`${name} is ${w.sampleRate} Hz, the effects must be ${SR} Hz`);
      cache.set(name, w.channels);
    }
    return cache.get(name);
  };
  return { gain: Number(meta.gain) || 1, sounds: meta.sounds, file };
}

// ---------- cues ----------
// Reads audio/cues.json and every scenes/<id>/cues.json (scene-local seconds), checks each cue, adds the seam
// whooshes, and returns the cues in time order plus the ones that were left out.
export function collectCues(root, project, sfx, { seams = false } = {}) {
  const scenes = project.scenes || [];
  const duration = scenes.length ? Number(scenes[scenes.length - 1].end) : 0;
  const cues = [], skipped = [];
  const take = (list, where, shift = 0, limit = Infinity) => {
    if (!Array.isArray(list)) { skipped.push({ where, reason: 'the file is not a list of cues' }); return; }
    list.forEach((c, i) => {
      const at = `${where} #${i + 1}`;
      const local = Number(c?.t);
      const gain = c?.gain === undefined ? 0.7 : Number(c.gain);
      const pan = c?.pan === undefined || c?.pan === null ? null : Number(c.pan);
      if (!c || !Number.isFinite(local)) return skipped.push({ where: at, reason: 'no time "t"' });
      if (!sfx.sounds[c.kind]) return skipped.push({ where: at, reason: `unknown kind "${c.kind}"` });
      if (!Number.isFinite(gain) || gain <= 0) return skipped.push({ where: at, reason: 'gain must be a number above 0' });
      if (pan !== null && !Number.isFinite(pan)) return skipped.push({ where: at, reason: 'pan must be a number from -1 to 1' });
      if (local < 0 || local > limit + 0.05) return skipped.push({ where: at, reason: `t ${local} is outside its scene` });
      const t = local + shift;
      if (t > duration) return skipped.push({ where: at, reason: `t ${round(t)} is after the end of the video` });
      cues.push({ t, kind: c.kind, gain: Math.min(gain, 2), pan: pan === null ? null : Math.max(-1, Math.min(1, pan)), where: at });
    });
  };
  const main = path.join(root, 'audio', 'cues.json');
  if (fs.existsSync(main)) take(readJson(main), 'audio/cues.json');
  for (const sc of scenes) {
    const f = path.join(root, 'scenes', String(sc.id), 'cues.json');
    if (fs.existsSync(f)) take(readJson(f), `scenes/${sc.id}/cues.json`, Number(sc.start) || 0, Number(sc.end) - Number(sc.start));
  }
  let seamCount = 0;
  if (seams) {
    for (const sc of scenes.slice(1)) {
      const t = Number(sc.start);
      if (cues.some((c) => c.kind === 'whoosh' && Math.abs(c.t - t) < SEAM.clear)) continue;
      cues.push({ t, kind: 'whoosh', gain: SEAM.gain, pan: null, where: `seam ${sc.id}`, seam: true });
      seamCount++;
    }
  }
  cues.sort((a, b) => a.t - b.t);   // stable: equal times keep their order
  return { cues, skipped, seamCount, duration };
}

// ---------- the effects bed ----------
// Sums every cue into a stereo bed, in the order given. The stereo field: sweeps cross the field and alternate
// direction, small sounds alternate right and left, the big hits stay in the centre.
export function buildBed(cues, frames, sfx, gain = sfx.gain) {
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const used = {};
  for (const cue of cues) {
    const s = sfx.sounds[cue.kind];
    if (!s) continue;
    const turn = (used[cue.kind] = (used[cue.kind] || 0) + 1);
    const side = turn % 2 ? 1 : -1;
    const g = cue.gain * s.level * gain;
    let src = sfx.file(s.file);
    let gl = g, gr = g, swap = false, mid = false;
    if (s.field === 'sweep') {
      // The file moves towards s.to. A pan on the cue picks the direction; otherwise every second use is mirrored.
      const mirrored = cue.pan === null || cue.pan === 0 ? side < 0 : (cue.pan > 0 ? 'right' : 'left') !== s.to;
      if (mirrored && s.mirror) src = sfx.file(s.mirror); else swap = mirrored;
    } else if (s.field === 'side' || cue.pan !== null) {
      const p = cue.pan !== null ? cue.pan : (s.pan || 0) * side;
      gl = g * Math.sqrt(1 - p); gr = g * Math.sqrt(1 + p);   // equal power, unity in the middle
      mid = src.length > 1;                                    // a wide centre sound is placed by its mono sum
    }
    const a = src[0], b = src.length > 1 ? src[1] : src[0];
    let at = Math.trunc((cue.t - (s.preroll || 0)) * SR), from = 0;
    if (at < 0) { from = -at; at = 0; }
    const count = Math.min(a.length - from, frames - at);
    for (let i = 0; i < count; i++) {
      let l = a[from + i], r = b[from + i];
      if (mid) l = r = (l + r) / 2;
      if (swap) { const k = l; l = r; r = k; }
      L[at + i] += l * gl; R[at + i] += r * gr;
    }
  }
  return [L, R];
}

// Stacked hits can pass full scale on their own. Their tips are rounded here (both channels by the same amount),
// so the master limiter, which turns the whole mix down with the voice in it, has less to do on the big moments.
export function roundPeaks(L, R, knee = 0.8) {
  const room = 1 - knee;
  let touched = 0;
  for (let i = 0; i < L.length; i++) {
    const l = L[i] < 0 ? -L[i] : L[i], r = R[i] < 0 ? -R[i] : R[i];
    const a = l > r ? l : r;
    if (a <= knee) continue;
    const k = (knee + room * Math.tanh((a - knee) / room)) / a;
    L[i] *= k; R[i] *= k; touched++;
  }
  return touched;
}

// ---------- the voice ----------
// How present the voice is at each sample, 0..1: a 120 ms average of its level, scaled by its own loud passages.
export function voiceEnvelope(voice, frames) {
  const abs = new Float32Array(frames);
  const m = Math.min(frames, voice.length);
  for (let i = 0; i < m; i++) abs[i] = voice[i] < 0 ? -voice[i] : voice[i];
  const env = movingAverage(abs, Math.round(0.12 * SR));
  const top = percentile(env, 98, Math.max(1, Math.floor(frames / 2e6))) + 1e-9;
  for (let i = 0; i < frames; i++) { const v = env[i] / top; env[i] = v > 1 ? 1 : v; }
  return env;
}

// Puts the voice on the bed as it is: a mono voice goes to both sides, a stereo voice keeps its width. The effects
// drop a little while the voice speaks. Returns the voice's envelope for the music.
export function addVoice(L, R, voice) {
  const frames = L.length;
  const vl = voice[0], vr = voice[voice.length > 1 ? 1 : 0];
  const env = voiceEnvelope(vl, frames);
  for (let i = 0; i < frames; i++) { const k = 1 - SFX_UNDER_VOICE * env[i]; L[i] *= k; R[i] *= k; }
  const m = Math.min(frames, vl.length);
  for (let i = 0; i < m; i++) { L[i] += vl[i]; R[i] += vr[i]; }
  return env;
}

// Adds the music: brought to its loudness with one gain, faded in over 0.4 s and out over 1.5 s, and pulled down
// under the voice by `duck` (0..1). The duck follows a smoothed envelope, so the music breathes instead of pumping.
// `end` is the sample where the music stops (the end of the video, or earlier when the track runs out there).
export function addMusic(L, R, music, { lufs = DEFAULTS.musicLufs, duck = DEFAULTS.duck, env = null, end = L.length } = {}) {
  const loud = integratedLoudness(music);
  if (!Number.isFinite(loud)) return { gainDb: null, measured: loud };
  const g = fromDb(lufs - loud);
  const slow = env ? movingAverage(env, Math.round(0.35 * SR)) : null;
  const fadeIn = 0.4 * SR, fadeOut = MUSIC_FADE_OUT * SR;
  for (let i = 0; i < end; i++) {
    let k = g * Math.min(1, i / fadeIn) * Math.max(0, Math.min(1, (end - i) / fadeOut));
    if (slow) k *= 1 - duck * Math.min(1, slow[i] * 1.6);
    L[i] += music[0][i] * k; R[i] += music[1][i] * k;
  }
  return { gainDb: round(lufs - loud, 1), measured: round(loud, 1) };
}

// ---------- music ----------

// Bass onsets (kicks, bass notes): [{ time, strength 0..1 }]. The fallback when the engine cannot run.
export function bassOnsets(samples, sampleRate) {
  const low = applyFilter(samples, butterworth('low', 4, 150, sampleRate));
  const hop = Math.round(0.005 * sampleRate);
  const count = Math.floor(low.length / hop);
  const energy = new Float64Array(count);
  for (let f = 0, p = 0; f < count; f++) {
    let sum = 0;
    for (let i = 0; i < hop; i++, p++) sum += low[p] * low[p];
    energy[f] = sum / hop;
  }
  // The level over the last 20 ms (long enough for the slow swing of a bass note), and its rise over 10 ms.
  const level = new Float64Array(count), flux = new Float64Array(count);
  for (let f = 3; f < count; f++) level[f] = Math.sqrt((energy[f] + energy[f - 1] + energy[f - 2] + energy[f - 3]) / 4);
  for (let f = 5; f < count; f++) flux[f] = Math.max(0, level[f] - level[f - 2]);
  const top = percentile(flux, 99.5);
  if (!(top > 1e-5)) return [];
  // An onset is the moment the rise passes the threshold; its strength is the largest rise in the next 120 ms.
  const on = 0.3 * top, off = 0.15 * top, hold = Math.round(0.12 * sampleRate / hop);
  const found = [];
  let armed = true;
  for (let f = 5; f < count; f++) {
    if (!armed) { if (flux[f] < off) armed = true; continue; }
    if (flux[f] < on) continue;
    let v = 0;
    for (let k = f; k < Math.min(count, f + hold); k++) if (flux[k] > v) v = flux[k];
    found.push({ time: round(Math.max(0, f - 1) * hop / sampleRate), strength: round(Math.min(1, v / top)) });
    armed = false;
    f += hold - 1;
  }
  return found;
}

// The engine's beat list for a music file, or null when the engine cannot run or finds nothing.
async function engineBeats(file) {
  try {
    const { engineJson } = await import('./lib/engine.mjs');
    return await withTempDir(async (dir) => {
      await ffmpeg(['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', path.join(dir, 'music.wav')]);
      const seconds = Math.max(1, Math.ceil(fs.statSync(path.join(dir, 'music.wav')).size / (44100 * 2)));
      // The engine reads the music of a composition, so the track gets a minimal one around it.
      fs.writeFileSync(path.join(dir, 'index.html'), [
        '<!doctype html>', '<html><head><meta charset="utf-8"></head><body>',
        `<div id="root" data-composition-id="main" data-start="0" data-duration="${seconds}" data-width="1080" data-height="1080">`,
        `<audio id="music" src="music.wav" data-start="0" data-duration="${seconds}" data-volume="1"></audio>`,
        '</div>', '</body></html>', '',
      ].join('\n'));
      const r = await engineJson(['beats', dir, '--json'], { timeoutMs: 180000 });
      const list = readJson(path.join(dir, r.json?.file || 'beats/music.wav.json'), null);
      const beats = (list?.beats || []).filter((b) => Number.isFinite(b?.time)).map((b) => ({ time: b.time, strength: Number(b.strength) || 0 }));
      if (beats.length < 4) { note('the engine found no beats in the music; using the built-in detector'); return null; }
      return { bpm: r.json?.bpm ?? null, beats };
    });
  } catch (e) {
    note(`the engine's beat detection did not run (${String(e.message).split('\n')[0]}); using the built-in detector`);
    return null;
  }
}

// The beats of a music file. The engine gives the beat grid and how strong each beat is; the built-in detector
// gives the moments the bass really hits. An engine beat that sits on a real hit moves onto it exactly, one that
// does not is marked down (a grid can run through places where nothing plays). Without the engine the bass hits
// are the beats. The answer is kept in work/beats, so the next mix does not analyse the same file again.
async function findBeats(file, root) {
  const st = fs.statSync(file);
  const mode = (process.env.FOCUS_MOTION_BEATS || '').toLowerCase() === 'onsets' ? 'onsets' : 'engine';
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 12);
  const cacheFile = (m) => path.join(root, 'work', 'beats', `${key}-${m}.json`);
  const cached = readJson(cacheFile(mode), null);
  if (cached?.beats?.length) return cached;
  const rate = 12000;
  const onsets = bassOnsets((await decodeAudio(file, { sampleRate: rate, channels: 1 })).channels[0], rate);
  const eng = mode === 'engine' ? await engineBeats(file) : null;
  let result;
  if (eng) {
    let k = 0;
    const beats = eng.beats.map((b) => {
      while (k < onsets.length - 1 && Math.abs(onsets[k + 1].time - b.time) <= Math.abs(onsets[k].time - b.time)) k++;
      const hit = onsets.length && Math.abs(onsets[k].time - b.time) <= 0.04;
      return hit ? { time: onsets[k].time, strength: b.strength, onHit: true } : { time: b.time, strength: round(b.strength * 0.6), onHit: false };
    });
    result = { source: 'engine', bpm: eng.bpm, beats };
  } else {
    result = { source: 'onsets', bpm: null, beats: onsets };
  }
  if (result.beats.length) writeJson(cacheFile(result.source), { file: fwd(file), ...result });
  return result;
}

// Picks the strongest beat near the moment the track would reach at `hit`, and the start that puts it exactly there.
export function alignToHit(beats, start, hit) {
  if (beats.length < 2) return null;
  const gaps = beats.slice(1).map((b, i) => b.time - beats[i].time).sort((a, b) => a - b);
  const beat = Math.min(1.2, Math.max(0.25, gaps[gaps.length >> 1]));
  const target = start + hit;
  const reach = 2 * beat;
  const near = beats.filter((b) => b.time >= hit && Math.abs(b.time - target) <= reach + 1e-6);
  if (!near.length) return null;
  // The strongest wins; a beat at the edge of the reach has to be clearly stronger than one right on the spot.
  const score = (b) => b.strength - 0.15 * Math.abs(b.time - target) / reach;
  const best = near.reduce((p, b) => (score(b) > score(p) ? b : p));
  return { start: round(best.time - hit, 4), beat: best.time, strength: best.strength, moved: round(best.time - hit - start) };
}

// The stretch of music the video needs: from `start`, and from the top of the track again if the track ends early.
async function musicBed(file, start, frames, dir) {
  const first = await decodeAudio(file, { channels: 2, start, duration: frames / SR + 0.05, dir });
  const have = first.channels[0].length;
  if (!have) throw new Error(`--music-start ${start} is past the end of the music (${round(first.source.duration, 2)} s)`);
  if (have >= frames) return { channels: first.channels.map((c) => c.subarray(0, frames)), loops: [], end: frames };
  const outCh = [new Float32Array(frames), new Float32Array(frames)];
  if (frames - have <= MUSIC_FADE_OUT * SR) {
    // The track runs out inside the closing fade: it simply ends a moment early, nothing starts again.
    outCh.forEach((o, c) => o.set(first.channels[c]));
    return { channels: outCh, loops: [], end: have };
  }
  const top = start > 0 ? (await decodeAudio(file, { channels: 2, duration: (frames - have) / SR + 0.05, dir })).channels : first.channels;
  const loops = [];
  const fade = Math.round(0.03 * SR);
  let at = 0, src = first.channels;
  while (at < frames) {
    const len = Math.min(src[0].length, frames - at);
    if (len <= 0) break;
    for (let c = 0; c < 2; c++) {
      const piece = src[c];
      for (let i = 0; i < len; i++) {
        // 30 ms fades on both sides of a join, so the loop point does not click
        const fin = at > 0 ? Math.min(1, i / fade) : 1;
        const fout = at + len < frames ? Math.min(1, (len - 1 - i) / fade) : 1;
        outCh[c][at + i] = piece[i] * fin * fout;
      }
    }
    at += len;
    if (at < frames) loops.push(round(at / SR, 2));
    src = top;
  }
  return { channels: outCh, loops, end: frames };
}

// ---------- settings ----------
const inside = (root, p) => { const rel = path.relative(root, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
// A relative path is looked for in the project first, then in the current folder.
function resolveIn(root, p) {
  if (path.isAbsolute(p)) return p;
  const a = path.resolve(root, p);
  if (fs.existsSync(a)) return a;
  const b = path.resolve(p);
  return fs.existsSync(b) ? b : a;
}
const portable = (root, p) => (inside(root, p) ? fwd(path.relative(root, p)) : fwd(p));
const numberArg = (v, name, { min = -Infinity, max = Infinity } = {}) => {
  const x = Number(v);
  if (v === true || v === '' || !Number.isFinite(x) || x < min || x > max) die(`${name} needs a number${Number.isFinite(min) ? ` from ${min}` : ''}${Number.isFinite(max) ? ` to ${max}` : ''}`, 2);
  return x;
};

function usage() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const end = lines.findIndex((l, i) => i > 0 && !l.startsWith('//'));
  return lines.slice(1, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ['help', 'sfx', 'seams', 'no-voice', 'no-music'], aliases: { o: 'out', h: 'help' },
  });
  if (args.help) { process.stdout.write(usage()); return; }
  if (args._.length !== 1) { process.stderr.write(usage()); process.exit(2); }

  const { root, project } = loadProject(args._[0]);
  const features = project.features && typeof project.features === 'object' ? project.features : {};
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const duration = scenes.length ? Number(scenes[scenes.length - 1].end) : NaN;
  if (!(duration > 0)) die('project.json has no scenes yet, so the length of the video is unknown. Set the scenes first: project.mjs set-scenes', 2);
  const frames = Math.round(duration * SR);
  const memoryFile = path.join(root, 'audio', 'mix.json');
  const saved = readJson(memoryFile, {}) || {};
  const notes = [];

  // What goes in. A flag wins, then "features" in project.json, then the last run, then the default.
  const useSfx = args.sfx !== undefined ? args.sfx : features.sfx !== false;
  const seams = args.seams !== undefined ? args.seams : Boolean(saved.seams);
  const sfxGainArg = args['sfx-gain'] !== undefined ? numberArg(args['sfx-gain'], '--sfx-gain', { min: 0, max: 4 }) : null;

  let voiceFile = null;
  if (args['no-voice']) voiceFile = null;
  else if (args.voice !== undefined) {
    if (args.voice === true) die('--voice needs a file', 2);
    voiceFile = resolveIn(root, String(args.voice));
    if (!fs.existsSync(voiceFile)) die(`voice not found: ${fwd(voiceFile)}`, 2);
  } else if (fs.existsSync(path.join(root, 'audio', 'voice.wav'))) voiceFile = path.join(root, 'audio', 'voice.wav');

  let music = null;
  if (args['no-music']) music = null;
  else if (args.music !== undefined) {
    if (args.music === true) die('--music needs a file', 2);
    music = { file: resolveIn(root, String(args.music)) };
    // The same track as last time keeps its start, hit and levels unless a flag changes them.
    music.remembered = Boolean(saved.music?.file) && path.resolve(resolveIn(root, saved.music.file)).toLowerCase() === path.resolve(music.file).toLowerCase();
    if (features.music === false) notes.push('project.json says features.music is false, but --music was given, so the music is in');
  } else if (features.music !== false && saved.music?.file) {
    music = { ...saved.music, file: resolveIn(root, saved.music.file), remembered: true };
    if (!fs.existsSync(music.file)) { notes.push(`the music of the last mix is gone (${fwd(music.file)}); mixing without music`); music = null; }
  }
  if (music) {
    if (!fs.existsSync(music.file)) die(`music not found: ${fwd(music.file)}`, 2);
    const pick = (flag, key, range) => (args[flag] !== undefined ? numberArg(args[flag], `--${flag}`, range)
      : music.remembered && saved.music[key] !== undefined && saved.music[key] !== null ? Number(saved.music[key]) : DEFAULTS[key] ?? null);
    music.musicStart = pick('music-start', 'musicStart', { min: 0 });
    music.musicLufs = pick('music-lufs', 'musicLufs', { min: -60, max: -5 });
    music.duck = pick('duck', 'duck', { min: 0, max: 1 });
    music.hit = pick('hit', 'hit', { min: 0, max: duration });
    const info = await mediaInfo(music.file).catch(() => null);
    if (!info?.hasAudio) die(`no sound found in the music file ${fwd(music.file)}`, 2);
    if (music.musicStart >= info.duration - 0.5) die(`--music-start ${music.musicStart} is past the end of the music (${Math.round(info.duration * 100) / 100} s)`, 2);
  } else {
    for (const f of ['music-start', 'music-lufs', 'duck', 'hit']) if (args[f] !== undefined) notes.push(`--${f} has no effect without music`);
  }

  const outFile = path.resolve(root, args.out === undefined || args.out === true ? path.join('audio', 'mix.wav') : String(args.out));
  const inputs = [voiceFile, music?.file].filter(Boolean).map((f) => path.resolve(f).toLowerCase());
  if (inputs.includes(outFile.toLowerCase())) die('the output would overwrite one of the inputs', 2);
  if (inside(path.join(root, 'source'), outFile)) die('the output cannot be written into source/, that folder holds the originals', 2);

  // The effects.
  let bed = [new Float32Array(frames), new Float32Array(frames)];
  let cueInfo = { cues: [], skipped: [], seamCount: 0 };
  let sfxGain = null;
  if (useSfx) {
    const sfx = loadSfx();
    sfxGain = sfxGainArg ?? (Number(saved.sfxGain) > 0 ? Number(saved.sfxGain) : sfx.gain);
    cueInfo = collectCues(root, project, sfx, { seams });
    bed = buildBed(cueInfo.cues, frames, sfx, sfxGain);
    roundPeaks(bed[0], bed[1]);
    note(`effects: ${cueInfo.cues.length} cues${cueInfo.seamCount ? ` (${cueInfo.seamCount} seam whooshes)` : ''}${cueInfo.skipped.length ? `, ${cueInfo.skipped.length} left out` : ''}`);
  }
  if (!cueInfo.cues.length && !voiceFile && !music) {
    die('nothing to mix: no cues, no voice and no music. Add cues to audio/cues.json or scenes/<id>/cues.json, or assemble with --no-audio', 1);
  }

  const result = await withTempDir(async (dir) => {
    const report = { voice: null, music: null };
    const [L, R] = bed;
    let env = null;

    if (voiceFile) {
      const v = await decodeAudio(voiceFile, { dir });
      // The balance is set against a voice at -16 LUFS. A voice far from that gets one plain gain, nothing else.
      const level = integratedLoudness(v.channels);
      if (!Number.isFinite(level)) notes.push('the voice file is silent');
      else if (Math.abs(level - VOICE_LUFS) > 1) {
        const g = fromDb(VOICE_LUFS - level);
        for (const c of v.channels) for (let i = 0; i < c.length; i++) c[i] *= g;
        notes.push(`the voice was at ${round(level, 1)} LUFS and was moved to ${VOICE_LUFS} with a plain gain. Prepare it with voice.mjs prep for a clean result`);
      }
      env = addVoice(L, R, v.channels);
      const seconds = v.channels[0].length / SR;
      report.voice = { file: portable(root, voiceFile), seconds: round(seconds, 2), lufs: Number.isFinite(level) ? round(level, 1) : null };
      if (seconds > duration + 0.05) notes.push(`the voice is ${round(seconds - duration, 2)} s longer than the video, so its end is cut. Make the last scene longer`);
      note(`voice: ${round(seconds, 2)} s`);
    }

    if (music) {
      let start = music.musicStart;
      let hitInfo = null;
      if (music.hit !== null) {
        const found = await findBeats(music.file, root);
        const fit = alignToHit(found.beats, start, music.hit);
        if (fit) {
          start = fit.start;
          hitInfo = { second: music.hit, beat: fit.beat, strength: fit.strength, moved: fit.moved, by: found.source, bpm: found.bpm };
          note(`music: the beat at ${fit.beat} s of the track lands on ${music.hit} s (start moved by ${fit.moved} s, beats by ${found.source})`);
        } else {
          hitInfo = { second: music.hit, beat: null, by: found.source };
          notes.push('no clear beat was found near --hit, so the music start was not moved');
        }
      }
      const mu = await musicBed(music.file, start, frames, dir);
      const added = addMusic(L, R, mu.channels, { lufs: music.musicLufs, duck: music.duck, env, end: mu.end });
      if (added.gainDb === null) notes.push('the music is silent in this stretch, so there is none in the mix');
      if (mu.loops.length) notes.push(`the music is shorter than the video and starts again at ${mu.loops.join(', ')} s`);
      report.music = {
        file: portable(root, music.file), start: round(start, 3), lufs: music.musicLufs, gainDb: added.gainDb,
        duck: env ? music.duck : 0, hit: hitInfo, loops: mu.loops,
      };
      note(`music: from ${round(start, 3)} s at ${music.musicLufs} LUFS${env ? `, ducked ${music.duck} under the voice` : ', not ducked (no voice)'}`);
    }

    // Master: one gain to the target, and a limiter only when the peaks need it.
    const I = integratedLoudness([L, R]);
    if (!Number.isFinite(I)) die('the mix is silent: every cue fell outside the video or the inputs are empty', 1);
    const pre = path.join(dir, 'premaster.wav');
    writeWav(pre, [L, R], SR, { bits: 32 });
    const tmpOut = path.join(dir, 'master.wav');
    const measured = { I, TP: samplePeakDb([L, R]) + 0.5 };
    let ceiling = CEILING;
    let m = await normalizeLoudness(pre, tmpOut, { target: TARGET_LUFS, ceiling, maxTruePeak: MAX_TRUE_PEAK, measured });
    // The cut carries AAC, which raises the peaks a little: 0.1 dB on a voice, up to about 0.9 dB on dense music.
    // A test copy is encoded the way assemble.mjs encodes the cut and measured. When it reads above AAC_MAX, the
    // ceiling comes down by the difference and the master is made again; the loudness stays where it is.
    const aac = path.join(dir, 'check.m4a');
    const encodedPeak = async () => {
      await ffmpeg(['-v', 'error', '-nostdin', '-i', tmpOut, '-c:a', 'aac', '-b:a', '256k', '-ar', String(SR), aac]);
      return (await measureLoudness(aac)).TP;
    };
    let encoded = await encodedPeak();
    for (let k = 0; k < 3 && encoded > AAC_MAX; k++) {
      ceiling -= encoded - AAC_MAX + 0.05;
      m = await normalizeLoudness(pre, tmpOut, { target: TARGET_LUFS, ceiling, maxTruePeak: ceiling, measured });
      encoded = await encodedPeak();
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.copyFileSync(tmpOut, outFile);
    return { ...report, master: { ...m, ceiling: Math.round(ceiling * 100) / 100, encodedPeak: encoded } };
  });

  // Remember the options, so a plain `mix.mjs <project>` repeats this mix.
  const memory = { seams, sfxGain: sfxGainArg ?? (Number(saved.sfxGain) > 0 ? Number(saved.sfxGain) : undefined) };
  if (music) memory.music = { file: portable(root, music.file), musicStart: music.musicStart, hit: music.hit, musicLufs: music.musicLufs, duck: music.duck };
  else if (!args['no-music'] && saved.music) memory.music = saved.music;   // switched off by features: kept for later
  writeJson(memoryFile, memory);

  const { after } = result.master;
  const kinds = {};
  for (const c of cueInfo.cues) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  const enc = result.master.encodedPeak;
  const ok = Math.abs(after.I - TARGET_LUFS) <= 1 && after.TP <= MAX_TRUE_PEAK && enc <= AAC_MAX + 0.2;
  if (!ok) notes.push(`the master missed its target: ${after.I} LUFS, ${after.TP} dBTP (${enc} dBTP after AAC)`);
  out({
    ok,
    out: fwd(outFile),
    seconds: round(frames / SR, 3),
    sfx: useSfx ? { cues: cueInfo.cues.length, seams: cueInfo.seamCount, gain: sfxGain, kinds, skipped: cueInfo.skipped } : null,
    voice: result.voice,
    music: result.music,
    loudness: { lufs: after.I, truePeak: after.TP, truePeakAac: enc, range: after.LRA },
    master: { gainDb: result.master.gainDb, limited: result.master.limited, ceiling: result.master.ceiling, passes: result.master.passes },
    notes,
  });
  if (!ok) process.exit(1);
}

if (process.argv[1] && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))) {
  main().catch((e) => die(e.message));
}
