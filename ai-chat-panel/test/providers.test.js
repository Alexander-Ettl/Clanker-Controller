'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../lib/providers');
const { candidates } = require('../lib/binary-locator.js');
const { terminalSpec } = require('../lib/cli-accounts.js');
const { fetchModels, parseCodexModels } = require('../lib/cli-tools.js');
const { normalizeModels, setEnabledAgents, defaultModel, setModelCatalog } = require('../lib/model-catalog.js');
const { StreamEngine, normalizeEvent } = require('../lib/stream-engine.js');

const cursor = () => ({
  id: 'cursor',
  name: 'Cursor',
  company: 'Anysphere',
  color: '#22d3ee',
  cli: 'cursor-agent',
  locate: ({ join, home }) => [join(home, '.cursor', 'bin', 'cursor-agent.exe')],
  npmPackage: 'cursor-agent',
  login: ['login'],
  authStatus: { args: ['status'], interpret: (result) => (result.ok ? 'connected' : 'signin') },
  install: 'irm https://cursor.example/install.ps1 | iex',
  discoverModels: async () => [{ id: 'cursor-fast', agent: 'cursor', model: 'cursor-fast', effort: null, label: 'Cursor Fast', isDefault: true }],
});

test('the built-in providers are registered, valid and in a stable order', () => {
  assert.deepEqual(providers.ids(), ['claude', 'codex', 'gemini', 'copilot']);
  for (const provider of providers.all()) assert.deepEqual(providers.validate(provider), [], provider.id);
  assert.equal(providers.get('gemini').accountName, 'Gemini / Antigravity');
  assert.equal(providers.get('claude').accountName, 'Claude Code'); // defaults to the name
  assert.equal(providers.get('copilot').optional, true);
  assert.equal(providers.get('codex').updateArgs[0], 'update');
});

test('a descriptor missing pieces is refused with every problem named', () => {
  assert.throws(() => providers.register({ id: 'Bad Id', name: 'x' }), /id must be[\s\S]*company is required[\s\S]*color must be[\s\S]*locate/);
  assert.equal(providers.has('Bad Id'), false);
});

test('a provider registered at run time flows through locating, sign-in, model discovery, the picker and the webview data', async () => {
  providers.register(cursor());
  try {
    assert.deepEqual(providers.ids(), ['claude', 'codex', 'gemini', 'copilot', 'cursor']);
    assert.match(candidates('cursor')[0], process.platform === 'win32' ? /cursor-agent\.exe$/ : /cursor-agent$/);
    assert.deepEqual(candidates('nothing-registered'), []);

    const install = terminalSpec('cursor', null, 'win32');
    assert.equal(install.shellArgs.at(-1), 'irm https://cursor.example/install.ps1 | iex');
    assert.throws(() => terminalSpec('nothing-registered', null, 'win32'), /Unknown CLI/);

    // Discovery only runs for an installed provider (a binary the locator finds): none here, so null, and nothing breaks.
    const found = await fetchModels(['cursor']);
    assert.equal(found.cursor, null);
    const direct = normalizeModels(await providers.get('cursor').discoverModels({ file: 'x', runCli: async () => ({}) }));
    assert.equal(direct[0].label, 'Cursor Fast');

    setEnabledAgents(providers.ids());
    setModelCatalog(direct);
    assert.equal(defaultModel('cursor').id, 'cursor-fast');

    assert.equal(providers.displayList().at(-1).name, 'Cursor');
    assert.match(providers.accentCss(), /--cursor-color: #22d3ee;[\s\S]*\[data-agent='cursor'\] \{ --agent: var\(--cursor-color\); \}/);
    assert.equal(JSON.stringify(providers.displayList()).includes('locate'), false, 'no functions reach the webviews');
  } finally {
    providers.unregister('cursor');
    setModelCatalog([]);
  }
  assert.deepEqual(providers.ids(), ['claude', 'codex', 'gemini', 'copilot']);
});

test('copilot descriptor builds commands, discovers fallback models, and normalizes events', async () => {
  const copilot = providers.get('copilot');
  const discovered = await copilot.discoverModels({ file: 'copilot.cmd', runCli: async () => ({ ok: false }) });
  assert.ok(discovered.length >= 3);
  assert.equal(discovered[0].agent, 'copilot');
  const engine = new StreamEngine({ cwd: 'C:/Repo', models: { copilot: 'claude-sonnet-4.5' } });
  try {
    const spec = engine.commandFor('copilot', 'Fix tests', [], { model: 'gpt-5', resume: 'sess-1', permissionMode: 'fullAccess' });
    assert.deepEqual(spec.args, ['-p', 'Fix tests', '--model', 'gpt-5', '--resume', 'sess-1', '--allow-all-tools', '--add-dir', 'C:/Repo']);
    assert.deepEqual(normalizeEvent({ type: 'init', session_id: 'sess-1' }, 'copilot'), { type: 'session', sessionId: 'sess-1', agent: 'copilot' });
    assert.deepEqual(normalizeEvent({ type: 'delta', text: 'Hello from Copilot' }, 'copilot'), { type: 'delta', text: 'Hello from Copilot', model: 'copilot', agent: 'copilot' });
  } finally {
    engine.dispose();
  }
});

test('model lists still parse through the providers (Codex sample)', () => {
  const text = JSON.stringify({ models: [{ slug: 'gpt-x', display_name: 'GPT X', visibility: 'list', is_default: true, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] }] });
  assert.deepEqual(parseCodexModels(text).map((entry) => entry.id), ['gpt-x-low', 'gpt-x-medium']);
});
