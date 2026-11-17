'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SchedulerQueue } = require('../lib/scheduler-queue.js');

test('staged markup retains its source and hints after the composer files disappear', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-markup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { writeMarkup, readMarkup, markupPrompt } = require('../lib/markup');
  const source = path.join(root, 'source.png'), composite = path.join(root, 'marked.png');
  fs.writeFileSync(source, 'original'); fs.writeFileSync(composite, 'composite');
  writeMarkup(composite, source, { width: 100, height: 100, items: [{ kind: 'text', x: 10, y: 10, size: 8, text: 'Fix here' }] });
  const queue = new SchedulerQueue({ workspaceDir: root, sessionDir: path.join(root, 'session') });
  const [staged] = await queue.stageAttachments([composite], path.join(root, 'staged'));
  fs.unlinkSync(source); fs.unlinkSync(composite);
  assert.equal(fs.readFileSync(readMarkup(staged.absolutePath).original, 'utf8'), 'original');
  assert.match(markupPrompt(staged.absolutePath), /Fix here/);
});

test('ready scheduled prompts retain reordered priority across reload without changing their schedules', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ready-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { workspaceDir: root, sessionDir: path.join(root, 'session') };
  const queue = new SchedulerQueue(options);
  const base = { model: 'claude', chatId: 'chat', dispatchTrigger: 'quota-reset', notBefore: '2020-01-01T00:00:00.000Z' };
  const first = await queue.enqueue({ ...base, prompt: 'First' });
  const unrelated = await queue.enqueue({ ...base, chatId: 'other', prompt: 'Other chat' });
  const second = await queue.enqueue({ ...base, prompt: 'Second' });
  const future = await queue.enqueue({ ...base, prompt: 'Appointment', dispatchTrigger: 'fixed-time', dispatchTime: '2099-01-01T00:00:00.000Z' });
  await queue.reorder([second.id, first.id, future.id]);
  const tasks = await new SchedulerQueue(options).getQueue();
  assert.deepEqual(tasks.map(task => task.id), [second.id, unrelated.id, first.id, future.id]);
  assert.equal(tasks[0].notBefore, base.notBefore);
  assert.equal(tasks.at(-1).dispatchTime, future.dispatchTime);
});

test('Claude prompts for one reset share a conservative deadline across enqueue and reload', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-reset-clock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { workspaceDir: root, sessionDir: path.join(root, 'session') };
  const queue = new SchedulerQueue(options);
  const early = '2026-11-12T23:09:00.000Z', later = '2026-11-12T23:10:00.000Z';
  const base = { model: 'claude', chatId: 'visor', dispatchTrigger: 'quota-reset' };
  await queue.enqueue({ ...base, prompt: 'First', notBefore: early });
  await queue.enqueue({ ...base, prompt: 'Second', notBefore: later });
  await queue.enqueue({ ...base, prompt: 'Third', notBefore: early });
  let tasks = await queue.getQueue();
  assert.deepEqual(tasks.map(task => task.notBefore), [later, later, later]);
  tasks[0].notBefore = early; // Old on-disk state shown in the screenshot.
  fs.writeFileSync(queue.filePath, JSON.stringify(tasks));
  const restored = new SchedulerQueue(options);
  assert.deepEqual((await restored.getQueue()).map(task => task.notBefore), [later, later, later]);
  assert.deepEqual(JSON.parse(fs.readFileSync(queue.filePath)).map(task => task.notBefore), [later, later, later]);
  const calendar = await restored.enqueue({ ...base, prompt: 'Calendar', dispatchTrigger: 'fixed-time', dispatchTime: early });
  const weekly = await restored.enqueue({ ...base, prompt: 'Week', resetWindow: '7d', notBefore: early });
  const other = await restored.enqueue({ ...base, chatId: 'other', prompt: 'Other', notBefore: early });
  const nextWindow = await restored.enqueue({ ...base, prompt: 'Next window', notBefore: '2026-11-13T04:09:00.000Z' });
  tasks = await restored.getQueue();
  assert.equal(tasks.find(task => task.id === calendar.id).dispatchTime, early);
  assert.equal(tasks.find(task => task.id === weekly.id).resetWindow, '7d');
  for (const entry of [weekly, other, nextWindow]) assert.equal(tasks.find(task => task.id === entry.id).notBefore, entry.notBefore);
});

