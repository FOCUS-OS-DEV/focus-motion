#!/usr/bin/env node
// Review page: watch a video cut in the browser and pin notes to the exact second.
//
// The page shows the video, big. One key pauses and opens a note at the current frame; a pair of keys marks a
// stretch (from here to here) for notes like "too quiet from here to here". Every change is saved next to the
// video as <video name>.notes.json, so an agent reads the notes from disk with exact times. When a new cut is
// rendered, point the running server at it and the open tab reloads by itself (one tab, never a new one).
//
//   node review-notes.mjs serve <video.mp4> [--port 8790] [--open] [--foreground]
//       Starts the page in a server process of its own that keeps running in the background, waits until the
//       page answers, and prints one JSON line: {"url", "notes", "video", "port", "pid"} (pid of the server).
//       It runs apart because an agent's shell command is killed at its timeout, and a review round can last
//       longer. If a review server already runs on these ports, it is switched to the new video instead
//       ("reused": true) and nothing new is started. If another program holds the port, the next ports are
//       tried (up to +20). --open opens the browser once the page answers, unless a tab of it is already open.
//       --foreground keeps the server in this terminal instead, logging there (for debugging). A server in the
//       background logs to review-notes-<port>.log in the temp folder of the system.
//   node review-notes.mjs stop [--port 8790]
//       Stops the review server found on the ports wait searches and prints {"stopped": true, "port"}, or
//       {"stopped": false} when there is none. Exits 0 in both cases.
//   node review-notes.mjs wait [--port 8790] [--timeout 1500]
//       Blocks until the reviewer clicks the done button (or presses D), then prints the notes array and
//       exits 0. After --timeout seconds it prints {"timeout": true} and exits 2. Looks for the server on the
//       same ports serve tries. Made to run in the background, so an agent is woken by the click.
//   node review-notes.mjs frames <video.mp4>
//       Writes one JPEG per note (two for a stretch: its start and its end) into <video name>.notes-frames/
//       and prints [{t, t_end, text, frames: [paths]}]. Needs ffmpeg on the PATH (or its path in the FFMPEG
//       environment variable) and exits 3 without it.
//
// Keys in the page: Space play/pause, N note here, I start of a stretch and O its end, Left/Right one frame
// (with Shift: one second), S slow motion, D done, Enter save, Esc cancel. Letter keys are matched by their
// position, so they work on a Hebrew keyboard too.
//
// Node 20 or newer, nothing to install. The server listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const APP = 'review-notes';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8790;
const PORT_SPAN = 20; // how far past the asked port serve may go when other programs hold the ports
const PAGE_ALIVE_MS = 65_000; // a browser tab in the background still polls about once a minute
const PIECE = 1024 * 1024; // the video is read 1 MB at a time,
const SLICE = 64 * 1024; // and handed to the network in slices of 64 KB (see sendVideo)
const START_MS = 10_000; // how long serve waits for the server it started to answer
const USAGE = `Usage:
  node review-notes.mjs serve <video.mp4> [--port ${DEFAULT_PORT}] [--open] [--foreground]
      start the review page in the background (or show this video in the one running) and return
  node review-notes.mjs wait [--port ${DEFAULT_PORT}] [--timeout 1500]
      block until the reviewer clicks done, then print the notes
  node review-notes.mjs frames <video.mp4>
      one JPEG per note, next to the video
  node review-notes.mjs stop [--port ${DEFAULT_PORT}]
      stop the review server
  --foreground keeps the server in this terminal instead of the background, for debugging.`;

const SETTLE_MS = 1500; // a video written to this recently is taken to be still in the middle of a render

