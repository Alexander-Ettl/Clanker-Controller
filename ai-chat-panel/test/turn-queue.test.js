'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('../lib/chat-store');
const { ProjectRegistry } = require('../lib/projects');
const { SchedulerQueue, isDue, resetObserved } = require('../lib/scheduler-queue');
require('./model-fixture').seedModels();

// Run the real chat/queue lifecycle and persistence without spawning a model or an IDE.
class Engine extends EventEmitter {
  constructor(options = {}) { super(); this.cwd = options.cwd; }
  runs = [];
  start(run) { this.runs.push(run); this.running = true; }
  interrupt() { if (this.running) this.complete(true); }
  complete(interrupted = false) { this.running = false; this.emit('event', { type: 'turn_complete', interrupted }); }
  dispose() { this.disposed = true; }
}
let quotaHook, chatNames, railChats;
const agentTitles = {}; // what Antigravity "wrote" per conversation id
const quotas ={ claude: { remaining: 100 }, codex: { remaining: 100 }, gemini: { remaining: 100 } };
const load = Module._load;
const vscodeStub = {
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => ({ verifyCommand: 'npm run check', chatNames, railChats })[key] ?? fallback }) },
  Uri: { file: file => ({ scheme: 'file', fsPath: file, toString: () => file }), joinPath: (base, ...parts) => ({ scheme: 'file', fsPath: path.join(String(base), ...parts), toString: () => path.join(String(base), ...parts) }) },
};
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  if (request === './lib/stream-engine.js') return { StreamEngine: Engine };
  if (request === './lib/agent-titles.js') return { ...load.call(this, request, parent, isMain), readAgentTitle: async (agent, id) => agentTitles[`${agent}:${id}`] || '' };
  if (request === './lib/quota-bridge.js') return { readQuotas: async () => quotaHook ? quotaHook() : quotas, claudeUsageAge: () => 0, recordClaudeUsage() {} }; // age 0: the watchdog never probes the real claude CLI
  return load.call(this, request, parent, isMain);
};
const { ChatWindowManager, ChatWindowHost, SchedulerWatchdog, LauncherViewProvider } = require('../extension');
Module._load = load;

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { await tick(); await tick(); };
// Background saves land off the host thread; poll for them instead of sleeping a fixed time (slow CI runners miss fixed sleeps).
const until = async (read, ok, ms = 5000) => {
  const end = Date.now() + ms;
  let value = read();
  while (!ok(value) && Date.now() < end) { await new Promise(r => setTimeout(r, 25)); value = read(); }
  return value;
};

test('queued edit acknowledgements identify the exact saved text revision', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  run.queuePaused = true;
  await host.handleMessage({ type: 'queueTurn', chatId: run.chat.id, turn: { id: 'revision-test', text: 'Initial prompt', clientEditId: 'initial', attachments: [] } });
  const text = 'The full edited prompt. '.repeat(60) + 'COMPLETE_END';
  await host.handleMessage({ type: 'editQueuedTurn', chatId: run.chat.id, turn: { id: 'revision-test', text, clientEditId: 'saved-latest', attachments: [] }, editing: false });
  const echoed = host.messages.findLast(message => message.type === 'turnQueue').turns[0];
  assert.equal(echoed.text, text);
  assert.equal(echoed.clientEditId, 'saved-latest');
  f.deps.chatStore.flush();
  assert.equal(f.deps.chatStore.load(run.chat.id).turnQueue.turns[0].text, text);
});

test('mixed strip dispatches top to bottom once scheduled Claude work is due, even with 13% left', async t => {
  const f = fixture(t), run = f.chat(), modelId = 'claude-sonnet-5-5-high';
  quotaHook = () => ({ claude: { remaining: 13, secondary: { remaining: 16 } } });
  const queue = run.deps.schedulerQueue = f.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const task = await queue.enqueue({ model: 'claude', modelId, chatId: run.chat.id, prompt: 'Scheduled middle', dispatchTrigger: 'fixed-time', dispatchTime: '2099-01-01T00:00:00Z' });
  run.queuePaused = true;
  run.enqueue({ id: 'last', text: 'Queued last', modelId, attachments: [], queued: true });
  run.enqueue({ id: 'first', text: 'Queued first', modelId, attachments: [], queued: true });
  run.setQueueOrder(['turn:first', `scheduled:${task.id}`, 'turn:last']);
  run.pauseQueue(false);
  await settle();
  assert.equal(run.chat.messages.find(m => m.role === 'user').text, 'Queued first');
  run.streamEngine.complete(); await settle();
  assert.equal(run.streamEngine.runs.length, 1, 'future middle row holds the last queued prompt');
  const watchdog = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), chatStore: f.deps.chatStore,
    getQueueState: id => f.manager.runs.get(id)?.queueState() || {},
    isChatBusy: (id, task) => f.manager.isChatBusy(id, task), resumeInChat: task => f.manager.resumeChat(task) });
  t.after(() => watchdog.engine.dispose());
  await watchdog.tick(); await settle();
  assert.equal(run.streamEngine.runs.length, 1);
  await queue.update(task.id, item => { item.dispatchTime = new Date(0).toISOString(); });
  await watchdog.tick();
  for (let i = 0; i < 15; i++) await tick();
  const live = f.manager.runs.get(run.chat.id);
  assert.deepEqual(live.chat.messages.filter(m => m.role === 'user').map(m => m.text), ['Queued first', 'Scheduled middle']);
  live.streamEngine.complete();
  for (let i = 0; i < 15; i++) await tick();
  assert.deepEqual(live.chat.messages.filter(m => m.role === 'user').map(m => m.text), ['Queued first', 'Scheduled middle', 'Queued last']);
});

test('an exhausted first model holds later rows in its chat but not another chat', async t => {
  const f = fixture(t);
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  quotaHook = () => ({ codex: { remaining: 0 }, claude: { remaining: 100, secondary: { remaining: 0 } }, gemini: { remaining: 100 } });
  const base = { dispatchTrigger: 'fixed-time', dispatchTime: new Date(0).toISOString() };
  await queue.enqueue({ ...base, chatId: 'blocked-chat', model: 'codex', prompt: 'First blocked' });
  await queue.enqueue({ ...base, chatId: 'blocked-chat', model: 'claude', prompt: 'Second must wait' });
  await queue.enqueue({ ...base, chatId: 'weekly-blocked-chat', model: 'claude', prompt: 'Weekly quota exhausted' });
  await queue.enqueue({ ...base, chatId: 'other-chat', model: 'gemini', prompt: 'Independent' });
  const sent = [];
  const watchdog = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), resumeInChat: task => { sent.push(task.prompt); return true; } });
  t.after(() => watchdog.engine.dispose());
  await watchdog.tick();
  assert.deepEqual(sent, ['Independent']);
  assert.deepEqual((await queue.getQueue()).filter(task => task.status === 'pending').map(task => task.prompt), ['First blocked', 'Second must wait', 'Weekly quota exhausted']);
});

test('scheduled queue snapshots include viewable staged images without changing attachment dispatch paths', async t => {
  const f = fixture(t);
  f.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const run = f.chat(), host = f.host(run);
  const file = path.join(f.deps.attachmentsDir, 'screenshot.png');
  fs.writeFileSync(file, 'image bytes');
  const task = await f.deps.schedulerQueue.enqueue({ model: 'codex', chatId: run.chat.id, prompt: 'Check screenshot', dispatchTrigger: 'quota-reset' }, [file]);
  await host.pushSchedulerQueue();
  const shown = host.messages.findLast(message => message.type === 'schedulerQueue').queue[0];
  assert.equal(shown.files.length, 1);
  assert.equal(shown.files[0].name, 'screenshot.png');
  assert.equal(shown.files[0].mime, 'image/png');
  assert.ok(shown.files[0].uri);
  assert.equal(shown.files[0].path, task.attachments[0].absolutePath);
  assert.deepEqual((await f.deps.schedulerQueue.getQueue())[0].attachments, task.attachments);
});

test('ChatGPT active turns hold Clanker sends and completed local turns record a sync anchor', async t => {
  const f = fixture(t), run = f.chat();
  run.chat.sessions = { codex: { id: 'shared-thread', seen: 0 } };
  run.deps.codexChatSync = { async sync(current) { current.externalCodexTurn = true; } };
  await run.startTurn({ text: 'Follow up', modelId: 'gpt-6.1-sol-high' });
  assert.equal(run.queue.length, 1);
  assert.equal(run.streamEngine.runs.length, 0);
  assert.equal(run.state, 'running');
  run.externalCodexTurn = false;
  run.deps.codexChatSync = { async sync() {} };
  await run.drain();
  assert.equal(run.streamEngine.runs.length, 1);
  run.handleStreamEvent({ type: 'turn_complete', agent: 'codex', codexTurnId: 'own-turn' });
  assert.deepEqual(run.chat.codexSync, { threadId: 'shared-thread', turnId: 'own-turn' });
});

test('Codex session discovery and chat title changes sync the external thread name', async t => {
  const f = fixture(t), calls = [];
  f.deps.codexThreadTitles = { sync(chat, project) { calls.push({ title: chat.title, thread: chat.sessions?.codex?.id, project: project?.name }); } };
  const run = f.chat();
  await run.startTurn({ text: 'Fix login', modelId: 'gpt-6.1-sol-high' });
  run.deps.projects = { get: () => ({ name: 'Test Project' }) };
  run.handleStreamEvent({ type: 'session', agent: 'codex', sessionId: 'external-thread' });
  assert.equal(calls.at(-1).thread, 'external-thread');
  run.chat.title = 'Login repaired';
  run.save();
  assert.equal(calls.at(-1).title, 'Login repaired');
  assert.equal(calls.at(-1).project, 'Test Project');
});

test('resumed manual turns send no obsolete role reset and retain input fingerprints', async t => {
  const f = fixture(t), run = f.chat();
  run.chat.sessions = { codex: { id: 'existing-thread', seen: 0 } };
  await run.startTurn({ text: 'commit', modelId: 'gpt-6.1-sol-high' });
  const request = run.streamEngine.runs[0];
  assert.doesNotMatch(request.prompt, /Earlier Auto-mode|The model was selected manually/);
  assert.equal(run.chat.messages[0].text, 'commit');
  const { inputHash } = require('../lib/codex-chat-sync');
  assert.ok(run.chat.messages[0].codexInputHashes.includes(inputHash(request.prompt)));
});

test('opening a saved chat repairs legacy imported prompt bubbles durably', t => {
  const f = fixture(t);
  const stored = f.deps.chatStore.save({ ...f.deps.chatStore.create(), messages: [{ role: 'user', agent: 'codex', codexItemId: 'native-user', text: "The model was selected manually. Earlier Auto-mode role restrictions no longer apply. Follow the user's current request.\n\nPROJECT: Wittmann Website\n\ncommit" }] });
  const run = f.manager.runFor(stored.id);
  assert.equal(run.chat.messages[0].text, 'commit');
  assert.equal(f.deps.chatStore.load(stored.id).messages[0].text, 'commit');
});

test('manual sends confirm their bubble to the origin and preserve the identity on replay', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  await host.startTurn({ text: 'Keep this bubble', clientTurnId: 'local-send-1', modelId: 'gpt-6.1-sol-high' });
  const confirmation = host.messages.find(m => m.type === 'userMessage');
  assert.equal(confirmation?.clientTurnId, 'local-send-1');
  assert.equal(confirmation.text, 'Keep this bubble');
  assert.equal(run.chat.messages.find(m => m.role === 'user').clientTurnId, 'local-send-1');
  host.replay();
  assert.equal(host.messages.findLast(m => m.type === 'chatLoaded').chat.messages.find(m => m.role === 'user').clientTurnId, 'local-send-1');
});

test('a reset Continue retargeted in the composer dispatches to the new provider with its chat context', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const queue = f.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  host.deps.schedulerQueue = queue;
  const task = await queue.enqueue({ model: 'claude', modelId: 'claude-sonnet-5-5-high', chatId: run.chat.id, projectId: run.chat.projectId, workspaceDir: run.deps.workspaceDir, prompt: 'continue', dispatchTrigger: 'quota-reset', notBefore: new Date(Date.now() + 3600000).toISOString() });
  await host.handleMessage({ type: 'saveScheduledDraft', taskId: task.id, turn: { text: 'continue', modelId: 'gpt-6.1-sol-high', attachments: [] }, editing: false });
  const ready = await queue.getNextPendingForModel('codex');
  assert.ok(ready);
  assert.equal(ready.notBefore, undefined);
  const watcher = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), chatStore: f.deps.chatStore, onQueueChange() {}, resumeInChat: task => f.manager.resumeChat(task) });
  t.after(() => watcher.engine.dispose());
  await watcher.dispatch(ready);
  await settle();
  assert.equal(run.streamEngine.runs.at(-1).agent, 'codex');
  assert.equal(run.streamEngine.runs.at(-1).model, 'gpt-6.1-sol');
  assert.equal(run.chat.messages.filter(message => message.role === 'user').at(-1).text, 'continue');
});

test('a reset Continue on Antigravity Claude/GPT switched to Orchestrator fires immediately when Gemini has quota', async t => {
  const { models, seedModels } = require('./model-fixture');
  const { setModelCatalog, setFavoriteModels } = require('../lib/model-catalog');
  const { parseAgyModels } = require('../lib/cli-tools');
  const extra = [...models, ...parseAgyModels('claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)\ngemini-pro-orchestrator-g1-pro\tOrchestrator')];
  setModelCatalog(extra); setFavoriteModels(extra);
  t.after(seedModels);
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const queue = f.deps.schedulerQueue = run.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  host.deps.schedulerQueue = queue;
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const task = await queue.enqueue({ model: 'gemini', modelId: 'gemini:claude-sonnet-5-5-high', chatId: run.chat.id, projectId: run.chat.projectId, workspaceDir: run.deps.workspaceDir, prompt: 'continue', dispatchTrigger: 'quota-reset', notBefore: deadline });
  await queue.getQueue();
  assert.equal(run.pendingUsageReset('gemini-pro-orchestrator-g1-pro'), null, 'another Antigravity model does not inherit the Sonnet reset wait');
  assert.ok(run.pendingUsageReset('gemini:claude-sonnet-5-5-high'));
  quotaHook = () => ({ gemini: { remaining: 80, resetsAt: Date.now() / 1000 + 18000 }, antigravityClaudeGpt: { remaining: 0, resetsAt: Date.now() / 1000 + 3600 } });
  await host.handleMessage({ type: 'saveScheduledDraft', taskId: task.id, turn: { text: 'continue', modelId: 'gemini-pro-orchestrator-g1-pro', attachments: [] }, editing: false });
  const updated = (await queue.getQueue())[0];
  assert.equal(updated.dispatchTrigger, 'fixed-time');
  assert.equal(updated.notBefore, undefined);
  const watcher = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), chatStore: f.deps.chatStore, onQueueChange() {}, resumeInChat: task => f.manager.resumeChat(task) });
  t.after(() => watcher.engine.dispose());
  await watcher.tick();
  await settle();
  assert.equal(run.streamEngine.runs.at(-1).agent, 'gemini');
  assert.equal(run.streamEngine.runs.at(-1).model, 'gemini-pro-orchestrator-g1-pro');
  assert.equal(run.chat.messages.filter(message => message.role === 'user').at(-1).text, 'continue');
  const stuck = await queue.enqueue({ model: 'gemini', modelId: 'gemini:claude-sonnet-5-5-high', chatId: run.chat.id, projectId: run.chat.projectId, workspaceDir: run.deps.workspaceDir, prompt: 'Try Auto', dispatchTrigger: 'quota-reset', notBefore: deadline });
  quotaHook = () => ({ gemini: { remaining: 80 }, claude: { remaining: 0 }, codex: { remaining: 0 }, antigravityClaudeGpt: { remaining: 0 } });
  await host.handleMessage({ type: 'saveScheduledDraft', taskId: stuck.id, turn: { text: 'Try Auto', modelId: 'auto', attachments: [] }, editing: false, clearReset: true });
  const autoSaved = (await queue.getQueue()).find(item => item.id === stuck.id);
  assert.ok(['gemini-3.8-flash-high', 'gemini-pro-orchestrator-g1-pro'].includes(autoSaved.modelId));
  assert.equal(autoSaved.dispatchTrigger, 'fixed-time');
  assert.equal(autoSaved.notBefore, undefined);
});

test('editing a scheduled task restores its schedule to the composer and applies schedule changes on save', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run); host.panel.reveal = () => {};
  const queue = f.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  host.deps.schedulerQueue = queue;
  const dispatchTime = new Date(Date.now() + 7200000).toISOString();
  const task = await queue.enqueue({ model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: run.chat.id, projectId: run.chat.projectId, workspaceDir: run.deps.workspaceDir, prompt: 'Later edit', dispatchTrigger: 'fixed-time', dispatchTime });
  await host.handleMessage({ type: 'unscheduleToComposer', taskId: task.id });
  const restored = host.messages.findLast(m => m.type === 'restoreScheduledDraft');
  assert.deepEqual(restored.schedule, { dispatchTrigger: 'fixed-time', dispatchTime });
  const nextAt = Date.now() / 1000 + 5400;
  quotaHook = () => ({ codex: { remaining: 60, resetsAt: nextAt } });
  await host.handleMessage({ type: 'saveScheduledDraft', taskId: task.id, turn: { text: 'Wait for reset', modelId: 'gpt-6.1-sol-high', attachments: [] }, editing: false, schedule: { dispatchTrigger: 'quota-reset', resetWindow: '5h' } });
  const saved = (await queue.getQueue())[0];
  assert.equal(saved.dispatchTrigger, 'quota-reset');
  assert.equal(saved.dispatchTime, undefined);
  assert.equal(saved.notBefore, new Date(nextAt * 1000).toISOString());
});

