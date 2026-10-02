#!/usr/bin/env node
// check.mjs: the gate. Run it on every cut before the user sees it. It measures the picture, the sound and the
// scene sources, and lists what is wrong.
//
// Usage:
//   node check.mjs <project> [--video file] [--only video,audio,scenes]
//
//   <project>      the project folder (the one with project.json)
//   --video file   check this file instead of the current cut <name>-v<version>.mp4. A scene render
//                  (renders/s03.mp4) is checked as that scene alone: its own length and source, no audio
//   --only ...     run only some groups, for example --only scenes before a render
//
// stdout carries one JSON line:
//   { ok, fail, warn, mode, project, video, checked, findings: [...], measured: {...}, skipped: [...] }
//   A finding is { level: "FAIL" | "WARN", check, message } plus t, t_end (seconds) and scene for a moment in the
//   video, or scene, file and line for a place in a scene source. For a scene render t is the time inside the
//   render and cut_t the time in the whole cut.
// Exit code: 0 no FAIL (warnings are allowed), 1 at least one FAIL, 2 a bad call or nothing to check,
//            3 ffmpeg is missing.
//
// What it checks. The limits were calibrated on our own cuts. The picture is analysed at 30 fps on a grey frame
// whose short side is 135 px, so the numbers mean the same for every size and frame rate.
//   video
//     size, fps         equal to project.json                                                          FAIL
//     pixel-format      yuv420p                                                                        FAIL
//     colour            transfer, primaries and matrix tagged bt709, limited range                     FAIL
//     duration          within 0.2 s of the end of the scene list                                      FAIL
//     decode            the file opens and the picture runs to its end                                 FAIL
//     black-frames      a frame with 99.5 % of its pixels under 3 % brightness                         FAIL
//                       (WARN when the video only ends on black)
//     dead-stretch      nothing new happens: the difference between frames, averaged over 0.2 s, stays
//                       under 0.6 (of 255) for 0.7 s or more. A slow drift or a breathing scale does
//                       not count as something new. The last 1.5 s are exempt.           WARN, FAIL from 1.8 s
//     flashes           more than 3 brightness jumps in any second. A jump is the mean brightness
//                       moving by more than 2 % between two frames; jumps in the same direction
//                       count once                                                                     FAIL
//   audio
//     loudness          integrated loudness -14 LUFS, within 1                                         FAIL
//     true-peak         the mix is mastered to -1 dBTP; the cut may read up to -0.5 after AAC           FAIL
//     av-length         audio and video lengths within 0.2 s                                           FAIL
//     no-audio          the cut has no audio stream                                                    WARN
//     voice-silence     a pause over 0.45 s inside audio/voice.wav (more than 14 dB under the speech)  WARN
//   scenes              every scenes/<id>/index.html of the scene list
//     hebrew-hyphen     a hyphen or dash between two Hebrew words in text that reaches the screen      FAIL
//     nondeterministic  Math.random(, setTimeout(, setInterval(, requestAnimationFrame(, repeat: -1    FAIL
//     css-motion        a CSS transition, animation or @keyframes                                      FAIL
//     font-face         a font family used with no @font-face                                          FAIL
//     video-muted       a <video> without muted                                                        FAIL
//     http-asset        a script, style, font, image or video loaded from the network                  FAIL
//   Comments are never read as code or as text. Scripts and styles in other files are not scanned.
//
// Example:
//   node check.mjs "my videos/launch"
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, out, note, die, fwd, loadProject, mediaInfo, ffprobeJson } from './lib/common.mjs';
import { THRESHOLDS as T, tool, printUsage, round, videoSignals, deadStretches, blackRuns, flashBursts,
  measureLoudness, voiceSilences, scanScene } from './lib/quality.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['help'], aliases: { h: 'help' } });
if (args.help) printUsage(import.meta.url);
if (!args._[0]) printUsage(import.meta.url, 2);

let root, project;
try { ({ root, project } = loadProject(args._[0])); } catch (e) { die(e.message, 2); }
const scenes = (Array.isArray(project.scenes) ? project.scenes : [])
  .filter((s) => s && s.id !== undefined)
  .map((s) => ({ ...s, id: String(s.id), start: Number(s.start), end: Number(s.end) }));

