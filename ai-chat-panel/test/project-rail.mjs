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
  assert.equal(await page.locator('.rail-scroll > *').first().getAttribute('class'), 'launcher-actions', 'actions lead the sidebar');
  assert.equal(await page.locator('.rail #apiValue').count(), 0, 'API value leaves the sidebar');
  await send({ type: 'apiValue', totalUsd: 568, monthUsd: 300, byAgent: { claude: 497, codex: 55, gemini: 16 }, since: '2026-09-22', prices: { verified: '2026-10-01' }, unpriced: 2 });
  await send({ type: 'openSettings' });
  const valueCard = page.locator('.cs-api-value');
  assert.equal(await valueCard.evaluate(el => el.open), false, 'value starts collapsed in Settings');
  await valueCard.locator('summary').click();
  assert.equal(await valueCard.locator('[data-role=apiValueTotal]').innerText(), '≈ $568');
  assert.equal(await valueCard.locator('.cs-api-value-amount').allTextContents().then(values => values.join(', ')), '$497, $55.00, $16.00, $0');
  assert.match(await valueCard.locator('[data-role=apiValueFoot]').innerText(), /This month ≈ \$300.*2 turns of unlisted models not counted/);
  await send({ type: 'apiValue', totalUsd: 600, monthUsd: 332, byAgent: { claude: 529, codex: 55, gemini: 16 } });
  assert.equal(await valueCard.locator('[data-role=apiValueTotal]').innerText(), '≈ $600', 'live updates reach Settings');
  for (const width of [364, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const cardBox = await valueCard.boundingBox();
    assert.ok(cardBox.x >= 0 && cardBox.x + cardBox.width <= width, 'value card stays inside the window');
  }
  if (process.env.SHOT_VALUE) await valueCard.screenshot({ path: process.env.SHOT_VALUE });
  await send({ type: 'openSettings' }); // close the popup
  const svgUri = (fill, shape) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${shape.replace('FILL', fill)}</svg>`).toString('base64')}`;
  const projects = [
    { id: 'a', name: 'portfolio 2026', root: 'C:/Cloud/Portfolio' },
    { id: 'b', name: 'Visor', root: 'D:/Code/Visor', icon: 'D:/Code/Visor/logo.svg', iconUri: svgUri('#7dd3fc', '<rect width="32" height="32" rx="8" fill="FILL"/><circle cx="16" cy="16" r="6" fill="#0b1220"/>') },
    { id: 'c', name: 'Clanker Controller', root: 'D:/Code/Clanker', icon: 'D:/Code/Clanker/logo.svg', iconUri: svgUri('#fbbf24', '<path d="M4 6h24v14H18l-6 6v-6H4z" fill="FILL"/>') },
    { id: 'd', name: 'Research notes with a very long name', root: null, icon: 'broken.png', iconUri: 'data:image/png;base64,AAAA' },
  ];
  await send({ type: 'chatLoaded', chat: { id: 'chat-a', projectId: 'a', messages: [], apiCostUsd: 42, turnQueue: { turns: [], paused: false } } });
  assert.equal(await page.locator('[data-role=apiValueChat]').textContent(), 'Current chat ≈ $42.00');
  assert.equal(await page.locator('.pending-cost').count(), 0, 'chat value stays out of the running status pill');
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', required: false, pinnedProjectIds: ['b', 'c'] });
  await send({ type: 'history', sessions: [
    { id: 'chat-a', projectId: 'a', touchedProjectIds: ['b', 'a'], projectNames: ['Visor', 'portfolio 2026'], lastMessage: { role: 'assistant', agent: 'claude', text: 'Now the library rewrite of the selection logic.' }, models: ['claude'], title: 'Fix animation', state: null },
    { id: 'chat-b', projectId: 'c', touchedProjectIds: [], title: 'Running elsewhere', state: 'running' },
  ] });
  const tiles = page.locator('.project-item[data-id] .project-tile');
  assert.equal(await tiles.count(), 3, 'current project and two favorites');
  assert.equal(await page.locator('.project-tile.is-active + .project-peek .project-peek-text span').textContent(), 'portfolio 2026');
  assert.equal(await page.locator('.project-tile.is-touched').count(), 1);
  assert.equal(await page.locator('.project-live').count(), 1);
  assert.equal(await page.locator('.project-picker:visible').count(), 0, 'project tiles provide the picker');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.project-tile .project-mark .project-icon').count(), 2, 'Visor and Clanker show their favicon');
  assert.equal(await page.locator('.project-item[data-id="b"] .project-tile .project-mark').innerText(), '', 'the favicon replaces the initials');
  assert.equal(await page.locator('.project-item[data-id="a"] .project-tile .project-mark').innerText(), 'P2', 'no icon set: the initials stay');
  const chatPeek = page.locator('.history-item', { hasText: 'Fix animation' }).locator('.history-peek');
  assert.equal(await chatPeek.locator('.history-peek-icons .history-project-icon').count(), 2, 'the Recent preview shows the icons of the projects the chat worked in');
  assert.equal(await chatPeek.locator('.history-peek-icons .project-icon').count(), 1, 'Visor shows its favicon');
  assert.equal(await chatPeek.locator('.history-peek-icons .project-mark').last().innerText(), 'P2', 'a project without an icon keeps its initials');
  assert.equal(await page.locator('.history-item', { hasText: 'Running elsewhere' }).locator('.history-peek-icons .history-project-icon').count(), 1, 'a chat that touched nothing shows its own project');
  await page.locator('.history-item', { hasText: 'Fix animation' }).hover();
  await page.waitForTimeout(900);
  if (process.env.SHOT_RECENT) await page.screenshot({ path: process.env.SHOT_RECENT, clip: { x: 0, y: 380, width: 560, height: 520 } });
  await page.mouse.move(5, 5);
  await page.locator('#allProjectsBtn').click();
  const gallery = page.locator('#projectsModal');
  assert.equal(await gallery.locator('.project-gallery-card').count(), 4, 'hidden projects stay available');
  assert.equal(await gallery.locator('.project-gallery-card[data-id="d"] .project-mark').innerText(), 'Rn', 'broken icons fall back to initials');
  assert.equal(await gallery.locator('.project-gallery-card[data-id="c"] .project-gallery-status').innerText(), 'Running');
  assert.equal(await gallery.locator('.project-gallery-pin[aria-pressed=true]').count(), 2);
  assert.equal(await gallery.locator('.project-gallery-card[data-id="d"] .project-gallery-pin').isDisabled(), true, 'two favorites maximum');
  await gallery.locator('.project-gallery-card[data-id="c"] .project-gallery-pin').click();
  assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.type === 'pinProject').at(-1)), { type: 'pinProject', projectId: 'c', pinned: false });
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', pinnedProjectIds: ['b'] });
  await gallery.locator('.project-gallery-card[data-id="d"] .project-gallery-pin').click();
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', pinnedProjectIds: ['b', 'd'] });
  assert.equal(await tiles.count(), 3);
  assert.equal(await page.locator('.project-item[data-id="c"]').count(), 0);
  assert.equal(await page.locator('.project-overflow-live').count(), 1, 'hidden running work remains visible on All projects');
  assert.match(await page.locator('#allProjectsBtn').getAttribute('aria-label'), /1 hidden project running/);
  await gallery.locator('.project-gallery-search').fill('Research');
  assert.equal(await gallery.locator('.project-gallery-card').count(), 1);
  await gallery.locator('.project-gallery-search').fill('no such project');
  assert.match(await gallery.locator('.project-gallery').innerText(), /No matching projects/);
  await gallery.locator('.project-gallery-search').fill('');
  for (const width of [364, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await gallery.locator('.fs-modal-sheet').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, 'gallery fits a narrow sidebar');
  }
  if (process.env.SHOT_PROJECTS) await page.screenshot({ path: process.env.SHOT_PROJECTS });
  await gallery.locator('.project-gallery-card[data-id="c"] .project-gallery-open').click();
  assert.equal(await gallery.isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.type === 'openProject').at(-1)), { type: 'openProject', projectId: 'c' });
  await send({ type: 'project', project: projects[2], projects, chatId: 'chat-c', pinnedProjectIds: ['b', 'd'] });
  assert.equal(await tiles.count(), 3);
  assert.equal(await page.locator('.project-tile.is-active').getAttribute('aria-label'), 'Clanker Controller (this chat)');
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', pinnedProjectIds: ['b', 'c'] });
  await page.evaluate(() => { window.sent = window.sent.filter(message => !['openProject', 'pinProject'].includes(message.type)); });
  assert.equal(await page.locator('.project-pill.is-busy').count(), 0, 'idle: no ring');
  if (process.env.SHOT_TOP) {
    await page.locator('.rail-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: process.env.SHOT_TOP });
  }
  await page.locator('.project-item[data-id="b"]').hover();
  await page.locator('.project-item[data-id="b"] .project-peek-mark').click();
  assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'openProject')), [{ type: 'openProject', projectId: 'b' }]);
  await page.locator('.project-item[data-id="a"]').hover();
  await page.locator('.project-item[data-id="a"] .project-peek-mark').click();
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'openProject').length), 1, 'the active tile does nothing');
  await page.locator('#allProjectsBtn').click();
  await gallery.locator('[data-action=add]').click();
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', pinnedProjectIds: ['b', 'd'] });
  await page.locator('.project-item[data-id="d"]').hover();
  await page.locator('.project-item[data-id="d"] .project-x').click();
  assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'addProject' || m.type === 'removeProject')), [{ type: 'addProject' }, { type: 'removeProject', projectId: 'd' }]);
  assert.equal(await page.locator('.project-item[data-id="a"] .project-x').count(), 0, 'the chat\'s own project cannot be removed');
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', pinnedProjectIds: ['b', 'c'] });
  await send({ type: 'routing', agentId: 'claude' });
  assert.equal(await page.locator('.project-pill.is-busy').count(), 1, 'a running turn shows the ring');
  assert.equal(await page.locator('.project-tile.is-working + .project-peek .project-peek-text span').textContent(), 'portfolio 2026');
  await send({ type: 'tool_start', name: 'edit', file: 'D:\\Code\\Visor\\src\\a.js', command: 'a.js', toolId: 't1' });
  assert.equal(await page.locator('.project-tile.is-working + .project-peek .project-peek-text span').textContent(), 'Visor');
  await page.waitForTimeout(900);
  await page.screenshot({ path: process.env.SHOT || path.join(shotDir, 'project-rail.png') });
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
  await page.locator('.cs-card:has(.cs-project)').screenshot({ path: process.env.SHOT_SETTINGS || path.join(shotDir, 'project-icons-settings.png') });
  await send({ type: 'turn_complete' });
  assert.equal(await page.locator('.project-pill.is-busy').count(), 0, 'the ring leaves when the turn ends');
  // Settings > General: how many projects and recent chats the rail lists.
  const railSelects = page.locator('.cs-select[data-role=railProjects], .cs-select[data-role=railChats]');
  assert.equal(await railSelects.count(), 2, 'Settings has both pickers');
  await page.locator('.cs-select[data-role=railChats]').selectOption('0');
  await page.locator('.cs-select[data-role=railProjects]').selectOption('2');
  assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'setRailLimit')), [{ type: 'setRailLimit', key: 'railChats', value: 0 }, { type: 'setRailLimit', key: 'railProjects', value: 2 }]);
  await send({ type: 'fleet', models: [], clis: {}, services: { rail: { projects: 7, chats: 5 } } });
  assert.equal(await page.locator('.cs-select[data-role=railProjects]').inputValue(), '7', 'a value from settings.json that the list lacks still shows');
  if (process.env.SHOT_RAILSET) { await page.locator('.cs-select[data-role=railProjects]').scrollIntoViewIfNeeded(); await page.locator('.cs-card:has(.cs-select[data-role=railProjects])').screenshot({ path: process.env.SHOT_RAILSET }); }
  await send({ type: 'openSettings' }); // close it again
  const shown = () => page.locator('.project-item[data-id]').evaluateAll(items => items.map(item => item.dataset.id));
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', pinnedProjectIds: ['b', 'c'] });
  assert.deepEqual(await shown(), ['b', 'c', 'a'], 'default: two favorites and the current project');
  await send({ type: 'railLimits', value: { projects: 1, chats: 5 } });
  assert.deepEqual(await shown(), ['a'], 'one slot: the current project stays');
  await send({ type: 'railLimits', value: { projects: 2, chats: 5 } });
  assert.deepEqual(await shown(), ['b', 'a'], 'the current project, then the first favorite');
  await send({ type: 'project', project: projects[0], projects, chatId: 'chat-a', pinnedProjectIds: [] });
  assert.deepEqual((await shown()).sort(), ['a', 'c'], 'nothing pinned: the most recent project fills the slot');
  await send({ type: 'railLimits', value: { projects: 0, chats: 5 } });
  assert.deepEqual((await shown()).sort(), ['a', 'b', 'c', 'd'], '0 lists every project');
  await send({ type: 'railLimits', value: { projects: 3, chats: 5 } });
  assert.equal(await page.locator('.project-item[data-id]').count(), 3);
  const many = Array.from({ length: 9 }, (_, index) => ({ id: `m${index}`, projectId: 'a', touchedProjectIds: [], title: `Chat ${index}`, updatedAt: new Date(Date.now() - index * 60000).toISOString() }));
  await send({ type: 'history', sessions: many });
  assert.equal(await page.locator('#historyList .history-row').count(), 5, 'five recent chats by default');
  await send({ type: 'railLimits', value: { projects: 3, chats: 8 } });
  assert.equal(await page.locator('#historyList .history-row').count(), 8, 'the chat limit follows Settings');
  await send({ type: 'railLimits', value: { projects: 0, chats: 0 } });
  assert.equal(await page.locator('#historyList .history-row').count(), 9, '0 lists every chat');
  if (process.env.SHOT_ALL) await page.screenshot({ path: process.env.SHOT_ALL });
  await send({ type: 'railLimits', value: { projects: 3, chats: 5 } });
  assert.deepEqual(errors, []);
  console.log('project rail ok');
} finally { await browser.close(); }
