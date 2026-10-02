#!/usr/bin/env node
// doctor.mjs: checks that this computer can make videos, and says exactly what to install when it cannot.
//
// Usage:
//   node doctor.mjs [--write] [--selftest] [--with-transcribe]
//
//   (no flag)          Node, ffmpeg and ffprobe (and the zscale and tonemap filters HDR clips need), the video
//                      engine and its browser, the animation library (downloaded once into ~/.focus-motion/vendor/),
//                      free disk and free memory. A missing browser is downloaded by the engine.
//   --write            saves the result to ~/.focus-motion/state.json (setup_done, os, versions, ffmpegDir, checked)
//   --selftest         renders the 4 second example scene and checks the video: the proof that everything works.
//                      The video stays in ~/.focus-motion/selftest/ so it can be shown to the user.
//   --with-transcribe  also checks the Python environment for transcription (~/.focus-motion/venv, faster-whisper),
//                      the system Python that creates it, and an NVIDIA card (then the command is `setup --gpu`)
//
// Exit codes: 0 ready, 3 something is missing (the JSON lists the install commands), 1 the self-test failed.
//
// Example:
//   node doctor.mjs --write --selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SKILL_ROOT, HOME_DIR, STATE_FILE, IS_WIN, IS_MAC, fwd, out, note, parseArgs, readState, writeJson, findTool, runSync, mediaInfo,
} from './lib/common.mjs';
import { engine, engineVersion, engineStart, ENGINE_VERSION, ENGINE_SPEC } from './lib/engine.mjs';
import { ensureGsap, installGsap, GSAP_VERSION } from './lib/vendor.mjs';
import { EXAMPLE_DIR, copyDir, installFonts, compositionInfo } from './lib/scenes.mjs';
import { showUsage, round, removeTree } from './lib/cli.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['help', 'write', 'selftest', 'with-transcribe'], aliases: { h: 'help' } });
if (args.help) showUsage(import.meta.url, 0);
if (args._.length) showUsage(import.meta.url, 2, `unexpected argument: ${args._[0]}`);

const OS = IS_WIN ? 'windows' : IS_MAC ? 'macos' : 'linux';
const NODE_MIN = 20;
const checks = {};
const missing = [];   // required items that are not there: each with the install command for this OS
const warnings = [];
const need = (item, why, install) => missing.push({ item, why, install: install[OS] || install.linux || null, installByOs: install });

const INSTALL = {
  node: { windows: 'winget install -e --id OpenJS.NodeJS.LTS', macos: 'brew install node', linux: 'sudo apt-get install -y nodejs npm' },
  ffmpeg: { windows: 'winget install -e --id Gyan.FFmpeg', macos: 'brew install ffmpeg', linux: 'sudo apt-get install -y ffmpeg' },
  python: { windows: 'winget install -e --id Python.Python.3.12', macos: 'brew install python@3.12', linux: 'sudo apt-get install -y python3 python3-venv' },
};
const restartNote = 'After installing, close and reopen the terminal (or Claude Code) so the new program is found.';

// ---------- Node ----------
const nodeMajor = Number(process.versions.node.split('.')[0]);
checks.node = { ok: nodeMajor >= NODE_MIN, version: process.versions.node, min: NODE_MIN };
if (!checks.node.ok) need('node', `Node ${process.versions.node} is too old; ${NODE_MIN} or newer is needed`, INSTALL.node);

// ---------- ffmpeg, ffprobe and the HDR filters ----------
function fullPath(found) {
  if (!found) return null;
  if (path.isAbsolute(found)) return found;
  const exe = IS_WIN ? `${found}.exe` : found;
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return found;
}
for (const name of ['ffmpeg', 'ffprobe']) {
  const found = findTool(name);
  if (!found) {
    checks[name] = { ok: false };
    need(name, `${name} was not found`, INSTALL.ffmpeg);
    continue;
  }
  const v = runSync(found, ['-hide_banner', '-version']).stdout.split(/\r?\n/)[0] || '';
  checks[name] = { ok: true, path: fwd(fullPath(found)), version: (v.match(/version\s+(\S+)/) || [])[1] || null };
}
if (checks.ffmpeg.ok) {
  const list = runSync(findTool('ffmpeg'), ['-hide_banner', '-filters']).stdout;
  const has = (f) => new RegExp(`^\\s*\\S+\\s+${f}\\s`, 'm').test(list);
  checks.hdrFilters = { ok: has('zscale') && has('tonemap'), zscale: has('zscale'), tonemap: has('tonemap') };
  if (!checks.hdrFilters.ok) {
    warnings.push(`this ffmpeg has no ${['zscale', 'tonemap'].filter((f) => !checks.hdrFilters[f]).join(' or ')} filter. HDR phone clips then use a simpler colour conversion. A full build fixes it: ${IS_WIN ? INSTALL.ffmpeg.windows : IS_MAC ? 'brew install ffmpeg-full' : 'a static ffmpeg build with libzimg'}`);
  }
}
if (missing.some((m) => m.item.startsWith('ff'))) warnings.push(restartNote);

