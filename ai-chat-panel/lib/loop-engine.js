'use strict';

// One cycle of the full loop. It replaces the separate diagnose, find-and-fix and interface-test loops with one pipeline:
//
//   prepare   private git copy of the project, detected profile (how it is built, tested and shown)
//   check     the project's own checks, and a visual capture of its pages, at the same time (no model tokens)
//   scan      ten scouts read the project in parallel, each through one question (bugs, concurrency, security, errors,
//             recent changes, tests, contracts, interface code, performance, simplification)
//   confirm   independent verifiers try to refute every candidate against the code as it is now; only survivors continue
//   fix       confirmed problems, failing checks and measured layout problems go to editors working in parallel git worktrees,
//             each guarded by a quick gate and merged one at a time
//   verify    the checks and the capture run again; a fix that turns a passing check red is isolated and thrown out;
//             judges read every diff; a vision model looks at the pictures that changed
//   report    what was fixed, what was not, what is new, and one patch for the real project
//
// Every finished step is written to checkpoint.json in the run folder, so an interrupted run (IDE closed, crash, sleep)
// continues with the finished scouts, fixes and checks instead of starting over.

const fs = require('node:fs');
const path = require('node:path');
const { git, run, nodeCommand } = require('./loop-exec');
const { detectProfile } = require('./loop-profile');
const { prepareWorkspace, addWorktree, removeWorktree, dirty, revert, head, baselineOf } = require('./loop-workspace');
const { readContents, recentChanges, buildAspectPacket, excerptAround, digest } = require('./loop-source');
const { ASPECTS, COMPLIANCE_ASPECT, FIND_SCHEMA, CONFIRM_SCHEMA, JUDGE_SCHEMA, VISION_SCHEMA, scoutTask, schemaNote, CONFIRM_TASK, JUDGE_TASK, VISION_TASK } = require('./loop-aspects');
const { redactPersonalData, redactText, scanCompliance } = require('./loop-compliance');
const agents = require('./loop-agents');
const visual = require('./loop-visual');

const SEVERITY = { high: 0, medium: 1, low: 2 };
const KIND = { security: 0, bug: 1, review: 2, compliance: 2, simplify: 3 };
const MAX_ATTEMPTS = 2, MAX_BACKLOG = 40, MAX_CANDIDATES = 24, VERIFY_BATCH = 6, JUDGE_BATCH = 3, MAX_VISUAL = 8, MIN_CALL_TOKENS = 60000;
const FINAL = new Set(['applied', 'nochange', 'failed', 'rejected', 'conflict', 'skipped']);
const SHORT_CHECK = new Set(['syntax', 'compile']);

const clone = value => JSON.parse(JSON.stringify(value));
const words = text => new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(word => word.length > 3));
const similar = (a, b) => { const x = words(a), y = words(b); if (!x.size || !y.size) return 0; let shared = 0; for (const word of x) if (y.has(word)) shared++; return shared / (x.size + y.size - shared); };
const tail = (text, n) => String(text || '').slice(-n);

class Mutex { constructor() { this.last = Promise.resolve(); } run(fn) { const next = this.last.then(fn, fn); this.last = next.catch(() => {}); return next; } }

/** Run-folder checkpoint: small JSON, replaced atomically after every finished step. */
function openCheckpoint(directory) {
  const file = path.join(directory, 'checkpoint.json');
  let data = { version: 1, scouts: {}, fixes: {} };
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved?.version === 1) data = saved; } catch { /* a first run */ }
  data.scouts ||= {}; data.fixes ||= {};
  return { data, save() { fs.mkdirSync(directory, { recursive: true }); const temporary = `${file}.tmp`; fs.writeFileSync(temporary, JSON.stringify(data)); fs.renameSync(temporary, file); } };
}

/** Token accounting for one cycle. Unknown usage is charged at the call's allowance so the total never under-reports. */
class Budget {
  constructor(total) { this.total = total; this.spent = 0; this.unknown = 0; }
  get remaining() { return Math.max(0, this.total - this.spent); }
  charge(tokens, allowance) { if (Number.isFinite(tokens) && tokens >= 0) this.spent += tokens; else { this.spent += allowance; this.unknown++; } }
}

/** The project's own checks. Output lands in `<directory>/checks/<prefix><name>.txt`. A missing tool or a timeout is "inconclusive" (exitCode null), never a failure. */
async function runChecks({ profile, checkout, directory, signal, prefix = '', only = null, onActivity, exec = run }) {
  const logs = [];
  fs.mkdirSync(path.join(directory, 'checks'), { recursive: true });
  for (const check of profile.checks) {
    if (only && !only.includes(check.name)) continue;
    signal.throwIfAborted();
    const started = Date.now();
    let result, note = '';
    try { result = await exec(check.command, check.args, { cwd: checkout, signal, env: check.env, timeoutMs: check.timeoutMs, idleMs: 10 * 60000, maxBytes: 4 * 1024 * 1024, onActivity }); }
    catch (error) {
      signal.throwIfAborted();
      note = error.code === 'ENOENT' ? `${check.command} is not installed` : /time limit|No activity/.test(error.message) ? 'timed out' : error.message;
      result = { code: null, output: '', stderr: note };
    }
    const text = (result.output || '') + (result.stderr || '');
    fs.writeFileSync(path.join(directory, 'checks', `${prefix}${check.name.replace(/[^\w.-]+/g, '_')}.txt`), text);
    logs.push({ name: check.name, exitCode: result.code, output: tail(text, 10000), ms: Date.now() - started, optional: Boolean(check.optional), ...(note ? { note } : {}) });
  }
  return logs;
}
const passed = log => log.exitCode === 0, failed = log => Number.isInteger(log.exitCode) && log.exitCode > 0;
const checkLine = logs => logs.map(({ name, exitCode, note }) => `${name}: ${exitCode === 0 ? 'passed' : failed({ exitCode }) ? 'FAILED' : `inconclusive${note ? ` (${note})` : ''}`}`).join('; ') || 'no automatic checks found';

