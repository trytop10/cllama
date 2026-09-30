/**
 * Search helpers for chat history (the messages of one conversation, and every
 * stored `chatHistory_<scenarioId>` record).
 *
 * Pure functions only: no DOM, no `browser`, so `tools/chat-search.test.mjs` can
 * import this module in Node. The page (chat/chat.js) owns the DOM work
 * (highlighting, scrolling, rendering the result list) and calls in here for the
 * matching / snippet / store-scanning logic — the same split as
 * `token-usage.mjs` and `chat-export.mjs`.
 *
 * @module chat-search
 */

/** Characters that would change the meaning of a pattern if left unescaped. */
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** Upper bound for matches collected from one message, so a query like "e" on a
 * huge code block cannot build an unbounded array. */
export const MAX_MATCHES_PER_MESSAGE = 200;

/**
 * Escapes a string so it can be embedded in a regular expression literally.
 * @param {string} text - Raw text
 * @returns {string} Escaped text
 */
export function escapeRegExp(text) {
  return String(text ?? '').replace(REGEXP_SPECIALS, '\\$&');
}

/**
 * Builds the case-(in)sensitive matcher used everywhere in this module.
 * @param {string} query - Search query
 * @param {Object} [options] - { caseSensitive }
 * @returns {RegExp|null} Global regexp, or null for an empty query
 */
export function buildMatcher(query, options = {}) {
  const pattern = String(query ?? '');
  if (!pattern) return null;
  // No `\b`/word logic on purpose: a substring search is what users expect from
  // an in-page find, and it also works for CJK and code identifiers.
  return new RegExp(escapeRegExp(pattern), options.caseSensitive ? 'g' : 'gi');
}

/**
 * All occurrences of the query inside a text, in order.
 * @param {string} text - Text to scan
 * @param {string} query - Search query
 * @param {Object} [options] - { caseSensitive, maxMatches }
 * @returns {Array<{start: number, end: number}>} Match ranges (empty when none)
 */
export function findMatches(text, query, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const matcher = buildMatcher(query, options);
  if (!matcher || !source) return [];

  const max = Number.isFinite(options.maxMatches) && options.maxMatches > 0
    ? options.maxMatches
    : MAX_MATCHES_PER_MESSAGE;

  const out = [];
  let match = matcher.exec(source);
  while (match) {
    if (match[0] === '') {
      // Guard against a pattern that can match the empty string: advance one
      // character instead of looping forever.
      matcher.lastIndex++;
    } else {
      out.push({ start: match.index, end: match.index + match[0].length });
      if (out.length >= max) break;
    }
    match = matcher.exec(source);
  }
  return out;
}

/**
 * Renders a message as plain searchable text: thinking blocks are dropped (the
 * model's reasoning is not what the user is looking for), markdown markers are
 * removed so "**bold**" matches a search for "bold", and code is kept (it is
 * frequently what people search for).
 * @param {string} text - Raw message content (markdown or HTML)
 * @returns {string} Plain text
 */
export function stripForSearch(text) {
  let out = typeof text === 'string' ? text : '';
  if (!out) return '';

  // Drop the whole thinking block (opening tag, content and closing tag).
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  // Any other HTML that survived (rendered answers, <img>, <br>...).
  out = out.replace(/<[^>]*>/g, ' ');
  // Fenced code: keep the code itself, drop the fence and its language hint.
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '');
  out = out.replace(/[*_~]{1,3}/g, '');
  out = out.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, ' ');
  out = out.replace(/[ \t\r\f\v]+/g, ' ');
  out = out.replace(/ *\n */g, '\n');
  out = out.replace(/\n{2,}/g, '\n');
  return out.trim();
}

/**
 * Text of a history record: attachment messages store a data URL (or a file
 * name) as their content, which is noise to search through, so they are shown
 * as their file name instead.
 * @param {Object} record - History record { role, content, fileInfo }
 * @returns {string} Text to search
 */
export function recordText(record) {
  const content = typeof record?.content === 'string' ? record.content : '';
  if (/^data:[^,]*,/i.test(content)) {
    return record?.fileInfo?.name ? String(record.fileInfo.name) : '';
  }
  return content;
}

