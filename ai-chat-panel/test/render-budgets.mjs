import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);

export async function hiddenDialogs(page) {
  const sessions = Array.from({ length: 212 }, (_, i) => ({ id: `history-${i}`, title: `Review change ${i}`, models: ['codex'], messageCount: 10,
    updatedAt: '2026-03-02T07:00:00Z', lastMessage: { role: 'assistant', agent: 'codex', text: 'Implementation verified and ready for review.' } }));
  await send(page, { type: 'history', sessions });
  assert.equal(await page.locator('.history-card').count(), 0, 'closed history creates no cards');
  await send(page, { type: 'openHistory' });
  assert.equal(await page.locator('.history-card').count(), 212);
  await page.evaluate(() => { window.savedHistoryCard = document.querySelector('.history-card'); });
  await send(page, { type: 'history', sessions });
  assert.equal(await page.evaluate(() => window.savedHistoryCard === document.querySelector('.history-card')), true, 'unchanged cards keep their DOM');
  await page.getByRole('searchbox', { name: 'Search chats' }).fill('change 211');
  assert.equal(await page.locator('.history-card').count(), 1);
  await page.locator('#historyModal .fs-modal-close').click();
  assert.equal(await page.locator('.history-card').count(), 0, 'closing releases hidden DOM');
  sessions.at(-1).title = 'Updated while closed';
  await send(page, { type: 'history', sessions });
  await send(page, { type: 'openHistory' });
  await page.getByRole('searchbox', { name: 'Search chats' }).fill('Updated while closed');
  await page.getByText('Updated while closed', { exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Search chats' }).fill('');
}

async function lazyHighlighting(page) {
  assert.equal(await page.evaluate(() => typeof window.createCodeHighlighter), 'undefined', 'no Shiki initialization on empty chats');
  const theme = { name: 'test-theme', type: 'dark', colors: { 'editor.foreground': '#eeeeee', 'editor.background': '#101114' }, tokenColors: [{ scope: 'keyword', settings: { foreground: '#ff0000' } }] };
  await send(page, { type: 'editorTheme', theme });
  assert.equal(await page.evaluate(() => typeof window.createCodeHighlighter), 'undefined', 'a theme alone does not load Shiki');
  await send(page, { type: 'chatLoaded', chat: { id: 'code', messages: [{ role: 'user', text: 'Code' }, { role: 'assistant', text: '```js\nconst value = 42;\n```', agent: 'codex' }] } });
  await page.clock.runFor(100);
  await page.waitForFunction(() => document.querySelector('.code-block code span[style]'));
  assert.equal(await page.locator('.code-block code').textContent(), 'const value = 42;');
  await send(page, { type: 'editorTheme', theme: { ...theme, tokenColors: [{ scope: 'keyword', settings: { foreground: '#00ff00' } }] } });
  await page.waitForTimeout(100);
  await page.clock.runFor(100);
  await page.waitForFunction(() => [...document.querySelectorAll('.code-block code span')].some(el => el.style.color === 'rgb(0, 255, 0)'));
}

async function highlightBudget(page) {
  await page.evaluate(() => {
    window.tokenizations = 0;
    window.createCodeHighlighter = async () => ({ loadTheme: async () => {}, dispose() {}, codeToTokensBase(code) {
      window.tokenizations++;
      return [[...code].map(content => ({ content, color: '#abcdef' }))];
    } });
  });
  await send(page, { type: 'editorTheme', theme: { tokenColors: [] } });
  const show = async (code, complete = true) => {
    const before = await page.evaluate(() => window.tokenizations);
    await send(page, { type: 'chatLoaded', chat: { id: 'budget', messages: [{ role: 'assistant', text: `\`\`\`js\n${code}${complete ? '\n```' : ''}`, agent: 'codex' }] } });
    await page.clock.runFor(100);
    await page.waitForTimeout(40);
    return (await page.evaluate(() => window.tokenizations)) - before;
  };
  assert.equal(await show('completed'), 1);
  assert.equal(await show('completed'), 0, 'finished blocks reuse highlighting');
  assert.equal(await show('streaming prefix', false), 1);
  assert.equal(await show('streaming prefix', false), 1, 'unfinished prefixes are not cached');
  for (let i = 0; i < 35; i++) await show(`${i}:` + 'x'.repeat(1000));
  assert.equal(await show('completed'), 1, 'byte pressure evicts old entries before reaching the entry-count cap');
}

async function agentBudget(page) {
  await send(page, { type: 'subagent_start', id: 'budget-agent', agent: 'claude', description: 'Inspect cache budgets', subagentType: 'reviewer' });
  for (let i = 0; i < 20; i++) await send(page, { type: 'subagent_event', id: 'budget-agent', event: { type: 'delta', text: `event-${i}:` + 'recent activity '.repeat(2000) } });
  assert.equal(await page.locator('.agents-log').count(), 0, 'closed agent dialog builds no log');
  await page.locator('#agentsBtn').click();
  const text = await page.locator('.agents-log').textContent();
  assert.ok(text.includes('event-19:'));
  assert.ok(!text.includes('event-0:'), 'old activity is evicted by byte pressure');
  assert.ok(text.length * 2 <= 256 * 1024);
  await page.locator('#agentsModal .fs-modal-close').click();
  assert.equal(await page.locator('.agents-log').count(), 0, 'closing releases the materialized log');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  try {
    const first = await openChat(browser, { width: 900, height: 1000 });
    first.page.setDefaultTimeout(10000);
    await hiddenDialogs(first.page);
    await first.page.evaluate(() => { window.savedSearchCard = document.querySelector('.history-card'); });
    await first.page.getByRole('searchbox', { name: 'Search chats' }).fill('change 210');
    await first.page.getByRole('searchbox', { name: 'Search chats' }).fill('');
    assert.equal(await first.page.evaluate(() => window.savedSearchCard === document.querySelector('.history-card')), true, 'clearing a search restores filtered-out cards');
    await first.page.locator('#historyModal .fs-modal-close').click();
    await lazyHighlighting(first.page);
    await agentBudget(first.page);
    assert.deepEqual(first.problems, []);
    const second = await openChat(browser, { width: 900, height: 1000 });
    await highlightBudget(second.page);
    assert.deepEqual(second.problems, []);
    console.log('Hidden dialogs, real lazy highlighting, theme replacement and cache-budget checks passed.');
  } finally { await browser.close(); }
}