test('Send Now cannot remove a reset-waiting task, but the saved deadline expires independently of the next window', async t => {
  const f = fixture(t), run = f.chat();
  const queue = f.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const host = f.host(run); host.panel.reveal = () => {};
  const task = await queue.enqueue({ model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: run.chat.id, prompt: 'Keep building', dispatchTrigger: 'quota-reset', notBefore: new Date(Date.now() + 3600000).toISOString() });
  quotaHook = () => ({ codex: { remaining: 100, resetsAt: Date.now() / 1000 + 18000 } });
  await host.takeScheduledTask(task.id, true);
  assert.equal((await queue.getQueue()).length, 1);
  assert.equal(host.messages.some(message => message.type === 'restoreScheduledDraft'), false);
  await queue.update(task.id, item => { item.notBefore = new Date(Date.now() - 1000).toISOString(); });
  quotaHook = () => ({ codex: { remaining: 0 } });
  await host.takeScheduledTask(task.id, true);
  assert.equal((await queue.getQueue()).length, 1, 'exhausted usage still blocks after the timestamp');
  quotaHook = () => ({ codex: { remaining: 100, resetsAt: Date.now() / 1000 + 18000 } });
  await host.takeScheduledTask(task.id, true);
  assert.equal((await queue.getQueue()).filter(task => task.status === 'pending').length, 0);
  assert.equal(host.messages.findLast(message => message.type === 'restoreScheduledDraft').modelId, 'gpt-6.1-sol-high');
});

test('a usage reset that comes early frees the prompt waiting for the old reset time, and a plain wait stays', async t => {
  const f = fixture(t), run = f.chat();
  const queue = f.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const notBefore = new Date(Date.now() + 7200000).toISOString();
  const oldEnd = Date.parse(notBefore) / 1000;
  const task = await queue.enqueue({ model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: run.chat.id, prompt: 'continue', dispatchTrigger: 'quota-reset', notBefore });
  const watcher = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), chatStore: f.deps.chatStore, onQueueChange() {}, resumeInChat: () => false, isChatBusy: () => true });
  t.after(() => watcher.engine.dispose());
  const waitingFor = async () => (await queue.getQueue()).find(item => item.id === task.id).notBefore;
  for (const still of [{ remaining: 0, resetsAt: oldEnd }, { remaining: 60, resetsAt: oldEnd + 30 }, { remaining: 0, resetsAt: oldEnd + 18000 }, { remaining: 100, resetsAt: oldEnd, secondary: { remaining: 0, resetsAt: oldEnd + 86400 } }]) {
    quotaHook = () => ({ codex: still });
    await watcher.tick();
    assert.equal(await waitingFor(), notBefore, `still waiting at ${JSON.stringify(still)}`);
  }
  quotaHook = () => ({ codex: { remaining: 100, resetsAt: oldEnd + 18000 } }); // a manual reset: a new window, usage back
  await watcher.tick();
  assert.ok(Date.parse(await waitingFor()) <= Date.now(), 'the saved reset time no longer holds it back');
  assert.equal(isDue((await queue.getQueue())[0], Date.now()), true);
});

test('a reset is recognised from a fresh undated window and for the weekly window', () => {
  const task = { dispatchTrigger: 'quota-reset', notBefore: new Date(Date.now() + 3600000).toISOString() };
  const end = Date.parse(task.notBefore) / 1000;
  assert.equal(resetObserved(task, { remaining: 100, resetsAt: null }), true);
  assert.equal(resetObserved(task, { remaining: 40, resetsAt: null }), false);
  assert.equal(resetObserved({ ...task, resetWindow: '7d' }, { remaining: 0, secondary: { remaining: 100, resetsAt: end + 604800 } }), true);
  assert.equal(resetObserved({ ...task, resetWindow: '7d' }, { remaining: 100, secondary: { remaining: 100, resetsAt: end } }), false);
  assert.equal(resetObserved({ ...task, dispatchTrigger: 'fixed-time' }, { remaining: 100, resetsAt: end + 18000 }), false);
});

test('Steer Now and automatic queue draining preserve an active saved reset wait', async t => {
  for (const steer of [false, true]) {
    const f = fixture(t), run = f.chat(), host = f.host(run);
    const queue = run.deps.schedulerQueue = f.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
    const notBefore = new Date(Date.now() + 3600000).toISOString();
    await queue.enqueue({ model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: run.chat.id, prompt: 'continue', dispatchTrigger: 'quota-reset', notBefore });
    run.queue.push({ id: 'follow-up', text: 'Implement the next feature', modelId: 'gpt-6.1-sol-high', queued: true });
    if (steer) await host.handleMessage({ type: 'steerQueuedTurn', chatId: run.chat.id, id: 'follow-up' });
    else await run.drain();
    assert.equal(run.streamEngine.runs.length, 0);
    assert.equal(run.queue.length, steer ? 0 : 1);
    const tasks = await queue.getQueue();
    assert.deepEqual(tasks.map(task => task.prompt), steer ? ['continue', 'Implement the next feature'] : ['continue']);
    assert.ok(tasks.every(task => task.notBefore === notBefore), 'do not move prompts to the provider’s next window');
  }
});

test('each restored pop-out replays its own chat after the webview becomes ready', async t => {
  const f = fixture(t);
  const first = f.chat(), second = f.chat();
  first.chat.draft = 'Draft in the left window';
  second.chat.draft = 'Draft in the right window';
  first.save(); second.save();
  const restarted = new ChatWindowManager('/panel', { ...f.deps, chatStore: new ChatStore(f.deps.sessionDir) });
  const restored = [];
  restarted.wire = (panel, run) => {
    const host = f.host(run);
    host.pushRoutingMode = host.pushSchedulerQueue = () => {};
    host.postHistory = () => {};
    restored.push(host);
    return host;
  };
  for (const run of [first, second]) restarted.restore({ webview: {} }, run.chat.id);
  for (const host of restored) host.messages.length = 0; // startup messages arrived before JS loaded
  for (const host of restored.reverse()) await host.handleMessage({ type: 'chatReady' });
  assert.equal(restored[0].messages.find(m => m.type === 'chatLoaded').chat.id, second.chat.id);
  assert.equal(restored[0].messages.find(m => m.type === 'chatLoaded').chat.draft, second.chat.draft);
  assert.equal(restored[1].messages.find(m => m.type === 'chatLoaded').chat.id, first.chat.id);
  assert.equal(restored[1].messages.find(m => m.type === 'chatLoaded').chat.draft, first.chat.draft);
  assert.equal(restored[0].messages.find(m => m.type === 'setActive').modelId, restored[0].activeModelId);
  for (const run of restarted.runs.values()) run.streamEngine.dispose();
});

test('local HTML links open in the browser while source line links stay in the editor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-file-links-'));
  const html = path.join(root, 'router guide.html');
  const source = path.join(root, 'source file.js');
  fs.writeFileSync(html, '<h1>Router</h1>'); fs.writeFileSync(source, '// source');
  const opened = [], edited = [], warnings = [];
  const original = { window: vscodeStub.window, openExternal: vscodeStub.env.openExternal, Range: vscodeStub.Range, ViewColumn: vscodeStub.ViewColumn };
  vscodeStub.env.openExternal = async uri => { opened.push(uri.fsPath); return true; };
  vscodeStub.window = { showTextDocument: async (uri, options) => edited.push({ file: uri.fsPath, row: options.selection.row }), showWarningMessage: text => warnings.push(text) };
  vscodeStub.Range = class { constructor(row) { this.row = row; } };
  vscodeStub.ViewColumn = { One: 1 };
  t.after(() => { vscodeStub.window = original.window; vscodeStub.env.openExternal = original.openExternal; vscodeStub.Range = original.Range; vscodeStub.ViewColumn = original.ViewColumn; fs.rmSync(root, { recursive: true, force: true }); });
  const host = { deps: { workspaceDir: root } };
  await ChatWindowHost.prototype.openFile.call(host, html);
  await ChatWindowHost.prototype.openFile.call(host, 'router guide.html', 7);
  await ChatWindowHost.prototype.openFile.call(host, 'source file.js', 3);
  await ChatWindowHost.prototype.openFile.call(host, 'missing.html');
  assert.deepEqual(opened, [html]);
  assert.deepEqual(edited, [{ file: html, row: 6 }, { file: source, row: 2 }]);
  assert.match(warnings[0], /File not found/);
});

test('PDF references open through the editor for relative, file URI and Codex paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-pdf-links-'));
  const pdf = path.join(root, 'review notes.PDF');
  fs.writeFileSync(pdf, '%PDF-1.4');
  const opened = [], warnings = [];
  const original = { window: vscodeStub.window, commands: vscodeStub.commands, ViewColumn: vscodeStub.ViewColumn };
  vscodeStub.window = { showWarningMessage: text => warnings.push(text) };
  vscodeStub.commands = { executeCommand: async (...args) => opened.push(args) };
  vscodeStub.ViewColumn = { One: 1 };
  t.after(() => { Object.assign(vscodeStub, original); fs.rmSync(root, { recursive: true, force: true }); });
  const host = { deps: { workspaceDir: root } };
  for (const file of ['review notes.PDF', `file:///${pdf.replaceAll('\\', '/').replaceAll(' ', '%20')}`, `/${pdf.replaceAll('\\', '/')}`]) {
    await ChatWindowHost.prototype.openFile.call(host, file);
  }
  await ChatWindowHost.prototype.openFile.call(host, 'missing.pdf');
  assert.equal(opened.length, 3);
  for (const [command, uri, column] of opened) {
    assert.equal(command, 'vscode.open');
    assert.equal(path.normalize(uri.fsPath), pdf);
    assert.equal(column, 1);
  }
  assert.match(warnings[0], /File not found/);
});

test('routing receives the current task before the destination handoff is added', async t => {
  const { Router, config } = require('../lib/routing');
  const f = fixture(t), run = f.chat();
  run.chat.messages.push({ role: 'user', text: 'Build a new application with architecture and authentication.' }, { role: 'assistant', text: 'The initial backend is ready.' });
  const router = new Router({ getConfig: () => ({ tiers: ['deterministic'] }) });
  const route = router.route.bind(router); let captured;
  router.route = async (...args) => { captured = args[0]; return route(...args); };
  run.deps.routing = { router, getConfig: () => config(), prepareSummary: async () => {} };
  const latest = 'Adjust the spacing and typography on the existing page.';
  await run.startTurn({ text: latest, modelId: 'claude-sonnet-5-5-high' });
  assert.equal(captured.prompt, latest);
  assert.equal(captured.recent_work.length, 2);
  assert.match(captured.recent_work[0].text, /architecture/);
  assert.match(run.streamEngine.runs[0].prompt, /CHAT CONTEXT/);
  assert.ok(run.streamEngine.runs[0].prompt.endsWith(latest));
  assert.equal(router.usage().destination_turns.claude,1);
});

test('routed Claude and Gemini sends deliver every original image to the chosen CLI',async t=>{
  const {Router,config}=require('../lib/routing');
  const f=fixture(t);
  const original=path.join(f.deps.attachmentsDir,'original screenshot.png');
  const second=path.join(f.deps.attachmentsDir,'second image.jpg');
  const bytes=Buffer.from('original image contents');fs.writeFileSync(original,bytes);fs.writeFileSync(second,bytes);
  for(const id of ['claude-opus-5-5-medium','claude-sonnet-5-5-high','gemini-3.8-flash-high']){
    const run=f.chat();
    run.deps.routing={router:new Router({getConfig:()=>({tiers:['deterministic']})}),getConfig:()=>config(),prepareSummary:async()=>{}};
    await run.startTurn({text:'Inspect both screenshots',modelId:id,attachments:[original,second]});
    const request=run.streamEngine.runs[0];
    assert.deepEqual(request.attachments,[original,second]);
    assert.equal(request.model,require('../lib/model-catalog').modelOption(id).model);
    assert.deepEqual(fs.readFileSync(original),bytes);
    run.streamEngine.complete();
  }
});

test('routed prompt completes safely even if deps.routing lacks prepareSummary', async t => {
  const { Router, config } = require('../lib/routing');
  const f = fixture(t), run = f.chat();
  const router = new Router({ getConfig: () => ({ tiers: ['deterministic'] }) });
  run.deps.routing = { router, getConfig: () => config() };
  await run.startTurn({ text: 'Simple task without prepareSummary', modelId: 'gpt-6.1-sol-high' });
  assert.equal(run.streamEngine.runs.length, 1);
});

test('real routing runtime dispatches manual, Auto and queued turns without summary hooks', async t => {
  const { runtime } = require('../lib/routing-runtime');
  const { MODEL_CATALOG } = require('../lib/model-catalog');
  for (const kind of ['manual', 'auto', 'queued']) {
    for (const hook of ['missing', 'throws']) {
      await t.test(`${kind}: ${hook}`, async t => {
        const f = fixture(t), run = f.chat();
        const values = { routingConfig: { tiers: ['deterministic'] } };
        const context = { globalState: {
          get: (key, fallback) => values[key] ?? fallback,
          update: async (key, value) => { values[key] = value; },
        }, secrets: { get: async () => '' } };
        run.deps.routing = runtime(context, () => MODEL_CATALOG, f.deps.sessionDir);
        let summaryCalls = 0;
        if (hook === 'missing') delete run.deps.routing.prepareSummary;
        else run.deps.routing.prepareSummary = () => { summaryCalls++; throw Error('Obsolete summary hook'); };
        if (kind === 'queued') {
          run.enqueue({ id: 'runtime-regression', text: 'Explain this function', modelId: 'gpt-6.1-sol-high', attachments: [], queued: true });
          await settle();
        } else {
          await run.startTurn({ text: 'Explain this function', modelId: kind === 'auto' ? 'auto' : 'gpt-6.1-sol-high' });
        }
        assert.equal(run.streamEngine.runs.length, 1, 'the destination starts');
        assert.equal(summaryCalls, 0, 'native sessions and transcript handoffs do not use the obsolete summary hook');
        run.streamEngine.complete();
        assert.equal(run.chat.taskState.latestRequest, 'Explain this function');
        assert.equal(run.starting, false);
      });
    }
  }
});

const turn = (id, extra = {}) => ({ id, text: 'Task ' + id, modelId: 'gpt-6.1-sol-high', attachments: [], queued: true, ...extra });

test('scheduled turns use the favorite prompt and permission override', async (t) => {
  const f = fixture(t), id = 'gpt-6.1-sol-high';
  const watcher = new SchedulerWatchdog({ queue: { markDispatched: async () => {} }, workspaceDir: f.deps.workspaceDir, getModels: () => ({}),
    getPermissionMode: () => 'fullAccess', getModelSettings: () => ({ [id]: { permissionMode: 'ask' } }),
    getModelPrompts: () => ({ [id]: { text: 'Cite your sources.' } }) });
  await watcher.dispatch({ id: 'scheduled-settings', model: 'codex', modelId: id, prompt: 'Research', attachments: [] });
  assert.equal(watcher.engine.runs[0].permissionMode, 'ask');
  assert.match(watcher.engine.runs[0].prompt, /Cite your sources/);
});

test('manual and background queued turns apply the exact favorite prompt and permissions', async (t) => {
  const f = fixture(t), run = f.chat();
  const id = 'gpt-6.1-sol-high';
  let mode = 'ask';
  run.deps.getModelSettings = () => ({ [id]: { permissionMode: mode } });
  run.deps.getModelPrompts = () => ({ [id]: { text: 'Verify with primary sources.' } });
  await run.startTurn({ text: 'First', modelId: id });
  assert.equal(run.streamEngine.runs[0].permissionMode, 'ask');
  assert.match(run.streamEngine.runs[0].prompt, /Verify with primary sources/);
  run.enqueue(turn('next'));
  mode = 'auto';
  run.streamEngine.complete();
  await settle();
  assert.equal(run.streamEngine.runs[1].permissionMode, 'auto');
  assert.match(run.streamEngine.runs[1].prompt, /Verify with primary sources/);
  run.streamEngine.complete();
  await settle();
});

test('startup discovery finishes before a manual queued model is resolved', async (t) => {
  const f = fixture(t);
  const run = f.chat();
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  run.deps.ensureModels = () => ready;
  const started = run.startTurn({ text: 'Manual task', modelId: 'gpt-6.1-sol-high' });
  assert.equal(run.streamEngine.runs.length, 0);
  release();
  await started;
  assert.equal(run.streamEngine.runs[0].agent, 'codex');
  assert.equal(run.streamEngine.runs[0].model, 'gpt-6.1-sol');
  assert.equal(run.streamEngine.runs[0].effort, 'high');
  run.streamEngine.complete();
});


test('saved JSON attachments retain their bytes and reach the destination request', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const content = JSON.stringify({ feedback: 'Prefer Gemini for documentation', accepted: true });
  await host.saveAttachment({ chatId: run.chat.id, name: 'router feedback.json', mime: 'application/json', data: Buffer.from(content).toString('base64') });
  const saved = host.messages.findLast(message => message.type === 'attachmentSaved').attachment;
  assert.equal(fs.readFileSync(saved.path, 'utf8'), content);
  await host.startTurn({ chatId: run.chat.id, text: 'Review this feedback', modelId: 'gpt-6.1-sol-high', attachments: [saved.path] });
  const request = run.streamEngine.runs[0];
  assert.deepEqual(request.attachments, [saved.path]);
  const { attachmentPrompt } = require('../lib/attachments');
  const prompt = attachmentPrompt(request.prompt, request.attachments);
  const previews = JSON.parse(prompt.split('Attached document previews (JSON):\n')[1]);
  assert.equal(previews[0].content, content);
  run.streamEngine.complete();
});

