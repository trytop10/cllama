/**
 * Self-check for the chat bookmark helpers (js/chat-bookmarks.mjs).
 *
 *   node tools/chat-bookmarks.test.mjs
 *
 * Pure functions only: no browser stub needed.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const {
  MAX_BOOKMARKS, MAX_BOOKMARK_CHARS, addBookmark, bookmarkId, bookmarkText,
  groupBookmarks, isBookmarked, makeBookmark, normalizeBookmark, normalizeBookmarks,
  parseBookmarkId, removeBookmark, sortBookmarks, trimContent
} = await import('../js/chat-bookmarks.mjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ------------------- identity -------------------
check('bookmarkId is stable and normalises the parts', () => {
  assert.equal(bookmarkId('2', 1, 1700), '2:1:1700');
  assert.equal(bookmarkId(2, '1', 1700), '2:1:1700');
  assert.equal(bookmarkId(undefined, undefined, 5), '0:0:5');
  assert.equal(bookmarkId('', '', 5), '0:0:5');
  assert.equal(bookmarkId(null, null, 5), '0:0:5');
});

check('bookmarkId refuses a non-numeric timestamp', () => {
  assert.equal(bookmarkId('0', 0, undefined), '');
  assert.equal(bookmarkId('0', 0, 'abc'), '');
  assert.equal(bookmarkId('0', 0, NaN), '');
});

check('parseBookmarkId round-trips and rejects junk', () => {
  assert.deepEqual(parseBookmarkId(bookmarkId('3', '7', 42)), { scenarioId: '3', sessionId: '7', rtime: 42 });
  assert.equal(parseBookmarkId('3:7'), null);
  assert.equal(parseBookmarkId('3:7:abc'), null);
  assert.equal(parseBookmarkId(''), null);
});

// ------------------- snapshot -------------------
check('trimContent keeps short text and flags the truncated one', () => {
  assert.deepEqual(trimContent('abc', 10), { content: 'abc', truncated: false });
  const long = trimContent('x'.repeat(20), 10);
  assert.equal(long.content.length, 10);
  assert.equal(long.truncated, true);
  assert.deepEqual(trimContent(undefined, 10), { content: '', truncated: false });
  assert.equal(MAX_BOOKMARK_CHARS, 50000);
});

check('makeBookmark captures the record, the origin and the time', () => {
  const made = makeBookmark(
    { role: 'assistant', content: 'Answer text', rtime: 1700, model: 'gpt-x' },
    { scenarioId: '2', sessionId: 1, scenarioName: 'Coding', sessionName: '01', now: 9999 });
  assert.equal(made.ok, true);
  assert.deepEqual(made.notes, []);
  assert.equal(made.bookmark.id, '2:1:1700');
  assert.equal(made.bookmark.content, 'Answer text');
  assert.equal(made.bookmark.role, 'assistant');
  assert.equal(made.bookmark.model, 'gpt-x');
  assert.equal(made.bookmark.scenarioName, 'Coding');
  assert.equal(made.bookmark.sessionName, '01');
  assert.equal(made.bookmark.createdAt, 9999);
  assert.equal(made.bookmark.truncated, false);
});

check('makeBookmark refuses a message without timestamp or content', () => {
  assert.equal(makeBookmark({ role: 'assistant', content: 'x' }).ok, false);
  assert.equal(makeBookmark({ role: 'assistant', content: '', rtime: 1 }).ok, false);
  assert.equal(makeBookmark(null, { scenarioId: '0', sessionId: 0 }).ok, false);
});

check('makeBookmark slims attachments down to the file name', () => {
  const made = makeBookmark(
    { role: 'user', content: 'data:image/png;base64,AAAA', rtime: 5, fileInfo: { name: 'cat.png', type: 'image/png', size: 999, send: true } },
    { scenarioId: '0', sessionId: 0, now: 1 });
  assert.equal(made.ok, true);
  assert.equal(made.bookmark.content, '');
  assert.deepEqual(made.bookmark.fileInfo, { name: 'cat.png', type: 'image/png' });
  assert.equal(bookmarkText(made.bookmark), 'cat.png');
});

check('makeBookmark truncates a huge answer and says so in notes', () => {
  const made = makeBookmark({ role: 'assistant', content: 'y'.repeat(MAX_BOOKMARK_CHARS + 10), rtime: 1 },
    { scenarioId: '0', sessionId: 0, now: 1 });
  assert.equal(made.bookmark.content.length, MAX_BOOKMARK_CHARS);
  assert.equal(made.bookmark.truncated, true);
  assert.deepEqual(made.notes, ['content truncated']);
});

// ------------------- validation -------------------
check('normalizeBookmark fills the missing fields and rejects broken entries', () => {
  const ok = normalizeBookmark({ id: '1:2:3', content: 'hello' });
  assert.equal(ok.ok, true);
  assert.equal(ok.bookmark.scenarioId, '1');
  assert.equal(ok.bookmark.sessionId, '2');
  assert.equal(ok.bookmark.rtime, 3);
  assert.equal(ok.bookmark.createdAt, 0);

  assert.equal(normalizeBookmark(null).ok, false);
  assert.equal(normalizeBookmark('nope').ok, false);
  assert.equal(normalizeBookmark({ id: 'bad', content: 'x' }).ok, false);
  assert.equal(normalizeBookmark({ id: '1:2:3' }).ok, false);
});

check('normalizeBookmarks drops junk and duplicates', () => {
  const list = normalizeBookmarks([
    { id: '1:2:3', content: 'a' },
    { id: '1:2:3', content: 'duplicate' },
    { id: 'oops', content: 'b' },
    null,
    { id: '1:2:4', content: 'c' }
  ]);
  assert.deepEqual(list.map(b => b.id), ['1:2:3', '1:2:4']);
  assert.equal(list[0].content, 'a');
  assert.deepEqual(normalizeBookmarks('nope'), []);
  assert.deepEqual(normalizeBookmarks(undefined), []);
});

// ------------------- list operations -------------------
const sample = (id, createdAt) => ({ id, createdAt, content: id });

check('addBookmark appends once and is idempotent', () => {
  const first = addBookmark([], sample('1:0:1', 10));
  assert.equal(first.action, 'created');
  assert.equal(first.list.length, 1);

  const again = addBookmark(first.list, sample('1:0:1', 10));
  assert.equal(again.action, 'exists');
  assert.equal(again.list.length, 1);
});

check('addBookmark refuses at the cap instead of evicting', () => {
  let list = [];
  for (let i = 0; i < 3; i++) list = addBookmark(list, sample(`1:0:${i}`, i), { max: 3 }).list;
  const result = addBookmark(list, sample('1:0:99', 99), { max: 3 });
  assert.equal(result.action, 'atCapacity');
  assert.equal(result.list.length, 3);
  assert.ok(!isBookmarked(result.list, '1:0:99'));
});

check('addBookmark rejects an entry without id', () => {
  assert.equal(addBookmark([], { content: 'x' }).action, 'atCapacity');
  assert.equal(MAX_BOOKMARKS, 300);
});

check('removeBookmark removes by id and reports whether it did', () => {
  const list = [sample('1:0:1', 1), sample('1:0:2', 2)];
  const gone = removeBookmark(list, '1:0:1');
  assert.equal(gone.removed, true);
  assert.deepEqual(gone.list.map(b => b.id), ['1:0:2']);
  assert.equal(removeBookmark(list, 'nope').removed, false);
  assert.equal(list.length, 2, 'the input list is not mutated');
});

check('isBookmarked tolerates junk input', () => {
  assert.equal(isBookmarked([sample('a', 1)], 'a'), true);
  assert.equal(isBookmarked([sample('a', 1)], 'b'), false);
  assert.equal(isBookmarked(null, 'a'), false);
  assert.equal(isBookmarked([sample('a', 1)], ''), false);
});

// ------------------- display -------------------
check('sortBookmarks is newest first and deterministic', () => {
  const sorted = sortBookmarks([sample('b', 10), sample('a', 30), sample('c', 10)]);
  assert.deepEqual(sorted.map(b => b.id), ['a', 'c', 'b']);
  assert.deepEqual(sortBookmarks(null), []);
});

check('groupBookmarks nests scenario -> session and keeps first-seen order', () => {
  const groups = groupBookmarks([
    { id: '1:0:1', scenarioId: '1', sessionId: '0', scenarioName: 'Coding', sessionName: '00' },
    { id: '2:5:2', scenarioId: '2', sessionId: '5', scenarioName: 'Writing', sessionName: '05' },
    { id: '1:0:3', scenarioId: '1', sessionId: '0', scenarioName: 'Coding', sessionName: '00' },
    { id: '1:7:4', scenarioId: '1', sessionId: '7', scenarioName: 'Coding', sessionName: '07' }
  ]);
  assert.deepEqual(groups.map(g => g.scenarioId), ['1', '2']);
  assert.deepEqual(groups[0].sessions.map(s => s.sessionId), ['0', '7']);
  assert.deepEqual(groups[0].sessions[0].items.map(b => b.id), ['1:0:1', '1:0:3']);
  assert.equal(groups[0].scenarioName, 'Coding');
  assert.deepEqual(groupBookmarks(null), []);
});

check('bookmarkText falls back to the file name', () => {
  assert.equal(bookmarkText({ content: 'text' }), 'text');
  assert.equal(bookmarkText({ content: '', fileInfo: { name: 'a.pdf' } }), 'a.pdf');
  assert.equal(bookmarkText({ content: '', fileInfo: null }), '');
  assert.equal(bookmarkText(null), '');
});

// ------------------- i18n parity -------------------
check('every locale defines the bookmark messages', () => {
  const required = [
    'bookmarkAdd', 'bookmarkRemove', 'bookmarkList', 'bookmarkEmpty', 'bookmarkJump',
    'bookmarkGone', 'bookmarkAdded', 'bookmarkRemoved', 'bookmarkLimitReached',
    'bookmarkCount', 'bookmarkTruncated'
  ];
  const en = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));
  for (const key of required) {
    assert.ok(en[key]?.message, `en is missing ${key}`);
  }
  for (const locale of readdirSync(new URL('../_locales', import.meta.url))) {
    const messages = JSON.parse(readFileSync(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
    for (const key of required) {
      assert.ok(messages[key]?.message, `${locale} is missing ${key}`);
    }
  }
});

check('the bookmark count message keeps its {count} placeholder', () => {
  for (const locale of readdirSync(new URL('../_locales', import.meta.url))) {
    const messages = JSON.parse(readFileSync(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
    assert.match(messages.bookmarkCount.message, /\{count\}/, `${locale}: bookmarkCount lost {count}`);
  }
});

console.log(`\n${passed} checks passed.`);
