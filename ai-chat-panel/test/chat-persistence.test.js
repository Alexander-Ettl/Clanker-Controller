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

// Waits until the throttled checkpoint has run and its write has finished.
async function written(store, id) {
  for (let i = 0; i < 200 && (store.checkpoints.has(id) || store.writes.has(id)); i++) await delay(10);
  assert.equal(store.checkpoints.has(id) || store.writes.has(id), false, 'the checkpoint finished');
}

function longChat(store, settled = 300) {
  const chat = store.save({ ...store.create(), title: 'Long' });
  chat.messages = [];
  for (let i = 0; i < settled; i++) {
    chat.messages.push({ role: 'user', text: `Question ${i}` }, { role: 'assistant', text: `Answer ${i}`, agent: 'codex', at: '2026-01-01T00:00:00Z' });
    chat.messages.push({ role: 'tool', event: { name: 'Read', file: `f${i}.js`, output: i % 50 === 0 ? output(i) : 'ok' }, done: true });
  }
  chat.messages.push({ role: 'user', text: 'Now' }, { role: 'assistant', text: '', agent: 'codex', inProgress: true, hostPid: process.pid });
  return chat;
}

test('a checkpoint that reuses the settled history writes exactly what a full save would', async t => {
  const store = fixture(t), chat = longChat(store);
  const settled = chat.messages.length - 2;
  store.checkpoint(chat, { settled });
  await written(store, chat.id);
  const cached = store.heads.get(chat.id);
  assert.ok(cached && cached.count === settled, 'the settled history was serialised once');
  chat.messages.at(-1).text = 'streaming…';
  store.checkpoint(chat, { settled });
  await written(store, chat.id);
  assert.equal(store.heads.get(chat.id), cached, 'the next checkpoint reuses it');
  const viaCheckpoint = JSON.parse(fs.readFileSync(store.fileFor(chat.id), 'utf8'));
  delete viaCheckpoint.updatedAt;
  store.save(chat);
  const viaSave = JSON.parse(fs.readFileSync(store.fileFor(chat.id), 'utf8'));
  delete viaSave.updatedAt;
  assert.deepEqual(viaCheckpoint, viaSave);
  assert.equal(store.load(chat.id).messages[2].event.output, output(0), 'big tool output still resolves');
});

test('a full save drops the reused history, so a changed settled message is never written stale', async t => {
  const store = fixture(t), chat = longChat(store, 20);
  const settled = chat.messages.length - 2;
  store.checkpoint(chat, { settled });
  await written(store, chat.id);
  assert.ok(store.heads.get(chat.id));
  chat.messages[0].text = 'Edited question';
  store.save(chat);
  assert.equal(store.heads.get(chat.id), undefined);
  store.checkpoint(chat, { settled });
  await written(store, chat.id);
  assert.equal(JSON.parse(fs.readFileSync(store.fileFor(chat.id), 'utf8')).messages[0].text, 'Edited question');
});

test('trusted checkpoints skip re-reading the file and refresh the backup only now and then', async t => {
  const store = fixture(t), chat = longChat(store, 20);
  const settled = chat.messages.length - 2;
  store.checkpoint(chat, { settled });
  await written(store, chat.id);
  const file = store.fileFor(chat.id);
  const backupBefore = fs.statSync(file + '.bak').mtimeMs;
  const reads = [];
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...rest) => { reads.push(String(target)); return read(target, ...rest); });
  chat.messages.at(-1).text = 'more';
  store.checkpoint(chat, { settled });
  await written(store, chat.id);
  assert.deepEqual(reads.filter(name => name === file), [], 'the existing snapshot was not parsed again');
  assert.equal(fs.statSync(file + '.bak').mtimeMs, backupBefore, 'a fresh backup is left alone');
  assert.equal(JSON.parse(read(file, 'utf8')).messages.at(-1).text, 'more');
});

test('an idle chat saves a changed draft without serialising its messages again', async t => {
  const store = fixture(t), chat = longChat(store, 20);
  chat.messages.pop(); chat.messages.pop();
  const settled = chat.messages.length;
  store.checkpoint(chat, { settled });
  await written(store, chat.id);
  const head = store.heads.get(chat.id);
  chat.draft = 'half-typed thought';
  store.checkpoint(chat, { settled });
  await written(store, chat.id);
  assert.equal(store.heads.get(chat.id), head);
  const disk = JSON.parse(fs.readFileSync(store.fileFor(chat.id), 'utf8'));
  assert.equal(disk.draft, 'half-typed thought');
  assert.equal(disk.messages.length, settled);
});

test('the summary index lets a restarted store list chats without parsing them, and notices changes', async t => {
  const store = fixture(t);
  const a = store.save({ ...store.create(), title: 'First', messages: [{ role: 'user', text: 'hello', at: '2026-01-01T00:00:00Z' }] });
  const b = store.save({ ...store.create(), title: 'Second', messages: [{ role: 'user', text: 'world', at: '2026-01-02T00:00:00Z' }] });
  assert.equal(store.list().length, 2);
  await store.writeIndex();
  assert.ok(fs.existsSync(store.indexFile), 'the index is a cache beside the chats folder, never inside it');
  const root = path.dirname(store.dir);

  const parsed = [];
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...rest) => { if (String(target).endsWith('.json')) parsed.push(path.basename(String(target))); return read(target, ...rest); });
  const restarted = new ChatStore(root);
  const titles = restarted.list().map(entry => entry.title).sort();
  assert.deepEqual(titles, ['First', 'Second']);
  assert.deepEqual(parsed.filter(name => name !== 'chat-summaries.json'), [], 'no snapshot was parsed');

  parsed.length = 0;
  const changed = restarted.load(a.id); changed.title = 'First, renamed'; restarted.save(changed);
  const again = new ChatStore(root);
  assert.deepEqual(again.list().map(entry => entry.title).sort(), ['First, renamed', 'Second']);
  assert.ok(parsed.some(name => name.includes(a.id)), 'the changed chat was read again');
  assert.ok(!parsed.some(name => name.includes(b.id)), 'the untouched chat was not');
});

test('a damaged or outdated summary index is ignored', async t => {
  const store = fixture(t);
  store.save({ ...store.create(), title: 'Only', messages: [{ role: 'user', text: 'x', at: '2026-01-01T00:00:00Z' }] });
  fs.writeFileSync(store.indexFile, '{ not json');
  assert.equal(new ChatStore(path.dirname(store.dir)).list()[0].title, 'Only');
  fs.writeFileSync(store.indexFile, JSON.stringify({ v: 999, entries: { 'x.json': { stamp: 's', summary: { id: 'x' }, files: [] } } }));
  assert.equal(new ChatStore(path.dirname(store.dir)).list().length, 1);
});
