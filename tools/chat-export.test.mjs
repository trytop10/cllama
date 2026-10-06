/**
 * Self-check for the chat HTML export (js/chat-export.mjs).
 *
 *   node tools/chat-export.test.mjs
 *
 * The module is dependency-free (markdown rendering is injected), so no browser
 * stub is needed here: a tiny fake renderer keeps the assertions readable.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const {
  buildChatHtml, buildExportFileName, escapeHtml, formatDateTime,
  recordToHtml, sanitizeFileName, splitThinkBlocks, EXPORT_LAYOUT_CSS
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

check('print rules let long answers flow instead of owning a page', () => {
  const printBlock = EXPORT_LAYOUT_CSS.slice(EXPORT_LAYOUT_CSS.indexOf('@media print'));
  assert.ok(printBlock.length > 0, '@media print must exist');
  // The rule carries a comment explaining why .message is absent, so strip
  // comments before looking for selectors.
  const printCss = printBlock.replace(/\/\*[\s\S]*?\*\//g, '');

  // Blocks that look broken when split stay together...
  assert.ok(printCss.includes('break-inside: avoid'), 'code/tables/images must stay unbreakable');
  // ...but a whole message must be splittable: `avoid` on .message pushes the
  // entire bubble to the next page and leaves the previous one almost empty.
  assert.ok(!printCss.includes('.message'), '.message must not appear in the print rules at all');
  // No orphan/widow lines at a page boundary.
  assert.ok(/orphans:/.test(printCss) && /widows:/.test(printCss), 'orphans/widows must be set');
  // Headings must not be stranded at the bottom of a page.
  assert.ok(/break-after:\s*avoid/.test(printCss), 'headings must not break right after');
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

// ------------------- per-answer export (chat/chat.js) -------------------
// One answer is exported with the same builder, but in `minimal` mode: only the
// answer body survives — no heading, no model name, no token line, no footer,
// and no thinking block. The file name is what remembers where it came from.
const replyOnly = buildChatHtml({
  title: 'Chat freely · 00',
  meta: ['Model: gemma3'],
  records: [{
    role: 'assistant',
    content: '<think>secret reasoning</think>The answer.',
    rtime: Date.now(),
    model: 'gemma3',
    usage: { input: 19, output: 300, total: 319, cached: 0, estimated: false }
  }],
  renderMarkdown,
  labels: { generatedBy: 'Exported by cllama' },
  options: { includeThinking: false, minimal: true }
});
assert.ok(replyOnly.includes('The answer.'), 'the reply text must be exported');
assert.ok(!replyOnly.includes('secret reasoning'), 'thinking must not be exported');
assert.ok(!replyOnly.includes('<details class="think">'), 'no think block must be emitted');
assert.ok(!replyOnly.includes('class="export-header"'), 'no document header in a minimal export');
assert.ok(!replyOnly.includes('Chat freely'), 'no scenario/session heading in a minimal export');
assert.ok(!replyOnly.includes('gemma3'), 'no model name in a minimal export');
assert.ok(!replyOnly.includes('class="message-header"'), 'no sender/time line in a minimal export');
assert.ok(!replyOnly.includes('class="token-usage"'), 'no token line in a minimal export');
assert.ok(!replyOnly.includes('class="export-footer"'), 'no footer in a minimal export');
assert.ok(!replyOnly.includes('Exported by cllama'), 'the export credit line must be gone too');
assert.ok(!replyOnly.includes('Input'), 'usage labels must not leak in either');
assert.ok(replyOnly.includes('cllama-export-minimal'), 'the minimal marker class must be set');
passed++;
console.log('ok - a single answer exports as just the answer body');

check('minimal does not change the session export', () => {
  const full = buildChatHtml({
    title: 'Chat freely · 00',
    meta: ['Messages: 1'],
    records: [{ role: 'assistant', content: 'Hi', model: 'gemma3', usage: { input: 1, output: 2, total: 3 } }],
    renderMarkdown,
    options: { includeThinking: false }
  });
  assert.ok(full.includes('class="export-header"'), 'the session export keeps its header');
  assert.ok(full.includes('class="message-header"'), 'the session export keeps sender/time');
  assert.ok(full.includes('class="token-usage"'), 'the session export keeps the token line');
  assert.ok(full.includes('class="export-footer"'), 'the session export keeps its footer');
  // The rule itself is always in the shared stylesheet; it is the body class
  // that must stay off (see EXPORT_LAYOUT_CSS).
  assert.ok(full.includes('<body class="cllama-export">'), 'the session export is not marked minimal');
});

// ------------------- i18n parity -------------------
check('every locale defines the per-answer export messages', () => {
  const required = ['exportReply', 'exportReplyHtml', 'exportReplyPdf'];
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

console.log(`\n${passed} checks passed.`);
