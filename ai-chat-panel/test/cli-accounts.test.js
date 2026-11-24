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
    languageServer: async () => null, home: require('node:path').join(require('node:os').tmpdir(), 'clanker-no-home'), store: { get: () => value, set: async next => { value = next; } }, existingUser, cwd: 'C:/Work space',
    vscode: { window: { terminals, createTerminal(options) {
      const terminal = { options, show() {}, dispose() { terminals.splice(terminals.indexOf(terminal), 1); } };
      terminals.push(terminal); return terminal;
    } } },
    find: agent => ({ path: paths[agent] }), reset() {}, spec: (agent, file) => terminalSpec(agent, file, 'win32'), // these flows are the Windows ones
    broadcast: message => messages.push(message),
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

const CRASH = `file:///C:/npm/codex.js:107
  throw new Error(
        ^

Error: Missing optional dependency @openai/codex-win32-x64. Reinstall Codex: npm install -g @openai/codex@latest
    at findCodexExecutable (file:///C:/npm/codex.js:107:9)

Node.js v24.18.0`;

test('a Codex install that cannot start shows its real error and the sign-in button repairs it', async () => {
  const f = fixture();
  f.accounts.run = async () => ({ ok: false, stdout: '', stderr: CRASH });
  await f.accounts.connect('codex');
  assert.equal(f.accounts.snapshot().providers.codex.auth, 'broken');
  assert.match(f.accounts.snapshot().providers.codex.note, /Missing optional dependency @openai\/codex-win32-x64/);
  assert.equal(f.terminals[0].options.shellPath, 'powershell.exe', 'the terminal reinstalls, then signs in');
  assert.match(f.terminals[0].options.shellArgs.at(-1), /npm.cmd install -g @openai\/codex@latest.*login/);
  f.accounts.run = async () => ({ ok: false, stdout: '', stderr: 'Not logged in' });
  await f.accounts.check();
  assert.equal(f.accounts.snapshot().providers.codex.auth, 'signin', 'signed out is not a damaged install');
});
test('native terminal specs quote shims and offer Windows installs without WSL', () => {
  assert.throws(() => terminalSpec('unknown', null), /Unknown/);
  assert.match(terminalSpec('claude', null, 'win32').shellArgs.at(-1), /claude.ai\/install.ps1/);
  assert.match(terminalSpec('codex', null, 'win32').shellArgs.at(-1), /npm.cmd install -g @openai\/codex/);
  assert.match(terminalSpec('codex', "C:/O'Brien tools/codex.cmd", 'win32').shellArgs.at(-1), /O''Brien/);
  assert.match(terminalSpec('gemini', null, 'linux').shellArgs.at(-1), /antigravity.google\/cli\/install.sh/);
  assert.deepEqual(terminalSpec('gemini', '/home/me/.local/bin/agy', 'linux'), { shellPath: '/home/me/.local/bin/agy', shellArgs: [] }, 'sign-in is the bare CLI');
});

