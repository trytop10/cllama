/**
 * Self-check for the chat HTML export (js/chat-export.mjs).
 *
 *   node tools/chat-export.test.mjs
 *
 * The module is dependency-free (markdown rendering is injected), so no browser
 * stub is needed here: a tiny fake renderer keeps the assertions readable.
 */
import assert from 'node:assert/strict';

const {
  buildChatHtml, buildExportFileName, escapeHtml, formatDateTime,
  recordToHtml, sanitizeFileName, splitThinkBlocks
} = await import('../js/chat-export.mjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// Markdown stub: the real renderer is marked(+katex/highlight) in the browser.
const renderMarkdown = (md) => `<p>${escapeHtml(md.trim())}</p>`;

// ------------------- escaping -------------------
check('escapeHtml neutralizes tags and quotes', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml("it's & <b>"), 'it&#39;s &amp; &lt;b&gt;');
  assert.equal(escapeHtml(null), '');
});

check('user text is escaped (no HTML injection into the export)', () => {
  const html = recordToHtml({ role: 'user', content: '<script>alert(1)</script>' }, { renderMarkdown });
  assert.ok(!html.includes('<script>'), 'script tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'));
});

// ------------------- file names -------------------
check('sanitizeFileName strips path and reserved characters', () => {
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(sanitizeFileName('   '), 'chat');
  assert.equal(sanitizeFileName('...hidden'), 'hidden');
  assert.ok(sanitizeFileName('x'.repeat(200)).length <= 60);
});

check('buildExportFileName builds scenario-session-date.html', () => {
  const date = new Date(2026, 8, 26, 10, 30); // 2026-09-26 local
  assert.equal(buildExportFileName({ scenario: 'Study Notes', session: '02', date }),
    'Study_Notes-02-2026-09-26.html');
  assert.equal(buildExportFileName({ date }), 'cllama-chat-2026-09-26.html');
});

check('formatDateTime is stable and padded', () => {
  assert.equal(formatDateTime(new Date(2026, 0, 5, 9, 7)), '2026-01-05 09:07');
  assert.equal(formatDateTime(null), '');
});

// ------------------- thinking blocks -------------------
check('splitThinkBlocks keeps order and skips empty parts', () => {
  const blocks = splitThinkBlocks('<think>hmm</think>answer');
  assert.deepEqual(blocks, [
    { type: 'think', content: 'hmm' },
    { type: 'text', content: 'answer' }
  ]);
  assert.deepEqual(splitThinkBlocks('plain'), [{ type: 'text', content: 'plain' }]);
  assert.deepEqual(splitThinkBlocks(''), []);
});

check('thinking becomes a static <details> block', () => {
  const html = recordToHtml({ role: 'assistant', content: '<think>why</think>因为' }, { renderMarkdown });
  assert.ok(html.includes('<details class="think"><summary>Thinking</summary>'));
  assert.ok(html.includes('<div class="markdown-body"><p>因为</p></div>'));
});

check('thinking can be excluded from the export', () => {
  const html = recordToHtml({ role: 'assistant', content: '<think>why</think>因为' },
    { renderMarkdown, options: { includeThinking: false } });
  assert.ok(!html.includes('<details'), 'no details block expected');
  assert.ok(!html.includes('why'));
  assert.ok(html.includes('因为'));
});


// ------------------- attachments -------------------
const imageRecord = {
  role: 'user',
  content: 'data:image/png;base64,AAAA',
  fileInfo: { name: 'shot.png', type: 'image/png', send: true }
};

check('image attachments are embedded', () => {
  const html = recordToHtml(imageRecord, { renderMarkdown });
  assert.ok(html.includes('<img src="data:image/png;base64,AAAA" alt="shot.png">'));
});

check('images can be skipped (keeps the file small)', () => {
  const html = recordToHtml(imageRecord, { renderMarkdown, options: { includeImages: false } });
  assert.ok(!html.includes('<img'), 'image must not be embedded');
  assert.ok(html.includes('shot.png'));
});

