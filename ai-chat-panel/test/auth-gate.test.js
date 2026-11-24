'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AuthGate } = require('../lib/auth-gate');
const { showAuthPrompt } = require('../lib/auth-prompt');
const { fakeAccounts } = require('./auth-fixture');

// The gate runs on the real CliAccounts, the object behind the rail's rings; only the CLI process is faked (test/auth-fixture.js).
function fixture({ pollMs = 5, ...options } = {}) {
  const f = fakeAccounts(options);
  const prompts = [];
  const showPrompt = (block) => {
    const handle = { block, answer: null, closed: false, close() { this.closed = true; this.answer?.('later'); } };
    handle.result = new Promise((resolve) => { handle.answer = resolve; });
    prompts.push(handle);
    return handle;
  };
  const gate = new AuthGate({ accounts: f.accounts, showPrompt, pending: () => 3, pollMs, freshMs: 100 });
  const events = []; gate.on('resolved', (agent) => events.push(['resolved', agent])); gate.on('change', (block) => events.push(['change', block.kind]));
  const resolved = () => events.filter(([type]) => type === 'resolved');
  return { ...f, gate, prompts, events, resolved };
}
const until = async (condition) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(condition(), 'condition not reached'); };
const rail = (f, agent = 'codex') => f.accounts.snapshot().providers[agent].fault;

test('a signed-in CLI passes without a popup, and the look is reused for a short while', async () => {
  const f = fixture();
  assert.equal(await f.gate.check('codex'), null);
  assert.equal(await f.gate.check('codex'), null);
  assert.equal(f.calls.look, 1, 'most of the time you are signed in: one cheap look, not one per prompt');
  assert.equal(f.prompts.length, 0);
  f.clock.tick(500);
  await f.gate.check('codex');
  assert.equal(f.calls.look, 2, 'the look expires');
});

test('a signed-out CLI blocks before anything is sent and opens one popup for any number of prompts', async () => {
  const f = fixture({ status: { codex: 'signin' }, pollMs: 5000 });
  const [a, b] = await Promise.all([f.gate.check('codex'), f.gate.check('codex')]);
  assert.equal(a.kind, 'signin'); assert.equal(b.kind, 'signin');
  assert.equal(f.calls.look, 1, 'concurrent callers share one look');
  assert.equal(f.prompts.length, 1, 'one popup per incident');
  const { block } = f.prompts[0];
  assert.match(block.title, /Codex · Not signed in/);
  assert.match(block.message, /3 prompts are waiting/);
  assert.equal(block.button, 'Sign in to Codex');
  assert.equal((await f.gate.check('codex')).kind, 'signin');
  assert.equal(f.calls.look, 1, 'an open incident answers without asking the CLI again');
  f.gate.dispose();
});

test('the gate and the rail read one state: what either finds, the other already knows', async () => {
  // The rail's own round (startup, every 30 minutes, a closed terminal) finds Codex signed out ...
  const f = fixture({ status: { codex: 'signin' }, pollMs: 5000 });
  await f.accounts.check();
  assert.equal(f.calls.look, 1);
  // ... so the next send is blocked from that, without another status command.
  const block = await f.gate.check('codex');
  assert.equal(block.kind, 'signin');
  assert.equal(f.calls.look, 1, 'no second look inside the same half minute');
  assert.equal(block.title.split(' · ')[1], rail(f).title, 'the popup says what the ring says');
  assert.match(block.message, new RegExp(rail(f).detail.slice(0, 30)));
  // And the other way round: a sign-in that ended during a turn turns the ring red too.
  const g = fixture();
  assert.equal(rail(g), null);
  g.gate.expired('codex', '401');
  assert.deepEqual([rail(g).kind, rail(g).expired, rail(g).title], ['signin', true, 'Sign-in expired']);
  f.gate.dispose(); g.gate.dispose();
});

