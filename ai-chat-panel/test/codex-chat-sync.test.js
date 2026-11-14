'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { anchorTurn, mergeTurns, CodexChatSync } = require('../lib/codex-chat-sync');
const turn = (id, text, reply = 'Answer', status = 'completed') => ({ id, status, startedAt: 100, items: [
  { id: id + '-u', type: 'userMessage', content: [{ type: 'text', text }], startedAtMs: 100000 },
  { id: id + '-a', type: 'agentMessage', text: reply, startedAtMs: 101000 },
] });
const chat = () => ({ sessions: { codex: { id: 'thread', seen: 2 } }, messages: [
  { role: 'user', agent: 'codex', text: 'Original prompt', at: new Date(100000).toISOString() },
  { role: 'assistant', agent: 'codex', text: 'Original answer' },
] });

test('older chats anchor after the Clanker handoff; external turns import exactly once', () => {
  const c = chat(), turns = [turn('local', 'PROJECT: test\nHANDOFF\nOriginal prompt'), turn('external', 'New ChatGPT prompt')];
  const anchor = anchorTurn(c, turns);
  assert.equal(anchor, 'local');
  assert.equal(mergeTurns(c, turns, anchor).changed, true);
  assert.equal(c.messages.length, 4);
  assert.equal(c.messages[2].text, 'New ChatGPT prompt');
  assert.equal(c.sessions.codex.seen, 4);
  assert.equal(mergeTurns(c, turns, anchorTurn(c, turns)).changed, false);
  assert.equal(c.messages.length, 4);
});

test('partial replies grow in place, tool results persist, and the completion advances the cursor', () => {
  const c = chat(), turns = [turn('local', 'Original prompt'), turn('remote', 'New prompt', 'Half', 'inProgress')];
  turns[1].items.push({ id: 'tool', type: 'mcpToolCall', server: 'browser', tool: 'open', arguments: { url: 'https://example.com' }, status: 'inProgress' });
  let result = mergeTurns(c, turns, 'local');
  assert.equal(result.active, true);
  assert.equal(c.codexSync.turnId, 'local');
  turns[1].items[1].text = 'Whole answer';
  turns[1].items[2].status = 'completed';
  turns[1].items[2].result = { content: [{ type: 'text', text: 'Opened page' }] };
  turns[1].status = 'completed';
  result = mergeTurns(c, turns, anchorTurn(c, turns));
  assert.equal(result.active, false);
  assert.equal(c.messages.filter(m => m.role === 'assistant').at(-1).text, 'Whole answer');
  assert.equal(c.messages.at(-1).event.output, 'Opened page');
  assert.equal(c.messages.at(-1).done, true);
  assert.equal(c.codexSync.turnId, 'remote');
  assert.equal(c.messages.length, 5);
});

test('unknown anchors and old same-text prompts never import handoff content', () => {
  const c = chat(), t = turn('old', 'Original prompt'); t.startedAt = 0;
  c.messages[0].at = new Date(10000000).toISOString();
  assert.equal(anchorTurn(c, [t]), null);
  assert.deepEqual(mergeTurns(c, [t], 'missing'), { changed: false, active: false });
  c.codexSync = { threadId: 'thread', turnId: 'on-an-older-page' };
  assert.equal(anchorTurn(c, [t]), null, 'a persisted cursor must actually occur on a fetched page');
});

test('polls paginate to the anchor, replay changed panels, and never write to the native thread', async () => {
  const calls = [], c = chat(); let saves = 0, replays = 0;
  const run = { chat: c, hosts: new Set([{ replay({ synced }) { assert.equal(synced, true); replays++; } }]), deps: { notifyHistory() {} }, save() { saves++; } };
  const server = { async request(method, params) { calls.push(method); return params.cursor ? { data: [turn('local', 'Original prompt')], nextCursor: null } : { data: [turn('remote', 'Remote prompt')], nextCursor: 'older' }; }, dispose() {} };
  const sync = new CodexChatSync({ server });
  try {
    await sync.sync(run);
    assert.equal(c.messages.length, 4); assert.equal(saves, 1); assert.equal(replays, 1);
    assert.deepEqual(calls, ['thread/turns/list', 'thread/turns/list']);
    run.turn = {};
    await sync.sync(run);
    assert.equal(calls.length, 2, 'local streaming owns its messages');
  } finally { sync.dispose(); }
});
