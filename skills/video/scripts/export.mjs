#!/usr/bin/env node
// export.mjs: the small extras a finished video often needs.
//
// Usage:
//   node export.mjs cover <video> [--at 1.0] [-o cover.jpg]         one frame as a cover image
//   node export.mjs small <video> [--max-mb 15] [-o small.mp4]      a lighter copy for messaging apps
//   node export.mjs gif <video> [--start 0] [--len 4] [--width 360] [--fps 12] [-o clip.gif]
//
// Example:
//   node export.mjs cover "launch/launch-v3.mp4" --at 2.4
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, out, die, fwd, ffmpeg, mediaInfo } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['help'], aliases: { o: 'out' } });
const [job, video] = args._;
if (args.help || !job || !video) {
  process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(args.help ? 0 : 2);
}

const src = path.resolve(video);
if (!fs.existsSync(src)) die(`not found: ${fwd(src)}`, 2);
const base = src.replace(/\.[^.]+$/, '');
const info = await mediaInfo(src);
const num = (v, d) => (v === undefined || v === true ? d : Number(v));

if (job === 'cover') {
  const at = Math.min(Math.max(num(args.at, 1), 0), Math.max(info.duration - 0.05, 0));
  const dst = path.resolve(args.out || `${base}-cover.jpg`);
  await ffmpeg(['-ss', String(at), '-i', src, '-frames:v', '1', '-q:v', '2', dst]);
  out({ job, out: fwd(dst), at, width: info.width, height: info.height });
} else if (job === 'small') {
  const maxMb = num(args['max-mb'], 15);
  const dst = path.resolve(args.out || `${base}-small.mp4`);
  // Fit the size: the audio takes 128 kbit/s, the video gets the rest, capped so short clips are not bloated.
  const totalKbit = (maxMb * 8 * 1024 * 0.94) / Math.max(info.duration, 1);
  const videoKbit = Math.max(300, Math.min(Math.floor(totalKbit - 128), 3500));
  const longSide = 1280;
  const scale = info.height >= info.width ? `scale=-2:'min(${longSide},ih)'` : `scale='min(${longSide},iw)':-2`;
  await ffmpeg(['-i', src, '-vf', scale, '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${videoKbit}k`,
    '-maxrate', `${Math.floor(videoKbit * 1.4)}k`, '-bufsize', `${videoKbit * 2}k`, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dst]);
  const mb = fs.statSync(dst).size / 1024 / 1024;
  out({ job, out: fwd(dst), megabytes: Math.round(mb * 10) / 10, videoKbit, underLimit: mb <= maxMb });
} else if (job === 'gif') {
  const start = num(args.start, 0), len = num(args.len, 4), width = num(args.width, 360), fps = num(args.fps, 12);
  const dst = path.resolve(args.out || `${base}.gif`);
  const chain = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
  await ffmpeg(['-ss', String(start), '-t', String(len), '-i', src, '-filter_complex', chain, '-loop', '0', dst]);
  const mb = fs.statSync(dst).size / 1024 / 1024;
  out({ job, out: fwd(dst), megabytes: Math.round(mb * 100) / 100, start, len, width, fps });
} else {
  die(`unknown job "${job}". Use cover, small or gif.`, 2);
}
