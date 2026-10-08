'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInvestigationBridge, investigationOptions, cleanRequest, UNAVAILABLE } = require('../lib/investigation-bridge');

function setup({ available = true, reviewModels = [{ id: 'claude-opus-5-5-high', agent: 'claude' }], api } = {}) {
  const manager = Object.assign(new EventEmitter(), { snapshot: () => ({ jobs: [], runs: [], ledger: {}, version: manager.version }), version: 1 });
  const calls = [];
  const investigations = available ? { manager, api: api || (async request => { calls.push(request); return request.action === 'handoff' ? { projectId: 'project-a', prompt: 'REVIEW THIS' } : { ok: request.action }; }) } : null;
  const posted = [];
  const reviews = [];
  const bridge = createInvestigationBridge({
    getInvestigations: () => investigations,
    getOptions: () => ({ reviewModels }),
    review: async request => { reviews.push(request); return { projectId: request.projectId, modelId: request.modelId }; },
    post: message => posted.push(message),
  });
  return { bridge, manager, calls, posted, reviews };
}
const ask = (bridge, request, requestId = 'r1') => bridge.handle({ type: 'investigations', requestId, request });

test('a request is answered with its own id and a fresh snapshot', async () => {
  const { bridge, calls, posted } = setup();
  await ask(bridge, { action: 'start', id: 'job-1', ignored: '<script>' });
  assert.deepEqual(calls, [{ action: 'start', id: 'job-1' }], 'extra fields never reach the backend');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'investigationsResult');
  assert.equal(posted[0].requestId, 'r1');
  assert.equal(posted[0].ok, true);
  assert.deepEqual(posted[0].state.jobs, []);
});

test('malformed requests fail with an error and never reach the manager', async () => {
  const { bridge, calls, posted } = setup();
  const bad = [undefined, null, 'list', {}, { action: 'rm' }, { action: 'start' }, { action: 'start', id: { $ne: 1 } }, { action: 'start', id: '../x' },
    { action: 'openArtifact', runId: 'r', name: '..\\..\\secret.txt' }, { action: 'openArtifact', runId: 'r', name: 'C:\\x' },
    { action: 'create', projectId: 'p', limits: { dailyTokens: '1e9' } }, { action: 'create', projectId: 'p', limits: { surprise: 1 } }, { action: 'create', projectId: 'p', expiresAt: 'soon' },
    { action: 'review', runId: 'r' }];
  for (const [index, request] of bad.entries()) await ask(bridge, request, `bad-${index}`);
  assert.deepEqual(calls, []);
  assert.equal(posted.length, bad.length);
  assert.ok(posted.every((message, index) => message.ok === false && message.requestId === `bad-${index}` && message.error));
});

test('messages without a usable request id are ignored', async () => {
  const { bridge, posted } = setup();
  await bridge.handle({ type: 'investigations', request: { action: 'list' } });
  await bridge.handle({ type: 'investigations', requestId: 7, request: { action: 'list' } });
  await bridge.handle(null);
  assert.deepEqual(posted, []);
});

test('backend failures come back as errors with the state to show beside them', async () => {
  const { bridge, posted, manager } = setup({ api: async () => { throw new Error('Pause the investigation before changing limits.'); } });
  manager.version = 9;
  await ask(bridge, { action: 'configure', id: 'job-1', limits: { maxRuns: 2 } });
  assert.equal(posted[0].ok, false);
  assert.equal(posted[0].error, 'Pause the investigation before changing limits.');
  assert.equal(posted[0].state.version, 9);
});

test('another IDE host owning the manager is reported, not faked', async () => {
  const { bridge, posted } = setup({ available: false });
  await ask(bridge, { action: 'list' });
  assert.equal(posted[0].ok, false);
  assert.equal(posted[0].unavailable, true);
  assert.equal(posted[0].error, UNAVAILABLE);
  assert.equal(bridge.subscribed, false);
});

test('manager changes are pushed once per view and stop when the view is disposed', async () => {
  const { bridge, manager, posted } = setup();
  assert.equal(manager.listenerCount('change'), 0, 'nothing is subscribed before the view asks');
  await ask(bridge, { action: 'list' }, 'a');
  await ask(bridge, { action: 'list' }, 'b');
  assert.equal(manager.listenerCount('change'), 1);
  posted.length = 0;
  manager.emit('change', { jobs: [{ id: 'x' }], runs: [], ledger: {} });
  assert.deepEqual(posted.map(message => [message.type, message.available, message.state.jobs[0].id]), [['investigationsState', true, 'x']]);
  bridge.dispose();
  assert.equal(manager.listenerCount('change'), 0);
  posted.length = 0;
  manager.emit('change', { jobs: [], runs: [], ledger: {} });
  await ask(bridge, { action: 'list' }, 'late');
  assert.deepEqual(posted, [], 'a disposed view receives nothing');
});

