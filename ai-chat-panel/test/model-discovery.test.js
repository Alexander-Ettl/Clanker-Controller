'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModels, MODEL_CATALOG } = require('../lib/model-catalog');
const { CliHub, releaseStatus, parseClaudeModels, parseAgyModels } = require('../lib/cli-tools');

const memory = (initial) => { let value = initial; return { get: () => value, set: (next) => { value = next; } }; };
const native = parseClaudeModels(JSON.stringify({ type: 'control_response', response: { request_id: 'model-discovery', response: { models: [
  { value: 'default', resolvedModel: 'claude-future-42', supportedEffortLevels: ['medium'] },
] } } }));
const hosted = parseAgyModels('claude-future-42-medium\tClaude Future 42 Medium');

test('identical upstream models retain both CLI routes in either discovery order', () => {
  for (const entries of [[...native, ...hosted], [...hosted, ...native]]) {
    const models = normalizeModels(entries);
    assert.equal(models.length, 2);
    assert.equal(models.find((m) => m.agent === 'claude').id, 'claude-future-42-medium');
    assert.equal(models.find((m) => m.agent === 'gemini').id, 'gemini:claude-future-42-medium');
    assert.equal(models.find((m) => m.agent === 'gemini').model, 'claude-future-42-medium');
    assert.ok(models.every((m) => m.company === 'Anthropic'));
    assert.deepEqual(normalizeModels(models), models, 'cache normalization is idempotent');
  }
});

test('unknown shared model namespaces preserve every route without depending on discovery order', () => {
  const entries = ['claude', 'codex', 'gemini'].map((agent) => ({ id: 'future-42', model: 'future-42', agent }));
  const models = normalizeModels(entries);
  assert.equal(models.length, 3);
  assert.deepEqual(normalizeModels(entries.toReversed()), models);
  assert.deepEqual(normalizeModels(models), models);
});

test('refresh restores missing native favorites and migrates hosted favorites without rerouting', async () => {
  const oldHosted = { ...hosted[0], id: 'claude-future-42-medium' };
  const store = memory([native[0], oldHosted]);
  const cache = memory([oldHosted]);
  const promptStore = memory({ [oldHosted.id]: { text: 'Keep my instructions' } });
  const settingsStore = memory({ [oldHosted.id]: { permissionMode: 'ask' } });
  const hub = new CliHub({ store, cacheStore: cache, promptStore, settingsStore, broadcast() {},
    discover: async () => ({ claude: native, gemini: hosted, codex: null }) });
  await hub.refreshModels();
  assert.deepEqual(MODEL_CATALOG.map((m) => m.agent), ['claude', 'gemini']);
  assert.equal(new Set(MODEL_CATALOG.map((m) => m.id)).size, 2);
  assert.deepEqual(hub.snapshot().favorites, MODEL_CATALOG.map((m) => m.id));
  assert.equal(promptStore.get()[hosted[0].id].text, 'Keep my instructions');
  assert.equal(settingsStore.get()[hosted[0].id].permissionMode, 'ask');
  hub.toggleFavorite(hosted[0].id);
  assert.deepEqual(MODEL_CATALOG.map((m) => m.agent), ['claude']);
  assert.equal(cache.get().length, 2);
});

test('release checks retain network and HTTP failures and recover for every provider', async () => {
  for (const agent of ['claude', 'codex', 'gemini']) {
    assert.deepEqual(await releaseStatus(agent, async () => { throw new Error('Offline'); }), { latest: null, error: 'Offline' });
    assert.deepEqual(await releaseStatus(agent, async () => ({ ok: false, status: 503 })), { latest: null, error: 'Release service returned HTTP 503' });
    const result = await releaseStatus(agent, async () => ({ ok: true, json: async () => ({ version: '99.4.2' }),
      text: async () => 'Stable Version: 99.4.2. Rolled out to 100%' }));
    assert.deepEqual(result, { latest: '99.4.2', error: null });
  }
});
