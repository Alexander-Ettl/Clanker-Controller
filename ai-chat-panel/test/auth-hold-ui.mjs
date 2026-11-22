// Renders the "queue is held, sign in" card (media/main.js renderAuthHold) in the real chat webview at three widths.
// Screenshots go to out/auth-hold-review. No CLI, no IDE.
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
const out = path.resolve(fileURLToPath(new URL('../../out/auth-hold-review/', import.meta.url)));
fs.mkdirSync(out, { recursive: true });
const origin = 'http://127.0.0.1';
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
// The message is built by the real gate on the real CliAccounts, so the card shows exactly what the rail and the popup say.
const { AuthGate } = require('../lib/auth-gate');
const { fakeAccounts } = require('./auth-fixture');
const gateFor = (options) => { const { accounts } = fakeAccounts(options); return new AuthGate({ accounts, pending: () => 3, pollMs: 60000 }); };
const gate = gateFor();
const expired = { type: 'authHold', chatId: 'auth-chat', held: 3, ...gate.expired('codex', '401 Unauthorized') };
gate.dispose();
const noLogin = gateFor({ agents: ['gemini'], status: { gemini: 'signin' } });
const antigravity = { type: 'authHold', chatId: 'auth-chat', held: 3, ...await noLogin.check('gemini') };
noLogin.dispose();
assert.equal(expired.action, 'fixCli');

const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const errors = [];
  for (const width of [900, 420, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    page.on('pageerror', error => errors.push(`${width}: ${error.message}`));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(`${width}: ${message.text()}`); });
    await page.route(`${origin}/**`, route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(media, '.' + pathname);
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', body: fs.readFileSync(file) });
    });
    await page.addInitScript(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ postMessage(message) { window.sent.push(message); }, getState: () => ({}), setState() {} });
    });
    await page.goto(origin);
    await page.locator('#stopBtn').waitFor({ state: 'attached' });
    const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    await send({ type: 'chatLoaded', chat: { id: 'auth-chat', modelId: 'gpt-6.1-sol-high', messages: [
      { role: 'user', text: 'Keep going on the importer', scheduled: true },
      { role: 'assistant', agent: 'codex', text: 'Codex error: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', at: new Date().toISOString() }],
      turnQueue: { turns: [{ id: 'c', text: 'continue', modelId: 'gpt-6.1-sol-high', queued: true }], paused: false } } });

    await send(expired);
    const card = page.locator('.auth-hold');
    await card.waitFor();
    await page.waitForTimeout(400); // the entrance animation
    assert.match(await card.innerText(), /Codex · Sign-in expired/);
    assert.equal(await card.locator('button').count(), 2);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `held-${width}.png`) });
    const box = await card.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${width}px: the card stays inside the window`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px: no sideways scroll`);

    await card.getByRole('button', { name: 'Sign in to Codex' }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(item => item.type === 'authAction')), [{ type: 'authAction', agent: 'codex' }]);
    await card.getByRole('button', { name: 'Check again' }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(item => item.type === 'authRecheck')), [{ type: 'authRecheck', agent: 'codex' }]);

    // Waiting for the browser, then a failed attempt with its reason; the same card is updated, not stacked.
    await send({ ...expired, busy: true });
    assert.equal(await page.locator('.auth-hold').count(), 1);
    assert.equal(await card.locator('.auth-hold-primary').isDisabled(), true);
    await send({ ...expired, error: 'The sign-in did not finish. Try again.' });
    assert.match(await card.innerText(), /did not finish/);
    if (width === 420) await page.screenshot({ path: path.join(out, 'held-error-420.png') });

    // A kind without a button (Antigravity has no sign-in command) still offers "Check again".
    await send(antigravity);
    assert.deepEqual(await card.locator('button').allInnerTexts(), ['Check again']);

    await send({ type: 'authHold', chatId: 'auth-chat', cleared: true });
    assert.equal(await page.locator('.auth-hold').count(), 0, 'signed in: the card goes away');
    await send({ ...expired, chatId: 'another-chat' });
    assert.equal(await page.locator('.auth-hold').count(), 0, 'another chat\'s hold is not shown here');
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('Auth hold UI: card, buttons, busy and error states, clearing and per-chat scoping passed at 900/420/320px; screenshots in out/auth-hold-review.');
} finally {
  await browser.close();
}
