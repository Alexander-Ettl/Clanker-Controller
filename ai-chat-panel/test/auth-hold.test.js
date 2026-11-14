'use strict';

// Queued, scheduled and "continue" prompts look at the CLI's sign-in before they go out (lib/auth-gate.js), through the real
// chat/queue lifecycle. No model, no IDE, no popup, no real CLI: `status` is what the CLI's own status command would say, on the real CliAccounts (test/auth-fixture.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('../lib/chat-store');
const { SchedulerQueue } = require('../lib/scheduler-queue');
const { AuthGate } = require('../lib/auth-gate');
const { fakeAccounts } = require('./auth-fixture');
require('./model-fixture').seedModels();

class Engine extends EventEmitter {
  constructor(options = {}) { super(); this.cwd = options.cwd; }
  runs = [];
  start(run) { this.runs.push(run); this.running = true; }
  interrupt() { if (this.running) this.complete(true); }
  complete(interrupted = false) { this.running = false; this.emit('event', { type: 'turn_complete', interrupted }); }
  dispose() {}
}
const load = Module._load;
const vscodeStub = {
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  Uri: { file: file => ({ fsPath: file, toString: () => file }), joinPath: (base, ...parts) => ({ fsPath: path.join(String(base), ...parts), toString: () => path.join(String(base), ...parts) }) },
};
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  if (request === './lib/stream-engine.js') return { StreamEngine: Engine };
  if (request === './lib/quota-bridge.js') return { readQuotas: async () => ({ claude: { remaining: 100 }, codex: { remaining: 100 }, gemini: { remaining: 100 } }), claudeUsageAge: () => 0, recordClaudeUsage() {} };
  return load.call(this, request, parent, isMain);
};
const { ChatWindowManager, ChatWindowHost, SchedulerWatchdog } = require('../extension');
Module._load = load;

const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); }; // planning a turn takes a few ticks
const MODEL = 'gpt-6.1-sol-high';
const until = async condition => { for (let i = 0; i < 100 && !(await condition()); i++) await new Promise(resolve => setTimeout(resolve, 10)); }; // file writes need real time

