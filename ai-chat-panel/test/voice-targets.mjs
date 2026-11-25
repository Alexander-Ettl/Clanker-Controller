// Dictation across several chat windows: the hotkey records in the window used last, every window animates the one
// microphone in step, the target has the full animation and the others echo it quietly, and clicking another window moves
// the target. Drives the real host code with fake windows, then replays what each window received into a rendered page.
// Set VOICE_TARGET_SHOTS=<dir> to keep screenshots.
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// ---- Host: which window records, and what each window is told ----
const capture = {
  recording: false, starting: false, owner: null, device: 'Test mic', onVolume: null,
  isRecording() { return this.recording; },
  async start() { this.recording = true; },
  async stop() { this.recording = false; return path.join(process.env.TEMP || '.', 'voice-targets-missing.wav'); },
};
const manager = Object.assign(Object.create(ChatWindowManager.prototype), { hosts: new Set(), activeHost: null, mic: null, deps: { voiceCapture: capture } });
const windows = ['sidebar', 'popup-1', 'popup-2'].map(name => {
  const received = [];
  const host = Object.assign(Object.create(ChatWindowHost.prototype), { name, received, panel: { webview: { postMessage: message => { received.push(message); return Promise.resolve(true); } } }, deps: { voiceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'voice-targets-')), chatWindowManager: manager, voiceCapture: capture } });
  manager.hosts.add(host);
  return host;
});
const [sidebar, popup1, popup2] = windows;
const mics = host => host.received.filter(message => message.type === 'micState');
const clear = () => windows.forEach(host => { host.received.length = 0; });

// F9 pressed while the sidebar was used last.
manager.setActive(sidebar);
// The user then clicks into the first popup and uses it: it is where F9 records.
manager.setActive(popup1);
assert.equal(manager.getOrCreateActive(), popup1, 'the window clicked last is where the hotkey starts');
await manager.getOrCreateActive().handleMicToggle();
assert.equal(capture.owner, popup1);
for (const host of windows) assert.deepEqual(mics(host).map(m => m.state), ['starting', 'recording'], `${host.name} animates the shared microphone`);
assert.deepEqual(windows.map(host => mics(host).at(-1).target), [false, true, false], 'only the window used last is the target');
assert.deepEqual(windows.map(host => mics(host).at(-1).cue), [false, true, false], 'the start cue plays once, in the target');

// Clicking into the second popup mid-recording moves the target and replays the state there without a second cue.
clear();
manager.setActive(popup2);
assert.equal(capture.owner, popup2, 'the recording now ends in the window clicked last');
for (const host of windows) assert.deepEqual(mics(host).map(m => [m.state, m.target, m.cue]), [['recording', host === popup2, false]], `${host.name} switches its animation`);
manager.setActive(popup2);
assert.equal(popup2.received.length, 1, 'the same window again changes nothing');

// Live levels reach every window.
clear();
capture.onVolume({ rms: 0.05, peak: 0.2, level: 0.6 });
manager.broadcastMicVolume({ rms: 0.05, peak: 0.2, level: 0.6 });
assert.ok(windows.every(host => host.received.some(m => m.type === 'micVolume')));

// Cancel clears every window.
clear();
await popup2.handleMicCancel();
assert.ok(windows.every(host => mics(host).at(-1)?.state === 'idle'), 'every window goes back to normal');
assert.equal(manager.mic, null);

// F9 the second time lands in the window clicked last, and the other windows show it processing.
await popup2.handleMicToggle();
manager.setActive(popup1);
clear();
await manager.getOrCreateActive().handleMicToggle();
assert.deepEqual(mics(popup1).map(m => [m.state, m.target]).slice(0, 1), [['processing', true]], 'the finishing window is the target of the transcription');
assert.deepEqual(mics(sidebar).map(m => [m.state, m.target]).slice(0, 1), [['processing', false]]);
assert.ok(windows.every(host => mics(host).at(-1).state === 'idle'), 'every window is released when it ends');