// mtime: null until the video was looked at, 0 while it is missing, else seconds since 1970 (as the page gets it)
// fromServe: this process is a server that serve started in the background; it reports to serve and logs to a file
const state = { video: '', mtime: null, done: false, pageSeen: 0, notesProblem: '', server: null, fromServe: false, logFile: '' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stem = (video) => video.slice(0, video.length - path.extname(video).length);
const notesPathFor = (video) => `${stem(video)}.notes.json`;
const framesDirFor = (video) => `${stem(video)}.notes-frames`;

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function log(message) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${message}\n`;
  if (!state.logFile) return void process.stderr.write(line);
  try {
    fs.appendFileSync(state.logFile, line);
  } catch {}
}

const toServe = () => state.fromServe && typeof process.send === 'function' && process.connected;

// Print one JSON line and exit once it is flushed (a plain process.exit can cut piped output short).
function finish(code, value) {
  return new Promise(() => process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(code)));
}

// One line on stderr, then exit. A server started by serve also tells serve why, since nobody sees its stderr.
function fail(code, message) {
  return new Promise(() => {
    const exit = () => process.stderr.write(`review-notes: ${message}\n`, () => process.exit(code));
    if (toServe()) process.send({ type: 'error', message }, exit);
    else exit();
  });
}

// ---------------------------------------------------------------------------------------------------- notes

// The notes of one video. No file yet means no notes; a file that cannot be read or parsed throws.
function readNotes(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  text = text.trim(); // trim() also takes off the BOM that PowerShell puts in front of a file
  if (!text) return [];
  const notes = JSON.parse(text);
  if (!Array.isArray(notes)) throw new SyntaxError('the file is not a JSON array');
  return notes;
}

// Another program can be in the middle of writing the file, so a failed read is retried before giving up.
async function loadNotes() {
  const file = notesPathFor(state.video);
  for (let attempt = 1; ; attempt++) {
    try {
      const notes = readNotes(file);
      state.notesProblem = '';
      return notes;
    } catch (err) {
      if (attempt === 5) {
        const problem = `cannot read ${file} (${err.message}), showing an empty list`;
        if (problem !== state.notesProblem) log(problem); // once, not on every poll
        state.notesProblem = problem;
        return [];
      }
      await sleep(60);
    }
  }
}

function saveNotes(notes) {
  const file = notesPathFor(state.video);
  try {
    readNotes(file);
  } catch (err) {
    // Never write over notes this script could not parse: keep a copy first.
    if (!err.code) {
      try {
        fs.copyFileSync(file, `${file}.broken`);
      } catch {}
    }
  }
  fs.writeFileSync(file, JSON.stringify(notes, null, 1), 'utf8');
  log(`${notes.length} notes -> ${file}`);
}

// --------------------------------------------------------------------------------------------------- server

// What the page polls to know that the video changed: its name and the time it was last written.
function current() {
  try {
    const mtimeMs = fs.statSync(state.video).mtimeMs;
    const age = Date.now() - mtimeMs;
    // A file written to a moment ago is probably a render still in progress. Keep announcing the version
    // before it until the file settles, so the page reloads once, on a whole file, not on every half of one.
    const settled = age < 0 || age >= SETTLE_MS;
    if (settled || state.mtime === null) state.mtime = mtimeMs / 1000;
  } catch (err) {
    if (err.code === 'ENOENT') state.mtime = 0; // gone for now; any other error keeps the last known time
  }
  return {
    name: path.basename(state.video),
    mtime: state.mtime ?? 0,
    app: APP,
    pid: process.pid,
    page: Date.now() - state.pageSeen < PAGE_ALIVE_MS,
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buffer.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buffer);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('the request body is too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A page on another site must not reach this server: not through a domain that resolves to 127.0.0.1 (the Host
// header gives it away), and not by posting here from its own origin (the Origin header gives that away).
function isLocalHost(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === HOST || host === 'localhost';
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl and this script's own commands send none
  return origin.toLowerCase() === `http://${String(req.headers.host).toLowerCase()}`;
}

// The video file is open only for one short read at a time. A paused player leaves its request hanging for
// minutes, and on Windows a file that is held open cannot be renamed over: holding it would make the next
// render fail.
async function withVideo(file, read) {
  const fh = await fs.promises.open(file, 'r');
  try {
    return await read(fh);
  } finally {
    await fh.close().catch(() => {});
  }
}

