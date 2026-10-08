// The composer's Polish button, in the real HTML with the real main.js and style.css:
//   node test/polish-prompt.mjs             asserts the behaviour
//   SHOT=<dir> node test/polish-prompt.mjs  also writes polish-*.png there (hover, working, result)
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
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
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

  // Empty box: the alternate action is discoverable but cannot polish an empty draft.
  await mic.hover();
  await page.waitForTimeout(400);
  assert.equal(await visible(), true, 'hover offers polish even without a draft');
  assert.equal(await polish.isDisabled(), true, 'empty drafts cannot be polished');

  // A draft: hovering the mic brings the button up above it.
  const draft = 'so basically i want the settings page to like have a dictionary tab and also it should be searchable, and um the scan thing needs limits. also dont forget tests';
  await input.fill(draft);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  assert.equal(await visible(), false, 'hidden until hovered');
  await mic.hover();
  await page.waitForTimeout(450);
  assert.equal(await visible(), true, 'hovering the mic shows polish');
  const [m, p] = await Promise.all([mic.boundingBox(), polish.boundingBox()]);
  assert.equal(p.width, m.width, 'both actions have the same width');
  assert.equal(p.height, m.height, 'both actions have the same height');
  assert.ok(p.y + p.height <= m.y + 3, `the button sits above the mic ${JSON.stringify({ m, p })}`);
  assert.ok(Math.abs(p.x + p.width / 2 - (m.x + m.width / 2)) < 1.5, 'and is centred on it');
  // The pointer can travel from the mic to the button without it closing.
  await page.mouse.move(p.x + p.width / 2, p.y + p.height + 1);
  await page.waitForTimeout(150);
  assert.equal(await visible(), true, 'moving up keeps it open');
  if (shot('hover')) await page.screenshot({ path: shot('hover'), clip: { x: 0, y: 360, width: 520, height: 200 } });

  // Click: the text goes out once, the box is locked and Enter does not send the old draft.
  await polish.click();
  assert.deepEqual(await polishRequests(), [{ type: 'polishPrompt', text: draft, requestId: 1 }]);
  await page.waitForTimeout(450);
  const primary = await polish.boundingBox();
  assert.ok(Math.abs(primary.y - m.y) < 1, 'polish swaps into the default position');
  assert.equal(await input.evaluate(el => el.readOnly), true, 'locked while working');
  await input.press('Enter');
  assert.equal((await page.evaluate(() => window.sent.filter(m => m.type === 'sendPrompt' || m.type === 'prompt'))).length, 0, 'Enter does not send mid-polish');
  await polish.click({ force: true }).catch(() => {});
  assert.equal((await polishRequests()).length, 1, 'no second request while one runs');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  assert.equal(await visible(), true, 'the button stays up while it works');
  if (shot('working')) await page.screenshot({ path: shot('working'), clip: { x: 0, y: 360, width: 520, height: 200 } });

  // A stale answer is ignored; the right one replaces the text and Ctrl+Z gets the original back.
  await send({ type: 'polishResult', requestId: 99, text: 'WRONG' });
  assert.equal(await input.inputValue(), draft);
  const polished = '- Add a searchable Dictionary tab to the settings page.\n- Put limits on the project scan.\n- Add tests.';
  await send({ type: 'polishResult', requestId: 1, text: polished });
  assert.equal(await input.inputValue(), polished);
  assert.equal(await input.evaluate(el => el.readOnly), false, 'unlocked again');
  assert.equal(await page.evaluate(() => document.querySelector('.toast')?.textContent), 'Prompt polished. Ctrl+Z restores what you wrote.');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(450);
  assert.equal(await visible(), true, 'polish remains the default after completion');
  assert.equal(await mic.evaluate(el => getComputedStyle(el).visibility), 'hidden', 'dictate retracts');
  if (shot('result')) await page.screenshot({ path: shot('result'), clip: { x: 0, y: 300, width: 520, height: 260 } });
  await input.press('Control+z');
  assert.equal(await input.inputValue(), draft, 'Ctrl+Z restores the original');

  // A failure keeps the draft and says why.
  await polish.hover();
  await polish.click();
  await send({ type: 'polishResult', requestId: 2, error: 'Could not polish the prompt: offline' });
  assert.equal(await input.inputValue(), draft);
  assert.equal(await input.evaluate(el => el.readOnly), false);
  assert.match(await page.evaluate(() => [...document.querySelectorAll('.toast')].pop().textContent), /offline/);

  // The choice survives panel reload; hovering the new default offers dictate at the top.
  await page.reload();
  assert.equal(await page.locator('#micWrap').evaluate(el => el.classList.contains('polish-default')), true);
  await polish.hover();
  await page.waitForTimeout(450);
  const [polishDefault, dictateAlternate] = await Promise.all([polish.boundingBox(), mic.boundingBox()]);
  assert.equal(dictateAlternate.y + dictateAlternate.height, polishDefault.y, 'dictate appears directly above polish');
  await mic.click();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#micWrap').evaluate(el => el.classList.contains('polish-default')), false, 'dictate restores the default');
  assert.equal(await visible(), false, 'polish retracts after restoring dictate');
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'micToggle').length), 1);
  assert.ok(Math.abs((await mic.boundingBox()).y - polishDefault.y) < 1, 'dictate returns to the original position');

  // Keyboard users can reveal the same pill, and external recording keeps the mic accessible.
  await page.keyboard.press('Tab');
  await mic.focus();
  await page.waitForTimeout(450);
  assert.equal(await visible(), true, 'keyboard focus reveals the alternate action');
  await input.fill(draft);
  await mic.hover();
  await polish.click();
  await send({ type: 'polishResult', requestId: 1, text: draft });
  await send({ type: 'micState', state: 'recording' });
  assert.equal(await mic.evaluate(el => getComputedStyle(el).visibility), 'visible', 'hotkey recording exposes the mic even with polish selected');
  await send({ type: 'micState', state: 'idle' });

  assert.deepEqual(errors, []);
  console.log('polish prompt ok');
} finally { await browser.close(); }

