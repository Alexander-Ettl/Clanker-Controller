'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { InvestigationManager, FIX_DEFAULTS, removeTree } = require('../lib/investigation-manager');
const { investigate } = require('../lib/investigation-runner');
const { pickFixer } = require('../lib/investigation-commands');

const BACKEND = 'ai-chat-panel/lib/scheduler-queue.js', VISUAL = 'ai-chat-panel/media/style.css', ANCHOR = 'ai-chat-panel/extension.js';
const finding = (title, area, extra = {}) => ({ title, severity: 'high', status: 'observed', kind: 'bug', area, fixPrompt: `Fix: ${title}`,
  evidence: [{ file: ANCHOR, line: 1, detail: 'seen here' }], expected: 'works', observed: 'broken', suspectedCause: 'n/a', reproduction: 'n/a', uncertainty: 'none', ...extra });

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-fixloop-test-'));
  t.after(() => { try { removeTree(path.join(dir, 'storage', 'investigations', 'workspaces', 'x')); } catch { /* may not exist */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const root = path.join(dir, 'project');
  for (const [file, body] of [[BACKEND, 'const queue = bad();\n'], [VISUAL, '.pill { color: red; }\n'], [ANCHOR, '// entry\n'], ['ai-chat-panel/test/check.js', ''], ['package.json', '{}']]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), body);
  }
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  return { dir, root, directory: path.join(dir, 'storage', 'investigations', 'run-1') };
}
const jobFor = (root, extra = {}) => ({ id: 'x', root, model: 'gemini-3.8-flash-high', recipe: 'fixloop', backlog: [], handled: [], fingerprints: {},
  limits: { ...FIX_DEFAULTS }, ...extra });
const route = async ({ area }) => area === 'visual' ? { agent: 'claude', model: 'claude-x' } : { agent: 'codex', model: 'codex-x' };
const passing = async () => ({ code: 0, output: 'ok', stderr: '' });
const cycle = (context, deps) => investigate({ run: { topic: 'bugs: project binding and scheduling' }, signal: new AbortController().signal, resolveFixer: route, ...context }, deps);

test('a cycle finds, routes each prompt, fixes in a copy, verifies from the diff and reports every category', async t => {
  const p = project(t); const job = jobFor(p.root); const prompts = []; const fixes = [];
  const result = await cycle({ job, directory: p.directory }, {
    execute: passing,
    flash: async ({ prompt, maxTokens }) => {
      prompts.push({ prompt, maxTokens });
      if (prompts.length === 1) return { tokens: 100000, report: { summary: 'Two bugs.', questions: [], findings: [finding('Queue drops turns', 'backend'), finding('Pill is the wrong colour', 'visual'), finding('Third bug', 'backend', { severity: 'low' }),
        finding('Fourth bug', 'backend', { severity: 'low' })] } };
      return { tokens: 50000, report: { summary: 'Both fixes hold.', verdicts: [{ id: 'F1', verdict: 'fixed', reason: 'diff addresses it' }, { id: 'F2', verdict: 'unfixed', reason: 'colour still red' }],
        newIssues: [finding('Fix left a stale comment', 'backend', { severity: 'low' })] } };
    },
    fixer: async ({ agent, cwd, prompt }) => {
      fixes.push({ agent, prompt });
      const file = agent === 'claude' ? VISUAL : BACKEND;
      fs.writeFileSync(path.join(cwd, file), `// edited by ${agent} #${fixes.length}\n`);
      return { reply: 'fixed: changed it', tokens: 1234 };
    },
  });
  assert.equal(fixes.length, 3, 'only the first fixesPerCycle findings are attempted'); // F1 high backend, F2 high visual, F3 low backend
  const claude = fixes.find(fix => fix.agent === 'claude'); assert.match(claude.prompt, /Pill is the wrong colour/); assert.match(claude.prompt, /Fix: Pill is the wrong colour/);
  assert.equal(fixes.filter(fix => fix.agent === 'codex').length, 2);
  assert.equal(prompts.length, 2); assert.equal(prompts[1].maxTokens, job.limits.maxTokensPerRun - 100000);
  assert.match(prompts[1].prompt, /edited by codex/); assert.match(prompts[1].prompt, /Fixer \(claude\) said: fixed: changed it/);
  assert.equal(result.tokens, 150000);
  assert.equal(fs.readFileSync(path.join(p.root, BACKEND), 'utf8'), 'const queue = bad();\n', 'the real checkout is never touched');
  const names = list => list.map(item => item.title);
  assert.deepEqual(names(result.loop.fixed), ['Queue drops turns']);
  assert.deepEqual(names(result.loop.unfixed), ['Pill is the wrong colour']);
  assert.deepEqual(names(result.loop.unverified), ['Third bug'], 'applied but not covered by a verdict');
  assert.deepEqual(names(result.loop.newIssues), ['Fix left a stale comment']);
  assert.deepEqual(names(result.loop.additional), ['Fourth bug']);
  assert.deepEqual(names(result.backlog).sort(), ['Fix left a stale comment', 'Fourth bug', 'Pill is the wrong colour']);
  assert.equal(result.backlog.find(item => item.title === 'Pill is the wrong colour').attempts, 1);
  assert.equal(result.done, false); assert.equal(result.cleanStreak, 0);
  const patch = path.join(p.directory, 'changes.patch');
  assert.ok(result.artifacts.includes(patch));
  execFileSync('git', ['apply', '--check', patch], { cwd: p.root, windowsHide: true }); // the user can apply it to the real checkout
});

