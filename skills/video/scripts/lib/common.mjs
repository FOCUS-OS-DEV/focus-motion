// Shared helpers for the Focus Motion tools. Node 20+, built-in modules only, Windows / macOS / Linux.
// Every tool imports from here. Paths may contain spaces and Hebrew, so programs always run with an argument
// array (never a shell string).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HOME_DIR = path.resolve(process.env.FOCUS_MOTION_HOME || path.join(os.homedir(), '.focus-motion'));
export const STATE_FILE = path.join(HOME_DIR, 'state.json');
export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

// The three canvases. `reel` also covers TikTok, Shorts and Stories.
export const FORMATS = {
  reel: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  wide: { width: 1920, height: 1080 },
};

export const fwd = (p) => String(p).replace(/\\/g, '/');

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`cannot read JSON ${file}: ${e.message}`);
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export const readState = () => readJson(STATE_FILE, {});

// One JSON line on stdout: the result the agent parses. Human notes go to stderr with note().
export const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
export const note = (...a) => process.stderr.write(a.join(' ') + '\n');
export function die(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

// argv parser: `--key value`, `--key=value`, `--flag` (names listed in `booleans`), `-o value`, positionals in `_`.
export function parseArgs(argv = process.argv.slice(2), { booleans = [], aliases = {} } = {}) {
  const res = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { res._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && isNaN(Number(a)))) {
      let key = a.replace(/^--?/, '');
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      key = aliases[key] || key;
      if (key.startsWith('no-') && booleans.includes(key.slice(3))) { res[key.slice(3)] = false; continue; }
      if (booleans.includes(key)) { res[key] = val === undefined ? true : val !== 'false'; continue; }
      if (val === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next.length > 2)) { res[key] = true; continue; }
        val = next; i++;
      }
      res[key] = val;
    } else res._.push(a);
  }
  return res;
}

// Run a program. Resolves with { code, stdout, stderr, timedOut }, never rejects on a non-zero exit.
export function run(cmd, args = [], { cwd, env, timeoutMs = 0, input, inherit = false, shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd, shell, windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: String(e.message), timedOut: false });
    }
    let stdout = '', stderr = '', timedOut = false, timer = null;
    if (!inherit) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 4e6) stderr = stderr.slice(-2e6); });
      if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (IS_WIN && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      }, timeoutMs);
    }
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + String(e.message), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
  });
}

export function runSync(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { code: r.status ?? 127, stdout: r.stdout || '', stderr: r.stderr || String(r.error?.message || '') };
}

// ---------- ffmpeg / ffprobe ----------
const toolCache = {};
function candidates(name) {
  const exe = IS_WIN ? `${name}.exe` : name;
  const list = [];
  if (process.env.FOCUS_MOTION_FFMPEG_DIR) list.push(path.join(process.env.FOCUS_MOTION_FFMPEG_DIR, exe));
  const st = readState();
  if (st.ffmpegDir) list.push(path.join(st.ffmpegDir, exe));
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    list.push(path.join(local, 'Microsoft', 'WinGet', 'Links', exe));
    const pk = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pk)) {
        if (!/ffmpeg/i.test(d)) continue;
        for (const v of fs.readdirSync(path.join(pk, d))) list.push(path.join(pk, d, v, 'bin', exe));
      }
    } catch { /* no winget packages */ }
    list.push(path.join('C:\\ffmpeg\\bin', exe), path.join('C:\\ProgramData\\chocolatey\\bin', exe));
  } else {
    list.push(`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`, `/usr/bin/${exe}`);
  }
  return list;
}

// Full path of ffmpeg or ffprobe, or null. Checks the PATH first, then the usual install folders.
export function findTool(name) {
  if (name in toolCache) return toolCache[name];
  const probe = runSync(name, ['-version']);
  if (probe.code === 0) return (toolCache[name] = name);
  for (const c of candidates(name)) {
    if (fs.existsSync(c) && runSync(c, ['-version']).code === 0) return (toolCache[name] = c);
  }
  return (toolCache[name] = null);
}

function need(name) {
  const p = findTool(name);
  if (!p) die(`${name} was not found. Run the doctor: node "${fwd(path.join(SKILL_ROOT, 'scripts', 'doctor.mjs'))}"`, 3);
  return p;
}

// Runs ffmpeg with -hide_banner -y. Throws with the tail of stderr when it fails.
export async function ffmpeg(args, opts = {}) {
  const r = await run(need('ffmpeg'), ['-hide_banner', '-y', ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.split(/\r?\n/).slice(-12).join('\n')}`);
  return r;
}

export async function ffprobeJson(file) {
  const r = await run(need('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

const ratio = (s) => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : a || 0; };

// The facts the tools need about a media file.
export async function mediaInfo(file) {
  const j = await ffprobeJson(file);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  let rotation = 0;
  if (v) {
    const sd = (v.side_data_list || []).find((d) => d.rotation !== undefined);
    rotation = Number(sd?.rotation ?? v.tags?.rotate ?? 0) || 0;
  }
  const transfer = v?.color_transfer || 'unknown';
  return {
    file,
    duration: Number(j.format?.duration || v?.duration || a?.duration || 0),
    hasVideo: Boolean(v),
    width: v?.width || 0,
    height: v?.height || 0,
    rotation,
    fps: v ? Math.round(ratio(v.avg_frame_rate || v.r_frame_rate) * 1000) / 1000 : 0,
    frames: v?.nb_frames ? Number(v.nb_frames) : null,
    pixFmt: v?.pix_fmt || null,
    codec: v?.codec_name || null,
    transfer,
    primaries: v?.color_primaries || 'unknown',
    hdr: transfer === 'arib-std-b67' || transfer === 'smpte2084',
    hasAudio: Boolean(a),
    sampleRate: a ? Number(a.sample_rate) : 0,
    channels: a?.channels || 0,
  };
}

// ---------- project ----------
export function loadProject(dir) {
  let root = path.resolve(dir || '.');
  // Run from inside the project with its bare name ("scene.mjs lint my-video s01" while in my-video/): the name
  // resolves to my-video/my-video, which does not exist, so the current folder is meant.
  if (!fs.existsSync(path.join(root, 'project.json')) && dir && !path.isAbsolute(dir)
    && path.basename(process.cwd()) === path.basename(dir) && fs.existsSync(path.join(process.cwd(), 'project.json'))) {
    root = process.cwd();
  }
  const file = path.join(root, 'project.json');
  if (!fs.existsSync(file)) die(`no project.json in ${root}. Create the project first: project.mjs init <name>`, 2);
  const project = readJson(file);
  return { root, file, project };
}

export const saveProject = (root, project) => writeJson(path.join(root, 'project.json'), project);

// Frame-exact helpers: the video is always cut on whole frames.
export const toFrames = (seconds, fps) => Math.round(seconds * fps);
export const toSeconds = (frames, fps) => frames / fps;
