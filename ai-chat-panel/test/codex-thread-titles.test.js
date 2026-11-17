'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexThreadTitles, codexThreadTitle } = require('../lib/codex-thread-titles');

test('saved title repair stays outside activation and yields between chats', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [], calls = [];
  const sync = new CodexThreadTitles({ server: { async request(method, params) { calls.push({ method, ...params }); }, dispose() {} } });
  sync.repairSaved({
    list: () => [{ id: 'a', models: ['codex'] }, { id: 'skip', models: ['claude'] }, { id: 'b', models: ['codex'] }, { id: 'c', models: ['codex'] }],
    load: id => { reads.push(id); return { projectId: 'p', title: id, sessions: { codex: { id } } }; },
  }, { get: () => ({ name: 'Project' }) });
  assert.deepEqual(reads, []);
  t.mock.timers.tick(3000); await sync.queue;
  assert.deepEqual(reads, ['a']);
  t.mock.timers.tick(10); await sync.queue;
  assert.deepEqual(reads, ['a', 'b']);
  assert.ok(calls.every(call => call.method === 'thread/name/set'));
  sync.dispose();
  t.mock.timers.tick(10000);
  assert.deepEqual(reads, ['a', 'b'], 'disposal cancels remaining repair');
});

test('Codex names use the Clanker marker, project and chat title, never the handoff', () => {
  assert.equal(codexThreadTitle({ title: 'Customer edit mode', taskState: { latestRequest: 'PRIVATE HANDOFF' } }, { name: 'Visor' }), '🤖 Visor · Customer edit mode');
  assert.equal(codexThreadTitle({ messages: [{ role: 'user', text: 'Fix login' }] }, { name: 'Project\nName' }), '🤖 Project Name · Fix login');
});

test('metadata sync deduplicates saves, updates renames and session replacements, and retries errors', async () => {
  const calls = [], errors = [];
  let fail = false;
  const server = { async request(method, params) { calls.push({ method, params }); if (fail) throw new Error('offline'); }, dispose() {} };
  const sync = new CodexThreadTitles({ server, onError: error => errors.push(error.message) });
  const chat = { title: 'Fix login', sessions: { codex: { id: 'thread-one' } } };
  const project = { name: 'Clanker Controller' };
  await sync.sync({}, project);
  await Promise.all([sync.sync(chat, project), sync.sync(chat, project)]);
  assert.deepEqual(calls, [{ method: 'thread/name/set', params: { threadId: 'thread-one', name: '🤖 Clanker Controller · Fix login' } }]);
  chat.title = 'Login repaired';
  await sync.sync(chat, project);
  project.name = 'New project';
  await sync.sync(chat, project);
  chat.sessions.codex.id = 'thread-two';
  fail = true;
  await sync.sync(chat, project);
  assert.deepEqual(errors, ['offline']);
  fail = false;
  await sync.sync(chat, project);
  assert.equal(calls.at(-1).params.threadId, 'thread-two');
  assert.equal(calls.at(-1).params.name, '🤖 New project · Login repaired');
  assert.ok(calls.every(call => call.method === 'thread/name/set'), 'no turns are started');
  const count = calls.length;
  sync.dispose();
  await sync.sync({ ...chat, title: 'Later' }, project);
  assert.equal(calls.length, count);
});

test('rapid name edits retain the latest requested title', async () => {
  const calls = [];
  const sync = new CodexThreadTitles({ server: { async request(_method, params) { calls.push(params); } } });
  const chat = { title: 'Old title', sessions: { codex: { id: 'thread' } } };
  const first = sync.sync(chat, { name: 'Visor' });
  chat.title = 'New title';
  await sync.sync(chat, { name: 'Visor' });
  await first;
  assert.deepEqual(calls, [{ threadId: 'thread', name: '🤖 Visor · New title' }]);
});
