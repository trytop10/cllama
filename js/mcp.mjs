/**
 * MCP (Model Context Protocol) client over Streamable HTTP.
 *
 * Registers remote MCP server tools into the local tool registry
 * (`js/skill-tools.mjs`) so they can be selected in Skill tool whitelists and
 * invoked by the model through the existing native-tools / text-protocol
 * tool-calling loops — no other part of the tool pipeline needs to change.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST (MCP "Streamable HTTP"). Stdio-only
 * servers must be exposed via a gateway (e.g. supergateway / mcp-proxy).
 * Servers are configured by the user in the Skill management page and stored
 * in `DB_KEY.mcpServers` as:
 *
 *   [{ id, name, url, headers: {Header: "value"}, enabled: true }]
 *
 * Registered tool names follow `mcp_<serverName>_<toolName>` so they never
 * collide with built-in tools.
 */
import { registerTool, getTool, listTools, setMcpReady } from './skill-tools.mjs';
import { DB_KEY } from './cllama.js';
import { browser } from './browser.mjs';

// Protocol versions this client can speak, newest first. initialize offers the
// newest; per the MCP versioning spec the server replies with the version it
// picked (handshake revisions <= 2025-11-25) or rejects with a
// UnsupportedProtocolVersionError listing what it supports (2026-07-28 scheme).
const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
// Connection/listing (probe) must be snappy so a dead server never stalls UI.
const MCP_PROBE_TIMEOUT_MS = 5000;
// Actual tool calls may legitimately take longer (scraping, LLM-backed tools).
const MCP_CALL_TIMEOUT_MS = 60000;

/** Names already registered by this module (avoids duplicate registerTool). */
const registeredNames = new Set();

/**
 * Load the user's MCP server configuration from storage.
 * @returns {Promise<Array<{id,name,url,headers,enabled}>>}
 */
export function loadMcpServers() {
  return new Promise((resolve) => {
    browser.storage.local.get(DB_KEY.mcpServers, (data) => {
      const stored = data[DB_KEY.mcpServers];
      resolve(Array.isArray(stored) ? stored : []);
    });
  });
}

/**
 * Persist the MCP server configuration.
 * @param {Array} servers - Server list
 * @returns {Promise<void>}
 */
export function saveMcpServers(servers) {
  return new Promise((resolve) => {
    browser.storage.local.set({ [DB_KEY.mcpServers]: servers }, resolve);
  });
}

/**
 * Send a JSON-RPC request (or notification) to an MCP server.
 * Handles both plain-JSON and SSE-framed responses, and propagates the
 * `mcp-session-id` header when the server issues one.
 * @param {Object} server - { url, headers }
 * @param {Object} payload - JSON-RPC message
 * @param {string} [sessionId] - Current MCP session id
 * @returns {Promise<{result:Object|null, sessionId:string|null}>}
 */
/**
 * Send a JSON-RPC request (or notification) to an MCP server.
 * Handles both plain-JSON and SSE-framed responses, propagates the
 * `mcp-session-id` header when the server issues one, and declares the
 * negotiated protocol version via the `MCP-Protocol-Version` header
 * (mandatory for servers on the 2026-07-28 scheme, ignored by older ones).
 * @param {Object} server - { url, headers }
 * @param {Object} payload - JSON-RPC message
 * @param {string} [sessionId] - Current MCP session id
 * @param {number} [timeoutMs] - Request timeout
 * @param {string} [protocolVersion] - Negotiated protocol version to declare
 * @returns {Promise<{result:Object|null, sessionId:string|null, error:Object|null}>}
 */
