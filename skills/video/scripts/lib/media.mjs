// Helpers of the footage and transcription tools (footage.mjs, transcribe.mjs). Node 20+, built-in modules only.
// Four parts: programs and files, footage (probe, colour, normalize), words (captions files, text alignment),
// and the Python environment with the speech model.
//
// Usage:   import { probeFootage, normalizeFootage, groupCues, toSrt } from './lib/media.mjs';
// Example: const p = await probeFootage('source/video/clip.mov', { fps: 30 });   // p.needsNormalize, p.reasons
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  SKILL_ROOT, HOME_DIR, IS_WIN, IS_MAC, fwd, note, out, readState, run, runSync, findTool, ffmpeg, ffprobeJson, mediaInfo,
} from './common.mjs';
import { removeTree } from './cli.mjs';

// ====================================================================================================
// 1. Programs and files
// ====================================================================================================

// Ends the tool with one JSON line on stdout and a short line on stderr. Codes: 1 failed, 2 usage, 3 missing program.
export function fail(message, code = 1, extra = {}) {
  out({ ok: false, error: message, ...extra });
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

// Prints the usage block from the top of a tool file (the comment lines after the shebang).
export function usage(fileUrl, code = 0) {
  const lines = fs.readFileSync(new URL(fileUrl), 'utf8').split('\n');
  const block = [];
  for (const l of lines.slice(1)) { if (!l.startsWith('//')) break; block.push(l.replace(/^\/\/ ?/, '')); }
  process.stdout.write(block.join('\n') + '\n');
  process.exit(code);
}

export function tool(name) {
  const p = findTool(name);
  if (!p) fail(`${name} was not found. Run the doctor: node "${fwd(path.join(SKILL_ROOT, 'scripts', 'doctor.mjs'))}"`, 3, { missing: name });
  return p;
}

// Runs a program and returns its stdout as a Buffer (binary safe). Never rejects.
export function runBinary(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: 127, stdout: Buffer.alloc(0), stderr: String(e.message) }); }
    const chunks = []; let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-1e6); });
    child.on('error', (e) => resolve({ code: 127, stdout: Buffer.concat(chunks), stderr: stderr + String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr }));
  });
}

// The project folder that holds `file` (the nearest parent with a project.json), or null.
export function findProjectRoot(file) {
  let dir = path.resolve(file);
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'project.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// Nothing a person may have edited is overwritten: an existing file moves to `_versions/` first.
// Returns the new place of the old file, or null when there was none.
export function archiveExisting(file) {
  if (!fs.existsSync(file)) return null;
  const root = findProjectRoot(file) || path.dirname(file);
  const dir = path.join(root, '_versions');
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file);
  let dst = path.join(dir, `${path.basename(file, ext)}-${stamp()}${ext}`);
  for (let i = 2; fs.existsSync(dst); i++) dst = path.join(dir, `${path.basename(file, ext)}-${stamp()}-${i}${ext}`);
  fs.renameSync(file, dst);
  return dst;
}

// A file name that is safe everywhere: letters of any language and digits stay, the rest becomes a dash.
export function safeName(name) {
  const s = String(name).normalize('NFC').replace(/[^\p{L}\p{N}_.]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s || 'clip';
}

// 30 -> "30", 29.97 -> "30000/1001": the exact rate ffmpeg should use.
export function fpsArg(fps) {
  const f = Number(fps);
  for (const base of [24, 30, 60, 120]) if (Math.abs(f - base / 1.001) < 0.01) return `${base * 1000}/1001`;
  return Number.isInteger(f) ? String(f) : String(Math.round(f * 1000) / 1000);
}

// Frames get these tags, so every player reads the colours the same way.
export const TAG_709 = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';
export const ENC_709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
export const x264 = ({ crf = 16, preset = 'medium', fps = 30, gop = 2 } = {}) => [
  '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
  '-r', fpsArg(fps), '-g', String(Math.max(1, Math.round(fps * gop))), ...ENC_709,
];

let filterSet = null;
export async function hasFilter(name) {
  if (!filterSet) {
    filterSet = new Set();
    const r = await run(tool('ffmpeg'), ['-hide_banner', '-filters']);
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*[A-Z.]{2,3}\s+(\S+)\s+\S+->\S+/);
      if (m) filterSet.add(m[1]);
    }
  }
  return filterSet.has(name);
}

// 24-bit PCM WAV from Float32 samples (interleaved when channels > 1).
export function writeWav(file, samples, { rate = 48000, channels = 1 } = {}) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 3);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 3, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * 3, 28); buf.writeUInt16LE(channels * 3, 32); buf.writeUInt16LE(24, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 3, 40);
  for (let i = 0, o = 44; i < n; i++, o += 3) {
    let v = Math.round(Math.max(-1, Math.min(1, samples[i])) * 8388607);
    if (v < 0) v += 16777216;
    buf[o] = v & 255; buf[o + 1] = (v >> 8) & 255; buf[o + 2] = (v >> 16) & 255;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

// ====================================================================================================
// 2. Footage: probe, colour, normalize
// ====================================================================================================

const ratio = (s) => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : a || 0; };
const PHOTO_CODECS = new Set(['mjpeg', 'png', 'webp', 'bmp', 'tiff', 'gif', 'jpegxl', 'jpeg2000']);
const HDR_TRANSFERS = { 'arib-std-b67': 'hlg', smpte2084: 'pq' };

