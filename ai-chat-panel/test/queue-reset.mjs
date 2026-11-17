import assert from 'node:assert/strict';

// Exercise the saved deadline against a provider whose next window resets much later.
export async function queueReset(page) {
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const now = await page.evaluate(() => Date.now());
  const task = { id: 'reset-task', chatId: 'reset-chat', model: 'claude', modelId: 'claude-sonnet-5-5-high', prompt: 'Finish the interrupted work', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: new Date(now + 5000).toISOString(), attachments: [] };
  const turns = [{ id: 'next-task', modelId: task.modelId, text: 'Build the next feature', attachments: [] }];
  await send({ type: 'chatLoaded', chat: { id: task.chatId, modelId: task.modelId, messages: [], turnQueue: { turns, paused: true } } });
  await send({ type: 'quotas', quotas: { claude: { remaining: 100, resetsAt: now / 1000 + 14400 } } });
  await send({ type: 'schedulerQueue', queue: [task] });
  const scheduled = page.locator('.turn-queue-item.is-scheduled');
  const next = page.locator('.turn-queue-item[data-id="next-task"]');
  assert.equal(await scheduled.getByRole('button', { name: 'Send Now' }).isDisabled(), true);
  assert.equal(await next.getByRole('button', { name: 'Steer Now' }).isDisabled(), true);
  assert.match(await scheduled.locator('.turn-queue-when').innerText(), /^at reset · [0-5]s$/);
  await page.clock.fastForward(6500);
  assert.equal(await scheduled.locator('.turn-queue-when').isVisible(), false, 'a due prompt is just queued: no time and no "ready" label');
  assert.doesNotMatch(await page.locator('.turn-queue-head > span').innerText(), /ready/);
  assert.match(await page.locator('.turn-queue-head > span').innerText(), /2 queued/, 'a due scheduled prompt counts as queued');
  assert.equal(await page.locator('.schedule-time').innerText(), '', 'an elapsed saved reset does not leave a stale composer countdown');
  assert.equal(await scheduled.getByRole('button', { name: 'Send Now' }).isEnabled(), true);
  assert.equal(await next.getByRole('button', { name: 'Steer Now' }).isEnabled(), true);
  // A fresh quota reading can still say there is no capacity after the timestamp.
  await send({ type: 'quotas', quotas: { claude: { remaining: 0, resetsAt: now / 1000 + 14400 } } });
  assert.equal(await scheduled.getByRole('button', { name: 'Send Now' }).isDisabled(), true);
  assert.equal(await next.getByRole('button', { name: 'Steer Now' }).isDisabled(), true);
  assert.equal(await scheduled.locator('.turn-queue-when').innerText(), 'waiting for usage');
  await send({ type: 'quotas', quotas: { claude: { remaining: 100, resetsAt: now / 1000 + 14400 } } });
  assert.equal(await scheduled.locator('.turn-queue-when').isVisible(), false);
}
