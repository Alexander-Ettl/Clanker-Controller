// Pinned chats: the Pin button in Manage Chats, the "Pinned" section on top of it, and the pinned chats leading the rail's Recent list.
// SHOT_DIR=<folder> saves screenshots of both in a dark and a light theme.
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
  const page = await browser.newPage({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2 });
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
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const chat = (id, title, projectId, agent, minutes, extra = {}) => ({ id, projectId, title, models: [agent], latestAgent: agent, projectName: projects.find(p => p.id === projectId).name, messageCount: 40 - minutes % 30, updatedAt: ago(minutes), lastMessage: { role: 'assistant', agent, text: `Latest answer in ${title}.` }, ...extra });
  // The host lists pinned chats first (in the order they were pinned); the pages sort them again themselves.
  const sessions = (pins = []) => [
    chat('1', 'Fix the build', 'a', 'codex', 3, { selected: true, active: true }),
    chat('2', 'Refactor router', 'b', 'claude', 50),
    chat('3', 'Clanker main context', 'c', 'claude', 60 * 24 * 6),
    chat('4', 'Write the docs', 'a', 'gemini', 60 * 26),
    chat('5', 'Old experiment', 'b', 'codex', 60 * 24 * 12),
    chat('6', 'Voice dictionary', 'c', 'claude', 60 * 24 * 3),
    chat('7', 'Release notes', 'a', 'gemini', 60 * 24 * 20),
  ].map(session => ({ ...session, pinned: pins.includes(session.id), pinOrder: pins.indexOf(session.id) }))
    .sort((a, b) => (a.pinned || b.pinned) ? (a.pinned && b.pinned ? a.pinOrder - b.pinOrder : a.pinned ? -1 : 1) : 0);
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
  const titles = () => page.locator('#historyModal .history-title').allTextContents();
  const labels = () => page.locator('#historyModal .history-section-label').allTextContents();
  const railOrder = () => page.locator('.history-item').evaluateAll(items => items.map(item => item.getAttribute('aria-label')?.replace(/ · .*/, '')));

  await send({ type: 'project', project: projects[0], projects, chatId: '1', required: false });
  await send({ type: 'history', sessions: sessions() });
  await page.locator('#historyBtn').click();
  assert.equal(await page.locator('#historyModal .history-icon-btn.is-pin').count(), 7, 'every card has a Pin button');
  assert.equal(await page.locator('#historyModal .history-icon-btn.is-pin[aria-pressed="true"]').count(), 0);
  assert.ok(!(await labels()).includes('Pinned'), 'no Pinned section without pins');

  // Pressing Pin only asks the host; the list changes when the host answers.
  await page.locator('#historyModal .history-card[data-id="3"] .history-icon-btn.is-pin').click();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(message => message.type === 'pinChat')), { type: 'pinChat', id: '3', pinned: true });
  assert.equal(await page.locator('#historyModal .history-card[data-id="3"]').evaluate(card => card.classList.contains('is-pinned')), false);

  await send({ type: 'history', sessions: sessions(['3']) });
  assert.equal((await labels())[0], 'Pinned', 'Pinned leads Manage Chats');
  assert.equal((await titles())[0], 'Clanker main context');
  assert.equal((await titles()).filter(title => title === 'Clanker main context').length, 1, 'a pinned chat shows once');
  const pinBtn = page.locator('#historyModal .history-card[data-id="3"] .history-icon-btn.is-pin');
  assert.equal(await pinBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(await pinBtn.getAttribute('aria-label'), 'Unpin chat');
  assert.equal((await railOrder())[0], 'Pinned', 'the rail marks it');
  assert.equal(await page.locator('.history-item').first().locator('.history-pin').count(), 1, 'the pinned tile wears the pin');
  assert.equal(await page.locator('.history-item .history-pin').count(), 1, 'only the pinned tile does');

  // Two pins keep the order they were pinned in; the pinned chats lead the rail even though the open chat is newer.
  await send({ type: 'history', sessions: sessions(['3', '5']) });
  assert.deepEqual((await titles()).slice(0, 2), ['Clanker main context', 'Old experiment']);
  assert.deepEqual((await page.locator('.history-item').evaluateAll(items => items.slice(0, 3).map(item => item.getAttribute('aria-label').replace(/^Pinned · /, '').split(' · ')[0]))), ['Clanker main context', 'Old experiment', 'Fix the build']);
  assert.equal(await page.locator('.history-item .history-pin').count(), 2);

  // Pinned chats stay on top whatever the sort, and the search and the filters still apply to them.
  await page.locator('.history-filter-btn').click();
  await page.locator('#historyFilterPanel .history-chip', { hasText: 'Title A–Z' }).click();
  assert.deepEqual((await titles()).slice(0, 3), ['Clanker main context', 'Old experiment', 'Fix the build']);
  await page.locator('#historyFilterPanel .history-chip', { hasText: 'Last active' }).click();
  await page.fill('.history-search', 'router');
  assert.deepEqual(await titles(), ['Refactor router'], 'a search that skips the pinned chats hides them');
  assert.ok(!(await labels()).includes('Pinned'));
  await page.fill('.history-search', '');
  await page.locator('.history-filter-btn').click();

  // Unpinning goes back through the host.
  await page.locator('#historyModal .history-card[data-id="5"] .history-icon-btn.is-pin').click();
  assert.deepEqual(await page.evaluate(() => window.sent.findLast(message => message.type === 'pinChat')), { type: 'pinChat', id: '5', pinned: false });

  for (const theme of ['dark', 'light']) {
    await apply(PALETTES[theme]);
    await send({ type: 'history', sessions: sessions(['3', '5']) });
    await page.waitForTimeout(400);
    await shot(`pins-manage-${theme}.png`, page.locator('#historyModal .fs-modal-sheet'));
    await page.locator('#historyModal .history-card[data-id="3"]').hover();
    await page.waitForTimeout(250);
    await shot(`pins-manage-hover-${theme}.png`, page.locator('#historyModal .fs-modal-sheet'));
    await page.locator('#historyModal .fs-modal-close, #historyModal [aria-label="Close"]').first().click().catch(() => {});
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 760, height: 1500 });
    await shot(`pins-rail-${theme}.png`, page.locator('.rail'));
    await page.setViewportSize({ width: 760, height: 900 });
    await page.locator('#historyBtn').click();
  }
  assert.deepEqual(errors, []);
  console.log('chat pins ok');
} finally { await browser.close(); }