/**
 * mediaInfo() plus what the footage tools need: the size as it is displayed, whether the frame rate is constant,
 * and the list of reasons the file has to be normalized before it is cut or used in a scene.
 */
export async function probeFootage(file, { fps = 30 } = {}) {
  const info = await mediaInfo(file);
  const j = await ffprobeJson(file);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const format = String(j.format?.format_name || '');
  const res = { ...info, file: fwd(file), kind: 'audio', needsNormalize: false, reasons: [] };
  if (!v) return res;

  // The picture as a player shows it: pixels made square, then the rotation of the phone applied.
  const quarter = Math.abs(Math.round(info.rotation / 90)) % 2 === 1;
  const sar = ratio(String(v.sample_aspect_ratio || '1:1').replace(':', '/')) || 1;
  const square = { w: Math.round(v.width * sar), h: v.height };
  res.displayWidth = quarter ? square.h : square.w;
  res.displayHeight = quarter ? square.w : square.h;
  const isPhoto = /image2|_pipe/.test(format) || (PHOTO_CODECS.has(v.codec_name) && !a && (Number(v.nb_frames || 1) <= 1) && info.duration < 0.2);
  if (isPhoto) { res.kind = 'photo'; return res; }

  res.kind = 'video';
  const rFps = ratio(v.r_frame_rate), avgFps = ratio(v.avg_frame_rate);
  res.rFps = Math.round(rFps * 1000) / 1000;
  res.variableFrameRate = rFps > 0 && avgFps > 0 && Math.abs(rFps - avgFps) / rFps > 5e-5;
  res.matrix = v.color_space || 'unknown';
  res.range = v.color_range || (/^yuvj/.test(v.pix_fmt || '') ? 'pc' : 'unknown');
  res.interlaced = ['tt', 'bb', 'tb', 'bt'].includes(v.field_order);
  res.sar = Math.round(sar * 1000) / 1000;
  res.hdrKind = HDR_TRANSFERS[info.transfer] || null;
  res.container = format;

  const why = res.reasons;
  if (info.rotation) why.push(`rotated ${info.rotation} degrees`);
  if (res.hdrKind) why.push(`HDR (${res.hdrKind.toUpperCase()}), must be tone-mapped to SDR`);
  else if (info.primaries === 'bt2020') why.push('wide colour (bt2020)');
  if (v.codec_name !== 'h264') why.push(`codec ${v.codec_name}`);
  if (v.pix_fmt !== 'yuv420p') why.push(`pixel format ${v.pix_fmt}`);
  if (res.range === 'pc' && v.pix_fmt === 'yuv420p') why.push('full colour range');
  if (!['bt709', 'unknown'].includes(res.matrix) && !res.hdrKind) why.push(`colour matrix ${res.matrix}`);
  if (res.matrix === 'unknown' && Math.max(v.width, v.height) < 1280 && Math.min(v.width, v.height) < 720) why.push('untagged standard-definition colour');
  if (res.variableFrameRate) why.push('variable frame rate');
  else if (Math.abs(info.fps - fps) > 0.01) why.push(`frame rate ${info.fps}, the project runs at ${fps}`);
  if (res.interlaced) why.push('interlaced');
  if (Math.abs(sar - 1) > 0.001) why.push('non-square pixels');
  if (v.width % 2 || v.height % 2) why.push('odd frame size');
  if (a && Number(a.sample_rate) !== 48000) why.push(`audio at ${a.sample_rate} Hz`);
  if (a && a.channels > 2) why.push(`${a.channels} audio channels`);
  if (!/mp4|mov/.test(format)) why.push(`container ${format.split(',')[0]}`);
  if (Number(v.start_time || 0) > 0.05 || (a && Math.abs(Number(a.start_time || 0) - Number(v.start_time || 0)) > 0.05)) why.push('streams do not start together');
  res.needsNormalize = why.length > 0;
  return res;
}

// ---- HDR to SDR ----------------------------------------------------------------------------------
// The reference conversion is the zscale chain below (the zimg library). When this ffmpeg has no zscale, the same
// maths is baked into a 3D lookup table and applied with lut3d, which every ffmpeg has. Both give the same picture.
const NPL = 203;                    // nits of reference white (BT.2408)
const MOBIUS_KNEE = 0.3;

