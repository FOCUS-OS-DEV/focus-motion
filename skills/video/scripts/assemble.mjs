#!/usr/bin/env node
// assemble.mjs: cuts the scene renders together on the scene list and lays the mixed sound under them.
//
// Usage:
//   node assemble.mjs <project> [--audio audio/mix.wav | --no-audio] [--bump]
//
//   --audio      the mixed sound to lay under the picture (default: audio/mix.wav of the project)
//   --no-audio   write a silent cut, for a look at the picture before the sound exists
//   --bump       start a new version: raise "version" in project.json and move the older cuts and their notes
//                to _versions/. Without it the cut of the current version is rebuilt in place.
//
// Every scene render is trimmed, or its last frame is held, to the exact frame count of its slot, so cuts land on
// their frames and nothing drifts. The result is <name>-v<version>.mp4 at the project root: H.264, yuv420p, bt709,
// AAC 256k, fast start.
//
// Example:
//   node assemble.mjs launch-video --bump
import fs from 'node:fs';
import path from 'node:path';
import { fwd, out, note, die, parseArgs, loadProject, saveProject, ffmpeg, mediaInfo, findTool, SKILL_ROOT } from './lib/common.mjs';
import { timeline, sceneState, BT709_FILTER } from './lib/scenes.mjs';
import { showUsage, round, removeTree, freePath } from './lib/cli.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['help', 'bump', 'no-audio'], aliases: { h: 'help' } });
if (args.help) showUsage(import.meta.url, 0);
if (args._.length !== 1) showUsage(import.meta.url, 2);
for (const tool of ['ffmpeg', 'ffprobe']) {
  if (!findTool(tool)) die(`${tool} was not found. Run the doctor: node "${fwd(path.join(SKILL_ROOT, 'scripts', 'doctor.mjs'))}"`, 3);
}

const { root, project } = loadProject(args._[0]);
const t = timeline(project);
const { fps } = t;
const { width, height } = project;
if (!t.scenes.length) die('the project has no scenes yet.', 2);
const rel = (p) => fwd(path.relative(root, p));

// ---------- the sound ----------
let audioFile = null;
if (args['no-audio'] && args.audio !== undefined) showUsage(import.meta.url, 2, 'choose --audio or --no-audio, not both');
if (!args['no-audio']) {
  const given = typeof args.audio === 'string';
  audioFile = path.resolve(root, given ? args.audio : 'audio/mix.wav');
  if (given && !fs.existsSync(audioFile)) audioFile = path.resolve(String(args.audio)); // a path from where the tool was started
  if (!fs.existsSync(audioFile)) {
    die(given ? `the audio file was not found: ${fwd(audioFile)}`
      : 'audio/mix.wav does not exist yet. Mix the sound first (mix.mjs), or pass --no-audio for a silent cut.', given ? 2 : 1);
  }
}

// ---------- the scene renders ----------
const warnings = [];
const states = t.scenes.map((s) => ({ scene: s, state: sceneState(root, project, s) }));
const missing = states.filter((x) => !x.state.rendered).map((x) => x.scene.id);
if (missing.length) {
  out({ ok: false, error: `not rendered yet: ${missing.join(', ')}. Render them first (render.mjs).`, missing });
  process.exitCode = 1;
} else {
  await assemble();
}

