/**
 * Self-check for automatic MCP Skills (js/mcp-skills.mjs) and their wiring.
 *
 *   node tools/mcp-skills.test.mjs
 *
 * The builder is pure, so no browser stub is needed. The last group checks the
 * static wiring in the chat page / Skills page (patterns that are easy to break
 * silently: the derived list is never persisted, and the picker must NOT filter
 * `hidden` Skills or they would become unusable).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const {
  MCP_SKILL_PREFIX, MCP_SKILL_PROMPT_TOOLS_MAX, MCP_SKILL_TOOL_DESC_MAX,
  MCP_SKILL_UI_GROUPS_MAX, MCP_SKILL_UI_GROUP_MIN_TOOLS, MCP_TOOL_DESCRIPTION_MAX,
  buildMcpSkill, buildMcpSkills, buildMcpUiGroupSkills, isDestructiveTool, isMcpSkillId, mcpSkillId,
  mcpToolDescription, mcpUiGroupSkillId, oneLine, serverIdFromSkillId,
  uiGroupLabel, uiResourceOfTool
} = await import('../js/mcp-skills.mjs');
const { registerTool, buildNativeTools, buildToolInstructions } = await import('../js/skill-tools.mjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** Registered-tool shape produced by js/mcp.mjs. */
function mcpTool(serverName, name, extra = {}) {
  return {
    name: `mcp_${serverName}_${name}`,
    serverName,
    sideEffect: 'external',
    description: `${name} of ${serverName}`,
    ...extra
  };
}

const server = { id: 'srv_1', name: 'weather', url: 'http://127.0.0.1:1/mcp', enabled: true, autoSkill: true };
const tools = [
  mcpTool('weather', 'forecast'),
  mcpTool('weather', 'alerts', { annotations: { destructiveHint: true } }),
  mcpTool('other', 'thing')
];

// ------------------- identity -------------------

check('mcpSkillId builds a namespaced id', () => {
  assert.equal(mcpSkillId('srv_1'), 'mcp:srv_1');
  assert.equal(mcpSkillId(7), 'mcp:7');
  assert.equal(mcpSkillId(undefined), 'mcp:');
  assert.equal(MCP_SKILL_PREFIX, 'mcp:');
});

check('isMcpSkillId / serverIdFromSkillId round-trip', () => {
  assert.equal(isMcpSkillId('mcp:srv_1'), true);
  assert.equal(isMcpSkillId('srv_1'), false);
  assert.equal(isMcpSkillId(undefined), false);
  assert.equal(serverIdFromSkillId('mcp:srv_1'), 'srv_1');
  assert.equal(serverIdFromSkillId('general-helper'), null);
  assert.equal(serverIdFromSkillId(null), null);
});

// ------------------- gating -------------------

check('a server without autoSkill produces no Skill', () => {
  assert.equal(buildMcpSkill({ ...server, autoSkill: false }, tools), null);
  const { autoSkill, ...noFlag } = server;
  assert.equal(buildMcpSkill(noFlag, tools), null);
  assert.equal(buildMcpSkill({ ...server, autoSkill: 'yes' }, tools), null);
});

check('a disabled / anonymous server produces no Skill', () => {
  assert.equal(buildMcpSkill({ ...server, enabled: false }, tools), null);
  assert.equal(buildMcpSkill({ ...server, name: '   ' }, tools), null);
  assert.equal(buildMcpSkill({ ...server, id: null }, tools), null);
  assert.equal(buildMcpSkill(null, tools), null);
});

check('a server with no registered tools produces no Skill', () => {
  assert.equal(buildMcpSkill(server, []), null);
  assert.equal(buildMcpSkill(server, [mcpTool('other', 'thing')]), null);
  assert.equal(buildMcpSkill(server, null), null);
});

// ------------------- the derived Skill -------------------

check('the Skill is manual-only, marked hidden and namespaced', () => {
  const skill = buildMcpSkill(server, tools);
  assert.equal(skill.id, 'mcp:srv_1');
  assert.equal(skill.name, 'weather');
  assert.equal(skill.manualOnly, true);
  assert.equal(skill.hidden, true);
  assert.equal(skill.source, 'mcp');
  assert.equal(skill.serverId, 'srv_1');
  assert.equal(skill.serverName, 'weather');
  // Nothing that would write the Skill into storage or pick a fixed model.
  assert.equal(skill.dsService, undefined);
  assert.equal(skill.starter, undefined);
  assert.equal(skill.version, undefined);
});

