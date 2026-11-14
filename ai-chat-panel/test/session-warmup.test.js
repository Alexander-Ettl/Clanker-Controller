'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionWarmup, cheapestModel, commandFor, readOutput, WINDOW_MS, WEEK_MS } = require('../lib/session-warmup');

const catalog = [
  { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', label: 'Claude Opus 5.5 High' },
  { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', label: 'Claude Sonnet 5.5 Low' },
  { agent: 'claude', model: 'claude-haiku-5-5', effort: 'high', label: 'Claude Haiku 5.5 High' },
  { agent: 'claude', model: 'claude-haiku-5-5', effort: 'low', label: 'Claude Haiku 5.5 Low' },
  { agent: 'codex', model: 'gpt-5.5', effort: 'low', label: 'GPT 5.5 Low' },
  { agent: 'codex', model: 'gpt-5.5-mini', effort: 'medium', label: 'GPT 5.5 Mini Medium' },
  { agent: 'codex', model: 'gpt-5.5-mini', effort: 'low', label: 'GPT 5.5 Mini Low' },
  { agent: 'gemini', model: 'gemini-3.8-pro-low', effort: null, label: 'Gemini 3.8 Pro Low' },
  { agent: 'gemini', model: 'gemini-3.8-flash-high', effort: null, label: 'Gemini 3.8 Flash High' },
  { agent: 'gemini', model: 'gemini-3.8-flash-low', effort: null, label: 'Gemini 3.8 Flash Low' },
];

test('the cheapest model is the smallest family at the lowest effort', () => {
  assert.equal(cheapestModel(catalog, 'claude').label, 'Claude Haiku 5.5 Low');
  assert.equal(cheapestModel(catalog, 'codex').label, 'GPT 5.5 Mini Low');
  assert.equal(cheapestModel(catalog, 'gemini').model, 'gemini-3.8-flash-low');
  assert.equal(cheapestModel(catalog, 'nobody'), null);
  assert.equal(cheapestModel([{ agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' }], 'claude').effort, 'low');
});

test('commands send the prompt on stdin with the cheap model and no tools, and the plain variant drops the lean flags', () => {
  const claude = commandFor('claude', cheapestModel(catalog, 'claude'), 'C:\\bin\\claude.exe');
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--model'), claude.args.indexOf('--model') + 4), ['--model', 'claude-haiku-5-5', '--effort', 'low']);
  assert.ok(claude.args.includes('--tools') && claude.args.includes('--no-session-persistence'));
  assert.equal(claude.input, 'respond with 1\n');
  assert.ok(!commandFor('claude', cheapestModel(catalog, 'claude'), 'claude.exe', { lean: false }).args.includes('--tools'));
  const codex = commandFor('codex', cheapestModel(catalog, 'codex'), 'codex.exe');
  assert.deepEqual(codex.args.slice(0, 2), ['exec', '--json']);
  assert.ok(codex.args.includes('model_reasoning_effort="low"') && codex.args.at(-1) === '-');
  assert.ok(!codex.args.includes('--ephemeral'), 'the ping must leave a session log: Codex quota is read from it');
  const agy = commandFor('gemini', cheapestModel(catalog, 'gemini'), 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe');
  assert.ok(agy.args.includes('gemini-3.8-flash-low'));
  assert.equal(agy.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true', 'agy otherwise opens a terminal window for its background updater');
  assert.equal(agy.env.ANTIGRAVITY_NO_CHIME, '1', 'silences the global agy Stop hook so Clanker chimes once when the reply renders');
  assert.deepEqual(commandFor('codex', cheapestModel(catalog, 'codex'), 'codex.exe').env, {});
  assert.match(agy.input, /respond with 1/);
});

test('output gives the tokens used and the usage windows Claude reports', () => {
  const { tokens, windows, reply } = readOutput([
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: 1900000000 } } } }),
    JSON.stringify({ type: 'result', result: '1', usage: { input_tokens: 9, output_tokens: 5, cache_creation_input_tokens: 40 } }),
  ].join('\n'));
  assert.equal(tokens, 54);
  assert.equal(reply, '1');
  assert.deepEqual(windows.fiveHour, { used: 2, resetsAt: 1900000000 });
  assert.deepEqual(readOutput('not json\n'), { tokens: null, windows: null, reply: '' });
});

function fixture({ api = [], scheduled = [], time = new Date(2026, 9, 19, 6, 40), enabled = true, quotas = {}, code = 0, agents = ['claude', 'codex', 'gemini'] } = {}) {
  const calls = [], recorded = [];
  let saved = {}, clock = time;
  const warmup = new SessionWarmup({
    getConfig: () => ({ enabled }), models: () => catalog, agents: () => agents, locate: (agent) => `${agent}.exe`, hasScheduled: async (agent) => f.scheduled.includes(agent), subscription: (agent) => !api.includes(agent),
    readQuotas: async () => f.quotas, record: (agent, windows) => recorded.push([agent, windows]), now: () => clock,
    store: { get: () => saved, set: (value) => { saved = value; } },
    execute: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, input: options.input });
      return { code: typeof code === 'function' ? code(calls.length) : code, output: JSON.stringify({ type: 'result', result: '1', usage: { input_tokens: 10, output_tokens: 2 } }), stderr: 'unknown option --tools' };
    },
  });
  const f = { quotas, scheduled };
  return Object.assign(f, { warmup, calls, recorded, saved: () => saved, setTime: (next) => { clock = next; } });
}

