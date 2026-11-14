import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

// The rail's update button while a CLI updates: circulating arrow, hover pill with progress, then "Update is done".
const { CliHub } = createRequire(import.meta.url)('../lib/cli-tools.js');
const out = path.resolve('out/ui-review');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  for (const width of [320, 900]) {
    const { page, problems } = await openChat(browser, { width, height: 900, sidebar: true });
    const deliveries = [];
    const finishers = [];
    const hub = new CliHub({ store: { get: () => [] }, promptStore: { get: () => ({}) },
      updateCliImpl: () => new Promise(resolve => { finishers.push(resolve); }),
      installedVersionImpl: async () => '2.1.6', releaseStatusImpl: async () => ({ latest: '2.1.6', error: null }),
      broadcast: message => deliveries.push(page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message)) });
    const settle = () => Promise.all(deliveries.splice(0));
    const button = page.locator('#updatesBtn');
    const shot = name => page.screenshot({ path: path.join(out, `update-${name}-${width}.png`), clip: { x: Math.max(0, width - 400), y: 0, width: Math.min(width, 400), height: 420 } });

    hub.versions = { claude: { version: '2.1.5', latest: '2.1.6', outdated: true }, codex: { version: '0.9.0', latest: '0.9.1', outdated: true } };
    hub.push(); await settle();
    assert.equal(await button.isHidden(), false);
    assert.equal(await button.evaluate(el => el.className.includes('is-updating')), false);
    await shot('1-available');

    await page.clock.setSystemTime(Date.now()); // the harness pins the page to March 2026; the host stamps real time
    const claude = hub.update('claude', { background: true });
    const codex = hub.update('codex', { background: true });
    await new Promise(resolve => setTimeout(resolve, 50)); await settle();
    assert.match(await button.getAttribute('class'), /is-updating/);
    assert.notEqual(await page.locator('.upd-spin').evaluate(el => getComputedStyle(el).animationName), 'none', 'the arrow circulates');
    await page.waitForTimeout(700);
    const at = await button.boundingBox();
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2); // not locator.hover(): the pinned clock stops Playwright's frame checks
    await page.clock.runFor(6000); // the bar is paced by the clock, which the harness pins
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.upd-row').count(), 2);
    const pct = parseInt(await page.locator('.upd-pct').first().innerText(), 10);
    assert.ok(pct > 30 && pct < 94, `the bar has moved on (${pct}%)`);
    assert.match(await page.locator('.upd-status').innerText(), /Updating 2 CLIs/);
    assert.match(await page.locator('.upd-row').first().innerText(), /Claude Code/);
    const box = await page.locator('.upd-pill').boundingBox();
    assert.ok(box.width > 200 && box.x >= 0, `pill opens leftward on screen (x=${box.x}, w=${box.width})`);
    await shot('2-updating-hover');
    await page.mouse.move(5, 5);
    await page.waitForTimeout(800);
    await shot('2-updating');

    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    finishers.forEach(finish => finish({ ok: true, message: 'Updated' }));
    await Promise.all([claude, codex]);
    await settle();
    await page.waitForTimeout(1000);
    assert.match(await button.getAttribute('class'), /is-done/);
    assert.equal(await page.locator('.upd-status').innerText(), 'Update is done');
    assert.equal(await button.isHidden(), false);
    await shot('3-done');

    await page.clock.runFor(7000);
    assert.match(await button.getAttribute('class'), /is-collapsing/);
    assert.equal(await button.isHidden(), false, 'keep the button mounted during retraction');
    await page.clock.runFor(300);
    await shot('4-collapsing');
    await page.clock.runFor(300);
    assert.match(await button.getAttribute('class'), /is-exiting/);
    await page.clock.runFor(180);
    await shot('5-shrinking');
    await page.clock.runFor(220);
    assert.equal(await button.isHidden(), true, 'the button goes away once the result has been shown');
    assert.deepEqual(problems, []);
    await page.close();
  }
  console.log('Update button: circulating arrow, hover pill with progress and the "Update is done" message at 320px and 900px.');
} finally { await browser.close(); }
