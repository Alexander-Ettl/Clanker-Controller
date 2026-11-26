// Real-page check: while a start waits on the model list, usage, a CLI update or memory, the page says so above the composer,
// says the prompt goes out by itself, shows a moving bar and an elapsed time, and takes it all away when the wait ends.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const browser = await chromium.launch({ headless: true });
try {
  const { page, problems } = await openChat(browser, { width: 760, height: 700, realTime: true });
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const state = () => page.evaluate(() => { const e = document.querySelector('.start-wait'); const bar = e.querySelector('.start-wait-bar'); const row = document.querySelector('.compose-row');
    return { hidden: e.hidden, height: e.getBoundingClientRect().height, text: e.innerText.replace(/\s+/g, ' ').trim(), barAnimated: getComputedStyle(bar.querySelector('i')).animationName, stage: e.dataset.stage,
      order: [...row.children].filter(c => c.matches('.turn-queue-strip, .start-wait, .composer')).map(c => c.className.split(' ')[0]).join('>'), rowH: row.getBoundingClientRect().height }; });
  await send({ type: 'chatLoaded', chat: { id: 'wait-a', messages: [{ role: 'user', text: 'Hello' }, { role: 'assistant', agent: 'claude', text: 'Hi.' }],
    turnQueue: { turns: [{ id: 'q0', text: 'Sent when ready', modelId: 'claude-sonnet-5-5-high', attachments: [] }], paused: false } }, running: { agentId: 'claude', startedAt: Date.now() } });
  await page.waitForTimeout(900);
  assert.equal((await state()).hidden, true, 'nothing is announced until the host says a start is waiting');

  await send({ type: 'startWaiting', chatId: 'wait-a', stage: 'update', label: 'Updating Claude Code…', since: Date.now() - 5000 });
  await page.waitForTimeout(500);
  let now = await state();
  assert.equal(now.hidden, false);
  assert.match(now.text, /Getting ready/);
  assert.match(now.text, /Updating Claude Code/);
  assert.match(now.text, /queued prompts send as soon as this finishes/i, 'it says the prompt goes out by itself');
  assert.match(now.text, /\b[5-9] s\b/, 'the elapsed time shows once the wait is long');
  assert.notEqual(now.barAnimated, 'none', 'the bar moves');
  assert.equal(now.order, 'turn-queue-strip>start-wait>composer', 'it sits between the queue and the composer');
  assert.ok(now.height > 40, 'it has real height');

  // The next stage replaces the text; a clear followed at once by another stage does not flash the bud away.
  await send({ type: 'startWaiting', chatId: 'wait-a', stage: null });
  await send({ type: 'startWaiting', chatId: 'wait-a', stage: 'usage', label: 'Checking usage…', since: Date.now() });
  await page.waitForTimeout(450);
  now = await state();
  assert.equal(now.hidden, false, 'a following stage keeps the bud up');
  assert.match(now.text, /Checking usage/);
  assert.equal(now.stage, 'usage');

  // A wait for another chat is not this chat's wait.
  await send({ type: 'startWaiting', chatId: 'some-other-chat', stage: 'memory', label: 'Waiting for free memory…' });
  await page.waitForTimeout(150);
  assert.match((await state()).text, /Checking usage/, 'another chat\'s wait changes nothing here');

  // A determinate wait shows its progress.
  await send({ type: 'startWaiting', chatId: 'wait-a', stage: 'update', label: 'Updating Codex…', progress: 0.4, since: Date.now() });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.querySelector('.start-wait-bar').getAttribute('aria-valuenow')), '40');

  // The end of the wait takes the bud away.
  await send({ type: 'startWaiting', chatId: 'wait-a', stage: null });
  await page.waitForFunction(() => document.querySelector('.start-wait').hidden, null, { timeout: 3000 });

  // Switching chats while it is up clears it.
  await send({ type: 'startWaiting', chatId: 'wait-a', stage: 'models', label: 'Loading models…', since: Date.now() });
  await page.waitForTimeout(400);
  assert.equal((await state()).hidden, false);
  await send({ type: 'chatLoaded', chat: { id: 'wait-b', messages: [{ role: 'user', text: 'Another chat' }] } });
  await page.waitForTimeout(200);
  assert.equal((await state()).hidden, true, 'a different chat does not inherit the wait');
  assert.deepEqual(problems, [], 'no page errors');
  console.log('start-waiting ok');
} finally { await browser.close(); }
