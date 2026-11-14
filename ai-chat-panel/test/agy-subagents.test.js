const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgySubagents, transcriptEvents, plainArgs } = require('../lib/agy-subagents.js');
const { StreamEngine, geminiToolTarget } = require('../lib/stream-engine.js');

// The shapes below are what agy 's subagent conversations write to brain/<id>/.system_generated/logs/transcript.jsonl.
const PARENT = '93ec19e4-4110-465e-82ed-d5ecb0131e56';
const CHILD = '5301a03f-ccc3-42f5-ac4c-6debf532c16f';
const PROMPT = 'Transcribe pages 73 to 104 (inclusive) into `C:\\Users\\me\\seiten\\073.md`.\n\n### Rules\n1. Check the plan.';
const step = (n, extra) => JSON.stringify({ step_index: n, source: 'MODEL', status: 'DONE', created_at: '2026-10-30T11:07:05Z', ...extra }) + '\n';
const first = JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-30T11:07:04Z sender=${PARENT} priority=MESSAGE_PRIORITY_HIGH content=${PROMPT}\n</SYSTEM_MESSAGE>` }) + '\n';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sub-'));
  const logs = path.join(home, '.gemini', 'antigravity-cli', 'brain', CHILD, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, 'transcript.jsonl');
  fs.writeFileSync(file, first);
  return { home, file };
}

test('transcript steps become viewer events, tool results pair up in call order', () => {
  const state = { pending: [] };
  const describe = (name, params) => geminiToolTarget(name, params);
  const plan = transcriptEvents(JSON.parse(step(1, { type: 'PLANNER_RESPONSE', thinking: 'Check the plan first.', tool_calls: [{ name: 'read_file', args: { Path: '"C:\\\\a\\\\plan.csv"' } }, { name: 'run_command', args: { CommandLine: '"dir"' } }] })), state, describe);
  assert.deepEqual(plan.events.map((e) => e.type), ['thought', 'tool_start', 'tool_start']);
  assert.deepEqual([plan.events[1].name, plan.events[1].command, plan.events[2].name, plan.events[2].command], ['read_file', 'C:\\a\\plan.csv', 'bash', 'dir']);
  const ok = transcriptEvents(JSON.parse(step(2, { type: 'GENERIC', content: 'Created At: x\nCompleted At: y\nShowing lines 1-2 of 2\n1: a' })), state, describe);
  assert.deepEqual(ok.events, [{ type: 'tool_end', toolId: '1-0', output: 'Showing lines 1-2 of 2\n1: a', error: false }]);
  const bad = transcriptEvents(JSON.parse(step(3, { type: 'GENERIC', status: 'ERROR', error: 'file does not exist', content: 'Encountered error' })), state, describe);
  assert.deepEqual([bad.events[0].toolId, bad.events[0].error, bad.events[0].output], ['1-1', true, 'file does not exist']);
  assert.equal(transcriptEvents(JSON.parse(step(4, { type: 'GENERIC', content: 'stray' })), state, describe).events.length, 0, 'a result with no call is ignored');
  const done = transcriptEvents(JSON.parse(step(5, { type: 'PLANNER_RESPONSE', content: 'All 32 files are done.' })), state, describe);
  assert.deepEqual([done.events[0].type, done.finished], ['delta', true]);
  assert.equal(transcriptEvents(JSON.parse(step(6, { type: 'PLANNER_RESPONSE', content: 'Working.', tool_calls: [{ name: 'view_file', args: {} }] })), state, describe).finished, false);
  assert.deepEqual(plainArgs({ a: '"x"', b: 'plain', c: 3 }), { a: 'x', b: 'plain', c: 3 });
});

test('agy invoke_subagent steps put the subagent in the chip and follow its transcript to completion', () => {
  const { home, file } = fixture();
  const e = new StreamEngine({ cwd: os.tmpdir(), interactive: true });
  const events = [];
  e.on('event', (ev) => events.push(ev));
  e.agySubagents = new AgySubagents({ emit: (event) => e.emit('event', { ...event, agent: 'gemini' }), describe: geminiToolTarget, home, pollMs: 3600000 });
  const line = (raw) => e.consumeLine(JSON.stringify(raw), 'gemini');
  const call = { event: 'step_update', step_update: { step_index: 7, step_type: 'tool', tool_name: 'invoke_subagent', conversation_id: PARENT, state: 'ACTIVE', tool_info: { parameters: { Role: 'Transcriber Pages 73-104', TypeName: 'self', Prompt: PROMPT, Model: 'inherit' } } } };
  line(call);
  const start = events.find((ev) => ev.type === 'subagent_start');
  assert.deepEqual([start.id, start.description, start.subagentType, start.prompt], [`agy-${PARENT}-7`, 'Transcriber Pages 73-104', 'self', PROMPT]);
  assert.ok(events.some((ev) => ev.type === 'tool_start' && ev.toolId === 'step-7'), 'the call still shows as a step in the reply');

  line({ event: 'step_update', step_update: { ...call.step_update, state: 'DONE', tool_info: { ...call.step_update.tool_info, output: `Created the following subagent:\n{ "conversationId": "${CHILD}" }` } } });
  assert.equal(events.find((ev) => ev.type === 'subagent_end').launched, true);
  assert.equal(events.filter((ev) => ev.type === 'subagent_start').length, 1, 'the DONE update does not launch it twice');

  fs.appendFileSync(file, step(1, { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: '"C:\\\\a.csv"' } }] }) + step(2, { type: 'GENERIC', content: 'ok' }));
  e.agySubagents.poll(e.agySubagents.watchers.get(`agy-${PARENT}-7`));
  assert.deepEqual(events.filter((ev) => ev.type === 'subagent_event').map((ev) => ev.event.type), ['tool_start', 'tool_end']);
  assert.ok(!events.some((ev) => ev.type === 'subagent_status'));

  // A half-written last line waits for the rest instead of being lost.
  const last = step(3, { type: 'PLANNER_RESPONSE', content: 'Finished all pages.' });
  fs.appendFileSync(file, last.slice(0, 40));
  e.agySubagents.poll(e.agySubagents.watchers.get(`agy-${PARENT}-7`));
  assert.ok(!events.some((ev) => ev.type === 'subagent_status'));
  fs.appendFileSync(file, last.slice(40));
  e.agySubagents.poll(e.agySubagents.watchers.get(`agy-${PARENT}-7`));
  assert.deepEqual([events.at(-1).type, events.at(-1).status, events.at(-1).id], ['subagent_status', 'completed', `agy-${PARENT}-7`]);
  assert.equal(e.agySubagents.watchers.size, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('without a conversation id the transcript is found by its parent and prompt; two launches never share one', () => {
  const { home, file } = fixture();
  const out = [];
  const subs = new AgySubagents({ emit: (event) => out.push(event), describe: geminiToolTarget, home, pollMs: 3600000 });
  subs.launch({ id: 'other', parentId: PARENT, role: 'Other', typeName: 'self', prompt: 'A different task entirely' });
  subs.launch({ id: 'a', parentId: PARENT, role: 'A', typeName: 'self', prompt: PROMPT });
  assert.equal(subs.watchers.get('other').file, null, 'a transcript for another prompt is not taken');
  assert.equal(subs.watchers.get('a').file, file);
  subs.launch({ id: 'b', parentId: PARENT, role: 'B', typeName: 'self', prompt: PROMPT });
  assert.equal(subs.watchers.get('b').file, null, 'already followed');
  fs.appendFileSync(file, step(1, { type: 'PLANNER_RESPONSE', content: 'Done.' }));
  subs.poll(subs.watchers.get('a'));
  assert.deepEqual(out.filter((ev) => ev.type === 'subagent_status').map((ev) => [ev.id, ev.status]), [['a', 'completed']]);
  // The process ending closes what is left, after one last look at the files.
  subs.endAll('ended');
  assert.deepEqual(out.filter((ev) => ev.type === 'subagent_status').map((ev) => [ev.id, ev.status]), [['a', 'completed'], ['other', 'ended'], ['b', 'ended']]);
  assert.equal(subs.watchers.size, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an invoke_subagent that errors, and the flat Role parameters, read sensibly', () => {
  const e = new StreamEngine({ cwd: os.tmpdir(), interactive: true });
  const events = [];
  e.on('event', (ev) => events.push(ev));
  e.consumeLine(JSON.stringify({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', tool_name: 'invoke_subagent', conversation_id: PARENT, state: 'ERROR', tool_info: { parameters: { Role: 'R', Prompt: 'P' }, error: { message: 'no quota' } } } }), 'gemini');
  assert.deepEqual(events.find((ev) => ev.type === 'subagent_end'), { type: 'subagent_end', id: `agy-${PARENT}-2`, output: 'no quota', error: true, launched: false, agent: 'gemini' });
  assert.equal(geminiToolTarget('invoke_subagent', { Role: 'Transcriber', TypeName: 'self', Prompt: 'x' }), 'Transcriber');
});
