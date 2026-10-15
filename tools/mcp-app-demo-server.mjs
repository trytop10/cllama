#!/usr/bin/env node
/**
 * tools/mcp-app-demo-server.mjs — a minimal MCP server for testing cllama's
 * MCP Apps (SEP-1865) host end to end. NOT shipped: `tools/` is excluded from
 * every build, and this file has no dependencies beyond Node 18+.
 *
 * It speaks just enough of the MCP Streamable HTTP transport for js/mcp.mjs
 * (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
 * `resources/read`, `resources/list`) and exposes two tools:
 *
 *   render_dashboard  declares `_meta.ui.resourceUri = "ui://demo/dashboard"`,
 *                     so the chat page renders tools/mcp-app-demo-ui.html in a
 *                     sandboxed iframe.
 *   add_point         a plain tool of the same server, so the app can test an
 *                     app-initiated `tools/call` (which must still go through
 *                     the Skill whitelist + confirmation card + audit trail).
 *
 * Usage:
 *   node tools/mcp-app-demo-server.mjs                 # listen on 127.0.0.1:3210
 *   node tools/mcp-app-demo-server.mjs --port=3211
 *   node tools/mcp-app-demo-server.mjs --strict-session
 *   node tools/mcp-app-demo-server.mjs --self-test     # protocol smoke test, then exit
 *
 * See AGENTS.md §7.13 for the host side and the manual test script.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PORT = Number(value('port', 3210));
const HOST = value('host', '127.0.0.1');
/** When set, an unknown `mcp-session-id` is rejected with -32000 (this is what
 *  makes cllama re-handshake — see js/mcp.mjs isSessionError). */
const STRICT_SESSION = flag('strict-session');
const SELF_TEST = flag('self-test');

/** The UI resource the dashboard tool points at. */
const UI_URI = 'ui://demo/dashboard';
/** MIME the host accepts (js/mcp-apps.mjs only enforces the text/html prefix). */
const UI_MIME = 'text/html;profile=mcp-app';

/** The HTML document served by `resources/read`. Read once at startup. */
const UI_HTML = readFileSync(fileURLToPath(new URL('./mcp-app-demo-ui.html', import.meta.url)), 'utf8');

/** Points the demo dashboard works on (module-level: one shared demo state). */
const points = [12, 18, 7];
/** Sessions issued by `initialize` (see STRICT_SESSION). */
const sessions = new Set();

const TOOLS = [
  {
    name: 'render_dashboard',
    description: 'Renders the interactive points dashboard. Use this whenever the user wants to see or edit the sample data.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Heading shown in the dashboard' }
      }
    },
    // This is what makes it an MCP App: a ui:// resource holding the HTML view.
    _meta: { ui: { resourceUri: UI_URI, prefersBorder: true } }
  },
  {
    name: 'add_point',
    description: 'Appends one numeric point to the dashboard data and returns the new total.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'number', description: 'Point to append' } },
      required: ['value']
    }
  }
];

/** Dashboard text result: what the model reads, and the app's `toolOutput`. */
function dashboardText(title) {
  const total = points.reduce((sum, n) => sum + n, 0);
  return `${title || 'Dashboard'}: ${points.length} point(s) [${points.join(', ')}]; total ${total}. `
    + 'An interactive MCP App view was rendered next to this answer.';
}

/** JSON response helper (also sets permissive CORS: handy for other clients). */
function sendJson(res, payload, status = 200, headers = {}) {
  const body = payload === null ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version, accept',
    'Access-Control-Expose-Headers': 'mcp-session-id',
    ...headers
  });
  res.end(body);
}

/** JSON-RPC result / error envelopes. */
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
const textContent = (text) => ({ content: [{ type: 'text', text }] });

/**
 * Handle one JSON-RPC message.
 * @param {Object} msg - Parsed request/notification
 * @returns {{reply: Object|null, status: number, sessionId: string|null, log: string}}
 */
