// A failed tool step stays folded unless the user turns on "Open failed steps" (aiChatPanel.openFailedToolCards).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const send = (page, data) => page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const read = (file) => fs.readFileSync(path.join(media, file), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const { page, problems } = await openChat(browser, { width: 560, height: 700 });
  const fail = async (id, command) => {
    await send(page, { type: 'tool_start', toolId: id, name: 'bash', command, agent: 'claude' });
    await send(page, { type: 'tool_end', toolId: id, output: 'Exit code 1\nError: boom', error: true, agent: 'claude' });
  };
  await send(page, { type: 'userMessage', text: 'run it' });
  await fail('a', 'false-one');
  await page.waitForTimeout(250);
  const first = page.locator('.tool-card').first();
  assert.equal(await first.evaluate((el) => el.open), false, 'default: a failed step stays folded');
  assert.equal(await first.evaluate((el) => el.classList.contains('is-error')), true, 'but it is still marked as failed');
  await first.locator('summary').click();
  await page.waitForTimeout(250);
  assert.match(await first.textContent(), /boom/, 'and its error is one click away');

  // The setting arrives as a message: the next failure opens by itself.
  await send(page, { type: 'toolPrefs', openFailed: true });
  await fail('b', 'false-two');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.tool-card').nth(1).evaluate((el) => el.open), true, 'on: it opens by itself');
  // A step that succeeds folds either way.
  await send(page, { type: 'tool_start', toolId: 'c', name: 'bash', command: 'true', agent: 'claude' });
  await send(page, { type: 'tool_end', toolId: 'c', output: 'ok', agent: 'claude' });
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.tool-card').nth(2).evaluate((el) => el.open), false);
  // Off again, live.
  await send(page, { type: 'toolPrefs', openFailed: false });
  await fail('d', 'false-three');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.tool-card').nth(3).evaluate((el) => el.open), false);
  assert.deepEqual(problems, []);
  await page.context().close();

  // The host writes the saved choice into the page it serves (the fake host's setting is off).
  const fresh = await openChat(browser, { width: 560, height: 700 });
  assert.deepEqual(await fresh.page.evaluate(() => window.TOOL_PREFS), { openFailed: false });
  await fresh.page.context().close();

  // The switch in Settings > General.
  const html = `<!doctype html><meta charset="utf-8"><style>${['style.css', 'launcher.css', 'settings.css'].map(read).join('\n')}</style>
<body style="margin:0;padding:12px;width:420px"><div class="fs-modal" style="position:static;display:block"><div class="fs-modal-sheet glass"><div class="fs-modal-body" id="csBody"></div></div></div>
<script>window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (message) => window.sent.push(message) });</script>
<script>${read('agent-icons.js')}</script><script>${read('model-prompts.js')}</script><script>${read('voice-hotkey.js')}</script><script>${read('settings.js')}</script>
<script>window.api = window.initChatSettings({ vscode: window.acquireVsCodeApi(), body: document.getElementById('csBody') }); window.api.showTab('general');</script>`;
  const settings = await browser.newPage({ viewport: { width: 460, height: 1400 } });
  const errors = [];
  settings.on('pageerror', (error) => errors.push(error.message));
  await settings.setContent(html);
  const sw = settings.locator('[data-role=openFailedToolCards]');
  assert.equal(await sw.getAttribute('aria-checked'), 'false', 'off by default');
  await sw.click();
  assert.deepEqual(await settings.evaluate(() => window.sent.filter((m) => m.type === 'setOpenFailedToolCards').at(-1)), { type: 'setOpenFailedToolCards', enabled: true });
  await settings.evaluate(() => window.api.fleet({ models: [], clis: {}, services: { openFailedToolCards: false } }));
  assert.equal(await sw.getAttribute('aria-checked'), 'false', 'follows the saved setting');
  await settings.evaluate(() => window.api.fleet({ models: [], clis: {}, services: { openFailedToolCards: true } }));
  assert.equal(await sw.getAttribute('aria-checked'), 'true');
  assert.deepEqual(errors, []);
  console.log('failed-tool-cards ok');
} finally { await browser.close(); }
