/**
 * Strict whole-tree syntax check for the shipped JavaScript.
 *
 *   node tools/syntax-check.mjs
 *
 * Why this exists: `node --check somefile.js` does NOT catch early errors such as
 * a duplicated `let` declaration, because Node parses a plain `.js` argument in a
 * lenient script-like mode. Copying the file to `.mjs` first makes Node parse it
 * as a module and report those errors — which is exactly how a duplicated
 * declaration in chat/chat.js once survived `node --check` and only failed in the
 * minified bundle.
 *
 * Every `.js`/`.mjs` file that ships (i.e. outside tools/, doc/, dist/) is
 * checked. Exits non-zero when any file fails, so it can gate a release.
 */
import { readdirSync, statSync, copyFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const root = process.cwd();
const skip = new Set(['node_modules', 'dist', 'doc', 'tools', 'images', 'logo', 'css', '_locales']);
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(full);
  }
})(root);

const tmp = mkdtempSync(join(tmpdir(), 'syntax-'));
let failed = 0;
for (const file of files) {
  const copy = join(tmp, relative(root, file).replace(/[\\/]/g, '_') + '.mjs');
  copyFileSync(file, copy);
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.log('SYNTAX FAIL', relative(root, file));
    console.log(String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'));
  }
}
console.log(failed ? `\n${failed} file(s) failed` : `all ${files.length} JS files parse as modules`);
process.exit(failed ? 1 : 0);
