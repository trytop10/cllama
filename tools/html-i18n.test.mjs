/**
 * Self-check for the translation keys the extension pages ask for in their HTML.
 *
 *   node tools/html-i18n.test.mjs
 *
 * `js/cllama.js`'s i18n() rewrites `.i18n` elements from their own markup: the
 * text content, or the attribute named by `i18n="<attr>"` (title, placeholder,
 * aria-label...). A typo in one of those keys therefore fails *silently* — the
 * user just sees "collapseAlll" instead of a tooltip — which is exactly what
 * this test catches. It also catches a key that reached `en` but no other locale.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = ['node_modules', 'dist', 'doc', 'tools', 'css', 'js', '_locales', 'images', '.git'];

/** Every .html file that ships (i.e. outside the skipped directories). */
function collectPages(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectPages(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

/**
 * Translation keys referenced by the `.i18n` elements of one page.
 * @param {string} html - Page source
 * @returns {Set<string>} Keys, in no particular order
 */
function pageI18nKeys(html) {
  const keys = new Set();

  // Attribute form: class="... i18n" i18n="title" title="<key>"
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) || []) {
    if (!/\bclass="[^"]*\bi18n\b/.test(tag)) continue;
    const attrMatch = tag.match(/\bi18n="([^"]+)"/);
    if (!attrMatch) continue; // text form, handled below
    const attr = attrMatch[1];
    const keyMatch = tag.match(new RegExp(`\\b${attr}="([^"]*)"`));
    if (keyMatch?.[1]) keys.add(keyMatch[1]);
  }

  // Text form: class="... i18n" ...>key<  (content without any markup)
  const textTag = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*\bclass="[^"]*\bi18n\b[^>]*)>([^<]*)</g;
  let match = textTag.exec(html);
  while (match) {
    if (!/\bi18n="/.test(match[2])) {
      const text = match[3].trim();
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(text)) keys.add(text);
    }
    match = textTag.exec(html);
  }

  return keys;
}

const locales = readdirSync('_locales');
const messages = Object.fromEntries(locales.map(locale => [
  locale,
  JSON.parse(readFileSync(`_locales/${locale}/messages.json`, 'utf8'))
]));

const pages = collectPages('.');
// A floor per page and overall: if the scanner regex ever stops matching, this
// test must fail loudly instead of reporting "0 problems" forever.
const FLOORS = { 'chat/chat.html': 15, 'chat/skills.html': 25, 'option/options.html': 20 };

let passed = 0;
let referenced = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check('the scanner finds the expected pages', () => {
  assert.ok(pages.length >= 5, `only found ${pages.length} pages: ${pages.join(', ')}`);
  assert.ok(pages.some(p => p.endsWith('chat/chat.html')), 'chat/chat.html was not scanned');
});

const problems = [];
for (const page of pages) {
  const keys = pageI18nKeys(readFileSync(page, 'utf8'));
  referenced += keys.size;

  const floor = FLOORS[page.replace(/^\.\//, '')];
  if (floor && keys.size < floor) {
    problems.push(`${page}: only ${keys.size} keys found (expected at least ${floor}) - scanner broken?`);
  }

  for (const key of keys) {
    for (const locale of locales) {
      if (!messages[locale][key]?.message) {
        problems.push(`${page}: ${locale} has no message for "${key}"`);
      }
    }
  }
}

check('every translation key used by a page exists in every locale', () => {
  assert.deepEqual(problems, []);
});

check('the scan covers a meaningful number of keys', () => {
  assert.ok(referenced >= 100, `only ${referenced} keys were collected`);
});

console.log(`\n${passed} checks passed (${referenced} keys across ${pages.length} pages, ${locales.length} locales).`);
