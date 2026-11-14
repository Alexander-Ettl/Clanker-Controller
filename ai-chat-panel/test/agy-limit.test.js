'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StreamEngine } = require('../lib/stream-engine.js');
const { isLimitNotice, resetsInMs, limitActive } = require('../media/limit-notice.js');

const QUOTA = 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h43m1s.';

function turn(engine, lines) {
  const text = [];
  const types = [];
  engine.on('event', (event) => { types.push(event.type); if (event.type === 'delta') text.push(event.text); });
  engine.agyTurnAt = Date.now();
  engine.hadText = true; // the turn already streamed work before the limit hit
  for (const line of lines) engine.consumeLine(JSON.stringify(line), 'gemini');
  return { reply: text.join(''), types };
}

test('agy: a quota error next to a partial reply ends it with a limit notice the panel recognizes', () => {
  const engine = new StreamEngine({ agyLogDir: path.join(os.tmpdir(), 'no-such-agy-log-dir') });
  const { reply, types } = turn(engine, [
    { event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', step_index: 1, text_delta: 'Now a unit test for the fault data.' } },
    { event: 'result', result: { status: 'ERROR', response: 'Now a unit test for the fault data.', error: `generating and executing: ${QUOTA}` } },
  ]);
  assert.equal(isLimitNotice(`Now a unit test.\n\n${reply.split('\n\n').at(-1)}`), true);
  assert.match(reply.split('\n\n').at(-1), /^Gemini error: RESOURCE_EXHAUSTED \(code 429\): Individual quota reached\..*Resets in 4h43m1s\.$/);
  assert.equal(types.at(-1), 'turn_complete');
});

test('agy: with no error in the stream, the quota failure on stderr still reaches the reply', () => {
  const engine = new StreamEngine({ agyLogDir: path.join(os.tmpdir(), 'no-such-agy-log-dir') });
  const events = [];
  engine.on('event', (event) => events.push(event));
  engine.agyTurnAt = Date.now();
  engine.consumeStderrLine(`E1023 11:42:27.168647 7812 errorreport.go:224] generating and executing: ${QUOTA}`, 'gemini');
  engine.consumeLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '' } }), 'gemini');
  const delta = events.find((event) => event.type === 'delta');
  assert.equal(delta.text, `Gemini error: ${QUOTA}`);
  assert.equal(events.at(-1).type, 'turn_complete');
});

test("agy: a silent stream is read from agy's own log, and only once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-log-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli-20261023_113637.log'), `I1023 11:41:44 http_helpers.go:349] URL: x\nE1023 11:42:27.158432 7812 errorreport.go:224] agent executor error: generating and executing: ${QUOTA}\nE1023 11:42:27.168647 7812 errorreport.go:224] generating and executing: ${QUOTA}\n`);
    const engine = new StreamEngine({ agyLogDir: dir });
    const { reply } = turn(engine, [{ event: 'result', result: { status: 'SUCCESS', response: 'partial' } }]);
    assert.equal(reply, `\n\nGemini error: ${QUOTA}`);
    assert.equal(reply.split('RESOURCE_EXHAUSTED').length, 2);
    const clean = new StreamEngine({ agyLogDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-log-empty-')) });
    assert.equal(turn(clean, [{ event: 'result', result: { status: 'SUCCESS', response: 'done' } }]).reply, '', 'a turn that went fine says nothing');
    fs.utimesSync(path.join(dir, 'cli-20261023_113637.log'), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    assert.equal(turn(new StreamEngine({ agyLogDir: dir }), [{ event: 'result', result: { status: 'SUCCESS', response: 'done' } }]).reply, '', 'an older process\'s log is not this turn');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a limit notice that names its reset decides by itself whether it is still in force', () => {
  assert.equal(resetsInMs('Resets in 4h43m1s.'), (4 * 3600 + 43 * 60 + 1) * 1000);
  assert.equal(resetsInMs('resets in 2d 3h'), (51 * 3600) * 1000);
  assert.equal(resetsInMs("You've hit your session limit · resets 2:10pm"), null);
  const sent = new Date(Date.now() - 5 * 3600e3).toISOString();
  assert.equal(limitActive(`Gemini error: ${QUOTA}`, new Date().toISOString()), true);
  assert.equal(limitActive(`Gemini error: ${QUOTA}`, sent), false, 'the reset has passed since: no button on an old notice');
  assert.equal(limitActive('Quota exhausted'), null);
});
