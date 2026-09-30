/**
 * Self-check for the chat-history search helpers (js/chat-search.mjs).
 *
 *   node tools/chat-search.test.mjs
 *
 * Pure functions only: no browser stub needed.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const {
  MAX_MATCHES_PER_MESSAGE, buildMatcher, escapeRegExp, findMatches, makeSnippet,
  recordText, searchHistoryStore, searchRecords, stripForSearch
} = await import('../js/chat-search.mjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ------------------- escaping / matching -------------------
check('escapeRegExp neutralises regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b*c?'), 'a\\.b\\*c\\?');
  assert.equal(escapeRegExp('(x)[y]{z}'), '\\(x\\)\\[y\\]\\{z\\}');
  assert.equal(escapeRegExp('a\\b'), 'a\\\\b');
  assert.equal(escapeRegExp(null), '');
});

check('buildMatcher returns null for an empty query', () => {
  assert.equal(buildMatcher(''), null);
  assert.equal(buildMatcher('   ').source, '   ');
  assert.equal(buildMatcher('x').flags, 'gi');
  assert.equal(buildMatcher('x', { caseSensitive: true }).flags, 'g');
});

check('findMatches is case-insensitive by default and can be made strict', () => {
  assert.deepEqual(findMatches('Hello hello HELLO', 'hello'), [
    { start: 0, end: 5 }, { start: 6, end: 11 }, { start: 12, end: 17 }
  ]);
  assert.deepEqual(findMatches('Hello hello', 'hello', { caseSensitive: true }), [{ start: 6, end: 11 }]);
});

check('findMatches treats the query literally (no regex injection)', () => {
  assert.deepEqual(findMatches('cost is $3.50 (approx)', '$3.50'), [{ start: 8, end: 13 }]);
  assert.deepEqual(findMatches('2*3=6', '*' ), [{ start: 1, end: 2 }]);
});

check('findMatches works without word boundaries (CJK and code identifiers)', () => {
  assert.deepEqual(findMatches('这是一个测试，测试通过', '测试'), [
    { start: 4, end: 6 }, { start: 7, end: 9 }
  ]);
  assert.deepEqual(findMatches('getUserName()', 'getUser'), [{ start: 0, end: 7 }]);
});

check('findMatches caps the number of results', () => {
  assert.equal(findMatches('aaaaaa', 'a', { maxMatches: 3 }).length, 3);
  assert.equal(findMatches('aaaaaa', 'a').length, 6);
  assert.equal(MAX_MATCHES_PER_MESSAGE, 200);
});

check('findMatches tolerates empty / non-string input', () => {
  assert.deepEqual(findMatches('', 'x'), []);
  assert.deepEqual(findMatches(null, 'x'), []);
  assert.deepEqual(findMatches('abc', ''), []);
});

// ------------------- plain-text rendering -------------------
check('stripForSearch drops thinking blocks but keeps the answer', () => {
  const text = stripForSearch('<think>secret reasoning</think>Final answer here');
  assert.equal(text, 'Final answer here');
  assert.ok(!text.includes('secret'));
});

check('stripForSearch removes markdown markers', () => {
  assert.equal(stripForSearch('# Title'), 'Title');
  assert.equal(stripForSearch('- item one'), 'item one');
  assert.equal(stripForSearch('> quoted'), 'quoted');
  assert.equal(stripForSearch('**bold** and _italic_'), 'bold and italic');
  assert.equal(stripForSearch('`code`'), 'code');
  assert.equal(stripForSearch('1. first'), 'first');
});

check('stripForSearch keeps link text, image alt and code body', () => {
  assert.equal(stripForSearch('[docs](https://example.com/a)'), 'docs');
  assert.equal(stripForSearch('![logo](/images/logo.png)'), 'logo');
  assert.equal(stripForSearch('```js\nconst x = 1;\n```'), 'const x = 1;');
});

check('stripForSearch removes leftover HTML and collapses whitespace', () => {
  assert.equal(stripForSearch('<p>a</p>\n\n\n<br>  b'), 'a\nb');
  assert.equal(stripForSearch('  spaced   out  '), 'spaced out');
  assert.equal(stripForSearch(''), '');
  assert.equal(stripForSearch(undefined), '');
});

check('recordText shows a file name instead of the data URL', () => {
  assert.equal(recordText({ content: 'data:image/png;base64,AAAA', fileInfo: { name: 'cat.png' } }), 'cat.png');
  assert.equal(recordText({ content: 'data:image/png;base64,AAAA' }), '');
  assert.equal(recordText({ content: 'plain text' }), 'plain text');
});

// ------------------- snippets -------------------
check('makeSnippet centres the match and adds ellipses only where cut', () => {
  const long = `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}`;
  const snippet = makeSnippet(long, 'NEEDLE', { radius: 10 });
  assert.equal(snippet.text, `…${'a'.repeat(10)}NEEDLE${'b'.repeat(10)}…`);
  assert.equal(snippet.text.slice(snippet.hitStart, snippet.hitEnd), 'NEEDLE');
});

check('makeSnippet keeps a short text untouched when the match is inside', () => {
  const snippet = makeSnippet('hello world', 'world', { radius: 10 });
  assert.equal(snippet.text, 'hello world');
  assert.equal(snippet.hitStart, 6);
  assert.equal(snippet.hitEnd, 11);
});

check('makeSnippet folds newlines and falls back to the head without a match', () => {
  assert.equal(makeSnippet('line one\nline two', 'two').text, 'line one line two');
  const noMatch = makeSnippet('abcdef', 'zzz', { radius: 2 });
  assert.equal(noMatch.text, 'abcd…');
  assert.equal(noMatch.hitStart, -1);
  assert.deepEqual(makeSnippet('', 'x'), { text: '', hitStart: -1, hitEnd: -1 });
});

console.log(`\n${passed} checks passed.`);


// ------------------- one conversation -------------------
const records = [
  { role: 'user', content: 'How do I install cllama?', rtime: 100 },
  { role: 'assistant', content: '<think>hmm consider npm</think>Run `npm i` to install it in the project root.', rtime: 200 },
  { role: 'user', content: 'Thanks!', rtime: 300 },
  { role: 'user', content: 'data:image/png;base64,AAAA', rtime: 400, fileInfo: { name: 'shot.png' } }
];

check('searchRecords returns matching messages in display order', () => {
  const hits = searchRecords(records, 'install');
  assert.deepEqual(hits.map(h => h.index), [0, 1]);
  assert.deepEqual(hits.map(h => h.role), ['user', 'assistant']);
  assert.deepEqual(hits.map(h => h.rtime), [100, 200]);
  // The question and the visible answer both mention "install"; the thinking
  // block of the answer is skipped ("hmm consider npm" is not searchable).
  assert.deepEqual(hits.map(h => h.count), [1, 1]);
});

check('searchRecords counts every occurrence inside one message', () => {
  const hits = searchRecords([{ role: 'user', content: 'test test test' }], 'test');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 3);
});

check('searchRecords searches attachment file names', () => {
  const hits = searchRecords(records, 'shot');
  assert.deepEqual(hits.map(h => h.index), [3]);
});

check('searchRecords honours limit and ignores junk input', () => {
  assert.equal(searchRecords(records, 'install').length, 2);
  assert.equal(searchRecords(records, 'install', { limit: 1 }).length, 1);
  assert.deepEqual(searchRecords(null, 'x'), []);
  assert.deepEqual(searchRecords([], 'x'), []);
  assert.deepEqual(searchRecords(records, ''), []);
  assert.deepEqual(searchRecords([{ role: 'user', content: 'irrelevant' }], 'zzz'), []);
});

// ------------------- whole store -------------------
const store = {
  base: { anything: true },
  chatHistory_0: {
    currentId: 0,
    history: [
      { id: 0, name: '00', records: [{ role: 'user', content: 'hello world', rtime: 1 }] }
    ]
  },
  chatHistory_2: {
    currentId: 1,
    history: [
      { id: 1, name: '01', records: [{ role: 'assistant', content: 'hello from two', rtime: 2 }] },
      { id: 0, name: '00', records: [{ role: 'user', content: 'unrelated', rtime: 3 }] }
    ]
  },
  chatHistory_broken: 'not-an-object'
};

check('searchHistoryStore walks every chatHistory_* key', () => {
  const hits = searchHistoryStore(store, 'hello');
  assert.deepEqual(hits.map(h => `${h.scenarioId}:${h.sessionId}`), ['0:0', '2:1']);
  assert.deepEqual(hits.map(h => h.role), ['user', 'assistant']);
  assert.deepEqual(hits.map(h => h.rtime), [1, 2]);
});

check('searchHistoryStore sorts sessions by id inside a scenario', () => {
  const hits = searchHistoryStore({ chatHistory_2: store.chatHistory_2 }, 'hello');
  assert.deepEqual(hits.map(h => h.sessionId), [1]);
});

check('searchHistoryStore can be limited to one scenario', () => {
  assert.deepEqual(searchHistoryStore(store, 'hello', { scenarioId: '2' }).map(h => h.scenarioId), ['2']);
  assert.deepEqual(searchHistoryStore(store, 'hello', { scenarioId: 0 }).map(h => h.scenarioId), ['0']);
  assert.equal(searchHistoryStore(store, 'hello', { scenarioId: '9' }).length, 0);
});

check('searchHistoryStore attaches scenario and session names', () => {
  const hits = searchHistoryStore(store, 'hello', { scenarioNames: { 0: 'Chat', 2: 'Coding' } });
  assert.deepEqual(hits.map(h => h.scenarioName), ['Chat', 'Coding']);
  assert.deepEqual(hits.map(h => h.sessionName), ['00', '01']);
  // Unknown scenario: an empty name, never "undefined".
  assert.deepEqual(searchHistoryStore(store, 'hello').map(h => h.scenarioName), ['', '']);
});

check('searchHistoryStore tolerates corrupt entries and empty input', () => {
  assert.deepEqual(searchHistoryStore(null, 'x'), []);
  assert.deepEqual(searchHistoryStore('nope', 'x'), []);
  assert.deepEqual(searchHistoryStore({ chatHistory_1: null }, 'x'), []);
  assert.deepEqual(searchHistoryStore({ chatHistory_1: { history: 'nope' } }, 'x'), []);
  assert.deepEqual(searchHistoryStore({ chatHistory_1: { history: [{ id: 0 }] } }, 'x'), []);
  // Non-chat keys are never scanned.
  assert.deepEqual(searchHistoryStore({ base: { secret: 'hello' } }, 'hello'), []);
});

check('searchHistoryStore honours the global limit and snippet radius', () => {
  const hits = searchHistoryStore(store, 'hello', { limit: 1, snippetRadius: 3 });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].snippet.text.includes('hello'));
});

// ------------------- i18n parity -------------------
check('every locale defines the chat-search messages', () => {
  const required = [
    'chatSearch', 'chatSearchPlaceholder', 'chatSearchPrev', 'chatSearchNext',
    'chatSearchClose', 'chatSearchCount', 'chatSearchNoMatch', 'chatSearchScopeSession',
    'chatSearchScopeScenario', 'chatSearchScopeAll', 'chatSearchResultsCount', 'chatSearchBusy'
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

check('the count messages keep the placeholders chat.js replaces', () => {
  for (const locale of readdirSync(new URL('../_locales', import.meta.url))) {
    const messages = JSON.parse(readFileSync(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
    assert.match(messages.chatSearchCount.message, /\{index\}/, `${locale}: chatSearchCount lost {index}`);
    assert.match(messages.chatSearchCount.message, /\{total\}/, `${locale}: chatSearchCount lost {total}`);
    assert.match(messages.chatSearchResultsCount.message, /\{count\}/, `${locale}: chatSearchResultsCount lost {count}`);
  }
});

console.log(`\n${passed} checks passed.`);
