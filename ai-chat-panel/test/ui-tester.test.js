'use strict';

// The interface tester's pipeline around the model: triage, what Flash is shown and allowed to do, and what comes back.
// The browser harness has its own test (ui-tester.mjs); here the harness and Flash are fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { InvestigationManager, TESTER_DEFAULTS } = require('../lib/investigation-manager');
const { viewAllowed } = require('../lib/investigation-runner');
const { testCycle, copyMedia, MAX_IMAGES } = require('../lib/investigation-tester');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHwF2zQAAAABJRU5ErkJggg==', 'base64');
const item = (kind, severity, selector, extra = {}) => ({ kind, severity, selector, text: '', rect: { x: 10, y: 20, w: 100, h: 30 }, detail: 'overlaps span.cs-title by 38%', fingerprint: `fp-${kind}-${selector}`, isNew: true, ...extra });
const state = (id, findings = [], extra = {}) => ({ id, scenario: id.split('@')[0], width: Number(id.split('@')[1]), findings, aria: 'same', pixel: { status: 'same' }, shot: null, crop: null, ...extra });

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-uitester-test-'));
  const root = path.join(dir, 'project'); fs.mkdirSync(path.join(root, 'ai-chat-panel', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ai-chat-panel', 'lib', 'a.js'), 'module.exports = 1;\n'); fs.writeFileSync(path.join(root, 'package.json'), '{}');
  execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['add', '-A'], { cwd: root });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, root, job: { id: 'job-1', root, model: 'gemini-3.8-flash-high', fingerprints: {}, limits: { ...TESTER_DEFAULTS } }, run: { id: 'run-1', topic: 'interface testing' } };
}
/** A harness that writes the report it was told to, the way run.mjs does (--out, --baseline, --accept staging). */
function fakeHarness(states, { needsVision = [] } = {}) {
  const calls = [];
  const execute = async (command, args) => {
    const out = args.find(arg => arg.startsWith('--out=')).slice(6); calls.push(args);
    for (const dir of ['crops', 'shots', path.join('next-baseline')]) fs.mkdirSync(path.join(out, dir), { recursive: true });
    for (const s of states) for (const [key, folder] of [['crop', 'crops'], ['shot', 'shots']]) if (s[key]) fs.writeFileSync(path.join(out, folder, s[key]), PNG);
    fs.writeFileSync(path.join(out, 'next-baseline', 'known.json'), '["fp"]');
    const count = key => states.filter(s => s[key]).length;
    const summary = { states: states.length, errors: 0, warnings: 0, newFindings: 0, pictureChanges: states.filter(s => s.pixel.status === 'changed').length, treeChanges: states.filter(s => s.aria === 'changed').length, recorded: count('never') };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ summary, needsVision, states }));
    fs.writeFileSync(path.join(out, 'report.md'), '# Interface test report\n');
    return { code: 0, output: '', stderr: '' };
  };
  return { execute, calls };
}
const context = (p, signal = new AbortController().signal) => ({ job: p.job, run: p.run, directory: path.join(p.dir, 'storage', 'investigations', p.run.id), signal, onProgress: stage => (context.stages ||= []).push(stage) });

test('a quiet night uses no model, adopts the new baseline, and the same source is then skipped', async t => {
  const p = project(t); const harness = fakeHarness([state('chat-empty@420')]);
  const flash = async () => { throw new Error('Flash must not run'); };
  const result = await testCycle(context(p), { execute: harness.execute, flash });
  assert.equal(result.tokens, 0); assert.deepEqual(result.findings, []); assert.match(result.summary, /No model was used/);
  assert.ok(fs.existsSync(path.join(p.dir, 'storage', 'investigations', 'workspaces', 'job-1', 'ui-baselines', 'known.json')), 'baseline adopted after the report');
  assert.deepEqual(harness.calls[0].filter(arg => arg === '--accept'), ['--accept']);
  p.job.fingerprints['interface testing'] = result.fingerprint;
  assert.deepEqual(await testCycle(context(p), { execute: harness.execute, flash }), { skipped: true, reason: 'No new source since the last interface test' });
});

