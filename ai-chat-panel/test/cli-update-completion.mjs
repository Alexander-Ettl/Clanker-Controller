import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const { page, problems } = await openChat(browser, { width: 900, height: 1000, sidebar: true });
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const snapshot = {
    type: 'cliStatus', versions: { gemini: { version: '1.4.3', latest: '1.4.3' } },
    updates: [], updating: {}, notes: {}, fetched: [], favorites: [], catalog: [], prompts: {}, modelSettings: {},
  };
  await send({ type: 'openSettings', tab: 'general' });
  await send({ type: 'fleet', models: [], clis: { gemini: { path: 'C:/agy/agy.exe' } } });
  const completedAt = await page.evaluate(() => Date.now());
  const completed = { ...snapshot, notes: { gemini: { ok: true, text: 'Updated', completedAt } } };
  await send(completed);
  const note = page.locator('.cs-provider[data-agent=gemini] .cs-update-note');
  assert.equal(await note.innerText(), 'Update complete.');
  await page.clock.runFor(4900);
  assert.equal(await note.count(), 1);
  await page.clock.runFor(200);
  assert.equal(await note.count(), 0, 'completion clears after five seconds without another host message');
  await send(completed);
  assert.equal(await note.count(), 0, 'status refresh cannot replay an expired completion');
  await send({ ...snapshot, notes: { gemini: { ok: true, text: 'Old result' } } });
  assert.equal(await note.count(), 0, 'legacy success notes have no fresh completion time');
  await send({ ...snapshot, notes: { gemini: { ok: false, text: 'Update failed' } } });
  assert.equal(await note.innerText(), 'Update failed', 'errors remain available');
  const running = { ...snapshot, updating: { gemini: { startedAt: completedAt, estimateMs: 20000 } } };
  await send(running);
  await send(completed);
  await page.clock.runFor(7100);
  const button = page.locator('#updatesBtn');
  assert.match(await button.getAttribute('class'), /is-collapsing/);
  await send(running);
  assert.doesNotMatch(await button.getAttribute('class'), /is-collapsing|is-exiting/);
  await page.clock.runFor(1000);
  assert.equal(await button.isHidden(), false, 'a new update cancels the old exit');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await send(completed);
  await page.clock.runFor(7100);
  assert.equal(await button.isHidden(), true, 'reduced motion skips retraction and shrinking delays');
  assert.deepEqual(problems, []);
  console.log('Settings completion expires after five seconds and stale successes stay hidden.');
} finally { await browser.close(); }