test('changing providers clears only the old provider reset wait and keeps editing held', async t => {
  require('./model-fixture').seedModels();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queue = new SchedulerQueue({ workspaceDir: root, sessionDir: path.join(root, 'session') });
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const task = await queue.enqueue({ model: 'claude', modelId: 'claude-sonnet-5-5-high', prompt: 'continue', dispatchTrigger: 'quota-reset', notBefore: deadline });
  await queue.saveDraft(task.id, { text: 'continue', modelId: 'claude-opus-5-5-medium' }, [], false);
  assert.equal((await queue.getQueue())[0].notBefore, deadline, 'same provider keeps reset');
  await queue.saveDraft(task.id, { text: 'continue', modelId: 'gpt-6.1-sol-high' }, [], true);
  let saved = (await queue.getQueue())[0];
  const { isDue } = require('../lib/scheduler-queue');
  assert.equal(saved.model, 'codex');
  assert.equal(saved.notBefore, undefined);
  assert.equal(isDue(saved, Date.now()), false, 'never send while user edits');
  await queue.saveDraft(task.id, { text: 'continue', modelId: 'gpt-6.1-sol-high' }, [], false);
  saved = (await queue.getQueue())[0];
  assert.equal(isDue(saved, Date.now()), true);
  const restored = new SchedulerQueue({ workspaceDir: root, sessionDir: path.join(root, 'session') });
  assert.equal(isDue((await restored.getQueue())[0], Date.now()), true);
  const calendar = await queue.enqueue({ model: 'claude', prompt: 'Tomorrow', dispatchTrigger: 'fixed-time', dispatchTime: deadline });
  await queue.saveDraft(calendar.id, { text: 'Tomorrow', modelId: 'gpt-6.1-sol-high' }, [], false);
  assert.equal((await queue.getQueue()).find(item => item.id === calendar.id).dispatchTime, deadline);
});

test('switching Antigravity models drops the old reset wait while text-only edits keep it', async t => {
  const { models, seedModels } = require('./model-fixture');
  const { setModelCatalog, setFavoriteModels } = require('../lib/model-catalog');
  const { parseAgyModels } = require('../lib/cli-tools');
  const extra = [...models, ...parseAgyModels('claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)\ngemini-pro-orchestrator-g1-pro\tOrchestrator')];
  setModelCatalog(extra); setFavoriteModels(extra);
  t.after(seedModels);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-agy-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queue = new SchedulerQueue({ workspaceDir: root, sessionDir: path.join(root, 'session') });
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const task = await queue.enqueue({ model: 'gemini', modelId: 'gemini:claude-sonnet-5-5-high', prompt: 'continue', dispatchTrigger: 'quota-reset', notBefore: deadline });
  await queue.saveDraft(task.id, { text: 'continue please', modelId: 'gemini:claude-sonnet-5-5-high' }, [], false);
  assert.equal((await queue.getQueue())[0].notBefore, deadline, 'same Antigravity model keeps reset');
  await queue.saveDraft(task.id, { text: 'continue please', modelId: 'gemini-pro-orchestrator-g1-pro' }, [], false);
  const saved = (await queue.getQueue())[0];
  const { isDue } = require('../lib/scheduler-queue');
  assert.equal(saved.model, 'gemini');
  assert.equal(saved.modelId, 'gemini-pro-orchestrator-g1-pro');
  assert.equal(saved.dispatchTrigger, 'fixed-time');
  assert.equal(saved.notBefore, undefined);
  assert.equal(isDue(saved, Date.now()), true);
  const stuck = await queue.enqueue({ model: 'gemini', modelId: 'gemini-pro-orchestrator-g1-pro', prompt: 'stuck', dispatchTrigger: 'quota-reset', notBefore: deadline });
  await queue.saveDraft(stuck.id, { text: 'stuck', modelId: 'gemini-pro-orchestrator-g1-pro' }, [], false, { clearReset: true });
  const cleared = (await queue.getQueue()).find(item => item.id === stuck.id);
  assert.equal(cleared.dispatchTrigger, 'fixed-time');
  assert.equal(cleared.notBefore, undefined);
});

test('scheduled edits preserve their identity, schedule and pictures without merging', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-edit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = path.join(root, 'qt.png');
  fs.writeFileSync(image, 'picture');
  const queue = new SchedulerQueue({ workspaceDir: root, sessionDir: path.join(root, 'session') });
  const first = await queue.enqueue({ model: 'claude', prompt: 'Qt', dispatchTrigger: 'fixed-time', dispatchTime: '2020-01-01T00:00:00Z' }, [image]);
  const second = await queue.enqueue({ model: 'claude', prompt: 'Other', dispatchTrigger: 'quota-reset' });
  const { isDue } = require('../lib/scheduler-queue');
  await queue.saveDraft(first.id, { text: 'Qt edited' }, [image], true);
  let tasks = await queue.getQueue();
  assert.equal(isDue(tasks[0], Date.now()), false);
  const heldImage = tasks[0].attachments[0].relativePath;
  await queue.saveDraft(first.id, { text: 'Qt final' }, [image], false);
  await queue.saveDraft(second.id, { text: 'Other edit' }, [], true);
  tasks = await queue.getQueue();
  assert.deepEqual(tasks.map(item => item.id), [first.id, second.id]);
  assert.equal(tasks[0].dispatchTime, first.dispatchTime);
  assert.equal(tasks[0].prompt, 'Qt final');
  assert.equal(tasks[0].attachments[0].relativePath, heldImage, 'typing reuses staged files');
  assert.equal(fs.readFileSync(path.resolve(root, heldImage), 'utf8'), 'picture');
  assert.deepEqual(tasks[1].attachments, []);
  assert.equal(isDue(tasks[0], Date.now()), true);
  const reloaded = await new SchedulerQueue({ workspaceDir: root, sessionDir: path.join(root, 'session') }).getQueue();
  assert.equal(reloaded[1].editing, undefined, 'restart clears a stale editor hold');
});