// ---- Rendered: what the target and the other windows look like ----
const shots = process.env.VOICE_TARGET_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const origin = 'http://127.0.0.1';
const page_host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar: true }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = page_host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 520, height: 360 }, deviceScaleFactor: 2 });
    page.errors = [];
    page.on('pageerror', error => page.errors.push(error.message));
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
    return page;
  };
  const target = await open();
  const mirror = await open();
  const send = (page, message) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const state = page => page.evaluate(() => {
    const composer = document.querySelector('.composer');
    return { voice: composer.classList.contains('is-voice'), mirror: composer.classList.contains('is-voice-mirror'), mic: document.getElementById('micBtn').classList.contains('is-mirror'), title: document.getElementById('micBtn').title };
  });
  const shot = async (page, name) => { if (shots) await page.locator('.composer').first().screenshot({ path: path.join(shots, `${name}.png`) }); };
  for (const page of [target, mirror]) await page.locator('#promptInput').fill('Fix the header spacing on the product page');

  // Clicking or focusing a window tells the host it is the one used last.
  await mirror.locator('#promptInput').click();
  assert.ok((await mirror.evaluate(() => window.sent)).some(m => m.type === 'windowActive'), 'a click in a window reports it as used last');

  // F9: the host's broadcast, as each window received it.
  for (const [page, name] of [[target, 'popup-1'], [mirror, 'sidebar']]) {
    await send(page, { type: 'micState', state: 'recording', target: name === 'popup-1', hold: false, device: 'Test mic' });
  }
  await target.waitForTimeout(700);
  for (const level of [0.2, 0.8, 0.5, 0.9]) {
    for (const page of [target, mirror]) await send(page, { type: 'micVolume', rms: 0.05, peak: 0.2, level });
    await target.waitForTimeout(110);
  }
  assert.deepEqual([await state(target), await state(mirror)].map(s => [s.voice, s.mirror, s.mic]), [[true, false, false], [true, true, true]], 'both animate, only the echo is dimmed');
  assert.match((await state(mirror)).title, /another chat/);
  await shot(target, '1-target');
  await shot(mirror, '1-mirror');

  // The user clicks the other window: the animation moves there, the draft of the old target comes back.
  await send(target, { type: 'micState', state: 'recording', target: false, hold: false, device: 'Test mic' });
  await send(mirror, { type: 'micState', state: 'recording', target: true, hold: false, device: 'Test mic' });
  await target.waitForTimeout(450);
  await send(target, { type: 'micVolume', rms: 0.05, peak: 0.2, level: 0.8 });
  await send(mirror, { type: 'micVolume', rms: 0.05, peak: 0.2, level: 0.8 });
  await target.waitForTimeout(120);
  assert.deepEqual([await state(target), await state(mirror)].map(s => [s.mirror, s.mic]), [[true, true], [false, false]], 'the target switched windows');
  await shot(target, '2-switched-mirror');
  await shot(mirror, '2-switched-target');

  // A window that is only echoing never ends the recording by itself; the host releases both.
  assert.ok(!(await target.evaluate(() => window.sent)).some(m => m.type === 'micToggle'));
  for (const page of [target, mirror]) await send(page, { type: 'micState', state: 'processing', target: page === mirror });
  await target.waitForTimeout(500);
  await shot(target, '3-processing-mirror');
  await shot(mirror, '3-processing-target');
  for (const page of [target, mirror]) await send(page, { type: 'micState', state: 'idle' });
  await target.waitForTimeout(450);
  assert.deepEqual([await state(target), await state(mirror)].map(s => [s.voice, s.mirror, s.mic]), [[false, false, false], [false, false, false]], 'idle clears both');
  assert.deepEqual([...target.errors, ...mirror.errors], []);
} finally {
  await browser.close();
}
console.log('voice targets: ok');
