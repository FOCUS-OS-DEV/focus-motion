// Audio helpers for the sound tools (mix.mjs, voice.mjs). Node built-ins only; ffmpeg does the decoding and the
// loudness measurements. Samples are Float32Array, one per channel, in the range -1..1.
//
//   import { readWav, writeWav, decodeAudio, measureLoudness } from './lib/wav.mjs';
//   const { sampleRate, channels } = readWav('assets/sfx/hit.wav');   // channels[0] is the left (or only) channel
//   writeWav('out.wav', [left, right], 48000);                        // 24-bit PCM; { bits: 32 } writes float
//   const voice = await decodeAudio('take.m4a', { channels: 1 });     // any media, resampled to 48 kHz
//   const { I, TP } = await measureLoudness('mix.wav');               // LUFS and dBTP, as the gate measures them
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, findTool, mediaInfo, runSync } from './common.mjs';
import { removeTree } from './cli.mjs';

export const SR = 48000;

export const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));
export const fromDb = (d) => 10 ** (d / 20);

// ---------- WAV files ----------
// Reads PCM 8/16/24/32-bit and float 32/64-bit, plain or WAVE_FORMAT_EXTENSIBLE, any channel count.
export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.length < 12 || b.toString('latin1', 8, 12) !== 'WAVE' || !['RIFF', 'RF64'].includes(b.toString('latin1', 0, 4))) {
    throw new Error(`not a WAV file: ${file}`);
  }
  let fmt = null, dataAt = -1, dataLen = 0;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString('latin1', p, p + 4);
    let size = b.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      let tag = b.readUInt16LE(body);
      const bits = b.readUInt16LE(body + 14);
      if (tag === 0xfffe && size >= 26) tag = b.readUInt16LE(body + 24); // the real format sits in the sub-format
      fmt = { tag, channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), blockAlign: b.readUInt16LE(body + 12), bits };
    } else if (id === 'data') {
      // A streamed file may carry a size of 0 or 0xFFFFFFFF: then the samples run to the end of the file.
      if (size === 0 || size === 0xffffffff || body + size > b.length) size = b.length - body;
      dataAt = body; dataLen = size;
      break;
    }
    p = body + size + (size & 1);
  }
  if (!fmt || dataAt < 0) throw new Error(`WAV file has no audio data: ${file}`);
  const { tag, channels: nch, sampleRate, bits } = fmt;
  const bytes = bits >> 3;
  if (!nch || !bytes || (tag !== 1 && tag !== 3)) throw new Error(`unsupported WAV encoding (format ${tag}, ${bits} bit): ${file}`);
  const step = fmt.blockAlign || bytes * nch;
  const frames = Math.floor(dataLen / step);
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  for (let c = 0; c < nch; c++) {
    const dst = channels[c];
    let p = dataAt + c * bytes;
    if (tag === 3 && bytes === 4) for (let i = 0; i < frames; i++, p += step) dst[i] = b.readFloatLE(p);
    else if (tag === 3 && bytes === 8) for (let i = 0; i < frames; i++, p += step) dst[i] = b.readDoubleLE(p);
    else if (bytes === 2) for (let i = 0; i < frames; i++, p += step) dst[i] = b.readInt16LE(p) / 32768;
    else if (bytes === 3) for (let i = 0; i < frames; i++, p += step) dst[i] = ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8 >> 8) / 8388608;
    else if (bytes === 4) for (let i = 0; i < frames; i++, p += step) dst[i] = b.readInt32LE(p) / 2147483648;
    else if (bytes === 1) for (let i = 0; i < frames; i++, p += step) dst[i] = (b[p] - 128) / 128;
    else throw new Error(`unsupported WAV sample size (${bits} bit): ${file}`);
  }
  return { sampleRate, channels, frames, bits, float: tag === 3 };
}

