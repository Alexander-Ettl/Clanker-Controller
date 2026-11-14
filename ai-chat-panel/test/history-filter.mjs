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
const shotDir = fileURLToPath(new URL('../../out/screenshots/', import.meta.url));
fs.mkdirSync(shotDir, { recursive: true });
const origin = 'http://127.0.0.1';
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar: true }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });
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
  const projects = [
    { id: 'a', name: 'portfolio 2026', root: 'C:/Cloud/Portfolio' },
    { id: 'b', name: 'Visor', root: 'D:/Code/Visor' },
    { id: 'c', name: 'Clanker Controller', root: 'D:/Code/Clanker' },
  ];
  const day = n => new Date(Date.now() - n * 86400000).toISOString();
  const sessions = [
    { id: '1', projectId: 'a', title: 'Zebra layout', models: ['claude'], messageCount: 4, createdAt: day(5), updatedAt: day(0), lastMessage: { role: 'assistant', agent: 'claude', text: 'Done.' } },
    { id: '2', projectId: 'b', title: 'Alpha bridge', models: ['codex'], messageCount: 30, createdAt: day(9), updatedAt: day(1), lastMessage: { role: 'user', text: 'Ship it' } },
    { id: '3', projectId: 'c', title: 'Mid chat', models: ['claude', 'gemini'], messageCount: 12, createdAt: day(2), updatedAt: day(2), state: 'waiting', active: true, lastMessage: { role: 'assistant', agent: 'gemini', text: 'Which one?' } },
    { id: '4', title: 'No project chat', models: ['codex'], messageCount: 2, createdAt: day(20), updatedAt: day(20) },
  ];
  await send({ type: 'project', project: projects[0], projects, chatId: '1', required: false });
  await send({ type: 'history', sessions });
  await page.locator('#historyBtn').click();
  const titles = () => page.locator('#historyModal .history-title').allTextContents();
  const filterBtn = page.locator('.history-filter-btn');
  assert.equal(await filterBtn.isVisible(), true, 'Filter button shows beside the search');
  assert.equal(await page.locator('#historyFilterPanel').isHidden(), true);
  assert.equal((await titles()).length, 4);
  await filterBtn.click();
  assert.equal(await filterBtn.getAttribute('aria-expanded'), 'true');
  const shot = async name => { if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, name) }); };
  await shot('history-filter-open.png');
  const chip = text => page.locator('#historyFilterPanel .history-chip', { hasText: text });
  await chip('Visor').click();
  assert.deepEqual(await titles(), ['Alpha bridge'], 'project filter');
  assert.equal(await page.locator('.history-filter-badge').innerText(), '1');
  assert.equal(await page.locator('#historyModal .fs-modal-count').innerText(), '1 of 4');
  await chip('Visor').click();
  await chip('Codex').click();
  assert.deepEqual((await titles()).sort(), ['Alpha bridge', 'No project chat']);
  await chip('Codex').click();
  await chip('No project').click();
  assert.deepEqual(await titles(), ['No project chat']);
  await chip('No project').click();
  await chip('Needs input').click();
  assert.deepEqual(await titles(), ['Mid chat']);
  await chip('All').click();
  await chip('Title A–Z').click();
  assert.deepEqual(await titles(), ['Alpha bridge', 'Mid chat', 'No project chat', 'Zebra layout'], 'title sort is flat');
  await chip('Most messages').click();
  assert.deepEqual(await titles(), ['Alpha bridge', 'Mid chat', 'Zebra layout', 'No project chat']);
  await chip('Oldest').click();
  assert.equal((await titles())[0], 'No project chat');
  await chip('Newest').click();
  assert.equal((await titles())[0], 'Mid chat');
  await chip('Claude').click();
  await shot('history-filter-active.png');
  assert.equal(await page.locator('.history-filter-badge').innerText(), '2');
  await page.locator('.history-filter-reset').click();
  assert.equal((await titles()).length, 4);
  assert.equal(await page.locator('.history-filter-badge').isHidden(), true);
  await page.fill('.history-search', 'yesterday');
  assert.deepEqual(await titles(), ['Alpha bridge'], 'the search understands day words');
  const oct = new Date(day(20)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
  await page.fill('.history-search', oct);
  assert.ok((await titles()).includes('No project chat'), 'the search finds a chat by its date');
  await page.fill('.history-search', '');
  await chip('Visor').click();
  await page.fill('.history-search', 'zzz');
  assert.match(await page.locator('#historyModal .fs-modal-empty').innerText(), /No chats match/);
  for (const width of [364, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.locator('#historyFilterPanel').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, 'panel stays inside the window');
  }
  assert.deepEqual(errors, []);
  console.log('history filter ok');
} finally { await browser.close(); }
