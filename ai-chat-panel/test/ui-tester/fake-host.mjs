// The fake VS Code host for the chat page: the state the loops manager would publish, and answers shaped like
// lib/investigation-bridge.js. Shared by investigations-ui.mjs and the interface tester. Runs inside the page (addInitScript),
// so it must stay self-contained.
export function installFakeHost() {
  window.sent = [];
  const now = Date.now();
  const limits = { intervalMinutes: 0, maxRuns: 4, maxRunMinutes: 8, maxTokensPerRun: 250000, reservePercent: 50, hourlyTokens: 1000000, fixesPerCycle: 3, fixMinutes: 12 };
  const fixLimits = { ...limits, maxRuns: 6, maxRunMinutes: 45, maxTokensPerRun: 300000, hourlyTokens: 600000 };
  const job = (extra = {}) => ({ id: 'job-1', projectId: 'clanker', root: 'C:\\Projects\\Clanker Controller', model: 'gemini-3.8-flash-high', limits, expiresAt: now + 7.5 * 3600e3, enabled: true,
    nextRunAt: now + 20 * 60e3, completedRuns: 1, fingerprints: {}, reason: 'Waiting for next investigation', createdAt: now - 3600e3, ...extra });
  const run = (extra = {}) => ({ id: 'run-1', jobId: 'job-1', projectId: 'clanker', model: 'gemini-3.8-flash-high', topic: 'project binding and scheduling', status: 'completed', startedAt: now - 30 * 60e3,
    finishedAt: now - 24 * 60e3, day: new Date(now).toISOString().slice(0, 10), chargedTokens: 40000, tokenUsage: null, findings: [], questions: [], summary: '', quotaBefore: {}, artifacts: [], snapshotHash: 'abc', ...extra });
  const finding = (extra = {}) => ({ title: 'Queued turn keeps the old project', severity: 'high', status: 'observed', evidence: [{ file: 'ai-chat-panel/extension.js', line: 1996, detail: 'bindProject rejects but the queue was already filled' }],
    expected: 'The turn stays bound to its own project.', observed: 'The queued turn dispatched in the other project.', suspectedCause: 'The root is read at dispatch time.', reproduction: 'Queue two turns, switch projects, wait.', uncertainty: 'Only the code path was read.', ...extra });
  const testerLimits = { ...limits, maxRuns: 6, maxRunMinutes: 15, maxTokensPerRun: 60000, hourlyTokens: 1200000 };
  const fullLimits = { ...limits, maxRuns: 8, maxRunMinutes: 180, maxTokensPerRun: 3000000, hourlyTokens: 10000000, fixesPerCycle: 6, fixMinutes: 20 };
  const base = { version: 1, jobs: [], runs: [], ledger: {}, defaults: limits, fixDefaults: fixLimits, testerDefaults: testerLimits, fullDefaults: fullLimits, topics: [], activeRunId: null };
  const day = new Date(now).toISOString().slice(0, 10);
  const loopJob = (extra = {}) => job({ id: 'job-loop', recipe: 'fixloop', limits: fixLimits, backlog: [{ title: 'Pill colour ignores the theme' }, { title: 'Stale queue entry' }], reason: 'Waiting for next investigation', ...extra });
  const item = (title, extra = {}) => ({ id: 'F1', title, severity: 'high', kind: 'bug', area: 'backend', agent: 'codex', model: 'gpt-x', ...extra });
  const loopRun = (extra = {}) => run({ id: 'run-loop', jobId: 'job-loop', topic: 'security review: quota handling and model selection', tokenUsage: 148000, chargedTokens: 148000,
    summary: 'Three problems found. 1 fixed and verified, 1 unverified, 1 unfixed.', findings: [finding({ title: 'Queue drops a turn on reload', fix: { status: 'fixed', agent: 'codex' } })],
    artifacts: ['C:/x/run-loop/report.json', 'C:/x/run-loop/changes.patch', 'C:/x/run-loop/after-tests.txt'],
    loop: { lens: 'security review', verified: true, patch: 'changes.patch', checksBefore: [{ name: 'syntax', exitCode: 0 }, { name: 'tests', exitCode: 1 }], checksAfter: [{ name: 'syntax', exitCode: 0 }, { name: 'tests', exitCode: 0 }],
      fixed: [item('Queue drops a turn on reload', { reason: 'The diff keeps the turn bound to its project.' })], unverified: [item('Timer leaks on stop', { id: 'F2', agent: 'codex', reason: 'Gemini did not verify this change' })],
      unfixed: [item('Pill colour ignores the theme', { id: 'F3', kind: 'review', area: 'visual', agent: 'claude', reason: 'The change broke the syntax check and was reverted', gaveUp: true })],
      newIssues: [item('Fix left a stale comment', { id: 'N1', severity: 'low', agent: undefined })], additional: [item('Unused helper in router', { id: 'F4', severity: 'low', kind: 'simplify', agent: undefined })] }, ...extra });
  const testerJob = (extra = {}) => job({ id: 'job-tester', recipe: 'tester', limits: testerLimits, reason: 'Waiting for next investigation', ...extra });
  const uiFinding = (title, extra = {}) => finding({ title, observed: 'The picture and the measurements agree.', expected: 'Neighbouring elements keep their own space.',
    suspectedCause: 'Not diagnosed. The selector and rectangle point at the element; look at its CSS and its container.', reproduction: 'node ai-chat-panel/test/ui-tester/run.mjs --only=loops-loop (width 320px)',
    uncertainty: 'Measured by script; no model looked at this picture.',
    evidence: [{ file: 'ui:loops-loop@320', line: 1, detail: 'div.inv-job > div.cs-row > span.cs-tag at x212 y84, 96x22px; overlaps span.cs-title by 38%' }], ...extra });
  const testerRun = (extra = {}) => run({ id: 'run-t1', jobId: 'job-tester', topic: 'interface testing', tokenUsage: 21400, chargedTokens: 21400,
    summary: '48 screens checked: 2 new problems, 1 dismissed as false positives by Flash, 3 changed pictures, 1 changed accessibility tree. 4 pictures reviewed by Flash.',
    findings: [uiFinding('Overlapping elements: Interface test (loops-loop@320)', { severity: 'high', uncertainty: 'Flash looked at the picture and judged this real: the tag sits on top of the project name.' }),
      uiFinding('Clipped text: "Waiting for next investigation" (settings-general@320, long text)', { severity: 'medium', expected: 'All text is fully visible or intentionally truncated with an ellipsis.', observed: 'text needs 412px, box is 288px' })],
    artifacts: ['C:/x/run-t1/report.json', 'C:/x/run-t1/handoff.md', 'C:/x/run-t1/ui-report.md', 'C:/x/run-t1/capture.txt'], ...extra });
  const fullJob = (extra = {}) => job({ id: 'job-full', recipe: 'full', model: '', limits: fullLimits, expiresAt: null, mode: 'fix', roles: {}, options: {}, cycles: 1, shards: 3, backlog: [{ title: 'Pill colour ignores the theme' }], reason: 'Waiting for next investigation', ...extra });
  const scouts = ['Bugs', 'Security', 'Async', 'Data', 'Perf'].map((label, index) => ({ id: label.toLowerCase(), label, short: label, state: index < 3 ? 'done' : index === 3 ? 'running' : 'queued', found: index < 3 ? index + 1 : undefined }));
  const fullRun = (extra = {}) => run({ id: 'run-full', jobId: 'job-full', topic: 'Full review, cycle 1', tokenUsage: 920000, chargedTokens: 920000, summary: '10 scouts read a Node project: 7 candidates, 4 confirmed, 3 refuted. 2 fixed and verified, 0 applied but unverified, 1 unfixed, 0 new from verification, 1 queued.',
    findings: [], artifacts: ['C:/x/run-full/report.json', 'C:/x/run-full/changes.patch', 'C:/x/run-full/capture.txt'],
    loop: { lens: 'full', mode: 'fix', verified: true, patch: 'changes.patch', checksBefore: [{ name: 'syntax', exitCode: 0 }, { name: 'tests', exitCode: 1 }], checksAfter: [{ name: 'syntax', exitCode: 0 }, { name: 'tests', exitCode: 0 }],
      fixed: [item('Queue drops a turn on reload'), item('Timer leaks on stop', { id: 'F2' })], unverified: [], unfixed: [item('Pill colour ignores the theme', { id: 'F3', area: 'visual', agent: 'claude', reason: 'Made the "tests" check fail, so it was thrown out' })], newIssues: [], found: [], additional: [item('Unused helper in router', { id: 'F4', severity: 'low', agent: undefined })],
      agents: [{ id: 'bugs', label: 'Bugs', short: 'Bugs', status: 'done', found: 3 }, { id: 'security', label: 'Security', short: 'Security', status: 'done', found: 2 }, { id: 'perf', label: 'Performance', short: 'Perf', status: 'failed', found: 0, reason: 'rate limited' }],
      confirm: { proposed: 7, confirmed: 4, rejected: 3 }, regressions: [{ id: 'F3', title: 'Pill colour ignores the theme', checks: ['tests'] }],
      visual: { provider: 'playwright', ok: true, reason: '', routes: ['/', '/about', '/contact'], states: 9, measured: 1, afterOk: true } }, ...extra });
  const states = {
    full: { ...base, keepingAwake: true, activeRunId: 'run-full-live', activeRunIds: ['run-full-live'], ledger: { [day]: { tokens: 920000, runs: 1 } }, jobs: [fullJob()],
      runs: [fullRun(), run({ id: 'run-full-live', jobId: 'job-full', status: 'running', stage: 'scan', topic: 'Full review, cycle 2', finishedAt: undefined, startedAt: now - 6 * 60e3, resumes: 1,
        live: { note: '5 scouts on Gemini 3.8 Flash High', agents: scouts, fixes: [] } })] },
    fullpaused: { ...base, jobs: [fullJob({ enabled: false, reason: 'Paused by user', completedRuns: 1, roles: { editor: 'gemini' } })], runs: [fullRun()], ledger: { [day]: { tokens: 920000, runs: 1 } } },
    fullfind: { ...base, jobs: [fullJob({ mode: 'find', enabled: false, reason: 'Finished: every part of the project was reviewed' })],
      runs: [fullRun({ summary: 'Find only: 2 problems listed, nothing edited.', loop: { lens: 'full', mode: 'find', verified: false, patch: null, checksBefore: [], checksAfter: [], fixed: [], unverified: [], unfixed: [], newIssues: [], additional: [], found: [item('Queue drops a turn on reload', { agent: undefined }), item('Timer leaks on stop', { id: 'F2', agent: undefined })], agents: [], visual: { provider: 'none', ok: false, reason: 'This project has no pages to open', routes: [] } } })] },
    fullresuming: { ...base, jobs: [fullJob({ resumeRunId: 'run-full', reason: 'Resuming after a restart' })], runs: [fullRun({ status: 'interrupted', reason: 'The IDE closed; the run resumes automatically' })] },
    tester: { ...base, keepingAwake: true, activeRunId: 'run-t2', activeRunIds: ['run-t2'], ledger: { [day]: { tokens: 118000, runs: 2 } }, jobs: [testerJob()],
      runs: [testerRun(), run({ id: 'run-t2', jobId: 'job-tester', status: 'running', stage: 'vision', topic: 'interface testing', finishedAt: undefined, startedAt: now - 2 * 60e3 })] },
    testerdone: { ...base, jobs: [testerJob({ completedRuns: 1 })], runs: [testerRun()], ledger: { [day]: { tokens: 21400, runs: 1 } } },
    empty: base,
    unchanged: { ...base, jobs: [testerJob({ enabled: false, completedRuns: 1, reason: 'No new source since the last interface test; paused until restarted' })], runs: [testerRun({ findings: [], summary: '48 screens checked: no new problems.' })], ledger: { [day]: { tokens: 21400, runs: 1 } } },
    loop: { ...base, keepingAwake: true, activeRunId: 'run-live', activeRunIds: ['run-live'], ledger: { [day]: { tokens: 448000, runs: 2 } }, jobs: [loopJob()],
      runs: [loopRun(), run({ id: 'run-live', jobId: 'job-loop', status: 'running', stage: 'fix', topic: 'simplification: composer and queue behavior', finishedAt: undefined, startedAt: now - 4 * 60e3 })] },
    loopdone: { ...base, jobs: [loopJob({ enabled: false, backlog: [], reason: 'Finished: nothing left to fix', completedRuns: 5 })], runs: [loopRun()], ledger: { [day]: { tokens: 148000, runs: 1 } } },
    deferred: { ...base, jobs: [job({ reason: 'Verified spare quota unavailable', nextRunAt: now + 60e3 })], ledger: { [day]: { tokens: 40000, runs: 1 } }, runs: [run()] },
    running: { ...base, jobs: [job({ reason: 'Waiting for next investigation' })], activeRunId: 'run-2', ledger: { [day]: { tokens: 80000, runs: 2 } },
      runs: [run(), run({ id: 'run-2', status: 'running', stage: 'tests', topic: 'cancellation and interrupted runs', finishedAt: undefined, startedAt: now - 3 * 60e3 })] },
    parallel: { ...base, keepingAwake: true, activeRunId: 'run-2', activeRunIds: ['run-2', 'run-3'], ledger: { [day]: { tokens: 100000, runs: 2 } },
      jobs: [job({ reason: 'Waiting for next investigation' }), job({ id: 'job-2', projectId: 'p2', root: 'C:\\Projects\\Visor', reason: 'Waiting for next investigation' })],
      runs: [run({ id: 'run-2', status: 'running', stage: 'tests', finishedAt: undefined, startedAt: now - 3 * 60e3 }),
        run({ id: 'run-3', jobId: 'job-2', projectId: 'p2', status: 'running', stage: 'diagnosis', finishedAt: undefined, startedAt: now - 2 * 60e3 })] },
    stopped: { ...base, jobs: [job({ enabled: false, reason: 'Stopped by user' })], runs: [run({ status: 'interrupted', reason: 'Stopped by user', finishedAt: now - 60e3 })], ledger: { [day]: { tokens: 40000, runs: 1 } } },
    exhausted: { ...base, jobs: [job({ reason: 'Hourly allowance reached' })], ledger: { [day]: { tokens: 160000, runs: 4 } } },
    completed: { ...base, jobs: [job({ enabled: false, reason: 'Run limit reached', completedRuns: 4 })], ledger: { [day]: { tokens: 92000, runs: 3 } }, runs: [
      run({ id: 'run-3', summary: 'Two scheduling concerns, one confirmed by a failing test.', tokenUsage: 31200, chargedTokens: 31200, questions: ['Should a removed project cancel its queued turns?'],
        findings: [finding(), finding({ title: 'Quota reset timer ignores the weekly window', severity: 'medium', status: 'suspected' })],
        artifacts: ['C:\\x\\run-3\\report.json', 'C:\\x\\run-3\\tests.txt', 'C:\\x\\run-3\\queue.png'] }),
      run({ id: 'run-2', topic: 'composer and queue behavior', startedAt: now - 120 * 60e3, summary: 'Nothing wrong in the supplied excerpts.' }),
      run({ id: 'run-1', status: 'failed', reason: 'Flash did not return a completed diagnostic report.', startedAt: now - 200 * 60e3, topic: 'quota handling and model selection' })] },
    hostile: { ...base, jobs: [job({ enabled: false, reason: 'Run limit reached', completedRuns: 4 })], runs: [run({ id: 'run-x', summary: '<b id="summary-bold">bold</b>', questions: ['<img src=x onerror="window.pwned=1">'],
      findings: [finding({ title: '<img src=x onerror="window.pwned=1">', observed: '<script>window.pwned=2</script>', evidence: [{ file: '<svg onload="window.pwned=3">', line: 1, detail: '<a href="javascript:window.pwned=4">x</a>' }] })] })] },
  };
  window.fake = { states, state: states.empty, fail: {}, unavailable: false, count: 0,
    options: { projects: [{ id: 'clanker', name: 'Clanker Controller', root: 'C:\\Projects\\Clanker Controller' }, { id: 'site', name: 'Portfolio', root: 'C:\\Projects\\Portfolio' }], projectId: 'clanker',
      flashModels: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High', agent: 'gemini' }, { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash Low', agent: 'gemini' }],
      roles: {
        scout: { name: 'Scouts and verifiers', hint: 'Reads the project.', value: 'auto', auto: 'Gemini · Gemini 3.8 Flash High', choices: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High', agent: 'gemini' }, { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 High', agent: 'claude' }, { id: 'gpt-6.1-sol-high', label: 'GPT 6.1 Sol High', agent: 'codex' }] },
        editor: { name: 'Editor (backend fixes)', hint: 'Makes the fixes.', value: 'auto', auto: 'Codex · GPT 6.1 Sol High', choices: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High', agent: 'gemini' }, { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 High', agent: 'claude' }, { id: 'gpt-6.1-sol-high', label: 'GPT 6.1 Sol High', agent: 'codex' }] },
        visualEditor: { name: 'Editor (visual fixes)', hint: 'Makes layout fixes.', value: 'auto', auto: 'Claude · Claude Opus 5.5 High', choices: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High', agent: 'gemini' }, { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 High', agent: 'claude' }, { id: 'gpt-6.1-sol-high', label: 'GPT 6.1 Sol High', agent: 'codex' }] },
        vision: { name: 'Screenshot review', hint: 'Looks at screenshots.', value: 'auto', auto: 'Gemini · Gemini 3.8 Flash High', choices: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High', agent: 'gemini' }] } },
      reviewModels: [{ id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 High', agent: 'claude' }, { id: 'gpt-6.1-sol-high', label: 'GPT 6.1 Sol High', agent: 'codex' }] } };
  const answer = (message) => {
    const { requestId, request } = message;
    const reply = (payload) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'investigationsResult', requestId, action: request.action, ...payload } }));
    const fake = window.fake;
    if (fake.unavailable) return reply({ ok: false, unavailable: true, error: 'Loops are managed by another IDE window. Close that window or use it to manage them.' });
    if (fake.fail[request.action]) return reply({ ok: false, error: fake.fail[request.action], state: fake.state });
    const state = fake.state;
    let result = true;
    if (request.action === 'options') result = fake.options;
    else if (request.action === 'create') {
      result = job({ id: 'job-new', recipe: request.recipe || 'diagnose', ...(request.recipe === 'full' ? { model: '', mode: request.mode || 'fix', roles: request.roles || {}, options: request.options || {}, cycles: 0 } : {}), enabled: false, completedRuns: 0, limits: { ...(request.recipe === 'full' ? fullLimits : request.recipe === 'fixloop' ? fixLimits : request.recipe === 'tester' ? testerLimits : limits), ...request.limits }, expiresAt: request.expiresAt, projectId: request.projectId, model: request.model, reason: 'Ready; start explicitly' });
      fake.state = { ...state, jobs: [...state.jobs, result] };
    } else if (request.action === 'configure') {
      fake.state = { ...state, jobs: state.jobs.map((item) => item.id === request.id ? { ...item, limits: { ...item.limits, ...request.limits }, ...(request.mode ? { mode: request.mode } : {}), ...(request.roles ? { roles: request.roles } : {}), ...(request.options ? { options: request.options } : {}) } : item) };
    } else if (request.action === 'delete') {
      fake.state = { ...state, activeRunId: null, activeRunIds: [], jobs: state.jobs.filter((item) => item.id !== request.id) };
    } else if (request.action === 'start') {
      fake.state = { ...state, jobs: state.jobs.map((item) => item.id === request.id ? { ...item, enabled: true, reason: 'Waiting for idle time and verified spare quota' } : item) };
    } else if (request.action === 'stopAll') {
      fake.state = { ...state, activeRunId: null, jobs: state.jobs.map((item) => ({ ...item, enabled: false, reason: 'Stopped by user' })) };
    } else if (request.action === 'runNow') {
      fake.state = { ...state, jobs: state.jobs.map((item) => item.id === request.id ? { ...item, nextRunAt: Date.now() } : item) };
    } else if (request.action === 'pause') {
      fake.state = { ...state, jobs: state.jobs.map((item) => item.id === request.id ? { ...item, enabled: false, reason: 'Paused by user' } : item) };
    } else if (request.action === 'handoff') result = { projectId: 'clanker', prompt: 'Review these findings' };
    else if (request.action === 'review') result = { projectId: 'clanker', modelId: request.modelId };
    reply({ ok: true, result, state: request.action === 'options' ? undefined : fake.state });
  };
  window.acquireVsCodeApi = () => ({ postMessage(message) { window.sent.push(message); if (message.type === 'investigations') setTimeout(() => answer(message), 0); }, getState: () => ({}), setState() {} });
  window.setFakeState = (name) => { window.fake.state = window.fake.states[name]; };
  window.pushState = () => window.dispatchEvent(new MessageEvent('message', { data: { type: 'investigationsState', available: true, state: window.fake.state } }));
}
