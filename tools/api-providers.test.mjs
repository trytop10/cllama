/**
 * Self-check for the API provider catalogue and the pure helpers behind the
 * provider list (option/options.js).
 *
 *   node tools/api-providers.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROVIDER_TYPES,
  MODEL_TYPES,
  getProviderMeta,
  providerLabel,
  modelTypeLabel,
  newApiEntryId,
  apiEntryId,
  apiEntryLabel,
  apiEntryDisplay,
  resolveApiEntry,
  findDefaultEntry,
  normalizeApiEntry,
  normalizeApiList,
  entryFromConfig,
  isDefaultEntry,
  migrateLegacyReferences
} from '../js/api-providers.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const translate = (key) => ({
  apiProviderOllama: 'Ollama (local)',
  apiProviderCompatible: 'OpenAI-compatible API',
  modelTypeText: 'Text generation model',
  modelTypeDecision: 'Decision model',
  modelTypeImage: 'Image generation model'
}[key] || '');

check('provider keys keep the historic routing values', () => {
  const services = PROVIDER_TYPES.map((item) => item.service);
  assert.deepEqual(services, ['ollama', 'OpenAI', 'Google', 'DeepSeek', 'Qwen', 'ZhiPu', 'Other']);
  // "Other" is stored as-is; only the label is friendlier.
  assert.equal(PROVIDER_TYPES.find((item) => item.service === 'Other').labelKey, 'apiProviderCompatible');
});

check('model kinds cover text generation, decision and image generation', () => {
  assert.deepEqual(MODEL_TYPES.map((item) => item.value), ['text', 'decision', 'image']);
});

check('labels are localised and unknown providers fall back to their key', () => {
  assert.equal(providerLabel('ollama', translate), 'Ollama (local)');
  assert.equal(providerLabel('Other', translate), 'OpenAI-compatible API');
  assert.equal(providerLabel('Test', translate), 'Test');
  assert.equal(providerLabel('', translate), '');
});

check('unknown legacy providers keep their editing defaults', () => {
  assert.equal(getProviderMeta('Test').protocol, 'gemini');
  assert.equal(getProviderMeta('Claude').protocol, 'openai');
  assert.equal(getProviderMeta('ollama').protocol, 'ollama');
});

check('model type labels cover the three current kinds and legacy values map to text', () => {
  assert.equal(modelTypeLabel('text', translate), 'Text generation model');
  assert.equal(modelTypeLabel('decision', translate), 'Decision model');
  assert.equal(modelTypeLabel('image', translate), 'Image generation model');
  assert.equal(modelTypeLabel('chat', translate), 'Text generation model');
  assert.equal(modelTypeLabel('reasoning', translate), 'Text generation model');
  assert.equal(modelTypeLabel('nope', translate), 'Text generation model');
});

check('normalization fills defaults without touching unknown ones', () => {
  const out = normalizeApiEntry({
    service: 'OpenAI',
    apiUrl: '  https://api.openai.com/v1  ',
    apiKey: 'sk',
    modelName: ' gpt-4o ',
    custom: 'keep-me'
  });
  assert.equal(out.apiUrl, 'https://api.openai.com/v1');
  assert.equal(out.modelName, 'gpt-4o');
  assert.equal(out.modelType, 'text');
  assert.equal(out.custom, 'keep-me');
});

check('normalization drops the legacy name and maps capability flags / model types', () => {
  const out = normalizeApiEntry({
    id: '  entry-1  ',
    name: '  My API  ',
    service: 'Qwen',
    modelType: 'reasoning',
    multimodal: true,
    supportsTools: false
  });
  assert.equal(out.id, 'entry-1');
  // The data model has no display name any more: identity is the id, the label
  // is provider type + model (legacy references are migrated once).
  assert.equal('name' in out, false);
  assert.equal(out.multimodal, true);
  assert.equal('supportsTools' in out, false); // false/undefined = auto detection
  assert.equal(out.modelType, 'text');

  assert.equal(normalizeApiEntry({ service: 'Qwen', modelType: 'decision' }).modelType, 'decision');
  assert.equal(normalizeApiEntry({ service: 'Qwen', modelType: 'image' }).modelType, 'image');
  assert.equal(normalizeApiEntry({ service: 'Qwen', modelType: 'video' }).modelType, 'text');
  assert.equal(normalizeApiEntry({ service: 'Qwen', supportsTools: true }).supportsTools, true);
  assert.equal('supportsTools' in normalizeApiEntry({ service: 'Qwen', supportsTools: false }), false);
});

check('entryFromConfig migrates base-only data and carries identity', () => {
  const entry = entryFromConfig({
    dsId: 'base-entry',
    dsName: 'My provider',
    service: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/chat/completions',
    apiKey: 'k',
    modelName: 'deepseek-chat',
    modelType: 'reasoning',
    multimodal: true,
    supportsTools: true,
    maxTokens: 30000
  });
  assert.equal(entry.id, 'base-entry');
  assert.equal('name' in entry, false);
  assert.equal(entry.service, 'DeepSeek');
  assert.equal(entry.modelType, 'text');
  assert.equal(entry.multimodal, true);
  assert.equal(entry.supportsTools, true);
  assert.equal('maxTokens' in entry, false); // only provider fields travel

  assert.equal(entryFromConfig({ service: 'Qwen' }, 'explicit-id').id, 'explicit-id');
  assert.equal(entryFromConfig({ apiUrl: 'x' }), null);
});

check('normalizeApiList keeps several configs per provider and assigns stable ids', () => {
  const list = normalizeApiList([
    null,
    { service: 'OpenAI', modelName: 'a' },
    { service: 'OpenAI', modelName: 'b' },
    { service: 'ollama', modelName: 'llama3' },
    { apiUrl: 'no-service' }
  ]);
  assert.deepEqual(list.map((item) => item.service), ['OpenAI', 'OpenAI', 'ollama']);
  assert.deepEqual(list.map((item) => item.id), ['svc:OpenAI', 'svc:OpenAI:2', 'svc:ollama']);
  assert.equal(list[1].modelName, 'b');

  const explicit = normalizeApiList([
    { id: 'x', service: 'Other', modelName: 'a' },
    { id: 'x', service: 'Other', modelName: 'b' }
  ]);
  assert.deepEqual(explicit.map((item) => item.id), ['x', 'x:2']);
  assert.deepEqual(normalizeApiList(null), []);
});

check('entry ids and dropdown labels distinguish same-provider configs by model', () => {
  const list = normalizeApiList([
    { id: 'a', name: 'Legacy display name', service: 'Other', modelName: 'gpt-4o' },
    { id: 'b', service: 'Other', modelName: 'claude' },
    { service: 'ollama', modelName: 'llama3' }
  ]);

  assert.equal(apiEntryId(list[0]), 'a');
  assert.equal(apiEntryId(list[1]), 'b');
  // The legacy name is not part of the stored data model any more.
  assert.equal('name' in list[0], false);
  assert.equal(apiEntryLabel(list[0], translate), 'OpenAI-compatible API');
  assert.equal(apiEntryLabel(list[1], translate), 'OpenAI-compatible API');
  assert.equal(apiEntryDisplay(list[0], translate), 'OpenAI-compatible API · gpt-4o');
  assert.equal(apiEntryDisplay(list[1], translate), 'OpenAI-compatible API · claude');

  assert.equal(resolveApiEntry(list, 'b'), list[1]);
  assert.equal(resolveApiEntry(list, 'a'), list[0]);
  // Legacy values may still store the service key (`@deepseek`, old backups).
  assert.equal(resolveApiEntry(list, 'Other'), list[0]);
  assert.equal(resolveApiEntry(list, 'nope'), null);
});

check('newApiEntryId returns non-empty unique ids', () => {
  const a = newApiEntryId();
  const b = newApiEntryId();
  assert.ok(a && b && a !== b);
});

check('the default provider is matched by id, then by legacy fields', () => {
  const list = [
    { id: 'a', service: 'Other', apiUrl: 'u1', modelName: 'm1' },
    { id: 'b', service: 'Other', apiUrl: 'u2', modelName: 'm2' }
  ];

  assert.equal(isDefaultEntry(list[0], { dsId: 'b' }), false);
  assert.equal(isDefaultEntry(list[1], { dsId: 'b' }), true);
  // Old data has no dsId: URL + model pick the right one.
  assert.equal(isDefaultEntry(list[0], { service: 'Other', apiUrl: 'u1', modelName: 'm1' }), true);
  assert.equal(isDefaultEntry(list[0], { service: 'Other', apiUrl: 'u2', modelName: 'm2' }), false);
  assert.equal(findDefaultEntry(list, { dsId: 'b' }).id, 'b');
  // A stale dsId falls back to the legacy service/URL/model match.
  assert.equal(findDefaultEntry(list, { dsId: 'gone', service: 'Other', apiUrl: 'u2', modelName: 'm2' }).id, 'b');
  assert.equal(findDefaultEntry(list, {}), null);
  assert.equal(isDefaultEntry({ service: 'OpenAI' }, {}), false);
});

check('legacy references migrate to entry ids once, then the name field is gone', () => {
  const legacy = {
    base: {
      dsName: 'My provider',
      service: 'DeepSeek',
      apiUrl: 'https://api.deepseek.com/chat/completions',
      modelName: 'deepseek-chat',
      insightService: 'DeepSeek'
    },
    dsList: [
      {
        name: 'My provider',
        service: 'DeepSeek',
        apiUrl: 'https://api.deepseek.com/chat/completions',
        modelName: 'deepseek-chat'
      },
      { name: 'Local', service: 'ollama', apiUrl: 'http://localhost:11434', modelName: 'qwen3' }
    ],
    skillList: [
      { id: 1, name: 'Old', prompt: 'p', dsService: 'My provider' },
      { id: 2, name: 'Ollama skill', prompt: 'p', dsService: 'ollama' },
      { id: 3, name: 'Unknown', prompt: 'p', dsService: 'gone' }
    ]
  };

  const first = migrateLegacyReferences(legacy);
  assert.equal(first.dsList.length, 2);
  assert.ok(first.dsList.every((entry) => entry.id && !('name' in entry)));
  assert.equal(first.base.dsId, first.dsList[0].id);
  assert.equal(first.base.insightService, first.dsList[0].id);
  assert.equal('dsName' in first.base, false);
  assert.equal(first.skillList[0].dsService, first.dsList[0].id);
  assert.equal(first.skillList[1].dsService, first.dsList[1].id);
  assert.equal(first.skillList[2].dsService, 'gone'); // unknown stays untouched
  assert.deepEqual(first.changed, { base: true, dsList: true, skillList: true });

  // Same input shape, already migrated: nothing to write any more.
  const second = migrateLegacyReferences({ base: first.base, dsList: first.dsList, skillList: first.skillList });
  assert.deepEqual(second.changed, { base: false, dsList: false, skillList: false });
  assert.deepEqual(second.base, first.base);
  assert.deepEqual(second.dsList, first.dsList);
  assert.deepEqual(second.skillList, first.skillList);
});

check('ambiguous legacy names/services are not guessed', () => {
  const out = migrateLegacyReferences({
    dsList: [
      { id: 'a', name: 'dup', service: 'Other', apiUrl: 'u1', modelName: 'm1' },
      { id: 'b', name: 'dup', service: 'Other', apiUrl: 'u2', modelName: 'm2' }
    ],
    skillList: [{ id: 1, prompt: 'p', dsService: 'dup' }]
  });
  assert.equal(out.skillList[0].dsService, 'dup');
  assert.ok(out.dsList.every((entry) => !('name' in entry)));
});

check('tool execution survives the native-tools path', () => {
  const source = readFileSync(new URL('../js/cllama.js', import.meta.url), 'utf8');
  // A textual <tool_call> is executed even when native tools were declared: the
  // old `!useNativeTools && …` guard stripped such calls from the answer.
  assert.match(source, /const canTextTools = Boolean\(activeSkill \|\| autoSkills\);/);
  // Empty declared tools fall back to the text protocol instead of sending [].
  assert.match(source, /if \(!nativeTools\.length\) useNativeTools = false;/);
  // A gateway that rejects the `tools` field (or a stream that dies with EOF)
  // is retried without it, using the text protocol.
  assert.match(source, /const toolPayloadFailed = looksLikeToolRejection\(err\) \|\| looksLikeTransportBreak\(err\);/);
  assert.match(source, /useNativeTools && !toolsFallbackTried && toolPayloadFailed/);
  // The injected text is refreshed when the strategy changes.
  assert.match(source, /const refreshInjectText = \(\) =>/);
});

check('a per-turn data source decides message format and tool support', () => {
  const source = readFileSync(new URL('../js/cllama.js', import.meta.url), 'utf8');
  // The override is resolved before the messages are formatted...
  const resolveAt = source.indexOf('const dsOverrideName = options?.dsService');
  const formatAt = source.indexOf('// Format messages based on service type');
  assert.ok(resolveAt > 0 && formatAt > resolveAt);
  // ...and both the service-type decisions and native tool gating use it.
  assert.match(source, /const isOllama = turnConfig\.service == "ollama";/);
  assert.match(source, /const isGoogle = isGemini\(turnConfig\);/);
  assert.match(source, /turnConfig\.service === 'ollama'[\s\S]{0,400}turnConfig\.supportsTools === true/);
  // Tool results answer a specific call; OpenAI-compatible endpoints require it.
  assert.match(source, /tool_call_id = r\.tool_call_id;/);
});

console.log(`\n${passed} checks passed.`);
