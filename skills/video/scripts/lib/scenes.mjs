// Scene helpers shared by project.mjs, render.mjs, assemble.mjs and doctor.mjs: the fonts, the scene template,
// the timeline in whole frames, and the record of what was rendered from what.
//
//   import { timeline, sceneState, createScene } from './lib/scenes.mjs';
//   const t = timeline(project);            // { fps, totalFrames, duration, scenes: [{ id, startFrame, frames, ... }] }
//   const s = sceneState(root, project, t.scenes[0]);   // { exists, rendered, stale, quality, reason, ... }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKILL_ROOT, FORMATS, readJson, writeJson, fwd, toFrames } from './common.mjs';
import { installGsap, GSAP_CDN_URL } from './vendor.mjs';

export const TEMPLATE_DIR = path.join(SKILL_ROOT, 'assets', 'template', 'scene');
export const EXAMPLE_DIR = path.join(SKILL_ROOT, 'assets', 'examples', 'hello');
export const FONTS_DIR = path.join(SKILL_ROOT, 'assets', 'fonts');

// A scene id is a folder name and a file name: s01, s04b, intro-2.
export const SCENE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
export const KINDS = ['motion', 'footage'];

// The last filter of every re-encode. ffmpeg does not carry -color_primaries and -color_trc through a filter graph
// (measured on ffmpeg 8: the file comes out tagged "unknown"), and tmix drops the tags of its input, so the frames
// themselves are tagged SDR bt709 here.
export const BT709_FILTER = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';

// How far text stays from the edges, in pixels. `rightLow` is the right margin from y `rightLowFrom` down, where a
// reel carries the platform's like, comment and share buttons. The reel numbers come from the interface Instagram
// and TikTok paint over a 1080x1920 video: the header above y 250, the caption and name below y 1560, the buttons
// right of x 940 from y 1150. references/craft.md (safe areas) and build.md give the same numbers.
export const SAFE_ZONES = {
  reel: { top: 250, bottom: 360, left: 80, right: 80, rightLow: 140, rightLowFrom: 1150 },
  square: { top: 80, bottom: 80, left: 80, right: 80, rightLow: 80, rightLowFrom: 0 },
  wide: { top: 80, bottom: 110, left: 120, right: 120, rightLow: 120, rightLowFrom: 0 },
};

export function safeZone(project) {
  const { width, height } = project;
  for (const [name, f] of Object.entries(FORMATS)) {
    if (f.width === width && f.height === height) return SAFE_ZONES[name];
  }
  if (height > width) { // any other tall canvas: the reel margins, scaled
    const k = width / 1080, z = SAFE_ZONES.reel;
    return Object.fromEntries(Object.entries(z).map(([key, v]) => [key, Math.round(v * k)]));
  }
  const m = Math.round(Math.min(width, height) * 0.075);
  return { top: m, bottom: m, left: m, right: m, rightLow: m, rightLowFrom: 0 };
}

// ---------- fonts ----------
let fontCache;
function fontData() {
  if (!fontCache) fontCache = readJson(path.join(FONTS_DIR, 'fonts.json'));
  return fontCache;
}
export const fontLibrary = () => fontData().fonts;
export const defaultFont = () => fontData().default || 'Rubik';

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const FONT_FORMATS = { '.ttf': 'truetype', '.otf': 'opentype', '.woff2': 'woff2', '.woff': 'woff' };

// One entry of a font list is a family of the library ("Heebo"), or the user's own file: "Brand=source/brand/Brand.otf".
export function resolveFont(entry, projectRoot) {
  const text = String(entry).trim();
  const lib = fontLibrary().find((f) => squash(f.family) === squash(text) || f.dir === squash(text));
  if (lib) {
    return {
      family: lib.family,
      files: lib.files.map((f) => ({ src: path.join(FONTS_DIR, lib.dir, f.file), file: f.file, weight: f.weight, stretch: f.stretch })),
      library: true,
    };
  }
  const eq = text.indexOf('=');
  const file = eq > 0 ? text.slice(eq + 1).trim() : text;
  const ext = path.extname(file).toLowerCase();
  if (!FONT_FORMATS[ext]) return null;
  const src = path.resolve(projectRoot || '.', file);
  if (!fs.existsSync(src)) return null;
  const family = eq > 0 ? text.slice(0, eq).trim() : path.basename(file, path.extname(file));
  return { family, files: [{ src, file: path.basename(file) }], library: false };
}

export function fontFaceCss(font) {
  return font.files.map((f) => {
    const format = FONT_FORMATS[path.extname(f.file).toLowerCase()] || 'truetype';
    let rule = `@font-face { font-family: "${font.family}"; src: url("assets/${encodeURI(f.file)}") format("${format}");`;
    if (f.weight) rule += ` font-weight: ${f.weight};`;
    if (f.stretch) rule += ` font-stretch: ${f.stretch};`;
    return rule + ' }';
  }).join('\n      ');
}

