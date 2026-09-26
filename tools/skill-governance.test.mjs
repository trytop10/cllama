/**
 * Governance / migration self-check for the Skill & Tool changes.
 *
 * Runs the pure parts of the new behaviour without a browser: a stub `chrome`
 * global satisfies js/browser.mjs and storage is an in-memory map.
 *
 *   node tools/skill-governance.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ------------------- minimal browser stub -------------------
const store = {};
function pick(keys) {
  if (keys == null) return { ...store };
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (typeof k === 'string') out[k] = store[k];
  return out;
}
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = pick(keys);
        if (typeof cb === 'function') { cb(out); return undefined; }
        return Promise.resolve(out);
      },
      set(obj, cb) {
        Object.assign(store, obj);
        if (typeof cb === 'function') { cb(); return undefined; }
        return Promise.resolve();
      },
      remove(keys, cb) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        if (typeof cb === 'function') { cb(); return undefined; }
        return Promise.resolve();
      }
    },
    onChanged: { addListener() {}, removeListener() {} }
  },
  i18n: { getMessage: (k) => k, getUILanguage: () => 'en' },
  runtime: { getURL: (p) => p, openOptionsPage() {} },
  tabs: { query: async () => [], sendMessage: async () => ({}) }
};

const { previewToolArgs, toolNeedsConfirmation, getToolSideEffect, registerTool, listTools, executeToolCall, runTool,
        parseToolCallsDetailed, stripToolCalls } =
  await import('../js/skill-tools.mjs');
const { mergeDefaultSkills, SKILL_DEFAULTS, startSkillRun, recordRunStep, finishSkillRun, loadSkillRuns, clearSkillRuns, DB_KEY,
        collectArtifactDrafts, collectArtifactDraftsDetailed, extractBareJsonObjects, guessArtifactTarget, setPendingArtifact,
        loadPendingArtifact, removePendingDraft, applyArtifact, recordUserAction, recordPageEvent, filterSkillRuns, parseChoiceOptions,
        setPendingChoice, loadPendingChoice, clearPendingChoice } =
  await import('../js/cllama.js');
const { formatBytes, withUiLanguageDirective, UI_LANGUAGE_MARKER } = await import('../js/util.js');

// Audit-trail cap, mirrored here so the test can assert it.
const MAX_SKILL_RUNS = 50;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ------------------- danger is declared by the tool -------------------
check('read-only tools need no confirmation', () => {
  assert.equal(toolNeedsConfirmation('current_time'), false);
  assert.equal(getToolSideEffect('current_time'), 'read');
});

check('external / write tools require confirmation', () => {
  assert.equal(toolNeedsConfirmation('fetch_url'), true);
  assert.equal(getToolSideEffect('fetch_url'), 'external');
  assert.equal(toolNeedsConfirmation('save_skill'), true);
  assert.equal(toolNeedsConfirmation('save_chat_scenario'), true);
  assert.equal(toolNeedsConfirmation('save_insight_action'), true);
});

check('registering an unknown sideEffect level is rejected', () => {
  assert.throws(() => registerTool({ name: 'bad_tool', func: () => '', sideEffect: 'harmless' }));
});

// ------------------- argument previews are redacted -------------------
check('argument previews mask secrets and truncate long values', () => {
  const preview = previewToolArgs({ apiKey: 'sk-secret', prompt: 'x'.repeat(300), n: 3 });
  assert.ok(!preview.includes('sk-secret'), 'apiKey must be masked');
  assert.ok(preview.includes('***'));
  assert.ok(preview.length < 220, `preview should be short, got ${preview.length}`);
  assert.ok(preview.includes('chars)'), 'long values should report their size');
});

check('preview of empty args is empty', () => {
  assert.equal(previewToolArgs({}), '');
  assert.equal(previewToolArgs(null), '');
});

// ------------------- the confirmation gate really blocks -------------------
await checkAsync('a denied confirmation prevents the side effect', async () => {
  let ran = false;
  registerTool({
    name: 'test_write_tool',
    description: 'test',
    sideEffect: 'write',
    func: async () => { ran = true; return 'wrote'; }
  });
  const steps = [];
  const ctx = { requestConfirm: async () => false, onStep: (s) => steps.push(s) };
  const out = await executeToolCall({ name: 'test_write_tool', args: {} }, null, ctx);
  assert.equal(ran, false, 'tool must not run without confirmation');
  assert.ok(out.includes('<success>false</success>'));
  assert.ok(/denied/i.test(out));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].denied, true);
});

await checkAsync('a granted confirmation runs the tool and is audited', async () => {
  let ran = false;
  registerTool({
    name: 'test_write_tool_ok',
    description: 'test',
    sideEffect: 'write',
    func: async () => { ran = true; return 'wrote'; }
  });
  const steps = [];
  const ctx = { requestConfirm: async () => true, onStep: (s) => steps.push(s) };
  const out = await executeToolCall({ name: 'test_write_tool_ok', args: {} }, null, ctx);
  assert.equal(ran, true);
  assert.ok(out.includes('<success>true</success>'));
  assert.equal(steps[0].ok, true);
  assert.ok(typeof steps[0].ms === 'number');
});

await checkAsync('read-only tools run without asking', async () => {
  let asks = 0;
  const steps = [];
  const out = await executeToolCall({ name: 'current_time', args: {} }, null,
    { requestConfirm: async () => { asks++; return true; }, onStep: (s) => steps.push(s) });
  assert.equal(asks, 0);
  assert.ok(out.includes('<success>true</success>'));
  assert.equal(steps[0].ok, true);
});

await checkAsync('the native path applies the same gate', async () => {
  let ran = false;
  registerTool({ name: 'test_native_blocked', description: 't', sideEffect: 'external', func: async () => { ran = true; return 'x'; } });
  const out = await runTool('test_native_blocked', {}, null, { requestConfirm: async () => false, onStep: () => {} });
  assert.equal(ran, false);
  assert.ok(/denied/i.test(out));
});

await checkAsync('a skill whitelist can restrict but never relax the gate', async () => {
  let asks = 0;
  registerTool({ name: 'test_gated', description: 't', sideEffect: 'write', func: async () => 'done' });
  const skill = { name: 'S', tools: [{ name: 'test_gated', args: {} }] };
  // Even though the Skill explicitly lists the tool, the tool's own side effect
  // still forces a confirmation.
  await executeToolCall({ name: 'test_gated', args: {} }, skill,
    { requestConfirm: async () => { asks++; return true; }, onStep: () => {} });
  assert.equal(asks, 1);
  // A tool outside the whitelist is refused before reaching the gate.
  const res = await executeToolCall({ name: 'fetch_url', args: {} }, skill,
    { requestConfirm: async () => { asks++; return true; }, onStep: () => {} });
  assert.ok(res.includes('not allowed'));
  assert.equal(asks, 1);
});

// ------------------- audit trail -------------------
await checkAsync('runs are recorded with steps, duration and status', async () => {
  await clearSkillRuns();
  const run = startSkillRun({ skillId: 'x', skillName: 'X', model: 'm', service: 'ollama', sessionId: '1' });
  await recordRunStep(run, { tool: 'current_time', ok: true, ms: 12, args: {} });
  await recordRunStep(run, { tool: 'save_skill', ok: false, ms: 30, args: { apiKey: 'secret' }, error: 'boom' });
  await finishSkillRun(run);

  const runs = await loadSkillRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].skillName, 'X');
  assert.equal(runs[0].model, 'm');
  assert.equal(runs[0].steps.length, 2);
  assert.ok(typeof runs[0].duration === 'number');
  assert.equal(runs[0].steps[0].tool, 'current_time');
  assert.equal(runs[0].steps[1].error, 'boom');
  // Metadata only: no secret value may end up in the trail.
  assert.ok(!JSON.stringify(runs).includes('secret'));
  await clearSkillRuns();
  assert.equal((await loadSkillRuns()).length, 0);
});

// ------------------- built-in skill version migration -------------------
check('defaults carry a version', () => {
  for (const def of SKILL_DEFAULTS) {
    assert.ok(Number.isInteger(def.version) && def.version >= 1, `${def.id} is missing a version`);
  }
});

check('a new built-in is merged into an existing list', () => {
  const stored = [{ id: 'mine', name: 'Mine', prompt: 'p' }];
  const merged = mergeDefaultSkills(stored, []);
  assert.equal(merged[0].id, 'mine');
  for (const def of SKILL_DEFAULTS) {
    assert.ok(merged.some((s) => String(s.id) === String(def.id)), `${def.id} should have been merged in`);
  }
});

check('a deleted built-in stays deleted', () => {
  const merged = mergeDefaultSkills([], [String(SKILL_DEFAULTS[0].id)]);
  assert.ok(!merged.some((s) => String(s.id) === String(SKILL_DEFAULTS[0].id)));
});

check('an unmodified older copy is upgraded in place', () => {
  const def = SKILL_DEFAULTS.find((d) => d.id === 'date-time');
  const original = def.version;
  def.version = original + 1; // simulate a newer shipped version
  try {
    const older = { ...def, version: original, prompt: `${def.prompt}\n\nold extra line` };
    const merged = mergeDefaultSkills([older, { id: 'mine', name: 'Mine', prompt: 'x' }], []);
    const upgraded = merged.find((s) => s.id === 'date-time');
    assert.equal(upgraded.version, def.version, 'version should be bumped');
    assert.equal(upgraded.prompt, def.prompt, 'shipped prompt should be restored');
    assert.equal(merged[0].id, 'date-time', 'position is preserved');
  } finally {
    def.version = original;
  }
});

check('a user-edited copy is never overwritten', () => {
  const def = SKILL_DEFAULTS.find((d) => d.id === 'date-time');
  const edited = { ...def, version: def.version - 1, prompt: 'MY OWN PROMPT' };
  const merged = mergeDefaultSkills([edited], []);
  const kept = merged.find((s) => s.id === 'date-time');
  assert.equal(kept.prompt, 'MY OWN PROMPT');
  assert.equal(kept.version, def.version - 1);
});

check('migration is idempotent', () => {
  const first = mergeDefaultSkills([{ id: 'mine', name: 'Mine', prompt: 'p' }], []);
  const second = mergeDefaultSkills(first, []);
  assert.deepEqual(second.map((s) => s.id), first.map((s) => s.id));
});

check('legacy data without version fields still loads', () => {
  const legacy = [{ id: 'general-helper', name: 'n', description: 'd', prompt: 'p', tools: [] }];
  const merged = mergeDefaultSkills(legacy, []);
  assert.ok(merged.length >= legacy.length);
});

// ------------------- conversation builder (chat -> artifact) -------------------

check('conversation-builder may only run on request and never writes by itself', () => {
  const def = SKILL_DEFAULTS.find((d) => d.id === 'conversation-builder');
  assert.ok(def, 'conversation-builder must be a built-in Skill');
  assert.equal(def.manualOnly, true, 'Auto mode must not adopt it on its own');
  assert.equal(def.uiLanguage, true, 'its output must follow the interface language');
  assert.ok(def.starter, 'it needs a starter so "/name" prefills the request');
  assert.ok(!def.usePage, 'it works on the conversation, not on the current webpage');

  const names = def.tools.map((t) => t.name || t).sort();
  assert.deepEqual(names, ['ask_user_choice', 'list_tools', 'propose_artifact']);
  assert.ok(!names.some((n) => n.startsWith('save_')),
    'it must not own a write tool: importing stays a user click on a card');
  assert.ok(!def.prompt.includes('get_page_content'),
    'it must not depend on the webpage (that is page-builder\'s job)');
});

check('conversation-builder accepts "nothing to extract" as a complete answer', () => {
  const def = SKILL_DEFAULTS.find((d) => d.id === 'conversation-builder');
  assert.match(def.prompt, /Not suitable/);
  assert.match(def.prompt, /Output no numbered list and no JSON/);
  assert.match(def.prompt, /Never invent, embellish or pad/);
  assert.match(def.prompt, /choose "Not suitable"/);
  // Learned notes are the Reflect button's job (they need a scenario id).
  assert.match(def.prompt, /Do not draft learned notes/);
});

check('withUiLanguageDirective appends the interface language to a prompt', () => {
  const out = withUiLanguageDirective('You are X.', 'zh-CN');
  assert.ok(out.startsWith('You are X.'), 'the prompt must be kept, not replaced');
  assert.ok(out.includes(UI_LANGUAGE_MARKER), 'the marker line is missing');
  assert.ok(out.includes('zh-CN'), 'the language code is missing');
  for (const field of ['name', 'description', 'sample', 'starter']) {
    assert.ok(out.includes(`"${field}"`), `the directive should mention "${field}"`);
  }
});

check('withUiLanguageDirective is idempotent', () => {
  const once = withUiLanguageDirective('p', 'zh-CN');
  assert.equal(withUiLanguageDirective(once, 'fr'), once);
});

check('withUiLanguageDirective tolerates an empty prompt or language', () => {
  assert.equal(withUiLanguageDirective('p', ''), 'p');
  assert.equal(withUiLanguageDirective('', ''), '');
  assert.equal(withUiLanguageDirective('', 'en'), withUiLanguageDirective(undefined, 'en'));
});

check('a "Not suitable" answer produces no cards at all', () => {
  const answer = 'Not suitable: this is a single question and answer, there is nothing reusable here.';
  assert.deepEqual(parseChoiceOptions(answer), [], 'no clickable option list');
  const { drafts, rejected } = collectArtifactDraftsDetailed(answer);
  assert.equal(drafts.length, 0, 'no import card');
  assert.equal(rejected.length, 0, 'nothing to report as rejected either');
});

check('a draft the model emits after picking becomes a card', () => {
  const answer = 'Here is the draft:\n```json\n{"target":"recipe","name":"摘要","prompt":"Summarise the page."}\n```';
  const { drafts } = collectArtifactDraftsDetailed(answer);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].target, 'recipe');
  assert.equal(drafts[0].name, '摘要');
});

// ------------------- pending cards belong to one conversation -------------------
// A list the model displayed in scenario A must never be re-rendered as a question
// inside scenario B, and answering it in words (instead of clicking) must consume it.

await checkAsync('an option list is stamped with the conversation it was asked in', async () => {
  await setPendingChoice([{ title: 'One' }, { title: 'Two' }], 'Pick', '5:2');
  const pending = await loadPendingChoice();
  assert.equal(pending.sessionKey, '5:2');
  // Clearing from another conversation must not delete it.
  await clearPendingChoice('9:1');
  assert.ok(await loadPendingChoice(), 'a foreign clear must leave the list alone');
  await clearPendingChoice('5:2');
  assert.equal(await loadPendingChoice(), null);
});

await checkAsync('a legacy list without a session key still clears unconditionally', async () => {
  await setPendingChoice([{ title: 'One' }, { title: 'Two' }]);
  assert.equal((await loadPendingChoice()).sessionKey, undefined);
  await clearPendingChoice('9:1');
  assert.equal(await loadPendingChoice(), null);
});

await checkAsync('draft cards carry the conversation that produced them', async () => {
  await setPendingArtifact(
    [{ target: 'recipe', payload: { name: '摘要', prompt: 'Summarise.' }, name: '摘要' }], [], '5:2');
  assert.equal((await loadPendingArtifact()).sessionKey, '5:2');
  await removePendingDraft(0);
  assert.equal(await loadPendingArtifact(), null);
});

await checkAsync('ask_user_choice stamps the list from the turn context', async () => {
  await executeToolCall(
    { name: 'ask_user_choice', args: { options: [{ title: 'One' }, { title: 'Two' }] } },
    null,
    { sessionKey: '3:7', requestConfirm: async () => true, onStep: () => {} });
  assert.equal((await loadPendingChoice()).sessionKey, '3:7');
  await clearPendingChoice('3:7');
});

await checkAsync('propose_artifact stamps the cards from the turn context', async () => {
  await executeToolCall(
    { name: 'propose_artifact', args: { target: 'recipe', payload: { name: '摘要', prompt: 'Summarise.' } } },
    null,
    { sessionKey: '3:7', requestConfirm: async () => true, onStep: () => {} });
  assert.equal((await loadPendingArtifact()).sessionKey, '3:7');
  await removePendingDraft(0);
});

check('governance storage keys exist in DB_KEY', () => {
  for (const key of ['pendingToolConfirm', 'toolGrants', 'skillRuns']) {
    assert.equal(typeof DB_KEY[key], 'string');
  }
});

check('tool registry has no duplicate names', () => {
  const names = listTools().map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

// ------------------- artifact import (page -> user-confirmed import) -------------------
check('drafts are collected from json blocks', () => {
  const answer = '1. 代码评审 — Skill\n\n```json\n' +
    JSON.stringify({ name: 'CodeReview', description: 'd', prompt: 'p', tools: [{ name: 'current_time', args: {} }] }) +
    '\n```\n\n```json\n' + JSON.stringify({ name: '写作助手', prompt: 'p', sample: 'hi' }) + '\n```';
  const { drafts, rejected } = collectArtifactDraftsDetailed(answer);
  assert.equal(rejected.length, 0);
  assert.deepEqual(drafts.map((d) => d.target), ['skill', 'scenario']);
  assert.deepEqual(collectArtifactDrafts(answer).map((d) => d.name), ['CodeReview', '写作助手']);
});

check('an over-long recipe name is reported instead of dropped', () => {
  const block = '```json\n' + JSON.stringify({ target: 'recipe', name: 'KeyPointExtraction', prompt: 'p' }) + '\n```';
  const { drafts, rejected } = collectArtifactDraftsDetailed(block);
  assert.equal(drafts.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /too long/i);
  assert.ok(rejected[0].raw.includes('KeyPointExtraction'));
});

check('without a declared target a long name falls back to a scenario', () => {
  const { drafts, rejected } = collectArtifactDraftsDetailed('```json\n' + JSON.stringify({ name: 'KeyPointExtraction', prompt: 'p' }) + '\n```');
  assert.equal(rejected.length, 0);
  assert.deepEqual(drafts.map((d) => d.target), ['scenario']);
});

check('an unparsable json block is reported with the parse error', () => {
  const { rejected } = collectArtifactDraftsDetailed('```json\n{ "name": "X", }\n```');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /invalid JSON/i);
});

check('an explicit target from the model wins over the heuristics', () => {
  assert.equal(guessArtifactTarget({ target: 'recipe', name: 'KeyPointExtraction', prompt: 'p' }), 'recipe');
  assert.equal(guessArtifactTarget({ type: 'skill', name: 'X', prompt: 'p' }), 'skill');
  assert.equal(guessArtifactTarget({ name: 'X', prompt: 'p', sample: 's' }), 'scenario');
  assert.equal(guessArtifactTarget({ name: 'X', prompt: 'p', description: 'd' }), 'skill');
});

await checkAsync('all-rejected proposals still show up (no silent empty card)', async () => {
  await setPendingArtifact([], [{ name: 'Bad', target: 'recipe', reason: 'too long', raw: '{}' }]);
  const pending = await loadPendingArtifact();
  assert.ok(pending, 'a rejected-only proposal must still be visible');
  assert.equal(pending.drafts.length, 0);
  assert.equal(pending.rejected.length, 1);
  // Removing the (non-existent) draft must keep the rejected entry visible.
  await removePendingDraft(0);
  assert.equal((await loadPendingArtifact()).rejected.length, 1);
  await globalThis.chrome.storage.local.remove(DB_KEY.pendingArtifact);
});

await checkAsync('a duplicate name is refused, and overwrite succeeds', async () => {
  const first = await applyArtifact('recipe', { name: '要点提炼', prompt: 'p' });
  assert.equal(first.ok, true);
  const again = await applyArtifact('recipe', { name: '要点提炼', prompt: 'p2' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'exists');
  const forced = await applyArtifact('recipe', { name: '要点提炼', prompt: 'p2' }, { overwrite: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.action, 'updated');
});

// ------------------- tool-call text protocol (tolerant parsing) -------------------
check('the canonical tool_call shape is parsed', () => {
  const { calls, malformed } = parseToolCallsDetailed('<tool_call><tool_name>list_tools</tool_name><args>{}</args></tool_call>');
  assert.equal(malformed.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_tools');
});

check('an OpenAI-style JSON tool_call body is parsed', () => {
  const variants = [
    '{"name":"list_tools","arguments":{}}',
    '{"tool_name":"list_tools","args":{"a":1}}',
    '{"function":{"name":"list_tools","arguments":"{\\"b\\":2}"}}'
  ];
  for (const body of variants) {
    const { calls, malformed } = parseToolCallsDetailed(`<tool_call>${body}</tool_call>`);
    assert.equal(malformed.length, 0, body);
    assert.equal(calls.length, 1, body);
    assert.equal(calls[0].name, 'list_tools', body);
  }
});

check('a tool_call without its closing tag is still parsed', () => {
  const { calls, malformed } = parseToolCallsDetailed('<tool_call><tool_name>current_time</tool_name><args>{}</args>');
  assert.equal(malformed.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'current_time');
});

check('an unreadable tool_call is reported instead of dropped', () => {
  const { calls, malformed } = parseToolCallsDetailed('<tool_call>call list_tools please</tool_call>');
  assert.equal(calls.length, 0);
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].raw, /call list_tools please/);
});

check('unparsable <args> are reported while the call still runs', () => {
  const { calls } = parseToolCallsDetailed('<tool_call><tool_name>current_time</tool_name><args>{broken}</args></tool_call>');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]._parseError, 'the args problem must be reported to the model');
});

check('stripToolCalls removes readable blocks and keeps unreadable ones', () => {
  assert.equal(stripToolCalls('done<tool_call><tool_name>x</tool_name><args>{}</args></tool_call>'), 'done');
  const kept = stripToolCalls('<tool_call>not a call</tool_call>');
  assert.ok(kept.includes('not a call'), 'an unrecognized block stays visible so the user can see it');
});

// ------------------- bare JSON fallback -------------------
check('bare json objects are found outside fences only', () => {
  const text = 'here you go {"name":"A配方","prompt":"p"} and\n```\n{"ignored":true}\n```';
  const objects = extractBareJsonObjects(text);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].name, 'A配方');
});

check('an unfenced draft still becomes a card', () => {
  const { drafts, rejected } = collectArtifactDraftsDetailed('草案：{"name":"要点提炼","prompt":"提炼要点"}');
  assert.equal(rejected.length, 0);
  assert.deepEqual(drafts.map((d) => d.target), ['recipe']);
});

check('nested braces and braces inside strings do not break the scan', () => {
  const text = 'x {"name":"T","prompt":"use {braces} here","tools":[{"name":"current_time","args":{}}]} y';
  const objects = extractBareJsonObjects(text);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].name, 'T');
  assert.equal(objects[0].tools.length, 1);
});

// ------------------- OpenAI-compatible client: native tool calls -------------------
await checkAsync('the OpenAI-compatible client accumulates streamed tool_calls', async () => {
  const { ChatGPTClient } = await import('../js/client/chatgpt-client.mjs');
  const client = new ChatGPTClient({ endpoint: 'https://example.test/v1/chat/completions', apiKey: 'k' });

  // Build the SSE frames programmatically so the escaping is unambiguous.
  const frame = (delta, finishReason) => 'data: ' + JSON.stringify({
    choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }]
  });
  const sse = [
    frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_', arguments: '{"a"' } }] }),
    frame({ tool_calls: [{ index: 0, function: { name: 'tools', arguments: ':1}' } }] }),
    frame({}, 'tool_calls'),
    'data: [DONE]',
    ''
  ].join('\n');
  const bytes = new TextEncoder().encode(sse);
  let sent = false;
  const response = {
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes })),
        cancel: async () => {}
      })
    }
  };

  const result = await new Promise((resolve, reject) => {
    // _processStreamResponse expects an in-flight session (sendRequest registers
    // it before calling); without it the read loop cancels immediately.
    client.activeSessions.set('s1', new AbortController());
    client._processStreamResponse(response, 's1', {
      onComplete: (text, sessionId, toolCalls) => resolve({ text, sessionId, toolCalls }),
      onError: reject
    }).catch(reject);
  });

  assert.equal(result.sessionId, 's1');
  assert.equal(result.toolCalls.length, 1, 'the previously dropped tool call is delivered');
  assert.equal(result.toolCalls[0].function.name, 'list_tools', 'name fragments are concatenated');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).a, 1);
});

await checkAsync('a blank completion is logged instead of staying silent', async () => {
  const { ChatGPTClient } = await import('../js/client/chatgpt-client.mjs');
  const client = new ChatGPTClient({ endpoint: 'https://example.test/v1/chat/completions', apiKey: 'k' });
  const sse = ['data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]', ''].join('\n');
  const bytes = new TextEncoder().encode(sse);
  let sent = false;
  const response = {
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes })),
        cancel: async () => {}
      })
    }
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const result = await new Promise((resolve, reject) => {
      client.activeSessions.set('s2', new AbortController());
      client._processStreamResponse(response, 's2', {
        onComplete: (text, sessionId, toolCalls) => resolve({ text, toolCalls }),
        onError: reject
      }).catch(reject);
    });
    assert.equal(result.text, '');
    assert.deepEqual(result.toolCalls, []);
    assert.ok(warnings.some((w) => String(w[0]).includes('empty completion')), 'the empty answer is logged');
  } finally {
    console.warn = originalWarn;
  }
});

// ------------------- audit trail: user actions & page events -------------------
await checkAsync('a user-confirmed import is recorded with its origin', async () => {
  await clearSkillRuns();
  await recordUserAction({ action: 'import', target: 'recipe', name: '要点提炼', ok: true, sessionId: '3', detail: 'created' });

  const runs = await loadSkillRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].origin, 'user');
  assert.equal(runs[0].action, 'import');
  assert.equal(runs[0].status, 'ok');
  assert.equal(runs[0].target, 'recipe');
  assert.equal(runs[0].name, '要点提炼');
  assert.equal(runs[0].sessionId, '3');
  assert.equal(runs[0].steps.length, 1);
  assert.equal(runs[0].steps[0].tool, 'import');
  assert.ok(runs[0].steps[0].argsPreview.includes('要点提炼'), 'the target/name must be traceable');
  await clearSkillRuns();
});

await checkAsync('a refused import is recorded as failed with its reason', async () => {
  await clearSkillRuns();
  await recordUserAction({ action: 'import', target: 'skill', name: 'CodeReview', ok: false, error: 'already exists' });
  const runs = await loadSkillRuns();
  assert.equal(runs[0].origin, 'user');
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].steps[0].ok, false);
  assert.match(runs[0].steps[0].error, /already exists/);
  await clearSkillRuns();
});

await checkAsync('a page event (drafts parsed from the answer) is recorded', async () => {
  await clearSkillRuns();
  await recordPageEvent({ action: 'parse_drafts', count: 2, ok: true, sessionId: '3' });
  const runs = await loadSkillRuns();
  assert.equal(runs[0].origin, 'page');
  assert.equal(runs[0].action, 'parse_drafts');
  assert.equal(runs[0].count, 2);
  assert.equal(runs[0].status, 'ok');
  await clearSkillRuns();
});

await checkAsync('model runs keep origin=model and the trail stays capped', async () => {
  await clearSkillRuns();
  const run = startSkillRun({ skillName: 'X' });
  assert.equal(run.origin, 'model');
  await recordRunStep(run, { tool: 'current_time', ok: true, ms: 1, args: {} });
  await finishSkillRun(run);
  assert.equal((await loadSkillRuns())[0].origin, 'model');

  // 60 records must still be trimmed to the 50-record cap.
  for (let i = 0; i < 60; i++) {
    await recordUserAction({ action: 'import', target: 'recipe', name: `R${i}`, ok: true });
  }
  const runs = await loadSkillRuns();
  assert.equal(runs.length, MAX_SKILL_RUNS, `cap must hold, got ${runs.length}`);
  assert.equal(runs[runs.length - 1].name, 'R59', 'the newest record is kept');
  assert.notEqual(runs[0].name, undefined, 'old entries keep their shape');
  await clearSkillRuns();
});

// ------------------- audit-trail filters -------------------
check('the audit filter understands source, status, Skill and free text', () => {
  const runs = [
    { id: 'a', origin: 'model', skillName: '页面提炼器', status: 'ok', steps: [{ tool: 'list_tools', ok: true }] },
    { id: 'b', origin: 'user', action: 'import', status: 'ok', steps: [{ tool: 'import', ok: true, argsPreview: '{"name":"要点提炼"}' }] },
    { id: 'c', origin: 'user', action: 'import', status: 'failed', steps: [{ tool: 'import', ok: false, error: 'already exists' }] },
    { id: 'd', origin: 'page', action: 'parse_drafts', status: 'ok', count: 2, steps: [{ tool: 'parse_drafts', ok: true }] },
    { id: 'e', origin: 'model', skillName: '日期与时间', status: 'failed', steps: [{ tool: 'fetch_url', ok: false, error: 'boom' }] }
  ];

  // No filter: everything, order preserved.
  assert.deepEqual(filterSkillRuns(runs, {}).map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(filterSkillRuns(runs, { origin: 'all', status: 'all', skill: 'all', query: '' }).map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);

  // Source.
  assert.deepEqual(filterSkillRuns(runs, { origin: 'user' }).map((r) => r.id), ['b', 'c']);
  assert.deepEqual(filterSkillRuns(runs, { origin: 'page' }).map((r) => r.id), ['d']);

  // Status ("what went wrong?" is the point of this list).
  assert.deepEqual(filterSkillRuns(runs, { status: 'failed' }).map((r) => r.id), ['c', 'e']);
  assert.deepEqual(filterSkillRuns(runs, { status: 'ok' }).map((r) => r.id), ['a', 'b', 'd']);

  // Skill.
  assert.deepEqual(filterSkillRuns(runs, { skill: '日期与时间' }).map((r) => r.id), ['e']);

  // Free text: tool name, argument preview and error text are all searchable.
  assert.deepEqual(filterSkillRuns(runs, { query: 'fetch_url' }).map((r) => r.id), ['e']);
  assert.deepEqual(filterSkillRuns(runs, { query: '要点提炼' }).map((r) => r.id), ['b']);
  assert.deepEqual(filterSkillRuns(runs, { query: 'BOOM' }).map((r) => r.id), ['e']);

  // Combined.
  assert.deepEqual(filterSkillRuns(runs, { origin: 'model', status: 'failed' }).map((r) => r.id), ['e']);
  assert.deepEqual(filterSkillRuns(runs, { origin: 'user', status: 'failed', query: 'exists' }).map((r) => r.id), ['c']);
  assert.deepEqual(filterSkillRuns(runs, { origin: 'page', query: 'nothing' }).length, 0);
});

check('filterSkillRuns treats legacy records as model runs', () => {
  const legacy = [{ id: 'old', status: 'ok', steps: [] }];
  assert.deepEqual(filterSkillRuns(legacy, { origin: 'model' }).map((r) => r.id), ['old']);
  assert.deepEqual(filterSkillRuns(legacy, { origin: 'user' }).length, 0);
});

// ------------------- storage readout & quota permission -------------------
check('formatBytes renders readable sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(formatBytes(1.25 * 1024 * 1024), '1.3 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
  assert.equal(formatBytes(-1), '');
  assert.equal(formatBytes('nope'), '');
});

check('every manifest requests unlimitedStorage (all platforms)', () => {
  const files = ['manifest.json', 'manifest.firefox.json', 'manifest.android.json'];
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes('storage'),
      `${file} must keep the storage permission`);
    assert.ok(manifest.permissions.includes('unlimitedStorage'),
      `${file} must request unlimitedStorage so local data is not capped at the default quota`);
  }
});

console.log(`\n${passed} checks passed.`);