// ---------- the engine and its browser ----------
const startMode = engineStart();
if (!startMode) {
  checks.engine = { ok: false, pinned: ENGINE_VERSION };
  need('engine', 'npx was not found next to Node, so the video engine cannot start', INSTALL.node);
} else {
  if (startMode === 'npx') note(`installing the video engine ${ENGINE_SPEC} (only the first time, it can take a few minutes)`);
  const version = await engineVersion();
  checks.engine = { ok: version === ENGINE_VERSION, version, pinned: ENGINE_VERSION, start: engineStart() };
  if (!version) {
    need('engine', `the video engine could not be installed or started. It needs the internet once. Run the doctor again; if it still fails, run: npx --yes ${ENGINE_SPEC} --version`, {
      windows: `npx --yes ${ENGINE_SPEC} --version`, macos: `npx --yes ${ENGINE_SPEC} --version`, linux: `npx --yes ${ENGINE_SPEC} --version` });
  } else if (version !== ENGINE_VERSION) {
    warnings.push(`the engine reports ${version} but ${ENGINE_VERSION} is pinned`);
  }
}
if (checks.engine.ok) {
  let r = await engine(['browser', 'path'], { timeoutMs: 60000 });
  let browserPath = r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop() : '';
  let installed = false;
  if (!browserPath || !fs.existsSync(browserPath)) {
    note('downloading the browser the engine renders with (only the first time)');
    r = await engine(['browser', 'ensure'], { timeoutMs: 15 * 60000, stallMs: 5 * 60000 });
    const again = await engine(['browser', 'path'], { timeoutMs: 60000 });
    browserPath = again.code === 0 ? again.stdout.trim().split(/\r?\n/).pop() : '';
    installed = Boolean(browserPath && fs.existsSync(browserPath));
  }
  checks.browser = { ok: Boolean(browserPath && fs.existsSync(browserPath)), path: browserPath ? fwd(browserPath) : null, installed };
  if (!checks.browser.ok) {
    const cmd = `npx --yes ${ENGINE_SPEC} browser ensure`;
    need('browser', `the engine's browser could not be downloaded: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(' ')}`, { windows: cmd, macos: cmd, linux: cmd });
  }
}

// ---------- the animation library ----------
const g = await ensureGsap();
checks.gsap = { ok: g.ok, version: GSAP_VERSION, path: fwd(g.path), bytes: g.ok ? g.bytes : 0, downloaded: g.downloaded, source: g.source || null };
if (!g.ok) need('gsap', `the animation library could not be downloaded: ${g.error}. ${g.hint || ''}`.trim(), { windows: 'connect to the internet and run the doctor again', macos: 'connect to the internet and run the doctor again', linux: 'connect to the internet and run the doctor again' });

