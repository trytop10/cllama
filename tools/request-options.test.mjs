/**
 * Self-check for the client option mapping helpers (js/request-options.mjs).
 *
 *   node tools/request-options.test.mjs
 *
 * Pure functions only: no browser or SDK stub needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  normalizeSamplingOptions,
  openAISamplingOptions,
  toGeminiGenerationConfig,
  toGeminiFunctionDeclarations
} = await import('../js/request-options.mjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check('normalizeSamplingOptions reads the Ollama-shaped nested options', () => {
  assert.deepEqual(normalizeSamplingOptions({
    options: { temperature: 0.4, top_p: 0.8, top_k: 20, num_predict: 512, stop: ['\n'] }
  }), {
    temperature: 0.4,
    topP: 0.8,
    topK: 20,
    maxOutputTokens: 512,
    stopSequences: ['\n']
  });
});

check('normalizeSamplingOptions lets explicit top-level values win', () => {
  const out = normalizeSamplingOptions({
    temperature: 0.2,
    topP: 0.3,
    topK: 5,
    maxOutputTokens: 64,
    options: { temperature: 0.9, top_p: 0.9, top_k: 99, num_predict: 999 }
  });
  assert.equal(out.temperature, 0.2);
  assert.equal(out.topP, 0.3);
  assert.equal(out.topK, 5);
  assert.equal(out.maxOutputTokens, 64);
});

check('openAISamplingOptions falls back to the historical defaults', () => {
  assert.deepEqual(openAISamplingOptions(), { temperature: 1, top_p: 0.9 });
  assert.deepEqual(openAISamplingOptions({ options: { temperature: 0.3, top_p: 0.6 } }), {
    temperature: 0.3,
    top_p: 0.6
  });
});

check('toGeminiGenerationConfig maps names and removes undefined fields', () => {
  const config = toGeminiGenerationConfig({
    options: { temperature: 0.5, top_p: 0.7, top_k: 10, num_predict: 256, stop: ['END'] }
  });
  assert.deepEqual(config, {
    temperature: 0.5,
    topP: 0.7,
    topK: 10,
    maxOutputTokens: 256,
    stopSequences: ['END']
  });
  assert.equal('thinking' in toGeminiGenerationConfig({ options: { thinking: true } }), false);
  assert.deepEqual(toGeminiGenerationConfig(), {});
});

check('toGeminiFunctionDeclarations keeps the JSON Schema for parameters', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
  const declarations = toGeminiFunctionDeclarations([
    { type: 'function', function: { name: ' add ', description: 'Adds', parameters: schema } },
    { type: 'function', function: { name: 'noop' } },
    { type: 'function', function: { description: 'missing name' } }
  ]);
  assert.equal(declarations.length, 2);
  assert.deepEqual(declarations[0], {
    name: 'add',
    description: 'Adds',
    parametersJsonSchema: schema
  });
  assert.deepEqual(declarations[1], {
    name: 'noop',
    description: '',
    parametersJsonSchema: { type: 'object', properties: {} }
  });
});

check('toGeminiFunctionDeclarations tolerates missing input', () => {
  assert.deepEqual(toGeminiFunctionDeclarations(), []);
  assert.deepEqual(toGeminiFunctionDeclarations(null), []);
  assert.deepEqual(toGeminiFunctionDeclarations([null]), []);
});

check('Gemini client wires systemInstruction and function declarations', () => {
  const client = readFileSync(new URL('../js/client/gemini-client.mjs', import.meta.url), 'utf8');
  assert.match(client, /config\.systemInstruction = options\.systemInstruction/);
  assert.match(client, /toGeminiFunctionDeclarations\(options\.tools\)/);
  assert.match(client, /config\.tools = \[\{ functionDeclarations \}\]/);
  const chat = readFileSync(new URL('../js/cllama.js', import.meta.url), 'utf8');
  assert.match(chat, /functionResponse/);
  assert.match(chat, /systemInstructionText/);
  assert.doesNotMatch(chat, /supportsTools === true && !isGoogle/);
});

console.log(`\n${passed} checks passed.`);
