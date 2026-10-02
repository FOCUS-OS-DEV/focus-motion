#!/usr/bin/env node
// footage.mjs: the user's own clips, from the raw file to a scene with captions and graphics laid over it.
//
// Usage:
//   node footage.mjs probe <file> [--fps 30]                       facts about a clip or photo, and whether it needs normalizing
//   node footage.mjs normalize <file> [-o work/norm/<name>.mp4] [--fps 30] [--max-side 1920]
//                                                                  rotation applied, HDR to SDR, constant frame rate, 48 kHz audio
//   node footage.mjs normalize-all <project> [--force] [--max-side 1920]
//                                                                  every video of source/media.json that needs it, into work/norm/
//   node footage.mjs still <file> [--at 1.5] [-o frame.jpg] [--width 540]
//                                                                  one frame in true colours (also turns a photo into a JPEG)
//   node footage.mjs edl <project> <file> [--words file.json] [--pause 0.5] [--pad 0.12] [--id s01] [--split]
//                                                                  proposes edl.json from a transcript: speech stays, pauses go
//   node footage.mjs cut <project> [--whole <file>] [--set-scenes] [--dry-run]
//                                                                  edl.json -> work/base/<id>.mp4, work/voice-raw.wav, work/audio-raw.wav,
//                                                                  audio/words.json on the new timeline, work/scenes.json
//   node footage.mjs captions <project> <id> [--position bottom|middle|top] [--mode highlight|reveal]
//                             [--max-words 6] [--max-chars 18] [--lines 2] [--words audio/words.json] [--rewire]
//                                                                  word-synced captions into scenes/<id> (creates the scene if missing)
//   node footage.mjs overlay <project> <id> [--draft] [--crf 16] [--workers n] [--subject cutout.webm] [--keep]
//                                                                  renders scenes/<id> transparent and lays it over the base clip
//                                                                  -> renders/<id>.mp4 (video only)
//   node footage.mjs mux <video> --audio <file> -o <out.mp4>       joins a silent video with a sound file
//   node footage.mjs matte <file> -o subject.webm [--quality fast|balanced|best] [--device auto|cpu|cuda|coreml]
//                                                                  cuts the person out of a clip (transparent background)
//
// Example:
//   node footage.mjs normalize "my video/source/video/talk.mov"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  SKILL_ROOT, parseArgs, out, note, fwd, readJson, writeJson, ffmpeg, mediaInfo, loadProject, saveProject, toFrames, run,
} from './lib/common.mjs';
import { engine } from './lib/engine.mjs';
import { removeTree } from './lib/cli.mjs';
import {
  fail, usage, tool, runBinary, findProjectRoot, archiveExisting, safeName, fpsArg, TAG_709, x264,
  probeFootage, normalizeFootage, colourFilters, readWords, wordsText,
} from './lib/media.mjs';

const args = parseArgs(process.argv.slice(2), {
  booleans: ['help', 'force', 'set-scenes', 'dry-run', 'draft', 'keep', 'rewire', 'lut', 'split'],
  aliases: { o: 'out', h: 'help' },
});
const [job, ...rest] = args._;
if (args.help || !job) usage(import.meta.url, args.help ? 0 : 2);

const num = (v, d) => (v === undefined || v === true || v === '' ? d : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|mpg|mpeg|wmv|3gp|ts)$/i;

// A path given on the command line or inside a project file: as written, or relative to the project folder.
function locate(p, root) {
  if (!p || p === true) return null;
  const a = path.resolve(String(p));
  if (fs.existsSync(a)) return a;
  if (root) { const b = path.resolve(root, String(p)); if (fs.existsSync(b)) return b; }
  return null;
}
const rel = (root, p) => fwd(path.relative(root, p));
const needFile = (p, root, what = 'file') => locate(p, root) || fail(`${what} not found: ${p === true || !p ? '(missing)' : fwd(String(p))}`, 2);


// ---------------------------------------------------------------------------------------------------- probe
async function probe() {
  const file = needFile(rest[0]);
  const root = findProjectRoot(file);
  const fps = num(args.fps, root ? readJson(path.join(root, 'project.json')).fps || 30 : 30);
  out({ ok: true, ...(await probeFootage(file, { fps })), targetFps: fps });
}

// ---------------------------------------------------------------------------------------------------- normalize
async function normalize() {
  const file = needFile(rest[0]);
  const root = findProjectRoot(file) || (args.out && args.out !== true ? findProjectRoot(path.resolve(args.out)) : null);
  const fps = num(args.fps, root ? readJson(path.join(root, 'project.json')).fps || 30 : 30);
  const name = safeName(path.basename(file, path.extname(file)));
  const dst = args.out && args.out !== true ? path.resolve(args.out)
    : root ? path.join(root, 'work', 'norm', `${name}.mp4`) : path.join(path.dirname(file), `${name}-norm.mp4`);
  if (path.resolve(dst) === file) fail('the output would overwrite the source. Choose another name with -o.', 2);
  note(`normalizing ${fwd(file)}`);
  const res = await normalizeFootage(file, dst, { fps, maxSide: num(args['max-side'], 0), forceLut: Boolean(args.lut) });
  out({ ok: true, ...res, source: fwd(file) });
}

// The videos of the project: the entries of type "video" in source/media.json, else the files in source/video/.
function listedVideos(root) {
  const file = path.join(root, 'source', 'media.json');
  const found = [];
  const add = (p) => {
    const full = path.resolve(root, p);
    if (VIDEO_EXT.test(full) && fs.existsSync(full) && fs.statSync(full).isFile() && !found.includes(full)) found.push(full);
  };
  if (fs.existsSync(file)) {
    const media = readJson(file);
    for (const m of Array.isArray(media) ? media : media.files || []) if (m && m.type === 'video' && m.file && !m.unreadable) add(m.file);
  } else {
    const dir = path.join(root, 'source', 'video');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) add(path.join('source', 'video', f));
  }
  return { files: found, inventory: fs.existsSync(file) };
}