function handleMessage(msg) {
  const { id = null, method, params = {} } = msg;
  const isNotification = id === null || id === undefined;

  switch (method) {
    case 'initialize': {
      const sessionId = randomUUID();
      sessions.add(sessionId);
      return {
        reply: ok(id, {
          // Echo the version the client offered (cllama offers its newest first
          // and only retries when we reject it, so anything works here).
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: 'cllama-mcp-app-demo', version: '1.0.0' }
        }),
        status: 200,
        sessionId,
        log: `initialize → protocolVersion=${params.protocolVersion}, session=${sessionId.slice(0, 8)}`
      };
    }

    case 'notifications/initialized':
      return { reply: null, status: 202, sessionId: null, log: 'notifications/initialized' };

    case 'tools/list':
      return { reply: ok(id, { tools: TOOLS }), status: 200, sessionId: null, log: `tools/list → ${TOOLS.length} tools` };

    case 'tools/call': {
      const name = params.name;
      const callArgs = params.arguments || {};
      if (name === 'render_dashboard') {
        return { reply: ok(id, textContent(dashboardText(callArgs.title))), status: 200, sessionId: null, log: 'tools/call render_dashboard (UI tool)' };
      }
      if (name === 'add_point') {
        const v = Number(callArgs.value);
        if (!Number.isFinite(v)) return { reply: fail(id, -32602, 'add_point requires a numeric "value"'), status: 200, sessionId: null, log: 'tools/call add_point → invalid args' };
        points.push(v);
        const total = points.reduce((sum, n) => sum + n, 0);
        return { reply: ok(id, textContent(`Added ${v}. points=[${points.join(', ')}], total=${total}.`)), status: 200, sessionId: null, log: `tools/call add_point ${v} → total ${total}` };
      }
      return { reply: fail(id, -32602, `Unknown tool: ${name}`), status: 200, sessionId: null, log: `tools/call ${name} → unknown` };
    }

    case 'resources/list':
      return {
        reply: ok(id, { resources: [{ uri: UI_URI, name: 'Demo dashboard view', mimeType: UI_MIME }] }),
        status: 200,
        sessionId: null,
        log: 'resources/list'
      };

    case 'resources/read': {
      if (params.uri !== UI_URI) {
        return { reply: fail(id, -32002, `Resource not found: ${params.uri}`), status: 200, sessionId: null, log: `resources/read ${params.uri} → not found` };
      }
      return {
        reply: ok(id, { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: UI_HTML }] }),
        status: 200,
        sessionId: null,
        log: `resources/read ${UI_URI} → ${UI_MIME}, ${UI_HTML.length} bytes`
      };
    }

    default:
      if (isNotification) return { reply: null, status: 202, sessionId: null, log: `${method} (unknown notification, ignored)` };
      return { reply: fail(id, -32601, `Method not found: ${method}`), status: 200, sessionId: null, log: `${method} → method not found` };
  }
}

/** Read and parse a request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, null, 204);
  // The client never opens the notification stream; say so instead of hanging.
  if (req.method === 'GET') return sendJson(res, { error: 'This demo server does not offer an SSE stream; POST /mcp instead.' }, 405);

  if (req.method !== 'POST') return sendJson(res, { error: 'Use POST /mcp' }, 405);

  let msg;
  try {
    msg = await readBody(req);
  } catch (e) {
    return sendJson(res, fail(null, -32700, `Parse error: ${e.message}`), 200);
  }
  if (!msg || typeof msg !== 'object') return sendJson(res, fail(null, -32600, 'Invalid request'), 200);

  // Session bookkeeping (only meaningful with --strict-session).
  const headerSession = req.headers['mcp-session-id'];
  if (STRICT_SESSION && headerSession && !sessions.has(headerSession)) {
    console.log(`  ! bad session ${String(headerSession).slice(0, 8)} → -32000 (the client should re-initialize)`);
    return sendJson(res, fail(msg.id ?? null, -32000, 'Bad session: missing or expired Mcp-Session-Id'), 200);
  }

  const { reply, status, sessionId, log } = handleMessage(msg);
  console.log(`  ${msg.method}${msg.id ? ` #${msg.id}` : ''} — ${log}`);
  if (!reply) return sendJson(res, null, status, sessionId ? { 'mcp-session-id': sessionId } : {});
  return sendJson(res, reply, status, sessionId ? { 'mcp-session-id': sessionId } : {});
});

/** POST one JSON-RPC message to a running server. */
async function rpc(port, msg, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extraHeaders },
    body: JSON.stringify(msg)
  });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : null };
}

/** Start listening and resolve with the bound port. */
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server.address().port));
  });
}