test('every connected CLI whose window is not running gets one ping, then again once the window is over', async () => {
  const f = fixture({ quotas: { codex: { resetsAt: new Date(2026, 9, 19, 6, 40).getTime() / 1000 + 3600 } } });
  assert.deepEqual(await f.warmup.tick(), ['claude', 'gemini']);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => /clanker-warmup-/.test(call.cwd)));
  assert.deepEqual(Object.fromEntries(Object.entries(f.saved()).map(([agent, info]) => [agent, info.status])), { claude: 'done', codex: 'running', gemini: 'done' });
  assert.equal(f.saved().claude.tokens, 12);
  assert.equal(f.saved().claude.label, 'Claude Haiku 5.5 Low');
  assert.deepEqual(await f.warmup.tick(), []);
  f.setTime(new Date(2026, 9, 19, 7, 41)); // codex reported a window until 7:40
  f.quotas = {};
  assert.deepEqual(await f.warmup.tick(), ['codex'], 'a running window is looked at again once it ends');
  f.setTime(new Date(2026, 9, 19, 10, 0));
  assert.deepEqual(await f.warmup.tick(), [], 'the others are still inside their window at 10:00');
  f.setTime(new Date(2026, 9, 19, 6, 40, 0, WINDOW_MS + 1));
  assert.equal((await f.warmup.tick()).length, 2, 'every window pings again five hours later, at any time of day');
});

test('nothing is sent when it is off or the CLI is not installed', async () => {
  assert.deepEqual(await fixture({ enabled: false }).warmup.tick(), []);
  const f = fixture(); f.warmup.locate = () => '';
  assert.deepEqual(await f.warmup.tick(), []);
  assert.equal(f.calls.length, 0);
});

test('a provider with a prompt queued for its usage reset is not pinged: that prompt starts the window', async () => {
  const f = fixture({ scheduled: ['claude', 'gemini'] });
  assert.deepEqual(await f.warmup.tick(), ['codex']);
  assert.deepEqual(Object.keys(f.saved()), ['codex'], 'nothing is recorded for the others, so they are looked at again');
  assert.deepEqual(await f.warmup.tick(), []);
  f.scheduled = []; // the queued prompt ran or was cancelled
  assert.deepEqual(await f.warmup.tick(), ['claude', 'gemini']);
});

test('a CLI billed per token through an API key is never pinged', async () => {
  const f = fixture({ api: ['codex'] });
  assert.deepEqual(await f.warmup.tick(), ['claude', 'gemini']);
  assert.ok(f.calls.every((call) => !/codex/.test(call.command)));
});

test('a CLI that refuses the lean flags is retried once with the plain command; a failure is retried later, three times at most', async () => {
  const lean = fixture({ agents: ['claude'], code: (n) => (n === 1 ? 1 : 0) });
  assert.deepEqual(await lean.warmup.tick(), ['claude']);
  assert.equal(lean.calls.length, 2);
  assert.ok(lean.calls[0].args.includes('--tools') && !lean.calls[1].args.includes('--tools'));
  assert.equal(lean.saved().claude.status, 'done');

  const broken = fixture({ agents: ['claude'], code: 1 });
  await broken.warmup.tick();
  assert.equal(broken.saved().claude.status, 'failed');
  assert.match(broken.saved().claude.error, /unknown option/);
  assert.deepEqual(await broken.warmup.tick(), [], 'not again within ten minutes');
  for (const minute of [51, 62]) { broken.setTime(new Date(2026, 9, 19, 6, minute)); assert.deepEqual(await broken.warmup.tick(), ['claude']); }
  broken.setTime(new Date(2026, 9, 19, 7, 30));
  assert.deepEqual(await broken.warmup.tick(), [], 'the third failure is the last until the next window');
  broken.setTime(new Date(2026, 9, 19, 12, 3));
  assert.deepEqual(await broken.warmup.tick(), ['claude'], 'five hours after the last try it starts over');
});

