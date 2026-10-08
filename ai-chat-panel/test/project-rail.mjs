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
  const svgUri = (fill, shape) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${shape.replace('FILL', fill)}</svg>`).toString('base64')}`;
  const projects = [
    { id: 'a', name: 'portfolio 2026', root: 'C:/Cloud/Portfolio' },
    { id: 'b', name: 'Visor', root: 'D:/Code/Visor', icon: 'D:/Code/Visor/logo.svg', iconUri: svgUri('#7dd3fc', '<rect width="32" height="32" rx="8" fill="FILL"/><circle cx="16" cy="16" r="6" fill="#0b1220"/>') },
    { id: 'c', name: 'Clanker Controller', root: 'D:/Code/Clanker', icon: 'D:/Code/Clanker/logo.svg', iconUri: svgUri('#fbbf24', '<path d="M4 6h24v14H18l-6 6v-6H4z" fill="FILL"/>') },
    { id: 'd', name: 'Research notes with a very long name', root: null, icon: 'broken.png', iconUri: 'data:image/png;base64,AAAA' },
  ];
  await send({ type: 'chatLoaded', chat: { id: 'chat-a', projectId: 'a', messages: [], turnQueue: { turns: [], paused: false } } });
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', required: false });
  await send({ type: 'history', sessions: [
    { id: 'chat-a', projectId: 'a', touchedProjectIds: ['b', 'a'], title: 'Fix animation', state: null },
    { id: 'chat-b', projectId: 'c', touchedProjectIds: [], title: 'Running elsewhere', state: 'running' },
  ] });
  const tiles = page.locator('.project-item:not(.is-add) .project-tile');
  assert.equal(await tiles.count(), 4);
  assert.equal(await page.locator('.project-tile.is-active + .project-name').innerText(), 'portfolio 2026');
  assert.equal(await page.locator('.project-tile.is-touched').count(), 1);
  assert.equal(await page.locator('.project-live').count(), 1);
  assert.equal(await page.locator('.project-picker').innerText(), 'Manage');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.project-mark .project-icon').count(), 2, 'Visor and Clanker show their favicon');
  assert.equal(await page.locator('.project-item[data-id="b"] .project-mark').innerText(), '', 'the favicon replaces the initials');
  assert.equal(await page.locator('.project-item[data-id="d"] .project-mark').innerText(), 'Rn', 'an icon that will not load falls back to the initials');
  assert.equal(await page.locator('.project-item[data-id="a"] .project-mark').innerText(), 'P2', 'no icon set: the initials stay');
  assert.equal(await page.locator('.project-pill.is-busy').count(), 0, 'idle: no ring');
  await page.locator('.project-item[data-id="b"] .project-tile').click();
  assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'openProject')), [{ type: 'openProject', projectId: 'b' }]);
  await page.locator('.project-tile.is-active').click();
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'openProject').length), 1, 'the active tile does nothing');
  await page.locator('.project-item.is-add .project-tile').click();
  await page.locator('.project-item[data-id="d"]').hover();
  await page.locator('.project-item[data-id="d"] .project-x').click();
  assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'addProject' || m.type === 'removeProject')), [{ type: 'addProject' }, { type: 'removeProject', projectId: 'd' }]);
  assert.equal(await page.locator('.project-item[data-id="a"] .project-x').count(), 0, 'the chat\'s own project cannot be removed');
  await send({ type: 'routing', agentId: 'claude' });
  assert.equal(await page.locator('.project-pill.is-busy').count(), 1, 'a running turn shows the ring');
  assert.equal(await page.locator('.project-tile.is-working + .project-name').innerText(), 'portfolio 2026');
  await send({ type: 'tool_start', name: 'edit', file: 'D:\\Code\\Visor\\src\\a.js', command: 'a.js', toolId: 't1' });
  assert.equal(await page.locator('.project-tile.is-working + .project-name').innerText(), 'Visor');
  await page.waitForTimeout(900);
  await page.screenshot({ path: process.env.SHOT || 'project-rail.png' });
  await send({ type: 'turn_complete' });
  await send({ type: 'openSettings' });
  await send({ type: 'projectIcons', projects });
  const iconPanel = page.locator('.cs-project-icons');
  assert.equal(await iconPanel.evaluate(el => el.open), false, 'project icons start collapsed');
  assert.equal(await page.locator('.cs-project-actions button:visible').count(), 0, 'editing requires expansion');
  await iconPanel.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await iconPanel.evaluate(el => el.open), true, 'keyboard opens the panel');
  const rows = page.locator('.cs-project');
  assert.equal(await rows.count(), 4);
  assert.equal(await rows.nth(0).locator('.cs-project-tile').innerText(), 'P2');
  assert.equal(await rows.nth(0).locator('.cs-btn:visible', { hasText: 'Clear' }).count(), 0, 'nothing to clear without an icon');
  await page.waitForTimeout(150);
  assert.equal(await rows.nth(1).locator('.cs-project-tile img').count(), 1);
  assert.equal(await rows.nth(3).locator('.cs-project-tile img').count(), 0, 'a broken image leaves the initials');
  assert.equal(await rows.nth(3).locator('.cs-btn:visible', { hasText: 'Detect' }).count(), 0, 'a planning project has no folder to search');
  await rows.nth(2).locator('.cs-btn', { hasText: 'Detect' }).click();
  await rows.nth(2).locator('.cs-btn', { hasText: 'Ask AI' }).click();
  await rows.nth(1).locator('.cs-btn', { hasText: 'Clear' }).click();
  assert.deepEqual(await page.evaluate(() => window.sent.filter(m => /ProjectIcon|projectIcon/.test(m.type))), [
    { type: 'requestProjectIcons' }, { type: 'detectProjectIcon', id: 'c' }, { type: 'projectIconWithAI', id: 'c' }, { type: 'clearProjectIcon', id: 'b' },
  ]);
  await page.locator('.cs-project').first().scrollIntoViewIfNeeded();
  await page.locator('.cs-card:has(.cs-project)').screenshot({ path: process.env.SHOT_SETTINGS || 'project-icons-settings.png' });
  await send({ type: 'turn_complete' });
  assert.equal(await page.locator('.project-pill.is-busy').count(), 0, 'the ring leaves when the turn ends');
  assert.deepEqual(errors, []);
  console.log('project rail ok');
} finally { await browser.close(); }