const GROUPS = ['video', 'audio', 'scenes'];
let groups = new Set(GROUPS);
if (args.only !== undefined) {
  groups = new Set(String(args.only).split(',').map((g) => g.trim()).filter(Boolean));
  if (!groups.size || [...groups].some((g) => !GROUPS.includes(g))) die('--only takes video, audio, scenes (comma separated)', 2);
}

// ---------- which file ----------
let video = null, mode = 'cut', single = null;       // single: the scene of a scene render
if (args.video !== undefined) {
  if (args.video === true) die('--video needs a file', 2);
  video = [path.resolve(String(args.video)), path.resolve(root, String(args.video))].find((p) => fs.existsSync(p));
  if (!video) die(`video not found: ${fwd(path.resolve(String(args.video)))}`, 2);
  const inRenders = path.relative(path.join(root, 'renders'), video);
  if (!inRenders.startsWith('..') && !path.isAbsolute(inRenders)) {
    single = scenes.find((s) => s.id === path.basename(video).replace(/\.[^.]+$/, '')) || null;
    if (single) mode = 'scene';
  }
} else if (groups.has('video') || groups.has('audio')) {
  video = path.join(root, `${project.name || path.basename(root)}-v${project.version ?? 1}.mp4`);
  if (!fs.existsSync(video)) die(`no cut to check: ${fwd(video)} does not exist. Assemble first, pass --video <file>, or run --only scenes`, 2);
}
if (video) tool('ffmpeg');

const findings = [], skipped = [], measured = {};
const add = (level, check, message, where = {}) => findings.push({ level, check, ...where, message });
const sceneAt = (t) => (mode === 'scene' ? single : scenes.find((s) => t >= s.start - 1e-6 && t < s.end)) || null;
// Where a moment is: its time in the checked file, the scene, and for a scene render also its time in the cut.
const at = (t, tEnd) => {
  const s = sceneAt(t);
  return { t: round(t), ...(tEnd !== undefined ? { t_end: round(tEnd) } : {}), ...(s ? { scene: s.id } : {}),
    ...(mode === 'scene' ? { cut_t: round(single.start + t) } : {}) };
};
const inScene = (t) => { const s = sceneAt(t); return s && mode === 'cut' ? ` in ${s.id}` : ''; };
const sec = (x) => `${round(x).toFixed(2)} s`;

// ---------- the scene list ----------
let listEnd = null;                                   // the length the video should have
if (mode === 'scene') listEnd = single.end - single.start;
else if (!scenes.length) add('FAIL', 'scene-list', 'project.json has no scenes, so the length of the video cannot be checked');
else {
  const broken = scenes.find((s, i) => !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start
    || Math.abs(s.start - (i ? scenes[i - 1].end : 0)) > 0.001);
  if (broken) add('FAIL', 'scene-list', `the scene list is not contiguous at ${broken.id}: every scene starts where the one before ends, and the first starts at 0`, { scene: broken.id });
  else listEnd = scenes[scenes.length - 1].end;
}

// ---------- video ----------
let info = null, probe = null, videoSeconds = null;
if (video) {
  try {
    info = await mediaInfo(video);
    probe = await ffprobeJson(video);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    if (v) videoSeconds = Number(v.duration) > 0 ? Number(v.duration) : info.frames && info.fps ? info.frames / info.fps : info.duration;
  } catch (e) {
    // A file ffprobe cannot open is a finding, not a crash: the cut is broken.
    add('FAIL', 'decode', `the file cannot be read: ${fwd(e.message).split(/\r?\n/)[0]}`);
    info = null;
  }
}