// Resolves a font list. Throws one clear error when a name is not in the library and not a font file.
export function checkFonts(entries, projectRoot) {
  const fonts = [], unknown = [];
  for (const e of entries) {
    const f = resolveFont(e, projectRoot);
    if (!f) unknown.push(e);
    else if (!fonts.some((x) => x.family === f.family)) fonts.push(f);
  }
  if (unknown.length) {
    const names = fontLibrary().map((f) => f.family).join(', ');
    throw new Error(`unknown font: ${unknown.join(', ')}. The library has: ${names}. For your own file write Name=path/to/file.ttf`);
  }
  return fonts;
}

// Copies the font files into <sceneDir>/assets/ and returns the @font-face rules for them.
export function installFonts(sceneDir, entries, projectRoot) {
  const fonts = checkFonts(entries, projectRoot);
  const assets = path.join(sceneDir, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const font of fonts) for (const f of font.files) fs.copyFileSync(f.src, path.join(assets, f.file));
  return { families: fonts.map((f) => f.family), css: fonts.map(fontFaceCss).join('\n      ') };
}

// ---------- the template ----------
// Seconds for data-duration and DUR, rounded DOWN to 4 decimals. The engine renders ceil(duration x fps) frames, so
// rounding up adds a frame: 170 frames at 30 fps is 5.666..., and "5.667" renders 171 while "5.6666" renders 170.
export const secondsForFrames = (frames, fps) => Math.floor((frames / fps) * 1e4) / 1e4;
const secs = (n) => String(Math.floor(n * 1e4) / 1e4);

/**
 * Writes a scene's own values into the template's index.html.
 * v = { id, lang, width, height, duration, safe, fontsCss, family, gsapSrc, transparent }
 * Every anchor has to be found exactly once, so a template that was edited carelessly fails loudly.
 */
export function fillTemplate(html, v) {
  const once = (re, to, what) => {
    const n = (html.match(new RegExp(re.source, 'g')) || []).length;
    if (n !== 1) throw new Error(`the scene template changed: expected one "${what}", found ${n}`);
    html = html.replace(re, typeof to === 'function' ? to : () => to);
  };
  once(/<html lang="[^"]*">/, `<html lang="${v.lang}">`, 'html lang');
  once(/content="width=\d+, height=\d+"/, `content="width=${v.width}, height=${v.height}"`, 'viewport');
  once(/<script src="[^"]*gsap[^"]*"><\/script>/, `<script src="${v.gsapSrc}"></script>`, 'gsap script');
  once(/Scene s00\b/, `Scene ${v.id}`, 'scene name');
  once(/\/\* fonts:start \*\/[\s\S]*?\/\* fonts:end \*\//, `/* fonts:start */\n      ${v.fontsCss}\n      /* fonts:end */`, 'fonts block');
  once(/--w: \d+px; --h: \d+px;/, `--w: ${v.width}px; --h: ${v.height}px;`, 'canvas size');
  for (const [name, key] of [['top', 'top'], ['bottom', 'bottom'], ['left', 'left'], ['right', 'right'], ['right-low', 'rightLow'], ['right-low-from', 'rightLowFrom']]) {
    once(new RegExp(`--safe-${name}: \\d+px;`), `--safe-${name}: ${v.safe[key]}px;`, `--safe-${name}`);
  }
  if (v.transparent) once(/--stage-bg: [^;]+;/, '--stage-bg: transparent;', 'stage background');
  once(/(#root \{[^}]*font-family: )[^;]+;/, (_, pre) => `${pre}"${v.family}", sans-serif;`, '#root font-family');
  once(/data-duration="[^"]*" data-width="\d+" data-height="\d+"/,
    `data-duration="${secs(v.duration)}" data-width="${v.width}" data-height="${v.height}"`, 'root attributes');
  once(/const DUR = [\d.]+;/, `const DUR = ${secs(v.duration)};`, 'DUR');
  return html;
}

export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === '.gitkeep' || e.name === '.DS_Store') continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

/**
 * Creates scenes/<id>/ from the template. `duration` is in seconds and is already a whole number of frames.
 * Returns { dir, fonts, gsap: 'local' | 'cdn', gsapNote }. Throws when the folder exists or a font is unknown.
 */
export async function createScene({ root, project, id, duration, kind = 'motion', fonts }) {
  const dir = path.join(root, 'scenes', id);
  if (fs.existsSync(dir)) throw new Error(`scenes/${id} already exists; a scene is never overwritten`);
  const list = fonts && fonts.length ? fonts : (project.fonts && project.fonts.length ? project.fonts : [defaultFont()]);
  checkFonts(list, root); // before anything is written
  copyDir(TEMPLATE_DIR, dir);
  const f = installFonts(dir, list, root);
  const g = await installGsap(dir);
  const file = path.join(dir, 'index.html');
  const html = fillTemplate(fs.readFileSync(file, 'utf8'), {
    id,
    lang: project.language || 'he',
    width: project.width,
    height: project.height,
    duration,
    safe: safeZone(project),
    fontsCss: f.css,
    family: f.families[0],
    gsapSrc: g.mode === 'local' ? 'assets/gsap.min.js' : GSAP_CDN_URL,
    transparent: kind === 'footage',
  });
  fs.writeFileSync(file, html, 'utf8');
  writeJson(path.join(dir, 'meta.json'), { id, name: id, createdAt: new Date().toISOString() });
  writeJson(path.join(dir, 'package.json'), { name: id, private: true, type: 'module' });
  return {
    dir, fonts: f.families, gsap: g.mode,
    gsapNote: g.mode === 'local' ? null
      : `GSAP could not be downloaded (${g.error}). The scene loads it from ${GSAP_CDN_URL}, so rendering needs the network. When online, run the doctor, copy ~/.focus-motion/vendor/gsap.min.js into the scene's assets/ and set the script tag to assets/gsap.min.js.`,
  };
}

// ---------- what a composition says about itself ----------
export function compositionInfo(sceneDir) {
  const file = path.join(sceneDir, 'index.html');
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, error: `no index.html in ${fwd(sceneDir)}` }; }
  const tag = html.match(/<[a-z][a-z0-9]*\b[^>]*\bdata-composition-id\s*=\s*["'][^"']*["'][^>]*>/i);
  if (!tag) return { ok: false, error: 'index.html has no element with data-composition-id' };
  const attr = (name) => {
    const m = tag[0].match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
    return m ? m[1] : null;
  };
  const num = (name) => { const v = attr(name); return v === null || v === '' || isNaN(Number(v)) ? null : Number(v); };
  return {
    ok: true,
    id: attr('data-composition-id'),
    duration: num('data-duration'),
    width: num('data-width'),
    height: num('data-height'),
  };
}