test('registered projects isolate execution, context, attachments and restored chats', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const aRoot = path.join(f.deps.workspaceDir, 'cloud', 'Website'), bRoot = path.join(f.deps.workspaceDir, 'local', 'Extension');
  fs.mkdirSync(aRoot, { recursive: true }); fs.mkdirSync(bRoot, { recursive: true });
  const a = projects.add('Website', aRoot), b = projects.add('Extension', bRoot);
  Object.assign(f.manager.deps, { projects, defaultProjectId: a.id });
  const first = f.manager.runFor(null, a.id), second = f.manager.runFor(null, b.id);
  assert.equal(first.streamEngine.cwd, a.root); assert.equal(second.streamEngine.cwd, b.root);
  const image = path.join(first.deps.attachmentsDir, 'picture.png'); fs.writeFileSync(image, 'picture');
  await first.startTurn({ text: 'Website-only secret', modelId: 'gpt-6.1-sol-high', attachments: [image] });
  await second.startTurn({ text: 'Extension task', modelId: 'gpt-6.1-sol-high', attachments: [image] });
  assert.deepEqual(first.streamEngine.runs[0].attachments, [image]);
  assert.deepEqual(second.streamEngine.runs[0].attachments, []);
  assert.doesNotMatch(second.streamEngine.runs[0].prompt, /Website-only secret/);
  assert.equal(f.deps.chatStore.load(first.chat.id).projectId, a.id);
  second.chat.sessions = { codex: { id: 'old-folder-session' } }; second.save();
  first.streamEngine.complete(); second.streamEngine.complete(); await settle();
  const manager = new ChatWindowManager('/panel', f.manager.deps);
  t.after(() => { for (const run of manager.runs.values()) run.streamEngine.dispose(); });
  assert.equal(manager.runFor(second.chat.id).streamEngine.cwd, b.root);
  assert.equal(f.manager.listChats().find(chat => chat.id === second.chat.id).projectName, 'Extension');
  const host = f.host(second);
  await host.saveAttachment({ chatId: first.chat.id, name: 'late.png', mime: 'image/png', data: Buffer.from('late picture').toString('base64') });
  const upload = host.messages.findLast(message => message.type === 'attachmentSaved');
  assert.equal(upload.chatId, first.chat.id);
  assert.ok(upload.attachment.path.startsWith(first.deps.attachmentsDir));
  await host.startTurn({ chatId: first.chat.id, text: 'Original project send', modelId: 'gpt-6.1-sol-high' });
  assert.equal(f.manager.runs.get(first.chat.id).streamEngine.cwd, a.root);
  assert.equal(host.chat.projectId, b.id);
  fs.renameSync(bRoot, bRoot + '-moved');
  await assert.rejects(second.startTurn({ text: 'Unavailable', modelId: 'gpt-6.1-sol-high' }), /unavailable/);
  assert.equal(second.streamEngine.runs.length, 1);
  projects.update(b.id, { root: bRoot + '-moved' });
  const reopened = f.manager.runFor(second.chat.id);
  assert.equal(reopened.streamEngine.cwd, fs.realpathSync.native(bRoot + '-moved'));
  assert.deepEqual(reopened.chat.sessions, {});
});

test('legacy chats require explicit project binding and preserve messages and pictures', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const root = path.join(f.deps.workspaceDir, 'new-project'); fs.mkdirSync(root);
  const project = projects.add('New', root);
  const image = path.join(f.deps.attachmentsDir, 'old.png'); fs.writeFileSync(image, 'picture');
  const chat = f.deps.chatStore.save({ ...f.deps.chatStore.create(), sessions: { codex: { id: 'old-native-session' } }, messages: [{ role: 'user', text: 'Original', attachments: [image] }] });
  Object.assign(f.manager.deps, { projects, defaultProjectId: project.id });
  const run = f.manager.runFor(chat.id);
  await assert.rejects(run.startTurn({ text: 'Do not guess the project' }), /Choose a project/);
  const bound = f.manager.bindProject(run, project.id);
  assert.equal(bound.chat.id, chat.id); assert.equal(bound.chat.messages[0].text, 'Original');
  assert.equal(fs.readFileSync(bound.chat.messages[0].attachments[0], 'utf8'), 'picture');
  assert.ok(bound.chat.messages[0].attachments[0].startsWith(bound.deps.attachmentsDir));
  assert.deepEqual(bound.chat.sessions, {});
  assert.throws(() => f.manager.bindProject(bound, project.id), /cannot be moved/);
});

test('a fresh chat moves to another project; one with history cannot', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const aRoot = path.join(f.deps.workspaceDir, 'a'), bRoot = path.join(f.deps.workspaceDir, 'b');
  fs.mkdirSync(aRoot); fs.mkdirSync(bRoot);
  const a = projects.add('A', aRoot), b = projects.add('B', bRoot);
  Object.assign(f.manager.deps, { projects, defaultProjectId: a.id });
  const fresh = f.manager.runFor(null, a.id);
  assert.equal(fresh.chat.projectId, a.id);
  const moved = f.manager.bindProject(fresh, b.id);
  assert.equal(moved.chat.id, fresh.chat.id); assert.equal(moved.chat.projectId, b.id);
  assert.equal(moved.deps.workspaceDir, fs.realpathSync.native(bRoot));
  moved.chat.messages.push({ role: 'user', text: 'Hello' });
  assert.throws(() => f.manager.bindProject(moved, a.id), /cannot be moved/);
});

test('sleep protection spans the scheduled wait, chat handoff and running follow-up', async t => {
  const f = fixture(t); let held = 0;
  const keepAwake = () => { held++; return { release() { held--; } }; };
  f.manager.deps.keepAwake = keepAwake;
  const run = f.chat();
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir, keepAwake });
  t.after(() => { queue.dispose(); f.manager.dispose(); });
  const task = await queue.enqueue({ model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: run.chat.id, prompt: 'Scheduled task', dispatchTrigger: 'quota-reset' });
  assert.equal(held, 1, 'waiting for quota keeps Windows awake');
  const watchdog = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), resumeInChat: task => f.manager.resumeChat(task) });
  t.after(() => watchdog.engine.dispose());
  await watchdog.dispatch(task); await settle();
  assert.equal(held, 1, 'the chat holds protection after the scheduler releases its request');
  run.streamEngine.complete(); await settle();
  assert.equal(held, 0, 'idle chats release protection');
  const pending = await queue.enqueue({ model: 'codex', prompt: 'Later', dispatchTrigger: 'quota-reset' });
  assert.equal(held, 1);
  await queue.dequeue(pending.id); assert.equal(held, 0);
  await queue.enqueue({ model: 'codex', prompt: 'After restart', dispatchTrigger: 'quota-reset' });
  queue.dispose(); assert.equal(held, 0);
  const restored = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir, keepAwake });
  t.after(() => restored.dispose());
  await restored.getQueue(); assert.equal(held, 1, 'persisted pending schedules reacquire protection');
  restored.dispose(); assert.equal(held, 0);
});

test('scheduled follow-up stays visible and survives restart while continue runs', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const task = { model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: run.chat.id, dispatchTrigger: 'quota-reset' };
  const followup = await queue.enqueue({ ...task, prompt: 'Rebuild the test page' });
  const continuation = await queue.enqueue({ ...task, prompt: 'continue' });
  assert.deepEqual((await queue.getQueue()).map(item => item.id), [continuation.id, followup.id]);
  const watchdog = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}),
    resumeInChat: task => f.manager.resumeChat(task) });
  t.after(() => watchdog.engine.dispose());
  await watchdog.dispatch(continuation); await settle();
  await watchdog.dispatch(followup); await settle();
  assert.equal(run.chat.messages.findLast(message => message.role === 'user').text, 'continue');
  assert.equal((await queue.getQueue()).find(item => item.id === followup.id).status, 'done');
  const visible = host.messages.filter(message => message.type === 'turnQueue').at(-1).turns;
  assert.equal(visible.length, 1, 'the scheduled card becomes a visible queued card after handoff');
  assert.equal(visible[0].text, followup.prompt);
  assert.ok(visible[0].id, 'the queued card can be edited or removed');
  assert.equal(f.deps.chatStore.load(run.chat.id).turnQueue.turns[0].text, followup.prompt);

  run.streamEngine.dispose();
  const restarted = new ChatWindowManager('/panel', { ...f.deps, chatStore: new ChatStore(f.deps.sessionDir) });
  const restored = restarted.runFor(run.chat.id);
  t.after(() => restored.streamEngine.dispose());
  assert.equal(restored.queue[0].text, followup.prompt);
  assert.equal(restored.queue[0].scheduled, true);
  assert.equal(restored.queuePaused, true, 'an interrupted continuation leaves its follow-up paused');
  restored.pauseQueue(false); await settle();
  assert.equal(restored.chat.messages.findLast(message => message.role === 'user').text, followup.prompt);
  assert.equal(restored.streamEngine.runs.length, 1);
  restored.streamEngine.complete(); await settle();
  assert.equal(restored.streamEngine.runs.length, 1, 'the follow-up runs once');
});

test('scheduled work restores its pinned project and images after changing the workspace', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const aRoot = path.join(f.deps.workspaceDir, 'a'), bRoot = path.join(f.deps.workspaceDir, 'b');
  fs.mkdirSync(aRoot); fs.mkdirSync(bRoot);
  const a = projects.add('A', aRoot), b = projects.add('B', bRoot);
  Object.assign(f.manager.deps, { projects, defaultProjectId: a.id });
  const run = f.manager.runFor(null, b.id); run.pauseQueue(true);
  const image = path.join(run.deps.attachmentsDir, 'image.png'); fs.writeFileSync(image, 'picture');
  const queue = new SchedulerQueue({ workspaceDir: aRoot, sessionDir: f.deps.sessionDir });
  const task = await queue.enqueue({ model: 'codex', projectId: b.id, workspaceDir: bRoot, chatId: run.chat.id, prompt: 'Scheduled B', dispatchTrigger: 'quota-reset' }, [image]);
  const reloaded = await new SchedulerQueue({ workspaceDir: bRoot, sessionDir: f.deps.sessionDir }).getQueue();
  assert.equal(reloaded[0].status, 'pending'); assert.equal(reloaded[0].projectId, b.id);
  assert.equal(f.manager.resumeChat(task), true);
  assert.ok(run.queue[0].attachments[0].startsWith(run.deps.attachmentsDir));
  assert.equal(fs.readFileSync(run.queue[0].attachments[0], 'utf8'), 'picture');
  assert.throws(() => f.manager.resumeChat({ ...task, projectId: a.id }), /does not match/);
  const watchdog = new SchedulerWatchdog({ queue, projects, workspaceDir: aRoot, getModels: () => ({}), chatStore: f.deps.chatStore });
  t.after(() => watchdog.engine.dispose());
  await watchdog.dispatch({ ...task, chatId: undefined });
  assert.equal(watchdog.engine.cwd, b.root); assert.equal(watchdog.chat.projectId, b.id);
  assert.equal(watchdog.engine.runs[0].attachments[0], task.attachments[0].absolutePath);
});

test('automatic routed lanes are separate per project even for the same model provider', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const aRoot = path.join(f.deps.workspaceDir, 'a'), bRoot = path.join(f.deps.workspaceDir, 'b');
  fs.mkdirSync(aRoot); fs.mkdirSync(bRoot);
  const a = projects.add('A', aRoot), b = projects.add('B', bRoot);
  Object.assign(f.manager.deps, { projects, defaultProjectId: a.id, chooseAutoModel: async (_task, models) => models[0].id });
  await f.manager.routePrompt('One', { projectId: a.id });
  await f.manager.routePrompt('Two', { projectId: b.id });
  const lanes = JSON.parse(fs.readFileSync(path.join(f.deps.sessionDir, 'routed-chats.json')));
  assert.equal(Object.keys(lanes).length, 2);
  assert.equal(new Set(Object.values(lanes)).size, 2);
  assert.deepEqual(new Set(Object.values(lanes).map(id => f.deps.chatStore.load(id).projectId)), new Set([a.id, b.id]));
});

test('usage limits automatically schedule Continue without a window, preserve the model and resume after reset', async t => {
  for (const [agent, modelId] of [['codex', 'gpt-6.1-sol-high'], ['claude', 'claude-sonnet-5-5-high'], ['gemini', 'gemini-3.8-flash-high']]) {
    await t.test(agent, async t => {
      const f = fixture(t), run = f.chat();
      const queue = run.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
      f.manager.deps.schedulerQueue = queue;
      run.chat.projectId = 'sleep-project';
      const resetsAt = Math.ceil(Date.now() / 1000) + 3600;
      quotaHook = () => ({ [agent]: { remaining: 15, resetsAt } }); // stale quota must not dispatch early
      let scheduling;
      const schedule = run.scheduleQueuedUntilReset.bind(run);
      run.scheduleQueuedUntilReset = (...args) => (scheduling = schedule(...args));
      await run.startTurn({ text: 'Finish this task', modelId });
      run.streamEngine.emit('event', { type: 'session', agent, sessionId: 'native-session' });
      run.enqueue({ id: 'later', text: 'Next task', modelId, attachments: [], queued: true });
      run.streamEngine.emit('event', { type: 'delta', agent, text: "You've hit your usage limit" });
      run.streamEngine.complete();
      await scheduling;
      const tasks = await queue.getQueue();
      assert.deepEqual(tasks.map(task => task.prompt), ['continue', 'Finish this task', 'Next task'], 'the prompt the limit stopped before any work is scheduled right behind Continue');
      assert.equal(tasks[0].modelId, modelId);
      assert.equal(tasks[0].chatId, run.chat.id);
      assert.equal(tasks[0].workspaceDir, run.deps.workspaceDir);
      assert.equal(tasks[0].projectId, run.chat.projectId);
      assert.equal(tasks[0].notBefore, new Date(resetsAt * 1000).toISOString());
      assert.equal(await queue.getNextPendingForModel(agent), null);
      assert.equal(run.streamEngine.runs.length, 1);
      const reloaded = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
      assert.equal((await reloaded.getQueue())[0].prompt, 'continue');
      await queue.update(tasks[0].id, task => { task.notBefore = new Date(Date.now() - 1000).toISOString(); });
      const watchdog = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), chatStore: f.deps.chatStore, onQueueChange() {}, resumeInChat: task => f.manager.resumeChat(task) });
      t.after(() => watchdog.engine.dispose());
      await watchdog.dispatch(await queue.getNextPendingForModel(agent));
      await settle();
      const resumed = f.manager.runs.get(run.chat.id);
      assert.equal(resumed.streamEngine.runs.at(-1).resume, 'native-session');
      assert.equal(resumed.chat.messages.filter(message => message.role === 'user').at(-1).text, 'continue');
      assert.equal(resumed.chat.messages.filter(message => message.role === 'user').at(-1).scheduled, true);
      const reschedule = resumed.scheduleQueuedUntilReset.bind(resumed);
      resumed.scheduleQueuedUntilReset = (...args) => (scheduling = reschedule(...args));
      resumed.streamEngine.emit('event', { type: 'delta', agent, text: "You've hit your weekly limit" });
      const weekly = resetsAt + 86400;
      quotaHook = () => ({ [agent]: { remaining: 0, resetsAt, secondary: { resetsAt: weekly } } });
      resumed.streamEngine.complete(); await scheduling;
      assert.equal((await queue.getQueue()).filter(task => task.prompt === 'continue' && task.status === 'pending').length, 1);
      assert.equal((await queue.getQueue()).find(task => task.status === 'pending' && task.prompt === 'continue').notBefore, new Date(weekly * 1000).toISOString());
    });
  }
});

test('auto Continue respects opt-out, Stop and normal completion, and detects a quota error card', async t => {
  const original = vscodeStub.workspace.getConfiguration;
  t.after(() => { vscodeStub.workspace.getConfiguration = original; });
  for (const scenario of ['disabled', 'stopped', 'normal', 'explanation', 'upstream']) {
    const f = fixture(t), run = f.chat();
    const queue = run.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
    vscodeStub.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'autoContinueOnLimit' ? scenario !== 'disabled' : fallback });
    let scheduling;
    const schedule = run.scheduleQueuedUntilReset.bind(run);
    run.scheduleQueuedUntilReset = (...args) => (scheduling = schedule(...args));
    await run.startTurn({ text: 'Task', modelId: 'gpt-6.1-sol-high' });
    if (scenario === 'upstream') run.streamEngine.emit('event', { type: 'upstream_error', agent: 'codex', detail: 'Quota exhausted' });
    else run.streamEngine.emit('event', { type: 'delta', agent: 'codex', text: scenario === 'normal' ? 'Task finished.' : scenario === 'explanation' ? 'A rate limit caps the number of requests per minute.' : "You've hit your usage limit" });
    run.streamEngine.complete(scenario === 'stopped');
    await scheduling;
    assert.equal((await queue.getQueue()).length, scenario === 'upstream' ? 2 : 0, scenario); // Continue, and the prompt that never ran
    if (scenario === 'disabled') {
      const host = f.host(run); host.deps.schedulerQueue = queue;
      assert.equal(await host.scheduleTask({ task: { model: 'codex', prompt: 'continue', dispatchTrigger: 'quota-reset' } }), true);
      assert.equal((await queue.getQueue()).length, 1, 'manual Continue remains available');
    }
  }
});

test('a limit after a long Codex reply schedules Continue, the prompt that never ran and the older build prompt, in that order', async t => {
  const f = fixture(t), run = f.chat(), modelId = 'gpt-6.1-sol-high';
  const queue = run.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  quotaHook = () => ({ codex: { remaining: 0, resetsAt: Math.ceil(Date.now() / 1000) + 3600 } });
  t.after(() => { quotaHook = undefined; });
  const older = await queue.enqueue({ model: 'codex', modelId, chatId: run.chat.id, prompt: 'Now I have got a build prompt', dispatchTrigger: 'quota-reset' });
  run.queueOrder = [`scheduled:${older.id}`, 'turn:built']; // the user dragged the list: unranked prompts would otherwise land below it
  let scheduling;
  const schedule = run.scheduleQueuedUntilReset.bind(run);
  run.scheduleQueuedUntilReset = (...args) => (scheduling = schedule(...args));
  await run.startTurn({ text: 'Keep building', modelId });
  run.enqueue({ id: 'built', text: 'So now that everything is built, simplify the code', modelId, attachments: [], queued: true });
  run.streamEngine.emit('event', { type: 'delta', agent: 'codex', text: 'The installer has finished building. '.repeat(30) + "\n\nCodex error: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 8:20 PM." });
  run.streamEngine.complete(); await scheduling; await settle();
  assert.equal(run.streamEngine.runs.length, 1, 'the queued prompt is not sent into the exhausted model');
  assert.equal(run.queue.length, 0);
  assert.deepEqual((await queue.getQueue()).map(task => task.prompt), ['continue', 'So now that everything is built, simplify the code', 'Now I have got a build prompt']);
  const tasks = await queue.getQueue(), ids = ['continue', 'So now that everything is built, simplify the code', 'Now I have got a build prompt'].map(prompt => tasks.find(task => task.prompt === prompt).id);
  assert.deepEqual(run.queueOrder, ids.map(id => `scheduled:${id}`), 'the strip shows Continue as #1');
});

