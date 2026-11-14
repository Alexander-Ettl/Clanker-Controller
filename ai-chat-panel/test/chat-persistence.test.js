'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('../lib/chat-store');
const { CACHE_BYTES } = require('../lib/tool-output-store');
const { historyPage } = require('../lib/chat-history');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-persistence-'));
  const store = new ChatStore(root);
  t.after(() => { store.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  return store;
}
const output = i => `Result ${i}: Unicode \u{1f916} and exact whitespace\r\n`.repeat(1500);

test('legacy snapshots migrate on save, preserve full output, forks and backup recovery', t => {
  const store = fixture(t), chat = store.create();
  chat.messages = [{ role: 'user', text: 'Keep everything' }, { role: 'tool', event: { name: 'Read', output: output(1) } }];
  const file = store.fileFor(chat.id);
  fs.writeFileSync(file, JSON.stringify(chat));
  const legacy = store.load(chat.id);
  store.save(legacy);
  const disk = JSON.parse(fs.readFileSync(file));
  assert.equal(disk.messages[1].event.output, undefined);
  assert.equal(disk.messages[1].event.outputBlob.bytes, Buffer.byteLength(output(1)));
  assert.ok(fs.statSync(file).size < 2000);
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).messages[1].event.output, output(1));
  const loaded = new ChatStore(path.dirname(store.dir)).load(chat.id);
  assert.equal(loaded.messages[1].event.output, output(1));
  assert.equal(JSON.parse(JSON.stringify(loaded)).messages[1].event.output, output(1), 'exports contain complete output');
  const fork = store.save({ ...loaded, id: store.create().id });
  store.save(loaded); // backup now also contains references
  fs.writeFileSync(file, '{broken');
  assert.equal(store.load(chat.id).messages[1].event.output, output(1));
  store.delete(chat.id);
  assert.equal(store.load(fork.id).messages[1].event.output, output(1), 'deleting the original preserves shared blobs');
  fork.messages[1].event.output = output(2);
  store.save(fork);
  assert.equal(store.load(fork.id).messages[1].event.output, output(2), 'tool completion can replace a lazy output');
});

test('cold opens, summaries, forks and checkpoints do not decode unrequested tool output', t => {
  const store = fixture(t), chat = store.create();
  chat.messages = Array.from({ length: 30 }, (_, i) => [{ role: 'user', text: `Prompt ${i}` }, { role: 'tool', event: { output: output(i) } }]).flat();
  store.save(chat);
  const cold = new ChatStore(path.dirname(store.dir));
  const read = fs.readFileSync;
  let blobs = 0;
  t.mock.method(fs, 'readFileSync', (...args) => { if (String(args[0]).endsWith('.gz')) blobs++; return read(...args); });
  cold.list();
  const loaded = cold.load(chat.id);
  cold.save(loaded);
  cold.save({ ...loaded, id: cold.create().id });
  assert.equal(blobs, 0);
  JSON.stringify(historyPage(loaded.messages));
  assert.equal(blobs, 12, 'only the requested page resolves tool bodies');
  JSON.stringify(historyPage(loaded.messages));
  assert.equal(blobs, 12, 'decoded recent output is cached');
  assert.ok(cold.outputs.bytes <= CACHE_BYTES);
});

test('decoded output cache obeys its byte budget and corrupt blobs fail explicitly', t => {
  const store = fixture(t), chat = store.create();
  chat.messages = Array.from({ length: 6 }, (_, i) => ({ role: 'tool', event: { output: `${i}:` + 'x'.repeat(1024 * 1024) } }));
  store.save(chat);
  const cold = new ChatStore(path.dirname(store.dir)), loaded = cold.load(chat.id);
  for (const message of loaded.messages) assert.equal(message.event.output.length, 1024 * 1024 + 2);
  assert.ok(cold.outputs.bytes <= CACHE_BYTES);
  const ref = JSON.parse(fs.readFileSync(store.fileFor(chat.id))).messages[0].event.outputBlob;
  fs.writeFileSync(cold.outputs.file(ref), 'broken gzip');
  assert.throws(() => loaded.messages[0].event.output);
});

test('a checkpoint cannot overwrite a final save, flush or resurrect a deleted chat', async t => {
  const store = fixture(t), chat = store.save(store.create());
  const originalOpen = fs.promises.open;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let gate = blocked;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...values) => { await gate; return write(...values); };
    return handle;
  });
  chat.draft = 'older';
  store.checkpoint(chat); await delay(280);
  const first = store.writes.get(chat.id).promise;
  chat.draft = 'final'; store.save(chat);
  release(); await first;
  assert.equal(store.load(chat.id).draft, 'final');
  chat.draft = 'flush';
  let releaseFlush;
  const flushBlock = new Promise(resolve => { releaseFlush = resolve; });
  gate = flushBlock;
  store.checkpoint(chat); await delay(280);
  const flushing = store.writes.get(chat.id).promise;
  store.flush(); releaseFlush(); await flushing;
  assert.equal(store.load(chat.id).draft, 'flush');
  // Leave the next async write in flight, then delete synchronously.
  let releaseDelete;
  const deleteBlock = new Promise(resolve => { releaseDelete = resolve; });
  gate = deleteBlock;
  store.checkpoint(chat); await delay(280);
  const last = store.writes.get(chat.id).promise;
  store.delete(chat.id); releaseDelete(); await last;
  assert.equal(store.load(chat.id), null);
});

test('checkpoint failures remain flushable and incomplete UTF-16 stays lossless', async t => {
  const store = fixture(t), chat = store.save(store.create());
  chat.messages = [{ role: 'tool', event: { output: 'x'.repeat(20000) + '\ud800' } }];
  store.save(chat);
  assert.equal(store.load(chat.id).messages[0].event.output, chat.messages[0].event.output);
  const original = fs.promises.open;
  let fail = true;
  t.mock.method(fs.promises, 'open', async (...args) => { if (fail) throw new Error('test disk failure'); return original(...args); });
  chat.draft = 'must survive'; store.checkpoint(chat); await delay(280);
  await store.writes.get(chat.id).promise;
  assert.ok(store.writes.get(chat.id).error);
  fail = false;
  store.flush();
  assert.equal(store.load(chat.id).draft, 'must survive');
});

test('async checkpoints recheck cross-window ownership at commit time', async t => {
  const store = fixture(t), chat = store.save(store.create());
  const original = fs.promises.open;
  let release;
  const block = new Promise(resolve => { release = resolve; });
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await original(...args), write = handle.writeFile.bind(handle);
    handle.writeFile = async (...values) => { await block; return write(...values); }; return handle;
  });
  chat.draft = 'local draft'; store.checkpoint(chat); await delay(280);
  const pending = store.writes.get(chat.id).promise;
  const other = { ...chat, messages: [{ role: 'assistant', text: 'Other IDE', inProgress: true, hostPid: process.ppid }] };
  fs.writeFileSync(store.fileFor(chat.id), JSON.stringify(other));
  release(); await pending;
  assert.match(store.writes.get(chat.id).error.message, /another IDE window/);
  assert.equal(store.load(chat.id).messages[0].text, 'Other IDE');
  store.cancelCheckpoint(chat.id); // do not flush across the other owner's snapshot
});
