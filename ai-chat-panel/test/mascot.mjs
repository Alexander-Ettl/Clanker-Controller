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
  await page.addInitScript(() => {
    window.sent = []; window.notes = []; window.audioCreated = 0;
    window.acquireVsCodeApi = () => ({ postMessage(message) { window.sent.push(message); }, getState: () => ({}), setState() {} });
    Math.random = () => 0;
    window.AudioContext = class {
      constructor() { window.audioCreated++; this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      createOscillator() { return { frequency: { setValueAtTime(value) { window.notes.push(value); } }, connect(value) { return value; }, disconnect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(value) { return value; }, disconnect() {} }; }
    };
  });
  await page.goto(origin);
  const empty = page.locator('#transcript > .empty-state');
  await empty.locator('.clanker-rig').waitFor();
  await page.waitForFunction(() => !document.querySelector('.empty-state').classList.contains('mascot-paused'));
  const header = await page.locator('.topbar').innerHTML();
  const chassis = page.locator('.clanker-chassis-rig');
  assert.equal(await chassis.evaluate(el => getComputedStyle(el).transform), 'none');
  assert.equal(await page.locator('.clanker-rig').evaluate(el => Math.round(el.getBoundingClientRect().width)), 140);
  await page.mouse.move(999, 719);
  await page.waitForFunction(() => document.querySelector('.clanker-face-rig').style.transform.includes('11px'));
  assert.equal(await page.locator('.clanker-face-rig').evaluate(el => el.style.transform), 'translate(11px, 7.5px)');
  assert.equal(await chassis.evaluate(el => getComputedStyle(el).transform), 'none');
  await page.waitForFunction(() => document.querySelector('.empty-state').classList.contains('mascot-blinking'), { timeout: 7000 });
  assert.equal(await page.evaluate(() => window.audioCreated), 0);
  const input = page.locator('#promptInput');
  await input.focus();
  assert.equal(await empty.getAttribute('data-mascot'), 'focus');
  await input.pressSequentially('Design');
  assert.equal(await empty.getAttribute('data-mascot'), 'typing');
  await input.pressSequentially(' ');
  assert.equal(await empty.getAttribute('data-mascot'), 'thinking');
  assert.equal(await chassis.evaluate(el => getComputedStyle(el).transform), 'none');
  assert.equal(await page.locator('.clanker-scanline').evaluate(el => getComputedStyle(el).animationName), 'clanker-scan');

  // Pause typing with text -> should stay in thinking state
  await input.fill('Write an Astro component');
  await page.waitForTimeout(800);
  assert.equal(await empty.getAttribute('data-mascot'), 'thinking');
  assert.equal(await page.locator('.clanker-scanline').evaluate(el => getComputedStyle(el).animationName), 'clanker-scan');

  // Voice dictation listening test
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'micState', state: 'recording' } })));
  assert.equal(await empty.getAttribute('data-mascot'), 'listening');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'micState', state: 'idle' } })));
  assert.notEqual(await empty.getAttribute('data-mascot'), 'listening');

  await empty.locator('[data-mascot-action="mention"]').click();
  assert.equal(await empty.getAttribute('data-mascot'), 'mention');
  assert.match(await input.inputValue(), /@/);
  await empty.locator('[data-mascot-action="action"]').click();
  assert.equal(await empty.getAttribute('data-mascot'), 'action');
  await empty.locator('[data-mascot-action="image"]').click();
  assert.equal(await empty.getAttribute('data-mascot'), 'image');
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'pickAttachments').length), 1);
  await page.locator('#modelPill').click();
  assert.equal(await empty.getAttribute('data-mascot'), 'model');
  await page.locator('.model-option[data-model-id="gpt-6.1-sol-high"]').click();
  assert.equal(await page.evaluate(() => window.audioCreated), 0);
  assert.equal(await page.locator('.topbar').innerHTML(), header);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.model-menu')).opacity === '0');
  if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], 'mascot-empty.png') });
  await input.fill('Launch the design task');
  await input.press('Enter');
  assert.equal(await empty.count(), 0, JSON.stringify({ messages: await page.evaluate(() => window.sent), errors }));
  assert.equal(await page.locator('.empty-state.is-launching').count(), 1);
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'send').length), 1);
  assert.deepEqual(await page.evaluate(() => window.notes), [523.25, 659.25, 783.99, 1046.50]);
  await page.locator('.empty-state.is-launching').waitFor({ state: 'detached' });
  await page.mouse.move(20, 20);
  assert.equal(await page.locator('.clanker-rig').count(), 0);
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  await send({ type: 'chatLoaded', chat: { id: 'fresh', modelId: 'auto', messages: [] } });
  assert.equal(await empty.locator('.clanker-rig').count(), 1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await input.fill('Send with reduced motion');
  await page.locator('#sendBtn').click();
  assert.equal(await page.locator('.is-launching').evaluate(el => getComputedStyle(el).opacity), '0');
  assert.equal(await page.locator('.is-launching .empty-mark').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.locator('.empty-state.is-launching').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.notes.length), 8);
  await send({ type: 'chatLoaded', chat: { id: 'history', modelId: 'auto', messages: [{ role: 'user', text: 'Previous task' }, { role: 'assistant', text: 'Done', agent: 'codex' }] } });
  assert.equal(await page.locator('.clanker-rig').count(), 0);
  assert.equal(await page.locator('.topbar').innerHTML(), header);
  assert.deepEqual(errors, []);
  console.log('Clanker mascot: stable chassis, clamped gaze, blink, typing/scan, chips, model, launch-only audio, Enter/Send, restore and reduced motion passed.');
} finally {
  await browser.close();
}
