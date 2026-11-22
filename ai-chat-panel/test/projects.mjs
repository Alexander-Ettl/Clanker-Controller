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
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
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

  const projectA = { id: 'a', name: 'Portfolio', root: 'C:/Cloud/Portfolio' };
  const projectB = { id: 'b', name: 'Extension development', root: 'D:/Code/Extension' };
  const chatA = { id: 'chat-a', projectId: 'a', messages: [], turnQueue: { turns: [], paused: false } };
  const chatB = { id: 'chat-b', projectId: 'b', messages: [], turnQueue: { turns: [], paused: false } };
  await send({ type: 'chatLoaded', chat: chatA });
  await send({ type: 'project', project: projectA, required: false });
  assert.equal(await page.locator('.project-picker').innerText(), 'Portfolio');
  await page.locator('.project-picker').click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'chooseProject')), true);
  await page.getByRole('button', { name: 'Open project in Explorer' }).click();
  assert.equal(await page.evaluate(() => window.sent.some(message => message.type === 'openProjectExplorer')), true);
  const input = page.locator('#promptInput');
  await input.fill('Portfolio unsent draft');
  const image = { path: '/projects/a/attachments/picture.png', name: 'picture.png', mimeType: 'image/png', uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZL8AAAAASUVORK5CYII=' };
  await send({ type: 'attachmentSaved', attachment: image });
  await send({ type: 'chatLoading' });
  await send({ type: 'chatLoaded', chat: chatB });
  await send({ type: 'project', project: projectB, required: false });
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 0);
  assert.equal(await page.locator('.project-picker').innerText(), 'Extension development');
  await send({ type: 'attachmentSaved', chatId: 'chat-a', attachment: { ...image, path: '/projects/a/attachments/late.png', name: 'late.png' } });
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 0, 'a late attachment stays with its original chat');
  await input.fill('Extension unsent draft');
  await send({ type: 'chatLoaded', chat: chatA });
  await send({ type: 'project', project: projectA, required: false });
  assert.equal(await input.inputValue(), 'Portfolio unsent draft');
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 2);
  await send({ type: 'chatLoaded', chat: chatB });
  await send({ type: 'project', project: projectB, required: false });
  assert.equal(await input.inputValue(), 'Extension unsent draft');
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 0);
  await send({ type: 'project', project: null, required: true });
  assert.equal(await page.locator('.project-picker').innerText(), 'Choose project');
  assert.equal(await page.getByRole('button', { name: 'Open project in Explorer' }).isVisible(), false);
  await send({ type: 'project', project: { id: 'planning', name: 'Research', root: null }, required: false });
  assert.equal(await page.locator('.project-picker').innerText(), 'Research');
  await send({ type: 'project', project: projectB, required: false });
  const recovered = { id: 'recovered', messages: [
    { role: 'user', text: 'Recover my interrupted task', at: '2026-10-04T09:51:00Z' },
    { role: 'assistant', agent: 'codex', modelLabel: 'Codex', text: 'The first progress update.\n\nThe second progress update.', interrupted: true, interruptionReason: 'host_shutdown', at: '2026-10-04T10:13:00Z' },
    { role: 'tool', event: { name: 'shell', command: 'node check.js', toolId: 'saved-tool', output: 'Checks passed' }, offset: 'The first progress update.'.length, done: true },
    { role: 'tool', event: { name: 'shell', command: 'node unfinished.js', toolId: 'unfinished' }, offset: 'The first progress update.'.length, done: false, interrupted: true },
  ], turnQueue: { turns: [{ id: 'remaining', text: 'Next task', modelId: 'gpt-6.1-sol-high', attachments: [] }], paused: true } };
  await send({ type: 'chatLoaded', chat: recovered });
  await send({ type: 'project', project: projectB, required: false });
  assert.equal(await page.getByText('The first progress update.', { exact: true }).isVisible(), true);
  assert.equal(await page.getByText('The second progress update.', { exact: true }).isVisible(), true);
  await send({ type: 'chatLoaded', chat: { id: 'manual-selection', modelId: 'gpt-6.1-sol-high', messages: [] } });
  await send({ type: 'project', project: projectB, required: false });
  await page.locator('#modelPill').click();
  await page.locator('.model-option[data-model-id="claude-sonnet-5-5-high"]').click();
  await send({ type: 'attachmentSaved', chatId: 'manual-selection', attachment: image });
  await input.fill('Use Sonnet for this screenshot');
  await input.press('Enter');
  const submitted = await page.evaluate(() => window.sent.findLast(message => message.type === 'send'));
  assert.equal(submitted.modelId, 'claude-sonnet-5-5-high');
  assert.deepEqual(submitted.attachments, [image.path]);
  assert.equal(await page.locator('#modelPill').getAttribute('title'), 'Model: Claude Sonnet 5.5 High');
  await send({ type: 'turn_complete' });
  await send({ type: 'chatLoaded', chat: recovered });
  assert.equal(await page.locator('.chat-notice.is-interrupted').innerText(), 'Interrupted by IDE restart · Saved output restored');
  assert.equal(await page.locator('.tool-card.is-running').count(), 0, 'restored tools cannot appear to be still running');
  assert.equal(await page.locator('.tool-card.is-cancelled').count(), 1);
  await page.reload();
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  await send({ type: 'chatLoaded', chat: recovered });
  await send({ type: 'project', project: projectB, required: false });
  assert.equal(await page.getByText('The second progress update.', { exact: true }).isVisible(), true);
  if (process.argv[2]) { fs.mkdirSync(process.argv[2], { recursive: true }); await page.screenshot({ path: path.join(process.argv[2], 'projects.png') }); }
  assert.deepEqual(errors, []);
  console.log('Projects UI: project selection, Explorer action, separate drafts/images, interrupted history reload and manual Sonnet screenshot submission passed.');
} finally {
  await browser.close();
}
