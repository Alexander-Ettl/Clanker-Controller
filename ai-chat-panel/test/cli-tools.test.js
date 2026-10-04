'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, parseAgyLatest, isNewer, parseCodexModels, parseClaudeModels, parseAgyModels, CliHub } = require('../lib/cli-tools.js');
const { MODEL_CATALOG, AVAILABLE_MODELS, setModelCatalog, setFavoriteModels, modelOption, defaultModel } = require('../lib/model-catalog.js');

test('parseVersion: pulls x.y.z out of each CLI\'s --version line', () => {
  assert.equal(parseVersion('codex-cli 0.159.2'), '0.159.2');
  assert.equal(parseVersion('2.1.284 (Claude Code)'), '2.1.284');
  assert.equal(parseVersion('1.2.14\n'), '1.2.14');
  assert.equal(parseVersion('no version here'), null);
});

test('automatic version checks expose progress and deduplicate overlapping checks for every provider', async () => {
  let finish;
  let calls = 0;
  const broadcasts = [];
  const hub = new CliHub({ store: { get: () => [] }, promptStore: { get: () => ({}) }, broadcast: (message) => broadcasts.push(message),
    checkVersionsImpl: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const first = hub.check();
  assert.equal(hub.snapshot().checking, true);
  assert.equal(hub.check(), first);
  assert.equal(calls, 1);
  finish({ claude: { version: '2.1.286', latest: '2.1.286', outdated: false },
    codex: { version: '0.159.3', latest: '0.159.4', outdated: true },
    gemini: { version: '1.2.14', latest: null, outdated: false } });
  await first;
  assert.equal(hub.snapshot().checking, false);
  assert.deepEqual(hub.snapshot().updates, ['codex']);
  assert.equal(broadcasts.find((message) => message.type === 'cliStatus').checking, true);
  assert.equal(broadcasts.at(-1).checking, false);
});

test('update all starts outdated enabled CLIs in parallel and isolates failures', async () => {
  const started = [], finish = {};
  const hub = new CliHub({ store: { get: () => [] }, promptStore: { get: () => ({}) }, broadcast() {} });
  hub.accounts = { isEnabled: (agent) => agent !== 'gemini' };
  hub.versions = Object.fromEntries(['claude', 'codex', 'gemini'].map(agent => [agent, { outdated: true }]));
  hub.update = agent => { started.push(agent); return new Promise((resolve, reject) => { finish[agent] = { resolve, reject }; }); };
  const pending = hub.updateAll();
  assert.deepEqual(started, ['claude', 'codex'], 'both start before either finishes; disabled CLI is skipped');
  finish.claude.reject(new Error('Update failed'));
  finish.codex.resolve();
  assert.deepEqual((await pending).map(result => result.status), ['rejected', 'fulfilled']);
  hub.versions = { claude: { outdated: false }, codex: { outdated: false } };
  started.length = 0;
  await hub.updateAll();
  assert.deepEqual(started, [], 'current CLIs are skipped');
});

test('favorite editors persist individual permissions and carry configuration when reasoning changes', () => {
  const memory = (initial) => { let value = initial; return { get: () => value, set: (next) => { value = next; } }; };
  const models = parseCodexModels(JSON.stringify({ models: [{ slug: 'gpt-9-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] }] }));
  const store = memory([models[0]]), settingsStore = memory({}), promptStore = memory({});
  const hub = new CliHub({ store, settingsStore, promptStore, cacheStore: memory(models), broadcast() {} });
  hub.setModelSettings(models[0].id, 'ask');
  hub.setModelSettings(models[1].id, 'fullAccess');
  assert.equal(hub.modelSettings[models[1].id], undefined, 'only favorites may be configured');
  hub.setPrompt(models[0].id, models[0].label, 'Check sources.');
  hub.changeFavorite(models[0].id, models[1].id);
  assert.equal(store.get()[0].effort, 'high');
  assert.equal(settingsStore.get()[models[1].id].permissionMode, 'ask');
  assert.equal(promptStore.get()[models[1].id].text, 'Check sources.');
  hub.setModelSettings(models[1].id, 'inherit');
  assert.equal(settingsStore.get()[models[1].id], undefined);
  hub.setModelSettings(models[1].id, 'invalid');
  assert.equal(settingsStore.get()[models[1].id], undefined);
  const blankStore = memory([models[0]]);
  const blankHub = new CliHub({ store: blankStore, promptStore: memory({ [models[0].model]: { text: 'Legacy shared prompt' } }), cacheStore: memory(models), broadcast() {} });
  blankHub.setPrompt(models[0].id, models[0].label, '');
  blankHub.changeFavorite(models[0].id, models[1].id);
  assert.equal(blankHub.prompts[models[1].id].text, '', 'reasoning changes retain an explicit cleared prompt');
});

test('parseAgyLatest: the stable version, but only once it is rolled out to everyone', () => {
  assert.equal(parseAgyLatest('Antigravity CLI auto updater is running! Stable Version: 1.2.14. Rolled out to 100%'), '1.2.14');
  assert.equal(parseAgyLatest('Stable Version: 1.3.0. Rolled out to 20%'), null);
  assert.equal(parseAgyLatest('<html>404</html>'), null);
});

test('isNewer: compares numerically, not as text', () => {
  assert.equal(isNewer('0.159.3', '0.159.2'), true);
  assert.equal(isNewer('2.1.286', '2.1.284'), true);
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.2.14', '1.2.14'), false);
  assert.equal(isNewer('0.9.0', '0.159.2'), false);
});

test('parseCodexModels: one entry per listed model and effort, hidden models dropped', () => {
  const json = JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide', supported_reasoning_levels: [{ effort: 'high' }] },
  ] });
  const entries = parseCodexModels(json);
  assert.deepEqual(entries.map((e) => e.id), ['gpt-6.1-sol-low', 'gpt-6.1-sol-high']);
  assert.equal(entries[1].model, 'gpt-6.1-sol');
  assert.equal(entries[1].effort, 'high');
  assert.equal(entries[1].label, 'GPT 6.1 Sol High');
  assert.equal(entries[1].shortLabel, 'Sol');
  assert.deepEqual(parseCodexModels('not json'), []);
});

test('parseAgyModels: tab-separated id and label, banner line ignored', () => {
  const entries = parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n');
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].id, entries[0].agent, entries[0].model, entries[0].effort], ['gemini-3.8-flash-high', 'gemini', 'gemini-3.8-flash-high', null]);
  assert.equal(entries[0].shortLabel, 'Flash');
  assert.equal(entries[0].label, 'Gemini 3.8 Flash High');
});

test('picker has no built-ins; shuffled favorites group a model\'s efforts together', () => {
  setModelCatalog([]);
  setFavoriteModels([]);
  assert.equal(MODEL_CATALOG.length, 0);
  const models = parseCodexModels(JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'medium' }] },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
  ] }));
  setModelCatalog(models);
  const solHigh = models.find((entry) => entry.id === 'gpt-6.1-sol-high');
  const solMedium = models.find((entry) => entry.id === 'gpt-6.1-sol-medium');
  setFavoriteModels([solHigh, models[0], { ...solMedium, label: 'GPT-6.1-Sol Medium' }, solHigh]);
  assert.deepEqual(MODEL_CATALOG.map((entry) => entry.label), ['GPT 6 Astra High', 'GPT 6.1 Sol Medium', 'GPT 6.1 Sol High']);
  setFavoriteModels([]);
  assert.equal(MODEL_CATALOG.length, 0);
  assert.equal(modelOption(solHigh.id).effort, 'high', 'a saved chat still resolves an unfavorited model');
});

