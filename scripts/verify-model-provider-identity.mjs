import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const read = name => fs.readFileSync(new URL(`../ai-chat-panel/media/${name}`, import.meta.url), 'utf8');
  await page.setContent(`<style>${read('style.css')}\n${read('settings.css')}</style><div id="settings"></div>`);
  for (const name of ['model-prompts.js', 'settings.js']) {
    await page.addScriptTag({ content: fs.readFileSync(new URL(`../ai-chat-panel/media/${name}`, import.meta.url), 'utf8') });
  }
  await page.evaluate(() => {
    const settings = window.initChatSettings({ body: document.querySelector('#settings'), vscode: { postMessage() {} } });
    settings.showTab('general');
    settings.cliStatus({ versions: {}, updating: {}, notes: {}, favorites: [], catalog: [], prompts: {}, modelsBusy: false, fetched: [
      { id: 'claude-future-medium', model: 'claude-future', label: 'Claude Future Medium', agent: 'claude', company: 'Anthropic' },
      { id: 'gemini:claude-future-medium', model: 'claude-future-medium', label: 'Claude Future Medium', agent: 'gemini', company: 'Anthropic' },
      { id: 'gemini-future', model: 'gemini-future', label: 'Gemini Future', agent: 'gemini', company: 'Google' },
    ] });
  });
  await page.locator('[data-company="claude"]').click();
  assert.equal(await page.locator('.cs-model-row').count(), 1);
  assert.deepEqual(await page.locator('.cs-head-name').allTextContents(), ['Claude Code']);
  await page.locator('[data-company="gemini"]').click();
  assert.equal(await page.locator('.cs-model-row').count(), 2);
  assert.deepEqual(await page.locator('.cs-model-label').allTextContents(), ['Claude Future Medium', 'Gemini Future']);
  assert.equal(await page.locator('[data-company="gemini"]').innerText(), 'Antigravity CLI');
  assert.deepEqual(errors, []);
  console.log('CLI filters keep hosted Claude models under Antigravity CLI.');
} finally {
  await browser.close();
}
