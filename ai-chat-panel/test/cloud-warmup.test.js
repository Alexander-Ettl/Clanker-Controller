'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults, plan, due, slots, estimate, credential, HOUR } = require('../lib/cloud-warmup-plan');
const { execute, bucketStore, invoke } = require('../cloud-warmup/runner');
const { CloudWarmup } = require('../lib/cloud-warmup');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function store(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, { value: clone(v), generation: '1' }]));
  return {
    async get(name) { return clone(objects.get(name) || { value: null, generation: '0' }); },
    async put(name, value, generation) {
      const old = objects.get(name) || { value: null, generation: '0' };
      if (generation != null && old.generation !== generation) { const error = Error('Generation conflict'); error.status = 412; throw error; }
      objects.set(name, { value: clone(value), generation: String(Number(old.generation) + 1) });
    },
  };
}
const monday = Date.parse('2026-10-19T06:00:00Z');
const config = () => ({ enabled: true, revision: 'a', expiresAt: monday + 30 * 24 * HOUR, schedule: { ...defaults(), timezone: 'UTC' }, providers: { claude: { model: 'haiku' } } });
const token = 'sk-ant-oat01-test_subscription_token';

test('cloud object reads return an atomic generation and writes carry CAS preconditions', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, headers: { get: () => '42' }, json: async () => ({ status: 'ready' }) };
  };
  const s = bucketStore('private-bucket', async () => 'workload-token', fetchImpl);
  const record = await s.get('state/codex.json');
  assert.equal(record.generation, '42'); assert.equal(calls.length, 1);
  await s.put('state/codex.json', { status: 'starting' }, record.generation);
  assert.match(calls[1].url, /ifGenerationMatch=42/);
  assert.match(calls[1].url, /state%2Fcodex.json/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer workload-token');
  assert.equal(calls[1].options.body, '{"status":"starting"}');
});

test('a weekly calendar anchors the 9am example and rests overnight/weekends', () => {
  const p = plan({ ...defaults(), timezone: 'Europe/Berlin' });
  assert.deepEqual(slots(p, 1), [6, 11, 16]);
  assert.deepEqual(slots(p, 0), []);
  assert.equal(due(p, Date.parse('2026-10-19T04:00:00Z')), '2026-10-19/6');
  assert.equal(due(p, Date.parse('2026-10-19T19:00:00Z')), null);
  assert.equal(due(p, Date.parse('2026-10-19T04:16:00Z')), null, 'late delivery is not replayed');
  assert.equal(due(p, Date.parse('2026-10-18T04:00:00Z')), null);
  assert.equal(estimate(p, 2).callsPerWeek, 30);
  assert.ok(estimate(p, 2).cpuSeconds < 240000);
});

test('timezone decisions follow daylight saving without a drifting five-hour chain', () => {
  const p = plan({ ...defaults(), timezone: 'Europe/Berlin' });
  assert.equal(due(p, Date.parse('2026-10-23T04:00:00Z')), '2026-10-23/6');
  assert.equal(due(p, Date.parse('2026-10-26T05:00:00Z')), '2026-10-26/6');
  assert.equal(due(p, Date.parse('2026-10-26T04:00:00Z')), null);
});

test('invalid calendars and API-billed credentials fail closed', () => {
  assert.throws(() => plan({ ...defaults(), timezone: 'not/a/timezone' }), /timezone/);
  assert.throws(() => plan({ ...defaults(), leadHours: 5 }), /four/);
  assert.throws(() => plan({ ...defaults(), days: [] }), /seven/);
  const p = defaults(); p.days[1].start = 2;
  assert.throws(() => plan(p), /Overnight/);
  assert.throws(() => credential('codex', { auth_mode: 'apikey', OPENAI_API_KEY: 'secret' }), /subscription/);
  assert.throws(() => credential('claude', 'sk-ant-api03-secret'), /subscription/);
  assert.equal(credential('claude', token), token);
});

test('cloud sends one prompt and duplicate executions never send it again', async () => {
  const s = store({ 'config.json': config(), 'auth/claude.json': token }); let calls = 0;
  const invokeCli = async () => { calls++; return { status: 'done' }; };
  await execute({ store: s, now: () => monday, invokeCli });
  await execute({ store: s, now: () => monday + 1000, invokeCli });
  assert.equal(calls, 1);
  assert.equal((await s.get('state/claude.json')).value.status, 'done');
  assert.equal((await s.get('state/claude.json')).value.next, monday + 5 * HOUR);
  assert.equal((await s.get('lease.json')).value.until, 0);
});

