import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// The pending pill reads "Thinking" while the model works and "Timer" while it only waits on a running tool.
// SHOT_DIR=<folder> saves screenshots of both states.
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
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'claude' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 420 } });
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
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} });
  });
  await page.goto(origin);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const label = page.locator('.msg-pending .pending-label');
  const time = page.locator('.msg-pending .pending-time');
  const shot = async name => { if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOT_DIR, name) }); } };

  await send({ type: 'chatLoaded', chat: { id: 'timer-chat', modelId: 'auto', messages: [] } });
  await send({ type: 'routing', agentId: 'claude' });

  // Real work: Thinking.
  await send({ type: 'tool_start', name: 'Read', command: 'README.md', toolId: 'r1' });
  await label.waitFor();
  assert.equal(await label.textContent(), 'Thinking');
  await send({ type: 'tool_end', toolId: 'r1', output: 'ok' });

  // A shell that does work after its sleep is still work.
  await send({ type: 'tool_start', name: 'Bash', command: 'sleep 5 && npm test', toolId: 'b0' });
  assert.equal(await label.textContent(), 'Thinking');
  await send({ type: 'tool_end', toolId: 'b0', output: '' });

  // A Monitor that sleeps 240s: a countdown.
  await send({ type: 'tool_start', name: 'Monitor', command: 'sleep 240; cat /c/Users/user/AppData/Local/Temp/out.log', toolId: 'm1' });
  assert.equal(await label.textContent(), 'Timer');
  await page.waitForFunction(() => /^3m 5\ds$|^4m$/.test(document.querySelector('.msg-pending .pending-time').textContent), null, { timeout: 4000 });
  await shot('timer-countdown.png');
  await send({ type: 'tool_end', toolId: 'm1', output: 'done' });
  assert.equal(await label.textContent(), 'Thinking', 'a finished wait is Thinking again');

  // A Monitor with no known duration counts up; a bare sleep in PowerShell form counts down.
  await send({ type: 'tool_start', name: 'Monitor', command: 'until grep -q done out.log; do sleep 5; done', toolId: 'm2' });
  assert.equal(await label.textContent(), 'Timer');
  assert.equal(await page.evaluate(() => document.querySelector('.tool-card.is-running').dataset.waitSecs), undefined);
  await page.waitForFunction(() => /^[1-9]s$/.test(document.querySelector('.msg-pending .pending-time').textContent), null, { timeout: 4000 });
  await shot('timer-countup.png');
  await send({ type: 'tool_end', toolId: 'm2', output: '' });

  await send({ type: 'tool_start', name: 'Bash', command: 'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90"', toolId: 'b1' });
  assert.equal(await label.textContent(), 'Timer');
  assert.equal(await page.evaluate(() => document.querySelector('.tool-card.is-running').dataset.waitSecs), '90');
  await send({ type: 'tool_end', toolId: 'b1', output: '' });
  assert.deepEqual(errors, []);
  console.log('pending timer ok');
} finally {
  await browser.close();
}