if (info && groups.has('video')) {
  if (!info.hasVideo) add('FAIL', 'size', 'the file has no video stream');
  else {
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const turned = Math.abs(info.rotation) % 180 === 90;
    const width = turned ? info.height : info.width, height = turned ? info.width : info.height;
    Object.assign(measured, { width, height, fps: round(info.fps), pixFmt: info.pixFmt,
      colour: [v.color_transfer, v.color_primaries, v.color_space].map((c) => c || 'unknown').join('/'),
      seconds: round(videoSeconds, 3), ...(listEnd !== null ? { expected: round(listEnd, 3) } : {}) });

    if (width !== Number(project.width) || height !== Number(project.height)) {
      add('FAIL', 'size', `the video is ${width}x${height} but the project is ${project.width}x${project.height}`);
    }
    if (Math.abs(info.fps - Number(project.fps)) > 0.02) add('FAIL', 'fps', `the video is ${info.fps} fps but the project is ${project.fps}`);
    if (info.pixFmt !== 'yuv420p') add('FAIL', 'pixel-format', `the pixel format is ${info.pixFmt}; phones and browsers need yuv420p`);
    const tags = { transfer: v.color_transfer, primaries: v.color_primaries, matrix: v.color_space };
    const off = Object.entries(tags).filter(([, value]) => value !== 'bt709').map(([k, value]) => `${k} ${value || 'missing'}`);
    if (off.length) {
      add('FAIL', 'colour', `the colour is not tagged bt709 (${off.join(', ')}): ${info.hdr ? 'this is HDR, it looks burnt and red on a phone' : 'players guess and the colours shift'}; convert and tag it as SDR bt709`);
    } else if (v.color_range === 'pc') add('FAIL', 'colour', 'the video is full range (pc); deliver limited range (tv) so blacks and whites are not crushed');
    if (listEnd !== null && Math.abs(videoSeconds - listEnd) > T.durationTolerance) {
      const d = videoSeconds - listEnd;
      add('FAIL', 'duration', `the video is ${sec(videoSeconds)} but ${mode === 'scene' ? `scene ${single.id} is` : 'the scene list ends at'} ${sec(listEnd)} (${sec(Math.abs(d))} too ${d < 0 ? 'short' : 'long'})`);
    }

    note(`reading the frames of ${path.basename(video)} ...`);
    let sig = null;
    try { sig = await videoSignals(video, { width, height }); } catch (e) { add('FAIL', 'decode', fwd(e.message)); }
    if (sig) {
      if (!sig.complete || sig.seconds < videoSeconds - 0.5) {
        add('FAIL', 'decode', `the picture stops at ${sec(sig.seconds)} although the file says ${sec(videoSeconds)}: the file is damaged or cut off`, at(sig.seconds));
      }
      for (const b of blackRuns(sig)) {
        const span = b.frames === 1 ? `one black frame at ${sec(b.t)}` : `black for ${sec(b.t_end - b.t)} from ${sec(b.t)}`;
        if (b.atStart) add('FAIL', 'black-frames', `the video opens on black (${span}): the first frame is the cover and the hook`, at(b.t, b.t_end));
        else if (b.atEnd) add('WARN', 'black-frames', `the video ends on black (${span}): fine only if the plan asks for a fade out`, at(b.t, b.t_end));
        else add('FAIL', 'black-frames', `${span}${inScene(b.t)}: an empty frame flickers; a scene must be complete from its first frame to its last`, at(b.t, b.t_end));
      }
      const lastScene = mode === 'cut' || (scenes.length && single === scenes[scenes.length - 1]);
      const dead = deadStretches(sig, { exemptTail: lastScene ? T.exemptTail : 0 });
      for (const d of dead) {
        const what = d.frozen
          ? 'the picture is frozen, nothing moves at all. A scene shorter than its slot is padded with its last frame; otherwise keep a slow push on every hold'
          : 'only slow or ambient motion. Land something new on a spoken word, or tighten the timing';
        add(d.seconds >= T.deadFail ? 'FAIL' : 'WARN', 'dead-stretch', `nothing new for ${sec(d.seconds)} (${d.t.toFixed(2)} to ${d.t_end.toFixed(2)})${inScene(d.t)}: ${what}`, at(d.t, d.t_end));
      }
      const flash = flashBursts(sig);
      for (const f of flash.bursts) {
        add('FAIL', 'flashes', `${f.jumps} brightness jumps within one second from ${sec(f.t)}${inScene(f.t)} (the limit is ${T.flashMax}): flashing is hard to watch and unsafe for some viewers; space the hits or soften them`, at(f.t, f.t_end));
      }
      Object.assign(measured, { deadStretches: dead.length, longestDead: dead.reduce((m, d) => Math.max(m, d.seconds), 0), flashPeak: flash.peak });
    }
  }
}

