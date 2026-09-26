/**
 * Self-check for the token-usage helpers (js/token-usage.mjs).
 *
 *   node tools/token-usage.test.mjs
 *
 * Pure functions only: no browser stub needed.
 */
import assert from 'node:assert/strict';

const {
  formatCount, formatUsage, hasUsage, makeEstimatedUsage, mergeUsage,
  normalizeGeminiUsage, normalizeOllamaUsage, normalizeOpenAIUsage
} = await import('../js/token-usage.mjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ------------------- formatting -------------------
check('formatCount adds thousands separators', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(7010), '7,010');
  assert.equal(formatCount(1234567), '1,234,567');
});

// ------------------- Ollama -------------------
check('normalizeOllamaUsage maps prompt_eval_count / eval_count', () => {
  const usage = normalizeOllamaUsage({ done: true, prompt_eval_count: 6120, eval_count: 890 });
  assert.deepEqual(usage, { input: 6120, output: 890, total: 7010, cached: 0, estimated: false });
});

check('normalizeOllamaUsage ignores parts without counters', () => {
  assert.equal(normalizeOllamaUsage({ message: { content: 'hi' } }), null);
  assert.equal(normalizeOllamaUsage(null), null);
  assert.equal(normalizeOllamaUsage({ prompt_eval_count: 'nope' }), null);
});

// ------------------- OpenAI-compatible -------------------
check('normalizeOpenAIUsage maps prompt/completion/total tokens', () => {
  const usage = normalizeOpenAIUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  assert.deepEqual(usage, { input: 100, output: 20, total: 120, cached: 0, estimated: false });
});

check('normalizeOpenAIUsage reads every cached-token variant', () => {
  assert.equal(
    normalizeOpenAIUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 8 } }).cached, 8);
  assert.equal(
    normalizeOpenAIUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 7 }).cached, 7);
  assert.equal(
    normalizeOpenAIUsage({ prompt_tokens: 10, completion_tokens: 1, cached_tokens: 6 }).cached, 6);
});

check('normalizeOpenAIUsage falls back to input+output as total', () => {
  assert.equal(normalizeOpenAIUsage({ prompt_tokens: 5, completion_tokens: 3 }).total, 8);
  assert.equal(normalizeOpenAIUsage({}), null);
});

// ------------------- Gemini -------------------
check('normalizeGeminiUsage folds thinking tokens into the output', () => {
  const usage = normalizeGeminiUsage({
    promptTokenCount: 1000,
    candidatesTokenCount: 200,
    thoughtsTokenCount: 50,
    cachedContentTokenCount: 300,
    totalTokenCount: 1250
  });
  assert.deepEqual(usage, { input: 1000, output: 250, total: 1250, cached: 300, estimated: false });
});

check('normalizeGeminiUsage handles missing fields', () => {
  assert.deepEqual(normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 2 }),
    { input: 10, output: 2, total: 12, cached: 0, estimated: false });
  assert.equal(normalizeGeminiUsage(undefined), null);
});

// ------------------- estimates -------------------
check('makeEstimatedUsage flags values as estimated', () => {
  const usage = makeEstimatedUsage(120, 30);
  assert.equal(usage.estimated, true);
  assert.equal(usage.total, 150);
});

// ------------------- accumulation -------------------
check('mergeUsage sums every field of the two records', () => {
  const a = { input: 100, output: 20, total: 120, cached: 0, estimated: false };
  const b = { input: 300, output: 40, total: 340, cached: 10, estimated: false };
  assert.deepEqual(mergeUsage(a, b), { input: 400, output: 60, total: 460, cached: 10, estimated: false });
});

check('mergeUsage keeps a null total when both sides are unknown', () => {
  const merged = mergeUsage({ input: 5, output: 1, total: null, cached: 0, estimated: true },
    { input: 5, output: 1, total: null, cached: 0, estimated: true });
  assert.equal(merged.total, null);
  assert.equal(merged.estimated, true);
});

check('mergeUsage tolerates missing operands', () => {
  const a = { input: 1, output: 1, total: 2, cached: 0, estimated: false };
  assert.deepEqual(mergeUsage(null, a), a);
  assert.deepEqual(mergeUsage(a, null), a);
  assert.equal(mergeUsage(null, null), null);
});

// ------------------- display -------------------
check('hasUsage rejects empty records', () => {
  assert.equal(hasUsage(null), false);
  assert.equal(hasUsage({ input: 0, output: 0, total: 0 }), false);
  assert.equal(hasUsage({ input: 1, output: 0, total: 1 }), true);
});

check('formatUsage renders input / output / total', () => {
  const text = formatUsage({ input: 6120, output: 890, total: 7010, cached: 0, estimated: false }, {});
  assert.equal(text, 'Input 6,120 · Output 890 · Total 7,010 tokens');
});

check('formatUsage shows only the output while streaming', () => {
  const text = formatUsage({ input: 0, output: 512, total: null, cached: 0, estimated: true }, {});
  assert.equal(text, 'Output ≈512 tokens');
});

check('formatUsage prefixes estimated numbers and adds cached tokens', () => {
  const text = formatUsage(
    { input: 100, output: 20, total: 120, cached: 64, estimated: true },
    { input: 'In', output: 'Out', total: 'Sum', cached: 'Cache', tokens: 'tok' });
  assert.equal(text, 'In ≈100 · Out ≈20 · Sum ≈120 · Cache 64 tok');
});

check('formatUsage is empty for no usage', () => {
  assert.equal(formatUsage(null), '');
  assert.equal(formatUsage({ input: 0, output: 0, total: 0 }), '');
});

console.log(`\n${passed} checks passed.`);