check("only the server's own tools are included", () => {
  const skill = buildMcpSkill(server, tools);
  const names = skill.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['mcp_weather_alerts', 'mcp_weather_forecast']);
  assert.ok(!names.includes('mcp_other_thing'));
});

check('destructive tools stay callable and are only flagged to the model', () => {
  const skill = buildMcpSkill(server, tools);
  const forecast = skill.tools.find((t) => t.name === 'mcp_weather_forecast');
  const alerts = skill.tools.find((t) => t.name === 'mcp_weather_alerts');
  assert.deepEqual(forecast, { name: 'mcp_weather_forecast' });
  // Annotations are hints, not a block: the confirmation gate is the boundary.
  assert.deepEqual(alerts, { name: 'mcp_weather_alerts' });
  assert.ok(skill.tools.every((t) => t.blocked !== true));
  assert.match(skill.prompt, /may change or delete data/);
  assert.match(skill.prompt, /mcp_weather_alerts/);
});

check('write side effects are flagged too, never blocked', () => {
  const skill = buildMcpSkill(server, [mcpTool('weather', 'wipe', { sideEffect: 'write' })]);
  assert.deepEqual(skill.tools, [{ name: 'mcp_weather_wipe' }]);
  assert.match(skill.prompt, /may change or delete data/);
});

check('isDestructiveTool only reads declared hints', () => {
  assert.equal(isDestructiveTool({ sideEffect: 'external', annotations: { destructiveHint: true } }), true);
  assert.equal(isDestructiveTool({ sideEffect: 'write' }), true);
  assert.equal(isDestructiveTool({ sideEffect: 'external', annotations: { destructiveHint: false } }), false);
  assert.equal(isDestructiveTool({ sideEffect: 'external' }), false);
  assert.equal(isDestructiveTool(null), false);
});

check('description and prompt name the server and its tools (English)', () => {
  const skill = buildMcpSkill(server, tools);
  assert.match(skill.description, /MCP server "weather"/);
  assert.match(skill.description, /mcp_weather_forecast/);
  assert.match(skill.prompt, /You are connected to the MCP server "weather"/);
  assert.match(skill.prompt, /- mcp_weather_forecast: forecast of weather/);
  assert.match(skill.prompt, /Never claim a tool succeeded/);
  // Model-facing text stays English even when the UI language is not.
  assert.ok(!/[\u4e00-\u9fff]/.test(skill.prompt));
});

check('the prompt carries no skill-argument placeholders', () => {
  const skill = buildMcpSkill(
    server,
    [mcpTool('weather', 'forecast', { description: 'costs $1 and $ARGUMENTS' })]
  );
  // applySkillArguments() runs over every Skill prompt, so a server description
  // must not look like a placeholder (it would be substituted or blanked).
  assert.ok(!skill.prompt.includes('$'));
  assert.match(skill.prompt, /costs 1 and ARGUMENTS/);
});

check('oneLine flattens, caps and strips placeholder syntax', () => {
  assert.equal(oneLine('a\n\nb\tc'), 'a b c');
  assert.equal(oneLine('  '), '');
  assert.equal(oneLine(null), '');
  const long = oneLine('x'.repeat(MCP_SKILL_TOOL_DESC_MAX + 20));
  assert.equal(long.length, MCP_SKILL_TOOL_DESC_MAX);
  assert.ok(long.endsWith('…'));
});

check('very large tool lists are summarised in the prompt', () => {
  const many = [];
  for (let i = 0; i < MCP_SKILL_PROMPT_TOOLS_MAX + 3; i++) many.push(mcpTool('weather', `tool_${i}`));
  const skill = buildMcpSkill(server, many);
  assert.equal(skill.tools.length, MCP_SKILL_PROMPT_TOOLS_MAX + 3);
  assert.match(skill.prompt, /3 more tools of this server are available/);
  assert.match(skill.description, /…/);
  assert.ok(!skill.prompt.includes(`mcp_weather_tool_${MCP_SKILL_PROMPT_TOOLS_MAX + 2}`));
});

// ------------------- buildMcpSkills -------------------

