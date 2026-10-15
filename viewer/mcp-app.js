// viewer/mcp-app.js — The sandboxed shell that hosts an MCP App (SEP-1865).
//
// Why this page exists at all: MV3 extension pages run under a CSP of
// `script-src 'self'`, and a `srcdoc` iframe *inherits* its parent's policy —
// so bundling an app's inline scripts straight into the chat page would be
// blocked. Declaring this page under `sandbox.pages` in the manifest gives it an
// opaque origin plus a policy that permits inline scripts, while the extra
// isolation is exactly what a third-party UI needs: no `chrome.*` API here
// (verified by the spike in the plan), no access to the chat page's DOM.
//
// The chat page and the app then talk directly over postMessage:
//
//   chat page ──{type:'cllama:mcp-app:render', html}──▶ shell window (= the app)
//   app ────────JSON-RPC (ui/initialize, tools/call, …)──▶ window.parent
//
// Nothing from the server is executed as *host* code: the document is written
// into this sandboxed window and never into the chat page.
//
// NOTE: no `import { browser }` here on purpose — sandboxed pages have no
// extension API namespace, so importing js/browser.mjs would buy nothing.

/** Keep in sync with js/mcp-apps.mjs (guarded by tools/mcp-apps.test.mjs). */
const READY_TYPE = 'cllama:mcp-app:ready';
const RENDER_TYPE = 'cllama:mcp-app:render';
/** Sent back once the document is written, with the facts about it. */
const RENDERED_TYPE = 'cllama:mcp-app:rendered';
/** A view that throws on its own (load-time dependency errors, mostly). */
const VIEW_ERROR_TYPE = 'cllama:mcp-app:view-error';
const ERROR_TYPE = 'cllama:mcp-app:error';

/** Upper bound for a UI resource (see MCP_APP_HTML_MAX in js/mcp-apps.mjs). */
const HTML_MAX = 2 * 1024 * 1024;

/**
 * Can this document execute inline scripts at all?
 *
 * The view we are about to receive carries its logic in an inline `<script>`,
 * so if this frame's CSP forbids inline scripts the view would render and then
 * do nothing — a failure that is invisible from the outside. A script element
 * created from JS with `textContent` is subject to exactly the same
 * `script-src` check as one written by the parser, which makes this a faithful
 * probe. Report the answer to the host instead of letting it guess.
 * @returns {boolean}
 */
function probeInlineScripts() {
  try {
    const probe = document.createElement('script');
    probe.textContent = 'window.__cllamaInlineProbe = true;';
    (document.head || document.documentElement).appendChild(probe);
    probe.remove();
    return window.__cllamaInlineProbe === true;
  } catch (e) {
    return false;
  }
}

/**
 * Report the `<script src>` values that point outside this extension build.
 *
 * The sandbox policy allows `'self'`, inline scripts and `https:`. A view whose
 * bundle comes from anywhere else renders and then does nothing, and from the
 * outside that is indistinguishable from "the view is broken". The host cannot
 * look into this frame, so the fact is collected here — from the DOM that was
 * actually created, not from a guess about the HTML — and handed over.
 * @returns {Array<string>} The offending `src` values (capped, unmodified)
 */
function findRemoteScripts() {
  const found = [];
  try {
    for (const el of document.querySelectorAll('script[src]')) {
      const raw = String(el.getAttribute('src') || '');
      // Extension-relative paths (`mcp-app.js`, `/js/x.js`) and explicit
      // extension URLs stay allowed by `'self'`; a scheme or a protocol-relative
      // URL is what the CSP refuses.
      const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(raw)?.[1].toLowerCase() || '';
      const isExtension = scheme.startsWith('chrome-extension:') || scheme.startsWith('moz-extension:')
        || scheme.startsWith('safari-web-extension:');
      const isRemote = raw.startsWith('//') || (scheme !== '' && !isExtension);
      if (!isRemote) continue;
      found.push(raw);
      if (found.length >= 5) break;
    }
  } catch (e) {
    // Reporting is best-effort: it must never break the render itself.
  }
  return found;
}

