/**
 * Chat-history → standalone HTML export.
 *
 * Turns the stored session records
 * (`{ role, content, rtime, model?, fileInfo?, usage? }`) into one self-contained
 * HTML document: markdown is pre-rendered by the caller (so this module stays
 * dependency-free and testable in Node), CSS is injected by the caller, and
 * every dynamic value is escaped.
 *
 * The result is a single file that can be opened offline, printed to PDF with
 * the browser's own "Save as PDF", or archived.
 */
import { formatUsage } from './token-usage.mjs';

/**
 * Escapes text for safe interpolation into HTML.
 * @param {*} text - Raw text
 * @returns {string} Escaped text
 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Makes a string usable as a file name on every platform.
 * @param {*} name - Raw name (session/scenario title)
 * @param {string} [fallback] - Used when nothing usable is left
 * @returns {string} Sanitized name
 */
export function sanitizeFileName(name, fallback = 'chat') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim();
  return cleaned || fallback;
}

/**
 * Formats a timestamp as `YYYY-MM-DD HH:mm` (local time, no locale surprises).
 * @param {number|string|Date} value - Timestamp (ms), date string or Date
 * @returns {string} Formatted date/time, '' when invalid
 */
export function formatDateTime(value) {
  const d = value instanceof Date ? value : new Date(value ?? NaN);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Splits raw assistant markdown into text and `<think>` blocks, keeping the
 * original order. Used to turn the reasoning section into a static
 * `<details>` element (no JavaScript needed in the exported file).
 * @param {*} text - Raw assistant content
 * @returns {Array<{type: 'text'|'think', content: string}>} Blocks in order
 */
export function splitThinkBlocks(text) {
  const source = String(text ?? '');
  if (!source) return [];

  const blocks = [];
  const regex = /<think>([\s\S]*?)<\/think>/gi;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(source)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: 'text', content: source.slice(lastIndex, match.index) });
    }
    blocks.push({ type: 'think', content: match[1] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < source.length) {
    blocks.push({ type: 'text', content: source.slice(lastIndex) });
  }
  return blocks.filter(b => b.content.trim());
}

/**
 * Renders a file attachment (image / pdf / audio / video) stored as a data URL.
 * @param {Object} record - The message record
 * @param {Object} options - { includeImages }
 * @returns {string} HTML
 */
function attachmentHtml(record, options) {
  const info = record.fileInfo || {};
  const src = String(record.content ?? '');
  const name = escapeHtml(info.name || 'attachment');
  const type = String(info.type || '');

  if (type.startsWith('image/')) {
    if (options.includeImages === false) {
      return `<div class="export-attachment export-attachment-skipped">🖼 ${name}</div>`;
    }
    return `<div class="export-attachment"><a href="${escapeHtml(src)}" target="_blank" rel="noopener">` +
      `<img src="${escapeHtml(src)}" alt="${name}"></a></div>`;
  }
  return `<div class="export-attachment"><a href="${escapeHtml(src)}" download="${name}" rel="noopener">📎 ${name}</a></div>`;
}

/**
 * Renders one message record as a section of the exported document.
 * @param {Object} record - { role, content, rtime, model?, fileInfo?, usage? }
 * @param {Object} context - { renderMarkdown, labels, options }
 * @returns {string} HTML
 */
export function recordToHtml(record, context = {}) {
  const renderMarkdown = typeof context.renderMarkdown === 'function'
    ? context.renderMarkdown
    : (text) => escapeHtml(text);
  const labels = context.labels || {};
  const options = { includeThinking: true, includeImages: true, ...(context.options || {}) };

  const isUser = record?.role === 'user';
  const time = formatDateTime(record?.rtime);
  const sender = isUser
    ? (labels.user || 'You')
    : (record?.model || labels.assistant || 'Assistant');

  let body = '';
  if (isUser) {
    body = record?.fileInfo
      ? attachmentHtml(record, options)
      : `<div class="user-text">${escapeHtml(record?.content)}</div>`;
  } else {
    const blocks = splitThinkBlocks(record?.content);
    body = blocks.map(block => {
      const html = renderMarkdown(block.content);
      if (block.type === 'think') {
        if (options.includeThinking === false) return '';
        return `<details class="think"><summary>${escapeHtml(labels.thinking || 'Thinking')}</summary>` +
          `<div class="think-body">${html}</div></details>`;
      }
      return `<div class="markdown-body">${html}</div>`;
    }).join('\n');
  }

  const usageText = isUser ? '' : formatUsage(record?.usage, labels);
  const usageHtml = usageText
    ? `<div class="token-usage">${escapeHtml(usageText)}</div>`
    : '';

  return `<section class="message ${isUser ? 'user-message' : 'bot-message'}">
  <div class="message-header"><span class="message-sender">${escapeHtml(sender)}</span>` +
    `<span class="message-time">${escapeHtml(time)}</span></div>
  <div class="message-body">${body}</div>
  ${usageHtml}
</section>`;
}