const hlgInverse = (x) => {         // HLG signal 0..1 -> scene light 0..1
  x = Math.max(x, 0);
  return x <= 0.5 ? (x * x) / 3 : (Math.exp((x - 0.55991073) / 0.17883277) + 0.28466892) / 12;
};
const pqToNits = (x) => {           // PQ signal 0..1 -> nits
  const p = Math.pow(Math.max(x, 0), 1 / 78.84375);
  return 10000 * Math.pow(Math.max(p - 0.8359375, 0) / (18.8515625 - 18.6875 * p), 1 / 0.1593017578125);
};
const mobius = (v, j, peak) => {
  if (v <= j) return v;
  const a = -j * j * (peak - 1) / (j * j - 2 * j + peak);
  const b = (j * j - 2 * j * peak + peak) / Math.max(peak - 1, 1e-6);
  return ((b * b + 2 * b * j + j * j) / (b - a)) * (v + a) / (v + b);
};
const TO_709 = [[1.660491, -0.587641, -0.072850], [-0.124550, 1.132900, -0.008349], [-0.018151, -0.100579, 1.118730]];

// Text of a .cube file: HDR signal (BT.2020 R'G'B', full range) -> SDR BT.709 R'G'B'.
export function hdrCube(kind, { peak = 10, size = 33 } = {}) {
  const toLinear = kind === 'pq'
    ? (x) => pqToNits(x) / NPL
    : (x) => Math.pow(hlgInverse(x), 1.2) * (1000 / NPL);   // the display gamma of HLG, per channel like zimg
  const axis = Array.from({ length: size }, (_, i) => toLinear(i / (size - 1)));
  const lines = [`TITLE "${kind} to sdr"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const R = axis[r], G = axis[g], B = axis[b];
    const rgb = TO_709.map((m) => m[0] * R + m[1] * G + m[2] * B);
    const sig = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
    const k = mobius(sig, MOBIUS_KNEE, peak) / sig;
    lines.push(rgb.map((c) => Math.min(1, Math.pow(Math.max(c * k, 0), 1 / 2.4)).toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}

const SWS_MATRIX = { bt709: 'bt709', smpte170m: 'smpte170m', bt470bg: 'bt470bg', smpte240m: 'smpte240m', fcc: 'fcc', bt2020nc: 'bt2020', bt2020c: 'bt2020' };

/**
 * The video filters that turn a probed file into SDR BT.709 with square pixels.
 * Returns { filters: [..], method: 'sdr' | 'zscale' | 'lut', cube: text | null }. With method 'lut' the caller writes
 * `cube` as "fm-hdr.cube" into the folder ffmpeg runs in (a bare file name needs no escaping inside the filter).
 */
export async function colourFilters(p, { size = null, forceLut = false, target = 'yuv' } = {}) {
  const range = p.range === 'pc' ? 'pc' : 'tv';
  const sizeArg = size ? `${size.w}:${size.h}:flags=bicubic:` : '';
  const end = target === 'rgb' ? ['format=rgb24'] : ['format=yuv420p'];
  if (p.hdrKind) {
    const useLut = forceLut || !(await hasFilter('zscale')) || !(await hasFilter('tonemap'));
    const pre = size ? [`scale=${size.w}:${size.h}:flags=bicubic`] : [];
    if (!useLut) {
      const tin = p.hdrKind === 'pq' ? 'smpte2084' : 'arib-std-b67';
      const last = target === 'rgb' ? 'zscale=t=bt709:m=gbr:r=pc' : 'zscale=t=bt709:m=bt709:r=tv';
      return {
        method: 'zscale', cube: null,
        filters: [...pre, `zscale=tin=${tin}:min=bt2020nc:pin=bt2020:rin=${range}:t=linear:p=bt2020:npl=${NPL}`, 'format=gbrpf32le',
          'zscale=p=bt709', `tonemap=tonemap=mobius:param=${MOBIUS_KNEE}:desat=0`, last, ...end],
      };
    }
    const peak = Math.max(1, p.hdrPeak || 10);
    const back = target === 'rgb' ? [] : ['scale=out_color_matrix=bt709:out_range=tv'];
    return {
      method: 'lut', cube: hdrCube(p.hdrKind, { peak }),
      filters: [...pre, `scale=in_color_matrix=bt2020:in_range=${range}:out_range=pc`, 'format=gbrp16le',
        'lut3d=file=fm-hdr.cube:interp=tetrahedral', ...back, ...end],
    };
  }
  const known = SWS_MATRIX[p.matrix];
  const sd = Math.max(p.width, p.height) < 1280 && Math.min(p.width, p.height) < 720;
  const inMatrix = known || (sd ? 'smpte170m' : 'bt709');
  const rgbIn = /^(rgb|bgr|gbr|argb|abgr|pal8|rgba|bgra|0rgb|rgb0|0bgr|bgr0)/.test(p.pixFmt || '');
  const head = rgbIn ? '' : `in_color_matrix=${inMatrix}:in_range=${range}:`;
  if (target === 'rgb') return { method: 'sdr', cube: null, filters: [`scale=${sizeArg}${head}out_range=pc`, ...end] };
  return { method: 'sdr', cube: null, filters: [`scale=${sizeArg}${head}out_color_matrix=bt709:out_range=tv`, ...end] };
}

// The brightest value the tone mapper expects, read the way ffmpeg's tonemap filter reads it (in units of 100 nits).
function hdrPeakOf(probeJson) {
  const v = probeJson.streams.find((s) => s.codec_type === 'video');
  for (const sd of v?.side_data_list || []) {
    if (sd.max_content) return Number(sd.max_content) / 100;
  }
  for (const sd of v?.side_data_list || []) {
    if (sd.max_luminance) return ratio(sd.max_luminance) / 100;
  }
  return 10;
}

// Even frame size after rotation, square pixels and the optional cap on the longer side.
export function normalizedSize(p, maxSide = 0) {
  let w = p.displayWidth, h = p.displayHeight;
  if (maxSide > 0 && Math.max(w, h) > maxSide) { const k = maxSide / Math.max(w, h); w *= k; h *= k; }
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  return { w: even(w), h: even(h) };
}

/**
 * Writes a normalized copy of a clip: rotation applied, SDR BT.709, constant frame rate, H.264 yuv420p, square pixels,
 * audio AAC at 48 kHz. Location data and other metadata of the camera are dropped.
 */
export async function normalizeFootage(src, dst, { fps = 30, maxSide = 0, forceLut = false, crf = 14 } = {}) {
  const started = Date.now();
  src = path.resolve(src); dst = path.resolve(dst);
  if (!/\.mp4$/i.test(dst)) throw new Error('the normalized file must end with .mp4');
  const p = await probeFootage(src, { fps });
  if (p.kind !== 'video') throw new Error(`not a video: ${fwd(src)}`);
  if (p.hdrKind) p.hdrPeak = hdrPeakOf(await ffprobeJson(src));
  const size = normalizedSize(p, maxSide);
  const resize = size.w !== p.displayWidth || size.h !== p.displayHeight || Math.abs((p.sar || 1) - 1) > 0.001;
  const colour = await colourFilters(p, { size: resize ? size : null, forceLut });
  const vf = [...(p.interlaced ? ['bwdif=mode=send_frame:deint=all'] : []), `fps=${fpsArg(fps)}`, ...colour.filters, 'setsar=1', TAG_709].join(',');

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const part = dst.replace(/\.mp4$/i, '') + '.part.mp4';
  let cwd;
  if (colour.cube) {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-lut-'));
    fs.writeFileSync(path.join(cwd, 'fm-hdr.cube'), colour.cube);
  }
  const audio = p.hasAudio
    ? ['-map', '0:a:0', '-af', 'aresample=48000:async=1:first_pts=0', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', ...(p.channels > 2 ? ['-ac', '2'] : [])]
    : ['-an'];
  try {
    await ffmpeg(['-i', src, '-map', '0:v:0', '-vf', vf, ...x264({ crf, preset: 'fast', fps }), ...audio,
      '-dn', '-sn', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', part], { cwd });
  } finally {
    if (cwd) removeTree(cwd);
  }
  const info = await mediaInfo(part);
  if (info.width !== size.w || info.height !== size.h) {
    throw new Error(`normalized size is ${info.width}x${info.height}, expected ${size.w}x${size.h} (rotation was not applied)`);
  }
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  fs.renameSync(part, dst);
  return {
    out: fwd(dst), method: colour.method, width: info.width, height: info.height, fps: info.fps, frames: info.frames,
    duration: Math.round(info.duration * 1000) / 1000, hasAudio: info.hasAudio, fixed: p.reasons,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

// ====================================================================================================
// 3. Words: caption files and text alignment
// ====================================================================================================

const RTL_LANGS = new Set(['he', 'iw', 'ar', 'fa', 'ur', 'yi']);
export const isRtl = (lang) => RTL_LANGS.has(String(lang || '').toLowerCase().slice(0, 2));
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
const SENTENCE_END = /[.?!\u2026]["'\u05F4\u201D)]*$/;

export function readWords(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error(`cannot read words from ${fwd(file)}: ${e.message}`); }
  const list = Array.isArray(data) ? data : data.words;
  if (!Array.isArray(list)) throw new Error(`${fwd(file)} is not a words file (expected [{ text, start, end }])`);
  return list
    .map((w) => ({ text: String(w.text ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);
}

export const wordsText = (words) => words.map((w) => w.text).join(' ');

/**
 * Groups words into short caption cues. A cue never breaks inside a word, ends at a sentence end or at a pause, and
 * holds at most `maxChars` characters and `maxWords` words. Returns [{ start, end, text }].
 */
export function groupCues(words, { maxChars = 32, maxWords = 6, pause = 0.6 } = {}) {
  const groups = [];
  let cur = [];
  const len = (g) => g.reduce((n, w) => n + w.text.length, 0) + Math.max(0, g.length - 1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const full = cur.length && (cur.length >= maxWords || len(cur) + 1 + w.text.length > maxChars);
    const breakHere = prev && (w.start - prev.end > pause || SENTENCE_END.test(prev.text));
    if (cur.length && (full || breakHere)) { groups.push({ words: cur, soft: full && !breakHere }); cur = []; }
    cur.push(w);
  }
  if (cur.length) groups.push({ words: cur, soft: false });
  // A lone word after a full cue reads badly: hand it the last word of the cue before it.
  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1], b = groups[i];
    if (a.soft && b.words.length === 1 && a.words.length >= 3) {
      const moved = a.words[a.words.length - 1];
      if (moved.text.length + 1 + b.words[0].text.length <= maxChars) { a.words.pop(); b.words.unshift(moved); }
    }
  }
  const cues = groups.map((g) => ({ start: g.words[0].start, end: g.words[g.words.length - 1].end, text: g.words.map((w) => w.text).join(' ') }));
  // On screen long enough to read, never over the next cue.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1] ? cues[i + 1].start : Infinity;
    const wanted = Math.max(cues[i].end + 0.15, cues[i].start + 0.8);
    cues[i].end = next - cues[i].end < 0.5 ? next : Math.min(wanted, next);
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.05;
  }
  return cues;
}

const clock = (t, sep) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
};

// Subtitle players disagree about direction. Renderers built on libass (ffmpeg burn-in, mpv) lay every line out left
// to right, which scrambles a Hebrew line that holds Latin words, digits or punctuation; browsers detect it themselves.
// Measured: a line wrapped in an RTL embedding (RLE ... PDF) reads right in both, and a mark at the start (RLM) does
// not. So every right-to-left line that is not made of letters and spaces only is wrapped; the rest stay plain text.
const ONLY_RTL_LETTERS = /^[\s\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]*$/;
function directed(text, rtl, marks) {
  if (!rtl || marks === 'never' || !RTL_CHAR.test(text)) return text;
  if (marks !== 'always' && ONLY_RTL_LETTERS.test(text)) return text;
  return '\u202B' + text + '\u202C';
}

export function toSrt(cues, { rtl = false, marks = 'auto' } = {}) {
  return cues.map((c, i) => `${i + 1}\r\n${clock(c.start, ',')} --> ${clock(c.end, ',')}\r\n${directed(c.text, rtl, marks)}\r\n`).join('\r\n');
}

export function toVtt(cues, { rtl = false, marks = 'auto' } = {}) {
  return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${directed(c.text, rtl, marks)}\n`).join('\n');
}

