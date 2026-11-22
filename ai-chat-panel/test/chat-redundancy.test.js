'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChatRecovery } = require('../lib/chat-recovery.js');
const { ChatStore } = require('../lib/chat-store.js');
const { ProjectRegistry } = require('../lib/projects.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, 'session');
  const archive = path.join(root, 'recovery');
  const open = () => {
    const recovery = new ChatRecovery(session, archive);
    return { recovery, store: new ChatStore(session, recovery), projects: new ProjectRegistry(session, recovery) };
  };
  return { root, session, archive, open };
}

test('protects existing history from valid JSON overwrites and restores a missing primary directory', async t => {
  const { root, session, open } = fixture(t);
  const oldStore = new ChatStore(session);
  const attachment = path.join(session, 'projects', 'p', 'attachments', 'photo.png');
  fs.mkdirSync(path.dirname(attachment), { recursive: true });
  fs.writeFileSync(attachment, 'attached bytes');
  const output = 'tool output '.repeat(2000);
  const chat = oldStore.save({ ...oldStore.create(), messages: [
    { role: 'user', text: 'My old discussion', attachments: [attachment] },
    { role: 'tool', event: { output } },
  ] });
  const { recovery, store, projects } = open();
  projects.write([{ id: 'p', name: 'Project', root, icon: 'logo.svg' }]);
  store.seedRecovery();
  await recovery.flush();

  const file = store.fileFor(chat.id);
  fs.writeFileSync(file, JSON.stringify({ id: chat.id, messages: [] }));
  fs.writeFileSync(projects.file, '[]');
  assert.equal(store.list()[0].messageCount, 1);
  assert.equal(projects.list()[0].icon, 'logo.svg');

  fs.renameSync(session, path.join(root, 'lost-session'));
  const restored = open();
  assert.equal(restored.store.list()[0].id, chat.id);
  assert.equal(restored.store.load(chat.id).messages[0].text, 'My old discussion');
  assert.equal(restored.store.load(chat.id).messages[1].event.output, output);
  assert.equal(fs.readFileSync(attachment, 'utf8'), 'attached bytes');
  assert.equal(restored.projects.list()[0].id, 'p');
});

test('checks the ID and seal, backs up only committed changes, and keeps intentional deletions deleted', async t => {
  const { root, archive, open } = fixture(t);
  const { recovery, store } = open();
  const first = store.save({ ...store.create(), messages: [{ role: 'user', text: 'Original' }] });
  const second = store.save({ ...store.create(), messages: [{ role: 'user', text: 'Different chat' }] });
  await recovery.flush();

  const firstFile = store.fileFor(first.id);
  fs.copyFileSync(store.fileFor(second.id), firstFile);
  assert.equal(store.load(first.id).messages[0].text, 'Original');
  fs.writeFileSync(firstFile, fs.readFileSync(firstFile, 'utf8').replace('Original', 'Modified'));
  assert.equal(store.load(first.id).messages[0].text, 'Original');

  store.checkpoint({ ...first, messages: [{ role: 'user', text: 'Updated' }] }, { delay: 10000 });
  store.runCheckpoint(store.checkpoints.get(first.id));
  await store.writes.get(first.id).promise;
  assert.equal(open().store.load(first.id).messages[0].text, 'Updated');

  // A missing archive can be rebuilt using the independent copy of its key.
  fs.renameSync(archive, path.join(root, 'lost-archive'));
  const restarted = open();
  restarted.store.seedRecovery();
  await restarted.recovery.flush();
  const file = restarted.store.fileFor(first.id);
  assert.equal(restarted.store.delete(first.id), true);
  assert.throws(() => restarted.store.save(first), /deleted in another IDE window/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(open().store.load(first.id), null);
  assert.deepEqual(open().store.list().map(chat => chat.id), [second.id]);
});

test('uses the previous recovery generation when the live and newest backup are both lost', async t => {
  const { open } = fixture(t);
  const { recovery, store } = open();
  const chat = store.save({ ...store.create(), messages: [{ role: 'user', text: 'Earlier discussion' }] });
  await recovery.flush();
  store.save({ ...chat, messages: [...chat.messages, { role: 'assistant', text: 'New reply' }] });
  await recovery.flush();

  const file = store.fileFor(chat.id);
  fs.unlinkSync(file);
  fs.writeFileSync(recovery.file(file), 'truncated backup');
  assert.equal(open().store.load(chat.id).messages[0].text, 'Earlier discussion');
  assert.equal(open().store.load(chat.id).messages.length, 1);
});
