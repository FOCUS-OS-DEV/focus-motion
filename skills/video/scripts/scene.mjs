#!/usr/bin/env node
// scene.mjs: looks at one scene before it is rendered. Runs the video engine with the skill's settings, so never
// call the engine through npx yourself.
//
// Usage:
//   node scene.mjs frames <project> <id> --at 0.5,1.8,3.2 [--out <dir>]
//   node scene.mjs lint <project> <id>
//   node scene.mjs check <project> <id>
//
//   frames   PNG frames of the scene at the given scene-local seconds, at full size, for the look test and for
//            checking a moment. Default folder: <project>/work/frames/<id>/ (emptied first). Repeat a time to check
//            that the scene is repeatable: the two captures of that time must be identical (`same` in the JSON).
//   lint     the engine's fast static check (about 1 s). Errors are real and stop a render.
//   check    the engine's full check (8 to 40 s): script errors, missing targets and files, text outside the frame,
//            overlapping text, contrast. Layout and contrast findings on busy scenes are noisy: look at the frame.
//
// Prints one JSON line. Exit 0 ok, 1 the engine reported errors or failed, 2 bad usage, 3 the engine is missing.
//
// Example:
//   node scene.mjs frames launch-video s01 --at 0.4,1.6,1.6
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fwd, out, note, die, parseArgs, loadProject } from './lib/common.mjs';
import { engine, engineJson, ENGINE_INSTALL_HINT } from './lib/engine.mjs';
import { showUsage, removeTree } from './lib/cli.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['help'], aliases: { h: 'help', o: 'out' } });
if (args.help) showUsage(import.meta.url, 0);
const [cmd, projectArg, id] = args._;
if (!['frames', 'lint', 'check'].includes(cmd) || !projectArg || !id) showUsage(import.meta.url, 2);

const { root } = loadProject(projectArg);
const dir = path.join(root, 'scenes', id);
if (!fs.existsSync(path.join(dir, 'index.html'))) die(`no scene ${id}: ${fwd(path.join(dir, 'index.html'))} does not exist`, 2);

function engineMissing(r) {
  if (r.code === 127 || /not found|ENOENT/i.test(r.stderr || '')) {
    die(`the video engine could not start. Run doctor.mjs, or: ${ENGINE_INSTALL_HINT}`, 3);
  }
}
const lastLines = (s, n = 6) => String(s || '').trim().split(/\r?\n/).slice(-n).join('\n');

if (cmd === 'lint' || cmd === 'check') {
  const extra = cmd === 'check' ? ['--timeout', '15000'] : [];
  const r = await engineJson([cmd, dir, '--json', ...extra], { timeoutMs: cmd === 'check' ? 240000 : 120000 });
  engineMissing(r);
  if (!r.json) die(`the engine's ${cmd} printed no result: ${lastLines(r.stderr || r.stdout)}`, 1);
  // lint answers { errorCount, findings }; check answers one such block per part: lint, runtime, layout, ...
  const parts = Array.isArray(r.json.findings) ? { [cmd]: r.json } : Object.fromEntries(
    Object.entries(r.json).filter(([, v]) => v && typeof v === 'object' && Array.isArray(v.findings)));
  const summary = {}, errorsList = [];
  for (const [name, part] of Object.entries(parts)) {
    summary[name] = { errors: part.errorCount ?? 0, warnings: part.warningCount ?? 0 };
    for (const f of part.findings) {
      if (/error/i.test(f.severity || '')) errorsList.push({ part: name, code: f.code, time: f.time, selector: f.selector, message: f.message, fix: f.fixHint });
    }
  }
  const ok = r.json.ok !== false && errorsList.length === 0;
  out({ ok, scene: id, command: cmd, errors: errorsList.length, summary, findings: errorsList.slice(0, 20), result: r.json });
  process.exit(ok ? 0 : 1);
}

// frames
const times = String(args.at || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!times.length || times.some((t) => !Number.isFinite(Number(t)) || Number(t) < 0)) {
  showUsage(import.meta.url, 2, '--at needs scene-local seconds, for example --at 0.5,1.8');
}
const outDir = path.resolve(args.out && args.out !== true ? args.out : path.join(root, 'work', 'frames', id));
removeTree(outDir);                       // only this tool's own frames live here
fs.mkdirSync(outDir, { recursive: true });

const r = await engine(['snapshot', dir, '--at', times.join(','), '--no-end', '-o', outDir], { timeoutMs: 300000, stallMs: 120000 });
engineMissing(r);
// The engine names each file frame-<index>-at-<seconds>s.png, one per time asked, in the order asked.
const NAME = /frame-(\d+)-at-([\d.]+)s\.png$/i;
const pngs = fs.readdirSync(outDir).filter((f) => /\.png$/i.test(f)).sort((a, b) => {
  const ma = a.match(NAME), mb = b.match(NAME);
  return ma && mb ? Number(ma[1]) - Number(mb[1]) : a.localeCompare(b);
});
if (r.code !== 0 || !pngs.length) die(`the engine could not take the frames: ${lastLines(r.stderr || r.stdout)}`, 1);

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const frames = pngs.map((f, i) => {
  const m = f.match(NAME);
  return { file: fwd(path.join(outDir, f)), t: m ? Number(m[2]) : (times[i] !== undefined ? Number(times[i]) : null) };
});
const repeated = times.filter((t, i) => times.indexOf(t) !== i);
let same = null;
if (repeated.length) {
  const groups = {};
  frames.forEach((f) => { if (f.t !== null) (groups[f.t] = groups[f.t] || []).push(hash(f.file)); });
  same = Object.values(groups).filter((g) => g.length > 1).every((g) => g.every((h) => h === g[0]));
  if (frames.length < times.length) note('the engine wrote fewer files than times asked: compare the repeated time by eye');
}
const sheet = path.join(outDir, 'contact-sheet.jpg');
out({ ok: true, scene: id, folder: fwd(outDir), frames, ...(fs.existsSync(sheet) ? { sheet: fwd(sheet) } : {}), ...(same === null ? {} : { same }) });