async function normalizeAll() {
  const { root, project } = loadProject(rest[0]);
  const fps = project.fps || 30, maxSide = num(args['max-side'], 0);
  const { files, inventory } = listedVideos(root);
  const normDir = path.join(root, 'work', 'norm');
  const indexFile = path.join(normDir, 'index.json');
  const index = readJson(indexFile, {});
  const results = [];
  const taken = new Set(Object.keys(index));
  for (const src of files) {
    const st = fs.statSync(src), source = rel(root, src);
    let p;
    try { p = await probeFootage(src, { fps }); }
    catch (e) { results.push({ source, status: 'failed', error: e.message }); continue; }
    if (p.kind !== 'video') { results.push({ source, status: 'not a video' }); continue; }
    if (!p.needsNormalize) { results.push({ source, status: 'no need', use: source, duration: r3(p.duration) }); continue; }
    let name = Object.keys(index).find((k) => index[k].source === source);
    if (!name) {
      const stem = safeName(path.basename(src, path.extname(src)));
      name = `${stem}.mp4`;
      for (let i = 2; taken.has(name); i++) name = `${stem}-${i}.mp4`;
      taken.add(name);
    }
    const dst = path.join(normDir, name), was = index[name];
    const same = was && was.size === st.size && was.mtimeMs === Math.round(st.mtimeMs) && was.fps === fps && (was.maxSide || 0) === maxSide;
    if (same && fs.existsSync(dst) && !args.force) {
      results.push({ source, status: 'up to date', use: rel(root, dst), duration: was.duration });
      continue;
    }
    note(`normalizing ${source} (${p.reasons.join('; ')})`);
    try {
      const res = await normalizeFootage(src, dst, { fps, maxSide, forceLut: Boolean(args.lut) });
      index[name] = { source, size: st.size, mtimeMs: Math.round(st.mtimeMs), fps, maxSide, duration: res.duration };
      writeJson(indexFile, index);
      results.push({ source, status: 'normalized', use: rel(root, dst), fixed: p.reasons, method: res.method, duration: res.duration, seconds: res.seconds });
    } catch (e) {
      results.push({ source, status: 'failed', error: e.message.split('\n').slice(-3).join(' | ') });
    }
  }
  const failed = results.filter((r) => r.status === 'failed').length;
  out({ ok: failed === 0, project: fwd(root), inventory: inventory ? 'source/media.json' : 'source/video (no media.json)', videos: results.length,
    normalized: results.filter((r) => r.status === 'normalized').length, failed, files: results });
  if (failed) process.exit(1);
}

// ---------------------------------------------------------------------------------------------------- still
async function still() {
  const file = needFile(rest[0]);
  const p = await probeFootage(file);
  if (p.kind === 'audio') fail('this file has no picture', 2);
  const at = p.kind === 'photo' ? 0 : Math.min(Math.max(num(args.at, 0), 0), Math.max(0, p.duration - 1 / Math.max(p.fps, 1)));
  const dst = path.resolve(args.out && args.out !== true ? args.out
    : `${file.replace(/\.[^.]+$/, '')}${p.kind === 'photo' ? '' : `-${at.toFixed(2)}s`}.jpg`);
  if (dst === file) fail('the output would overwrite the source. Choose another name with -o.', 2);
  const width = num(args.width, 0);
  const size = width > 0 && width < p.displayWidth ? { w: even(width), h: even((p.displayHeight * width) / p.displayWidth) } : null;
  const colour = await colourFilters(p, { size, target: 'rgb', forceLut: Boolean(args.lut) });
  let cwd;
  if (colour.cube) { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-lut-')); fs.writeFileSync(path.join(cwd, 'fm-hdr.cube'), colour.cube); }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    await ffmpeg([...(at > 0 ? ['-ss', String(at)] : []), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', colour.filters.join(','),
      ...(/\.png$/i.test(dst) ? [] : ['-q:v', '2']), '-update', '1', dst], { cwd });
  } finally { if (cwd) removeTree(cwd); }
  const info = await mediaInfo(dst);
  out({ ok: true, out: fwd(dst), at, width: info.width, height: info.height, from: p.kind });
}

// ---------------------------------------------------------------------------------------------------- edl
// Proposes a cut list from a transcript: each run of speech becomes a segment, the pauses between runs are removed.
async function edl() {
  const { root, project } = loadProject(rest[0]);
  const fps = project.fps || 30;
  const file = needFile(rest[1], root, 'clip');
  const info = await mediaInfo(file);
  const base = path.basename(file, path.extname(file));
  const wordsFile = locate(args.words, root) || locate(path.join('work', 'words', `${base}.json`), root);
  if (!wordsFile) fail(`no transcript for this clip. Transcribe it first into work/words/${base}.json`, 2);
  const words = readWords(wordsFile);
  if (!words.length) fail('the transcript is empty', 2);
  const pause = num(args.pause, 0.5), pad = num(args.pad, 0.12), id = String(args.id && args.id !== true ? args.id : 's01');
  const runs = [];
  for (const w of words) {
    const last = runs[runs.length - 1];
    if (last && w.start - last[last.length - 1].end <= pause) last.push(w); else runs.push([w]);
  }
  const snap = (t) => Math.round(t * fps) / fps;
  const segments = runs.map((r, i) => {
    const prevEnd = i ? runs[i - 1][runs[i - 1].length - 1].end : 0;
    const nextStart = runs[i + 1] ? runs[i + 1][0].start : info.duration;
    const a = Math.max(r[0].start - pad, i ? (prevEnd + r[0].start) / 2 : 0, 0);
    const b = Math.min(r[r.length - 1].end + pad, runs[i + 1] ? (r[r.length - 1].end + nextStart) / 2 : info.duration);
    return { id: args.split ? `s${String(i + 1).padStart(2, '0')}` : id, src: rel(root, file), in: r3(snap(a)), out: r3(snap(b)), text: wordsText(r) };
  }).filter((s) => s.out - s.in >= 1 / fps);
  const kept = segments.reduce((s, x) => s + (x.out - x.in), 0);
  const file2 = path.join(root, 'edl.json');
  const old = archiveExisting(file2);
  writeJson(file2, { segments });
  out({ ok: true, edl: 'edl.json', archived: old ? rel(root, old) : null, clip: rel(root, file), words: rel(root, wordsFile),
    segments: segments.length, source_seconds: r3(info.duration), kept_seconds: r3(kept), removed_seconds: r3(info.duration - kept), list: segments });
}

