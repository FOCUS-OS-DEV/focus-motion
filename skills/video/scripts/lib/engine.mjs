// Starts the video engine (HyperFrames, pinned) for the Focus Motion tools. Windows / macOS / Linux, no shell.
//
//   import { engine, engineJson, engineVersion, ENGINE_VERSION } from './lib/engine.mjs';
//   const r = await engine(['render', sceneDir, '-o', outFile, '--fps', '30'], { timeoutMs: 600000, stallMs: 180000 });
//   // r = { code, stdout, stderr, timedOut, stalled, via, ms }
//
// How it starts, in this order:
//   1. "direct": the pinned version already sits in the npx cache, so its entry file runs with this Node (about 0.4 s).
//   2. "npx": this Node runs npm's own npx-cli.js with `--yes hyperframes@<pinned>`, which installs it on first use.
//      That file is JavaScript, so no .cmd wrapper and no shell are involved (Windows refuses to spawn .cmd files).
//   3. an `npx` program found on the PATH (macOS / Linux, or a native npx.exe shim on Windows).
// The caller's environment passes through unchanged; only the engine's own switches are added.
// Set FOCUS_MOTION_ENGINE=npx to skip the direct start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { IS_WIN, findTool } from './common.mjs';

export const ENGINE_PACKAGE = 'hyperframes';
export const ENGINE_VERSION = '0.8.106';
export const ENGINE_SPEC = `${ENGINE_PACKAGE}@${ENGINE_VERSION}`;
// What a person would type. The doctor prints it as the fix when the engine cannot start.
export const ENGINE_INSTALL_HINT = `npx --yes ${ENGINE_SPEC} --version`;

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// ---------- where things are ----------
function npmCacheDirs() {
  const list = [];
  if (process.env.npm_config_cache) list.push(process.env.npm_config_cache);
  try {
    const rc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const m = rc.match(/^\s*cache\s*=\s*(.+?)\s*$/m);
    if (m) list.push(m[1].replace(/^["']|["']$/g, '').replace(/^~(?=[\\/]|$)/, os.homedir()));
  } catch { /* no .npmrc */ }
  if (IS_WIN) list.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache'));
  list.push(path.join(os.homedir(), '.npm'));
  return [...new Set(list.map((d) => path.resolve(d)))];
}

// A complete install of the pinned version inside the npx cache, or null.
function installedEntry(base) {
  try {
    const pkgDir = path.join(base, 'node_modules', ENGINE_PACKAGE);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (pkg.version !== ENGINE_VERSION) return null;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[ENGINE_PACKAGE];
    if (!bin) return null;
    const entry = path.join(pkgDir, bin);
    if (!exists(entry)) return null;
    // An interrupted install leaves the package without its dependencies: then npx has to repair it.
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (!exists(path.join(base, 'node_modules', dep, 'package.json'))) return null;
    }
    return entry;
  } catch {
    return null;
  }
}

let directCache;
function findDirect() {
  if (directCache !== undefined) return directCache;
  if ((process.env.FOCUS_MOTION_ENGINE || '').toLowerCase() === 'npx') return (directCache = null);
  // npx names its folder after a hash of the requested spec; look there first, then in the other folders.
  const preferred = crypto.createHash('sha512').update(ENGINE_SPEC).digest('hex').slice(0, 16);
  for (const cache of npmCacheDirs()) {
    const root = path.join(cache, '_npx');
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    names.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)));
    for (const n of names) {
      const entry = installedEntry(path.join(root, n));
      if (entry) return (directCache = entry);
    }
  }
  return (directCache = null);
}

function pathDirs() {
  return String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
}

