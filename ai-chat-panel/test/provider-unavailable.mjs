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
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar: true }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });
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
  const { models } = require('./model-fixture');
  const quota = (remaining, resetsAt) => ({ remaining, used: 100 - remaining, resetsAt, windowMinutes: 300, windowLabel: '5h', secondary: { remaining: 80, used: 20, resetsAt: resetsAt + 86400, windowMinutes: 10080, windowLabel: '7d' } });
  const now = Math.floor(Date.now() / 1000);
  const quotas = { claude: quota(100, now + 17400), codex: quota(100, now + 17400), gemini: quota(100, now + 17700) };
  const providerState = (codex) => ({ type: 'cliConnections', setupNeeded: false, checking: false, providers: {
    claude: { enabled: true, installed: true, auth: 'connected' }, codex: { enabled: true, installed: true, auth: 'connected', ...codex }, gemini: { enabled: true, installed: true, auth: 'connected' } } });
  const catalog = (without) => models.filter(model => model.agent !== without);
  const cards = () => page.locator('#modelCards .model-card').evaluateAll(list => list.map(card => card.dataset.agent));

  // Everything is available: three rings, Codex models in the picker.
  await send({ type: 'quotas', quotas });
  await send({ type: 'modelCatalog', catalog: models, available: models });
  await send(providerState({}));
  assert.deepEqual(await cards(), ['claude', 'codex', 'gemini']);
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'requestCliAvailability')), true, 'the rail asks for the CLIs it may show');
  await page.locator('#modelPill').click();
  assert.match(await page.locator('#modelMenu').innerText(), /GPT 6\.1 Sol/);
  await page.keyboard.press('Escape');

  // Codex runs out: the extension drops it from the catalog and flags it unavailable.
  const failure = { kind: 'plan', reason: 'Needs ChatGPT Plus or above.', detail: 'This account is on the Free plan' };
  await send({ type: 'modelCatalog', catalog: catalog('codex'), available: catalog('codex') });
  await send(providerState({ unavailable: failure, fault: { kind: 'plan', code: null, title: failure.reason, detail: failure.detail, action: 'restoreCli', label: 'Allow a retry', steps: [] } }));
  // An unusable CLI keeps its ring, in red, so hovering can say why (see launcher.js usableAgents); only its models leave the selector.
  assert.deepEqual(await cards(), ['claude', 'codex', 'gemini'], 'an unavailable CLI keeps its ring');
  assert.equal(await page.locator('#modelCards .model-card[data-agent="codex"]').evaluate(el => el.classList.contains('is-faulty')), true, 'and the ring is red');
  await page.locator('#modelPill').click();
  const menu = await page.locator('#modelMenu').innerText();
  assert.doesNotMatch(menu, /GPT|Codex/, 'no Codex models in the selector');
  assert.match(menu, /Claude/);
  await page.waitForTimeout(700);
  if (process.env.SHOT_DIR) await page.locator('#modelMenu').screenshot({ path: path.join(process.env.SHOT_DIR, 'picker.png') });
  await page.keyboard.press('Escape');

  await send({ type: 'openSettings', tab: 'general' });
  await send({ type: 'fleet', models: catalog('codex'), clis: { claude: { path: 'claude.exe' }, codex: { path: 'codex.exe' }, gemini: { path: 'agy.exe' } }, services: {} });
  await send(providerState({ unavailable: failure }));
  const settings = page.locator('#settingsModal');
  await settings.waitFor({ state: 'visible' });
  const card = settings.locator('[data-role="providers"] [data-agent="codex"]');
  assert.equal(await card.locator('.cs-state').innerText(), 'Not available');
  assert.match(await card.locator('.cs-models').innerText(), /Needs ChatGPT Plus or above/);
  assert.match(await card.locator('.cs-models').getAttribute('title'), /Free plan/);
  assert.equal(await settings.locator('[data-role="providers"] [data-agent="claude"] .cs-state').innerText() !== 'Not available', true, 'other CLIs are unaffected');
  await card.scrollIntoViewIfNeeded();
  if (process.env.SHOT_DIR) await settings.locator('[data-role="providers"]').screenshot({ path: path.join(process.env.SHOT_DIR, 'your-clis.png') });
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'restoreCli' && message.agent === 'codex')), true);

  // Tried again: the ring and the models come back.
  await send({ type: 'modelCatalog', catalog: models, available: models });
  await send(providerState({}));
  assert.deepEqual(await cards(), ['claude', 'codex', 'gemini']);
  assert.equal(await card.locator('.cs-state').innerText() !== 'Not available', true);
  assert.deepEqual(errors, []);
  console.log('Unavailable CLI: the ring turns red and selector models drop out, Your CLIs says why, Try again restores them.');
} finally {
  await browser.close();
}
