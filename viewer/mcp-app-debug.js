// viewer/mcp-app-debug.js — the standalone MCP App debugger (see AGENTS.md §7.13).
//
// This page is a *host harness*: it speaks exactly the same protocol as the chat
// page (same constants, same helpers from js/mcp-apps.mjs, same sandbox shell)
// but with no conversation, no MCP server and no model in the way. It exists
// because the questions that actually cost time here — "did the handshake
// happen?", "what did we answer?", "what did the view send?" — cannot be asked
// of DevTools: every message travels as a postMessage.
//
// It deliberately does NOT re-implement the protocol: message types, payload
// shapes, link policy and the diagnostics report all come from
// js/mcp-apps.mjs, so a test can assert that this page stays in step with it.

import { i18n } from '../js/cllama.js';
import { browser } from '../js/browser.mjs';
import {
  MCP_APP_CONSOLE_TYPE, MCP_APP_ERROR_TYPE, MCP_APP_GET_HTML_TYPE, MCP_APP_HTML_TYPE, MCP_APP_INIT_TIMEOUT_MS, MCP_APP_METHODS,
  MCP_APP_NETWORK_TYPE, MCP_APP_PROTOCOL_VERSION, MCP_APP_READY_TIMEOUT_MS, MCP_APP_READY_TYPE,
  MCP_APP_RENDERED_TYPE, MCP_APP_RENDER_TYPE, MCP_APP_SANDBOX_PAGE, MCP_APP_VIEW_ERROR_TYPE,
  buildAppDiagnostics, buildInitResult, clampPayload, createAppTrace, formatTraceEntry,
  hostCapabilities, hostSupportsSandboxPages, isAllowedAppLink, parseAppMessage, pickViewHtml
} from '../js/mcp-apps.mjs';

const FRAME_MIN = 160;
const FRAME_MAX = 900;

const els = {
  viewHtml: document.getElementById('viewHtml'),
  toolName: document.getElementById('toolName'),
  toolArgs: document.getElementById('toolArgs'),
  toolOutput: document.getElementById('toolOutput'),
  run: document.getElementById('b_run'),
  copyHtml: document.getElementById('b_copy_html'),
  copy: document.getElementById('b_copy'),
  copied: document.getElementById('copiedHint'),
  log: document.getElementById('log'),
  hostArea: document.getElementById('hostArea'),
  unsupported: document.getElementById('unsupported')
};

/** The one live view: { frame, tool, args, output, trace, remoteScripts, … }. */
let view = null;

/**
 * Append one line to the page's log *and* to the view's trace.
 * @param {Object} entry - { dir: 'host'|'view', kind, method?, ok?, text? }
 */
function log(entry) {
  if (view?.trace) view.trace.push(entry);
  renderLog();
}

/** Repaint the trace pane from the ring buffer. */
function renderLog() {
  const entries = view?.trace ? view.trace.list() : [];
  els.log.textContent = entries.map(formatTraceEntry).join('\n');
  els.log.scrollTop = els.log.scrollHeight;
}

/** The facts a diagnostic report is built from (same shape as the chat page's). */
function diagFacts() {
  return {
    tool: view?.tool,
    serverName: 'debugger',
    resourceUri: view?.resourceUri || 'debug://pasted',
    protocolVersion: MCP_APP_PROTOCOL_VERSION,
    sandboxSupported: hostSupportsSandboxPages(browser.runtime?.getManifest?.() || null),
    hostCapabilities: hostCapabilities(),
    remoteScripts: view?.remoteScripts || [],
    viewError: view?.viewError || null,
    initialized: view?.initialized === true,
    userAgent: navigator.userAgent
  };
}

/** Drop the current view (frame + timers) before starting another one. */
function teardown() {
  if (!view) return;
  clearTimeout(view.readyTimer);
  clearTimeout(view.initTimer);
  try {
    view.frame.remove();
  } catch (e) { /* already gone */ }
  view = null;
}