check('buildMcpSkills handles several servers and reports why one is skipped', () => {
  const servers = [
    server,
    { id: 'srv_2', name: 'news', url: 'http://x/mcp', enabled: true, autoSkill: true },
    { id: 'srv_3', name: 'nomatch', url: 'http://x/mcp', enabled: true, autoSkill: true },
    { id: 'srv_4', name: 'off', url: 'http://x/mcp', enabled: false, autoSkill: true },
    { id: 'srv_5', name: 'plain', url: 'http://x/mcp', enabled: true }
  ];
  const all = [...tools, mcpTool('news', 'headlines')];
  const { skills, skipped } = buildMcpSkills(servers, all);
  assert.deepEqual(skills.map((s) => s.id), ['mcp:srv_1', 'mcp:srv_2']);
  assert.deepEqual(skipped.map((s) => `${s.server.id}:${s.reason}`), ['srv_3:no-tools', 'srv_4:disabled']);
  // Servers without the flag are not even reported as skipped.
  assert.ok(!skipped.some((s) => s.server.id === 'srv_5'));
});

check('servers sharing a name are skipped instead of pointing at wrong tools', () => {
  const servers = [
    { ...server, id: 'a' },
    { ...server, id: 'b' }
  ];
  const { skills, skipped } = buildMcpSkills(servers, tools);
  assert.deepEqual(skills, []);
  assert.deepEqual(skipped.map((s) => s.reason), ['duplicate-name', 'duplicate-name']);
});

check('buildMcpSkills tolerates junk input', () => {
  assert.deepEqual(buildMcpSkills(null, null), { skills: [], skipped: [] });
  assert.deepEqual(buildMcpSkills([null, undefined, 3], tools).skills, []);
});


// ------------------- UI groups -------------------

/**
 * Registry-tool shape for a server that declares `ui://` resources.
 */
function uiTool(serverName, name, uri, extra = {}) {
  return {
    name: `mcp_${serverName}_${name}`,
    serverName,
    sideEffect: 'external',
    description: `${name} does things`,
    ui: uri ? { resourceUri: uri } : undefined,
    ...extra
  };
}

const uiServer = { id: 'srv_ui', name: 'aaa', url: 'http://x/mcp', enabled: true, autoSkill: true };
const uiTools = [
  uiTool('aaa', 'get_stats', 'ui://aaa/dashboard'),
  uiTool('aaa', 'refresh_stats', 'ui://aaa/dashboard'),
  uiTool('aaa', 'update_item', 'ui://aaa/editor'),
  uiTool('aaa', 'delete_item', 'ui://aaa/editor'),
  uiTool('aaa', 'plain_text')
];

check('UI group ids are derived from the resource URI and stay stable', () => {
  const id = mcpUiGroupSkillId('srv_ui', 'ui://aaa/dashboard');
  assert.match(id, /^mcp:srv_ui:ui:dashboard-[a-z0-9]+$/);
  assert.equal(id, mcpUiGroupSkillId('srv_ui', 'ui://aaa/dashboard'));
  assert.notEqual(id, mcpUiGroupSkillId('srv_ui', 'ui://aaa/editor'));
  // A group id must still resolve back to its server (remembered selections).
  assert.equal(serverIdFromSkillId(id), 'srv_ui');
  assert.equal(uiGroupLabel('ui://aaa/dashboard'), 'dashboard');
  assert.equal(uiGroupLabel('ui://aaa/inbox/'), 'inbox');
  // Most apps ship index.html: the file name must not become the label.
  assert.equal(uiGroupLabel('ui://table/index.html'), 'table');
  assert.equal(uiGroupLabel('ui://chart/index.html'), 'chart');
  assert.equal(uiGroupLabel('ui://aaa/dashboard.html'), 'dashboard');
  assert.equal(uiGroupLabel(''), '');
  assert.equal(uiResourceOfTool({ ui: { resourceUri: 'ui://a/b' } }), 'ui://a/b');
  assert.equal(uiResourceOfTool({}), '');
});

check('a server with several apps gets one Skill per app', () => {
  const groups = buildMcpUiGroupSkills(uiServer, uiTools);
  assert.deepEqual(groups.map((s) => s.name), ['aaa · dashboard', 'aaa · editor']);
  assert.deepEqual(groups.map((s) => s.tools.length), [2, 2]);
  assert.ok(groups.every((s) => s.id.startsWith('mcp:srv_ui:ui:')));
  assert.ok(groups.every((s) => s.manualOnly && s.hidden && s.source === 'mcp'));
  assert.ok(groups.every((s) => !s.tools.some((t) => t.name === 'mcp_aaa_plain_text')));
  assert.match(groups[0].prompt, /covers only the "dashboard" app/);
  assert.match(groups[0].description, /\(app "dashboard"\)/);
});

