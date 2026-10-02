#!/usr/bin/env node
// transcribe.mjs: speech to words with exact times, on this computer. Also writes subtitle and text files.
//
// Usage:
//   node transcribe.mjs <media> [-o audio/words.json] [--language he] [--script file.txt]
//                       [--srt file.srt] [--vtt file.vtt] [--txt file.txt] [--max-chars 32] [--max-words 6] [--marks auto]
//                       [--device auto|cpu|cuda] [--model <hugging face repo>] [--model-dir <folder>] [--vad]
//       Transcribes an audio or video file into words.json: [{ "text", "start", "end" }], in seconds.
//       --script is the text the speaker read: matched words take its spelling, names included.
//   node transcribe.mjs export <words.json> [--srt file] [--vtt file] [--txt file] [--max-chars 32] [--max-words 6] [--language he]
//       Only converts an existing words file. Fast, needs no Python.
//       --marks: Hebrew lines that hold Latin words, digits or punctuation are wrapped in invisible direction marks, so
//       players built on libass (mpv, burned-in subtitles) show them right to left. never = plain text, always = every line.
//   node transcribe.mjs fix <words.json> --text <corrected.txt>
//       Makes the words read exactly as a corrected text and keeps their times. The old file moves to _versions/.
//   node transcribe.mjs setup [--gpu]
//       Creates the private Python environment in ~/.focus-motion/venv and installs faster-whisper into it.
//       --gpu adds the NVIDIA libraries (Windows or Linux with an NVIDIA card, about 1.3 GB more).
//
// Example:
//   node transcribe.mjs "my video/work/norm/talk.mp4" -o "my video/audio/words.json" --srt "my video/talk.srt"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SKILL_ROOT, parseArgs, out, note, fwd, readJson, writeJson, findTool } from './lib/common.mjs';
import { removeTree } from './lib/cli.mjs';
import {
  fail, usage, findProjectRoot, archiveExisting, isRtl, readWords, wordsText, groupCues, toSrt, toVtt, toTxt, applyText,
  transcribeSetup, installTranscribe, ensureModel, MODELS_DIR, SPEECH_MODELS,
} from './lib/media.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['help', 'vad', 'gpu', 'no-holes'], aliases: { o: 'out', h: 'help' } });
if (args.help || !args._.length) usage(import.meta.url, args.help ? 0 : 2);

