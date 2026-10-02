#!/usr/bin/env node
// project.mjs: creates a video project folder and keeps its scene list, its media and its status.
//
// Usage:
//   node project.mjs init <slug> [--format reel|square|wide] [--track idea|voice|footage] [--title "..."] [--fps 30]
//                    [--fonts "Rubik,Heebo"] [--language he]
//   node project.mjs add-scene <project> <id> [--kind motion|footage] [--duration 4] [--fonts "Rubik,Heebo"]
//   node project.mjs set-scenes <project> <file.json>
//   node project.mjs status <project>
//   node project.mjs ingest <project> <path...> [--move] [--as video|photos|audio|brand|other]
//
// init        makes <slug>/ in the current folder: project.json, source/{video,photos,audio,brand,other}/, work/,
//             audio/, scenes/, renders/, _versions/. <slug> may be a path; its last part is the project name.
// add-scene   copies the scene template into scenes/<id>/ and fills the size, the id, the length and the fonts.
//             An id that is not in the scene list yet is appended to it (--duration seconds, 4 by default).
// set-scenes  replaces the scene list with the JSON array in the file, after checking that it is contiguous.
// status      lists each scene: exists, rendered, stale, draft or final.
// ingest      copies the user's files and folders into source/<type>/ under safe names and measures them into
//             source/media.json. The originals are never changed (--move only when the user asked for it).
//
// Example:
//   node project.mjs init launch-video --format reel --track voice --title "סרטון השקה"
import fs from 'node:fs';
import path from 'node:path';
import {
  FORMATS, fwd, readJson, writeJson, out, note, die, parseArgs, loadProject, saveProject, mediaInfo, findTool, toFrames,
} from './lib/common.mjs';
import {
  SCENE_ID, KINDS, timeline, validateScenes, createScene, compositionInfo, sceneState, checkFonts, defaultFont,
  secondsForFrames,
} from './lib/scenes.mjs';
import { showUsage, round, stamp, freePath } from './lib/cli.mjs';

const TRACKS = ['idea', 'voice', 'footage'];
const FPS_OK = [24, 25, 30, 50, 60];
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SOURCE_TYPES = ['video', 'photos', 'audio', 'brand', 'other'];
const FOLDERS = [...SOURCE_TYPES.map((t) => `source/${t}`), 'work', 'audio', 'scenes', 'renders', '_versions'];

// What a new project of each track does by default. Claude edits `features` in project.json by hand afterwards.
const FEATURES = {
  idea: { captions: false, cuts: false, graphics: true, music: false, sfx: true, voicePolish: false, lookTest: true },
  voice: { captions: false, cuts: false, graphics: true, music: false, sfx: true, voicePolish: true, lookTest: true },
  footage: { captions: true, cuts: true, graphics: true, music: false, sfx: true, voicePolish: true, lookTest: true },
};

const EXT_TYPES = {
  video: ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'],
  photos: ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif'],
  audio: ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'],
  brand: ['.svg'],
};
const LARGE_BYTES = 1024 ** 3; // a file this big is worth telling the user about
const LIST_MAX = 60;           // the most files one JSON line lists
const JUNK = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

const args = parseArgs(process.argv.slice(2), { booleans: ['help', 'move'], aliases: { h: 'help' } });
const [command] = args._;
if (args.help) showUsage(import.meta.url, 0);
if (!command) showUsage(import.meta.url, 2);

const rel = (root, p) => fwd(path.relative(root, p));
const fontList = (text) => String(text).split(',').map((s) => s.trim()).filter(Boolean);

// ---------- init ----------
function suggestSlug(name) {
  const s = name.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s || 'my-video';
}

