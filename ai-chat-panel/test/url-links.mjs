import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// URLs in agent replies (bare, in backticks, or as [label](url)) render as links and open through the host.
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
const reply = [
  '### Mockup link',
  '',
  'Open `http://192.168.1.50:5180/glass/index.html` from any device on your network, or `http://127.0.0.1:5180/glass/index.html` on this PC. Plain: http://localhost:3000/app, and [a label](https://example.com/docs).',
  '',
  'Not a link: `npm run dev` and `<img src="x" onerror="alert(1)">`.',
].join('\n');
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 520 } });
  const errors = [];
  const sent = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(media, '.' + pathname);
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.exposeFunction('__sent', message => sent.push(message));
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage: message => window.__sent(message), getState: () => ({}), setState() {} });
  });
  await page.goto(origin);
  await page.locator('.topbar-actions').waitFor();
  await page.evaluate(text => window.postMessage({ type: 'chatLoaded', chat: { id: 'c1', messages: [{ role: 'user', text: 'link?' }, { role: 'assistant', text }] } }, '*'), reply);
  await page.locator('.msg-assistant a').first().waitFor();
  const links = await page.locator('.msg-assistant a').evaluateAll(list => list.map(a => ({ href: a.getAttribute('href'), code: Boolean(a.querySelector('code')) })));
  assert.deepEqual(links, [
    { href: 'http://192.168.1.50:5180/glass/index.html', code: true },
    { href: 'http://127.0.0.1:5180/glass/index.html', code: true },
    { href: 'http://localhost:3000/app', code: false },
    { href: 'https://example.com/docs', code: false },
  ]);
  assert.equal(await page.locator('.msg-assistant img').count(), 0);
  await page.locator('.msg-assistant a.code-link').first().click();
  await page.locator('.msg-assistant a.code-link').nth(1).click();
  assert.deepEqual(sent.filter(m => m.type === 'openUrl').map(m => m.url), ['http://192.168.1.50:5180/glass/index.html', 'http://127.0.0.1:5180/glass/index.html']);
  assert.deepEqual(errors, []);
  if (process.argv[2]) await page.locator('.msg-assistant').first().screenshot({ path: path.join(process.argv[2], 'url-links.png') });
  console.log('url links ok:', links.length);
} finally {
  await browser.close();
}