test('Antigravity signs in from its own terminal: the browser menu is chosen for you and the terminal closes once it works', async () => {
  const timers = [];
  const realSet = global.setTimeout;
  global.setTimeout = (fn) => { const t = { fn, unref() {} }; timers.push(t); return t; };
  try {
    const f = fixture({ enabled: ['gemini'] });
    f.paths.gemini = '/home/me/.local/bin/agy';
    let signedIn = false; const sent = [];
    f.accounts.run = async () => (signedIn ? { ok: true, stdout: 'gemini-flash\tGemini Flash' } : { ok: false, stdout: '', stderr: 'Please sign in to view available models.' });
    await f.accounts.check();
    const fault = f.accounts.fault('gemini');
    assert.equal(fault.action, 'fixCli', 'a signed-out Antigravity gets a sign-in button, not "use the IDE"');
    f.accounts.vscode.window.createTerminal = (options) => { const t = { options, sendText: (...a) => sent.push(a), show() {}, dispose() { f.terminals.splice(f.terminals.indexOf(t), 1); } }; f.terminals.push(t); return t; };
    assert.deepEqual(await f.accounts.fix('gemini'), { ok: false });
    assert.equal(f.terminals.length, 1);
    assert.equal(f.terminals[0].options.shellPath, '/home/me/.local/bin/agy');
    timers.shift().fn(); // Enter on "Google OAuth"
    assert.deepEqual(sent, [['', true]]);
    await timers.shift().fn(); // still signed out: keep watching
    assert.equal(f.terminals.length, 1);
    signedIn = true;
    await timers.shift().fn();
    assert.equal(f.terminals.length, 0, 'the setup terminal closes once the account works');
    assert.equal(f.accounts.fault('gemini'), null);
  } finally { global.setTimeout = realSet; }
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

test('a CLI whose plan ended drops out of the picker and Auto, stays listed in Settings, and comes back on request', async () => {
  const f = fixture(undefined, true);
  const store = { value: [{ id: 'claude-test', agent: 'claude', model: 'claude-test', effort: 'medium', label: 'Claude Test' }, { id: 'codex-test', agent: 'codex', model: 'gpt-test', effort: 'medium', label: 'GPT Test' }], get() { return this.value; }, set(next) { this.value = next; } };
  const hub = new CliHub({ store, promptStore: { get: () => ({}), set() {} }, cacheStore: { get: () => store.value, set() {} }, broadcast() {}, accounts: f.accounts });
  try {
    await f.accounts.markUnavailable('codex', { kind: 'plan', reason: 'Your plan or subscription no longer covers it.', detail: 'not supported' });
    hub.connectionsChanged();
    assert.deepEqual(f.accounts.enabledAgents(), ['claude', 'gemini']);
    assert.equal(f.accounts.isEnabled('codex'), false);
    assert.equal(f.accounts.isUnavailable('codex'), true);
    assert.deepEqual(MODEL_CATALOG.map(entry => entry.agent), ['claude']);
    assert.deepEqual(hub.available().map(entry => entry.agent), ['claude']);
    const provider = f.messages.at(-1).providers.codex;
    assert.equal(provider.enabled, true, 'Settings still lists it as added');
    assert.equal(provider.unavailable.kind, 'plan');
    assert.equal(route('Fix the backend parser', {}, 'auto', f.accounts.enabledAgents()).agent, 'claude');
    assert.equal(fixture(f.saved()).accounts.isUnavailable('codex'), true, 'remembered across restarts');
    await f.accounts.check();
    assert.equal(f.checks.some(check => check.file === f.paths.codex), true, 'its sign-in is still checked');
    await f.accounts.restore('codex');
    hub.connectionsChanged();
    assert.equal(MODEL_CATALOG.length, 2);
    assert.equal(f.accounts.snapshot().providers.codex.unavailable, null);
    await f.accounts.markUnavailable('codex', { kind: 'auth', reason: 'x', detail: '' });
    await f.accounts.connect('codex');
    assert.equal(f.accounts.isUnavailable('codex'), false, 'signing in again clears it');
    await f.accounts.markUnavailable('codex', { kind: 'auth', reason: 'x', detail: '' });
    await f.accounts.remove('codex');
    assert.equal(f.accounts.snapshot().providers.codex.unavailable, null, 'removing a CLI forgets it');
    await f.accounts.markUnavailable('codex', { kind: 'plan', reason: 'x', detail: '' });
    assert.equal(f.accounts.isUnavailable('codex'), false, 'a CLI that was not added cannot become unavailable');
  } finally { setEnabledAgents(['claude', 'codex', 'gemini']); }
});

test('a signed-in CLI whose plan ended is hidden up front, and comes back once the plan does', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-plan-'));
  fs.mkdirSync(path.join(home, '.codex'));
  const token = (plan) => `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })).toString('base64url')}.y`;
  const writeAuth = (plan) => fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token(plan) } }));
  try {
    writeAuth('free');
    let status = '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}';
    const f = fixture({ enabled: ['claude', 'codex'] });
    f.accounts.home = home;
    f.accounts.run = async () => ({ ok: true, stdout: status });
    await f.accounts.check();
    assert.deepEqual(f.accounts.enabledAgents(), ['claude'], 'Codex login still says signed in, the plan says Free');
    assert.equal(f.accounts.unavailable.codex.kind, 'plan');
    assert.match(f.accounts.snapshot().providers.codex.unavailable.reason, /Plus/);
    assert.equal(f.saved().unavailable.codex.source, 'plan', 'remembered across restarts');

    status = '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"free"}';
    await f.accounts.check();
    assert.deepEqual(f.accounts.enabledAgents(), [], 'any provider can declare its own plan check');

    writeAuth('plus'); status = '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}';
    await f.accounts.check();
    assert.deepEqual(f.accounts.enabledAgents(), ['claude', 'codex'], 'a plan flag clears itself');

    await f.accounts.markUnavailable('codex', { kind: 'credits', reason: 'x', detail: '' });
    await f.accounts.check();
    assert.equal(f.accounts.isUnavailable('codex'), true, 'a failed-turn flag waits for Try again');
    await f.accounts.restore('codex');
    assert.equal(f.accounts.isUnavailable('codex'), false);

    await f.accounts.markUnavailable('codex', { kind: 'credits', reason: 'x', detail: '' });
    writeAuth('free');
    await f.accounts.restore('codex'); // Try again while the plan is still missing
    assert.equal(f.accounts.isUnavailable('codex'), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Antigravity is checked through its language server: a tier that unlocks no model is flagged', async () => {
  const status = (tier, allowed) => ({ userStatus: { planStatus: { planInfo: { teamsTier: tier } }, cascadeModelConfigData: { clientModelConfigs: allowed.map(allowedTiers => ({ allowedTiers })) } } });
  let answer = status('TEAMS_TIER_PRO', [['TEAMS_TIER_PRO', 'TEAMS_TIER_TEAMS'], ['TEAMS_TIER_TEAMS']]);
  const f = fixture({ enabled: ['gemini'] });
  f.paths.gemini = 'C:/agy/agy.exe';
  f.accounts.languageServer = async (rpc) => (rpc === 'GetUserStatus' ? answer : null);
  await f.accounts.check();
  assert.equal(f.accounts.isUnavailable('gemini'), false, 'one allowed model is enough');
  answer = status('TEAMS_TIER_FREE', [['TEAMS_TIER_PRO'], ['TEAMS_TIER_TEAMS']]);
  await f.accounts.check();
  assert.equal(f.accounts.unavailable.gemini.kind, 'plan');
  answer = null; // Antigravity not running: no verdict, the flag stays as it was
  await f.accounts.check();
  assert.equal(f.accounts.isUnavailable('gemini'), true);
  answer = status('TEAMS_TIER_PRO', [['TEAMS_TIER_PRO']]);
  await f.accounts.check();
  assert.equal(f.accounts.isUnavailable('gemini'), false, 'clears itself');
});

