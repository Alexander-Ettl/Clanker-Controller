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
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
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
    window.acquireVsCodeApi = () => ({ postMessage(message) { window.sent.push(message); }, getState: () => ({}), setState() {} });
  });
  await page.goto(origin);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const initial = { type: 'cliConnections', setupNeeded: true, checking: false, providers: {
    claude: { enabled: false, installed: true, auth: 'unknown' },
    codex: { enabled: false, installed: true, auth: 'unknown' },
    gemini: { enabled: false, installed: false, auth: 'unknown' },
  } };
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'requestCliConnections')), true);
  await send(initial);
  const setup = page.locator('#cliSetupModal');
  await setup.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.cs-setup-mark img').naturalWidth > 0);
  assert.equal(await setup.locator('.cs-provider').count(), 3);
  assert.equal(await setup.getByRole('button', { name: 'Start chatting', exact: true }).isDisabled(), true);
  await setup.getByRole('button', { name: 'Set up all three', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'connectAllClis')), true);
  await setup.locator('[data-agent="codex"]').getByRole('button', { name: 'Sign in / Sign up' }).click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'connectCli' && message.agent === 'codex')), true);
  if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], 'cli-welcome.png') });
  const connected = { ...initial, providers: { ...initial.providers, codex: { enabled: true, installed: true, auth: 'connected' } } };
  await send(connected);
  assert.equal(await setup.getByRole('button', { name: 'Start chatting', exact: true }).isEnabled(), true);
  assert.match(await setup.locator('[data-role="setupProgress"]').innerText(), /1 of 3 CLIs ready/);
  await setup.getByRole('button', { name: 'Start chatting', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'completeCliSetup')), true);
  await send({ ...connected, setupNeeded: false });
  await setup.waitFor({ state: 'hidden' });
  await send({ type: 'openSettings', tab: 'general' });
  await send({ type: 'fleet', models: [], clis: { claude: { path: 'claude.exe' }, codex: { path: 'codex.exe' }, gemini: { path: null } }, services: {} });
  await send({ ...connected, setupNeeded: false });
  const settings = page.locator('#settingsModal');
  await settings.waitFor({ state: 'visible' });
  const codex = settings.locator('[data-role="providers"] [data-agent="codex"]');
  assert.equal(await codex.locator('.cs-state').innerText() !== 'Sign in', true);
  await codex.getByRole('button', { name: 'Remove Codex', exact: true }).click(); // the trash can asks first
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'removeCli')), false);
  await codex.getByRole('button', { name: 'Cancel', exact: true }).click();
  await codex.getByRole('button', { name: 'Remove Codex', exact: true }).click();
  await codex.getByRole('button', { name: 'Remove', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'removeCli' && message.agent === 'codex')), true);
  await send({ ...connected, setupNeeded: false, providers: { ...connected.providers, codex: { ...connected.providers.codex, enabled: false } } });
  await codex.getByRole('button', { name: 'Add CLI', exact: true }).click();
  await settings.getByRole('button', { name: 'Check', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'checkCliConnections')), true);
  await send({ ...connected, setupNeeded: false, checking: true });
  assert.equal(await settings.getByRole('button', { name: 'Checking…', exact: true }).isDisabled(), true);
  assert.equal(await setup.isVisible(), false, 'updates never reopen a completed welcome');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  await send({ ...connected, setupNeeded: false });
  assert.equal(await setup.isVisible(), false, 'returning users do not see the welcome');
  await send(initial);
  await setup.waitFor({ state: 'visible' });
  await setup.getByRole('button', { name: 'Set up later', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'completeCliSetup')), true);
  assert.deepEqual(errors, []);
  console.log('CLI setup UI: first-run welcome, individual/all sign-in, readiness, skip, Settings remove/readd/check and returning users passed.');
} finally {
  await browser.close();
}