// ---------- audio ----------
if (info && groups.has('audio')) {
  if (mode === 'scene') skipped.push('audio: a scene render has no sound');
  else {
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    if (!a) add('WARN', 'no-audio', 'the cut has no audio stream: fine for a silent draft, not for delivery');
    else {
      note('measuring the loudness ...');
      try {
        const loud = await measureLoudness(video);
        Object.assign(measured, { lufs: loud.lufs, truePeak: loud.truePeak === -Infinity ? null : loud.truePeak });
        if (Math.abs(loud.lufs - T.lufsTarget) > T.lufsTolerance + 1e-9) {
          add('FAIL', 'loudness', `the loudness is ${loud.lufs} LUFS; the target is ${T.lufsTarget} LUFS, within ${T.lufsTolerance}${loud.lufs < -50 ? ' (the audio is silent)' : ''}`);
        }
        const ceiling = T.truePeakMax + T.truePeakCodecAllowance;
        if (loud.truePeak !== null && loud.truePeak > ceiling + 1e-9) {
          add('FAIL', 'true-peak', `the true peak is ${loud.truePeak} dBTP; the mix is mastered to ${T.truePeakMax} dBTP and the cut may read up to ${ceiling} after AAC`);
        }
      } catch (e) { add('FAIL', 'loudness', e.message); }
      const audioSeconds = Number(a.duration) > 0 ? Number(a.duration) : info.duration;
      measured.audioSeconds = round(audioSeconds, 3);
      if (info.hasVideo && Math.abs(audioSeconds - videoSeconds) > T.avLengthTolerance) {
        add('FAIL', 'av-length', `the audio is ${sec(audioSeconds)} and the video ${sec(videoSeconds)}: they must end together`);
      }
    }
    const voice = path.join(root, 'audio', 'voice.wav');
    if (!fs.existsSync(voice)) skipped.push('voice-silence: no audio/voice.wav in this project');
    else {
      try {
        const vs = await voiceSilences(voice);
        Object.assign(measured, { voiceSeconds: vs.seconds, voiceSilences: vs.silences.length });
        for (const s of vs.silences) {
          add('WARN', 'voice-silence', `${sec(s.seconds)} of silence in the voice at ${sec(s.t)}${inScene(s.t)}: tighten the pause, or cover it on purpose`, at(s.t, s.t_end));
        }
      } catch (e) { add('WARN', 'voice-silence', e.message); }
    }
  }
}

// ---------- scene sources ----------
if (groups.has('scenes')) {
  const dir = path.join(root, 'scenes');
  let onDisk = [];
  try { onDisk = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no scenes folder */ }
  const listed = mode === 'scene' ? [single.id] : scenes.length ? scenes.map((s) => s.id) : onDisk;
  const ids = listed.filter((id) => fs.existsSync(path.join(dir, id, 'index.html')));
  const extra = onDisk.filter((id) => !listed.includes(id));
  if (extra.length && mode === 'cut') skipped.push(`scenes not in the scene list were not checked: ${extra.join(', ')}`);
  if (!ids.length) skipped.push('scenes: no scenes/<id>/index.html to check');
  measured.scenesChecked = ids.length;
  for (const id of ids) {
    const file = path.join(dir, id, 'index.html');
    const html = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    // Local stylesheets the scene links: read only so that their @font-face rules count.
    const extraCss = [];
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
      const target = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').split(/[?#]/)[0];
      if (!/stylesheet/i.test(m[0]) || !target || /^(?:[a-z]+:)?\/\//i.test(target)) continue;
      try { extraCss.push(fs.readFileSync(path.resolve(path.dirname(file), decodeURI(target)), 'utf8')); } catch { /* missing file: the engine's lint reports it */ }
    }
    const perCheck = {};
    for (const f of scanScene(html, { extraCss })) {
      perCheck[f.check] = (perCheck[f.check] || 0) + 1;
      if (perCheck[f.check] <= 12) add(f.level, f.check, f.message, { scene: id, file: fwd(path.relative(root, file)), line: f.line });
    }
    for (const [check, n] of Object.entries(perCheck)) {
      if (n > 12) add('FAIL', check, `${n - 12} more "${check}" findings in this scene are not listed`, { scene: id, file: fwd(path.relative(root, file)) });
    }
  }
}

// ---------- result ----------
const order = (f) => [f.level === 'FAIL' ? 0 : 1, f.t === undefined ? 1 : 0, f.t ?? 0, f.scene ?? '', f.line ?? 0];
findings.sort((a, b) => { const x = order(a), y = order(b); for (let i = 0; i < x.length; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; } return 0; });
const fail = findings.filter((f) => f.level === 'FAIL').length;
out({
  ok: fail === 0, fail, warn: findings.length - fail, mode, ...(single ? { scene: single.id } : {}),
  project: fwd(root), ...(video ? { video: fwd(video) } : {}), checked: [...groups], findings, measured, skipped,
});
process.exitCode = fail ? 1 : 0;