// Writes 24-bit PCM by default. bits: 16, 24, or 32 (float, keeps values above full scale).
export function writeWav(file, channels, sampleRate = SR, { bits = 24 } = {}) {
  const nch = channels.length;
  const frames = nch ? channels[0].length : 0;
  const bytes = bits >> 3;
  const float = bits === 32;
  if (![16, 24, 32].includes(bits)) throw new Error(`writeWav: unsupported bit depth ${bits}`);
  const dataLen = frames * nch * bytes;
  if (dataLen > 0xfffffff0 - 64) throw new Error('writeWav: the audio is too long for a WAV file');
  const head = float ? 58 : 44;
  const b = Buffer.allocUnsafe(head + dataLen);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(head - 8 + dataLen, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(float ? 18 : 16, 16);
  b.writeUInt16LE(float ? 3 : 1, 20); b.writeUInt16LE(nch, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * nch * bytes, 28); b.writeUInt16LE(nch * bytes, 32); b.writeUInt16LE(bits, 34);
  let p = 36;
  if (float) {
    b.writeUInt16LE(0, 36);
    b.write('fact', 38, 'latin1'); b.writeUInt32LE(4, 42); b.writeUInt32LE(frames, 46);
    p = 50;
  }
  b.write('data', p, 'latin1'); b.writeUInt32LE(dataLen, p + 4);
  p += 8;
  const step = nch * bytes;
  for (let c = 0; c < nch; c++) {
    const src = channels[c];
    let q = p + c * bytes;
    if (float) for (let i = 0; i < frames; i++, q += step) b.writeFloatLE(src[i], q);
    else if (bytes === 3) {
      for (let i = 0; i < frames; i++, q += step) {
        let v = Math.round(src[i] * 8388608);
        v = v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v;
        b[q] = v & 255; b[q + 1] = (v >> 8) & 255; b[q + 2] = (v >> 16) & 255;
      }
    } else {
      for (let i = 0; i < frames; i++, q += step) {
        const v = Math.round(src[i] * 32768);
        b.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, q);
      }
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, b);
  return { frames, seconds: frames / sampleRate };
}

// ---------- temp space ----------
// Runs fn(dir) with a private folder in the system temp space and removes the folder afterwards.
export async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-motion-'));
  try {
    return await fn(dir);
  } finally {
    removeTree(dir);   // not fs.rmSync: on Windows it silently skips paths with Hebrew letters (a Hebrew user name)
  }
}

