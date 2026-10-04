import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { EventEmitter: class { event = () => ({ dispose() {} }); fire() {} } };
  return originalLoad.call(this, request, parent, isMain);
};
const { buildHtml } = require(resolve(process.env.VISOR_DIR || fileURLToPath(new URL('../../Visor/', import.meta.url)), 'vscode-extension/out/webviewPanel.js'));
Module._load = originalLoad;

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.sent.push(message) });
  });
  await page.route('http://localhost:4321/**', route => route.fulfill({ contentType: 'text/html', body: '<script>window.received=[];addEventListener("message",e=>received.push(e.data));</script>' }));
  await page.goto(`data:text/html,${encodeURIComponent(buildHtml('http://localhost:4321'))}`);
  const receive = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  await receive({ type: 'astro-editor:start-result', online: true });
  await page.waitForFunction(() => document.querySelector('iframe').getAttribute('src'));
  const frame = page.frames().find(frame => frame.url().startsWith('http://localhost:4321')) || await page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith('http://localhost:4321') });
  await frame.waitForFunction(() => Array.isArray(window.received));
  const prompt = { type: 'astro-editor:route-prompts', requestId: '42', prompts: ['Fix src/pages/about.astro heading, rect 200x40: make it smaller'], fallbackPrompt: 'retry' };
  for (const message of [prompt, { type: 'astro-editor:request-models' }, { type: 'astro-editor:set-routing-mode', mode: 'auto' }, { type: 'astro-editor:dispatch-batch', phases: [] }, { type: 'astro-editor:run-next-batch-in-clean-session', batchPrompt: 'phase' }, { type: 'astro-editor:voice-toggle' }, { type: 'astro-editor:voice-cancel' }]) {
    await frame.evaluate(message => parent.postMessage(message, '*'), message);
    await page.waitForFunction(type => window.sent.some(message => message.type === type), message.type);
    assert.deepEqual((await page.evaluate(() => window.sent)).at(-1), message);
  }
  for (const message of [{ type: 'astro-editor:models', models: [{ id: 'codex-high', label: 'Codex High', agent: 'codex' }] }, { type: 'astro-editor:routing-mode', mode: 'auto', connected: { cloudflare: true, groq: false } }, { type: 'astro-editor:route-result', requestId: '42', sent: true }, { type: 'astro-editor:voice-state', state: 'recording' }, { type: 'astro-editor:voice-audio', audioBase64: 'd2F2', mimeType: 'audio/wav' }, { type: 'astro-editor:voice-error', error: 'No microphone' }]) {
    await receive(message);
    await frame.waitForFunction(type => window.received.some(message => message.type === type), message.type);
    assert.deepEqual((await frame.evaluate(() => window.received)).at(-1), message);
  }
  const count = await page.evaluate(() => window.sent.length);
  await page.evaluate(prompt => window.dispatchEvent(new MessageEvent('message', { source: document.querySelector('iframe').contentWindow, origin: 'https://client.example', data: prompt })), prompt);
  assert.equal(await page.evaluate(() => window.sent.length), count, 'foreign origins cannot submit editor commands');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }

// Exercise the real provider method without starting any CLI or sending a real task.
const source = readFileSync(new URL('../ai-chat-panel/extension.js', import.meta.url), 'utf8');
const method = source.slice(source.indexOf('  async routePrompt('), source.indexOf('  /** A scheduled task bound to a chat'));
const routePrompt = vm.runInNewContext(`(${method.trim().replace('async routePrompt(', 'async function (')})`, { MODEL_CATALOG: [{ id: 'codex-high', label: 'Codex High', agent: 'codex' }] });
const chats = [], runs = new Map(), opened = [];
const manager = {
  deps: { chatStore: { create: () => ({ id: String(chats.length + 1) }), save: chat => { chats.push(chat); return chat; } }, notifyHistory() {} },
  runFor(id) { if (!runs.has(id)) runs.set(id, { queue: [], enqueue(message) { this.queue.push(message); } }); return runs.get(id); },
  open(id, options) { opened.push({ id, options }); },
};
for (const text of ['Fix heading in about.astro', 'Fix spacing in home.astro']) assert.equal(await routePrompt.call(manager, text, { newChat: true }), true);
assert.equal(chats.length, 2);
assert.equal(new Set(chats.map(chat => chat.id)).size, 2);
assert.ok(chats.every(chat => chat.modelId === 'auto'));
assert.equal(runs.get('1').queue[0].text, 'Fix heading in about.astro');
assert.equal(runs.get('2').queue[0].modelId, 'auto');
assert.ok(opened.every(entry => entry.options.preserveFocus));
assert.equal(await routePrompt.call(manager, 'Use my chosen model', { newChat: true, targetModel: 'codex-high' }), true);
assert.equal(chats[2].modelId, 'codex-high');
assert.equal(runs.get('3').queue[0].modelId, 'codex-high');
await assert.rejects(routePrompt.call(manager, 'Removed model', { newChat: true, targetModel: 'removed' }), /no longer available/);
assert.equal(chats.length, 3, 'removed models cannot create a chat');
console.log('Visor bridge: iframe forwarding, favorites, delivery replies, voice, origin guard, Auto and selected-model chats passed.');
