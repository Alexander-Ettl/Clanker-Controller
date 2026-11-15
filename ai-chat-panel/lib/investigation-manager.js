'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { usageTotal } = require('./investigation-runner');
const { removeTree } = require('./loop-workspace');
const { Semaphore, sleep } = require('./loop-exec');
const { ROLES } = require('./loop-roles');

const DEFAULTS = Object.freeze({ intervalMinutes: 0, maxRuns: 4, maxRunMinutes: 8,
  maxTokensPerRun: 250000, reservePercent: 50, editorReservePercent: 20,
  hourlyTokens: 1000000, fixesPerCycle: 3, fixMinutes: 12 });
// The fix loop works in cycles of one lens each; its defaults are tighter per hour and longer per run than a diagnosis.
const FIX_DEFAULTS = Object.freeze({ ...DEFAULTS, maxRuns: 6, maxRunMinutes: 45, maxTokensPerRun: 300000,
  hourlyTokens: 600000 });
// The interface tester spends tokens only on a handful of cropped pictures, so its allowance per run is small.
const TESTER_DEFAULTS = Object.freeze({ ...DEFAULTS, maxRuns: 6, maxRunMinutes: 15, maxTokensPerRun: 60000,
  hourlyTokens: 1200000 });
// The full loop: ten scouts, refutation, parallel fixes, regression checks and visual checks in one run. It is bounded by what it
// reserves and by its own per-call limits, not by one wall clock; maxRunMinutes is a soft budget after which it wraps up.
const FULL_DEFAULTS = Object.freeze({ ...DEFAULTS, maxRuns: 8, maxRunMinutes: 180, maxTokensPerRun: 3000000, hourlyTokens: 10000000, fixesPerCycle: 6, fixMinutes: 20 });
// Overnight: many cycles with a pause between them, a lower Gemini reserve (the scouts' pool is rarely more than half used) and a low
// reserve for the Claude/Codex editors, whose quota is checked before every fix. A cycle whose editors are out of quota does not
// rescan: the loop waits for the reset (see `waiting` in execute) and carries on, so a night is not spent on repeated scouting.
const OVERNIGHT_LIMITS = Object.freeze({ maxRuns: 12, intervalMinutes: 10, maxRunMinutes: 150, reservePercent: 25, editorReservePercent: 15, fixesPerCycle: 8, fixMinutes: 20 });
const WAIT_MIN_MS = 5 * 60000, WAIT_MAX_MS = 4 * 3600000, WAIT_GUESS_MS = 30 * 60000;
const RECIPE_DEFAULTS = { diagnose: DEFAULTS, fixloop: FIX_DEFAULTS, tester: TESTER_DEFAULTS, full: FULL_DEFAULTS };
const RECIPES = ['diagnose', 'fixloop', 'tester', 'full'];
const VISUAL_CHOICES = ['auto', 'visor', 'playwright', 'off'];
const TOPICS = ['project binding and scheduling', 'cancellation and interrupted runs',
  'quota handling and model selection', 'composer and queue behavior'];
const LENSES = ['bugs', 'code review', 'security review', 'simplification'];
const topicFor = (job, n) => job.recipe === 'full' ? `Full review, cycle ${(job.cycles || 0) + 1}` : job.recipe === 'tester' ? 'interface testing' : job.recipe === 'fixloop' ? `${LENSES[n % LENSES.length]}: ${TOPICS[Math.floor(n / LENSES.length) % TOPICS.length]}` : TOPICS[n % TOPICS.length];
const YIELDED = 'Yielded to foreground work', MAX_YIELDS = 3; // After three yields in a row an older loop stops instead of re-spending its reservation.
const HOST_CLOSING = 'The IDE is closing', MAX_RESUMES = 12, MAX_FAILURES = 3, GATE_MAX_MS = 20 * 60000;
const SLEPT = 'Computer slept during the run', SLEEP_GAP_MS = 30000, PRE_MODEL_STAGES = ['snapshot', 'syntax', 'tests', 'render', 'capture', 'triage', 'prepare', 'check'];
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const identifier = /^[\w.:-]{1,80}$/;