// ---------- ffmpeg ----------
// Decodes the first audio stream of any media file to float samples at `sampleRate`.
// channels: 1 mixes down to mono, 2 gives stereo, 0 keeps mono as mono and turns everything else into stereo.
export async function decodeAudio(file, { sampleRate = SR, channels = 0, start = 0, duration = 0, dir } = {}) {
  const info = await mediaInfo(file);
  if (!info.hasAudio) throw new Error(`there is no sound in ${file}`);
  const nch = channels || Math.min(2, info.channels || 1);
  const work = async (tmp) => {
    const wav = path.join(tmp, `decode-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    const args = ['-v', 'error', '-nostdin'];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn');
    if (duration > 0) args.push('-t', String(duration));
    args.push('-ac', String(nch), '-ar', String(sampleRate), '-c:a', 'pcm_f32le', wav);
    await ffmpeg(args);
    const audio = readWav(wav);
    try { fs.unlinkSync(wav); } catch { /* removed with its folder */ }
    return { ...audio, source: info };
  };
  return dir ? work(dir) : withTempDir(work);
}

const num = (s) => (s === undefined ? NaN : /inf/i.test(s) ? (s.trim().startsWith('-') ? -Infinity : Infinity) : Number(s));

// Reads the summary ffmpeg's ebur128 filter prints at the end of a run.
export function parseLoudness(stderr) {
  const tail = stderr.slice(stderr.lastIndexOf('Summary:'));
  const pick = (re) => { const m = tail.match(re); return m ? num(m[1]) : NaN; };
  const I = pick(/\bI:\s+(-?[\d.]+|-?inf|nan)\s+LUFS/i);
  return {
    I: I <= -69.9 ? -Infinity : I,            // ebur128 prints -70.0 for silence
    LRA: pick(/\bLRA:\s+(-?[\d.]+|-?inf|nan)\s+LU\b/i),
    TP: pick(/\bPeak:\s+(-?[\d.]+|-?inf|nan)\s+dBFS/i),
  };
}

// A mono file plays from both speakers, so it is measured as two equal channels (3 LU above the bare mono figure).
const METER = 'ebur128=peak=true:dualmono=true:framelog=quiet';

// Integrated loudness (LUFS), loudness range (LU) and true peak (dBTP) of a file, to one decimal.
export async function measureLoudness(file, { filters = '' } = {}) {
  const af = [filters, METER].filter(Boolean).join(',');
  const r = await ffmpeg(['-nostdin', '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-af', af, '-f', 'null', '-']);
  const m = parseLoudness(r.stderr);
  if (Number.isNaN(m.I)) throw new Error(`could not measure the loudness of ${file}`);
  return m;
}

let limiterLatency;
// Newer ffmpeg can compensate the limiter's look-ahead delay; older builds reject the option.
function limiterHasLatency() {
  if (limiterLatency === undefined) {
    const tool = findTool('ffmpeg');
    const r = tool ? runSync(tool, ['-hide_banner', '-h', 'filter=alimiter']) : { stdout: '' };
    limiterLatency = /\blatency\b/.test(r.stdout);
  }
  return limiterLatency;
}

// Brings a file to a loudness target with one plain gain. Only when the peaks would pass the ceiling, a look-ahead
// limiter (run at 192 kHz so it sees the true peaks) holds them. The result is measured and corrected until it sits
// on the target. Returns what was done and the final numbers.
export async function normalizeLoudness(inFile, outFile, {
  target = -14, ceiling = -1.5, maxTruePeak = -1, codec = 'pcm_s24le', sampleRate = SR, measured = null, tolerance = 0.15,
} = {}) {
  const before = measured || await measureLoudness(inFile);
  if (!Number.isFinite(before.I)) throw new Error('the audio is silent, there is nothing to bring to a loudness target');
  let gain = target - before.I;
  let limit = ceiling;
  let after = null, limited = false, passes = 0, prev = null;
  for (;;) {
    passes++;
    limited = before.TP + gain > limit;
    const chain = [`volume=${gain.toFixed(2)}dB`];
    if (limited) {
      chain.push('aresample=192000',
        `alimiter=limit=${fromDb(limit).toFixed(5)}:attack=5:release=80:asc=1:level=0${limiterHasLatency() ? ':latency=1' : ''}`,
        `aresample=${sampleRate}`);
    }
    const graph = `[0:a:0]${chain.join(',')},asplit[file][meter];[meter]${METER}[null]`;
    const r = await ffmpeg(['-nostdin', '-nostats', '-i', inFile, '-filter_complex', graph,
      '-map', '[file]', '-ar', String(sampleRate), '-c:a', codec, outFile, '-map', '[null]', '-f', 'null', '-']);
    after = parseLoudness(r.stderr);
    const off = target - after.I;
    const over = after.TP - maxTruePeak;
    if (process.env.FOCUS_MOTION_DEBUG) process.stderr.write(`master pass ${passes}: gain ${gain.toFixed(2)} dB, limiter ${limited ? limit.toFixed(2) : 'off'} -> ${after.I} LUFS, ${after.TP} dBTP\n`);
    if ((Math.abs(off) <= tolerance && over <= 0) || passes >= 6 || !Number.isFinite(after.I)) break;
    // The limiter takes some loudness away, so the gain is corrected. From the second pass on, the measured slope
    // (loudness gained per dB of gain) sets the size of the step.
    let slope = 1;
    if (prev && Math.abs(gain - prev.gain) > 0.05) slope = Math.min(1, Math.max(0.3, (after.I - prev.I) / (gain - prev.gain)));
    prev = { gain, I: after.I };
    gain += off / slope;
    if (over > 0) limit -= over + 0.1;
  }
  return { before, after, gainDb: Math.round(gain * 100) / 100, limited, passes };
}

// ---------- levels ----------
// RMS level in dB of consecutive frames of `hop` seconds.
export function frameLevels(x, sampleRate = SR, hop = 0.01) {
  const size = Math.max(1, Math.round(hop * sampleRate));
  const count = Math.floor(x.length / size);
  const out = new Float64Array(count);
  for (let f = 0, p = 0; f < count; f++) {
    let sum = 0;
    for (let i = 0; i < size; i++, p++) sum += x[p] * x[p];
    out[f] = 10 * Math.log10(sum / size + 1e-12);
  }
  return out;
}

// The p-th percentile (0..100) with linear interpolation. `stride` samples every n-th value of a long array.
export function percentile(values, p, stride = 1) {
  const count = Math.ceil(values.length / stride);
  if (!count) return NaN;
  const sorted = new Float64Array(count);
  for (let i = 0, j = 0; j < count; i += stride, j++) sorted[j] = values[i];
  sorted.sort();
  const pos = (p / 100) * (count - 1);
  const lo = Math.floor(pos), hi = Math.min(count - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Centred moving average over `win` samples; the edges repeat the first and the last full window.
export function movingAverage(x, win) {
  const n = x.length;
  const out = new Float32Array(n);
  if (!n) return out;
  win = Math.max(1, Math.min(Math.floor(win), n));
  const half = win >> 1;
  const count = n - win + 1;
  let sum = 0;
  for (let i = 0; i < win; i++) sum += x[i];
  const first = sum / win;
  for (let i = 0; i < half; i++) out[i] = first;
  for (let k = 0; ; k++) {
    out[half + k] = sum / win;
    if (k + 1 >= count) break;
    sum += x[k + win] - x[k];
  }
  const last = out[half + count - 1];
  for (let i = half + count; i < n; i++) out[i] = last;
  return out;
}

// ---------- filters ----------
// Butterworth low-pass or high-pass of an even order, as second-order sections.
export function butterworth(type, order, freq, sampleRate = SR) {
  const sections = [];
  const w0 = 2 * Math.PI * freq / sampleRate;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  for (let k = 0; k < order / 2; k++) {
    const q = 1 / (2 * Math.cos(Math.PI * (2 * k + 1) / (2 * order)));
    const alpha = sin / (2 * q);
    const a0 = 1 + alpha;
    const b = type === 'high' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
    sections.push([b[0] / a0, b[1] / a0, b[2] / a0, (-2 * cos) / a0, (1 - alpha) / a0]);
  }
  return sections;
}

// Butterworth band-pass between lo and hi (Hz) of an even order: `order` second-order sections, unity gain in the
// middle of the band. The low-pass prototype is moved to the band and then to the digital domain (bilinear).
export function butterworthBand(order, lo, hi, sampleRate = SR) {
  const w1 = 4 * Math.tan(Math.PI * lo / sampleRate), w2 = 4 * Math.tan(Math.PI * hi / sampleRate);
  const bw = w2 - w1, centre = w1 * w2;
  const sections = [];
  for (let k = 0; k < order / 2; k++) {
    // a prototype pole in the upper half plane, scaled to half the bandwidth
    const theta = Math.PI * (2 * k + order + 1) / (2 * order);
    const pr = (bw / 2) * Math.cos(theta), pi = (bw / 2) * Math.sin(theta);
    // it becomes two band-pass poles: p +- sqrt(p^2 - centre)
    const ar = pr * pr - pi * pi - centre, ai = 2 * pr * pi;
    const mag = Math.hypot(ar, ai);
    const sr = Math.sqrt((mag + ar) / 2), si = (ai < 0 ? -1 : 1) * Math.sqrt((mag - ar) / 2);
    for (const sign of [1, -1]) {
      const br = pr + sign * sr, bi = pi + sign * si;
      // bilinear transform of the pole: z = (4 + s) / (4 - s); its mirror image completes the section
      const den = (4 - br) * (4 - br) + bi * bi;
      const zr = ((4 + br) * (4 - br) - bi * bi) / den, zi = (8 * bi) / den;
      sections.push([1, 0, -1, -2 * zr, zr * zr + zi * zi]);
    }
  }
  // unity gain at the centre of the band
  const w = 2 * Math.atan(Math.sqrt(centre) / 4);
  let gain = 1;
  for (const [b0, b1, b2, a1, a2] of sections) {
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    gain *= Math.hypot(b0 + b1 * c1 + b2 * c2, b1 * s1 + b2 * s2) / Math.hypot(1 + a1 * c1 + a2 * c2, a1 * s1 + a2 * s2);
  }
  const each = gain ** (-1 / sections.length);
  return sections.map(([b0, b1, b2, a1, a2]) => [b0 * each, b1 * each, b2 * each, a1, a2]);
}

// Runs the sections over x and returns a new Float64Array. `reverse` filters from the end to the start.
export function applyFilter(x, sections, reverse = false) {
  const n = x.length;
  let y = Float64Array.from(x);
  for (const [b0, b1, b2, a1, a2] of sections) {
    let z1 = 0, z2 = 0;
    if (reverse) {
      for (let i = n - 1; i >= 0; i--) { const v = y[i]; const o = b0 * v + z1; z1 = b1 * v - a1 * o + z2; z2 = b2 * v - a2 * o; y[i] = o; }
    } else {
      for (let i = 0; i < n; i++) { const v = y[i]; const o = b0 * v + z1; z1 = b1 * v - a1 * o + z2; z2 = b2 * v - a2 * o; y[i] = o; }
    }
  }
  return y;
}

// Forward then backward: twice the slope and no shift in time.
export const zeroPhase = (x, sections) => applyFilter(applyFilter(x, sections), sections, true);

// ---------- loudness in JavaScript ----------
// Integrated loudness (ITU-R BS.1770, LUFS) of 48 kHz samples. One channel is measured as two equal channels, the
// way it is heard. Agrees with ffmpeg's ebur128 to about 0.1 LU; it saves a run when the samples are in memory.
export function integratedLoudness(channels, sampleRate = SR) {
  if (sampleRate !== 48000) throw new Error('integratedLoudness expects 48 kHz audio');
  const n = channels[0]?.length || 0;
  const seg = 4800;                       // 100 ms; a block is four of them (400 ms, 75 percent overlap)
  const segs = Math.floor(n / seg);
  if (segs < 4) return -Infinity;
  const energy = new Float64Array(segs);
  for (const x of channels) {
    // K-weighting: a high shelf, then a high-pass.
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0;
    for (let s = 0, p = 0; s < segs; s++) {
      let sum = 0;
      for (let i = 0; i < seg; i++, p++) {
        const v = x[p];
        const o = 1.53512485958697 * v + a1;
        a1 = -2.69169618940638 * v + 1.69065929318241 * o + a2;
        a2 = 1.19839281085285 * v - 0.73248077421585 * o;
        const y = o + b1;
        b1 = -2 * o + 1.99004745483398 * y + b2;
        b2 = o - 0.99007225036621 * y;
        sum += y * y;
      }
      energy[s] += sum;
    }
  }
  const weight = (channels.length === 1 ? 2 : 1) / (4 * seg);
  const blocks = new Float64Array(segs - 3);
  for (let j = 0; j < blocks.length; j++) blocks[j] = (energy[j] + energy[j + 1] + energy[j + 2] + energy[j + 3]) * weight;
  const lufs = (z) => -0.691 + 10 * Math.log10(z);
  const mean = (floor) => {
    let sum = 0, count = 0;
    for (const z of blocks) if (z > 0 && lufs(z) > floor) { sum += z; count++; }
    return count ? sum / count : 0;
  };
  const gated = mean(-70);
  if (!gated) return -Infinity;
  const final = mean(Math.max(-70, lufs(gated) - 10));
  return final ? lufs(final) : -Infinity;
}

// The highest sample of all channels, in dBFS.
export function samplePeakDb(channels) {
  let peak = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) { const v = x[i] < 0 ? -x[i] : x[i]; if (v > peak) peak = v; }
  return toDb(peak);
}