/** Read the tool fields, tolerating a half-typed JSON argument object. */
function readToolFields() {
  let args = {};
  try {
    const parsed = JSON.parse(els.toolArgs.value || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
  } catch (e) {
    log({ dir: 'host', kind: 'input', ok: false, text: `arguments is not valid JSON (${String(e.message)}) — using {}` });
  }
  return { tool: els.toolName.value.trim() || 'demo_tool', args, output: els.toolOutput.value };
}

/**
 * Ask the shell for the live HTML of the view (see the chat page's twin of this).
 * The frame is an opaque origin, so this page cannot read it; the shell can.
 * @returns {Promise<string>} Live HTML, or '' when the shell did not answer
 */
function requestViewHtml(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!view?.frame?.contentWindow) {
      resolve('');
      return;
    }
    let done = false;
    const finish = (html) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (view) view.pendingHtml = null;
      resolve(typeof html === 'string' ? html : '');
    };
    const timer = setTimeout(() => finish(''), timeoutMs);
    view.pendingHtml = finish;
    try {
      view.frame.contentWindow.postMessage({ type: MCP_APP_GET_HTML_TYPE }, '*');
    } catch (e) {
      finish('');
    }
  });
}

/** postMessage into the view (the shell writes it into its own document). */
function post(payload) {
  try {
    view?.frame?.contentWindow?.postMessage(payload, '*');
  } catch (e) {
    log({ dir: 'host', kind: 'error', ok: false, text: `postMessage failed: ${String(e && e.message || e)}` });
  }
}

