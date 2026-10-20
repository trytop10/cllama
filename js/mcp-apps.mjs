/**
 * MCP Apps (SEP-1865) host-side helpers — pure, zero-dependency functions.
 *
 * MCP Apps lets an MCP server ship an interactive UI with a tool: the tool
 * declares `_meta.ui.resourceUri` pointing at a `ui://` resource whose body is
 * an HTML document, and the host renders it in a sandboxed iframe, talking to it
 * over JSON-RPC messages on `postMessage`.
 *
 * This module holds only the *decisions* (what is a valid app message, which
 * links and which tool calls an app may make, what the host admits to
 * supporting). The DOM/iframe plumbing lives in `chat/chat.js`. Nothing here
 * touches a browser API, so it is directly testable in Node
 * (`tools/mcp-apps.test.mjs`).
 *
 * P0 scope: render + `ui/initialize` handshake + tool input/result delivery +
 * proxied `tools/call` (through the normal governance pipeline) + open-link +
 * size. Resource prefetch/caching, host styles, display modes and
 * `update-model-context` are deliberately NOT implemented and are therefore
 * reported as unsupported in `hostCapabilities()` — an app feature-detects on
 * that, so an honest "no" is the only correct answer (capability gating).
 */

/** JSON-RPC methods of the subset this host implements. */
export const MCP_APP_METHODS = Object.freeze({
  INITIALIZE: 'ui/initialize',
  INITIALIZED: 'ui/notifications/initialized',
  TOOL_INPUT: 'ui/notifications/tool-input',
  TOOL_RESULT: 'ui/notifications/tool-result',
  SIZE_CHANGED: 'ui/notifications/size-changed',
  OPEN_LINK: 'ui/open-link',
  MESSAGE: 'ui/message',
  /** Shared with core MCP: the app asking the host to run a server tool. */
  TOOLS_CALL: 'tools/call'
});

/**
 * MIME type a `ui://` resource must declare to be rendered.
 * NOTE: verify the exact string against the MCP Apps specification
 * (`specification/<date>/apps.mdx`) before relying on it beyond a prefix check.
 * We only enforce the `text/html` prefix so a stricter/looser profile suffix
 * never turns a renderable app into a silent no-op.
 */
export const MCP_APP_HTML_MIME_PREFIX = 'text/html';

/** postMessage types used between the chat page and the sandbox shell. */
export const MCP_APP_READY_TYPE = 'cllama:mcp-app:ready';
export const MCP_APP_RENDER_TYPE = 'cllama:mcp-app:render';
/**
 * Sent by the shell once the view's document is written, carrying the facts the
 * host can only learn from inside the frame (currently: which `<script src>`
 * point outside the extension and are therefore blocked by the sandbox CSP).
 */
export const MCP_APP_RENDERED_TYPE = 'cllama:mcp-app:rendered';
/**
 * An uncaught error thrown by the view itself. The host cannot see into an
 * opaque-origin frame, so without this a view that dies on its own dependency
 * (`t.lazy is not a function` at load, say) is indistinguishable from one whose
 * script never started.
 */
export const MCP_APP_VIEW_ERROR_TYPE = 'cllama:mcp-app:view-error';
/**
 * Host → shell: "give me the current HTML of the view".
 *
 * Only the shell can answer: the frame has an opaque origin, so the chat page
 * cannot read its `contentDocument` at all. Chrome's DevTools can show a
 * sandboxed frame's DOM, Firefox's cannot — this is the portable substitute,
 * and it is the LIVE DOM (after the view's own scripts ran), not the source.
 */
export const MCP_APP_GET_HTML_TYPE = 'cllama:mcp-app:get-html';
/** Shell → host: the answer to the above. */
export const MCP_APP_HTML_TYPE = 'cllama:mcp-app:html';
/**
 * One network request the view made (only while debugging is on).
 *
 * Firefox's network panel does not show requests made from a sandboxed frame,
 * and neither browser shows them for an opaque-origin document in a useful way —
 * so the shell instruments `fetch` / `XMLHttpRequest` and reports METADATA only
 * (method, URL, status, duration): never request or response bodies.
 */
