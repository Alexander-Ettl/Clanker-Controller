'use strict';

// SCHED-01: the headless runner runs due scheduled turns with the editor closed. Real queue, chat store and stream
// engine on a temp session folder; the vendor CLI is a stand-in script, so no real prompt is ever sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WIN = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-headless-'));
process.env.CLANKER_HOME = path.join(root, 'home');
process.env.AI_CHAT_PANEL_QUOTA_CACHE = path.join(root, 'quota-cache.json');

// A stand-in `claude`: prints a stream-json reply, records its arguments, and fails when asked to.
const FAKE = path.join(root, 'bin', 'claude');
fs.mkdirSync(path.dirname(FAKE), { recursive: true });
fs.writeFileSync(FAKE, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
fs.appendFileSync(path.join(here, 'calls.log'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
const mode = fs.existsSync(path.join(here, 'mode')) ? fs.readFileSync(path.join(here, 'mode'), 'utf8').trim() : 'ok';
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'fake-session-1' });
if (mode === 'fail') { process.stderr.write('Failed to authenticate. API Error: 401 Unauthorized, please log in again\\n'); process.exit(1); }
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done at night.' }] } });
setTimeout(() => { say({ type: 'result', result: 'Done at night.', usage: { input_tokens: 3, output_tokens: 4 } }); process.exit(0); }, 150);
`, { mode: 0o755 });
const locator = require('../lib/binary-locator');
locator.locate = (agent) => ({ agent, path: FAKE, checked: [] });

const { runDue } = require('../lib/headless-runner');
const { SchedulerQueue } = require('../lib/scheduler-queue');
const { ChatStore } = require('../lib/chat-store');
const { ProjectRegistry } = require('../lib/projects');
const { IdePresence } = require('../lib/runner-lock');

const skip = WIN ? 'the stand-in CLI is a shebang script; Windows has no equivalent here' : false;
const calls = () => (fs.existsSync(path.join(path.dirname(FAKE), 'calls.log')) ? fs.readFileSync(path.join(path.dirname(FAKE), 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const setMode = (mode) => fs.writeFileSync(path.join(path.dirname(FAKE), 'mode'), mode);
const quotas = async () => ({ claude: { remaining: 80, used: 20 } });

/** A fresh session folder with one registered project and an empty queue. */
async function world() {
  fs.rmSync(path.join(path.dirname(FAKE), 'calls.log'), { force: true });
  setMode('ok');
  const sessionDir = fs.mkdtempSync(path.join(root, 'session-'));
  const projectDir = fs.mkdtempSync(path.join(root, 'project-'));
  const projects = new ProjectRegistry(sessionDir);
  const project = projects.add('Demo', projectDir);
  const queue = new SchedulerQueue({ workspaceDir: projectDir, sessionDir });
  const chats = new ChatStore(sessionDir);
  const past = () => new Date(Date.now() - 60000).toISOString();
  const schedule = (extra = {}) => queue.enqueue({ model: 'claude', prompt: 'continue', dispatchTrigger: 'fixed-time', dispatchTime: past(), projectId: project.id, ...extra });
  const settings = { sessionDir, workspaceDir: projectDir, enabledAgents: ['claude'], models: {}, permissionMode: 'fullAccess' };
  const run = (extra = {}) => runDue({ settings, readQuotas: quotas, ...extra });
  // The runner works on its own copy of the files: reload to see what it wrote.
  const fresh = () => new SchedulerQueue({ workspaceDir: projectDir, sessionDir });
  return { sessionDir, projectDir, project, queue, chats, schedule, settings, run, fresh, past };
}

test('a due prompt runs with the editor closed and lands in a chat that shows its reply', { skip }, async () => {
  const w = await world();
  const task = await w.schedule({ prompt: 'write the changelog' });
  const notes = [];
  const result = await w.run({ notify: (agent, text, title) => notes.push({ agent, text, title }) });
  assert.deepEqual(result.ran, [{ id: task.id, status: 'done' }]);
  const [saved] = await w.fresh().getQueue();
  assert.equal(saved.status, 'done');
  assert.equal(saved.outputPreview, 'Done at night.');
  const [summary] = w.chats.list();
  const chat = w.chats.load(summary.id);
  assert.equal(chat.projectId, w.project.id);
  assert.equal(chat.title, 'Scheduled: write the changelog');
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chat.messages[1].text, 'Done at night.');
  assert.equal(chat.messages[1].inProgress, undefined, 'a finished reply is not left looking busy');
  assert.equal(chat.messages[0].scheduled, true);
  assert.equal(chat.sessions.claude.id, 'fake-session-1');
  assert.equal(fs.realpathSync(calls()[0].cwd), fs.realpathSync(w.projectDir), 'the turn ran in the project\'s own folder');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Scheduled task');
});

test('a prompt for a chat resumes that chat\'s own session and adds to it', { skip }, async () => {
  const w = await world();
  const chat = w.chats.save({ ...w.chats.create(), projectId: w.project.id, title: 'Release work', sessions: { claude: { id: 'earlier-session', seen: 2 } },
    messages: [{ role: 'user', text: 'start the release', agent: 'claude' }, { role: 'assistant', text: 'Hit the limit.', agent: 'claude' }] });
  await w.schedule({ chatId: chat.id, prompt: 'continue' });
  const result = await w.run();
  assert.equal(result.ran[0].status, 'done');
  const args = calls()[0].args;
  assert.ok(args.includes('--resume') && args[args.indexOf('--resume') + 1] === 'earlier-session', `resumed the chat's session: ${args.join(' ')}`);
  const after = w.chats.load(chat.id);
  assert.deepEqual(after.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(after.title, 'Release work');
  assert.equal(after.messages[3].text, 'Done at night.');
  assert.equal(w.chats.list().length, 1, 'no second chat was made');
});

