'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const out = require('../lib/agy-step-output');
require('./model-fixture').seedModels();
const { StreamEngine, normalizeEvent } = require('../lib/stream-engine');

const CONVERSATION = 'd339801c-5d02-4072-a0b4-b744a9185104';
const BACKGROUND = `Created At: 2026-11-25T12:57:27+01:00
Tool is running as a background task with task id: ${CONVERSATION}/task-262
Task Description: LD_LIBRARY_PATH="/usr/local/lib" "/opt/enroll" --help 2>&1 || true
echo "=== second line ==="
Task logs are available at: file:///x/task-262.log
Log output:
Choose the finger to enroll:
> `;

/** A throwaway ~/.gemini with one conversation's .system_generated folder. */
function brain({ steps = {}, transcript = [], logs = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-brain-'));
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'brain', CONVERSATION, '.system_generated');
  fs.mkdirSync(path.join(dir, 'steps'), { recursive: true }); fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true }); fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  for (const [index, text] of Object.entries(steps)) { fs.mkdirSync(path.join(dir, 'steps', index)); fs.writeFileSync(path.join(dir, 'steps', index, 'output.txt'), text); }
  for (const [name, text] of Object.entries(logs)) fs.writeFileSync(path.join(dir, 'tasks', `${name}.log`), text);
  if (transcript.length) fs.writeFileSync(path.join(dir, 'logs', 'transcript_full.jsonl'), transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return home;
}

test('a step result is read from its output file without the Created/Completed header', () => {
  const home = brain({ steps: { 150: 'Created At: 2026-11-25T11:33:32+01:00\nCompleted At: 2026-11-25T11:33:36+01:00\nCommand exited with code 0.\n\nOK\n' } });
  assert.deepEqual(out.readStepResult(CONVERSATION, 150, { home }), { text: 'Command exited with code 0.\n\nOK', task: null });
});

test('a step with no output file is found in the transcript, newest entry first, and a half line at the cut is ignored', () => {
  const home = brain({ transcript: [{ step_index: 7, type: 'GENERIC', content: 'old' }, { step_index: 8, type: 'PLANNER_RESPONSE', content: 'not a tool result' }, { step_index: 8, type: 'GENERIC', content: 'Created At: x\nfrom the transcript' }] });
  assert.equal(out.readStepResult(CONVERSATION, 8, { home }).text, 'from the transcript');
  assert.equal(out.readStepResult(CONVERSATION, 9, { home }), null, 'an unknown step is nothing');
});

test('a step that starts a background task reports the task and what it runs', () => {
  const home = brain({ steps: { 262: BACKGROUND } });
  const result = out.readStepResult(CONVERSATION, 262, { home });
  assert.equal(result.task.id, `${CONVERSATION}/task-262`);
  assert.match(result.task.description, /^LD_LIBRARY_PATH=.*--help 2>&1 \|\| true\necho "=== second line ==="$/);
  assert.match(result.text, /Choose the finger to enroll/);
});