export const MCP_APP_NETWORK_TYPE = 'cllama:mcp-app:network';
/**
 * A `console.*` call made by the view (only while debugging is on — see
 * DB_KEY.mcpAppDebug). The frame's own console is unreadable from the chat page,
 * and context-switching DevTools to a sandboxed frame is exactly the friction
 * this removes.
 */
export const MCP_APP_CONSOLE_TYPE = 'cllama:mcp-app:console';
export const MCP_APP_ERROR_TYPE = 'cllama:mcp-app:error';

/** How long the shell may take to say "I'm alive" before we give up on it. */
export const MCP_APP_READY_TIMEOUT_MS = 3000;

/**
 * How long the injected document may take to call `ui/initialize`. A view whose
 * script never runs (blocked by a CSP that does not allow inline scripts) is
 * otherwise indistinguishable from a slow one — and a silently dead card is the
 * worst possible outcome, so this watchdog turns it into a visible message.
 */
export const MCP_APP_INIT_TIMEOUT_MS = 4000;

/**
 * The sandboxed extension page that renders app views (Chrome's `sandbox.pages`,
 * see manifest.json). Also the single source of truth for its URL.
 */
export const MCP_APP_SANDBOX_PAGE = 'viewer/mcp-app.html';

/** Upper bound for one UI resource / one message handed to an app. */
export const MCP_APP_HTML_MAX = 2 * 1024 * 1024;
export const MCP_APP_PAYLOAD_MAX = 256 * 1024;

/** URL schemes an app may open in a tab. Everything else is refused. */
export const MCP_APP_LINK_PROTOCOLS = Object.freeze(['http:', 'https:', 'mailto:']);

/**
 * Registry-safe tool name for an MCP server tool.
 *
 * MUST stay identical to `mcpToolId()` in `js/mcp.mjs` — an app is only allowed
 * to call tools of the server that declared its UI, and that check is done by
 * name prefix (see `isAppToolAllowed`). The two functions are duplicated on
 * purpose so this module stays importable in Node without storage/browser code;
 * `tools/mcp-apps.test.mjs` guards the shared shape.
 * @param {string} serverName - User-assigned server name
 * @param {string} toolName - Remote tool name
 * @returns {string} e.g. "mcp_My_Server_get_time"
 */