// Size and time of change: what tells one version of the file from the next.
function stampOf(file) {
  return withVideo(file, async (fh) => {
    const stat = await fh.stat();
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

// One piece of the video, or null when the file is no longer the version the response started with.
function readPiece(file, stamp, position, length) {
  return withVideo(file, async (fh) => {
    const stat = await fh.stat();
    if (stat.size !== stamp.size || stat.mtimeMs !== stamp.mtimeMs) return null;
    const { bytesRead, buffer } = await fh.read(Buffer.allocUnsafe(length), 0, length, position);
    return bytesRead === length ? buffer : null;
  });
}

function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

// The video with byte ranges, so the browser can seek anywhere in the file. The file may be in the middle of
// being replaced by a new render: reads are retried for a few seconds, and a file that changes while it is
// sent cuts the response short (the player asks again) instead of mixing two versions.
async function sendVideo(req, res) {
  const file = state.video;
  let gone = false;
  res.on('close', () => (gone = true));
  let stamp = null;
  let missing = false;
  for (let attempt = 0; attempt < 25 && !gone && !stamp; attempt++) {
    try {
      const found = await stampOf(file);
      if (found.size > 0) stamp = found; // an empty file is one that is just being created
      missing = false;
    } catch (err) {
      missing = err.code === 'ENOENT';
    }
    if (!stamp) await sleep(100);
  }
  if (gone) return undefined;
  if (!stamp) {
    return send(res, missing ? 404 : 503, { error: 'the video cannot be read right now' }, undefined, { 'Retry-After': '1' });
  }
  const { size } = stamp;

  const range = /^bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const partial = Boolean(range && (range[1] || range[2]));
  let start = 0;
  let end = size - 1;
  if (partial) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else start = Math.max(0, size - Number(range[2])); // "bytes=-500": the last 500 bytes
    if (start > end) {
      return send(res, 416, { error: 'range not satisfiable' }, undefined, { 'Content-Range': `bytes */${size}` });
    }
  }
  const headers = {
    'Content-Type': path.extname(file).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-store',
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();

  let position = start;
  while (position <= end && !gone) {
    const length = Math.min(PIECE, end - position + 1);
    let piece = null;
    for (let attempt = 0; attempt < 10 && !gone; attempt++) {
      try {
        piece = await readPiece(file, stamp, position, length);
        break;
      } catch {
        await sleep(100); // locked or missing for a moment while another program writes it
      }
    }
    if (!piece) break;
    position += length;
    // Small writes on purpose. With 1 MB writes, a download over a connection that closes after the answer
    // sometimes hung for 19 s and was reset (Windows 11, Node 24, cause not pinned down); with 64 KB it did not.
    for (let at = 0; at < length && !gone; at += SLICE) {
      if (!res.write(piece.subarray(at, at + SLICE)) && !gone) await drained(res);
    }
  }
  return position > end && !gone ? res.end() : res.destroy();
}

async function handle(req, res) {
  let route;
  try {
    route = new URL(req.url, `http://${HOST}`).pathname;
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  if (!isLocalHost(req)) return send(res, 403, { error: 'this server answers on 127.0.0.1 and localhost only' });

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (route === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (route === '/current') {
      // The page polls this, and only a browser sends a Referer: that is how an open tab is known.
      if (req.headers.referer) state.pageSeen = Date.now();
      return send(res, 200, current());
    }
    if (route === '/notes') return send(res, 200, await loadNotes());
    if (route === '/done-state') return send(res, 200, { done: state.done, notes: (await loadNotes()).length });
    if (route === '/video') return sendVideo(req, res);
    return send(res, 404, {});
  }

  if (req.method === 'POST') {
    if (!isSameOrigin(req)) return send(res, 403, { error: 'cross-site request refused' });
    const body = await readBody(req);

    if (route === '/notes' || route === '/done') {
      // The page sends its notes with the done signal too, so "done" never arrives ahead of the last note.
      if (route === '/notes' || body.trim()) {
        let notes;
        try {
          notes = JSON.parse(body);
        } catch {}
        if (!Array.isArray(notes)) return send(res, 400, { error: 'the body must be a JSON array of notes' });
        saveNotes(notes);
      }
      if (route === '/notes') return send(res, 200, { ok: true });
      state.done = true;
      log('the reviewer is done');
      return send(res, 200, { ok: true, done: true, notes: (await loadNotes()).length });
    }
    if (route === '/done-clear') {
      state.done = false;
      return send(res, 200, { ok: true });
    }
    if (route === '/switch') {
      let target;
      try {
        target = JSON.parse(body).video;
      } catch {}
      if (typeof target !== 'string' || !target) return send(res, 400, { error: 'expected {"video": "<path>"}' });
      const video = path.resolve(target);
      if (!isFile(video)) return send(res, 404, { error: 'no such file' });
      if (video !== state.video) {
        state.done = false; // a done click belongs to the cut it was made on
        state.mtime = null;
      }
      state.video = video;
      log(`now reviewing ${video}`);
      return send(res, 200, current());
    }
    if (route === '/quit') {
      let pid = null;
      try {
        pid = JSON.parse(body || '{}').pid ?? null;
      } catch {}
      if (pid !== null && pid !== process.pid) return send(res, 409, { error: 'that pid is not this server' });
      log('stopping (POST /quit)');
      // Answer first, then stop taking connections and exit.
      res.on('finish', () => {
        if (state.server) state.server.close();
        setTimeout(() => process.exit(0), 150);
      });
      return send(res, 200, { ok: true, stopping: true, pid: process.pid });
    }
    return send(res, 404, {});
  }

  return send(res, 405, {});
}

function onRequest(req, res) {
  res.on('error', () => {});
  handle(req, res).catch((err) => {
    log(`${req.method} ${req.url} failed: ${err.message}`);
    if (res.headersSent) res.destroy();
    else send(res, err.status || 500, { error: err.message });
  });
}

// Resolves with the listening server, or with null when the port is taken.
function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(onRequest);
    server.once('error', (err) => (err.code === 'EADDRINUSE' || err.code === 'EACCES' ? resolve(null) : reject(err)));
    server.listen(port, HOST, () => {
      server.removeAllListeners('error');
      server.on('error', (err) => log(`server error: ${err.message}`));
      server.on('clientError', (err, socket) => socket.destroy());
      resolve(server);
    });
  });
}

// --------------------------------------------------------------------------------- talking to a running server

function call(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
    const req = http.request({ host: HOST, port, method, path: route, headers, agent: false, timeout: 1500 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) req.destroy(new Error('the answer is too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {}
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

// What a review server says about itself, or null when the port holds another program or nothing at all.
async function probe(port) {
  try {
    const res = await call(port, 'GET', '/current');
    return res.status === 200 && res.json && res.json.app === APP ? res.json : null;
  } catch {
    return null;
  }
}

// serve may have moved past the port it was asked for, so the other commands look in the same range.
// Returns {port, info} (info: what the server's /current said), or null.
async function findServer(base) {
  const first = await probe(base);
  if (first) return { port: base, info: first };
  const ports = [];
  for (let port = base + 1; port <= Math.min(base + PORT_SPAN, 65535); port++) ports.push(port);
  const found = await Promise.all(ports.map(probe));
  const hit = found.findIndex(Boolean);
  return hit === -1 ? null : { port: ports[hit], info: found[hit] };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // it exists, but belongs to another user
  }
}

function openBrowser(url) {
  const [command, args, options] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
      : process.platform === 'darwin'
        ? ['open', [url], {}]
        : ['xdg-open', [url], {}];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, ...options });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// ------------------------------------------------------------------------------------------------- commands

// A review server already runs on this port: it shows the new video, and nothing new is started.
async function reuse(port, running, video, args) {
  const res = await call(port, 'POST', '/switch', { video });
  if (res.status !== 200) return fail(1, `the review server on port ${port} did not take the video (${res.status})`);
  const line = { url: `http://${HOST}:${port}/`, notes: notesPathFor(video), video, port, pid: running.pid, reused: true };
  // A server started in the background that found a twin started a moment earlier: serve reports the twin.
  if (toServe()) return new Promise(() => process.send({ type: 'reused', line, page: running.page }, () => process.exit(0)));
  if (args.open && !running.page) openBrowser(line.url); // an open tab follows by itself; only a closed one is reopened
  return finish(0, line);
}

async function serve(args) {
  if (!args.rest[0]) return fail(1, `serve needs a video file.\n${USAGE}`);
  const video = path.resolve(args.rest[0]);
  if (!isFile(video)) return fail(1, `no such video file: ${video}`);
  state.video = video;

  // One server per range of ports: a running one takes the new video, even when a port before it is free.
  const found = await findServer(args.port);
  if (found) return reuse(found.port, found.info, video, args);
  if (!args.foreground) return serveInBackground(args, video);

  for (let port = args.port; port <= Math.min(args.port + PORT_SPAN, 65535); port++) {
    const url = `http://${HOST}:${port}/`;
    const server = await listen(port);
    if (server) {
      state.server = server;
      // From here on the page must stay up whatever happens, so a stray error is logged, not fatal.
      process.on('uncaughtException', (err) => log(`unexpected error: ${(err && err.stack) || err}`));
      process.on('unhandledRejection', (err) => log(`unexpected error: ${(err && err.stack) || err}`));
      const line = { url, notes: notesPathFor(video), video, port, pid: process.pid };
      if (toServe()) {
        state.logFile = path.join(os.tmpdir(), `review-notes-${port}.log`);
        try {
          fs.writeFileSync(state.logFile, '');
        } catch {}
        log(`reviewing ${video} on ${url}, pid ${process.pid}`);
        process.send({ type: 'ready', line });
      } else {
        process.stdout.write(`${JSON.stringify(line)}\n`);
        if (args.open) openBrowser(url);
      }
      return undefined; // the server keeps the process alive
    }
    const running = await probe(port);
    if (running) return reuse(port, running, video, args); // a twin that started a moment ago took this port
  }
  return fail(1, `no free port between ${args.port} and ${args.port + PORT_SPAN}`);
}

// Starts the server as a process of its own that outlives this one, and returns once its page answers.
// The new process runs this script with --foreground and tells this one, over their channel, which port it
// took, or that a twin started a moment earlier got there first (then it shows the video there and quits).
function serveInBackground(args, video) {
  return new Promise(() => {
    const child = spawn(process.execPath, [SCRIPT, 'serve', video, '--port', String(args.port), '--from-serve'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      cwd: os.tmpdir(), // not the caller's folder: on Windows, a process keeps its folder from being renamed or deleted
    });
    let over = false;
    const giveUp = (message) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      try {
        child.kill(); // the process this call started, nothing else
      } catch {}
      fail(1, message);
    };
    const timer = setTimeout(() => giveUp(`the review server did not answer within ${START_MS / 1000} s`), START_MS);
    child.on('error', (err) => giveUp(`could not start the review server: ${err.message}`));
    // a last message can arrive just after the exit, so give it a moment
    child.on('exit', (code) => setTimeout(() => giveUp(`the review server stopped while starting (exit code ${code})`), 300));
    child.on('message', async (message) => {
      if (over || !message || typeof message !== 'object') return undefined;
      if (message.type === 'error') return giveUp(message.message);
      if (message.type === 'reused') {
        over = true;
        clearTimeout(timer);
        if (args.open && !message.page) openBrowser(message.line.url);
        return finish(0, message.line);
      }
      if (message.type !== 'ready') return undefined;
      const { line } = message;
      while (!over) {
        const info = await probe(line.port); // the page answers, from the very process this call started
        if (info && info.pid === line.pid) break;
        await sleep(100);
      }
      if (over) return undefined;
      over = true;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.disconnect();
      child.unref();
      if (args.open) openBrowser(line.url);
      return finish(0, line);
    });
  });
}

async function stop(args) {
  const found = await findServer(args.port);
  if (!found) return finish(0, { stopped: false });
  const { port, info } = found;
  let asked = false;
  try {
    asked = (await call(port, 'POST', '/quit', { pid: info.pid })).status === 200;
  } catch {}
  if (!asked) {
    // A server from before POST /quit existed: end it by the pid it gave, after checking it still holds the port.
    const again = await probe(port);
    if (again && again.pid === info.pid) {
      try {
        process.kill(info.pid);
        asked = true;
      } catch {}
    }
  }
  for (let i = 0; asked && i < 50; i++) {
    if (!isAlive(info.pid) && !(await probe(port))) return finish(0, { stopped: true, port });
    await sleep(100);
  }
  return fail(1, `the review server on port ${port} (pid ${info.pid}) did not stop`);
}

async function wait(args) {
  const deadline = Date.now() + args.timeout * 1000;
  const noServer = `no review server answers on ports ${args.port} to ${args.port + PORT_SPAN}. Start one first: node review-notes.mjs serve <video.mp4>`;
  let port = null;
  let misses = 0;
  for (;;) {
    try {
      if (port === null) port = (await findServer(args.port))?.port ?? null;
      const res = port === null ? null : await call(port, 'GET', '/done-state');
      if (res && res.status === 200 && res.json && typeof res.json.done === 'boolean') {
        misses = 0;
        if (res.json.done) {
          const notes = await call(port, 'GET', '/notes');
          if (notes.status === 200 && Array.isArray(notes.json)) {
            await call(port, 'POST', '/done-clear').catch(() => {});
            return finish(0, notes.json);
          }
        }
      } else {
        port = null;
        misses++;
      }
    } catch {
      port = null;
      misses++;
    }
    if (misses >= 5) return fail(1, noServer);
    if (Date.now() >= deadline) return misses ? fail(1, noServer) : finish(2, { timeout: true });
    await sleep(1000);
  }
}

// One JPEG, 540 px wide. A note pinned on the very last frame has no frame after it, so step back a little.
function grabFrame(ffmpeg, video, t, file) {
  if (!Number.isFinite(t)) return false;
  for (const back of [0, 0.05, 0.25, 1]) {
    const at = Math.max(0, t - back);
    const run = spawnSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '3', '-update', '1', file],
      { stdio: 'ignore', timeout: 120_000 },
    );
    if (!run.error && run.status === 0 && isFile(file) && fs.statSync(file).size > 0) return true;
    if (at === 0) break;
  }
  return false;
}

