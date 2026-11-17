'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { anchorTurn, mergeTurns, CodexChatSync, inputHash, repairImportedPrompts } = require('../lib/codex-chat-sync');
const turn = (id, text, reply = 'Answer', status = 'completed') => ({ id, status, startedAt: 100, items: [
  { id: id + '-u', type: 'userMessage', content: [{ type: 'text', text }], startedAtMs: 100000 },
  { id: id + '-a', type: 'agentMessage', text: reply, startedAtMs: 101000 },
] });
const chat = () => ({ sessions: { codex: { id: 'thread', seen: 2 } }, messages: [
  { role: 'user', agent: 'codex', text: 'Original prompt', at: new Date(100000).toISOString() },
  { role: 'assistant', agent: 'codex', text: 'Original answer' },
] });

const legacy = "The model was selected manually. Earlier Auto-mode role restrictions no longer apply. Follow the user's current request.\n\nPROJECT: Wittmann Website\n\n";

test('repairs the known legacy wrapper on imported prompts without changing actual user headings', () => {
  const c = chat();
  c.messages.push({ role: 'user', agent: 'codex', text: legacy + 'commit', codexItemId: 'imported' });
  c.messages.push({ role: 'user', text: 'PROJECT: Example\n\nKeep this heading', codexItemId: 'external' });
  c.messages.push({ role: 'user', text: legacy + 'quoted by the user' });
  c.messages.push({ role: 'user', text: legacy + 'TASK STATE:\nunknown handoff', codexItemId: 'full' });
  assert.equal(repairImportedPrompts(c), true);
  assert.equal(c.messages[2].text, 'commit');
  assert.equal(c.messages[3].text, 'PROJECT: Example\n\nKeep this heading');
  assert.equal(c.messages[4].text, legacy + 'quoted by the user');
  assert.match(c.messages[5].text, /^The model was selected manually/);
  assert.equal(repairImportedPrompts(c), false);
});

test('stale cursors do not reimport local turns or their expanded prompts', () => {
  const c = chat();
  const prompt = 'PROJECT: Example\n\nTASK STATE:\n{}\n\ncommit\n\nAttachment available locally: image.png';
  c.messages.push({ role: 'user', agent: 'codex', text: 'commit', attachments: ['image.png'], codexInputHashes: [inputHash(prompt)] });
  c.messages.push({ role: 'assistant', agent: 'codex', text: 'Committed', modelLabel: 'Chosen model' });
  const turns = [turn('anchor', 'Original prompt'), turn('local-later', prompt, 'Committed'), turn('external', 'New ChatGPT prompt')];
  mergeTurns(c, turns, 'anchor');
  assert.deepEqual(c.messages.filter(m => m.role === 'user').map(m => m.text), ['Original prompt', 'commit', 'New ChatGPT prompt']);
  assert.equal(c.messages[3].modelLabel, 'Chosen model');
  assert.deepEqual(c.messages[2].attachments, ['image.png']);
});

test('full handoffs recover display text from a known original without guessing at delimiters', () => {
  const c = chat();
  const prompt = 'PROJECT: Example\n\nTASK STATE:\n{}\n\nCHAT CONTEXT\ncommit';
  c.messages.push({ role: 'user', agent: 'codex', text: 'commit', codexInputHashes: [inputHash(prompt)] });
  c.messages.push({ role: 'user', agent: 'codex', text: prompt, codexItemId: 'imported-full' });
  assert.equal(repairImportedPrompts(c), true);
  assert.equal(c.messages.at(-1).text, 'commit');
  assert.equal(repairImportedPrompts(c), false);
});

test('input fingerprints anchor attachment prompts whose native text does not end with user text', () => {
  const c = chat(), prompt = 'PROJECT: Example\n\nOriginal prompt\n\nAttachment available locally: image.png';
  c.messages[0].codexInputHashes = [inputHash(prompt)];
  assert.equal(anchorTurn(c, [turn('local-with-image', prompt)]), 'local-with-image');
});

test('legacy local echoes preserve original text; orphan imports hide only the known wrapper', () => {
  const c = chat();
  c.messages.push({ role: 'user', agent: 'codex', text: 'commit', at: new Date(100000).toISOString() });
  const turns = [turn('anchor', 'Original prompt'), turn('local-later', legacy + 'commit'), turn('orphan', legacy + 'commit both')];
  mergeTurns(c, turns, 'anchor');
  assert.deepEqual(c.messages.filter(m => m.role === 'user').map(m => m.text), ['Original prompt', 'commit', 'commit both']);
  assert.equal(mergeTurns(c, turns, anchorTurn(c, turns)).changed, false);
});

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

test('the same prompt run again in the Codex app is imported, not mistaken for the local copy', () => {
  const run = (localAt) => {
    const c = chat();
    c.messages.push({ role: 'user', agent: 'codex', text: 'continue', at: new Date(localAt).toISOString(), codexInputHashes: [inputHash('continue')] });
    c.messages.push({ role: 'assistant', agent: 'codex', text: 'Done' });
    mergeTurns(c, [turn('anchor', 'Original prompt'), turn('again', 'continue', 'Second run')], 'anchor');
    return c.messages.filter(m => m.role === 'assistant').map(m => m.text);
  };
  assert.deepEqual(run(100000 + 5000), ['Original answer', 'Done'], 'a turn that began moments after the local message is that message');
  assert.deepEqual(run(100000 + 3600 * 1000), ['Original answer', 'Done', 'Second run'], 'an hour apart it is a separate run');
});
