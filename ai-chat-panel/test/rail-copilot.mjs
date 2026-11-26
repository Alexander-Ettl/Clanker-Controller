// Copilot has one monthly allowance: its sidebar ring opens to a single "Month" row whose name must not run into the bar, with no stray 7d row.
// Copilot has one monthly allowance: its sidebar ring opens to a single "Month" row whose name must not run into the bar, with no stray 7d row.
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
const { AuthGate } = require('../lib/auth-gate');
const { fakeAccounts } = require('./auth-fixture');
Module._load = originalLoad;
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const out = path.resolve(process.argv[2] || fileURLToPath(new URL('../../out/rail-copilot/', import.meta.url)));
fs.mkdirSync(out, { recursive: true });
const origin = 'http://127.0.0.1';
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar: true }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });

const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 700 } });
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
  const send = (message) => page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const { models } = require('./model-fixture');
  const copilot = { ...models.find((m) => m.agent === 'claude'), id: 'copilot-gpt', agent: 'copilot', label: 'GPT 5.1', provider: 'copilot' };
  const now = Math.floor(Date.now() / 1000);
  const { accounts } = fakeAccounts({ agents: ['claude', 'codex', 'gemini', 'copilot'] });
  await accounts.check();
  await send(accounts.snapshot());
  await send({ type: 'modelCatalog', catalog: [...models, copilot], available: [...models, copilot] });
  await send({ type: 'quotas', quotas: { copilot: { remaining: 100, used: 0, resetsAt: now + 5 * 86400 + 9 * 3600, windowMinutes: 43200, windowLabel: 'Month', detail: { plan: 'Copilot Free', used: 0.125, entitlement: 200, what: 'AI credits' } } } });
  const card = page.locator('#modelCards .model-card[data-agent="copilot"]');
  await card.waitFor({ state: 'attached' });
  assert.match(await card.getAttribute('title'), /0[.,]125 of 200 AI credits used this month/);
  await card.locator('.ring').hover();
  await page.waitForTimeout(800);
  const rows = card.locator('.ring-row');
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.nth(1).isVisible(), false, 'no stray 7d row on a one-allowance provider');
  const geometry = await card.evaluate((el) => {
    const row = el.querySelector('.ring-row'), name = row.querySelector('.ring-row-name').getBoundingClientRect(), bar = row.querySelector('.ring-bar').getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(row.querySelector('.ring-row-name'));
    return { nameRight: Math.max(range.getBoundingClientRect().right, name.right), barLeft: bar.left, text: row.querySelector('.ring-row-name').textContent, barWidth: bar.width };
  });
  assert.equal(geometry.text, 'Month');
  assert.ok(geometry.nameRight <= geometry.barLeft + 0.5, `"Month" ends at ${geometry.nameRight}px but the bar starts at ${geometry.barLeft}px`);
  assert.ok(geometry.barWidth > 40, `the bar is still a bar (${geometry.barWidth}px)`);
  await page.screenshot({ path: path.join(out, 'rail-copilot.png') });
  assert.deepEqual(errors, []);
  console.log('rail-copilot ok');
} finally { await browser.close(); }
