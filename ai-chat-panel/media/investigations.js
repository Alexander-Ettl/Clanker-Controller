/**
 * Sidebar Loops popup: manage bounded Flash loops (lib/investigation-manager.js). The page talks to the
 * extension host only through `{type:'investigations', requestId, request}` messages and renders what comes back.
 * Report text comes from a model reading source code, so everything is written with textContent, never as HTML.
 * Controls reuse the settings popup's cs-* styles; investigations.css adds the few things only this tab has.
 */
(function () {
  'use strict';

  const CHECK_STAGES = [['snapshot', 'Snapshot'], ['syntax', 'Syntax'], ['tests', 'Tests'], ['render', 'Render']];
  const STAGES = { diagnose: [...CHECK_STAGES, ['diagnosis', 'Diagnosis'], ['report', 'Report']],
    fixloop: [...CHECK_STAGES, ['find', 'Find'], ['fix', 'Fix'], ['verify', 'Verify'], ['report', 'Report']],
    tester: [['snapshot', 'Snapshot'], ['capture', 'Capture'], ['triage', 'Triage'], ['vision', 'Vision'], ['report', 'Report']],
    full: [['prepare', 'Prepare'], ['check', 'Checks'], ['scan', 'Scouts'], ['confirm', 'Confirm'], ['fix', 'Fix'], ['verify', 'Verify'], ['report', 'Report']] };
  const MODES = [['full', 'Full loop'], ['diagnose', 'Diagnose only'], ['fixloop', 'Basic fix loop'], ['tester', 'Test the interface']];
  const FIX_CHOICES = [['fix', 'Fix problems'], ['find', 'Find only']];
  const VISUAL_CHOICES = [['auto', 'Automatic'], ['visor', 'Visor'], ['playwright', 'Playwright'], ['off', 'Off']];
  const AGENT_TITLE = { gemini: 'Gemini', claude: 'Claude', codex: 'Codex' };
  const ROLE_ORDER = ['scout', 'editor', 'visualEditor', 'vision'];
  const LENS_NAMES = { bugs: 'Bug hunt', 'code review': 'Code review', 'security review': 'Security review', simplification: 'Simplify' };
  // [key, label, unit, min, max, advanced, hint]: ranges mirror validateLimits() in the manager, which checks them again.
  const FIELDS = [
    ['maxRuns', 'Runs in this loop', 'runs', 1, 12, false, 'How many runs (one cycle each in Find and fix) it may start before it stops.'],
    ['maxTokensPerRun', 'Tokens reserved per run', 'tokens', 1000, 500000, false, 'Held against the allowance before a run starts, then corrected to the real figure if the CLI reports one.'],
    ['intervalMinutes', 'Time between runs', 'minutes', 0, 1440, true, 'The earliest a run may start after the previous one. 0 starts the next run as soon as one finishes.'],
    ['maxRunMinutes', 'Time limit per run', 'minutes', 1, 90, true, 'Checks, diagnosis and fixes are cancelled when it runs out.'],
    ['fixesPerCycle', 'Fixes per cycle', 'fixes', 0, 8, false, 'How many problems the fixers attempt in one cycle. 0 only finds problems.', true],
    ['fixMinutes', 'Time per fix', 'minutes', 1, 30, true, 'A fixer that runs longer is stopped and its edits are thrown away.', true],
    ['hourlyTokens', 'Hourly token allowance', 'tokens', 1000, 2000000, true, 'No run starts if it would take the last hour past this. Shared by every loop.'],
    ['reservePercent', 'Quota to keep free', '% per window', 25, 95, true, 'A run waits unless every Gemini quota window has at least this much left.'],
  ];
  // The full loop works on larger budgets (see FULL_DEFAULTS in the manager): same fields, wider ranges, and no clock that cuts a run off.
  const FULL_FIELDS = {
    maxRuns: { range: [1, 24], hint: 'How many cycles it may start. A large project is split into parts and each cycle reviews another part.' },
    maxTokensPerRun: { range: [1000, 6000000], hint: 'Held against the allowance before a cycle starts, then corrected to the real figure if the CLIs report one.' },
    maxRunMinutes: { range: [1, 720], hint: 'After this the cycle stops starting new work and writes its report. Nothing is cut off mid-call.' },
    hourlyTokens: { range: [1000, 30000000], hint: 'No cycle starts if it would take the last hour past this. Shared by every loop.' },
    fixesPerCycle: { range: [0, 12], hint: 'How many confirmed problems the editors attempt in one cycle. 0 only finds problems.' },
  };
  const HOURS = [2, 4, 8, 12];
  const SEVERITY = { high: 0, medium: 1, low: 2 };
  const ARTIFACTS = { 'handoff.md': 'Fix handoff', 'ui-report.md': 'Screen report', 'capture.txt': 'Capture log', 'report.json': 'Report', 'packet.txt': 'Evidence packet', 'syntax.txt': 'Syntax check', 'tests.txt': 'Test output', 'render.txt': 'Render log', 'queue.png': 'Fixture render',
    'changes.patch': 'Patch with the fixes', 'verify-packet.txt': 'Verification packet', 'after-tests.txt': 'Tests after fixes', 'after-syntax.txt': 'Syntax after fixes', 'after-queue.png': 'Render after fixes' };
  const svg = (paths) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    loop: svg('<path d="M3 8a5 5 0 0 1 8.7-3.4L13 6"/><path d="M13 3v3h-3"/><path d="M13 8a5 5 0 0 1-8.7 3.4L3 10"/><path d="M3 13v-3h3"/>'),
    chevron: svg('<path d="m4 6 4 4 4-4"/>'),
    check: svg('<path d="m3.5 8.5 3 3 6-7"/>'),
    stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.8"/>'),
    play: svg('<path d="M5 3.5v9l7-4.5z"/>'),
    pause: svg('<path d="M5.5 3.5v9M10.5 3.5v9"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1"/>'),
    send: svg('<path d="M14 2 2 6.8l4.6 2 2 4.6z"/><path d="M6.6 8.8 14 2"/>'),
    file: svg('<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>'),
    plus: svg('<path d="M8 3v10M3 8h10"/>'),
    trash: svg('<path d="M3 4.5h10M6.5 4.5v-1.5h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => { const wrap = el('span', 'inv-ico'); wrap.innerHTML = ICON[name]; return wrap; }; // static markup from this file only
  let ddCount = 0;
  /**
   * The settings popup's custom dropdown (cs-dd, styled in settings.css) in place of a native select, whose grey
   * system popup ignores the panel's look. `groups` is [[heading|'', [[value, text], ...]], ...]; `.value` reads the
   * choice and `.focus()` focuses the trigger. Ids are labelled by `labelId` so the row's label still names it.
   */
  function dropdown({ groups, value, label, labelId }) {
    const root = el('div', 'cs-dd');
    const trigger = el('button', 'cs-dd-trigger');
    trigger.type = 'button'; trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    if (labelId) trigger.setAttribute('aria-labelledby', labelId); else trigger.setAttribute('aria-label', label);
    const shown = el('span', 'cs-dd-value');
    trigger.append(shown);
    trigger.insertAdjacentHTML('beforeend', ICON.chevron);
    const menu = el('div', 'cs-dd-menu');
    menu.id = `inv-dd-${++ddCount}`; menu.setAttribute('role', 'listbox'); menu.hidden = true;
    if (labelId) menu.setAttribute('aria-labelledby', labelId); else menu.setAttribute('aria-label', label);
    trigger.setAttribute('aria-controls', menu.id);
    const choices = [];
    for (const [heading, items] of groups) {
      if (heading) { const head = el('div', 'cs-dd-group', heading); head.setAttribute('role', 'presentation'); menu.append(head); }
      for (const [optionValue, text] of items) {
        const option = el('button', 'cs-dd-option');
        option.type = 'button'; option.setAttribute('role', 'option'); option.title = text;
        option.append(el('span', 'cs-dd-text', text));
        option.insertAdjacentHTML('beforeend', ICON.check);
        choices.push({ value: optionValue, text, option });
        menu.append(option);
      }
    }
    const api = { node: root, value: '', focus: () => trigger.focus(), set: (next) => choose(next), onchange: null };
    const options = () => choices.map((choice) => choice.option);
    function choose(next) {
      const hit = choices.find((choice) => choice.value === next) || choices[0];
      api.value = hit ? hit.value : '';
      shown.textContent = hit ? hit.text : '';
      trigger.title = hit ? hit.text : '';
      for (const choice of choices) {
        const on = choice === hit;
        choice.option.classList.toggle('is-selected', on);
        choice.option.setAttribute('aria-selected', String(on));
      }
    }
    function setOpen(open) {
      root.classList.toggle('is-open', open);
      trigger.setAttribute('aria-expanded', String(open));
      menu.hidden = !open;
      if (open) (menu.querySelector('.is-selected') || menu.querySelector('.cs-dd-option'))?.focus();
    }
    trigger.addEventListener('click', () => setOpen(menu.hidden));
    trigger.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } });
    menu.addEventListener('click', (event) => {
      const hit = choices.find((choice) => choice.option === event.target.closest('.cs-dd-option'));
      if (!hit) return;
      choose(hit.value); setOpen(false); trigger.focus(); api.onchange?.(hit.value);
    });
    menu.addEventListener('keydown', (event) => {
      const items = options();
      const at = items.indexOf(document.activeElement);
      const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
      if (move != null) { event.preventDefault(); items[(move + items.length) % items.length]?.focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus(); }
      else if (event.key === 'Tab') setOpen(false);
    });
    const away = (event) => {
      if (!root.isConnected) document.removeEventListener('pointerdown', away); // the form was redrawn
      else if (!menu.hidden && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    root.append(trigger, menu);
    choose(value);
    return api;
  }
  const uid = () => Math.random().toString(36).slice(2, 7);
  /** The settings popup's pill row as a radio group. `set(value)` changes it from code; clicks also call onChange(value, true). */
  function pillGroup(label, choices, value, { keyPrefix = '', onChange = () => {} } = {}) {
    const track = el('div', 'time-format-picker pill-track');
    track.setAttribute('role', 'radiogroup'); track.setAttribute('aria-label', label);
    const api = { node: track, value };
    const buttons = choices.map(([choiceValue, text]) => {
      const choice = el('button', 'format-pill', text);
      choice.type = 'button'; choice.setAttribute('role', 'radio');
      if (keyPrefix) choice.dataset.key = `${keyPrefix}-${choiceValue}`;
      choice.addEventListener('click', () => api.set(choiceValue, true));
      track.append(choice);
      return [choiceValue, choice];
    });
    const apply = (next) => {
      api.value = next;
      for (const [choiceValue, choice] of buttons) { choice.setAttribute('aria-checked', String(choiceValue === next)); choice.classList.toggle('active', choiceValue === next); }
    };
    api.set = (next, byUser = false) => { apply(next); onChange(next, byUser); };
    apply(value);
    return api;
  }
  /** A settings row: a title and hint on the left, the dropdown on the right. */
  function choiceRow(title, hint, groups, value) {
    const row = el('div', 'cs-set');
    const info = el('div', 'cs-info');
    const labelNode = el('label', 'cs-title', title);
    labelNode.id = `inv-pick-${uid()}`;
    info.append(labelNode, el('span', 'cs-desc', hint));
    const select = dropdown({ groups, value, labelId: labelNode.id });
    row.append(info, select.node);
    return { row, select };
  }
  function switchRow(title, hint, checked, onChange) {
    const row = el('div', 'cs-set');
    const info = el('div', 'cs-info');
    const labelNode = el('span', 'cs-title', title);
    labelNode.id = `inv-switch-${uid()}`;
    const desc = el('span', 'cs-desc', hint);
    info.append(labelNode, desc);
    const node = el('button', 'cs-switch');
    node.type = 'button'; node.setAttribute('role', 'switch'); node.setAttribute('aria-checked', String(Boolean(checked))); node.setAttribute('aria-labelledby', labelNode.id);
    const api = { row, desc, get on() { return node.getAttribute('aria-checked') === 'true'; }, set: (next) => node.setAttribute('aria-checked', String(Boolean(next))) };
    node.addEventListener('click', () => { api.set(!api.on); onChange(api.on); });
    row.append(info, node);
    return api;
  }
  const count = (n) => Number(n).toLocaleString('en-US');
  const plural = (n, word, many = `${word}s`) => `${count(n)} ${n === 1 ? word : many}`;
  const basename = (file) => String(file).split(/[\\/]/).pop();
  const cap = (text) => text[0].toUpperCase() + text.slice(1);
  /** "code review: composer and queue behavior" reads as "Code review, composer and queue behavior". */
  const topicName = (topic) => { const [lens, rest] = String(topic).split(': '); return rest ? `${LENS_NAMES[lens] || cap(lens)}, ${rest}` : cap(lens); };

  function duration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 1) return 'under a minute';
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  }
  function clock(timestamp, now) {
    const date = new Date(timestamp);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return date.toDateString() === new Date(now).toDateString() ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }
  
  window.initInvestigations = function initInvestigations({ vscode, root, onState = () => {} }) {
    root.classList.add('inv');
    let snapshot = null;
    let options = null;
    let unavailable = '';
    let loaded = false;
    let formOpen = false;
    let formNode = null; // the open form is built once, so a state push never wipes what you typed
    const editors = new Map(); // job id -> its limits editor, kept for the same reason
    let editing = null; // job id whose limits are being edited
    let reviewing = null; // run id whose model picker is open
    let confirmingDelete = null; // job id waiting for the second click
    let showAllRuns = false;
    let statusTimer = 0;
    let seq = 0;
    const pending = new Map();
    const openKeys = new Set();
    const busy = new Set();

    const status = el('p', 'inv-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    const bar = el('div', 'inv-bar');
    const overview = el('section', 'cs-card inv-overview');
    const formHost = el('div', 'inv-form-host');
    const jobsHost = el('div', 'inv-section');
    const resultsHost = el('div', 'inv-section');
    root.append(status, bar, overview, formHost, jobsHost, resultsHost);

    // ---------- Host requests ----------
    function request(body, timeout = 20000) {
      const requestId = `inv-${Date.now().toString(36)}-${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('The IDE did not answer. Reload the window if this keeps happening.')); }, timeout);
        pending.set(requestId, { resolve, reject, timer });
        vscode.postMessage({ type: 'investigations', requestId, request: body });
      });
    }
    function setSnapshot(state) {
      if (!state || !Array.isArray(state.jobs) || !Array.isArray(state.runs)) return;
      snapshot = state;
      onState(state);
      unavailable = '';
      render();
    }
    function message(data) {
      if (data.type === 'investigationsState') { if (data.available !== false) setSnapshot(data.state); return; }
      const entry = pending.get(data.requestId);
      if (!entry) return;
      pending.delete(data.requestId);
      clearTimeout(entry.timer);
      if (data.unavailable) { unavailable = data.error; render(); }
      else if (data.state) setSnapshot(data.state);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(Object.assign(new Error(data.error || 'The request failed.'), { unavailable: Boolean(data.unavailable) }));
    }
    function say(text, tone = '') {
      clearTimeout(statusTimer);
      status.textContent = text;
      status.hidden = !text;
      status.className = `inv-status${tone ? ` is-${tone}` : ''}`;
      if (text && tone !== 'error') statusTimer = setTimeout(() => say(''), 9000);
    }
    /** Runs one user action: its buttons stay disabled until the host answers, and a failure is said plainly. */
    async function act(key, work, success) {
      if (busy.has(key)) return null;
      busy.add(key);
      render();
      try {
        const result = await work();
        say(success ? (typeof success === 'function' ? success(result) : success) : '', 'ok');
        return result;
      } catch (error) {
        if (!error.unavailable) say(error.message, 'error');
        return null;
      } finally { busy.delete(key); render(); }
    }
    async function refresh() {
      try {
        const [state, offered] = await Promise.all([request({ action: 'list' }), request({ action: 'options' })]);
        options = offered;
        formNode = null;
        loaded = true;
        setSnapshot(state);
      } catch (error) { loaded = true; if (!error.unavailable) say(error.message, 'error'); render(); }
    }

    // ---------- Derived state ----------
    const projectName = (job) => options?.projects?.find((project) => project.id === job.projectId)?.name || basename(job.root);
    const jobRuns = (job) => snapshot.runs.filter((run) => run.jobId === job.id);
    const activeIds = () => snapshot.activeRunIds || (snapshot.activeRunId ? [snapshot.activeRunId] : []);
    const activeRun = (job) => snapshot.runs.find((run) => activeIds().includes(run.id) && run.jobId === job.id);
    const armed = () => snapshot.jobs.filter((job) => job.enabled);

    /** One state per loop, taken from what the backend recorded: its reason, its newest run and the clock. */
    function jobState(job, now) {
      const running = activeRun(job);
      if (running) return { key: 'running', label: 'Running', tone: 'run', detail: 'A run is in progress.' };
      const reason = job.reason || '';
      const last = jobRuns(job).at(-1);
      if (job.enabled) {
        if (job.resumeRunId && /resum|retry/i.test(reason)) return { key: 'resuming', label: /retry/i.test(reason) ? 'Retrying' : 'Resuming', tone: 'run' };
        if (/foreground/i.test(reason)) return { key: 'foreground', label: 'Waiting: your work', tone: 'warn' };
        if (/quota/i.test(reason)) return { key: 'quota', label: 'Waiting: quota', tone: 'warn' };
        if (/allowance/i.test(reason)) return { key: 'allowance', label: 'Allowance used', tone: 'warn' };
        if (/model/i.test(reason) || /project/i.test(reason)) return { key: 'blocked', label: 'Waiting', tone: 'warn' };
        return { key: 'armed', label: job.nextRunAt > now ? 'Active: next run later' : 'Active', tone: 'ok' };
      }
      if (/^Finished/.test(reason)) return { key: 'finished', label: 'Finished', tone: 'ok' };
      if (expired(job, now) || reason === 'Expired') return { key: 'expired', label: 'Expired', tone: '' };
      if (job.completedRuns >= job.limits.maxRuns) return { key: 'finished', label: 'Finished', tone: 'ok' };
      if (reason === 'Paused by user') return { key: 'paused', label: 'Paused', tone: '' };
      if (reason === 'Stopped by user') return { key: 'stopped', label: 'Stopped', tone: '' };
      if (last?.status === 'failed' && last.reason === reason) return { key: 'failed', label: 'Failed', tone: 'bad' };
      if (last?.status === 'interrupted' && last.reason === reason) return { key: 'interrupted', label: 'Interrupted', tone: 'warn' };
      if (/usage|review/i.test(reason)) return { key: 'review', label: 'Needs your review', tone: 'warn' };
      if (!job.completedRuns) return { key: 'ready', label: 'Not started', tone: '' };
      return { key: 'paused', label: 'Paused', tone: '' };
    }
    // The full loop has no expiry: it ends when it is done, when it runs out of runs, or when you stop it.
    function expired(job, now) { return job.expiresAt != null && job.expiresAt <= now; }
    const canStart = (job, now) => !expired(job, now) && job.completedRuns < job.limits.maxRuns;

    // ---------- Pieces ----------
    function tag(text, tone) { return el('span', `cs-tag${tone ? ` is-${tone}` : ''}`, text); }
    function button(label, onClick, { className = '', iconName = '', key = '', disabled = false } = {}) {
      const node = el('button', `cs-btn ${className}`);
      node.type = 'button';
      if (iconName) node.append(icon(iconName));
      node.append(el('span', '', label));
      if (key) node.dataset.key = key;
      node.disabled = disabled;
      node.addEventListener('click', onClick);
      return node;
    }
    function section(title, hint) {
      const head = el('div', 'inv-head');
      head.append(el('h3', 'inv-title', title));
      if (hint) head.append(el('span', 'inv-hint', hint));
      return head;
    }
    function details(key, summary, body, className = '') {
      const node = el('details', className);
      node.open = openKeys.has(key);
      node.addEventListener('toggle', () => { if (node.open) openKeys.add(key); else openKeys.delete(key); });
      node.append(summary, body);
      return node;
    }
    function fact(label, value, { mono = false, title = '', preview = false } = {}) {
      const node = el('div', 'inv-fact');
      node.append(el('dt', '', label));
      const dd = el('dd', mono ? 'is-mono' : '', value);
      if (preview) dd.classList.add('inv-preview');
      if (title) dd.title = title;
      node.append(dd);
      return node;
    }

    /** The limit fields in plain language with units. `read()` returns whole numbers or the first problem found. */
    function limitsForm(values, { withExpiry = false, hours = 8, recipe = 'diagnose' } = {}) {
      const form = el('div', 'inv-fields');
      const inputs = new Map();
      const field = (def) => {
        const [name, label, unit, min, max, , hint] = def;
        const row = el('div', 'cs-set');
        const info = el('div', 'cs-info');
        info.append(el('label', 'cs-title', label), el('span', 'cs-desc', `${hint} Allowed: ${count(min)}–${count(max)} ${unit}.`));
        const input = el('input', 'cs-num');
        input.type = 'number'; input.inputMode = 'numeric'; input.min = String(min); input.max = String(max); input.step = '1';
        input.value = String(values[name]); input.id = `inv-${name}-${Math.random().toString(36).slice(2, 7)}`;
        info.querySelector('label').htmlFor = input.id;
        const unitNode = el('span', 'inv-unit', unit);
        const control = el('div', 'inv-control'); control.append(input, unitNode);
        const error = el('p', 'inv-field-error'); error.hidden = true;
        input.addEventListener('input', () => { error.hidden = true; input.removeAttribute('aria-invalid'); });
        row.append(info, control, error);
        inputs.set(name, { input, error, def });
        return row;
      };
      const basic = el('div', 'cs-set-list');
      const advanced = el('div', 'cs-set-list');
      let hoursSelect = null;
      if (withExpiry) {
        const row = el('div', 'cs-set');
        const info = el('div', 'cs-info');
        info.append(el('label', 'cs-title', 'Stops after'), el('span', 'cs-desc', 'The loop stops itself then, even with runs left.'));
        const labelNode = info.querySelector('label');
        labelNode.id = `inv-hours-${Math.random().toString(36).slice(2, 7)}`;
        hoursSelect = dropdown({ groups: [['', HOURS.map((h) => [String(h), `${h} hours`])]], value: String(hours), labelId: labelNode.id });
        row.append(info, hoursSelect.node);
        basic.append(row);
      }
      const tuned = (def) => { const full = recipe === 'full' && FULL_FIELDS[def[0]]; return full ? [def[0], def[1], def[2], full.range[0], full.range[1], def[5], full.hint, def[7]] : def; };
      for (const def of FIELDS.filter((def) => !def[7] || recipe === 'fixloop' || recipe === 'full').map(tuned)) (def[5] ? advanced : basic).append(field(def));
      const more = el('summary', 'cs-row inv-more');
      more.append(el('span', 'cs-title', 'Advanced limits'), el('span', 'cs-desc', 'Spacing, time limits, hourly allowance and quota reserve.'));
      more.insertAdjacentHTML('beforeend', ICON.chevron);
      const advancedBox = el('details', 'inv-advanced');
      advancedBox.append(more, advanced);
      form.append(basic, advancedBox);

      function read() {
        const limits = {};
        let first = null;
        for (const [name, { input, error, def }] of inputs) {
          const [, label, unit, min, max] = def;
          const value = input.value.trim() === '' ? NaN : Number(input.value);
          error.hidden = true; input.removeAttribute('aria-invalid');
          if (!Number.isInteger(value) || value < min || value > max) {
            error.textContent = `${label}: enter a whole number from ${count(min)} to ${count(max)} ${unit}.`;
            error.hidden = false; input.setAttribute('aria-invalid', 'true');
            if (def[5]) advancedBox.open = true;
            first ||= input;
          } else limits[name] = value;
        }
        if (!first && limits.hourlyTokens < limits.maxTokensPerRun) {
          const { input, error } = inputs.get('hourlyTokens');
          error.textContent = 'The hourly allowance must cover at least one run’s reserved tokens.';
          error.hidden = false; input.setAttribute('aria-invalid', 'true'); advancedBox.open = true; first = input;
        }
        if (first) { first.focus(); return { problem: true }; }
        return { limits, hours: hoursSelect ? Number(hoursSelect.value) : null };
      }
      return { node: form, read };
    }

    /**
     * What only the full loop has. `top` is always on screen: fix or find only, and the Gemini-edits switch. `advanced` goes behind Options:
     * who does what, the visual-check choice and how many agents run. `read()` returns { mode, roles, options } for create and configure.
     */
    const FIX_HINT = { fix: 'Editors fix each confirmed problem in a private copy, and every fix is checked before it stays.', find: 'Reports confirmed problems and edits nothing. Quicker and cheaper.' };
    function fullControls(job) {
      const info = options?.roles || {};
      const saved = job?.roles || {};
      const chosen = job?.options || {};
      const mode = pillGroup('Fix problems or only find them', FIX_CHOICES, job?.mode || 'fix', { keyPrefix: 'fix', onChange: (next) => { fixDesc.textContent = FIX_HINT[next]; syncEditors(); } });
      const fixRow = el('div', 'cs-set');
      const fixInfo = el('div', 'cs-info');
      const fixDesc = el('span', 'cs-desc', FIX_HINT[mode.value]);
      fixInfo.append(el('span', 'cs-title', 'When it finds a problem'), fixDesc);
      fixRow.append(fixInfo, mode.node);

      const groupsFor = (role) => {
        const entry = info[role];
        const byAgent = {};
        for (const choice of entry.choices || []) (byAgent[choice.agent] ||= []).push([choice.id, choice.label]);
        const groups = [['', [['auto', `Automatic: ${entry.auto}`]]]];
        for (const agent of ['gemini', 'claude', 'codex']) if (byAgent[agent]) groups.push([AGENT_TITLE[agent], [[agent, `${AGENT_TITLE[agent]}, its default model`], ...byAgent[agent]]]);
        return groups;
      };
      const rows = {};
      for (const role of ROLE_ORDER) if (info[role]) rows[role] = choiceRow(info[role].name, info[role].hint, groupsFor(role), saved[role] || 'auto');
      const geminiEdits = () => rows.editor?.select.value === 'gemini' && rows.visualEditor?.select.value === 'gemini';
      const geminiHint = () => `Off: ${info.editor?.auto || 'Codex or Claude'} fix. They are better at fixing right now, so Automatic leaves Gemini out whenever either is installed.`;
      const geminiSwitch = switchRow('Let Gemini make the fixes', geminiHint(), geminiEdits(), (on) => { for (const role of ['editor', 'visualEditor']) rows[role]?.select.set(on ? 'gemini' : 'auto'); });
      geminiSwitch.row.dataset.key = 'gemini-fixes';
      geminiSwitch.row.hidden = !rows.editor;
      for (const role of ['editor', 'visualEditor']) if (rows[role]) rows[role].select.onchange = () => geminiSwitch.set(geminiEdits());
      function syncEditors() { const find = mode.value === 'find'; geminiSwitch.row.hidden = find || !rows.editor; for (const role of ['editor', 'visualEditor']) if (rows[role]) rows[role].row.hidden = find; }

      const visual = choiceRow('Visual checks', 'Automatic uses Visor on an Astro site wired to it, Playwright on any other site, and skips projects with no pages, such as iOS apps.', [['', VISUAL_CHOICES]], chosen.visual || 'auto');
      const agents = choiceRow('Scouts', 'How many agents read the project at once, each on a different aspect.', [['', Array.from({ length: 10 }, (_, index) => [String(10 - index), `${10 - index} scouts`])]], String(chosen.agents || 10));
      const parallel = choiceRow('Fixes at once', 'How many fixes are made at the same time, each in its own copy.', [['', Array.from({ length: 6 }, (_, index) => [String(index + 1), index ? `${index + 1} at once` : 'One at a time'])]], String(chosen.parallelFixes || 3));
      const advanced = el('div', 'cs-set-list');
      advanced.append(...ROLE_ORDER.filter((role) => rows[role]).map((role) => rows[role].row), visual.row, agents.row, parallel.row);
      const top = el('div', 'cs-set-list');
      top.append(fixRow, geminiSwitch.row);
      syncEditors();
      return { top, advanced, read: () => ({ mode: mode.value,
        roles: Object.fromEntries(Object.entries(rows).filter(([, row]) => row.select.value !== 'auto').map(([role, row]) => [role, row.select.value])),
        options: { visual: visual.select.value, agents: Number(agents.select.value), parallelFixes: Number(parallel.select.value) } }) };
    }

    // ---------- Overview and bar ----------
    function renderBar() {
      bar.replaceChildren();
      if (!snapshot) { bar.hidden = true; return; }
      const live = armed();
      bar.hidden = !live.length && !activeIds().length;
      if (bar.hidden) return;
      const running = activeIds().length > 1 ? `${activeIds().length} runs are in progress. ` : activeIds().length ? 'A run is in progress. ' : '';
      const awake = snapshot.keepingAwake ? ' The computer is kept awake.' : '';
      bar.append(el('span', 'inv-bar-text', `${running}${plural(live.length, 'loop')} active.${awake}`));
      bar.append(button('Stop all', () => act('stopAll', () => request({ action: 'stopAll' }), 'Everything is stopped. Nothing will start until you start a loop again.'),
        { className: 'is-danger', iconName: 'stop', key: 'stopAll', disabled: busy.has('stopAll') }));
    }

    function renderOverview(now) {
      overview.replaceChildren();
      const row = el('div', 'cs-row');
      const mark = el('span', 'cs-icon'); mark.innerHTML = ICON.loop;
      const info = el('div', 'cs-info');
      info.append(el('span', 'cs-title', 'Loops'),
        el('span', 'cs-desc', 'Background runs that look for bugs and layout problems in a private copy of your project. Your files are never edited.'));
      row.append(mark, info);
      overview.append(row);
      const actions = el('div', 'cs-actions inv-actions');
      const start = button(formOpen ? 'Close' : 'New loop',() => { formOpen = !formOpen; formNode = null; if (formOpen) editing = null; render(); if (formOpen) formHost.querySelector('.cs-dd-trigger, input')?.focus(); },
        { className: formOpen ? '' : 'is-primary', iconName: formOpen ? '' : 'plus', key: 'start', disabled: !snapshot || Boolean(unavailable) });
      start.setAttribute('aria-expanded', String(formOpen));
      actions.append(start);
      overview.append(actions);
      if (snapshot && !snapshot.jobs.length) {
        overview.append(el('p', 'cs-connection-note', 'No loops yet. Pick what it should do, choose a project and press Start. A loop does a few bounded passes, one at a time, and yields to your own chats.'));
      }
    }

    // ---------- Create form ----------
    let formApi = null;
    function renderForm() {
      if (!formOpen || !snapshot) { formNode = null; formApi = null; formHost.replaceChildren(); return; }
      if (formNode) { if (formHost.firstElementChild !== formNode) formHost.replaceChildren(formNode); return; }
      const card = el('section', 'cs-card inv-form inv-bud');
      card.setAttribute('aria-label', 'New loop');
      const lead = el('div', 'inv-lead');
      const leadText = el('p');
      lead.append(leadText);
      let mode = 'full';
      const LEADS = {
        full: 'Up to ten agents read the project, each on a different aspect. Other agents try to refute every candidate, editors fix what holds up in a private copy, and the checks and a look at the pages show whether anything broke. Your files are never edited.',
        diagnose: 'Checks a frozen copy of your project and has Flash write down what looks wrong. Nothing is fixed.',
        fixloop: 'Flash finds problems one lens at a time, Claude and Codex fix them in a private copy, and Flash checks each fix. You get a report and a patch. Your files are never edited.',
        tester: 'Opens the chat window at three widths, measures layout problems, and has Flash confirm what it sees. You get a report and a handoff another agent can fix from.',
      };
      const projects = options?.projects || [];
      const models = options?.flashModels || [];
      const pick = (label, hint, choices, selected) => choiceRow(label, hint, [['', choices]], selected);
      const project = pick('Project', 'The tracked source here is copied for each run.', projects.map((p) => [p.id, p.name]), options?.projectId);
      const model = pick('Flash model', 'Used exactly as chosen. There is no fallback to another model.', models.map((m) => [m.id, m.label || m.id]),
        models.find((m) => m.id === 'gemini-3.8-flash-high')?.id);
      const full = fullControls(null);
      const modeRow = el('div', 'cs-set');
      const modeInfo = el('div', 'cs-info');
      modeInfo.append(el('span', 'cs-title', 'What it does'));
      const modeGroup = pillGroup('What the loop does', MODES, mode, { keyPrefix: 'mode', onChange: (next) => setMode(next) });
      modeRow.append(modeInfo, modeGroup.node);
      const list = el('div', 'cs-set-list'); list.append(modeRow, lead, project.row);
      const optionsBody = el('div', 'cs-set-list'); optionsBody.append(model.row, full.advanced);
      const optionsBox = el('details', 'inv-advanced inv-options');
      const optionsSummary = el('summary', 'cs-row inv-more');
      optionsSummary.append(el('span', 'cs-title', 'Options'), el('span', 'cs-desc', 'Models, runs, limits and how long the loop may go on.'));
      optionsSummary.insertAdjacentHTML('beforeend', ICON.chevron);
      optionsBox.append(optionsSummary, optionsBody);
      const defaultsFor = (recipe) => (recipe === 'full' ? snapshot.fullDefaults : recipe === 'fixloop' ? snapshot.fixDefaults : recipe === 'tester' ? snapshot.testerDefaults : null) || snapshot.defaults;
      const limitsFor = (recipe) => limitsForm(defaultsFor(recipe), { withExpiry: recipe !== 'full', hours: 8, recipe });
      formApi = limitsFor(mode);
      optionsBody.append(formApi.node);
      const problemFor = (recipe) => !projects.length ? 'Register a code project first.'
        : recipe === 'full' ? (options?.roles?.scout?.auto === 'Nothing available' ? 'No model can run the scouts. Connect Antigravity, Claude Code or Codex.' : '')
        : !models.length ? 'No Flash model is available. Connect Antigravity under General.' : '';
      const note = el('p', 'cs-note');
      const footer = el('div', 'cs-actions inv-actions');
      const pausedActions = el('div', 'cs-actions inv-actions');
      function setMode(next) {
        mode = next;
        leadText.textContent = LEADS[next];
        model.row.hidden = next === 'full'; full.advanced.hidden = next !== 'full'; full.top.hidden = next !== 'full';
        if (formApi && formApi.node.isConnected) { const old = formApi.node; formApi = limitsFor(next); old.replaceWith(formApi.node); }
        const problem = problemFor(next);
        note.textContent = problem || (next === 'full' ? 'The loop keeps going until nothing is left to fix, and picks up where it stopped if you close the IDE. It waits for idle time and spare quota.' : 'A loop waits for idle time and spare quota, and yields to your own chats. Reserved tokens are an admission limit, not a bill.');
        note.classList.toggle('is-error', Boolean(problem));
        for (const node of card.querySelectorAll('[data-key="arm"], [data-key="createPaused"]')) node.disabled = Boolean(problem) || busy.has('create');
      }
      const submit = async (start) => {
        const read = formApi.read();
        if (read.problem) { optionsBox.open = true; card.querySelector('[aria-invalid="true"]')?.focus(); return; }
        const buttons = [...card.querySelectorAll('.cs-actions button')];
        buttons.forEach((b) => { b.disabled = true; });
        const done = await act('create', async () => {
          const created = mode === 'full' ? { action: 'create', projectId: project.select.value, recipe: 'full', ...full.read(), limits: read.limits }
            : { action: 'create', projectId: project.select.value, model: model.select.value, recipe: mode, limits: read.limits, expiresAt: Date.now() + read.hours * 3600000 };
          const job = await request(created);
          if (start) {
            try { await request({ action: 'start', id: job.id }); }
            catch (error) { throw new Error(`The loop was created but could not start: ${error.message}`); }
          }
          return job;
        }, start ? 'Loop started. It runs when you are idle and quota allows.' : 'Created and paused. Start it from the list when you are ready.');
        if (done) { formOpen = false; render(); } else buttons.forEach((b) => { b.disabled = false; });
      };
      footer.append(
        button('Start loop', () => submit(true), { className: 'is-primary', iconName: 'play', key: 'arm' }),
        button('Cancel', () => { formOpen = false; formNode = null; render(); }, { className: 'is-quiet', key: 'cancel' }));
      pausedActions.append(button('Create paused instead', () => submit(false), { className: 'is-quiet', key: 'createPaused' }));
      optionsBody.append(pausedActions);
      card.append(list, full.top, optionsBox, note, footer);
      setMode(mode);
      formNode = card;
      formHost.replaceChildren(card);
    }

    // ---------- Loops ----------
    /** "Scouts: Gemini · Fixes: Codex" for pinned roles; a full loop with nothing pinned says it follows what is installed. */
    function rolesText(job) {
      const pinned = Object.entries(job.roles || {}).map(([role, value]) => `${options?.roles?.[role]?.name || role}: ${value}`);
      return pinned.length ? pinned.join(' · ') : 'Models chosen automatically';
    }
    /** One small chip per scout or fix with its state; text only, since titles come from a model. */
    function liveChips(items, title) {
      const box = el('div', 'inv-chips');
      box.setAttribute('role', 'list'); box.setAttribute('aria-label', title);
      for (const item of items) {
        const name = item.short || item.label || item.title || item.id;
        const chip = el('span', `inv-chip is-${String(item.state).replace(/[^\w-]/g, '')}`, name);
        chip.setAttribute('role', 'listitem'); chip.title = `${item.label || item.title || item.id}: ${item.state}${item.reason ? ` — ${item.reason}` : ''}${item.found ? `, ${plural(item.found, 'candidate')}` : ''}`;
        box.append(chip);
      }
      return box;
    }
    function stageStrip(run, recipe) {
      const stages = STAGES[recipe] || STAGES.diagnose;
      const current = stages.findIndex(([name]) => name === run.stage);
      const strip = el('ol', 'inv-stages');
      strip.setAttribute('aria-label', 'Run progress');
      stages.forEach(([name, label], index) => {
        const item = el('li', index < current ? 'is-done' : index === current ? 'is-now' : '', label);
        if (index === current) item.setAttribute('aria-current', 'step');
        strip.append(item);
      });
      return strip;
    }

    function renderJob(job, now) {
      const state = jobState(job, now);
      const card = el('article', 'cs-card inv-job');
      card.dataset.state = state.key;
      const row = el('div', 'cs-row');
      const info = el('div', 'cs-info');
      info.append(el('span', 'cs-title', projectName(job)), el('span', job.recipe === 'full' ? 'cs-desc' : 'cs-desc is-mono', job.recipe === 'full' ? rolesText(job) : job.model));
      row.append(info);
      if (job.recipe === 'full') row.append(tag(job.mode === 'find' ? 'Full loop, find only' : 'Full loop', 'ok'));
      if (job.recipe === 'fixloop') row.append(tag('Find and fix', 'ok'));
      if (job.recipe === 'tester') row.append(tag('Interface test', 'ok'));
      row.append(tag(state.label, state.tone));
      card.append(row);

      const run = activeRun(job);
      if (run) {
        const live = el('div', 'inv-live');
        live.append(stageStrip(run, job.recipe), el('p', 'cs-desc', `${topicName(run.topic)}. Started ${duration(now - run.startedAt)} ago.${run.stage ? '' : ' Preparing…'}${run.resumes ? ` Resumed ${plural(run.resumes, 'time')} after a restart.` : ''}`),
          el('p', 'cs-desc', usageText(run)));
        if (run.live?.note) live.append(el('p', 'cs-desc inv-note', run.live.note));
        if (run.live?.agents?.length) live.append(liveChips(run.live.agents, 'Scouts'));
        if (run.live?.fixes?.length) live.append(liveChips(run.live.fixes.map((fix) => ({ ...fix, short: fix.title })), 'Fixes'));
        card.append(live);
      }
      const facts = el('dl', 'inv-facts');
      const reason = job.reason || '';
      facts.append(
        fact(run ? 'Activity' : job.enabled ? 'Waiting because' : 'Status', run ? run.live?.note || 'Run in progress' : reason || '—', { preview: true }),
        fact('Expires', job.expiresAt == null ? 'Never. It ends when it is done or you stop it.' : job.expiresAt > now ? `${clock(job.expiresAt, now)} (in ${duration(job.expiresAt - now)})` : `${clock(job.expiresAt, now)} (past)`),
        fact('Next eligible run', run ? 'Running now' : !job.enabled ? 'Not scheduled' : job.nextRunAt > now ? `${clock(job.nextRunAt, now)} (in ${duration(job.nextRunAt - now)})` : 'As soon as the conditions above allow'),
        fact('Runs started', `${job.completedRuns} of ${job.limits.maxRuns}`),
        fact('Per-run reserve', `${count(job.limits.maxTokensPerRun)} tokens, ${job.limits.maxRunMinutes} min limit`),
        fact('Spacing and reserve', `${job.limits.intervalMinutes ? `${job.limits.intervalMinutes} min apart` : 'Back to back'}, ${job.limits.reservePercent}% quota kept free`));
      if (job.recipe === 'full') {
        facts.append(fact('Cycles done', `${job.cycles || 0}${job.shards > 1 ? ` of about ${job.shards} for the whole project` : ''}`),
          fact('Carried over', `${plural((job.backlog || []).length, 'open problem')} for the next cycle`),
          fact('Visual checks', job.options?.visual && job.options.visual !== 'auto' ? cap(job.options.visual) : 'Automatic'));
      }
      if (job.recipe === 'fixloop') {
        facts.append(fact('Fix loop', `${plural(job.limits.fixesPerCycle, 'fix', 'fixes')} per cycle, ${job.limits.fixMinutes} min each`),
          fact('Carried over', `${plural((job.backlog || []).length, 'open problem')} for the next cycle`),
          fact('Hourly allowance', `${count(job.limits.hourlyTokens)} tokens`));
      }
      card.append(facts);

      if (editing === job.id) {
        let editor = editors.get(job.id);
        if (!editor) { editor = limitsForm(job.limits, { recipe: job.recipe }); if (job.recipe === 'full') editor.full = fullControls(job); editors.set(job.id, editor); }
        const bud = el('div', 'inv-edit inv-bud');
        bud.append(el('p', 'cs-note', 'Editing a paused loop. An active loop cannot be edited.'), ...(editor.full ? [editor.full.top, editor.full.advanced] : []), editor.node);
        const footer = el('div', 'cs-actions inv-actions');
        footer.append(
          button(job.recipe === 'full' ? 'Save' : 'Save limits', async () => {
            const read = editor.read();
            if (read.problem) return;
            if (await act(`save-${job.id}`, () => request({ action: 'configure', id: job.id, limits: read.limits, ...(editor.full ? editor.full.read() : {}) }), 'Saved.')) { editing = null; editors.delete(job.id); render(); }
          }, { className: 'is-primary', key: `save-${job.id}`, disabled: busy.has(`save-${job.id}`) }),
          button('Cancel', () => { editing = null; editors.delete(job.id); render(); }, { className: 'is-quiet', key: `cancel-${job.id}` }));
        bud.append(footer);
        card.append(bud);
      } else {
        const actions = el('div', 'cs-actions inv-actions');
        if (job.enabled) {
          if (!run && job.nextRunAt > now) actions.append(button('Run now', () => act(`now-${job.id}`, () => request({ action: 'runNow', id: job.id }), 'Starting now.'),
            { className: 'is-primary', iconName: 'play', key: `now-${job.id}`, disabled: busy.has(`now-${job.id}`) }));
          actions.append(button(run ? 'Pause and cancel run' : 'Pause', () => act(`pause-${job.id}`, () => request({ action: 'pause', id: job.id }), 'Paused.'),
            { iconName: 'pause', key: `pause-${job.id}`, disabled: busy.has(`pause-${job.id}`) }));
        } else {
          if (canStart(job, now)) actions.append(button('Start', () => act(`start-${job.id}`, () => request({ action: 'start', id: job.id }), 'Loop started. It runs when you are idle and quota allows.'),
            { className: 'is-primary', iconName: 'play', key: `start-${job.id}`, disabled: busy.has(`start-${job.id}`) }));
          if (canStart(job, now)) actions.append(button(job.recipe === 'full' ? 'Edit settings' : 'Edit limits', () => { editing = job.id; formOpen = false; formNode = null; editors.delete(job.id); render(); }, { key: `edit-${job.id}` }));
        }
        if (confirmingDelete === job.id) {
          card.append(el('p', 'cs-note', `Deletes this loop${run ? ', cancels its run' : ''} and its working copy. Its reports stay below, and the allowance it already used is not given back.`));
          actions.append(
            button('Delete for good', () => act(`delete-${job.id}`, async () => { await request({ action: 'delete', id: job.id }); confirmingDelete = null; }, 'Loop deleted. Create a new one with the current defaults.'),
              { className: 'is-danger', iconName: 'trash', key: `delete-${job.id}`, disabled: busy.has(`delete-${job.id}`) }),
            button('Keep it', () => { confirmingDelete = null; render(); }, { className: 'is-quiet', key: `keep-${job.id}` }));
        } else actions.append(button('Delete', () => { confirmingDelete = job.id; render(); }, { className: 'is-quiet', iconName: 'trash', key: `ask-delete-${job.id}` }));
        card.append(actions);
      }
      return card;
    }

    function renderJobs(now) {
      jobsHost.replaceChildren();
      if (!snapshot || !snapshot.jobs.length) return;
      jobsHost.append(section('Loops', 'Newest first'));
      const ordered = snapshot.jobs.slice().sort((a, b) => b.createdAt - a.createdAt);
      const live = ordered.filter((job) => job.enabled || activeRun(job) || canStart(job, now));
      const earlier = ordered.filter((job) => !live.includes(job));
      for (const job of live) jobsHost.append(renderJob(job, now));
      if (earlier.length) {
        const body = el('div', 'inv-stack');
        for (const job of earlier) body.append(renderJob(job, now));
        const summary = el('summary', 'cs-row inv-more');
        summary.append(el('span', 'cs-title', `Earlier loops (${earlier.length})`), el('span', 'cs-desc', 'Finished, expired or stopped.'));
        summary.insertAdjacentHTML('beforeend', ICON.chevron);
        jobsHost.append(details('earlier-jobs', summary, body, 'cs-card inv-earlier'));
      }
    }

    // ---------- Reports ----------
    function runTone(run) {
      return run.status === 'failed' ? 'bad' : run.status === 'interrupted' ? 'warn' : run.status === 'running' ? 'run' : run.status === 'completed' && run.loop?.mode === 'find' ? ((run.loop.found || []).length ? 'warn' : 'ok') : run.status === 'completed' && run.loop ? ((run.loop.unfixed || []).length ? 'warn' : run.loop.fixed.length ? 'ok' : '') : run.status === 'completed' && run.findings.length ? 'warn' : '';
    }
    function usageText(run) {
      if (run.status === 'running' && run.live?.scoutTokens > 0) return `${count(run.chargedTokens)} tokens reserved; ${count(run.live.scoutTokens)} tokens reported by completed scouts (run total pending)`;
      if (run.status === 'running') return `${count(run.chargedTokens)} tokens reserved; measured usage is reported when the run finishes`;
      if (run.tokenUsage !== null && run.tokenUsage !== undefined) return `${count(run.tokenUsage)} tokens measured`;
      return `Usage unknown, full ${count(run.chargedTokens)} token reservation kept`;
    }
    function labelled(title, text) {
      const block = el('div', 'inv-block');
      block.append(el('h5', '', title), el('p', '', text || 'Not stated.'));
      return block;
    }
    const FIX_LABEL = { fixed: 'Fixed', unverified: 'Applied, unverified', unfixed: 'Unfixed', failed: 'Fix failed', rejected: 'Fix reverted', nochange: 'Nothing changed', skipped: 'No fixer' };
    function renderFinding(finding) {
      const card = el('article', 'inv-finding');
      card.dataset.severity = finding.severity;
      const head = el('div', 'inv-finding-head');
      head.append(tag(`${finding.severity[0].toUpperCase()}${finding.severity.slice(1)} severity`, finding.severity === 'high' ? 'bad' : finding.severity === 'medium' ? 'warn' : ''),
        tag(finding.status === 'observed' ? 'Observed' : 'Suspected', finding.status === 'observed' ? 'ok' : ''));
      if (finding.fix) head.append(tag(FIX_LABEL[finding.fix.status] || finding.fix.status, finding.fix.status === 'fixed' ? 'ok' : finding.fix.status === 'unverified' ? 'warn' : 'bad'));
      card.append(head, el('h4', 'inv-finding-title', finding.title));
      card.append(labelled('Expected', finding.expected), labelled('Observed', finding.observed), labelled('Suspected cause', finding.suspectedCause),
        labelled('Reproduction', finding.reproduction), labelled('Uncertainty', finding.uncertainty));
      const evidence = el('div', 'inv-block');
      evidence.append(el('h5', '', 'Evidence'));
      const list = el('ul', 'inv-evidence');
      for (const item of finding.evidence || []) {
        const li = el('li');
        li.append(el('code', '', `${item.file}:${item.line}`), el('span', '', item.detail));
        list.append(li);
      }
      evidence.append(list);
      card.append(evidence);
      return card;
    }
    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return; } catch { /* fall back below */ }
      const area = el('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.append(area); area.select();
      const ok = document.execCommand('copy'); area.remove();
      if (!ok) throw new Error('Copying was blocked. Use Review with… instead, or open the report file.');
    }
    const LOOP_GROUPS = [['found', 'Confirmed problems (nothing was edited)', 'found', 'warn'], ['fixed', 'Fixed and verified', 'fixed', 'ok'], ['unverified', 'Applied, not verified', 'unverified', 'warn'], ['unfixed', 'Still unfixed', 'unfixed', 'bad'],
      ['newIssues', 'New issues found while verifying', 'new', 'warn'], ['additional', 'Found, queued for the next cycle', 'queued', '']];
    const AGENT = { claude: 'Claude', codex: 'Codex' };
    function checkLine(label, checks) {
      const parts = (checks || []).filter((check) => check.name === 'syntax' || check.name === 'tests').map((check) => `${check.name} ${check.exitCode === 0 ? 'passed' : 'failed'}`);
      return parts.length ? `${label}: ${parts.join(', ')}.` : '';
    }
    /** The fix loop's own report: what was fixed, what was not, and what verification turned up. Titles come from a model, so textContent only. */
    function renderLoop(run) {
      const loop = run.loop;
      const box = el('div', 'inv-loop');
      const counts = el('div', 'inv-loop-counts');
      for (const [key, , short, tone] of LOOP_GROUPS) if ((loop[key] || []).length) counts.append(tag(`${loop[key].length} ${short}`, tone));
      if (!counts.childElementCount) counts.append(tag('Nothing found', 'ok'));
      box.append(counts);
      for (const [key, title] of LOOP_GROUPS) {
        const items = loop[key] || [];
        if (!items.length) continue;
        const block = el('div', 'inv-block'); block.append(el('h5', '', title));
        const list = el('ul', 'inv-loop-list');
        for (const item of items) {
          const li = el('li');
          const head = el('div', 'inv-loop-item');
          head.append(el('span', 'inv-loop-title', item.title));
          const meta = [item.kind, item.area, item.agent ? `by ${AGENT[item.agent] || item.agent}` : '', item.gaveUp ? 'given up after two attempts' : ''].filter(Boolean).join(' · ');
          head.append(el('span', 'cs-desc', meta));
          li.append(head);
          if (item.reason) li.append(el('p', 'inv-loop-reason', item.reason));
          list.append(li);
        }
        block.append(list); box.append(block);
      }
      const checks = [checkLine('Before the fixes', loop.checksBefore), checkLine('After the fixes', loop.checksAfter)].filter(Boolean).join(' ');
      if (checks) box.append(el('p', 'cs-desc', checks));
      if (loop.agents?.length) {
        const done = loop.agents.filter((agent) => agent.status === 'done').length;
        const block = el('div', 'inv-block'); block.append(el('h5', '', 'Scouts'), el('p', 'cs-desc', `${done} of ${loop.agents.length} finished${loop.confirm ? `; ${loop.confirm.proposed || 0} candidates, ${loop.confirm.confirmed || 0} confirmed, ${loop.confirm.rejected || 0} refuted` : ''}.`));
        block.append(liveChips(loop.agents.map((agent) => ({ ...agent, state: agent.status || 'skipped', found: agent.found })), 'Scouts')); box.append(block);
      }
      if (loop.visual) box.append(el('p', 'cs-desc', loop.visual.ok ? `Visual checks (${loop.visual.provider}): ${plural(loop.visual.routes?.length || 0, 'page')}, ${plural(loop.visual.measured || 0, 'new layout problem')}.` : `Visual checks did not run${loop.visual.reason ? `: ${loop.visual.reason}` : '.'}`));
      if ((loop.regressions || []).length) box.append(el('p', 'cs-desc', `${plural(loop.regressions.length, 'fix', 'fixes')} thrown out for breaking a check.`));
      if (!loop.verified && loop.mode !== 'find' && (loop.unverified || []).length) box.append(el('p', 'cs-desc', 'Flash did not verify these changes this cycle, for lack of allowance or a missing answer.'));
      return box;
    }
    function renderRun(run, now) {
      const incomplete = run.reviewIncomplete || (run.topic === 'interface testing' && run.questions?.length);
      const emptyLabel = run.topic === 'interface testing' ? 'No new findings' : 'Clean';
      const summary = el('summary', 'cs-row inv-run-summary');
      const info = el('div', 'cs-info');
      const finished = run.finishedAt || run.startedAt;
      info.append(el('span', 'cs-title', topicName(run.topic)),
        el('span', 'cs-desc inv-preview', `${clock(finished, now)} · ${run.status === 'completed' ? (run.loop?.mode === 'find' ? plural(run.loop.found.length, 'problem') + ' found' : run.loop ? plural(run.loop.fixed.length, 'problem') + ' fixed' : plural(run.findings.length, 'finding')) : run.status === 'running' ? 'in progress' : run.reason || run.status}`));
      summary.append(info, tag(run.status === 'completed' ? incomplete ? 'Review incomplete' : (run.loop ? (run.loop.mode === 'find' ? (run.loop.found.length ? `${run.loop.found.length} found` : emptyLabel) : run.loop.fixed.length ? `${run.loop.fixed.length} fixed` : run.findings.length ? `${run.findings.length} found` : emptyLabel) : run.findings.length ? `${run.findings.length} found` : emptyLabel) : run.status[0].toUpperCase() + run.status.slice(1), incomplete ? 'warn' : runTone(run)));
      summary.insertAdjacentHTML('beforeend', ICON.chevron);

      const body = el('div', 'inv-run');
      body.append(el('p', 'cs-desc', usageText(run)));
      if (run.status !== 'completed' && run.reason) body.append(el('p', 'inv-reason', run.reason));
      if (run.status === 'completed') {
        if (run.summary) body.append(labelled('Summary', run.summary));
        if (run.loop) body.append(renderLoop(run));
        if (!run.findings.length && !run.loop) body.append(el('p', 'inv-clean', incomplete ? 'The visual review did not complete. This report cannot confirm the interface is clean.' : run.topic === 'interface testing' ? 'No new findings in this run. Previously reported problems may still be present.' : 'No findings. A clean report is a valid result, not a failure. It only covers the evidence this run was given.'));
        for (const finding of run.findings.slice().sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity])) body.append(renderFinding(finding));
        if (run.questions?.length) {
          const block = el('div', 'inv-block'); block.append(el('h5', '', 'Unresolved questions'));
          const list = el('ul', 'inv-questions'); for (const q of run.questions) list.append(el('li', '', q));
          block.append(list); body.append(block);
        }
        const actions = el('div', 'cs-actions inv-actions');
        actions.append(
          button('Copy handoff', () => act(`copy-${run.id}`, async () => { const handoff = await request({ action: 'handoff', runId: run.id }); await copyText(handoff.prompt); }, 'Handoff copied. Paste it into any chat you choose.'),
            { iconName: 'copy', key: `copy-${run.id}`, disabled: busy.has(`copy-${run.id}`) }),
          button('Review with…', () => { reviewing = reviewing === run.id ? null : run.id; render(); },
            { iconName: 'send', key: `review-${run.id}` }));
        body.append(actions);
        if (reviewing === run.id) body.append(renderReview(run));
        body.append(el('p', 'inv-caution', run.loop?.patch
          ? 'Every change was made in a private copy. Nothing in your project has changed. Open the patch, review it, and apply it yourself from your project folder with git apply.'
          : 'This report describes a frozen snapshot. Whoever reads it must check each claim against the current source first.'));
      }
      const files = (run.artifacts || []).map(basename).filter((name) => ARTIFACTS[name]);
      if (files.length) {
        const block = el('div', 'inv-block'); block.append(el('h5', '', 'Files'));
        const row = el('div', 'inv-files');
        for (const name of files) row.append(button(ARTIFACTS[name], () => act(`open-${run.id}-${name}`, () => request({ action: 'openArtifact', runId: run.id, name })), { className: 'is-small is-quiet', iconName: 'file', key: `open-${run.id}-${name}` }));
        block.append(row);
        if (files.includes('queue.png')) block.append(el('p', 'cs-desc', 'The render is a recorded fixture for you to look at. It is not an interaction test, and Flash did not see it.'));
        body.append(block);
      }
      return details(`run-${run.id}`, summary, body, 'cs-card inv-run-card');
    }
    function renderReview(run) {
      const models = options?.reviewModels || [];
      const bud = el('div', 'inv-review inv-bud');
      if (!models.length) {
        bud.append(el('p', 'cs-note is-error', 'No review model is connected. Connect Claude Code or Codex under General, or use Copy handoff.'));
        return bud;
      }
      const label = el('label', 'cs-title', 'Review with');
      label.id = `inv-review-${run.id}`;
      const byAgent = new Map();
      for (const model of models) byAgent.set(model.agent, [...(byAgent.get(model.agent) || []), model]);
      const select = dropdown({ labelId: label.id, groups: [...byAgent].map(([agent, group]) => [(window.AGENT_NAMES || {})[agent] || agent, group.map((model) => [model.id, model.label || model.id])]) });
      const project = options?.projects?.find((p) => p.id === run.projectId);
      bud.append(label, select.node,el('p', 'cs-desc', `Opens a new chat in ${project?.name || 'the report’s project'} with the handoff as a draft. Nothing is sent until you press send.`));
      const actions = el('div', 'cs-actions inv-actions');
      actions.append(
        button('Open draft in new chat', () => act(`go-${run.id}`, async () => { await request({ action: 'review', runId: run.id, modelId: select.value }); reviewing = null; }, 'Draft ready in a new chat.'),
          { className: 'is-primary', iconName: 'send', key: `go-${run.id}`, disabled: busy.has(`go-${run.id}`) }),
        button('Cancel', () => { reviewing = null; render(); }, { className: 'is-quiet', key: `cancel-review-${run.id}` }));
      bud.append(actions);
      return bud;
    }
    function renderResults(now) {
      resultsHost.replaceChildren();
      if (!snapshot) return;
      resultsHost.append(section('Reports', 'Findings first, newest on top'));
      const runs = snapshot.runs.slice().sort((a, b) => b.startedAt - a.startedAt);
      if (!runs.length) {
        resultsHost.append(el('p', 'cs-note inv-empty', 'No runs yet. Reports appear here as each run finishes. An empty report is a valid result.'));
        return;
      }
      const shown = showAllRuns ? runs : runs.slice(0, 8);
      const stack = el('div', 'inv-stack');
      for (const run of shown) stack.append(renderRun(run, now));
      resultsHost.append(stack);
      if (runs.length > shown.length) resultsHost.append(button(`Show ${runs.length - shown.length} older`, () => { showAllRuns = true; render(); }, { className: 'is-quiet', key: 'older' }));
    }

    // ---------- Whole page ----------
    function renderUnavailable() {
      const card = el('section', 'cs-card inv-unavailable');
      const row = el('div', 'cs-row');
      const info = el('div', 'cs-info');
      info.append(el('span', 'cs-title', 'Loops are unavailable here'), el('span', 'cs-desc', unavailable));
      row.append(info, tag('Not running', 'warn'));
      card.append(row);
      const actions = el('div', 'cs-actions inv-actions');
      actions.append(button('Check again', () => { say(''); void refresh(); }, { key: 'again' }));
      card.append(actions);
      return card;
    }
    function render() {
      const focused = root.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
      const now = Date.now();
      if (unavailable) {
        bar.hidden = true;
        for (const host of [overview, formHost, jobsHost]) host.replaceChildren();
        formNode = null; formApi = null;
        resultsHost.replaceChildren(renderUnavailable());
      } else {
        renderBar(); renderOverview(now); renderForm(); renderJobs(now); renderResults(now);
        if (!snapshot && !loaded) overview.append(el('p', 'cs-connection-note', 'Loading…'));
      }
      if (focused) root.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }

    // Relative times ("in 12m") move even when nothing is pushed; only a visible tab redraws.
    const clockTimer = setInterval(() => { if (snapshot && root.offsetParent) render(); }, 15000);
    return {
      message,
      watch() { void request({ action: 'list' }).catch(error => { if (!error.unavailable) say(error.message, 'error'); }); },
      show() { void refresh(); },
      dispose() { clearInterval(clockTimer); clearTimeout(statusTimer); for (const entry of pending.values()) clearTimeout(entry.timer); pending.clear(); },
    };
  };
})();
