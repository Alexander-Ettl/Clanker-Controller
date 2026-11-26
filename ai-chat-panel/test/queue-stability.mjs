import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

export async function queueStability(page) {
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const turns = [
    { id: 'agenda', text: 'Create an agenda to review together.', modelId: 'claude-sonnet-5-5-high', attachments: [], files: [] },
    { id: 'translate', text: 'Translate the complete site into English.', modelId: 'claude-sonnet-5-5-high', attachments: [], files: [] },
    { id: 'verify', text: 'Verify the translated pages.', modelId: 'auto', attachments: [], files: [] },
  ];
  await send({ type: 'chatLoaded', chat: { id: 'queue-stability', messages: [{ role: 'user', text: 'Work on the site.' }], turnQueue: { turns, paused: true } }, running: { agentId: 'claude', startedAt: Date.now() } });
  await page.waitForTimeout(700); // CSS animation time is independent of the fake host's clock.
  await page.waitForFunction(() => !document.querySelector('.turn-queue-item.is-entering'));
  await page.evaluate(() => {
    const strip = document.querySelector('.turn-queue-strip');
    window.queueRows = new Map([...strip.querySelectorAll('.turn-queue-item')].map(row => [row.dataset.id, row]));
    window.queueTransport = strip.querySelector('.queue-transport');
    window.queueRestarts = 0;
    window.queueMutations = 0;
    window.queueObserver = new MutationObserver(records => { window.queueMutations += records.length; });
    window.queueObserver.observe(strip, { childList: true, subtree: true, attributes: true, characterData: true });
    strip.addEventListener('animationstart', event => { if (event.target.matches('.turn-queue-item')) window.queueRestarts++; });
  });
  for (let i = 0; i < 5; i++) {
    await send({ type: 'turnQueue', chatId: 'queue-stability', turns: structuredClone(turns), paused: true });
    await send({ type: 'schedulerQueue', queue: [{ id: 'another-chat-task', chatId: 'other', status: 'pending', prompt: `Unrelated update ${i}` }] });
  }
  assert.equal(await page.evaluate(() => [...window.queueRows].every(([id, row]) => document.querySelector(`[data-id="${id}"]`) === row)), true, 'host echoes must preserve existing queue rows');
  assert.equal(await page.evaluate(() => window.queueTransport === document.querySelector('.queue-transport')), true, 'transport focus must survive refresh');
  assert.equal(await page.evaluate(() => window.queueMutations), 0, 'unchanged host snapshots must not mutate the queue DOM');
  await page.evaluate(() => window.queueObserver.disconnect());
  const input = page.locator('#promptInput');
  await input.fill('Unsent composer draft');
  await page.locator('[data-id="agenda"]').getByRole('button', { name: 'Move back into the composer' }).click();
  for (let i = 0; i < 5; i++) {
    await input.fill(`Create an agenda, revision ${i}`);
    const edit = await page.evaluate(() => window.sent.findLast(item => item.type === 'editQueuedTurn'));
    Object.assign(turns[0], edit.turn, { editing: true });
    await send({ type: 'turnQueue', chatId: 'queue-stability', turns: structuredClone(turns), paused: true });
    await send({ type: 'schedulerQueue', queue: [] });
  }
  assert.equal(await page.evaluate(() => ['translate', 'verify'].every(id => window.queueRows.get(id) === document.querySelector(`[data-id="${id}"]`))), true, 'editing one prompt must preserve its siblings');
  await page.clock.runFor(60);
  assert.equal(await page.evaluate(() => window.queueRestarts), 0, 'existing rows must not repeatedly restart fade-in animations');
  await input.press('Enter');
  assert.equal(await input.inputValue(), 'Unsent composer draft');
  const finished = await page.evaluate(() => window.sent.findLast(item => item.type === 'editQueuedTurn'));
  Object.assign(turns[0], finished.turn, { editing: false });
  await send({ type: 'turnQueue', chatId: 'queue-stability', turns, paused: true });
  // Updating an existing row must preserve both the row and its buttons, while callbacks use the latest snapshot.
  await page.evaluate(() => { window.translateEdit = document.querySelector('[data-id="translate"] button[aria-label="Move back into the composer"]'); });
  turns[1].text = 'Updated by another window';
  turns[1].modelId = 'auto';
  turns[1].files = [{ path: '/attachments/review.txt', name: 'review.txt', mime: 'text/plain' }];
  await send({ type: 'turnQueue', chatId: 'queue-stability', turns: structuredClone(turns), paused: true });
  assert.equal(await page.evaluate(() => window.translateEdit === document.querySelector('[data-id="translate"] button[aria-label="Move back into the composer"]')), true);
  assert.equal(await page.locator('[data-id="translate"] .turn-queue-files').textContent(), '1 file');
  await page.locator('[data-id="translate"]').getByRole('button', { name: 'Move back into the composer' }).click();
  assert.equal(await input.inputValue(), 'Updated by another window');
  await input.press('Enter');
  const task = { id: 'scheduled', chatId: 'queue-stability', model: 'claude', prompt: 'A scheduled follow-up', status: 'pending', dispatchTrigger: 'quota-reset', attachments: [] };
  await send({ type: 'schedulerQueue', queue: [task] });
  await page.evaluate(() => { window.scheduledRow = document.querySelector('[data-task-id="scheduled"]'); });
  task.prompt = 'Updated scheduled follow-up';
  await send({ type: 'schedulerQueue', queue: [task] });
  assert.equal(await page.evaluate(() => window.scheduledRow === document.querySelector('[data-task-id="scheduled"]')), true);
  assert.equal(await page.locator('[data-task-id="scheduled"] .turn-queue-text').textContent(), task.prompt);
  // The scheduled row stays outside ordinary queue drag positions, and host echoes must not break pointer capture.
  await send({ type: 'turnQueue', chatId: 'queue-stability', turns, paused: true });
  await page.waitForTimeout(400);
  const grip = page.locator('[data-id="agenda"] .turn-queue-text');
  const from = await grip.boundingBox(), to = await page.locator('[data-id="verify"] .turn-queue-text').boundingBox();
  const restarts = await page.evaluate(() => window.queueRestarts);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 2 }); // the row lifts after a few pixels, a plain click does not
  turns[2].text = 'Updated while dragging';
  await send({ type: 'turnQueue', chatId: 'queue-stability', turns: structuredClone(turns), paused: true });
  await send({ type: 'schedulerQueue', queue: [task] });
  assert.equal(await page.locator('[data-id="agenda"].is-dragging').count(), 1);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(item => item.type === 'reorderQueuedTurns').ids), ['translate', 'verify', 'agenda']);
  assert.equal(await page.locator('[data-id="verify"] .turn-queue-text').textContent(), 'Updated while dragging');
  assert.equal(await page.locator('.is-dragging').count(), 0);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.queueRestarts), restarts, 'finishing a drag must not restart entrance animations');
  // Deleting a row after a snapshot replacement must act on the current item by ID.
  await page.locator('[data-id="verify"]').getByRole('button', { name: 'Delete', exact: true }).click();
  assert.equal(await page.locator('[data-id="verify"]').count(), 0);
  await send({ type: 'schedulerQueue', queue: [] });
  const many = [...turns, ...Array.from({ length: 8 }, (_, i) => ({ id: 'extra-' + i, text: 'Additional queued task ' + i, modelId: 'auto', files: [], attachments: [] }))];
  await send({ type: 'turnQueue', chatId: 'queue-stability', turns: many, paused: true });
  const scrollTop = await page.locator('.turn-queue-strip').evaluate(strip => { strip.scrollTop = 60; return strip.scrollTop; });
  await send({ type: 'turnQueue', chatId: 'queue-stability', turns: structuredClone(many), paused: true });
  assert.equal(await page.locator('.turn-queue-strip').evaluate(strip => strip.scrollTop), scrollTop, 'host echoes must preserve the queue scroll position');
  // Numbers, arrows and the fixed two-line row. extra-0 .. extra-7 follow translate (agenda is gone; verify was deleted).
  const order = () => page.locator('.turn-queue-item').evaluateAll(rows => rows.map(row => row.dataset.id));
  const numbers = () => page.locator('.turn-queue-num').allTextContents();
  const ids = await order();
  assert.deepEqual(await numbers(), ids.map((_, i) => `#${i + 1}`), 'rows show their place in the send order');
  const rows = page.locator('.turn-queue-item');
  assert.equal(await rows.first().locator('.is-up').isVisible(), false, 'the first row cannot go up');
  assert.equal(await rows.last().locator('.is-down').isVisible(), false, 'the last row cannot go down');
  assert.equal(await rows.nth(1).locator('.is-up').isVisible() && await rows.nth(1).locator('.is-down').isVisible(), true);
  assert.deepEqual(await rows.first().locator('.turn-queue-actions button').evaluateAll(b => b.map(x => x.getAttribute('aria-label'))), ['Delete', 'Move back into the composer', 'Send Now'], 'send sits at the right edge, then edit, then delete');
  assert.equal(await rows.first().locator('.turn-queue-files img').count(), 0);
  const heights = await rows.evaluateAll(list => new Set(list.map(row => Math.round(row.getBoundingClientRect().height))).size);
  assert.equal(heights, 1, 'every prompt is the same two-line height');
  await rows.nth(1).locator('.is-up').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await order(), [ids[1], ids[0], ...ids.slice(2)], 'the up arrow moves a prompt one place earlier');
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(item => item.type === 'reorderQueuedTurns').ids.slice(0, 2)), [ids[1], ids[0]]);
  await rows.first().locator('.is-down').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await order(), ids, 'the down arrow moves it back');
  assert.deepEqual(await numbers(), ids.map((_, i) => `#${i + 1}`));
  // Finish with the same two-row dock as the attached screenshot, settled after its single entrance animation.
  await send({ type: 'turnQueue', chatId: 'queue-stability', turns: turns.slice(0, 2), paused: false });
  await input.fill('');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(700);
}

