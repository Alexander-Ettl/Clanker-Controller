'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decodeThought, readThoughts } = require('../lib/agy-question');
require('./model-fixture').seedModels();
const { StreamEngine, normalizeEvent } = require('../lib/stream-engine');

const varint = (value) => {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
};
const field = (number, data) => Buffer.concat([varint(number * 8 + 2), varint(Buffer.byteLength(data)), Buffer.from(data)]);
const CONVERSATION = '26a0e81b-362b-4749-aec7-c396c2f46202';
const fakeChild = () => ({ pid: 0, stdin: { writable: false }, kill() {} });
const tool = (index, name, parameters, state = 'ACTIVE') => JSON.stringify({ event: 'step_update', step_update: { conversation_id: CONVERSATION, step_index: index, step_type: 'tool', state, tool_name: name, tool_info: { parameters } } });
const plan = [{ status: 'completed', title: 'Copy the build' }, { status: 'in_progress', title: 'Add diagnostics' }, { status: 'pending', title: 'Run the tests' }];

test('reads the thinking summary of a model step (field 20, sub-field 3), Unicode included', () => {
  assert.equal(decodeThought(field(20, Buffer.concat([field(3, 'Prüfe zuerst die Datei.'), field(6, 'sig')]))), 'Prüfe zuerst die Datei.');
  assert.equal(decodeThought(field(5, 'something else')), '');
});

test('an update_steps card names the step in progress and how far the plan is', () => {
  const start = normalizeEvent(JSON.parse(tool(4, 'update_steps', { steps: plan })), 'gemini');
  assert.equal(start.command, 'Add diagnostics (2/3)');
  assert.equal(start.checklist, '✓ Copy the build\n▸ Add diagnostics\n○ Run the tests');
  assert.equal(normalizeEvent(JSON.parse(tool(4, 'update_steps', { steps: plan.map((s) => ({ ...s, status: 'completed' })) })), 'gemini').command, 'All 3 steps done');
  assert.equal(normalizeEvent(JSON.parse(tool(4, 'update_steps', { toolSummary: 'Plan the work' })), 'gemini').command, 'Plan the work');
});

test('the plan becomes the finished card body and never leaks onto the start event', async () => {
  const e = new StreamEngine({ agyThoughtReader: () => [] });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', (event) => events.push(event));
  await e.consumeAgyLine(tool(4, 'update_steps', { steps: plan }), child);
  await e.consumeAgyLine(tool(4, 'update_steps', {}, 'DONE'), child);
  assert.equal(events[0].type, 'tool_start');
  assert.equal('checklist' in events[0], false);
  assert.equal(events[1].type, 'tool_end');
  assert.match(events[1].output, /^✓ Copy the build\n▸ Add diagnostics/);
});

test('a turn reads only the thinking after its own user message, even when its first streamed step is a tool', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, `${CONVERSATION}.db`));
    db.exec('CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB)');
    const add = db.prepare('INSERT INTO steps VALUES (?, ?, ?)');
    const planner = (text) => field(20, field(3, text));
    // turn one: user 0, planner 1 ("old"), tool 2; turn two: user 3, planner 4 ("new"), tools 5 and 6
    [[0, 14, Buffer.alloc(0)], [1, 15, planner('old turn')], [2, 132, Buffer.alloc(0)], [3, 14, Buffer.alloc(0)], [4, 15, planner('new turn')], [5, 132, Buffer.alloc(0)], [6, 132, Buffer.alloc(0)]]
      .forEach((row) => add.run(...row));
    db.close();
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // The first tool this turn streamed is step 5; its thinking is the planner just before it, at 4.
    assert.deepEqual(readThoughts(CONVERSATION, -1, 5).map((t) => t.text), ['new turn']);
    assert.deepEqual(readThoughts(CONVERSATION, 4, 7), []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('thinking shows ahead of the step it explains, once, and never from an earlier turn', async () => {
  const calls = [];
  const stored = [{ idx: 3, text: 'old turn' }, { idx: 6, text: 'Look at the config first.' }, { idx: 9, text: 'Now run it.' }];
  // The real reader also floors `after` at the turn's user message (idx 5 here).
  const reader = (id, after, before) => { calls.push([id, after, before]); return stored.filter((t) => t.idx > Math.max(after, 5) && t.idx < before); };
  const e = new StreamEngine({ agyThoughtReader: reader });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', (event) => events.push(event));
  const send = (step) => e.consumeAgyLine(JSON.stringify({ event: 'step_update', step_update: { conversation_id: CONVERSATION, ...step } }), child);
  await send({ step_index: 5, step_type: 'user_input', state: 'DONE' });
  await send({ step_index: 7, step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/a' } } });
  await send({ step_index: 7, step_type: 'tool', state: 'DONE', tool_name: 'view_file', tool_info: { parameters: {} } });
  await send({ step_index: 10, step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/b' } } });
  assert.deepEqual(events.filter((x) => x.type === 'thought').map((x) => x.text), ['Look at the config first.', 'Now run it.']);
  assert.deepEqual(events.map((x) => x.type), ['thought', 'tool_start', 'tool_end', 'thought', 'tool_start']);
  assert.equal(calls.length, 2, 'only a starting tool asks, not its end');
});

test('a missing trajectory file only means no thinking', async () => {
  const e = new StreamEngine({ agyThoughtReader: () => { throw new Error('no such table'); } });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', (event) => events.push(event));
  await e.consumeAgyLine(tool(2, 'view_file', { AbsolutePath: '/a' }), child);
  assert.deepEqual(events.map((x) => x.type), ['tool_start']);
});