test('a reservation survives a lost response and prevents automatic request retries', async () => {
  const s = store({ 'config.json': config(), 'auth/claude.json': token }); let calls = 0;
  const invokeCli = async () => { calls++; throw Error('lost response'); };
  await execute({ store: s, now: () => monday, invokeCli });
  await execute({ store: s, now: () => monday + 1000, invokeCli });
  assert.equal(calls, 1);
  assert.equal((await s.get('state/claude.json')).value.status, 'failed');
});

test('concurrent duplicate deliveries are serialized by the generation lease', async () => {
  const s = store({ 'config.json': config(), 'auth/claude.json': token }); let calls = 0;
  const invokeCli = async () => { calls++; return { status: 'done' }; };
  await Promise.all([execute({ store: s, now: () => monday, invokeCli }), execute({ store: s, now: () => monday, invokeCli })]);
  assert.equal(calls, 1);
});

test('paused, expired, quiet-hour, and known active windows send no prompt', async () => {
  for (const patch of [{ enabled: false }, { expiresAt: monday - 1 }]) {
    await execute({ store: store({ 'config.json': { ...config(), ...patch } }), now: () => monday, invokeCli: () => assert.fail('no prompt') });
  }
  await execute({ store: store({ 'config.json': config() }), now: () => monday + HOUR, invokeCli: () => assert.fail('no prompt') });
  await execute({ store: store({ 'config.json': config(), 'state/claude.json': { next: monday + HOUR } }), now: () => monday, invokeCli: () => assert.fail('active window') });
});

test('missing credentials require reconnect and do not keep retrying', async () => {
  const s = store({ 'config.json': config() });
  await execute({ store: s, now: () => monday, invokeCli: () => assert.fail('no credentials') });
  assert.equal((await s.get('state/claude.json')).value.status, 'reconnect');
  await execute({ store: s, now: () => monday + 5 * HOUR, invokeCli: () => assert.fail('reconnect blocks subsequent slots') });
});

test('the kill switch is checked after obtaining the lease', async () => {
  const s = store({ 'config.json': config(), 'auth/claude.json': token });
  const get = s.get.bind(s); let reads = 0;
  s.get = async name => {
    const record = await get(name);
    if (name === 'config.json' && ++reads === 2) record.value.enabled = false;
    return record;
  };
  await execute({ store: s, now: () => monday, invokeCli: () => assert.fail('paused during dispatch') });
});

test('refreshed Codex credentials persist and concurrent reconnect wins', async () => {
  const fs = require('node:fs/promises'), path = require('node:path');
  const auth = { auth_mode: 'chatgpt', tokens: { access_token: 'old', refresh_token: 'refresh' } };
  for (const reconnect of [false, true]) {
    const cfg = config(); cfg.providers = { codex: { model: 'test-model', effort: 'low' } };
    const s = store({ 'config.json': cfg, 'auth/codex.json': auth });
    await execute({ store: s, now: () => monday, invokeCli: async (_agent, _entry, home) => {
      await fs.writeFile(path.join(home, '.codex/auth.json'), JSON.stringify({ ...auth, tokens: { ...auth.tokens, access_token: 'rotated' } }));
      if (reconnect) await s.put('auth/codex.json', { ...auth, tokens: { ...auth.tokens, access_token: 'new-login' } });
      return { status: 'done' };
    } });
    assert.equal((await s.get('auth/codex.json')).value.tokens.access_token, reconnect ? 'new-login' : 'rotated');
  }
});

function host(saved = {}) {
  const notices = [], writes = [];
  const context = { globalState: { get: () => saved, update: async (_key, value) => writes.push(clone(value)) } };
  const vscode = { window: { showErrorMessage: text => notices.push(text), showWarningMessage: text => notices.push(text) } };
  const h = new CloudWarmup({ context, vscode, models: () => [], locate: () => '', enabledAgents: () => [], subscription: () => false, readQuotas: async () => ({}) });
  return { h, notices, writes };
}

test('opt-in defaults off and unprovisioned opt-in creates no cloud resources', async () => {
  const { h } = host();
  h.gcloud = () => assert.fail('no cloud calls');
  assert.equal(h.snapshot().enabled, false);
  assert.equal(h.owns('codex'), false);
  await h.handle({ action: 'enable', enabled: true });
  assert.equal(h.snapshot().enabled, true);
  assert.equal(h.owns('codex'), false);
});

