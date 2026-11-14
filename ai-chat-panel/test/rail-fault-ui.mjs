// The sidebar ring of a signed-out CLI, fed by the real CliAccounts.snapshot() (the same object the send gate reads), and its
// button: it sends `fixCli`, the same browser sign-in the Windows popup offers. Screenshots go to out/rail-fault. No CLI, no IDE.
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
const out = path.resolve(fileURLToPath(new URL('../../out/rail-fault/', import.meta.url)));
fs.mkdirSync(out, { recursive: true });
const origin = 'http://127.0.0.1';
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar: true }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
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
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const { models } = require('./model-fixture');
  const quota = (remaining, resetsAt) => ({ remaining, used: 100 - remaining, resetsAt, windowMinutes: 300, windowLabel: '5h', secondary: { remaining: 80, used: 20, resetsAt: resetsAt + 86400, windowMinutes: 10080, windowLabel: '7d' } });
  const now = Math.floor(Date.now() / 1000);
  await send({ type: 'quotas', quotas: { claude: quota(100, now + 17400), codex: quota(60, now + 17400), gemini: quota(100, now + 17700) } });
  await send({ type: 'modelCatalog', catalog: models, available: models });

  const { accounts } = fakeAccounts({ agents: ['claude', 'codex', 'gemini'], status: { codex: 'signin' } });
  await accounts.check();
  const gate = new AuthGate({ accounts, pollMs: 60000 });
  const card = page.locator('#modelCards .model-card[data-agent="codex"]');
  for (const [name, prepare, title] of [['signed-out', () => {}, 'Not signed in'], ['expired', () => { accounts.auth.codex = 'connected'; gate.expired('codex', '401'); }, 'Sign-in expired']]) {
    prepare();
    await send(accounts.snapshot());
    assert.equal(await card.evaluate(el => el.classList.contains('is-faulty')), true, `${name}: the ring is red`);
    await card.locator('.ring').hover();
    await page.waitForTimeout(700); // the pill springs out
    assert.equal(await card.locator('.ring-fault-title').innerText(), title);
    assert.equal(await card.locator('.ring-fault-btn').innerText(), 'Sign in');
    await page.screenshot({ path: path.join(out, `rail-${name}.png`) });
    await page.evaluate(() => { window.sent.length = 0; });
    await card.locator('.ring-fault-btn').click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'fixCli')), [{ type: 'fixCli', agent: 'codex' }], `${name}: the button is the same browser sign-in as the popup`);
  }
  // Mid-browser-sign-in the rail says so, the same state the popup is waiting on.
  accounts.signingIn.add('codex');
  await send(accounts.snapshot());
  assert.equal(await card.locator('.ring-fault-btn').innerText(), 'Waiting for sign-in…');
  gate.dispose();
  assert.deepEqual(errors, []);
  console.log('Rail fault: red ring, shared text, and the fixCli button for signed-out and expired sign-ins; screenshots in out/rail-fault.');
} finally {
  await browser.close();
}
