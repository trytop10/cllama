/**
 * Self-check for the attachment capability gate.
 *
 *   node tools/multimodal.test.mjs
 *
 * Static assertions over the chat page + locale files: the button is disabled as
 * a whole, and every locale can explain why.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const chat = readFileSync(new URL('../chat/chat.js', import.meta.url), 'utf8');

check('the attachment button is gated by the effective model capability', () => {
  assert.match(chat, /function supportsAttachments\(/);
  assert.match(chat, /\.multimodal === true/);
  assert.match(chat, /bImageUpload\.disabled = !supported/);
  assert.match(chat, /attachment-disabled/);
  assert.match(chat, /aria-disabled/);
});

check('pending attachments cannot bypass the gate at send time', () => {
  assert.match(chat, /hasPendingAttachments/);
  assert.match(chat, /supportsAttachments\(callDsService\)/);
  assert.match(chat, /multimodalUnsupported/);
});

check('every locale defines the attachment capability message', () => {
  const dir = new URL('../_locales/', import.meta.url);
  for (const locale of readdirSync(dir, { withFileTypes: true })) {
    if (!locale.isDirectory()) continue;
    const messages = JSON.parse(readFileSync(new URL(`${locale.name}/messages.json`, dir), 'utf8'));
    assert.equal(typeof messages.multimodalUnsupported?.message, 'string', `${locale.name} is missing multimodalUnsupported`);
    assert.ok(messages.multimodalUnsupported.message.trim().length > 0, `${locale.name} has an empty multimodalUnsupported`);
  }
});

console.log(`\n${passed} checks passed.`);
