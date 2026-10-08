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
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
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

  const draftInput = page.locator('#promptInput');
  await send({ type: 'chatLoaded', chat: { id: 'draft-chat', messages: [], draft: 'Stored unsent text' } });
  assert.equal(await draftInput.inputValue(), 'Stored unsent text');
  await draftInput.fill('Edited unsent text');
  assert.deepEqual(await page.evaluate(() => window.sent.filter(item => item.type === 'saveDraft').at(-1)), { type: 'saveDraft', chatId: 'draft-chat', text: 'Edited unsent text' });
  await send({ type: 'chatLoaded', chat: { id: 'other-chat', messages: [], draft: 'Other stored text' } });
  assert.deepEqual(await page.evaluate(() => window.sent.filter(item => item.type === 'saveDraft').at(-1)), { type: 'saveDraft', chatId: 'other-chat', text: 'Other stored text' });
  await send({ type: 'chatLoaded', chat: { id: 'draft-chat', messages: [], draft: 'Stored unsent text' } });
  assert.equal(await draftInput.inputValue(), 'Edited unsent text');
  await draftInput.fill('');
  assert.equal(await page.evaluate(() => window.sent.filter(item => item.type === 'saveDraft').at(-1).text), '');
  await send({ type: 'chatLoaded', chat: { id: 'queue-chat', modelId: 'auto', messages: [], turnQueue: { turns: [], paused: true } } });
  const image = { path: '/attachments/qt.png', name: 'qt.png', mimeType: 'image/png', uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZL8AAAAASUVORK5CYII=' };
  const turns = [
    { id: 'qt', text: 'Qt picture task', modelId: 'gpt-6.1-sol-high', attachments: [image.path], files: [image] },
    { id: 'other', text: 'Separate task', modelId: 'auto', attachments: [], files: [] },
  ];
  await send({ type: 'turnQueue', chatId: 'queue-chat', turns, paused: true });
  const input = page.locator('#promptInput');
  await input.fill('Unsent composer draft');
  const edit = id => page.locator('.turn-queue-item[data-id="' + id + '"]').getByRole('button', { name: 'Move back into the composer' }).click();
  await edit('qt');
  assert.equal(await input.inputValue(), 'Qt picture task');
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 1);
  await input.fill('Qt picture task edited');
  await edit('other');
  assert.equal(await input.inputValue(), 'Separate task');
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 0);
  const savedQt = await page.evaluate(() => window.sent.filter(item => item.type === 'editQueuedTurn' && item.turn.id === 'qt' && !item.editing).at(-1));
  assert.equal(savedQt.turn.text, 'Qt picture task edited');
  assert.deepEqual(savedQt.turn.attachments, [image.path]);
  assert.equal(savedQt.turn.modelId, 'gpt-6.1-sol-high');
  await input.fill('Separate task edited');
  await edit('qt');
  assert.equal(await input.inputValue(), 'Qt picture task edited');
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 1);
  const savedOther = await page.evaluate(() => window.sent.filter(item => item.type === 'editQueuedTurn' && item.turn.id === 'other' && !item.editing).at(-1));
  assert.equal(savedOther.turn.text, 'Separate task edited');
  assert.deepEqual(savedOther.turn.attachments, []);
  await input.press('Enter');
  assert.equal(await input.inputValue(), 'Unsent composer draft', 'the unrelated draft is restored separately');
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 0);
  assert.equal(await page.evaluate(() => window.sent.filter(item => item.type === 'queueTurn' || item.type === 'removeQueuedTurn').length), 0, 'edits never remove/reappend queue entries');

  await send({ type: 'restoreScheduledDraft', taskId: 'scheduled-qt', text: 'Scheduled Qt', modelId: 'gpt-6.1-sol-high', files: [image] });
  await input.fill('Scheduled Qt edited');
  await send({ type: 'restoreScheduledDraft', taskId: 'scheduled-other', text: 'Scheduled other', modelId: 'auto', files: [] });
  assert.equal(await input.inputValue(), 'Scheduled other');
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 0);
  const savedSchedule = await page.evaluate(() => window.sent.filter(item => item.type === 'saveScheduledDraft' && item.taskId === 'scheduled-qt' && !item.editing).at(-1));
  assert.equal(savedSchedule.turn.text, 'Scheduled Qt edited');
  assert.deepEqual(savedSchedule.turn.attachments, [image.path]);
  await input.fill('Scheduled other edited');
  await page.locator('#sendBtn').click();
  assert.equal(await input.inputValue(), 'Unsent composer draft');
  await send({ type: 'turnQueue', chatId: 'queue-chat', turns, paused: true });
  await edit('other');
  await input.fill('Schedule the edited task');
  await page.locator('#scheduleBtn').click();
  await page.locator('#sendBtn').click();
  const converted = await page.evaluate(() => window.sent.filter(item => item.type === 'scheduleQueuedTurn').at(-1));
  assert.equal(converted.id, 'other');
  assert.equal(converted.turn.text, 'Schedule the edited task');
  assert.equal(converted.task.dispatchTrigger, 'quota-reset');

  const limit = { role: 'assistant', agent: 'claude', text: 'I was checking the code. '.repeat(25) + "\nYou've hit your session limit · resets 2:10pm" };
  await send({ type: 'chatLoaded', chat: { id: 'queue-chat', modelId: 'claude-sonnet-5-5-high', messages: [{ role: 'user', text: 'Original task' }, limit] } });
  assert.equal(await page.locator('.continue-at-reset').count(), 1, 'partial replies also offer Continue after reload');
  await send({ type: 'schedulerQueue', queue: [{ id: 'continued', chatId: 'queue-chat', model: 'claude', prompt: 'continue', status: 'pending', dispatchTrigger: 'quota-reset', attachments: [] }] });
  assert.equal(await page.locator('.continue-at-reset').count(), 0);
  await send({ type: 'schedulerQueue', queue: [] });
  await send({ type: 'chatLoaded', chat: { id: 'queue-chat', modelId: 'claude-sonnet-5-5-high', messages: [{ role: 'user', text: 'Original task' }, limit, { role: 'user', text: 'continue', scheduled: true }] } });
  assert.equal(await page.locator('.continue-at-reset').count(), 0, 'a sent Continue remains suppressed after restart');
  await send({ type: 'queueUsageWarning', chatId: 'queue-chat', id: 'other', agent: 'claude', text: 'Claude is out of usage. The prompt is still queued.' });
  await send({ type: 'queueUsageWarning', chatId: 'queue-chat', id: 'other', agent: 'claude', text: 'Claude is out of usage. The prompt is still queued.' });
  assert.equal(await page.locator('.queue-usage-warning').count(), 1, 'retry warnings do not stack');
  await page.getByRole('button', { name: 'Schedule at reset', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sent.filter(item => item.type === 'scheduleQueuedTurn').at(-1).id), 'other');
  assert.deepEqual(errors, []);
  console.log('Queue editor UI: separate prompts, edited text/model/images, original slots, saved edits, scheduled switching and independent composer draft passed.');
} finally {
  await browser.close();
}