test('a result that arrives after disposal is dropped', async () => {
  let release;
  const { bridge, posted, manager } = setup({ api: () => new Promise(resolve => { release = resolve; }) });
  const pending = ask(bridge, { action: 'list' });
  await new Promise(resolve => setImmediate(resolve));
  bridge.dispose();
  release({});
  await pending;
  assert.deepEqual(posted, []);
  assert.equal(manager.listenerCount('change'), 0);
});

test('Review with… opens the project the report belongs to, with the chosen model, and nothing else', async () => {
  const { bridge, calls, reviews, posted } = setup();
  await ask(bridge, { action: 'review', runId: 'run-1', modelId: 'claude-opus-5-5-high' });
  assert.deepEqual(calls, [{ action: 'handoff', runId: 'run-1' }]);
  assert.deepEqual(reviews, [{ projectId: 'project-a', prompt: 'REVIEW THIS', modelId: 'claude-opus-5-5-high' }]);
  assert.equal(posted[0].ok, true);
  assert.deepEqual(posted[0].result, { projectId: 'project-a', modelId: 'claude-opus-5-5-high' });
});

test('Review with… refuses a model that is not on the offered list, Flash included', async () => {
  const { bridge, calls, reviews, posted } = setup();
  await ask(bridge, { action: 'review', runId: 'run-1', modelId: 'gemini-3.8-flash-high' });
  assert.deepEqual(reviews, []);
  assert.deepEqual(calls, []);
  assert.equal(posted[0].ok, false);
});

test('Review with… reports a project that can no longer be opened and sends nothing', async () => {
  const { posted } = await (async () => {
    const context = setup();
    context.bridge = createInvestigationBridge({
      getInvestigations: () => ({ manager: context.manager, api: async () => ({ projectId: 'gone', prompt: 'p' }) }),
      getOptions: () => ({ reviewModels: [{ id: 'm' }] }),
      review: async () => { throw new Error('Project folder is missing.'); },
      post: message => context.posted.push(message),
    });
    await ask(context.bridge, { action: 'review', runId: 'r', modelId: 'm' });
    return context;
  })();
  assert.equal(posted[0].ok, false);
  assert.equal(posted[0].error, 'Project folder is missing.');
});

test('cleanRequest keeps only the documented fields', () => {
  assert.deepEqual(cleanRequest({ action: 'create', projectId: 'p', model: 'gemini-3.8-flash-high', limits: { maxRuns: 2 }, expiresAt: 5, extra: 1 }),
    { action: 'create', projectId: 'p', model: 'gemini-3.8-flash-high', limits: { maxRuns: 2 }, expiresAt: 5 });
  assert.deepEqual(cleanRequest({ action: 'stopAll', id: 'x' }), { action: 'stopAll' });
});

test('options offer Flash for diagnosis and every other connected model for review', () => {
  const models = [
    { id: 'gemini-3.8-flash-high', model: 'gemini-3.8-flash-high', agent: 'gemini', label: 'Flash High' },
    { id: 'gemini-3.1-pro-high', model: 'gemini-3.1-pro-high', agent: 'gemini', label: 'Pro' },
    { id: 'claude-opus-5-5-high', model: 'claude-opus-5-5', agent: 'claude', label: 'Opus' },
    { id: 'gpt-6.1-sol-high', model: 'gpt-6.1-sol', agent: 'codex', label: 'Sol' },
  ];
  const options = investigationOptions({ projects: [{ id: 'a', name: 'A', root: '/a', secret: 1 }, { id: 'b', name: 'B' }], projectId: 'a', models, isEnabled: agent => agent !== 'codex' });
  assert.deepEqual(options.projects, [{ id: 'a', name: 'A', root: '/a' }]);
  assert.deepEqual(options.flashModels.map(model => model.id), ['gemini-3.8-flash-high']);
  assert.deepEqual(options.reviewModels.map(model => model.id), ['gemini-3.1-pro-high', 'claude-opus-5-5-high']);
  assert.equal(options.projectId, 'a');
});