/** The files a failing check points at, when its output names any (stack traces and compiler messages). */
function evidenceFromOutput(output, contents) {
  const found = [], seen = new Set();
  for (const match of String(output).matchAll(/([\w./\\@-]+\.(?:[cm]?[jt]sx?|py|go|rs|swift|cs|java|kt|css|html))[:(](\d+)/g)) {
    const file = match[1].replace(/\\/g, '/').replace(/^.*?\/(?=(?:src|lib|app|ai-chat-panel|test|tests|scripts)\/)/, '');
    const key = [...contents.keys()].find(name => name === file || name.endsWith(`/${file}`) || file.endsWith(`/${name}`));
    if (!key || seen.has(`${key}:${match[2]}`)) continue;
    seen.add(`${key}:${match[2]}`); found.push({ file: key, line: Math.max(1, Number(match[2])), detail: 'Named by the failing check output' });
    if (found.length >= 4) break;
  }
  return found;
}

function checkFinding(log, contents) {
  const evidence = evidenceFromOutput(log.output, contents);
  return { source: 'check', title: `Check "${log.name}" fails`, severity: 'high', status: 'observed', kind: 'bug', area: 'backend', confidence: 10,
    evidence: evidence.length ? evidence : [{ file: `check:${log.name}`, line: 1, detail: 'Output of the failing check' }],
    expected: `The project's "${log.name}" check passes.`, observed: tail(log.output, 900).trim() || 'The check exited with a failure.',
    fixPrompt: `The project's "${log.name}" check fails in this copy of the project. Read the failure output below, find the root cause in the project's source, and make the check pass with the smallest correct change. Never weaken, skip or delete a test or the check itself to make it pass.\n\nOutput (end):\n${tail(log.output, 2500)}`,
    aspects: ['checks'], agreement: 1 };
}

/** Candidates from several scouts that describe the same problem become one, remembering how many scouts agreed. */
function mergeFindings(found) {
  const clusters = [];
  for (const finding of found.slice().sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || (b.confidence || 0) - (a.confidence || 0))) {
    // The same lines with any wording in common are one problem; nearby lines need clearly similar titles.
    const nearby = (cluster, span) => cluster.evidence.some(a => finding.evidence.some(b => a.file === b.file && Math.abs(a.line - b.line) <= span));
    const near = clusters.find(cluster => similar(cluster.title, finding.title) >= 0.55 || (nearby(cluster, 2) && similar(cluster.title, finding.title) > 0) || (nearby(cluster, 6) && similar(cluster.title, finding.title) >= 0.25));
    if (near) {
      near.aspects = [...new Set([...near.aspects, ...finding.aspects])]; near.agreement = near.aspects.length;
      near.confidence = Math.max(near.confidence || 0, finding.confidence || 0);
      if ((finding.fixPrompt || '').length > (near.fixPrompt || '').length) near.fixPrompt = finding.fixPrompt;
    } else clusters.push({ ...finding, aspects: [...finding.aspects], agreement: finding.aspects.length });
  }
  return clusters;
}
const priority = item => (SEVERITY[item.severity] ?? 2) * 10 + (KIND[item.kind] ?? 2) * 2 - Math.min(3, (item.agreement || 1) - 1) - (item.source === 'check' ? 4 : 0) - (item.source === 'visual' ? 1 : 0);

const evidenceLine = item => `${item.file}:${item.line} ${item.detail}`;
function fixPromptFor(item, cwd) {
  return `You are fixing one problem in an isolated copy of a project at ${cwd}. Edit only files inside this folder.
Do not run git, touch node_modules, or start long-running processes. Make the smallest correct change and, where practical, add or extend
a regression test in the project's existing test folder. Never weaken, skip or delete an existing test. Do not fix anything else.

PROBLEM (${item.kind}, ${item.severity} severity): ${item.title}
Expected: ${item.expected}
Observed: ${item.observed}
Evidence:
${(item.evidence || []).map(evidenceLine).join('\n')}
${item.note ? `A previous attempt did not resolve this: ${item.note}\n` : ''}${item.confirmation ? `A reviewer who tried to refute this problem concluded: ${item.confirmation}\n` : ''}
TASK:
${item.fixPrompt}

When you are done, reply with one short paragraph that starts with "fixed" or "not fixed" and says what you changed and why.`;
}

const summarize = (item, extra = {}) => ({ id: item.id, title: item.title, severity: item.severity, kind: item.kind, area: item.area, source: item.source,
  agent: item.fix?.agent, model: item.fix?.model, reason: item.fix?.reason, agreement: item.agreement, ...extra });
const carry = (item, note) => { const { fix, id, ...rest } = item; return { ...rest, ...(note ? { note } : {}) }; };
const publicFinding = item => ({ title: item.title, severity: item.severity, status: item.status, kind: item.kind, area: item.area, source: item.source, evidence: item.evidence,
  expected: item.expected, observed: item.observed, suspectedCause: '', reproduction: '', uncertainty: item.confirmation || (item.source === 'check' ? 'Measured: the project’s own check fails.' : item.source === 'visual' ? 'Measured in a headless browser.' : ''),
  agreement: item.agreement, confidence: item.confidence, aspects: item.aspects, ...(item.fix ? { fix: item.fix } : {}) });

// ---------------------------------------------------------------------------------------------------------------------
// Visual helpers

const slugOf = route => route === '/' ? 'home' : route.replace(/^\/|\/$/g, '').replace(/[^\w-]+/g, '-').slice(0, 40);
const LABEL = { overlap: 'Overlapping elements', 'clipped-text': 'Clipped text', 'covered-control': 'Covered control', offscreen: 'Control off screen', 'page-overflow': 'Page scrolls sideways',
  'unnamed-control': 'Control without a name', 'tiny-target': 'Very small control', 'page-error': 'Script error', 'console-error': 'Console error', 'request-failed': 'Failed request' };
const SEVERE = item => item.severity === 'error' || item.severity === 'warn';

