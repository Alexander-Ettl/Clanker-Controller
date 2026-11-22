// Dictation start: the click is answered at once (flat dashes + breathing mic), the dashes turn upright into the live meter
// when the host says "recording", and the start cue plays on that message only. Set VOICE_START_SHOTS=<dir> to keep frames.
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
const shots = process.env.VOICE_START_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar: true }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 700 }, deviceScaleFactor: 2 });
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
    window.cues = [];
    window.acquireVsCodeApi = () => ({ postMessage(message) { window.sent.push(message); }, getState: () => ({}), setState() {} });
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () { window.cues.push(performance.now()); return create.call(this); };
  });
  await page.goto(origin);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const composer = page.locator('#composer, .composer').first();
  const mic = page.locator('#micBtn');
  const shot = async name => { if (shots) await page.locator('.compose-row, .composer').first().screenshot({ path: path.join(shots, `${name}.png`) }); };
  const bars = () => page.evaluate(() => [...document.querySelectorAll('.waveform-bar')].map(bar => ({ h: parseFloat(bar.style.height) || 0, rot: Math.round(Number((bar.style.transform.match(/rotate\(([\d.]+)deg/) || [0, 0])[1])) })));

  // Click: answered before the host says anything.
  await mic.hover();
  await mic.click();
  assert.equal(await composer.evaluate(el => el.classList.contains('is-voice-starting')), true, 'the composer shows the loading state on the click itself');
  assert.equal(await mic.evaluate(el => el.classList.contains('is-starting') && el.disabled), true, 'the mic breathes and cannot be double-clicked');
  assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'micToggle')), [{ type: 'micToggle' }]);
  assert.equal(await page.evaluate(() => window.cues.length), 0, 'no cue while the microphone is still opening');

  // The host confirms "starting": nothing restarts.
  await send({ type: 'micState', state: 'starting' });
  await page.waitForTimeout(350);
  await shot('1-loading-a');
  const shutA = await bars();
  await page.waitForTimeout(400);
  await shot('1-loading-b');
  const shutB = await bars();
  for (const row of [shutA, shutB]) {
    assert.ok(row.every(bar => bar.rot === 90 && bar.h === 6), 'while loading every bar lies on its side as a flat dash, never a wave');
  }
  assert.equal(await page.evaluate(() => window.cues.length), 0, 'still no cue');

  // Microphone live: cue plays now, the dashes turn upright into the meter.
  await send({ type: 'micState', state: 'recording', cue: true, device: 'Test mic' });
  assert.ok(await page.evaluate(() => window.cues.length) >= 2, 'the start cue plays when the host reports recording');
  assert.equal(await composer.evaluate(el => el.classList.contains('is-voice-starting')), false);
  assert.equal(await mic.evaluate(el => el.classList.contains('recording') && !el.classList.contains('is-starting')), true);
  await page.waitForTimeout(90);
  await shot('2-turning');
  const turning = await bars();
  assert.ok(turning[15].rot < turning[0].rot, 'the quarter turn travels from the centre outwards');
  await page.waitForTimeout(110);
  await shot('2-turning-b');
  await page.waitForTimeout(400);
  const quiet = (await bars()).map(bar => bar.h);
  assert.ok((await bars()).every(bar => bar.rot === 0), 'every bar is upright once the shutter has opened');
  assert.ok(Math.max(...quiet) < 5, 'in silence the bars rest as dots once the handover is done');
  await send({ type: 'micVolume', rms: 0.06, peak: 0.3, level: 0.7 });
  await page.waitForTimeout(220);
  await send({ type: 'micVolume', rms: 0.06, peak: 0.3, level: 0.7 });
  await page.waitForTimeout(120);
  await shot('3-recording');
  assert.ok(Math.max(...(await bars()).map(bar => bar.h)) > 12, 'speech raises the bars');

  // A failed start unlocks everything.
  await send({ type: 'micState', state: 'idle' });
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.sent.length = 0; });
  await mic.click();
  assert.equal(await composer.evaluate(el => el.classList.contains('is-voice-starting')), true);
  await send({ type: 'micState', state: 'idle' });
  assert.equal(await composer.evaluate(el => el.classList.contains('is-voice')), false, 'an error returns the composer to normal');
  assert.equal(await mic.evaluate(el => el.disabled), false);
  assert.deepEqual(errors, []);
  console.log('voice start: ok');
} finally {
  await browser.close();
}
