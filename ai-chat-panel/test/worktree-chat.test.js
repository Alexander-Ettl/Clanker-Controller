'use strict';

// WORKTREE-01, the chat side: /worktree new|remove, the working root of live and queued runs, deleting a chat, the hint.
// The real chat manager, project registry, chat store and git (temp repositories); the stream engine is a stand-in that records
// where it was told to work, so no CLI or model runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ChatStore } = require('../lib/chat-store');
const { ProjectRegistry } = require('../lib/projects');
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
const shown = [];
const vscodeStub = {
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { showWarningMessage: (text) => { shown.push(text); }, showInformationMessage: (text) => { shown.push(text); } },
  Uri: { file: file => ({ fsPath: file, toString: () => file }), joinPath: (base, ...parts) => ({ fsPath: path.join(String(base), ...parts), toString: () => path.join(String(base), ...parts) }) },
};
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  if (request === './lib/stream-engine.js') return { StreamEngine: Engine };
  if (request === './lib/quota-bridge.js') return { readQuotas: async () => ({ claude: { remaining: 100 } }), claudeUsageAge: () => 0, recordClaudeUsage() {} };
  return load.call(this, request, parent, isMain);
};
const { ChatWindowManager, ChatWindowHost } = require('../extension');
Module._load = load;

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const MODEL = 'gpt-6.1-sol-high';

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-wt-chat-')));
  const previous = process.env.CLANKER_WORKTREES;
  process.env.CLANKER_WORKTREES = path.join(base, 'managed');
  const repo = path.join(base, 'app');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo); git(['config', 'user.email', 't@t'], repo); git(['config', 'user.name', 't'], repo); git(['config', 'core.autocrlf', 'false'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(['add', '.'], repo); git(['commit', '-qm', 'base'], repo);
  const sessionDir = path.join(base, 'session');
  fs.mkdirSync(sessionDir);
  const projects = new ProjectRegistry(sessionDir);
  const project = projects.add('App', repo);
  const deps = { sessionDir, attachmentsDir: path.join(sessionDir, 'attachments'), workspaceDir: repo, chatStore: new ChatStore(sessionDir), projects, defaultProjectId: project.id, getModels: () => ({}), getPermissionMode: () => 'fullAccess', notifyHistory() {} };
  fs.mkdirSync(deps.attachmentsDir);
  const manager = new ChatWindowManager('/panel', deps);
  const chat = (title = 'Fix the login bug') => manager.runFor(deps.chatStore.save({ ...deps.chatStore.create(), projectId: project.id, title }).id, project.id);
  const host = (run) => {
    const instance = Object.create(ChatWindowHost.prototype);
    const messages = [];
    Object.assign(instance, { panel: { webview: { postMessage: message => messages.push(message), asWebviewUri: uri => uri }, title: '' }, extensionUri: '/panel', deps: { ...deps, chatWindowManager: manager }, run: null, activeModelId: 'auto', activeAgent: 'auto', messages });
    instance.attach(run);
    return instance;
  };
  const notices = (h) => h.messages.filter(message => message.type === 'notice').map(message => message.text);
  t.after(() => {
    clearTimeout(manager.openTimer); for (const run of manager.runs.values()) run.streamEngine.dispose(); deps.chatStore.flush();
    if (previous === undefined) delete process.env.CLANKER_WORKTREES; else process.env.CLANKER_WORKTREES = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, repo, project, deps, manager, chat, host, notices };
}

test('/worktree new moves the chat\'s working root into its own worktree, and queued turns run there', async t => {
  const f = fixture(t);
  let run = f.chat(); const host = f.host(run);
  assert.equal(run.streamEngine.cwd, f.repo, 'before: the project folder');
  await host.worktreeCommand('new');
  run = f.manager.runFor(run.chat.id);
  const saved = f.deps.chatStore.load(run.chat.id);
  assert.match(saved.worktree.branch, /^clanker\/fix-the-login-bug/);
  assert.ok(saved.worktree.path.startsWith(path.join(f.base, 'managed') + path.sep), 'under the managed folder, outside the repo');
  assert.equal(run.deps.workspaceDir, saved.worktree.path);
  assert.equal(run.streamEngine.cwd, saved.worktree.path, 'the engine works in the worktree');
  assert.equal(run.deps.projectRoot, f.repo, 'the project stays its parent');
  assert.deepEqual(saved.sessions, {}, 'the agent\'s old session was for another folder');
  assert.match(f.notices(host).at(-1), /own worktree on clanker\/fix-the-login-bug/);
  // A turn queued afterwards runs in the worktree too.
  run.enqueue({ id: 'q1', text: 'edit a.txt', modelId: MODEL, queued: true });
  await flush();
  assert.equal(run.streamEngine.runs.length, 1);
  assert.equal(run.streamEngine.cwd, saved.worktree.path);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo), 'main', 'the project folder was not switched');
});