export function mcpToolId(serverName, toolName) {
  const slug = (s) => String(s || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp_${slug(serverName)}_${slug(toolName)}`;
}

/**
 * Name prefix every tool of one MCP server shares.
 * @param {string} serverName - User-assigned server name
 * @returns {string} e.g. "mcp_My_Server_"
 */
export function mcpToolPrefix(serverName) {
  const slug = (s) => String(s || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp_${slug(serverName)}_`;
}

/**
 * Extract the UI metadata of a tool from a `tools/list` entry.
 *
 * Both spellings seen in the wild are accepted: the nested
 * `_meta.ui.resourceUri` and the older flattened `_meta["ui/resourceUri"]`.
 * Anything that is not a `ui://` URI is ignored — an arbitrary URL must never
 * be treated as a renderable app.
 * @param {Object} tool - Raw tool object from `tools/list`
 * @returns {{resourceUri: string, csp: Object|null, prefersBorder: boolean}|null}
 */
export function extractUiMeta(tool) {
  const meta = tool && typeof tool._meta === 'object' && tool._meta ? tool._meta : null;
  if (!meta) return null;
  const ui = typeof meta.ui === 'object' && meta.ui ? meta.ui : null;
  const raw = (ui && ui.resourceUri) || meta['ui/resourceUri'];
  const resourceUri = typeof raw === 'string' ? raw.trim() : '';
  if (!resourceUri || !resourceUri.startsWith('ui://')) return null;
  return {
    resourceUri,
    csp: ui && typeof ui.csp === 'object' && ui.csp ? ui.csp : null,
    prefersBorder: ui?.prefersBorder === true
  };
}

/**
 * What this host actually implements, as reported to the app in the
 * `ui/initialize` result. Apps feature-detect on these flags, so a capability
 * must be `false`/absent until it truly works — claiming one we do not honour is
 * what makes an app fail confusingly instead of degrading.
 * @returns {Object} Host capability flags
 */
/**
 * The MCP Apps protocol version this host speaks.
 *
 * Must be one the app's SDK accepts: `@modelcontextprotocol/ext-apps` 2.x ships
 * `SUPPORTED_PROTOCOL_VERSIONS = ["2026-01-26"]` and its own host-side
 * AppBridge answers an initialize request with the client's version when that
 * version is supported, or with this newest one otherwise — so this constant is
 * also the correct fallback. An unsupported string is not fatal (the app only
 * schema-validates it as a string), but a MISSING one is.
 */
export const MCP_APP_PROTOCOL_VERSION = '2026-01-26';

/**
 * The host capabilities we advertise in the `ui/initialize` result.
 *
 * The shape is not free-form: the spec's `McpUiHostCapabilities` is a **closed**
 * object (`additionalProperties: false`) whose every entry is an object, and the
 * official SDK validates the whole initialize result before resolving
 * `App.connect()`. Inventing a key (or answering `openLink: true` instead of
 * `openLinks: {}`) makes the validation fail, and the app is then permanently
 * "Not connected" — every `callServerTool()` throws, while the UI still renders
 * (exactly the failure this function was rewritten to fix).
 *
 * So: spell things the way the spec does, and **omit** what is not implemented —
 * there is no `false` form to declare.
 */
export function hostCapabilities() {
  return {
    // tools/call — the app asks us to run one of its server's tools, and it
    // goes through the normal Skill whitelist + side-effect confirmation +
    // audit pipeline (see handleAppToolCall).
    serverTools: {},
    // ui/open-link — http/https/mailto only (see isAllowedAppLink).
    openLinks: {},
    // ui/message — accepted, but text only, and it only PRE-FILLS the input
    // box: an app never quietly spends a model call.
    message: { text: {} }
  };
}

/**
 * Whether this build can host an app view at all.
 *
 * The opaque origin and the inline-script-capable CSP come from
 * `manifest.sandbox`, which Chrome and Firefox/Firefox Android 154+ support.
 * Builds that do not register it (Firefox ≤153, Firefox Android <154) load the
 * shell page as an ordinary extension page whose `script-src 'self'` blocks the
 * view's own script. Reading the *live* manifest lets those builds degrade up
 * front with an explanation, instead of rendering a card that silently does
 * nothing.
 * @param {Object} manifest - `browser.runtime.getManifest()`
 * @returns {boolean}
 */
export function hostSupportsSandboxPages(manifest) {
  const pages = manifest?.sandbox?.pages;
  return Array.isArray(pages) && pages.some((p) => typeof p === 'string' && p.includes(MCP_APP_SANDBOX_PAGE));
}

/**
 * Parse a message an app posted to the host. Anything malformed is refused (and
 * reported) rather than half-handled: an unknown/misshapen frame must never
 * reach the dispatch switch.
 * @param {*} data - The `MessageEvent.data` received
 * @param {Object} [opts] - { maxBytes }
 * @returns {{ok: true, msg: {id: (string|number|null), method: string, params: Object}}|{ok: false, reason: string}}
 */
export function parseAppMessage(data, opts = {}) {
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MCP_APP_PAYLOAD_MAX;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const method = typeof data.method === 'string' ? data.method.trim() : '';
  if (!method) return { ok: false, reason: 'missing-method' };
  const params = data.params === undefined || data.params === null
    ? {}
    : (typeof data.params === 'object' && !Array.isArray(data.params) ? data.params : null);
  if (params === null) return { ok: false, reason: 'bad-params' };
  let id = null;
  if (data.id !== undefined && data.id !== null) {
    if (typeof data.id !== 'string' && typeof data.id !== 'number') return { ok: false, reason: 'bad-id' };
    id = data.id;
  }
  let size = 0;
  try {
    size = JSON.stringify(data).length;
  } catch (e) {
    return { ok: false, reason: 'not-serializable' };
  }
  if (size > maxBytes) return { ok: false, reason: 'too-large' };
  return { ok: true, msg: { id, method, params } };
}

/**
 * Build the `ui/initialize` result handed back to an app.
 * @param {Object} info - { toolName, toolInput, toolOutput, serverName }
 * @returns {Object} Result payload
 */
export function buildInitResult(info = {}) {
  return {
    // The spec's `McpUiInitializeResult` REQUIRES all four of these, and the
    // official SDK enforces it: a missing `protocolVersion` / `hostContext`
    // makes the initialize response fail schema validation, `App.connect()`
    // rejects, and every later `callServerTool()` throws "Not connected" while
    // the view keeps rendering happily.
    protocolVersion: MCP_APP_PROTOCOL_VERSION,
    hostInfo: { name: 'cllama', version: String(info.hostVersion || '1.0') },
    hostCapabilities: hostCapabilities(),
    // Every field inside is optional; `{}` is a valid answer.
    hostContext: (info.hostContext && typeof info.hostContext === 'object' && !Array.isArray(info.hostContext))
      ? info.hostContext
      : {},
    // Passthrough extras (the result schema allows them): the call that produced
    // this view, so an app renders immediately even if it never subscribes to
    // the tool-input / tool-result notifications.
    toolName: info.toolName || null,
    serverName: info.serverName || null,
    toolInput: info.toolInput ?? null,
    toolOutput: info.toolOutput ?? null
  };
}

/**
 * Whether an app-provided URL may be opened. Only plain web/mail schemes; the
 * usual escape hatches (`javascript:`, `data:`, `file:`, `blob:`) are refused.
 * @param {string} url - Candidate URL
 * @returns {boolean}
 */
export function isAllowedAppLink(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch (e) {
    return false;
  }
  return MCP_APP_LINK_PROTOCOLS.includes(parsed.protocol);
}

/**
 * Whether an app may call a given tool: only the tools of the MCP server that
 * declared its UI. This keeps an app away from built-in tools (notably the
 * storage-writing `save_*` tools) even when a Skill whitelist would allow them.
 *
 * Strictly case-sensitive on purpose: two servers may legitimately be named
 * `Charts` and `charts`, and a loose match would let one app reach the other.
 * @param {string} toolName - Tool the app asked for
 * @param {string} serverName - Server that declared the app's UI
 * @returns {boolean}
 */
export function isAppToolAllowed(toolName, serverName) {
  if (typeof toolName !== 'string' || !toolName) return false;
  if (typeof serverName !== 'string' || !serverName.trim()) return false;
  const prefix = mcpToolPrefix(serverName);
  return toolName.startsWith(prefix) && toolName.length > prefix.length;
}

/**
 * Map a tool name an app asked for onto the registered tool name.
 *
 * Apps speak their own server's vocabulary (`add_point`), while the registry
 * names remote tools `mcp_<server>_<tool>` (see js/mcp.mjs). Accepting only the
 * prefixed form is what once made every app-initiated call fail with "not
 * available to this app" — and, because the refusal never reached the UI, it
 * looked like the button simply did nothing.
 * @param {string} rawName - Name as sent by the app
 * @param {string} serverName - Server that declared the app's UI
 * @returns {string|null} Registered tool name, or null when out of scope
 */
export function resolveAppToolName(rawName, serverName) {
  const raw = typeof rawName === 'string' ? rawName.trim() : '';
  if (!raw || typeof serverName !== 'string' || !serverName.trim()) return null;
  // Already the prefixed name (an app may use it) — scope check still applies.
  if (isAppToolAllowed(raw, serverName)) return raw;
  const scoped = mcpToolId(serverName, raw);
  return isAppToolAllowed(scoped, serverName) ? scoped : null;
}

/**
 * Truncate a payload handed to an app (tool input/output). Apps render what they
 * receive, so a runaway page dump must not be posted at full size.
 * @param {*} text - Value to clamp
 * @param {number} [max] - Max characters
 * @returns {string}
 */
export function clampPayload(text, max = MCP_APP_PAYLOAD_MAX) {
  let s;
  if (typeof text === 'string') s = text;
  else if (text === undefined || text === null) s = '';
  else {
    try { s = JSON.stringify(text); } catch (e) { s = String(text); }
  }
  if (typeof s !== 'string') return '';
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

// ------------------- diagnostics: trace + report (see AGENTS.md §7.13) -------------------
// "The app doesn't work" is nearly always a question about the *conversation*
// between host and view — which the browser cannot show, because every message
// is a postMessage. These helpers turn that conversation into something a card
// can display and a user can paste into a bug report. Pure: no browser APIs, so
// the whole thing is unit-testable in Node.

/** Max trace entries kept per view. */
export const MCP_APP_TRACE_LIMIT = 50;
/** Max characters kept of one trace entry / one console line. */
export const MCP_APP_TRACE_TEXT_MAX = 300;

/**
 * Per-view ring buffer of what happened, newest last.
 *
 * Kept for every view (it is cheap and bounded) even when debugging is off: it
 * is what makes a failure explain itself, and it is the only record of the
 * handshake that survives a reload of the card.
 * @param {number} [limit] - Max entries (defaults to MCP_APP_TRACE_LIMIT)
 * @returns {{push: Function, list: Function, clear: Function, size: Function}}
 */
export function createAppTrace(limit = MCP_APP_TRACE_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MCP_APP_TRACE_LIMIT;
  let entries = [];
  return {
    /**
     * @param {Object} entry - { dir: 'host'|'view', kind, method?, ok?, text?, at? }
     * @returns {Object} The stored entry
     */
    push(entry) {
      const item = {
        at: Number(entry?.at) || Date.now(),
        dir: entry?.dir === 'view' ? 'view' : 'host',
        kind: String(entry?.kind || 'event'),
        method: entry?.method ? String(entry.method) : '',
        ok: entry?.ok !== false,
        text: clampPayload(entry?.text ?? '', MCP_APP_TRACE_TEXT_MAX)
      };
      entries.push(item);
      if (entries.length > max) entries = entries.slice(-max);
      return item;
    },
    list() {
      return entries.slice();
    },
    clear() {
      entries = [];
    },
    size() {
      return entries.length;
    }
  };
}

/**
 * One trace line, stable and greppable: `HH:MM:SS.mmm  →  ui/initialize  ok  detail`.
 * @param {Object} entry - An entry from createAppTrace
 * @returns {string}
 */
export function formatTraceEntry(entry) {
  const at = new Date(Number(entry?.at) || 0);
  const time = at.toISOString().slice(11, 23);
  const arrow = entry?.dir === 'view' ? '←' : '→';
  const method = String(entry?.method || entry?.kind || '');
  const status = entry?.ok === false ? 'FAIL' : 'ok';
  const text = String(entry?.text || '');
  return `${time}  ${arrow}  ${method}  ${status}${text ? `  ${text}` : ''}`;
}

/**
 * The full diagnostic report for one view: the facts first, then the timeline.
 * This is what the card's "copy diagnostics" button puts on the clipboard — a
 * bug report that does not require the reporter to know what to look for.
 * @param {Object} info - View facts
 * @param {Array<Object>} [entries] - Trace entries
 * @returns {string}
 */
export function buildAppDiagnostics(info = {}, entries = []) {
  const lines = [
    'cllama — MCP App diagnostics',
    `tool: ${info.tool || '?'}`,
    `server: ${info.serverName || '?'}`,
    `resource: ${info.resourceUri || '?'}`,
    `protocolVersion: ${info.protocolVersion || MCP_APP_PROTOCOL_VERSION}`,
    `sandbox: ${info.sandboxSupported ? 'yes' : 'NO (no manifest sandbox support)'}`,
    `host capabilities: ${JSON.stringify(info.hostCapabilities || {})}`,
    `remote scripts: ${(info.remoteScripts || []).join(', ') || 'none'}`,
    `view error: ${info.viewError?.message ? `${info.viewError.message} (${info.viewError.source || '?'}:${info.viewError.line || 0})` : 'none'}`,
    `initialized: ${info.initialized ? 'yes' : 'no'}`,
    `user agent: ${info.userAgent || '?'}`,
    '',
    `--- trace (${entries.length}) ---`
  ];
  if (!entries.length) lines.push('(empty)');
  for (const entry of entries) lines.push(formatTraceEntry(entry));
  return lines.join('\n');
}

/**
 * What to copy for "copy view HTML": the live DOM the frame reported, or — when
 * the frame did not answer — the source we injected (better than nothing, and for
 * a view that never started the source *is* the whole story).
 * @param {string} liveHtml - HTML the shell reported for the current document
 * @param {string} sourceHtml - The UI resource the host injected
 * @param {number} [max] - Cap (defaults to MCP_APP_HTML_MAX)
 * @returns {{ text: string, live: boolean }}
 */
export function pickViewHtml(liveHtml, sourceHtml, max = MCP_APP_HTML_MAX) {
  const live = typeof liveHtml === 'string' ? liveHtml.trim() : '';
  if (live) return { text: clampPayload(live, max), live: true };
  return { text: clampPayload(typeof sourceHtml === 'string' ? sourceHtml : '', max), live: false };
}

// ------------------- stored view references (see AGENTS.md §7.13) -------------------
// A view dies with the conversation it was rendered in (frames are torn down).
// To bring it back after a reload we keep a *reference* on the assistant record:
// which tool produced it, of which server, at which `ui://` URI, plus a clamped
// copy of the arguments and of the tool result. Two rules behind this shape:
//   - never store the HTML (it is re-fetched, so a fixed server is picked up);
//   - never re-run the tool to rebuild a view (that would repeat side effects).

/** Max view references remembered per message. */
export const MCP_APP_REFS_MAX = 4;
/** Stored copy of the tool result handed to a view. */
export const MCP_APP_STORED_OUTPUT_MAX = 32 * 1024;
/** Stored copy of the tool arguments (`toolInput` for a restored view). */
export const MCP_APP_STORED_ARGS_MAX = 4 * 1024;

/**
 * Build the storable reference for one rendered view.
 * @param {Object} info - { tool, args, output, ui, serverName }
 * @returns {Object|null} Reference, or null when there is nothing to render
 */
export function makeAppRef(info = {}) {
  const resourceUri = typeof info.ui?.resourceUri === 'string' ? info.ui.resourceUri : '';
  const tool = String(info.tool || '').trim();
  if (!tool || !resourceUri.startsWith('ui://')) return null;

  let args = null;
  let truncated = false;
  try {
    const json = JSON.stringify(info.args ?? null);
    if (json && json.length <= MCP_APP_STORED_ARGS_MAX) args = JSON.parse(json);
    else truncated = true;
  } catch (e) {
    truncated = true;
  }
  const raw = typeof info.output === 'string' ? info.output : String(info.output ?? '');
  if (raw.length > MCP_APP_STORED_OUTPUT_MAX) truncated = true;

  return {
    tool,
    serverName: info.serverName || null,
    resourceUri,
    args,
    output: clampPayload(raw, MCP_APP_STORED_OUTPUT_MAX),
    truncated
  };
}

/**
 * Validate one stored reference. Anything unexpected is dropped rather than
 * half-rendered (history can contain records written by older versions).
 * @param {*} ref - Candidate reference
 * @returns {Object|null}
 */
export function normalizeAppRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const resourceUri = typeof ref.resourceUri === 'string' ? ref.resourceUri.trim() : '';
  if (!resourceUri.startsWith('ui://')) return null;
  const tool = String(ref.tool || '').trim();
  if (!tool) return null;
  const args = ref.args && typeof ref.args === 'object' && !Array.isArray(ref.args) ? ref.args : null;
  return {
    tool,
    serverName: typeof ref.serverName === 'string' && ref.serverName ? ref.serverName : null,
    resourceUri,
    args,
    output: typeof ref.output === 'string' ? ref.output : '',
    truncated: ref.truncated === true
  };
}

/**
 * Validate a stored list of references (caps the count, drops the invalid ones).
 * @param {*} raw - Value read from a history record
 * @returns {Array<Object>}
 */
export function normalizeAppRefs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAppRef).filter(Boolean).slice(0, MCP_APP_REFS_MAX);
}
