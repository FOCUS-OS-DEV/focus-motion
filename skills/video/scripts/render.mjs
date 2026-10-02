#!/usr/bin/env node
// render.mjs: renders the scenes of a project, one at a time, into renders/<id>.mp4 (video only, no sound).
//
// Usage:
//   node render.mjs <project> [ids...] [--all] [--changed] [--draft | --final] [--mblur id,id] [--workers n]
//                   [--timeout seconds] [--check | --no-check] [--shutter 0.5] [--mblur-samples 8]
//
//   ids          the scenes to render; they run in the order of the scene list, never in parallel
//   --all        every scene of the project
//   --changed    skip the scenes whose render is up to date (alone it looks at every scene)
//   --draft      a fast render for iteration: half the frame rate and a light encode. Not for delivery.
//   --final      full quality. This is the default.
//   --mblur      real motion blur for these scenes: 4x the frames, blended. A scene keeps it on later renders;
//                "--mblur none" turns it off. A draft never blurs.
//   --shutter 0.5        blend the samples over half of each frame instead of all of it (8x the frames at 30 fps):
//                        the move stays readable up to about 48 px per frame instead of 16
//   --mblur-samples 8    8 samples over the whole frame (also 8x the frames): smoother, softer
//                        Both are kept for the scene on later renders. The engine captures at most 240 fps.
//   --workers    browser workers of the engine (default: the engine decides; 1 uses the least memory)
//   --timeout    seconds allowed per scene before the one retry in low-memory mode (default: by frame count)
//   --check      run the engine's layout and runtime check before the render. On by default for a final render,
//   --no-check   off by default for a draft. Lint always runs, and a lint error stops the scene.
//
// Example:
//   node render.mjs launch-video s02 s03 --draft
import fs from 'node:fs';
import path from 'node:path';
import {
  SKILL_ROOT, fwd, out, note, die, parseArgs, loadProject, run, ffmpeg, ffprobeJson, mediaInfo, findTool,
} from './lib/common.mjs';
import { engine, engineJson, engineStart, ENGINE_VERSION, ENGINE_INSTALL_HINT } from './lib/engine.mjs';
import { timeline, sceneState, compositionInfo, writeRecord, readRecords, BT709_FILTER, secondsForFrames } from './lib/scenes.mjs';
import { showUsage, round, removeTree } from './lib/cli.mjs';

const STALL_MS = 180000;       // the engine printed nothing for this long: it hangs
const LOCK_STALE_MS = 6 * 3600 * 1000;

const args = parseArgs(process.argv.slice(2), {
  booleans: ['help', 'all', 'changed', 'draft', 'final', 'check'], aliases: { h: 'help' },
});
if (args.help) showUsage(import.meta.url, 0);
if (!args._.length) showUsage(import.meta.url, 2);
if (args.draft && args.final) showUsage(import.meta.url, 2, 'choose --draft or --final, not both');

const { root, project } = loadProject(args._[0]);
const t = timeline(project);
const fps = t.fps;
const ids = args._.slice(1).map(String);
if (!t.scenes.length) die('the project has no scenes yet. Add them with project.mjs add-scene or set-scenes.', 2);
const unknown = ids.filter((id) => !t.scenes.some((s) => s.id === id));
if (unknown.length) die(`not in the scene list: ${unknown.join(', ')}. The list has: ${t.scenes.map((s) => s.id).join(', ')}`, 2);
if (!ids.length && !args.all && !args.changed) showUsage(import.meta.url, 2, 'name the scenes to render, or pass --all or --changed');
const selected = ids.length ? t.scenes.filter((s) => ids.includes(s.id)) : t.scenes;

