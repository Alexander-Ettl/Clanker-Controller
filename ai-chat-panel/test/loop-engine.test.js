'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fullCycle, mergeFindings, evidenceFromOutput, checkFinding, priority } = require('../lib/loop-engine');
const { validateLimits, FULL_DEFAULTS } = require('../lib/investigation-manager');
const { ASPECTS, COMPLIANCE_ASPECT, FIND_SCHEMA, CONFIRM_SCHEMA, JUDGE_SCHEMA } = require('../lib/loop-aspects');
const { buildAspectPacket } = require('../lib/loop-source');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true }).toString();

function project(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-loop-engine-'));
  const root = path.join(dir, 'project'); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const all = { 'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node t.js' } }), 'src/a.js': 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n', 'src/b.js': 'module.exports = 1;\n', ...files };
  for (const [name, body] of Object.entries(all)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), body); }
  git(root, 'init', '-q');
  t.after(() => { try { require('../lib/loop-workspace').removeTree(path.join(dir, 'investigations', 'workspaces')); } catch { /* best effort */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, root };
}

const finding = (extra = {}) => ({ title: 'add subtracts instead of adding', severity: 'high', status: 'observed', kind: 'bug', area: 'backend', confidence: 9,
  evidence: [{ file: 'src/a.js', line: 2, detail: 'returns a - b' }], expected: 'add returns the sum', observed: 'add returns the difference', fixPrompt: 'Make add return a + b in src/a.js.', ...extra });

/** Fakes for everything that would call a model, start a browser or run project code. */
function harness({ dir, root }, { mode = 'fix', scoutFindings = { bugs: [finding()] }, failTest = () => false, editBody = (cwd, item) => fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n'), roles = {} } = {}) {
  const calls = { scouts: [], prompts: [], confirm: 0, judge: 0, edits: [], checks: [] };
  const job = { id: 'job1', root, mode, recipe: 'full', limits: validateLimits({ ...FULL_DEFAULTS }), options: {}, backlog: [], handled: [], fingerprints: {}, cycles: 0 };
  const exec = async (command, args, { cwd }) => {
    const label = args.includes('--check') ? `check:${args.at(-1)}` : 'test';
    calls.checks.push(label);
    if (label === 'test' && failTest(cwd)) return { code: 1, output: 'AssertionError at src/a.js:2\n', stderr: '' };
    return { code: 0, output: 'ok', stderr: '' };
  };
  const analyze = async ({ schema, prompt, task, supplied }) => {
    calls.prompts.push(prompt);
    if (schema === FIND_SCHEMA) {
      const aspect = [...ASPECTS, COMPLIANCE_ASPECT].find(item => task.includes(item.task.slice(0, 40)));
      calls.scouts.push(aspect.id);
      return { tokens: 5000, report: { summary: aspect.id, questions: [], findings: scoutFindings[aspect.id] || [] } };
    }
    if (schema === CONFIRM_SCHEMA) {
      calls.confirm++;
      const ids = [...prompt.matchAll(/CANDIDATE (C\d+):/g)].map(match => match[1]);
      return { tokens: 3000, report: { summary: 'checked', verdicts: ids.map(id => ({ id, verdict: 'confirmed', confidence: 8, reason: 'Traced the call: a - b is returned.' })) } };
    }
    if (schema === JUDGE_SCHEMA) {
      calls.judge++;
      const ids = [...prompt.matchAll(/FIX (F\d+):/g)].map(match => match[1]);
      return { tokens: 3000, report: { summary: 'judged', verdicts: ids.map(id => ({ id, verdict: 'fixed', reason: 'The diff changes the operator.' })), newIssues: [] } };
    }
    throw new Error('unexpected analysis');
  };
  const edit = async ({ cwd, target, prompt }) => { calls.edits.push({ target, cwd }); await editBody(cwd, prompt); return { reply: 'fixed: changed the operator', tokens: 100 }; };
  const capture = async () => ({ ok: false, skipped: true, provider: 'none', reason: 'No pages in this project' });
  const resolveRole = async role => roles[role] ?? { target: role === 'scout' ? { agent: 'gemini', model: 'gemini-3.8-flash-high', label: 'Flash' } : role === 'editor' || role === 'visualEditor' ? { agent: 'codex', model: 'gpt-x', label: 'Codex' } : null, skipped: [] };
  const context = (run = {}, extra = {}) => ({ job, run: { id: 'run1', topic: 'Full review, cycle 1', ...run }, directory: path.join(dir, 'investigations', run.id || 'run1'), signal: new AbortController().signal, onProgress: () => {}, resolveRole, ...extra });
  return { calls, job, deps: { exec, analyze, edit, capture }, context };
}

test('a full cycle scans with parallel scouts, confirms, fixes in a worktree, re-checks and reports a patch', async t => {
  const p = project(t); const h = harness(p);
  const progress = [];
  const result = await fullCycle(h.context({}, { onProgress: (stage, live) => progress.push([stage, live?.agents?.length]) }), h.deps);
  assert.equal(h.calls.scouts.length, ASPECTS.filter(aspect => !aspect.needs).length + 1, 'one scout per aspect that applies to the project, plus the EU compliance scout');
  assert.ok(h.calls.scouts.includes('security') && h.calls.scouts.includes('regression') && h.calls.scouts.includes('async'));
  assert.equal(h.calls.confirm, 1); assert.equal(h.calls.judge, 1); assert.equal(h.calls.edits.length, 1);
  assert.equal(h.calls.edits[0].target.agent, 'codex'); assert.match(h.calls.edits[0].cwd, /fix/);
  assert.equal(result.loop.fixed.length, 1); assert.equal(result.loop.fixed[0].title, 'add subtracts instead of adding');
  assert.equal(result.loop.regressions.length, 0); assert.equal(result.loop.mode, 'fix');
  assert.match(fs.readFileSync(path.join(p.dir, 'investigations', 'run1', 'changes.patch'), 'utf8'), /\+  return a \+ b;/);
  assert.equal(fs.readFileSync(path.join(p.root, 'src', 'a.js'), 'utf8').includes('a - b'), true, 'the real project is never edited');
  assert.deepEqual(progress.map(item => item[0]).filter((stage, index, all) => all.indexOf(stage) === index), ['prepare', 'check', 'scan', 'confirm', 'fix', 'verify', 'report']);
  assert.ok(result.tokens > 0); assert.equal(result.fingerprintKey, 'full');
  assert.equal(result.loop.agents.length, h.calls.scouts.length);
});

test('find only never edits anything and finishes after one complete pass', async t => {
  const p = project(t); const h = harness(p, { mode: 'find' });
  const result = await fullCycle(h.context(), h.deps);
  assert.equal(h.calls.edits.length, 0); assert.equal(h.calls.judge, 0);
  assert.equal(result.loop.mode, 'find'); assert.equal(result.loop.found.length, 1); assert.equal(result.done, true);
  assert.equal(fs.existsSync(path.join(p.dir, 'investigations', 'run1', 'changes.patch')), false);
});

test('scouts stay paused or queued until admitted and await output before being shown as responding', async t => {
  const p = project(t), h = harness(p, { scoutFindings: {} });
  let enterGate, releaseGate;
  const entered = new Promise(resolve => { enterGate = resolve; });
  const held = new Promise(resolve => { releaseGate = resolve; });
  let latest, calls = 0;
  let scoutTokens = 0;
  const onProgress = (_stage, live) => { latest = live; scoutTokens = live.scoutTokens || scoutTokens; };
  const analyze = async options => {
    calls++;
    const id = path.basename(options.cwd);
    assert.equal(latest.agents.find(agent => agent.id === id).state, 'waiting', 'an admitted request awaits model output');
    if (calls === 1) assert.ok(latest.agents.some(agent => agent.state === 'queued'));
    assert.match(latest.note, /awaiting response/);
    options.onStatus('running');
    assert.equal(latest.agents.find(agent => agent.id === id).state, 'running');
    assert.match(latest.note, /responding/);
    return h.deps.analyze(options);
  };
  const cycle = fullCycle(h.context({}, { onProgress, slots: new (require('../lib/loop-exec').Semaphore)(1), gate: () => { enterGate(); return held; } }), { ...h.deps, analyze });
  await entered;
  assert.ok(latest.agents.some(agent => agent.state === 'paused'));
  assert.ok(latest.agents.every(agent => agent.state !== 'running' && agent.state !== 'waiting'));
  releaseGate();
  await cycle;
  assert.ok(calls > 1);
  assert.equal(scoutTokens, calls * 5000, 'completed scout usage is visible before the whole run finishes');
});

test('a candidate the verifier refutes is never fixed', async t => {
  const p = project(t); const h = harness(p);
  const refuting = async options => options.schema === CONFIRM_SCHEMA
    ? { tokens: 1, report: { summary: '', verdicts: [...options.prompt.matchAll(/CANDIDATE (C\d+):/g)].map(match => ({ id: match[1], verdict: 'rejected', confidence: 9, reason: 'A guard on line 1 makes it impossible.' })) } }
    : h.deps.analyze(options);
  const result = await fullCycle(h.context(), { ...h.deps, analyze: refuting });
  assert.equal(h.calls.edits.length, 0); assert.equal(result.loop.confirm.rejected, 1); assert.equal(result.loop.fixed.length, 0);
});

test('a fix that turns a passing check red is isolated and thrown out while the good fix stays', async t => {
  const p = project(t, { 'src/c.js': 'module.exports = 2;\n' });
  const h = harness(p, {
    scoutFindings: { bugs: [finding(), finding({ title: 'c exports the wrong constant', evidence: [{ file: 'src/c.js', line: 1, detail: 'exports 2' }], fixPrompt: 'Change src/c.js.' })] },
    failTest: cwd => fs.existsSync(path.join(cwd, 'src', 'c.js')) && fs.readFileSync(path.join(cwd, 'src', 'c.js'), 'utf8').includes('BROKEN'),
    editBody: (cwd, prompt) => { if (/src\/c\.js/.test(prompt.split('TASK:')[1] || '')) fs.writeFileSync(path.join(cwd, 'src', 'c.js'), 'module.exports = BROKEN;\n'); else fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n'); },
  });
  const result = await fullCycle(h.context(), h.deps);
  assert.equal(h.calls.edits.length, 2);
  assert.deepEqual(result.loop.regressions.map(item => item.title), ['c exports the wrong constant']);
  assert.deepEqual(result.loop.fixed.map(item => item.title), ['add subtracts instead of adding']);
  const patch = fs.readFileSync(path.join(p.dir, 'investigations', 'run1', 'changes.patch'), 'utf8');
  assert.match(patch, /a \+ b/); assert.doesNotMatch(patch, /BROKEN/);
});

test('a failing check becomes a finding without needing a verifier, and is fixed', async t => {
  const p = project(t);
  let fixed = false;
  const h = harness(p, { scoutFindings: {}, failTest: cwd => !fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8').includes('a + b'), editBody: cwd => { fixed = true; fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n'); } });
  const result = await fullCycle(h.context(), h.deps);
  assert.equal(fixed, true); assert.equal(result.loop.fixed.length, 1); assert.match(result.loop.fixed[0].title, /Check "test" fails/);
  assert.equal(result.loop.checksBefore.find(check => check.name === 'test').exitCode, 1); assert.equal(result.loop.checksAfter.find(check => check.name === 'test').exitCode, 0);
});

test('a run that was cut off continues with the scouts it had finished instead of starting over', async t => {
  const p = project(t); const h = harness(p);
  const controller = new AbortController();
  let analysed = 0;
  const dying = async options => { if (options.schema === FIND_SCHEMA && ++analysed === 5) { controller.abort(new Error('The IDE is closing')); throw controller.signal.reason; } return h.deps.analyze(options); };
  await assert.rejects(fullCycle(h.context({}, { signal: controller.signal }), { ...h.deps, analyze: dying }), /closing/);
  const done = Object.values(JSON.parse(fs.readFileSync(path.join(p.dir, 'investigations', 'run1', 'checkpoint.json'), 'utf8')).scouts).filter(entry => entry.status === 'done').length;
  assert.ok(done >= 3 && done < ASPECTS.filter(aspect => !aspect.needs).length + 1, `some scouts were saved (${done})`);
  h.calls.scouts.length = 0;
  const result = await fullCycle(h.context({ resumes: 1 }), h.deps);
  assert.ok(h.calls.scouts.length < ASPECTS.filter(aspect => !aspect.needs).length + 1 - 2, `only the unfinished scouts ran again (${h.calls.scouts.length})`);
  assert.equal(result.loop.fixed.length, 1);
});

test('a scout that fails does not fail the cycle; all of them failing does', async t => {
  const p = project(t); const h = harness(p);
  const flaky = async options => { if (options.schema === FIND_SCHEMA && /security/i.test(options.task.slice(0, 200))) throw new Error('model refused'); return h.deps.analyze(options); };
  const result = await fullCycle(h.context(), { ...h.deps, analyze: flaky });
  assert.equal(result.loop.agents.find(agent => agent.id === 'security').status, 'failed');
  assert.equal(result.loop.fixed.length, 1);
  const q = project(t);
  await assert.rejects(fullCycle(harness(q).context(), { ...harness(q).deps, analyze: async () => { throw new Error('quota gone'); } }), /Every scout failed/);
});

test('without any scout model the cycle still reports failing checks instead of crashing', async t => {
  const p = project(t); const h = harness(p, { roles: { scout: { target: null, skipped: [] }, editor: { target: null, skipped: [{ reason: 'none' }] } }, failTest: () => true });
  const result = await fullCycle(h.context(), h.deps);
  assert.equal(h.calls.scouts.length, 0); assert.equal(result.loop.unfixed.length, 1); assert.equal(result.loop.unfixed[0].reason, 'none');
});

test('similar findings from different scouts merge and count their agreement', () => {
  const a = { ...finding(), aspects: ['bugs'] }, b = { ...finding({ title: 'add() subtracts rather than adds', severity: 'medium' }), aspects: ['tests'] };
  const other = { ...finding({ title: 'Unrelated timer leak', evidence: [{ file: 'src/z.js', line: 40, detail: 'x' }] }), aspects: ['async'] };
  const merged = mergeFindings([a, b, other]);
  assert.equal(merged.length, 2); assert.deepEqual(merged[0].aspects.sort(), ['bugs', 'tests']); assert.equal(merged[0].agreement, 2); assert.equal(merged[0].severity, 'high');
  assert.ok(priority(merged[0]) < priority(merged[1]) || merged[1].severity !== 'high');
});

test('failing check output yields cited files only when the project has them', () => {
  const contents = new Map([['src/a.js', 'x\ny\n']]);
  assert.deepEqual(evidenceFromOutput('at add (C:\\work\\project\\src\\a.js:2:10)\n at node:internal:1', contents).map(item => `${item.file}:${item.line}`), ['src/a.js:2']);
  assert.equal(checkFinding({ name: 'build', output: 'boom' }, contents).evidence[0].file, 'check:build');
});

test('each scout gets a different, bounded slice, and larger projects rotate slices between cycles', () => {
  const files = new Map(); for (let n = 0; n < 40; n++) files.set(`src/m${n}.js`, `function f${n}() {\n${'  doWork();\n'.repeat(400)}}\n`);
  const bugs = ASPECTS.find(aspect => aspect.id === 'bugs');
  const first = buildAspectPacket(files, bugs, { budget: 60000, cycle: 0 }), second = buildAspectPacket(files, bugs, { budget: 60000, cycle: 1 });
  assert.ok(first.packet.length <= 70000); assert.ok(first.shards > 1);
  assert.notDeepEqual([...first.supplied.keys()], [...second.supplied.keys()]);
  const perf = buildAspectPacket(new Map([['a.css', 'a{}\n'], ['b.js', 'for (const x of y) {}\n']]), ASPECTS.find(aspect => aspect.id === 'performance'), { budget: 1000 });
  assert.ok(perf.supplied.has('b.js'));
});

const REAL_MAIL = 'anna.schmidt@kunde-gmbh.de';
const euProject = t => project(t, { 'src/seed.js': `module.exports = { owner: "${REAL_MAIL}" };\n`, 'index.html': '<html><body><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><a href="/about">About</a></body></html>' });

test('EU compliance: personal data never reaches a model, and indicators are listed but not fixed', async t => {
  const p = euProject(t);
  const h = harness(p, { scoutFindings: { bugs: [finding()], compliance: [finding({ title: 'Chat answers are not labelled as AI (AI Act Art. 50)', kind: 'compliance', status: 'suspected', severity: 'medium', evidence: [{ file: 'src/a.js', line: 2, detail: 'no notice' }] })] } });
  const result = await fullCycle(h.context(), h.deps);
  assert.ok(h.calls.scouts.includes('compliance'));
  assert.ok(h.calls.prompts.length > 3);
  assert.ok(h.calls.prompts.every(prompt => !prompt.includes(REAL_MAIL)), 'no prompt carries the e-mail address');
  assert.ok(h.calls.prompts.some(prompt => prompt.includes('[email]')), 'the placeholder is what the scouts read');
  assert.match(fs.readFileSync(path.join(p.root, 'src', 'seed.js'), 'utf8'), /anna\.schmidt/, 'the real project keeps its value');
  const listed = result.loop.additional.filter(item => item.kind === 'compliance');
  assert.ok(listed.some(item => item.title === 'Fonts are loaded from Google servers'), 'the free text check found the remote font');
  assert.ok(listed.some(item => /AI Act/.test(item.title)), 'the scout\'s indicator is listed');
  assert.ok(listed.some(item => item.title.startsWith('Real-looking personal data')));
  assert.ok(listed.every(item => /not a legal verdict/.test(item.reason)));
  assert.equal(h.calls.edits.length, 1, 'only the confirmed bug is fixed, never a compliance indicator');
  assert.match(result.summary, /EU compliance indicators? to review \(not legal advice\)/);
});

test('EU compliance can be switched off: no scout, no indicators, nothing redacted', async t => {
  const p = euProject(t); const h = harness(p);
  const result = await fullCycle(h.context({}, { compliance: { scout: false, redact: false } }), h.deps);
  assert.ok(!h.calls.scouts.includes('compliance'));
  assert.ok(h.calls.prompts.some(prompt => prompt.includes(REAL_MAIL)));
  assert.equal(result.loop.additional.filter(item => item.kind === 'compliance').length, 0);
  assert.doesNotMatch(result.summary, /compliance/i);
});

test('editors out of quota: the cycle waits for the reset without scanning, and an editor that is merely not installed still skips', async t => {
  const p = project(t); const h = harness(p);
  const short = { target: null, skipped: [{ agent: 'claude', reason: 'short on quota', quota: true, retryAt: 5000000 }, { agent: 'codex', reason: 'short on quota', quota: true, retryAt: 4000000 }] };
  const result = await fullCycle(h.context({}, { resolveRole: async role => role === 'scout' ? { target: { agent: 'gemini', model: 'gemini-4-hydrogen-high' }, skipped: [] } : short }), h.deps);
  assert.equal(result.skipped, true); assert.equal(result.waiting, true); assert.equal(result.retryAt, 4000000, 'wakes when the first editor is back');
  assert.match(result.reason, /Claude and Codex are short on quota/);
  assert.equal(h.calls.scouts.length, 0, 'not one Gemini call was spent'); assert.equal(h.calls.edits.length, 0);
  const q = project(t), g = harness(q);
  const none = await fullCycle(g.context({}, { resolveRole: async role => role === 'scout' ? { target: { agent: 'gemini', model: 'm' }, skipped: [] } : { target: null, skipped: [{ agent: 'claude', reason: 'not installed' }] } }), g.deps);
  assert.ok(!none.waiting, 'no quota shortfall, so the cycle runs and the fix is skipped as before');
  assert.equal(g.calls.edits.length, 0); assert.ok(g.calls.scouts.length > 0);
});

test('a low Gemini pool stops new model calls, and the incomplete cycle is neither clean nor finished', async t => {
  const p = project(t); const h = harness(p, { mode: 'find', scoutFindings: {} });
  const result = await fullCycle(h.context({}, { quotaLow: () => true }), h.deps);
  assert.equal(h.calls.scouts.length, 0, 'no scout started');
  assert.equal(result.done, false, 'a find pass that read nothing does not claim the project was reviewed');
  assert.equal(result.cleanStreak, 0);
  assert.match(result.summary, /Incomplete: \d+ of \d+ scouts did not finish \(Gemini quota is low\)/);
  assert.equal(result.loop.agents.every(agent => agent.status === 'skipped'), true);
});

test('a finding that failed once is retried by the stronger editor', async t => {
  const p = project(t); const picks = [];
  const h = harness(p, { editBody: () => {} });
  // The quota probe before scanning passes no `escalate`; only a real fix does.
  const ask = async (role, extra) => { if (role === 'editor' && extra && 'escalate' in extra) picks.push(extra.escalate); return role === 'scout' ? { target: { agent: 'gemini', model: 'gemini-4-hydrogen-high' }, skipped: [] } : { target: { agent: 'claude', model: extra?.escalate ? 'claude-opus' : 'claude-sonnet' }, skipped: [] }; };
  const first = await fullCycle(h.context({}, { resolveRole: ask }), h.deps);
  assert.deepEqual(picks, [false], 'Sonnet first'); assert.equal(first.backlog.length, 1); assert.equal(first.backlog[0].attempts, 1);
  const second = harness(project(t), { editBody: () => {}, scoutFindings: {} }); // scouts are told what is already in the backlog
  second.job.backlog = first.backlog;
  await fullCycle(second.context({ id: 'run2' }, { resolveRole: ask }), second.deps);
  assert.equal(picks.at(-1), true, 'Opus on the second attempt');
});
