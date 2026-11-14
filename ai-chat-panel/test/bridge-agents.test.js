'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BridgeAgents } = require('../lib/bridge-agents');
const { start } = require('../lib/clanker-agent');

test('bridge viewer isolates chats, tracks model and detached completion, and restores jobs', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-view-'));
  try {
    const job = await start({ cwd, from: 'chat-a', to: 'codex:fake', task: 'research', prompt: 'Read the sources' }, { inline: true, catalog: [] });
    const events = [];
    const viewer = new BridgeAgents('chat-a', e => events.push(e));
    const other = new BridgeAgents('chat-b', () => assert.fail('wrong chat'));
    other.poll(cwd);
    viewer.poll(cwd);
    assert.equal(viewer.active, true);
    assert.equal(events[0].model, 'fake');
    assert.equal(events[0].prompt, 'Read the sources');
    assert.equal(events[1].status, 'background');
    viewer.poll(cwd);
    assert.equal(events.length, 2, 'polls do not duplicate events');
    fs.writeFileSync(path.join(job.dir, 'status.json'), JSON.stringify({ id: job.id, state: 'done', resultFile: 'result.md' }));
    viewer.poll(cwd);
    assert.equal(viewer.active, false);
    assert.equal(events[2].status, 'completed');
    assert.match(events[3].event.text, /result\.md/);
    const restored = [];
    new BridgeAgents('chat-a', e => restored.push(e)).poll(cwd);
    assert.equal(restored[1].status, 'completed');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