/**
 * Builds a timestamped export file name, e.g.
 * `cllama-Study Notes-02-2026-09-26.html`.
 * @param {Object} parts - { scenario, session, date, extension }
 * @returns {string} File name
 */
export function buildExportFileName(parts = {}) {
  const ext = sanitizeFileName(parts.extension || 'html', 'html');
  const date = formatDateTime(parts.date ?? Date.now()).slice(0, 10) || '';
  return [
    sanitizeFileName(parts.scenario, 'cllama'),
    sanitizeFileName(parts.session, 'chat'),
    date
  ].filter(Boolean).join('-').replace(/\s+/g, '_') + `.${ext}`;
}

/**
 * Layout / print styles for the exported document. Kept here (instead of a
 * separate CSS file) so the export stays a single self-contained file that can
 * be opened offline.
 */
export const EXPORT_LAYOUT_CSS = `
:root { color-scheme: light dark; }
body.cllama-export {
  margin: 0;
  padding: 24px;
  background: #ffffff;
  color: #1f2328;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  line-height: 1.5;
}
.export-header { border-bottom: 1px solid #d0d7de; padding-bottom: 12px; margin-bottom: 20px; }
.export-header h1 { font-size: 1.4rem; margin: 0 0 6px; }
.export-meta { font-size: 0.78rem; color: #59636e; }
.export-meta span + span::before { content: " · "; }
.export-body { max-width: 900px; margin: 0 auto; }
.message { margin: 0 0 18px; }
.message-header { font-size: 0.72rem; color: #59636e; margin-bottom: 4px; }
.message-sender { font-weight: 600; margin-right: 8px; }
.user-message .message-body {
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 8px 12px;
}
.user-text { white-space: pre-wrap; word-break: break-word; }
.export-attachment img { max-width: 100%; max-height: 360px; border-radius: 6px; }
.export-attachment { margin: 4px 0; }
.think { margin: 6px 0; border-left: 3px solid #d0d7de; padding-left: 10px; }
.think summary { cursor: pointer; font-size: 0.78rem; color: #59636e; }
.think-body { font-size: 0.85rem; color: #59636e; }
.token-usage {
  font-size: 0.72rem;
  color: #59636e;
  margin-top: 4px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.export-footer {
  max-width: 900px;
  margin: 28px auto 0;
  border-top: 1px solid #d0d7de;
  padding-top: 8px;
  font-size: 0.72rem;
  color: #59636e;
}
pre { overflow-x: auto; }
@media print {
  body.cllama-export { padding: 0; }
  .message, pre, table, img, .think { break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
  .export-footer { page-break-before: auto; }
}
`;

/**
 * Assembles the complete standalone HTML document.
 * @param {Object} params - Export parameters
 * @param {string} [params.title] - Document title / heading
 * @param {Array<string>} [params.meta] - Header meta lines
 * @param {Array<Object>} [params.records] - Session records
 * @param {string} [params.css] - Extra CSS (markdown / KaTeX stylesheets)
 * @param {Function} [params.renderMarkdown] - markdown → HTML renderer
 * @param {Object} [params.labels] - Localized labels (passed to records)
 * @param {Object} [params.options] - { includeThinking, includeImages }
 * @returns {string} Complete HTML document
 */
export function buildChatHtml(params = {}) {
  const title = params.title || 'cllama';
  const records = Array.isArray(params.records) ? params.records : [];
  const meta = (params.meta || []).filter(Boolean);
  const labels = params.labels || {};

  const body = records
    .map(record => recordToHtml(record, {
      renderMarkdown: params.renderMarkdown,
      labels,
      options: params.options
    }))
    .join('\n');

  const metaHtml = meta.length
    ? `<div class="export-meta">${meta.map(m => `<span>${escapeHtml(m)}</span>`).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(params.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${params.css || ''}
${EXPORT_LAYOUT_CSS}
</style>
</head>
<body class="cllama-export">
<header class="export-header">
<h1>${escapeHtml(title)}</h1>
${metaHtml}
</header>
<main class="export-body">
${body}
</main>
<footer class="export-footer">${escapeHtml(labels.generatedBy || 'Exported by cllama')} · ${escapeHtml(formatDateTime(params.exportedAt ?? Date.now()))}</footer>
</body>
</html>
`;
}
