/**
 * Self-check for the HTML / PDF export menu of chat/chat.js.
 *
 *   node tools/export-menu.test.mjs
 *
 * Loads the *real* `showExportMenu` block out of chat/chat.js (not a copy) into
 * a real DOM, wires the button the same way the page does, and clicks it — so
 * the whole point is that the click which opens the menu must not close it
 * again. That regression is invisible in every other way: the menu is created
 * and removed within one event, so the user just sees "nothing happens" and
 * there is no error in the console.
 *
 * jsdom is not a dependency of this repo (there is no package.json), so the
 * checks are skipped with a notice when it cannot be found. To run them:
 *   npm i jsdom                      (or: npm i -g jsdom)
 *   CLLAMA_JSDOM=/path/to/node_modules/jsdom node tools/export-menu.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolves jsdom from the usual places, or from CLLAMA_JSDOM. */
async function loadJsdom() {
  const candidates = [];
  if (process.env.CLLAMA_JSDOM) candidates.push(join(process.env.CLLAMA_JSDOM, 'lib/api.js'));
  candidates.push('jsdom');

  for (const candidate of candidates) {
    try {
      const specifier = candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate;
      const mod = await import(specifier);
      if (mod?.JSDOM) return mod.JSDOM;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const JSDOM = await loadJsdom();
if (!JSDOM) {
  console.log('skipped - jsdom not installed (see the header of this file)');
  process.exit(0);
}

const CHAT_JS = new URL('../chat/chat.js', import.meta.url);

/** The menu code, sliced out of the real page script. */
function exportMenuBlock() {
  const source = readFileSync(CHAT_JS, 'utf8');
  const start = source.indexOf('    let exportMenu = null;');
  const end = source.indexOf('    /**\n     * Saves ONE answer');
  if (start < 0 || end < 0 || end < start) {
    throw new Error('could not locate the export-menu block in chat/chat.js — was it renamed or reformatted?');
  }
  return source.slice(start, end);
}

const BLOCK = exportMenuBlock();

/** Builds a DOM with one button, plus the menu API bound to it. */
function buildPage() {
  const dom = new JSDOM('<!DOCTYPE html><body><a id="b_export" href="#">E</a><p id="outside">x</p></body>');
  const { document, window } = dom.window;
  const browser = { i18n: { getMessage: (key) => key } };
  const factory = new Function(
    'document', 'window', 'escapeHTML', 'browser', 'balert',
    `${BLOCK}\n return { showExportMenu, closeExportMenu };`
  );
  return {
    document,
    window,
    api: factory(document, window, (text) => String(text), browser, () => {})
  };
}

/** Dispatches a bubbling click on an element. */
function click(document, el) {
  el.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL - ${name} :: ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

check('the menu survives the very click that opened it (no stopPropagation)', () => {
  const { document, api } = buildPage();
  const anchor = document.getElementById('b_export');
  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    api.showExportMenu(anchor, () => {});
  });
  click(document, anchor);
  assert(document.querySelector('.export-menu'), 'menu must stay open');
});

check('the menu survives with stopPropagation (the per-answer wiring)', () => {
  const { document, api } = buildPage();
  const anchor = document.getElementById('b_export');
  anchor.addEventListener('click', (e) => {
    e.stopPropagation();
    api.showExportMenu(anchor, () => {});
  });
  click(document, anchor);
  assert(document.querySelector('.export-menu'), 'menu must stay open');
});

check('a click outside closes the menu', () => {
  const { document, api } = buildPage();
  const anchor = document.getElementById('b_export');
  anchor.addEventListener('click', (e) => { e.stopPropagation(); api.showExportMenu(anchor, () => {}); });
  click(document, anchor);
  click(document, document.getElementById('outside'));
  assert(!document.querySelector('.export-menu'), 'menu must be gone');
});

check('clicking the same button again closes the menu', () => {
  const { document, api } = buildPage();
  const anchor = document.getElementById('b_export');
  anchor.addEventListener('click', (e) => { e.stopPropagation(); api.showExportMenu(anchor, () => {}); });
  click(document, anchor);
  assert(document.querySelector('.export-menu'), 'open after the first click');
  click(document, anchor);
  assert(!document.querySelector('.export-menu'), 'closed after the second click');
});

check('the menu offers html and pdf, and a pick reaches the callback', () => {
  const { document, api } = buildPage();
  const anchor = document.getElementById('b_export');
  let picked = null;
  anchor.addEventListener('click', (e) => {
    e.stopPropagation();
    api.showExportMenu(anchor, (format) => { picked = format; });
  });
  click(document, anchor);

  const items = [...document.querySelectorAll('.export-menu-item')];
  assert(items.length === 2, `expected 2 items, got ${items.length}`);
  assert(items.map(i => i.dataset.format).join() === 'html,pdf', 'formats must be html,pdf');

  click(document, items[1]);
  assert(picked === 'pdf', `the pick must reach the callback, got ${picked}`);
  assert(!document.querySelector('.export-menu'), 'the menu closes after a pick');
});

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}.`);
process.exit(failed ? 1 : 0);
