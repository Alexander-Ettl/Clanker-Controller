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
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'gemini' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  for (const width of [900, 380]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
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
    const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    const event = { type: 'question_required', agent: 'gemini', actionId: 'step-2', deferred: true, modelId: 'gemini-3.8-flash-high', questions: [{ question: 'Pick A or B?', options: [{ label: 'A' }, { label: 'B (Recommended)' }] }, { question: 'Extras?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }] };
    const chat = { id: 'agy-question-chat', messages: [{ role: 'user', text: 'Ask me' }, { role: 'assistant', text: '', agent: 'gemini', at: new Date().toISOString() }, { role: 'tool', event, offset: 0, done: true }] };
    await send({ type: 'chatLoaded', chat: { ...chat, messages: chat.messages.slice(0, 1) } });
    await send({ type: 'routing', agentId: 'gemini', modelLabel: 'Gemini' });
    await send(event);
    await send({ type: 'turn_complete', agent: 'gemini' });
    assert.equal(await page.locator('.question-card.resolved').count(), 0, 'ending the AGY turn leaves its question answerable');
    await page.locator('.question-submit').waitFor({ state: 'visible' });
    await send({ type: 'chatLoaded', chat });
    const card = page.locator('.question-card');
    await card.waitFor({ state: 'visible' });
    assert.equal(await card.locator('.question-text').count(), 2);
    await send({ type: 'setActive', modelId: 'gpt-6.1-sol-high' });
    await card.locator('[data-label="B (Recommended)"]').click();
    await card.locator('[data-label="X"]').click();
    await card.locator('[data-label="Y"]').click();
    fs.mkdirSync('out', { recursive: true });
    await page.screenshot({ path: `out/agy-question-${width}.png` });
    await card.locator('.question-submit').click();
    const sent = await page.evaluate(() => window.sent);
    const settlement = sent.findLast(message => message.type === 'deferredQuestionSettled');
    assert.ok(settlement);
    assert.deepEqual(settlement.answers, { 'Pick A or B?': 'B (Recommended)', 'Extras?': 'X, Y' });
    assert.equal(sent.filter(message => message.type === 'send' || message.type === 'queueTurn').length, 0, 'the host dispatches the answer atomically');
    event.settled = settlement.settled;
    await send({ type: 'chatLoaded', chat });
    assert.equal(await page.locator('.question-card.resolved').count(), 1, 'resolved cards survive reload');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('AGY question UI: restored cards, multiple choice, pinned model, answers and settlements pass at 900/380px.');
} finally { await browser.close(); }