check('non-image attachments become download links', () => {
  const html = recordToHtml({
    role: 'user',
    content: 'data:application/pdf;base64,BBBB',
    fileInfo: { name: 'doc.pdf', type: 'application/pdf' }
  }, { renderMarkdown });
  assert.ok(html.includes('download="doc.pdf"'));
  assert.ok(html.includes('📎 doc.pdf'));
});

// ------------------- usage line -------------------
check('assistant answers show the token line', () => {
  const html = recordToHtml({
    role: 'assistant',
    content: 'hi',
    usage: { input: 1200, output: 30, total: 1230, cached: 0, estimated: false }
  }, { renderMarkdown });
  assert.ok(html.includes('<div class="token-usage">Input 1,200 · Output 30 · Total 1,230 tokens</div>'));
});

check('user messages carry no token line', () => {
  const html = recordToHtml({
    role: 'user',
    content: 'hi',
    usage: { input: 1, output: 1, total: 2, cached: 0, estimated: false }
  }, { renderMarkdown });
  assert.ok(!html.includes('token-usage'));
});

check('messages without usage omit the token line', () => {
  const html = recordToHtml({ role: 'assistant', content: 'hi' }, { renderMarkdown });
  assert.ok(!html.includes('token-usage'));
});

// ------------------- document -------------------
check('buildChatHtml produces a complete, self-contained document', () => {
  const html = buildChatHtml({
    title: 'Session 02',
    lang: 'zh-CN',
    meta: ['Messages: 2', 'Model: gemma3'],
    records: [
      { role: 'user', content: '问题', rtime: new Date(2026, 8, 26, 10, 30).getTime() },
      { role: 'assistant', content: 'answer', model: 'gemma3', rtime: Date.now(),
        usage: { input: 5, output: 2, total: 7, cached: 0, estimated: true } }
    ],
    css: '.markdown-body { color: red; }',
    renderMarkdown,
    labels: { thinking: 'Thinking', generatedBy: 'Exported by cllama' }
  });

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="zh-CN">'));
  assert.ok(html.includes('<title>Session 02</title>'));
  assert.ok(html.includes('.markdown-body { color: red; }'), 'injected CSS must be inlined');
  assert.ok(html.includes('@media print'), 'print rules must be present');
  assert.ok(html.includes('.token-usage'), 'layout css must style the token line');
  assert.ok(html.includes('<span>Messages: 2</span><span>Model: gemma3</span>'));
  assert.ok(html.includes('class="message user-message"'));
  assert.ok(html.includes('class="message bot-message"'));
  assert.ok(html.includes('Input ≈5'), 'estimated usage is marked in the export too');
});

check('buildChatHtml survives empty / malformed input', () => {
  assert.ok(buildChatHtml({}).includes('<!DOCTYPE html>'));
  const withJunk = buildChatHtml({ records: [null, {}, { role: 'assistant' }], renderMarkdown });
  assert.ok(withJunk.includes('bot-message'));
});

// ------------------- real markdown pipeline (integration) -------------------
// Uses the very marked instance the chat page uses, proving the injected
// renderer path yields a genuinely formatted document (tables, code, thinking,
// token line) while user input stays escaped.
const { marked } = await import('../js/marked.mjs');
const integration = buildChatHtml({
  title: 'Integration',
  records: [
    { role: 'user', content: '<b>hi</b>' },
    { role: 'assistant', content: '<think>why</think>**bold**\n\n| a |\n| - |\n| 1 |\n\n```js\nconst a = 1;\n```',
      usage: { input: 10, output: 2, total: 12, cached: 0, estimated: false } }
  ],
  renderMarkdown: (md) => marked.parse(md),
  labels: { thinking: 'Thinking' }
});
assert.ok(integration.includes('<table>'), 'markdown table must be rendered');
assert.ok(integration.includes('<strong>bold</strong>'));
assert.ok(integration.includes('hljs'), 'code highlighting classes must be present');
assert.ok(integration.includes('<details class="think">'));
assert.ok(integration.includes('&lt;b&gt;hi&lt;/b&gt;'), 'user text must stay escaped');
assert.ok(integration.includes('Input 10 · Output 2 · Total 12 tokens'));
assert.ok(!integration.includes('<script'), 'the export must contain no script');
passed++;
console.log('ok - real markdown pipeline renders a formatted document');

console.log(`\n${passed} checks passed.`);