check('apps that ship index.html still get meaningful group names', () => {
  const apps = [
    uiTool('aaa', 'table_one', 'ui://table/index.html'),
    uiTool('aaa', 'table_two', 'ui://table/index.html'),
    uiTool('aaa', 'chart_one', 'ui://chart/index.html'),
    uiTool('aaa', 'chart_two', 'ui://chart/index.html')
  ];
  const groups = buildMcpUiGroupSkills(uiServer, apps);
  assert.deepEqual(groups.map((s) => s.name), ['aaa · chart', 'aaa · table']);
});

check('a server where only one app has several tools is not split', () => {
  // The "20 tools, many UIs, but each UI has one tool" shape: no benefit.
  const apps = [
    uiTool('aaa', 'table_browser', 'ui://table/index.html'),
    uiTool('aaa', 'chart_card', 'ui://chart/index.html'),
    uiTool('aaa', 'todo_add', 'ui://todo/index.html'),
    uiTool('aaa', 'todo_remove', 'ui://todo/index.html'),
    uiTool('aaa', 'todo_list', 'ui://todo/index.html'),
    uiTool('aaa', 'metrics_dashboard', 'ui://dashboard/index.html')
  ];
  assert.deepEqual(buildMcpUiGroupSkills(uiServer, apps), []);
});

check('UI splitting is skipped when it would not help', () => {
  // One tool per app: nothing to gain over the full set.
  assert.deepEqual(buildMcpUiGroupSkills(uiServer, [
    uiTool('aaa', 'one', 'ui://aaa/x'),
    uiTool('aaa', 'two', 'ui://aaa/y')
  ]), []);
  // A single app for everything: splitting is the same list.
  assert.deepEqual(buildMcpUiGroupSkills(uiServer, [
    uiTool('aaa', 'one', 'ui://aaa/x'),
    uiTool('aaa', 'two', 'ui://aaa/x')
  ]), []);
  // No UI metadata at all.
  assert.deepEqual(buildMcpUiGroupSkills(uiServer, uiTools.filter((t) => !t.ui)), []);
  // Not opted in.
  assert.deepEqual(buildMcpUiGroupSkills({ ...uiServer, autoSkill: false }, uiTools), []);
});

check('the number of group Skills is capped', () => {
  const many = [];
  for (let i = 0; i < MCP_SKILL_UI_GROUPS_MAX + 3; i++) {
    many.push(uiTool('aaa', `a${i}`, `ui://aaa/app${i}`));
    many.push(uiTool('aaa', `b${i}`, `ui://aaa/app${i}`));
  }
  const groups = buildMcpUiGroupSkills(uiServer, many);
  assert.equal(groups.length, MCP_SKILL_UI_GROUPS_MAX);
  assert.ok(MCP_SKILL_UI_GROUP_MIN_TOOLS >= 2);
});

check('buildMcpSkills lists the full set first, then the app groups', () => {
  const { skills } = buildMcpSkills([uiServer], uiTools);
  assert.equal(skills[0].id, 'mcp:srv_ui');
  assert.equal(skills[0].name, 'aaa');
  assert.equal(skills[0].tools.length, uiTools.length);
  assert.deepEqual(skills.slice(1).map((s) => s.name), ['aaa · dashboard', 'aaa · editor']);
});

// ------------------- model-facing description -------------------

check('the tool description adds title, required parameters and hints', () => {
  const text = mcpToolDescription('aaa', {
    name: 'update_item',
    description: 'Updates an item',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, range: { type: 'object' } },
      required: ['id']
    },
    annotations: { title: 'Update item', readOnlyHint: false, destructiveHint: true }
  });
  assert.match(text, /^\[MCP:aaa\] Update item: Updates an item/);
  assert.match(text, /Parameters: id\* \(string\), range \(object\)\./);
  assert.match(text, /\[destructive\]/);
});

check('a top-level tool title wins over annotations.title', () => {
  // Newer MCP servers (and the demo server) put the title here.
  const text = mcpToolDescription('aaa', {
    name: 'table_browser',
    title: 'SQL 结果浏览器',
    description: '以分页表格展示查询结果',
    annotations: { title: 'ignored', readOnlyHint: true }
  });
  assert.match(text, /^\[MCP:aaa\] SQL 结果浏览器: 以分页表格展示查询结果/);
  assert.match(text, /\[read-only\]/);
});

