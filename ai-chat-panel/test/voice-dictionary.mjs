import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
require('./model-fixture').seedModels();
const { learnedTerms } = require('../lib/voice-learn');
const { addTerm, listEnabledTerms } = require('../lib/voice-dictionary');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-voice-dictionary-'));
const paths = { dictionaryFile: path.join(temporary, 'dictionary.json') };
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
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 720 } });
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
    window.sent = []; window.saved = {};
    window.acquireVsCodeApi = () => ({ postMessage: message => window.sent.push(message), getState: () => window.saved, setState: state => { window.saved = state; } });
  });
  await page.clock.install();
  await page.goto(origin);
  const post = async message => {
    await page.evaluate(message => window.postMessage(message, '*'), message);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  };
  const input = page.locator('#promptInput');
  const latest = type => page.evaluate(type => window.sent.filter(message => message.type === type).at(-1), type);
  const suggestions = async () => {
    try {
      await page.waitForFunction(() => window.sent.filter(message => message.type === 'voiceDraftEdited').at(-1)?.edited === document.getElementById('promptInput').value, null, { timeout: 5000 });
    } catch (error) {
      console.error(await page.evaluate(() => ({ input: document.getElementById('promptInput').value, sent: window.sent })), errors);
      throw error;
    }
    const request = await latest('voiceDraftEdited');
    await post({ type: 'voiceDictionarySuggestions', requestId: request.requestId, terms: learnedTerms(request.original, request.edited) });
    return request;
  };
  await post({ type: 'voiceResult', output: { cleanedPrompt: 'open the tech no matrix model' } });
  await input.fill('open the Tecnomatix model');
  const request = await suggestions();
  await page.getByRole('button', { name: 'Cancel adding Tecnomatix to voice dictionary' }).waitFor();
  assert.equal(await page.locator('.voice-dictionary-countdown').textContent(), '10s');
  await page.clock.runFor(600); // allow the fused notice to finish emerging before visual inspection
  await page.screenshot({ path: path.join(os.tmpdir(), 'clanker-voice-dictionary-preview.png') });
  await page.clock.runFor(8400);
  assert.equal(await latest('voiceDictionarySave'), undefined, 'nothing is saved before the ten-second cancel window ends');
  assert.deepEqual(listEnabledTerms(paths), []);
  await page.clock.runFor(1100);
  const save = await latest('voiceDictionarySave');
  assert.equal(save.term, 'Tecnomatix');
  assert.ok(learnedTerms(save.original, save.edited).includes(save.term));
  addTerm(paths, save.term, { replaceSpelling: true });
  await post({ type: 'voiceTermsLearned', requestId: save.requestId, terms: [save.term] });
  await page.waitForFunction(() => document.querySelector('.voice-dictionary-bud').hidden);
  assert.deepEqual(listEnabledTerms(paths), ['Tecnomatix'], 'uncancelled spelling persists after the countdown');

  await input.fill('');
  await post({ type: 'voiceResult', output: { cleanedPrompt: 'write the simtalk method' } });
  await input.fill('write the SimTalk method');
  await suggestions();
  await page.getByRole('button', { name: 'Cancel adding SimTalk to voice dictionary' }).waitFor();
  await page.clock.runFor(9000);
  await page.getByRole('button', { name: 'Cancel adding SimTalk to voice dictionary' }).click();
  await page.clock.runFor(1100);
  assert.equal((await latest('voiceDictionarySave')).term, 'Tecnomatix', 'late cancellation prevents saving');
  assert.deepEqual(listEnabledTerms(paths), ['Tecnomatix']);
  await input.fill('write the SimTalk method please');
  await suggestions();
  assert.equal(await page.locator('.voice-dictionary-bud').isVisible(), false, 'dismissed word stays dismissed for this recording');

  await input.fill('');
  await post({ type: 'voiceResult', output: { cleanedPrompt: 'use the simtalk method' } });
  await input.fill('use the SimTalk method');
  const next = await suggestions();
  await page.getByRole('button', { name: 'Cancel adding SimTalk to voice dictionary' }).waitFor();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(20000);
  assert.equal((await latest('voiceDictionarySave')).term, 'Tecnomatix', 'hidden chat does not consume the cancellation window');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(9000);
  assert.equal((await latest('voiceDictionarySave')).term, 'Tecnomatix', 'returning to chat still leaves the cancellation window');
  await page.clock.runFor(1100);
  assert.equal((await latest('voiceDictionarySave')).term, 'SimTalk');
  await post({ type: 'voiceDictionaryError', requestId: next.requestId, term: 'SimTalk', message: 'Could not save to voice dictionary: disk is read-only' });
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  assert.equal(await page.locator('.voice-dictionary-countdown').textContent(), '10s', 'retry gives a fresh cancel window');
  await page.getByRole('button', { name: 'Cancel adding SimTalk to voice dictionary' }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'prompt fits narrow chat windows');
  await input.fill('');
  await post({ type: 'voiceDictionarySuggestions', requestId: next.requestId, terms: ['StaleWord'] });
  assert.equal(await page.locator('.voice-dictionary-bud').isVisible(), false, 'cleared draft rejects stale responses');
  await post({ type: 'voiceDictionarySuggestions', requestId: request.requestId, terms: ['OtherChatWord'] });
  assert.equal(await page.locator('.voice-dictionary-bud').isVisible(), false);

  await post({ type: 'chatLoaded', chat: { id: 'voice-chat-a', messages: [] } });
  await input.fill('typed introduction');
  await post({ type: 'voiceResult', output: { cleanedPrompt: 'use the simtalk method' } });
  await input.fill('typed introduction\nuse the SimTalk method');
  await page.waitForFunction(() => window.sent.filter(message => message.type === 'voiceDraftEdited').at(-1)?.edited === 'use the SimTalk method');
  const prefixed = await latest('voiceDraftEdited');
  assert.equal(prefixed.original, 'use the simtalk method', 'typed prefix is outside the learning region');
  await post({ type: 'chatLoading' });
  await post({ type: 'chatLoaded', chat: { id: 'voice-chat-b', messages: [] } });
  await post({ type: 'voiceDictionarySuggestions', requestId: prefixed.requestId, terms: ['SimTalk'] });
  assert.equal(await page.locator('.voice-dictionary-bud').isVisible(), false, 'old chat cannot show suggestions in the new chat');
  assert.equal(await input.inputValue(), '');
  const savesBefore = await page.evaluate(() => window.sent.filter(message => message.type === 'voiceDictionarySave').length);
  await page.clock.runFor(11000);
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'voiceDictionarySave').length), savesBefore, 'chat switch cancels pending addition timers');
  const count = await page.evaluate(() => window.sent.filter(message => message.type === 'voiceDraftEdited').length);
  await input.fill('a fresh typed prompt');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'voiceDraftEdited').length), count, 'new chat does not learn from the previous chat');
  assert.deepEqual(errors, []);
  console.log('Voice dictionary: ten-second countdown, late trash cancellation, hidden-window pause, persistence, retry, typed prefixes, chat switching, stale responses and narrow layout passed.');
} finally {
  await browser.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
