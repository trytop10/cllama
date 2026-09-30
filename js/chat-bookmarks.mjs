/**
 * Bookmark (收藏) helpers for chat answers.
 *
 * A bookmark is a **snapshot plus a reference**: the answer text is copied, so
 * clearing a session, deleting a message or removing a scenario never destroys
 * what the user saved (the "bookmark survives the page" rule). The reference
 * (`scenarioId` / `sessionId` / `rtime`) is only used to jump back; when the
 * source is gone the row stays readable and simply loses its jump action.
 *
 * Pure functions only: no DOM, no `browser`, so `tools/chat-bookmarks.test.mjs`
 * can import this module in Node. Storage access lives in `js/cllama.js`
 * (`loadBookmarks` / `toggleBookmark` / `deleteBookmark`), the same split as
 * `scenario-learn.mjs` / `chat-search.mjs`.
 *
 * @module chat-bookmarks
 */

/** Cap on the number of bookmarks; adding beyond it is refused, never silently
 * evicted — favourites are user data, like learned notes. */
export const MAX_BOOKMARKS = 300;

/** Cap on the stored text of one bookmark. Longer answers are truncated and
 * flagged, so a single huge code block cannot bloat `storage.local`. */
export const MAX_BOOKMARK_CHARS = 50000;

/**
 * Stable identity of a message: `<scenarioId>:<sessionId>:<rtime>`. Used both as
 * the bookmark id and as the idempotency key when toggling.
 * @param {string|number} scenarioId - Scenario id ("0" for plain Chat)
 * @param {string|number} sessionId - Session id inside that scenario
 * @param {number} rtime - Record timestamp (messageDiv.dataset.timestamp)
 * @returns {string} Id, or '' when the timestamp is not a number
 */
export function bookmarkId(scenarioId, sessionId, rtime) {
  const time = Number(rtime);
  if (!Number.isFinite(time)) return '';
  const scenario = scenarioId === undefined || scenarioId === null || scenarioId === ''
    ? '0'
    : String(scenarioId);
  const session = sessionId === undefined || sessionId === null || sessionId === ''
    ? '0'
    : String(sessionId);
  return `${scenario}:${session}:${time}`;
}

/**
 * Splits a bookmark id back into its parts.
 * @param {string} id - Id produced by bookmarkId()
 * @returns {{scenarioId: string, sessionId: string, rtime: number}|null}
 */
export function parseBookmarkId(id) {
  const parts = String(id ?? '').split(':');
  if (parts.length !== 3) return null;
  const rtime = Number(parts[2]);
  if (!Number.isFinite(rtime)) return null;
  return { scenarioId: parts[0], sessionId: parts[1], rtime };
}

/**
 * Truncates a snapshot to the storage budget.
 * @param {string} text - Raw content
 * @param {number} [max] - Character budget
 * @returns {{content: string, truncated: boolean}} Trimmed text plus the flag
 */
export function trimContent(text, max = MAX_BOOKMARK_CHARS) {
  const source = typeof text === 'string' ? text : '';
  const limit = Number.isFinite(max) && max > 0 ? max : MAX_BOOKMARK_CHARS;
  if (source.length <= limit) return { content: source, truncated: false };
  return { content: source.slice(0, limit), truncated: true };
}

/** Attachment messages keep a data URL as their content; only the file name is
 * worth storing (a base64 image would be megabytes of storage for no value). */
function slimFileInfo(fileInfo) {
  if (!fileInfo || typeof fileInfo !== 'object') return null;
  const name = typeof fileInfo.name === 'string' ? fileInfo.name : '';
  const type = typeof fileInfo.type === 'string' ? fileInfo.type : '';
  if (!name && !type) return null;
  return { name, type };
}

/**
 * Builds the snapshot of one message.
 * @param {Object} record - History record ({ role, content, rtime, model, fileInfo })
 * @param {Object} [context] - { scenarioId, sessionId, scenarioName, sessionName, now }
 * @returns {{ok: boolean, bookmark: Object|null, notes: Array<string>}}
 *   `notes` explains every rejection, so a caller can surface it instead of
 *   silently doing nothing.
 */
export function makeBookmark(record, context = {}) {
  const notes = [];
  const id = bookmarkId(context.scenarioId, context.sessionId, record?.rtime);
  if (!id) return { ok: false, bookmark: null, notes: ['missing rtime'] };

  const raw = typeof record?.content === 'string' ? record.content : '';
  const fileInfo = slimFileInfo(record?.fileInfo);
  const source = /^data:[^,]*,/i.test(raw) ? '' : raw;
  if (!source && !fileInfo) return { ok: false, bookmark: null, notes: ['empty content'] };

  const { content, truncated } = trimContent(source);
  if (truncated) notes.push('content truncated');

  return {
    ok: true,
    notes,
    bookmark: {
      id,
      scenarioId: String(context.scenarioId ?? '0'),
      sessionId: String(context.sessionId ?? '0'),
      rtime: Number(record.rtime),
      role: record?.role === 'user' ? 'user' : 'assistant',
      model: typeof record?.model === 'string' ? record.model : '',
      content,
      truncated,
      fileInfo,
      scenarioName: typeof context.scenarioName === 'string' ? context.scenarioName : '',
      sessionName: typeof context.sessionName === 'string' ? context.sessionName : '',
      createdAt: Number.isFinite(context.now) ? context.now : Date.now()
    }
  };
}

/**
 * Validates one stored bookmark (the store is restored from a backup file, so it
 * is untrusted input).
 * @param {Object} raw - Stored entry
 * @returns {{ok: boolean, bookmark: Object|null, notes: Array<string>}}
 */
