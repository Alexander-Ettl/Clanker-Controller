// The Recent rail with work-context icons: the project is the main mark, the work icon sits on its corner in the latest agent's colour,
// the hover preview spells the category out. Offline: no provider is called. SHOT_RECENT / SHOT_HOVER write screenshots.
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
const { ChatWindowHost, ChatWindowManager } = require('../extension');
Module._load = originalLoad;
// Restore before routing exists, then initialize it: the cached run must find the live service.
{
  const chats = Array.from({ length: 7 }, (_, i) => ({ id: `restore-${i}`, messages: [{ role: 'user', text: 'Improve the sidebar spacing and colours.' }] }));
  const calls = [];
  const manager = Object.assign(Object.create(ChatWindowManager.prototype), {
    runs: new Map(), deps: { workspaceDir: process.cwd(), getModels: () => ({}), chatStore: { load: id => chats.find(chat => chat.id === id), list: () => chats } },
  });
  const restored = manager.runFor(chats[0].id);
  assert.equal(restored.deps.routing, undefined);
  manager.deps.routing = { workContext: { enabled: () => true, consider: run => calls.push(run.chat.id) } };
  manager.refreshWorkContexts();
  assert.ok(calls.includes(restored.chat.id), 'pre-initialization run uses the manager routing service');
  assert.equal(new Set(calls).size, 5, 'startup seeds only five recent chats');
  calls.length = 0;
  manager.deps.routing.workContext.enabled = () => false;
  manager.refreshWorkContexts();
  assert.equal(calls.length, 0, 'disabled startup does not classify');
  manager.deps.routing.workContext.enabled = () => true;
  manager.runFor(chats[6].id);
  assert.deepEqual(calls, [chats[6].id], 'opening an older chat requests its first icon');
  // The category is predicted from the prompt the moment it is sent (before the answer exists), and a finished turn asks nothing.
  const events = [];
  manager.deps.routing.workContext.consider = run => events.push(`consider:${run.chat.id}:${run.chat.messages.at(-2)?.text}`);
  const finishing = manager.runFor(chats[1].id);
  Object.assign(finishing.deps, { notify: () => events.push('chime'), notifyHistory: () => {}, chatWindowManager: manager, getModels: () => [], routing: { ...manager.deps.routing, router: {} } });
  manager.release = () => {};
  Object.assign(finishing, { save() {}, post() {}, syncAwake() {}, drain() {} });
  finishing.streamEngine.start = () => events.push('stream');
  const send = (text, reply = {}) => finishing.begin({ agent: 'claude', user: { role: 'user', text, at: new Date().toISOString() }, reply: { role: 'assistant', agent: 'claude', text: '', ...reply }, routing: { agentId: 'claude' }, run: {} });
  events.length = 0;
  send('Make the sidebar spacing consistent');
  assert.deepEqual(events, ['consider:restore-1:Make the sidebar spacing consistent', 'stream'], 'a sent prompt asks at once, before the turn runs');
  events.length = 0;
  send('Summarise the thread so far', { compact: true });
  assert.ok(!events.some(event => event.startsWith('consider')), 'a compaction is not new work');
  events.length = 0;
  finishing.activeAssistantMessage = { role: 'assistant', agent: 'claude', text: 'All done.', inProgress: true };
  finishing.turn = { startedAt: 1 };
  finishing.handleStreamEvent({ type: 'turn_complete' });
  assert.ok(!events.some(event => event.startsWith('consider')), 'a finished turn does not ask');
  for (const run of manager.runs.values()) run.streamEngine.dispose();
}
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const shotDir = fileURLToPath(new URL('../../out/screenshots/', import.meta.url));
fs.mkdirSync(shotDir, { recursive: true });
const origin = 'http://127.0.0.1';
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar: true }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const context = categoryId => ({ version: 1, categoryId, sourceRevision: 3, updatedAt: ago(1) });
const svgUri = (fill, shape) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${shape.replace('FILL', fill)}</svg>`).toString('base64')}`;
const projects = [
  { id: 'cc', name: 'Clanker Controller', root: 'D:/Code/Clanker', iconUri: svgUri('#fbbf24', '<path d="M4 6h24v14H18l-6 6v-6H4z" fill="FILL"/>') },
  { id: 'home', name: 'Home', root: 'D:/Home' },
];
const sessions = [
  // Claude, then Codex, then Claude again: the rail shows Claude, though `models` lists Codex last.
  { id: 'c1', projectId: 'cc', selected: true, title: 'Rail icons for recent chats', projectName: 'Clanker Controller', models: ['claude', 'codex'], latestAgent: 'claude', workContext: context('design'), updatedAt: ago(0), state: null, lastMessage: { role: 'assistant', agent: 'claude', text: 'The badge sits on the tile corner now.' } },
  { id: 'c2', projectId: 'cc', title: 'Context classifier against Cloudflare', projectName: 'Clanker Controller', models: ['codex'], latestAgent: 'codex', workContext: context('backend'), updatedAt: ago(4), state: 'running', recentUntil: Date.now() + 60000 },
  { id: 'c3', projectId: 'cc', title: 'Why does the quota ring jump?', projectName: 'Clanker Controller', models: ['codex', 'claude'], latestAgent: 'codex', workContext: context('debugging'), updatedAt: ago(35), state: 'waiting', lastMessage: { role: 'assistant', agent: 'codex', text: 'Do you want the reset time rounded up?' } },
  { id: 'c4', projectId: 'home', title: 'Find the Alexa skill setup docs', projectName: 'Home', models: ['gemini'], latestAgent: 'gemini', workContext: context('research'), updatedAt: ago(180), state: null },
  { id: 'c5', projectId: 'cc', title: 'Fresh chat, nothing classified yet', projectName: 'Clanker Controller', models: ['claude'], latestAgent: 'claude', workContext: null, updatedAt: ago(1500), state: null },
];
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 1300 }, deviceScaleFactor: 3 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(media, '.' + pathname);
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
  await page.goto(origin);
  await page.locator('#historyList').waitFor({ state: 'attached' });
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  assert.equal(await page.evaluate(() => window.CONTEXT_ASSETS.categories.length), 24, 'the page carries all 24 categories');
  assert.equal(await page.evaluate(() => Object.keys(window.CONTEXT_ASSETS.icons).length), 24, 'and their icons');
  await send({ type: 'project', project: projects[0], projects, chatId: 'c1' });
  await send({ type: 'history', sessions });

  const items = page.locator('.history-item');
  assert.equal(await items.count(), 5);
  assert.equal(await page.locator('.history-context').count(), 4, 'a chat with no category shows its agent alone');
  // The tile's main mark is the chat's project; the provider is told by the colour of the work icon (and named in the label).
  assert.equal(await page.locator('.history-lead .agent-mark').count(), 0, 'no provider logo on a tile that has a project');
  assert.equal(await items.nth(0).locator('.history-lead .history-project-icon.is-tile .project-icon').count(), 1, 'the project favicon leads the tile');
  assert.equal(await items.nth(3).locator('.history-lead .project-mark').innerText(), 'Ho', 'a project without an icon keeps its initials');
  assert.equal(await items.nth(0).getAttribute('data-agent'), 'claude', 'Claude, Codex, Claude: the latest agent is Claude');
  assert.equal(await items.nth(2).getAttribute('data-agent'), 'codex', 'the latest agent wins over the first');
  const tints = await Promise.all([0, 1, 3].map(i => items.nth(i).locator('.history-context').evaluate(el => getComputedStyle(el).boxShadow)));
  assert.equal(new Set(tints).size, 3, 'the work icon\'s ring wears each chat\'s provider colour (Claude, Codex, Gemini)');
  assert.equal(await items.nth(0).locator('.history-context').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)', 'the icon itself is white for contrast');
  assert.match(await items.nth(0).locator('.history-row').getAttribute('aria-label'), /Clanker Controller · Claude Code/, 'project and provider are in the accessible name');
  assert.equal(await items.nth(0).locator('.history-peek-mark .history-project-icon').count(), 1, 'the preview keeps the same mark at its right end');
  // A chat with no project keeps the provider's logo; before the project list loads, the mark stays blank rather than flashing it.
  await send({ type: 'history', sessions: [{ ...sessions[0], projectId: null }] });
  assert.equal(await page.locator('.history-lead .agent-mark').count(), 1, 'no project: the provider logo');
  await send({ type: 'history', sessions });
  assert.equal(await items.nth(4).locator('.history-context').count(), 0);
  assert.match(await items.nth(0).locator('.history-row').getAttribute('aria-label'), /Visual design/, 'the category is in the accessible name, not only the icon');
  assert.equal(await items.nth(0).locator('.history-peek-context').innerText(), 'Visual design');
  assert.equal(await items.nth(4).locator('.history-peek-context').isHidden(), true);

  // The badge stays on the tile's corner and inside the rail pill.
  const pill = await page.locator('#historyList').boundingBox();
  for (let i = 0; i < 4; i++) {
    const tile = await items.nth(i).locator('.history-row').boundingBox();
    const badge = await items.nth(i).locator('.history-context').boundingBox();
    assert.ok(badge.x >= pill.x + 1 && badge.x + badge.width <= pill.x + pill.width - 1, 'badge inside the pill');
    assert.ok(badge.y >= tile.y && badge.y + badge.height <= tile.y + tile.height + 4, 'badge on the tile, above the time label');
  }

  // An unknown or missing category degrades to the agent alone.
  await send({ type: 'history', sessions: [{ ...sessions[0], workContext: { version: 1, categoryId: '../../evil' } }] });
  assert.equal(await page.locator('.history-context').count(), 0, 'only allowlisted ids render');
  await send({ type: 'history', sessions });

  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const railBox = await page.locator('.rail').boundingBox();
  const clip = { x: railBox.x - 20, y: pill.y - 30, width: railBox.width + 20, height: pill.height + 60 };
  await page.screenshot({ path: process.env.SHOT_RECENT || path.join(shotDir, 'recent-context.png'), clip });
  const badge = items.nth(1).locator('.history-context');
  await items.nth(1).hover();
  await badge.waitFor({ state: 'hidden' });
  await page.waitForTimeout(750);
  assert.equal(await items.nth(1).locator('.history-peek-context svg').isVisible(), true);
  await page.screenshot({ path: path.join(shotDir, 'recent-context-hover-motion.png'), clip: { x: 0, y: pill.y - 30, width: 560, height: pill.height + 60 } });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  assert.equal(await badge.isVisible(), false, 'badge stays hidden during preview retraction');
  await badge.waitFor({ state: 'visible' });
  await items.nth(1).focus();
  await badge.waitFor({ state: 'hidden' });
  await page.waitForTimeout(750);
  assert.equal(await items.nth(1).locator('.history-peek-context svg').isVisible(), true, 'keyboard focus preserves the category in the preview');
  await page.locator('#promptInput').focus();
  await badge.waitFor({ state: 'visible' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await items.nth(1).hover();
  await badge.waitFor({ state: 'hidden' });
  await page.waitForTimeout(900);
  const peek = await items.nth(1).locator('.history-peek').boundingBox();
  assert.ok(peek.x >= 0 && peek.width > 300, 'the preview opens over the chat');
  assert.equal(await items.nth(1).locator('.history-peek-context').innerText(), 'Backend');
  await page.screenshot({ path: process.env.SHOT_HOVER || path.join(shotDir, 'recent-context-hover.png'), clip: { x: peek.x - 20, y: pill.y - 30, width: 560 - peek.x + 20, height: pill.height + 60 } });
  // The non-coding categories sit on the same tiles (the rail shows five chats, so two batches).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(5, 5);
  const plain = [['study', 'Studying', 'claude'], ['notes', 'Notes and minutes', 'codex'], ['organizing', 'Organizing', 'gemini'], ['schedule', 'Schedule and tasks', 'claude'], ['math', 'Math and numbers', 'codex'],
    ['language', 'Language', 'gemini'], ['ideas', 'Ideas', 'claude'], ['life', 'Everyday life', 'codex']];
  for (const [part, batch] of [plain.slice(0, 4), plain.slice(4)].entries()) {
    await send({ type: 'history', sessions: batch.map(([id, , agent], i) => ({ id: `n${part}${i}`, projectId: i % 2 ? 'cc' : 'home', title: `Chat ${i}`, projectName: 'Home', models: [agent], latestAgent: agent, workContext: context(id), updatedAt: ago(i * 7), state: null })) });
    await page.waitForTimeout(300);
    for (const [i, [, label]] of batch.entries()) assert.match(await items.nth(i).locator('.history-row').getAttribute('aria-label'), new RegExp(label), `${label} is named on its tile`);
    assert.equal(await page.locator('.history-context svg').count(), batch.length, 'every non-coding category has its icon');
    const box = await page.locator('#historyList').boundingBox();
    await page.screenshot({ path: path.join(shotDir, `recent-context-plain-${part + 1}.png`), clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 20), width: box.width + 40, height: box.height + 40 } });
  }
  assert.deepEqual(errors, []);
  console.log('recent context ok');
} finally { await browser.close(); }
