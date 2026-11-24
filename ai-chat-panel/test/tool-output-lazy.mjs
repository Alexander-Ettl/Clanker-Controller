import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

// Opening a chat ships a preview of each long tool output; the full text comes when the card is opened.
const require = createRequire(import.meta.url);
const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const FULL = Array.from({ length: 400 }, (_, i) => `line ${i} of a long tool output`).join('\n');
const browser = await chromium.launch({ headless: true });
try {
  const { page, problems } = await openChat(browser, { width: 900, height: 1000 });
  const { ChatWindowHost } = require('../extension');
  const stored = [
    { role: 'user', text: 'read it', at: '2026-03-02T07:00:00Z' },
    { role: 'assistant', text: 'Reading.', agent: 'codex', at: '2026-03-02T07:01:00Z' },
    { role: 'tool', event: { name: 'Bash', command: 'cat big.txt', toolId: 't-big', output: FULL }, done: true, offset: 8 },
    { role: 'tool', event: { name: 'Bash', command: 'echo hi', toolId: 't-small', output: 'hi' }, done: true, offset: 8 },
  ];
  const lite = ChatWindowHost.prototype.webviewMessages.call({ webviewFiles: f => f }, stored);
  assert.equal(lite[2].event.outputTruncated, FULL.length, 'the long output is cut and says how long it was');
  assert.ok(lite[2].event.output.length < 2000);
  assert.equal(lite[3].event.output, 'hi', 'a short output is sent whole');
  assert.equal(stored[2].event.output, FULL, 'the stored chat is untouched');
  await send(page, { type: 'chatLoaded', chat: { id: 'c1', messages: lite, historyStart: 0, historyEnd: 4, historyUserStart: 0 }, running: null });
  const card = page.locator('.tool-card', { hasText: 'cat big.txt' });
  await card.waitFor({ state: 'attached' }); // a finished turn is folded, so the card is not visible until opened
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'requestToolOutput').length), 0, 'nothing is fetched while folded');
  await card.evaluate(el => { el.open = true; });
  await page.waitForFunction(() => window.sent.some(m => m.type === 'requestToolOutput'));
  const request = await page.evaluate(() => window.sent.findLast(m => m.type === 'requestToolOutput'));
  assert.deepEqual({ chatId: request.chatId, index: request.index, toolId: request.toolId }, { chatId: 'c1', index: 2, toolId: 't-big' });
  // The host answers from the chat it holds.
  const host = { chat: { id: 'c1', messages: stored }, panel: { webview: { postMessage: m => { host.reply = m; } } } };
  await ChatWindowHost.prototype.handleMessage.call(host, request);
  assert.deepEqual(host.reply, { type: 'toolOutput', chatId: 'c1', index: 2, text: FULL });
  await ChatWindowHost.prototype.handleMessage.call(host, { ...request, toolId: 'someone-else' });
  assert.match(host.reply.error, /no longer available/, 'a changed chat is not answered with the wrong output');
  await send(page, { type: 'toolOutput', chatId: 'c1', index: 2, text: FULL });
  await page.waitForFunction(() => !document.querySelector('.tool-card.is-lazy'));
  assert.match(await card.locator('.tool-body').evaluate(el => el.textContent), /line 399 of a long tool output/, 'the full text replaces the preview');
  assert.equal(await page.locator('.tool-card.is-lazy').count(), 0);
  await card.evaluate(el => { el.open = false; }); await card.evaluate(el => { el.open = true; }); // reopening does not ask again
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'requestToolOutput').length), 1);
  assert.deepEqual(problems, []);
  console.log('Lazy tool output: preview on open, full text on demand, one request per card.');
} finally { await browser.close(); }