function fixture(t, state = 'signin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-auth-hold-'));
  const deps = { sessionDir: dir, attachmentsDir: path.join(dir, 'attachments'), workspaceDir: dir, chatStore: new ChatStore(dir), getModels: () => ({}), getPermissionMode: () => 'fullAccess', notifyHistory() {} };
  fs.mkdirSync(deps.attachmentsDir);
  const { accounts, state: status, calls } = fakeAccounts({ agents: ['claude', 'codex', 'gemini'], status: { codex: state } });
  const gate = new AuthGate({ accounts, showPrompt: () => null, pending: () => 0, pollMs: 5 });
  deps.authGate = gate;
  const manager = new ChatWindowManager('/panel', deps);
  gate.on('resolved', agent => { for (const run of manager.runs.values()) run.authResolved(agent); });
  const chat = () => manager.runFor(deps.chatStore.save({ ...deps.chatStore.create(), title: 'Auth test' }).id);
  const host = run => {
    const host = Object.create(ChatWindowHost.prototype);
    const messages = [];
    Object.assign(host, { panel: { webview: { postMessage: message => messages.push(message), asWebviewUri: uri => uri }, title: '' }, extensionUri: '/panel', deps: { ...deps, chatWindowManager: manager }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex', messages });
    host.attach(run);
    return host;
  };
  t.after(() => { gate.dispose(); clearTimeout(manager.openTimer); for (const run of manager.runs.values()) run.streamEngine.dispose(); deps.chatStore.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { deps, manager, chat, host, accounts, status, calls, gate };
}

test('a queued "continue" is held while Codex is signed out, and goes first once it is signed in again', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  run.enqueue({ id: 'next', text: 'Build the next feature', modelId: MODEL, queued: true });
  run.enqueue({ id: 'cont', text: 'continue', modelId: MODEL, queued: true, scheduled: true });
  await flush();
  assert.equal(run.streamEngine.runs.length, 0, 'nothing is sent into a login error');
  assert.deepEqual(run.queue.map(turn => turn.text), ['continue', 'Build the next feature'], 'both stay queued, in order');
  const banner = host.messages.findLast(message => message.type === 'authHold');
  assert.equal(banner.kind, 'signin'); assert.equal(banner.held, 2); assert.equal(banner.action, 'fixCli'); assert.equal(banner.button, 'Sign in to Codex');
  f.status.codex = 'connected';
  await f.gate.recheck('codex'); await flush();
  assert.equal(run.streamEngine.runs.length, 1);
  assert.match(run.streamEngine.runs[0].prompt, /continue/);
  assert.doesNotMatch(run.streamEngine.runs[0].prompt, /next feature/);
  assert.equal(host.messages.findLast(message => message.type === 'authHold').cleared, true, 'the banner goes away');
  assert.deepEqual(run.queue.map(turn => turn.text), ['Build the next feature']);
});

test('a window opened while the queue is held shows the banner', async t => {
  const f = fixture(t), run = f.chat();
  run.enqueue({ id: 'a', text: 'First', modelId: MODEL, queued: true });
  await flush();
  const late = f.host(run);
  assert.equal(late.messages.findLast(message => message.type === 'authHold')?.held, 1);
});

test('a signed-in CLI sends queued prompts as before, after a single status look', async t => {
  const f = fixture(t, 'connected'), run = f.chat();
  run.enqueue({ id: 'a', text: 'First', modelId: MODEL, queued: true });
  await flush();
  assert.equal(run.streamEngine.runs.length, 1);
  run.streamEngine.complete();
  run.enqueue({ id: 'b', text: 'Second', modelId: MODEL, queued: true });
  await flush();
  assert.equal(run.streamEngine.runs.length, 2);
  assert.equal(f.calls.look, 1, 'the second send within the same minute does not start another status command');
});

test('the watchdog keeps a scheduled "continue" pending while signed out and hands it over once signed in', async t => {
  const f = fixture(t), run = f.chat();
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  await queue.enqueue({ model: 'codex', modelId: MODEL, chatId: run.chat.id, prompt: 'continue', dispatchTrigger: 'quota-reset' });
  const watchdog = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), chatStore: f.deps.chatStore, onQueueChange() {},
    resumeInChat: task => f.manager.resumeChat(task), isChatBusy: id => f.manager.isChatBusy(id), authGate: f.gate });
  t.after(() => watchdog.engine.dispose());
  f.gate.on('resolved', () => void watchdog.tick());
  await watchdog.tick(); await flush();
  assert.equal(watchdog.failed, '');
  assert.deepEqual((await queue.getQueue()).map(task => task.status), ['pending'], 'the card stays in the Scheduled tab, unsent');
  assert.ok(f.gate.incident('codex'), 'and you are told');
  f.status.codex = 'connected';
  await f.gate.recheck('codex');
  await until(async () => (await queue.getQueue())[0]?.status === 'done');
  assert.deepEqual((await queue.getQueue()).map(task => task.status), ['done']);
  assert.deepEqual(f.manager.runs.get(run.chat.id).chat.messages.filter(message => message.role === 'user').map(message => message.text), ['continue']);
});

test('a sign-in that ends mid-turn re-queues the failed prompt behind the sign-in, not into the same 401', async t => {
  const f = fixture(t, 'connected'), run = f.chat(), host = f.host(run);
  await run.startTurn({ text: 'Build it', modelId: MODEL });
  run.streamEngine.emit('event', { type: 'delta', agent: 'codex', text: 'Codex error: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses' });
  run.queue.push({ id: 'q', text: 'Then this', modelId: MODEL, queued: true });
  run.streamEngine.complete(); await flush();
  assert.equal(run.streamEngine.runs.length, 1, 'nothing more is sent');
  assert.equal(run.authHold.agent, 'codex');
  const banner = host.messages.findLast(message => message.type === 'authHold');
  assert.equal(banner.expired, true); assert.match(banner.title, /Sign-in expired/); assert.equal(banner.held, 2, 'the failed prompt and the one behind it');
  await f.gate.recheck('codex'); await flush(); // signed in again
  assert.equal(run.streamEngine.runs.length, 2);
  assert.match(run.streamEngine.runs[1].prompt, /Build it/, 'the prompt that hit the 401 is sent again, first');
  assert.deepEqual(run.queue.map(turn => turn.text), ['Then this']);
});