function visualFinding(state, item, verdict, routeOf) {
  const name = item.text ? `"${item.text}"` : item.selector.split(' > ').slice(-1)[0];
  const where = `${routeOf(state)} at ${state.width}px${item.stress ? ' with text 45% longer' : ''}`;
  const rect = item.rect ? ` at x${item.rect.x} y${item.rect.y}, ${item.rect.w}x${item.rect.h}px` : '';
  return { source: 'visual', title: `${LABEL[item.kind] || item.kind}: ${name} (${state.id})`.slice(0, 190), severity: item.severity === 'error' ? 'high' : 'medium', status: 'observed', kind: 'bug', area: 'visual', confidence: verdict?.verdict === 'real' ? 9 : 7,
    evidence: [{ file: `ui:${state.id}`, line: 1, detail: `${item.selector}${rect}${item.detail ? `; ${item.detail}` : ''}`.slice(0, 380) }],
    expected: 'The page has no overlap, clipping, covered controls or script errors.', observed: item.detail || `${LABEL[item.kind] || item.kind} measured in a headless browser on ${where}.`,
    fixPrompt: `A headless browser measured a layout problem on the page ${where}: ${LABEL[item.kind] || item.kind} on ${item.selector}${rect}${item.detail ? ` (${item.detail})` : ''}. Find the markup and styles responsible in this project, fix the layout so it holds at that width and with longer text, and keep every other page unchanged.`,
    confirmation: verdict ? `A vision model looked at the picture and judged this ${verdict.verdict}: ${verdict.reason}` : '', fingerprint: item.fingerprint, aspects: ['visual'], agreement: 1 };
}
function pickImages(report, captureDir, visionDir, limit) {
  const rank = state => state.findings.some(item => item.isNew && item.severity === 'error') ? 0 : state.findings.some(item => item.isNew && item.severity === 'warn') ? 1 : state.pixel.status === 'changed' ? 2 : 3;
  const ordered = (report.states || []).filter(state => report.needsVision.includes(state.id) && (state.crop || state.shot)).sort((a, b) => rank(a) - rank(b) || (b.pixel.ratio || 0) - (a.pixel.ratio || 0)).slice(0, limit);
  fs.mkdirSync(visionDir, { recursive: true });
  return ordered.map((state, index) => {
    const from = path.join(captureDir, state.crop ? 'crops' : 'shots', state.crop || state.shot);
    const name = `img-${index + 1}.png`; fs.copyFileSync(from, path.join(visionDir, name));
    return { name, file: path.join(visionDir, name), state };
  });
}
function visionPrompt(images) {
  const blocks = images.map(({ name, file, state }) => {
    const lines = [`${name}  (${state.id})  open with view_file at: ${file}`];
    for (const item of state.findings.filter(item => item.isNew && SEVERE(item))) lines.push(`  measured id=${item.fingerprint}: ${item.severity} ${item.kind}${item.stress ? ' (only when text is 45% longer)' : ''} on ${item.selector.split(' > ').slice(-1)[0]}${item.text ? ` "${item.text}"` : ''}${item.detail ? `: ${item.detail}` : ''}`);
    if (state.cropStretched) lines.push('  this picture was taken with all text lengthened by 45% on purpose, to test other languages');
    if (state.pixel.status === 'changed') lines.push(`  picture changed since the last accepted run: ${(state.pixel.ratio * 100).toFixed(2)}% of pixels`);
    if (state.ariaDiff?.length) lines.push(`  accessibility tree changes:\n    ${state.ariaDiff.slice(0, 6).join('\n    ')}`);
    return lines.join('\n');
  });
  return `${schemaNote(VISION_SCHEMA)}\nPictures:\n${blocks.join('\n')}`;
}
const adoptBaseline = (captureDir, baselineDir) => { const staged = path.join(captureDir, 'next-baseline'); if (fs.existsSync(staged)) { fs.mkdirSync(baselineDir, { recursive: true }); fs.cpSync(staged, baselineDir, { recursive: true, force: true }); } };

// ---------------------------------------------------------------------------------------------------------------------