test('the popup button signs in through the browser, then the held prompts are released once', async () => {
  const f = fixture({ status: { codex: 'signin' }, signIn: async (agent, state) => { state[agent] = 'connected'; return { ok: true }; } });
  await f.gate.check('codex');
  f.prompts[0].answer('act');
  await until(() => f.resolved().length);
  assert.equal(f.calls.signIn, 1);
  assert.deepEqual(f.resolved(), [['resolved', 'codex']]);
  assert.equal(await f.gate.check('codex'), null, 'sending is allowed again straight away');
  assert.equal(rail(f), null, 'and the ring is clear');
  f.gate.dispose();
});

test('a sign-in that does not finish asks again with the reason instead of sending', async () => {
  let attempts = 0;
  const f = fixture({ status: { codex: 'signin' }, signIn: async (agent, state) => { if (++attempts > 1) state[agent] = 'connected'; return { ok: attempts > 1 }; } });
  await f.gate.check('codex');
  f.prompts[0].answer('act');
  await until(() => f.prompts.length === 2);
  assert.match(f.prompts[1].block.error, /did not finish.*"codex login"/);
  assert.equal(f.resolved().length, 0);
  f.prompts[1].answer('act');
  await until(() => f.resolved().length);
  f.gate.dispose();
});

test('signing in by hand is noticed by the background look, and "Not now" keeps the prompts held', async () => {
  const f = fixture({ status: { codex: 'signin' } });
  await f.gate.check('codex');
  f.prompts[0].answer('later');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.resolved().length, 0, 'dismissing the popup does not release anything');
  assert.ok(f.gate.incident('codex'));
  f.state.codex = 'connected';
  await until(() => f.resolved().length);
  assert.equal(f.gate.incident('codex'), null);
  f.gate.dispose();
});

test('a sign-in that ends mid-run is only cleared by a sign-in, since the status command may still say "logged in"', async () => {
  const f = fixture(); // status says connected the whole time
  const block = f.gate.expired('codex', 'unexpected status 401 Unauthorized');
  assert.equal(block.expired, true);
  assert.match(f.prompts[0].block.title, /Sign-in expired/);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f.resolved().length, 0, 'a passing status check alone must not resend into the same 401');
  f.prompts[0].answer('act');
  await until(() => f.resolved().length);
  assert.equal(f.calls.signIn, 1);
  assert.equal(rail(f), null);
  f.gate.dispose();
});

test('an expired sign-in also ends when the CLI is seen signed out and then signed in again', async () => {
  const f = fixture();
  f.gate.expired('codex');
  f.state.codex = 'signin';
  await until(() => f.accounts.expired.codex?.sawBad);
  f.state.codex = 'connected'; // signed in again by hand (its own app, a terminal)
  await until(() => f.resolved().length);
  f.gate.dispose();
});

test('"Check again" trusts a sign-in you did yourself after an expired token', async () => {
  const f = fixture({ pollMs: 5000 });
  f.gate.expired('codex');
  await f.gate.recheck('codex');
  assert.deepEqual(f.resolved(), [['resolved', 'codex']]);
  f.gate.dispose();
});

test('"Check again" while still signed out says so and keeps holding', async () => {
  const f = fixture({ status: { codex: 'signin' }, pollMs: 5000 });
  await f.gate.check('codex');
  await f.gate.recheck('codex');
  assert.equal(f.gate.incident('codex').error, 'Still not signed in.');
  assert.equal(f.resolved().length, 0);
  f.gate.dispose();
});

test('a broken install, a missing CLI and an ended plan each get their own fix', async () => {
  const broken = fixture({ status: { codex: 'broken' }, pollMs: 5000 });
  assert.equal((await broken.gate.check('codex')).kind, 'broken');
  assert.match(broken.prompts[0].block.message, /Missing optional dependency/);
  assert.equal(broken.prompts[0].block.button, 'Repair & sign in');
  broken.prompts[0].answer('act');
  await until(() => broken.calls.terminals === 1);
  broken.gate.dispose();

  const missing = fixture({ status: { codex: 'missing' }, pollMs: 5000 });
  assert.equal((await missing.gate.check('codex')).kind, 'missing');
  assert.equal(missing.prompts[0].block.button, 'Install & sign in');
  missing.gate.dispose();

  const plan = fixture({ pollMs: 5000 });
  await plan.accounts.markUnavailable('codex', { kind: 'plan', reason: 'Needs ChatGPT Plus or above.', detail: 'Free plan.' });
  assert.equal((await plan.gate.check('codex')).kind, 'plan');
  assert.match(plan.prompts[0].block.message, /Free plan/);
  plan.prompts[0].answer('act');
  await until(() => plan.resolved().length);
  assert.equal(plan.accounts.isUnavailable('codex'), false);
  plan.gate.dispose();
});