// The transcript as plain text: a new line after each sentence and after each long pause.
export function toTxt(words, { pause = 1.0 } = {}) {
  const lines = [];
  let cur = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (prev && cur.length && (SENTENCE_END.test(prev.text) || w.start - prev.end > pause)) { lines.push(cur.join(' ')); cur = []; }
    cur.push(w.text);
  });
  if (cur.length) lines.push(cur.join(' '));
  return lines.join('\n') + '\n';
}

// ---- alignment of timed words with a written text ------------------------------------------------
const normToken = (t) => String(t).normalize('NFKD').replace(/[\u0300-\u036F\u0591-\u05C7]/g, '')
  .replace(/["'`\u05F3\u05F4\u2018\u2019\u201C\u201D.,!?:;()\[\]{}\u05BE\-\u2013\u2014\u2026]/g, '').toLowerCase();

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const n = a.length, m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const row = [i];
    for (let j = 1; j <= m; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[m] / Math.max(n, m);
}

// Any Latin letter makes a token Latin, so a Hebrew prefix glued to an English word still counts as another alphabet.
const scriptKind = (t) => (/[A-Za-z]/.test(t) ? 'latin' : RTL_CHAR.test(t) ? 'rtl' : /[0-9]/.test(t) ? 'number' : 'other');

/**
 * Lays a written text over timed words and keeps the timing.
 *   mode 'hint'  (a script the speaker followed): matched words take the spelling of the text; a name the recogniser
 *                wrote in another alphabet is replaced; anything else that was heard stays as heard.
 *   mode 'truth' (a transcript a person corrected): the result reads exactly as the text. Words missing from the text
 *                are removed, new words get a time between their neighbours.
 * Returns { words, report: { matched, respelled, replaced, inserted, removed, notHeard } }.
 */
export function applyText(words, text, { mode = 'truth' } = {}) {
  const tokens = String(text).split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  const H = words.map((w) => normToken(w.text)), T = tokens.map(normToken);
  const n = H.length, m = T.length;
  const report = { matched: 0, respelled: [], replaced: [], inserted: [], removed: [], notHeard: [] };
  if (!m) return { words: mode === 'truth' ? [] : words.slice(), report };
  if (!n) return { words: [], report: { ...report, notHeard: tokens } };

  // Global alignment inside a band around the diagonal.
  const band = Math.max(120, Math.abs(n - m) + 80);
  const W = m + 1;
  const back = new Uint8Array((n + 1) * W);          // 1 pair, 2 heard only, 3 text only
  let prev = new Float64Array(W).fill(Infinity), row = new Float64Array(W);
  for (let j = 0; j <= m; j++) { prev[j] = j; back[j] = 3; }
  const NEAR = 0.6;                                  // the same word, spelled a little differently
  const subCost = (i, j) => { const s = similarity(H[i - 1], T[j - 1]); return s >= 0.99 ? 0 : s >= NEAR ? 0.35 : 1.2; };
  for (let i = 1; i <= n; i++) {
    row.fill(Infinity);
    const centre = Math.round((i * m) / n);
    const lo = Math.max(0, centre - band), hi = Math.min(m, centre + band);
    if (lo === 0) { row[0] = i; back[i * W] = 2; }
    for (let j = Math.max(1, lo); j <= hi; j++) {
      const pair = prev[j - 1] + subCost(i, j), heard = prev[j] + 1, txt = row[j - 1] + 1;
      const best = Math.min(pair, heard, txt);
      row[j] = best;
      back[i * W + j] = best === pair ? 1 : best === heard ? 2 : 3;
    }
    [prev, row] = [row, prev];
  }
  // Walk back and collect: pairs that agree, and the gaps between them.
  const ops = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    const b = i === 0 ? 3 : j === 0 ? 2 : back[i * W + j] || 2;
    if (b === 1) { ops.push({ h: i - 1, t: j - 1, ok: similarity(H[i - 1], T[j - 1]) >= NEAR }); i--; j--; }
    else if (b === 2) { ops.push({ h: i - 1, t: -1, ok: false }); i--; }
    else { ops.push({ h: -1, t: j - 1, ok: false }); j--; }
  }
  ops.reverse();

  const result = [];
  const spread = (toks, a, b) => {                     // share the time a..b between the tokens, by their length
    const total = toks.reduce((s, t) => s + Math.max(1, t.length), 0);
    let at = a;
    return toks.map((t) => { const d = ((b - a) * Math.max(1, t.length)) / total; const w = { text: t, start: at, end: at + d }; at += d; return w; });
  };
  for (let k = 0; k < ops.length;) {
    if (ops[k].ok) {
      const w = words[ops[k].h], t = tokens[ops[k].t];
      if (w.text !== t) report.respelled.push({ from: w.text, to: t, t: w.start });
      report.matched++;
      result.push({ text: t, start: w.start, end: w.end });
      k++; continue;
    }
    const heard = [], written = [];
    for (; k < ops.length && !ops[k].ok; k++) { if (ops[k].h >= 0) heard.push(words[ops[k].h]); if (ops[k].t >= 0) written.push(tokens[ops[k].t]); }
    if (heard.length && written.length) {
      const cross = new Set(heard.map((w) => scriptKind(w.text))).size === 1 && new Set(written.map(scriptKind)).size === 1
        && scriptKind(heard[0].text) !== scriptKind(written[0]);
      if (mode === 'truth' || cross) {
        result.push(...spread(written, heard[0].start, heard[heard.length - 1].end));
        report.replaced.push({ from: heard.map((w) => w.text).join(' '), to: written.join(' '), t: heard[0].start });
      } else {
        result.push(...heard.map((w) => ({ ...w })));
        report.notHeard.push(...written);
      }
    } else if (heard.length) {
      if (mode === 'truth') report.removed.push(...heard.map((w) => ({ text: w.text, t: w.start })));
      else result.push(...heard.map((w) => ({ ...w })));
    } else if (written.length) {
      if (mode === 'truth') result.push({ pending: written });
      else report.notHeard.push(...written);
    }
  }
  // New words: into the pause between their neighbours, or a slice of the word before them when there is no pause.
  const final = [];
  result.forEach((item, idx) => {
    if (!item.pending) { final.push(item); return; }
    const before = final[final.length - 1];
    const after = result.slice(idx + 1).find((x) => !x.pending);
    let a = before ? before.end : Math.max(0, (after ? after.start : 0) - 0.3 * item.pending.length);
    let b = after ? after.start : a + 0.3 * item.pending.length;
    if (b - a < 0.08 * item.pending.length && before) {
      const take = Math.min((before.end - before.start) * 0.4, 0.25 * item.pending.length);
      before.end -= take; a = before.end;
    }
    if (b <= a) b = a + 0.05 * item.pending.length;
    const placed = spread(item.pending, a, Math.min(b, a + 0.45 * item.pending.length));
    final.push(...placed);
    report.inserted.push({ text: item.pending.join(' '), t: Math.round(a * 1000) / 1000 });
  });
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { words: final.map((w) => ({ text: w.text, start: r3(w.start), end: r3(Math.max(w.end, w.start + 0.02)) })), report };
}

// ====================================================================================================
// 4. The Python environment and the speech model
// ====================================================================================================

export const VENV_DIR = path.join(HOME_DIR, 'venv');
export const MODELS_DIR = path.join(HOME_DIR, 'models');
export const venvPython = () => (IS_WIN ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python'));
export const SPEECH_MODELS = { he: 'ivrit-ai/whisper-large-v3-turbo-ct2', other: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo' };
const SCRIPTS_DIR = path.join(SKILL_ROOT, 'scripts');

// The Python that runs transcribe.py: FOCUS_MOTION_PYTHON, then `python` in state.json, then the private environment.
export function transcribePython() {
  const list = [process.env.FOCUS_MOTION_PYTHON, readState().python, venvPython()].filter(Boolean);
  for (const p of list) if (fs.existsSync(p)) return p;
  return null;
}

// faster-whisper's version when this Python can import it, else null. Runs from the scripts folder, never from the
// user's folder, so a stray .py file there cannot shadow a standard module.
export function whisperVersion(python) {
  const r = runSync(python, ['-c', 'import faster_whisper; print(faster_whisper.__version__)'], { cwd: SCRIPTS_DIR });
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop() : null;
}

// A system Python of version 3.9 or newer that can create the private environment: { cmd, args, version } or null.
export function findBasePython() {
  const tries = IS_WIN ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, args] of tries) {
    const r = runSync(cmd, [...args, '--version']);
    const m = (r.stdout + r.stderr).match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (r.code === 0 && m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 9))) return { cmd, args, version: `${m[1]}.${m[2]}.${m[3]}` };
  }
  return null;
}