test('/worktree is refused while a turn is running, and when the chat already has one', async t => {
  const f = fixture(t);
  const run = f.chat(); const host = f.host(run);
  run.enqueue({ id: 'q1', text: 'work', modelId: MODEL, queued: true });
  await flush();
  await host.worktreeCommand('new');
  assert.match(f.notices(host).at(-1), /Wait for the current turn/);
  assert.equal(f.deps.chatStore.load(run.chat.id).worktree, undefined);
  run.streamEngine.complete(); await flush();
  await host.worktreeCommand('new');
  const again = f.manager.runFor(run.chat.id);
  await f.host(again).worktreeCommand('new');
  assert.match(f.notices(host).at(-1) + f.notices(f.host(again)).at(-1), /already has a worktree/);
});

test('/worktree remove keeps a dirty worktree, removes a clean one and sends the chat back to the project folder', async t => {
  const f = fixture(t);
  const run = f.chat(); const host = f.host(run);
  await host.worktreeCommand('new');
  let current = f.manager.runFor(run.chat.id);
  const tree = current.chat.worktree.path;
  fs.writeFileSync(path.join(tree, 'new.txt'), 'x\n');
  const h2 = f.host(current);
  await h2.worktreeCommand('remove');
  assert.match(f.notices(h2).at(-1), /kept: 1 uncommitted file.*--force/);
  assert.ok(fs.existsSync(tree));
  assert.ok(f.deps.chatStore.load(current.chat.id).worktree, 'the chat still points at it');
  fs.rmSync(path.join(tree, 'new.txt'));
  await h2.worktreeCommand('remove');
  current = f.manager.runFor(run.chat.id);
  assert.equal(fs.existsSync(tree), false);
  assert.equal(f.deps.chatStore.load(run.chat.id).worktree, undefined);
  assert.equal(current.deps.workspaceDir, f.repo, 'back in the project folder');
  assert.equal(git(['worktree', 'list', '--porcelain'], f.repo).split('\n').filter(line => line.startsWith('worktree ')).length, 1, 'no stale git worktree entry');
});

test('deleting a chat removes a clean worktree and keeps one with unsaved work, saying so', async t => {
  const f = fixture(t);
  const a = f.chat('Clean one'); await f.host(a).worktreeCommand('new');
  const treeA = f.deps.chatStore.load(a.chat.id).worktree.path;
  const b = f.chat('Dirty one'); await f.host(b).worktreeCommand('new');
  const treeB = f.deps.chatStore.load(b.chat.id).worktree.path;
  fs.writeFileSync(path.join(treeB, 'wip.txt'), 'wip\n');
  f.manager.deleteChat(a.chat.id);
  assert.equal(fs.existsSync(treeA), false, 'clean: gone with the chat');
  f.manager.deleteChat(b.chat.id);
  assert.ok(fs.existsSync(path.join(treeB, 'wip.txt')), 'dirty: kept');
  assert.match(shown.at(-1), /worktree was kept.*uncommitted/);
  assert.equal(f.deps.chatStore.load(b.chat.id), null);
});

test('a second chat starting in a project where another is running is told about /worktree, once', async t => {
  const f = fixture(t);
  const first = f.chat('First'); f.host(first);
  first.enqueue({ id: 'q1', text: 'long job', modelId: MODEL, queued: true });
  await flush();
  assert.equal(first.state, 'running');
  const second = f.chat('Second'); const host = f.host(second);
  second.suggestWorktree();
  second.suggestWorktree();
  const hints = f.notices(host).filter(text => /\/worktree new/.test(text));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /Another chat \("First"\) is working in this project/);
  const lone = f.chat('Alone'); first.streamEngine.complete(); await flush();
  const h3 = f.host(lone); lone.suggestWorktree();
  assert.equal(f.notices(h3).filter(text => /\/worktree new/.test(text)).length, 0, 'nothing running elsewhere: no hint');
});

test('the chip state names the branch and counts uncommitted files', async t => {
  const f = fixture(t);
  const run = f.chat(); const host = f.host(run);
  await host.worktreeCommand('new');
  const current = f.manager.runFor(run.chat.id);
  const h2 = f.host(current);
  fs.writeFileSync(path.join(current.chat.worktree.path, 'x.txt'), '1\n');
  h2.pushWorktreeState();
  await new Promise(resolve => setTimeout(resolve, 200));
  const state = h2.messages.findLast(message => message.type === 'worktree');
  assert.equal(state.worktree.dirty, 1);
  assert.match(state.worktree.branch, /^clanker\//);
  assert.equal(state.worktree.missing, false);
});
