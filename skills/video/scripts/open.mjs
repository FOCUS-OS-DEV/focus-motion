#!/usr/bin/env node
// open.mjs: show a file, a folder or a web address on the user's screen with the system's default app.
//
// Usage:
//   node open.mjs <file | folder | url>            open it (a video plays, an image opens, a url opens the browser)
//   node open.mjs <file> --reveal                  open the folder with the file selected
//
// Example:
//   node open.mjs "my video/launch-v2.mp4" --reveal
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IS_WIN, IS_MAC, parseArgs, out, die, fwd } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['reveal', 'help'] });
if (args.help || !args._[0]) {
  process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(args.help ? 0 : 2);
}

const target = args._[0];
const isUrl = /^https?:\/\//i.test(target);
const full = isUrl ? target : path.resolve(target);
if (!isUrl && !fs.existsSync(full)) die(`not found: ${fwd(full)}`, 2);

// Detached and ignored: the viewer keeps running after this tool exits.
function launch(cmd, argv, verbatim = false) {
  const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: verbatim });
  child.on('error', (e) => die(`could not open: ${e.message}`));
  child.unref();
}

if (IS_WIN) {
  // explorer.exe opens files, folders and urls with the default app. Its exit code is not meaningful.
  if (args.reveal && !isUrl) launch('explorer.exe', [`/select,"${full}"`], true);
  else launch('explorer.exe', [full]);
} else if (IS_MAC) {
  launch('open', args.reveal && !isUrl ? ['-R', full] : [full]);
} else {
  launch('xdg-open', [args.reveal && !isUrl ? path.dirname(full) : full]);
}

out({ opened: isUrl ? full : fwd(full), reveal: Boolean(args.reveal) });