test('a native Cloudflare failure pauses and preserves the queue even when local auth status stays connected', async t => {
  const f = fixture(t, 'connected'), run = f.chat(), host = f.host(run);
  const model = 'claude-sonnet-5-5-high';
  run.deps.cliAccounts = f.accounts;
  await run.startTurn({ text: 'First task', modelId: model });
  run.queue.push({ id: 'next', text: 'Second task', modelId: model, queued: true });
  run.pipeline = { task: 'First task', editorModel: MODEL };
  run.streamEngine.emit('event', { type: 'delta', agent: 'claude', text: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare' });
  run.streamEngine.complete(); await flush();
  assert.equal(run.streamEngine.runs.length, 1, 'the next queued task never starts');
  assert.equal(run.queuePaused, true);
  assert.deepEqual(run.queue.map(turn => turn.text), ['First task', 'Second task']);
  assert.equal(run.pipeline, null, 'an error is not handed to the build model as a plan');
  assert.equal(f.accounts.fault('claude').kind, 'blocked');
  assert.equal(f.accounts.fault('claude').action, 'restoreCli');
  assert.match(f.accounts.fault('claude').steps.join(' '), /cannot confirm recovery/);
  assert.equal(f.deps.chatStore.load(run.chat.id).turnQueue.paused, true, 'pause survives reload');
  assert.match(host.messages.findLast(message => message.type === 'notice').text, /Queue paused.*no follow-up/);
  await f.accounts.verify('claude'); await flush();
  assert.equal(run.queuePaused, true);
  assert.equal(run.streamEngine.runs.length, 1, 'a successful local status command cannot release a provider block');
  await f.accounts.restore('claude');
  run.pauseQueue(false); await flush();
  assert.equal(run.streamEngine.runs.length, 2, 'an explicitly allowed retry sends just the retained first task');
  run.streamEngine.emit('event', { type: 'delta', agent: 'claude', text: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare' });
  run.streamEngine.complete(); await flush();
  assert.equal(run.queuePaused, true, 'a repeated rejection pauses again');
  assert.equal(run.streamEngine.runs.length, 2);
  assert.deepEqual(run.queue.map(turn => turn.text), ['First task', 'Second task']);
});

test('a headless scheduled Claude Cloudflare failure is not completed and blocks the next scheduled send', async t => {
  const f = fixture(t, 'connected');
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const task = await queue.enqueue({ model: 'claude', modelId: 'claude-sonnet-5-5-high', prompt: 'Scheduled first', dispatchTrigger: 'quota-reset' });
  await queue.enqueue({ model: 'claude', modelId: 'claude-sonnet-5-5-high', prompt: 'Scheduled second', dispatchTrigger: 'quota-reset' });
  const watchdog = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), chatStore: f.deps.chatStore, onQueueChange() {}, authGate: f.gate, isAgentEnabled: agent => f.accounts.isEnabled(agent) });
  t.after(() => watchdog.engine.dispose());
  await watchdog.dispatch(task);
  watchdog.engine.emit('event', { type: 'delta', agent: 'claude', text: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare' });
  await watchdog.handleEvent({ type: 'turn_complete', agent: 'claude' });
  await watchdog.tick(); await flush();
  assert.equal(watchdog.engine.runs.length, 1);
  assert.equal(f.accounts.fault('claude').kind, 'blocked');
  assert.equal((await queue.getQueue()).find(entry => entry.id === task.id).status, 'pending');
  assert.match((await queue.getQueue()).find(entry => entry.id === task.id).error, /Cloudflare/);
});

test('a turn that had already worked is continued, not repeated, after the sign-in', async t => {
  const f = fixture(t, 'connected'), run = f.chat();
  await run.startTurn({ text: 'Refactor everything', modelId: MODEL });
  run.streamEngine.emit('event', { type: 'delta', agent: 'codex', text: `${'x'.repeat(500)}\nCodex error: unexpected status 401 Unauthorized: token expired` });
  run.streamEngine.complete(); await flush();
  await f.gate.recheck('codex'); await flush();
  assert.equal(run.streamEngine.runs.length, 2);
  assert.deepEqual(run.chat.messages.filter(message => message.role === 'user').map(message => message.text), ['Refactor everything', 'continue']);
});