check('the description degrades gracefully and stays bounded', () => {
  assert.equal(mcpToolDescription('aaa', { name: 'x' }), '[MCP:aaa] x');
  // title === description must not repeat the text.
  assert.equal(
    mcpToolDescription('aaa', { name: 'x', description: 'same', annotations: { title: 'same' } }),
    '[MCP:aaa] same'
  );
  const long = mcpToolDescription('aaa', { name: 'x', description: 'y'.repeat(2000) });
  assert.equal(long.length, MCP_TOOL_DESCRIPTION_MAX);
  assert.ok(long.endsWith('…'));
});

// ------------------- Skill-level tool hints -------------------

registerTool({
  name: 'test_hint_tool',
  description: 'does the thing',
  parameters: { type: 'object', properties: {} },
  func: async () => 'ok'
});

check('a Skill tool hint reaches the model on both tool paths', () => {
  const skill = { name: 's', prompt: '', tools: [{ name: 'test_hint_tool', hint: 'use for editing only' }] };
  const native = buildNativeTools(skill);
  assert.equal(native.length, 1);
  assert.match(native[0].function.description, /does the thing — use for editing only/);
  assert.match(buildToolInstructions(skill), /test_hint_tool: does the thing — use for editing only/);
});

check('a tool without a hint keeps its description exactly as before', () => {
  const skill = { name: 's', prompt: '', tools: [{ name: 'test_hint_tool', args: {} }] };
  assert.equal(buildNativeTools(skill)[0].function.description, 'does the thing');
  assert.match(buildToolInstructions(skill), /test_hint_tool: does the thing$/m);
});

// ------------------- wiring -------------------

check('js/mcp.mjs keeps the server annotations for the default block list', () => {
  const mcp = read('js/mcp.mjs');
  assert.match(mcp, /annotations: t\.annotations/);
  // The model-facing description is built by the pure helper (title, required
  // parameters, read-only/destructive hints) instead of a bare string concat.
  assert.match(mcp, /description: mcpToolDescription\(server\.name, t\)/);
  assert.match(mcp, /import \{ mcpToolDescription \} from '\.\/mcp-skills\.mjs'/);
});

