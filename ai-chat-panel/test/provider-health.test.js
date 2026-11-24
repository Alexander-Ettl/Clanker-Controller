'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { silentTurnMessage } = require('../lib/provider-health.js');
const { StreamEngine } = require('../lib/stream-engine.js');

test('a clean exit with no reply says what to check', () => {
  const text = silentTurnMessage({ agent: 'claude', code: 0, unrecognized: 3 });
  assert.match(text, /^Claude Code ended without a reply\./);
  assert.match(text, /3 lines that Clanker does not recognise/);
  assert.match(text, /signed out or the CLI changed its output format/);
  assert.match(text, /Show Logs/);
  assert.match(silentTurnMessage({ agent: 'codex', code: 0, unrecognized: 1 }), /1 line that Clanker/);
  assert.match(silentTurnMessage({ agent: 'gemini', code: 0 }), /printed nothing Clanker could use/);
});

test('a CLI that explained itself, or crashed plainly, keeps the existing message', () => {
  assert.equal(silentTurnMessage({ agent: 'claude', code: 1, diagnostic: 'Please run /login' }), '');
  assert.equal(silentTurnMessage({ agent: 'claude', code: 0, diagnostic: 'Please run /login' }), '');
  assert.equal(silentTurnMessage({ agent: 'claude', code: 137 }), '', 'exited with code 137 is already clear');
  assert.match(silentTurnMessage({ agent: 'claude', code: 1, unrecognized: 4 }), /ended without a reply/, 'a crash after output nobody understood is the format-change case');
});

test('the engine counts JSON lines it does not recognise, not the ones it does', () => {
  const engine = new StreamEngine();
  engine.sawOutput = false;
  engine.consumeLine(JSON.stringify({ type: 'brand_new_event_v9', payload: 1 }), 'claude');
  engine.consumeLine(JSON.stringify({ type: 'another_unknown' }), 'claude');
  assert.equal(engine.unrecognizedLines, 2);
  engine.consumeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }), 'claude');
  assert.equal(engine.sawOutput, true);
  engine.consumeLine(JSON.stringify({ type: 'yet_another' }), 'claude');
  assert.equal(engine.unrecognizedLines, 2, 'once a reply is flowing, unknown housekeeping lines are not counted');
});