function init() {
  const target = args._[1];
  if (!target) showUsage(import.meta.url, 2, 'init needs a project name');
  const root = path.resolve(String(target));
  const name = path.basename(root);
  if (!SLUG.test(name)) {
    die(`"${name}" cannot be a project name. Use lowercase English letters, digits and hyphens, for example "${suggestSlug(name)}". The Hebrew name goes in --title.`, 2);
  }
  const format = String(args.format || 'reel');
  if (!FORMATS[format]) die(`unknown format "${format}". Use reel (1080x1920), square (1080x1080) or wide (1920x1080).`, 2);
  const track = String(args.track || 'idea');
  if (!TRACKS.includes(track)) die(`unknown track "${track}". Use idea, voice or footage.`, 2);
  const fps = Number(args.fps === undefined ? 30 : args.fps);
  if (!FPS_OK.includes(fps)) die(`fps must be one of ${FPS_OK.join(', ')}.`, 2);
  let fonts = [defaultFont()];
  if (args.fonts !== undefined && args.fonts !== true) {
    fonts = fontList(args.fonts);
    // A library name is checked now. The user's own file (Name=source/brand/x.otf) is checked when a scene is added,
    // because the project folder does not hold it yet.
    const names = fonts.filter((f) => !/=|\.(ttf|otf|woff2?)$/i.test(f));
    try { checkFonts(names, root); } catch (e) { die(e.message, 2); }
    if (!fonts.length) fonts = [defaultFont()];
  }
  if (fs.existsSync(path.join(root, 'project.json'))) die(`a project already exists in ${fwd(root)}. Nothing was changed.`, 1);
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) die(`${fwd(root)} is a file, not a folder.`, 2);

  for (const f of FOLDERS) fs.mkdirSync(path.join(root, f), { recursive: true });
  const project = {
    name,
    title: args.title === undefined || args.title === true ? name : String(args.title),
    track,
    format, width: FORMATS[format].width, height: FORMATS[format].height, fps,
    language: String(args.language || 'he'),
    version: 1,
    fonts,
    features: { ...FEATURES[track] },
    scenes: [],
  };
  saveProject(root, project);
  out({ ok: true, project: fwd(root), ...project, folders: FOLDERS });
}

// ---------- add-scene ----------
async function addScene() {
  const [, dirArg, id] = args._;
  if (!dirArg || !id) showUsage(import.meta.url, 2, 'add-scene needs a project and a scene id');
  const { root, project } = loadProject(dirArg);
  if (!SCENE_ID.test(String(id))) die(`"${id}" cannot be a scene id. Use letters, digits, - or _, for example s01.`, 2);
  if (args.kind !== undefined && !KINDS.includes(String(args.kind))) die('--kind must be motion or footage.', 2);
  const fps = Number(project.fps) || 30;
  const t = timeline(project);
  const listed = t.scenes.find((s) => s.id === id);
  const kind = String(args.kind || (listed && listed.kind) || 'motion');
  const fonts = args.fonts !== undefined ? fontList(args.fonts) : null;

  let frames, added = false;
  const scenes = Array.isArray(project.scenes) ? project.scenes.map((s) => ({ ...s })) : [];
  let entry = scenes.find((s) => s.id === id);
  if (entry) {
    frames = listed.frames;
    entry.kind = kind;
  } else {
    const seconds = Number(args.duration === undefined ? 4 : args.duration);
    if (!isFinite(seconds) || seconds <= 0) die('--duration must be a positive number of seconds.', 2);
    frames = Math.max(1, toFrames(seconds, fps));
    const start = scenes.length ? Number(scenes[scenes.length - 1].end) : 0;
    entry = { id, kind, start, end: round(start + frames / fps, 4) };
    scenes.push(entry);
    added = true;
  }
  if (kind === 'footage') {
    if (!entry.clip) entry.clip = `work/base/${id}.mp4`;
    entry.overlay = true; // a scene folder for a footage scene is an overlay over the clip
  }

  let made;
  try {
    made = await createScene({ root, project, id, duration: frames / fps, kind, fonts });
  } catch (e) {
    die(e.message, /already exists/.test(e.message) ? 1 : 2);
  }
  project.scenes = scenes;
  saveProject(root, project);
  const warnings = [];
  if (made.gsapNote) warnings.push(made.gsapNote);
  if (kind === 'footage' && !fs.existsSync(path.resolve(root, entry.clip))) {
    warnings.push(`the footage clip ${entry.clip} does not exist yet; cut it before rendering this scene`);
  }
  out({
    ok: true, id, kind,
    scene: rel(root, made.dir), index: `${rel(root, made.dir)}/index.html`,
    start: entry.start, end: entry.end, duration: secondsForFrames(frames, fps), frames,
    width: project.width, height: project.height, fps,
    fonts: made.fonts, gsap: made.gsap, addedToList: added, warnings,
  });
}

