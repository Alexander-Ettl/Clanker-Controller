'use strict';

// A prompt that repeats (`/loop 5m <prompt>`): every finished run leaves the next one, bounded by a run limit and an expiry,
// and cancelling the waiting one (or `/loop stop`) ends it. Real queue on a temp folder; no CLI, no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SchedulerQueue, normalizeRecurrence } = require('../lib/scheduler-queue.js');
require('./model-fixture').seedModels();

const queue = () => new SchedulerQueue({ workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sched-rec-')), sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sched-rec-session-')) });
const task = (extra = {}) => ({ model: 'claude', prompt: 'check the build', chatId: 'chat-1', dispatchTrigger: 'fixed-time', dispatchTime: new Date().toISOString(), recurrence: { everyMinutes: 5, maxRuns: 3 }, ...extra });
const live = async (q) => (await q.getQueue()).filter((item) => item.status === 'pending');

test('normalizeRecurrence bounds the interval, the runs and the expiry', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(normalizeRecurrence(undefined, now), null);
  assert.deepEqual(normalizeRecurrence({ everyMinutes: 5 }, now), { everyMinutes: 5, maxRuns: 24, expiresAt: '2026-01-08T00:00:00.000Z', run: 1 });
  assert.throws(() => normalizeRecurrence({ everyMinutes: 0.5 }, now), /interval of 1 to 1440/);
  assert.throws(() => normalizeRecurrence({ everyMinutes: 5000 }, now), /interval/);
  assert.throws(() => normalizeRecurrence({ everyMinutes: 5, maxRuns: 0 }, now), /1 to 500 times/);
  assert.throws(() => normalizeRecurrence({ everyMinutes: 5, expiresAt: '2025-01-01T00:00:00Z' }, now), /future/);
});

test('a finished run leaves the next one an interval later, up to the run limit', async () => {
  const q = queue();
  const first = await q.enqueue(task());
  assert.equal(first.recurrence.run, 1);
  const before = Date.now();
  await q.markDispatched(first.id);
  await q.markCompleted(first.id, 'ok');
  let waiting = await live(q);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].recurrence.run, 2);
  assert.notEqual(waiting[0].id, first.id);
  assert.equal(waiting[0].prompt, 'check the build');
  assert.equal(waiting[0].chatId, 'chat-1');
  const delay = Date.parse(waiting[0].dispatchTime) - before;
  assert.ok(delay >= 5 * 60000 - 50 && delay < 5 * 60000 + 5000, `next run in about 5 minutes, got ${delay} ms`);
  await q.markCompleted(waiting[0].id);
  waiting = await live(q);
  assert.equal(waiting[0].recurrence.run, 3);
  await q.markCompleted(waiting[0].id);
  assert.equal((await live(q)).length, 0, 'the third run was the last');
  const all = await q.getQueue();
  assert.equal(all.find((item) => item.recurrence.run === 3).recurrence.ended, 'ran 3 times');
});

test('a run that would start after the expiry is the last', async () => {
  const q = queue();
  const saved = await q.enqueue(task({ recurrence: { everyMinutes: 60, maxRuns: 50, expiresAt: new Date(Date.now() + 30 * 60000).toISOString() } }));
  await q.markCompleted(saved.id);
  assert.equal((await live(q)).length, 0);
  assert.equal((await q.getQueue())[0].recurrence.ended, 'reached its expiry');
});

test('cancelling the waiting run ends the loop', async () => {
  const q = queue();
  const saved = await q.enqueue(task());
  await q.markCompleted(saved.id);
  const [next] = await live(q);
  await q.dequeue(next.id);
  assert.equal((await live(q)).length, 0);
});

test('/loop stop cancels the chat\'s waiting repeats and a run in flight leaves no next one', async () => {
  const q = queue();
  const mine = await q.enqueue(task());
  const other = await q.enqueue(task({ chatId: 'chat-2' }));
  const plain = await q.enqueue({ model: 'claude', prompt: 'one shot', chatId: 'chat-1', dispatchTrigger: 'fixed-time', dispatchTime: new Date().toISOString() });
  await q.markDispatched(mine.id);
  assert.equal(await q.stopRepeating('chat-1'), 1);
  await q.markCompleted(mine.id);
  const ids = (await live(q)).map((item) => item.id).sort();
  assert.deepEqual(ids, [other.id, plain.id].sort(), 'only chat-1\'s repeat went; its plain prompt and the other chat stay');
  assert.equal((await q.getQueue()).find((item) => item.id === mine.id).recurrence.ended, 'was stopped');
  const waiting = await q.enqueue(task());
  assert.equal(await q.stopRepeating('chat-1'), 1);
  assert.equal((await q.getQueue()).find((item) => item.id === waiting.id).status, 'cancelled');
});

test('a repeating prompt needs a clock and no attachments', async () => {
  const q = queue();
  await assert.rejects(q.enqueue(task({ dispatchTrigger: 'quota-reset', dispatchTime: undefined })), /on a clock/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'att-')), 'a.txt');
  fs.writeFileSync(file, 'x');
  await assert.rejects(q.enqueue(task(), [file]), /attachments/);
  await assert.rejects(q.enqueue(task({ recurrence: { everyMinutes: 0 } })), /interval/);
});

test('the repeat survives a restart', async () => {
  const q = queue();
  const saved = await q.enqueue(task());
  await q.markCompleted(saved.id);
  const again = new SchedulerQueue({ workspaceDir: q.workspaceDir, sessionDir: q.sessionDir });
  const [next] = await live(again);
  assert.equal(next.recurrence.run, 2);
});