test('an added CLI that fails its status check carries the exit code and a one-click fix for the usage ring', async () => {
  const f = fixture({ enabled: ['claude', 'codex', 'gemini'], completed: true });
  f.paths.gemini = null;
  f.accounts.run = async file => (file.includes('claude') ? { ok: true, code: 0, stdout: '{"loggedIn":true}' } : { ok: false, code: 1, stdout: '', stderr: 'private error detail' });
  await f.accounts.check();
  const { providers } = f.accounts.snapshot();
  assert.equal(providers.claude.fault, null, 'a working CLI has no fault');
  assert.deepEqual(providers.codex.fault, { kind: 'signin', expired: false, code: 1, title: 'Not signed in', detail: 'Codex has no signed-in account. Sign in with your browser and it works again.', action: 'fixCli', label: 'Sign in', steps: ['Press the button to open your browser and sign in.'] });
  assert.deepEqual([providers.gemini.fault.title, providers.gemini.fault.code, providers.gemini.fault.label], ['Not installed', null, 'Install & sign in']);
  assert.equal(JSON.stringify(f.messages).includes('private error detail'), false);

  f.accounts.run = async () => ({ ok: false, code: 1, stdout: '', stderr: CRASH });
  await f.accounts.check();
  const broken = f.accounts.snapshot().providers.codex.fault;
  assert.deepEqual([broken.title, broken.code, broken.label], ['Cannot start', 1, 'Repair & sign in']);
  assert.match(broken.detail, /Missing optional dependency @openai\/codex-win32-x64/);

  await f.accounts.markUnavailable('claude', { kind: 'plan', reason: 'Plan ended.', detail: 'Renew it.' });
  assert.deepEqual(f.accounts.snapshot().providers.claude.fault, { kind: 'plan', code: null, title: 'Plan ended.', detail: 'Renew it.', action: 'restoreCli', label: 'Try again', steps: ['Fix the plan or subscription, then press the button.'] });
  await f.accounts.remove('codex');
  assert.equal(f.accounts.snapshot().providers.codex.fault, null, 'a removed CLI shows no ring at all');
});
test('VS Code\'s copilot shim without the real CLI is "not installed", and sign-in runs in a terminal', async () => {
  const copilot = require('../lib/providers/copilot');
  const shim = { ok: false, code: 127, stdout: '', stderr: 'GitHub Copilot CLI was not found. Run copilot in a terminal to install it, or see https://docs.github.com' };
  assert.equal(copilot.authStatus.interpret(shim), 'missing');
  assert.equal(copilot.authStatus.interpret({ ok: true, code: 0, stdout: '1.0.3\n' }), 'ready');
  const terminals = []; let reply = shim;
  const accounts = new CliAccounts({
    languageServer: async () => null, store: { get: () => ({ enabled: ['copilot'], completed: true }), set: async () => {} }, cwd: '/work',
    vscode: { window: { terminals, createTerminal(options) { const t = { options, show() {}, dispose() {} }; terminals.push(t); return t; } } },
    find: () => ({ path: '/usr/bin/copilot' }), reset() {}, broadcast() {}, run: async () => reply, spec: (agent, file) => ({ shellPath: file, shellArgs: ['login'] }),
  });
  await accounts.check();
  const fault = accounts.fault('copilot');
  assert.equal(fault.kind, 'missing');
  assert.equal(fault.code, null, 'the shim\'s 127 is not shown as a sign-in error code');
  assert.equal(accounts.snapshot().providers.copilot.installed, false);
  await accounts.fix('copilot');
  assert.deepEqual(terminals.map(t => t.options.shellArgs), [['login']], 'the shim is run in a terminal, where it offers to install');

  // Installed but signed out (seen by a failed turn): the button opens `copilot login` in a terminal, never a hidden run.
  terminals.length = 0; accounts.terminals.clear(); reply = { ok: true, code: 0, stdout: '1.0.3' };
  await accounts.check();
  accounts.markSignedOut('copilot', 'not logged in');
  assert.equal(accounts.fault('copilot').action, 'fixCli');
  const result = await accounts.fix('copilot');
  assert.equal(result.ok, false);
  assert.equal(terminals.length, 1, 'opens a terminal even though --version says ready');
  accounts.terminalClosed(terminals[0]);
  await accounts.pendingCheck;
  assert.equal(accounts.fault('copilot'), null, 'closing the sign-in terminal ends the expired state');
});
