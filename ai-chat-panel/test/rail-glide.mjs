// The rail's Recent list: opening a chat slides its tile up to the top and the old first tile steps down (a short glide).
// SHOT_DIR=<folder> saves frames of the glide in a dark and a light theme.
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
  for (const [name, theme] of Object.entries(PALETTES)) {
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
    await page.evaluate(theme => {
      document.body.classList.remove('vscode-light', 'vscode-dark');
      document.body.classList.add(theme.kind);
      const colours = { 'editor.background': theme.background, 'editor.foreground': theme.foreground, 'editorWidget.background': theme.panel, 'sideBar.background': theme.panel, 'textLink.foreground': theme.accent, 'focusBorder': theme.accent, 'button.background': theme.accent, 'button.foreground': theme.background };
      for (const [key, value] of Object.entries(colours)) document.documentElement.style.setProperty(`--vscode-${key.replaceAll('.', '-')}`, value);
    }, theme);
    await page.waitForFunction(() => document.body.style.getPropertyValue('--chat-bg').startsWith('rgb('));
    const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
    const chat = (id, agent, minutes, extra = {}) => ({ id, title: `Chat ${id}`, models: [agent], latestAgent: agent, updatedAt: ago(minutes), lastMessage: { role: 'assistant', agent, text: 'Latest.' }, ...extra });
    // Opening chat `open` makes it the selected first tile; the one that was first stays "recent" and steps to second.
    const sessions = (open, previous) => [
      chat('1', 'codex', 1), chat('2', 'claude', 9), chat('3', 'gemini', 120), chat('4', 'claude', 60 * 26), chat('5', 'gemini', 60 * 24 * 12),
    ].map(session => ({ ...session, selected: session.id === open, active: session.id === open, recentUntil: session.id === previous ? Date.now() + 60000 : 0 }));
    const order = () => page.locator('.history-item').evaluateAll(items => items.map(item => item.dataset.id));
    const tops = () => page.locator('.history-item').evaluateAll(items => Object.fromEntries(items.map(item => [item.dataset.id, Math.round(item.getBoundingClientRect().top - document.querySelector('.history-list').getBoundingClientRect().top)])));
    const freeze = ms => page.evaluate(ms => document.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect?.target?.classList?.contains('history-item')).forEach(animation => { animation.pause(); animation.currentTime = ms; }), ms);
    const shot = async (file) => { if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await page.locator('.history-list').screenshot({ path: path.join(process.env.SHOT_DIR, file) }); } };

    await send({ type: 'history', sessions: sessions('1') });
    await page.waitForTimeout(400);
    assert.deepEqual(await order(), ['1', '2', '3', '4', '5']);
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect?.target?.classList?.contains('history-item')).length), 0, 'the first list draws without a glide');
    const rest = await tops();

    // Open chat 2 (second): a straight swap with the old first.
    await send({ type: 'history', sessions: sessions('2', '1') });
    assert.deepEqual(await order(), ['2', '1', '3', '4', '5']);
    const swapped = await page.evaluate(() => document.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect?.target?.classList?.contains('history-item')).length);
    assert.equal(swapped, 2, 'exactly the two swapped tiles glide');
    await freeze(0);
    const start = await page.locator('.history-item').evaluateAll(items => Object.fromEntries(items.map(item => [item.dataset.id, Math.round(item.getBoundingClientRect().top - document.querySelector('.history-list').getBoundingClientRect().top)])));
    assert.equal(start['2'], rest['2'], 'the opened chat starts from where it was');
    assert.equal(start['1'], rest['1'], 'the old first starts from where it was');
    await shot(`glide-${name}-0.png`);
    await freeze(90);
    const mid = await tops();
    assert.ok(mid['2'] < rest['2'] && mid['2'] > rest['1'], `the opened chat is between the two spots (${JSON.stringify({ mid, rest, start })})`);
    await shot(`glide-${name}-1.png`);
    await page.evaluate(() => document.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect?.target?.classList?.contains('history-item')).forEach(animation => animation.finish()));
    const end = await tops();
    assert.equal(end['2'], rest['1'], 'the opened chat ends where the first one was');
    assert.equal(end['1'], rest['2']);
    assert.equal(end['3'], rest['3'], 'tiles that did not move stay put');
    await shot(`glide-${name}-2.png`);

    // Open chat 4 (fourth): it rises over the tiles that step down to make room.
    await send({ type: 'history', sessions: sessions('4', '2') });
    assert.deepEqual(await order(), ['4', '2', '1', '3', '5']);
    assert.equal(await page.evaluate(() => document.querySelector('.history-item[data-id="4"]').style.zIndex), '2', 'the rising tile passes over the others');
    await page.evaluate(() => document.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect?.target?.classList?.contains('history-item')).forEach(animation => animation.finish()));
    assert.deepEqual(await page.locator('.history-item').evaluateAll(items => items.map(item => item.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)).length)), [0, 0, 0, 0, 0]);

    // Re-rendering the same list (a status update) moves nothing and animates nothing.
    await send({ type: 'history', sessions: sessions('4', '2') });
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect?.target?.classList?.contains('history-item')).length), 0);

    // Reduced motion: the order changes at once.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await send({ type: 'history', sessions: sessions('5', '4') });
    assert.deepEqual(await order(), ['5', '4', '1', '2', '3']);
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect?.target?.classList?.contains('history-item')).length), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('rail-glide ok');
} finally { await browser.close(); }
