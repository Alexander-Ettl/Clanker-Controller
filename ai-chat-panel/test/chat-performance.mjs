import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
const { historyPage } = createRequire(import.meta.url)('../lib/chat-history');
const { ChatStore } = createRequire(import.meta.url)('../lib/chat-store');

export function historyFixture(turns = 100) {
  return Array.from({ length: turns }, (_, i) => [
    { role: 'user', text: `Review change ${i}. Explain the implementation and check the result.`, at: '2026-03-02T07:00:00Z' },
    { role: 'assistant', text: `Checking change **${i}**.\n\nThe implementation preserves the project's existing behavior.\n\n\`\`\`js\nconst change = ${i};\nconsole.log(change);\n\`\`\`\n\n| Check | Result |\n| --- | --- |\n| Syntax | Passed |\n| Behavior | Passed |\n\nThe change is ready for review.`, agent: 'codex', modelLabel: 'GPT 6.1 Sol Medium', at: '2026-03-02T07:01:00Z' },
    ...Array.from({ length: 4 }, (_, j) => ({ role: 'tool', event: { name: 'Read', file: `C:/project/change-${i}-${j}.js`, toolId: `t-${i}-${j}`, output: 'Verified source line\n'.repeat(30) }, done: true, offset: 22 })),
  ]).flat();
}

const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);

export async function pagedHistory(page) {
  const messages = historyFixture();
  messages.at(-5).inProgress = true;
  delete messages.at(-5).at;
  const running = { agentId: 'codex', modelLabel: 'GPT 6.1 Sol Medium', startedAt: Date.now() };
  await send(page, { type: 'chatLoaded', chat: { id: 'long-history', ...historyPage(messages) }, running });
  await page.clock.runFor(100);
  await page.waitForTimeout(80);
  await page.waitForFunction(() => document.querySelector('#transcript').scrollTop > 320);
  assert.equal(await page.locator('.msg-group-user').count(), 12);
  await page.locator('.msg-pending').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.savedTail = document.querySelector('.turn:last-child'); });
  assert.equal(await page.getByRole('button', { name: 'Show earlier messages', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'requestChatHistory').length), 0, 'opening a long chat must not fetch its older pages');
  await page.locator('#transcript').evaluate(element => { element.scrollTop = 400; });
  await page.clock.runFor(40);
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'requestChatHistory').length), 0, 'fetch only when approaching the top');
  await page.locator('#transcript').evaluate(element => { element.scrollTop = 200; });
  await page.waitForFunction(() => window.sent.some(message => message.type === 'requestChatHistory'));
  const request = await page.evaluate(() => window.sent.findLast(message => message.type === 'requestChatHistory'));
  assert.equal(request.before, historyPage(messages).historyStart);
  await page.locator('#transcript').evaluate(element => { element.scrollTop = 0; });
  await page.clock.runFor(60);
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'requestChatHistory').length), 1, 'only one older page may be in flight');
  // A delta can land while the host is fetching the previous page.
  await send(page, { type: 'delta', model: 'codex', text: '\n\nStill working on the latest change.' });
  const older = historyPage(messages, request.before);
  const position = await page.locator('.msg-group-user').first().evaluate(element => element.getBoundingClientRect().top);
  await send(page, { type: 'chatHistory', chatId: 'long-history', requestId: request.requestId, ...older });
  assert.equal(await page.locator('.msg-group-user').count(), 24);
  assert.equal(await page.evaluate(() => window.savedTail === document.querySelector('.turn:last-child')), true, 'older pages must preserve the live DOM');
  const after = await page.locator(`[data-user-index="${historyPage(messages).historyUserStart}"]`).evaluate(element => element.getBoundingClientRect().top);
  assert.ok(Math.abs(after - position) < 4, `reading position jumped by ${after - position}px`);
  await page.getByText('Still working on the latest change.', { exact: false }).waitFor();
  await page.locator('.msg-pending').waitFor({ state: 'visible' });
  // Absolute indices survive paging; a live send must use the next index after all 100 turns.
  const first = page.locator('.msg-group-user').first();
  await first.getByRole('button', { name: /Revert to here/ }).dispatchEvent('click');
  assert.equal(await page.evaluate(() => window.sent.findLast(message => message.type === 'revertToMessage').index), older.historyUserStart);
  await send(page, { type: 'turn_complete', agent: 'codex' });
  await send(page, { type: 'userMessage', text: 'A new prompt' });
  assert.equal(await page.locator('.msg-group-user').last().getAttribute('data-user-index'), '100');
  await send(page, { type: 'compacting', auto: false });
  await send(page, { type: 'turn_complete', agent: 'codex' });
  await send(page, { type: 'userMessage', text: 'After compaction' });
  assert.equal(await page.locator('.msg-group-user').last().getAttribute('data-user-index'), '102');
  // Navigate away while an older request is pending, then deliver it late.
  await page.clock.runFor(60);
  await page.locator('#transcript').evaluate(element => { element.scrollTop = 180; });
  await page.waitForFunction(() => window.sent.filter(message => message.type === 'requestChatHistory').length === 2);
  const stale = await page.evaluate(() => window.sent.findLast(message => message.type === 'requestChatHistory'));
  await send(page, { type: 'chatLoading' });
  await send(page, { type: 'chatLoaded', chat: { id: 'other', messages: [{ role: 'user', text: 'Another chat' }] } });
  await send(page, { type: 'chatHistory', chatId: 'long-history', requestId: stale.requestId, ...historyPage(messages, stale.before) });
  assert.equal(await page.locator('.msg-group-user').count(), 1);
  // Exhaustion stops loading, even when scrolling to the beginning repeatedly.
  const small = historyFixture(13);
  await send(page, { type: 'chatLoaded', chat: { id: 'small-history', ...historyPage(small) } });
  await page.clock.runFor(100);
  await page.waitForTimeout(80);
  await page.waitForFunction(() => document.querySelector('#transcript').scrollTop > 320);
  await page.locator('#transcript').evaluate(element => { element.scrollTop = 100; });
  await page.waitForFunction(() => window.sent.some(message => message.type === 'requestChatHistory' && message.chatId === 'small-history'));
  const lastPage = await page.evaluate(() => window.sent.findLast(message => message.type === 'requestChatHistory'));
  await send(page, { type: 'chatHistory', chatId: 'small-history', requestId: lastPage.requestId, ...historyPage(small, lastPage.before) });
  await page.locator('#transcript').evaluate(element => { element.scrollTop = 0; });
  await page.clock.runFor(100);
  assert.equal(await page.locator('.msg-group-user').count(), 13);
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'requestChatHistory' && message.chatId === 'small-history').length), 1);
  // Short pages fill the viewport, then stop without fetching the entire history.
  const compact = Array.from({ length: 100 }, () => [
    { role: 'user', compact: true, text: '' }, { role: 'assistant', compact: true, text: '' },
  ]).flat();
  await send(page, { type: 'chatLoaded', chat: { id: 'compact-history', ...historyPage(compact) } });
  await page.clock.runFor(100);
  await page.waitForFunction(() => window.sent.some(message => message.type === 'requestChatHistory' && message.chatId === 'compact-history'));
  const fill = await page.evaluate(() => window.sent.findLast(message => message.type === 'requestChatHistory'));
  await send(page, { type: 'chatHistory', chatId: 'compact-history', requestId: fill.requestId, ...historyPage(compact, fill.before) });
  await page.clock.runFor(100);
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'requestChatHistory' && message.chatId === 'compact-history').length), 1, 'stop filling once the viewport overflows');
  assert.equal(await page.locator('.compact-divider').count(), 24);
  assert.equal(await page.locator('#transcript').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 2), true, 'automatic viewport filling keeps the recent tail visible');
  // Finish the visual scenario at the first loaded turn; scrolling has already requested the next batch.
  await send(page, { type: 'chatLoaded', chat: { id: 'long-history', ...historyPage(messages) } });
  await page.clock.runFor(100);
  await page.waitForTimeout(80);
  await page.locator('#transcript').evaluate(element => { element.scrollTop = 0; });
}