// ---------- the timeline, in whole frames ----------
export function timeline(project) {
  const fps = Number(project.fps) || 30;
  const list = Array.isArray(project.scenes) ? project.scenes : [];
  const scenes = list.map((s, index) => {
    const startFrame = toFrames(Number(s.start) || 0, fps);
    const endFrame = toFrames(Number(s.end) || 0, fps);
    return { ...s, kind: s.kind || 'motion', index, startFrame, endFrame, frames: endFrame - startFrame };
  });
  const totalFrames = scenes.length ? scenes[scenes.length - 1].endFrame : 0;
  return { fps, scenes, totalFrames, duration: totalFrames / fps };
}

// Checks a scene list. Returns { errors, scenes }: `scenes` is the cleaned list, to be saved when errors is empty.
export function validateScenes(list, fps) {
  const errors = [];
  if (!Array.isArray(list) || !list.length) return { errors: ['the scene list is empty; it must be a JSON array of scenes'], scenes: [] };
  const seen = new Set();
  const scenes = [];
  list.forEach((raw, i) => {
    const at = `scene ${i + 1}${raw && raw.id ? ` (${raw.id})` : ''}`;
    if (!raw || typeof raw !== 'object') { errors.push(`${at}: not an object`); return; }
    const s = { ...raw };
    if (typeof s.id !== 'string' || !SCENE_ID.test(s.id)) errors.push(`${at}: id must be letters, digits, - or _ (for example s01)`);
    else if (seen.has(s.id.toLowerCase())) errors.push(`${at}: the id is used twice`);
    else seen.add(s.id.toLowerCase());
    s.kind = s.kind || 'motion';
    if (!KINDS.includes(s.kind)) errors.push(`${at}: kind must be motion or footage`);
    for (const k of ['start', 'end']) {
      if (typeof s[k] !== 'number' || !isFinite(s[k])) errors.push(`${at}: ${k} must be a number of seconds`);
    }
    if (typeof s.start === 'number' && typeof s.end === 'number') {
      if (s.end <= s.start) errors.push(`${at}: end (${s.end}) must be after start (${s.start})`);
      else if (toFrames(s.end, fps) - toFrames(s.start, fps) < 1) errors.push(`${at}: shorter than one frame at ${fps} fps`);
      const prev = scenes[scenes.length - 1];
      if (i === 0 && Math.abs(s.start) > 1e-6) errors.push(`${at}: the first scene must start at 0, not ${s.start}`);
      if (prev && typeof prev.end === 'number' && Math.abs(s.start - prev.end) > 1e-6) {
        const gap = Math.round((s.start - prev.end) * 1000) / 1000;
        errors.push(`${at}: starts at ${s.start} but ${prev.id} ends at ${prev.end} (${gap > 0 ? `a gap of ${gap}` : `an overlap of ${-gap}`} s); scenes must be contiguous`);
      }
    }
    if (s.kind === 'footage') {
      if (s.clip === undefined) s.clip = `work/base/${s.id}.mp4`;
      if (typeof s.clip !== 'string' || !s.clip) errors.push(`${at}: clip must be a path such as work/base/${s.id}.mp4`);
      s.overlay = Boolean(s.overlay);
    }
    scenes.push(s);
  });
  return { errors, scenes };
}

