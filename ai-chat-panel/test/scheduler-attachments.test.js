'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SchedulerQueue } = require('../lib/scheduler-queue.js');

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
