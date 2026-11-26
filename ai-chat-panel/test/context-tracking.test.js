'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeContext } = require('../lib/agy-question');
require('./model-fixture').seedModels();
const { StreamEngine, contextWindowOf } = require('../lib/stream-engine');

const varint = (value) => {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
};
const field = (number, data) => Buffer.concat([varint(number * 8 + 2), varint(Buffer.byteLength(data)), Buffer.from(data)]);
const int = (number, value) => Buffer.concat([varint(number * 8), varint(value)]);
// agy's gen_metadata row: 1.4 = usage (2 fresh input, 3 output, 5 cache read), 1.9.10.4 = the budget agy compacts at.
const row = ({ fresh, out, cached, budget }) => field(1, Buffer.concat([
  field(4, Buffer.concat([int(1, 1532), int(2, fresh), int(3, out), ...(cached ? [int(5, cached)] : [])])),
  ...(budget ? [field(9, field(10, Buffer.concat([int(1, 381236), int(4, budget)])))] : []),
]));
const CONVERSATION = '26a0e81b-362b-4749-aec7-c396c2f46202';
const fakeChild = () => ({ pid: 0, stdin: { writable: false }, kill() {} });
const stepLine = (extra) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: CONVERSATION, ...extra } });

test("a Gemini call's context is fresh input + output + the cached history, against agy's own budget", () => {
  // The real last call of a long chat: 3,388 fresh + 1,602 out looked like "5k"; with the 418,209 cached it is 423k.
  assert.deepEqual(decodeContext(row({ fresh: 3388, out: 1602, cached: 418209, budget: 512000 })), { tokens: 423199, limit: 512000 });
  assert.deepEqual(decodeContext(row({ fresh: 10281, out: 701 })), { tokens: 10982 }, 'a first call has no cache and may not name a budget');
  assert.equal(decodeContext(field(2, 'not usage')), null);
});

test('the Gemini gauge follows the conversation, not the stream\'s fresh-token step usage', async () => {
  let size = 150000;
  const e = new StreamEngine({ agyThoughtReader: () => [], agyContextReader: () => ({ tokens: size, limit: 512000 }) });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', (event) => events.push(event));
  await e.consumeAgyLine(stepLine({ step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/a' } } }), child);
  // The step's own usage is the 5k that used to replace the gauge each turn.
  await e.consumeAgyLine(stepLine({ step_index: 2, step_type: 'agent_response', state: 'COMPLETE', usage: { input_tokens: 3388, output_tokens: 1602 } }), child);
  size = 160000;
  await e.consumeAgyLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok', usage: { input_tokens: 34009, cache_read_tokens: 92633, output_tokens: 5026 } } }), child);
  const usage = events.filter((event) => event.type === 'usage');
  assert.deepEqual(usage.map((event) => event.contextTokens), [150000, 160000]);
  assert.ok(usage.every((event) => event.contextWindow === 512000));
  assert.ok(!usage.some((event) => event.contextGrowth), 'the result needs no growth estimate once the real size is known');
});

test('without a readable trajectory the old estimates still apply', async () => {
  const e = new StreamEngine({ agyThoughtReader: () => [], agyContextReader: () => { throw new Error('no table'); } });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', (event) => events.push(event));
  await e.consumeAgyLine(stepLine({ step_index: 1, step_type: 'agent_response', state: 'COMPLETE', usage: { input_tokens: 4000, cache_read_tokens: 138000, output_tokens: 500 } }), child);
  assert.deepEqual(events.filter((event) => event.type === 'usage').map((event) => event.contextTokens), [142500]);
});

test("Claude's and Codex's own window replaces the nominal one", () => {
  assert.equal(contextWindowOf({ type: 'result', modelUsage: { 'claude-haiku': { contextWindow: 200000, inputTokens: 50 }, 'claude-opus': { contextWindow: 1000000, inputTokens: 9000, cacheReadInputTokens: 80000 } } }), 1000000, 'the model that did the work');
  assert.equal(contextWindowOf({ type: 'result', modelUsage: {} }), 0);
  assert.equal(contextWindowOf({ type: 'assistant' }), 0);
  const e = new StreamEngine();
  const events = [];
  e.on('event', (event) => events.push(event));
  e.codexActive = true;
  e.codexAcceptEvents = true;
  e.handleCodexNotification({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { modelContextWindow: 272000, last: { totalTokens: 90000 }, total: { totalTokens: 90000 } } } });
  assert.deepEqual(events.find((event) => event.type === 'usage'), { type: 'usage', agent: 'codex', contextTokens: 90000, contextWindow: 272000 });
});

// ---- a half-saved model call must not read as a shrunken context (2026-11-25: "153k -> 4k" on a chat that went on to 190k) ----
const contextEvents = async (reads, { lines } = {}) => {
  let i = 0;
  const e = new StreamEngine({ agyThoughtReader: () => [], agyContextReader: () => reads[Math.min(i++, reads.length - 1)] });
  const child = e.child = fakeChild();
  const events = [];
  e.on('event', (event) => events.push(event));
  for (const line of lines) { await e.consumeAgyLine(line, child); child.agyContextAt = 0; } // the 1.5 s throttle is not under test
  return events.filter((event) => event.type === 'usage').map((event) => event.contextTokens);
};
const tool = (index) => stepLine({ step_index: index, step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/a' } } });

test('a call saved in stages (fresh input and output, cache not yet) is not announced as a shrink; the full row that follows is', async () => {
  const seen = await contextEvents([{ tokens: 153325, limit: 512000 }, { tokens: 3721, limit: 512000 }, { tokens: 172987, limit: 512000 }], { lines: [tool(1), tool(2), tool(3)] });
  assert.deepEqual(seen, [153325, 172987]);
});

test('a real compaction (the low reading stays) is announced on the second read', async () => {
  const seen = await contextEvents([{ tokens: 511000 }, { tokens: 16208 }, { tokens: 16300 }, { tokens: 17000 }], { lines: [tool(1), tool(2), tool(3), tool(4)] });
  assert.deepEqual(seen, [511000, 16300, 17000]);
});

test('ordinary growth and small falls are never held back', async () => {
  const seen = await contextEvents([{ tokens: 20000 }, { tokens: 9000 }, { tokens: 100000 }, { tokens: 70000 }], { lines: [tool(1), tool(2), tool(3), tool(4)] });
  assert.deepEqual(seen, [20000, 9000, 100000, 70000], 'under 40k, or a fall of less than half, is just a number');
});

test("the stream's fresh-only usage never stands in for the gauge while agy's record can be read", async () => {
  const seen = await contextEvents([null, { tokens: 153325, limit: 512000 }], {
    lines: [stepLine({ step_index: 1, step_type: 'agent_response', state: 'COMPLETE', usage: { input_tokens: 3375, output_tokens: 346 } }), tool(2)],
  });
  assert.deepEqual(seen, [153325], 'the 3,721 fresh tokens of the first step must not appear as the context');
});
