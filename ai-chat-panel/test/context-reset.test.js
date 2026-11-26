'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('./model-fixture').seedModels();
const { StreamEngine, normalizeEvent } = require('../lib/stream-engine');
const { describeContextReset, isContextDrop } = require('../lib/context-reset');

test("Claude's own compaction is announced with its size, not as a plain notice", () => {
  const raw = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 962000 } };
  assert.deepEqual(normalizeEvent(raw, 'claude'), { type: 'context_reset', kind: 'native', agent: 'claude', trigger: 'auto', preTokens: 962000 });
  assert.equal(normalizeEvent({ type: 'system', subtype: 'compact_boundary' }, 'claude').trigger, 'auto');
  assert.match(describeContextReset(normalizeEvent(raw, 'claude')).detail, /962k tokens/);
});

test('every reset the user did not ask for has words; their own choices have none', () => {
  const session = (reason) => describeContextReset({ kind: 'session', agent: 'claude', reason, tokens: 850000, limit: 1000000 });
  assert.match(session('target context threshold').detail, /85% of Claude's window \(850k of 1\.0M\)/);
  assert.match(session('provider changed').detail, /changed vendor/);
  assert.match(session('unrelated task').detail, /unrelated/);
  assert.equal(session('user requested'), null);
  assert.equal(session('always new'), null);
  assert.equal(describeContextReset({ kind: 'resume', agent: 'codex' }).title, 'New session · context reset');
  assert.match(describeContextReset({ kind: 'drop', agent: 'gemini', before: 420000, after: 90000 }).detail, /90k tokens, down from 420k/);
  assert.equal(describeContextReset({ kind: 'nonsense' }), null);
});

test('only a sharp fall of a large context counts as a drop', () => {
  assert.equal(isContextDrop(400000, 120000), true);
  assert.equal(isContextDrop(400000, 250000), false, 'ordinary variation');
  assert.equal(isContextDrop(30000, 2000), false, 'too small to matter');
  assert.equal(isContextDrop(0, 0), false);
});

test('a resume the CLI refuses says that the session was replaced', () => {
  const engine = new StreamEngine({ cwd: process.cwd() });
  const events = [];
  engine.on('event', (event) => events.push(event));
  engine.start = () => {};
  engine.resumeRetry = { agent: 'claude', prompt: 'fresh' };
  engine.consumeLine('No conversation found with session ID: 0000', 'claude');
  assert.deepEqual(events, [{ type: 'context_reset', kind: 'resume', agent: 'claude' }]);
});

test("Codex's own compaction mid-turn is announced once", () => {
  const engine = new StreamEngine({ cwd: process.cwd() });
  const events = [];
  engine.on('event', (event) => events.push(event));
  engine.codexActive = true;
  engine.codexAcceptEvents = true;
  engine.turn = { codexCommand: null };
  engine.handleCodexNotification({ method: 'item/started', params: { item: { type: 'contextCompaction', id: 'c1' } } });
  engine.handleCodexNotification({ method: 'thread/compacted', params: { threadId: 't' } });
  assert.equal(events.filter((event) => event.type === 'context_reset').length, 1);
  assert.equal(engine.codexActive, true, 'native compaction leaves the running turn active');
  engine.dispose();
});