async function assemble() {
  const stale = states.filter((x) => x.state.stale).map((x) => x.scene.id);
  if (stale.length) warnings.push(`these renders are older than their scenes: ${stale.join(', ')}. Render them again (render.mjs --changed).`);
  const drafts = states.filter((x) => x.state.quality === 'draft').map((x) => x.scene.id);
  const quality = !drafts.length ? 'final' : drafts.length === states.length ? 'draft' : 'mixed';
  if (quality === 'mixed') warnings.push(`the cut mixes draft and final renders. Draft scenes: ${drafts.join(', ')}. Render them with --final before delivery.`);
  if (quality === 'draft') warnings.push('every scene is a draft render: this cut is for review, not for delivery.');

  const work = path.join(root, 'work', `assemble-${process.pid}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    // 1. every scene to its exact length, all with one encoder setting so they join without a re-encode
    const fast = quality !== 'final';
    const parts = [], rows = [];
    for (const { scene, state } of states) {
      const src = await mediaInfo(state.file);
      let have = src.frames;
      if (have === null) have = Math.round(src.duration * src.fps);
      const atProjectRate = Math.round(have * fps / (src.fps || fps)); // its length once it runs at the project rate
      const pad = Math.max(0, scene.frames - atProjectRate);
      const cut = Math.max(0, atProjectRate - scene.frames);
      if (pad > 1) warnings.push(`${scene.id}: the render is ${pad} frames short of its slot, so its last frame is held for ${round(pad / fps, 2)} s.`);
      if (cut > 1) warnings.push(`${scene.id}: the render is ${cut} frames longer than its slot, so its end is cut.`);
      const part = path.join(work, `${scene.id}.mp4`);
      const chain = [`fps=${fps}`, `scale=${width}:${height}:flags=lanczos`, 'format=yuv420p',
        `tpad=stop_mode=clone:stop=${pad + 2}`, `trim=end_frame=${scene.frames}`, 'setpts=PTS-STARTPTS', BT709_FILTER];
      note(`  ${scene.id}: ${scene.frames} frames`);
      await ffmpeg(['-i', state.file, '-an', '-vf', chain.join(','), '-c:v', 'libx264', '-preset', fast ? 'veryfast' : 'medium',
        '-crf', fast ? '20' : '14', '-r', String(fps), '-frames:v', String(scene.frames), part]);
      parts.push(part);
      rows.push({ id: scene.id, frames: scene.frames, rendered: have, held: pad, cut, quality: state.quality || 'unknown' });
    }

    // 2. join
    const list = path.join(work, 'list.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${fwd(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
    const video = path.join(work, 'video.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);

    // 3. the sound: padded with silence or cut so it is exactly as long as the picture
    const seconds = t.totalFrames / fps;
    const result = path.join(work, 'cut.mp4');
    let audio = null;
    if (audioFile) {
      const a = await mediaInfo(audioFile);
      if (!a.hasAudio) throw new Error(`${fwd(audioFile)} has no audio`);
      const diff = round(a.duration - seconds, 3);
      if (Math.abs(diff) > 1.5 / fps) warnings.push(`the audio is ${Math.abs(diff)} s ${diff > 0 ? 'longer than the picture, so its end is cut' : 'shorter than the picture, so the end is silent'}.`);
      await ffmpeg(['-i', video, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', 'apad', '-c:a', 'aac',
        '-b:a', '256k', '-ar', '48000', '-t', seconds.toFixed(6), '-movflags', '+faststart', result]);
      audio = { file: rel(audioFile).startsWith('..') ? fwd(audioFile) : rel(audioFile), seconds: round(a.duration), difference: diff };
    } else {
      await ffmpeg(['-i', video, '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', result]);
    }

    // 4. check the result before anything at the project root is touched
    const m = await mediaInfo(result);
    const bad = [];
    if (m.frames !== t.totalFrames) bad.push(`${m.frames} frames instead of ${t.totalFrames}`);
    if (m.width !== width || m.height !== height) bad.push(`size ${m.width}x${m.height}`);
    if (Math.abs(m.fps - fps) > 0.01) bad.push(`frame rate ${m.fps}`);
    if (m.pixFmt !== 'yuv420p') bad.push(`pixel format ${m.pixFmt}`);
    if (m.transfer !== 'bt709' || m.primaries !== 'bt709') bad.push(`colour tagged ${m.transfer}/${m.primaries}`);
    if (Boolean(audioFile) !== m.hasAudio) bad.push(audioFile ? 'the sound is missing' : 'unexpected sound');
    if (bad.length) throw new Error(`the assembled cut is not valid: ${bad.join('; ')}`);

    // 5. versions. The new cut goes in place first; only then do older cuts and their notes move to _versions/.
    //    Nothing is deleted. --bump on a version that has no cut yet keeps the number: there is nothing to bump past.
    const cutName = (v) => `${project.name}-v${v}`;
    let version = Number(project.version) || 1;
    if (args.bump && fs.existsSync(path.join(root, `${cutName(version)}.mp4`))) version += 1;
    const final = path.join(root, `${cutName(version)}.mp4`);
    try {
      fs.renameSync(result, final);
    } catch (e) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw new Error(`cannot replace ${rel(final)}: it is open in another program. Close the player and assemble again.`);
      throw e;
    }
    const moved = [];
    if (args.bump) {
      const older = new RegExp(`^${project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+)(\\.notes\\.json|\\.mp4)$`);
      for (const name of fs.readdirSync(root)) {
        const hit = name.match(older);
        if (!hit || Number(hit[1]) >= version) continue;
        const dest = freePath(path.join(root, '_versions', name));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(path.join(root, name), dest);
        moved.push(rel(dest));
      }
      if (version !== (Number(project.version) || 1)) { project.version = version; saveProject(root, project); }
    }

    out({
      ok: true, file: fwd(final), name: path.basename(final), version, quality,
      frames: t.totalFrames, duration: round(seconds), fps, width, height,
      megabytes: round(fs.statSync(final).size / 1024 / 1024, 1),
      audio, scenes: rows, moved, warnings,
    });
  } catch (e) {
    out({ ok: false, error: String(e.message || e).slice(0, 1200), warnings });
    process.exitCode = 1;
  } finally {
    removeTree(work);
  }
}