test('nothing is read for an id that is not a conversation, a bad index, or a missing folder', () => {
  const home = brain({ steps: { 1: 'x' } });
  assert.equal(out.readStepResult('../../etc', 1, { home }), null);
  assert.equal(out.readStepResult(`${CONVERSATION}/..`, 1, { home }), null);
  assert.equal(out.readStepResult(CONVERSATION, -1, { home }), null);
  assert.equal(out.readStepResult(CONVERSATION, 1.5, { home }), null);
  assert.equal(out.readStepResult('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, { home }), null);
  assert.equal(out.readTaskLog(CONVERSATION, '../../etc/passwd', { home }), '');
});

test('a very long result is cut at the read limit, not read whole', () => {
  const home = brain({ steps: { 5: 'x'.repeat(2 * 1024 * 1024) } });
  assert.ok(out.readStepResult(CONVERSATION, 5, { home }).text.length <= 256 * 1024);
});

test('a task log shows its last lines with spinner overwrites folded away', () => {
  const home = brain({ logs: { 'task-9': 'one\ntwo\nprogress 10%\rprogress 90%\n\nthree\n' } });
  assert.equal(out.readTaskLog(CONVERSATION, `${CONVERSATION}/task-9`, { home, lines: 3 }), 'two\nprogress 90%\nthree');
  assert.equal(out.readTaskLog(CONVERSATION, `${CONVERSATION}/task-9`, { home, lines: 2, head: true }), 'one\ntwo', 'the head says what it is');
  assert.equal(out.readTaskLog(CONVERSATION, 'task-404', { home }), '');
});

test('a task is called by the first line of what it runs, shortened', () => {
  assert.equal(out.taskLabel('\n  make -j8  \nmore', ''), 'make -j8');
  assert.equal(out.taskLabel('', 'compiling\nlinking'), 'compiling');
  assert.equal(out.taskLabel('x'.repeat(200), '').length, 90);
  assert.equal(out.taskLabel('', ''), '');
});

// ---- in the engine ----
const fakeChild = () => ({ pid: 0, stdin: { writable: false }, kill() {} });
const step = (index, name, parameters, state = 'ACTIVE') => JSON.stringify({ event: 'step_update', step_update: { conversation_id: CONVERSATION, step_index: index, step_type: 'tool', state, tool_name: name, tool_info: { parameters } } });
async function run(home, lines) {
  const engine = new StreamEngine({ agyThoughtReader: () => [], agyContextReader: () => null, agyHome: home });
  const child = engine.child = fakeChild();
  const events = [];
  engine.on('event', (event) => events.push(event));
  for (const line of lines) await engine.consumeAgyLine(line, child);
  return events;
}

test('a finished Gemini tool card carries the step result, an unknown one stays empty', async () => {
  const home = brain({ steps: { 3: 'Created At: a\nCommand exited with code 0.\n\nhello' } });
  const events = await run(home, [step(3, 'run_command', { CommandLine: 'echo hello' }), step(3, 'run_command', {}, 'DONE'), step(4, 'view_file', { AbsolutePath: '/a' }), step(4, 'view_file', {}, 'DONE')]);
  const ends = events.filter((e) => e.type === 'tool_end');
  assert.equal(ends[0].output, 'Command exited with code 0.\n\nhello');
  assert.equal(ends[1].output, '');
});

test('a failed step still shows what it printed', async () => {
  const home = brain({ steps: { 3: 'Created At: a\nbash: nope: command not found' } });
  const events = await run(home, [step(3, 'run_command', { CommandLine: 'nope' }), step(3, 'run_command', { x: 1 }, 'ERROR')]);
  assert.equal(events.at(-1).output, 'bash: nope: command not found');
  assert.equal(events.at(-1).error, true);
});

test('manage_task names the task by what it runs, learned from the step that started it', async () => {
  const home = brain({ steps: { 262: BACKGROUND, 265: 'Created At: a\nTask "x/task-262" cancelled.' } });
  const events = await run(home, [
    step(262, 'run_command', { CommandLine: 'enroll --help', toolSummary: 'Check the enroll tool' }), step(262, 'run_command', {}, 'DONE'),
    step(265, 'manage_task', { Action: 'kill', TaskId: `${CONVERSATION}/task-262` }), step(265, 'manage_task', {}, 'DONE'),
  ]);
  const kill = events.find((e) => e.type === 'tool_start' && e.name === 'manage_task');
  assert.equal(kill.command, 'kill Check the enroll tool (task-262)');
  assert.equal(events.at(-1).output, 'Task "x/task-262" cancelled.');
});

test('without a summary the task is named by its command; a task from an earlier turn by the first line of its log', async () => {
  const home = brain({ steps: { 262: BACKGROUND }, logs: { 'task-77': '=== [1/3] Compiling benchmark ===\nmore\n' } });
  const events = await run(home, [
    step(262, 'run_command', { CommandLine: 'x' }), step(262, 'run_command', {}, 'DONE'),
    step(270, 'manage_task', { Action: 'status', TaskId: `${CONVERSATION}/task-262` }),
    step(271, 'manage_task', { Action: 'status', TaskId: `${CONVERSATION}/task-77` }),
    step(272, 'manage_task', { Action: 'status', TaskId: `${CONVERSATION}/task-5` }),
  ]);
  const starts = events.filter((e) => e.type === 'tool_start' && e.name === 'manage_task').map((e) => e.command);
  assert.equal(starts[0], 'status LD_LIBRARY_PATH="/usr/local/lib" "/opt/enroll" --help 2>&1 || true (task-262)');
  assert.equal(starts[1], 'status === [1/3] Compiling benchmark === (task-77)');
  assert.equal(starts[2], 'status task-5', 'nothing known: the short id, not the conversation id');
});

test('with no agy folder at all the cards are exactly as before', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-empty-'));
  const events = await run(home, [step(3, 'run_command', { CommandLine: 'ls' }), step(3, 'run_command', {}, 'DONE')]);
  assert.deepEqual(events.map((e) => [e.type, e.output ?? e.command]), [['tool_start', 'ls'], ['tool_end', '']]);
});

test("a call's own one-line summary rides on the start event when it says something the command does not", () => {
  const event = (parameters) => normalizeEvent(JSON.parse(step(1, 'run_command', parameters)), 'gemini');
  assert.equal(event({ CommandLine: 'sha256sum a b', toolSummary: 'Hash release artifacts' }).summary, 'Hash release artifacts');
  assert.equal('summary' in event({ CommandLine: 'ls' }), false);
  assert.equal('summary' in event({ CommandLine: 'ls', toolSummary: 'ls' }), false);
  assert.equal(normalizeEvent(JSON.parse(step(1, 'manage_task', { Action: 'status', TaskId: 'c/task-1' })), 'gemini').command, 'status task-1');
});

test('newer agy file tools are edits that name their file: write_file, edit_file, create_file', () => {
  const start = (name, parameters) => normalizeEvent(JSON.parse(step(1, name, parameters)), 'gemini');
  const write = start('write_file', { Path: 'dual-reader/pam.c', Content: 'a\nb', Overwrite: 'True' });
  assert.deepEqual([write.name, write.command, write.file, write.diff], ['edit', 'dual-reader/pam.c', 'dual-reader/pam.c', '+a\n+b']);
  // The old text is called Target, which a path guess must never take for a path, whatever order the keys arrive in.
  const edit = start('edit_file', { Target: 'old line', Replacement: 'new line', Path: '/src/a.c' });
  assert.deepEqual([edit.name, edit.command, edit.file, edit.diff], ['edit', '/src/a.c', '/src/a.c', '-old line\n+new line']);
  assert.equal(start('create_file', { path: 'x.txt', content: 'hi' }).name, 'edit');
  assert.equal(start('read_file', { Path: '/src/a.c' }).name, 'read_file');
  assert.equal(start('write_to_file', { TargetFile: 'b.txt', CodeContent: 'hi' }).file, 'b.txt', 'older agy as before');
});
