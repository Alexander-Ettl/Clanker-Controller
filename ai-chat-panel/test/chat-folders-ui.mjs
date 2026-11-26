// Chat folders: Manage Chats bundling/pinning/search/optional toggle + Recent rail iOS-style top expansion and collapse.
// SHOT_DIR=<folder> saves dark and light screenshots of Manage Chats and the Recent rail.
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
const PALETTES = {
  dark: { kind: 'vscode-dark', background: '#172437', panel: '#213149', foreground: '#e4edf7', accent: '#8acbff' },
  light: { kind: 'vscode-light', background: '#e6e7ee', panel: '#d9dbe5', foreground: '#38405e', accent: '#365cb0' },
};
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 920 }, deviceScaleFactor: 2 });
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
    { id: 'a', name: 'Portfolio 2026', root: '/dev/portfolio' },
    { id: 'b', name: 'Visor', root: '/dev/visor' },
    { id: 'c', name: 'Clanker Controller', root: '/dev/clanker' },
  ];
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const chat = (id, title, projectId, agent, minutes, extra = {}) => ({
    id, projectId, title, models: [agent], latestAgent: agent,
    projectName: projects.find(p => p.id === projectId).name,
    messageCount: 12 + (minutes % 10), updatedAt: ago(minutes),
    lastMessage: { role: 'assistant', agent, text: `Latest answer in ${title}.` },
    ...extra,
  });
  const baseSessions = [
    chat('1', 'Fix the build', 'a', 'codex', 2, { selected: true, active: true }),
    chat('2', 'OAuth callback', 'c', 'claude', 12, { state: 'running', active: true }),
    chat('3', 'Login form UI', 'c', 'gemini', 40),
    chat('4', 'Session tests', 'b', 'codex', 90),
    chat('5', 'Release notes', 'a', 'claude', 60 * 25),
    chat('6', 'Design audit', 'b', 'gemini', 60 * 24 * 4),
    chat('7', 'Voice tuning', 'c', 'claude', 60 * 24 * 6),
    chat('8', 'Archive cleanup', 'a', 'codex', 60 * 24 * 14),
  ];
  const folders = [
    { id: 'f-auth', name: 'Auth flow', chatIds: ['2', '3', '4'], pinned: false, pinnedAt: null, createdAt: ago(120), updatedAt: ago(12) },
    { id: 'f-rel', name: 'Release', chatIds: ['7', '8'], pinned: true, pinnedAt: 1000, createdAt: ago(60 * 24 * 10), updatedAt: ago(60 * 24 * 6) },
  ];

  const apply = async theme => {
    await page.evaluate(theme => {
      document.body.classList.remove('vscode-light', 'vscode-dark');
      document.body.classList.add(theme.kind);
      const colours = { 'editor.background': theme.background, 'editor.foreground': theme.foreground, 'editorWidget.background': theme.panel, 'sideBar.background': theme.panel, 'textLink.foreground': theme.accent, 'focusBorder': theme.accent, 'button.background': theme.accent, 'button.foreground': theme.background };
      for (const [key, value] of Object.entries(colours)) document.documentElement.style.setProperty(`--vscode-${key.replaceAll('.', '-')}`, value);
    }, theme);
    await page.waitForFunction(() => document.body.style.getPropertyValue('--chat-bg').startsWith('rgb('));
  };
  const shot = async (name, locator = page) => { if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await locator.screenshot({ path: path.join(process.env.SHOT_DIR, name) }); } };

  await send({ type: 'project', project: projects[0], projects, chatId: '1', required: false });

  // 1. With 0 folders, Manage Chats stays clean: no Folders section, no extra move-to-folder button on cards, Recent rail is flat.
  await send({ type: 'history', sessions: baseSessions, folders: [], chatFoldersEnabled: true });
  assert.equal(await page.locator('#historyList .history-item.is-folder').count(), 0);
  await page.locator('#historyBtn').click();
  assert.equal(await page.locator('#historyModal .history-folder-add-btn').isVisible(), true);
  assert.equal(await page.locator('#historyModal .history-folder-card').count(), 0);
  assert.equal(await page.locator('#historyModal .history-card .history-icon-btn.is-folder').count(), 0, 'no per-card folder button until a folder exists');

  // 2. Creating a folder with bundled chats posts createChatFolder.
  await page.locator('#historyModal .history-folder-add-btn').click();
  await page.fill('#historyFolderCreator .history-folder-name-input', 'Auth flow');
  await page.locator('#historyFolderCreator .history-folder-pick-row', { hasText: 'OAuth callback' }).click();
  await page.locator('#historyFolderCreator .history-folder-pick-row', { hasText: 'Login form UI' }).click();
  await page.locator('#historyFolderCreator .history-folder-submit').click();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'createChatFolder')), { type: 'createChatFolder', name: 'Auth flow', chatIds: ['2', '3'] });

  // 3. Host responds with folders: Pinned folder leads Manage Chats under Pinned, unpinned under Folders; bundled chats aren't duplicated outside.
  await send({ type: 'history', sessions: baseSessions, folders, chatFoldersEnabled: true });
  const labels = await page.locator('#historyModal .history-section-label').allTextContents();
  assert.equal(labels[0], 'Pinned');
  assert.equal(labels[1], 'Folders');
  assert.equal(await page.locator('#historyModal .history-folder-card').count(), 2);
  assert.equal(await page.locator('#historyModal .history-card[data-id="2"]').count(), 0, 'collapsed folder hides its member cards');

  // Expanding a folder reveals its bundled chats inside.
  await page.locator('#historyModal .history-folder-card[data-folder-id="f-auth"] .history-folder-head').click();
  assert.equal(await page.locator('#historyModal .history-folder-card[data-folder-id="f-auth"] .history-card').count(), 3);

  // Pinning a folder posts pinChatFolder.
  await page.locator('#historyModal .history-folder-card[data-folder-id="f-auth"] .history-folder-head .history-icon-btn.is-pin').click();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'pinChatFolder')), { type: 'pinChatFolder', id: 'f-auth', pinned: true });

  // Moving a standalone chat via the card's folder menu posts setChatFolder.
  await page.locator('#historyModal .history-card[data-id="5"] .history-icon-btn.is-folder').click();
  await page.locator('.history-folder-menu-item', { hasText: 'Auth flow' }).click();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'setChatFolder')), { type: 'setChatFolder', chatId: '5', folderId: 'f-auth' });

  // Searching finds a chat inside a collapsed folder and auto-expands it.
  await page.locator('#historyModal .history-folder-card[data-folder-id="f-auth"] .history-folder-head').click();
  await page.fill('.history-search', 'Voice tuning');
  assert.equal(await page.locator('#historyModal .history-folder-card[data-folder-id="f-rel"].is-expanded').count(), 1);
  assert.equal(await page.locator('#historyModal .history-folder-card[data-folder-id="f-rel"] .history-card[data-id="7"]').count(), 1);
  await page.fill('.history-search', '');

  // Deleting a folder posts deleteChatFolder (keeps chats).
  await page.locator('#historyModal .history-folder-card[data-folder-id="f-rel"] .history-folder-head .history-icon-btn.is-danger').click();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'deleteChatFolder')), { type: 'deleteChatFolder', id: 'f-rel' });

  // Close Manage Chats and verify the Recent rail!
  await page.locator('#historyModal .fs-modal-close').click();

  // 4. Recent rail: pinned folder ('f-rel', even though its chats are 6+ days old!) ALWAYS appears at top of Recent, followed by selected chat & active folder.
  const railIds = () => page.locator('#historyList .history-item').evaluateAll(els => els.map(el => el.dataset.id));
  assert.deepEqual((await railIds()).slice(0, 3), ['folder:f-rel', '1', 'folder:f-auth'], 'pinned folder leads Recent, then selected chat, then active unpinned folder');
  assert.equal(await page.locator('#historyList .history-item[data-folder-id="f-rel"] .history-pin').count(), 1, 'pinned folder wears the pin badge');
  assert.equal(await page.locator('#historyList .history-item[data-folder-id="f-auth"] .history-row .folder-mini-grid .folder-mini-cell').count(), 3, 'iOS 2x2 mini-grid renders member chat marks');
  assert.equal(await page.locator('#historyList .history-item[data-folder-id="f-auth"] .history-spinner').count(), 1, 'collapsed folder with running chat wears the spinner orb');

  // 5. Clicking a folder in Recent expands it AT THE VERY TOP POSITION with ALL its chats listed below!
  await page.locator('#historyList .history-item[data-folder-id="f-auth"]').click();
  const topChildIsExpandedAuth = await page.locator('#historyList > :first-child').evaluate(el => el.classList.contains('history-folder-group') && el.dataset.folderId === 'f-auth');
  assert.equal(topChildIsExpandedAuth, true, 'expanded folder moves to the very top position in Recent');
  assert.deepEqual(await page.locator('#historyList .history-folder-group .history-folder-contents .history-item').evaluateAll(els => els.map(e => e.dataset.id)), ['2', '3', '4'], 'all chats inside the folder are listed directly below');
  assert.equal(await page.locator('#historyList .history-item[data-folder-id="f-auth"]').getAttribute('aria-expanded'), 'true');

  // Clicking a chat inside the expanded folder restores it.
  await page.locator('#historyList .history-folder-contents .history-item[data-id="3"]').click();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'restoreChat')), { type: 'restoreChat', id: '3' });

  // Clicking the expanded folder header again collapses it back to its natural position!
  await page.locator('#historyList .history-item[data-folder-id="f-auth"]').click();
  assert.equal(await page.locator('#historyList .history-folder-group').count(), 0, 'clicking again collapses the folder');
  assert.deepEqual((await railIds()).slice(0, 3), ['folder:f-rel', '1', 'folder:f-auth']);

  // 6. Optional setting off (chatFoldersEnabled: false) hides all folder UI and flattens Recent & Manage Chats.
  await send({ type: 'history', sessions: baseSessions, folders: [], chatFoldersEnabled: false });
  assert.equal(await page.locator('#historyList .history-item.is-folder').count(), 0);
  await page.locator('#historyBtn').click();
  assert.equal(await page.locator('#historyModal .history-folder-add-btn').isVisible(), false, 'New folder button hides when chatFolders is disabled');
  assert.equal(await page.locator('#historyModal .history-folder-card').count(), 0);
  assert.equal(await page.locator('#historyModal .history-card').count(), 8, 'all chats appear flat');
  await page.locator('#historyModal .fs-modal-close').click();

  // 7. Capture dark & light visual review shots if SHOT_DIR is set.
  if (process.env.SHOT_DIR) {
    await send({ type: 'history', sessions: baseSessions, folders, chatFoldersEnabled: true });
    for (const theme of ['dark', 'light']) {
      await apply(PALETTES[theme]);
      await page.waitForTimeout(300);
      await shot(`folders-rail-collapsed-${theme}.png`, page.locator('.rail'));
      await page.locator('#historyList .history-item[data-folder-id="f-auth"]').click();
      await page.mouse.move(10, 10);
      await page.waitForTimeout(350);
      await shot(`folders-rail-expanded-${theme}.png`, page.locator('.rail'));
      await page.locator('#historyList .history-item[data-folder-id="f-auth"]').click();
      await page.waitForTimeout(250);
      await page.locator('#historyBtn').click();
      await page.locator('#historyModal .history-folder-card[data-folder-id="f-auth"] .history-folder-head').click();
      await page.waitForTimeout(350);
      await shot(`folders-manage-${theme}.png`, page.locator('#historyModal .fs-modal-sheet'));
      await page.locator('#historyModal .fs-modal-close').click();
      await page.waitForTimeout(200);
    }
  }

  assert.deepEqual(errors, []);
  console.log('chat-folders-ui ok');
} finally { await browser.close(); }