test('a change that breaks the syntax check is reverted, retried once, then given up on', async t => {
  const p = project(t); let job = jobFor(p.root, { limits: { ...FIX_DEFAULTS, fixesPerCycle: 1 } }); let broken = false;
  const deps = { execute: async (command, args) => ({ code: broken && /check\.js$/.test(args[0]) ? 1 : 0, output: 'out', stderr: '' }),
    flash: async () => ({ tokens: 10000, report: { summary: 's', questions: [], findings: job.backlog.length ? [] : [finding('Bad queue', 'backend')] } }),
    fixer: async ({ cwd }) => { fs.writeFileSync(path.join(cwd, BACKEND), 'syntax error {{{\n'); broken = true; return { reply: 'fixed', tokens: null }; } };
  const first = await cycle({ job, directory: p.directory }, deps);
  assert.equal(first.loop.unfixed.length, 1); assert.equal(first.loop.unfixed[0].gaveUp, false); assert.match(first.loop.unfixed[0].reason, /reverted/);
  assert.equal(fs.readFileSync(path.join(p.root, '..', 'storage', 'investigations', 'workspaces', 'x', 'snapshot', BACKEND), 'utf8'), 'const queue = bad();\n');
  assert.equal(first.backlog.length, 1);
  job = { ...job, backlog: first.backlog }; broken = false;
  const second = await cycle({ job, directory: path.join(p.dir, 'run-2') }, deps);
  assert.equal(second.loop.unfixed[0].gaveUp, true); assert.equal(second.backlog.length, 0, 'two failed attempts drop it from the backlog');
  assert.match(second.loop.unfixed[0].title, /Bad queue/);
});

test('without fixer, usage or budget the cycle reports instead of spending', async t => {
  const p = project(t);
  const unrouted = await cycle({ job: jobFor(p.root), directory: p.directory, resolveFixer: async () => null }, { execute: passing,
    flash: async () => ({ tokens: 5000, report: { summary: 's', questions: [], findings: [finding('A bug', 'backend')] } }), fixer: async () => assert.fail('no fixer may run') });
  assert.equal(unrouted.loop.unfixed.length, 1); assert.match(unrouted.loop.unfixed[0].reason, /No fixer/); assert.equal(unrouted.backlog[0].attempts, undefined, 'a skipped finding is not an attempt');
  const unknown = await cycle({ job: jobFor(p.root), directory: path.join(p.dir, 'run-2') }, { execute: passing,
    flash: async () => ({ tokens: null, report: { summary: 's', questions: [], findings: [finding('A bug', 'backend')] } }), fixer: async () => assert.fail('unknown usage must not spend more') });
  assert.equal(unknown.tokens, null); assert.equal(unknown.loop.additional.length, 1);
});