// ---------- disk and memory ----------
function freeBytes(p) {
  try {
    let dir = path.resolve(p);
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch { return null; }
}
const gb = (b) => (b === null ? null : round(b / 1024 ** 3, 1));
const diskHere = freeBytes(process.cwd()), diskHome = freeBytes(HOME_DIR), diskTmp = freeBytes(os.tmpdir());
checks.disk = { ok: true, freeGbHere: gb(diskHere), freeGbHome: gb(diskHome), freeGbTemp: gb(diskTmp) };
const lowest = Math.min(...[diskHere, diskHome, diskTmp].filter((x) => x !== null));
if (isFinite(lowest) && lowest < 5 * 1024 ** 3) {
  checks.disk.ok = false;
  warnings.push(`only ${gb(lowest)} GB of disk is free. Renders and footage need room: keep at least 5 GB free.`);
}
const totalGb = gb(os.totalmem()), freeGb = gb(os.freemem());
checks.memory = { ok: os.freemem() >= 1024 ** 3, totalGb, freeGb, lowMemoryMachine: os.totalmem() <= 8 * 1024 ** 3 };
if (!checks.memory.ok) warnings.push(`only ${freeGb} GB of memory is free. Close other programs before rendering, or render with --workers 1.`);
if (checks.memory.lowMemoryMachine) warnings.push(`this computer has ${totalGb} GB of memory: the engine renders with one browser, so renders are slower.`);

// ---------- transcription (optional) ----------
if (args['with-transcribe']) {
  const venv = path.join(HOME_DIR, 'venv');
  const venvPy = IS_WIN ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  const st = readState();
  const candidates = [process.env.FOCUS_MOTION_PYTHON, st.python, venvPy].filter(Boolean);
  const py = candidates.find((p) => fs.existsSync(p)) || null;
  let fw = null, pyVersion = null;
  if (py) {
    const r = runSync(py, ['-c', 'import sys, faster_whisper; print(sys.version.split()[0]); print(faster_whisper.__version__)'], { timeout: 120000 });
    if (r.code === 0) [pyVersion, fw] = r.stdout.trim().split(/\r?\n/);
    else pyVersion = (runSync(py, ['--version']).stdout || '').replace(/^Python\s+/i, '').trim() || null;
  }
  // python is the private environment's Python (null until setup); basePython is the system Python that creates it.
  const { findBasePython, nvidiaCard, gpuLibraries, GPU_WHY } = await import('./lib/media.mjs');
  const base = findBasePython();
  const card = nvidiaCard();
  const cardLibs = card && py && fw ? gpuLibraries(py) : null;
  checks.transcribe = {
    ok: Boolean(fw), python: py ? fwd(py) : null, pythonVersion: pyVersion, fasterWhisper: fw || null, venv: fwd(venv),
    basePython: base ? { command: [base.cmd, ...base.args].join(' '), version: base.version } : null,
    gpu: card, gpuLibraries: cardLibs,
  };
  const setup = `node "${fwd(path.join(SKILL_ROOT, 'scripts', 'transcribe.mjs'))}" setup`;
  const setupHere = card ? `${setup} --gpu` : setup;   // the card is checked on this computer only
  if (!checks.transcribe.ok) {
    const why = (py ? 'the Python environment exists but faster-whisper is not installed in it' : 'the Python environment for transcription does not exist yet')
      + (base ? `; Python ${base.version} is installed (${[base.cmd, ...base.args].join(' ')})` : '; Python is not installed')
      + (card ? `; ${GPU_WHY.replace('an NVIDIA card is present', `an NVIDIA card is present (${card.name})`)}` : '');
    need('transcribe', why, {
      windows: base ? setupHere : `${INSTALL.python.windows}  then  ${setupHere}`,
      macos: base ? setup : `${INSTALL.python.macos}  then  ${setup}`,
      linux: base ? setupHere : `${INSTALL.python.linux}  then  ${setupHere}`,
    });
  } else if (card && cardLibs === false) {
    warnings.push(`transcription runs on the processor although an NVIDIA card is present (${card.name}). Run: ${setupHere} (faster, and it does not fail when memory is short)`);
  }
}

// ---------- self-test ----------
async function selftest() {
  const t0 = Date.now();
  const dir = path.join(HOME_DIR, 'selftest', 'hello');
  const video = path.join(HOME_DIR, 'selftest', 'hello.mp4');
  removeTree(path.join(HOME_DIR, 'selftest')); // our own folder from the last self-test
  copyDir(EXAMPLE_DIR, dir);
  installFonts(dir, ['Rubik'], dir);
  const gsap = await installGsap(dir, { download: false });
  if (gsap.mode !== 'local') return { ok: false, error: 'the animation library is missing, so the example cannot render offline' };
  const info = compositionInfo(dir);
  const lint = await engine(['lint', dir, '--json'], { timeoutMs: 120000 });
  let lintJson = null;
  try { lintJson = JSON.parse(lint.stdout.slice(lint.stdout.indexOf('{'), lint.stdout.lastIndexOf('}') + 1)); } catch { /* below */ }
  if (!lintJson) return { ok: false, error: `the engine's lint did not run: ${(lint.stderr || lint.stdout).trim().split(/\r?\n/).slice(-3).join(' ')}` };
  if (!lintJson.ok) return { ok: false, error: `lint found errors in the example: ${lintJson.findings.filter((f) => f.severity === 'error').map((f) => f.code).join(', ')}` };
  note('rendering the example scene (about half a minute)');
  // Two browsers: on a machine with little free memory the engine's automatic five took longer to start than to render.
  const base = ['render', dir, '-o', video, '--fps', '30', '--quality', 'looks', '--sdr', '--workers', '2'];
  let r = await engine(base, { timeoutMs: 10 * 60000, stallMs: 3 * 60000 });
  if (r.code !== 0 || !fs.existsSync(video)) {
    note('the render failed; trying once more in low-memory mode');
    r = await engine([...base, '--low-memory-mode'], { timeoutMs: 15 * 60000, stallMs: 3 * 60000 });
  }
  if (r.code !== 0 || !fs.existsSync(video)) {
    return { ok: false, error: r.timedOut ? 'the render passed its time limit' : r.stalled ? 'the render stopped making progress'
      : `the render failed: ${(r.stdout + '\n' + r.stderr).trim().split(/\r?\n/).slice(-4).join(' ')}` };
  }
  const m = await mediaInfo(video);
  const frames = Math.round(info.duration * 30);
  const problems = [];
  if (m.frames !== frames) problems.push(`${m.frames} frames instead of ${frames}`);
  if (Math.abs(m.duration - info.duration) > 0.05) problems.push(`${m.duration} s instead of ${info.duration} s`);
  if (m.width !== info.width || m.height !== info.height) problems.push(`size ${m.width}x${m.height}`);
  if (m.pixFmt !== 'yuv420p') problems.push(`pixel format ${m.pixFmt}`);
  if (m.transfer !== 'bt709' || m.primaries !== 'bt709') problems.push(`colour ${m.transfer}/${m.primaries}`);
  return {
    ok: problems.length === 0, video: fwd(video), scene: fwd(dir),
    seconds: round((Date.now() - t0) / 1000, 1),
    duration: round(m.duration), frames: m.frames, width: m.width, height: m.height, pixFmt: m.pixFmt, color: m.transfer,
    ...(problems.length ? { error: `the video is not right: ${problems.join('; ')}` } : {}),
  };
}

let selftestResult = null;
const renderMissing = missing.filter((m) => m.item !== 'transcribe'); // transcription is not needed to render
if (args.selftest) {
  if (renderMissing.length) selftestResult = { ok: false, error: `skipped: install ${renderMissing.map((m) => m.item).join(', ')} first` };
  else {
    try { selftestResult = await selftest(); } catch (e) { selftestResult = { ok: false, error: String(e.message || e).slice(0, 600) }; }
  }
}

// ---------- result ----------
const ready = missing.length === 0;
let stateFile = null;
if (args.write) {
  const prev = readState();
  const ffDir = checks.ffmpeg.ok && path.isAbsolute(checks.ffmpeg.path) ? fwd(path.dirname(checks.ffmpeg.path)) : prev.ffmpegDir || null;
  writeJson(STATE_FILE, {
    ...prev,
    setup_done: renderMissing.length === 0 && (!selftestResult || selftestResult.ok),
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    versions: {
      node: process.versions.node,
      ffmpeg: checks.ffmpeg.version || null,
      engine: checks.engine.version || null,
      gsap: checks.gsap.ok ? GSAP_VERSION : null,
      ...(checks.transcribe ? { python: checks.transcribe.pythonVersion, fasterWhisper: checks.transcribe.fasterWhisper } : {}),
    },
    ffmpegDir: ffDir,
    hdrFilters: checks.hdrFilters ? checks.hdrFilters.ok : null,
    ...(selftestResult && selftestResult.ok ? { selftest: { video: selftestResult.video, at: new Date().toISOString() } } : {}),
    checked: new Date().toISOString(),
  });
  stateFile = fwd(STATE_FILE);
}

out({
  ok: ready && (!selftestResult || selftestResult.ok),
  ready, canRender: renderMissing.length === 0, os: OS, checks, missing, warnings,
  ...(selftestResult ? { selftest: selftestResult } : {}),
  ...(stateFile ? { state: stateFile } : {}),
});
process.exitCode = !ready ? 3 : selftestResult && !selftestResult.ok ? 1 : 0;