// ---------------------------------------------------------------------------------------------------- cut
// Scale and crop filters that fit a picture of sw x sh into the canvas W x H.
function fitFilters(sw, sh, W, H, { fit = 'cover', focus = [0.5, 0.5], zoom = 1 } = {}) {
  const fx = Math.min(1, Math.max(0, Number(focus?.[0] ?? 0.5))), fy = Math.min(1, Math.max(0, Number(focus?.[1] ?? 0.5)));
  const cover = (w, h, z = 1) => {
    const k = Math.max(w / sw, h / sh) * Math.max(1, z);
    const tw = Math.max(w, even(sw * k)), th = Math.max(h, even(sh * k));
    const f = [];
    if (tw !== sw || th !== sh) f.push(`scale=${tw}:${th}:flags=lanczos`);
    if (tw !== w || th !== h) f.push(`crop=${w}:${h}:${Math.round((tw - w) * fx)}:${Math.round((th - h) * fy)}`);
    return f;
  };
  if (fit === 'cover') return cover(W, H, zoom);
  const k = Math.min(W / sw, H / sh);
  const tw = Math.min(W, even(sw * k)), th = Math.min(H, even(sh * k));
  if (tw === W && th === H) return tw === sw && th === sh ? [] : [`scale=${W}:${H}:flags=lanczos`];
  if (fit === 'contain') return [`scale=${tw}:${th}:flags=lanczos`, `pad=${W}:${H}:${Math.round((W - tw) / 2)}:${Math.round((H - th) / 2)}:color=black`];
  if (fit === 'blur') {
    const bw = even(W / 4), bh = even(H / 4);
    const bg = [...cover(bw, bh), 'gblur=sigma=12', `scale=${W}:${H}:flags=bilinear`, 'eq=brightness=-0.06'].join(',');
    return [`split[fma][fmb];[fma]${bg}[fmbg];[fmb]scale=${tw}:${th}:flags=lanczos[fmfg];[fmbg][fmfg]overlay=${Math.round((W - tw) / 2)}:${Math.round((H - th) / 2)}`];
  }
  fail(`unknown fit "${fit}". Use cover, contain or blur.`, 2);
  return [];
}