let npxCache;
// { cmd, pre }: the program to spawn and the arguments that come before `--yes <spec>`. Null when npx is missing.
function findNpx() {
  if (npxCache !== undefined) return npxCache;
  const rel = ['node_modules', 'npm', 'bin', 'npx-cli.js'];
  const nodeDir = path.dirname(process.execPath);
  const scripts = [
    path.join(nodeDir, ...rel),                       // Windows installer, nvm-windows, fnm, Volta, Scoop
    path.join(nodeDir, '..', 'lib', ...rel),          // macOS / Linux installers, nvm, n, fnm
    path.join(nodeDir, '..', 'libexec', 'lib', ...rel), // Homebrew keg
  ];
  if (process.env.npm_execpath) scripts.unshift(path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js'));
  if (!IS_WIN) scripts.push(path.join('/opt/homebrew/lib', ...rel), path.join('/usr/local/lib', ...rel), path.join('/usr/lib', ...rel));
  let program = null;
  for (const dir of pathDirs()) {
    if (IS_WIN) {
      if (exists(path.join(dir, 'npx.cmd'))) scripts.push(path.join(dir, ...rel));
      if (!program && exists(path.join(dir, 'npx.exe'))) program = path.join(dir, 'npx.exe');
    } else {
      const p = path.join(dir, 'npx');
      if (!exists(p)) continue;
      try {
        const real = fs.realpathSync(p);
        if (/\.c?js$/.test(real)) scripts.push(real);
      } catch { /* broken link */ }
      if (!program) program = p;
    }
  }
  for (const s of scripts) if (exists(s)) return (npxCache = { cmd: process.execPath, pre: [path.resolve(s)] });
  return (npxCache = program ? { cmd: program, pre: [] } : null);
}

// How the engine would start right now: 'direct', 'npx' or null (Node has no npx at all).
export function engineStart() {
  if (findDirect()) return 'direct';
  return findNpx() ? 'npx' : null;
}

// ---------- environment ----------
function engineEnv(extra) {
  const env = {
    ...process.env,
    HYPERFRAMES_SKIP_SKILLS: '1',     // never install or check agent skills
    HYPERFRAMES_NO_TELEMETRY: '1',    // the engine's own switch for usage reporting
    HYPERFRAMES_NO_UPDATE_CHECK: '1', // the version is pinned here
    HYPERFRAMES_NO_AUTO_INSTALL: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  // The engine looks for ffmpeg on the PATH only. Hand it the copy our tools found in an install folder.
  for (const [name, key] of [['ffmpeg', 'HYPERFRAMES_FFMPEG_PATH'], ['ffprobe', 'HYPERFRAMES_FFPROBE_PATH']]) {
    if (env[key]) continue;
    const found = findTool(name);
    if (found && path.isAbsolute(found)) env[key] = found;
  }
  return { ...env, ...(extra || {}) };
}

// ---------- process ----------
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL'); // the child leads its own process group (detached), so this takes its browser too
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

const live = new Set();
let hooked = false;
function hookSignals() {
  if (hooked) return;
  hooked = true;
  // A stopped tool must not leave an engine and its browser rendering in the background.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      for (const c of live) killTree(c);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

function spawnOnce(cmd, args, { cwd, env, timeoutMs = 0, stallMs = 0, inherit = false, onOutput } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: String(e.message), timedOut: false, stalled: false, ms: 0 });
    }
    hookSignals();
    live.add(child);
    let stdout = '', stderr = '', timedOut = false, stalled = false, last = Date.now();
    const cap = (s) => (s.length > 4e6 ? s.slice(-2e6) : s);
    const seen = (chunk, isErr) => {
      last = Date.now();
      const text = chunk.toString('utf8');
      if (isErr) stderr = cap(stderr + text); else stdout = cap(stdout + text);
      if (inherit) process.stderr.write(text); // stdout of a tool carries one JSON line only
      if (onOutput) { try { onOutput(text, isErr); } catch { /* the caller's problem */ } }
    };
    child.stdout.on('data', (d) => seen(d, false));
    child.stderr.on('data', (d) => seen(d, true));
    const hard = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    const watch = stallMs > 0 ? setInterval(() => {
      if (Date.now() - last > stallMs) { stalled = true; killTree(child); }
    }, Math.min(5000, Math.max(250, Math.floor(stallMs / 4)))) : null;
    const done = (code, extra = '') => {
      clearTimeout(hard); clearInterval(watch); live.delete(child);
      resolve({ code, stdout, stderr: stderr + extra, timedOut, stalled, ms: Date.now() - started });
    };
    child.on('error', (e) => done(127, String(e.message)));
    child.on('close', (code) => done(code ?? 1));
  });
}

const BROKEN_INSTALL = /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/;

/**
 * Run the engine: engine(['lint', dir, '--json'], { cwd, timeoutMs, inherit }).
 * Options: cwd, timeoutMs (hard limit), stallMs (kill when the engine prints nothing for this long),
 * inherit (also show the engine's output live, on stderr), env (extra variables), onOutput(text, isStderr).
 * Resolves with { code, stdout, stderr, timedOut, stalled, via, ms } and never rejects.
 * code 127 means the engine could not be started at all.
 */
export async function engine(args = [], opts = {}) {
  const env = engineEnv(opts.env);
  const direct = findDirect();
  if (direct) {
    const r = await spawnOnce(process.execPath, [direct, ...args], { ...opts, env });
    if (!(r.code !== 0 && !r.timedOut && !r.stalled && BROKEN_INSTALL.test(r.stderr) && r.stderr.includes('node_modules'))) {
      return { ...r, via: 'direct' };
    }
    directCache = null; // a damaged cache folder: let npx repair it
  }
  const npx = findNpx();
  if (!npx) {
    return {
      code: 127, stdout: '', timedOut: false, stalled: false, via: null, ms: 0,
      stderr: 'npx was not found next to this Node. Install Node.js 20 or newer (it includes npm and npx).',
    };
  }
  const r = await spawnOnce(npx.cmd, [...npx.pre, '--yes', ENGINE_SPEC, ...args], { ...opts, env });
  if (r.code === 0) directCache = undefined; // installed now: the next call can start it directly
  return { ...r, via: 'npx' };
}

// Runs an engine command that prints JSON (most take --json) and parses it. `json` is null when nothing parsed.
export async function engineJson(args = [], opts = {}) {
  const r = await engine(args, opts);
  let json = null;
  const a = r.stdout.indexOf('{'), b = r.stdout.lastIndexOf('}');
  if (a >= 0 && b > a) { try { json = JSON.parse(r.stdout.slice(a, b + 1)); } catch { /* not JSON */ } }
  return { ...r, json };
}

// The version the engine reports ('0.8.106'), or null when it cannot start. The first call may install it,
// which needs the network once and can take a few minutes.
export async function engineVersion({ timeoutMs = 600000 } = {}) {
  const r = await engine(['--version'], { timeoutMs });
  const m = r.code === 0 ? r.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) : null;
  return m ? m[0] : null;
}