const draft = Boolean(args.draft);
const quality = draft ? 'draft' : 'final';
const runCheck = args.check === undefined ? !draft : args.check;
const workers = args.workers === undefined ? null : String(args.workers);
if (workers !== null && workers !== 'auto' && !(Number(workers) >= 1)) die('--workers must be a number from 1 up, or auto.', 2);
const userTimeout = args.timeout === undefined ? null : Number(args.timeout);
if (userTimeout !== null && !(userTimeout > 0)) die('--timeout must be a positive number of seconds.', 2);
const blurArg = args.mblur === undefined || args.mblur === true ? [] : String(args.mblur).split(',').map((s) => s.trim()).filter(Boolean);
const blurOff = blurArg.includes('none');
const blurBad = blurArg.filter((id) => id !== 'none' && !t.scenes.some((s) => s.id === id));
if (blurBad.length) die(`--mblur names scenes that are not in the list: ${blurBad.join(', ')}`, 2);
// Motion blur samples: `samples` captures blended into one frame, spread over `shutter` of the frame interval.
// The capture runs at fps x samples / shutter, which must be a whole multiple of the fps and at most 240.
const samplesArg = args['mblur-samples'] === undefined ? null : Number(args['mblur-samples']);
const shutterArg = args.shutter === undefined ? null : Number(args.shutter);
if (samplesArg !== null && !(Number.isInteger(samplesArg) && samplesArg >= 2 && samplesArg <= 8)) die('--mblur-samples must be a whole number from 2 to 8.', 2);
if (shutterArg !== null && !(shutterArg > 0 && shutterArg <= 1)) die('--shutter must be above 0 and at most 1 (0.5 is half the frame).', 2);
if (samplesArg !== null || shutterArg !== null) {
  const period = (samplesArg || 4) / (shutterArg || 1);
  if (Math.abs(period - Math.round(period)) > 1e-9) die(`--mblur-samples ${samplesArg || 4} over --shutter ${shutterArg || 1} is not a whole number of sub-frames per frame. Try --shutter 0.5 or 1.`, 2);
}
const MAX_CAPTURE_FPS = 240;

for (const tool of ['ffmpeg', 'ffprobe']) {
  if (!findTool(tool)) die(`${tool} was not found. Run the doctor: node "${fwd(path.join(SKILL_ROOT, 'scripts', 'doctor.mjs'))}"`, 3);
}
if (!engineStart()) die(`the video engine cannot start because npx is missing. Install Node.js 20 or newer, then run: ${ENGINE_INSTALL_HINT}`, 3);

const rendersDir = path.join(root, 'renders');
const tmpDir = path.join(rendersDir, '.tmp');
const rel = (p) => fwd(path.relative(root, p));
const tail = (text, n = 10) => String(text || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n');

// ---------- one render at a time per project ----------
const lockFile = path.join(rendersDir, '.lock');
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function lock() {
  fs.mkdirSync(rendersDir, { recursive: true });
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (held.pid !== process.pid && alive(held.pid) && Date.now() - held.at < LOCK_STALE_MS) {
      die(`another render is running in this project (process ${held.pid}). Scenes render one at a time: wait for it to finish.`, 1);
    }
  } catch { /* no lock, or an unreadable one */ }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
  process.on('exit', () => {
    try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === process.pid) fs.unlinkSync(lockFile); } catch { /* gone */ }
  });
}

// ---------- measuring a file ----------
async function probe(file) {
  const m = await mediaInfo(file);
  if (m.frames === null && m.hasVideo) { // the container did not say: count them
    const r = await run(findTool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
    m.frames = Number(String(r.stdout).trim()) || null;
  }
  return m;
}

// The checks every scene render has to pass. Returns the list of problems (empty when it is fine).
function verify(m, frames) {
  const bad = [];
  if (!m.hasVideo) return ['the file has no video'];
  if (m.width !== project.width || m.height !== project.height) bad.push(`size is ${m.width}x${m.height}, the project is ${project.width}x${project.height}`);
  if (Math.abs(m.fps - fps) > 0.01) bad.push(`frame rate is ${m.fps}, the project is ${fps}`);
  if (m.pixFmt !== 'yuv420p') bad.push(`pixel format is ${m.pixFmt}, expected yuv420p`);
  if (m.transfer !== 'bt709' || m.primaries !== 'bt709') bad.push(`colour is tagged ${m.transfer}/${m.primaries}, expected bt709 (SDR)`);
  if (frames !== null && m.frames !== frames) bad.push(`it has ${m.frames} frames, expected ${frames}`);
  return bad;
}

// Rewrites the colour tags of an H.264 file without re-encoding (only when a render came out untagged).
async function tagBt709(file) {
  const fixed = file.replace(/\.mp4$/, '.tagged.mp4');
  await ffmpeg(['-i', file, '-c', 'copy', '-an', '-bsf:v',
    'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0', fixed]);
  fs.renameSync(fixed, file);
}

function cleanTmp(stem) {
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      if (name.startsWith(`${stem}.`) || name.startsWith(`.${stem}.`)) removeTree(path.join(tmpDir, name));
    }
    if (!fs.readdirSync(tmpDir).length) fs.rmdirSync(tmpDir);
  } catch { /* nothing to clean */ }
}

