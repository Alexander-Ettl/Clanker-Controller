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
    const home = path.join(cwd, 'home');
    const job = await start({ cwd, from: 'chat-a', to: 'codex:fake', task: 'research', prompt: 'Read the sources' }, { inline: true, catalog: [], home });
    const events = [];
    const viewer = new BridgeAgents('chat-a', e => events.push(e), { home });
    const other = new BridgeAgents('chat-b', () => assert.fail('wrong chat'), { home });
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
    new BridgeAgents('chat-a', e => restored.push(e), { home }).poll(cwd);
    assert.equal(restored[1].status, 'completed');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('a job started under another --cwd than the chat folder still shows in that chat', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cwd-'));
  try {
    const home = path.join(root, 'home');
    const chatFolder = path.join(root, 'project');
    const elsewhere = path.join(root, 'project', 'Research'); // where the agent pointed --cwd: no _work/clanker under chatFolder itself
    fs.mkdirSync(elsewhere, { recursive: true });
    await start({ cwd: elsewhere, from: 'chat-a', to: 'gemini:fake', task: 'web-search', prompt: 'Search' }, { inline: true, catalog: [], home });
    const events = [];
    new BridgeAgents('chat-a', e => events.push(e), { home }).poll(chatFolder);
    assert.equal(events[0].type, 'subagent_start');
    assert.equal(events[0].agent, 'gemini');
    const none = [];
    new BridgeAgents('chat-b', e => none.push(e), { home }).poll(chatFolder);
    assert.equal(none.length, 0, 'another chat does not see it');
    const [jobId] = fs.readdirSync(path.join(elsewhere, '_work', 'clanker'));
    const statusFile = path.join(elsewhere, '_work', 'clanker', jobId, 'status.json');
    const stale = JSON.stringify({ state: 'queued', createdAt: '2000-01-01T00:00:00Z' });
    fs.writeFileSync(statusFile, stale);
    const staleEvents = [];
    new BridgeAgents('chat-a', e => staleEvents.push(e), { home }).poll(chatFolder);
    assert.equal(staleEvents[1].status, 'failed');
    assert.equal(fs.readFileSync(statusFile, 'utf8'), stale, 'viewer polling leaves job files alone');
    assert.equal(fs.existsSync(path.join(path.dirname(statusFile), 'result.md')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
