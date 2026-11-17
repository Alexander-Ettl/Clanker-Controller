'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { historyPage } = require('../lib/chat-history');
const { ChatStore } = require('../lib/chat-store');

test('history pages cover the original transcript once, at whole-turn boundaries', () => {
  const messages = Array.from({ length: 100 }, (_, i) => [
    { role: 'user', text: `Prompt ${i}`, compact: i === 95 },
    { role: 'assistant', text: `Reply ${i}`, agent: 'codex' },
    { role: 'tool', event: { toolId: `tool-${i}` }, offset: 4 },
  ]).flat();
  let before = messages.length, pages = [];
  do {
    const page = historyPage(messages, before);
    assert.equal(page.messages[0].role, 'user');
    assert.equal(page.historyUserStart, page.historyStart / 3);
    assert.ok(page.messages.length <= 36);
    assert.equal(page.historyEnd, before);
    pages.unshift(...page.messages);
    before = page.historyStart;
  } while (before);
  assert.deepEqual(pages, messages);
  assert.deepEqual(historyPage([]).messages, []);
  assert.equal(historyPage(messages, 0).historyStart, 0);
});

test('tool-heavy pages respect the record budget while retaining one oversized turn', () => {
  const turn = count => [{ role: 'user' }, ...Array.from({ length: count }, () => ({ role: 'tool' })), { role: 'assistant' }];
  const messages = [...turn(250), ...turn(60), ...turn(60), ...turn(60)];
  const recent = historyPage(messages);
  assert.equal(recent.messages.length, 124);
  const older = historyPage(messages, recent.historyStart);
  assert.equal(older.historyStart, 0);
  assert.equal(older.messages.length, 314);
  assert.deepEqual(historyPage([{ role: 'assistant', text: 'Legacy history without a user' }]).messages.length, 1);
});

test('history summaries avoid transcript reads and refresh after external edits, recovery and deletion', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  const chat = store.create();
  chat.messages.push({ role: 'user', text: 'First prompt' }, { role: 'tool', event: { file: 'C:/project/a.js', output: 'large output' } });
  store.save(chat);
  const file = store.fileFor(chat.id);
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => { if (!String(args[0]).endsWith('chat-summaries.json')) reads++; return read(...args); }); // the summary index is a cache of this very listing
  assert.equal(store.list()[0].title, 'First prompt');
  assert.equal(store.list(() => 'p1')[0].touchedProjectIds[0], 'p1');
  assert.equal(store.list(() => 'p2')[0].touchedProjectIds[0], 'p2', 'registry changes must not be cached');
  assert.equal(reads, 0, 'save primes metadata without reparsing disk');
  const cold = new ChatStore(root);
  cold.list(); const warmReads = reads;
  cold.list();
  assert.equal(reads, warmReads, 'unchanged history needs only file metadata');
  fs.writeFileSync(file, JSON.stringify({ ...chat, title: 'Externally renamed conversation' }));
  assert.equal(cold.list()[0].title, 'Externally renamed conversation');
  fs.writeFileSync(file + '.bak', JSON.stringify({ ...chat, title: 'Recovered backup' }));
  fs.writeFileSync(file, '{broken');
  assert.equal(cold.list()[0].title, 'Recovered backup');
  fs.writeFileSync(file + '.bak', JSON.stringify({ ...chat, title: 'Updated recovery snapshot' }));
  assert.equal(cold.list()[0].title, 'Updated recovery snapshot');
  fs.unlinkSync(file); fs.unlinkSync(file + '.bak');
  assert.deepEqual(cold.list(), []);
  assert.equal(cold.summaries.size, 0);
});

test('an idle chat is last active at its newest message, not at its last save', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-active-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  const old = new Date(Date.now() - 2 * 864e5).toISOString();
  const chat = store.create();
  chat.messages.push({ role: 'user', text: 'Yesterday', at: old }, { role: 'assistant', text: 'Done', at: old });
  store.save(chat); // closing a chat saves it again: updatedAt is now, the conversation is not
  assert.equal(store.list()[0].updatedAt, old);
  chat.messages.push({ role: 'assistant', text: 'Typing', inProgress: true });
  store.save(chat);
  assert.ok(store.list()[0].updatedAt > old, 'a running reply is current activity');
});