test('new measured problems go to Flash as crops with one read-only tool; dismissed ones are dropped and its own issues are cited', async t => {
  const p = project(t);
  const overlap = item('overlap', 'error', 'div.inv-job > span.cs-tag'), clipped = item('clipped-text', 'warn', 'p.cs-desc', { text: 'Waiting', detail: 'text needs 400px, box is 288px' });
  const states = [state('loops-loop@320', [overlap, clipped], { crop: 'loops-loop_320.png' })];
  const harness = fakeHarness(states, { needsVision: ['loops-loop@320'] });
  let seen;
  const flash = async args => {
    seen = args;
    return { tokens: 14000, report: { summary: 'ok', verdicts: [{ id: overlap.fingerprint, verdict: 'real', reason: 'The tag covers the title.' }, { id: clipped.fingerprint, verdict: 'false-positive', reason: 'The text is fully visible.' }],
      issues: [{ image: 'img-1.png', title: 'Tag too close to the edge', severity: 'low', observed: 'The tag touches the card border.', expected: 'Padding around the tag.' }] } };
  };
  const result = await testCycle(context(p), { execute: harness.execute, flash });
  assert.deepEqual(seen.tools, ['view_file']); assert.equal(seen.maxViews, 1); assert.equal(seen.readRoot, path.join(p.dir, 'storage', 'investigations', 'run-1', 'vision'));
  assert.ok(seen.prompt.includes(path.join(seen.readRoot, 'img-1.png')) && seen.prompt.includes(`id=${overlap.fingerprint}`) && !seen.prompt.includes('source excerpts'));
  assert.ok(fs.existsSync(path.join(seen.readRoot, 'img-1.png')));
  assert.equal(result.tokens, 14000);
  assert.deepEqual(result.findings.map(f => f.severity), ['high', 'low']);
  assert.match(result.findings[0].uncertainty, /judged this real/); assert.match(result.findings[0].reproduction, /--only=loops-loop \(width 320px\)/);
  assert.match(result.summary, /1 dismissed as false positives/);
  const handoff = fs.readFileSync(path.join(p.dir, 'storage', 'investigations', 'run-1', 'handoff.md'), 'utf8');
  assert.ok(handoff.includes('run.mjs --only=loops-loop') && handoff.includes('you do not need the pictures'));
  assert.deepEqual(context.stages.slice(-4), ['capture', 'triage', 'vision', 'report']);
});

test('known problems are not re-reported and a changed picture alone reaches Flash', async t => {
  const p = project(t);
  const known = item('overlap', 'error', 'div.x', { isNew: false });
  const states = [state('settings-general@420', [known], { pixel: { status: 'changed', ratio: 0.02, bbox: { x: 1, y: 2, w: 30, h: 40 } }, crop: 'a.png' })];
  const harness = fakeHarness(states, { needsVision: ['settings-general@420'] });
  let prompt = '';
  const result = await testCycle(context(p), { execute: harness.execute, flash: async args => { prompt = args.prompt; return { tokens: 9000, report: { summary: 'clean', verdicts: [], issues: [] } }; } });
  assert.deepEqual(result.findings, []); assert.match(prompt, /picture changed since the last accepted run: 2\.00%/); assert.ok(!prompt.includes('measured id='));
});

test('at most eight pictures are sent, the worst states first', async t => {
  const p = project(t);
  const states = Array.from({ length: 12 }, (_, n) => state(`s${n}@420`, [item('overlap', n === 11 ? 'error' : 'warn', `div.n${n}`)], { crop: `c${n}.png` }));
  const harness = fakeHarness(states, { needsVision: states.map(s => s.id) });
  let seen;
  await testCycle(context(p), { execute: harness.execute, flash: async args => { seen = args; return { tokens: 1, report: { summary: '', verdicts: [], issues: [] } }; } });
  assert.equal(MAX_IMAGES, 8); assert.equal(seen.maxViews, 8);
  assert.equal(seen.prompt.match(/open with view_file/g).length, 8); assert.ok(seen.prompt.indexOf('(s11@420)') < seen.prompt.indexOf('(s0@420)'));
});

test('a failed or ungrounded visual pass keeps measured problems and usage without claiming a completed review', async t => {
  for (const [expectedTokens, flash] of [[null, async () => { throw new Error('Flash did not return a completed diagnostic report.'); }],
    [5, async () => ({ tokens: 5, report: { summary: '', verdicts: [], issues: [{ image: 'img-9.png', title: 't', severity: 'low', observed: 'o', expected: 'e' }] } })],
    [5, async () => ({ tokens: 5, report: { summary: '', verdicts: [{ id: 'invented', verdict: 'real', reason: 'r' }], issues: [] } })],
    [171507, async () => { throw Object.assign(new Error('Measured token allowance reached.'), { tokenUsage: 171507 }); }]]) {
    const p = project(t); const states = [state('a@420', [item('overlap', 'error', 'div.a')], { crop: 'a.png' })];
    const result = await testCycle(context(p), { execute: fakeHarness(states, { needsVision: ['a@420'] }).execute, flash });
    assert.equal(result.findings.length, 1); assert.match(result.findings[0].uncertainty, /no model looked/);
    assert.equal(result.tokens, expectedTokens); assert.match(result.questions[0], /Visual review failed/);
    assert.equal(result.reviewIncomplete, true); assert.match(result.summary, /Visual review incomplete/);
    assert.doesNotMatch(result.summary, /pictures? reviewed by Flash/);
    assert.equal(fs.existsSync(path.join(p.dir, 'storage', 'investigations', 'workspaces', p.job.id, 'ui-baselines')), false, 'an incomplete review must not accept a baseline');
  }
});