test('Claude initialize discovery deduplicates aliases and uses reported efforts and versions', () => {
  const response = { type: 'control_response', response: { request_id: 'model-discovery', response: { models: [
    { value: 'default', resolvedModel: 'claude-opus-9-2', displayName: 'Default (recommended)', supportedEffortLevels: ['medium', 'high'] },
    { value: 'opus', resolvedModel: 'claude-opus-9-2', displayName: 'Opus 9.2', supportedEffortLevels: ['medium', 'high'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-7', displayName: 'Haiku 7' },
  ] } } };
  const entries = parseClaudeModels('startup noise\n' + JSON.stringify(response));
  assert.equal(entries.length, 3);
  assert.equal(entries.find((entry) => entry.isDefault).label, 'Claude Opus 9.2 Medium');
  assert.equal(entries.find((entry) => entry.effort === 'high').brand, 'opus');
  assert.equal(entries.find((entry) => entry.model === 'claude-haiku-7').effort, null);
  assert.deepEqual(parseClaudeModels('invalid'), []);
});

test('CLI hub refresh updates cached names, preserves favorites and survives a provider failure', async () => {
  const memory = (initial) => { let value = initial; return { get: () => value, set: (next) => { value = next; } }; };
  const codex = parseCodexModels(JSON.stringify({ models: [{ slug: 'gpt-9-sol', display_name: 'GPT-9-Sol', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] }] }));
  const store = memory([{ ...codex[1], label: 'old-name' }]);
  const cacheStore = memory(codex);
  const broadcasts = [];
  let discovered = { codex, claude: null, gemini: null };
  const hub = new CliHub({ store, cacheStore, promptStore: memory({}), broadcast: (message) => broadcasts.push(message), discover: async () => discovered });
  await hub.refreshModels();
  assert.equal(MODEL_CATALOG[0].label, 'GPT 9 Sol High');
  assert.equal(defaultModel('codex').effort, 'high');
  discovered = { codex: null, claude: null, gemini: null };
  await hub.refreshModels();
  assert.equal(AVAILABLE_MODELS.length, 2, 'failed discovery keeps cache');
  assert.ok(broadcasts.some((message) => message.type === 'modelCatalog'));
  hub.toggleFavorite(codex[1].id);
  assert.equal(MODEL_CATALOG.length, 0, 'every model can be removed');
  await hub.refreshModels();
  assert.equal(MODEL_CATALOG.length, 0, 'refresh never re-adds removed favorites');
  hub.toggleFavorite(codex[0].id);
  assert.equal(MODEL_CATALOG[0].label, 'GPT 9 Sol Medium');
  const restored = new CliHub({ store, cacheStore, promptStore: memory({}), broadcast() {} });
  assert.equal(restored.fetched.length, 2, 'restart loads dynamic cache before discovery');
  assert.equal(MODEL_CATALOG[0].effort, 'medium');
});
