// Dictation under existing text, in the real HTML with the real main.js and style.css:
//   node test/voice-landing.mjs             asserts the behaviour
//   SHOT=<dir> node test/voice-landing.mjs  also writes voice-landing-*.png there
// The written text stays on screen, a live row opens under it (meter, then ghost lines), no placeholder text shows while the
// recording is turned into text, the transcript lands on a new line, and ONE Ctrl+Z takes the whole dictation back.
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
const shot = (name) => process.env.SHOT && path.join(process.env.SHOT, `voice-landing-${name}.png`);
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'claude' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const OLD = 'Fix the scan limit in the voice dictionary and make the settings tab searchable.';
const NEW = 'Also add tests for the project scan.\n\n- Cover the limit\n- Cover the dedupe';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  for (const [mode, theme] of [['dark', 'vscode-dark'], ['light', 'vscode-light']]) {
    const page = await browser.newPage({ viewport: { width: 520, height: 420 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${origin}/**`, route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(media, '.' + pathname);
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', body: fs.readFileSync(file) });
    });
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage(m) { window.sent.push(m); }, getState: () => ({}), setState() {} }); });
    await page.goto(origin);
    await page.locator('#stopBtn').waitFor({ state: 'attached' });
    await page.evaluate(cls => { document.body.classList.remove('vscode-dark', 'vscode-light'); document.body.classList.add(cls); }, theme);
    const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    await send({ type: 'chatLoaded', chat: { id: 'c', modelId: 'auto', messages: [] } });
    const input = page.locator('#promptInput');
    const composer = page.locator('.composer');
    const height = () => input.evaluate(el => Math.round(el.offsetHeight));
    const opacity = () => input.evaluate(el => Number(getComputedStyle(el).opacity));
    const record = async () => { await send({ type: 'micState', state: 'recording', target: true }); for (let i = 0; i < 8; i++) { await send({ type: 'micVolume', level: 0.5 }); await page.waitForTimeout(30); } };
    const land = async () => { await send({ type: 'micState', state: 'idle', target: true }); await send({ type: 'voiceResult', output: { cleanedPrompt: NEW }, rawTranscript: 'raw' }); };
    const undo = async () => { await input.focus(); await page.keyboard.press('Control+z'); };

    // Under written text: the text stays, a row opens beneath it, the placeholder stays blank, ghost lines show.
    await input.fill(OLD);
    await page.waitForTimeout(250);
    const idle = await height();
    await record();
    await page.waitForTimeout(450);
    assert.ok(await height() >= idle + 36, `${mode}: a row opens under the written text`);
    assert.ok(await opacity() > 0.4, `${mode}: the written text stays visible while recording`);
    await send({ type: 'micState', state: 'processing', target: true });
    await page.waitForTimeout(900);
    assert.equal(await input.evaluate(el => getComputedStyle(el, '::placeholder').color), 'rgba(0, 0, 0, 0)', `${mode}: no placeholder text while processing`);
    const ghosts = await page.evaluate(() => ['::before', '::after'].map(pseudo => Number(getComputedStyle(document.querySelector('.voice-overlay'), pseudo).opacity)));
    assert.deepEqual(ghosts, [1, 1], `${mode}: two ghost lines stand where the new lines will appear`);
    if (shot('x')) await composer.screenshot({ path: shot(`${mode}-processing`) });

    // The transcript lands on a new line under the old text.
    await land();
    await page.waitForTimeout(1300);
    assert.equal(await input.inputValue(), `${OLD}\n${NEW}`, `${mode}: new line after the written text`);
    assert.equal(await composer.evaluate(el => el.classList.contains('has-voice-row')), false, `${mode}: the row is given back`);
    assert.equal(await input.evaluate(el => el.classList.contains('is-revealing')), false, `${mode}: the reveal mask is gone`);
    if (shot('x')) await composer.screenshot({ path: shot(`${mode}-done`) });

    // One Ctrl+Z undoes the whole dictation, and the box shrinks back.
    await undo();
    assert.equal(await input.inputValue(), OLD, `${mode}: Ctrl+Z removes the dictation`);
    await page.waitForTimeout(500);
    assert.equal(await height(), idle, `${mode}: the box returns to its height`);

    // Empty box: no row, the transcript is the first text, Ctrl+Z empties it again.
    await input.fill('');
    await page.waitForTimeout(250);
    const empty = await height();
    await record();
    assert.equal(await height(), empty, `${mode}: an empty box does not grow`);
    await send({ type: 'micState', state: 'processing', target: true });
    await land();
    await page.waitForTimeout(1300);
    assert.equal(await input.inputValue(), NEW);
    await undo();
    assert.equal(await input.inputValue(), '', `${mode}: Ctrl+Z over a dictation into an empty box empties it`);

    // A cancelled recording gives the row back and never touches the text.
    await input.fill(OLD);
    await page.waitForTimeout(250);
    const before = await height();
    await record();
    await send({ type: 'micState', state: 'idle', target: true });
    await page.waitForTimeout(700);
    assert.equal(await height(), before, `${mode}: a cancelled recording gives the row back`);
    assert.equal(await input.inputValue(), OLD);

    // A long draft scrolls inside the capped box and the row still sits under its last line.
    await input.fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long written prompt`).join('\n'));
    await page.waitForTimeout(250);
    await record();
    await send({ type: 'micState', state: 'processing', target: true });
    await page.waitForTimeout(700);
    const long = await input.evaluate(el => ({ scrolledToEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 1, box: el.offsetHeight }));
    assert.equal(long.scrolledToEnd, true, `${mode}: the last written line is in view above the row`);
    assert.ok(long.box <= 140 + 40 + 1, `${mode}: the capped box stays capped`);
    await land();
    await page.waitForTimeout(1300);
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  }
  console.log('voice landing: row under written text, ghost lines, no placeholder, new line, one-step Ctrl+Z, cancel, long drafts passed.');
} finally { await browser.close(); }
