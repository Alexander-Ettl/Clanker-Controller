import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
require('../ai-chat-panel/test/model-fixture').seedModels();
const uri = file => ({ fsPath: file, toString: () => file });
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(String(base), ...parts)) }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
  return originalLoad.call(this, request, parent, isMain);
};
const { ChatWindowHost } = require('../ai-chat-panel/extension');
Module._load = originalLoad;
const media = path.resolve(fileURLToPath(new URL('../ai-chat-panel/media/', import.meta.url)));
const origin = 'http://clanker.test';
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(media, '.' + pathname);
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
  await page.goto(origin);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const chat = { id: 'compaction-test', modelId: 'gpt-6.1-sol-high', messages: [
    { role: 'user', text: 'Keep working on the design.', at: new Date().toISOString() },
    { role: 'assistant', text: 'The design is ready.', agent: 'codex', at: new Date().toISOString() },
  ] };
  await send({ type: 'chatLoaded', chat });
  await send({ type: 'compacting', auto: true });
  await send({ type: 'routing', agentId: 'codex', compact: true });
  const active = page.locator('.compact-divider.is-compacting');
  await active.waitFor();
  await page.waitForFunction(() => document.querySelector('.compact-divider.is-compacting.is-visible'));
  assert.equal(await active.innerText(), 'Thinking · compacting context');
  assert.equal(await page.locator('.msg-pending').count(), 0);
  await send({ type: 'thought', text: 'Hidden checkpoint thinking' });
  await send({ type: 'delta', text: 'Hidden checkpoint summary' });
  assert.equal(await page.getByText('Hidden checkpoint summary').count(), 0);
  assert.equal(await page.locator('.msg-pending').count(), 0);
  assert.equal(await active.locator('.compact-thinking i').count(), 3);
  assert.equal(await active.locator('svg path').first().evaluate(el => getComputedStyle(el).animationName), 'compact-gather-top');
  assert.equal(await active.locator('svg path').first().evaluate(el => getComputedStyle(el).animationPlayState), 'running');
  if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], 'compaction-active.png') });
  await send({ type: 'turn_complete' });
  assert.equal(await page.locator('.compact-divider').innerText(), 'Context auto-compacted');
  assert.equal(await active.count(), 0);
  assert.equal(await page.locator('.compact-thinking:visible').count(), 0);
  assert.equal(await page.locator('.msg-pending').count(), 0);
  assert.equal(await page.locator('.compact-divider svg path').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], 'compaction-complete.png') });
  const compactChat = { ...chat, messages: [...chat.messages, { role: 'user', text: 'Auto-compact', compact: true, auto: true }, { role: 'assistant', text: '', compact: true, agent: 'codex' }] };
  await send({ type: 'chatLoaded', chat: compactChat, running: { compact: true, agentId: 'codex', startedAt: Date.now() } });
  assert.equal(await active.count(), 1);
  assert.equal(await page.locator('.msg-pending').count(), 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await active.locator('svg path').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  await send({ type: 'turn_complete', interrupted: true });
  assert.equal(await page.locator('.compact-divider').innerText(), 'Context compaction interrupted');
  await send({ type: 'chatLoaded', chat: compactChat });
  assert.equal(await page.locator('.compact-divider').innerText(), 'Context auto-compacted');
  assert.equal(await active.count(), 0);
  await send({ type: 'chatLoaded', chat: { ...chat, messages: [...chat.messages, { role: 'user', text: 'Continue.' }] }, running: { agentId: 'codex', startedAt: Date.now() } });
  await page.locator('.msg-pending').waitFor();
  await send({ type: 'turn_complete' });
  await send({ type: 'compacting', auto: false });
  await send({ type: 'delta', text: 'Codex error: test failure' });
  await send({ type: 'turn_complete' });
  assert.equal(await page.locator('.compact-divider').last().innerText(), 'Context compaction failed');
  assert.deepEqual(errors, []);
  console.log('Compaction status: live thinking, completion, restore, interruption, failure, reduced motion and normal thinking passed.');
} finally {
  await browser.close();
}