test('four clean lenses in a row end the loop; one finding resets the count', async t => {
  const p = project(t); let findings = [];
  const deps = { execute: passing, flash: async () => ({ tokens: 1000, report: { summary: 's', questions: [], findings } }), fixer: async () => ({ reply: 'not fixed', tokens: null }) };
  const clean = await cycle({ job: jobFor(p.root, { cleanStreak: 3 }), directory: p.directory }, deps);
  assert.equal(clean.cleanStreak, 4); assert.equal(clean.done, true);
  findings = [finding('Late bug', 'backend')];
  const dirty = await cycle({ job: jobFor(p.root, { cleanStreak: 3 }), directory: path.join(p.dir, 'run-2') }, deps);
  assert.equal(dirty.cleanStreak, 0); assert.equal(dirty.done, false);
});

test('Flash may not invent evidence in a finding or a verification', async t => {
  const p = project(t);
  await assert.rejects(cycle({ job: jobFor(p.root), directory: p.directory }, { execute: passing,
    flash: async () => ({ tokens: 1, report: { summary: 's', questions: [], findings: [finding('Ghost', 'backend', { evidence: [{ file: 'nowhere.js', line: 1, detail: 'x' }] })] } }) }), /supplied source file/);
  await assert.rejects(cycle({ job: jobFor(p.root), directory: path.join(p.dir, 'run-2') }, { execute: passing,
    flash: async () => ({ tokens: 1, report: { summary: 's', questions: [], findings: [finding('Real', 'backend', { fixPrompt: 'x' }), { ...finding('Extra field', 'backend'), patch: 'diff' }] } }) }), /unsupported fields/);
});

test('fixers are picked by area, fall back to the other agent, and never spend unmeasured or scarce quota', () => {
  const ok = { remaining: 90, secondary: { remaining: 80 } };
  const base = { isEnabled: () => true, modelFor: agent => ({ model: `${agent}-m`, label: agent }), quotas: { claude: ok, codex: ok } };
  assert.equal(pickFixer({ area: 'visual' }, { reservePercent: 50 }, base).agent, 'claude');
  assert.equal(pickFixer({ area: 'backend' }, { reservePercent: 50 }, base).agent, 'codex');
  assert.equal(pickFixer({ area: 'backend' }, { reservePercent: 50 }, { ...base, quotas: { claude: ok, codex: { remaining: 20 } } }).agent, 'claude');
  assert.equal(pickFixer({ area: 'backend' }, { reservePercent: 50 }, { ...base, quotas: { claude: ok, codex: { remaining: 90, secondary: { remaining: 10 } } } }).agent, 'claude');
  assert.equal(pickFixer({ area: 'visual' }, { reservePercent: 50 }, { ...base, isEnabled: agent => agent === 'codex' }).agent, 'codex');
  assert.equal(pickFixer({ area: 'visual' }, { reservePercent: 50 }, { ...base, quotas: {} }), null, 'an unreadable quota is not safe to spend');
  assert.equal(pickFixer({ area: 'backend' }, { reservePercent: 50 }, { ...base, backendAgent: 'claude', visualAgent: 'codex' }).agent, 'claude');
});