function validateLimits(input = {}) {
  const { dailyTokens, dailyRuns, ...current } = input; // the daily allowance was removed; saved loops may still carry it
  const limits = { ...DEFAULTS, ...current };
  const ranges = { intervalMinutes: [0, 1440], maxRuns: [1, 24], maxRunMinutes: [1, 720],
    maxTokensPerRun: [1000, 6000000], reservePercent: [25, 95], editorReservePercent: [0, 95],
    hourlyTokens: [1000, 30000000], fixesPerCycle: [0, 12], fixMinutes: [1, 60] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max) throw new Error(`Invalid ${key}: use ${min}–${max}.`);
  }
  if (Object.keys(limits).some(key => !ranges[key])) throw new Error('Unknown investigation limit.');
  if (limits.hourlyTokens < limits.maxTokensPerRun) throw new Error('Hourly allowance must cover one reserved run.');
  return limits;
}

/** Which model does which job. Only the four known roles; "auto" is the absence of a choice. */
function cleanRoles(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid model roles.');
  const roles = {};
  for (const [role, value] of Object.entries(input)) {
    if (!ROLES.includes(role) || typeof value !== 'string' || !identifier.test(value)) throw new Error('Invalid model roles.');
    if (value !== 'auto') roles[role] = value;
  }
  return roles;
}
function cleanOptions(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid loop options.');
  const options = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'visual' && VISUAL_CHOICES.includes(value)) options.visual = value;
    else if (key === 'agents' && Number.isInteger(value) && value >= 1 && value <= 10) options.agents = value;
    else if (key === 'parallelFixes' && Number.isInteger(value) && value >= 1 && value <= 6) options.parallelFixes = value;
    else throw new Error('Invalid loop options.');
  }
  return options;
}

class InvestigationManager extends EventEmitter {
  constructor({ storageDir, projects, runner, readQuota, isForegroundBusy = () => false, availableModels = () => [], now = Date.now, pollMs = 15000, maxParallel = () => 1, maxAgents = () => 12,
    keepAwake = null, resolveFixer = async () => null, resolveRole = async () => ({ target: null, skipped: [] }), canRun = () => ({ ok: true }), visorDir = () => null, compliance = () => ({}) }) {
    super();
    Object.assign(this, { projects, runner, readQuota, isForegroundBusy, availableModels, now, pollMs, maxParallel, resolveFixer, roleResolver: resolveRole, canRun, visorDir, compliance, keepAwakeFactory: keepAwake });
    this.actives = new Map(); this.pending = new Set(); this.admitting = false; this.disposed = false; this.awake = null; this.saveTimer = null;
    this.slots = new Semaphore(Number(maxAgents()) || 12); this.maxAgents = maxAgents;
    this.dir = path.join(storageDir, 'investigations');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'manager.json');
    this.lock = path.join(this.dir, 'manager.lock');
    try { fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(fs.readFileSync(this.lock, 'utf8'));
      let alive = true;
      try { process.kill(owner, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Another investigation manager owns this storage.');
      fs.unlinkSync(this.lock);
      fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx' });
    }
    try {
      this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
        : { version: 1, jobs: [], runs: [], ledger: {} };
      if (this.state.version !== 1 || !Array.isArray(this.state.jobs) || !Array.isArray(this.state.runs) || !this.state.ledger) throw new Error('Invalid investigation state.');
      for (const entry of Object.values(this.state.ledger)) if (!Number.isFinite(entry.tokens) || entry.tokens < 0 || !Number.isInteger(entry.runs) || entry.runs < 0) throw new Error('Invalid persisted investigation allowance.');
      for (const job of this.state.jobs) {
        job.limits = validateLimits(job.limits); job.recipe ||= 'diagnose';
        if (!(job.expiresAt === null && job.recipe === 'full') && !Number.isFinite(job.expiresAt) || !Number.isInteger(job.completedRuns)) throw new Error('Invalid persisted investigation task.');
      }
      // Older interface runs discarded repeated findings and charged only the reservation after a failed visual pass.
      // Recover from their own artifacts while holding the manager lock, never by editing a live manager's state file.
      for (const run of this.state.runs.filter(run => run.topic === 'interface testing' && run.status === 'completed' && !run.reportRecovered)) {
        const directory = path.resolve(this.dir, run.id);
        if (path.dirname(directory) !== this.dir) continue;
        const reportFile = path.join(directory, 'report.json');
        if (fs.existsSync(reportFile)) {
          const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
          if (Array.isArray(report.findings)) run.findings = report.findings.map(finding => ({ ...finding, fingerprint: hash(JSON.stringify([finding.title, finding.evidence])) }));
          run.reviewIncomplete = Boolean(run.questions?.length);
          if (run.reviewIncomplete && run.summary) run.summary = run.summary.replace(/\d+ pictures? reviewed by Flash\./, 'Visual review incomplete.');
        }
        const logFile = path.join(directory, 'flash.jsonl');
        if (fs.existsSync(logFile)) {
          for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (event.event !== 'result') continue;
            const tokens = usageTotal(event.result?.usage || event.usage);
            if (tokens === null) continue;
            const ledger = this.state.ledger[run.day];
            if (ledger) ledger.tokens += tokens - run.chargedTokens;
            run.tokenUsage = run.chargedTokens = tokens;
          }
        }
        const job = this.state.jobs.find(job => job.id === run.jobId);
        if (job && run.chargedTokens > job.limits.maxTokensPerRun) { job.enabled = false; job.reason = 'Usage exceeded run allowance; review required'; }
        run.reportRecovered = true;
      }
      // Skipped runs used to be kept as empty reports; they carry no information.
      this.state.runs = this.state.runs.filter(run => run.status !== 'skipped');
      // A run that was in flight when the IDE closed (or crashed) is not lost: its loop stays armed and the run continues from
      // its checkpoint once the manager polls. Its reservation is kept, so the hourly allowance still counts it.
      for (const run of this.state.runs.filter(run => run.status === 'running')) {
        run.status = 'interrupted'; run.finishedAt = this.now();
        const job = this.state.jobs.find(job => job.id === run.jobId);
        if (job?.enabled) { run.reason = 'The IDE closed; the run resumes automatically'; job.resumeRunId = run.id; job.nextRunAt = this.now(); job.reason = 'Resuming after a restart'; }
        else { run.reason = 'Host restarted; reserved usage retained'; if (job) { job.enabled = false; job.reason = run.reason; } }
      }
      this.persist();
    } catch (error) { fs.unlinkSync(this.lock); throw error; }
  }