test('pausing writes the cloud kill switch before stopping the timer', async () => {
  const { h } = host({ enabled: true, deployed: true, provisioned: true, project: 'test-project', expiresAt: Date.now() + HOUR, providers: { claude: {} } });
  const steps = [];
  h.config = async enabled => steps.push(['config', enabled]);
  h.gcloud = async args => steps.push(['gcloud', ...args.slice(0, 3)]);
  assert.equal(h.owns('claude'), true);
  await h.handle({ action: 'enable', enabled: false });
  assert.deepEqual(steps[0], ['config', false]);
  assert.deepEqual(steps[1], ['gcloud', 'scheduler', 'jobs', 'pause']);
  assert.equal(h.owns('claude'), false);
});

test('a failed pause does not falsely report cloud disabled', async () => {
  const { h, notices } = host({ enabled: true, provisioned: true });
  h.config = async () => { throw Error('offline'); };
  await h.handle({ action: 'enable', enabled: false });
  assert.equal(h.snapshot().enabled, true);
  assert.match(h.snapshot().status, /offline/);
  assert.equal(notices.length, 1);
});

test('re-enabling resumes the timer and does not extend expiry', async () => {
  const expiresAt = Date.now() + HOUR;
  const { h } = host({ enabled: false, deployed: true, project: 'test-project', expiresAt });
  const steps = []; h.config = async value => steps.push(value); h.gcloud = async args => steps.push(args[2]);
  await h.handle({ action: 'enable', enabled: true });
  assert.deepEqual(steps, [true, 'resume']);
  assert.equal(h.saved.expiresAt, expiresAt);
});

test('failed removals retain resource identities for cleanup; absent resources are idempotent', async () => {
  const saved = { enabled: true, deployed: true, provisioned: true, project: 'test-project', bucket: 'test-bucket' };
  const { h } = host(saved); h.config = async () => {};
  h.gcloud = async () => { throw Error('permission denied'); };
  await h.handle({ action: 'remove' });
  assert.equal(h.saved.bucket, 'test-bucket');
  assert.equal(h.saved.enabled, false);
  h.gcloud = async () => { const e = Error('gone'); e.notFound = true; throw e; };
  await h.handle({ action: 'remove' });
  assert.equal(h.saved.deployed, false);
  assert.equal(h.saved.bucket, null);
});

test('deployment builds only the runner sources and never runs a model prompt', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const { h } = host({ enabled: true, project: 'test-project', schedule: { ...defaults(), timezone: 'UTC' } });
  h.models = () => [{ agent: 'claude', model: 'claude-haiku', label: 'Haiku' }, { agent: 'codex', model: 'gpt-mini', label: 'Mini' }];
  h.enabledAgents = () => ['claude', 'codex', 'gemini', 'extra-provider'];
  h.subscription = () => true;
  h.vscode.window.showWarningMessage = async () => 'Deploy to my Google Cloud project';
  h.fetchImpl = async () => ({ ok: true, json: async () => ({ version: '1.2.3' }) });
  const commands = [], uploaded = [], s = store();
  h.store = () => s;
  h.gcloud = async args => {
    commands.push(args);
    if (args[0] === 'projects') return JSON.stringify({ projectNumber: '123456' });
    if (args[0] === 'builds') {
      const dir = args[2];
      const files = fs.readdirSync(dir).sort();
      assert.deepEqual(files, ['Dockerfile', 'build.json', 'cloud-warmup-plan.js', 'runner.js']);
      const build = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
      assert.equal(build.options.logging, 'GCS_ONLY');
      assert.ok(args.some(a => a.startsWith('--service-account=')));
      assert.ok(args.some(a => a.includes('/source')));
      uploaded.push(dir);
    }
    return '{}';
  };
  await h.handle({ action: 'deploy' });
  assert.equal(h.saved.deployed, true);
  assert.deepEqual(Object.keys(h.saved.providers).sort(), ['claude', 'codex']);
  assert.equal((await s.get('config.json')).value.enabled, true);
  assert.equal(commands.some(a => a.includes('--execute-now') || a.includes('execute')), false);
  const run = commands.find(a => a[0] === 'run' && a.includes('deploy'));
  assert.ok(run.includes('--max-retries=0')); assert.ok(run.includes('--tasks=1'));
  assert.equal(uploaded.every(dir => !fs.existsSync(dir)), true, 'build scratch removed');
  assert.equal(h.saved.auth, undefined, 'no desktop credentials uploaded');
});

