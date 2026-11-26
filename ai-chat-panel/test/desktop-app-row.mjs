import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const { CliHub } = createRequire(import.meta.url)('../lib/cli-tools.js');
const out = path.resolve('out/ui-review');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  for (const width of [320, 900]) {
    const { page, problems } = await openChat(browser, { width, height: 1400, sidebar: true });
    const deliveries = [];
    let resolveUpdate;
    const hub = new CliHub({ store: { get: () => [] }, promptStore: { get: () => ({}) },
      checkAppsImpl: async () => ({ codex: { name: 'ChatGPT', version: '26.1120.50957', latest: '26.1120.50957', outdated: false } }),
      updateAppImpl: (agent, { onLine }) => new Promise((resolve) => { onLine('Unpacking chatgpt (26.1120.50957)'); resolveUpdate = () => resolve({ ok: true, message: 'Updated to 26.1120.50957. Restart ChatGPT to finish.' }); }),
      beforeUpdate: async () => {}, installedVersionImpl: async () => '0.172.0',
      broadcast: message => deliveries.push(page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message)) });
    hub.versions = { codex: { version: '0.172.0', latest: '0.172.0', outdated: false } };
    hub.apps = { codex: { name: 'ChatGPT', version: '26.1120.41243', latest: '26.1120.50957', outdated: true } };
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings', tab: 'general' } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', clis: { codex: { path: '/home/me/.nvm/bin/codex' } } } }));
    });
    hub.push();
    await Promise.all(deliveries.splice(0));
    const card = page.locator('.cs-provider[data-agent=codex]');
    const button = card.locator('.cs-ractions button', { hasText: 'ChatGPT 26.1120.50957' });
    assert.equal(await button.count(), 1, 'an outdated app gets its own update button');
    assert.equal(await page.locator('#updatesBtn').isHidden(), false, 'the sidebar badge counts the app');
    await card.screenshot({ path: path.join(out, `app-update-before-${width}.png`) });
    const running = hub.updateApp('codex');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.all(deliveries.splice(0));
    assert.match(await card.locator('.cs-progress-line').innerText(), /Unpacking chatgpt/);
    assert.equal(await card.locator('.cs-ractions button:disabled').count(), 1);
    await card.screenshot({ path: path.join(out, `app-update-running-${width}.png`) });
    resolveUpdate();
    await running;
    await Promise.all(deliveries.splice(0));
    assert.match(await card.locator('.cs-update-note.is-ok').innerText(), /Restart ChatGPT/);
    assert.equal(await card.locator('.cs-ractions button').count(), 0);
    await page.waitForTimeout(400);
    assert.deepEqual(problems, []);
    await page.close();
  }
  console.log('A desktop app update shows its own button, progress and restart note at 320px and 900px.');
} finally { await browser.close(); }
