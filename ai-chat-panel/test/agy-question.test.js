'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { decodeQuestion } = require('../lib/agy-question');
require('./model-fixture').seedModels();
const { StreamEngine } = require('../lib/stream-engine');

// Captured AGY Step layout: Step.metadata(5).tool_call(4), with
// tool_call.name(2) and tool_call.arguments_json(3). No tool_info in stdout.
const questions = [{ question: 'Pick A or B?', options: ['A', 'B'], is_multi_select: false }];
const varint = (value) => {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
};
const field = (number, data) => Buffer.concat([varint(number * 8 + 2), varint(Buffer.byteLength(data)), Buffer.from(data)]);
const payloadFor = (name, input) => field(5, field(4, Buffer.concat([field(2, name), field(3, JSON.stringify(input))])));
const rawStep = { event: 'step_update', step_update: { conversation_id: '26a0e81b-362b-4749-aec7-c396c2f46202', step_index: 2, state: 'DONE', step_type: 'unknown', duration_seconds: 0.1436815 } };
const fakeChild = () => ({ pid: 0, stdin: { writable: false }, kill() {} });

test('decodes the actual hidden tool-call layout, including Unicode and multiple selections', () => {
  assert.deepEqual(decodeQuestion(payloadFor('ask_question', { questions })), questions);
  const multi = [{ question: 'Größe wählen?', options: ['Groß', 'Klein'], is_multi_select: true }];
  assert.deepEqual(decodeQuestion(payloadFor('ask_question', { questions: multi })), multi);
  assert.equal(decodeQuestion(payloadFor('other_tool', { questions })), null);
  assert.throws(() => decodeQuestion(Buffer.from([42, 127, 1])), /Invalid AGY protobuf/);
});

test('real unknown stream event recovers a card before later result output, retries the trajectory write', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-agy-question-'));
  const file = path.join(temp, 'trajectory.db');
  let db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)');
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(2, payloadFor('ask_question', { questions }));
  db.close();
  let reads = 0;
  const e = new StreamEngine({ cwd: temp, interactive: true, agyQuestionReader: async (id, index) => {
    assert.equal(id, rawStep.step_update.conversation_id);
    assert.equal(index, 2);
    if (++reads === 1) return undefined;
    db = new DatabaseSync(file, { readOnly: true });
    try { return decodeQuestion(Buffer.from(db.prepare('SELECT step_payload FROM steps WHERE idx=?').get(index).step_payload)); }
    finally { db.close(); }
  } });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', event => events.push(event));
  try {
    await e.consumeAgyLine(JSON.stringify(rawStep), child);
    await e.consumeAgyLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'I have asked the question as requested.' } }), child);
    assert.deepEqual(events.map(event => event.type), ['question_required', 'turn_complete']);
    assert.equal(events[0].deferred, true);
    assert.deepEqual(events[0].questions[0].options, [{ label: 'A' }, { label: 'B' }]);
    assert.equal(e.child, null);
    assert.equal(reads, 2);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('a stale database read cannot emit a question into the replacement turn', async () => {
  let resolve;
  const e = new StreamEngine({ agyQuestionReader: () => new Promise(done => { resolve = done; }) });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', event => events.push(event));
  const pending = e.consumeAgyLine(JSON.stringify(rawStep), child);
  e.child = fakeChild();
  resolve(questions);
  await pending;
  assert.equal(events.length, 0);
});

test('unattended AGY questions leave the process running until its real result', async () => {
  const e = new StreamEngine({ agyQuestionReader: async () => questions });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', event => events.push(event));
  await e.consumeAgyLine(JSON.stringify(rawStep), child);
  assert.equal(e.child, child);
  assert.deepEqual(events, []);
  assert.equal(e.approvals.size, 0);
  await e.consumeAgyLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Completed after skipping the question.' } }), child);
  assert.equal(events.filter(event => event.type === 'turn_complete').length, 1);
  assert.ok(events.some(event => event.type === 'delta' && event.text.includes('Completed after skipping')));
});

test('unknown steps for other tools do not make question cards', async () => {
  const e = new StreamEngine({ agyQuestionReader: async () => null });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', event => events.push(event));
  await e.consumeAgyLine(JSON.stringify(rawStep), child);
  assert.equal(events.length, 0);
  assert.equal(e.child, child);
});