test('declining deployment creates no resources and a failed deployment keeps cleanup information', async () => {
  const { h } = host({ enabled: true, project: 'test-project' });
  h.models = () => [{ agent: 'claude', model: 'haiku' }]; h.enabledAgents = () => ['claude']; h.subscription = () => true;
  h.vscode.window.showWarningMessage = async () => undefined;
  h.gcloud = () => assert.fail('declined deploy cannot create resources');
  await h.handle({ action: 'deploy' });
  assert.equal(h.saved.provisioned, undefined);
  h.vscode.window.showWarningMessage = async () => 'Deploy to my Google Cloud project';
  h.gcloud = async args => {
    if (args[0] === 'projects') return JSON.stringify({ projectNumber: '123' });
    if (args[0] === 'iam') throw Error('organization policy');
    return '{}';
  };
  await h.handle({ action: 'deploy' });
  assert.equal(h.saved.provisioned, true);
  assert.equal(h.saved.deployed, undefined);
  assert.equal(h.saved.bucket, 'test-project-clanker-123');
  assert.match(h.status, /organization policy/);
});

test('a timezone change updates the timer, and a cloud refresh adopts the saved remote calendar', async () => {
  const { h } = host({ enabled: true, deployed: true, project: 'test-project' });
  const steps = [];
  h.gcloud = async args => steps.push(args);
  h.config = async () => steps.push('config');
  const next = { ...defaults(), timezone: 'Asia/Kathmandu' };
  await h.handle({ action: 'save', schedule: next });
  assert.ok(steps[0].includes('--time-zone=Asia/Kathmandu'));
  assert.equal(steps[1], 'config');
  const remote = config(); remote.schedule.timezone = 'America/New_York'; remote.expiresAt = Date.now() + 30 * 24 * HOUR; // the status line compares with the real clock, so a fixed date would expire
  h.store = () => store({ 'config.json': remote });
  h.api = async () => ({ state: 'PAUSED' });
  await h.handle({ action: 'refresh' });
  assert.equal(h.snapshot().schedule.timezone, 'America/New_York');
  assert.match(h.snapshot().status, /timer is paused/);
});

test('partial removal remains retryable after the runtime bucket was already deleted', async () => {
  const { h } = host({ provisioned: true, deployed: true, enabled: true, project: 'test-project', bucket: 'test-bucket' });
  h.config = async () => { const e = Error('missing bucket'); e.status = 404; throw e; };
  let deletions = 0; h.gcloud = async () => { deletions++; };
  await h.handle({ action: 'remove' });
  assert.ok(deletions > 0); assert.equal(h.saved.provisioned, false);
});

test('cloud invocation isolates its environment and requires a completed answer', async () => {
  const { EventEmitter } = require('node:events');
  const fakeSpawn = (events, code = 0, check = () => {}) => (binary, args, options) => {
    check(binary, args, options);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = prompt => {
      assert.equal(prompt, 'respond with 1\n');
      process.nextTick(() => { child.stdout.emit('data', events.map(JSON.stringify).join('\n')); child.emit('close', code); });
    };
    child.kill = () => {};
    return child;
  };
  const done = [{ type: 'item.completed', item: { type: 'agent_message', text: '1' } }, { type: 'turn.completed' }];
  const result = await invoke('codex', { model: 'gpt-mini', effort: 'low' }, 'temporary-home', {}, fakeSpawn(done, 0, (binary, args, { env, cwd }) => {
    assert.equal(binary, 'codex'); assert.equal(cwd, 'temporary-home');
    assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('web_search="disabled"'));
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(env.HOME, 'temporary-home');
  }));
  assert.equal(result.status, 'done');
  assert.equal((await invoke('codex', { model: 'gpt-mini' }, 'tmp', {}, fakeSpawn([{ type: 'turn.completed' }]))).status, 'failed');
  assert.equal((await invoke('claude', { model: 'haiku' }, 'tmp', token, fakeSpawn([{ type: 'result', is_error: true, result: 'Authentication required' }], 1))).status, 'reconnect');
  assert.equal((await invoke('claude', { model: 'haiku' }, 'tmp', token, fakeSpawn([{ type: 'result', result: '1' }]))).status, 'done');
});

test('Google connection uses official sign-in, selects a billing-enabled project, and saves the account', async () => {
  const { h } = host();
  const commands = [];
  h.gcloud = async args => {
    commands.push(args);
    if (args[0] === 'config') return 'person@example.com';
    if (args[0] === 'projects') return JSON.stringify([{ projectId: 'test-project', name: 'Personal test' }]);
    return '';
  };
  h.api = async () => ({ billingEnabled: true });
  h.vscode.window.showQuickPick = async entries => entries[0];
  await h.handle({ action: 'connect' });
  assert.deepEqual(commands[0], ['auth', 'login', '--quiet']);
  assert.equal(h.saved.project, 'test-project'); assert.equal(h.saved.account, 'person@example.com');
  assert.equal(h.saved.provisioned, undefined); assert.equal(h.connecting, false);
});