test('the frozen interface includes vendor assets larger than two megabytes', t => {
  const p = project(t); const media = path.join(p.root, 'ai-chat-panel', 'media', 'vendor', 'shiki');
  fs.mkdirSync(media, { recursive: true });
  const bundle = Buffer.alloc(2272591, 'x'); fs.writeFileSync(path.join(media, 'shiki.bundle.js'), bundle);
  const checkout = path.join(p.dir, 'snapshot'); copyMedia(p.root, checkout);
  assert.deepEqual(fs.readFileSync(path.join(checkout, 'ai-chat-panel', 'media', 'vendor', 'shiki', 'shiki.bundle.js')), bundle);
});

test('a media-only change invalidates the interface fingerprint', async t => {
  const p = project(t); const media = path.join(p.root, 'ai-chat-panel', 'media'); fs.mkdirSync(media);
  const file = path.join(media, 'icon.png'); fs.writeFileSync(file, PNG);
  const harness = fakeHarness([state('chat-empty@420')]);
  const deps = { execute: harness.execute, flash: async () => assert.fail('no visual change') };
  const first = await testCycle(context(p), deps); p.job.fingerprints[p.run.topic] = first.fingerprint;
  fs.appendFileSync(file, 'changed'); p.run.id = 'run-2';
  const second = await testCycle(context(p), deps);
  assert.notEqual(first.fingerprint, second.fingerprint); assert.equal(harness.calls.length, 2);
});

test('cancelling stops the cycle and leaves the old baseline in place', async t => {
  const p = project(t); const controller = new AbortController();
  const states = [state('a@420', [item('overlap', 'error', 'div.a')], { crop: 'a.png' })];
  await assert.rejects(testCycle(context(p, controller.signal), { execute: fakeHarness(states, { needsVision: ['a@420'] }).execute, flash: async () => { controller.abort(new Error('Stopped by user')); throw new Error('cut'); } }), /cut/);
  assert.ok(!fs.existsSync(path.join(p.dir, 'storage', 'investigations', 'workspaces', 'job-1', 'ui-baselines')));
});

test('a missing harness report is a failed run with the reason, not a silent pass', async t => {
  const p = project(t);
  await assert.rejects(testCycle(context(p), { execute: async () => ({ code: 1, output: '', stderr: 'browserType.launch: Executable does not exist' }), flash: async () => ({}) }), /produced no report: browserType\.launch/);
});

test('Flash may open only PNG pictures inside its scratch folder, and nothing else', () => {
  const root = path.join(os.tmpdir(), 'clanker-vision');
  const view = (file, name = 'view_file') => ({ step_update: { step_type: 'tool', tool_name: name, tool_info: { parameters: { AbsolutePath: file, StartLine: 1 } } } });
  assert.equal(viewAllowed(view(path.join(root, 'img-1.png')), root), true);
  assert.equal(viewAllowed(view(path.join(root, '..', 'secret.png')), root), false);
  assert.equal(viewAllowed(view(path.join(root, 'notes.txt')), root), false);
  assert.equal(viewAllowed(view(path.join(root, 'img-1.png'), 'run_command'), root), false);
  assert.equal(viewAllowed(view(path.join(root, 'img-1.png')), null), false, 'no folder, no reading');
  assert.equal(viewAllowed({ step_update: { step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: {} } } }, root), false, 'a read with no path is refused');
});

test('a tester task gets its own small allowance and unknown recipes are still rejected', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-uitester-mgr-'));
  const root = path.join(dir, 'p'); fs.mkdirSync(root);
  const manager = new InvestigationManager({ storageDir: path.join(dir, 'storage'), projects: { get: () => ({ id: 'p', root }) }, availableModels: () => [], readQuota: async () => null, runner: async () => ({}) });
  t.after(() => { manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const job = manager.create({ projectId: 'p', recipe: 'tester' });
  assert.equal(job.recipe, 'tester'); assert.equal(job.limits.maxTokensPerRun, 60000); assert.equal(job.limits.maxRunMinutes, 15);
  assert.equal(manager.snapshot().testerDefaults.maxTokensPerRun, 60000); assert.ok(manager.snapshot().recipes.includes('tester'));
  assert.throws(() => manager.create({ projectId: 'p', recipe: 'nope' }), /Unknown investigation recipe/);
});