test('the watchdog hands a chat one scheduled prompt at a time and only once the model has finished the previous one', async t => {
  const f = fixture(t), run = f.chat(), modelId = 'gpt-6.1-sol-high';
  quotaHook = undefined; // earlier tests leave their own quota numbers behind
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const base = { model: 'codex', modelId, chatId: run.chat.id, dispatchTrigger: 'quota-reset' };
  await queue.enqueue({ ...base, prompt: 'Simplify the code' });
  await queue.enqueue({ ...base, prompt: 'Build the next feature' });
  await queue.enqueue({ ...base, prompt: 'continue' });
  const watchdog = new SchedulerWatchdog({ queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}), chatStore: f.deps.chatStore, onQueueChange() {},
    resumeInChat: task => f.manager.resumeChat(task), isChatBusy: id => f.manager.isChatBusy(id) });
  t.after(() => watchdog.engine.dispose());
  const flush = async () => { for (let i = 0; i < 12; i++) await tick(); }; // planning a turn takes a few ticks
  const live = () => f.manager.runs.get(run.chat.id); // an idle run is replaced when the chat is next resumed
  const sent = () => live().chat.messages.filter(message => message.role === 'user').map(message => message.text);
  const pending = async () => (await queue.getQueue()).filter(task => task.status === 'pending').map(task => task.prompt);
  await watchdog.tick(); await flush();
  assert.equal(watchdog.failed, '', 'tick error: ' + watchdog.failed);
  assert.deepEqual(sent(), ['continue'], 'Continue goes first, alone');
  assert.deepEqual(await pending(), ['Simplify the code', 'Build the next feature']);
  await watchdog.tick(); await flush();
  assert.deepEqual(sent(), ['continue'], 'nothing more while the model is still on Continue');
  live().streamEngine.complete(); await flush();
  await watchdog.tick(); await flush();
  assert.deepEqual(sent(), ['continue', 'Simplify the code']);
  assert.deepEqual(await pending(), ['Build the next feature']);
  live().streamEngine.complete(); await flush();
  await watchdog.tick(); await flush();
  assert.deepEqual(sent(), ['continue', 'Simplify the code', 'Build the next feature']);
});

test('the settings message persists the auto Continue opt-out globally', async t => {
  const original = vscodeStub.workspace.getConfiguration;
  const target = vscodeStub.ConfigurationTarget;
  const writes = [];
  vscodeStub.ConfigurationTarget = { Global: 1 };
  vscodeStub.workspace.getConfiguration = () => ({ update: async (...args) => writes.push(args) });
  t.after(() => { vscodeStub.workspace.getConfiguration = original; vscodeStub.ConfigurationTarget = target; });
  const settings = new LauncherViewProvider('/panel', {});
  await settings.handleMessage({ type: 'setAutoContinueOnLimit', enabled: false });
  await settings.handleMessage({ type: 'setAutoContinueOnLimit', enabled: true });
  await settings.handleMessage({ type: 'setAutoContinueOnLimit', enabled: 'false' });
  assert.deepEqual(writes, [['autoContinueOnLimit', false, 1], ['autoContinueOnLimit', true, 1]]);
});

test('automatic and manual Continue share deduplication and scheduling failures are visible', async t => {
  const f = fixture(t), run = f.chat();
  const queue = run.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const host = f.host(run); host.deps.schedulerQueue = queue;
  run.chat.modelId = 'gpt-6.1-sol-high';
  await Promise.all([
    run.scheduleQueuedUntilReset('codex', "You've hit your usage limit", { continueTask: true }),
    host.scheduleTask({ task: { model: 'codex', prompt: 'continue', dispatchTrigger: 'quota-reset' } }),
  ]);
  assert.equal((await queue.getQueue()).length, 1);
  run.deps.schedulerQueue = { enqueue: async () => { throw Error('Disk unavailable'); } };
  await run.scheduleQueuedUntilReset('codex', 'Quota exhausted', { continueTask: true });
  assert.ok(host.messages.some(message => message.type === 'notice' && /Could not schedule Continue: Disk unavailable/.test(message.text)));
});

test('project favorites persist across windows without closing hidden chats or scheduled work', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const registered = ['Current', 'Favorite one', 'Favorite two', 'Hidden'].map(name => {
    const root = path.join(f.deps.workspaceDir, name); fs.mkdirSync(root);
    return projects.add(name, root);
  });
  let saved;
  const projectPinStore = { get: () => saved, set: async ids => { saved = ids; } };
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  Object.assign(f.manager.deps, { projects, defaultProjectId: registered[0].id, projectPinStore, schedulerQueue: queue });
  const current = f.manager.runFor(null, registered[0].id), hidden = f.manager.runFor(null, registered[3].id);
  const host = f.host(current), other = f.host(hidden);
  f.manager.hosts.add(host); f.manager.hosts.add(other);
  await current.startTurn({ text: 'Current task', modelId: 'gpt-6.1-sol-high' }); current.streamEngine.complete();
  await hidden.startTurn({ text: 'Keep working in the background', modelId: 'gpt-6.1-sol-high' });
  const scheduled = await queue.enqueue({ model: 'codex', prompt: 'Later in hidden project', projectId: registered[3].id, chatId: hidden.chat.id, workspaceDir: hidden.deps.workspaceDir, dispatchTrigger: 'quota-reset' });
  assert.deepEqual(host.projectPins(), [], 'recent projects are not implicitly pinned');
  await host.handleMessage({ type: 'pinProject', projectId: registered[1].id, pinned: true });
  await host.handleMessage({ type: 'pinProject', projectId: registered[2].id, pinned: true });
  await host.handleMessage({ type: 'pinProject', projectId: registered[3].id, pinned: true });
  assert.deepEqual(saved, [registered[1].id, registered[2].id], 'a third favorite cannot be saved');
  await host.handleMessage({ type: 'pinProject', projectId: registered[2].id, pinned: false });
  await host.handleMessage({ type: 'pinProject', projectId: registered[3].id, pinned: true });
  assert.deepEqual(saved, [registered[1].id, registered[3].id]);
  assert.deepEqual(other.messages.findLast(message => message.type === 'project').pinnedProjectIds, saved);
  assert.deepEqual(other.projectPins(), saved, 'another window reads the same stored preferences');
  const reload = f.host(current); assert.deepEqual(reload.projectPins(), saved);
  assert.equal(hidden.streamEngine.running, true);
  assert.equal((await queue.getQueue()).find(task => task.id === scheduled.id).status, 'pending');
  assert.equal(projects.list().length, 4, 'hiding does not unregister projects');
  host.openProjectExplorer = async () => {};
  await host.handleMessage({ type: 'openProject', projectId: registered[3].id });
  assert.equal(host.run, hidden, 'switching opens the hidden project’s running chat');
  assert.equal(hidden.streamEngine.running, true);
  assert.equal(current.chat.projectId, registered[0].id);
  await host.handleMessage({ type: 'pinProject', projectId: 'unknown', pinned: true });
  assert.deepEqual(saved, [registered[1].id, registered[3].id]);
});

test('AGY deferred questions survive completion and reload, and settlements are saved', async t => {
  const f = fixture(t), run = f.chat();
  const host = f.host(run);
  await run.startTurn({ text: 'Ask me a question', modelId: 'gemini-3.8-flash-high', attachments: [] });
  const event = { type: 'question_required', agent: 'gemini', deferred: true, actionId: 'step-2', questions: [{ question: 'Pick A or B?', options: [{ label: 'A' }, { label: 'B' }] }] };
  run.streamEngine.emit('event', event);
  run.streamEngine.complete();
  const saved = f.deps.chatStore.load(run.chat.id);
  const stored = saved.messages.find(entry => entry.event?.type === 'question_required');
  assert.deepEqual(stored.event.questions, event.questions);
  assert.equal(stored.event.modelId, 'gemini-3.8-flash-high');
  await host.handleMessage({ type: 'deferredQuestionSettled', actionId: 'step-2', answers: { 'Pick A or B?': 'B' }, settled: { text: 'B', tone: 'allowed' } });
  assert.deepEqual(f.deps.chatStore.load(run.chat.id).messages.find(entry => entry.event?.type === 'question_required').event.settled, { text: 'B', tone: 'allowed' });
});

test('deferred questions block queued and scheduled work across reload and prioritize their answers', async t => {
  for (const skip of [false, true]) {
    const f = fixture(t), original = f.chat();
    await original.startTurn({ text: 'Ask me', modelId: 'gemini-3.8-flash-high' });
    original.enqueue(turn('later'));
    original.streamEngine.emit('event', { type: 'question_required', agent: 'gemini', deferred: true, actionId: 'ask', questions: [{ question: 'Pick?' }] });
    original.streamEngine.complete();
    await settle();
    assert.equal(original.streamEngine.runs.length, 1);
    assert.equal(original.state, 'waiting');
    assert.equal(f.manager.isChatBusy(original.chat.id), true);
    f.manager.runs.delete(original.chat.id);
    assert.equal(f.manager.isChatBusy(original.chat.id), true, 'unloaded chats still await their saved question');
    const run = f.manager.runFor(original.chat.id), host = f.host(run);
    run.drain();
    await settle();
    assert.equal(run.state, 'waiting');
    assert.equal(run.streamEngine.runs.length, 0);
    await host.handleMessage({ type: 'deferredQuestionSettled', actionId: 'ask', answers: { 'Pick?': 'B' }, settled: { text: skip ? 'Skipped' : 'B', tone: skip ? 'denied' : 'allowed' } });
    await settle();
    assert.equal(run.streamEngine.runs.length, 1);
    const user = run.chat.messages.findLast(message => message.role === 'user');
    assert.equal(user.text, skip ? 'Task later' : 'Pick?\nB');
    assert.equal(user.modelId, skip ? 'gpt-6.1-sol-high' : 'gemini-3.8-flash-high');
    assert.equal(run.queue.length, skip ? 0 : 1);
    await host.handleMessage({ type: 'deferredQuestionSettled', actionId: 'ask', settled: { text: 'Skipped', tone: 'denied' } });
    assert.equal(run.streamEngine.runs.length, 1, 'duplicate settlements cannot dispatch twice');
  }
});

test('deferred question answer sends immediately ahead of pending scheduled prompts, ranked queueOrder, and paused queues', async t => {
  const { firstPrompt } = require('../lib/scheduler-queue.js');

  // 1. Pending scheduled prompt + ranked earlier queued turn must NOT block or jump ahead of the answer.
  const f = fixture(t);
  const run = f.chat();
  const scheduledTask = { id: 'sched-reboot', status: 'pending', chatId: run.chat.id, model: 'gemini', prompt: 'about the vs code reboot issue' };
  f.deps.schedulerQueue = { loaded: true, tasks: [scheduledTask] };
  const host = f.host(run);
  await run.startTurn({ text: 'commit and push', modelId: 'gemini-3.8-flash-high' });
  run.enqueue(turn('later'));
  run.queueOrder = [`scheduled:${scheduledTask.id}`, 'turn:later'];
  run.streamEngine.emit('event', { type: 'question_required', agent: 'gemini', deferred: true, actionId: 'ask-commit', questions: [{ question: 'Rewrite 828b3b6?' }] });
  run.streamEngine.complete();
  await settle();
  assert.equal(run.streamEngine.runs.length, 1);

  await host.handleMessage({ type: 'deferredQuestionSettled', actionId: 'ask-commit', answers: { 'Rewrite 828b3b6?': 'Yes' }, settled: { text: 'Yes', tone: 'allowed' } });
  await settle();
  assert.equal(run.streamEngine.runs.length, 2, 'answer must start immediately ahead of scheduled and queued prompts');
  const sent = run.chat.messages.findLast(m => m.role === 'user');
  assert.equal(sent.text, 'Rewrite 828b3b6?\nYes');
  assert.equal(sent.modelId, 'gemini-3.8-flash-high');
  assert.deepEqual(run.queue.map(q => q.id), ['later'], 'earlier queued prompt remains queued behind the answer');
  assert.equal(firstPrompt(run.queueState(), [scheduledTask])?.id, scheduledTask.id, 'after answer starts, original scheduled order is preserved');

  // 2. Paused queue: answering a question still sends immediately while leaving the rest of the queue paused.
  const f2 = fixture(t), run2 = f2.chat(), host2 = f2.host(run2);
  await run2.startTurn({ text: 'Ask while paused', modelId: 'gemini-3.8-flash-high' });
  run2.enqueue(turn('paused-later'));
  run2.pauseQueue(true);
  run2.streamEngine.emit('event', { type: 'question_required', agent: 'gemini', deferred: true, actionId: 'ask-paused', questions: [{ question: 'Proceed?' }] });
  run2.streamEngine.complete();
  await settle();
  await host2.handleMessage({ type: 'deferredQuestionSettled', actionId: 'ask-paused', answers: { 'Proceed?': 'Go' }, settled: { text: 'Go', tone: 'allowed' } });
  await settle();
  assert.equal(run2.streamEngine.runs.length, 2, 'question answer dispatches even when queue is paused');
  assert.equal(run2.chat.messages.findLast(m => m.role === 'user').text, 'Proceed?\nGo');
  run2.streamEngine.complete();
  await settle();
  assert.equal(run2.streamEngine.runs.length, 2, 'remaining queued turns stay paused after answer finishes');
  assert.deepEqual(run2.queue.map(q => q.id), ['paused-later']);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-turn-queue-'));
  const deps = { sessionDir: dir, attachmentsDir: path.join(dir, 'attachments'), workspaceDir: dir, chatStore: new ChatStore(dir), getModels: () => ({}), getPermissionMode: () => 'fullAccess', notifyHistory() {} };
  fs.mkdirSync(deps.attachmentsDir);
  const manager = new ChatWindowManager('/panel', deps);
  const chat = () => manager.runFor(deps.chatStore.save({ ...deps.chatStore.create(), title: 'Queue test' }).id);
  const host = run => {
    const host = Object.create(ChatWindowHost.prototype);
    const messages = [];
    Object.assign(host, { panel: { webview: { postMessage: message => messages.push(message), asWebviewUri: uri => uri }, title: '' }, extensionUri: '/panel', deps: { ...deps, chatWindowManager: manager }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex', messages });
    host.attach(run);
    return host;
  };
  t.after(() => { quotaHook = null; clearTimeout(manager.openTimer); for (const run of manager.runs.values()) run.streamEngine.dispose(); deps.chatStore.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { deps, manager, chat, host };
}

test('revert restores the selected message with independent attachments and preserves fork history', async t => {
  const f = fixture(t), run = f.chat();
  const image = path.join(f.deps.attachmentsDir, '1720000000000_screenshot.png');
  const document = path.join(f.deps.attachmentsDir, '1720000000000_notes.txt');
  fs.writeFileSync(image, 'original image bytes');
  fs.writeFileSync(document, 'original document bytes');
  run.chat.messages = [
    { role: 'user', text: 'Earlier prompt', attachments: [image] },
    { role: 'assistant', text: 'Earlier reply', at: '2026-10-22T00:00:00.000Z' },
    { role: 'user', text: 'Inspect these files', attachments: [image, document] },
    { role: 'assistant', text: 'Later reply', at: '2026-10-22T00:00:00.000Z' },
  ];
  run.save();
  const originalId = run.chat.id, host = f.host(run);
  await host.handleMessage({ type: 'revertToMessage', index: 1 });
  const draft = host.messages.findLast(message => message.type === 'prefillPrompt');
  assert.equal(draft.text, 'Inspect these files');
  assert.equal(draft.files.length, 2);
  assert.deepEqual(draft.files.map(file => file.mime), ['image/png', '']);
  assert.deepEqual(draft.files.map(file => file.name.replace(/^\d{10,}_/, '')), ['screenshot.png', 'notes.txt']);
  assert.notEqual(host.chat.id, originalId);
  assert.equal(host.chat.forkedFrom, originalId);
  assert.deepEqual(host.chat.messages, run.chat.messages.slice(0, 2));
  for (const [i, original] of [image, document].entries()) {
    assert.notEqual(draft.files[i].path, original);
    assert.deepEqual(fs.readFileSync(draft.files[i].path), fs.readFileSync(original));
    assert.ok(draft.files[i].uri);
  }
  await host.run.startTurn({ text: draft.text, modelId: 'claude-sonnet-5-5-high', attachments: draft.files.map(file => file.path) });
  assert.deepEqual(host.run.streamEngine.runs[0].attachments, draft.files.map(file => file.path));
  host.renameAttachment(draft.files[0].path, 'renamed');
  host.removeAttachment(draft.files[1].path);
  await settle();
  assert.equal(fs.readFileSync(image, 'utf8'), 'original image bytes');
  assert.equal(fs.readFileSync(document, 'utf8'), 'original document bytes');
  assert.deepEqual(f.deps.chatStore.load(originalId).messages, run.chat.messages);
});

test('revert without attachments restores an empty attachment list', async t => {
  const f = fixture(t), run = f.chat();
  run.chat.messages = [{ role: 'user', text: 'Text only' }];
  run.save();
  const host = f.host(run);
  await host.handleMessage({ type: 'revertToMessage', index: 0 });
  assert.deepEqual(host.messages.findLast(message => message.type === 'prefillPrompt'), { type: 'prefillPrompt', text: 'Text only', files: [] });
  assert.deepEqual(host.chat.messages, []);
});

test('webview history pages preserve the full backend chat and reject requests for other chats', async t => {
  const f = fixture(t), run = f.chat();
  run.chat.messages = Array.from({ length: 100 }, (_, i) => [
    { role: 'user', text: `Prompt ${i}` },
    { role: 'assistant', text: `Reply ${i}`, agent: 'codex', compactContext: 'private handoff', compactPreviousContext: 'old handoff' },
  ]).flat();
  const host = f.host(run);
  const initial = host.messages.findLast(message => message.type === 'chatLoaded').chat;
  assert.equal(initial.messages.length, 24);
  assert.equal(initial.historyStart, 176);
  assert.equal(initial.historyUserStart, 88);
  assert.equal(initial.messages[1].compactContext, undefined);
  assert.equal(run.chat.messages.length, 200);
  await host.handleMessage({ type: 'requestChatHistory', chatId: run.chat.id, before: initial.historyStart, requestId: 7 });
  const older = host.messages.findLast(message => message.type === 'chatHistory');
  assert.equal(older.historyStart, 152);
  assert.equal(older.historyEnd, 176);
  assert.equal(older.historyUserStart, 76);
  assert.equal(older.requestId, 7);
  assert.equal(older.messages[0].text, 'Prompt 76');
  assert.equal(older.messages[1].compactPreviousContext, undefined);
  const count = host.messages.length;
  for (const [chatId, before] of [['other-chat', 100], [run.chat.id, -1], [run.chat.id, 1e20], [run.chat.id, 1.5]]) {
    await host.handleMessage({ type: 'requestChatHistory', chatId, before });
  }
  assert.equal(host.messages.length, count);
});

test('switching an unchanged chat does not rewrite it; pending drafts flush before release', async t => {
  const f = fixture(t), run = f.chat(), other = f.chat();
  other.chat.messages.push({ role: 'user', text: 'Another saved conversation' });
  other.save();
  run.chat.messages.push({ role: 'user', text: 'A saved conversation' });
  run.chat.textEntered = true;
  run.save();
  const host = f.host(run), save = f.deps.chatStore.save.bind(f.deps.chatStore);
  let writes = 0;
  t.mock.method(f.deps.chatStore, 'save', chat => { writes++; return save(chat); });
  host.restoreChat(other.chat.id);
  assert.equal(writes, 0);
  host.restoreChat(run.chat.id);
  await host.handleMessage({ type: 'saveDraft', chatId: run.chat.id, text: 'Unsaved draft', userInput: true });
  host.restoreChat(other.chat.id);
  assert.equal(writes, 1);
  assert.equal(f.deps.chatStore.load(run.chat.id).draft, 'Unsaved draft');
  assert.equal(f.deps.chatStore.checkpoints.has(run.chat.id), false);
});

test('Claude background shell replies remain busy and survive a chat switch and disk reload', async t => {
  const f = fixture(t), run = f.chat(), other = f.chat(), host = f.host(run);
  await run.startTurn({ text: 'Download the photos', modelId: 'claude-sonnet-5-5-high' });
  const { StreamEngine } = require('../lib/stream-engine');
  const engine = new StreamEngine({ cwd: f.deps.workspaceDir, interactive: true });
  engine.child = { exitCode: 0, stdin: { writable: true, end() {} } };
  run.streamEngine = engine;
  engine.on('event', event => run.handleStreamEvent(event));
  const line = raw => engine.consumeLine(JSON.stringify(raw), 'claude');
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'The scraper takes eight minutes.' }] } });
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'scraper', content: 'Command running in background with ID: scrape-job.' }] } });
  line({ type: 'result', session_id: 's1' });
  assert.equal(run.state, 'running');
  assert.equal(run.activeAssistantMessage.inProgress, true);
  host.restoreChat(other.chat.id);
  line({ type: 'system', subtype: 'task_notification', task_id: 'scrape-job', status: 'completed' });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: '256 images downloaded.' }] } });
  assert.equal(run.state, 'running');
  line({ type: 'result', session_id: 's1' });
  host.restoreChat(run.chat.id);
  const saved = f.deps.chatStore.load(run.chat.id);
  assert.match(saved.messages.findLast(message => message.role === 'assistant').text, /eight minutes\.[\s\S]*256 images downloaded/);
  assert.equal(saved.messages.findLast(message => message.role === 'assistant').inProgress, undefined);
  assert.equal(run.state, null);
});

