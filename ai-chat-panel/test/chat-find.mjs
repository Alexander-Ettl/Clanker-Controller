// Find in chat, in the real chat page: Ctrl+F, typing, stepping, a match in history the window has not loaded, Esc.
// The host side is the real lib/chat-find.js and historyRange, answered from this script. Run: node ai-chat-panel/test/chat-find.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const require = createRequire(import.meta.url);
const { ChatFind, historyWindow } = require('../lib/chat-find.js');
const { historyPage, historyPageForward } = require('../lib/chat-history.js');

// 60 turns. "kiwi" appears in old turns, middle turns and the loaded tail; "zebra" only in turn 5, far outside the first page.
const messages = [];
for (let turn = 0; turn < 60; turn++) {
  messages.push({ role: 'user', text: turn === 5 ? 'Tell me about the **zebra** crossing.' : `Question ${turn}${turn % 7 === 0 ? ' about kiwi' : ''}?`, at: new Date(Date.UTC(2026, 2, 1, 8, turn)).toISOString() });
  messages.push({ role: 'assistant', agent: 'claude', text: `Answer ${turn}.\n\n${turn % 7 === 0 ? 'A Kiwi is a bird; kiwi is also a fruit.' : 'Nothing special here.'}\n\n${'Filler line for height. '.repeat(12)}` });
}
const finder = new ChatFind();