async function rpc(server, payload, sessionId = null, timeoutMs = MCP_PROBE_TIMEOUT_MS, protocolVersion = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
        ...(server.headers || {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const newSessionId = resp.headers.get('mcp-session-id') || sessionId;
    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    const raw = await resp.text();
    let json = null;
    if (ctype.includes('text/event-stream')) {
      // SSE framing: take the last "data:" line that parses as JSON.
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { json = JSON.parse(line.slice(5).trim()); } catch (e) { /* keep last good */ }
      }
    } else if (raw.trim()) {
      json = JSON.parse(raw);
    }
    return { result: json && !json.error ? json.result : null, sessionId: newSessionId, error: json?.error || null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Initialize a session with an MCP server and return its tool list.
 * Protocol version negotiation: we offer our newest version; the server either
 * picks one in the initialize response (handshake revisions) or rejects with
 * UnsupportedProtocolVersionError listing versions it supports, in which case
 * we retry with the best mutual version.
 * @param {Object} server - { name, url, headers }
 * @returns {Promise<Array<{name, description, inputSchema}>>}
 */
export async function listMcpTools(server) {
  const negotiate = async (version) => {
    const init = await rpc(server, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'cllama', version: '1.0' }
      }
    });
    // Handshake servers pick their version in the response; accept any version
    // string they return (spec says clients should not reject a supported pick).
    if (init.result) return { version: init.result.protocolVersion || version, ...init };
    // 2026-07-28 scheme: server rejected; find a mutual version and retry once.
    const offered = init.error?.data?.supportedVersions || [];
    const mutual = SUPPORTED_PROTOCOL_VERSIONS.find(v => offered.includes(v));
    if (!mutual) throw new Error(init.error?.message || 'initialize failed (no mutual protocol version)');
    const retry = await rpc(server, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: mutual,
        capabilities: {},
        clientInfo: { name: 'cllama', version: '1.0' }
      }
    });
    if (!retry.result) throw new Error(retry.error?.message || 'initialize failed');
    return { version: retry.result.protocolVersion || mutual, ...retry };
  };

  const { version, sessionId } = await negotiate(MCP_PROTOCOL_VERSION);
  // notifications/initialized must be sent before requesting tools.
  await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId, MCP_PROBE_TIMEOUT_MS, version);
  const listed = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId, MCP_PROBE_TIMEOUT_MS, version);
  if (listed.error) throw new Error(listed.error.message || 'tools/list failed');
  return Array.isArray(listed.result?.tools) ? listed.result.tools : [];
}

/**
 * Invoke a tool on an MCP server.
 * @param {Object} server - { url, headers }
 * @param {string} toolName - MCP tool name
 * @param {Object} args - Tool arguments
 * @returns {Promise<string>} Flattened text content of the tool result
 */
export async function callMcpTool(server, toolName, args) {
  const res = await rpc(server, {
    jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
    params: { name: toolName, arguments: args || {} }
  }, null, MCP_CALL_TIMEOUT_MS);
  const content = res.result?.content;
  if (res.result?.isError) {
    const errText = Array.isArray(content)
      ? content.map(c => c.text || JSON.stringify(c)).join('\n') : 'tool error';
    throw new Error(errText);
  }
  if (!Array.isArray(content)) return JSON.stringify(res.result ?? null);
  return content.map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
}

/**
 * Build a registry-safe tool name for an MCP server tool.
 * @param {string} serverName - User-assigned server name
 * @param {string} toolName - Remote tool name
 * @returns {string}
 */
function mcpToolId(serverName, toolName) {
  const slug = s => String(s || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp_${slug(serverName)}_${slug(toolName)}`;
}

/**
 * Register all tools of the enabled MCP servers into the local tool registry.
 * Idempotent: already-registered names are skipped, so calling again after a
 * config change only adds new tools. Servers are probed in parallel with a
 * short timeout so one dead server never blocks startup; errors are swallowed
 * (console.warn). Non-blocking by design — callers may fire-and-forget, and
 * chat() awaits getMcpReady() before using tools.
 * @returns {Promise<number>} Number of MCP tools available after the call
 */
export async function initMcpTools() {
  const done = (async () => {
    const servers = (await loadMcpServers()).filter(s => s.enabled !== false && s.url);
    await Promise.allSettled(servers.map(async (server) => {
      try {
        const tools = await listMcpTools(server);
        for (const t of tools) {
          if (!t?.name) continue;
          const id = mcpToolId(server.name, t.name);
          if (registeredNames.has(id) || getTool(id)) continue;
          registeredNames.add(id);
          registerTool({
            name: id,
            description: `[MCP:${server.name}] ${t.description || t.name}`,
            parameters: t.inputSchema || { type: 'object', properties: {} },
            func: async (args) => callMcpTool(server, t.name, args)
          });
        }
      } catch (e) {
        console.warn(`[MCP] Failed to load tools from "${server.name}": ${e.message}`);
      }
    }));
    return listTools().filter(t => t.name.startsWith('mcp_')).length;
  })();
  setMcpReady(done.catch(() => {}));
  return done;
}