function place(tmpFile, finalFile) {
  try {
    fs.renameSync(tmpFile, finalFile);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
      throw new Error(`cannot replace ${rel(finalFile)}: it is open in another program. Close the player and render again.`);
    }
    throw e;
  }
}

// ---------- the engine's gates ----------
const short = (s, n = 160) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };

async function lint(dir) {
  const r = await engineJson(['lint', dir, '--json'], { timeoutMs: 120000 });
  if (!r.json || !Array.isArray(r.json.findings)) return { ran: false, error: `the engine's lint did not run: ${short(tail(r.stderr || r.stdout, 3), 300)}` };
  const errors = r.json.findings.filter((f) => f.severity === 'error').map((f) => ({ code: f.code, message: short(f.message, 260), fix: short(f.fixHint, 200) }));
  const warnings = r.json.findings.filter((f) => f.severity === 'warning').map((f) => `lint ${f.code}: ${short(f.message, 200)}`);
  return { ran: true, errors, warnings };
}

// The engine's `check` in one browser session: runtime (script errors, files that fail to load), layout (text
// outside the frame or its box) and contrast. Findings are grouped by code so a noisy scene stays readable.
async function gate(dir) {
  const started = Date.now();
  const r = await engineJson(['check', dir, '--json', '--timeout', '15000'], { timeoutMs: 240000 });
  const j = r.json;
  if (!j || j.error || !j.runtime) return { ran: false, error: short(j?.error || tail(r.stderr || r.stdout, 3) || 'no output', 300) };
  const findings = {};
  let errors = 0, warnings = 0;
  for (const part of ['runtime', 'layout', 'contrast', 'motion']) {
    const groups = new Map();
    for (const f of j[part]?.findings || []) {
      if (f.severity !== 'error' && f.severity !== 'warning') continue;
      if (f.severity === 'error') errors++; else warnings++;
      const key = `${f.severity} ${f.code}`;
      if (!groups.has(key)) groups.set(key, { level: f.severity, code: f.code, count: 0, examples: [] });
      const g = groups.get(key);
      g.count++;
      const ex = { t: f.time, selector: short(f.selector, 80), text: f.text ? short(f.text, 40) : undefined, message: short(f.message, 180), fix: f.fixHint ? short(f.fixHint, 180) : undefined };
      if (g.examples.length < 3 && !g.examples.some((e) => e.selector === ex.selector && e.message === ex.message)) g.examples.push(ex);
    }
    if (groups.size) findings[part] = [...groups.values()];
  }
  return { ran: true, seconds: round((Date.now() - started) / 1000, 1), errors, warnings, findings };
}

// ---------- rendering ----------
const draftFps = () => (fps % 2 === 0 && fps >= 24 ? fps / 2 : fps);

async function renderWithEngine(dir, rawFile, captureFps, frames) {
  const limit = (userTimeout !== null ? userTimeout : Math.max(240, Math.ceil(frames * 1.5))) * 1000;
  const base = ['render', dir, '-o', rawFile, '--fps', String(captureFps), '--quality', draft ? 'draft' : 'looks', '--sdr'];
  // A draft starts two browsers: measured on a 6 s scene, the engine's automatic choice (five) spent 17 s starting
  // them on a machine with little free memory, and the whole draft took 42 s instead of 13 s.
  const w = workers || (draft ? '2' : null);
  const tries = [
    { args: w ? [...base, '--workers', w] : base, timeoutMs: limit },
    { args: [...base, '--low-memory-mode'], timeoutMs: limit * 2 }, // one browser, the slow and safe capture
  ];
  let last = null;
  for (const [i, tryIt] of tries.entries()) {
    try { fs.unlinkSync(rawFile); } catch { /* not there */ }
    const r = await engine(tryIt.args, { timeoutMs: tryIt.timeoutMs, stallMs: STALL_MS });
    if (r.code === 0 && !r.timedOut && !r.stalled && fs.existsSync(rawFile)) {
      const phases = (r.stdout.match(/compile [\d.]+s[^\r\n]*/) || [])[0] || null; // the engine's own time per phase
      return { ok: true, attempts: i + 1, phases: phases ? phases.trim() : null };
    }
    last = r.timedOut ? `the render passed its time limit of ${Math.round(tryIt.timeoutMs / 1000)} s`
      : r.stalled ? `the render stopped making progress for ${STALL_MS / 1000} s`
        : `the engine failed (exit ${r.code}): ${short(tail(`${r.stdout}\n${r.stderr}`, 6), 600)}`;
    if (i === 0) note(`  ${last}. Trying once more in low-memory mode.`);
  }
  return { ok: false, attempts: tries.length, error: last };
}