async function benchmark() {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  const results = [];
  try {
    const { page, problems } = await openChat(browser, { width: 900, height: 1000 });
    page.setDefaultTimeout(10000);
    await pagedHistory(page);
    console.log('Paging, live updates, Revert and navigation checks passed.');
    for (const turns of [100, 500]) {
      const messages = historyFixture(turns);
      for (const mode of ['full', 'paged']) {
        console.log(`Measuring ${turns} turns, ${mode} history…`);
        const chat = { id: `${turns}-${mode}`, ...(mode === 'full' ? { messages } : historyPage(messages)) };
        const samples = [];
        for (let i = 0; i < 6; i++) {
          await send(page, { type: 'chatLoaded', chat: { id: 'empty', messages: [] } });
          const sample = await page.evaluate(chat => {
            const start = performance.now();
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat } }));
            return { ms: performance.now() - start, nodes: document.querySelector('#transcript').querySelectorAll('*').length, turns: document.querySelectorAll('.msg-group-user').length };
          }, chat);
          if (i) samples.push(sample.ms);
          await page.clock.runFor(40);
          if (i === 5) results.push({ turns, mode, medianReplayMs: samples.sort((a, b) => a - b)[2], nodes: sample.nodes, renderedTurns: sample.turns, payloadBytes: Buffer.byteLength(JSON.stringify(chat)) });
        }
      }
    }
    assert.deepEqual(problems, []);
    const out = path.resolve('out/chat-performance');
    fs.mkdirSync(out, { recursive: true });
    const summaries = benchmarkSummaries();
    fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify({ note: 'Synthetic Edge webview: same renderer with full history versus paged payload. Median of 5 warm synchronous replays; excludes disk and IDE transport. Summary timings compare new-store scans with repeated cached scans.', results, summaries }, null, 2));
    console.log(JSON.stringify(results, null, 2));
    console.log(JSON.stringify(summaries, null, 2));
  } finally { await browser.close(); }
}

function benchmarkSummaries() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-summary-bench-'));
  try {
    const store = new ChatStore(root), messages = historyFixture(100);
    for (let i = 0; i < 30; i++) store.save({ ...store.create(), messages });
    const median = samples => samples.sort((a, b) => a - b)[2];
    const measure = getStore => Array.from({ length: 5 }, () => {
      const current = getStore(), start = performance.now(); current.list(); return performance.now() - start;
    });
    return { chats: 30, turnsPerChat: 100, coldMedianMs: median(measure(() => new ChatStore(root))), cachedMedianMs: median(measure(() => store)) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await benchmark();
