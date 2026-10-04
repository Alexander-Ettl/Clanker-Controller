'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore, recoverInterruptedChat, ownedByAnotherHost } = require('../lib/chat-store');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-recovery-'));
  const store = new ChatStore(dir);
  t.after(() => { store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('damaged or missing primary snapshots load from the backup and stay listed', t => {
  const store = fixture(t), chat = store.create();
  chat.messages.push({ role: 'assistant', text: 'Saved answer', at: '2026-10-04T10:00:00Z' });
  store.save(chat); store.save(chat);
  const file = store.fileFor(chat.id);
  fs.writeFileSync(file, '{"messages":');
  assert.equal(store.load(chat.id).messages[0].text, 'Saved answer');
  assert.equal(store.list()[0].id, chat.id);
  store.save(store.load(chat.id));
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).messages[0].text, 'Saved answer');
  fs.unlinkSync(file);
  assert.equal(store.fileFor(chat.id), file);
  assert.equal(store.load(chat.id).messages[0].text, 'Saved answer');
  assert.equal(store.list().length, 1);
  assert.equal(store.delete(chat.id), true);
  assert.equal(store.load(chat.id), null);
  assert.equal(store.list().length, 0, 'deleting a chat also deletes its recovery copy');
});

test('a failed atomic replacement leaves the original intact and cleans its temporary file', t => {
  const store = fixture(t), chat = store.save(store.create());
  const file = store.fileFor(chat.id), original = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('Simulated interruption'); };
  try {
    chat.messages.push({ role: 'assistant', text: 'New snapshot' });
    assert.throws(() => store.save(chat), /Simulated interruption/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readdirSync(store.dir).some(name => name.endsWith('.tmp')), false);
});

test('legacy unfinished replies recover once without changing completed or user-stopped replies', () => {
  const chat = { updatedAt: '2026-10-04T10:00:00Z', messages: [
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'Complete', at: '2026-10-04T09:00:00Z' },
    { role: 'assistant', text: 'Stopped', interrupted: true },
  ] };
  assert.equal(recoverInterruptedChat(chat), true);
  assert.equal(chat.messages[0].interruptionReason, 'host_shutdown');
  assert.equal(chat.messages[1].interrupted, undefined);
  assert.equal(chat.messages[2].interruptionReason, undefined);
  assert.equal(recoverInterruptedChat(chat), false);
});

test('another live IDE host owns its running chat; reads cannot recover it and writes cannot overwrite it', t => {
  const store = fixture(t), chat = store.create();
  chat.messages.push({ role: 'assistant', text: 'Still working', inProgress: true, hostPid: process.ppid });
  store.save(chat);
  const snapshot = store.load(chat.id);
  assert.equal(ownedByAnotherHost(snapshot), true);
  assert.equal(recoverInterruptedChat(snapshot), false);
  assert.equal(snapshot.messages[0].interrupted, undefined);
  assert.throws(() => store.save({ ...snapshot, messages: [] }), /another IDE window/);
  assert.throws(() => store.rename(chat.id, 'Overwrite title'), /another IDE window/);
  assert.throws(() => store.delete(chat.id), /another IDE window/);
  assert.equal(store.load(chat.id).messages[0].text, 'Still working');
});