async function renderMotion(scene, state, wantBlur, blurSet = { samples: 4, shutter: 1 }) {
  const res = { warnings: [] };
  const info = compositionInfo(state.dir);
  if (!info.ok) return { ...res, error: info.error };
  if (info.duration === null || !(info.duration > 0)) return { ...res, error: 'the root element has no data-duration' };
  if (info.width !== project.width || info.height !== project.height) {
    return { ...res, error: `the composition is ${info.width}x${info.height} but the project is ${project.width}x${project.height}` };
  }
  const frames = Math.ceil(info.duration * fps - 1e-6); // the engine renders every started frame
  if (frames !== scene.frames) {
    const d = frames - scene.frames;
    res.warnings.push(`the composition is ${frames} frames (${info.duration} s) but its slot in the scene list is ${scene.frames} frames: the cut will ${d > 0 ? `drop its last ${d} frames` : `hold its last frame for ${-d} frames`}. Make data-duration ${secondsForFrames(scene.frames, fps)}.`);
  }

  const l = await lint(state.dir);
  if (!l.ran) return { ...res, error: l.error };
  res.warnings.push(...l.warnings);
  if (l.errors.length) return { ...res, error: `lint found ${l.errors.length} error(s); the scene was not rendered`, lint: l.errors };

  if (runCheck) {
    const cached = state.record && state.record.gate && state.record.gate.hash === state.inputs.hash ? state.record.gate : null;
    if (cached) res.gate = { ...cached, cached: true };
    else {
      note(`  checking ${scene.id}`);
      res.gate = { ...(await gate(state.dir)), hash: state.inputs.hash };
      writeRecord(root, scene.id, { ...(readRecords(root)[scene.id] || {}), gate: res.gate });
    }
  }

  const blur = wantBlur && !draft;
  if (wantBlur && draft) res.warnings.push('motion blur is skipped in a draft');
  const period = Math.round(blurSet.samples / blurSet.shutter); // sub-frames captured per output frame
  if (blur && fps * period > MAX_CAPTURE_FPS) {
    return { ...res, error: `motion blur with ${blurSet.samples} samples over ${blurSet.shutter} of the frame needs ${fps * period} fps; the engine captures at most ${MAX_CAPTURE_FPS}. Use fewer samples or --shutter 1.` };
  }
  const captureFps = blur ? fps * period : draft ? draftFps() : fps;
  const captureFrames = Math.ceil(info.duration * captureFps - 1e-6);
  fs.mkdirSync(tmpDir, { recursive: true });
  const stem = `${scene.id}-${process.pid}`;
  const raw = path.join(tmpDir, `${stem}.raw.mp4`);
  const done = path.join(tmpDir, `${stem}.done.mp4`);
  try {
    note(`  rendering ${scene.id}: ${captureFrames} frames at ${captureFps} fps${blur ? ` (motion blur, ${blurSet.samples} samples over ${blurSet.shutter} of the frame)` : draft ? ' (draft)' : ''}`);
    const r = await renderWithEngine(state.dir, raw, captureFps, captureFrames);
    res.attempts = r.attempts;
    res.phases = r.phases;
    if (!r.ok) return { ...res, error: r.error };
    if (blur) {
      // Four sub-frames become one frame: a real shutter.
      // Average the first `samples` captures of every `period`: with 4 and 4 that is the classic full shutter,
      // with 4 and 8 the samples cover half the frame, which keeps fast text readable.
      await ffmpeg(['-i', raw, '-vf', `tmix=frames=${blurSet.samples},select='eq(mod(n,${period}),${blurSet.samples - 1})',setpts=N/(${fps}*TB),fps=${fps},tpad=stop_mode=clone:stop=1,format=yuv420p,${BT709_FILTER}`,
        '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-r', String(fps), '-frames:v', String(frames), done]);
    } else if (captureFps !== fps) {
      // A draft was captured at half rate: repeat frames up to the project rate so every tool sees the same shape.
      await ffmpeg(['-i', raw, '-vf', `fps=${fps},tpad=stop_mode=clone:stop=2,format=yuv420p,${BT709_FILTER}`,
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-r', String(fps), '-frames:v', String(frames), done]);
    } else {
      fs.renameSync(raw, done);
    }
    let m = await probe(done);
    if (m.hasVideo && m.pixFmt === 'yuv420p' && (m.transfer !== 'bt709' || m.primaries !== 'bt709')) {
      await tagBt709(done);
      m = await probe(done);
    }
    const bad = verify(m, frames);
    if (bad.length) return { ...res, error: `the render is not valid: ${bad.join('; ')}` };
    place(done, state.file);
    return { ...res, frames, mblur: blur, ...(blur ? { mblurSamples: blurSet.samples, shutter: blurSet.shutter } : {}) };
  } finally {
    cleanTmp(stem);
  }
}

// A footage scene with an overlay is rendered and composited by footage.mjs (its own tool).
async function renderOverlay(scene, state) {
  const res = { warnings: [] };
  const script = process.env.FOCUS_MOTION_FOOTAGE_SCRIPT || path.join(SKILL_ROOT, 'scripts', 'footage.mjs');
  if (!fs.existsSync(script)) return { ...res, error: `footage.mjs was not found at ${fwd(script)}, so a footage scene cannot be rendered` };
  if (!fs.existsSync(path.join(state.dir, 'index.html'))) return { ...res, error: `scenes/${scene.id}/index.html is missing. Create it: project.mjs add-scene <project> ${scene.id} --kind footage` };
  if (!scene.clip || !fs.existsSync(path.resolve(root, scene.clip))) return { ...res, error: `the footage clip ${scene.clip || '(none)'} is missing. Cut it first: footage.mjs cut <project>` };
  const l = await lint(state.dir);
  if (!l.ran) return { ...res, error: l.error };
  res.warnings.push(...l.warnings);
  if (l.errors.length) return { ...res, error: `lint found ${l.errors.length} error(s); the scene was not rendered`, lint: l.errors };

  const before = fs.existsSync(state.file) ? fs.statSync(state.file).mtimeMs : 0;
  const limit = (userTimeout !== null ? userTimeout : Math.max(480, scene.frames * 3)) * 1000;
  note(`  footage overlay ${scene.id}: ${scene.frames} frames${draft ? ' (draft)' : ''}`);
  const extra = [...(draft ? ['--draft'] : []), ...(workers ? ['--workers', workers] : [])];
  const r = await run(process.execPath, [script, 'overlay', root, scene.id, ...extra], { timeoutMs: limit });
  let reply = null;
  for (const line of String(r.stdout).split(/\r?\n/).reverse()) {
    if (line.trim().startsWith('{')) { try { reply = JSON.parse(line); break; } catch { /* not the JSON line */ } }
  }
  if (r.timedOut) return { ...res, error: `footage.mjs overlay passed its time limit of ${Math.round(limit / 1000)} s` };
  if (r.code !== 0) return { ...res, error: `footage.mjs overlay failed (exit ${r.code}): ${short(reply?.error || tail(r.stderr, 4), 500)}` };
  if (!fs.existsSync(state.file) || fs.statSync(state.file).mtimeMs <= before) return { ...res, error: 'footage.mjs overlay reported success but did not write renders/' + scene.id + '.mp4' };
  const m = await probe(state.file);
  const bad = verify(m, null);
  if (bad.length) return { ...res, error: `the overlay render is not valid: ${bad.join('; ')}` };
  if (m.frames !== scene.frames) res.warnings.push(`the render has ${m.frames} frames but the slot is ${scene.frames}: the cut will ${m.frames > scene.frames ? 'drop the extra frames' : 'hold the last frame'}`);
  if (Array.isArray(reply?.warnings)) res.warnings.push(...reply.warnings.map((w) => `footage: ${short(w, 200)}`));
  return { ...res, frames: m.frames, mblur: false };
}

// A footage scene without an overlay: the cut clip itself, brought to the project's size, rate and colour.
async function renderPlainFootage(scene, state) {
  const res = { warnings: [] };
  const clip = scene.clip ? path.resolve(root, scene.clip) : null;
  if (!clip || !fs.existsSync(clip)) return { ...res, error: `the footage clip ${scene.clip || '(none)'} is missing. Cut it first: footage.mjs cut <project>` };
  const src = await probe(clip);
  if (!src.hasVideo) return { ...res, error: `${scene.clip} has no video` };
  if (src.hdr) return { ...res, error: `${scene.clip} is HDR. Normalize the footage first: footage.mjs normalize` };
  fs.mkdirSync(tmpDir, { recursive: true });
  const stem = `${scene.id}-${process.pid}`;
  const done = path.join(tmpDir, `${stem}.done.mp4`);
  try {
    const { width: w, height: h } = project;
    note(`  conforming footage ${scene.id}`);
    await ffmpeg(['-i', clip, '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},fps=${fps},format=yuv420p,${BT709_FILTER}`,
      '-an', '-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'medium', '-crf', draft ? '22' : '14', '-r', String(fps), done]);
    const m = await probe(done);
    const bad = verify(m, null);
    if (bad.length) return { ...res, error: `the conformed clip is not valid: ${bad.join('; ')}` };
    if (m.frames !== scene.frames) res.warnings.push(`the clip has ${m.frames} frames but the slot is ${scene.frames}: the cut will ${m.frames > scene.frames ? 'drop the extra frames' : 'hold the last frame'}`);
    place(done, state.file);
    return { ...res, frames: m.frames, mblur: false };
  } finally {
    cleanTmp(stem);
  }
}

// ---------- run ----------
lock();
const started = Date.now();
const results = [];
for (const scene of selected) {
  const state = sceneState(root, project, scene);
  const record = state.record;
  const wantBlur = scene.kind === 'motion' && !blurOff && (blurArg.includes(scene.id) || scene.mblur === true || Boolean(record && record.mblur));
  const row = { id: scene.id, kind: scene.kind };
  // The blur settings: from this run's flags, else the ones the scene was last blurred with, else 4 over a full frame.
  const kept = record && record.mblur ? record : {};
  const blurSet = { samples: samplesArg || kept.mblurSamples || 4, shutter: shutterArg || kept.shutter || 1 };
  const sameBlur = !wantBlur || ((record && record.mblurSamples) || 4) === blurSet.samples && ((record && record.shutter) || 1) === blurSet.shutter;
  const blurInfo = (r) => (r && r.mblur ? { mblurSamples: r.mblurSamples || 4, shutter: r.shutter || 1 } : {});

  // --changed: a render that still matches its scene is kept. A final render also answers a draft request.
  const fresh = state.rendered && !state.stale && record
    && (draft || (record.quality === 'final' && Boolean(record.mblur) === wantBlur && sameBlur));
  if (args.changed && fresh) {
    results.push({ ...row, status: 'skipped', reason: 'up to date', quality: record.quality, mblur: Boolean(record.mblur), ...blurInfo(record), file: rel(state.file) });
    continue;
  }

  const t0 = Date.now();
  let r;
  try {
    if (scene.kind === 'footage') r = scene.overlay ? await renderOverlay(scene, state) : await renderPlainFootage(scene, state);
    else if (!state.exists) r = { warnings: [], error: `scenes/${scene.id}/index.html is missing. Create it: project.mjs add-scene <project> ${scene.id}` };
    else r = await renderMotion(scene, state, wantBlur, blurSet);
  } catch (e) {
    r = { warnings: [], error: short(e.message || String(e), 700) };
  }
  const seconds = round((Date.now() - t0) / 1000, 1);
  if (r.error) {
    note(`  ${scene.id} failed: ${r.error}`);
    results.push({ ...row, status: 'failed', error: r.error, lint: r.lint, gate: r.gate, warnings: r.warnings, seconds });
    continue;
  }
  const gateRecord = r.gate || (record && record.gate && record.gate.hash === state.inputs.hash ? record.gate : undefined);
  writeRecord(root, scene.id, {
    ...state.inputs, quality, mblur: r.mblur, ...blurInfo(r), frames: r.frames, slotFrames: scene.frames,
    seconds, engine: ENGINE_VERSION, at: new Date().toISOString(), ...(gateRecord ? { gate: gateRecord } : {}),
  });
  note(`  ${scene.id} done in ${seconds} s`);
  results.push({
    ...row, status: 'rendered', quality, mblur: r.mblur, ...blurInfo(r), file: rel(state.file), frames: r.frames, seconds,
    attempts: r.attempts, engineTimes: r.phases || undefined, gate: r.gate, warnings: r.warnings,
  });
}

const pick = (status) => results.filter((x) => x.status === status).map((x) => x.id);
const failed = pick('failed');
out({
  ok: failed.length === 0,
  project: fwd(root), quality, fps,
  rendered: pick('rendered'), skipped: pick('skipped'), failed,
  seconds: round((Date.now() - started) / 1000, 1),
  scenes: results,
});
process.exitCode = failed.length ? 1 : 0; // no process.exit(): the JSON line must leave the pipe first