/** A paused chat whose only due prompts live in the scheduler (turnQueue empty) still shows the Play button and lets the user resume. */
async function dueScheduledTransport(page) {
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const now = await page.evaluate(() => Date.now());
  const past = new Date(now - 60000).toISOString();
  const soon = new Date(now + 2500).toISOString();
  await send({ type: 'chatLoaded', chat: { id: 'queue-due-only', messages: [{ role: 'user', text: 'Earlier task.' }], turnQueue: { turns: [], paused: true } }, running: null });
  await send({ type: 'schedulerQueue', queue: [
    { id: 'due-1', chatId: 'queue-due-only', model: 'claude', modelId: 'claude-opus-5-5-high', prompt: 'continue', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: past, attachments: [] },
    { id: 'due-2', chatId: 'queue-due-only', model: 'claude', modelId: 'claude-opus-5-5-high', prompt: 'Follow up', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: past, attachments: [] },
  ] });
  assert.equal(await page.locator('.turn-queue-head > span').textContent(), '2 queued · paused');
  const transport = page.locator('.turn-queue-head > .queue-transport');
  assert.equal(await transport.isVisible(), true, 'Play button must be visible when due scheduled prompts are paused');
  assert.equal(await transport.getAttribute('aria-label'), 'Resume queue');
  await transport.click();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(item => item.type === 'pauseTurnQueue')), { type: 'pauseTurnQueue', chatId: 'queue-due-only', paused: false });

  // When a waiting scheduled prompt becomes due on the live countdown tick, the transport button appears without a new host snapshot.
  await send({ type: 'turnQueue', chatId: 'queue-due-only', turns: [], paused: true });
  await send({ type: 'schedulerQueue', queue: [
    { id: 'soon-1', chatId: 'queue-due-only', model: 'claude', modelId: 'claude-opus-5-5-high', prompt: 'Wait a moment', status: 'pending', dispatchTrigger: 'fixed-time', dispatchTime: soon, attachments: [] },
  ] });
  assert.equal(await transport.isVisible(), false, 'future scheduled prompt alone needs no play/pause button yet');
  await page.clock.runFor(3500);
  assert.equal(await page.locator('.turn-queue-head > span').textContent(), '1 queued · paused');
  assert.equal(await transport.isVisible(), true, 'Play button appears automatically as soon as the countdown reaches zero');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  try {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const { page, problems } = await openChat(browser, { width: 900, height: 900 });
      await page.emulateMedia({ reducedMotion });
      await queueStability(page);
      await dueScheduledTransport(page);
      assert.deepEqual(problems, []);
      await page.close();
    }
    console.log('Queue stability: repeated host snapshots, editing, sibling rows, animations, current callbacks, scheduled updates and due-scheduled play/pause passed.');
  } finally { await browser.close(); }
}
