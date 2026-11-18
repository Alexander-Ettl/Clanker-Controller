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
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(media, '.' + pathname);
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.addInitScript(() => {
    window.sent = []; window.notes = []; window.audioCreated = 0;
    window.acquireVsCodeApi = () => ({ postMessage(message) { window.sent.push(message); }, getState: () => ({}), setState() {} });
    Math.random = () => 0;
    window.AudioContext = class {
      constructor() { window.audioCreated++; this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      createOscillator() { return { frequency: { setValueAtTime(value) { window.notes.push(value); } }, connect(value) { return value; }, disconnect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(value) { return value; }, disconnect() {} }; }
    };
  });
  await page.goto(origin);
  const empty = page.locator('#transcript > .empty-state');
  await empty.locator('.clanker-rig').waitFor();
  await page.waitForFunction(() => !document.querySelector('.empty-state').classList.contains('mascot-paused'));
  // The tint follows the IDE theme (toggled before the header snapshot: a theme change makes the glass engine rebuild its filters).
  const bodyTint = () => page.locator('.cg-fill-a').evaluate(el => getComputedStyle(el).stopColor);
  const darkTint = await bodyTint();
  await page.evaluate(() => { document.body.classList.remove('vscode-dark'); document.body.classList.add('vscode-light'); });
  assert.notEqual(await bodyTint(), darkTint);
  await page.evaluate(() => { document.body.classList.remove('vscode-light'); document.body.classList.add('vscode-dark'); });
  assert.equal(await bodyTint(), darkTint);
  const header = await page.locator('.topbar').innerHTML();
  const chassis = page.locator('.clanker-chassis-rig');
  assert.equal(await chassis.evaluate(el => getComputedStyle(el).transform), 'none');
  assert.equal(await page.locator('.clanker-rig').evaluate(el => Math.round(el.getBoundingClientRect().width)), 140);
  // Liquid Glass 2.0: a glass body and a separate smoked-glass screen, no drop shadow, and colours that follow the IDE theme.
  assert.equal(await page.locator('.clanker-rig').evaluate(el => getComputedStyle(el).filter), 'none');
  assert.equal(await page.locator('.clanker-chassis-rig .cg-glow').count(), 1);
  assert.equal(await page.locator('.cg-screen-depth').count(), 1);
  await page.mouse.move(999, 719);
  const gazeNear = (x, y) => page.waitForFunction(([x, y]) => {
    const m = document.querySelector('.clanker-face-rig').style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
    return m && Math.abs(m[1] - x) < 0.1 && Math.abs(m[2] - y) < 0.1;
  }, [x, y]);
  await gazeNear(11, 7.5);
  assert.equal(await chassis.evaluate(el => getComputedStyle(el).transform), 'none');
  await page.waitForFunction(() => document.querySelector('.empty-state').classList.contains('mascot-blinking'), { timeout: 7000 });
  await page.waitForFunction(() => document.querySelector('.clanker-eye-left-rig .clanker-eye-pixels').getAttribute('visibility') === 'visible', null, { timeout: 1000 });
  if (process.argv[2]) await page.locator('.clanker-rig').screenshot({ path: path.join(process.argv[2], 'mascot-blink.png') });
  await page.waitForFunction(() => document.querySelectorAll('.clanker-eye-left-rig .clanker-eye-pixels rect:not([visibility="hidden"])').length <= 7 && getComputedStyle(document.querySelector('.clanker-eye-left-rig .clanker-eye-solid')).display === 'none', null, { timeout: 1000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.clanker-eye-left-rig .clanker-eye-solid')).display !== 'none', null, { timeout: 1000 });
  assert.equal(await page.evaluate(() => window.audioCreated), 0);
  const input = page.locator('#promptInput');
  await input.focus();
  assert.equal(await empty.getAttribute('data-mascot'), 'focus');
  await input.pressSequentially('Design');
  assert.equal(await empty.getAttribute('data-mascot'), 'typing');
  await input.pressSequentially(' ');
  assert.equal(await empty.getAttribute('data-mascot'), 'thinking');
  assert.equal(await chassis.evaluate(el => getComputedStyle(el).transform), 'none');
  const scanOpacity = () => page.locator('.clanker-scanline').evaluate(el => Number(el.style.opacity));
  await page.waitForFunction(() => Number(document.querySelector('.clanker-scanline').style.opacity) > 0.1);

  // Pause typing with text -> should stay in thinking state
  await input.fill('Write an Astro component');
  await page.waitForTimeout(800);
  assert.equal(await empty.getAttribute('data-mascot'), 'thinking');
  await page.waitForFunction(() => Number(document.querySelector('.clanker-scanline').style.opacity) > 0.1);

  // Easter egg: typing now and then turns the visor into a scrolling ASCII-bit ticker, then it fades out.
  await page.evaluate(() => { window.realRandom = Math.random; Math.random = () => 0; });
  await input.pressSequentially('abcdefghijklm');
  await page.evaluate(() => { Math.random = window.realRandom; });
  assert.equal(await empty.getAttribute('data-mascot'), 'decode');
  await page.waitForFunction(() => Number(document.querySelector('.clanker-bits').style.opacity) > 0.9);
  assert.ok((await page.locator('.clanker-bits').getAttribute('d')).length > 500);
  await page.waitForTimeout(900);
  assert.ok(Number(await page.locator('.clanker-brow-left-rig').evaluate(el => el.style.opacity)) < 0.2);
  assert.ok(Number(await page.locator('.clanker-brow-right-rig').evaluate(el => el.style.opacity)) < 0.2);
  if (process.argv[2]) await page.locator('.clanker-rig').screenshot({ path: path.join(process.argv[2], 'mascot-bits.png') });
  const bitsX = () => page.locator('.clanker-bits').evaluate(el => el.style.transform);
  const before = await bitsX();
  await page.waitForTimeout(150);
  assert.notEqual(await bitsX(), before);
  await page.waitForFunction(() => document.querySelector('.empty-state').dataset.mascot !== 'decode', null, { timeout: 15000 });
  await page.waitForFunction(() => Number(document.querySelector('.clanker-bits').style.opacity) < 0.05);

  // Voice dictation listening test
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'micState', state: 'recording' } })));
  assert.equal(await empty.getAttribute('data-mascot'), 'listening');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'micState', state: 'idle' } })));
  assert.notEqual(await empty.getAttribute('data-mascot'), 'listening');
  // Listening: the eyes wander, and leaving it fades the scan out instead of cutting it.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'micState', state: 'recording' } })));
  const gaze = () => page.locator('.clanker-eye-left-rig').evaluate(el => el.style.transform);
  const first = await gaze();
  await page.waitForFunction(first => document.querySelector('.clanker-eye-left-rig').style.transform !== first, first, { timeout: 3000 });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'micState', state: 'idle' } })));
  assert.ok(await scanOpacity() < 0.95);

  // Scheduling: hovering the clock button turns the right eye into a ticking clock face.
  await page.locator('#scheduleBtn').hover();
  assert.equal(await empty.getAttribute('data-mascot'), 'scheduling');
  await page.waitForFunction(() => Number(document.querySelector('.clanker-hand-min').style.opacity) > 0.5);
  const hand = () => page.locator('.clanker-hand-min').evaluate(el => el.style.transform);
  const tickedFrom = await hand();
  await page.waitForFunction(from => document.querySelector('.clanker-hand-min').style.transform !== from, tickedFrom, { timeout: 2000 });
  await page.mouse.move(999, 719);
  await page.waitForFunction(() => document.querySelector('.empty-state').dataset.mascot !== 'scheduling');

  await empty.locator('[data-mascot-action="mention"]').click();
  assert.equal(await empty.getAttribute('data-mascot'), 'mention');
  assert.match(await input.inputValue(), /@/);
  await empty.locator('[data-mascot-action="action"]').click();
  assert.equal(await empty.getAttribute('data-mascot'), 'action');
  await empty.locator('[data-mascot-action="image"]').click();
  assert.equal(await empty.getAttribute('data-mascot'), 'image');
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'pickAttachments').length), 1);
  await page.locator('#modelPill').click();
  assert.equal(await empty.getAttribute('data-mascot'), 'model');
  // Wink: the right eye breaks into pixels, drops out until a thin line is left, and the solid shape returns.
  const eyeCells = () => page.evaluate(() => [...document.querySelectorAll('.clanker-eye-right-rig .clanker-eye-pixels rect')].filter(r => r.getAttribute('visibility') !== 'hidden').length);
  await page.waitForFunction(() => document.querySelector('.clanker-eye-right-rig .clanker-eye-pixels').getAttribute('visibility') === 'visible');
  await page.waitForFunction(() => document.querySelectorAll('.clanker-eye-right-rig .clanker-eye-pixels rect:not([visibility="hidden"])').length <= 10);
  if (process.argv[2]) for (const [i, ms] of [0, 40, 120].entries()) { await page.waitForTimeout(ms); await page.locator('.clanker-rig').screenshot({ path: path.join(process.argv[2], `mascot-wink${i}.png`) }); }
  assert.ok(await eyeCells() < 76);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.clanker-eye-right-rig .clanker-eye-solid')).display !== 'none', null, { timeout: 3000 });
  await page.locator('.model-option[data-model-id="gpt-6.1-sol-high"]').click();
  assert.equal(await page.evaluate(() => window.audioCreated), 0);
  assert.equal(await page.locator('.topbar').innerHTML(), header);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.model-menu')).opacity === '0');
  if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], 'mascot-empty.png') });
  await input.fill('Launch the design task');
  await input.press('Enter');
  assert.equal(await empty.count(), 0, JSON.stringify({ messages: await page.evaluate(() => window.sent), errors }));
  assert.equal(await page.locator('.empty-state.is-launching').count(), 1);
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'send').length), 1);
  assert.deepEqual(await page.evaluate(() => window.notes), [523.25, 659.25, 783.99, 1046.50]);
  await page.locator('.empty-state.is-launching').waitFor({ state: 'detached' });
  await page.mouse.move(20, 20);
  assert.equal(await page.locator('.clanker-rig').count(), 0);
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  await send({ type: 'chatLoaded', chat: { id: 'fresh', modelId: 'auto', messages: [] } });
  assert.equal(await empty.locator('.clanker-rig').count(), 1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await input.fill('Send with reduced motion');
  await page.locator('#sendBtn').click();
  assert.equal(await page.locator('.is-launching').evaluate(el => getComputedStyle(el).opacity), '0');
  assert.equal(await page.locator('.is-launching .empty-mark').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.locator('.empty-state.is-launching').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.notes.length), 8);
  await send({ type: 'chatLoaded', chat: { id: 'history', modelId: 'auto', messages: [{ role: 'user', text: 'Previous task' }, { role: 'assistant', text: 'Done', agent: 'codex' }] } });
  assert.equal(await page.locator('.clanker-rig').count(), 0);
  assert.equal(await page.locator('.topbar').innerHTML(), header);

  // Sending in an existing chat must NOT play sound or launch mascot
  await input.fill('Second prompt in existing chat');
  await page.locator('#sendBtn').click();
  assert.equal(await page.evaluate(() => window.notes.length), 8, 'Sound must not play in existing chat');
  assert.equal(await page.locator('.empty-state.is-launching').count(), 0);

  // Chat handed over to a different AI model (e.g. model switched in an existing thread)
  await send({ type: 'chatLoaded', chat: { id: 'handoff', modelId: 'claude-3-7-sonnet', messages: [{ role: 'user', text: 'Planning turn' }, { role: 'assistant', text: 'Plan ready', agent: 'claude' }] } });
  assert.equal(await page.locator('.clanker-rig').count(), 0);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setActive', modelId: 'codex' } })));
  await input.fill('Editor turn handed over to Codex');
  await page.locator('#sendBtn').click();
  assert.equal(await page.evaluate(() => window.notes.length), 8, 'Sound must not play in handed-over chat');
  assert.equal(await page.locator('.empty-state.is-launching').count(), 0);

  // Completely new chat where Clanker controller is visible: sound MUST play on prompt send
  await send({ type: 'chatLoaded', chat: { id: 'brand-new', modelId: 'auto', messages: [] } });
  assert.equal(await empty.locator('.clanker-rig').count(), 1);
  await input.fill('First prompt in fresh chat');
  await page.locator('#sendBtn').click();
  assert.equal(await page.evaluate(() => window.notes.length), 12, 'Sound must play when sending in a completely new chat');
  await page.locator('.empty-state.is-launching').waitFor({ state: 'detached' });

  assert.deepEqual(errors, []);
  console.log('Clanker mascot: stable chassis, clamped gaze, blink, typing/scan, chips, model, launch-only audio, Enter/Send, restore, existing-chat and handed-over silence, and reduced motion passed.');
} finally {
  await browser.close();
}
