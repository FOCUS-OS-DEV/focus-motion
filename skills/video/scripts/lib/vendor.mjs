// The animation library (GSAP) for the scenes. It is not shipped with the skill: the doctor downloads the pinned
// minified file once from its official CDN into ~/.focus-motion/vendor/, and every new scene gets a copy in its own
// assets/ folder, so a render never needs the network.
//
//   import { ensureGsap, installGsap, GSAP_VERSION } from './lib/vendor.mjs';
//   const g = await ensureGsap();            // { ok, path, bytes, downloaded, source, error?, hint? }
//   const used = await installGsap(sceneDir); // 'local' (copied to assets/gsap.min.js) or 'cdn' (no file, no network)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR, IS_WIN, runSync } from './common.mjs';

export const GSAP_VERSION = '3.14.2';
export const GSAP_FILE = 'gsap.min.js';
export const GSAP_BYTES = 72779;
export const GSAP_SHA256 = 'c174bfce53a729418d57a8ad8625e7247c793a22fef8e2851e3cfa3de9cd8280';
export const GSAP_BANNER = `/*!\n * GSAP ${GSAP_VERSION}\n * https://gsap.com`;
// The three public CDNs serve the same bytes for a pinned version; the first one is the address a scene falls back to.
export const GSAP_URLS = [
  `https://cdn.jsdelivr.net/npm/gsap@${GSAP_VERSION}/dist/gsap.min.js`,
  `https://unpkg.com/gsap@${GSAP_VERSION}/dist/gsap.min.js`,
  `https://cdnjs.cloudflare.com/ajax/libs/gsap/${GSAP_VERSION}/gsap.min.js`,
];
export const GSAP_CDN_URL = GSAP_URLS[0];
export const VENDOR_DIR = path.join(HOME_DIR, 'vendor');
export const GSAP_PATH = path.join(VENDOR_DIR, GSAP_FILE);

// Is this buffer exactly the pinned file? Checks the banner, the size and the hash.
export function verifyGsap(buf) {
  if (!buf || !buf.length) return { ok: false, reason: 'empty file' };
  const head = buf.subarray(0, 200).toString('utf8').replace(/\r\n/g, '\n');
  if (!head.startsWith(GSAP_BANNER)) return { ok: false, reason: 'the file does not start with the GSAP banner' };
  if (buf.length !== GSAP_BYTES) return { ok: false, reason: `size is ${buf.length} bytes, expected ${GSAP_BYTES}` };
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== GSAP_SHA256) return { ok: false, reason: 'the content hash does not match the pinned version' };
  return { ok: true };
}

export function gsapStatus() {
  try {
    const buf = fs.readFileSync(GSAP_PATH);
    const v = verifyGsap(buf);
    return { ok: v.ok, path: GSAP_PATH, bytes: buf.length, reason: v.reason };
  } catch {
    return { ok: false, path: GSAP_PATH, bytes: 0, reason: 'not downloaded yet' };
  }
}

async function download(url, timeoutMs) {
  // Node's own fetch first. Behind an antivirus or proxy that inspects TLS it fails, and curl (part of Windows 10+,
  // macOS and Linux) uses the system certificates, so it is the second try.
  let firstError = '';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { buf: Buffer.from(await res.arrayBuffer()), via: 'fetch' };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    firstError = String(e?.cause?.code || e?.cause?.message || e?.message || e);
  }
  const tmp = path.join(VENDOR_DIR, `.download-${process.pid}.tmp`);
  try {
    const r = runSync(IS_WIN ? 'curl.exe' : 'curl', ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-o', tmp, url]);
    if (r.code === 0 && fs.existsSync(tmp)) return { buf: fs.readFileSync(tmp), via: 'curl' };
    return { error: `${firstError}; curl: ${(r.stderr || `exit ${r.code}`).trim().split(/\r?\n/).pop()}` };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
  }
}

// Makes sure the pinned file is in the vendor folder. Downloads it when it is missing or wrong (unless download:false,
// or FOCUS_MOTION_OFFLINE=1 in the environment).
export async function ensureGsap({ download: allow = true, timeoutMs = 20000 } = {}) {
  if (process.env.FOCUS_MOTION_OFFLINE === '1') allow = false;
  const now = gsapStatus();
  const base = { version: GSAP_VERSION, path: GSAP_PATH, bytes: GSAP_BYTES };
  if (now.ok) return { ok: true, ...base, downloaded: false, source: null };
  if (!allow) return { ok: false, ...base, downloaded: false, source: null, error: now.reason };
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const errors = [];
  for (const url of GSAP_URLS) {
    const got = await download(url, timeoutMs);
    if (!got.buf) { errors.push(`${new URL(url).host}: ${got.error}`); continue; }
    const v = verifyGsap(got.buf);
    if (!v.ok) { errors.push(`${new URL(url).host}: ${v.reason}`); continue; }
    const tmp = `${GSAP_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, got.buf);
    fs.renameSync(tmp, GSAP_PATH);
    return { ok: true, ...base, downloaded: true, source: url, via: got.via };
  }
  const tls = errors.some((e) => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(e));
  return {
    ok: false, ...base, downloaded: false, source: null,
    error: `could not download GSAP ${GSAP_VERSION} (${errors.join(' | ')})`,
    hint: tls
      ? 'Something on this computer inspects secure connections. Run the same command again with the environment variable NODE_OPTIONS=--use-system-ca.'
      : 'Check the internet connection and run the doctor again.',
  };
}

// Puts gsap.min.js into <sceneDir>/assets/. Returns 'local', or 'cdn' when the file could not be had (the scene
// then has to load it from GSAP_CDN_URL and needs the network at render time).
export async function installGsap(sceneDir, opts = {}) {
  const g = await ensureGsap(opts);
  if (!g.ok) return { mode: 'cdn', url: GSAP_CDN_URL, error: g.error, hint: g.hint };
  const dest = path.join(sceneDir, 'assets', GSAP_FILE);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(GSAP_PATH, dest);
  return { mode: 'local', file: dest, downloaded: g.downloaded };
}