test('an inconclusive check lets the prompt go: the turn\'s own error is read afterwards', async () => {
  const f = fixture({ status: { codex: 'unknown' } });
  assert.equal(await f.gate.check('codex'), null);
  assert.equal(f.prompts.length, 0);
});

test('CLIs that were not added, and other CLIs, are not held by one that is signed out', async () => {
  const f = fixture({ status: { codex: 'signin' }, pollMs: 5000 });
  await f.gate.check('codex');
  assert.equal(await f.gate.check('claude'), null, 'agents not in the account list are not this gate\'s business');
  const g = fixture({ status: { codex: 'signin' }, agents: ['claude', 'codex'], pollMs: 5000 });
  await g.gate.check('codex');
  assert.equal(await g.gate.check('claude'), null, 'a signed-in CLI still sends while another one is held');
  f.gate.dispose(); g.gate.dispose();
});

test('Antigravity signs in from its own setup terminal (no IDE needed) and is released when it works', async () => {
  const f = fixture({ agents: ['gemini'], status: { gemini: 'signin' } });
  const block = await f.gate.check('gemini');
  assert.equal(block.action, 'fixCli');
  assert.equal(f.prompts[0].block.button, 'Sign in to Gemini / Antigravity');
  f.state.gemini = 'connected';
  await until(() => f.resolved().length);
  f.gate.dispose();
});

test('pressing the rail\'s button with nothing held signs in without opening a popup', async () => {
  const f = fixture({ status: { codex: 'signin' }, signIn: async (agent, state) => { state[agent] = 'connected'; return { ok: true }; } });
  await f.accounts.check();
  assert.equal(rail(f).action, 'fixCli');
  await f.gate.act('codex');
  assert.equal(f.calls.signIn, 1);
  assert.equal(rail(f), null);
  assert.equal(f.prompts.length, 0);
  f.gate.dispose();
});

test('the Windows popup passes its text through the environment and maps the exit to a choice', async () => {
  const spawned = [];
  const spawnImpl = (cmd, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => { child.killed = true; };
    spawned.push({ cmd, args, options, child });
    return child;
  };
  assert.equal(showAuthPrompt({ title: 'x' }, { platform: 'darwin' }), null); // Linux has its own notification popup: test/linux-integration.test.js
  const prompt = showAuthPrompt({ title: 'Codex is signed out', message: 'it is `$(calc)` "quoted"', steps: ['one', 'two'], button: 'Sign in to Codex' }, { platform: 'win32', spawnImpl });
  const { cmd, args, options } = spawned[0];
  assert.equal(cmd, 'powershell.exe');
  assert.ok(args.includes('-STA') && args.includes('-File'));
  assert.equal(args.some((arg) => arg.includes('calc')), false, 'text is never part of the command line');
  assert.equal(options.env.AUTH_MESSAGE, 'it is `$(calc)` "quoted"');
  assert.equal(options.env.AUTH_STEPS, 'one\ntwo');
  spawned[0].child.stdout.emit('data', 'act\r\n'); spawned[0].child.emit('close');
  assert.equal(await prompt.result, 'act');
  const dismissed = showAuthPrompt({ title: 'x' }, { platform: 'win32', spawnImpl });
  spawned[1].child.emit('close');
  assert.equal(await dismissed.result, 'later');
  const broken = showAuthPrompt({ title: 'x' }, { platform: 'win32', spawnImpl });
  spawned[2].child.emit('error', new Error('spawn powershell.exe ENOENT'));
  assert.equal(await broken.result, 'later');
  broken.close();
  assert.equal(spawned[2].child.killed, true);
});