const PYTHON_INSTALL = IS_WIN
  ? 'winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements'
  : IS_MAC ? 'brew install python@3.12' : 'sudo apt-get install -y python3 python3-venv';

let cardCache;
// The NVIDIA card of this computer, read with nvidia-smi (on the PATH, or where the Windows driver puts it):
// { name, memoryMb } or null. A Mac never has one.
export function nvidiaCard() {
  if (cardCache !== undefined) return cardCache;
  if (IS_MAC) return (cardCache = null);
  const tries = ['nvidia-smi'];
  if (IS_WIN) {
    tries.push(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'nvidia-smi.exe'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'));
  }
  for (const cmd of tries) {
    if (cmd !== 'nvidia-smi' && !fs.existsSync(cmd)) continue;
    const r = runSync(cmd, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 15000 });
    const line = r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : '';
    if (line) {
      const [name, mem] = line.split(',').map((s) => s.trim());
      return (cardCache = { name, memoryMb: Number(mem) || null });
    }
  }
  return (cardCache = null);
}

// Whether this Python has the NVIDIA libraries that `setup --gpu` installs.
export function gpuLibraries(python) {
  const r = runSync(python, ['-c', 'import importlib.util as u; print(u.find_spec("nvidia.cublas") is not None)'], { cwd: SCRIPTS_DIR, timeout: 60000 });
  return r.code === 0 && r.stdout.trim().endsWith('True');
}