const str = (v) => (v === undefined || v === true || v === '' ? null : String(v));
const num = (v, d) => (str(v) === null ? d : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;

try {
  if (args._[0] === 'setup') await setup();
  else if (args._[0] === 'export') await exportOnly();
  else if (args._[0] === 'fix') await fix();
  else await transcribe();
} catch (e) { fail(e.message || String(e), 1); }

// Writes the subtitle and text files that were asked for. Returns what was written.
function writeExports(words, language, limit = Infinity) {
  const cueOpts = { maxChars: num(args['max-chars'], 32), maxWords: num(args['max-words'], 6) };
  const marks = str(args.marks) || 'auto';
  if (!['auto', 'always', 'never'].includes(marks)) fail('--marks is auto, always or never', 2);
  const clamp = (cues) => cues.map((c) => ({ ...c, end: Math.min(c.end, Math.max(limit, c.start + 0.05)) }));
  const rtl = isRtl(language);
  const written = {};
  const save = (key, text) => {
    const file = path.resolve(str(args[key]));
    const old = archiveExisting(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    written[key] = fwd(file);
    if (old) written[`${key}_previous`] = fwd(old);
  };
  let cues = null;
  if (str(args.srt)) { cues = clamp(groupCues(words, cueOpts)); save('srt', toSrt(cues, { rtl, marks })); }
  if (str(args.vtt)) { cues = cues || clamp(groupCues(words, cueOpts)); save('vtt', toVtt(cues, { rtl, marks })); }
  if (str(args.txt)) save('txt', toTxt(words));
  if (cues) written.cues = cues.length;
  return written;
}

function languageOf(file) {
  if (str(args.language)) return str(args.language).toLowerCase();
  const root = findProjectRoot(file);
  return (root && readJson(path.join(root, 'project.json'), {}).language) || 'he';
}

async function setup() {
  const res = await installTranscribe({ gpu: Boolean(args.gpu) });
  if (!res.ok) { out(res); process.stderr.write(`error: ${res.error}\n`); process.exit(res.install ? 3 : 1); }
  out(res);
}

async function exportOnly() {
  const file = path.resolve(str(args._[1]) || fail('give the words file: export <words.json> --srt|--vtt|--txt <file>', 2));
  if (!fs.existsSync(file)) fail(`not found: ${fwd(file)}`, 2);
  if (!str(args.srt) && !str(args.vtt) && !str(args.txt)) fail('choose at least one of --srt <file>, --vtt <file>, --txt <file>', 2);
  const words = readWords(file);
  out({ ok: true, words: words.length, ...writeExports(words, languageOf(file)) });
}

async function fix() {
  const file = path.resolve(str(args._[1]) || fail('give the words file: fix <words.json> --text <corrected.txt>', 2));
  if (!fs.existsSync(file)) fail(`not found: ${fwd(file)}`, 2);
  const textFile = path.resolve(str(args.text) || fail('give the corrected text: --text <file.txt>', 2));
  if (!fs.existsSync(textFile)) fail(`not found: ${fwd(textFile)}`, 2);
  const before = readWords(file);
  const { words, report } = applyText(before, fs.readFileSync(textFile, 'utf8').replace(/^\uFEFF/, ''), { mode: 'truth' });
  const old = archiveExisting(file);
  writeJson(file, words);
  const refreshed = refreshSiblings(file, words, languageOf(file));
  out({ ok: true, out: fwd(file), previous: old ? fwd(old) : null, words: words.length, words_before: before.length, ...report,
    ...writeExports(words, languageOf(file)), refreshed,
    ...(refreshed.length ? {} : { exports_note: `subtitle or text files made from the old words elsewhere are stale: node "${fwd(path.join(SKILL_ROOT, 'scripts', 'transcribe.mjs'))}" export "${fwd(file)}" --srt <file>` }),
    text: wordsText(words) });
}

// Subtitle and text files made earlier from this words file (same folder, same name: words.srt next to words.json)
// would now be stale. They are written again from the corrected words; the old ones move to _versions/.
function refreshSiblings(file, words, language) {
  const dir = path.dirname(file), base = path.basename(file, path.extname(file));
  const given = new Set(['srt', 'vtt', 'txt'].filter((k) => str(args[k])).map((k) => path.resolve(str(args[k]))));
  const cueOpts = { maxChars: num(args['max-chars'], 32), maxWords: num(args['max-words'], 6) };
  const rtl = isRtl(language), marks = str(args.marks) || 'auto';
  const refreshed = [];
  for (const ext of ['txt', 'srt', 'vtt']) {
    const f = path.join(dir, `${base}.${ext}`);
    if (!fs.existsSync(f) || given.has(path.resolve(f))) continue;
    const text = ext === 'txt' ? toTxt(words)
      : ext === 'srt' ? toSrt(groupCues(words, cueOpts), { rtl, marks }) : toVtt(groupCues(words, cueOpts), { rtl, marks });
    archiveExisting(f);
    fs.writeFileSync(f, text, 'utf8');
    refreshed.push(fwd(f));
  }
  return refreshed;
}

async function transcribe() {
  const media = path.resolve(args._[0]);
  if (!fs.existsSync(media)) fail(`not found: ${fwd(media)}`, 2);
  const target = path.resolve(str(args.out) || `${media.replace(/\.[^.]+$/, '')}.words.json`);
  const script = str(args.script) ? path.resolve(str(args.script)) : null;
  if (script && !fs.existsSync(script)) fail(`script not found: ${fwd(script)}`, 2);
  const language = languageOf(media);

  // 1. Python with faster-whisper
  const env = transcribeSetup();
  if (!env.ready) {
    out({ ok: false, error: 'transcription is not installed on this computer yet', missing: env.missing, install: env.install, by_hand: env.byHand });
    process.stderr.write(`error: transcription is not installed (${env.missing} is missing). Run:\n${env.install.map((s) => `  ${s.run}`).join('\n')}\n`);
    process.exit(3);
  }

  // 2. the speech model: a folder given by hand, or downloaded once by name
  const repo = str(args.model) || (language === 'he' ? SPEECH_MODELS.he : SPEECH_MODELS.other);
  const given = str(args['model-dir']) ? path.resolve(str(args['model-dir'])) : null;
  let modelDir, downloaded = false;
  if (given && fs.existsSync(path.join(given, 'model.bin'))) modelDir = given;
  else ({ dir: modelDir, downloaded } = await ensureModel(repo, given || MODELS_DIR));

  // 3. recognise. Python writes to a temporary file; the result is checked before anything is replaced.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-words-'));
  const raw = path.join(tmp, 'words.json');
  const pyArgs = [path.join(SKILL_ROOT, 'scripts', 'transcribe.py'), media, '-o', raw, '--language', language, '--model-dir', modelDir];
  const ff = findTool('ffmpeg');
  if (ff) pyArgs.push('--ffmpeg', ff);
  if (script) pyArgs.push('--script', script);
  if (str(args.device)) pyArgs.push('--device', str(args.device));
  if (str(args.threads)) pyArgs.push('--threads', str(args.threads));
  if (args.vad) pyArgs.push('--vad');
  if (args['no-holes']) pyArgs.push('--no-holes');
  note(`transcribing ${fwd(media)} (${language})`);
  const py = await new Promise((resolve) => {
    const child = spawn(env.python, pyArgs, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (e) => resolve({ code: 127, stdout: String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
  let res = null;
  for (const line of py.stdout.split(/\r?\n/).reverse()) { if (line.trim().startsWith('{')) { try { res = JSON.parse(line); break; } catch { /* not the result line */ } } }
  if (py.code !== 0 || !res?.ok) {
    removeTree(tmp);
    fail(res?.error || `the recogniser stopped (exit ${py.code})`, py.code === 3 ? 3 : 1, {
      ...(res?.cause ? { cause: res.cause } : {}),
      ...(res?.card_unused ? { card_unused: true, hint: `node "${fwd(path.join(SKILL_ROOT, 'scripts', 'transcribe.mjs'))}" setup --gpu` } : {}),
    });
  }
  let words = readWords(raw);
  removeTree(tmp);

  // 4. the script as a spelling guide
  let scriptReport = null;
  if (script) {
    const applied = applyText(words, fs.readFileSync(script, 'utf8').replace(/^\uFEFF/, ''), { mode: 'hint' });
    words = applied.words;
    scriptReport = applied.report;
  }

  const old = archiveExisting(target);
  writeJson(target, words);
  out({
    ok: true, out: fwd(target), previous: old ? fwd(old) : null, words: words.length, duration: res.duration, language,
    model: repo && !given ? repo : res.model, model_downloaded: downloaded, device: res.device, compute: res.compute,
    seconds: res.seconds, load_seconds: res.load_seconds, speed: res.speed, holes: res.holes,
    script: scriptReport, ...writeExports(words, language, res.duration),
    last_word_end: words.length ? r3(words[words.length - 1].end) : 0,
    ...(res.card_unused ? { hint: `an NVIDIA card is present but unused. Run: node "${fwd(path.join(SKILL_ROOT, 'scripts', 'transcribe.mjs'))}" setup --gpu (about 10 times faster, with little main memory)` } : {}),
    text: wordsText(words),
  });
}