/**
 * Protocol smoke test: proves the server answers exactly what js/mcp.mjs and
 * the MCP App view need, without a browser. Run via `--self-test`.
 */
async function selfTest() {
  const port = await start(0);
  let failed = 0;
  const check = (name, cond, detail = '') => {
    if (cond) {
      console.log(`ok   - ${name}`);
    } else {
      failed++;
      console.log(`FAIL - ${name} ${detail}`);
    }
  };

  try {
    const init = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'self-test', version: '1' } } });
    check('initialize answers with a protocol version', init.body?.result?.protocolVersion === '2026-07-28', JSON.stringify(init.body));
    const sessionId = init.sessionId;
    check('initialize issues an mcp-session-id', typeof sessionId === 'string' && sessionId.length > 0);

    const headers = { 'mcp-session-id': sessionId, 'MCP-Protocol-Version': '2026-07-28' };
    const note = await rpc(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
    check('notifications/initialized returns an empty 202', note.status === 202 && note.body === null, `status=${note.status}`);

    const list = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers);
    const uiTool = list.body?.result?.tools?.find((t) => t.name === 'render_dashboard');
    check('tools/list returns both tools', list.body?.result?.tools?.length === 2);
    check('the UI tool declares _meta.ui.resourceUri', uiTool?._meta?.ui?.resourceUri === UI_URI, JSON.stringify(uiTool?._meta));
    check('the plain tool has no UI metadata', !list.body?.result?.tools?.find((t) => t.name === 'add_point')?._meta);

    const read = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: UI_URI } }, headers);
    const body = read.body?.result?.contents?.[0];
    check('resources/read returns the HTML view', typeof body?.text === 'string' && body.text.length > 500);
    check('the view declares a text/html MIME', String(body?.mimeType || '').startsWith('text/html'), body?.mimeType);
    check('the view really contains an inline <script>', body?.text.includes('<script>') && body?.text.includes('ui/initialize'));

    const call = await rpc(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'render_dashboard', arguments: { title: 'Self test' } } }, headers);
    check('tools/call render_dashboard returns text', /total \d+/.test(call.body?.result?.content?.[0]?.text || ''), JSON.stringify(call.body));

    const add = await rpc(port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'add_point', arguments: { value: 5 } } }, headers);
    check('tools/call add_point appends the point', /Added 5/.test(add.body?.result?.content?.[0]?.text || ''));
    const badArg = await rpc(port, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'add_point', arguments: {} } }, headers);
    check('a bad argument is an error, not a crash', badArg.body?.error?.code === -32602);

    const missing = await rpc(port, { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'ui://nope' } }, headers);
    check('an unknown resource is -32002', missing.body?.error?.code === -32002);
    const unknown = await rpc(port, { jsonrpc: '2.0', id: 8, method: 'does/not/exist' }, headers);
    check('an unknown method is -32601', unknown.body?.error?.code === -32601);

    if (STRICT_SESSION) {
      const stale = await rpc(port, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, { 'mcp-session-id': 'deadbeef' });
      check('--strict-session rejects an unknown session with -32000', stale.body?.error?.code === -32000);
    }

    const get = await fetch(`http://127.0.0.1:${port}/mcp`);
    check('GET is refused with 405 (no SSE stream)', get.status === 405);
  } finally {
    server.close();
  }

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll self-test checks passed.');
  process.exit(failed ? 1 : 0);
}

if (SELF_TEST) {
  selfTest().catch((e) => {
    console.error('self-test crashed:', e);
    process.exit(1);
  });
} else {
  start().then((port) => {
    console.log(`MCP App demo server listening on http://${HOST}:${port}/mcp`);
    console.log(`  tools: ${TOOLS.map((t) => t.name).join(', ')}`);
    console.log(`  ui resource: ${UI_URI} (${UI_MIME}, ${UI_HTML.length} bytes)`);
    if (STRICT_SESSION) console.log('  strict sessions: unknown mcp-session-id → -32000 (tests the client re-handshake)');
    console.log('\nAdd it in cllama → Skills page → MCP servers, then read AGENTS.md §7.13 for the test script.');
    console.log('Ctrl+C to stop.');
  }).catch((e) => {
    console.error(`Failed to listen on ${HOST}:${PORT}:`, e.message);
    process.exit(1);
  });
}