function waitExit(child) {
  return new Promise((resolve) => {
    let err = '';
    child.stderr?.on('data', (d) => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
    child.on('error', (e) => resolve({ code: 127, err: String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, err }));
  });
}

// One base clip from one or more source ranges: every range is decoded to raw frames and piped into a single encoder,
// so the clip holds exactly the planned number of frames, with one generation of compression.
async function writeBaseClip(parts, dst, { W, H, fps, crf = 14 }) {
  const ff = tool('ffmpeg'), frameBytes = W * H * 1.5;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst.replace(/\.mp4$/i, '.part.mp4');
  const enc = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', fpsArg(fps),
    '-i', 'pipe:0', '-vf', TAG_709, ...x264({ crf, preset: 'fast', fps }), '-an', '-movflags', '+faststart', tmp],
  { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  const encDone = waitExit(enc);
  enc.stdin.on('error', () => { /* the encoder died; its exit code tells why */ });
  let frames = 0;
  for (const part of parts) {
    const chain = [];
    if (Math.abs(part.srcFps - fps) > 0.01) chain.push(`fps=${fpsArg(fps)}`);
    chain.push('setpts=PTS-STARTPTS', ...fitFilters(part.sw, part.sh, W, H, part), 'tpad=stop_mode=clone:stop=-1', 'format=yuv420p');
    // The seek lands half a frame before the first wanted frame, so rounding can never pick its neighbour.
    const seek = Math.max(0, (part.inFrame - 0.5) / fps);
    const dec = spawn(ff, ['-hide_banner', '-loglevel', 'error', ...(seek > 0 ? ['-ss', seek.toFixed(6)] : []), '-i', part.file, '-map', '0:v:0', '-an',
      '-vf', chain.join(','), '-frames:v', String(part.frames), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const decDone = waitExit(dec);
    let bytes = 0;
    for await (const chunk of dec.stdout) {
      bytes += chunk.length;
      if (!enc.stdin.write(chunk)) await Promise.race([once(enc.stdin, 'drain'), encDone]);
    }
    const d = await decDone;
    if (d.code !== 0 || bytes !== part.frames * frameBytes) {
      enc.stdin.destroy();
      throw new Error(`could not read ${part.frames} frames from ${fwd(part.file)} at ${r3(part.inFrame / fps)} s (${Math.floor(bytes / frameBytes)} read). ${d.err.trim().split(/\r?\n/).slice(-2).join(' | ')}`);
    }
    frames += part.frames;
  }
  enc.stdin.end();
  const e = await encDone;
  if (e.code !== 0) throw new Error(`the encoder failed: ${e.err.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  fs.renameSync(tmp, dst);
  return frames;
}

// The sound of one source range as stereo float samples, exactly `samples` long (silence where the source has none).
async function readAudio(file, startSec, samples, hasAudio) {
  const data = new Float32Array(samples * 2);
  if (!hasAudio || samples <= 0) return data;
  const r = await runBinary(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-ss', startSec.toFixed(6), '-t', (samples / 48000 + 0.25).toFixed(3),
    '-i', file, '-map', '0:a:0', '-vn', '-af', 'aresample=48000:async=1:first_pts=0', '-ac', '2', '-f', 'f32le', 'pipe:1']);
  if (r.code !== 0) throw new Error(`could not read the sound of ${fwd(file)}: ${r.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}`);
  const n = Math.min(samples * 2, Math.floor(r.stdout.length / 4));
  new Uint8Array(data.buffer).set(r.stdout.subarray(0, n * 4));
  const fade = Math.min(192, Math.floor(samples / 2));               // 4 ms at each edge, so a cut never clicks
  for (let i = 0; i < fade; i++) {
    const g = i / fade, tail = (samples - 1 - i) * 2;
    data[i * 2] *= g; data[i * 2 + 1] *= g; data[tail] *= g; data[tail + 1] *= g;
  }
  return data;
}

// A WAV file (24-bit PCM, 48 kHz) written piece by piece.
function wavWriter(file, totalSamples, channels) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  const bytes = totalSamples * channels * 3, h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + bytes, 4); h.write('WAVEfmt ', 8, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(48000 * channels * 3, 28); h.writeUInt16LE(channels * 3, 32);
  h.writeUInt16LE(24, 34); h.write('data', 36, 'ascii'); h.writeUInt32LE(bytes, 40);
  fs.writeSync(fd, h);
  return {
    write(samples) {
      const b = Buffer.alloc(samples.length * 3);
      for (let i = 0, o = 0; i < samples.length; i++, o += 3) {
        let v = Math.round(Math.max(-1, Math.min(1, samples[i])) * 8388607);
        if (v < 0) v += 16777216;
        b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255;
      }
      fs.writeSync(fd, b);
    },
    close() { fs.closeSync(fd); },
  };
}

async function cut() {
  const { root, project } = loadProject(rest[0]);
  const fps = project.fps || 30, W = project.width, H = project.height;
  const edlFile = path.join(root, 'edl.json');
  const warnings = [];
  let archived = null;

  if (args.whole !== undefined) {
    const file = needFile(args.whole, root, 'clip');
    const info = await mediaInfo(file);
    if (!args['dry-run']) { archived = archiveExisting(edlFile); writeJson(edlFile, { segments: [{ id: 's01', src: rel(root, file), in: 0, out: r3(info.duration) }] }); }
    else if (!fs.existsSync(edlFile)) fail('--dry-run with --whole needs an existing edl.json, or run without --dry-run', 2);
  }
  if (!fs.existsSync(edlFile)) fail(`no edl.json in ${fwd(root)}. Write it, propose it with "edl", or use --whole <file>.`, 2);
  const list = readJson(edlFile).segments;
  if (!Array.isArray(list) || !list.length) fail('edl.json has no segments', 2);

  // ---- read and check the plan
  const infos = new Map();
  const segs = [];
  for (const [i, s] of list.entries()) {
    const where = `segment ${i + 1}`;
    if (!s.id || !/^[A-Za-z0-9_-]+$/.test(String(s.id))) fail(`${where}: "id" must be letters, digits, dash or underscore`, 2);
    if (!s.src) {
      const d = Number(s.duration);
      if (!(d > 0)) fail(`${where}: give "src" with "in" and "out", or "duration" for a stretch with no sound`, 2);
      segs.push({ id: String(s.id), kind: 'silence', seconds: d });
      continue;
    }
    const file = locate(s.src, root) || fail(`${where}: source not found: ${s.src}`, 2);
    if (!infos.has(file)) infos.set(file, await mediaInfo(file));
    const info = infos.get(file);
    const a = Number(s.in ?? 0), b = Number(s.out ?? info.duration);
    if (!(a >= 0) || !(b > a)) fail(`${where}: "out" must be after "in"`, 2);
    if (b > info.duration + 1.5 / fps) fail(`${where}: "out" ${b} is past the end of the clip (${r3(info.duration)} s)`, 2);
    const video = s.video !== false && info.hasVideo;
    if (video && info.rotation) warnings.push(`${s.src} is rotated in its file: normalize it first`);
    if (video && info.hdr) warnings.push(`${s.src} is HDR: normalize it first, or the colours come out wrong`);
    segs.push({ id: String(s.id), kind: video ? 'video' : 'audio', file, info, a, b, fit: s.fit, focus: s.focus, zoom: Number(s.zoom || 1), words: s.words });
  }
  // Segments that share an id form one scene. The id may not come back later.
  const groups = [];
  for (const s of segs) {
    const g = groups[groups.length - 1];
    if (g && g.id === s.id) g.segs.push(s);
    else { if (groups.some((x) => x.id === s.id)) fail(`id "${s.id}" appears in two separate places of edl.json: use a new id`, 2); groups.push({ id: s.id, segs: [s] }); }
  }
  for (const g of groups) {
    const kinds = new Set(g.segs.map((s) => (s.kind === 'video' ? 'video' : 'other')));
    if (kinds.size > 1) fail(`scene "${g.id}" mixes footage with sound-only stretches: give them different ids`, 2);
  }

  // ---- the timeline, in whole frames
  let cursor = 0;                                                    // frames on the new timeline
  for (const s of segs) {
    if (s.kind === 'silence') { s.frames = Math.max(1, toFrames(s.seconds, fps)); }
    else {
      s.inFrame = toFrames(s.a, fps);
      const srcFrames = Math.max(1, Math.round(s.info.duration * fps));
      s.frames = Math.max(1, Math.min(toFrames(s.b, fps), Math.max(srcFrames, s.inFrame + 1)) - s.inFrame);
    }
    s.startFrame = cursor; cursor += s.frames;
  }
  const totalFrames = cursor;
  const oldScenes = new Map((project.scenes || []).map((s) => [s.id, s]));
  const scenes = groups.map((g) => {
    const first = g.segs[0], last = g.segs[g.segs.length - 1];
    const footage = first.kind === 'video';
    const was = oldScenes.get(g.id) || {};
    const scene = { ...was, id: g.id, kind: footage ? 'footage' : (was.kind === 'footage' ? 'motion' : was.kind || 'motion'),
      start: r3(first.startFrame / fps), end: r3((last.startFrame + last.frames) / fps) };
    if (footage) { scene.clip = `work/base/${g.id}.mp4`; scene.overlay = was.overlay === true; }
    else { delete scene.clip; delete scene.overlay; }
    return scene;
  });
  const sourceSeconds = [...infos.values()].reduce((s, i) => s + i.duration, 0);
  const plan = {
    project: fwd(root), segments: segs.length, scenes, frames: totalFrames, duration: r3(totalFrames / fps),
    source_seconds: r3(sourceSeconds), removed_seconds: r3(Math.max(0, sourceSeconds - segs.filter((s) => s.kind !== 'silence').reduce((x, s) => x + s.frames / fps, 0))),
  };
  if (args['dry-run']) { out({ ok: true, dry_run: true, ...plan, warnings: [...new Set(warnings)] }); return; }

  // ---- the base clips
  const base = [];
  for (const g of groups) {
    if (g.segs[0].kind !== 'video') continue;
    const dst = path.join(root, 'work', 'base', `${g.id}.mp4`);
    const one = g.segs.length === 1 ? g.segs[0] : null;
    const i = one?.info;
    const asIs = one && one.inFrame === 0 && i.width === W && i.height === H && Math.abs(i.fps - fps) < 0.01 && i.codec === 'h264' && i.pixFmt === 'yuv420p'
      && !i.rotation && !i.hdr && one.zoom === 1 && (!one.fit || one.fit === 'cover') && i.frames !== null && Math.abs(i.frames - one.frames) <= 1
      && ['bt709'].includes(i.transfer) && i.primaries === 'bt709';
    if (asIs) {                                                      // the whole clip, already in the project's shape: no re-encode
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      await ffmpeg(['-i', one.file, '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', dst]);
      const made = (await mediaInfo(dst)).frames;
      if (made !== one.frames) {                                      // keep every number equal to the real file
        const d = made - one.frames; one.frames = made;
        for (const s of segs) if (s.startFrame > one.startFrame) s.startFrame += d;
      }
      base.push({ id: g.id, file: rel(root, dst), frames: one.frames, copied: true });
      continue;
    }
    note(`cutting ${g.id}: ${g.segs.length} range(s), ${g.segs.reduce((x, s) => x + s.frames, 0)} frames`);
    const frames = await writeBaseClip(g.segs.map((s) => ({ file: s.file, inFrame: s.inFrame, frames: s.frames, srcFps: s.info.fps,
      sw: s.info.width, sh: s.info.height, fit: s.fit, focus: s.focus, zoom: s.zoom })), dst, { W, H, fps });
    const made = (await mediaInfo(dst)).frames;
    if (made !== frames) throw new Error(`work/base/${g.id}.mp4 has ${made} frames, planned ${frames}`);
    base.push({ id: g.id, file: rel(root, dst), frames, copied: false });
  }
  // A stream copy may have changed a length: lay the timeline out again from the real numbers.
  cursor = 0;
  for (const s of segs) { s.startFrame = cursor; cursor += s.frames; }
  for (const [k, g] of groups.entries()) {
    const first = g.segs[0], last = g.segs[g.segs.length - 1];
    scenes[k].start = r3(first.startFrame / fps); scenes[k].end = r3((last.startFrame + last.frames) / fps);
  }
  const frames = cursor, duration = r3(frames / fps);

  // ---- the sound: the same ranges, joined sample by sample
  const sampleAt = (frame) => Math.round((frame / fps) * 48000);
  const total = sampleAt(frames);
  const voice = wavWriter(path.join(root, 'work', 'voice-raw.wav'), total, 1);
  const audio = wavWriter(path.join(root, 'work', 'audio-raw.wav'), total, 2);
  for (const s of segs) {
    const n = sampleAt(s.startFrame + s.frames) - sampleAt(s.startFrame);
    const st = s.kind === 'silence' ? new Float32Array(n * 2) : await readAudio(s.file, s.inFrame / fps, n, s.info.hasAudio);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (st[i * 2] + st[i * 2 + 1]) / 2;
    audio.write(st); voice.write(mono);
  }
  voice.close(); audio.close();

  // ---- the words, moved to the new timeline (when the sources have transcripts in work/words/)
  let wordsOut = null, wordsNote = null;
  const withSound = segs.filter((s) => s.kind !== 'silence');
  const wordsOf = (s) => locate(s.words, root) || locate(path.join('work', 'words', `${path.basename(s.file, path.extname(s.file))}.json`), root);
  const have = withSound.filter(wordsOf);
  if (have.length && have.length === withSound.length) {
    const cache = new Map(), moved = [];
    for (const s of withSound) {
      const wf = wordsOf(s);
      if (!cache.has(wf)) cache.set(wf, readWords(wf));
      const a = s.inFrame / fps, b = (s.inFrame + s.frames) / fps, shift = s.startFrame / fps - a;
      for (const w of cache.get(wf)) {
        const mid = (w.start + w.end) / 2;
        if (mid < a || mid >= b) continue;
        moved.push({ text: w.text, start: r3(Math.max(w.start, a) + shift), end: r3(Math.min(w.end, b) + shift) });
      }
    }
    const target = path.join(root, 'audio', 'words.json');
    const old = archiveExisting(target);
    if (old) wordsNote = `the previous audio/words.json moved to ${rel(root, old)}`;
    writeJson(target, moved);
    wordsOut = 'audio/words.json';
  } else if (have.length) {
    wordsNote = 'some sources have no transcript in work/words/, so audio/words.json was not written';
  }

  writeJson(path.join(root, 'work', 'scenes.json'), scenes);
  const setScenes = Boolean(args['set-scenes']) || args.whole !== undefined;
  if (setScenes) { project.scenes = scenes; saveProject(root, project); }
  out({ ok: true, ...plan, scenes, frames, duration, base, voice: 'work/voice-raw.wav', audio: 'work/audio-raw.wav', words: wordsOut, words_note: wordsNote,
    scenes_file: 'work/scenes.json', project_updated: setScenes, edl_archived: archived ? rel(root, archived) : null, warnings: [...new Set(warnings)] });
}

// ---------------------------------------------------------------------------------------------------- captions
const CAPTIONS_SRC = path.join(SKILL_ROOT, 'assets', 'template', 'lib', 'captions.js');
const MARK_A = '<!-- captions:start', MARK_B = '<!-- captions:end -->';

function captionsBlock({ W, H, position, mode, maxWords, maxChars, lines }) {
  const portrait = H > W, square = H === W;
  const y = { top: portrait ? 22 : 14, middle: 50, bottom: portrait ? 74 : 84 }[position];
  const size = Math.round(portrait ? W * 0.066 : square ? W * 0.058 : H * 0.06);
  return `${MARK_A} (written by footage.mjs captions: change the variables freely, keep the two marker lines) -->
    <style>
      .fm-cap {
        --cap-y: ${y}%;                 /* where the block sits, from the top of the frame */
        --cap-size: ${size}px;
        --cap-weight: 800;
        --cap-color: #ffffff;
        --cap-active-color: #ffe14d;    /* the word being spoken */
        --cap-stroke-width: ${Math.max(2, Math.round(size / 12))}px;
        --cap-stroke-color: rgba(0, 0, 0, 0.85);
        --cap-shadow: 0 ${Math.round(size / 14)}px ${Math.round(size / 4)}px rgba(0, 0, 0, 0.5);
        --cap-active-bg: transparent;   /* a colour here puts a box behind the spoken word */
        --cap-bg: transparent;          /* a colour here puts a box behind each line */
      }
    </style>
    <script src="assets/words.js"></script>
    <script src="assets/captions.js"></script>
    <script>
      FocusCaptions.add(window.__timelines["main"], window.FM_WORDS, { mode: "${mode}", maxWords: ${maxWords}, maxChars: ${maxChars}, lines: ${lines} });
      window.__timelines["main"].seek(0);
    </script>
    ${MARK_B}`;
}

async function captions() {
  const { root, project } = loadProject(rest[0]);
  const id = rest[1] || fail('give the scene id: captions <project> <id>', 2);
  const scene = (project.scenes || []).find((s) => s.id === id) || fail(`scene "${id}" is not in project.json. Set the scenes first (cut --set-scenes, or project.mjs set-scenes).`, 2);
  const W = project.width, H = project.height, fps = project.fps || 30;
  const duration = r3((toFrames(scene.end, fps) - toFrames(scene.start, fps)) / fps);
  const position = args.position && args.position !== true ? String(args.position) : 'bottom';
  if (!['top', 'middle', 'bottom'].includes(position)) fail('--position is top, middle or bottom', 2);
  const mode = args.mode && args.mode !== true ? String(args.mode) : 'highlight';
  if (!['highlight', 'reveal'].includes(mode)) fail('--mode is highlight or reveal', 2);
  const portrait = H > W;
  const opts = { W, H, position, mode, maxWords: num(args['max-words'], 6), maxChars: num(args['max-chars'], portrait ? 18 : H === W ? 22 : 30), lines: num(args.lines, 2) };

  const wordsFile = needFile(args.words && args.words !== true ? args.words : path.join('audio', 'words.json'), root, 'words file');
  const local = readWords(wordsFile)
    .filter((w) => w.start >= scene.start - 1e-6 && w.start < scene.end - 1e-6)
    .map((w) => ({ text: w.text, start: r3(w.start - scene.start), end: r3(Math.min(w.end, scene.end) - scene.start) }));
  if (!local.length) fail(`no words between ${scene.start} and ${scene.end} s in ${rel(root, wordsFile)}`, 1);
  if (!fs.existsSync(CAPTIONS_SRC)) fail(`the captions helper is missing: ${fwd(CAPTIONS_SRC)}`, 3);

  const dir = path.join(root, 'scenes', id), assets = path.join(dir, 'assets'), index = path.join(dir, 'index.html');
  const block = captionsBlock(opts);
  let wired;
  if (!fs.existsSync(index)) {
    // A new scene from the skill's template (transparent stage, fonts, GSAP), made by project.mjs.
    const made = await run(process.execPath, [path.join(SKILL_ROOT, 'scripts', 'project.mjs'), 'add-scene', root, id, '--kind', 'footage']);
    if (made.code !== 0 || !fs.existsSync(index)) fail(`could not create scenes/${id}: ${(made.stderr || made.stdout).trim().split(/\r?\n/).pop()}`, made.code === 3 ? 3 : 1);
    const html = fs.readFileSync(index, 'utf8');
    if (!/<\/body>/i.test(html)) fail(`scenes/${id}/index.html has no </body> to add the captions before`, 1);
    fs.writeFileSync(index, html.replace(/<\/body>/i, `  ${block}\n  </body>`));
    wired = 'new scene';
  } else {
    const html = fs.readFileSync(index, 'utf8');
    const a = html.indexOf(MARK_A), b = html.indexOf(MARK_B);
    if (a >= 0 && b > a && !args.rewire) wired = 'kept';
    else {
      const keep = path.join(root, '_versions');
      fs.mkdirSync(keep, { recursive: true });
      fs.copyFileSync(index, path.join(keep, `${id}-index-${Date.now()}.html`));
      let next;
      if (a >= 0 && b > a) next = html.slice(0, a) + block + html.slice(b + MARK_B.length);
      else if (/<\/body>/i.test(html)) next = html.replace(/<\/body>/i, `  ${block}\n  </body>`);
      else fail(`scenes/${id}/index.html has no </body> to add the captions before`, 1);
      fs.writeFileSync(index, next);
      wired = a >= 0 ? 'rewritten' : 'added';
    }
  }
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'words.js'), `// Words of scene ${id}, in the scene's own seconds. Written by footage.mjs captions.\nwindow.FM_WORDS = ${JSON.stringify(local, null, 1)};\n`);
  fs.copyFileSync(CAPTIONS_SRC, path.join(assets, 'captions.js'));
  const fresh = loadProject(root).project;              // add-scene may have updated project.json
  const entry = (fresh.scenes || []).find((x) => x.id === id) || scene;
  let overlayOn = entry.overlay === true;
  if (entry.kind === 'footage' && !overlayOn) { entry.overlay = true; saveProject(root, fresh); overlayOn = true; }
  out({ ok: true, scene: id, kind: scene.kind, words: local.length, from: r3(scene.start), to: r3(scene.end), duration, wired, position, mode,
    files: [`scenes/${id}/index.html`, `scenes/${id}/assets/words.js`, `scenes/${id}/assets/captions.js`], overlay: overlayOn,
    text: wordsText(local) });
}

// ---------------------------------------------------------------------------------------------------- overlay
async function alphaRange(file) {
  const r = await run(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'alphaextract,signalstats,metadata=mode=print:file=-', '-f', 'null', '-']);
  const min = r.stdout.match(/signalstats\.YMIN=(\d+)/), max = r.stdout.match(/signalstats\.YMAX=(\d+)/);
  return min && max ? { min: Number(min[1]), max: Number(max[1]) } : null;
}

async function overlay() {
  const started = Date.now();
  const { root, project } = loadProject(rest[0]);
  const id = rest[1] || fail('give the scene id: overlay <project> <id>', 2);
  const scene = (project.scenes || []).find((s) => s.id === id) || fail(`scene "${id}" is not in project.json`, 2);
  if (scene.kind !== 'footage') fail(`scene "${id}" is a ${scene.kind} scene. Only footage scenes are composited; render it with render.mjs.`, 2);
  const W = project.width, H = project.height, fps = project.fps || 30;
  const frames = toFrames(scene.end, fps) - toFrames(scene.start, fps);
  const clip = needFile(scene.clip || path.join('work', 'base', `${id}.mp4`), root, 'base clip');
  const info = await mediaInfo(clip);
  if (!info.hasVideo) fail(`${rel(root, clip)} has no picture`, 1);
  const warnings = [];
  if (info.hdr) fail(`${rel(root, clip)} is HDR. Normalize it first (footage.mjs normalize), or the colours come out wrong.`, 1);
  if (info.frames !== null && info.frames !== frames) warnings.push(`the base clip has ${info.frames} frames and the scene ${frames}: the clip is ${info.frames > frames ? 'trimmed' : 'held on its last frame'}`);
  const draft = Boolean(args.draft);
  const dst = path.join(root, 'renders', `${id}.mp4`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  // The base, brought to the project's shape when it is not there already.
  if (info.rotation) warnings.push('the base clip is rotated in its file: normalize it first');
  const fitChain = [];
  if (Math.abs(info.fps - fps) > 0.01) fitChain.push(`fps=${fpsArg(fps)}`);
  fitChain.push(...fitFilters(info.width, info.height, W, H, { fit: scene.fit, focus: scene.focus, zoom: Number(scene.zoom || 1) }));
  const baseChain = [...fitChain];
  if (info.frames !== null && info.frames < frames) baseChain.push('tpad=stop_mode=clone:stop=-1');
  if (info.pixFmt !== 'yuv420p') baseChain.push('format=yuv420p');
  const crf = num(args.crf, draft ? 23 : 16);           // 16 is the engine's own default; 0 is lossless
  const encode = [...x264({ crf, preset: draft ? 'veryfast' : 'medium', fps }), '-an', '-movflags', '+faststart'];
  const timing = {};

  const subjectArg = args.subject && args.subject !== true ? args.subject : scene.subject;
  const subject = subjectArg ? needFile(subjectArg, root, 'subject cutout') : null;

  if (scene.overlay !== true) {
    // No graphics: the clip itself is the scene.
    const plain = !baseChain.length && info.codec === 'h264' && info.frames === frames;
    if (plain) await ffmpeg(['-i', clip, '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', dst]);
    else await ffmpeg(['-i', clip, '-map', '0:v:0', '-vf', [...baseChain, TAG_709].join(','), '-frames:v', String(frames), ...encode, dst]);
    const made = await mediaInfo(dst);
    out({ ok: made.frames === frames, id, out: rel(root, dst), overlay: false, copied: plain, frames: made.frames, expected_frames: frames, pixFmt: made.pixFmt,
      transfer: made.transfer, seconds: r3((Date.now() - started) / 1000), warnings });
    if (made.frames !== frames) process.exit(1);
    return;
  }

  const sceneDir = path.join(root, 'scenes', id);
  if (!fs.existsSync(path.join(sceneDir, 'index.html'))) fail(`scenes/${id}/index.html is missing. Create the scene, or set "overlay": false for a clip with no graphics.`, 2);
  const lint = await engine(['lint', sceneDir, '--json'], { timeoutMs: 120000 });
  if (lint.code === 127) fail(`the video engine could not start: ${lint.stderr.trim().split(/\r?\n/).pop()}`, 3);
  let lintJson = null;
  try { lintJson = JSON.parse(lint.stdout.slice(lint.stdout.indexOf('{'), lint.stdout.lastIndexOf('}') + 1)); } catch { /* an older engine prints text */ }
  if (lintJson && lintJson.errorCount > 0) {
    fail(`the scene has ${lintJson.errorCount} lint error(s): ${lintJson.findings.filter((f) => f.severity === 'error').slice(0, 3).map((f) => f.message).join(' | ')}`, 1, { lint: lintJson.findings });
  }

  // 1. The graphics alone, as transparent PNG frames. The footage never enters the engine.
  const work = path.join(root, 'work', 'overlay', id);
  removeTree(work);
  fs.mkdirSync(work, { recursive: true });
  const framesDir = path.join(work, 'frames');
  const renderArgs = (extra) => ['render', sceneDir, '--format', 'png-sequence', '-o', framesDir, '--fps', fpsArg(fps), ...extra];
  const limit = { timeoutMs: Math.max(600000, frames * 4000), stallMs: 240000 };
  const workers = args.workers && args.workers !== true ? ['--workers', String(args.workers)] : [];
  note(`rendering the graphics of ${id}: ${frames} frames`);
  let t0 = Date.now();
  let r = await engine(renderArgs(workers), limit);
  let attempts = 1;
  const pngs = () => (fs.existsSync(framesDir) ? fs.readdirSync(framesDir).filter((n) => /^frame_\d+\.png$/.test(n)).sort() : []);
  if (r.code !== 0 || pngs().length < frames) {
    note(`the render ${r.stalled ? 'stalled' : r.timedOut ? 'timed out' : 'failed'}; trying once more with one worker`);
    removeTree(framesDir);
    r = await engine(renderArgs(['--workers', '1', '--low-memory-mode']), limit);
    attempts = 2;
  }
  timing.render = r3((Date.now() - t0) / 1000);
  const list = pngs();
  if (r.code !== 0 || list.length < frames) {
    fail(`the engine did not render the scene (${list.length} of ${frames} frames). ${(r.stderr || r.stdout).trim().split(/\r?\n/).filter((l) => !/Render:trace|initSession/.test(l)).slice(-3).join(' | ')}`, 1);
  }
  if (list.length > frames) {
    // The engine rounds data-duration up to whole frames; a duration written with three decimals can add one.
    warnings.push(`the engine rendered ${list.length} frames for ${frames} planned; the extra frame(s) at the end were dropped. data-duration="${Math.floor((frames / fps) * 1e4) / 1e4}" renders exactly ${frames}.`);
  }
  const digits = list[0].match(/\d+/)[0];
  const first = Number(digits);

  // 2. Is the scene really transparent?
  const samples = [list[0], list[Math.floor(frames / 2)], list[frames - 1]];
  const alpha = [];
  for (const f of samples) alpha.push(await alphaRange(path.join(framesDir, f)));
  if (alpha.every((a) => a && a.min === 255)) {
    fail(`scene "${id}" paints an opaque background, so it would hide the footage. Make html, body and the root transparent (background: transparent) and run again.`, 1);
  }
  if (alpha.every((a) => a && a.max === 0)) warnings.push('the rendered graphics are empty on the first, middle and last frame');

  // 3. Lay the frames over the clip. The clip stays in its own YUV colours; only the graphics are converted.
  t0 = Date.now();
  const inputs = ['-i', clip, '-framerate', fpsArg(fps), '-start_number', String(first), '-i', `frame_%0${digits.length}d.png`];
  const graph = [`[0:v]${[...baseChain, 'setpts=PTS-STARTPTS'].join(',')}[base]`,
    '[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva444p[gfx]'];
  let top = '[base][gfx]overlay=format=yuv420:alpha=straight:eof_action=pass';
  if (subject) {
    // The cutout of the person goes back on top, so the graphics sit behind them.
    const vp9 = /\.webm$/i.test(subject) ? ['-c:v', 'libvpx-vp9'] : [];
    inputs.push(...vp9, '-i', subject);
    graph.push(`${top}[mid]`, `[2:v]${[...fitChain, 'setpts=PTS-STARTPTS', 'format=yuva420p'].join(',')}[subj]`);
    top = '[mid][subj]overlay=format=yuv420:alpha=straight:eof_action=pass';
  }
  graph.push(`${top},format=yuv420p,${TAG_709}[v]`);
  await ffmpeg([...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-frames:v', String(frames), ...encode, dst], { cwd: framesDir });
  timing.composite = r3((Date.now() - t0) / 1000);

  const made = await mediaInfo(dst);
  const ok = made.frames === frames && made.pixFmt === 'yuv420p' && made.width === W && made.height === H;
  if (!args.keep) { removeTree(work); try { fs.rmdirSync(path.dirname(work)); } catch { /* other scenes' frames are kept */ } }
  out({ ok, id, out: rel(root, dst), overlay: true, route: 'png-sequence', frames: made.frames, expected_frames: frames, width: made.width, height: made.height,
    pixFmt: made.pixFmt, transfer: made.transfer, primaries: made.primaries, subject: subject ? rel(root, subject) : null, draft, attempts,
    seconds: { ...timing, total: r3((Date.now() - started) / 1000) }, kept_frames: args.keep ? rel(root, framesDir) : null, warnings });
  if (!ok) process.exit(1);
}

// ---------------------------------------------------------------------------------------------------- mux
async function mux() {
  const video = needFile(rest[0], null, 'video');
  const audio = needFile(args.audio, findProjectRoot(video), 'audio file');
  if (!args.out || args.out === true) fail('give the output: -o <out.mp4>', 2);
  const dst = path.resolve(args.out);
  if (dst === video || dst === audio) fail('the output would overwrite an input', 2);
  const v = await mediaInfo(video), a = await mediaInfo(audio);
  if (!v.hasVideo) fail(`${fwd(video)} has no picture`, 2);
  if (!a.hasAudio) fail(`${fwd(audio)} has no sound`, 2);
  const old = archiveExisting(dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // The sound is cut or padded with silence to the exact length of the picture.
  await ffmpeg(['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', `apad,atrim=end=${v.duration.toFixed(6)}`,
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', dst]);
  const made = await mediaInfo(dst);
  out({ ok: true, out: fwd(dst), duration: r3(made.duration), video_seconds: r3(v.duration), audio_seconds: r3(a.duration), frames: made.frames,
    archived: old ? fwd(old) : null });
}

// ---------------------------------------------------------------------------------------------------- matte
async function matte() {
  const started = Date.now();
  const file = needFile(rest[0]);
  if (!args.out || args.out === true) fail('give the output: -o subject.webm (or .mov, or .png for a photo)', 2);
  const dst = path.resolve(args.out);
  if (!/\.(webm|mov|png)$/i.test(dst)) fail('the output ends with .webm (for use inside a scene), .mov or .png', 2);
  const info = await mediaInfo(file);
  if (info.hdr) fail('this clip is HDR. Normalize it first (footage.mjs normalize), then make the cutout from the normalized file.', 1);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const extra = [];
  if (args.quality && args.quality !== true) extra.push('--quality', String(args.quality));
  if (args.device && args.device !== true) extra.push('--device', String(args.device));
  note(`cutting out the subject of ${fwd(file)} (${info.frames ?? '?'} frames). The first run downloads the model once.`);
  const r = await engine(['remove-background', file, '-o', dst, '--json', ...extra], { timeoutMs: Math.max(900000, (info.frames || 300) * 6000), stallMs: 600000 });
  if (r.code === 127) fail(`the video engine could not start: ${r.stderr.trim().split(/\r?\n/).pop()}`, 3);
  if (r.code !== 0 || !fs.existsSync(dst)) fail(`the cutout failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' | ')}`, 1);
  const made = await mediaInfo(dst);
  out({ ok: true, out: fwd(dst), width: made.width, height: made.height, duration: r3(made.duration), megabytes: Math.round(fs.statSync(dst).size / 1048576 * 10) / 10,
    seconds: r3((Date.now() - started) / 1000) });
}

// ---------------------------------------------------------------------------------------------------- run
const jobs = { probe, normalize, 'normalize-all': normalizeAll, still, edl, cut, captions, overlay, mux, matte };
if (!jobs[job]) fail(`unknown command "${job}". Run with --help.`, 2);
try { await jobs[job](); } catch (e) { fail(e.message || String(e), 1); }
