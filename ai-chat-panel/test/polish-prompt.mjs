// The composer's Polish button, in the real HTML with the real main.js and style.css:
//   node test/polish-prompt.mjs             asserts the behaviour
//   SHOT=<dir> node test/polish-prompt.mjs  also writes polish-*.png there (rest, working, result)
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
require('./model-fixture').seedModels();
const uri = file => ({ fsPath: file, toString: () => file });
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(String(base), ...parts)) }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
  return originalLoad.call(this, request, parent, isMain);
};
const { ChatWindowHost } = require('../extension');
Module._load = originalLoad;
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const origin = 'http://127.0.0.1';
const shot = (name) => process.env.SHOT && path.join(process.env.SHOT, `polish-${name}.png`);
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar: true }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 560 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(media, '.' + pathname);
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.addInitScript(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({ postMessage(message) { window.sent.push(message); }, getState: () => JSON.parse(sessionStorage.getItem('panelState') || '{}'), setState(state) { sessionStorage.setItem('panelState', JSON.stringify(state)); } });
  });
  await page.goto(origin);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const polishRequests = () => page.evaluate(() => window.sent.filter(m => m.type === 'polishPrompt'));
  const input = page.locator('#promptInput');
  const polish = page.locator('#polishBtn');
  const mic = page.locator('#micBtn');
  const visible = async () => Number(await polish.evaluate(el => getComputedStyle(el).opacity)) > 0.99 && await polish.evaluate(el => getComputedStyle(el).visibility) === 'visible';

  // Layout: format is its own button, directly left of dictate, in the bar. There is no hover menu.
  const [m0, p0] = await Promise.all([mic.boundingBox(), polish.boundingBox()]);
  assert.ok(p0.x + p0.width <= m0.x + 1 && m0.x - (p0.x + p0.width) < 12, 'format sits directly left of dictate');
  assert.ok(Math.abs(p0.y - m0.y) < 1 && p0.width === m0.width && p0.height === m0.height, 'format and dictate are one row of equal buttons');
  assert.equal(await visible(), true, 'format is always shown');
  assert.equal(await page.locator('#micWrap').evaluate(el => getComputedStyle(el).display), 'contents', 'no wrapper box or pill around the two');

  // Empty box: nothing to format.
  assert.equal(await polish.isDisabled(), true, 'empty drafts cannot be formatted');

  // A draft enables it.
  const draft = 'so basically i want the settings page to like have a dictionary tab and also it should be searchable, and um the scan thing needs limits. also dont forget tests';
  await input.fill(draft);
  assert.equal(await polish.isDisabled(), false, 'a draft can be formatted');
  await page.waitForTimeout(500); // the send button takes its slot
  const ready = await polish.boundingBox();
  if (shot('rest')) await page.screenshot({ path: shot('rest'), clip: { x: 0, y: 360, width: 520, height: 200 } });

  // Click: the text goes out once, the box is locked and Enter does not send the old draft.
  await polish.click();
  assert.deepEqual(await polishRequests(), [{ type: 'polishPrompt', text: draft, requestId: 1 }]);
  await page.waitForTimeout(450);
  const primary = await polish.boundingBox();
  assert.ok(Math.abs(primary.x + primary.width / 2 - ready.x - ready.width / 2) < 1 && Math.abs(primary.y + primary.height / 2 - ready.y - ready.height / 2) < 1, 'format stays where it was while working');
  assert.equal(await input.evaluate(el => el.readOnly), true, 'locked while working');
  await input.press('Enter');
  assert.equal((await page.evaluate(() => window.sent.filter(m => m.type === 'sendPrompt' || m.type === 'prompt'))).length, 0, 'Enter does not send mid-polish');
  await polish.click({ force: true }).catch(() => {});
  assert.equal((await polishRequests()).length, 1, 'no second request while one runs');
  if (shot('working')) await page.screenshot({ path: shot('working'), clip: { x: 0, y: 360, width: 520, height: 200 } });

  // A stale answer is ignored; the right one replaces the text and Ctrl+Z gets the original back.
  await send({ type: 'polishResult', requestId: 99, text: 'WRONG' });
  assert.equal(await input.inputValue(), draft);
  const polished = '- Add a searchable Dictionary tab to the settings page.\n- Put limits on the project scan.\n- Add tests.';
  await send({ type: 'polishResult', requestId: 1, text: polished });
  assert.equal(await input.inputValue(), polished);
  assert.equal(await input.evaluate(el => el.readOnly), false, 'unlocked again');
  assert.equal(await page.evaluate(() => document.querySelector('.toast')?.textContent), 'Prompt polished. Ctrl+Z restores what you wrote.');
  assert.equal(await visible(), true, 'format remains after completion');
  assert.equal(await mic.evaluate(el => getComputedStyle(el).visibility), 'visible', 'dictate is never hidden by format');
  if (shot('result')) await page.screenshot({ path: shot('result'), clip: { x: 0, y: 300, width: 520, height: 260 } });
  await input.press('Control+z');
  assert.equal(await input.inputValue(), draft, 'Ctrl+Z restores the original');

  // A failure keeps the draft and says why.
  await polish.click();
  await send({ type: 'polishResult', requestId: 2, error: 'Could not polish the prompt: offline' });
  assert.equal(await input.inputValue(), draft);
  assert.equal(await input.evaluate(el => el.readOnly), false);
  assert.match(await page.evaluate(() => [...document.querySelectorAll('.toast')].pop().textContent), /offline/);

  // Dictate is one click away, untouched by format.
  const dictateSlot = await mic.evaluate(el => el.offsetLeft);
  await mic.click();
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'micToggle').length), 1);
  await send({ type: 'micState', state: 'idle' }); // the click shows "opening the microphone" until the host answers; this harness has no host
  assert.equal(await mic.evaluate(el => el.offsetLeft), dictateSlot, 'dictate returns to the same slot');

  // External (hotkey) recording takes the composer over; format steps aside, dictate stays reachable.
  await send({ type: 'micState', state: 'recording' });
  assert.equal(await mic.evaluate(el => getComputedStyle(el).visibility), 'visible', 'recording exposes the mic');
  assert.equal(await polish.evaluate(el => getComputedStyle(el).display), 'none', 'format steps aside while recording');
  await send({ type: 'micState', state: 'idle' });

  assert.deepEqual(errors, []);
  console.log('polish prompt ok');
} finally { await browser.close(); }