export async function chatFindCheck(page, { quiet = false, appearance = 'clanker' } = {}) {
  const chat = { id: 'find-chat', modelId: 'claude-sonnet-5-5-high', ...historyPage(messages), messages: historyPage(messages).messages };
  await page.exposeFunction('__findHost', async (message) => {
    let reply = null;
    if (message.type === 'findInChat') reply = { type: 'findResults', chatId: 'find-chat', requestId: message.requestId, turns: finder.find(messages, message.query) };
    if (message.type === 'requestChatHistory') {
      const after = Number.isSafeInteger(message.after) && message.after >= 0 && message.after < message.before ? message.after : 0;
      const range = Number.isSafeInteger(message.fromTurn)
        ? historyWindow(messages, message.fromTurn, after, message.before)
        : message.direction === 'down'
          ? { ...historyPageForward(messages, after, message.before), rangeStart: after, rangeEnd: message.before }
          : { ...historyPage(messages, message.before, after), rangeStart: after, rangeEnd: message.before };
      if (range) reply = { type: 'chatHistory', chatId: 'find-chat', requestId: message.requestId, ...range };
    }
    if (reply) await page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), reply);
  });
  await page.evaluate((chat) => {
    const push = window.sent.push.bind(window.sent);
    window.sent.push = (message) => { push(message); window.__findHost(message); return window.sent.length; };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat } }));
  }, chat);
  await page.waitForTimeout(300);
  const loadedTurns = () => page.locator('.msg-group-user[data-user-index]').count();
  const firstPage = await loadedTurns();
  assert.ok(firstPage < 20, `only the last page is rendered at first (${firstPage} turns)`);

  const state = () => page.evaluate(() => {
    const current = CSS.highlights.get('chat-find-current');
    const range = current ? [...current][0] : null;
    const box = document.getElementById('transcript').getBoundingClientRect();
    const rect = range?.getBoundingClientRect();
    return {
      count: document.querySelector('.chat-find-count').textContent,
      text: range ? range.toString() : null,
      turn: range ? Number(range.startContainer.parentElement.closest('.turn')?.querySelector('.msg-group-user')?.dataset.userIndex) : null,
      visible: Boolean(rect && rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom),
      others: CSS.highlights.get('chat-find')?.size ?? 0,
      gaps: document.querySelectorAll('.history-gap').length,
    };
  });
  const waitVisibleTurn = (expectedTurn) => page.waitForFunction((t) => {
    const c = CSS.highlights.get('chat-find-current');
    const r = c ? [...c][0] : null;
    if (!r) return false;
    const turn = Number(r.startContainer.parentElement.closest('.turn')?.querySelector('.msg-group-user')?.dataset.userIndex);
    const box = document.getElementById('transcript').getBoundingClientRect();
    const rect = r.getBoundingClientRect();
    return turn === t && rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom;
  }, expectedTurn);

  // Clicking the Search button opens the bar with focus in the input, clear of the header; Esc closes it.
  const searchBtn = appearance === 'halo' ? page.locator('.halo-top [data-halo="find"]') : page.locator('#findBtn');
  await searchBtn.click();
  assert.equal(await page.locator('.chat-find').isVisible(), true, 'search button opens find bar');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'chat-find-input');
  const clearOfHeader = await page.evaluate(() => {
    const bar = document.querySelector('.chat-find').getBoundingClientRect();
    const header = document.querySelector('.topbar, .halo-top');
    const h = header?.getBoundingClientRect();
    return !h || h.height === 0 || bar.top >= h.bottom;
  });
  assert.equal(clearOfHeader, true, 'find bar sits below the header buttons without overlapping them');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.chat-find').isVisible(), false);

  // Ctrl+F also opens the bar with the caret in it.
  await page.locator('#promptInput').focus();
  await page.keyboard.press('Control+f');
  assert.equal(await page.locator('.chat-find').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'chat-find-input');

  // Typing: the loaded matches answer at once; the host adds the older ones.
  const started = Date.now();
  await page.keyboard.type('kiwi');
  await page.waitForFunction(() => CSS.highlights.get('chat-find-current')?.size === 1);
  const firstPaintMs = Date.now() - started;
  await page.waitForFunction(() => !/\+|…/.test(document.querySelector('.chat-find-count').textContent));
  let now = await state();
  const hostTurns = finder.find(messages, 'kiwi');
  const total = hostTurns.reduce((sum, [, count]) => sum + count, 0);
  const [lastTurn, lastCount] = hostTurns.at(-1);
  // Searching starts on the page you are looking at: the first match of the latest turn that has one (you are at the bottom).
  assert.equal(now.count, `${total - lastCount + 1} of ${total}`);
  assert.equal(now.turn, lastTurn);
  assert.equal(now.text.toLowerCase(), 'kiwi');
  assert.equal(now.visible, true, 'the match is scrolled into view');
  assert.ok(now.others >= 1, 'other matches nearby are painted too');

  // Stepping: Enter goes forward and wraps to the oldest match; Shift+Enter and the up button go back.
  for (let i = 1; i < lastCount; i++) await page.keyboard.press('Enter');
  assert.equal((await state()).count, `${total} of ${total}`);
  await page.keyboard.press('Enter');
  await waitVisibleTurn(0);
  now = await state();
  assert.equal(now.count, `1 of ${total}`, 'wraps to the oldest match');
  assert.equal(now.turn, 0);
  assert.equal(now.visible, true, 'the oldest match was in history the window had not loaded');
  assert.ok(await page.evaluate(() => window.sent.some((m) => m.type === 'requestChatHistory' && m.fromTurn === 0)), 'loaded from that turn in one request');
  assert.ok(now.gaps >= 1, 'skipped middle turns stay in a lazy gap instead of bloating the DOM');
  const renderedAfterTurn0 = await loadedTurns();
  assert.ok(renderedAfterTurn0 < 30, `only a small window loaded around turn 0 (${renderedAfterTurn0} turns)`);

  // Stepping forward into turn 7 (inside the gap!) loads a small window around turn 7 and splits/shrinks the gap.
  const turn0Count = hostTurns[0][1];
  for (let i = 0; i < turn0Count; i++) await page.keyboard.press('Enter');
  await waitVisibleTurn(7);
  now = await state();
  assert.equal(now.turn, 7);
  assert.equal(now.visible, true);

  // Clicking a remaining gap loads a page on demand without errors.
  const beforeGapClick = await loadedTurns();
  if (await page.locator('.history-gap').count() > 0) {
    await page.locator('.history-gap').first().click();
    await page.waitForFunction((n) => document.querySelectorAll('.msg-group-user[data-user-index]').length > n, beforeGapClick);
  }

  // Stepping back from match 1 wraps to the newest match, and the prev button steps back one more.
  await page.locator('.chat-find-input').focus();
  for (let i = 0; i < turn0Count; i++) await page.keyboard.press('Shift+Enter');
  await waitVisibleTurn(0);
  await page.keyboard.press('Shift+Enter');
  await waitVisibleTurn(lastTurn);
  assert.equal((await state()).count, `${total} of ${total}`);
  await page.locator('.chat-find [data-find="prev"]').click();
  now = await state();
  assert.equal(now.count, `${total - 1} of ${total}`);
  assert.equal(now.text.toLowerCase(), 'kiwi');
  assert.equal(now.visible, true);

  // A word only in history that was never sent to the window: fetched as a small window in one request, then shown.
  // The chat opens again first, so only its last page is on screen (the bar stays open and searches it anew).
  await page.evaluate((chat) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat } })), chat);
  await page.waitForTimeout(200);
  assert.equal(await loadedTurns(), firstPage);
  const before = (await page.evaluate(() => window.sent.filter((m) => m.type === 'requestChatHistory').length));
  await page.locator('.chat-find-input').fill('zebra');
  await waitVisibleTurn(5);
  now = await state();
  assert.equal(now.count, '1 of 1');
  assert.equal(now.turn, 5);
  assert.equal(now.visible, true, 'the far match is on screen after the load');
  const requests = await page.evaluate(() => window.sent.filter((m) => m.type === 'requestChatHistory'));
  assert.equal(requests.length - before, 1, `exactly one windowed load for the far match (${requests.length - before})`);
  assert.ok(requests.some((m) => m.fromTurn === 5));
  assert.ok(await loadedTurns() < 30, 'far match did not render the entire chat');

  // Nothing found says so; Esc closes and clears every highlight.
  await page.locator('.chat-find-input').fill('no such phrase anywhere');
  await page.waitForFunction(() => document.querySelector('.chat-find-count').textContent === 'No results');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.chat-find').isVisible(), false);
  assert.equal(await page.evaluate(() => (CSS.highlights.get('chat-find')?.size ?? 0) + (CSS.highlights.get('chat-find-current')?.size ?? 0)), 0);
  if (!quiet) console.log(`Find in chat (${appearance}): button + Ctrl+F, ${total} matches across loaded and gapped turns, stepping/wrap/gap-split, far match in 1 window request, Esc clears. First highlight ${firstPaintMs} ms.`);
  return { firstPaintMs };
}

const direct = import.meta.url === `file://${process.argv[1]}`;
if (direct) {
  const browser = await chromium.launch();
  try {
    for (const appearance of ['clanker', 'halo']) {
      process.env.CLANKER_UI_APPEARANCE = appearance;
      const { page, problems } = await openChat(browser, { width: 420, height: 860, sidebar: appearance === 'halo' });
      await chatFindCheck(page, { appearance });
      assert.deepEqual(problems, []);
      await page.close();
    }
  } finally { await browser.close(); }
}