test('history lists only the active empty chat and keeps conversations with messages', t => {
  const f = fixture(t), abandoned = f.chat(), active = f.chat(), conversation = f.chat();
  conversation.chat.messages.push({ role: 'user', text: 'Keep this conversation' });
  conversation.save();
  f.host(active);
  assert.deepEqual(new Set(f.manager.listChats().map(chat => chat.id)), new Set([active.chat.id, conversation.chat.id]));
  assert.ok(f.deps.chatStore.load(abandoned.chat.id), 'old empty history is hidden without modifying stored chats');
});

test('startup deletes legacy empty snapshots and backups while preserving restored chats and scheduled or queued prompts', async t => {
  const f = fixture(t), store = f.deps.chatStore;
  const abandoned = store.save(store.create()); store.save(abandoned);
  const remembered = store.save(store.create());
  const open = f.chat(); f.host(open);
  const sent = store.save({ ...store.create(), messages: [{ role: 'user', text: 'Keep this prompt' }] });
  const queued = store.save({ ...store.create(), turnQueue: { turns: [turn('later')], paused: true } });
  const scheduled = store.save(store.create());
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  await queue.enqueue({ model: 'codex', prompt: 'Scheduled prompt', chatId: scheduled.id, dispatchTrigger: 'fixed-time', dispatchTime: '2099-01-01T00:00:00Z' });
  f.manager.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  f.manager.deps.sidebarState = { get: key => key === 'aiChatPanel.sidebarChatId' ? remembered.id : null };
  store.checkpoint(abandoned);
  f.manager.recentSelections.set(abandoned.id, Date.now());
  await f.manager.pruneEmptyChats();
  assert.equal(store.load(abandoned.id), null);
  assert.equal(fs.readdirSync(store.dir).some(name => name.includes(abandoned.id)), false);
  assert.equal(store.checkpoints.has(abandoned.id), false);
  assert.equal(f.manager.recentSelections.has(abandoned.id), false);
  for (const id of [remembered.id, open.chat.id, sent.id, queued.id, scheduled.id]) assert.ok(store.load(id));
  await f.manager.pruneEmptyChats();
  assert.equal(store.list().length, 5, 'cleanup can run again without deleting protected chats');
});

test('startup leaves empty chats intact when the scheduler cannot be read', async t => {
  const f = fixture(t), empty = f.deps.chatStore.save(f.deps.chatStore.create());
  f.manager.deps.schedulerQueue = { getQueue: async () => { throw new Error('Unreadable scheduler'); } };
  await assert.rejects(f.manager.pruneEmptyChats(), /Unreadable scheduler/);
  assert.ok(f.deps.chatStore.load(empty.id));
});

test('switching deletes an empty chat and its backup and cancels its pending checkpoint', async t => {
  const f = fixture(t), empty = f.chat(), conversation = f.chat(), host = f.host(empty);
  conversation.chat.messages.push({ role: 'user', text: 'Existing conversation' }); conversation.save();
  empty.save(); f.deps.chatStore.checkpoint(empty.chat);
  host.restoreChat(conversation.chat.id);
  assert.equal(f.deps.chatStore.load(empty.chat.id), null);
  assert.equal(f.deps.chatStore.checkpoints.has(empty.chat.id), false);
  assert.equal(f.manager.runs.has(empty.chat.id), false);
  assert.equal(empty.streamEngine.disposed, true);
  assert.equal(fs.readdirSync(f.deps.chatStore.dir).some(name => name.includes(empty.chat.id)), false);
  await settle();
  assert.deepEqual(f.manager.listChats().map(chat => chat.id), [conversation.chat.id]);
});

test('repeated new chats remove the empty predecessor and retain the active sidebar chat', t => {
  const f = fixture(t), host = f.host(f.chat());
  host.panel.sidebar = true;
  f.manager.sidebar = host;
  f.manager.deps.sidebarState = { update() {} };
  const ids = [host.chat.id];
  for (let i = 0; i < 3; i++) {
    host.resetToFreshChat();
    host.run.save();
    ids.push(host.chat.id);
    assert.deepEqual(f.manager.listChats().map(chat => chat.id), [host.chat.id]);
  }
  for (const id of ids.slice(0, -1)) {
    assert.equal(f.deps.chatStore.load(id), null);
    assert.equal(f.manager.recentSelections.has(id), false);
  }
});

test('typed drafts survive switching and restart, including text entered then erased', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  await host.handleMessage({ type: 'saveDraft', chatId: run.chat.id, text: 'Unsent idea\nKeep this', userInput: true });
  host.attach(f.chat());
  assert.equal(f.deps.chatStore.load(run.chat.id).draft, 'Unsent idea\nKeep this');
  assert.ok(f.manager.listChats().some(chat => chat.id === run.chat.id));
  const restarted = new ChatWindowManager('/panel', { ...f.deps, chatStore: new ChatStore(f.deps.sessionDir) });
  await restarted.pruneEmptyChats();
  clearTimeout(restarted.openTimer);
  assert.equal(restarted.deps.chatStore.load(run.chat.id).draft, 'Unsent idea\nKeep this');
  host.restoreChat(run.chat.id);
  assert.equal(host.messages.filter(message => message.type === 'chatLoaded').at(-1).chat.draft, 'Unsent idea\nKeep this');
  await host.handleMessage({ type: 'saveDraft', chatId: run.chat.id, text: '' });
  host.attach(f.chat());
  assert.equal(f.deps.chatStore.load(run.chat.id).draft, '');
  assert.equal(f.deps.chatStore.load(run.chat.id).textEntered, true);
});

test('a draft holding only attachments survives switching and restart, and is dropped once they are removed', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const images = [1, 2, 3].map(n => { const file = path.join(f.deps.attachmentsDir, `photo ${n}.png`); fs.writeFileSync(file, 'photo'); return file; });
  await host.handleMessage({ type: 'saveDraft', chatId: run.chat.id, text: '', attachments: images });
  host.attach(f.chat());
  assert.ok(f.manager.listChats().some(chat => chat.id === run.chat.id), 'images alone keep the chat in recent history');
  const restarted = new ChatWindowManager('/panel', { ...f.deps, chatStore: new ChatStore(f.deps.sessionDir) });
  await restarted.pruneEmptyChats();
  clearTimeout(restarted.openTimer);
  assert.deepEqual(restarted.deps.chatStore.load(run.chat.id).draftAttachments, images);
  host.restoreChat(run.chat.id);
  assert.equal(host.messages.filter(message => message.type === 'chatLoaded').at(-1).chat.draftFiles.length, 3);
  await host.handleMessage({ type: 'saveDraft', chatId: run.chat.id, text: '', attachments: [] });
  host.attach(f.chat());
  assert.equal(f.deps.chatStore.load(run.chat.id), null, 'an emptied composer leaves nothing to keep');
});
test('startup deletes a legacy empty chat whose stale typing flag alone kept it in recent history', async t => {
  const f = fixture(t), store = f.deps.chatStore;
  const ghost = store.save({ ...store.create(), hasTypedMessage: true, draft: '' });
  store.save(ghost);
  f.manager.recentSelections.set(ghost.id, Date.now());
  assert.equal(f.manager.listChats().some(chat => chat.id === ghost.id), false);
  await f.manager.pruneEmptyChats();
  assert.equal(store.load(ghost.id), null);
  assert.equal(fs.readdirSync(store.dir).some(name => name.includes(ghost.id)), false);
});

test('programmatic composer text does not leave a sticky typing flag after being cleared', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  await host.handleMessage({ type: 'saveDraft', chatId: run.chat.id, text: 'Temporary composer text' });
  assert.equal(run.chat.textEntered, undefined);
  await host.handleMessage({ type: 'saveDraft', chatId: run.chat.id, text: '' });
  host.attach(f.chat());
  assert.equal(f.deps.chatStore.load(run.chat.id), null);
  assert.equal(f.deps.chatStore.checkpoints.has(run.chat.id), false);
});

test('opening and leaving a legacy ghost deletes it even with a stale typing flag', async t => {
  const f = fixture(t), store = f.deps.chatStore;
  const ghost = store.save({ ...store.create(), hasTypedMessage: true, draft: '' });
  const host = f.host(f.manager.runFor(ghost.id));
  await f.manager.pruneEmptyChats();
  assert.ok(store.load(ghost.id), 'the currently displayed empty chat stays usable');
  await host.handleMessage({ type: 'saveDraft', chatId: ghost.id, text: '' });
  host.attach(f.chat());
  assert.equal(store.load(ghost.id), null);
  assert.equal(f.manager.runs.has(ghost.id), false);
});

test('legacy snapshots with actual drafts remain preserved despite lacking user-input metadata', async t => {
  const f = fixture(t), store = f.deps.chatStore;
  const draft = store.save({ ...store.create(), hasTypedMessage: true, draft: 'Actual unsent text' });
  await f.manager.pruneEmptyChats();
  assert.equal(store.load(draft.id).draft, 'Actual unsent text');
});

test('a draft is retained in slot five and removed with its backup when a sixth chat displaces it', async t => {
  const f = fixture(t), store = f.deps.chatStore;
  const draft = store.save({ ...store.create(), draft: 'Unsent idea' });
  store.save(draft);
  const addNewer = i => store.save({ ...store.create(), updatedAt: new Date().toISOString(), messages: [{ role: 'user', text: `Sent ${i}` }] });
  // Give the draft an unambiguous older timestamp without depending on clock resolution.
  const file = store.fileFor(draft.id);
  fs.writeFileSync(file, JSON.stringify({ ...draft, updatedAt: '2000-01-01T00:00:00Z' }));
  for (let i = 0; i < 4; i++) addNewer(i);
  await f.manager.pruneEmptyChats();
  assert.equal(f.manager.listChats()[4].id, draft.id);
  assert.equal(store.load(draft.id).draft, 'Unsent idea');
  addNewer(4);
  await f.manager.pruneEmptyChats();
  assert.equal(store.load(draft.id), null);
  assert.equal(fs.readdirSync(store.dir).some(name => name.includes(draft.id)), false);
  assert.equal(store.list().length, 5, 'sent conversations survive cleanup');
});

test('pinned chats lead the list in pin order and their pins are dropped when the chat is deleted', async t => {
  const f = fixture(t), store = f.deps.chatStore;
  let saved;
  f.manager.deps.chatPinStore = { get: () => saved, set: async ids => { saved = ids; } };
  let notified = 0;
  f.manager.deps.notifyHistory = () => { notified++; };
  const make = (i, at) => store.save({ ...store.create(), updatedAt: at, messages: [{ role: 'user', text: `Sent ${i}` }] });
  const [oldest, middle, newest] = [make(0, '2026-01-01T00:00:00Z'), make(1, '2026-01-02T00:00:00Z'), make(2, '2026-01-03T00:00:00Z')];
  // save() stamps the time itself; put the dates back so the unpinned order is known.
  for (const [chat, at] of [[oldest, '2026-01-01T00:00:00Z'], [middle, '2026-01-02T00:00:00Z'], [newest, '2026-01-03T00:00:00Z']]) fs.writeFileSync(store.fileFor(chat.id), JSON.stringify({ ...store.load(chat.id), updatedAt: at }));
  assert.deepEqual(f.manager.listChats().map(chat => chat.id), [newest.id, middle.id, oldest.id]);
  assert.ok(f.manager.listChats().every(chat => chat.pinned === false));
  await f.manager.pinChat(oldest.id, true);
  await f.manager.pinChat(middle.id, true);
  assert.deepEqual(saved, [oldest.id, middle.id]);
  assert.equal(notified, 2, 'the lists are told');
  assert.deepEqual(f.manager.listChats().map(chat => [chat.id, chat.pinned]), [[oldest.id, true], [middle.id, true], [newest.id, false]]);
  await f.manager.pinChat(oldest.id, true); // pinning twice keeps one pin
  assert.deepEqual(saved, [middle.id, oldest.id]);
  await f.manager.pinChat('missing-chat', true);
  await f.manager.pinChat(newest.id, 'yes');
  assert.deepEqual(saved, [middle.id, oldest.id], 'unknown chats and non-boolean values are ignored');
  await f.manager.pinChat(middle.id, false);
  assert.deepEqual(f.manager.listChats().map(chat => chat.id), [oldest.id, newest.id, middle.id]);
  f.manager.deleteChat(oldest.id);
  assert.ok(!f.manager.listChats().some(chat => chat.id === oldest.id));
  await f.manager.pinChat(newest.id, true);
  assert.deepEqual(saved, [newest.id], 'a deleted chat\'s pin is dropped on the next change');
});

test('sidebar switches preserve drafts across the configured recent rail slots', async t => {
  railChats = 6;
  t.after(() => { railChats = undefined; });
  const f = fixture(t), host = f.host(f.chat());
  host.panel.sidebar = true;
  f.manager.sidebar = host;
  f.manager.deps.sidebarState = { update() {} };
  const drafts = [];
  for (let i = 0; i < 7; i++) {
    drafts.push(host.chat.id);
    await host.handleMessage({ type: 'saveDraft', chatId: host.chat.id, text: `Draft ${i}` });
    host.attach(f.chat());
  }
  assert.equal(f.deps.chatStore.load(drafts[0]), null);
  for (const id of drafts.slice(-5)) assert.ok(f.deps.chatStore.load(id));
  assert.equal(f.manager.listChats()[0].id, host.chat.id);
});

test('late draft updates cannot write into the newly selected chat', async t => {
  const f = fixture(t), old = f.chat(), host = f.host(old);
  host.attach(f.chat());
  await host.handleMessage({ type: 'saveDraft', chatId: old.chat.id, text: 'Late text' });
  assert.equal(host.chat.draft, undefined);
  assert.equal(f.deps.chatStore.load(old.chat.id), null);
});

test('an empty chat shared by two windows is deleted only after both leave it', t => {
  const f = fixture(t), empty = f.chat(), next = f.chat(), first = f.host(empty), second = f.host(empty);
  first.attach(next);
  assert.ok(f.deps.chatStore.load(empty.chat.id));
  assert.equal(empty.streamEngine.disposed, undefined);
  assert.deepEqual(f.manager.listChats().map(chat => chat.id), [next.chat.id]);
  second.attach(next);
  assert.equal(f.deps.chatStore.load(empty.chat.id), null);
});

test('leaving a chat preserves submitted messages, queued prompts and scheduled work', t => {
  const f = fixture(t), sent = f.chat(), queued = f.chat(), scheduled = f.chat(), next = f.chat();
  sent.chat.messages.push({ role: 'user', text: 'Sent prompt' }); sent.save();
  queued.queuePaused = true; queued.enqueue(turn('waiting'));
  f.manager.deps.schedulerQueue = { tasks: [{ chatId: scheduled.chat.id, status: 'pending', prompt: 'Later' }] };
  for (const run of [sent, queued, scheduled]) {
    const host = f.host(run);
    host.attach(next);
    assert.ok(f.deps.chatStore.load(run.chat.id));
  }
  assert.deepEqual(new Set(f.manager.listChats().map(chat => chat.id)), new Set([sent.chat.id, queued.chat.id, scheduled.chat.id, next.chat.id]));
});

