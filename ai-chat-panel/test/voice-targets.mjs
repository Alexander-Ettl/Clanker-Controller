// Dictation across several chat windows: the hotkey records in the window used last, only that window animates recording and
// transcribing (the others are told idle), and a click on another window's mic moves the animation there without stopping. Drives the real host code with fake windows, then replays what each window received into a rendered page.
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
assert.deepEqual(mics(popup1).map(m => m.state), ['starting', 'recording'], 'the target animates');
assert.deepEqual([sidebar, popup2].map(host => mics(host).map(m => m.state)), [['idle', 'idle'], ['idle', 'idle']], 'no other chat animates');
assert.ok([sidebar, popup2].every(host => mics(host).every(m => m.target === false && m.elsewhere === 'recording' && !m.cue)), 'the others only learn that another chat records, and play no cue');
assert.deepEqual([mics(popup1).at(-1).target, mics(popup1).at(-1).cue], [true, true], 'the start cue plays once, in the target');

// Clicking into the second popup mid-recording moves the animation there; the recording keeps running, no second cue.
clear();
manager.setActive(popup2);
assert.equal(capture.owner, popup2, 'the recording now ends in the window clicked last');
assert.deepEqual(mics(popup2).map(m => [m.state, m.target, m.cue]), [['recording', true, false]], 'the new target takes over');
assert.deepEqual(mics(popup1).map(m => [m.state, m.target, m.elsewhere]), [['idle', false, 'recording']], 'the old target stops animating');
assert.deepEqual(mics(sidebar).map(m => m.state), ['idle']);
assert.ok(capture.recording, 'moving the dictation does not stop the recording');
manager.setActive(popup2);
assert.equal(popup2.received.length, 1, 'the same window again changes nothing');

// Live levels reach the recording window only.
clear();
manager.broadcastMicVolume({ rms: 0.05, peak: 0.2, level: 0.6 });
assert.deepEqual(windows.map(host => host.received.some(m => m.type === 'micVolume')), [false, false, true], 'only the target gets the levels');

// Cancel clears every window.
clear();
await popup2.handleMicCancel();
assert.ok(windows.every(host => mics(host).at(-1)?.state === 'idle' && !mics(host).at(-1).elsewhere), 'every window goes back to normal');
assert.equal(manager.mic, null);

// The second F9 lands in the window clicked last; transcribing shows there alone and does not follow a later click.
await popup2.handleMicToggle();
manager.setActive(popup1);
clear();
await manager.getOrCreateActive().handleMicToggle();
assert.deepEqual(mics(popup1).map(m => [m.state, m.target]).slice(0, 1), [['processing', true]], 'the finishing window is the target of the transcription');
assert.deepEqual([sidebar, popup2].map(host => mics(host).slice(0, 1).map(m => [m.state, m.elsewhere])), [[['idle', 'processing']], [['idle', 'processing']]], 'other chats do not play the transcribing animation');
assert.ok(windows.every(host => mics(host).at(-1).state === 'idle'), 'every window is released when it ends');
capture.owner = popup1; manager.mic = { state: 'processing' }; // transcription under way: a click elsewhere must not move it
manager.setActive(popup2);
assert.equal(capture.owner, popup1, 'a click during transcription does not move it');
manager.mic = null;

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
  const left = await open();
  const right = await open();
  const send = (page, message) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const state = page => page.evaluate(() => {
    const composer = document.querySelector('.composer');
    return { voice: composer.classList.contains('is-voice'), processing: composer.classList.contains('is-voice-processing'), mic: document.getElementById('micBtn').classList.contains('recording'), disabled: document.getElementById('micBtn').disabled, title: document.getElementById('micBtn').title };
  });
  const sent = page => page.evaluate(() => window.sent.map(m => m.type));
  const shot = async (page, name) => { if (shots) await page.locator('.composer').first().screenshot({ path: path.join(shots, `${name}.png`) }); };
  for (const page of [left, right]) await page.locator('#promptInput').fill('Fix the header spacing on the product page');

  // Clicking or focusing a window tells the host it is the one used last.
  await left.locator('#promptInput').click();
  assert.ok((await sent(left)).includes('windowActive'), 'a click in a window reports it as used last');

  // Recording in the right chat, as the host sends it: the right chat animates, the left one is told idle.
  await send(right, { type: 'micState', state: 'recording', target: true, hold: false, device: 'Test mic' });
  await send(left, { type: 'micState', state: 'idle', target: false, elsewhere: 'recording' });
  await right.waitForTimeout(700);
  for (const level of [0.2, 0.8, 0.5, 0.9]) {
    await send(right, { type: 'micVolume', rms: 0.05, peak: 0.2, level });
    await right.waitForTimeout(110);
  }
  assert.deepEqual([await state(right), await state(left)].map(s => [s.voice, s.mic]), [[true, true], [false, false]], 'only the recording chat animates');
  assert.match((await state(left)).title, /Click to move dictation/);
  await shot(right, '1-right-recording');
  await shot(left, '1-left-idle');

  // A click on the left mic only moves it: it sends windowActive and no micToggle, even if the host's answer lands before the click.
  await left.evaluate(() => { window.sent.length = 0; });
  const micBox = await left.locator('#micBtn').boundingBox();
  await left.mouse.move(micBox.x + micBox.width / 2, micBox.y + micBox.height / 2);
  await left.mouse.down();
  await send(left, { type: 'micState', state: 'recording', target: true, hold: false, device: 'Test mic' }); // the host answered the pointerdown at once
  await send(right, { type: 'micState', state: 'idle', target: false, elsewhere: 'recording' });
  await left.mouse.up();
  const afterClick = await sent(left);
  assert.ok(afterClick.includes('windowActive'), 'the press made this chat the target');
  assert.ok(!afterClick.includes('micToggle'), 'the click did not stop the recording');
  await right.waitForTimeout(450);
  await send(left, { type: 'micVolume', rms: 0.05, peak: 0.2, level: 0.8 });
  await left.waitForTimeout(120);
  assert.deepEqual([await state(right), await state(left)].map(s => [s.voice, s.mic]), [[false, false], [true, true]], 'the animation moved to the left chat');
  await shot(left, '2-left-recording');
  await shot(right, '2-right-idle');

  // The next click on the chat that owns the recording stops it.
  await left.evaluate(() => { window.sent.length = 0; });
  await left.locator('#micBtn').click();
  assert.ok((await sent(left)).includes('micToggle'), 'a click on the recording chat stops it');

  // Transcribing plays in one chat only; the other one cannot start a second recording meanwhile.
  await send(left, { type: 'micState', state: 'processing', target: true });
  await send(right, { type: 'micState', state: 'idle', target: false, elsewhere: 'processing' });
  await left.waitForTimeout(500);
  assert.deepEqual([await state(left), await state(right)].map(s => [s.voice, s.processing]), [[true, true], [false, false]], 'only the transcribing chat plays the animation');
  await right.evaluate(() => { window.sent.length = 0; });
  await right.locator('#micBtn').click();
  assert.ok(!(await sent(right)).includes('micToggle'), 'a chat cannot start a second recording while another transcribes');
  await shot(left, '3-left-transcribing');
  await shot(right, '3-right-idle');
  for (const page of [left, right]) await send(page, { type: 'micState', state: 'idle', target: page === left });
  await left.waitForTimeout(450);
  assert.deepEqual([await state(left), await state(right)].map(s => [s.voice, s.mic]), [[false, false], [false, false]], 'idle clears both');
  assert.deepEqual([...left.errors, ...right.errors], []);
} finally {
  await browser.close();
}
console.log('voice targets: ok');
