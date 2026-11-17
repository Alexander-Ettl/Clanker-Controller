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

test('copilot descriptor builds commands and normalizes events', async () => {
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

test('copilot models come only from the CLI\'s ACP session (account list); a failure is an error, not a fallback list', async () => {
  const copilot = providers.get('copilot');
  const acp = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'not-a-uuid', models: { currentModelId: 'claude-sonnet-5.5', availableModels: [
      { modelId: 'auto', name: 'Auto' }, { modelId: 'auto', name: 'Auto', _meta: { copilotEnablement: 'enabled' } },
      { modelId: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', _meta: { copilotEnablement: 'enabled' } },
      { modelId: 'gpt-6-sol', name: 'GPT-6 Sol' }, { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { copilotEnablement: 'disabled' } },
    ] } } }),
  ].join('\n');
  const calls = [];
  const found = await copilot.discoverModels({ file: 'copilot', runCli: async (file, args, timeout, onLine, input) => { calls.push({ args, input }); return { ok: true, stdout: acp }; } });
  assert.deepEqual(calls[0].args, ['--acp']);
  assert.match(calls[0].input, /"method":"initialize"[\s\S]*"method":"session\/new"/);
  assert.equal(calls[0].input.includes('session/prompt'), false, 'discovery never sends a prompt');
  assert.deepEqual(found.map((e) => e.model), ['auto', 'claude-sonnet-5.5', 'gpt-6-sol'], 'deduplicated, disabled models dropped');
  assert.equal(found.find((e) => e.isDefault).model, 'claude-sonnet-5.5');
  assert.equal(found[2].label, 'Copilot · GPT-6 Sol');

  const failing = (result) => copilot.discoverModels({ file: 'copilot', runCli: async () => result });
  await assert.rejects(failing({ ok: false, code: 1, stdout: '', stderr: 'boom\nError: not authenticated\n' }), /Could not discover Copilot models: Error: not authenticated/);
  await assert.rejects(failing({ ok: true, stdout: JSON.stringify({ jsonrpc: '2.0', id: 2, error: { message: 'Session limit' } }) }), /Session limit/);
  await assert.rejects(failing({ ok: true, stdout: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { models: { availableModels: [] } } }) }), /no enabled models/);
});

test('the copilot model probe removes only its own empty session folder', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { removeProbeSession } = providers.get('copilot');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  const make = (id, files) => { const dir = path.join(home, 'session-state', id); fs.mkdirSync(dir, { recursive: true }); for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text); return dir; };
  const empty = make('11111111-1111-1111-1111-111111111111', { 'workspace.yaml': 'client_name: github/acp\n' });
  const used = make('22222222-2222-2222-2222-222222222222', { 'workspace.yaml': 'client_name: github/acp\n', 'events.jsonl': '{}' });
  const other = make('33333333-3333-3333-3333-333333333333', { 'workspace.yaml': 'client_name: cli\n' });
  for (const dir of [empty, used, other]) removeProbeSession(path.basename(dir), { COPILOT_HOME: home });
  removeProbeSession('../..', { COPILOT_HOME: home });
  assert.equal(fs.existsSync(empty), false);
  assert.equal(fs.existsSync(used), true);
  assert.equal(fs.existsSync(other), true);
  fs.rmSync(home, { recursive: true, force: true });
});