test('Auto runs the exact chosen favorite with its own instructions, permissions and resumed context', async t => {
  const f = fixture(t), run = f.chat(), id = 'gpt-6-astra-high';
  run.deps.chooseAutoModel = async (task, models) => {
    assert.equal(task, 'Improve the interface');
    assert.ok(models.some(model => model.id === id));
    return id;
  };
  run.deps.getModelSettings = () => ({ [id]: { permissionMode: 'ask' } });
  run.deps.getModelPrompts = () => ({ [id]: { text: 'Check keyboard access.' } });
  run.chat.sessions = { codex: { id: 'existing-thread', seen: 0 } };
  await run.startTurn({ text: 'Improve the interface', modelId: 'auto' });
  const request = run.streamEngine.runs[0];
  assert.equal(request.model, 'gpt-6-astra');
  assert.equal(request.effort, 'high');
  assert.equal(request.permissionMode, 'ask');
  assert.equal(request.resume, 'existing-thread');
  assert.match(request.prompt, /Check keyboard access/);
  assert.doesNotMatch(request.prompt, /Earlier Auto-mode role restrictions|The model was selected manually/);
  assert.equal(run.chat.modelId, 'auto');
  assert.equal(run.activeAssistantMessage.modelLabel, require('../lib/model-catalog').modelOption(id).label);
  run.streamEngine.complete();
});

test('Stop while Auto is selecting a favorite cancels dispatch', async t => {
  const f = fixture(t), run = f.chat();
  let release;
  run.deps.chooseAutoModel = () => new Promise(resolve => { release = resolve; });
  const pending = run.startTurn({ text: 'Task', modelId: 'auto' });
  await settle();
  assert.equal(typeof release, 'function');
  run.stop(); release('gpt-6-astra-high');
  assert.equal(await pending, false);
  assert.equal(run.streamEngine.runs.length, 0);
});

test('Visor targets its site instead of the active chat and persists requests in a paused lane', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const site = path.join(f.deps.workspaceDir, 'E&B Tech');
  fs.mkdirSync(site);
  const other = projects.add('Visor', f.deps.workspaceDir), target = projects.add('E&B Tech', site);
  Object.assign(f.manager.deps, { projects, defaultProjectId: other.id, routing: {} });
  const chat = f.deps.chatStore.save({ ...f.deps.chatStore.create(), projectId: target.id });
  const run = f.manager.runFor(chat.id);
  run.pauseQueue(true);
  fs.writeFileSync(path.join(f.deps.sessionDir, 'routed-chats.json'), JSON.stringify({ [`${target.id}:routing`]: chat.id }));
  f.manager.activeHost = { chat: { projectId: other.id } };
  assert.equal(await f.manager.routePrompt('First site edit', { projectRoot: site }), true);
  assert.equal(await f.manager.routePrompt('Second site edit', { projectRoot: site }), true);
  f.deps.chatStore.flush();
  const saved = f.deps.chatStore.load(chat.id);
  assert.equal(saved.projectId, target.id);
  assert.equal(saved.turnQueue.paused, true);
  assert.deepEqual(saved.turnQueue.turns.map(turn => turn.text), ['First site edit', 'Second site edit'].map(text => `Astro site root: ${site}\n\n${text}`));
  assert.equal(new Set(saved.turnQueue.turns.map(turn => turn.id)).size, 2);
  assert.equal(run.streamEngine.runs.length, 0);
  await assert.rejects(f.manager.routePrompt('Unknown site', { projectRoot: path.join(os.tmpdir(), 'unregistered-visor-site') }), /Register the Visor site/);
});

test('Visor images resolve from a nested Astro site and reach Codex as native images', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const site = path.join(f.deps.workspaceDir, 'Portfolio with spaces', 'site');
  fs.mkdirSync(site, { recursive: true });
  const project = projects.add('Portfolio', path.dirname(site));
  Object.assign(f.manager.deps, { projects, defaultProjectId: project.id });
  f.manager.open = () => {};
  const images = ['.astro/session/shots/task-1.png', '.astro/session/shots/attachments/reference image.webp', '.astro/session/shots/attachments/reference.gif'];
  const bytes = Buffer.from('original image bytes');
  for (const image of images) { const file = path.join(site, image); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  await f.manager.routePrompt('Use the screenshot and my references', { projectRoot: site, newChat: true, targetModel: 'gpt-6.1-sol-high', attachments: [...images, images[0]] });
  await settle();
  const run = [...f.manager.runs.values()][0], delivered = run.streamEngine.runs[0];
  assert.equal(run.chat.title, 'Visor · Use the screenshot and my references');
  assert.equal(delivered.attachments.length, 3, 'all unique images survive staging');
  assert.ok(delivered.prompt.includes(`Astro site root: ${site}`));
  for (const [i, file] of delivered.attachments.entries()) {
    assert.ok(file.startsWith(projects.context(project.id).attachmentsDir + path.sep));
    assert.ok(file.endsWith(path.basename(images[i])), 'original names distinguish screenshots from references');
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  const { codexAttachmentInput } = require('../lib/attachments');
  assert.deepEqual(codexAttachmentInput(delivered.prompt, delivered.attachments).slice(1), delivered.attachments.map(file => ({ type: 'localImage', path: file })));
  run.streamEngine.complete();
});

test('Visor rejects missing, unsupported, outside-project and oversized images before dispatch', async t => {
  const f = fixture(t), projects = new ProjectRegistry(f.deps.sessionDir);
  const site = path.join(f.deps.workspaceDir, 'site');
  fs.mkdirSync(site);
  const project = projects.add('Portfolio', site);
  Object.assign(f.manager.deps, { projects, defaultProjectId: project.id });
  f.manager.open = () => { throw new Error('A rejected image must not open a chat'); };
  const good = path.join(site, 'good.png'); fs.writeFileSync(good, 'image');
  const large = path.join(site, 'large.png'); fs.writeFileSync(large, ''); fs.truncateSync(large, 20000001);
  for (const [image, error] of [['missing.png', /not found/], ['notes.txt', /Unsupported/], ['../outside.png', /outside the selected project/], ['large.png', /exceeds 20 MB/], [null, /valid file path/]]) {
    await assert.rejects(f.manager.routePrompt('Apply references', { projectRoot: site, newChat: true, attachments: ['good.png', image] }), error);
  }
  assert.equal(f.manager.runs.size, 0);
  assert.deepEqual(fs.readdirSync(projects.context(project.id).attachmentsDir), [], 'a rejected request stages no partial attachment set');
});

test('external routed prompts preserve the selected non-default favorite', async t => {
  const f = fixture(t);
  f.deps.chooseAutoModel = async () => 'gpt-6-astra-high';
  assert.equal(await f.manager.routePrompt('Design the interface'), true);
  await settle();
  const run = [...f.manager.runs.values()][0];
  assert.equal(run.streamEngine.runs[0].model, 'gpt-6-astra');
  assert.equal(run.streamEngine.runs[0].effort, 'high');
  run.streamEngine.complete();
});

test('Visor new-chat requests wait for discovery before resolving a selected model', async t => {
  const f = fixture(t);
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  f.deps.ensureModels = () => ready;
  f.manager.open = () => {};
  const pending = f.manager.routePrompt('Use the selected model', { newChat: true, targetModel: 'gpt-6-astra-high' });
  await settle();
  assert.equal(f.manager.runs.size, 0, 'no chat is dispatched before discovery finishes');
  release();
  assert.equal(await pending, true);
  await settle();
  const run = [...f.manager.runs.values()][0];
  assert.equal(run.streamEngine.runs[0].model, 'gpt-6-astra');
  run.streamEngine.complete();
});

test('editing holds the original queue slot and saves text, model and images independently', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  run.pauseQueue(true);
  const image = path.join(f.deps.attachmentsDir, 'qt.png');
  fs.writeFileSync(image, 'picture');
  run.enqueue(turn('qt', { attachments: [image] }));
  run.enqueue(turn('other'));
  await host.handleMessage({ type: 'editQueuedTurn', chatId: run.chat.id, turn: { ...run.queue[0], text: 'Edited Qt', attachments: [image] }, editing: true });
  run.pauseQueue(false);
  await settle();
  assert.equal(run.streamEngine.runs.length, 0, 'editing blocks automatic dispatch');
  run.pauseQueue(true);
  await host.handleMessage({ type: 'editQueuedTurn', chatId: run.chat.id, turn: { ...run.queue[0], text: 'Qt final', attachments: [image] }, editing: false });
  await host.handleMessage({ type: 'editQueuedTurn', chatId: run.chat.id, turn: { ...run.queue[1], text: 'Other edit', attachments: [] }, editing: true });
  const saved = f.deps.chatStore.load(run.chat.id).turnQueue.turns;
  assert.deepEqual(saved.map(item => item.id), ['qt', 'other']);
  assert.equal(saved[0].text, 'Qt final');
  assert.deepEqual(saved[0].attachments, [image]);
  assert.deepEqual(saved[1].attachments, []);
  host.releaseQueueEdits();
  assert.equal(run.queue[1].editing, false, 'closing the editor releases its hold');
});

test('queue conversion preserves edits, images and project; explicit reordering survives reload', async t => {
  const f = fixture(t), run = f.chat();
  f.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  run.deps.schedulerQueue = f.deps.schedulerQueue;
  const host = f.host(run);
  run.pauseQueue(true);
  const image = path.join(f.deps.attachmentsDir, 'schedule.png'); fs.writeFileSync(image, 'picture');
  run.enqueue(turn('convert', { modelId: 'claude-sonnet-5-5-high', attachments: [image] }));
  await host.handleMessage({ type: 'scheduleQueuedTurn', chatId: run.chat.id, id: 'convert', turn: { ...run.queue[0], text: 'Edited regulatory task' }, task: { dispatchTrigger: 'fixed-time', dispatchTime: '2099-01-01T00:00:00Z' } });
  assert.equal(run.queue.length, 0);
  let tasks = await f.deps.schedulerQueue.getQueue();
  assert.equal(tasks[0].prompt, 'Edited regulatory task');
  assert.equal(tasks[0].chatId, run.chat.id);
  assert.equal(tasks[0].workspaceDir, run.deps.workspaceDir);
  assert.equal(tasks[0].dispatchTrigger, 'fixed-time');
  assert.equal(fs.readFileSync(tasks[0].attachments[0].absolutePath, 'utf8'), 'picture');
  const schedule = prompt => host.scheduleTask({ task: { model: 'claude', prompt, dispatchTrigger: 'quota-reset', resumeHere: true } });
  await Promise.all([schedule('continue'), schedule('continue')]);
  await schedule('Next task');
  tasks = await f.deps.schedulerQueue.getQueue();
  assert.deepEqual(tasks.map(task => task.prompt), ['continue', 'Edited regulatory task', 'Next task']);
  await f.deps.schedulerQueue.reorder(tasks.map(task => task.id).reverse());
  const reloaded = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  assert.equal((await reloaded.getQueue())[0].prompt, 'Next task');
  await f.deps.schedulerQueue.update((await reloaded.getQueue())[0].id, task => { task.notBefore = '2099-01-01T00:00:00Z'; });
  assert.equal(await f.deps.schedulerQueue.getNextPendingForModel('claude'), null, 'later prompts wait for the continuation even if already due');
  const independent = await f.deps.schedulerQueue.enqueue({ chatId: 'another-chat', model: 'claude', prompt: 'Independent task', dispatchTrigger: 'quota-reset' });
  assert.equal((await f.deps.schedulerQueue.getNextPendingForModel('claude')).id, independent.id, 'other chats are not blocked');
  run.chat.messages.push({ role: 'assistant', agent: 'claude', text: "You've hit your session limit" }, { role: 'user', text: 'continue', scheduled: true });
  const continuation = (await reloaded.getQueue())[0];
  await f.deps.schedulerQueue.markCompleted(continuation.id);
  await schedule('continue');
  assert.equal((await f.deps.schedulerQueue.getQueue()).filter(task => task.prompt === 'continue').length, 1);
});

test('failed conversion keeps the queued prompt and releases the editor hold', async t => {
  const f = fixture(t), run = f.chat();
  f.deps.schedulerQueue = { enqueue: async () => { throw Error('Disk unavailable'); } };
  const host = f.host(run);
  run.pauseQueue(true); run.enqueue(turn('keep'));
  await host.handleMessage({ type: 'scheduleQueuedTurn', chatId: run.chat.id, id: 'keep' });
  assert.equal(run.queue[0].id, 'keep');
  assert.equal(run.queue[0].editing, false);
  assert.ok(host.messages.some(message => message.type === 'scheduleTaskFailed'));
});

test('queued turns finish FIFO after repeated chat switches with no window watching them', async t => {
  const f = fixture(t), run = f.chat(), other = f.chat(), host = f.host(run);
  await run.startTurn({ text: 'First task', modelId: 'gpt-6.1-sol-high' }, { origin: host });
  for (const id of ['two', 'three', 'four']) run.enqueue(turn(id));
  host.attach(other); host.attach(run); host.attach(other);
  assert.equal(run.queuePaused, false);
  assert.equal(run.hosts.size, 0);
  for (const count of [2, 3, 4]) {
    run.streamEngine.complete();
    await settle();
    assert.equal(run.streamEngine.runs.length, count);
    assert.equal(run.queuePaused, false);
  }
  run.streamEngine.complete(); await settle();
  assert.deepEqual(run.chat.messages.filter(m => m.role === 'user').map(m => m.text), ['First task', 'Task two', 'Task three', 'Task four']);
  assert.deepEqual(f.deps.chatStore.load(run.chat.id).turnQueue, { turns: [], paused: false });
  assert.equal(run.streamEngine.disposed, true, 'a completed unattended run can be released');
});

test('manual pause holds the next task, persists across switches/reloads, and play starts it once', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  await run.startTurn({ text: 'Current task', modelId: 'gpt-6.1-sol-high' });
  run.enqueue(turn('next'));
  run.pauseQueue(true);
  assert.equal(run.streamEngine.running, true, 'pause lets the current task finish');
  host.attach(f.chat());
  run.streamEngine.complete(); await settle();
  host.attach(run);
  assert.equal(run.queuePaused, true);
  assert.equal(run.streamEngine.runs.length, 1);
  f.manager.runs.delete(run.chat.id);
  const restored = f.manager.runFor(run.chat.id);
  assert.equal(restored.queuePaused, true);
  assert.equal(restored.queue[0].text, 'Task next');
  restored.pauseQueue(false); restored.pauseQueue(false);
  await settle();
  assert.equal(restored.streamEngine.runs.length, 1);
  assert.equal(restored.queue.length, 0);
  restored.streamEngine.complete();
});

test('Codex and Claude queues drain independently in parallel while a third chat is open', async t => {
  const f = fixture(t), codex = f.chat(), claude = f.chat(), visible = f.chat(), host = f.host(codex);
  const models = { codex: 'gpt-6.1-sol-high', claude: 'claude-opus-5-5-medium' };
  await codex.startTurn({ text: 'Codex first', modelId: models.codex }, { origin: host });
  codex.streamEngine.emit('event', { type: 'session', agent: 'codex', sessionId: 'codex-session' });
  for (let i = 1; i <= 7; i++) codex.enqueue(turn('codex-' + i, { modelId: models.codex }));
  host.attach(claude);
  await claude.startTurn({ text: 'Claude first', modelId: models.claude }, { origin: host });
  claude.streamEngine.emit('event', { type: 'session', agent: 'claude', sessionId: 'claude-session' });
  for (let i = 1; i <= 4; i++) claude.enqueue(turn('claude-' + i, { modelId: models.claude }));
  host.attach(visible);
  assert.notEqual(codex.streamEngine, claude.streamEngine);
  assert.equal(codex.streamEngine.running && claude.streamEngine.running, true);
  assert.equal(codex.hosts.size + claude.hosts.size, 0);
  // Different completion speeds: the shorter queue finishes while the longer one continues.
  for (let i = 0; i < 8; i++) {
    if (i < 5) claude.streamEngine.complete();
    codex.streamEngine.complete();
    await settle();
    assert.equal(host.run, visible, 'neither queue needs to open its chat to launch the next task');
    assert.equal(codex.queuePaused || claude.queuePaused, false);
    if (i === 4) {
      assert.equal(claude.streamEngine.disposed, true);
      assert.equal(codex.streamEngine.running, true, 'finishing Claude does not stop Codex');
    }
  }
  for (const [agent, run, count] of [['codex', codex, 7], ['claude', claude, 4]]) {
    assert.deepEqual(run.chat.messages.filter(m => m.role === 'user').map(m => m.text), [agent === 'codex' ? 'Codex first' : 'Claude first', ...Array.from({ length: count }, (_, i) => 'Task ' + agent + '-' + (i + 1))]);
    assert.equal(run.streamEngine.runs.length, count + 1, 'every queued task runs exactly once');
    assert.ok(run.streamEngine.runs.every(task => task.agent === agent));
    assert.ok(run.streamEngine.runs.slice(1).every(task => task.resume === agent + '-session'), 'each queue resumes its own provider session');
    assert.deepEqual(f.deps.chatStore.load(run.chat.id).turnQueue, { turns: [], paused: false });
    assert.equal(f.manager.runs.has(run.chat.id), false, 'only the completed chat is released');
  }
});

test('pause during planning neither starts nor loses a task', async t => {
  const f = fixture(t), run = f.chat();
  let resolve;
  quotaHook = () => new Promise(done => { resolve = done; });
  run.enqueue(turn('one'));
  run.pauseQueue(true);
  resolve(quotas); await settle();
  assert.equal(run.streamEngine.runs.length, 0);
  assert.equal(run.queue[0].id, 'one');
  run.enqueue(turn('two'));
  quotaHook = null;
  run.reorderQueuedTurns(['two', 'one']);
  run.removeQueuedTurn('one');
  run.pauseQueue(false); await settle();
  assert.equal(run.chat.messages.find(m => m.role === 'user').text, 'Task two');
  assert.equal(run.streamEngine.runs.length, 1);
});