async function fullCycle(context, deps = {}) {
  const { job, run: runRecord, directory, signal, onProgress = () => {}, resolveRole = async () => ({ target: null, skipped: [] }), slots = null, gate = async () => {}, expired = () => false, visorDir = null } = context;
  // EU compliance (Settings > Loops): the extra scout and the static indicators, and redaction of personal data in model input. Both default on.
  const eu = { scout: true, redact: true, ...(context.compliance || {}) };
  const scrub = text => eu.redact ? redactText(text) : text;
  const exec = deps.exec || run, analyze = deps.analyze || agents.analyze, edit = deps.edit || agents.edit, capture = deps.capture || visual.capture, now = deps.now || Date.now;
  const options = { agents: 10, parallelFixes: 3, minConfidence: 6, packetChars: 160000, visual: 'auto', ...(job.options || {}) };
  const fixLimit = job.mode === 'find' ? 0 : job.limits.fixesPerCycle;
  const cycle = job.cycles || 0;
  signal.throwIfAborted();
  fs.mkdirSync(directory, { recursive: true });
  const cp = openCheckpoint(directory);
  const live = { agents: [], fixes: [], note: '', resumed: Boolean(runRecord.resumes) };
  const report = (stage, patch = {}) => { Object.assign(live, patch); onProgress(stage, clone(live)); };
  const budget = new Budget(job.limits.maxTokensPerRun);
  Object.assign(budget, cp.data.budget || {});
  const saveBudget = () => { cp.data.budget = { spent: budget.spent, unknown: budget.unknown }; cp.save(); };
  const pool = agents.createPool({ limit: options.agents, slots, signal, onRetry: (error, attempt) => report('scan', { note: `Retrying after: ${error.message.slice(0, 80)} (${attempt})` }) });

  // ---- prepare
  report('prepare', { note: 'Copying the project' });
  const workspace = path.join(path.dirname(directory), 'workspaces', job.id);
  const checkout = await prepareWorkspace(job.root, workspace, { signal });
  const profile = detectProfile(checkout);
  const baseline = baselineOf(checkout);
  const resumed = Boolean(cp.data.cycleStart);
  const cycleStart = cp.data.cycleStart || head(checkout);
  const backlog = (job.backlog || []).slice();
  const shardHint = job.shards || 1;
  const fingerprint = digest(`${cycleStart}:${cycle % shardHint}:${fixLimit ? 'fix' : 'find'}`);
  if (!backlog.length && cycle > 0 && job.fingerprints?.full === fingerprint && !resumed) return { skipped: true, finished: true, reason: 'Nothing changed since the last cycle' };
  cp.data.cycleStart = cycleStart; cp.save();
  if (resumed) restoreApplied(checkout, cycleStart, cp.data.after?.fixes || cp.data.fixes);
  const contents = readContents(checkout);
  // Cloud models see `shown`, never `contents`: real e-mail addresses, IBANs and phone numbers are replaced inside their lines.
  const redacted = redactPersonalData(contents);
  const shown = eu.redact ? redacted.contents : contents;
  const changes = recentChanges(job.root);
  const recent = eu.redact ? { ...changes, diff: redactText(changes.diff) } : changes;
  const baselineDir = path.join(workspace, 'ui-baselines');

  // ---- check + capture, in parallel (no model tokens)
  report('check', { note: profile.checks.length ? `${profile.label}: ${profile.checks.map(check => check.name).join(', ')}` : `${profile.label}: no automatic checks found` });
  if (!cp.data.before) {
    const [checks, shot] = await Promise.all([
      runChecks({ profile, checkout, directory, signal, exec }),
      capture({ profile, checkout, directory, name: 'capture', signal, choice: options.visual, baselineDir, accept: true, visorDir }).catch(error => { signal.throwIfAborted(); return { ok: false, provider: 'none', reason: error.message }; }),
    ]);
    cp.data.before = { checks, visual: { ok: shot.ok, provider: shot.provider, reason: shot.reason, captureDir: shot.captureDir, routes: shot.routes || [], skipped: shot.skipped } }; cp.save();
  }
  const before = cp.data.before.checks, visualBefore = cp.data.before.visual;
  const readCapture = info => { try { return info?.ok ? JSON.parse(fs.readFileSync(path.join(info.captureDir, 'report.json'), 'utf8')) : null; } catch { return null; } };
  const captureBefore = readCapture(visualBefore);
  const routeOf = state => (visualBefore.routes || []).find(route => `page-${slugOf(route)}` === state.scenario) || state.scenario.replace(/^page-/, '/');

  // ---- scan
  const scout = await resolveRole('scout');
  const aspects = [...ASPECTS.filter(aspect => !aspect.needs || aspect.needs(profile, [...contents.keys()])).slice(0, options.agents), ...(eu.scout ? [COMPLIANCE_ASPECT] : [])];
  live.agents = aspects.map(aspect => ({ id: aspect.id, label: aspect.label, short: aspect.short, state: cp.data.scouts[aspect.id]?.status === 'done' ? 'done' : 'queued', found: cp.data.scouts[aspect.id]?.found }));
  report('scan', { note: scout.target ? `${aspects.length} scouts on ${scout.target.label}` : 'No model available for scouts' });
  const known = [...(job.handled || []), ...backlog.map(item => item.title)].slice(-40);
  const failingChecks = before.filter(failed);
  let shards = cp.data.shards || 1;
  const runScout = async aspect => {
    if (cp.data.scouts[aspect.id]?.status === 'done') return;
    const mark = (state, extra = {}) => {
      const entry = live.agents.find(item => item.id === aspect.id);
      if (entry.state === state && !Object.keys(extra).length) return;
      const reason = { running: 'Model output received', waiting: 'Waiting for model output', queued: 'Waiting for an available scout slot', paused: 'Waiting for foreground work to finish' }[state];
      Object.assign(entry, { state, reason }, extra);
      const counts = [['running', 'responding'], ['waiting', 'awaiting response'], ['queued', 'queued'], ['paused', 'waiting for idle'], ['done', 'done'], ['failed', 'failed'], ['skipped', 'skipped']]
        .map(([key, label]) => { const n = live.agents.filter(item => item.state === key).length; return n ? `${n} ${label}` : ''; }).filter(Boolean);
      const scoutTokens = Object.values(cp.data.scouts).reduce((total, scout) => total + (Number.isFinite(scout.tokens) ? scout.tokens : 0), 0);
      report('scan', { note: `${aspects.length} scouts on ${scout.target?.label || 'unavailable model'}: ${counts.join(', ')}`, scoutTokens });
    };
    if (!scout.target) { cp.data.scouts[aspect.id] = { status: 'skipped', reason: 'No scout model' }; mark('skipped'); return; }
    if (expired() || budget.remaining < MIN_CALL_TOKENS) { cp.data.scouts[aspect.id] = { status: 'skipped', reason: expired() ? 'Time budget used up' : 'Token budget used up' }; mark('skipped'); return; }
    const dir = path.join(directory, 'scouts', aspect.id); fs.mkdirSync(dir, { recursive: true });
    const packet = buildAspectPacket(shown, aspect, { budget: options.packetChars, cycle, recent: recent.files });
    shards = Math.max(shards, packet.shards);
    const withOutput = aspect.id === 'tests' || aspect.id === 'bugs' || aspect.id === 'regression';
    const prompt = `${schemaNote(FIND_SCHEMA)}\nProject: ${profile.label}\nYour question: ${aspect.label}\nChecks before any fix: ${checkLine(before)}\n`
      + `${withOutput && failingChecks.length ? `Failing check output:\n${failingChecks.map(log => `--- ${log.name}\n${scrub(tail(log.output, 3500))}`).join('\n')}\n` : ''}`
      + `${aspect.recent && recent.diff ? `RECENT CHANGES (context only; cite lines from the FILE excerpts below, not from the diff):\n${recent.diff}\n` : ''}`
      + `${known.length ? `Already known or fixed, do not report again: ${JSON.stringify(known)}\n` : ''}`
      + `Source excerpts (${packet.files} of ${packet.total} files${packet.shards > 1 ? `, slice ${packet.shard + 1} of ${packet.shards}` : ''}; may be truncated):\n${packet.packet}`;
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
    mark('paused', { reason: 'Waiting for foreground work to finish' });
    try {
      await gate(signal);
      mark('queued', { reason: 'Waiting for an available scout slot' });
      const result = await pool.run(() => {
        mark('waiting', { reason: 'Starting request; waiting for model output' });
        return analyze({ target: scout.target, cwd: dir, prompt, task: scoutTask(aspect, profile.label), schema: FIND_SCHEMA, supplied: packet.supplied, signal,
          maxTokens: Math.min(450000, budget.remaining), logFile: path.join(dir, 'log.jsonl'),
          onStatus: state => mark(state) });
      });
      budget.charge(result.tokens, 150000);
      const findings = result.report.findings.map(finding => ({ ...finding, source: 'scout', aspects: [aspect.id], agreement: 1, suggestion: aspect.fixes === false }));
      cp.data.scouts[aspect.id] = { status: 'done', findings, summary: result.report.summary, questions: result.report.questions, tokens: result.tokens, found: findings.length };
      saveBudget(); mark('done', { found: findings.length });
    } catch (error) {
      signal.throwIfAborted();
      if (Number.isFinite(error.tokenUsage)) budget.charge(error.tokenUsage, 0); else budget.charge(null, 20000);
      cp.data.scouts[aspect.id] = { status: 'failed', reason: error.message.slice(0, 300) }; saveBudget(); mark('failed', { reason: error.message.slice(0, 120) });
    }
  };
  await Promise.all(aspects.map(runScout));
  cp.data.shards = shards; cp.save();
  const scouted = Object.values(cp.data.scouts);
  if (scout.target && scouted.length && scouted.every(entry => entry.status === 'failed')) throw new Error(`Every scout failed: ${scouted[0].reason}`);
  const questions = scouted.flatMap(entry => entry.questions || []).slice(0, 8);

  // ---- confirm
  report('confirm', { note: 'Verifiers are trying to refute each candidate' });
  if (!cp.data.queue) {
    const raw = scouted.flatMap(entry => entry.findings || []);
    const isEu = item => item.aspects.includes('compliance');
    const suggestions = mergeFindings(raw.filter(item => item.suggestion && !isEu(item))).slice(0, 8);
    // Indicators from the text rules and the EU scout. They get their own list so the other suggestions cannot crowd them out.
    const compliance = eu.scout ? mergeFindings([...scanCompliance(contents, eu.redact ? redacted : null), ...raw.filter(isEu)]).slice(0, 12) : [];
    const proposed = mergeFindings(raw.filter(item => !item.suggestion)).sort((a, b) => priority(a) - priority(b)).slice(0, MAX_CANDIDATES);
    proposed.forEach((item, index) => { item.id = `C${index + 1}`; });
    let confirmed = [], rejected = 0, unchecked = [];
    const verifier = proposed.length ? await resolveRole('scout') : { target: null };
    if (proposed.length && verifier.target) {
      const batches = []; for (let index = 0; index < proposed.length; index += VERIFY_BATCH) batches.push(proposed.slice(index, index + VERIFY_BATCH));
      const verdicts = new Map();
      await Promise.all(batches.map(async (batch, index) => {
        if (expired() || budget.remaining < MIN_CALL_TOKENS) { unchecked.push(...batch); return; }
        const dir = path.join(directory, 'verify', String(index + 1)); fs.mkdirSync(dir, { recursive: true });
        const prompt = `${schemaNote(CONFIRM_SCHEMA)}\nProject: ${profile.label}\n\n${batch.map(item => `CANDIDATE ${item.id}: ${item.title}\nSeverity: ${item.severity}. Found by: ${item.aspects.join(', ')}.\nClaim: ${item.observed}\nExpected: ${item.expected}\n`
          + `Scout's evidence:\n${item.evidence.map(evidenceLine).join('\n')}\nCurrent text around the evidence:\n${excerptAround(shown, item.evidence)}`).join('\n\n')}`;
        fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
        try {
          await gate(signal);
          const result = await pool.run(() => analyze({ target: verifier.target, cwd: dir, prompt, task: CONFIRM_TASK, schema: CONFIRM_SCHEMA, signal, maxTokens: Math.min(450000, budget.remaining), logFile: path.join(dir, 'log.jsonl') }));
          budget.charge(result.tokens, 120000); saveBudget();
          for (const verdict of result.report.verdicts) verdicts.set(verdict.id, verdict);
        } catch (error) { signal.throwIfAborted(); budget.charge(null, 20000); unchecked.push(...batch); }
      }));
      for (const item of proposed) {
        const verdict = verdicts.get(item.id);
        if (!verdict) { if (!unchecked.includes(item)) unchecked.push(item); continue; }
        if (verdict.verdict === 'confirmed' && verdict.confidence >= options.minConfidence) {
          confirmed.push({ ...item, severity: verdict.severity || item.severity, area: verdict.area || item.area, confidence: verdict.confidence, confirmation: `Confirmed ${verdict.confidence}/10: ${verdict.reason}` });
        } else rejected++;
      }
    } else unchecked = proposed;
    // Failing checks and measured layout problems are evidence in themselves: they skip the refutation step.
    const measured = failingChecks.map(log => checkFinding(log, contents));
    let visionNotes = '';
    const visionRole = captureBefore ? await resolveRole('vision') : { target: null };
    const visualItems = [];
    if (captureBefore) {
      const images = visionRole.target && captureBefore.needsVision?.length ? pickImages(captureBefore, visualBefore.captureDir, path.join(directory, 'vision-before'), 10) : [];
      let review = null;
      if (images.length && !expired() && budget.remaining >= MIN_CALL_TOKENS) {
        report('confirm', { note: `Reviewing ${images.length} screenshots` });
        try {
          await gate(signal);
          const dir = path.join(directory, 'vision-before');
          const result = await pool.run(() => analyze({ target: visionRole.target, cwd: dir, prompt: visionPrompt(images), task: VISION_TASK, schema: VISION_SCHEMA, signal, maxTokens: Math.min(300000, budget.remaining),
            tools: ['view_file'], readRoot: dir, maxViews: images.length, logFile: path.join(dir, 'log.jsonl') }));
          budget.charge(result.tokens, 80000); saveBudget();
          const ids = new Set(captureBefore.states.flatMap(state => state.findings.map(item => item.fingerprint)));
          if (result.report.verdicts.every(verdict => ids.has(verdict.id)) && result.report.issues.every(issue => images.some(image => image.name === issue.image))) review = { report: result.report, images };
          else visionNotes = 'The screenshot review cited something it was not given and was ignored.';
        } catch (error) { signal.throwIfAborted(); visionNotes = `Screenshot review failed: ${error.message.slice(0, 120)}`; }
      } else if (captureBefore.needsVision?.length && !visionRole.target) visionNotes = 'No Antigravity model for screenshots; layout measurements are reported without a visual second opinion.';
      const verdictOf = new Map((review?.report.verdicts || []).map(verdict => [verdict.id, verdict]));
      for (const state of captureBefore.states) for (const item of state.findings) {
        if (!SEVERE(item) || !item.isNew) continue;
        const verdict = verdictOf.get(item.fingerprint);
        if (verdict?.verdict === 'false-positive') continue;
        visualItems.push(visualFinding(state, item, verdict, routeOf));
      }
      for (const issue of review?.report.issues || []) {
        const state = review.images.find(image => image.name === issue.image).state;
        visualItems.push({ source: 'visual', title: `${issue.title} (${state.id})`.slice(0, 190), severity: issue.severity, status: 'observed', kind: 'bug', area: 'visual', confidence: 7,
          evidence: [{ file: `ui:${state.id}`, line: 1, detail: `Seen in ${issue.image} on ${routeOf(state)} at ${state.width}px` }], expected: issue.expected, observed: issue.observed,
          fixPrompt: `A vision model looking at the page ${routeOf(state)} at ${state.width}px saw: ${issue.title}. Observed: ${issue.observed} Expected: ${issue.expected} Find the markup and styles responsible, fix them, and keep every other page unchanged.`,
          confirmation: 'Seen by a vision model in a cropped screenshot; no script measured it.', aspects: ['visual'], agreement: 1 });
      }
    }
    const fresh = [...measured, ...confirmed, ...visualItems.slice(0, MAX_VISUAL)];
    const queue = [...backlog.map(item => ({ ...item, agreement: item.agreement || 1, aspects: item.aspects || [] })), ...fresh].sort((a, b) => priority(a) - priority(b));
    queue.forEach((item, index) => { item.id = `F${index + 1}`; });
    cp.data.queue = queue; cp.data.confirm = { proposed: proposed.length, confirmed: confirmed.length, rejected, unchecked: unchecked.length };
    cp.data.suggestions = suggestions; cp.data.compliance = compliance; cp.data.unchecked = unchecked.slice(0, 12); cp.data.fresh = fresh.map(publicFinding); cp.data.visionNotes = visionNotes; cp.save();
  }

  // ---- fix
  const queue = cp.data.queue;
  const batch = queue.slice(0, fixLimit), rest = queue.slice(fixLimit);
  const mutex = new Mutex();
  const fixPool = agents.createPool({ limit: options.parallelFixes, slots, signal });
  live.fixes = batch.map(item => ({ id: item.id, title: item.title, state: cp.data.fixes[item.id]?.status || 'queued' }));
  if (batch.length) report('fix', { note: `${batch.length} fix${batch.length === 1 ? '' : 'es'}, up to ${options.parallelFixes} at a time` });
  const setFixState = (item, state) => { const entry = live.fixes.find(fix => fix.id === item.id); if (entry) entry.state = state; report('fix'); };
  const fixOne = async item => {
    const saved = cp.data.fixes[item.id];
    if (saved && FINAL.has(saved.status)) { item.fix = saved; return; }
    const role = await resolveRole(item.area === 'visual' ? 'visualEditor' : 'editor', { area: item.area });
    if (!role.target) { item.fix = cp.data.fixes[item.id] = { status: 'skipped', reason: role.skipped?.[0]?.reason || 'No editor with spare quota is available for this kind of work' }; cp.save(); setFixState(item, 'skipped'); return; }
    if (expired()) { item.fix = cp.data.fixes[item.id] = { status: 'skipped', reason: 'Time budget used up' }; cp.save(); setFixState(item, 'skipped'); return; }
    await gate(signal);
    item.fix = { status: 'running', agent: role.target.agent, model: role.target.model };
    setFixState(item, 'running');
    // One attempt: a private worktree, the editor, a quick gate, then a one-at-a-time merge into the loop's copy.
    const attempt = async () => {
      const worktree = addWorktree(checkout, workspace, job.root, item.id);
      try {
        const done = await edit({ target: role.target, cwd: worktree, prompt: fixPromptFor(item, worktree), signal, timeoutMs: job.limits.fixMinutes * 60000, logFile: path.join(directory, `fix-${item.id}.jsonl`) });
        const answer = { reply: String(done.reply || '').slice(0, 1500), usage: done.tokens };
        if (!dirty(worktree)) return { ...answer, status: 'nochange', reason: 'The editor changed nothing' };
        const rejected = await quickGate({ profile, cwd: worktree, signal, exec });
        if (rejected) return { ...answer, status: 'rejected', reason: rejected };
        git(worktree, ['add', '-A']); git(worktree, ['commit', '-q', '-m', `${item.id}: ${item.title}`.slice(0, 200)]);
        const sha = head(worktree);
        return await mutex.run(async () => {
          try { git(checkout, ['cherry-pick', sha]); return { ...answer, status: 'applied', commit: head(checkout), source: sha }; }
          catch { git(checkout, ['cherry-pick', '--abort'], { allowFail: true }); revert(checkout); return { ...answer, status: 'conflict', reason: 'The change collided with another fix and will be retried next cycle' }; }
        });
      } finally { removeWorktree(checkout, worktree, item.id); }
    };
    try {
      const outcome = await fixPool.run(attempt);
      if (outcome.status !== 'conflict') item.attempts = (item.attempts || 0) + 1;
      Object.assign(item.fix, outcome);
    } catch (error) {
      signal.throwIfAborted();
      item.attempts = (item.attempts || 0) + 1;
      Object.assign(item.fix, { status: 'failed', reason: error.message.slice(0, 240) });
    }
    cp.data.fixes[item.id] = item.fix; cp.save(); setFixState(item, item.fix.status);
  };
  await Promise.all(batch.map(fixOne));

  // ---- verify
  let applied = batch.filter(item => item.fix?.status === 'applied');
  let after = [], verification = null, regressions = [], visualAfter = null, newVisual = [];
  if (applied.length) {
    report('verify', { note: 'Running the checks again' });
    if (!cp.data.after) {
      let afterChecks = await runChecks({ profile, checkout, directory, signal, prefix: 'after-', exec });
      let broke = afterChecks.filter(log => failed(log) && before.some(was => was.name === log.name && passed(was)));
      if (broke.length) {
        report('verify', { note: `${broke.map(log => log.name).join(', ')} turned red; isolating the change that did it` });
        const names = broke.map(log => log.name);
        git(checkout, ['reset', '--hard', '-q', cycleStart]);
        for (const item of applied) {
          try { git(checkout, ['cherry-pick', item.fix.source]); } catch { git(checkout, ['cherry-pick', '--abort'], { allowFail: true }); revert(checkout); Object.assign(item.fix, { status: 'conflict', reason: 'The change collided while re-checking' }); continue; }
          const test = await runChecks({ profile, checkout, directory, signal, prefix: 'isolate-', only: names, exec });
          const bad = test.filter(failed);
          if (bad.length) { git(checkout, ['reset', '--hard', '-q', 'HEAD~1']); regressions.push({ id: item.id, title: item.title, checks: bad.map(log => log.name) }); Object.assign(item.fix, { status: 'regressed', reason: `Made the "${bad[0].name}" check fail, so it was thrown out` }); }
          else item.fix.commit = head(checkout);
        }
        afterChecks = await runChecks({ profile, checkout, directory, signal, prefix: 'after-', exec });
        applied = applied.filter(item => item.fix.status === 'applied');
      }
      cp.data.after = { checks: afterChecks, regressions, fixes: Object.fromEntries(batch.map(item => [item.id, item.fix])) }; cp.save();
    } else { after = cp.data.after.checks; regressions = cp.data.after.regressions; for (const item of batch) if (cp.data.after.fixes[item.id]) item.fix = cp.data.after.fixes[item.id]; applied = batch.filter(item => item.fix?.status === 'applied'); }
    after = cp.data.after.checks;

    if (applied.length && captureBefore && !cp.data.visualAfter) {
      report('verify', { note: 'Looking at the pages again' });
      const shot = await capture({ profile, checkout, directory, name: 'capture-after', signal, choice: options.visual, baselineDir, accept: true, visorDir }).catch(error => { signal.throwIfAborted(); return { ok: false, reason: error.message }; });
      cp.data.visualAfter = { ok: shot.ok, reason: shot.reason, captureDir: shot.captureDir }; cp.save();
    }
    visualAfter = cp.data.visualAfter;
    const captureAfter = readCapture(visualAfter);
    if (captureAfter && captureBefore) {
      const was = new Set(captureBefore.states.flatMap(state => state.findings.map(item => item.fingerprint)));
      for (const state of captureAfter.states) for (const item of state.findings) if (SEVERE(item) && !was.has(item.fingerprint)) newVisual.push(visualFinding(state, item, null, routeOf));
    }

    // Judges read every diff. They are an extra opinion; the checks above are the hard evidence.
    const judge = applied.length ? await resolveRole('scout') : { target: null };
    if (judge.target && applied.length && !expired() && budget.remaining >= MIN_CALL_TOKENS) {
      const groups = []; for (let index = 0; index < applied.length; index += JUDGE_BATCH) groups.push(applied.slice(index, index + JUDGE_BATCH));
      const supplied = readContents(checkout);
      const verdicts = new Map(), more = [];
      await Promise.all(groups.map(async (group, index) => {
        const dir = path.join(directory, 'judge', String(index + 1)); fs.mkdirSync(dir, { recursive: true });
        const blocks = group.map(item => `FIX ${item.id}: ${item.title}\nProblem: ${item.observed}\nExpected: ${item.expected}\nEditor (${item.fix.agent}) said: ${item.fix.reply}\nDiff:\n${scrub(git(checkout, ['show', '--format=', '-U15', item.fix.commit]).slice(0, 9000))}`);
        const prompt = `${schemaNote(JUDGE_SCHEMA)}\nChecks before the fixes: ${JSON.stringify(before.map(({ name, exitCode, output }) => ({ name, exitCode, output: scrub(tail(output, 1500)) })))}\nChecks after the fixes: ${JSON.stringify(after.map(({ name, exitCode, output }) => ({ name, exitCode, output: scrub(tail(output, 1500)) })))}\n\n${blocks.join('\n\n').slice(0, 50000)}`;
        fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
        try {
          await gate(signal);
          const result = await pool.run(() => analyze({ target: judge.target, cwd: dir, prompt, task: JUDGE_TASK, schema: JUDGE_SCHEMA, supplied, signal, maxTokens: Math.min(450000, budget.remaining), logFile: path.join(dir, 'log.jsonl') }));
          budget.charge(result.tokens, 100000); saveBudget();
          for (const verdict of result.report.verdicts) verdicts.set(verdict.id, verdict);
          more.push(...result.report.newIssues);
        } catch (error) { signal.throwIfAborted(); budget.charge(null, 20000); }
      }));
      verification = { verdicts, newIssues: more };
    }
    for (const item of applied) {
      const verdict = verification?.verdicts.get(item.id);
      if (!verdict) { item.fix.status = 'unverified'; item.fix.reason = item.fix.reason || (after.length ? 'The checks ran, but no reviewer judged the diff' : 'No checks and no reviewer'); }
      else { item.fix.status = verdict.verdict; item.fix.reason = verdict.reason; }
    }
  }

  // ---- report
  report('report', { note: 'Writing the report' });
  const status = name => batch.filter(item => item.fix?.status === name);
  const retry = batch.filter(item => !['fixed', 'unverified', 'applied'].includes(item.fix?.status));
  const newIssues = [...(verification?.newIssues || []).map(issue => ({ ...issue, source: 'judge', aspects: ['judge'], agreement: 1 })), ...newVisual.slice(0, 4)].map((issue, index) => Object.assign(issue, { id: `N${index + 1}` }));
  const nextBacklog = [...retry.filter(item => (item.attempts || 0) < MAX_ATTEMPTS && item.fix?.status !== 'skipped').map(item => carry(item, item.fix?.reason)), ...retry.filter(item => item.fix?.status === 'skipped').map(item => carry(item)),
    ...newIssues.map(issue => carry(issue)), ...rest.map(item => carry(item))].slice(0, MAX_BACKLOG);
  const extra = [...(cp.data.compliance || []), ...(cp.data.suggestions || []), ...(cp.data.unchecked || [])].map((item, index) => ({ ...item, id: `S${index + 1}` }));
  const patch = git(checkout, ['diff', baseline, 'HEAD']);
  if (patch) fs.writeFileSync(path.join(directory, 'changes.patch'), patch);
  const agentsList = aspects.map(aspect => ({ id: aspect.id, label: aspect.label, short: aspect.short, ...(cp.data.scouts[aspect.id] ? { status: cp.data.scouts[aspect.id].status, found: cp.data.scouts[aspect.id].found || 0, reason: cp.data.scouts[aspect.id].reason } : { status: 'skipped' }) }));
  const loop0 = { mode: fixLimit ? 'fix' : 'find' };
  const loop = { lens: 'full', mode: loop0.mode, fixed: status('fixed').map(item => summarize(item)), unverified: status('unverified').map(item => summarize(item)),
    unfixed: retry.map(item => summarize(item, { gaveUp: (item.attempts || 0) >= MAX_ATTEMPTS })), newIssues: newIssues.map(issue => summarize(issue)),
    found: loop0.mode === 'find' ? queue.map(item => summarize(item)) : [],
    additional: [...(loop0.mode === 'fix' ? rest.map(item => summarize(item)) : []), ...extra.map(item => summarize(item, { reason: item.kind === 'compliance' ? 'An indicator for you to judge, not a legal verdict; never changed automatically' : item.suggestion ? 'Suggestion only; never changed automatically' : 'Not confirmed by a verifier' }))],
    verified: Boolean(verification), checksBefore: before.map(({ name, exitCode }) => ({ name, exitCode })), checksAfter: after.map(({ name, exitCode }) => ({ name, exitCode })),
    patch: patch ? 'changes.patch' : null, agents: agentsList, confirm: cp.data.confirm, regressions,
    visual: { provider: visualBefore.provider, ok: Boolean(visualBefore.ok), reason: visualBefore.reason || cp.data.visionNotes || '', routes: visualBefore.routes || [], states: captureBefore?.summary?.states || 0, measured: captureBefore?.summary?.newFindings || 0, afterOk: Boolean(visualAfter?.ok) },
    profile: { kind: profile.kind, label: profile.label, checks: profile.checks.map(check => check.name) }, tokens: { spent: budget.spent, unknown: budget.unknown } };
  const confirmed = cp.data.confirm?.confirmed || 0;
  const summary = [`${aspects.length} scouts read ${profile.label}: ${cp.data.confirm?.proposed || 0} candidates, ${confirmed} confirmed, ${cp.data.confirm?.rejected || 0} refuted.`,
    loop.mode === 'fix' ? `${loop.fixed.length} fixed and verified, ${loop.unverified.length} applied but unverified, ${loop.unfixed.length} unfixed, ${loop.newIssues.length} new from verification, ${rest.length} queued.` : `Find only: ${queue.length} problem${queue.length === 1 ? '' : 's'} listed, nothing edited.`,
    cp.data.compliance?.length ? `${cp.data.compliance.length} EU compliance indicator${cp.data.compliance.length === 1 ? '' : 's'} to review (not legal advice).` : '',
    regressions.length ? `${regressions.length} fix${regressions.length === 1 ? ' was' : 'es were'} thrown out for breaking a check.` : '', cp.data.visionNotes || ''].filter(Boolean).join(' ');
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ summary, loop, findings: cp.data.fresh || [] }, null, 2));
  if (captureBefore || visualAfter?.ok) adoptBaseline(visualAfter?.ok ? visualAfter.captureDir : visualBefore.captureDir, baselineDir);
  const clean = !queue.length && !newIssues.length;
  const cleanStreak = clean ? (job.cleanStreak || 0) + 1 : 0;
  const done = loop.mode === 'find' ? cycle + 1 >= shards : cleanStreak >= shards && !nextBacklog.length;
  const artifacts = ['report.json', 'changes.patch', 'capture.txt', 'capture-after.txt'].map(name => path.join(directory, name)).filter(file => fs.existsSync(file));
  for (const name of fs.existsSync(path.join(directory, 'checks')) ? fs.readdirSync(path.join(directory, 'checks')) : []) artifacts.push(path.join(directory, 'checks', name));
  return { summary, findings: cp.data.fresh || [], questions, loop, backlog: nextBacklog, cleanStreak, done, finishedReason: done ? (loop.mode === 'find' ? 'Finished: every part of the project was reviewed' : 'Finished: nothing left to fix') : '',
    handled: [...(job.handled || []), ...loop.fixed.map(item => item.title)].slice(-40), tokens: budget.spent, fingerprint, fingerprintKey: 'full', shards, snapshotHash: cycleStart, artifacts };
}