/**
 * A one-line excerpt around the first match, with ellipses on the sides that
 * were cut. Newlines are folded so a result row stays a single line.
 * @param {string} text - Plain text (usually already stripped)
 * @param {string} query - Search query
 * @param {Object} [options] - { radius, caseSensitive }
 * @returns {{text: string, hitStart: number, hitEnd: number}} Snippet and the
 *   match position inside it (-1/-1 when the query was not found)
 */
export function makeSnippet(text, query, options = {}) {
  const source = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const radius = Number.isFinite(options.radius) ? Math.max(0, options.radius) : 40;
  if (!source) return { text: '', hitStart: -1, hitEnd: -1 };

  const matches = findMatches(source, query, { ...options, maxMatches: 1 });
  if (!matches.length) {
    const head = source.slice(0, radius * 2);
    return { text: head.length < source.length ? `${head}…` : head, hitStart: -1, hitEnd: -1 };
  }

  const { start, end } = matches[0];
  const from = Math.max(0, start - radius);
  const to = Math.min(source.length, end + radius);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < source.length ? '…' : '';
  const body = source.slice(from, to);
  return {
    text: `${prefix}${body}${suffix}`,
    hitStart: prefix.length + (start - from),
    hitEnd: prefix.length + (end - from)
  };
}

/**
 * Finds the messages of one conversation that match, in display order.
 * @param {Array<Object>} records - Session records ({ role, content, rtime })
 * @param {string} query - Search query
 * @param {Object} [options] - { caseSensitive, limit, snippetRadius }
 * @returns {Array<Object>} Hits:
 *   { index, rtime, role, count, snippet: { text, hitStart, hitEnd } }
 */
export function searchRecords(records, query, options = {}) {
  if (!Array.isArray(records)) return [];
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 0;
  const hits = [];

  records.forEach((record, index) => {
    const text = stripForSearch(recordText(record));
    if (!text) return;
    const matches = findMatches(text, query, options);
    if (!matches.length) return;
    hits.push({
      index,
      rtime: Number.isFinite(record?.rtime) ? record.rtime : null,
      role: record?.role === 'user' ? 'user' : 'assistant',
      count: matches.length,
      snippet: makeSnippet(text, query, { ...options, radius: options.snippetRadius })
    });
  });

  return limit ? hits.slice(0, limit) : hits;
}

/**
 * Scans every stored conversation (`chatHistory_<scenarioId>` keys of a
 * `storage.local.get(null)` result) for the query.
 *
 * The store is untrusted input: entries with a missing/odd shape are skipped
 * instead of throwing, so one half-written key can never break the whole search.
 * @param {Object} store - Full `storage.local` snapshot (may be null)
 * @param {string} query - Search query
 * @param {Object} [options] - { scenarioNames, scenarioId, caseSensitive, limit, snippetRadius }
 *   scenarioNames maps a scenario id to its display name; scenarioId limits the
 *   scan to one scenario (null/'' means every scenario).
 * @returns {Array<Object>} Hits:
 *   { scenarioId, scenarioName, sessionId, sessionName, index, rtime, role, count, snippet }
 */
export function searchHistoryStore(store, query, options = {}) {
  if (!store || typeof store !== 'object') return [];
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 0;
  const onlyScenario = options.scenarioId == null || options.scenarioId === ''
    ? null
    : String(options.scenarioId);
  const scenarioNames = options.scenarioNames && typeof options.scenarioNames === 'object'
    ? options.scenarioNames
    : {};

  const hits = [];
  const keys = Object.keys(store)
    .filter(key => key.startsWith('chatHistory_'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const key of keys) {
    const scenarioId = key.slice('chatHistory_'.length);
    if (onlyScenario !== null && scenarioId !== onlyScenario) continue;

    const scenarioData = store[key];
    const sessions = Array.isArray(scenarioData?.history) ? scenarioData.history : [];
    const scenarioName = scenarioNames[scenarioId] ? String(scenarioNames[scenarioId]) : '';

    const ordered = [...sessions].sort((a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0));
    for (const session of ordered) {
      const records = Array.isArray(session?.records) ? session.records : [];
      for (const hit of searchRecords(records, query, options)) {
        hits.push({
          scenarioId,
          scenarioName,
          sessionId: Number.isFinite(session?.id) ? session.id : 0,
          sessionName: session?.name ? String(session.name) : '',
          ...hit
        });
        if (limit && hits.length >= limit) return hits;
      }
    }
  }

  return hits;
}