/** Answer one request/notification from the view, exactly like the chat host does. */
function handleAppMessage(msg) {
  const { id, method } = msg;
  const params = msg.params || {};
  const reply = (result) => { if (id !== null) post({ jsonrpc: '2.0', id, result }); };
  const replyError = (code, message) => { if (id !== null) post({ jsonrpc: '2.0', id, error: { code, message } }); };

  if (method === MCP_APP_METHODS.INITIALIZE) {
    clearTimeout(view.initTimer);
    log({ dir: 'view', kind: 'request', method, text: `protocolVersion=${params.protocolVersion || '?'}` });
    const result = buildInitResult({
      toolName: view.tool,
      toolInput: view.args,
      toolOutput: clampPayload(view.output),
      serverName: 'debugger',
      hostVersion: browser.runtime?.getManifest?.().version || '1.0',
      hostContext: {
        theme: (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light',
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        platform: 'desktop',
        locale: browser.i18n?.getUILanguage?.() || undefined,
        userAgent: navigator.userAgent
      }
    });
    reply(result);
    // The full result is worth keeping: a missing required field is exactly the
    // mistake that makes a real app report "Not connected" with no other clue.
    log({ dir: 'host', kind: 'response', method, text: JSON.stringify(result).slice(0, 300) });
    return;
  }

  if (method === MCP_APP_METHODS.INITIALIZED) {
    view.initialized = true;
    log({ dir: 'view', kind: 'notification', method });
    post({ jsonrpc: '2.0', method: MCP_APP_METHODS.TOOL_INPUT, params: { arguments: view.args } });
    log({ dir: 'host', kind: 'notification', method: MCP_APP_METHODS.TOOL_INPUT });
    post({ jsonrpc: '2.0', method: MCP_APP_METHODS.TOOL_RESULT, params: { content: [{ type: 'text', text: clampPayload(view.output) }] } });
    log({ dir: 'host', kind: 'notification', method: MCP_APP_METHODS.TOOL_RESULT });
    return;
  }

  if (method === MCP_APP_METHODS.SIZE_CHANGED) {
    const height = Number(params.height);
    if (Number.isFinite(height) && height > 0) {
      view.frame.style.height = `${Math.max(FRAME_MIN, Math.min(FRAME_MAX, Math.round(height)))}px`;
    }
    log({ dir: 'view', kind: 'notification', method, text: `height=${height}` });
    return;
  }

  if (method === MCP_APP_METHODS.OPEN_LINK) {
    const url = params.url || params.href;
    const allowed = isAllowedAppLink(url);
    reply(allowed ? { opened: true } : { opened: false, isError: true });
    if (allowed) browser.tabs.create({ url });
    log({ dir: 'view', kind: 'request', method, ok: allowed, text: String(url || '') });
    return;
  }

  if (method === MCP_APP_METHODS.MESSAGE) {
    const text = String(params.content ?? params.text ?? '').trim();
    reply(text ? { delivered: true } : { delivered: false, isError: true });
    log({ dir: 'view', kind: 'request', method, ok: Boolean(text), text });
    return;
  }

  if (method === MCP_APP_METHODS.TOOLS_CALL) {
    // No server and no registry here: answer with the configured result, so the
    // round trip itself can be verified end to end.
    reply({ content: [{ type: 'text', text: clampPayload(view.output) }] });
    log({ dir: 'view', kind: 'request', method, text: `${String(params.name || '')} ${JSON.stringify(params.arguments || {}).slice(0, 160)}` });
    log({ dir: 'host', kind: 'response', method, text: 'answered with the configured result' });
    return;
  }

  log({ dir: 'view', kind: 'request', method, ok: false, text: 'not implemented by this host' });
  replyError(-32601, `Method not supported: ${method}`);
}

/** Boot one view: sandbox frame, handshake, watchdogs. */
function run() {
  teardown();
  els.copied.textContent = '';
  const html = els.viewHtml.value || '';
  if (!html.trim()) {
    view = { trace: createAppTrace() };
    log({ dir: 'host', kind: 'input', ok: false, text: 'paste the view HTML first' });
    return;
  }

  const { tool, args, output } = readToolFields();
  const frame = document.createElement('iframe');
  frame.className = 'mcp-app-frame';
  // Same flags as the chat page: an opaque origin, no allow-same-origin.
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.style.height = `${FRAME_MIN}px`;
  frame.src = browser.runtime.getURL(MCP_APP_SANDBOX_PAGE);

  view = {
    frame, tool, args, output, html, resourceUri: 'debug://pasted',
    remoteScripts: [], viewError: null, ready: false, initialized: false, failed: false,
    pendingHtml: null,
    trace: createAppTrace()
  };
  els.hostArea.replaceChildren(frame);
  log({ dir: 'host', kind: 'mount', text: `tool=${tool} sandbox=${MCP_APP_SANDBOX_PAGE}` });

  view.readyTimer = setTimeout(() => {
    if (view?.ready || view?.failed) return;
    view.failed = true;
    log({ dir: 'host', kind: 'timeout', method: 'ready', ok: false, text: 'the sandbox shell never reported itself ready' });
  }, MCP_APP_READY_TIMEOUT_MS);
}

window.addEventListener('message', (event) => {
  if (!view || event.source !== view.frame.contentWindow) return;
  const data = event.data;

  if (data?.type === MCP_APP_READY_TYPE) {
    view.ready = true;
    clearTimeout(view.readyTimer);
    log({ dir: 'view', kind: 'ready', text: `inlineScripts=${data.inlineScripts} sandboxed=${data.sandboxed} origin=${data.origin}` });
    if (data.inlineScripts === false) {
      view.failed = true;
      log({ dir: 'host', kind: 'notice', ok: false, text: 'this frame cannot execute inline scripts' });
      return;
    }
    // Always debug here: mirroring the view's console is the point of the page.
    post({ type: MCP_APP_RENDER_TYPE, html: view.html, debug: true });
    log({ dir: 'host', kind: 'render', text: `html=${view.html.length}B debug=true` });
    clearTimeout(view.initTimer);
    view.initTimer = setTimeout(() => {
      if (!view || view.initialized || view.failed) return;
      view.failed = true;
      log({ dir: 'host', kind: 'timeout', method: 'ui/initialize', ok: false, text: 'the view never called ui/initialize' });
    }, MCP_APP_INIT_TIMEOUT_MS);
    return;
  }

  if (data?.type === MCP_APP_RENDERED_TYPE) {
    view.remoteScripts = Array.isArray(data.remoteScripts) ? data.remoteScripts.map(String).slice(0, 5) : [];
    log({ dir: 'view', kind: 'rendered', ok: !view.remoteScripts.length, text: view.remoteScripts.length ? `remote scripts: ${view.remoteScripts.join(', ')}` : '' });
    return;
  }

  if (data?.type === MCP_APP_VIEW_ERROR_TYPE) {
    view.viewError = { message: String(data.message || ''), source: String(data.source || ''), line: Number(data.line) || 0 };
    log({ dir: 'view', kind: 'view-error', ok: false, text: `${view.viewError.message} (${view.viewError.source}:${view.viewError.line})` });
    return;
  }

  if (data?.type === MCP_APP_CONSOLE_TYPE) {
    const level = String(data.level || 'log');
    log({ dir: 'view', kind: 'console', method: level, ok: level !== 'error', text: String(data.text || '') });
    return;
  }

  if (data?.type === MCP_APP_ERROR_TYPE) {
    view.failed = true;
    log({ dir: 'view', kind: 'shell-error', ok: false, text: String(data.reason || '') });
    return;
  }

  if (data?.type === MCP_APP_HTML_TYPE) {
    const html = String(data.html || '');
    if (typeof view.pendingHtml === 'function') view.pendingHtml(html);
    log({ dir: 'view', kind: 'html', text: `${html.length}B` });
    return;
  }

  if (data?.type === MCP_APP_NETWORK_TYPE) {
    const method = String(data.method || 'GET');
    const status = Number(data.status) || 0;
    const ok = data.ok !== false;
    log({
      dir: 'view', kind: 'network', method, ok,
      text: `${method} ${String(data.url || '')} ${status || (ok ? '' : 'FAILED')} ${Number(data.ms) || 0}ms${data.error ? ` (${data.error})` : ''}`.replace(/\s+/g, ' ').trim()
    });
    return;
  }

  const parsed = parseAppMessage(data);
  if (!parsed.ok) {
    log({ dir: 'view', kind: 'refused', ok: false, text: `ignored app message: ${parsed.reason}` });
    return;
  }
  try {
    handleAppMessage(parsed.msg);
  } catch (e) {
    log({ dir: 'host', kind: parsed.msg.method, ok: false, text: String(e?.message || e) });
  }
});

els.run.addEventListener('click', run);
els.copyHtml.addEventListener('click', async () => {
  const picked = pickViewHtml(await requestViewHtml(), view?.html || '');
  try {
    if (!picked.text) throw new Error('nothing to copy');
    await navigator.clipboard.writeText(picked.text);
    els.copied.textContent = browser.i18n.getMessage('copied') || 'Copied';
  } catch (e) {
    els.copied.textContent = browser.i18n.getMessage('replicationFailed') || 'Copy failed';
  }
  log({
    dir: 'host', kind: 'html', ok: picked.live,
    text: picked.live ? 'copied the live DOM' : 'copied the injected source (the frame did not answer)'
  });
  setTimeout(() => { els.copied.textContent = ''; }, 2000);
});
els.copy.addEventListener('click', async () => {
  const report = buildAppDiagnostics(diagFacts(), view?.trace ? view.trace.list() : []);
  try {
    await navigator.clipboard.writeText(report);
    els.copied.textContent = browser.i18n.getMessage('copied') || 'Copied';
  } catch (e) {
    els.copied.textContent = browser.i18n.getMessage('replicationFailed') || 'Copy failed';
  }
  setTimeout(() => { els.copied.textContent = ''; }, 2000);
});

// Say so up front when this build cannot host a view at all (Firefox ≤153,
// Android): a card here would only produce a misleading "nothing happens".
if (!hostSupportsSandboxPages(browser.runtime?.getManifest?.() || null)) {
  els.unsupported.classList.remove('d-none');
  els.run.disabled = true;
}

i18n();

