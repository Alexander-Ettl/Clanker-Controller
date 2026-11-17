'use strict';

// lib/log.js feeds the Logs popup and the output channel; media/error-report.js feeds it from the webview.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const log = require('../lib/log.js');

test('entries keep level, source, message and the stack of an Error', () => {
  log.clear();
  log.warn('queue', 'Slow start');
  const error = new Error('boom');
  log.error('message', 'Handling "send" failed:', error);
  const [warn, failed] = log.entries();
  assert.deepStrictEqual([warn.level, warn.source, warn.message], ['warn', 'queue', 'Slow start']);
  assert.strictEqual(failed.message, 'Handling "send" failed: boom');
  assert.match(failed.stack, /log\.test\.js/);
  assert.match(log.format([failed]), /ERROR \[message\] Handling "send" failed: boom\n.*Error: boom/s);
});

test('the buffer keeps only the newest entries, and listeners hear appends and clears', () => {
  log.clear();
  log.error('early', 'kept');
  const heard = [];
  const stop = log.onEntry(entry => heard.push(entry ? entry.message : null));
  for (let i = 0; i < log.MAX_ENTRIES + 5; i++) log.debug('click', `#${i}`);
  assert.strictEqual(log.entries().length, log.MAX_ENTRIES);
  assert.strictEqual(log.entries()[0].message, 'kept', 'debug lines are dropped before an older error');
  assert.strictEqual(log.entries()[1].message, '#6');
  log.clear();
  stop();
  log.info('x', 'after');
  assert.strictEqual(heard.length, log.MAX_ENTRIES + 6); // the appends and the clear's null; 'after' came once unsubscribed
  assert.strictEqual(heard.at(-1), null);
});

test('an attached channel gets each entry at its level', () => {
  log.clear();
  const lines = [];
  log.attachChannel({ error: l => lines.push(['error', l]), warn: l => lines.push(['warn', l]), info: l => lines.push(['info', l]), debug: l => lines.push(['debug', l]) });
  try {
    log.error('a', 'one');
    log.add({ level: 'warn', source: 'notification', message: 'two', stack: 'at here' });
  } finally { log.attachChannel(null); }
  assert.deepStrictEqual(lines, [['error', '[a] one'], ['warn', '[notification] two\nat here']]);
});

test('webview reports are reduced to clipped plain fields', () => {
  log.clear();
  const entry = log.fromWebview({ level: 'nonsense', source: 'uncaught', message: 'x'.repeat(20000), stack: 42, extra: { huge: true } });
  assert.strictEqual(entry.level, 'error');
  assert.strictEqual(entry.source, 'webview: uncaught');
  assert.ok(entry.message.length < 8100);
  assert.strictEqual(entry.stack, '');
  assert.strictEqual(entry.origin, 'webview');
  assert.strictEqual(log.fromWebview(null), null);
});

test('error-report.js forwards uncaught errors, rejections and console.error, naming the click before them', () => {
  const posted = [];
  const listeners = {};
  const docListeners = {};
  const button = { nodeType: 1, tagName: 'BUTTON', id: 'sendBtn', dataset: {}, className: 'send-btn', textContent: '', getAttribute: name => (name === 'title' ? 'Send' : null), closest(selector) { return selector === '#logsModal' ? null : this; } };
  const consoleCalls = [];
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    console: { error: (...args) => consoleCalls.push(args), warn: () => {} },
    document: { addEventListener: (type, fn) => { docListeners[type] = fn; } },
    Date, JSON, Math, String, Error,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => { listeners[type] = fn; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'error-report.js'), 'utf8'), sandbox);

  assert.strictEqual(sandbox.acquireVsCodeApi(), sandbox.acquireVsCodeApi(), 'later scripts get the same API object');
  docListeners.click({ target: button });
  assert.deepStrictEqual([posted[0].level, posted[0].source, posted[0].message], ['debug', 'click', '"Send" button#sendBtn']);

  const thrown = new sandbox.Error('nope');
  listeners.error({ error: thrown, message: 'nope', filename: 'vscode-webview://x/media/main.js', lineno: 10, colno: 2 });
  assert.strictEqual(posted[1].level, 'error');
  assert.strictEqual(posted[1].message, 'nope');
  assert.match(posted[1].details, /after clicking "Send" button#sendBtn/);

  listeners.unhandledrejection({ reason: new sandbox.Error('later') });
  assert.match(posted[2].message, /Unhandled rejection: later/);

  sandbox.console.error('plain', { a: 1 });
  assert.strictEqual(consoleCalls.length, 1, 'the real console still gets the call');
  assert.strictEqual(posted[3].message, 'plain {"a":1}');
});