function frames(args) {
  if (!args.rest[0]) return fail(1, `frames needs a video file.\n${USAGE}`);
  const video = path.resolve(args.rest[0]);
  if (!isFile(video)) return fail(1, `no such video file: ${video}`);
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).error) {
    return fail(3, 'ffmpeg was not found. Install it (https://ffmpeg.org/download.html), check that "ffmpeg -version" runs in this terminal, then run this again.');
  }
  let notes;
  try {
    notes = readNotes(notesPathFor(video));
  } catch (err) {
    return fail(1, `cannot read ${notesPathFor(video)}: ${err.message}`);
  }

  const dir = framesDirFor(video);
  if (notes.length) fs.mkdirSync(dir, { recursive: true });
  // Frames of an earlier round go first. unlinkSync and not rmSync: on Windows, Node 24 was seen to skip
  // rmSync without an error when the path has Hebrew letters in it.
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^note-\d+-.+\.jpg$/.test(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {}
  }
  let failed = 0;
  const result = notes.map((note, index) => {
    const shots = note.t_end == null ? [['at', note.t]] : [['from', note.t], ['to', note.t_end]];
    const files = [];
    for (const [label, t] of shots) {
      const file = path.join(dir, `note-${String(index + 1).padStart(2, '0')}-${label}-${Number(t).toFixed(2)}s.jpg`);
      if (grabFrame(ffmpeg, video, Number(t), file)) files.push(file);
      else failed++;
    }
    return { t: note.t, t_end: note.t_end ?? null, text: note.text, frames: files };
  });
  if (failed) process.stderr.write(`review-notes: ${failed} frame(s) could not be extracted\n`);
  return finish(failed ? 1 : 0, result);
}