test('a Claude ping hands its reported windows to the gauges', async () => {
  const f = fixture({ agents: ['claude'] });
  f.warmup.execute = async () => ({ code: 0, stderr: '', output: [
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: 1900000000 } } } }),
    JSON.stringify({ type: 'result', result: '1' })].join('\n') });
  await f.warmup.tick();
  assert.deepEqual(f.recorded, [['claude', { fiveHour: { used: 1, resetsAt: 1900000000 }, sevenDay: null }]]);
});

test('the snapshot tells the settings pane whether it is on and the last results', async () => {
  const f = fixture();
  await f.warmup.tick();
  const snapshot = f.warmup.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.last.claude.status, 'done');
});

test('startup output, token counts and streamed failures never count as a successful warm-up', async () => {
  for (const event of [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { usage: { input_tokens: 10 } } },
    { type: 'result', is_error: true, result: 'Not signed in' },
    { type: 'turn.failed', error: { message: 'Usage limit reached' } },
    { event: 'result', result: { status: 'ERROR', error: 'Request failed', response: 'Error' } },
  ]) {
    const f = fixture({ agents: ['claude'] });
    let calls = 0;
    f.warmup.execute = async () => { calls++; return { code: 0, stderr: '', output: JSON.stringify(event) }; };
    await f.warmup.tick();
    assert.equal(f.saved().claude.status, 'failed', JSON.stringify(event));
    assert.equal(calls, 1, 'a failed request must not be repeated with isolation flags removed');
    assert.equal(f.saved().claude.next - f.saved().claude.at, 10 * 60 * 1000);
  }
});

test('Codex and Antigravity require their completed answer events', async () => {
  for (const [agent, events] of [
    ['codex', [{ type: 'item.completed', item: { type: 'agent_message', text: '1' } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }]],
    ['gemini', [{ event: 'result', result: { status: 'SUCCESS', response: '1', usage: { input_tokens: 10, output_tokens: 2 } } }]],
  ]) {
    const f = fixture({ agents: [agent] });
    f.warmup.execute = async () => ({ code: 0, stderr: '', output: events.map(event => JSON.stringify(event)).join('\n') });
    await f.warmup.tick();
    assert.equal(f.saved()[agent].status, 'done');
    assert.equal(f.saved()[agent].tokens, 12);
  }
});

test('Gemini 4 Argon gets its own weekly warm-up on the cheapest Argon model, skipped on Ultra', async () => {
  const argonCatalog = [
    ...catalog,
    { agent: 'gemini', model: 'gemini-4-argon-high', effort: 'high', brand: 'antigravityArgon', label: 'Gemini 4 Argon High' },
    { agent: 'gemini', model: 'gemini-4-argon-low', effort: 'low', brand: 'antigravityArgon', label: 'Gemini 4 Argon Low' },
  ];
  assert.equal(cheapestModel(argonCatalog, 'gemini').model, 'gemini-3.8-flash-low');
  assert.equal(cheapestModel(argonCatalog, 'gemini', 'antigravityArgon').model, 'gemini-4-argon-low');

  const f = fixture({ agents: ['gemini'], quotas: { gemini: { remaining: 100, resetsAt: null }, antigravityArgon: { remaining: 100, resetsAt: null } } });
  f.warmup.models = () => argonCatalog;
  assert.deepEqual(await f.warmup.tick(), ['gemini', 'antigravityArgon']);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].args.includes('gemini-3.8-flash-low'));
  assert.ok(f.calls[1].args.includes('gemini-4-argon-low'));
  assert.equal(f.saved().antigravityArgon.next - f.saved().antigravityArgon.at, WEEK_MS);

  // Ultra plans report a Gemini pool and no separate Argon pool: Argon is not pinged separately.
  const ultra = fixture({ agents: ['gemini'], quotas: { gemini: { remaining: 90, resetsAt: null }, antigravityArgon: null } });
  ultra.warmup.models = () => argonCatalog;
  assert.deepEqual(await ultra.warmup.tick(), ['gemini']);
});
