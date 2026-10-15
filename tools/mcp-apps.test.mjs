/**
 * Self-check for the MCP Apps (SEP-1865) host helpers (js/mcp-apps.mjs).
 *
 *   node tools/mcp-apps.test.mjs
 *
 * Pure functions only — plus a few *static* guards for the pieces that cannot be
 * unit-tested here but whose drift would be silent: the sandbox shell's postMessage
 * types, the wiring in chat/chat.js (including the security-relevant sandbox
 * flags), the manifest's sandbox page registration and the translation keys.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const {
  MCP_APP_HTML_MAX, MCP_APP_HTML_MIME_PREFIX, MCP_APP_LINK_PROTOCOLS, MCP_APP_METHODS,
  MCP_APP_PAYLOAD_MAX, MCP_APP_ERROR_TYPE, MCP_APP_INIT_TIMEOUT_MS, MCP_APP_PROTOCOL_VERSION, MCP_APP_READY_TYPE,
  MCP_APP_RENDERED_TYPE, MCP_APP_RENDER_TYPE, MCP_APP_REFS_MAX, MCP_APP_SANDBOX_PAGE, MCP_APP_STORED_ARGS_MAX,
  MCP_APP_STORED_OUTPUT_MAX, MCP_APP_VIEW_ERROR_TYPE,
  buildInitResult, clampPayload, extractUiMeta, hostCapabilities, hostSupportsSandboxPages,
  isAllowedAppLink, isAppToolAllowed, makeAppRef, mcpToolId, mcpToolPrefix, normalizeAppRef,
  normalizeAppRefs, parseAppMessage, resolveAppToolName
} = await import('../js/mcp-apps.mjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ------------------- _meta.ui extraction -------------------

check('extractUiMeta reads the nested _meta.ui.resourceUri', () => {
  const meta = extractUiMeta({ name: 't', _meta: { ui: { resourceUri: 'ui://charts/bar', prefersBorder: true } } });
  assert.deepEqual(meta, { resourceUri: 'ui://charts/bar', csp: null, prefersBorder: true });
});

check('extractUiMeta also accepts the flattened _meta["ui/resourceUri"]', () => {
  const meta = extractUiMeta({ _meta: { 'ui/resourceUri': ' ui://x/y ' } });
  assert.equal(meta.resourceUri, 'ui://x/y');
  assert.equal(meta.prefersBorder, false);
});

check('extractUiMeta ignores tools without usable UI metadata', () => {
  assert.equal(extractUiMeta(null), null);
  assert.equal(extractUiMeta({}), null);
  assert.equal(extractUiMeta({ _meta: null }), null);
  assert.equal(extractUiMeta({ _meta: 'nope' }), null);
  assert.equal(extractUiMeta({ _meta: {} }), null);
  assert.equal(extractUiMeta({ _meta: { ui: {} } }), null);
  assert.equal(extractUiMeta({ _meta: { ui: { resourceUri: '' } } }), null);
  assert.equal(extractUiMeta({ _meta: { ui: { resourceUri: 42 } } }), null);
});

check('extractUiMeta refuses a non-ui:// URI', () => {
  // A plain URL must never be treated as a renderable app.
  assert.equal(extractUiMeta({ _meta: { ui: { resourceUri: 'https://evil.test/app.html' } } }), null);
  assert.equal(extractUiMeta({ _meta: { ui: { resourceUri: 'data:text/html,<b>x</b>' } } }), null);
});

check('extractUiMeta keeps a declared csp object', () => {
  const meta = extractUiMeta({ _meta: { ui: { resourceUri: 'ui://a/b', csp: { script: ['https://cdn.test'] } } } });
  assert.deepEqual(meta.csp, { script: ['https://cdn.test'] });
});

// ------------------- tool naming (must match js/mcp.mjs) -------------------

check('mcpToolId / mcpToolPrefix use the shared registry-safe slug', () => {
  assert.equal(mcpToolId('My Server', 'get-time'), 'mcp_My_Server_get_time');
  assert.equal(mcpToolPrefix('My Server'), 'mcp_My_Server_');
  assert.equal(mcpToolId('', ''), 'mcp__');
  assert.equal(mcpToolPrefix('a.b/c'), 'mcp_a_b_c_');
});

check('the tool-id rule in js/mcp.mjs still matches this module (drift guard)', () => {
  // The two implementations are duplicated on purpose (this module must stay
  // importable in Node without storage code), so pin the shared shape.
  const src = read('../js/mcp.mjs');
  assert.match(src, /return `mcp_\$\{slug\(serverName\)\}_\$\{slug\(toolName\)\}`;/);
  assert.match(src, /replace\(\/\[\^A-Za-z0-9_\]\/g, '_'\)/);
});

// ------------------- host capabilities (capability gating) -------------------

check('hostCapabilities only claims what this host really implements', () => {
  const caps = hostCapabilities();
  // The spec's McpUiHostCapabilities is a CLOSED object whose entries are all
  // objects: a made-up key (or `openLink: true`) fails the SDK's validation of
  // the initialize result, which leaves the app permanently "Not connected".
  const SPEC_KEYS = ['experimental', 'openLinks', 'downloadFile', 'serverTools',
    'serverResources', 'logging', 'sandbox', 'updateModelContext', 'message', 'sampling'];
  for (const key of Object.keys(caps)) {
    assert.ok(SPEC_KEYS.includes(key), `${key} is not part of McpUiHostCapabilities`);
    assert.equal(typeof caps[key], 'object', `${key} must be an object`);
  }
  // What we DO implement, spelled as the spec does.
  assert.deepEqual(caps.serverTools, {});
  assert.deepEqual(caps.openLinks, {});
  assert.deepEqual(caps.message, { text: {} });
  // What we do not implement must be absent (there is no `false` form).
  for (const key of ['downloadFile', 'serverResources', 'logging', 'sandbox', 'sampling', 'updateModelContext']) {
    assert.equal(key in caps, false, `${key} is not implemented and must be omitted`);
  }
});

check('the initialize result fills every field the spec requires', () => {
  // `@modelcontextprotocol/ext-apps` validates this object before resolving
  // App.connect(); a missing field rejects the connect and every later
  // callServerTool() throws "Not connected" while the view still renders.
  const REQUIRED = ['protocolVersion', 'hostInfo', 'hostCapabilities', 'hostContext'];
  const result = buildInitResult({});
  for (const key of REQUIRED) {
    assert.ok(key in result, `McpUiInitializeResult requires ${key}`);
  }
  assert.equal(result.protocolVersion, MCP_APP_PROTOCOL_VERSION);
  assert.equal(result.hostInfo.name, 'cllama');
  assert.ok(result.hostInfo.version, 'hostInfo needs a version');
  assert.deepEqual(result.hostContext, {});
  assert.deepEqual(Object.keys(result.hostCapabilities).sort(), ['message', 'openLinks', 'serverTools']);
});

check('hostSupportsSandboxPages reads the build that is actually running', () => {
  // The capability is Chrome-only, and it is *the* precondition for a view whose
  // own script must run — so it is detected from the live manifest, not sniffed.
  assert.equal(hostSupportsSandboxPages({ sandbox: { pages: [MCP_APP_SANDBOX_PAGE] } }), true);
  assert.equal(hostSupportsSandboxPages({ sandbox: { pages: ['other/page.html', MCP_APP_SANDBOX_PAGE] } }), true);
  assert.equal(hostSupportsSandboxPages({ sandbox: { pages: ['viewer/print.html'] } }), false);
  assert.equal(hostSupportsSandboxPages({ sandbox: {} }), false);
  assert.equal(hostSupportsSandboxPages({}), false);
  assert.equal(hostSupportsSandboxPages(null), false);
  assert.equal(hostSupportsSandboxPages(undefined), false);
});


// ------------------- app → host messages -------------------

check('parseAppMessage accepts a request and a notification', () => {
  const req = parseAppMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } });
  assert.deepEqual(req, { ok: true, msg: { id: 7, method: 'tools/call', params: { name: 'x' } } });
  const note = parseAppMessage({ jsonrpc: '2.0', method: ' ui/notifications/initialized ' });
  assert.deepEqual(note, { ok: true, msg: { id: null, method: 'ui/notifications/initialized', params: {} } });
});

check('parseAppMessage refuses malformed frames with a reason', () => {
  assert.equal(parseAppMessage(null).reason, 'not-an-object');
  assert.equal(parseAppMessage('tools/call').reason, 'not-an-object');
  assert.equal(parseAppMessage([{ method: 'x' }]).reason, 'not-an-object');
  assert.equal(parseAppMessage({}).reason, 'missing-method');
  assert.equal(parseAppMessage({ method: '   ' }).reason, 'missing-method');
  assert.equal(parseAppMessage({ method: 'x', params: [] }).reason, 'bad-params');
  assert.equal(parseAppMessage({ method: 'x', params: 3 }).reason, 'bad-params');
  assert.equal(parseAppMessage({ method: 'x', id: {} }).reason, 'bad-id');
  assert.equal(parseAppMessage({ method: 'x', id: true }).reason, 'bad-id');
});

check('parseAppMessage caps the frame size', () => {
  const big = { method: 'x', params: { blob: 'a'.repeat(MCP_APP_PAYLOAD_MAX) } };
  assert.equal(parseAppMessage(big).reason, 'too-large');
  assert.equal(parseAppMessage(big, { maxBytes: big.params.blob.length * 2 }).ok, true);
});

check('buildInitResult carries the host capabilities and the tool call', () => {
  const result = buildInitResult({ toolName: 'mcp_s_t', toolInput: { a: 1 }, toolOutput: 'out', serverName: 's', hostVersion: '9.9.9' });
  assert.equal(result.hostInfo.name, 'cllama');
  assert.equal(result.hostInfo.version, '9.9.9');
  assert.deepEqual(result.hostCapabilities.serverTools, {});
  assert.equal(result.toolName, 'mcp_s_t');
  assert.deepEqual(result.toolInput, { a: 1 });
  assert.equal(result.toolOutput, 'out');
  assert.equal(result.serverName, 's');
  assert.deepEqual(buildInitResult().toolInput, null);
  // The host context is optional but must be an object when given.
  assert.deepEqual(buildInitResult({ hostContext: { theme: 'dark' } }).hostContext, { theme: 'dark' });
  assert.deepEqual(buildInitResult({ hostContext: 'nope' }).hostContext, {});
  assert.deepEqual(buildInitResult({ hostContext: [1] }).hostContext, {});
});

// ------------------- link policy -------------------

check('isAllowedAppLink allows only web/mail schemes', () => {
  assert.equal(isAllowedAppLink('https://example.com/a?b=1'), true);
  assert.equal(isAllowedAppLink(' http://example.com '), true);
  assert.equal(isAllowedAppLink('mailto:user@example.com'), true);
  assert.deepEqual(MCP_APP_LINK_PROTOCOLS, ['http:', 'https:', 'mailto:']);
});

check('isAllowedAppLink refuses the escape hatches', () => {
  assert.equal(isAllowedAppLink('javascript:alert(1)'), false);
  assert.equal(isAllowedAppLink('data:text/html,<b>x</b>'), false);
  assert.equal(isAllowedAppLink('file:///etc/passwd'), false);
  assert.equal(isAllowedAppLink('blob:https://x/y'), false);
  assert.equal(isAllowedAppLink('chrome-extension://abc/chat/chat.html'), false);
  assert.equal(isAllowedAppLink('/relative/path'), false);
  assert.equal(isAllowedAppLink('not a url'), false);
  assert.equal(isAllowedAppLink(''), false);
  assert.equal(isAllowedAppLink(null), false);
});

// ------------------- app tool scope -------------------

check('isAppToolAllowed keeps an app inside its own server', () => {
  assert.equal(isAppToolAllowed('mcp_Charts_get_data', 'Charts'), true);
  // Strictly case-sensitive on purpose: two servers may legitimately be named
  // "Charts" and "charts", and a loose match would let one app reach the other.
  assert.equal(isAppToolAllowed('mcp_charts_get_data', 'Charts'), false);
  assert.equal(isAppToolAllowed('mcp_Other_get_data', 'Charts'), false);
});

check('isAppToolAllowed never reaches host tools or empty input', () => {
  // Notably the storage-writing tools: an app must not import Skills/scenarios.
  assert.equal(isAppToolAllowed('save_skill', 'Charts'), false);
  assert.equal(isAppToolAllowed('save_chat_scenario', 'Charts'), false);
  assert.equal(isAppToolAllowed('current_time', 'Charts'), false);
  assert.equal(isAppToolAllowed('mcp_Charts_', 'Charts'), false);
  assert.equal(isAppToolAllowed('', 'Charts'), false);
  assert.equal(isAppToolAllowed('mcp_Charts_x', ''), false);
  assert.equal(isAppToolAllowed('mcp_Charts_x', null), false);
});

// ------------------- payload clamping -------------------

check('clampPayload truncates with a visible marker', () => {
  assert.equal(clampPayload('abc'), 'abc');
  assert.equal(clampPayload('abcdef', 6), 'abcdef');
  assert.equal(clampPayload('abcdefg', 6), 'abcdef\n…[truncated]');
  assert.equal(clampPayload(null), '');
  assert.equal(clampPayload(undefined), '');
  assert.equal(clampPayload({ a: 1 }), '{"a":1}');
});

// ------------------- stored view references -------------------

check('makeAppRef captures what is needed to rebuild a view', () => {
  const ref = makeAppRef({ tool: 'mcp_s_render', serverName: 's', ui: { resourceUri: 'ui://d/x' }, args: { a: 1 }, output: 'total 37' });
  assert.deepEqual(ref, {
    tool: 'mcp_s_render',
    serverName: 's',
    resourceUri: 'ui://d/x',
    args: { a: 1 },
    output: 'total 37',
    truncated: false
  });
});

check('makeAppRef refuses anything that is not a renderable view', () => {
  assert.equal(makeAppRef({}), null);
  assert.equal(makeAppRef({ tool: 'x', ui: {} }), null);
  assert.equal(makeAppRef({ tool: 'x', ui: { resourceUri: 'https://evil.test/a.html' } }), null);
  assert.equal(makeAppRef({ tool: '', ui: { resourceUri: 'ui://a/b' } }), null);
});

check('makeAppRef clamps the stored output and flags truncation', () => {
  const long = 'x'.repeat(MCP_APP_STORED_OUTPUT_MAX + 100);
  const ref = makeAppRef({ tool: 't', ui: { resourceUri: 'ui://a/b' }, output: long });
  assert.equal(ref.truncated, true);
  assert.ok(ref.output.length < long.length);
  assert.match(ref.output, /truncated/);
  // Arguments that cannot be stored verbatim are dropped, not half-stored.
  const big = makeAppRef({ tool: 't', ui: { resourceUri: 'ui://a/b' }, args: { blob: 'y'.repeat(MCP_APP_STORED_ARGS_MAX + 10) } });
  assert.equal(big.args, null);
  assert.equal(big.truncated, true);
});

check('normalizeAppRefs validates, caps and tolerates junk', () => {
  assert.deepEqual(normalizeAppRefs(null), []);
  assert.deepEqual(normalizeAppRefs('nope'), []);
  const good = { tool: 't', resourceUri: 'ui://a/b', output: 'o' };
  assert.equal(normalizeAppRefs([good, null, {}, { tool: 'x' }, { resourceUri: 'ui://a/b' }, 42]).length, 1);
  // A record written by an older/newer version must not break rendering.
  const normalized = normalizeAppRef({ tool: 't', resourceUri: 'ui://a/b', args: 'not-an-object', serverName: 7 });
  assert.deepEqual(normalized, { tool: 't', serverName: null, resourceUri: 'ui://a/b', args: null, output: '', truncated: false });
  // The per-message cap keeps a pathological turn from bloating storage.
  const many = Array.from({ length: MCP_APP_REFS_MAX + 5 }, () => ({ ...good }));
  assert.equal(normalizeAppRefs(many).length, MCP_APP_REFS_MAX);
});

// ------------------- sandbox shell parity (static) -------------------

check('the sandbox shell posts the same message types this module expects', () => {
  const shell = read('../viewer/mcp-app.js');
  for (const t of [MCP_APP_READY_TYPE, MCP_APP_RENDER_TYPE, MCP_APP_RENDERED_TYPE, MCP_APP_VIEW_ERROR_TYPE, MCP_APP_ERROR_TYPE]) {
    assert.ok(shell.includes(`'${t}'`), `viewer/mcp-app.js must use ${t}`);
  }
  const cap = shell.match(/const HTML_MAX = ([^;]+);/);
  assert.ok(cap, 'the shell must cap the document size');
  // Evaluate the constant's expression so `2 * 1024 * 1024` and `2097152` agree.
  assert.equal(Function(`return ${cap[1]};`)(), MCP_APP_HTML_MAX, 'shell size cap must match');
  // Sandboxed pages have no extension APIs, so importing the browser module there
  // would only be a silent no-op (and a misleading one).
  assert.ok(!/from '\.\.\/js\//.test(shell), 'the shell must not import extension modules');
});

check('the shell only reacts to messages from its parent', () => {
  const shell = read('../viewer/mcp-app.js');
  assert.match(shell, /event\.source !== window\.parent/);
});

// ------------------- host wiring (static) -------------------

check('chat.js renders the view and never grants allow-same-origin', () => {
  const chat = read('../chat/chat.js');
  assert.match(chat, /onToolResult: \(info\) => renderMcpApp\(info\)/);
  assert.match(chat, /sandbox', 'allow-scripts allow-forms allow-popups'\)/);
  // The flags are asserted (not the word): the comment above the frame mentions
  // allow-same-origin precisely to explain that it must not be granted.
  assert.ok(!/setAttribute\('sandbox',[^)]*allow-same-origin/.test(chat), 'the app frame must stay opaque-origin');
  assert.match(chat, /teardownMcpApps\(\);/);
  // The proxied call must go through the governed pipeline, not straight to MCP.
  assert.match(chat, /await runTool\(name, args, bridge\.skill \|\| null, ctx\)/);
  // The frame URL comes from the shared constant (the manifest registers the
  // same page), and the build's ability to host it is checked, not assumed.
  assert.match(chat, /browser\.runtime\.getURL\(MCP_APP_SANDBOX_PAGE\)/);
  assert.match(chat, /hostSupportsSandboxPages\(browser\.runtime\?\.getManifest\?\.\(\)/);
  // A view whose script never starts must say so instead of staying dead.
  assert.match(chat, new RegExp(`\\}, MCP_APP_INIT_TIMEOUT_MS\\)`));
  assert.match(chat, /clearTimeout\(bridge\.initTimer\)/);
});

check('chat.js dispatches every method the capability flags imply', () => {
  const chat = read('../chat/chat.js');
  for (const m of ['INITIALIZE', 'INITIALIZED', 'SIZE_CHANGED', 'OPEN_LINK', 'MESSAGE', 'TOOLS_CALL']) {
    assert.match(chat, new RegExp(`MCP_APP_METHODS\\.${m}`), `chat.js must handle ${m}`);
  }
  // Tools the app asks for are still confirmed like any other side effect: the
  // ctx built for them carries the standard confirmation hook.
  assert.match(chat, /buildToolContext\(\{/);
});

check('the tool pipeline exposes a separate data channel for the UI', () => {
  const tools = read('../js/skill-tools.mjs');
  // Both execution paths (text protocol + native calls) must feed the view.
  assert.equal((tools.match(/notifyToolResult\(ctx, tool, mergedArgs, out\);/g) || []).length, 2);
  // ...and it must stay out of the audit trail (metadata only).
  assert.ok(!/onToolResult[\s\S]{0,200}recordRunStep/.test(tools));
  assert.match(read('../js/cllama.js'), /onToolResult: \(info\) => \{/);
});

check('the Chrome manifest registers the sandbox page and its CSP', () => {
  const manifest = JSON.parse(read('../manifest.json'));
  assert.deepEqual(manifest.sandbox?.pages, [MCP_APP_SANDBOX_PAGE]);
  // MV3: the sandboxed page's CSP lives in content_security_policy.sandbox.
  // Without an inline-script-capable policy the view renders but its own script
  // never runs — the exact failure this declaration exists to prevent.
  const sandboxCsp = manifest.content_security_policy?.sandbox || '';
  assert.match(sandboxCsp, /^sandbox /);
  assert.match(sandboxCsp, /'unsafe-inline'/);
  assert.match(sandboxCsp, /script-src 'self' 'unsafe-inline'/);
  // Remote bundles are common in real apps, and this policy is static — a
  // per-app `_meta.ui.csp` cannot loosen it at runtime, so https: is allowed
  // for every view (they are already opaque-origin and have no extension APIs).
  assert.match(sandboxCsp, /'unsafe-eval' https:;/);
});

check('the Firefox (MV2) manifest registers the sandbox page in the MV2 shape', () => {
  // Firefox supports sandboxed pages too — but in MV2 the policy is a *string*
  // inside the `sandbox` key, not `content_security_policy.sandbox`. Copying the
  // MV3 shape here would leave the view unable to run its own script.
  const manifest = JSON.parse(read('../manifest.firefox.json'));
  assert.deepEqual(manifest.sandbox?.pages, [MCP_APP_SANDBOX_PAGE]);
  assert.equal(typeof manifest.sandbox.content_security_policy, 'string');
  assert.match(manifest.sandbox.content_security_policy, /'unsafe-inline'/);
  // Same reason as the Chrome manifest: https: is part of the policy.
  assert.match(manifest.sandbox.content_security_policy, /'unsafe-eval' https:/);
  assert.equal(manifest.content_security_policy?.sandbox, undefined);
  // The extension's own pages keep their (untouched) MV2 string policy.
  assert.equal(typeof manifest.content_security_policy, 'string');
});

// ------------------- i18n parity -------------------

check('resolveAppToolName maps the app vocabulary onto the registry', () => {
  // The app asks for its server's own tool name; the registry is prefixed.
  assert.equal(resolveAppToolName('add_point', 'test'), 'mcp_test_add_point');
  assert.equal(resolveAppToolName('add-point', 'test'), 'mcp_test_add_point');
  assert.equal(resolveAppToolName('  get_data  ', 'My Server'), 'mcp_My_Server_get_data');
  // A prefixed name from the app keeps working.
  assert.equal(resolveAppToolName('mcp_test_add_point', 'test'), 'mcp_test_add_point');
  // Out of scope / empty input is refused (never silently "unknown tool").
  assert.equal(resolveAppToolName('add_point', ''), null);
  assert.equal(resolveAppToolName('add_point', null), null);
  assert.equal(resolveAppToolName('', 'test'), null);
  assert.equal(resolveAppToolName(null, 'test'), null);
  // Another server's namespace cannot be reached through the raw form.
  assert.equal(resolveAppToolName('save_skill', 'test'), 'mcp_test_save_skill');
});

check('an app call is resolved, checked and never refused silently', () => {
  const chat = read('../chat/chat.js');
  // The name the app sends is mapped to the registry name...
  assert.match(chat, /const name = resolveAppToolName\(rawName, bridge\.serverName\)/);
  // ...the tool must actually exist...
  assert.match(chat, /const tool = getTool\(name\);/);
  assert.match(chat, /deny\(`Unknown tool: \$\{rawName\}`\)/);
  // ...and a refusal leaves a chip plus an audit step (a button that silently
  // does nothing is indistinguishable from a broken one).
  assert.match(chat, /const deny = \(message\) => \{/);
  assert.match(chat, /ctx\.onStep\(\{ tool: rawName \|\| 'app-tool', ok: false, denied: true, error: message \}\)/);
});

check('the host replies with the payload shapes the spec defines', () => {
  const chat = read('../chat/chat.js');
  // tool-input's params is a CLOSED object — the app's SDK rejects a payload
  // carrying extra keys, and ours used to also send `toolName`.
  assert.match(chat, /params: \{ arguments: \(bridge\.args && typeof bridge\.args === 'object'\) \? bridge\.args : \{\} \}/);
  assert.ok(!/params: \{ toolName: bridge\.tool/.test(chat), 'notification params must not carry toolName');
  // tool-result's params is a standard MCP tool result: `content` is required.
  assert.match(chat, /method: MCP_APP_METHODS\.TOOL_RESULT,[\s\S]{0,240}content: \[\{ type: 'text', text: clampPayload\(bridge\.output\) \}\]/);
  // The initialize reply carries the build's real version and a host context the
  // app can theme / lay out with (both required-or-useful, see buildInitResult).
  assert.match(chat, /hostVersion: browser\.runtime\?\.getManifest\?\.\(\)\.version/);
  assert.match(chat, /hostContext: \{[\s\S]{0,400}displayMode: 'inline'/);
  // The SDK decides success from `isError` on these results, so refusals must
  // set it (our own `opened` / `delivered` flags stay for the demo view).
  assert.match(chat, /result: allowed \? \{ opened: true \} : \{ opened: false, isError: true \}/);
  assert.match(chat, /result: delivered \? \{ delivered: true \} : \{ delivered: false, isError: true \}/);
});

check('the MCP Apps / app-origin labels exist in every locale', () => {
  const KEYS = ['mcpAppTitle', 'mcpAppUnsupported', 'mcpAppLoadFailed', 'mcpAppScriptBlocked',
    'mcpAppInlineBlocked', 'mcpAppExternalScriptBlocked', 'mcpAppViewError', 'mcpAppMessagePrefilled', 'mcpAppLinkBlocked', 'mcpAppRender',
    'mcpAppHide', 'mcpAppAutoRender', 'mcpAppAutoRenderHint', 'skillRunApp', 'skillRunFilterApp'];
  const dir = new URL('../_locales/', import.meta.url);
  const locales = readdirSync(dir);
  assert.ok(locales.length >= 15, `expected every locale, found ${locales.length}`);
  const missing = [];
  for (const loc of locales) {
    const messages = JSON.parse(readFileSync(new URL(`${loc}/messages.json`, dir), 'utf8'));
    for (const key of KEYS) {
      const msg = messages[key]?.message;
      if (!msg || !String(msg).trim()) missing.push(`${loc}:${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

check('the audit filter offers the app origin', () => {
  const html = read('../chat/skills.html');
  assert.match(html, /<option value="app" class="i18n">skillRunFilterApp<\/option>/);
  const js = read('../chat/skills.js');
  assert.match(js, /app: 'skillRunApp'/);
});

check('a view is remembered on the message and rebuilt on reload', () => {
  const chat = read('../chat/chat.js');
  // The reference (not the HTML) is what survives the conversation.
  assert.match(chat, /assistantMessageToAdd\.mcpApps = normalizeAppRefs\(pendingAppRefs\)/);
  assert.match(chat, /pendingAppRefs = \[\];/);
  // Reloading a conversation re-mounts the views from those references...
  assert.match(chat, /const refs = normalizeAppRefs\(item\.mcpApps\)/);
  assert.match(chat, /mountAppView\(block, ref, \{ auto: mcpAppAutoRender \}\)/);
  // ...and the document is always re-fetched (a fixed server is picked up).
  assert.match(chat, /async function loadMcpAppDocument\(bridge, ref\)/);
  assert.ok(!/bridge\.html = ref\./.test(chat), 'a stored reference must never carry HTML');
});

check('a view can be rendered on demand instead of automatically', () => {
  const chat = read('../chat/chat.js');
  // The affordance is a small icon in the *message footer* (next to the token
  // line), and with auto-rendering off no card exists until it is clicked.
  assert.match(chat, /<div class="message-footer">/);
  assert.match(chat, /<div class="mcp-app-triggers"><\/div>/);
  assert.match(chat, /function addAppTriggerIcon\(block, ref\)/);
  assert.match(chat, /if \(auto\) createAppCard\(content, ref\);\s*\n\s*else addAppTriggerIcon\(block, ref\);/);
  assert.match(chat, /getMessage\('mcpAppRender'\)/);
  assert.match(chat, /getMessage\('mcpAppHide'\)/);
  // The preference governs *reopened* conversations only: a view produced by the
  // answer being generated right now always renders...
  assert.match(chat, /mountAppView\(block, ref, \{ auto: true \}\)/);
  assert.match(chat, /async function loadChatHistory\(scenarioId, sessionId\) \{[\s\S]{0,500}mcpAppAutoRender = await loadMcpAppAutoRender\(\)/);
  // ...so the switch is read fresh when a conversation is restored (never from a
  // cached value) and kept live while the page stays open.
  assert.match(chat, /changes\[DB_KEY\.mcpAppAutoRender\]/);
  const cllama = read('../js/cllama.js');
  assert.match(cllama, /export async function loadMcpAppAutoRender\(\)/);
  assert.match(cllama, /export async function setMcpAppAutoRender\(enabled\)/);
  assert.match(cllama, /mcpAppAutoRender: "mcpAppAutoRender"/);
  // ...and it is switchable where the MCP servers are configured.
  assert.match(read('../chat/skills.html'), /id="mcpAppAutoRender"/);
  assert.match(read('../chat/skills.js'), /setMcpAppAutoRender\(autoRenderBox\.checked\)/);
});

check('the chosen Skill is remembered per conversation only', () => {
  const chat = read('../chat/chat.js');
  const cllama = read('../js/cllama.js');
  // Storage helpers are keyed by "<scenarioId>:<sessionId>" — the conversation —
  // so nothing becomes a global or scenario-wide default.
  assert.match(cllama, /skillSelection: "skillSelection"/);
  assert.match(cllama, /export async function loadSkillSelection\(sessionKey\)/);
  assert.match(cllama, /export async function saveSkillSelection\(sessionKey, entry\)/);
  assert.match(cllama, /export async function removeSkillSelection\(sessionKey\)/);
  assert.match(chat, /function currentSkillSelection\(\)/);
  assert.match(chat, /saveSkillSelection\(sessionKey\(\), currentSkillSelection\(\)\)/);
  assert.match(chat, /async function applyStoredSkillSelection\(\{ skillsReady = false \} = \{\}\)/);
  // A conversation with no memory resets to "No Skill" instead of inheriting the
  // selection of the conversation that was on screen before.
  assert.match(chat, /if \(!entry\) \{[\s\S]{0,900}skillDisabled = true;/);
  // Persisted on every explicit choice (fixed Skill, Auto, off)...
  assert.equal((chat.match(/persistSkillSelection\(\);/g) || []).length >= 3, true);
  // ...restored when a conversation is shown and once the Skill list is ready...
  assert.match(chat, /applyStoredSkillSelection\(\{ skillsReady: skills\.length > 0 \}\)/);
  assert.match(chat, /await applyStoredSkillSelection\(\{ skillsReady: true \}\)/);
  // ...and cleaned up when the conversation is deleted.
  assert.match(chat, /removeSkillSelection\(`\$\{ccId \|\| '0'\}:\$\{scenarioData\.currentId\}`\)/);
});

check('the shell reports whether inline scripts actually run', () => {
  const shell = read('../viewer/mcp-app.js');
  assert.match(shell, /function probeInlineScripts\(\)/);
  assert.match(shell, /inlineScripts: probeInlineScripts\(\)/);
  // `window.origin` — not `location.origin` — is the opaque-origin test: a
  // sandboxed extension page still reports its chrome-extension:// URL from
  // `location.origin` in Chrome, which made this log field always false.
  assert.match(shell, /sandboxed: window\.origin === 'null'/);
  assert.ok(!/sandboxed: location\.origin/.test(shell), 'the opaque-origin probe must not use location.origin');
  // A frame that cannot run inline scripts must not be fed the document at all:
  // that is exactly the "renders but does nothing" card we must never ship.
  const chat = read('../chat/chat.js');
  assert.match(chat, /data\.inlineScripts === false/);
  assert.match(chat, /'mcpAppInlineBlocked'/);
});

check('the shell reports remote scripts and the host names them on failure', () => {
  const shell = read('../viewer/mcp-app.js');
  // The facts come from the DOM that was actually written, not from the HTML
  // text, and they travel on their own message type.
  assert.match(shell, /function findRemoteScripts\(\)/);
  assert.match(shell, /document\.querySelectorAll\('script\[src\]'\)/);
  assert.match(shell, /postMessage\(\{ type: RENDERED_TYPE, remoteScripts: findRemoteScripts\(\) \}/);
  // `'self'` covers extension-relative paths, so those must not be flagged.
  assert.match(shell, /scheme\.startsWith\('chrome-extension:'\)/);
  assert.match(shell, /scheme\.startsWith\('moz-extension:'\)/);

  const chat = read('../chat/chat.js');
  assert.match(chat, /data\?\.type === MCP_APP_RENDERED_TYPE/);
  assert.match(chat, /bridge\.remoteScripts = Array\.isArray\(data\.remoteScripts\)/);
  // A blocked remote bundle is the named cause; everything else keeps the
  // generic notice, so a working view never shows a misleading message.
  assert.match(chat, /'mcpAppExternalScriptBlocked'/);
  assert.match(chat, /if \(bridge\.remoteScripts\?\.length\) \{/);
  assert.match(chat, /'mcpAppScriptBlocked'/);
});

check('a view that throws says so, and the host reports what it threw', () => {
  // The frame has an opaque origin, so its console cannot be read from the chat
  // page: the shell must hand the error over or "the script never started"
  // stays the only explanation we can offer.
  const shell = read('../viewer/mcp-app.js');
  assert.match(shell, /function reportViewError\(event\)/);
  assert.match(shell, /type: VIEW_ERROR_TYPE/);
  assert.match(shell, /window\.addEventListener\('error', reportViewError\)/);
  assert.match(shell, /window\.addEventListener\('unhandledrejection', reportViewError\)/);
  // Re-registered right after document.open() — which drops window listeners —
  // and again after document.write, like the message listener.
  assert.match(shell, /document\.open\(\);[\s\S]{0,400}registerWindowListeners\(\);[\s\S]{0,200}document\.write\(html\);/);
  assert.match(shell, /registerWindowListeners\(\);\s*\n\s*window\.removeEventListener\('message', onMessage\)/);
  // Capped: a view broken in a loop must not flood the card.
  assert.match(shell, /forwardedErrors >= 3/);

  const chat = read('../chat/chat.js');
  assert.match(chat, /data\?\.type === MCP_APP_VIEW_ERROR_TYPE/);
  assert.match(chat, /if \(!bridge\.viewError\) \{/);
  // The thrown message beats the inferences (remote scripts / CSP), and the
  // notice carries the message through a placeholder.
  assert.match(chat, /if \(bridge\.viewError\) \{[\s\S]{0,500}setCardNoticeText\(bridge\.card, template\.replace\('\{message\}', bridge\.viewError\.message\)\)/);
  assert.match(chat, /browser\.i18n\.getMessage\('mcpAppViewError'\)/);
  assert.match(chat, /function setCardNoticeText\(cardEl, text\)/);
});

check('the shell classifies exactly the scripts the sandbox cannot load', () => {
  // The classification is pure once the DOM query is stubbed, and getting it
  // wrong in either direction is costly: a missed remote bundle leaves the
  // "renders but does nothing" card unexplained, while a false positive would
  // tell a working view that it is broken.
  const shell = read('../viewer/mcp-app.js');
  const fn = shell.match(/function findRemoteScripts\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'the shell must define findRemoteScripts()');

  const probe = (srcs) => new Function('document',
    `${fn[0]}; return findRemoteScripts();`)({
    querySelectorAll: () => srcs.map((s) => ({ getAttribute: () => s }))
  });

  // Blocked: other origins, insecure schemes, and schemes CSP cannot allow.
  assert.deepEqual(probe(['https://cdn.example.com/app.js']), ['https://cdn.example.com/app.js']);
  assert.deepEqual(probe(['//cdn.example.com/b.js']), ['//cdn.example.com/b.js']);
  assert.deepEqual(probe(['http://insecure.example.com/a.js']), ['http://insecure.example.com/a.js']);
  assert.deepEqual(probe(['data:text/javascript,alert(1)']), ['data:text/javascript,alert(1)']);
  assert.deepEqual(probe(['blob:https://x/y']), ['blob:https://x/y']);

  // Allowed: `'self'` covers these, so they must never be reported.
  assert.deepEqual(probe(['mcp-app.js']), []);
  assert.deepEqual(probe(['/js/thing.js']), []);
  assert.deepEqual(probe(['./nested.js']), []);
  assert.deepEqual(probe(['chrome-extension://abcdef/viewer/x.js']), []);
  assert.deepEqual(probe(['moz-extension://abcdef/viewer/x.js']), []);
  assert.deepEqual(probe([]), []);

  // Mixed input keeps the order and drops the harmless entries.
  assert.deepEqual(
    probe(['https://a/1.js', '//b/2.js', 'mcp-app.js', '', null, 'http://c/3.js']),
    ['https://a/1.js', '//b/2.js', 'http://c/3.js']
  );
});

check('the demo app view only sends methods this host implements', () => {
  // tools/mcp-app-demo-server.mjs serves this document; if it ever sends a
  // method the host answers with "Method not supported", the demo would look
  // broken for a reason that has nothing to do with the server.
  const ui = read('./mcp-app-demo-ui.html');
  const known = new Set(Object.values(MCP_APP_METHODS));
  const sent = [...ui.matchAll(/(?:request|notify)\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(sent.length >= 6, `expected the demo to exercise several methods, found ${sent.length}`);
  assert.deepEqual(sent.filter((m) => !known.has(m)), []);
  // The view must make "did my script run?" answerable by looking at it: the
  // static heading says it did NOT, and the script overwrites it.
  assert.match(ui, /script did NOT run/);
  assert.match(ui, /inline script IS running/);
});

check('the demo view declares the UI MIME the host accepts', () => {
  const server = read('./mcp-app-demo-server.mjs');
  assert.match(server, new RegExp(`text/html;profile=mcp-app`));
  assert.ok(MCP_APP_HTML_MIME_PREFIX === 'text/html');
  // The demo must declare a real inline <script>, since that is what the
  // sandbox is being tested for.
  assert.match(read('./mcp-app-demo-ui.html'), /<script>[\s\S]*ui\/initialize/);
});

console.log(`\nAll ${passed} checks passed.`);
