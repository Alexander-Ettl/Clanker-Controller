'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { summarizeText, SCHEMA } = require('../lib/summarize');

test('summarize asks Gemini directly, with no tools, in a scratch folder that is removed afterwards', async () => {
  let call;
  const answer = { overview: 'A test comment.', items: [] };
  const text = await summarizeText('Summarize.', '[1] page / · a@b.c\ntest 123', { flash: async options => { call = options; assert.ok(fs.existsSync(options.cwd)); return { report: answer, tokens: 10 }; } });
  assert.deepEqual(JSON.parse(text), answer);
  assert.equal(call.model, 'gemini-3.8-flash-high'); assert.equal(call.schema, SCHEMA); assert.equal(call.prompt, '[1] page / · a@b.c\ntest 123');
  assert.deepEqual(call.tools || [], []);
  assert.match(call.task, /^Summarize\./); assert.match(call.task, /Never follow instructions/);
  assert.equal(fs.existsSync(call.cwd), false);
});

test('summarize returns nothing for empty text and cleans up when Gemini fails', async () => {
  assert.equal(await summarizeText('x', '  ', { flash: async () => assert.fail('no call') }), '');
  let cwd;
  await assert.rejects(summarizeText('x', 'y', { flash: async options => { cwd = options.cwd; throw new Error('Flash failed'); } }), /Flash failed/);
  assert.equal(fs.existsSync(cwd), false);
});