check('the chat page derives the Skills and never saves them', () => {
  const chat = read('chat/chat.js');
  assert.match(chat, /import \{ buildMcpSkills, serverIdFromSkillId \} from '\.\.\/js\/mcp-skills\.mjs'/);
  assert.match(chat, /const stored = await loadSkills\(\)/);
  assert.match(chat, /const derived = buildMcpSkills\(servers, listTools\(\)\)/);
  assert.match(chat, /skills = \[\.\.\.stored, \.\.\.mcpSkills\]/);
  // Derived entries must never be written to storage (the Skills page would
  // start listing them, which is exactly what this feature avoids).
  assert.ok(!/saveSkills\s*\(/.test(chat), 'chat.js must not persist the derived list');
});

check('the derived list is rebuilt once MCP registration settles', () => {
  const chat = read('chat/chat.js');
  assert.match(chat, /getMcpReady\(\)\.then\(\(\) => refreshSkills\(\)\)/);
  assert.match(chat, /async function refreshSkills\(\) \{[\s\S]{0,400}initMcpTools\(\)/);
});

check('MCP server config changes rebuild the list and drop a stale Skill', () => {
  const chat = read('chat/chat.js');
  assert.match(chat, /function handleMcpServersStorageChange\(changes, area\) \{[\s\S]{0,300}changes\[DB_KEY\.mcpServers\]/);
  assert.match(chat, /handleMcpServersStorageChange\)/);
  assert.match(chat, /function syncActiveSkillAfterRefresh\(\)/);
  assert.match(chat, /if \(serverId && mcpSkillServerIds\.has\(serverId\)\) \{/);
  assert.match(chat, /mcpSkillServerIds = new Set\(servers/);
});

check('the "/" picker shows the derived Skill with a badge (not filtered out)', () => {
  const chat = read('chat/chat.js');
  assert.match(chat, /const matches = skills\.filter\(/);
  assert.match(chat, /s\.source === 'mcp'/);
  assert.match(chat, /skill-picker-badge/);
  assert.match(chat, /getMessage\("mcpAutoSkillBadge"\)/);
  // `hidden` is a marker only: filtering the picker by it would make the Skill
  // unusable (manual-only Skills have no other entry point).
  assert.ok(!/filter\([^)]*\.hidden/.test(chat), 'the picker must not filter hidden Skills');
  assert.match(read('chat/chat.css'), /\.skill-picker-badge \{/);
});

check('the Skills page exposes the autoSkill switch and marks such servers', () => {
  const html = read('chat/skills.html');
  assert.match(html, /id="mcpAutoSkillInput"/);
  assert.match(html, /mcpAutoSkillHint/);
  const js = read('chat/skills.js');
  assert.match(js, /const autoSkill = document\.getElementById\('mcpAutoSkillInput'\)\.checked/);
  assert.match(js, /existing\.autoSkill = autoSkill/);
  assert.match(js, /enabled, autoSkill \}/);
  assert.match(js, /s\.autoSkill === true/);
});

check('Test connection renders the full tool metadata instead of a count', () => {
  const html = read('chat/skills.html');
  assert.match(html, /id="mcpToolsModal"/);
  assert.match(html, /id="mcpToolsPreview"/);
  assert.match(html, /id="b_copy_mcp_tools"/);
  const js = read('chat/skills.js');
  assert.match(js, /async function showMcpToolsPanel\(server\)/);
  assert.match(js, /function renderMcpToolsPreview\(server, tools\)/);
  assert.match(js, /function formatMcpToolsReport\(server, tools\)/);
  assert.match(js, /function describeToolParams\(tool\)/);
  assert.match(js, /uiResourceOf\(tool\)/);
  assert.match(js, /annotations\.destructiveHint === true/);
  assert.match(js, /await showMcpToolsPanel\(/);
  // The count-only alert is gone: the details are the point of the panel.
  assert.ok(!/mcpTestOk/.test(js), 'the count-only alert must be gone');
  assert.match(read('chat/skills.css'), /\.mcp-tool-item \{/);
});

check('the Skill editor stores and shows a per-tool hint', () => {
  const js = read('chat/skills.js');
  assert.match(js, /tool-hint-input/);
  assert.match(js, /editingTools\[index\]\.hint = hintInput \? hintInput\.value\.trim\(\) : ''/);
  assert.match(js, /if \(item\.hint\) entry\.hint = item\.hint/);
  assert.match(js, /hint: typeof t\.hint === 'string' \? t\.hint : ''/);
  assert.match(js, /editingTools\[index\]\.hint = '';/);
  assert.match(read('js/skill-tools.mjs'), /export function skillToolHint\(entry\)/);
});

check('the confirmation card warns about destructive tools without blocking them', () => {
  const cllama = read('js/cllama.js');
  // The flag is read from the server annotations and stored on the request...
  assert.match(cllama, /destructive: getTool\(info\.tool\)\?\.annotations\?\.destructiveHint === true/);
  assert.match(cllama, /destructive: req\.destructive === true/);
  // ...and rendered as a warning line on the confirm card.
  const chat = read('chat/chat.js');
  assert.match(chat, /if \(pending\.destructive\) \{/);
  assert.match(chat, /getMessage\('toolConfirmDestructive'\)/);
});

check('the new labels exist in every locale', () => {
  const keys = [
    'mcpAutoSkill', 'mcpAutoSkillHint', 'mcpAutoSkillBadge',
    'mcpToolsPreview', 'mcpToolsLoading', 'mcpToolsFound', 'mcpToolsEmpty',
    'mcpToolsFailed', 'mcpToolParams', 'mcpToolNoUi', 'mcpToolReadOnly',
    'mcpToolDestructive', 'skillToolHintPlaceholder', 'toolConfirmDestructive'
  ];
  const dir = new URL('../_locales/', import.meta.url);
  const locales = readdirSync(dir);
  assert.ok(locales.length >= 15, `expected every locale, found ${locales.length}`);
  const missing = [];
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(new URL(`${locale}/messages.json`, dir), 'utf8'));
    for (const key of keys) {
      const message = messages[key]?.message;
      if (!message || !String(message).trim()) missing.push(`${locale}:${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

check('the English hint explains where the Skill can be found', () => {
  const messages = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));
  assert.match(messages.mcpAutoSkillHint.message, /does not appear in the Skill list/);
  assert.match(messages.mcpAutoSkillHint.message, /"\/"/);
  assert.equal(messages.mcpAutoSkillBadge.message, 'MCP');
});

console.log(`\n${passed} checks passed.`);