function parseArgs(argv) {
  const args = { rest: [], port: DEFAULT_PORT, timeout: 1500, open: false, foreground: false, fromServe: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith('--') ? argv[i].split(/=(.*)/s) : [argv[i]];
    if (flag === '--open') args.open = true;
    else if (flag === '--foreground') args.foreground = true;
    else if (flag === '--from-serve') args.foreground = args.fromServe = true; // internal: started by serve
    else if (flag === '--port' || flag === '--timeout') {
      const value = Number(inline ?? argv[++i]);
      const ok = flag === '--port' ? Number.isInteger(value) && value > 0 && value < 65536 : Number.isFinite(value) && value >= 0;
      if (!ok) throw new Error(`${flag} needs a number`);
      args[flag.slice(2)] = value;
    } else if (flag.startsWith('--')) throw new Error(`unknown option ${flag}`);
    else args.rest.push(argv[i]);
  }
  return args;
}

async function main() {
  // A closed pipe on the other side (an agent that stopped listening) must not take the server down.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return undefined;
  }
  const commands = new Map([['serve', serve], ['wait', wait], ['frames', frames], ['stop', stop]]);
  // "node review-notes.mjs <video.mp4>" with no command starts the page, like the first version of this tool.
  const run = commands.get(command) || (isFile(command) ? serve : null);
  if (!run) return fail(1, `unknown command "${command}".\n${USAGE}`);
  let args;
  try {
    args = parseArgs(commands.has(command) ? rest : [command, ...rest]);
  } catch (err) {
    return fail(1, `${err.message}.\n${USAGE}`);
  }
  state.fromServe = args.fromServe;
  return run(args);
}