// ---------- what was rendered from what ----------
const HASH_SKIP_FILES = new Set(['cues.json', 'meta.json', 'package.json']); // none of them changes a pixel
const HASH_SKIP_DIRS = new Set(['snapshots', 'renders', 'node_modules']);
const BIG_FILE = 16 * 1024 * 1024;

// A hash of everything in the scene folder that can change the picture. Null when the folder is missing.
export function hashScene(sceneDir) {
  if (!fs.existsSync(sceneDir)) return null;
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue; // engine caches and editor files
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!HASH_SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (!rel && HASH_SKIP_FILES.has(e.name)) continue;
      if (/\.log$/i.test(e.name)) continue;
      files.push(r);
    }
  };
  walk(sceneDir, '');
  files.sort();
  const h = crypto.createHash('sha256');
  for (const r of files) {
    const full = path.join(sceneDir, r);
    const st = fs.statSync(full);
    h.update(r).update('\n');
    if (st.size > BIG_FILE) h.update(`big:${st.size}:${Math.round(st.mtimeMs)}`); // large media: size and date are enough
    else h.update(fs.readFileSync(full));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 32);
}

function clipSignature(root, scene) {
  if (scene.kind !== 'footage' || !scene.clip) return null;
  const mode = scene.overlay ? 'overlay' : 'plain';
  try {
    const st = fs.statSync(path.resolve(root, scene.clip));
    return `${fwd(scene.clip)}:${st.size}:${Math.round(st.mtimeMs)}:${mode}`;
  } catch {
    return `${fwd(scene.clip)}:missing:${mode}`;
  }
}

export const recordsFile = (root) => path.join(root, 'renders', 'renders.json');
export const readRecords = (root) => readJson(recordsFile(root), {});
export function writeRecord(root, id, record) {
  const all = readRecords(root);
  all[id] = record;
  writeJson(recordsFile(root), all);
}

// What a render of this scene is made from right now. Compared with the stored record to find stale renders.
export function sceneInputs(root, project, scene) {
  return {
    hash: hashScene(path.join(root, 'scenes', scene.id)),
    clip: clipSignature(root, scene),
    fps: Number(project.fps) || 30,
    width: project.width,
    height: project.height,
  };
}

/**
 * The state of one scene (an entry of timeline(project).scenes):
 * { exists, rendered, stale, reason, quality, mblur, file, dir, inputs, record }
 * `stale` means renders/<id>.mp4 no longer matches the scene: the source changed, or nothing recorded how it was made.
 */
export function sceneState(root, project, scene) {
  const dir = path.join(root, 'scenes', scene.id);
  const file = path.join(root, 'renders', `${scene.id}.mp4`);
  const hasFolder = fs.existsSync(path.join(dir, 'index.html'));
  const plainFootage = scene.kind === 'footage' && !scene.overlay;
  const exists = plainFootage ? fs.existsSync(path.resolve(root, scene.clip || '')) : hasFolder;
  const rendered = fs.existsSync(file);
  const inputs = sceneInputs(root, project, scene);
  const record = readRecords(root)[scene.id] || null;
  let stale = false, reason = null;
  if (rendered) {
    if (!record) { stale = true; reason = 'no record of how it was rendered'; }
    else if (record.hash !== inputs.hash) { stale = true; reason = 'the scene changed after the render'; }
    else if (record.clip !== inputs.clip) { stale = true; reason = 'the footage clip changed after the render'; }
    else if (record.fps !== inputs.fps || record.width !== inputs.width || record.height !== inputs.height) {
      stale = true; reason = 'the project size or fps changed after the render';
    }
  }
  return {
    exists, rendered, stale, reason,
    quality: rendered && record ? record.quality || null : null,
    mblur: Boolean(rendered && record && record.mblur),
    file, dir, inputs, record,
  };
}
