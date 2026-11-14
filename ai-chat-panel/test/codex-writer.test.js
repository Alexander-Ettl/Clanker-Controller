'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { StreamEngine } = require('../lib/stream-engine');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Server extends EventEmitter {
  calls = [];
  locked = true;
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/resume') {
      if (this.locked) throw new Error(`thread ${params.threadId} already has an active writer`);
      return { thread: { id: params.threadId } };
    }
    if (method === 'turn/start') return { turn: { id: 'accepted-turn' } };
    return {};
  }
  dispose() {}
}
function retry(engine) {
  const callback = engine.retryTimer._onTimeout;
  clearTimeout(engine.retryTimer);
  callback();
}

test('writer ownership waits without sending input, forking or losing the original prompt', async () => {
  const server = new Server(), engine = new StreamEngine({ cwd: process.cwd(), interactive: true, codexServerFactory: () => server });
  const events = [];
  engine.on('event', event => events.push(event));
  try {
    engine.start({ agent: 'codex', model: 'chosen-model', effort: 'medium', prompt: 'The original task', freshPrompt: 'Fresh handoff', resume: 'shared-thread', permissionMode: 'ask' });
    await tick();
    assert.ok(engine.retryTimer);
    assert.equal(events.some(e => e.type === 'turn_complete'), false);
    assert.match(events.find(e => e.type === 'notice').text, /prompt is kept/);
    retry(engine); await tick();
    assert.equal(events.filter(e => e.type === 'notice').length, 1, 'one clear waiting notice');
    assert.ok(server.calls.every(c => c.method === 'thread/resume'));
    server.locked = false;
    retry(engine); await tick();
    const start = server.calls.find(c => c.method === 'turn/start');
    assert.equal(start.params.threadId, 'shared-thread');
    assert.equal(start.params.input[0].text, 'The original task');
    assert.equal(start.params.model, 'chosen-model');
    assert.equal(start.params.effort, 'medium');
    assert.equal(start.params.approvalPolicy, 'on-request');
    assert.equal(server.calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(server.calls.some(c => ['thread/start', 'thread/fork', 'turn/interrupt'].includes(c.method)), false);
  } finally { engine.dispose(); }
});

test('Stop cancels the pending writer wait', async () => {
  const server = new Server(), engine = new StreamEngine({ cwd: process.cwd(), codexServerFactory: () => server });
  const events = [];
  engine.on('event', event => events.push(event));
  try {
    engine.start({ agent: 'codex', prompt: 'Task', resume: 'shared-thread' });
    await tick();
    assert.ok(engine.retryTimer);
    assert.equal(engine.interrupt(), true);
    assert.equal(engine.retryTimer, null);
    assert.equal(events.at(-1).interrupted, true);
    assert.equal(server.calls.some(c => c.method === 'turn/interrupt'), false, 'never interrupt the other app');
  } finally { engine.dispose(); }
});