test('with the editor open the runner stands down and touches nothing', { skip }, async () => {
  const w = await world();
  await w.schedule();
  const presence = new IdePresence(w.sessionDir);
  presence.start();
  try {
    const result = await w.run();
    assert.equal(result.skipped, 'ide-open');
    assert.equal(calls().length, 0);
    assert.equal((await w.fresh().getQueue())[0].status, 'pending');
  } finally { presence.dispose(); }
  assert.equal((await w.run()).ran.length, 1, 'once the editor is closed it runs');
});

test('two runners starting together run the task once', { skip }, async () => {
  const w = await world();
  await w.schedule();
  const [a, b] = await Promise.all([w.run(), w.run()]);
  assert.equal(a.ran.length + b.ran.length, 1);
  assert.equal([a.skipped, b.skipped].filter(Boolean)[0], 'runner-active');
  assert.equal(calls().length, 1);
});

test('a runner that died leaves a lock that does not block the next one', { skip }, async () => {
  const w = await world();
  await w.schedule();
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.on('exit', resolve));
  fs.writeFileSync(path.join(w.sessionDir, 'runner.lock'), JSON.stringify({ pid: child.pid, at: new Date().toISOString() }));
  assert.equal((await w.run()).ran.length, 1);
  assert.equal(fs.existsSync(path.join(w.sessionDir, 'runner.lock')), false, 'the lock is released afterwards');
});

test('only what is due runs: a future time, an exhausted model and a removed CLI all wait', { skip }, async () => {
  const w = await world();
  await w.schedule({ dispatchTime: new Date(Date.now() + 3600000).toISOString() });
  assert.deepEqual((await w.run()).ran, []);
  await w.schedule({ prompt: 'second' });
  assert.deepEqual((await w.run({ readQuotas: async () => ({ claude: { remaining: 0 } }) })).ran, [], 'no usage left: it waits for the reset');
  assert.deepEqual((await w.run({ settings: { ...w.settings, enabledAgents: ['codex'] } })).ran, [], 'a CLI taken out of Clanker is left alone');
  assert.equal(calls().length, 0);
  assert.equal((await w.run()).ran.length, 1);
});

test('a failing turn says so in the chat and keeps the task for a retry', { skip }, async () => {
  const w = await world();
  await w.schedule({ prompt: 'try this' });
  setMode('fail');
  const result = await w.run();
  assert.equal(result.ran[0].status, 'failed');
  const [saved] = await w.fresh().getQueue();
  assert.equal(saved.status, 'pending');
  assert.equal(saved.retryCount, 1);
  assert.match(saved.error, /./);
  const chat = w.chats.load(w.chats.list()[0].id);
  assert.match(chat.messages[1].text, /failed|sign|log in/i, 'the chat explains it instead of showing an empty reply');
});

test('a task whose project folder is gone is left pending', { skip }, async () => {
  const w = await world();
  await w.schedule();
  fs.rmSync(w.projectDir, { recursive: true, force: true });
  assert.deepEqual((await w.run()).ran, []);
  assert.equal(calls().length, 0);
});

test('a chat that another process is still writing is not touched', { skip }, async () => {
  const w = await world();
  const chat = w.chats.save({ ...w.chats.create(), projectId: w.project.id, title: 'Busy', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'partial', inProgress: true, hostPid: process.ppid || 1 }] });
  await w.schedule({ chatId: chat.id });
  const result = await w.run();
  assert.deepEqual(result.ran.map((r) => r.status), ['busy']);
  assert.equal(calls().length, 0);
});

test('the editor\'s settings are published once and read back', () => {
  const { publishSettings, readSettings } = require('../lib/headless-runner');
  assert.equal(readSettings(), null);
  assert.equal(publishSettings({ sessionDir: '/x/session', workspaceDir: '/x', models: { claude: 'opus' } }), true);
  assert.equal(publishSettings({ sessionDir: '/x/session', workspaceDir: '/x', models: { claude: 'opus' } }), false, 'unchanged: no rewrite');
  assert.equal(readSettings().models.claude, 'opus');
  fs.rmSync(path.join(process.env.CLANKER_HOME, 'runner.json'));
});

test('the editor\'s queue refuses to load while a runner owns it, and reads the runner\'s work afterwards', { skip }, async () => {
  const w = await world();
  await w.schedule();
  const editor = w.fresh();
  let blocked = true;
  editor.guard = () => { if (blocked) throw new Error('owned by the runner'); };
  await assert.rejects(editor.getQueue(), /owned by the runner/);
  assert.equal(editor.loaded, false, 'nothing half-loaded');
  blocked = false;
  assert.equal((await editor.getQueue())[0].status, 'pending');
  await w.run();
  assert.equal((await editor.getQueue())[0].status, 'pending', 'its in-memory copy is stale until it reloads');
  await editor.reload();
  assert.equal((await editor.getQueue())[0].status, 'done');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
