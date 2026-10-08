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
const { SchedulerQueue } = require('../lib/scheduler-queue');
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
let quotaHook;
const quotas = { claude: { remaining: 100 }, codex: { remaining: 100 }, gemini: { remaining: 100 } };
const load = Module._load;
const vscodeStub = {
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'verifyCommand' ? 'npm run check' : fallback }) },
  Uri: { file: file => ({ fsPath: file, toString: () => file }), joinPath: (base, ...parts) => ({ fsPath: path.join(String(base), ...parts), toString: () => path.join(String(base), ...parts) }) },
};
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  if (request === './lib/stream-engine.js') return { StreamEngine: Engine };
  if (request === './lib/quota-bridge.js') return { readQuotas: async () => quotaHook ? quotaHook() : quotas };
  return load.call(this, request, parent, isMain);
};
const { ChatWindowManager, ChatWindowHost, SchedulerWatchdog } = require('../extension');
Module._load = load;

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { await tick(); await tick(); };

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
  host.saveAttachment({ chatId: run.chat.id, name: 'router feedback.json', mime: 'application/json', data: Buffer.from(content).toString('base64') });
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
  host.saveAttachment({ chatId: first.chat.id, name: 'late.png', mime: 'image/png', data: Buffer.from('late picture').toString('base64') });
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
  await host.handleMessage({ type: 'saveDraft', chatId: run.chat.id, text: 'Unsent idea\nKeep this' });
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
  assert.equal(f.deps.chatStore.load(run.chat.id).hasTypedMessage, true);
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

test('sidebar switches apply the same recent-five ordering as the rail', async t => {
  const f = fixture(t), host = f.host(f.chat());
  host.panel.sidebar = true;
  f.manager.sidebar = host;
  f.manager.deps.sidebarState = { update() {} };
  const drafts = [];
  for (let i = 0; i < 6; i++) {
    drafts.push(host.chat.id);
    await host.handleMessage({ type: 'saveDraft', chatId: host.chat.id, text: `Draft ${i}` });
    host.attach(f.chat());
  }
  assert.equal(f.deps.chatStore.load(drafts[0]), null);
  for (const id of drafts.slice(-4)) assert.ok(f.deps.chatStore.load(id));
  assert.equal(f.manager.listChats().slice(0, 5)[0].id, host.chat.id);
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
  assert.match(request.prompt, /Earlier Auto-mode role restrictions no longer apply/);
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

test('queue conversion preserves edits, images and project; Continue stays first and survives reload', async t => {
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
  assert.equal((await reloaded.getQueue())[0].prompt, 'continue');
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

test('streaming without a window saves text, tool steps and session IDs before turn completion', async t => {
  const f = fixture(t), run = f.chat();
  await run.startTurn({ text: 'Long task', modelId: 'gpt-6.1-sol-high' });
  run.handleStreamEvent({ type: 'session', agent: 'codex', sessionId: 'durable-thread' });
  assert.equal(f.deps.chatStore.load(run.chat.id).sessions.codex.id, 'durable-thread');
  run.handleStreamEvent({ type: 'delta', agent: 'codex', text: 'Saved progress' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.deps.chatStore.load(run.chat.id).messages.at(-1).text, 'Saved progress');
  assert.equal(f.deps.chatStore.load(run.chat.id).messages.at(-1).inProgress, true);
  run.handleStreamEvent({ type: 'tool_start', name: 'shell', toolId: 'step' });
  assert.equal(f.deps.chatStore.load(run.chat.id).messages.at(-1).offset, 'Saved progress'.length);
  run.streamEngine.complete();
  assert.equal(f.deps.chatStore.load(run.chat.id).messages.at(-2).inProgress, undefined);
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

test('Explorer warns about all active chats, cancels safely and can open a separate window', async t => {
  const f = fixture(t), run = f.chat(), other = f.chat(), host = f.host(run);
  const projects = new ProjectRegistry(f.deps.sessionDir);
  const project = projects.add('Workspace', f.deps.workspaceDir);
  run.chat.projectId = project.id;
  host.deps.projects = projects;
  await run.startTurn({ text: 'One', modelId: 'gpt-6.1-sol-high' });
  await other.startTurn({ text: 'Two', modelId: 'gpt-6.1-sol-high' });
  let choice, warning, additions = 0;
  const commands = [];
  vscodeStub.workspace.workspaceFolders = [];
  vscodeStub.workspace.updateWorkspaceFolders = () => { additions++; return true; };
  vscodeStub.window = { showWarningMessage: async (...args) => { warning = args; return choice; }, showErrorMessage: message => assert.fail(message) };
  vscodeStub.commands = { executeCommand: async (...args) => commands.push(args) };
  await host.openProjectExplorer();
  assert.match(warning[0], /2 active chats/);
  assert.equal(warning[1].modal, true);
  assert.equal(additions, 0);
  choice = 'Open in New Window';
  await host.openProjectExplorer();
  assert.equal(additions, 0);
  assert.equal(commands.at(-1)[0], 'vscode.openFolder');
  assert.deepEqual(commands.at(-1)[2], { forceNewWindow: true });
  assert.equal(run.streamEngine.disposed, undefined);
  choice = 'Switch Anyway';
  run.handleStreamEvent({ type: 'delta', text: 'Flush before switching' });
  await host.openProjectExplorer();
  assert.equal(additions, 1);
  assert.equal(f.deps.chatStore.load(run.chat.id).messages.at(-1).text, 'Flush before switching');
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: project.root } }];
  warning = null;
  await host.openProjectExplorer();
  assert.equal(warning, null, 'revealing a folder already in Explorer cannot interrupt chats');
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
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.deps.chatStore.load(id).messages.at(-1).text, 'Scheduled progress');
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
