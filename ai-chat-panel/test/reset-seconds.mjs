// Real-page check: a quota reset less than a minute away reads in seconds and counts down, instead of "now".
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const browser = await chromium.launch({ headless: true });
try {
  const { page, problems } = await openChat(browser, { width: 420, height: 800, sidebar: true, realTime: true });
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const label = () => page.evaluate(() => document.querySelector('.model-card-claude .model-card-reset')?.textContent.trim());
  const at = seconds => Date.now() / 1000 + seconds;
  await send({ type: 'quotas', quotas: { claude: { remaining: 0, resetsAt: at(42), secondary: { remaining: 60, resetsAt: at(86400) } } } });
  await page.waitForTimeout(300);
  const first = await label();
  assert.match(first, /^\d{1,2}s$/, `a reset 42 s away reads in seconds, got "${first}"`);
  await page.waitForTimeout(3200);
  const later = await label();
  assert.match(later, /^\d{1,2}s$/);
  assert.ok(parseInt(later) <= parseInt(first) - 1, `it counts down on its own (${first} then ${later})`);
  await send({ type: 'quotas', quotas: { claude: { remaining: 0, resetsAt: at(5400), secondary: { remaining: 60, resetsAt: at(86400) } } } });
  await page.waitForTimeout(300);
  assert.match(await label(), /^1h 30m$|^1h 29m$/, 'a far reset keeps its minutes');
  await send({ type: 'quotas', quotas: { claude: { remaining: 0, resetsAt: at(2), secondary: { remaining: 60, resetsAt: at(86400) } } } });
  await page.waitForFunction(() => document.querySelector('.model-card-claude .model-card-reset')?.textContent.trim() === 'now', null, { timeout: 4000 });
  assert.deepEqual(problems, []);
  console.log('reset-seconds ok');
} finally { await browser.close(); }
