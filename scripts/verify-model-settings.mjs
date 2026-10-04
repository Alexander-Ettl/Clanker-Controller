import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const read = name => fs.readFileSync(new URL(`../ai-chat-panel/media/${name}`, import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<style>${read('style.css')}\n${read('settings.css')}</style><div id="settings" style="padding:16px"></div>`);
  for (const name of ['model-prompts.js', 'settings.js']) await page.addScriptTag({ content: read(name) });
  await page.evaluate(() => {
    window.testStatus = { versions: {}, updating: {}, notes: {}, favorites: [], catalog: [], prompts: {}, modelsBusy: false,
      fetched: [
        ...Array.from({ length: 35 }, (_, i) => ({ id: `opus-${i}`, model: `claude-opus-${i}`, label: `Claude Opus ${i} High`, agent: 'claude' })),
        { id: 'sol', model: 'gpt-6.1-sol', label: 'GPT 6.1 Sol High', agent: 'codex' },
        { id: 'astra', model: 'gpt-6.1-astra', label: 'GPT 6.1 Astra High', agent: 'codex' },
        { id: 'gemini', model: 'gemini-flash', label: 'Gemini Flash', agent: 'gemini' },
      ] };
    window.settings = window.initChatSettings({ body: document.querySelector('#settings'), vscode: { postMessage(message) {
      if (message.type !== 'toggleFavoriteModel') return;
      const favorites = window.testStatus.favorites;
      window.testStatus = { ...window.testStatus, favorites: favorites.includes(message.id) ? favorites.filter(id => id !== message.id) : [...favorites, message.id] };
      window.settings.cliStatus(window.testStatus);
    } } });
    window.settings.showTab('general');
    window.settings.cliStatus(window.testStatus);
  });
  const search = page.getByRole('searchbox');
  const rows = page.locator('.cs-model-row');
  await search.fill('OPUS');
  assert.equal(await rows.count(), 35);
  await search.fill('6.1');
  assert.equal(await rows.count(), 2);
  await page.getByRole('button', { name: 'Google', exact: true }).click();
  assert.equal(await rows.count(), 0);
  assert.match(await page.locator('[data-role="modelList"]').innerText(), /No models match/);
  await search.fill('');
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.first().innerText(), 'Gemini Flash');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.evaluate(() => {
    const list = document.querySelector('[data-role="modelList"]');
    list.scrollTop = 500;
    window.heartBefore = list.querySelector('[data-model-id="opus-18"]');
    window.heartBefore.focus({ preventScroll: true });
    window.scrollBefore = list.scrollTop;
    window.heartBefore.click();
  });
  await page.waitForFunction(() => window.heartBefore.classList.contains('is-popping'));
  assert.equal(await page.evaluate(() => document.querySelector('[data-role="modelList"]').scrollTop === window.scrollBefore), true);
  assert.equal(await page.evaluate(() => document.activeElement === window.heartBefore && window.heartBefore.isConnected), true);
  assert.equal(await page.evaluate(() => window.heartBefore.getAttribute('aria-pressed')), 'true');
  assert.equal(await page.evaluate(() => getComputedStyle(window.heartBefore.querySelector('svg')).animationName), 'cs-heart-pop');
  await page.evaluate(() => window.heartBefore.click());
  assert.equal(await page.evaluate(() => window.heartBefore.getAttribute('aria-pressed')), 'false');
  assert.equal(await page.evaluate(() => document.querySelector('[data-role="modelList"]').scrollTop === window.scrollBefore), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(window.heartBefore.querySelector('svg')).animationName), 'none');
  assert.deepEqual(errors, []);
  if (process.argv[2]) {
    await page.evaluate(() => {
      document.activeElement.blur();
      document.querySelector('[data-role="modelList"]').scrollTop = 0;
    });
    await page.screenshot({ path: process.argv[2], fullPage: true });
  }
  console.log('Model settings: search, company filters, favorite scroll/focus, animation and reduced motion passed.');
} finally {
  await browser.close();
}
