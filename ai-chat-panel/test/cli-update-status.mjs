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
    const hub = new CliHub({ store: { get: () => [] }, promptStore: { get: () => ({}) },
      installedVersionImpl: async () => '1.4.3',
      broadcast: message => deliveries.push(page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message)) });
    hub.versions = { gemini: { version: '1.4.2', latest: '1.4.3', outdated: true } };
    hub.notes.gemini = { ok: false, text: 'Error: update already in progress' };
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings', tab: 'general' } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', clis: { gemini: { path: 'C:/agy/agy.exe' } } } }));
    });
    hub.push();
    await Promise.all(deliveries.splice(0));
    const card = page.locator('.cs-provider[data-agent=gemini]');
    assert.equal(await card.locator('.cs-ver').innerText(), 'v1.4.2');
    assert.match(await card.locator('.cs-update-note').innerText(), /already in progress/);
    assert.equal(await page.locator('#updatesBtn').isHidden(), false);
    await card.screenshot({ path: path.join(out, `agy-update-before-${width}.png`) });
    await hub.refreshInstalled();
    await Promise.all(deliveries.splice(0));
    assert.equal(await card.locator('.cs-ver').innerText(), 'v1.4.3');
    assert.equal(await card.locator('.cs-update-note.is-error').count(), 0);
    assert.equal(await card.locator('.cs-state').innerText(), 'Up to date');
    assert.equal(await card.locator('.cs-ractions button').count(), 0);
    assert.equal(await page.locator('#updatesBtn').isHidden(), true, 'sidebar badge follows the same live status');
    await card.screenshot({ path: path.join(out, `agy-update-after-${width}.png`) });
    assert.deepEqual(problems, []);
    await page.close();
  }
  console.log('External agy update refreshed Settings and hid the sidebar update button without a reload at 320px and 900px.');
} finally { await browser.close(); }