// ----------------------------------------------------------------------------------------------------- page

const PAGE = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><title>הערות על הסרטון</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6f4fb;--card:#fff;--ink:#16121f;--soft:#3d3550;--acc:#7c3aed;--acc2:#ede7fb;--line:#e2dcef;--warn:#b45309}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Rubik,Arial,sans-serif;font-size:20px}
main{display:grid;grid-template-columns:minmax(380px,auto) 1fr;gap:28px;padding:22px 28px;height:100vh}
#left{display:flex;flex-direction:column;align-items:center;gap:12px;min-height:0}
video{height:calc(100vh - 210px);max-width:100%;aspect-ratio:9/16;background:#000;border-radius:18px;box-shadow:0 20px 50px rgba(40,20,80,.18)}
#bar{position:relative;width:100%;height:44px;background:var(--card);border:1px solid var(--line);border-radius:12px;cursor:pointer;direction:ltr}
#fill{position:absolute;inset:0 auto 0 0;background:var(--acc2);border-radius:12px}
#head{position:absolute;top:-4px;bottom:-4px;width:3px;background:var(--acc);border-radius:2px}
.mk{position:absolute;top:6px;bottom:6px;width:6px;margin-left:-3px;background:var(--acc);border-radius:3px}
.rg{position:absolute;top:10px;bottom:10px;background:rgba(124,58,237,.35);border-radius:6px}
#sel{position:absolute;top:2px;bottom:2px;background:rgba(180,83,9,.25);border:2px solid var(--warn);border-radius:8px;display:none}
#row{display:flex;gap:14px;align-items:center;width:100%;justify-content:space-between}
#tc{font-size:30px;font-weight:700;direction:ltr;font-variant-numeric:tabular-nums}
button{font:inherit;font-size:19px;border:0;border-radius:12px;padding:10px 18px;background:var(--acc);color:#fff;cursor:pointer;font-weight:500}
button.ghost{background:var(--card);color:var(--ink);border:1px solid var(--line)}
#done{background:var(--ink)}
@media (max-width:1399px){#row{align-items:flex-start}#tc{line-height:45px}#done{display:block;margin:8px auto 0 0}}
#right{display:flex;flex-direction:column;min-height:0}
h1{font-size:30px;margin:4px 0 6px}#name{font-size:20px;color:var(--soft);margin-bottom:12px}
#keys{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px;line-height:1.75;margin-bottom:14px}
kbd{display:inline-block;min-width:34px;text-align:center;background:var(--acc2);border-radius:8px;padding:0 8px;font-family:inherit;font-weight:700;color:var(--acc)}
#editor{display:none;background:var(--card);border:2px solid var(--acc);border-radius:16px;padding:14px;margin-bottom:14px}
#editor .when{font-weight:700;margin-bottom:8px}
textarea{width:100%;min-height:96px;font:inherit;font-size:22px;border:1px solid var(--line);border-radius:12px;padding:10px;resize:vertical}
#list{overflow:auto;display:flex;flex-direction:column;gap:10px;padding-bottom:30px}
.n{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 16px;display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:start}
.n.on{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc2)}
.n .t{font-weight:700;color:var(--acc);direction:ltr;cursor:pointer;white-space:nowrap}
.n .x{font-size:22px;line-height:1.45;white-space:pre-wrap}
.n button{font-size:16px;padding:6px 12px}
#empty{color:var(--soft);font-size:21px;padding:10px 4px}
#flash{position:fixed;left:50%;top:18px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 22px;border-radius:12px;opacity:0;transition:opacity .25s;font-size:20px}
</style></head><body>
<main>
 <section id="left">
  <video id="v" src="/video" preload="auto" playsinline></video>
  <div id="bar"><div id="fill"></div><div id="sel"></div><div id="head"></div></div>
  <div id="row">
   <span id="tc">0.00</span>
   <span><button class="ghost" id="slow">מהירות רגילה</button> <button id="add">הערה כאן (N)</button> <button id="done">סיימתי, אפשר לתקן</button></span>
  </div>
 </section>
 <section id="right">
  <h1>הערות על הסרטון</h1>
  <div id="name"></div>
  <div id="keys">
   <kbd>רווח</kbd> ניגון ועצירה &nbsp; <kbd>N</kbd> הערה על הרגע הזה<br>
   <kbd>I</kbd> תחילת קטע &nbsp; <kbd>O</kbd> סוף הקטע ואז הערה על כל הקטע<br>
   <kbd>←</kbd> <kbd>→</kbd> פריים אחד, עם שיפט שנייה &nbsp; <kbd>S</kbd> הילוך איטי<br>
   <kbd>Enter</kbd> שומר את ההערה, <kbd>Esc</kbd> מבטל. אפשר גם להכתיב לתוך התיבה<br>
   <kbd>D</kbd> סיימתי, אפשר לתקן
  </div>
  <div id="editor"><div class="when" id="when"></div><textarea id="txt" placeholder="מה מפריע כאן?"></textarea>
   <div style="margin-top:10px;display:flex;gap:10px"><button id="save">שמירה (Enter)</button><button class="ghost" id="cancel">ביטול (Esc)</button></div></div>
  <div id="list"></div>
 </section>
</main>
<div id="flash"></div>
<script>
const v=document.getElementById('v'),bar=document.getElementById('bar'),fill=document.getElementById('fill'),head=document.getElementById('head'),
 sel=document.getElementById('sel'),tc=document.getElementById('tc'),list=document.getElementById('list'),ed=document.getElementById('editor'),
 txt=document.getElementById('txt'),when=document.getElementById('when');
let notes=[],draft=null,inT=null,ver=null,editing=null;const FPS=30;
const fmt=t=>{const m=Math.floor(t/60),s=(t%60).toFixed(2).padStart(5,'0');return m+':'+s};
function flash(s){const f=document.getElementById('flash');f.textContent=s;f.style.opacity=1;clearTimeout(flash.t);flash.t=setTimeout(()=>f.style.opacity=0,1400)}
async function save(){notes.sort((a,b)=>a.t-b.t);await fetch('/notes',{method:'POST',body:JSON.stringify(notes)});draw()}
function pct(t){return v.duration?100*t/v.duration:0}
function draw(){
 [...bar.querySelectorAll('.mk,.rg')].forEach(e=>e.remove());
 notes.forEach(n=>{const e=document.createElement('div');if(n.t_end!=null){e.className='rg';e.style.left=pct(n.t)+'%';e.style.width=Math.max(.6,pct(n.t_end)-pct(n.t))+'%'}else{e.className='mk';e.style.left=pct(n.t)+'%'}bar.appendChild(e)});
 list.innerHTML='';
 if(!notes.length){list.innerHTML='<div id="empty">עוד אין הערות. מריצים את הסרטון ולוחצים N על כל דבר שמפריע.</div>';return}
 notes.forEach((n,i)=>{const d=document.createElement('div');d.className='n';
  d.innerHTML=\`<div class="t">\${fmt(n.t)}\${n.t_end!=null?' – '+fmt(n.t_end):''}</div><div class="x"></div><div><button class="ghost">עריכה</button> <button class="ghost">מחיקה</button></div>\`;
  d.querySelector('.x').textContent=n.text;
  d.querySelector('.t').onclick=()=>{v.currentTime=n.t;v.pause()};
  const [eb,db]=d.querySelectorAll('button');
  eb.onclick=()=>{editing=i;open(n.t,n.t_end,n.text)};
  db.onclick=()=>{if(confirm('למחוק את ההערה?')){notes.splice(i,1);save()}};
  list.appendChild(d)})}
function open(t,t2,text){v.pause();draft={t:+t.toFixed(2),t_end:t2==null?null:+t2.toFixed(2)};
 when.textContent=(draft.t_end!=null?'קטע '+fmt(draft.t)+' עד '+fmt(draft.t_end):'ברגע '+fmt(draft.t));
 ed.style.display='block';txt.value=text||'';txt.focus()}
function close(){ed.style.display='none';draft=null;editing=null;inT=null;sel.style.display='none';v.focus()}
function commit(){const s=txt.value.trim();if(!draft)return;if(!s){close();return}
 const n={t:draft.t,t_end:draft.t_end,text:s,at:new Date().toLocaleTimeString('he-IL')};
 if(editing!=null)notes[editing]=n;else notes.push(n);close();save();flash('ההערה נשמרה')}
document.getElementById('save').onclick=commit;document.getElementById('cancel').onclick=close;
document.getElementById('add').onclick=()=>{editing=null;open(v.currentTime,null)};
const doneB=document.getElementById('done');
async function sendDone(){if(draft)commit();doneB.blur();
 try{const r=await fetch('/done',{method:'POST',body:JSON.stringify(notes)});if(!r.ok)throw 0;flash('ההערות נשלחו')}
 catch(e){flash('השרת לא עונה, ההערות לא נשלחו')}}
doneB.onclick=sendDone;
const slowB=document.getElementById('slow');
function toggleSlow(){v.playbackRate=v.playbackRate===1?0.5:1;slowB.textContent=v.playbackRate===1?'מהירות רגילה':'הילוך איטי, חצי מהירות'}
slowB.onclick=toggleSlow;
txt.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();commit()}if(e.key==='Escape'){e.preventDefault();close()}});
addEventListener('keydown',e=>{if(document.activeElement===txt)return;
 if(e.code==='Space'){e.preventDefault();v.paused?v.play():v.pause()}
 else if(e.code==='KeyN'){e.preventDefault();editing=null;open(v.currentTime,null)}
 else if(e.code==='KeyI'){e.preventDefault();inT=v.currentTime;sel.style.display='block';flash('תחילת קטע: '+fmt(inT)+'. עכשיו O בסוף הקטע')}
 else if(e.code==='KeyO'){e.preventDefault();if(inT==null){flash('קודם I בתחילת הקטע');return}const a=Math.min(inT,v.currentTime),b=Math.max(inT,v.currentTime);editing=null;open(a,b)}
 else if(e.code==='KeyS'){e.preventDefault();toggleSlow()}
 else if(e.code==='KeyD'&&!e.repeat&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();sendDone()}
 else if(e.code==='ArrowLeft'||e.code==='ArrowRight'){e.preventDefault();v.pause();const d=(e.shiftKey?1:1/FPS)*(e.code==='ArrowRight'?1:-1);v.currentTime=Math.max(0,Math.min(v.duration,v.currentTime+d))}});
bar.addEventListener('click',e=>{const r=bar.getBoundingClientRect();v.currentTime=(e.clientX-r.left)/r.width*v.duration});
function tick(){tc.textContent=fmt(v.currentTime||0);const p=pct(v.currentTime||0);fill.style.width=p+'%';head.style.left=p+'%';
 if(inT!=null){const a=Math.min(inT,v.currentTime),b=Math.max(inT,v.currentTime);sel.style.left=pct(a)+'%';sel.style.width=(pct(b)-pct(a))+'%'}
 const on=notes.findIndex(n=>Math.abs(n.t-v.currentTime)<0.25||(n.t_end!=null&&v.currentTime>=n.t&&v.currentTime<=n.t_end));
 [...list.querySelectorAll('.n')].forEach((d,i)=>d.classList.toggle('on',i===on));requestAnimationFrame(tick)}
v.addEventListener('loadedmetadata',draw);
async function poll(){try{const c=await (await fetch('/current')).json();
 if(ver&&ver!==c.name+c.mtime){const r=await fetch('/notes');notes=await r.json();v.src='/video?'+Date.now();flash('נטענה גרסה חדשה: '+c.name)}
 ver=c.name+c.mtime;document.getElementById('name').textContent=c.name}catch(e){} setTimeout(poll,3000)}
(async()=>{notes=await (await fetch('/notes')).json();draw();poll();tick()})();
</script></body></html>`;

main().catch((err) => fail(1, (err && err.message) || String(err)));