// Why --gpu, in one line for the agent.
export const GPU_WHY = 'an NVIDIA card is present: --gpu also installs its libraries (about 1.5 GB more on disk), and transcription then runs on the card, about 10 times faster and with little main memory, so it does not fail when memory is short';

/**
 * What is missing for transcription and the exact commands that install it. `ready` is true when nothing is missing.
 * Each command is one line that runs as written in PowerShell, bash and zsh.
 */
export function transcribeSetup() {
  const python = transcribePython();
  const version = python ? whisperVersion(python) : null;
  const card = nvidiaCard();
  if (python && version) return { ready: true, python: fwd(python), fasterWhisper: version, missing: null, install: [], gpu: card };
  const base = findBasePython();
  const setup = `node "${fwd(path.join(SCRIPTS_DIR, 'transcribe.mjs'))}" setup${card ? ' --gpu' : ''}`;
  const install = [];
  if (!base) install.push({ what: 'Python 3.9 or newer', run: PYTHON_INSTALL });
  install.push({ what: `a private Python environment in ${fwd(VENV_DIR)} with faster-whisper${card ? ` and the libraries of the ${card.name}` : ''}`,
    run: setup, ...(card ? { why: GPU_WHY } : {}) });
  const py = base ? [base.cmd, ...base.args].join(' ') : IS_WIN ? 'py -3' : 'python3';
  return {
    ready: false, python: python ? fwd(python) : null, fasterWhisper: null, gpu: card,
    basePython: base ? { command: [base.cmd, ...base.args].join(' '), version: base.version } : null,
    missing: !base && !python ? 'python' : python ? 'faster-whisper' : 'venv', install,
    // What `setup` runs, for a person who wants to do it by hand (bash form; PowerShell needs `&` before a quoted program).
    byHand: [`${py} -m venv "${fwd(VENV_DIR)}"`, `"${fwd(venvPython())}" -m pip install --upgrade pip`, `"${fwd(venvPython())}" -m pip install faster-whisper`,
      ...(card ? [`"${fwd(venvPython())}" -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"`] : [])],
  };
}

