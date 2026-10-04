'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setModelCatalog, setFavoriteModels, setEnabledAgents } = require('../lib/model-catalog');
const { route, routeBest } = require('../lib/auto-router');
const fast = { id: 'new-model-low', agent: 'codex', model: 'new-model', effort: 'low' };
const deep = { id: 'other-model-xhigh', agent: 'codex', model: 'other-model', effort: 'xhigh' };
const visual = { id: 'future-model', agent: 'gemini', model: 'future-model', effort: 'high' };
const seed = (favorites = [fast, deep, visual]) => {
  setEnabledAgents(['claude', 'codex', 'gemini']);
  setModelCatalog([fast, deep, visual]); setFavoriteModels(favorites);
};

test('semantic routing considers every favorite and preserves the exact model/effort id', async () => {
  seed();
  const result = await routeBest('Design the UI', {}, undefined, async (task, models) => {
    assert.equal(task, 'Design the UI');
    assert.deepEqual(new Set(models.map(m => m.id)), new Set([fast.id, deep.id, visual.id]));
    return deep.id;
  });
  assert.equal(result.modelId, deep.id);
  assert.equal(result.agent, 'codex', 'any provider can handle UI');
  assert.equal(result.directive, '');
});

test('favorites, discovery and enabled connections take effect immediately', async () => {
  seed([visual]); assert.equal(route('Code', {}).modelId, visual.id);
  seed([deep]); assert.equal(route('Plan', {}).modelId, deep.id);
  setEnabledAgents(['gemini']); assert.throws(() => route('Task'), /favorite a model/);
  seed(); setModelCatalog([fast, visual]);
  const result = await routeBest('Task', {}, undefined, async () => deep.id);
  assert.notEqual(result.modelId, deep.id, 'removed discovery entry cannot be chosen');
});

test('rejects exhausted windows, prefers healthy quotas, and checks the weekly cap', async () => {
  seed();
  const quotas = { codex: { remaining: 90, secondary: { remaining: 0 } }, gemini: { remaining: 10 } };
  assert.equal(route('Task', quotas).modelId, visual.id);
  assert.equal(route('Task', { codex: { remaining: 10 }, gemini: { remaining: 90 } }).agent, 'gemini');
  assert.throws(() => route('Task', { codex: { remaining: 0 }, gemini: { remaining: 0 } }), /out of usage/);
  assert.equal(route('Task', quotas, 'codex').agent, 'codex', 'manual choice is unchanged');
});

test('invalid decisions and classifier failures use task difficulty without fixed model names', async () => {
  seed([fast, deep]);
  assert.equal((await routeBest('Fix a typo', {}, undefined, async () => 'invented')).modelId, fast.id);
  assert.equal((await routeBest('Investigate a complex migration', {}, undefined, async () => { throw Error('offline'); })).modelId, deep.id);
});

test('a favorite removed during classification is never dispatched', async () => {
  seed();
  const result = await routeBest('Task', {}, undefined, async () => { setFavoriteModels([visual]); return deep.id; });
  assert.equal(result.modelId, visual.id);
});

test('the classifier receives the live candidates and task context and returns an exact id', async () => {
  const { selectFavoriteModel } = await import('../../voice-router/lib/groq-client.mjs');
  const originalFetch = global.fetch, originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-only';
  global.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(input.candidates, [fast, deep]);
    assert.deepEqual(input.context, [{ role: 'user', text: 'Our migration is failing.' }]);
    assert.match(body.messages[0].content, /no fixed provider roles/);
    assert.ok(request.signal);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ modelId: deep.id }) } }] }) };
  };
  try {
    assert.equal(await selectFavoriteModel('Investigate it', [fast, deep], {}, [{ role: 'user', text: 'Our migration is failing.' }]), deep.id);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalKey;
  }
});
