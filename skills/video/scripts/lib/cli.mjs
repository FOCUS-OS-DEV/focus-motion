// Small command line helpers shared by doctor.mjs, project.mjs, render.mjs and assemble.mjs.
//
//   import { showUsage, round, stamp } from './lib/cli.mjs';
//   if (args.help) showUsage(import.meta.url, 0);   // prints the comment block at the top of the tool and exits
import fs from 'node:fs';

// The usage block of a tool is the comment at the top of its own file.
export function usageText(metaUrl) {
  const lines = fs.readFileSync(new URL(metaUrl), 'utf8').split(/\r?\n/);
  const text = [];
  for (const line of lines) {
    if (line.startsWith('#!')) continue;
    if (!line.startsWith('//')) break;
    text.push(line.replace(/^\/\/ ?/, ''));
  }
  return text.join('\n') + '\n';
}

// --help goes to stdout with exit 0; a usage mistake goes to stderr with exit 2.
export function showUsage(metaUrl, code = 0, message = '') {
  const stream = code === 0 ? process.stdout : process.stderr;
  if (message) stream.write(`error: ${message}\n\n`);
  stream.write(usageText(metaUrl));
  process.exit(code);
}

export const round = (n, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;

// 20261002-143015, for file names of backups.
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Removes a folder of our own temp files. Written by hand on purpose: on Node 24 for Windows,
// fs.rmSync(dir, { recursive: true }) silently does nothing when the path holds Hebrew letters, and fs.cpSync
// crashes the process on such a path. Plain unlink, rmdir and copyFile are safe.
export function removeTree(target) {
  let st;
  try { st = fs.lstatSync(target); } catch { return; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(target)) removeTree(`${target}/${name}`);
    try { fs.rmdirSync(target); } catch { /* still in use: it is only a temp folder */ }
  } else {
    try { fs.unlinkSync(target); } catch { /* still in use */ }
  }
}

// A path that does not exist yet: name.ext, name-2.ext, name-3.ext ...
export function freePath(file) {
  if (!fs.existsSync(file)) return file;
  const m = file.match(/^(.*?)(\.[^.\\/]+)?$/);
  for (let i = 2; ; i++) {
    const candidate = `${m[1]}-${i}${m[2] || ''}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}