test('the strip order mixing queued and scheduled prompts is saved with the chat and sent to every window', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  run.queuePaused = true;
  run.enqueue(turn('one'));
  run.setQueueOrder(['scheduled:task-a', 'turn:one', 'turn:one', 'junk', 'scheduled:']);
  assert.deepEqual(f.deps.chatStore.load(run.chat.id).turnQueue.order, ['scheduled:task-a', 'turn:one'], 'duplicates and malformed keys are dropped');
  assert.deepEqual(host.messages.findLast(m => m.type === 'turnQueue').order, ['scheduled:task-a', 'turn:one']);
});

test('reorder or delete while a task is being planned cannot start the old front item', async t => {
  const f = fixture(t);
  for (const operation of ['reorder', 'delete']) {
    const run = f.chat();
    let resolve;
    quotaHook = () => new Promise(done => { resolve = done; });
    run.enqueue(turn('one'));
    run.enqueue(turn('two'));
    if (operation === 'reorder') run.reorderQueuedTurns(['two', 'one']);
    else run.removeQueuedTurn('one');
    quotaHook = null;
    resolve(quotas); await settle();
    assert.equal(run.streamEngine.runs.length, 1);
    assert.equal(run.chat.messages.find(m => m.role === 'user').text, 'Task two');
    assert.equal(run.queue.length, operation === 'reorder' ? 1 : 0);
    run.streamEngine.complete(); await settle();
  }
});

test('Steer Now during planning cannot race a queued turn into a second start', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const resolvers = [];
  quotaHook = () => new Promise(done => resolvers.push(done));
  run.enqueue(turn('one')); run.enqueue(turn('two'));
  const steering = host.handleMessage({ type: 'steerQueuedTurn', chatId: run.chat.id, id: 'two' });
  assert.equal(resolvers.length, 2);
  quotaHook = null;
  resolvers.forEach(resolve => resolve(quotas));
  await steering; await settle();
  assert.equal(run.streamEngine.runs.length, 1);
  assert.equal(run.chat.messages.find(m => m.role === 'user').text, 'Task two');
  run.streamEngine.complete(); await settle();
  assert.equal(run.streamEngine.runs.length, 2);
  assert.deepEqual(run.chat.messages.filter(m => m.role === 'user').map(m => m.text), ['Task two', 'Task one']);
});

test('background queued tasks preserve Auto-Verify and the architect/build model handoff', async t => {
  const f = fixture(t), run = f.chat();
  run.enqueue(turn('plan', { pipeline: true, verify: true }));
  await settle();
  assert.equal(run.streamEngine.runs[0].agent, 'claude');
  run.activeAssistantMessage.text = 'Update the header links.';
  run.streamEngine.complete(); await settle();
  assert.equal(run.streamEngine.runs[1].agent, 'codex');
  assert.match(run.streamEngine.runs[1].prompt, /Update the header links/);
  assert.match(run.streamEngine.runs[1].prompt, /npm run check/);
  assert.equal(run.chat.modelId, 'gpt-6.1-sol-high');
  assert.equal(run.queuePaused, false);
});

test('queue controls are scoped to their chat and mirrored into multiple windows', async t => {
  const f = fixture(t), run = f.chat(), other = f.chat(), first = f.host(run), second = f.host(run);
  await run.startTurn({ text: 'Current task', modelId: 'gpt-6.1-sol-high' });
  first.attach(other);
  await first.handleMessage({ type: 'queueTurn', chatId: run.chat.id, turn: turn('next', { verify: true }) });
  await first.handleMessage({ type: 'pauseTurnQueue', chatId: run.chat.id, paused: true });
  assert.equal(run.queuePaused, true);
  assert.equal(other.queuePaused, false);
  assert.equal(second.messages.findLast(m => m.type === 'turnQueue').paused, true);
  await first.handleMessage({ type: 'steerQueuedTurn', chatId: run.chat.id, id: 'next' });
  assert.equal(run.queuePaused, true, 'sending one task now does not discard a deliberate pause');
  assert.match(run.streamEngine.runs.at(-1).prompt, /npm run check/);
  assert.equal(run.chat.messages.at(-2).text, 'Task next');
  assert.equal(second.messages.filter(m => m.type === 'userMessage' && m.text === 'Task next').length, 1);
  await first.handleMessage({ type: 'steerQueuedTurn', chatId: run.chat.id, id: 'next' });
  assert.equal(run.streamEngine.runs.length, 2, 'stale clicks cannot run a consumed task twice');
});

test('old webview queues migrate once and continue unpaused without opening their chat', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(f.chat());
  const message = { type: 'importTurnQueue', chatId: run.chat.id, turns: [turn('legacy-one'), turn('legacy-two')] };
  await host.handleMessage(message); await settle();
  await host.handleMessage(message);
  assert.equal(run.queuePaused, false);
  assert.equal(run.streamEngine.runs.length, 1);
  assert.equal(run.queue.length, 1);
  run.streamEngine.complete(); await settle();
  assert.equal(run.streamEngine.runs.length, 2);
  assert.equal(run.chat.messages.filter(m => m.role === 'user').length, 2);
});

test('legacy migration also preserves tasks when a new host-owned queue already exists', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(f.chat());
  run.pauseQueue(true);
  run.enqueue(turn('new'));
  await host.handleMessage({ type: 'importTurnQueue', chatId: run.chat.id, turns: [turn('old'), turn('new')] });
  assert.deepEqual(run.queue.map(turn => turn.id), ['new', 'old']);
  assert.equal(run.queuePaused, true, 'migration preserves an existing deliberate pause');
  assert.equal(f.deps.chatStore.load(run.chat.id).turnQueueImported, true);
});

test('Stop retains queued tasks behind a deliberate pause, but does not pause an empty queue', async t => {
  const f = fixture(t), run = f.chat();
  await run.startTurn({ text: 'Current task', modelId: 'gpt-6.1-sol-high' });
  run.enqueue(turn('next'));
  run.stop(); await settle();
  assert.equal(run.queuePaused, true);
  assert.equal(run.queue[0].id, 'next');
  assert.equal(run.streamEngine.runs.length, 1);
  run.pauseQueue(false); await settle();
  run.stop(); await settle();
  assert.equal(run.queuePaused, false);
});

test('resumed sessions receive only missed turns; fresh sessions also receive their own earlier answers', async t => {
  const f = fixture(t), run = f.chat();
  await run.startTurn({ text: 'First Claude task', modelId: 'claude-sonnet-5-5-high' });
  run.handleStreamEvent({ type: 'session', agent: 'claude', sessionId: 'claude-memory' });
  run.handleStreamEvent({ type: 'delta', agent: 'claude', text: 'OWN EARLIER CLAUDE ANSWER' });
  run.handleStreamEvent({ type: 'tool_start', name: 'shell', toolId: 'memory-step' });
  run.streamEngine.complete();
  const seen = run.chat.messages.length;
  assert.equal(run.chat.sessions.claude.seen, seen);
  assert.equal(f.deps.chatStore.load(run.chat.id).sessions.claude.seen, seen, 'seen survives persistence');

  await run.startTurn({ text: 'Ask Codex in between', modelId: 'gpt-6.1-sol-high' });
  run.handleStreamEvent({ type: 'delta', agent: 'codex', text: 'MISSED CODEX ANSWER' });
  run.streamEngine.complete();
  assert.equal(run.chat.sessions.claude.seen, seen, 'other agents do not advance Claude memory');

  await run.startTurn({ text: 'Return to Claude', modelId: 'claude-sonnet-5-5-high' });
  const resumed = run.streamEngine.runs.at(-1);
  assert.equal(resumed.resume, 'claude-memory');
  assert.match(resumed.prompt, /MISSED CODEX ANSWER/);
  assert.doesNotMatch(resumed.prompt, /OWN EARLIER CLAUDE ANSWER/);
  assert.match(resumed.freshPrompt, /OWN EARLIER CLAUDE ANSWER/, 'failed resume fallback replays full history');
  run.streamEngine.complete();

  delete run.chat.sessions.claude.id;
  await run.startTurn({ text: 'Fresh Claude session', modelId: 'claude-sonnet-5-5-high' });
  const fresh = run.streamEngine.runs.at(-1);
  assert.equal(fresh.resume, null);
  assert.match(fresh.prompt, /OWN EARLIER CLAUDE ANSWER/);
  assert.match(fresh.prompt, /MISSED CODEX ANSWER/);
  run.streamEngine.complete();
});

test('streaming without a window saves text, tool steps and session IDs before turn completion', async t => {
  const f = fixture(t), run = f.chat();
  const saved = () => f.deps.chatStore.load(run.chat.id);
  await run.startTurn({ text: 'Long task', modelId: 'gpt-6.1-sol-high' });
  run.handleStreamEvent({ type: 'session', agent: 'codex', sessionId: 'durable-thread' }); // written off the host thread, straight away
  assert.equal((await until(saved, c => c.sessions?.codex?.id === 'durable-thread')).sessions.codex.id, 'durable-thread');
  run.handleStreamEvent({ type: 'delta', agent: 'codex', text: 'Saved progress' });
  const progress = await until(saved, c => c.messages.at(-1).text === 'Saved progress');
  assert.equal(progress.messages.at(-1).text, 'Saved progress');
  assert.equal(progress.messages.at(-1).inProgress, true);
  run.handleStreamEvent({ type: 'tool_start', name: 'shell', toolId: 'step' }); // tool boundaries share the checkpoint's off-thread write
  const stepped = await until(saved, c => c.messages.at(-1).offset === 'Saved progress'.length);
  assert.equal(stepped.messages.at(-1).offset, 'Saved progress'.length);
  run.streamEngine.complete();
  assert.equal(saved().messages.at(-2).inProgress, undefined);
});

test('restoring a killed host keeps partial replies and pauses its remaining queue', async t => {
  const f = fixture(t), run = f.chat();
  await run.startTurn({ text: 'Long task', modelId: 'gpt-6.1-sol-high' });
  run.handleStreamEvent({ type: 'delta', agent: 'codex', text: 'Partial answer' });
  run.enqueue(turn('pending'));
  const restarted = new ChatWindowManager('/panel', f.deps);
  const restored = restarted.runFor(run.chat.id);
  assert.equal(restored.chat.messages.at(-1).text, 'Partial answer');
  assert.equal(restored.chat.messages.at(-1).interruptionReason, 'host_shutdown');
  assert.equal(restored.chat.messages.at(-1).inProgress, undefined);
  assert.equal(restored.queuePaused, true);
  assert.equal(restored.queue[0].id, 'pending');
  assert.equal(restored.state, null);
  await settle();
  assert.equal(restored.streamEngine.runs.length, 0, 'opening history must not re-run interrupted work');
  restarted.dispose();
});

test('graceful host disposal flushes the final text and invalidates planned queued work', async t => {
  const f = fixture(t), run = f.chat();
  await run.startTurn({ text: 'Long task', modelId: 'gpt-6.1-sol-high' });
  run.enqueue(turn('next'));
  run.handleStreamEvent({ type: 'delta', agent: 'codex', text: 'Last unsaved delta' });
  f.manager.dispose();
  const chat = f.deps.chatStore.load(run.chat.id);
  assert.equal(chat.messages.at(-1).text, 'Last unsaved delta');
  assert.equal(chat.messages.at(-1).interruptionReason, 'host_shutdown');
  assert.equal(chat.turnQueue.paused, true);
  assert.equal(f.deps.chatStore.checkpoints.size, 0);
});

test('Explorer adds a project without warning while other chats keep running', async t => {
  const f = fixture(t), run = f.chat(), other = f.chat(), host = f.host(run);
  const projects = new ProjectRegistry(f.deps.sessionDir);
  const project = projects.add('Workspace', f.deps.workspaceDir);
  run.chat.projectId = project.id;
  host.deps.projects = projects;
  await run.startTurn({ text: 'One', modelId: 'gpt-6.1-sol-high' });
  await other.startTurn({ text: 'Two', modelId: 'gpt-6.1-sol-high' });
  let additions = 0;
  const commands = [];
  vscodeStub.workspace.workspaceFolders = [];
  vscodeStub.workspace.updateWorkspaceFolders = () => { additions++; return true; };
  vscodeStub.window = { showWarningMessage: () => assert.fail('Adding a project must not warn'), showErrorMessage: message => assert.fail(message) };
  vscodeStub.commands = { executeCommand: async (...args) => commands.push(args) };
  run.handleStreamEvent({ type: 'delta', text: 'Flush before switching' });
  await host.openProjectExplorer();
  assert.equal(additions, 1);
  assert.deepEqual(commands, [['workbench.view.explorer']]);
  assert.ok(run.state);
  assert.ok(other.state);
  assert.equal(run.streamEngine.disposed, undefined);
  assert.equal(other.streamEngine.disposed, undefined);
  assert.equal(f.deps.chatStore.load(run.chat.id).messages.at(-1).text, 'Flush before switching');
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: project.root } }];
  await host.openProjectExplorer();
  assert.equal(additions, 1, 'a folder already in Explorer is not added twice');
  delete vscodeStub.workspace.workspaceFolders;
});

test('a second IDE window cannot restore or dispatch a chat still owned by the first host', t => {
  const f = fixture(t), chat = f.deps.chatStore.create();
  chat.messages.push({ role: 'assistant', text: 'Still running elsewhere', inProgress: true, hostPid: process.ppid });
  f.deps.chatStore.save(chat);
  let notice;
  vscodeStub.window.showInformationMessage = text => { notice = text; };
  assert.equal(f.manager.runFor(chat.id), null);
  assert.match(notice, /another IDE window/);
  assert.equal(f.manager.runs.has(chat.id), false);
  assert.equal(f.deps.chatStore.load(chat.id).messages[0].inProgress, true);
});

test('headless scheduled work checkpoints its response and marks an IDE shutdown', async t => {
  const f = fixture(t);
  const watcher = new SchedulerWatchdog({ queue: { markDispatched: async () => {} }, workspaceDir: f.deps.workspaceDir,
    getModels: () => ({}), chatStore: f.deps.chatStore });
  await watcher.dispatch({ id: 'scheduled-recovery', model: 'codex', prompt: 'Background task', attachments: [] });
  const id = watcher.chat.id;
  await watcher.handleEvent({ type: 'delta', text: 'Scheduled progress' });
  const saved = await until(() => f.deps.chatStore.load(id), c => c.messages.at(-1)?.text === 'Scheduled progress');
  assert.equal(saved.messages.at(-1).text, 'Scheduled progress');
  watcher.stop();
  const reply = f.deps.chatStore.load(id).messages.at(-1);
  assert.equal(reply.interruptionReason, 'host_shutdown');
  assert.equal(reply.inProgress, undefined);
  assert.equal(watcher.engine.disposed, true);
});

test('manual Sonnet screenshot sends and background queued sends use Sonnet despite a previous Codex session', async t => {
  const f=fixture(t),run=f.chat(),id='claude-sonnet-5-5-high';
  const {Router,config}=require('../lib/routing');
  run.deps.routing={router:new Router(),getConfig:()=>config(),prepareSummary:async()=>{}};
  run.chat.routingModelId='gpt-6.1-sol-high';
  run.chat.sessions={codex:{id:'previous-codex-session',seen:0}};
  const image=path.join(f.deps.attachmentsDir,'screenshot.png');fs.writeFileSync(image,'fixture image');
  await run.startTurn({text:'Investigate this screenshot',modelId:id,attachments:[image]});
  const request=run.streamEngine.runs[0];
  assert.equal(request.agent,'claude');
  assert.equal(request.model,'claude-sonnet-5-5');
  assert.equal(request.effort,'high');
  assert.deepEqual(request.attachments,[image]);
  assert.equal(request.resume,null,'the Codex session must not capture a manual Claude turn');
  assert.equal(run.chat.messages.at(-1).modelLabel,'Claude Sonnet 5.5 High');
  assert.equal(run.chat.messages.at(-1).modelId,id);
  assert.equal(run.chat.messages.at(-2).modelId,id);
  run.enqueue(turn('manual-sonnet',{modelId:id,attachments:[image]}));
  run.streamEngine.complete();await settle();
  assert.equal(run.streamEngine.runs[1].agent,'claude');
  assert.equal(run.streamEngine.runs[1].model,'claude-sonnet-5-5');
  assert.equal(run.streamEngine.runs[1].effort,'high');
});

test('a manually selected discovered model remains usable outside Auto favorites', async t => {
  const f=fixture(t),run=f.chat(),id='claude-sonnet-5-5-high';
  const catalog=require('../lib/model-catalog'),{Router,config}=require('../lib/routing');
  catalog.setFavoriteModels(catalog.MODEL_CATALOG.filter(model=>model.id!==id));
  t.after(()=>require('./model-fixture').seedModels());
  run.deps.routing={router:new Router(),getConfig:()=>config(),prepareSummary:async()=>{}};
  await run.startTurn({text:'Use my selected model',modelId:id});
  assert.equal(run.streamEngine.runs[0].model,'claude-sonnet-5-5');
});

test('a stale selected model reports an error before starting any CLI',async t=>{
  const f=fixture(t),run=f.chat();
  await assert.rejects(run.startTurn({text:'Task',modelId:'missing-selected-model'}),/Selected model.*unavailable/);
  assert.equal(run.streamEngine.runs.length,0);
  assert.equal(run.chat.messages.length,0);
});