// Creates the private environment and installs faster-whisper into it (and the NVIDIA libraries with gpu: true).
export async function installTranscribe({ gpu = false } = {}) {
  if (gpu && IS_MAC) { note('a Mac has no NVIDIA card: transcription runs on the processor'); gpu = false; }
  const base = findBasePython();
  if (!fs.existsSync(venvPython())) {
    if (!base) return { ok: false, error: 'Python 3.9 or newer was not found', install: [{ what: 'Python', run: PYTHON_INSTALL }] };
    note(`creating the Python environment in ${fwd(VENV_DIR)} (Python ${base.version})`);
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const r = await run(base.cmd, [...base.args, '-m', 'venv', VENV_DIR]);
    if (r.code !== 0 || !fs.existsSync(venvPython())) return { ok: false, error: `could not create the environment: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' | ')}` };
  }
  const py = venvPython();
  const pip = async (label, args) => {
    note(label);
    const r = await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', ...args], { cwd: HOME_DIR });
    return r.code === 0 ? null : (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-4).join(' | ');
  };
  await pip('updating pip', ['--upgrade', 'pip']);            // an old pip still installs; a failure here is not fatal
  let err = await pip('installing faster-whisper (about 250 MB)', ['faster-whisper']);
  if (err) return { ok: false, error: `pip could not install faster-whisper: ${err}` };
  if (gpu) {
    err = await pip('installing the NVIDIA libraries (about 1.3 GB)', ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*']);
    if (err) return { ok: false, error: `pip could not install the NVIDIA libraries: ${err}` };
  }
  const version = whisperVersion(py);
  if (!version) return { ok: false, error: 'faster-whisper was installed but does not import' };
  return { ok: true, python: fwd(py), fasterWhisper: version, gpu };
}

const MODEL_FILES = /^(config\.json|preprocessor_config\.json|model\.bin|tokenizer\.json|vocabulary\.(json|txt))$/;
export const modelFolder = (repo, root = MODELS_DIR) => path.join(root, repo.replace(/\//g, '--'));
export const modelReady = (dir) => fs.existsSync(path.join(dir, 'model.bin')) && fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, '.complete'));

/**
 * Makes sure the speech model is on disk and returns its folder. The first call downloads it from Hugging Face
 * (the Hebrew model is about 1.6 GB); a broken download continues where it stopped.
 */
export async function ensureModel(repo, root = MODELS_DIR) {
  const dir = modelFolder(repo, root);
  if (modelReady(dir)) return { dir, downloaded: false };
  fs.mkdirSync(dir, { recursive: true });
  const explain = (e) => {
    const msg = String(e?.cause?.code || e?.cause?.message || e?.message || e);
    if (/CERT|certificate|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(msg)) return `${msg}. A security program inspects the connection: run the command again with the environment variable NODE_OPTIONS=--use-system-ca`;
    return `${msg}. Check the internet connection and run the command again; the download continues where it stopped`;
  };
  let files;
  try {
    const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
    if (!res.ok) throw new Error(`the model list answered ${res.status}`);
    files = ((await res.json()).siblings || []).filter((s) => MODEL_FILES.test(s.rfilename)).map((s) => ({ name: s.rfilename, size: s.size ?? s.lfs?.size ?? 0 }));
  } catch (e) { throw new Error(`cannot reach the model ${repo}: ${explain(e)}`); }
  if (!files.some((f) => f.name === 'model.bin')) throw new Error(`${repo} is not a faster-whisper model (no model.bin)`);
  const total = files.reduce((s, f) => s + f.size, 0);
  note(`downloading the speech model ${repo}, ${(total / 1e9).toFixed(2)} GB, one time`);
  let done = 0, shown = -1;
  for (const f of files) {
    const dst = path.join(dir, f.name), part = dst + '.part';
    if (fs.existsSync(dst) && (!f.size || fs.statSync(dst).size === f.size)) { done += f.size; continue; }
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (f.size && have > f.size) { fs.unlinkSync(part); have = 0; }
    try {
      if (!f.size || have < f.size) {
        const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${f.name}`, { headers: have ? { Range: `bytes=${have}-` } : {} });
        if (!res.ok && res.status !== 206) throw new Error(`${f.name} answered ${res.status}`);
        const append = have > 0 && res.status === 206;
        if (!append) have = 0;
        const body = Readable.fromWeb(res.body);
        body.on('data', (chunk) => {
          have += chunk.length;
          const pct = total ? Math.floor(((done + have) / total) * 20) * 5 : -1;
          if (pct !== shown) { shown = pct; note(`  ${pct}%`); }
        });
        await pipeline(body, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
      }
    } catch (e) { throw new Error(`the download of ${f.name} stopped: ${explain(e)}`); }
    const got = fs.statSync(part).size;
    if (f.size && got !== f.size) throw new Error(`${f.name} is ${got} bytes, expected ${f.size}. Run the command again`);
    fs.renameSync(part, dst);
    done += f.size;
  }
  fs.writeFileSync(path.join(dir, '.complete'), `${repo}\n`);
  return { dir, downloaded: true };
}
