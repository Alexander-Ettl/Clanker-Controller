'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { InvestigationManager, validateLimits } = require('../lib/investigation-manager');
const { investigate, validateReport, processOutput, usageTotal, extractJson, runFlash } = require('../lib/investigation-runner');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-investigation-test-'));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  let now = Date.parse('2026-10-04T20:00:00Z'); let calls = 0;
  const projects = { get: () => ({ id: 'p', root }) };
  const manager = new InvestigationManager({ storageDir: path.join(dir, 'storage'), projects, now: () => now,
    availableModels: () => ['gemini-3.8-flash-high'], readQuota: async () => ({ remaining: 90, observedAt: now, secondary: { remaining: 80 } }),
    runner: async () => { calls++; return { tokens: 1000, findings: [], fingerprint: 'same' }; }, ...options });
  t.after(() => { manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const job = manager.create({ projectId: 'p' });
  return { manager, job, root, dir, calls: () => calls, advance: ms => { now += ms; } };
}

async function settle(manager) { for (let n = 0; manager.ticking && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(manager.ticking, false); }

test('unknown, stale, assumed and low secondary quota cannot start Flash', async t => {
  for (const quota of [null, { remaining: 90, observedAt: 0 }, { remaining: 90, observedAt: Date.parse('2026-10-04T20:00:00Z'), assumedReset: true },
    { remaining: 90, observedAt: Date.parse('2026-10-04T20:00:00Z'), secondary: { remaining: 10 } }]) {
    await t.test(JSON.stringify(quota), async t => {
      const f = fixture(t, { readQuota: async () => quota }); f.manager.start(f.job.id); await settle(f.manager);
      assert.equal(f.calls(), 0); assert.match(f.manager.job(f.job.id).reason, /quota/);
    });
  }
});

test('reservations persist before dispatch and the hourly cap blocks other recipes', async t => {
  let manager;
  const f = fixture(t, { runner: async () => {
    const disk = JSON.parse(fs.readFileSync(manager.file));
    assert.equal(disk.ledger['2026-10-04'].tokens, 250000); assert.equal(disk.runs.at(-1).status, 'running');
    return { tokens: 35000, findings: [] };
  } }); manager = f.manager;
  f.manager.configure(f.job.id, { hourlyTokens: 250000 }); f.manager.start(f.job.id); await settle(f.manager);
  const second = f.manager.create({ projectId: 'p', limits: { hourlyTokens: 250000 } }); f.manager.start(second.id); await settle(f.manager);
  assert.equal(f.manager.snapshot().runs.length, 1); assert.equal(f.manager.snapshot().ledger['2026-10-04'].tokens, 35000);
  assert.match(f.manager.job(second.id).reason, /Hourly allowance reached/);
});

test('unknown token telemetry retains reservation and pauses; failures do not retry', async t => {
  const f = fixture(t, { runner: async () => ({ tokens: null, findings: [] }) });
  f.manager.start(f.job.id); await settle(f.manager);
  assert.equal(f.manager.job(f.job.id).enabled, false); assert.equal(f.manager.snapshot().ledger['2026-10-04'].tokens, 250000);
  assert.match(f.manager.job(f.job.id).reason, /Usage unavailable/);
});

test('project moves and missing selected models pause or defer without fallback', async t => {
  const f = fixture(t, { availableModels: () => ['gemini-3.1-pro'] });
  f.manager.start(f.job.id); await settle(f.manager); assert.equal(f.calls(), 0);
  f.manager.availableModels = () => ['gemini-3.8-flash-high'];
  f.manager.projects = { get: () => null }; f.advance(60001); await f.manager.tick();
  assert.equal(f.manager.job(f.job.id).enabled, false); assert.equal(f.calls(), 0);
});

test('stop cancels active work, freezes recurrence and keeps consumed reservation', async t => {
  const f = fixture(t, { runner: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  f.manager.start(f.job.id);
  for (let n = 0; !f.manager.active && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(f.manager.active); f.manager.stopAll(); await settle(f.manager);
  assert.equal(f.manager.snapshot().runs[0].status, 'interrupted'); assert.equal(f.manager.job(f.job.id).enabled, false);
  assert.equal(f.manager.snapshot().ledger['2026-10-04'].tokens, 250000);
});

test('restart keeps an armed loop armed, marks its run resumable and does not reset the allowance', async t => {
  const f = fixture(t);
  f.manager.state.runs.push({ id: 'lost', jobId: f.job.id, status: 'running', chargedTokens: 40000, findings: [] });
  f.manager.state.ledger['2026-10-04'] = { tokens: 40000, runs: 1 }; f.manager.job(f.job.id).enabled = true; f.manager.persist();
  f.manager.dispose();
  const recovered = new InvestigationManager({ storageDir: path.dirname(f.manager.dir), projects: f.manager.projects, now: f.manager.now });
  assert.equal(recovered.snapshot().runs[0].status, 'interrupted'); assert.equal(recovered.job(f.job.id).enabled, true);
  assert.equal(recovered.job(f.job.id).resumeRunId, 'lost'); assert.match(recovered.job(f.job.id).reason, /Resuming/);
  assert.equal(recovered.snapshot().ledger['2026-10-04'].tokens, 40000); recovered.dispose();
  // A loop the user had already paused stays paused after a restart.
  const paused = new InvestigationManager({ storageDir: path.dirname(f.manager.dir), projects: f.manager.projects, now: f.manager.now });
  paused.state.runs.push({ id: 'lost2', jobId: f.job.id, status: 'running', chargedTokens: 0, findings: [] }); paused.job(f.job.id).enabled = false; paused.job(f.job.id).resumeRunId = undefined; paused.persist(); paused.dispose();
  const again = new InvestigationManager({ storageDir: path.dirname(f.manager.dir), projects: f.manager.projects, now: f.manager.now });
  assert.equal(again.job(f.job.id).enabled, false); assert.equal(again.job(f.job.id).resumeRunId, undefined); again.dispose();
});

test('invalid limits and unsupported solution fields are rejected', () => {
  assert.throws(() => validateLimits({ reservePercent: 0 })); assert.throws(() => validateLimits({ maxRuns: Infinity }));
  assert.throws(() => validateReport({ summary: '', findings: [], questions: [], fixes: [] }, new Map()), /unsupported/);
  const finding = { title: 'bug', severity: 'high', status: 'suspected', evidence: [{ file: '../secret', line: 1, detail: 'x' }], expected: '', observed: '', suspectedCause: '', reproduction: '', uncertainty: '' };
  assert.throws(() => validateReport({ summary: '', findings: [finding], questions: [] }, new Map()), /supplied source/);
});

test('token accounting includes reported cache and thinking, and missing usage stays unknown', () => {
  assert.equal(usageTotal(null), null); assert.equal(usageTotal({ input_tokens: 100 }), null);
  assert.equal(usageTotal({ total_tokens: 900, input_tokens: 800, output_tokens: 100 }), 900);
  assert.equal(usageTotal({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, thinking_tokens: 80 }), 700);
  assert.equal(usageTotal({ input_tokens: -1, output_tokens: 20 }), null);
});

test('foreground activity and expired jobs never dispatch, and ownership prevents duplicate managers', async t => {
  const f = fixture(t, { isForegroundBusy: () => true });
  assert.throws(() => new InvestigationManager({ storageDir: path.dirname(f.manager.dir) }), /Another investigation manager/);
  f.manager.start(f.job.id); await settle(f.manager); assert.equal(f.calls(), 0);
  f.manager.isForegroundBusy = () => false; f.advance(8 * 3600000 + 1); await f.manager.tick();
  assert.equal(f.manager.job(f.job.id).enabled, false); assert.equal(f.manager.job(f.job.id).reason, 'Expired'); assert.equal(f.calls(), 0);
});

test('a source snapshot includes dirty source, excludes secrets and keeps the product unchanged', async t => {
  const f = fixture(t); execFileSync('git', ['init', '-q'], { cwd: f.root, windowsHide: true });
  fs.mkdirSync(path.join(f.root, 'ai-chat-panel', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(f.root, 'ai-chat-panel', 'test'), { recursive: true }); fs.writeFileSync(path.join(f.root, 'ai-chat-panel', 'test', 'check.js'), '');
  fs.writeFileSync(path.join(f.root, 'package.json'), '{}');
  const file = path.join(f.root, 'ai-chat-panel', 'lib', 'scheduler-queue.js'); fs.writeFileSync(file, 'const broken = true;\n');
  fs.writeFileSync(path.join(f.root, '.env'), 'SECRET=do-not-copy');
  const directory = path.join(f.dir, 'run'); let prompts = 0;
  const result = await investigate({ job: f.manager.job(f.job.id), run: { topic: 'project binding and scheduling' }, directory, signal: new AbortController().signal }, {
    execute: async () => ({ code: 0, output: 'passed', stderr: '' }),
    flash: async ({ prompt, cwd }) => {
      prompts++; assert.match(prompt, /broken = true/); assert.doesNotMatch(prompt, /do-not-copy/);
      assert.equal(fs.existsSync(path.join(cwd, '.env')), false);
      return { tokens: 700, report: { summary: 'No verified issue.', findings: [], questions: [] } };
    }
  });
  assert.equal(prompts, 1); assert.equal(result.tokens, 700); assert.equal(fs.readFileSync(file, 'utf8'), 'const broken = true;\n');
  assert.ok(fs.existsSync(path.join(directory, 'report.json')));
});

test('process cancellation terminates an actual local child without invoking any AI CLI', async () => {
  const controller = new AbortController();
  const running = processOutput(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(new Error('test stop')), 100);
  await assert.rejects(running, /test stop/);
});

test('CLI option detection reads the usage text the Go CLI prints on stderr', () => {
  const { cliHelp } = require('../lib/investigation-runner');
  const help = cliHelp(process.execPath, ['-e', 'console.error("Usage: --json-schema")']);
  assert.match(help, /--json-schema/);
});

test('a foreground yield retries later without disabling the job, and stops after three in a row', async t => {
  let busy = true;
  const f = fixture(t, { isForegroundBusy: () => busy, pollMs: 1e9,
    runner: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  f.manager.start(f.job.id);
  for (let n = 1; n <= 3; n++) {
    busy = false; f.advance(61000); const pending = f.manager.tick(); await new Promise(resolve => setTimeout(resolve, 5));
    busy = true; f.manager.active.controller.abort(new Error('Yielded to foreground work')); await pending;
    const job = f.manager.job(f.job.id);
    assert.equal(job.enabled, true, `yield ${n} keeps the job armed`); assert.equal(job.completedRuns, 0);
    assert.equal(f.manager.snapshot().ledger['2026-10-04'].runs, 0);
    assert.equal(job.nextRunAt - f.manager.state.runs.at(-1).finishedAt, 60000, `yield ${n} retries after exactly one minute`);
    if (n < 3) assert.match(job.reason, /retrying/);
    else assert.equal(job.yields, 3);
  }
  busy = false; f.advance(61000); const last = f.manager.tick(); await new Promise(resolve => setTimeout(resolve, 5));
  busy = true; f.manager.active.controller.abort(new Error('Yielded to foreground work')); await last;
  assert.equal(f.manager.job(f.job.id).enabled, false); assert.match(f.manager.job(f.job.id).reason, /Yielded/);
});

test('jobs run in parallel up to the cap, each holding its own reservation', async t => {
  let running = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { maxParallel: () => 2, pollMs: 1e9,
    runner: async () => { peak = Math.max(peak, ++running); await gate; running--; return { tokens: 1000, findings: [], fingerprint: 'same' }; } });
  const second = f.manager.create({ projectId: 'p' }), third = f.manager.create({ projectId: 'p' });
  for (const id of [f.job.id, second.id, third.id]) f.manager.job(id).enabled = true;
  const tick = f.manager.tick();
  for (let n = 0; f.manager.actives.size < 2 && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.manager.actives.size, 2);
  const snapshot = f.manager.snapshot();
  assert.equal(snapshot.activeRunIds.length, 2); assert.equal(snapshot.ledger['2026-10-04'].tokens, 500000);
  assert.equal(f.manager.job(third.id).completedRuns, 0, 'the third job waits for a free slot');
  release(); await tick;
  assert.equal(peak, 2); assert.equal(f.manager.snapshot().ledger['2026-10-04'].tokens, 2000);
});

test('a sleep during a run is retried without penalty and refunds a run that never reached the model', async t => {
  const f = fixture(t, { pollMs: 1e9, runner: async ({ onProgress }) => { onProgress('tests'); f.advance(2 * 3600000); throw new Error('Process time limit reached'); } });
  f.manager.start(f.job.id); await settle(f.manager);
  const job = f.manager.job(f.job.id), run = f.manager.snapshot().runs[0];
  assert.equal(run.status, 'interrupted'); assert.match(run.reason, /slept/);
  assert.equal(job.enabled, true); assert.equal(job.completedRuns, 0); assert.match(job.reason, /retrying/);
  assert.deepEqual(f.manager.snapshot().ledger['2026-10-04'], { tokens: 0, runs: 0 });
});

test('a check that dies before the model is reached gives its token reservation back', async t => {
  const f = fixture(t, { runner: async ({ onProgress }) => { onProgress('tests'); throw new Error('Process time limit reached'); } });
  f.manager.start(f.job.id); await settle(f.manager);
  const run = f.manager.snapshot().runs[0];
  assert.equal(run.status, 'failed'); assert.equal(run.chargedTokens, 0); assert.equal(f.manager.job(f.job.id).enabled, false);
  assert.deepEqual(f.manager.snapshot().ledger['2026-10-04'], { tokens: 0, runs: 1 });
});

test('the system is held awake while a task is armed and released when nothing is', async t => {
  let held = 0, released = 0;
  const f = fixture(t, { pollMs: 1e9, keepAwake: () => { held++; return { release() { released++; } }; } });
  assert.equal(held, 0); f.manager.start(f.job.id); await settle(f.manager);
  assert.equal(held, 1); assert.equal(f.manager.snapshot().keepingAwake, true);
  f.manager.stopAll(); assert.equal(released, 1); assert.equal(f.manager.snapshot().keepingAwake, false);
});

test('extractJson tolerates fences and trailing text but rejects missing objects', () => {
  assert.deepEqual(extractJson('```json\n{"a":"}{","b":[1]}\n```\nDone.'), { a: '}{', b: [1] });
  assert.deepEqual(extractJson('{"a":1}\n{"a":2}'), { a: 1 });
  assert.throws(() => extractJson('no json here'), /no JSON/);
  assert.throws(() => extractJson('{"a":'), /incomplete/);
});

test('saved loops that still carry the removed daily limits load without them', () => {
  const limits = validateLimits({ dailyTokens: 1000000, dailyRuns: 4, maxRuns: 3 });
  assert.equal(limits.maxRuns, 3); assert.equal('dailyTokens' in limits, false); assert.equal('dailyRuns' in limits, false);
});

test('back-to-back loops start the next run at once and Run now skips a long wait', async t => {
  const f = fixture(t); assert.equal(f.job.limits.intervalMinutes, 0);
  f.manager.start(f.job.id); await settle(f.manager);
  assert.equal(f.manager.job(f.job.id).nextRunAt, f.manager.now());
  f.manager.pause(f.job.id);
  const slow = f.manager.create({ projectId: 'p', limits: { intervalMinutes: 60 } });
  f.manager.start(slow.id); await settle(f.manager);
  assert.ok(f.manager.job(slow.id).nextRunAt > f.manager.now()); const before = f.calls();
  f.manager.runNow(slow.id); await settle(f.manager);
  assert.equal(f.calls(), before + 1);
});

test('Run now overrules foreground priority, for the admission and for the run itself, and only for that run', async t => {
  let busy = true;
  const f = fixture(t, { isForegroundBusy: () => busy, runner: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { tokens: 1000, findings: [] }; } });
  f.manager.start(f.job.id); await settle(f.manager);
  assert.equal(f.calls(), 0); assert.match(f.manager.job(f.job.id).reason, /Foreground work has priority/);
  f.manager.runNow(f.job.id); await settle(f.manager);
  assert.equal(f.manager.snapshot().runs[0].status, 'completed', 'the run was not yielded while chats were busy');
  assert.equal(f.manager.job(f.job.id).forced, undefined, 'the override ends with the run');
  f.advance(1); await f.manager.tick(); await settle(f.manager);
  assert.equal(f.manager.snapshot().runs.length, 1, 'the next scheduled run waits for the foreground again');
});

test('the sidebar timer start is persisted and explicit resume starts a fresh elapsed period', async t => {
  const f = fixture(t);
  f.manager.start(f.job.id); await settle(f.manager);
  assert.equal(f.manager.job(f.job.id).startedAt, f.manager.now());
  assert.equal(JSON.parse(fs.readFileSync(f.manager.file)).jobs[0].startedAt, f.manager.now());
  f.manager.pause(f.job.id); f.advance(60000);
  f.manager.start(f.job.id); await settle(f.manager);
  assert.equal(f.manager.job(f.job.id).startedAt, f.manager.now());
});

test('unchanged source pauses without consuming a slot, repeated reports, or keeping the system awake', async t => {
  let calls = 0, released = 0;
  const f = fixture(t, { keepAwake: () => ({ release() { released++; } }), runner: async () => {
    calls++; return { skipped: true, reason: 'No new source since the last interface test' };
  } });
  f.manager.start(f.job.id); await settle(f.manager);
  const job = f.manager.job(f.job.id);
  assert.equal(job.enabled, false); assert.equal(job.completedRuns, 0);
  assert.match(job.reason, /No new source.*paused/);
  assert.equal(f.manager.snapshot().runs.length, 0, 'a skipped run leaves no report behind');
  assert.equal(JSON.parse(fs.readFileSync(f.manager.file)).runs.length, 0);
  assert.equal(f.manager.snapshot().keepingAwake, false); assert.equal(released, 1);
  assert.deepEqual(f.manager.snapshot().ledger['2026-10-04'], { tokens: 0, runs: 0 });
  f.advance(60000); await f.manager.tick(); assert.equal(calls, 1);
  f.manager.start(job.id); await settle(f.manager); assert.equal(calls, 2, 'explicit restart can check changed source');
});

test('findings remain visible in each report even when a previous loop found them', async t => {
  const finding = { title: 'Missing asset', evidence: [{ file: 'ui:chat', line: 1, detail: '404' }] };
  const f = fixture(t, { runner: async () => ({ tokens: 1000, findings: [finding, finding] }) });
  f.manager.start(f.job.id); await settle(f.manager); f.manager.pause(f.job.id);
  const second = f.manager.create({ projectId: 'p' });
  f.manager.start(second.id); await settle(f.manager);
  assert.deepEqual(f.manager.snapshot().runs.map(run => run.findings.length), [1, 1]);
});

test('a completed over-budget review retains its findings, charges actual usage and pauses', async t => {
  const f = fixture(t, { runner: async () => ({ tokens: 171507, findings: [{ title: 'Issue', evidence: [] }] }) });
  const job = f.manager.create({ projectId: 'p', recipe: 'tester' });
  f.manager.start(job.id); await settle(f.manager);
  assert.equal(f.manager.snapshot().runs[0].findings.length, 1);
  assert.equal(f.manager.snapshot().ledger['2026-10-04'].tokens, 171507);
  assert.equal(f.manager.job(job.id).enabled, false); assert.match(f.manager.job(job.id).reason, /exceeded/);
});

test('failed model telemetry above the reservation is charged rather than lost', async t => {
  const f = fixture(t, { runner: async () => { throw Object.assign(new Error('Measured token allowance reached.'), { tokenUsage: 270000 }); } });
  f.manager.start(f.job.id); await settle(f.manager);
  assert.equal(f.manager.snapshot().runs[0].chargedTokens, 270000);
  assert.equal(f.manager.snapshot().ledger['2026-10-04'].tokens, 270000);
});

test('old interface reports recover findings and final token usage once under the storage lock', t => {
  const f = fixture(t); const job = f.manager.create({ projectId: 'p', recipe: 'tester' });
  const dir = path.join(f.manager.dir, 'old-run'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ findings: [{ title: 'Missing asset', evidence: [] }] }));
  fs.writeFileSync(path.join(dir, 'flash.jsonl'), 'incomplete line\n' + JSON.stringify({ event: 'result', result: { usage: { total_tokens: 171507 } } }));
  f.manager.state.runs.push({ id: 'old-run', jobId: job.id, topic: 'interface testing', status: 'completed', day: '2026-10-04', chargedTokens: 60000, tokenUsage: 60000, findings: [], questions: ['Visual review failed'] });
  f.manager.state.ledger['2026-10-04'] = { tokens: 60000, runs: 1 }; f.manager.persist(); f.manager.dispose();
  const options = { storageDir: path.dirname(f.manager.dir), projects: f.manager.projects, now: f.manager.now };
  for (let n = 0; n < 2; n++) {
    const recovered = new InvestigationManager(options);
    assert.equal(recovered.snapshot().runs[0].findings.length, 1);
    assert.equal(recovered.snapshot().runs[0].reviewIncomplete, true);
    assert.equal(recovered.snapshot().ledger['2026-10-04'].tokens, 171507);
    assert.match(recovered.job(job.id).reason, /exceeded/); recovered.dispose();
  }
});

test('Flash keeps a successful final response over budget and sums distinct step usage without double charging updates', async t => {
  const f = fixture(t);
  const options = { cwd: f.dir, prompt: 'fixture', model: 'gemini-3.8-flash-high', signal: new AbortController().signal, maxTokens: 60000, timeoutMs: 1000 };
  const help = () => '--agent --json-schema --disable-slash-commands --sandbox --mode --print-timeout';
  const answer = await runFlash(options, { binary: 'fake-cli', help, execute: async (_command, _args, { onLine }) => {
    onLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '{"summary":"ok","findings":[],"questions":[]}', usage: { total_tokens: 171507 } } }));
    return { code: 0 };
  } });
  assert.equal(answer.tokens, 171507); assert.equal(answer.report.summary, 'ok');
  await assert.rejects(runFlash(options, { binary: 'fake-cli', help, execute: async (_command, _args, { onLine }) => {
    const step = (index, total) => onLine(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c', step_index: index, step_type: 'agent_response', state: 'COMPLETE', usage: { total_tokens: total } } }));
    step(1, 20000); step(1, 30000); step(2, 31000);
    assert.fail('must stop before another request');
  } }), error => error.tokenUsage === 61000 && /allowance/.test(error.message));
});

test('Gemini scout startup does not count as a model response, and status reaches the caller through analyze', async t => {
  const f = fixture(t), states = [];
  const { analyze } = require('../lib/loop-agents');
  const result = await analyze({ target: { agent: 'gemini', model: 'gemini-3.8-flash-high' }, cwd: f.dir, prompt: 'fixture',
    signal: new AbortController().signal, maxTokens: 1000, timeoutMs: 1000, onStatus: state => states.push(state) }, {
    flash: options => runFlash(options, { binary: 'fake-cli', help: () => '--agent --json-schema --disable-slash-commands --sandbox --mode --print-timeout',
      execute: async (_command, _args, { onLine }) => {
        onLine(JSON.stringify({ event: 'init', conversation_id: 'fixture' }));
        onLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } }));
        assert.deepEqual(states, ['waiting']);
        onLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'answer' } }));
        assert.deepEqual(states, ['waiting', 'running']);
        onLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '{"summary":"ok","findings":[],"questions":[]}', usage: { total_tokens: 10 } } }));
        return { code: 0 };
      } })
  });
  assert.equal(result.tokens, 10);
});
