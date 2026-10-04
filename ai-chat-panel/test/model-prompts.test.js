'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withPrompt, promptFor, permissionFor, modelRows, retiredPrompts, appendInstructions, MAX_PROMPT } = require('../media/model-prompts.js');

const catalog = [
  { id: 'claude-sonnet-5-5-high', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', label: 'Claude Sonnet 5.5 High' },
  { id: 'claude-sonnet-5-5-medium', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', label: 'Claude Sonnet 5.5 Medium' },
  { id: 'gemini-3.8-flash-high', agent: 'gemini', model: 'gemini-3.8-flash-high', effort: null, label: 'Gemini 3.8 Flash High' },
];

test('each favorite has its own prompt and permissions while older shared prompts remain compatible', () => {
  const prompts = { [catalog[0].model]: { text: 'Shared instructions' }, [catalog[0].id]: { text: 'High instructions' } };
  assert.equal(promptFor(prompts, catalog[0]), 'High instructions');
  assert.equal(promptFor(prompts, catalog[1]), 'Shared instructions');
  prompts[catalog[0].id].text = '';
  assert.equal(promptFor(prompts, catalog[0]), '', 'clearing overrides an inherited shared prompt');
  const settings = { [catalog[0].id]: { permissionMode: 'ask' } };
  assert.equal(permissionFor(settings, catalog[0], 'fullAccess'), 'ask');
  assert.equal(permissionFor(settings, catalog[1], 'fullAccess'), 'fullAccess');
  settings[catalog[0].id].permissionMode = 'invalid';
  assert.equal(permissionFor(settings, catalog[0], 'auto'), 'auto');
});

test('live Claude turns apply permission changes before sending the prompt', async () => {
  const { StreamEngine } = require('../lib/stream-engine');
  const engine = new StreamEngine({ permissionMode: 'fullAccess', interactive: true });
  const writes = [];
  const child = { permissionMode: 'fullAccess', stdin: { writable: true, write: (text) => writes.push(JSON.parse(text)) } };
  engine.live = child;
  engine.sendToLive({ agent: 'claude', prompt: 'Check sources', attachments: [], permissionMode: 'ask' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].request.subtype, 'set_permission_mode');
  assert.equal(writes[0].request.mode, 'default');
  engine.consumeLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: writes[0].request_id, response: {} } }), 'claude');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes[1].type, 'user');
  assert.equal(child.permissionMode, 'ask');
  const events = [];
  engine.on('event', (event) => events.push(event));
  engine.sendToLive({ agent: 'claude', prompt: 'Blocked turn', attachments: [], permissionMode: 'fullAccess' });
  engine.consumeLine(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: writes[2].request_id, error: 'Mode unavailable' } }), 'claude');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 3, 'refused permission changes never send the prompt');
  assert.equal(events.at(-1).type, 'turn_complete');
});

test('withPrompt: saves, trims, caps, and removes on empty text, without touching the old map', () => {
  const before = {};
  const saved = withPrompt(before, 'claude-sonnet-5-5', 'Claude Sonnet 5.5', '  Verify designs by rendering them.  ');
  assert.deepEqual(before, {});
  assert.equal(saved['claude-sonnet-5-5'].text, 'Verify designs by rendering them.');
  assert.equal(saved['claude-sonnet-5-5'].label, 'Claude Sonnet 5.5');
  assert.deepEqual(withPrompt(saved, 'claude-sonnet-5-5', 'x', '   '), {});
  assert.equal(withPrompt({}, 'm', 'M', 'x'.repeat(MAX_PROMPT + 50)).m.text.length, MAX_PROMPT);
  assert.deepEqual(withPrompt({ a: { text: 't', label: 'A' } }, '', 'x', 'y'), { a: { text: 't', label: 'A' } });
});

test('promptFor: keyed by the exact model, so a new version starts without it', () => {
  const prompts = { 'claude-sonnet-5-5': { text: 'Render designs.', label: 'Sonnet 5.5' } };
  assert.equal(promptFor(prompts, catalog[0]), 'Render designs.');
  assert.equal(promptFor(prompts, catalog[1]), 'Render designs.'); // any effort of the same model
  assert.equal(promptFor(prompts, { model: 'claude-sonnet-5-6' }), '');
  assert.equal(promptFor(prompts, null), '');
  assert.equal(promptFor(undefined, catalog[0]), '');
});

test('modelRows: one row per model, the effort dropped from its name', () => {
  assert.deepEqual(modelRows(catalog).map((row) => [row.model, row.label]), [['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['gemini-3.8-flash-high', 'Gemini 3.8 Flash High']]);
});

test('retiredPrompts: the prompts of models that left the catalog', () => {
  const prompts = { 'claude-sonnet-5-5': { text: 'a', label: 'Sonnet 5.5' }, 'claude-sonnet-5-4': { text: 'b', label: 'Sonnet 5.4' } };
  assert.deepEqual(retiredPrompts(prompts, catalog), [{ model: 'claude-sonnet-5-4', text: 'b', label: 'Sonnet 5.4' }]);
});

test('appendInstructions: your text, the model prompt, then Auto-Verify last; missing parts leave no gaps', () => {
  assert.equal(appendInstructions('Fix it', { modelPrompt: 'Render designs.', verify: '[Auto-Verify] run tests' }), 'Fix it\n\nRender designs.\n\n[Auto-Verify] run tests');
  assert.equal(appendInstructions('Fix it', { verify: '[Auto-Verify] x' }), 'Fix it\n\n[Auto-Verify] x');
  assert.equal(appendInstructions('Fix it', { modelPrompt: 'Render.' }), 'Fix it\n\nRender.');
  assert.equal(appendInstructions('Fix it'), 'Fix it');
});