// ---------- set-scenes ----------
function setScenes() {
  const [, dirArg, fileArg] = args._;
  if (!dirArg || !fileArg) showUsage(import.meta.url, 2, 'set-scenes needs a project and a JSON file');
  const { root, project } = loadProject(dirArg);
  const file = path.resolve(String(fileArg));
  if (!fs.existsSync(file)) die(`not found: ${fwd(file)}`, 2);
  let data;
  try { data = readJson(file); } catch (e) { die(e.message, 2); }
  const list = Array.isArray(data) ? data : data && data.scenes;
  const fps = Number(project.fps) || 30;
  const { errors, scenes } = validateScenes(list, fps);
  if (errors.length) {
    out({ ok: false, error: 'the scene list is not valid; project.json was not changed', errors });
    process.exit(1);
  }
  let backup = null;
  if (Array.isArray(project.scenes) && project.scenes.length) {
    backup = freePath(path.join(root, '_versions', `scenes-${stamp()}.json`));
    writeJson(backup, project.scenes);
  }
  project.scenes = scenes;
  saveProject(root, project);

  const t = timeline(project);
  const warnings = [];
  const rows = t.scenes.map((s) => {
    const dir = path.join(root, 'scenes', s.id);
    const folder = fs.existsSync(path.join(dir, 'index.html'));
    const row = { id: s.id, kind: s.kind, start: s.start, end: s.end, frames: s.frames, exists: folder };
    if (folder) {
      const info = compositionInfo(dir);
      const want = s.frames / fps;
      if (info.ok && info.duration !== null && Math.abs(info.duration - want) > 0.5 / fps) {
        row.compositionDuration = info.duration;
        warnings.push(`${s.id}: the slot is ${round(want)} s but scenes/${s.id}/index.html says data-duration="${info.duration}". Update the composition (data-duration, DUR and the timeline).`);
      }
    }
    return row;
  });
  const ids = new Set(t.scenes.map((s) => s.id));
  let orphans = [];
  try {
    orphans = fs.readdirSync(path.join(root, 'scenes'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !ids.has(e.name)).map((e) => e.name);
  } catch { /* no scenes folder */ }
  if (orphans.length) warnings.push(`scene folders that are not in the list (left in place): ${orphans.join(', ')}`);
  out({
    ok: true, scenes: rows, count: rows.length, frames: t.totalFrames, duration: round(t.duration),
    missing: rows.filter((r) => !r.exists && r.kind === 'motion').map((r) => r.id),
    orphans, previousList: backup ? rel(root, backup) : null, warnings,
  });
}

// ---------- status ----------
function status() {
  const { root, project } = loadProject(args._[1]);
  const t = timeline(project);
  const scenes = t.scenes.map((s) => {
    const st = sceneState(root, project, s);
    const row = {
      id: s.id, kind: s.kind, start: s.start, end: s.end, frames: s.frames,
      exists: st.exists, rendered: st.rendered, stale: st.stale, quality: st.quality,
    };
    if (st.mblur) row.mblur = true;
    if (st.reason) row.reason = st.reason;
    if (s.kind === 'footage') { row.clip = s.clip || null; row.overlay = Boolean(s.overlay); }
    if (s.note) row.note = s.note;
    return row;
  });
  const count = (fn) => scenes.filter(fn).length;
  const cutName = `${project.name}-v${project.version || 1}`;
  const cutFile = path.join(root, `${cutName}.mp4`);
  const notesFile = path.join(root, `${cutName}.notes.json`);
  const has = (p) => fs.existsSync(path.join(root, p));
  const media = readJson(path.join(root, 'source', 'media.json'), []);
  const mediaCounts = Object.fromEntries(SOURCE_TYPES.map((type) => [type, media.filter((m) => m.type === type).length]));
  const needRender = scenes.filter((s) => !s.rendered || s.stale).map((s) => s.id);
  out({
    ok: true,
    project: fwd(root),
    name: project.name, title: project.title, track: project.track, format: project.format,
    width: project.width, height: project.height, fps: t.fps, language: project.language || 'he',
    version: project.version || 1,
    fonts: project.fonts || [defaultFont()],
    features: project.features || {},
    duration: round(t.duration), frames: t.totalFrames,
    scenes,
    counts: {
      scenes: scenes.length, exist: count((s) => s.exists), rendered: count((s) => s.rendered),
      stale: count((s) => s.stale), draft: count((s) => s.quality === 'draft'), final: count((s) => s.quality === 'final'),
    },
    needRender,
    cut: { file: `${cutName}.mp4`, exists: fs.existsSync(cutFile), notes: fs.existsSync(notesFile) ? readJson(notesFile, []).length : 0 },
    audio: { voice: has('audio/voice.wav'), words: has('audio/words.json'), cues: has('audio/cues.json'), mix: has('audio/mix.wav') },
    media: mediaCounts,
  });
}

// ---------- ingest ----------
// A file name that no tool chokes on: Hebrew and other letters stay, everything else becomes a hyphen.
function safeName(name) {
  const ext = path.extname(name);
  let base = path.basename(name, ext).normalize('NFC')
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '') // invisible direction marks
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (!base) base = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`; // reserved on Windows
  return base.slice(0, 80) + ext.toLowerCase().replace(/[^.a-z0-9]/g, '');
}

function typeByExt(file) {
  const ext = path.extname(file).toLowerCase();
  for (const [type, list] of Object.entries(EXT_TYPES)) if (list.includes(ext)) return type;
  return 'other';
}

function collect(p, found) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p).sort()) {
      if (e.startsWith('.') || JUNK.has(e.toLowerCase()) || e === 'node_modules') continue;
      collect(path.join(p, e), found);
    }
  } else if (st.isFile() && !JUNK.has(path.basename(p).toLowerCase())) {
    found.push({ src: p, bytes: st.size, mtime: st.mtime });
  }
}

function moveFile(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to); // another drive: copy, then remove the original the user asked to move
    fs.unlinkSync(from);
  }
}

async function ingest() {
  const [, dirArg, ...inputs] = args._;
  if (!dirArg || !inputs.length) showUsage(import.meta.url, 2, 'ingest needs a project and at least one file or folder');
  const { root } = loadProject(dirArg);
  const forced = args.as === undefined ? null : String(args.as);
  if (forced && !SOURCE_TYPES.includes(forced)) die(`--as must be one of ${SOURCE_TYPES.join(', ')}.`, 2);
  const sourceDir = path.join(root, 'source');
  for (const type of SOURCE_TYPES) fs.mkdirSync(path.join(sourceDir, type), { recursive: true });

  const found = [], missing = [];
  for (const input of inputs) {
    const p = path.resolve(String(input));
    if (!fs.existsSync(p)) { missing.push(fwd(p)); continue; }
    collect(p, found);
  }
  if (!found.length && missing.length) die(`not found: ${missing.join(', ')}`, 2);

  const canProbe = Boolean(findTool('ffprobe'));
  const mediaFile = path.join(sourceDir, 'media.json');
  const media = readJson(mediaFile, []);
  const added = [], skipped = [];
  const inside = (p, dir) => { const r = path.relative(dir, p); return Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r); };

  for (const [i, f] of found.entries()) {
    const original = fwd(f.src);
    if (path.resolve(f.src) === path.resolve(mediaFile)) continue;
    if (inside(f.src, root) && !inside(f.src, sourceDir)) { skipped.push({ original, reason: 'inside the project, outside source/' }); continue; }

    const known = media.find((m) => m.original === original && m.bytes === f.bytes && fs.existsSync(path.join(root, m.file)));
    if (known) { skipped.push({ original, reason: `already in the project as ${known.file}` }); continue; }

    // What is it? The extension decides first; a probe corrects a "video" that only carries sound.
    let type = forced || typeByExt(f.src);
    let facts = null, readable = true;
    if (canProbe && (['video', 'audio', 'photos'].includes(typeByExt(f.src)))) {
      try { facts = await mediaInfo(f.src); } catch { readable = false; }
      if (!forced && facts && type === 'video' && !facts.hasVideo && facts.hasAudio) type = 'audio';
    }

    const wanted = path.join(sourceDir, type, safeName(path.basename(f.src)));
    let dest, how;
    if (path.resolve(f.src) === path.resolve(wanted)) {
      dest = wanted; how = 'registered'; // already in its place: only measure it
    } else {
      dest = freePath(wanted);
      if (inside(f.src, sourceDir)) { moveFile(f.src, dest); how = 'organized'; } // dropped into source/: put it in its folder
      else if (args.move) { moveFile(f.src, dest); how = 'moved'; }
      else {
        note(`copy ${i + 1}/${found.length}: ${path.basename(f.src)}`);
        fs.copyFileSync(f.src, dest);
        try { fs.utimesSync(dest, new Date(), f.mtime); } catch { /* the date is a nicety */ }
        how = 'copied';
      }
    }
    const isMedia = type === 'video' || type === 'audio';
    const entry = {
      file: rel(root, dest), type, original, bytes: f.bytes,
      duration: facts && isMedia ? round(facts.duration) : null,
      width: facts && facts.hasVideo ? facts.width : null,
      height: facts && facts.hasVideo ? facts.height : null,
      fps: facts && type === 'video' ? facts.fps : null,
      rotation: facts && type === 'video' ? facts.rotation : null,
      hdr: facts && type === 'video' ? facts.hdr : null,
      hasAudio: facts && isMedia ? facts.hasAudio : null,
    };
    if (!readable) entry.unreadable = true;
    const at = media.findIndex((m) => m.file === entry.file);
    if (at >= 0) media[at] = entry; else media.push(entry);
    added.push({ ...entry, how });
  }
  writeJson(mediaFile, media);

  const names = (fn) => added.filter(fn).map((e) => e.file);
  const counts = (list) => Object.fromEntries(SOURCE_TYPES.map((type) => [type, list.filter((e) => e.type === type).length]));
  const videoSeconds = (list) => round(list.filter((e) => e.type === 'video').reduce((sum, e) => sum + (e.duration || 0), 0), 1);
  const warnings = [];
  if (!canProbe) warnings.push('ffprobe was not found, so the files were filed but not measured. Run the doctor, then ingest again.');
  if (missing.length) warnings.push(`not found: ${missing.join(', ')}`);
  out({
    ok: true,
    added: added.length, skipped: skipped.length,
    counts: counts(added),
    videoSeconds: videoSeconds(added),
    flags: {
      hdr: names((e) => e.hdr === true),
      noAudio: names((e) => e.type === 'video' && e.hasAudio === false),
      rotated: names((e) => e.type === 'video' && Boolean(e.rotation)),
      large: names((e) => e.bytes >= LARGE_BYTES),
      unreadable: names((e) => e.unreadable === true),
    },
    files: added.slice(0, LIST_MAX),
    skippedFiles: skipped.slice(0, LIST_MAX),
    listsCut: added.length > LIST_MAX || skipped.length > LIST_MAX, // the full list is always in source/media.json
    totals: { ...counts(media), videoSeconds: videoSeconds(media) },
    media: rel(root, mediaFile),
    warnings,
  });
}

// ---------- run ----------
const commands = { init, 'add-scene': addScene, 'set-scenes': setScenes, status, ingest };
if (!commands[command]) showUsage(import.meta.url, 2, `unknown command "${command}"`);
try {
  await commands[command]();
} catch (e) {
  die(e.message || String(e), 1);
}
