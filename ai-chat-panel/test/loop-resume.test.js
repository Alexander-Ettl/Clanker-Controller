'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InvestigationManager, HOST_CLOSING, OVERNIGHT_LIMITS, FULL_DEFAULTS, validateLimits } = require('../lib/investigation-manager');
const { resolveRole, describeAuto } = require('../lib/loop-roles');
const { cleanRequest } = require('../lib/investigation-bridge');
const { createPool } = require('../lib/loop-agents');
const { Semaphore } = require('../lib/loop-exec');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-loop-resume-'));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const clock = { now: Date.parse('2026-10-08T09:00:00Z') };
  const make = extra => new InvestigationManager({ storageDir: path.join(dir, 'storage'), projects: { get: () => ({ id: 'p', root }) }, now: () => clock.now, pollMs: 1e9,
    readQuota: async () => ({ remaining: 90, observedAt: clock.now }), availableModels: () => [], ...options, ...extra });
  const managers = [];
  const open = extra => { const manager = make(extra); managers.push(manager); return manager; };
  t.after(() => { for (const manager of managers) manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, clock, open };
}
const until = async (check, ms = 2000) => { for (let n = 0; !check() && n < ms / 5; n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), 'condition reached in time'); };

test('closing the IDE keeps the loop armed, and the next start resumes the same run with its reservation', async t => {
  const f = fixture(t);
  let starts = 0;
  const first = f.open({ runner: ({ signal }) => { starts++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const job = first.create({ projectId: 'p', recipe: 'full' });
  first.start(job.id); await until(() => first.active);
  const runId = first.active.run.id;
  first.dispose(); await until(() => !fs.existsSync(first.lock));
  const saved = JSON.parse(fs.readFileSync(first.file));
  assert.equal(saved.jobs[0].enabled, true, 'closing is not stopping'); assert.equal(saved.jobs[0].resumeRunId, runId);
  assert.equal(saved.runs[0].status, 'interrupted'); assert.match(saved.runs[0].reason, /resumes automatically/);
  const seen = [];
  const second = f.open({ runner: async context => { seen.push({ run: context.run.id, resumes: context.run.resumes, directory: context.directory }); return { tokens: 9000, findings: [], loop: { lens: 'full', fixed: [], unverified: [], unfixed: [], newIssues: [], additional: [] }, backlog: [], handled: [], cleanStreak: 0, done: true, finishedReason: 'Finished: nothing left to fix', shards: 1 }; } });
  second.startPolling(); await until(() => seen.length === 1);
  assert.equal(seen[0].run, runId, 'the same run continues'); assert.equal(seen[0].resumes, 1); assert.equal(seen[0].directory, path.join(second.dir, runId));
  await until(() => second.job(job.id).enabled === false);
  assert.match(second.job(job.id).reason, /Finished/);
  assert.equal(second.snapshot().runs.length, 1, 'one run, not two');
  assert.equal(second.snapshot().ledger['2026-10-08'].tokens, 9000, 'the reservation was corrected once, never charged twice');
  assert.equal(starts, 1);
});

test('a crash (no dispose) resumes the same way, and Stop all is the only thing that ends a loop for good', async t => {
  const f = fixture(t);
  const first = f.open({ runner: () => new Promise(() => {}) });
  const job = first.create({ projectId: 'p', recipe: 'full' }); first.start(job.id); await until(() => first.active);
  const runId = first.active.run.id;
  fs.unlinkSync(first.lock); // the process died without cleaning up
  const second = f.open({ runner: async () => ({ tokens: 1, findings: [] }) });
  assert.equal(second.job(job.id).enabled, true); assert.equal(second.job(job.id).resumeRunId, runId);
  second.stopAll();
  assert.equal(second.job(job.id).enabled, false); assert.equal(second.job(job.id).resumeRunId, undefined); assert.equal(second.job(job.id).reason, 'Stopped by user');
});

test('the full loop is not killed by the run time limit, a long sleep or the clock', async t => {
  const f = fixture(t);
  const manager = f.open({ runner: async () => { f.clock.now += 5 * 3600000; await new Promise(resolve => setTimeout(resolve, 20)); return { tokens: 5, findings: [], loop: { fixed: [], unverified: [], unfixed: [], newIssues: [], additional: [] }, backlog: [], handled: [], cleanStreak: 0, done: false, shards: 1 }; } });
  const job = manager.create({ projectId: 'p', recipe: 'full', limits: { maxRunMinutes: 1 } });
  manager.start(job.id); await until(() => manager.snapshot().runs[0]?.status === 'completed');
  assert.equal(manager.snapshot().runs[0].status, 'completed'); assert.equal(manager.job(job.id).expiresAt, null);
});

test('a failure in the full loop is retried from the same run, and only repeated failure stops it', async t => {
  const f = fixture(t);
  let attempts = 0, resumed = [];
  const manager = f.open({ runner: async ({ run }) => { attempts++; resumed.push(run.resumes || 0); throw new Error('Every scout failed: rate limited'); } });
  const job = manager.create({ projectId: 'p', recipe: 'full' }); manager.start(job.id);
  for (let n = 0; n < 4; n++) { await until(() => !manager.ticking); f.clock.now += 11 * 60000; await manager.tick(); }
  await until(() => !manager.ticking);
  assert.equal(attempts, 4); assert.deepEqual(resumed, [0, 1, 2, 3], 'each retry continues the same run');
  assert.equal(manager.job(job.id).enabled, false); assert.match(manager.job(job.id).reason, /Every scout failed/);
  assert.equal(manager.snapshot().runs.length, 1);
});

test('foreground work pauses between calls of the full loop but never aborts it', async t => {
  const f = fixture(t);
  let busy = true, gated = false, done, go;
  const finished = new Promise(resolve => { done = resolve; }), started = new Promise(resolve => { go = resolve; });
  const manager = f.open({ isForegroundBusy: () => busy, runner: async ({ gate, signal }) => { await started; await gate(signal); gated = true; done(); return { tokens: 1, findings: [] }; } });
  const job = manager.create({ projectId: 'p', recipe: 'full' }); manager.job(job.id).enabled = true; manager.job(job.id).forced = true; void manager.tick();
  await until(() => manager.active);
  manager.job(job.id).forced = false; go(); // the user is working: the gate waits
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(gated, false); assert.equal(manager.active.run.status, 'running', 'still running while the user chats');
  busy = false; await finished; assert.equal(gated, true);
});

test('progress inside a stage is saved shortly after, and a changed stage at once', async t => {
  const f = fixture(t);
  let release;
  const manager = f.open({ runner: async ({ onProgress }) => { onProgress('scan', { agents: [{ id: 'bugs', state: 'running' }] }); await new Promise(resolve => { release = resolve; }); return { tokens: 1, findings: [] }; } });
  const job = manager.create({ projectId: 'p', recipe: 'full' }); manager.start(job.id); await until(() => manager.active?.run.stage === 'scan');
  assert.equal(JSON.parse(fs.readFileSync(manager.file)).runs[0].stage, 'scan');
  assert.deepEqual(manager.snapshot().runs[0].live.agents, [{ id: 'bugs', state: 'running' }]);
  release(); await until(() => manager.snapshot().runs[0].status === 'completed');
  assert.equal(manager.snapshot().runs[0].live, undefined);
});

test('role choices: Automatic never gives Gemini the editor while Codex or Claude exists, but picking it works, and with nothing else it does the editing', () => {
  const models = [{ id: 'gemini-3.8-flash-high', agent: 'gemini', model: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High' }, { id: 'gemini-3.7-flash-high', agent: 'gemini', model: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash High' },
    { id: 'gpt-6', agent: 'codex', model: 'gpt-6', label: 'GPT 6' }, { id: 'claude-opus', agent: 'claude', model: 'claude-opus', label: 'Opus' }, { id: 'claude-sonnet', agent: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet' }];
  const ctx = (agents) => ({ models: models.filter(model => agents.includes(model.agent)), isEnabled: agent => agents.includes(agent), installed: agent => agents.includes(agent), defaultModel: agent => models.find(model => model.agent === agent && model.id !== 'claude-sonnet') || null });
  const all = ctx(['gemini', 'codex', 'claude']);
  assert.equal(resolveRole('scout', all).target.model, 'gemini-3.8-flash-high', 'newest Flash scouts');
  assert.equal(resolveRole('editor', all).target.model, 'claude-sonnet-5-5', 'Claude Sonnet edits first'); assert.equal(resolveRole('visualEditor', all).target.agent, 'claude', 'visual work goes to Claude first');
  assert.equal(resolveRole('editor', all, { escalate: true }).target.model, 'claude-opus', 'a second attempt escalates to Opus');
  assert.equal(resolveRole('editor', { ...all, legacy: { backendAgent: 'codex' } }).target.agent, 'codex', 'Codex first when chosen in Settings');
  assert.equal(resolveRole('visualEditor', { ...all, legacy: { visualAgent: 'codex' } }).target.agent, 'codex');
  assert.equal(resolveRole('editor', all, { value: 'gemini-3.7-flash-high' }).target.model, 'gemini-3.7-flash-high', 'picked on purpose');
  assert.equal(resolveRole('editor', all, { value: 'gemini' }).target.agent, 'gemini');
  const only = ctx(['gemini']);
  assert.equal(resolveRole('editor', only).target.agent, 'gemini', 'nothing else installed'); assert.equal(resolveRole('vision', only).target.agent, 'gemini');
  const claudeOnly = ctx(['claude']);
  assert.equal(resolveRole('scout', claudeOnly).target.model, 'claude-sonnet-5-5', 'a mid-sized Claude reads when there is no Gemini');
  assert.equal(resolveRole('vision', claudeOnly).target, null); assert.equal(resolveRole('editor', ctx([])).target, null);
  assert.equal(resolveRole('vision', all, { value: 'gpt-6' }).target, null, 'only Antigravity can look at pictures');
  assert.match(resolveRole('editor', all, { value: 'nonsense' }).skipped[0].reason, /not available/);
  assert.match(describeAuto('editor', all), /Claude/); assert.equal(describeAuto('editor', ctx([])), 'Nothing available');
  const quotas = { codex: { remaining: 10 }, claude: { remaining: 80 } };
  assert.equal(resolveRole('editor', { ...all, legacy: { backendAgent: 'codex' } }, { quotas, reservePercent: 50 }).target.agent, 'claude', 'a short agent is skipped');
  assert.equal(resolveRole('editor', all, { value: 'codex', quotas, reservePercent: 50 }).target, null, 'a pinned agent that is short waits');
});

test('scouts: Hydrogen High when Antigravity has it, never Argon, Carbon or an Orchestrator on Automatic', () => {
  const entry = (model, agent = 'gemini') => ({ id: model, agent, model, label: model });
  const models = ['gemini-3.8-flash-high', 'gemini-4-argon-high', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium', 'gemini-pro-orchestrator-g1-pro'].map(model => entry(model));
  const ctx = { models, isEnabled: () => true, installed: () => true, defaultModel: agent => agent === 'gemini' ? models.find(model => /argon/.test(model.model)) : null };
  assert.equal(resolveRole('scout', ctx).target.model, 'gemini-4-hydrogen-high', 'High beats xhigh (3 index points for 1.7x the cost)');
  assert.equal(resolveRole('scout', { ...ctx, models: models.filter(model => !/hydrogen/.test(model.model)) }).target.model, 'gemini-3.8-flash-high', 'Flash without Hydrogen');
  const argonOnly = { ...ctx, models: models.filter(model => /argon|orchestrator/.test(model.model)) };
  assert.equal(resolveRole('scout', argonOnly).target, null, 'Argon is not a fallback scout: its weekly pool is small');
  assert.equal(resolveRole('scout', argonOnly, { value: 'gemini-4-argon-high' }).target.model, 'gemini-4-argon-high', 'but a deliberate pick is honoured');
  assert.equal(resolveRole('scout', ctx, { value: 'gemini' }).target.model, 'gemini-4-hydrogen-high', 'the "gemini" shortcut also means Hydrogen');
  assert.equal(resolveRole('vision', ctx).target.model, 'gemini-3.8-flash-high', 'screenshots stay on the model that is proven to open images');
  assert.match(describeAuto('scout', ctx), /hydrogen/i);
});

test('an editor that is short on quota reports when it resets, so the loop can wait instead of rescanning', () => {
  const models = [{ id: 'claude-sonnet-5-5', agent: 'claude', model: 'claude-sonnet-5-5' }, { id: 'gpt-6', agent: 'codex', model: 'gpt-6' }];
  const ctx = { models, isEnabled: () => true, installed: () => true, defaultModel: agent => models.find(model => model.agent === agent) };
  const quotas = { claude: { remaining: 5, resetsAt: 2000, secondary: { remaining: 3, resetsAt: 9000 } }, codex: { remaining: 4, resetsAt: 1500 } };
  const pick = resolveRole('editor', ctx, { quotas, reservePercent: 15 });
  assert.equal(pick.target, null);
  assert.deepEqual(pick.skipped.map(item => [item.agent, item.quota, item.retryAt]), [['claude', true, 9000000], ['codex', true, 1500000]], 'the latest short window decides when an agent is back');
  assert.equal(resolveRole('editor', ctx, { quotas: { ...quotas, codex: { remaining: 60 } }, reservePercent: 15 }).target.agent, 'codex');
});

test('create validates mode, roles and options; roles of "auto" are not stored', () => {
  assert.deepEqual(cleanRequest({ action: 'create', projectId: 'p', recipe: 'full', mode: 'find', roles: { scout: 'auto', editor: 'gemini' }, options: { visual: 'off', agents: 10 } }),
    { action: 'create', projectId: 'p', recipe: 'full', mode: 'find', roles: { scout: 'auto', editor: 'gemini' }, options: { visual: 'off', agents: 10 } });
  assert.throws(() => cleanRequest({ action: 'create', projectId: 'p', roles: { admin: 'x' } }), /Unknown model role/);
  assert.throws(() => cleanRequest({ action: 'create', projectId: 'p', options: { shell: 'rm' } }), /Unknown loop option/);
  assert.deepEqual(cleanRequest({ action: 'setRoles', roles: { vision: 'auto' }, extra: 1 }), { action: 'setRoles', roles: { vision: 'auto' } });
  assert.deepEqual(cleanRequest({ action: 'apply', runId: 'abc' }), { action: 'apply', runId: 'abc' });
});

test('the pool runs at most its limit at once, shares slots across pools, and backs off after a rate limit', async () => {
  let running = 0, peak = 0;
  const slots = new Semaphore(3);
  const pool = createPool({ limit: 8, slots, backoffMs: 1 });
  await Promise.all(Array.from({ length: 12 }, () => pool.run(async () => { peak = Math.max(peak, ++running); await new Promise(resolve => setTimeout(resolve, 5)); running--; })));
  assert.equal(peak, 3, 'the shared slots cap every pool');
  let tries = 0;
  const limited = createPool({ limit: 8, backoffMs: 1 });
  const value = await limited.run(async () => { if (++tries < 2) throw new Error('429 rate limit exceeded'); return 'ok'; });
  assert.equal(value, 'ok'); assert.equal(tries, 2); assert.equal(limited.throttled, true);
  await assert.rejects(limited.run(async () => { throw new Error('Measured token allowance reached.'); }), /allowance/);
  await assert.rejects(limited.run(async () => { throw new Error('syntax error in my code'); }), /syntax error/);
});

test('a cycle blocked on editor quota is not a run: nothing is charged, the loop stays armed and wakes at the reset', async t => {
  const f = fixture(t);
  const resetsAt = f.clock.now + 90 * 60000;
  let calls = 0, floors = [];
  const manager = f.open({ readQuota: async () => ({ remaining: 90, observedAt: f.clock.now }),
    runner: async context => { calls++; floors.push(typeof context.quotaLow, context.quotaLow()); return calls === 1 ? { skipped: true, waiting: true, reason: 'Claude is short on quota for fixes; nothing was scanned', retryAt: resetsAt } : { tokens: 10, findings: [], done: true, finishedReason: 'Finished: nothing left to fix', shards: 1 }; } });
  const job = manager.create({ projectId: 'p', recipe: 'full', limits: OVERNIGHT_LIMITS }); manager.start(job.id); // start() already ticks
  await until(() => calls === 1 && manager.job(job.id).nextRunAt === resetsAt);
  assert.equal(manager.job(job.id).enabled, true, 'still armed'); assert.equal(manager.job(job.id).completedRuns, 0); assert.equal(manager.job(job.id).nextRunAt, resetsAt);
  assert.match(manager.job(job.id).reason, /short on quota.*waiting until/); assert.equal(manager.snapshot().runs.length, 0); assert.equal(manager.snapshot().ledger['2026-10-08'].tokens, 0);
  await manager.tick(); assert.equal(calls, 1, 'not before the reset');
  f.clock.now = resetsAt + 1; await manager.tick(); await until(() => manager.job(job.id).enabled === false);
  assert.equal(calls, 2); assert.match(manager.job(job.id).reason, /Finished/); assert.equal(manager.job(job.id).waitingSince, undefined);
  assert.deepEqual(floors.filter(item => typeof item !== 'boolean'), ['function', 'function'], 'the runner is told when the Gemini pool is low');
});

test('the Gemini pool is watched while a full loop runs, and the overnight limits are valid', async t => {
  assert.doesNotThrow(() => validateLimits({ ...FULL_DEFAULTS, ...OVERNIGHT_LIMITS }));
  assert.equal(OVERNIGHT_LIMITS.maxRuns, 12); assert.ok(OVERNIGHT_LIMITS.editorReservePercent < OVERNIGHT_LIMITS.reservePercent, 'editors may run lower than the scouts’ pool');
  assert.deepEqual(cleanRequest({ action: 'create', projectId: 'p', recipe: 'full', limits: { editorReservePercent: 15 } }).limits, { editorReservePercent: 15 });
  const f = fixture(t);
  let reads = 0, low;
  const manager = f.open({ readQuota: async () => ({ remaining: ++reads > 1 ? 8 : 90, observedAt: f.clock.now }),
    runner: async context => { await new Promise(resolve => setTimeout(resolve, 40)); low = context.quotaLow(); return { tokens: 1, findings: [], shards: 1 }; } });
  const job = manager.create({ projectId: 'p', recipe: 'full', limits: OVERNIGHT_LIMITS }); manager.start(job.id);
  await until(() => low !== undefined);
  assert.equal(low, true, 'below half the reserve (12%) the engine is told to stop starting calls');
});
