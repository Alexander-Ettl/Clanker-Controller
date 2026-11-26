import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// A chat opened as an editor tab shows Find, Manage chats and New chat in its header; Scheduled and Loops stay out.
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
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 420 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(media, '.' + pathname);
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} });
  });
  await page.goto(origin);
  await page.locator('.topbar-actions').waitFor();
  // A scheduled prompt arriving must not bring the Queue pill back.
  await page.evaluate(() => window.postMessage({ type: 'schedulerQueue', tasks: [{ id: 't1', status: 'pending', prompt: 'x', model: 'codex', scheduledAt: Date.now() + 60000 }] }, '*'));
  await page.waitForTimeout(300);
  const visible = await page.locator('.topbar-actions button').evaluateAll(buttons => buttons.filter(b => b.getBoundingClientRect().width > 0).map(b => ({
    id: b.id,
    w: Math.round(b.getBoundingClientRect().width),
    h: Math.round(b.getBoundingClientRect().height),
    svgW: Math.round(b.querySelector('svg').getBoundingClientRect().width),
    svgH: Math.round(b.querySelector('svg').getBoundingClientRect().height),
  })));
  assert.deepEqual(visible, [
    { id: 'findBtn', w: 42, h: 42, svgW: 20, svgH: 20 },
    { id: 'historyBtn', w: 42, h: 42, svgW: 20, svgH: 20 },
    { id: 'newChatBtn', w: 42, h: 42, svgW: 20, svgH: 20 },
  ]);
  const bodyPad = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { left: cs.paddingLeft, right: cs.paddingRight, bottom: cs.paddingBottom };
  });
  assert.deepEqual(bodyPad, { left: '10px', right: '10px', bottom: '14px' });
  assert.deepEqual(errors, []);
  if (process.argv[2]) await page.locator('.topbar').screenshot({ path: path.join(process.argv[2], 'popout-header.png') });
  console.log('popout header ok:', visible.map(b => `${b.id}(${b.w}x${b.h})`).join(', '));
} finally {
  await browser.close();
}
