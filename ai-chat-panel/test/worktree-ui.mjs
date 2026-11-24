import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

// The chip that shows a chat's git worktree (WORKTREE-01), in the real page, in the editor-tab layout and the sidebar rail.
// SHOT_DIR=<folder> saves screenshots in dark and light.
const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const projects = [{ id: 'a', name: 'portfolio 2026', root: '/dev/portfolio' }];
const info = (extra = {}) => ({ type: 'worktree', chatId: 'c1', worktree: { branch: 'clanker/fix-the-login-bug', path: '/home/u/.clanker/worktrees/app/fix-the-login-bug', dirty: 3, ahead: 1, missing: false, ...extra } });
const browser = await chromium.launch({ headless: true });
try {
  for (const sidebar of [false, true]) {
    for (const theme of ['dark', 'light']) {
      const { page, problems } = await openChat(browser, { width: sidebar ? 420 : 640, height: 700, scale: 2, sidebar });
      if (theme === 'light') await page.evaluate(() => { document.documentElement.classList.add('is-light'); document.body.classList.add('vscode-light'); });
      await send(page, { type: 'project', project: projects[0], projects, chatId: 'c1', required: false, pinnedProjectIds: [] });
      const chip = page.locator('.worktree-chip');
      assert.equal(await chip.isVisible(), false, 'no chip for a chat in the project folder');
      await send(page, info());
      await chip.waitFor();
      assert.equal(await chip.locator('span').innerText(), 'fix-the-login-bug · 3');
      assert.match(await chip.getAttribute('title'), /clanker\/fix-the-login-bug[\s\S]*3 uncommitted files, 1 commit ahead/);
      assert.equal(await chip.evaluate(el => el.classList.contains('is-dirty')), true);
      const box = await chip.boundingBox(), view = page.viewportSize();
      assert.ok(box.x >= 0 && box.x + box.width <= view.width, 'the chip stays inside the window');
      await chip.click();
      assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'worktreeMenu')), { type: 'worktreeMenu' });
      if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOT_DIR, `worktree-${sidebar ? 'rail' : 'tab'}-${theme}.png`) }); }
      await send(page, info({ dirty: 0, ahead: 0 }));
      assert.equal(await chip.locator('span').innerText(), 'fix-the-login-bug');
      assert.equal(await chip.evaluate(el => el.classList.contains('is-dirty')), false);
      await send(page, info({ missing: true }));
      assert.equal(await chip.locator('span').innerText(), 'worktree missing');
      assert.match(await chip.getAttribute('title'), /gone[\s\S]*\/worktree remove/);
      await send(page, { type: 'worktree', chatId: 'c1', worktree: null });
      assert.equal(await chip.isVisible(), false, 'removing the worktree hides it');
      // /worktree is a panel command, not a prompt for the model.
      await page.locator('#promptInput').fill('/worktree new');
      await page.locator('#promptInput').press('Enter');
      assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'worktreeCommand')), { type: 'worktreeCommand', args: 'new' });
      assert.equal(await page.evaluate(() => window.sent.some(m => m.type === 'send' || m.type === 'sendMessage' || m.type === 'chat')), false, 'it was not sent to a model');
      assert.deepEqual(problems, []);
      await page.close();
    }
  }
  console.log('Worktree chip: hidden without one, branch and dirty count, missing state, menu click, /worktree as a panel command; tab and rail, dark and light.');
} finally { await browser.close(); }