/**
 * Tell the chat page the shell is alive, plus the two facts it needs to explain
 * a failure instead of presenting a dead card:
 *   - `inlineScripts`: whether the view's own script can run here at all;
 *   - `sandboxed`/`origin`: whether this frame really is an opaque-origin
 *     sandbox page (Chrome's `manifest.sandbox`) or an ordinary extension page
 *     (Firefox/Android, where a view can never work).
 *
 * `window.origin` — not `location.origin` — is the opaque-origin test: a
 * sandboxed extension page keeps reporting its `chrome-extension://` URL from
 * `location.origin` even though its origin is opaque.
 */
window.parent.postMessage({
  type: READY_TYPE,
  inlineScripts: probeInlineScripts(),
  sandboxed: window.origin === 'null',
  origin: location.origin
}, '*');

/**
 * Forward uncaught errors thrown by the view to the host.
 *
 * The view's scripts run in THIS window, so their failures are observable here
 * and nowhere else — the frame has an opaque origin, so the chat page cannot
 * read its console. Handing the message over is what turns "the view did
 * nothing" into "the view threw X" (the interesting case being a view whose
 * bundle dies inside its own dependency at import time).
 *
 * Capped, because a broken view can throw in a loop and the host only needs the
 * first few facts. Cross-origin scripts without CORS yield "Script error." —
 * still better than silence, and the frame's own console has the rest.
 */
let forwardedErrors = 0;
function reportViewError(event) {
  if (forwardedErrors >= 3) return;
  forwardedErrors++;
  const err = event?.error ?? event?.reason;
  const message = String(event?.message || err?.message || err || 'unknown error');
  window.parent.postMessage({
    type: VIEW_ERROR_TYPE,
    message: message.slice(0, 300),
    source: String(event?.filename || '').slice(0, 200),
    line: Number(event?.lineno) || 0
  }, '*');
}

/** (Re-)register the window listeners; document.open() must not lose them. */
function registerWindowListeners() {
  window.removeEventListener('error', reportViewError);
  window.addEventListener('error', reportViewError);
  window.removeEventListener('unhandledrejection', reportViewError);
  window.addEventListener('unhandledrejection', reportViewError);
}
registerWindowListeners();

/**
 * Receive a UI document and become it.
 *
 * `document.write` after load replaces the document but keeps this window (and
 * therefore the listener below) alive — but `document.open()` *does* drop the
 * listeners registered on the window, which is why the handlers are re-attached
 * around the write instead of only at load time.
 * @param {MessageEvent} event - Message from the chat page
 */
function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== RENDER_TYPE) return;

  const html = typeof data.html === 'string' ? data.html : '';
  if (!html) {
    window.parent.postMessage({ type: ERROR_TYPE, reason: 'empty-html' }, '*');
    return;
  }
  if (html.length > HTML_MAX) {
    window.parent.postMessage({ type: ERROR_TYPE, reason: 'too-large' }, '*');
    return;
  }

  try {
    document.open();
    // `document.open()` replaces the document AND drops the listeners that were
    // registered on this window — so re-register BEFORE writing, or a view that
    // throws while its scripts are parsed is reported to nobody (measured: with
    // only the post-write registration the synchronous throw was lost, while
    // the async ones survived).
    registerWindowListeners();
    document.write(html);
    document.close();
    window.parent.postMessage({ type: RENDERED_TYPE, remoteScripts: findRemoteScripts() }, '*');
    registerWindowListeners();
    window.removeEventListener('message', onMessage);
    window.addEventListener('message', onMessage);
  } catch (e) {
    window.parent.postMessage({ type: ERROR_TYPE, reason: String(e && e.message || e) }, '*');
  }
}

window.addEventListener('message', onMessage);
