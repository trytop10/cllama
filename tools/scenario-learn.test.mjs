/**
 * Self-check for scenario learning (js/scenario-learn.mjs + its storage helpers
 * in js/cllama.js).
 *
 *   node tools/scenario-learn.test.mjs
 *
 * The pure rules are exercised directly; the storage helpers run against the same
 * in-memory `chrome` stub the other self-checks use.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// ------------------- minimal browser stub -------------------
const store = {};
function pick(keys) {
  if (keys == null) return { ...store };
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (typeof k === 'string') out[k] = store[k];
  return out;
}
const changeListeners = [];
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = pick(keys);
        if (typeof cb === 'function') { cb(out); return undefined; }
        return Promise.resolve(out);
      },
      set(obj, cb) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store[k], newValue: v };
          store[k] = v;
        }
        changeListeners.forEach((fn) => fn(changes, 'local'));
        if (typeof cb === 'function') { cb(); return undefined; }
        return Promise.resolve();
      },
      remove(keys, cb) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        if (typeof cb === 'function') { cb(); return undefined; }
        return Promise.resolve();
      }
    },
    onChanged: {
      addListener(fn) { changeListeners.push(fn); },
      removeListener(fn) {
        const i = changeListeners.indexOf(fn);
        if (i >= 0) changeListeners.splice(i, 1);
      }
    }
  },
  i18n: { getMessage: (k) => k, getUILanguage: () => 'en' },
  runtime: { getURL: (p) => p, openOptionsPage() {} },
  tabs: { query: async () => [], sendMessage: async () => ({}) }
};

const learn = await import('../js/scenario-learn.mjs');
const {
  ARTIFACT_TARGETS, DB_KEY, applyArtifact, artifactTargetLabel, clearLessons,
  collectArtifactDraftsDetailed, guessArtifactTarget, loadScenarioLearn,
  removeLesson, setLearnEnabled, MAX_LEARN_REVISIONS
} = await import('../js/cllama.js');

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

// ------------------- validation -------------------
check('normalizeLesson accepts a name + text pair and keys it by name', () => {
  const r = learn.normalizeLesson({ name: 'Tone', text: 'Answer in Chinese.' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { name: 'Tone', key: 'Tone', text: 'Answer in Chinese.' });
  assert.deepEqual(r.notes, []);
});

check('normalizeLesson accepts key/note aliases', () => {
  const r = learn.normalizeLesson({ key: 'Format', note: 'Lead with the conclusion.' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.key, 'Format');
  assert.equal(r.entry.text, 'Lead with the conclusion.');
});

check('normalizeLesson rejects a missing name or text', () => {
  assert.equal(learn.normalizeLesson({ text: 'x' }).ok, false);
  assert.equal(learn.normalizeLesson({ name: 'x' }).ok, false);
  assert.equal(learn.normalizeLesson({ name: '  ', text: '  ' }).ok, false);
  assert.equal(learn.normalizeLesson(null).ok, false);
  assert.match(learn.normalizeLesson({ name: 'x' }).message, /Nothing was saved/);
});

check('normalizeLesson rejects an over-long note instead of truncating it', () => {
  const r = learn.normalizeLesson({ name: 'x', text: 'a'.repeat(learn.LESSON_TEXT_MAX + 1) });
  assert.equal(r.ok, false);
  assert.match(r.message, new RegExp(`max ${learn.LESSON_TEXT_MAX} characters`));
});

check('normalizeLesson truncates a long name and reports it', () => {
  const long = 'N'.repeat(learn.LESSON_NAME_MAX + 5);
  const r = learn.normalizeLesson({ name: long, text: 'rule' });
  assert.equal(r.ok, true);
  assert.equal([...r.entry.name].length, learn.LESSON_NAME_MAX);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /truncated/);
});

check('normalizeLesson flattens a multi-line note to one line', () => {
  const r = learn.normalizeLesson({ name: 'k', text: 'first\n  second\n\n\nthird' });
  assert.equal(r.entry.text, 'first second third');
});

check('countChars/clampChars count code points, not UTF-16 units', () => {
  assert.equal(learn.countChars('中文'), 2);
  assert.equal(learn.countChars('👍'), 1);
  assert.equal(learn.clampChars('中文abc', 2), '中文');
  assert.equal(learn.clampChars('abc', 10), 'abc');
});

// ------------------- similarity & matching -------------------
check('similarity is 1 for identical text and 0 for unrelated text', () => {
  assert.equal(learn.similarity('Answer in Chinese', 'Answer in Chinese'), 1);
  assert.equal(learn.similarity('Answer in Chinese', 'use a table'), 0);
  assert.equal(learn.similarity('', 'anything'), 0);
});

check('similarity works for CJK text (bigram tokens)', () => {
  const close = learn.similarity('先给结论再给依据', '先给结论再给细节');
  const far = learn.similarity('先给结论再给依据', '请使用英文回答');
  assert.ok(close > far, `expected ${close} > ${far}`);
  assert.ok(close > 0.3);
  assert.equal(far, 0);
});

check('findLessonIndex matches an exact key first', () => {
  const lessons = [
    { id: 'a', key: 'Tone', text: 'Answer in Chinese.' },
    { id: 'b', key: 'Format', text: 'Lead with the conclusion.' }
  ];
  assert.equal(learn.findLessonIndex(lessons, { key: 'format', text: 'whatever' }), 1);
});

check('findLessonIndex falls back to a similar text', () => {
  const lessons = [{ id: 'a', key: 'Tone', text: 'Always answer in Chinese please.' }];
  const index = learn.findLessonIndex(lessons, { key: 'Language', text: 'Always answer in Chinese please.' });
  assert.equal(index, 0);
});

check('findLessonIndex ignores an empty key and unrelated notes', () => {
  const lessons = [{ id: 'a', key: 'Tone', text: 'Answer in Chinese.' }];
  assert.equal(learn.findLessonIndex(lessons, { key: '', text: 'x' }), -1);
  assert.equal(learn.findLessonIndex(lessons, { key: 'Other', text: 'Use a table.' }), -1);
});

// ------------------- de-duplication -------------------
check('dedupeLessons appends new notes with a stable shape', () => {
  const r = learn.dedupeLessons(['A', 'B'].map((n) => ({ name: n, text: `rule ${n}` })), [], {
    now: 1000,
    makeId: (() => { let i = 0; return () => `id-${++i}`; })()
  });
  assert.equal(r.lessons.length, 2);
  assert.equal(r.added.length, 2);
  assert.equal(r.updated.length, 0);
  assert.deepEqual(Object.keys(r.lessons[0]).sort(), ['createdAt', 'id', 'key', 'name', 'origin', 'text', 'updatedAt']);
  assert.equal(r.lessons[0].createdAt, 1000);
  assert.equal(r.lessons[1].id, 'id-2');
});

check('dedupeLessons updates the existing note on a repeated key instead of duplicating', () => {
  const existing = [{ id: 'a', key: 'Tone', name: 'Tone', text: 'Be brief.', createdAt: 1, updatedAt: 1, origin: 'reflect' }];
  const r = learn.dedupeLessons([{ name: 'Tone', text: 'Be very brief.' }], existing, { now: 2000 });
  assert.equal(r.lessons.length, 1);
  assert.equal(r.added.length, 0);
  assert.equal(r.updated.length, 1);
  assert.equal(r.lessons[0].id, 'a');
  assert.equal(r.lessons[0].text, 'Be very brief.');
  assert.equal(r.lessons[0].createdAt, 1);
  assert.equal(r.lessons[0].updatedAt, 2000);
});

check('dedupeLessons never mutates the list it was given', () => {
  const existing = [{ id: 'a', key: 'Tone', name: 'Tone', text: 'Be brief.' }];
  learn.dedupeLessons([{ name: 'Tone', text: 'Changed.' }], existing, { now: 5 });
  assert.equal(existing[0].text, 'Be brief.');
});

check('dedupeLessons skips invalid candidates', () => {
  const r = learn.dedupeLessons([{ name: 'x' }, null, { text: 'y' }], []);
  assert.equal(r.lessons.length, 0);
});

check('dedupeLessons caps the list and drops the oldest note', () => {
  const existing = [];
  for (let i = 0; i < learn.LESSONS_MAX; i++) existing.push({ id: `id-${i}`, key: `k${i}`, name: `k${i}`, text: `rule ${i}` });
  const r = learn.dedupeLessons([{ name: 'fresh', text: 'brand new rule' }], existing, { now: 9, makeId: () => 'new' });
  assert.equal(r.lessons.length, learn.LESSONS_MAX);
  assert.equal(r.lessons[r.lessons.length - 1].id, 'new');
  assert.equal(r.lessons.some((l) => l.id === 'id-0'), false);
});

check('dedupeLessons is idempotent for the same candidate', () => {
  const first = learn.dedupeLessons([{ name: 'Tone', text: 'Be brief.' }], [], { now: 1, makeId: () => 'one' });
  const second = learn.dedupeLessons([{ name: 'Tone', text: 'Be brief.' }], first.lessons, { now: 2 });
  assert.equal(second.lessons.length, 1);
  assert.equal(second.added.length, 0);
  assert.equal(second.updated.length, 0);
});

// ------------------- injection block -------------------
check('buildLessonsBlock marks the notes as reference-only material', () => {
  const block = learn.buildLessonsBlock([{ text: 'Be brief.' }]);
  assert.ok(block.startsWith(learn.LESSONS_BLOCK_HEADER));
  assert.match(block, /not instructions/i);
  assert.match(block, /Be brief\./);
});

check('buildLessonsBlock returns an empty string when there is nothing to inject', () => {
  assert.equal(learn.buildLessonsBlock([]), '');
  assert.equal(learn.buildLessonsBlock(null), '');
  assert.equal(learn.buildLessonsBlock([{ text: '   ' }, {}]), '');
});

check('buildLessonsBlock respects the character budget', () => {
  const notes = [{ text: 'a'.repeat(50) }, { text: 'b'.repeat(50) }, { text: 'c'.repeat(50) }];
  const block = learn.buildLessonsBlock(notes, { maxChars: 80 });
  assert.ok(block.includes('a'.repeat(50)));
  assert.ok(!block.includes('b'.repeat(50)));
  assert.equal(block.split('\n').length, 2);
});

check('buildLessonsBlock always keeps the first note', () => {
  const block = learn.buildLessonsBlock([{ text: 'x'.repeat(100) }], { maxChars: 10 });
  assert.ok(block.includes('x'.repeat(100)));
});

// ------------------- reflection excerpt -------------------
check('buildReflectExcerpt keeps roles and order and skips non-text records', () => {
  const excerpt = learn.buildReflectExcerpt([
    { role: 'user', content: 'Question one' },
    { role: 'assistant', content: 'Answer one' },
    { role: 'user', content: 'a file', fileInfo: { name: 'x.png' } },
    { role: 'user', content: '<img src="/images/x.png">' },
    { role: 'assistant', content: '   ' },
    { role: 'system', content: 'ignored' }
  ]);
  assert.equal(excerpt, 'User: Question one\nAssistant: Answer one');
});

check('buildReflectExcerpt only uses the most recent messages', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const excerpt = learn.buildReflectExcerpt(records, { maxMessages: 3 });
  assert.equal(excerpt.split('\n').length, 3);
  assert.ok(excerpt.includes('msg 9'));
  assert.ok(!excerpt.includes('msg 6'));
});

check('buildReflectExcerpt keeps the newest lines when the budget is tight', () => {
  const records = [
    { role: 'user', content: 'old'.repeat(30) },
    { role: 'assistant', content: 'middle'.repeat(20) },
    { role: 'user', content: 'newest' }
  ];
  const excerpt = learn.buildReflectExcerpt(records, { maxChars: 60 });
  assert.ok(excerpt.endsWith('User: newest'));
  assert.ok(!excerpt.includes('middle'));
});

check('buildReflectExcerpt truncates a single long message', () => {
  const excerpt = learn.buildReflectExcerpt([{ role: 'user', content: 'z'.repeat(500) }], { perMessageChars: 20 });
  assert.equal(excerpt, `User: ${'z'.repeat(20)}`);
});

check('buildReflectExcerpt strips reasoning blocks and stray think tags', () => {
  const excerpt = learn.buildReflectExcerpt([
    { role: 'assistant', content: '<think>secret reasoning</think>Answer one' },
    { role: 'assistant', content: '</think>Answer two' },
    { role: 'assistant', content: '<think>only reasoning</think>' }
  ]);
  assert.equal(excerpt, 'Assistant: Answer one\nAssistant: Answer two');
});

check('buildReflectExcerpt is empty when there is nothing to review', () => {
  assert.equal(learn.buildReflectExcerpt([]), '');
  assert.equal(learn.buildReflectExcerpt([{ role: 'user', content: '  ' }]), '');
});

// ------------------- reflection readiness -------------------
check('reflectReadiness reports empty for a session with no usable message', () => {
  const r = learn.reflectReadiness([]);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'empty');
  assert.deepEqual(r.need, { messages: learn.REFLECT_MIN_MESSAGES, chars: learn.REFLECT_MIN_CHARS });

  // Attachments, image placeholders and blank answers carry nothing to learn from.
  const onlyJunk = learn.reflectReadiness([
    { role: 'user', content: 'file', fileInfo: { name: 'a.png' } },
    { role: 'user', content: '<img src="/images/a.png">' },
    { role: 'assistant', content: '   ' }
  ]);
  assert.equal(onlyJunk.reason, 'empty');
  assert.equal(onlyJunk.stats.messages, 0);
});

check('reflectReadiness needs at least one user and one assistant message', () => {
  const questionsOnly = learn.reflectReadiness([{ role: 'user', content: 'q'.repeat(200) }]);
  assert.equal(questionsOnly.reason, 'incomplete');
  assert.equal(questionsOnly.stats.assistant, 0);

  const answersOnly = learn.reflectReadiness([{ role: 'assistant', content: 'a'.repeat(200) }]);
  assert.equal(answersOnly.reason, 'incomplete');
  assert.equal(answersOnly.stats.user, 0);
});

check('reflectReadiness rejects an exchange that is too short', () => {
  const r = learn.reflectReadiness([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' }
  ]);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'too-short');
  assert.ok(r.stats.chars < learn.REFLECT_MIN_CHARS);
});

check('reflectReadiness accepts a full exchange at the threshold', () => {
  const half = 'x'.repeat(Math.ceil(learn.REFLECT_MIN_CHARS / 2));
  const r = learn.reflectReadiness([
    { role: 'user', content: half },
    { role: 'assistant', content: half }
  ]);
  assert.equal(r.ready, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.stats.messages, learn.REFLECT_MIN_MESSAGES);
  assert.ok(r.stats.chars >= learn.REFLECT_MIN_CHARS);
});

check('reflectReadiness is too-short one message below the minimum', () => {
  const big = 'y'.repeat(500);
  const r = learn.reflectReadiness([{ role: 'user', content: big }, { role: 'assistant', content: '' }]);
  assert.equal(r.ready, false);
  assert.equal(r.stats.messages, 1);
});

check('reflectReadiness counts code points the same way the excerpt does', () => {
  const r = learn.reflectReadiness([
    { role: 'user', content: '中'.repeat(60) },
    { role: 'assistant', content: '文'.repeat(60) }
  ]);
  assert.equal(r.stats.chars, 120);
  assert.equal(r.ready, true);
});

check('reflectReadiness ignores reasoning blocks when measuring', () => {
  const r = learn.reflectReadiness([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '<think>' + 'z'.repeat(400) + '</think>ok' }
  ]);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'too-short');
  assert.ok(r.stats.chars < learn.REFLECT_MIN_CHARS);
});

check('reflectReadiness reports busy before anything else', () => {
  const records = [{ role: 'user', content: 'x'.repeat(100) }, { role: 'assistant', content: 'y'.repeat(100) }];
  const r = learn.reflectReadiness(records, { busy: true });
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'busy');
  // ...but the stats are still reported, so the UI can show progress if needed.
  assert.equal(r.stats.messages, 2);
});

check('readiness and the excerpt agree on what is usable', () => {
  const records = [
    { role: 'user', content: 'hello there, please answer briefly and skip the preamble' },
    { role: 'user', content: 'ignored file', fileInfo: { name: 'x.pdf' } },
    { role: 'assistant', content: '<think>hidden</think>Sure, done in two lines from now on.' },
    { role: 'user', content: '<img src="/images/p.png">' },
    { role: 'assistant', content: 'Understood, I will keep every answer short from now on.' }
  ];
  const ready = learn.reflectReadiness(records);
  const excerpt = learn.buildReflectExcerpt(records);
  assert.equal(ready.stats.messages, excerpt.split('\n').length);
  assert.equal(ready.ready, true);
  // The unusable records are counted out of both.
  assert.equal(ready.stats.messages, 3);
});

// ------------------- reflection prompt -------------------
check('REFLECT_PROMPT asks for a numbered list, then one json block per pick', () => {
  assert.match(learn.REFLECT_PROMPT, /STEP 1/);
  assert.match(learn.REFLECT_PROMPT, /STEP 2/);
  assert.match(learn.REFLECT_PROMPT, /"target":"memory"/);
  assert.match(learn.REFLECT_PROMPT, /suggest: memory/);
});

check('REFLECT_PROMPT tells the model how the picked notes come back', () => {
  // The confirm button of the clickable list sends the shared
  // choiceSelectionMessage template ("Build the following selected items: ..."),
  // so the reviewer prompt has to read that wording as a selection.
  assert.match(learn.REFLECT_PROMPT, /Build the following selected items/);
  assert.match(learn.REFLECT_PROMPT, /not as a build request/);
});

check('REFLECT_PROMPT forbids writing to storage and forbids inventing preferences', () => {
  assert.match(learn.REFLECT_PROMPT, /never write to storage/i);
  assert.match(learn.REFLECT_PROMPT, /never invent a preference/i);
  assert.match(learn.REFLECT_PROMPT, /secrets/i);
});

// ------------------- artifact target detection -------------------
check('memory is a known artifact target with its own label', () => {
  assert.ok(ARTIFACT_TARGETS.includes('memory'));
  assert.equal(artifactTargetLabel('memory'), 'artifactTargetMemory');
});

check('guessArtifactTarget honors an explicit target:memory', () => {
  assert.equal(guessArtifactTarget({ target: 'memory', name: 'Tone', text: 'Be brief.' }), 'memory');
});

check('guessArtifactTarget recognizes a name+text payload without a prompt', () => {
  assert.equal(guessArtifactTarget({ name: 'Tone', text: 'Be brief.' }), 'memory');
});

check('guessArtifactTarget does not turn a recipe or scenario into a note', () => {
  assert.equal(guessArtifactTarget({ name: 'Short', prompt: 'do it' }), 'recipe');
  assert.equal(guessArtifactTarget({ name: 'Longer scenario', prompt: 'do it', sample: 'hi' }), 'scenario');
  assert.equal(guessArtifactTarget({ name: 'X', prompt: 'p', description: 'd' }), 'skill');
});

// ------------------- page-side card pipeline -------------------
check('collectArtifactDraftsDetailed turns a memory json block into a draft', () => {
  const text = 'Here they are:\n```json\n{"target":"memory","name":"Tone","text":"Answer in Chinese."}\n```\n';
  const { drafts, rejected } = collectArtifactDraftsDetailed(text);
  assert.equal(rejected.length, 0);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].target, 'memory');
  assert.equal(drafts[0].name, 'Tone');
  assert.equal(drafts[0].payload.text, 'Answer in Chinese.');
});

check('collectArtifactDraftsDetailed rejects a nameless memory block with a reason', () => {
  const text = '```json\n{"target":"memory","text":"Answer in Chinese."}\n```\n';
  const { drafts, rejected } = collectArtifactDraftsDetailed(text);
  assert.equal(drafts.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /needs at least a "name" and a "text"/);
});

// ------------------- storage helpers (per scenario) -------------------
await checkAsync('applyArtifact(memory) refuses to write without a scenarioId', async () => {
  const res = await applyArtifact('memory', { name: 'Tone', text: 'Be brief.' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid');
  assert.match(res.message, /needs the scenario/);
  assert.equal(store[DB_KEY.scenarioLearn], undefined);
});

await checkAsync('applyArtifact(memory) stores a note in its own scenario only', async () => {
  const res = await applyArtifact('memory', { name: 'Tone', text: 'Answer in Chinese.' }, { scenarioId: '2' });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'created');
  assert.equal(res.count, 1);

  const two = await loadScenarioLearn('2');
  const other = await loadScenarioLearn('7');
  assert.equal(two.lessons.length, 1);
  assert.equal(two.lessons[0].text, 'Answer in Chinese.');
  assert.equal(two.lessons[0].origin, 'reflect');
  assert.equal(two.enabled, true);
  assert.equal(other.lessons.length, 0);
  assert.equal(other.updatedAt, 0);
});

await checkAsync('applyArtifact(memory) updates a repeated note instead of duplicating it', async () => {
  const before = (await loadScenarioLearn('2')).lessons[0];
  const res = await applyArtifact('memory', { name: 'Tone', text: 'Answer in Chinese, briefly.' }, { scenarioId: '2' });
  assert.equal(res.action, 'updated');
  const after = await loadScenarioLearn('2');
  assert.equal(after.lessons.length, 1);
  assert.equal(after.lessons[0].id, before.id);
  assert.equal(after.lessons[0].text, 'Answer in Chinese, briefly.');
  assert.ok(after.revisions.length >= 2);
  assert.equal(after.revisions[after.revisions.length - 1].action, 'lesson-updated');
  assert.ok(after.revisions.length <= MAX_LEARN_REVISIONS);
});

await checkAsync('a rejected note leaves storage untouched', async () => {
  const res = await applyArtifact('memory', { name: 'Tone', text: 'x'.repeat(learn.LESSON_TEXT_MAX + 1) }, { scenarioId: '2' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid');
  assert.equal((await loadScenarioLearn('2')).lessons.length, 1);
});

await checkAsync('setLearnEnabled toggles injection without deleting notes', async () => {
  await setLearnEnabled('2', false);
  let state = await loadScenarioLearn('2');
  assert.equal(state.enabled, false);
  assert.equal(state.lessons.length, 1);

  await setLearnEnabled('2', true);
  state = await loadScenarioLearn('2');
  assert.equal(state.enabled, true);
  assert.equal(state.lessons.length, 1);
});

await checkAsync('removeLesson deletes one note and reports an unknown id', async () => {
  const id = (await loadScenarioLearn('2')).lessons[0].id;
  assert.equal(await removeLesson('2', 'does-not-exist'), false);
  assert.equal(await removeLesson('2', id), true);
  assert.equal((await loadScenarioLearn('2')).lessons.length, 0);
  assert.equal((await loadScenarioLearn('2')).revisions.at(-1).action, 'lesson-removed');
});

await checkAsync('clearLessons empties one scenario and returns the count', async () => {
  await applyArtifact('memory', { name: 'A', text: 'rule A' }, { scenarioId: '3' });
  await applyArtifact('memory', { name: 'B', text: 'rule B' }, { scenarioId: '3' });
  await applyArtifact('memory', { name: 'C', text: 'rule C' }, { scenarioId: '4' });

  assert.equal(await clearLessons('3'), 2);
  assert.equal((await loadScenarioLearn('3')).lessons.length, 0);
  assert.equal(await clearLessons('3'), 0);
  assert.equal((await loadScenarioLearn('4')).lessons.length, 1);
  assert.equal((await loadScenarioLearn('4')).revisions.length, 1);
});

await checkAsync('loadScenarioLearn tolerates corrupt storage', async () => {
  store[DB_KEY.scenarioLearn] = 'not-an-object';
  const state = await loadScenarioLearn('2');
  assert.deepEqual(state, { enabled: true, lessons: [], revisions: [], updatedAt: 0 });

  store[DB_KEY.scenarioLearn] = { 2: { lessons: 'nope', enabled: 'yes' } };
  const partial = await loadScenarioLearn('2');
  assert.equal(partial.enabled, true);
  assert.deepEqual(partial.lessons, []);
});

// ------------------- i18n parity -------------------
check('every locale defines the scenario-learning messages', () => {
  const required = [
    'reflectTitle', 'reflectButton', 'reflectFailed',
    'reflectNeedMore', 'reflectNoScenario', 'reflectBusy',
    'artifactTargetMemory', 'lessonPanelTitle', 'lessonsEmpty', 'lessonsInjectOn',
    'lessonsInjectOff', 'lessonsClear', 'lessonsClearConfirm', 'lessonsCleared',
    'lessonRemoved', 'lessonsHint',
    'skillDefaultConversationBuilder', 'skillDefaultConversationBuilderDesc',
    'conversationBuilderStarter'
  ];
  const en = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));
  for (const key of required) {
    assert.ok(en[key]?.message, `en is missing ${key}`);
  }
  for (const locale of readdirSync(new URL('../_locales', import.meta.url))) {
    const messages = JSON.parse(readFileSync(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
    for (const key of required) {
      assert.ok(messages[key]?.message, `${locale} is missing ${key}`);
    }
  }
});

check('the learned-note messages keep the placeholders the code replaces', () => {
  for (const locale of readdirSync(new URL('../_locales', import.meta.url))) {
    const messages = JSON.parse(readFileSync(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
    assert.match(messages.lessonRemoved.message, /\{name\}/, `${locale}: lessonRemoved lost {name}`);
    assert.match(messages.reflectNeedMore.message, /\{count\}/, `${locale}: reflectNeedMore lost {count}`);
  }
});

await checkAsync('re-importing the identical note is a no-op (idempotent import)', async () => {
  const note = { name: 'Language', text: 'Answer in Chinese.' };
  const first = await applyArtifact('memory', note, { scenarioId: '9' });
  assert.equal(first.action, 'created');
  const afterFirst = await loadScenarioLearn('9');

  const second = await applyArtifact('memory', note, { scenarioId: '9' });
  assert.equal(second.ok, true);
  assert.equal(second.action, 'unchanged');
  assert.match(second.message, /already learned/);

  const afterSecond = await loadScenarioLearn('9');
  assert.equal(afterSecond.lessons.length, 1);
  assert.equal(afterSecond.updatedAt, afterFirst.updatedAt);
  assert.equal(afterSecond.revisions.length, afterFirst.revisions.length);
});

await checkAsync('the revision log stays capped while notes keep updating', async () => {
  for (let i = 0; i < MAX_LEARN_REVISIONS + 8; i++) {
    await applyArtifact('memory', { name: 'Language', text: `Answer in Chinese, v${i}.` }, { scenarioId: '9' });
  }
  const state = await loadScenarioLearn('9');
  assert.equal(state.lessons.length, 1);
  assert.equal(state.revisions.length, MAX_LEARN_REVISIONS);
  assert.ok(state.lessons[0].text.endsWith(`v${MAX_LEARN_REVISIONS + 7}.`));
});

console.log(`\n${passed} checks passed.`);