/** Rewinds the copy to the start of the cycle and re-applies the fixes that were recorded as merged, so a resumed run starts from a known state. */
function restoreApplied(checkout, cycleStart, fixes) {
  git(checkout, ['cherry-pick', '--abort'], { allowFail: true });
  git(checkout, ['reset', '--hard', '-q', cycleStart]);
  for (const fix of Object.values(fixes || {})) {
    if (fix?.status !== 'applied' || !fix.source) continue;
    try { git(checkout, ['cherry-pick', fix.source]); fix.commit = head(checkout); }
    catch { git(checkout, ['cherry-pick', '--abort'], { allowFail: true }); revert(checkout); fix.status = 'conflict'; fix.reason = 'The change could not be restored after a restart and will be retried'; }
  }
}

/** A quick guard for one fix before it is merged: changed JSON must parse, changed scripts must compile, and the profile's quick checks must pass. Returns a reason or ''. */
async function quickGate({ profile, cwd, signal, exec = run }) {
  const changed = git(cwd, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean).map(line => line.slice(3).replace(/^"|"$/g, '')).filter(file => !file.endsWith('/'));
  const node = nodeCommand();
  for (const file of changed) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) continue;
    if (/\.json$/i.test(file)) { try { JSON.parse(fs.readFileSync(full, 'utf8')); } catch (error) { return `${file} is no longer valid JSON`; } }
    if (/\.(?:[cm]?js)$/i.test(file)) {
      const result = await exec(node.command, ['--check', file], { cwd, signal, env: node.env, timeoutMs: 30000 }).catch(error => { signal.throwIfAborted(); return { code: null, stderr: error.message }; });
      if (result.code) return `${file} does not compile: ${tail(result.stderr, 200).trim()}`;
    }
  }
  for (const check of profile.checks.filter(check => check.gate)) {
    const result = await exec(check.command, check.args, { cwd, signal, env: check.env, timeoutMs: check.timeoutMs, idleMs: 5 * 60000 }).catch(error => { signal.throwIfAborted(); return { code: null, output: '', stderr: error.message }; });
    if (result.code) return `The "${check.name}" check failed after the change: ${tail((result.output || '') + (result.stderr || ''), 200).trim()}`;
  }
  return '';
}

module.exports = { fullCycle, runChecks, mergeFindings, checkFinding, openCheckpoint, quickGate, evidenceFromOutput, priority, Budget, fixPromptFor, similar };
