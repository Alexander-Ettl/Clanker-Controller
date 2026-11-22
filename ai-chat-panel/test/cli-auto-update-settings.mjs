import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const out = path.resolve('out/ui-review');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  for (const width of [320, 900]) {
    const { page, problems } = await openChat(browser, { width, height: 1400 });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings', tab: 'general' } })));
    const toggle = page.getByRole('switch', { name: 'Automatically update idle CLIs', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.type === 'setAutoUpdateClis').at(-1)), { type: 'setAutoUpdateClis', enabled: false });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', services: { autoUpdateClis: true } } })));
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'host synchronizes the persisted setting');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', services: { autoUpdateClis: false } } })));
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.type === 'setAutoUpdateClis').at(-1)), { type: 'setAutoUpdateClis', enabled: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await toggle.locator('..').screenshot({ path: path.join(out, `auto-update-${width}.png`) });
    await page.emulateMedia({ colorScheme: 'light' });
    await toggle.locator('..').screenshot({ path: path.join(out, `auto-update-${width}-light.png`) });
    assert.deepEqual(problems, []);
    await page.close();
  }
  const { page, problems } = await openChat(browser, { width: 900, height: 900 });
  await page.locator('#promptInput').fill('Draft for the selected provider');
  assert.ok(await page.evaluate(() => window.sent.some(message => message.type === 'composerActivity')));
  assert.deepEqual(problems, []);
  await page.close();
  console.log('Auto-update toggle and composer activity passed at 320px and 900px.');
} finally { await browser.close(); }
