import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

// The line under a reply that says what the turn changed, in the real page. SHOT_DIR=<folder> saves screenshots in dark and light.
const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const diff = {
  count: 4, add: 47, del: 13,
  files: [
    { path: 'src/very/long/folder/name/that/keeps/going/and/going/component.tsx', status: 'M', add: 40, del: 12 },
    { path: 'src/new-file.ts', status: 'A', add: 7, del: 0 },
    { path: 'old/dead.js', status: 'D', add: 0, del: 1 },
    { path: 'media/logo.png', status: 'M', add: null, del: null },
  ],
};
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['dark', 'light']) {
    const { page, problems } = await openChat(browser, { width: 640, height: 700, scale: 2 });
    if (theme === 'light') await page.evaluate(() => { document.documentElement.classList.add('is-light'); document.body.classList.add('vscode-light'); });
    const messages = [{ role: 'user', text: 'fix it', at: '2026-03-02T07:00:00Z' }, { role: 'assistant', text: 'Done. I changed four files.', agent: 'claude', at: '2026-03-02T07:01:00Z' }];
    await send(page, { type: 'chatLoaded', chat: { id: 'c1', messages, historyStart: 0, historyEnd: 2, historyUserStart: 0 }, running: null });
    await page.locator('.msg-assistant').waitFor();
    await send(page, { type: 'undoOffer', count: 4, diff });
    const box = page.locator('.turn-diff');
    await box.waitFor();
    assert.match(await box.locator('summary').innerText(), /4 files changed\s*\+47\s*[−-]13/);
    assert.equal(await box.locator('.turn-diff-file').first().isVisible(), false, 'collapsed until opened');
    await box.locator('summary').click();
    assert.equal(await box.locator('.turn-diff-file').count(), 4);
    assert.deepEqual(await box.locator('.turn-diff-status').allTextContents(), ['edited', 'new', 'deleted', 'edited']);
    assert.equal(await box.locator('.turn-diff-counts').last().innerText(), 'binary');
    const overflow = await page.evaluate(() => { const el = document.querySelector('.turn-diff-files'); return el.scrollWidth - el.clientWidth; });
    assert.ok(overflow <= 1, 'a long path is clipped, not scrolled');
    await box.locator('.turn-diff-file').nth(1).click();
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'openTurnDiff')), { type: 'openTurnDiff', index: 1 });
    if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOT_DIR, `turn-diff-${theme}.png`) }); }
    // A new offer (the next turn) replaces the list; none for a turn that changed nothing.
    await send(page, { type: 'undoOffer', count: 0 });
    assert.equal(await page.locator('.turn-diff').count(), 0);
    await send(page, { type: 'undoOffer', count: 1 });
    assert.equal(await page.locator('.turn-diff').count(), 0, 'no list when the host sent none');
    assert.deepEqual(problems, []);
    await page.close();
  }
  console.log('Turn diff: collapsed count, file list, one message per click, no overflow, dark and light.');
} finally { await browser.close(); }