export function normalizeBookmark(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, bookmark: null, notes: ['not an object'] };
  }
  const parsed = parseBookmarkId(raw.id);
  if (!parsed) return { ok: false, bookmark: null, notes: ['bad id'] };

  const content = typeof raw.content === 'string' ? raw.content : '';
  const fileInfo = slimFileInfo(raw.fileInfo);
  if (!content && !fileInfo) return { ok: false, bookmark: null, notes: ['empty content'] };

  const createdAt = Number(raw.createdAt);
  const rtime = Number(raw.rtime);
  return {
    ok: true,
    notes: raw.truncated ? ['content truncated'] : [],
    bookmark: {
      id: String(raw.id),
      scenarioId: String(raw.scenarioId ?? parsed.scenarioId),
      sessionId: String(raw.sessionId ?? parsed.sessionId),
      rtime: Number.isFinite(rtime) ? rtime : parsed.rtime,
      role: raw.role === 'user' ? 'user' : 'assistant',
      model: typeof raw.model === 'string' ? raw.model : '',
      content,
      truncated: Boolean(raw.truncated),
      fileInfo,
      scenarioName: typeof raw.scenarioName === 'string' ? raw.scenarioName : '',
      sessionName: typeof raw.sessionName === 'string' ? raw.sessionName : '',
      createdAt: Number.isFinite(createdAt) ? createdAt : 0
    }
  };
}

/**
 * Normalizes a whole stored list, dropping the entries that cannot be read and
 * the duplicates (the same message must never appear twice).
 * @param {Array<Object>} raw - Stored value (any shape)
 * @returns {Array<Object>} Valid bookmarks, stored order preserved
 */
export function normalizeBookmarks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const { ok, bookmark } = normalizeBookmark(item);
    if (!ok || seen.has(bookmark.id)) continue;
    seen.add(bookmark.id);
    out.push(bookmark);
  }
  return out;
}

/**
 * Whether a message is already bookmarked.
 * @param {Array<Object>} list - Bookmark list
 * @param {string} id - Bookmark id
 * @returns {boolean}
 */
export function isBookmarked(list, id) {
  if (!Array.isArray(list) || !id) return false;
  return list.some(item => item?.id === id);
}

/**
 * Adds a bookmark, idempotently.
 * @param {Array<Object>} list - Current list (not modified)
 * @param {Object} bookmark - Snapshot from makeBookmark()
 * @param {Object} [options] - { max }
 * @returns {{list: Array<Object>, action: 'created'|'exists'|'atCapacity'}}
 */
export function addBookmark(list, bookmark, options = {}) {
  const current = Array.isArray(list) ? list : [];
  if (!bookmark?.id) return { list: current, action: 'atCapacity' };
  if (isBookmarked(current, bookmark.id)) return { list: current, action: 'exists' };

  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : MAX_BOOKMARKS;
  // Refuse instead of evicting: dropping a saved answer silently is worse than
  // telling the user the collection is full.
  if (current.length >= max) return { list: current, action: 'atCapacity' };

  return { list: [...current, bookmark], action: 'created' };
}

/**
 * Removes a bookmark.
 * @param {Array<Object>} list - Current list (not modified)
 * @param {string} id - Bookmark id
 * @returns {{list: Array<Object>, removed: boolean}}
 */
export function removeBookmark(list, id) {
  const current = Array.isArray(list) ? list : [];
  if (!isBookmarked(current, id)) return { list: current, removed: false };
  return { list: current.filter(item => item?.id !== id), removed: true };
}

/**
 * Display order: newest first, with the id as a tie-breaker so the result is
 * deterministic for equal timestamps.
 * @param {Array<Object>} list - Bookmark list
 * @returns {Array<Object>} New sorted array (input untouched)
 */
export function sortBookmarks(list) {
  const current = Array.isArray(list) ? [...list] : [];
  return current.sort((a, b) => {
    const diff = (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0);
    if (diff !== 0) return diff;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  });
}

/**
 * Groups a list for the panel: scenario → session → items, keeping the order in
 * which each group first appears (so the newest bookmark stays on top).
 * @param {Array<Object>} list - Bookmark list (typically already sorted)
 * @returns {Array<Object>} [{ scenarioId, scenarioName, sessions: [{ sessionId, sessionName, items }] }]
 */
export function groupBookmarks(list) {
  const scenarios = [];
  const byScenario = new Map();
  const bySession = new Map();

  (Array.isArray(list) ? list : []).forEach(item => {
    if (!item?.id) return;
    const scenarioKey = String(item.scenarioId ?? '0');
    let scenario = byScenario.get(scenarioKey);
    if (!scenario) {
      scenario = { scenarioId: scenarioKey, scenarioName: item.scenarioName || '', sessions: [] };
      byScenario.set(scenarioKey, scenario);
      scenarios.push(scenario);
    } else if (!scenario.scenarioName && item.scenarioName) {
      scenario.scenarioName = item.scenarioName;
    }

    const sessionKey = `${scenarioKey}:${String(item.sessionId ?? '0')}`;
    let session = bySession.get(sessionKey);
    if (!session) {
      session = { sessionId: String(item.sessionId ?? '0'), sessionName: item.sessionName || '', items: [] };
      bySession.set(sessionKey, session);
      scenario.sessions.push(session);
    } else if (!session.sessionName && item.sessionName) {
      session.sessionName = item.sessionName;
    }

    session.items.push(item);
  });

  return scenarios;
}

/**
 * The text a bookmark shows in a list/摘要: its snapshot, or the attachment file
 * name when there is no text (an image answer has nothing to read).
 * @param {Object} bookmark - Bookmark entry
 * @returns {string}
 */
export function bookmarkText(bookmark) {
  const content = typeof bookmark?.content === 'string' ? bookmark.content : '';
  if (content) return content;
  return bookmark?.fileInfo?.name ? String(bookmark.fileInfo.name) : '';
}