test('downloadAttachment and copyAttachment preserve image.png or renamed filenames and guard attachment paths', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const { cleanAttachmentName } = require('../extension');
  assert.equal(cleanAttachmentName('1794686684460_image.png'), 'image.png');
  assert.equal(cleanAttachmentName('b7efae68-a440-4c03-a48f-994b89991baf_1794686684460_wordmark.png'), 'wordmark.png');
  const rawImg = path.join(f.deps.attachmentsDir, '1794686684460_image.png');
  const renamedImg = path.join(f.deps.attachmentsDir, '1794686684461_wordmark.png');
  fs.writeFileSync(rawImg, 'png-bytes-1');
  fs.writeFileSync(renamedImg, 'png-bytes-2');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-dl-'));
  const savedDefaults = [], copied = [];
  const originalWindow = vscodeStub.window;
  vscodeStub.window = {
    ...originalWindow,
    showSaveDialog: async ({ defaultUri }) => {
      savedDefaults.push(path.basename(defaultUri.fsPath));
      return { fsPath: path.join(outDir, path.basename(defaultUri.fsPath)) };
    },
  };
  host.deps.copyImageToClipboard = async file => copied.push(file);
  t.after(() => { vscodeStub.window = originalWindow; fs.rmSync(outDir, { recursive: true, force: true }); });
  await host.downloadAttachment(rawImg, 'image.png');
  await host.downloadAttachment(renamedImg, '1794686684461_wordmark.png');
  assert.deepEqual(savedDefaults, ['image.png', 'wordmark.png']);
  assert.equal(fs.readFileSync(path.join(outDir, 'image.png'), 'utf8'), 'png-bytes-1');
  assert.equal(fs.readFileSync(path.join(outDir, 'wordmark.png'), 'utf8'), 'png-bytes-2');
  assert.equal(await host.downloadAttachment(path.join(outDir, 'image.png'), 'outside.png'), null);
  assert.equal(await host.copyAttachment(renamedImg), true);
  assert.deepEqual(copied, [renamedImg]);
  assert.equal(await host.copyAttachment(path.join(outDir, 'image.png')), false);
  run.chat.messages.push({ role: 'user', text: 'Sent image', attachments: [rawImg] });
  run.save();
  host.renameAttachment(rawImg, 'hero-banner');
  const renamedEvent = host.messages.findLast(m => m.type === 'attachmentRenamed');
  assert.equal(cleanAttachmentName(renamedEvent.attachment.name), 'hero-banner.png');
  assert.deepEqual(run.chat.messages.at(-1).attachments, [renamedEvent.attachment.path]);
});

test('tool_start and tool_end record startedAt and durationMs on saved tool steps', async t => {
  const f = fixture(t), run = f.chat();
  await run.startTurn({ text: 'Run the script', modelId: 'gpt-6.1-sol-high' });
  const startMs = Date.now() - 142000;
  run.handleStreamEvent({ type: 'tool_start', toolId: 'py-1', name: 'bash', command: 'python _work\\build_fluid_pptx.py', startedAt: startMs });
  const step = run.chat.messages.findLast(entry => entry.role === 'tool');
  assert.equal(step.startedAt, startMs);
  const endEvent = { type: 'tool_end', toolId: 'py-1', output: 'Done' };
  run.handleStreamEvent(endEvent);
  assert.equal(step.done, true);
  assert.ok(step.durationMs >= 142000);
  assert.equal(endEvent.durationMs, step.durationMs);
  assert.equal(step.event.durationMs, step.durationMs);
});

test('chatLoading and chatLoaded report pending scheduled/queued counts while scheduler loads or switches', async t => {
  const f = fixture(t), first = f.chat(), second = f.chat();
  const scheduler = f.deps.schedulerQueue = f.manager.deps.schedulerQueue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  const host = f.host(first);
  host.deps.schedulerQueue = scheduler;
  // Cold start before scheduler-queue.json is loaded: chatLoaded reports unknown (null) instead of empty.
  host.replay();
  assert.equal(host.messages.findLast(m => m.type === 'chatLoaded').chat.scheduledPending, null);
  await scheduler.enqueue({ model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: second.chat.id, prompt: 'Scheduled on second', dispatchTrigger: 'fixed-time', dispatchTime: new Date(Date.now() + 600000).toISOString() });
  second.queue.push({ id: 'q1', text: 'Queued on second', modelId: 'gpt-6.1-sol-high', queued: true });
  // Empty chat after scheduler loaded omits scheduledPending.
  host.replay();
  assert.equal(host.messages.findLast(m => m.type === 'chatLoaded').chat.scheduledPending, undefined);
  // Switching to second chat sends combined queueCount on chatLoading and exact scheduledPending on chatLoaded.
  host.restoreChat(second.chat.id);
  const loading = host.messages.findLast(m => m.type === 'chatLoading');
  const loaded = host.messages.findLast(m => m.type === 'chatLoaded');
  assert.equal(loading.queueCount, 2);
  assert.equal(loaded.chat.scheduledPending, 1);
});

// Chat names: the agent's own title where it writes one (Antigravity), Groq otherwise or when asked.
async function nameTurn(t, { modelId, agent, setting, annotation }) {
  const { setChatSpill } = await import('../../voice-router/lib/groq-client.mjs');
  const asked = [];
  setChatSpill({ callChat: async body => { asked.push(body.messages[1].content); return 'Groq name'; } });
  chatNames = setting;
  t.after(() => { chatNames = undefined; setChatSpill({ callChat: null }); for (const key of Object.keys(agentTitles)) delete agentTitles[key]; });
  const f = fixture(t);
  f.deps.agentTitleRetryMs = 1;
  const run = f.manager.runFor(f.deps.chatStore.save(f.deps.chatStore.create()).id);
  if (annotation) agentTitles[`${agent}:session-1`] = annotation;
  await run.startTurn({ text: 'Fix the dock hover', modelId });
  await settle();
  const duringTurn = { title: run.chat.title, asked: asked.length };
  run.streamEngine.emit('event', { type: 'session', agent, sessionId: 'session-1' });
  run.streamEngine.complete();
  for (let i = 0; i < 20; i++) await tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  return { duringTurn, title: run.chat.title, asked };
}

test('an Antigravity chat takes the name Antigravity wrote and never asks Groq', async t => {
  const result = await nameTurn(t, { modelId: 'gemini-3.8-flash-high', agent: 'gemini', setting: 'agent', annotation: 'Fix Dock Hover Animation' });
  assert.deepEqual(result.duringTurn, { title: undefined, asked: 0 }, 'nothing is guessed while the turn runs');
  assert.equal(result.title, 'Fix Dock Hover Animation');
  assert.deepEqual(result.asked, []);
});

test('an Antigravity chat with no title written falls back to Groq', async t => {
  const result = await nameTurn(t, { modelId: 'gemini-3.8-flash-high', agent: 'gemini', setting: 'agent' });
  assert.equal(result.title, 'Groq name');
  assert.deepEqual(result.asked, ['Fix the dock hover']);
});

test('Claude chats are named by Groq at once, since headless Claude writes no title', async t => {
  const result = await nameTurn(t, { modelId: 'claude-sonnet-5-5-high', agent: 'claude', setting: 'agent', annotation: 'Ignored' });
  assert.deepEqual(result.duringTurn, { title: 'Groq name', asked: 1 });
  assert.equal(result.title, 'Groq name');
});

test('with chat names set to Groq an Antigravity chat is named by Groq at once, ignoring its own title', async t => {
  const result = await nameTurn(t, { modelId: 'gemini-3.8-flash-high', agent: 'gemini', setting: 'groq', annotation: 'Fix Dock Hover Animation' });
  assert.deepEqual(result.duringTurn, { title: 'Groq name', asked: 1 });
  assert.equal(result.title, 'Groq name');
  assert.equal(result.asked.length, 1);
});

test('a name you typed is never replaced by the agent title', async t => {
  const f = fixture(t);
  f.deps.agentTitleRetryMs = 1;
  agentTitles['gemini:session-2'] = 'Agent Name';
  const run = f.manager.runFor(f.deps.chatStore.save({ ...f.deps.chatStore.create(), title: 'Mine', customTitle: true }).id);
  run.chat.sessions = { gemini: { id: 'session-2' } };
  await run.adoptAgentTitle('gemini');
  assert.equal(run.chat.title, 'Mine');
});

test('reply text is sent to the windows in batches without changing order or content', async t => {
  const f = fixture(t), run = f.chat();
  const seen = []; // what the first window received
  const secondSeen = [];
  const window = log => ({ panel: { webview: { postMessage: message => { log.push(message); } } } });
  const first = window(seen), second = window(secondSeen);
  run.hosts.add(first);
  const text = () => seen.filter(m => m.type === 'delta').map(m => m.text).join('');
  const delta = word => run.postEvent({ type: 'delta', agent: 'codex', model: 'codex', text: word });
  delta('One '); // leaves at once
  assert.equal(seen.length, 1);
  delta('two '); delta('three ');
  assert.equal(seen.length, 1, 'the next chunks wait for the batch');
  run.postEvent({ type: 'tool_start', name: 'shell', toolId: 'x' });
  assert.deepEqual(seen.map(m => m.type), ['delta', 'delta', 'tool_start'], 'a batch goes out before the event that follows it');
  assert.equal(seen[1].text, 'two three ');
  delta('four ');
  run.focus(second); // a window attaching mid-batch must not receive the text twice
  assert.equal(text(), 'One two three four ');
  delta('five '); delta('six ');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(text(), 'One two three four five six ');
  assert.equal(secondSeen.map(m => m.text).join(''), 'five six ', 'the window that attached later gets only what came after it');
  assert.equal(run.pendingDelta, null);
  run.postEvent({ type: 'delta', agent: 'codex', model: 'codex', text: 'whole', block: true });
  assert.equal(seen.at(-1).block, true, 'block replies are never merged');
});

test('a model switch saves the actual handoff and confirms it to the waiting user bubble', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const send = async (modelId, clientTurnId) => {
    await run.startTurn({ modelId, clientTurnId, text: `Prompt ${clientTurnId}` });
    const reply = run.chat.messages.at(-1);
    const prompt = run.chat.messages.at(-2);
    const confirmed = host.messages.findLast(message => message.type === 'userMessage');
    assert.equal(confirmed.clientTurnId, clientTurnId);
    assert.deepEqual(confirmed.contextHandoff, prompt.contextHandoff);
    run.streamEngine.emit('event', { type: 'delta', agent: reply.agent, text: 'Reply.' });
    run.streamEngine.complete();
    await settle();
    return { prompt, model: { agent: reply.agent, label: reply.modelLabel } };
  };
  const first = await send('claude-sonnet-5-5-high', 'first');
  assert.equal(first.prompt.contextHandoff, undefined);
  const second = await send('gpt-6.1-sol-high', 'second');
  assert.deepEqual(second.prompt.contextHandoff, { from: first.model, to: second.model });
  const same = await send('gpt-6.1-sol-high', 'same');
  assert.equal(same.prompt.contextHandoff, undefined);
  const otherCodex = await send('gpt-6-astra-high', 'other-model');
  assert.deepEqual(otherCodex.prompt.contextHandoff, { from: same.model, to: otherCodex.model });
  f.deps.chatStore.flush();
  assert.deepEqual(f.deps.chatStore.load(run.chat.id).messages.find(entry => entry.clientTurnId === 'second').contextHandoff, second.prompt.contextHandoff);
});

test('a Claude chat keeps its session at high context while native compaction is available', async t => {
  const { Router, config } = require('../lib/routing');
  const f = fixture(t), run = f.chat(), host = f.host(run);
  run.deps.routing = { router: new Router({ getConfig: () => ({ tiers: ['deterministic'] }) }), getConfig: () => config(), prepareSummary: async () => {} };
  const modelId = 'claude-sonnet-5-5-high';
  run.chat.sessions = { claude: { id: 'session-1', seen: 0 } };
  run.chat.context = { agent: 'claude', tokens: 165000, limit: 1000000 };
  await run.startTurn({ text: 'keep going', modelId });
  assert.equal(run.streamEngine.runs.at(-1).resume, 'session-1', 'was 129% of an assumed 128k window and started over');
  assert.ok(!host.messages.some(message => message.type === 'contextReset'));
  run.streamEngine.complete(); await settle();

  run.chat.context = { agent: 'claude', tokens: 850000, limit: 1000000 };
  await run.startTurn({ text: 'and more', modelId });
  assert.equal(run.streamEngine.runs.at(-1).resume, 'session-1');
  assert.ok(!host.messages.some(message => message.type === 'contextReset'));
  run.streamEngine.complete(); await settle();

  t.mock.method(require('../lib/providers').get('claude'), 'nativeAutoCompaction', () => false);
  run.chat.context = { agent: 'claude', tokens: 850000, limit: 1000000 };
  await run.startTurn({ text: 'and again', modelId });
  assert.equal(run.streamEngine.runs.at(-1).resume, null);
  const reply = run.chat.messages.findLast(message => message.role === 'assistant');
  assert.equal(reply.contextResets.length, 1);
  assert.match(reply.contextResets[0].detail, /85% of Claude's window/);
  assert.deepEqual(host.messages.filter(message => message.type === 'contextReset').map(message => message.title), ['New session · context reset']);
});

test('high context defers to the harness and still uses the fallback when native compaction is disabled', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const modelId = 'claude-sonnet-5-5-high';
  const provider = require('../lib/providers').get('claude');
  const capability = t.mock.method(provider, 'nativeAutoCompaction', () => true);
  const engine = run.streamEngine;
  const finishAt = async (contextTokens) => {
    await run.startTurn({ text: 'Keep working', modelId });
    engine.emit('event', { type: 'usage', agent: 'claude', contextTokens, contextWindow: 200000 });
    engine.emit('event', { type: 'delta', agent: 'claude', text: 'Progress.' });
    engine.complete();
    await settle();
  };
  await finishAt(200000);
  assert.equal(engine.runs.length, 1);
  await assert.rejects(run.startTurn({ text: '/compact keep this', modelId }), /manages compaction automatically/);
  assert.equal(engine.runs.length, 1, 'a typed compaction command never reaches the CLI');
  capability.mock.mockImplementation(() => false);
  await finishAt(179999);
  assert.equal(engine.runs.length, 2);
  await finishAt(180000);
  assert.equal(engine.runs.length, 4);
  assert.equal(engine.runs.at(-1).autoCompact, true);
  assert.equal(host.messages.filter(message => message.type === 'compacting').length, 1);
  engine.emit('event', { type: 'delta', agent: 'claude', text: 'Retained work and next steps.' });
  engine.complete();
  await settle();
  assert.equal(run.chat.messages.at(-1).checkpoint, true);
});

test("a CLI's own compaction and an unexplained fall of the gauge both leave a divider, once", async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  run.chat.sessions = { claude: { id: 'session-1', seen: 0 } };
  run.chat.context = { agent: 'claude', tokens: 400000, limit: 1000000 };
  await run.startTurn({ text: 'work', modelId: 'claude-sonnet-5-5-high' });
  const engine = run.streamEngine;
  engine.emit('event', { type: 'usage', agent: 'claude', contextTokens: 410000 });
  engine.emit('event', { type: 'context_reset', kind: 'native', agent: 'claude', trigger: 'auto', preTokens: 410000 });
  engine.emit('event', { type: 'context_reset', kind: 'native', agent: 'claude', trigger: 'auto', preTokens: 410000 });
  engine.emit('event', { type: 'usage', agent: 'claude', contextTokens: 60000 });
  const reply = run.chat.messages.findLast(message => message.role === 'assistant');
  assert.deepEqual(reply.contextResets.map(entry => entry.kind), ['native'], 'the drop after an announced compaction is not news again');
  engine.complete(); await settle();

  // Nothing announced it this time (Gemini): the fall itself is the evidence.
  run.chat.context = { agent: 'claude', tokens: 400000, limit: 1000000 };
  await run.startTurn({ text: 'more work', modelId: 'claude-sonnet-5-5-high' });
  run.streamEngine.emit('event', { type: 'usage', agent: 'claude', contextTokens: 120000 });
  const second = run.chat.messages.findLast(message => message.role === 'assistant');
  assert.deepEqual(second.contextResets.map(entry => entry.kind), ['drop']);
  assert.match(second.contextResets[0].detail, /120k tokens, down from 400k/);
  assert.equal(host.messages.filter(message => message.type === 'contextReset').length, 2);
});

test('resuming a paused queue with only due scheduled prompts immediately triggers the watchdog', async t => {
  const f = fixture(t);
  let watchdog;
  f.deps.onQueueResumed = () => void watchdog?.tick();
  const run = f.chat();
  const queue = new SchedulerQueue({ workspaceDir: f.deps.workspaceDir, sessionDir: f.deps.sessionDir });
  await queue.enqueue({ model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: run.chat.id, dispatchTrigger: 'quota-reset', prompt: 'continue', notBefore: new Date(Date.now() - 60000).toISOString() });
  await queue.enqueue({ model: 'codex', modelId: 'gpt-6.1-sol-high', chatId: run.chat.id, dispatchTrigger: 'quota-reset', prompt: 'Next prompt', notBefore: new Date(Date.now() - 60000).toISOString() });
  run.pauseQueue(true);
  watchdog = new SchedulerWatchdog({
    queue, workspaceDir: f.deps.workspaceDir, getModels: () => ({}),
    resumeInChat: task => f.manager.resumeChat(task),
    isChatBusy: (id, task) => f.manager.isChatBusy(id, task),
    getQueueState: id => f.manager.runs.get(id)?.queueState() || {},
  });
  t.after(() => watchdog.engine.dispose());
  await watchdog.tick(); await settle();
  assert.equal(run.streamEngine.runs.length, 0, 'paused queue holds due scheduled prompts');

  run.pauseQueue(false);
  await until(() => run.streamEngine.runs.length, n => n === 1);
  assert.equal(run.chat.messages.findLast(m => m.role === 'user').text, 'continue', 'resuming dispatches the first due scheduled prompt at once');
});

test('attachUris copies dropped/pasted local files into attachments and turns directories into mentions', async t => {
  const f = fixture(t), run = f.chat(), host = f.host(run);
  const sample = path.join(f.deps.workspaceDir, 'notes.txt');
  const folder = path.join(f.deps.workspaceDir, 'sub');
  fs.writeFileSync(sample, 'hello linux drop');
  fs.mkdirSync(folder);
  const toFileUri = (p) => `file://${p.startsWith('/') ? '' : '/'}${encodeURI(p.replace(/\\/g, '/'))}`;
  await host.handleMessage({ type: 'attachUris', chatId: run.chat.id, uris: [toFileUri(sample), toFileUri(folder), 'https://example.com/nope'] });
  const saved = host.messages.find(m => m.type === 'attachmentSaved');
  assert.ok(saved, 'regular file is copied and reported as attachmentSaved');
  assert.equal(fs.readFileSync(saved.attachment.path, 'utf8'), 'hello linux drop');
  const mentions = host.messages.find(m => m.type === 'insertMentions');
  assert.deepEqual(mentions?.paths, ['sub'], 'dropped directory becomes a workspace-relative @-mention');
});