test('a scheduled prompt whose image sits in the queue\'s own folder survives a reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  const workspaceDir = path.join(root, 'workspace');
  const sessionDir = path.join(root, 'session');
  const image = path.join(sessionDir, 'scheduler', 'sched_1', 'attachments', 'shot.png');
  fs.mkdirSync(path.dirname(image), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(image, 'png');
  const task = (id, file) => ({ id, model: 'claude', prompt: 'p', dispatchTrigger: 'quota-reset', status: 'pending', createdAt: new Date().toISOString(), attachments: [{ name: 'shot.png', relativePath: path.relative(workspaceDir, file).split(path.sep).join('/') }] });
  fs.writeFileSync(path.join(sessionDir, 'scheduler-queue.json'), JSON.stringify([task('kept', image), task('gone', path.join(sessionDir, 'scheduler', 'sched_2', 'attachments', 'nope.png')), task('outside', path.join(root, 'elsewhere.png'))]));
  fs.writeFileSync(path.join(root, 'elsewhere.png'), 'png');
  const queue = new SchedulerQueue({ workspaceDir, sessionDir });
  const tasks = await queue.getQueue();
  const status = Object.fromEntries(tasks.map((t) => [t.id, t.status]));
  assert.deepEqual(status, { kept: 'pending', gone: 'attachment-missing', outside: 'attachment-missing' });
});

test('saveDraft applies edited schedule mode and timestamps when finished', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-reschedule-'));
  const queue = new SchedulerQueue({ workspaceDir: root, sessionDir: path.join(root, 'session') });
  const initialTime = new Date(Date.now() + 7200000).toISOString();
  const nextTime = new Date(Date.now() + 3600000).toISOString();
  const task = await queue.enqueue({ model: 'claude', prompt: 'Later', dispatchTrigger: 'fixed-time', dispatchTime: initialTime });
  await queue.saveDraft(task.id, { text: 'Sooner' }, [], true, { schedule: { dispatchTrigger: 'fixed-time', dispatchTime: nextTime } });
  let saved = (await queue.getQueue())[0];
  assert.equal(saved.dispatchTime, initialTime, 'in-progress typing does not mutate the schedule early');
  await queue.saveDraft(task.id, { text: 'Sooner' }, [], false, { schedule: { dispatchTrigger: 'fixed-time', dispatchTime: nextTime } });
  saved = (await queue.getQueue())[0];
  assert.equal(saved.dispatchTrigger, 'fixed-time');
  assert.equal(saved.dispatchTime, nextTime);
  await queue.saveDraft(task.id, { text: 'On weekly reset' }, [], false, { schedule: { dispatchTrigger: 'quota-reset', resetWindow: '7d', notBefore: nextTime } });
  saved = (await queue.getQueue())[0];
  assert.equal(saved.dispatchTrigger, 'quota-reset');
  assert.equal(saved.resetWindow, '7d');
  assert.equal(saved.notBefore, nextTime);
  assert.equal(saved.dispatchTime, undefined);
});

test('a file the OS briefly refuses (EPERM) neither blocks loading nor loses the queue', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-eperm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { workspaceDir: root, sessionDir: path.join(root, 'session') };
  const seed = new SchedulerQueue(options);
  const task = await seed.enqueue({ model: 'claude', chatId: 'chat', dispatchTrigger: 'quota-reset', prompt: 'Survive', notBefore: '2099-01-01T00:00:00.000Z' });
  const refuse = (name, times) => {
    const original = fs.promises[name];
    let left = times;
    fs.promises[name] = async (...args) => { if (left-- > 0) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); return original(...args); };
    t.after(() => { fs.promises[name] = original; });
  };
  refuse('readFile', 2);
  assert.deepEqual((await new SchedulerQueue(options).getQueue()).map(item => item.id), [task.id], 'a read refused twice is retried');
  refuse('rename', 99); // never lets go: the in-place write is the last resort
  await seed.reorder([task.id]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.sessionDir, 'scheduler-queue.json'), 'utf8'))[0].prompt, 'Survive');
  assert.deepEqual(fs.readdirSync(options.sessionDir).filter(name => name.endsWith('.tmp')), [], 'no stray temporary file is left behind');
});
