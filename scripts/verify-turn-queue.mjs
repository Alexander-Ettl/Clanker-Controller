import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

fs.mkdirSync(new URL('../out/', import.meta.url), { recursive: true });

const require = createRequire(import.meta.url);
const { ChatStore } = require('../ai-chat-panel/lib/chat-store');
require('../ai-chat-panel/test/model-fixture').seedModels();
class Engine extends EventEmitter {
  runs = [];
  start(run) { this.runs.push(run); this.running = true; }
  interrupt() { if (this.running) this.complete(true); }
  complete(interrupted = false) { this.running = false; this.emit('event', { type: 'turn_complete', interrupted }); }
  dispose() {}
}
const uri = file => ({ fsPath: file, toString: () => file });
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(String(base), ...parts)) }, workspace: { findFiles: async () => [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
  if (request === './lib/stream-engine.js') return { StreamEngine: Engine };
  if (request === './lib/quota-bridge.js') return { readQuotas: async () => ({ claude: { remaining: 100 }, codex: { remaining: 100 }, gemini: { remaining: 100 } }) };
  return load.call(this, request, parent, isMain);
};
const { ChatWindowManager, ChatWindowHost } = require('../ai-chat-panel/extension');
Module._load = load;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-queue-ui-'));
const media = fileURLToPath(new URL('../ai-chat-panel/media/', import.meta.url));
const deps = { sessionDir: dir, attachmentsDir: dir, workspaceDir: dir, chatStore: new ChatStore(dir), getModels: () => ({}), getPermissionMode: () => 'fullAccess', notifyHistory() {} };
const manager = new ChatWindowManager('/panel', deps);
const makeChat = () => manager.runFor(deps.chatStore.save({ ...deps.chatStore.create(), title: 'Queue test', modelId: 'gpt-6.1-sol-high' }).id);
const run = makeChat(), other = makeChat();
const host = Object.create(ChatWindowHost.prototype);
let html;
const server = http.createServer((request, response) => {
  if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
  const file = path.resolve(media, '.' + decodeURIComponent(request.url.split('?')[0]));
  if (!file.startsWith(media) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const errors = [], messages = [];
  page.on('pageerror', error => errors.push(error.message));
  Object.assign(host, { extensionUri: '/panel', deps: { ...deps, chatWindowManager: manager }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex', panel: { webview: { cspSource: base, asWebviewUri: uri => base + '/' + path.relative('/panel/media', uri.fsPath).replaceAll('\\', '/'), postMessage: message => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message) }, title: '' } });
  html = host.renderHtml(host.panel.webview);
  await page.exposeBinding('sendToHost', async (_source, message) => { messages.push(message); await host.handleMessage(message); });
  await page.addInitScript(() => {
    window.saved = {};
    window.acquireVsCodeApi = () => ({ postMessage: message => { void window.sendToHost(message); }, getState: () => window.saved, setState: state => { window.saved = state; } });
  });
  await page.goto(base);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  host.attach(run);
  await page.waitForFunction(() => document.querySelector('#modelPill').textContent.includes('Sol'));
  const send = async text => { await page.locator('#promptInput').fill(text); await page.locator('#promptInput').press('Enter'); };
  await send('First task');
  await page.locator('#stopBtn').waitFor({ state: 'visible' });
  await send('Second task'); await send('Third task');
  await page.waitForFunction(() => document.querySelectorAll('.turn-queue-item').length === 2);
  await page.getByRole('button', { name: 'Pause queue', exact: true }).click();
  await page.getByRole('button', { name: 'Resume queue', exact: true }).waitFor();
  assert.equal(run.queuePaused, true);
  assert.equal(run.streamEngine.runs.length, 1);
  assert.equal(await page.locator('.queue-transport svg').count(), 1);
  await page.screenshot({ path: fileURLToPath(new URL('../out/turn-queue-paused.png', import.meta.url)) });
  host.attach(other);
  run.streamEngine.complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.streamEngine.runs.length, 1, 'manual pause remains in the background');
  host.attach(run);
  await page.getByRole('button', { name: 'Resume queue', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Resume queue', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Pause queue', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.turn-queue-item').length === 1);
  assert.equal(run.streamEngine.runs.length, 2);
  assert.equal(await page.locator('.queue-transport').evaluate(node => node === document.activeElement), true, 'keyboard focus survives the host acknowledgement');
  assert.equal(await page.locator('.msg-user-text').filter({ hasText: 'Second task' }).count(), 1);
  await page.setViewportSize({ width: 480, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: fileURLToPath(new URL('../out/turn-queue-running.png', import.meta.url)) });
  host.attach(other); host.attach(run); host.attach(other);
  run.streamEngine.complete();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.streamEngine.runs.length, 3, 'queued task starts while a different chat is shown');
  run.streamEngine.complete();
  host.attach(run);
  await page.locator('.turn-queue-strip').waitFor({ state: 'hidden' });
  assert.deepEqual(run.chat.messages.filter(message => message.role === 'user').map(message => message.text), ['First task', 'Second task', 'Third task']);
  assert.equal(messages.filter(message => message.type === 'send').length, 1, 'the UI never redispatches a host-owned queued turn');
  assert.deepEqual(errors, []);
  console.log('Turn queue UI: pause/play, keyboard focus, chat switching, background execution, and 480px layout passed.');
} finally {
  clearTimeout(manager.openTimer);
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
