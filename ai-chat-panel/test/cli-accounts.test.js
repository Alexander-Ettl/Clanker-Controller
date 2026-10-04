'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CliAccounts, terminalSpec } = require('../lib/cli-accounts');
const { CliHub } = require('../lib/cli-tools');
const { route } = require('../lib/auto-router');
const { MODEL_CATALOG, defaultModel, modelOption, setEnabledAgents } = require('../lib/model-catalog');

function fixture(saved, existingUser = false) {
  const terminals = [], messages = [], checks = [];
  let value = saved;
  const paths = { claude: 'C:/Program Files/Claude/claude.exe', codex: 'C:/Codex/codex.exe', gemini: null };
  const accounts = new CliAccounts({
    store: { get: () => value, set: async next => { value = next; } }, existingUser, cwd: 'C:/Work space',
    vscode: { window: { terminals, createTerminal(options) {
      const terminal = { options, show() {}, dispose() { terminals.splice(terminals.indexOf(terminal), 1); } };
      terminals.push(terminal); return terminal;
    } } },
    find: agent => ({ path: paths[agent] }), reset() {}, broadcast: message => messages.push(message),
    run: async (file, args) => { checks.push({ file, args }); return { ok: true, stdout: file.includes('agy') ? 'gemini-flash\tGemini Flash' : '{"loggedIn":true,"secret":"never sent"}' }; },
  });
  return { accounts, terminals, messages, checks, paths, saved: () => value };
}

test('new profiles start with a welcome, legacy profiles keep their providers', async () => {
  const fresh = fixture();
  assert.equal(fresh.accounts.snapshot().setupNeeded, true);
  assert.deepEqual(fresh.accounts.enabledAgents(), []);
  await fresh.accounts.check();
  assert.equal(fresh.checks.length, 0, 'unselected CLIs never start an auth flow');
  const legacy = fixture(undefined, true);
  assert.deepEqual(legacy.accounts.enabledAgents(), ['claude', 'codex', 'gemini']);
  assert.equal(legacy.accounts.snapshot().setupNeeded, false);
  await fresh.accounts.complete();
  const restored = fixture(fresh.saved());
  assert.equal(restored.accounts.snapshot().setupNeeded, false, 'Set up later is remembered');
});

test('one or all CLIs open native sign-in; duplicate clicks reuse setup terminals', async () => {
  const f = fixture();
  await f.accounts.connect('claude');
  assert.deepEqual(f.terminals[0].options.shellArgs, ['auth', 'login']);
  assert.equal(f.terminals[0].options.shellPath, f.paths.claude);
  await f.accounts.connect('claude');
  assert.equal(f.terminals.length, 1);
  await f.accounts.connectAll();
  assert.equal(f.terminals.length, 3);
  assert.deepEqual(f.accounts.enabledAgents(), ['claude', 'codex', 'gemini']);
  assert.match(f.terminals[2].options.shellArgs.at(-1), /antigravity.google\/cli\/install.ps1/);
  assert.deepEqual(f.terminals[1].options.shellArgs, ['login']);
  assert.equal(f.accounts.snapshot().providers.claude.auth, 'unknown', 'opening login is not authentication success');
  await f.accounts.connect('codex; Remove-Item C:/');
  assert.equal(f.terminals.length, 3);
  await f.accounts.check();
  assert.equal(f.accounts.snapshot().providers.claude.auth, 'connected');
  assert.equal(f.accounts.snapshot().providers.gemini.auth, 'missing');
  assert.equal(JSON.stringify(f.messages).includes('never sent'), false);
  f.paths.gemini = 'C:/agy/agy.exe';
  await f.accounts.check();
  assert.equal(f.accounts.snapshot().providers.gemini.auth, 'ready', 'AGY readiness is not advertised as verified account authentication');
  await f.accounts.remove('codex');
  assert.equal(f.accounts.isEnabled('codex'), false);
  assert.equal(f.checks.some(check => check.args.includes('logout')), false);
  assert.equal(f.paths.codex, 'C:/Codex/codex.exe', 'remove keeps the installation');
  assert.deepEqual(fixture(f.saved()).accounts.enabledAgents(), ['claude', 'gemini']);
});

test('native terminal specs quote shims and offer Windows installs without WSL', () => {
  assert.throws(() => terminalSpec('unknown', null), /Unknown/);
  assert.match(terminalSpec('claude', null, 'win32').shellArgs.at(-1), /claude.ai\/install.ps1/);
  assert.match(terminalSpec('codex', null, 'win32').shellArgs.at(-1), /npm.cmd install -g @openai\/codex/);
  assert.match(terminalSpec('codex', "C:/O'Brien tools/codex.cmd", 'win32').shellArgs.at(-1), /O''Brien/);
  assert.throws(() => terminalSpec('gemini', null, 'darwin'), /official website/);
});

test('failed checks never report connected; overlapping checks share one run and refresh', async () => {
  const f = fixture({ enabled: ['claude'], completed: false });
  let resolveCheck, refreshed = 0, calls = 0;
  f.accounts.run = () => { calls++; return new Promise(resolve => { resolveCheck = resolve; }); };
  f.accounts.onChecked = async () => { refreshed++; };
  const first = f.accounts.check();
  assert.equal(f.accounts.check(), first);
  assert.equal(f.accounts.snapshot().checking, true);
  resolveCheck({ ok: false, stdout: 'private error detail' });
  await first;
  assert.equal(calls, 1);
  assert.equal(refreshed, 1);
  assert.equal(f.accounts.snapshot().providers.claude.auth, 'signin');
  assert.equal(f.accounts.snapshot().checking, false);
  assert.equal(JSON.stringify(f.messages).includes('private error detail'), false);
  f.accounts.dispose();
  await f.accounts.check();
  assert.equal(calls, 1, 'disposal stops checks');
});

test('removing and readding a CLI preserves favorites and excludes it from Auto', async () => {
  const f = fixture({ enabled: ['claude', 'codex'], completed: true });
  const entries = [{ id: 'claude-test', model: 'claude-test', agent: 'claude', label: 'Claude Test' }, { id: 'codex-test', model: 'gpt-test', agent: 'codex', label: 'GPT Test' }];
  const memory = initial => { let value = initial; return { get: () => value, set: next => { value = next; } }; };
  const store = memory(entries);
  const hub = new CliHub({ accounts: f.accounts, store, cacheStore: memory(entries), promptStore: memory({}), broadcast() {}, discover: async enabled => {
    assert.deepEqual(enabled, ['claude']);
    return { claude: [entries[0]], codex: null, gemini: null };
  } });
  try {
    await f.accounts.remove('codex');
    hub.connectionsChanged();
    assert.deepEqual(MODEL_CATALOG.map(entry => entry.agent), ['claude']);
    assert.equal(defaultModel('codex'), null);
    assert.equal(modelOption('codex-test').model, 'gpt-test', 'saved chats retain their exact model metadata');
    assert.equal(route('Fix the backend parser', {}, 'auto', f.accounts.enabledAgents()).agent, 'claude');
    assert.throws(() => route('Hello', {}, 'auto', []), /Add a CLI/);
    await hub.refreshModels();
    assert.deepEqual(hub.snapshot().fetched.map(entry => entry.agent), ['claude']);
    assert.equal(store.get().length, 2);
    await f.accounts.connect('codex');
    hub.connectionsChanged();
    assert.equal(MODEL_CATALOG.length, 2);
  } finally { setEnabledAgents(['claude', 'codex', 'gemini']); }
});