  get ticking() { return this.admitting || this.pending.size > 0; }
  get active() { return this.actives.values().next().value || null; }
  persist() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.file);
    this.syncAwake();
    this.emit('change', this.snapshot());
  }
  /** Progress inside a stage changes often (ten scouts report as they go); write it a moment later instead of every time. */
  persistSoon() { if (!this.saveTimer && !this.disposed) { this.saveTimer = setTimeout(() => { this.saveTimer = null; if (!this.disposed) this.persist(); }, 400); this.saveTimer.unref?.(); } }
  // A sleeping computer freezes every run and timer, so hold the system awake while anything is armed or running.
  syncAwake() {
    const needed = !this.disposed && (this.actives.size > 0 || this.state.jobs.some(job => job.enabled));
    if (needed && !this.awake && this.keepAwakeFactory) {
      try { this.awake = this.keepAwakeFactory({ onChange: () => { if (!this.disposed) this.emit('change', this.snapshot()); }, onError: error => this.emit('managerError', error) }) || null; } catch (error) { this.emit('managerError', error); }
    } else if (!needed && this.awake) { try { this.awake.release(); } finally { this.awake = null; } }
  }
  snapshot() {
    const ids = [...this.actives.values()].map(entry => entry.run.id);
    return clone({ ...this.state, defaults: DEFAULTS, fixDefaults: FIX_DEFAULTS, testerDefaults: TESTER_DEFAULTS, fullDefaults: FULL_DEFAULTS, recipes: RECIPES, topics: TOPICS, lenses: LENSES, activeRunId: ids[0] || null, activeRunIds: ids, maxParallel: this.parallelLimit(), keepingAwake: Boolean(this.awake && this.awake.active !== false) });
  }
  parallelLimit() { const value = Math.floor(Number(this.maxParallel())); return Number.isFinite(value) ? Math.min(4, Math.max(1, value)) : 1; }
  create({ projectId, model = 'gemini-3.8-flash-high', recipe = 'diagnose', mode, roles, options, limits = {}, expiresAt } = {}) {
    if (!RECIPES.includes(recipe)) throw new Error('Unknown investigation recipe.');
    const full = recipe === 'full';
    const project = this.projects.get(projectId);
    if (!project?.root || !fs.statSync(project.root).isDirectory()) throw new Error('Select a registered code project.');
    if (!full && !/^gemini-[\d.]+-flash(?:-(?:low|medium|high))?$/.test(model)) throw new Error('Investigations require an explicit Flash model.');
    if (expiresAt === undefined) expiresAt = full ? null : this.now() + 8 * 3600000;
    const horizon = full ? 7 * 24 : 24;
    if (!(full && expiresAt === null) && (!Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + horizon * 3600000)) throw new Error(`Expiry must be within the next ${horizon === 24 ? '24 hours' : '7 days'}.`);
    if (mode !== undefined && !['fix', 'find'].includes(mode)) throw new Error('Mode must be fix or find.');
    const job = { id: crypto.randomUUID(), projectId, root: fs.realpathSync.native(project.root), model: full ? '' : model,
      recipe, limits: validateLimits({ ...RECIPE_DEFAULTS[recipe], ...limits }), expiresAt, enabled: false, nextRunAt: this.now(), completedRuns: 0,
      fingerprints: {}, backlog: [], handled: [], cleanStreak: 0, reason: 'Ready; start explicitly', createdAt: this.now(),
      ...(full ? { mode: mode || 'fix', roles: cleanRoles(roles), options: cleanOptions(options), cycles: 0 } : {}) };
    this.state.jobs.push(job); this.persist(); return clone(job);
  }
  job(id) { const job = this.state.jobs.find(job => job.id === id); if (!job) throw new Error('Investigation not found.'); return job; }
  configure(id, limits, extra = {}) {
    const job = this.job(id);
    if (job.enabled || this.actives.has(id)) throw new Error('Pause the investigation before changing limits.');
    job.limits = validateLimits({ ...job.limits, ...limits });
    if (job.recipe === 'full') {
      if (extra.mode !== undefined) { if (!['fix', 'find'].includes(extra.mode)) throw new Error('Mode must be fix or find.'); job.mode = extra.mode; }
      if (extra.roles !== undefined) job.roles = cleanRoles(extra.roles);
      if (extra.options !== undefined) job.options = cleanOptions(extra.options);
    }
    this.persist(); return clone(job);
  }
  // Skips the spacing wait and the foreground-priority rule (the run works on a frozen copy, so the user's own chats
  // are no reason to hold it back). The quota and allowance checks still apply. `forced` lasts until that run ends.
  runNow(id) {
    const job = this.job(id);
    if (!job.enabled || this.actives.has(id)) throw new Error('Only a waiting loop can run now.');
    job.forced = true; job.nextRunAt = this.now(); this.persist(); void this.tick();
  }
  /** Foreground chats make a loop wait or yield, unless the user pressed Run now for it. */
  yieldsToForeground(job) { return !job?.forced && this.isForegroundBusy(); }
  start(id) {
    const job = this.job(id);
    if ((job.expiresAt && job.expiresAt <= this.now()) || job.completedRuns >= job.limits.maxRuns) throw new Error('This investigation has finished or expired. Create a new loop.');
    delete job.forced; delete job.failures; job.startedAt = this.now(); job.enabled = true; job.reason = 'Waiting for idle time and verified spare quota'; this.persist(); void this.tick();
  }
  pause(id) {
    const job = this.job(id); delete job.forced; delete job.resumeRunId; job.enabled = false; job.reason = 'Paused by user';
    this.actives.get(id)?.controller.abort(new Error(job.reason));
    this.persist();
  }
  /** Deletes a task and its loop workspace. Its reports stay as history and its spent allowance stays in the ledger. */
  remove(id) {
    const job = this.job(id);
    job.enabled = false; job.reason = 'Task deleted';
    this.state.jobs = this.state.jobs.filter(item => item !== job);
    const entry = this.actives.get(id);
    if (entry) entry.controller.abort(new Error('Task deleted')); // the workspace is removed once that run has settled
    else this.discardWorkspace(job);
    this.persist();
  }
  discardWorkspace(job) {
    try { removeTree(path.join(this.dir, 'workspaces', job.id)); } catch (error) { this.emit('managerError', error); }
  }
  /** The only way a running loop ends other than finishing: the user asks. Closing the IDE does not come through here. */
  stopAll() { for (const job of this.state.jobs.filter(job => job.enabled || this.actives.has(job.id))) { job.enabled = false; delete job.resumeRunId; job.reason = 'Stopped by user'; } for (const entry of this.actives.values()) entry.controller.abort(new Error('Stopped by user')); this.persist(); }
  startPolling() {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // A loop that was running when the IDE closed is picked up right away, without waiting for the first poll.
    if (this.state.jobs.some(job => job.enabled && job.resumeRunId)) { const first = setTimeout(() => void this.tick(), 1500); first.unref?.(); }
  }
  defer(job, reason) { job.reason = reason; job.nextRunAt = this.now() + 60000; this.persist(); }

  async tick() {
    if (this.disposed) return;
    if (this.actives.size && this.isForegroundBusy()) for (const [id, entry] of this.actives) {
      const job = this.state.jobs.find(job => job.id === id);
      if (job?.recipe !== 'full' && this.yieldsToForeground(job)) entry.controller.abort(new Error(YIELDED)); // the full loop pauses between calls instead (gate)
    }
    if (this.admitting) return;
    this.admitting = true;
    const started = [];
    try {
      for (const candidate of this.state.jobs) {
        if (candidate.enabled && candidate.expiresAt && candidate.expiresAt <= this.now()) { candidate.enabled = false; candidate.reason = 'Expired'; this.persist(); }
      }
      // Admission is sequential so every run sees the reservations already made; started runs continue on their own.
      for (const job of this.state.jobs.filter(job => job.enabled && job.nextRunAt <= this.now() && !this.actives.has(job.id))) {
        if (this.disposed || this.actives.size >= this.parallelLimit()) break;
        const pendingAdmission = job.resumeRunId ? this.admitResume(job) : this.admit(job);
        const admitted = pendingAdmission && await pendingAdmission;
        if (!admitted) continue;
        const running = this.execute(job, admitted).finally(() => this.pending.delete(running));
        this.pending.add(running); started.push(running);
      }
    } catch (error) { this.emit('managerError', error); }
    finally { this.admitting = false; }
    await Promise.all(started);
  }

  /** Whether the job's models are usable right now: a pinned Flash model for older loops, the role resolver for the full loop. */
  unavailable(job) {
    if (job.recipe === 'full') { const check = this.canRun(job); return check.ok === false ? check.reason || 'No model is available for this loop' : ''; }
    return this.availableModels().includes(job.model) ? '' : 'Selected Flash model unavailable; no fallback';
  }

  // Synchronous checks first (a deferral never yields the event loop); only the quota read is awaited.
  admit(job) {
    if (this.yieldsToForeground(job)) return this.defer(job, 'Foreground work has priority');
    const project = this.projects.get(job.projectId);
    if (!project?.root || fs.realpathSync.native(project.root) !== job.root) { job.enabled = false; return this.defer(job, 'Project folder changed or became unavailable'); }
    const missing = this.unavailable(job);
    if (missing) return this.defer(job, missing);
    return Promise.resolve(this.readQuota()).then(quota => this.reserve(job, quota));
  }

  /** Continues a run that was interrupted by a restart or a retryable failure. Its reservation is still held; nothing is charged twice. */
  admitResume(job) {
    const run = this.state.runs.find(item => item.id === job.resumeRunId);
    if (!run || run.status === 'completed') { delete job.resumeRunId; return null; }
    const project = this.projects.get(job.projectId);
    if (!project?.root || fs.realpathSync.native(project.root) !== job.root) { job.enabled = false; delete job.resumeRunId; return this.defer(job, 'Project folder changed or became unavailable'); }
    const missing = this.unavailable(job);
    if (missing) return this.defer(job, missing);
    if (job.recipe !== 'full' && this.yieldsToForeground(job)) return this.defer(job, 'Foreground work has priority');
    if ((run.resumes || 0) >= MAX_RESUMES) { delete job.resumeRunId; job.enabled = false; job.reason = 'The run was interrupted too many times'; run.status = 'failed'; run.reason = job.reason; this.persist(); return null; }
    const ledger = this.state.ledger[run.day] ||= { tokens: 0, runs: 0 };
    if (run.chargedTokens < job.limits.maxTokensPerRun) { ledger.tokens += job.limits.maxTokensPerRun - run.chargedTokens; run.chargedTokens = job.limits.maxTokensPerRun; } // a refund for an early failure is taken back
    run.status = 'running'; run.resumes = (run.resumes || 0) + 1; delete run.reason; delete run.finishedAt;
    delete job.resumeRunId; job.reason = 'Resumed after a restart';
    const entry = { run, controller: new AbortController() }; this.actives.set(job.id, entry); this.persist();
    return entry;
  }

  reserve(job, quota) {
    if (!job.enabled || this.disposed) return null;
    if (!quota || !Number.isFinite(quota.remaining) || quota.assumedReset || !Number.isFinite(quota.observedAt) || this.now() - quota.observedAt > 60000
      || [quota, quota.secondary].filter(Boolean).some(window => !Number.isFinite(window.remaining) || window.remaining < job.limits.reservePercent || window.assumedReset)) {
      return this.defer(job, 'Verified spare quota unavailable');
    }
    if (this.yieldsToForeground(job)) return this.defer(job, 'Foreground work has priority');
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const ledger = this.state.ledger[day] ||= { tokens: 0, runs: 0 };
    const hourTokens = this.state.runs.filter(item => item.startedAt > this.now() - 3600000).reduce((sum, item) => sum + (item.chargedTokens || 0), 0);
    if (hourTokens + job.limits.maxTokensPerRun > job.limits.hourlyTokens) return this.defer(job, 'Hourly allowance reached');
    const run = { id: crypto.randomUUID(), jobId: job.id, projectId: job.projectId, model: job.model,
      topic: topicFor(job, job.completedRuns), status: 'running', startedAt: this.now(), day,
      chargedTokens: job.limits.maxTokensPerRun, tokenUsage: null, findings: [], quotaBefore: quota };
    // Reserve before starting any process; a crash cannot give that allowance back. Parallel runs each hold their own reservation.
    ledger.tokens += run.chargedTokens; ledger.runs++; job.completedRuns++;
    const controller = new AbortController(); const entry = { run, controller };
    this.actives.set(job.id, entry);
    this.state.runs.push(run); this.persist();
    return entry;
  }

  /** Holds a full-loop run between model calls while the user is working in the foreground, but never for more than twenty minutes at a time. */
  async gate(job, run, signal) {
    if (!this.yieldsToForeground(job)) return;
    const started = this.now();
    while (this.yieldsToForeground(job) && this.now() - started < GATE_MAX_MS) await sleep(2000, signal);
    run.pausedMs = (run.pausedMs || 0) + (this.now() - started);
  }

  async execute(job, { run, controller }) {
    const ledger = this.state.ledger[run.day];
    const full = job.recipe === 'full';
    const heart = { beat: this.now() };
    const slept = () => !full && this.now() - heart.beat > SLEEP_GAP_MS;
    try {
      // Older loops are cut off by a wall clock. The full loop is not: every model call and every process has its own inactivity
      // limit, and maxRunMinutes only tells it to stop starting new work and write its report.
      const timeout = full ? null : setTimeout(() => controller.abort(new Error('Run time limit reached')), Math.min(job.limits.maxRunMinutes * 60000, (job.expiresAt ?? Infinity) - this.now()));
      const yieldTimer = setInterval(() => {
        const gap = this.now() - heart.beat; heart.beat = this.now();
        if (full) return;
        if (gap > SLEEP_GAP_MS) controller.abort(new Error(SLEPT));
        else if (this.yieldsToForeground(job)) controller.abort(new Error(YIELDED));
      }, 2000);
      yieldTimer.unref?.(); // a runner that ignores its abort signal must not keep the process alive
      // While a full loop runs, the Gemini pool is read once a minute. Below half the admission reserve the loop stops starting model
      // calls and writes up what it has; the next cycle is then held back by admission until the pool has recovered.
      const gemini = { low: false };
      let quotaTimer = null;
      if (full) {
        const floor = Math.max(5, Math.floor(job.limits.reservePercent / 2));
        const poll = () => Promise.resolve().then(() => this.readQuota()).then(quota => { if (quota) gemini.low = [quota, quota.secondary].filter(Boolean).some(window => Number.isFinite(window.remaining) && window.remaining < floor); }).catch(() => {});
        void poll(); quotaTimer = setInterval(poll, 60000); quotaTimer.unref?.();
      }
      let result;
      try {
        result = await this.runner({ job: clone(job), run: clone(run), directory: path.join(this.dir, run.id), signal: controller.signal, resolveFixer: this.resolveFixer, quotaLow: () => gemini.low,
          resolveRole: (role, extra) => Promise.resolve(this.roleResolver(role, job, extra)), slots: this.slots, visorDir: this.visorDir(), compliance: this.compliance(),
          gate: signal => this.gate(job, run, signal), expired: () => this.now() > run.startedAt + job.limits.maxRunMinutes * 60000 + (run.pausedMs || 0),
          onProgress: (stage, live) => {
            if (controller.signal.aborted) return;
            const changed = run.stage !== stage; run.stage = stage;
            if (live) run.live = live;
            if (changed) this.persist(); else this.persistSoon();
          } });
      } finally { clearTimeout(timeout); clearInterval(yieldTimer); clearInterval(quotaTimer); }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (result.skipped) {
        // No model invocation happened, so there is nothing to report: the loop's own status carries the reason.
        ledger.tokens -= run.chargedTokens; ledger.runs--; job.completedRuns--;
        this.state.runs = this.state.runs.filter(item => item !== run);
        try { fs.rmSync(path.join(this.dir, run.id), { recursive: true, force: true }); } catch (error) { this.emit('managerError', error); }
        if (result.waiting) {
          // Blocked on the editors' quota: nothing is rescanned and nothing is spent. The loop stays armed and wakes at the reset.
          const at = Number.isFinite(result.retryAt) ? Math.min(this.now() + WAIT_MAX_MS, Math.max(this.now() + WAIT_MIN_MS, result.retryAt)) : this.now() + WAIT_GUESS_MS;
          job.nextRunAt = at; job.waitingSince ||= this.now();
          job.reason = `${result.reason}; waiting until ${new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
          this.persist(); return;
        }
        delete job.waitingSince;
        job.enabled = false; job.reason = result.finished ? `Finished: ${String(result.reason).replace(/^./, c => c.toLowerCase())}` : `${result.reason}; paused until restarted`;
        this.persist(); return;
      } else {
        if (Number.isFinite(result.tokens) && result.tokens >= 0) {
          run.tokenUsage = result.tokens; ledger.tokens += result.tokens - run.chargedTokens; run.chargedTokens = result.tokens;
        } else { job.enabled = false; job.reason = 'Usage unavailable; full reservation retained, review before resuming'; }
        job.yields = 0; job.failures = 0; delete job.waitingSince; run.status = 'completed'; run.artifacts = result.artifacts || []; run.snapshotHash = result.snapshotHash; delete run.live;
        const known = new Set(); // Deduplicate within this report; earlier reports cannot make this run look clean.
        run.findings = (result.findings || []).map(finding => ({ ...finding, fingerprint: hash(JSON.stringify([finding.title, finding.evidence])) }))
          .filter(finding => { if (known.has(finding.fingerprint)) return false; known.add(finding.fingerprint); return true; });
        run.questions = result.questions || []; run.summary = result.summary || '';
        run.reviewIncomplete = Boolean(result.reviewIncomplete); run.reportRecovered = true;
        job.fingerprints ||= {}; if (!run.reviewIncomplete) job.fingerprints[result.fingerprintKey || run.topic] = result.fingerprint;
        if (result.loop) { run.loop = result.loop; job.backlog = result.backlog; job.handled = result.handled; job.cleanStreak = result.cleanStreak; }
        if (full) { job.cycles = (job.cycles || 0) + 1; if (result.shards) job.shards = result.shards; }
        if (!full && run.tokenUsage > job.limits.maxTokensPerRun) { job.enabled = false; job.reason = 'Usage exceeded run allowance; review required'; }
        else if (run.reviewIncomplete && job.enabled) { job.enabled = false; job.reason = 'Visual review incomplete; review required'; }
      }
      run.finishedAt = this.now(); job.nextRunAt = this.now() + job.limits.intervalMinutes * 60000;
      if (result.done) { job.enabled = false; job.reason = result.finishedReason || 'Finished: nothing left to fix'; }
      else if (job.completedRuns >= job.limits.maxRuns) { job.enabled = false; job.reason = 'Run limit reached'; }
      else if (job.enabled) job.reason = 'Waiting for next investigation';
      this.persist();
    } catch (error) {
      const reason = slept() ? SLEPT : controller.signal.aborted ? controller.signal.reason?.message : error.message;
      const closing = reason === HOST_CLOSING;
      run.status = controller.signal.aborted || slept() ? 'interrupted' : 'failed'; run.reason = reason; run.finishedAt = this.now();
      if (Number.isFinite(error.tokenUsage) && error.tokenUsage > run.chargedTokens) {
        ledger.tokens += error.tokenUsage - run.chargedTokens; run.chargedTokens = error.tokenUsage;
      }
      if (closing) {
        // The IDE is closing, not the user stopping: keep the loop armed and the reservation held. The next start resumes this run.
        run.reason = 'The IDE closed; the run resumes automatically'; job.resumeRunId = run.id; job.nextRunAt = this.now(); job.reason = 'Resuming after a restart'; this.persist();
      } else {
        // Whatever ended it, a run that never reached the model spent no tokens: give the reservation back so one stuck
        // check cannot use up the day's allowance. The model may have been called once past those stages, so it stays charged then.
        if (ledger && PRE_MODEL_STAGES.includes(run.stage)) { ledger.tokens -= run.chargedTokens; run.chargedTokens = 0; }
        if (run.status === 'interrupted' && (reason === YIELDED || reason === SLEPT) && job.enabled && !this.disposed && (job.yields = (job.yields || 0) + 1) <= MAX_YIELDS) {
          // Foreground work and sleep are not faults: keep the job armed, retry shortly, and give the run slot back.
          if (ledger) ledger.runs--;
          job.completedRuns--; job.nextRunAt = this.now() + 60000; job.reason = `${reason} (${job.yields}/${MAX_YIELDS}); retrying`; this.persist();
        } else if (full && run.status === 'failed' && job.enabled && !this.disposed && (job.failures = (job.failures || 0) + 1) <= MAX_FAILURES) {
          // A failure inside the full loop is retried from its checkpoint a little later; only repeated failure stops it.
          job.resumeRunId = run.id; job.nextRunAt = this.now() + 120000 * job.failures; job.reason = `Retrying after a failure (${job.failures}/${MAX_FAILURES}): ${reason}`.slice(0, 240); this.persist();
        } else { job.enabled = false; delete job.resumeRunId; job.reason = reason; this.persist(); }
      }
    } finally {
      delete job.forced; this.actives.delete(job.id); this.syncAwake();
      if (!this.state.jobs.includes(job)) this.discardWorkspace(job); if (!this.disposed) this.emit('change', this.snapshot()); }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearInterval(this.timer); this.timer = null; clearTimeout(this.saveTimer);
    // Closing the IDE is not stopping the loop. Running work is cancelled so no process outlives the window, but every armed loop
    // stays armed and every interrupted run is marked resumable (see execute); the next start picks them up from their checkpoints.
    for (const entry of this.actives.values()) entry.controller.abort(new Error(HOST_CLOSING));
    // Keep ownership until in-flight runs have settled and saved their final state.
    // A run that ignores its abort signal cannot hold the storage for ever: after ten seconds the lock goes anyway.
    const closing = Date.now();
    const release = () => { if ((this.admitting || this.pending.size) && Date.now() - closing < 10000) { setTimeout(release, 50).unref?.(); return; } this.persist(); try { fs.unlinkSync(this.lock); } catch { /* already released */ } };
    release();
  }
}


module.exports = { InvestigationManager, DEFAULTS, FIX_DEFAULTS, TESTER_DEFAULTS, FULL_DEFAULTS, OVERNIGHT_LIMITS, TOPICS, LENSES, validateLimits, removeTree, cleanRoles, cleanOptions, HOST_CLOSING };