function manager(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-fixloop-manager-'));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  let now = Date.parse('2026-10-04T20:00:00Z');
  const instance = new InvestigationManager({ storageDir: path.join(dir, 'storage'), projects: { get: () => ({ id: 'p', root }) }, now: () => now, pollMs: 1e9,
    availableModels: () => ['gemini-3.8-flash-high'], readQuota: async () => ({ remaining: 90, observedAt: now, secondary: { remaining: 80 } }),
    runner: async () => ({ tokens: 1000, findings: [], fingerprint: 'f' }), ...options });
  t.after(() => { instance.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { instance, dir, advance: ms => { now += ms; } };
}
const settle = async m => { for (let n = 0; m.ticking && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 2)); };

test('a fix-loop task gets its own defaults, cycles through the four lenses, and finishes when the runner says nothing is left', async t => {
  const topics = [];
  const { instance, advance } = manager(t, { runner: async ({ run, job }) => { topics.push(run.topic); return { tokens: 1000, findings: [], fingerprint: run.topic, loop: { fixed: [] }, backlog: [], handled: [], cleanStreak: topics.length, done: topics.length === 5, summary: 's' }; } });
  const job = instance.create({ projectId: 'p', recipe: 'fixloop' });
  assert.equal(job.recipe, 'fixloop'); assert.equal(job.limits.maxRunMinutes, 45); assert.equal(job.limits.fixesPerCycle, 3);
  assert.throws(() => instance.create({ projectId: 'p', recipe: 'free-for-all' }), /Unknown investigation recipe/);
  instance.start(job.id); await settle(instance);
  for (let n = 0; n < 4; n++) { advance(11 * 60000); await instance.tick(); await settle(instance); }
  assert.deepEqual(topics.slice(0, 4).map(topic => topic.split(':')[0]), ['bugs', 'code review', 'security review', 'simplification']);
  assert.equal(topics.length, 5);
  assert.equal(instance.job(job.id).enabled, false); assert.equal(instance.job(job.id).reason, 'Finished: nothing left to fix');
  assert.equal(instance.snapshot().runs.at(-1).loop.fixed.length, 0);
});

test('the hourly allowance holds a second task back even when the day has no limit', async t => {
  const { instance } = manager(t, { runner: async () => ({ tokens: 200000, findings: [], fingerprint: 'f' }) });
  const first = instance.create({ projectId: 'p', limits: { hourlyTokens: 300000 } }), second = instance.create({ projectId: 'p', limits: { hourlyTokens: 300000 } });
  instance.start(first.id); await settle(instance); instance.start(second.id); await settle(instance);
  assert.equal(instance.snapshot().runs.length, 1); assert.match(instance.job(second.id).reason, /Hourly allowance/);
  assert.throws(() => instance.create({ projectId: 'p', limits: { hourlyTokens: 1000 } }), /Hourly allowance must cover/);
});

test('deleting a task removes it and its workspace, keeps its reports and spent allowance, and never touches linked dependencies', async t => {
  const { instance, dir } = manager(t);
  const job = instance.create({ projectId: 'p', recipe: 'fixloop' }); instance.start(job.id); await settle(instance);
  const real = path.join(dir, 'real-node-modules'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'keep.txt'), 'dependency');
  const checkout = path.join(dir, 'storage', 'investigations', 'workspaces', job.id, 'snapshot'); fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'copy.js'), 'x'); fs.symlinkSync(real, path.join(checkout, 'node_modules'), 'junction');
  const tokens = instance.snapshot().ledger['2026-10-04'].tokens;
  instance.remove(job.id);
  assert.equal(instance.snapshot().jobs.length, 0); assert.equal(instance.snapshot().runs.length, 1, 'reports stay as history');
  assert.equal(instance.snapshot().ledger['2026-10-04'].tokens, tokens, 'deleting cannot reset the allowance');
  assert.equal(fs.existsSync(path.join(dir, 'storage', 'investigations', 'workspaces', job.id)), false);
  assert.equal(fs.readFileSync(path.join(real, 'keep.txt'), 'utf8'), 'dependency');
  assert.throws(() => instance.job(job.id), /not found/);
  assert.equal(JSON.parse(fs.readFileSync(instance.file, 'utf8')).jobs.length, 0, 'the deletion is persisted');
});

test('deleting a task mid-run stops the run, then cleans up the workspace', async t => {
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  const { instance, dir } = manager(t, { runner: ({ signal, job }) => new Promise((_, reject) => { fs.mkdirSync(path.join(path.dirname(path.join(dir, 'storage', 'investigations', 'x')), 'workspaces', job.id), { recursive: true }); signal.addEventListener('abort', () => reject(signal.reason)); started(); }) });
  const job = instance.create({ projectId: 'p' }); instance.start(job.id); await begun;
  instance.remove(job.id); await settle(instance);
  assert.equal(instance.snapshot().jobs.length, 0); assert.equal(instance.snapshot().runs[0].status, 'interrupted'); assert.match(instance.snapshot().runs[0].reason, /deleted/);
  assert.equal(fs.existsSync(path.join(dir, 'storage', 'investigations', 'workspaces', job.id)), false);
});
