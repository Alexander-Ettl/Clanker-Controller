(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const AGENT_IDS = ['claude', 'codex', 'gemini'];
  const AGENT_NAMES = window.AGENT_NAMES || { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity' };
  const terminalBtn = document.getElementById('terminalBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const historyBtn = document.getElementById('historyBtn');
  const AGENT_ICONS = window.AGENT_ICONS || {};
  const AUTO_ICON = '<svg class="agent-logo" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5 9.2 5l3.5 1.2-3.5 1.2L8 10.9 6.8 7.4 3.3 6.2l3.5-1.2L8 1.5Z" fill="currentColor"/><path d="M13 10.5 13.6 12l1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z" fill="currentColor"/></svg>';
  // Composer model picker: 'auto' plus lib/model-catalog.js (injected by the host).
  const MODEL_OPTIONS = [{ id: 'auto', agent: 'auto', label: 'Auto', hint: 'Best available favorite for each task' }, ...(window.MODEL_CATALOG || [])];
  let availableModels = window.AVAILABLE_MODELS || [];
  let pendingModelId = null;
  const modelPickerBtn = document.getElementById('modelPill');

  const promptInput = document.getElementById('promptInput');
  const sendBtn = document.getElementById('sendBtn');
  const micBtn = document.getElementById('micBtn');
  const transcriptEl = document.getElementById('transcript');

  let activeModelId = 'auto';
  let activeAgent = 'auto';
  let lastQuotas = {};
  let currentAssistantBubble = null;
  // Each exchange (your message, its steps, the answer) lives in one .turn group
  // with a rail down its left side; the running turn's parts are appended into it.
  let currentTurnEl = null;
  const turnHost = () => (currentTurnEl?.isConnected ? currentTurnEl : transcriptEl);
  let openToolCard = null;
  let attachments = [];
  let emptyMascot = null;
  const chatDrafts = new Map();
  const projectBar = document.createElement('div');
  projectBar.className = 'project-toolbar'; projectBar.hidden = true;
  const projectBtn = document.createElement('button');
  projectBtn.type = 'button'; projectBtn.className = 'project-picker'; projectBtn.textContent = 'Choose project';
  projectBtn.setAttribute('aria-label', 'Choose project');
  projectBtn.addEventListener('click', () => { if (editingQueue) finishQueueEdit(); vscode.postMessage({ type: 'chooseProject' }); });
  const explorerBtn = document.createElement('button');
  explorerBtn.type = 'button'; explorerBtn.className = 'round-btn'; explorerBtn.title = 'Open project in Explorer';
  explorerBtn.setAttribute('aria-label', 'Open project in Explorer');
  explorerBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 4a1 1 0 0 1 1-1h4l2 2h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/></svg>';
  explorerBtn.addEventListener('click', () => vscode.postMessage({ type: 'openProjectExplorer' }));
  projectBar.append(projectBtn, explorerBtn);
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.prepend(projectBar); else transcriptEl.before(projectBar);

  const attachmentStrip = document.createElement('div');
  attachmentStrip.className = 'attachment-strip island-bud';
  document.querySelector('.compose-row').insertBefore(attachmentStrip, document.querySelector('.composer'));
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button'; attachBtn.id = 'attachBtn'; attachBtn.className = 'composer-icon-btn'; attachBtn.title = 'Attach files';
  attachBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  document.querySelector('.composer').insertBefore(attachBtn, promptInput);

  // ---------- P16-K: full-screen Liquid Glass modals (queue + history) ----------
  // The one trash can: Manage Chats' Delete, a queued turn's Delete and a scheduled prompt's Delete all draw it.
  const TRASH_PATH = '<path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.4M6.75 7v4M9.25 7v4"/>';
  const TRASH_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TRASH_PATH}</svg>`;
  const VERIFY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.75 2.75 3.75v4c0 3 2.2 5.2 5.25 6.5 3.05-1.3 5.25-3.5 5.25-6.5v-4z"/><path d="m5.6 8.2 1.7 1.7 3.1-3.4"/></svg>';
  const NOTE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></svg>';
  const CLOSE_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  // The suite's one pencil (sources/noun_Pencil_3437310.svg, omeneko / Noun Project): every edit button and the Edit tool card.
  const PENCIL_SVG = '<svg viewBox="7.99 7.95 496.01 496.06" fill="currentColor" aria-hidden="true"><path d="M339.24,100.59a8,8,0,0,0-11.32,0C21.76,406.75,39.26,388,37.51,393.51L8.76,483.11a16,16,0,0,0,20.13,20.13c97.07-31.14,92.2-28.84,96-32.67L411.41,184.08a8,8,0,0,0,0-11.32Z"/><path d="M403.22,25.29,361.86,66.65a8,8,0,0,0,0,11.31L434,150.14a8,8,0,0,0,11.31,0l41.36-41.36A58.65,58.65,0,0,0,504,67C504,14.85,440.44-11.93,403.22,25.29Z"/></svg>';
  const HANDLE_SVG ='<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></svg>';
  const MODEL_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  let lastFocus = null;
  function createModal(id, title) {
    const el = document.createElement('div');
    el.className = 'fs-modal'; el.id = id; el.hidden = true;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', title);
    el.innerHTML = `<div class="fs-modal-sheet glass"><header class="fs-modal-head"><h2></h2><span class="fs-modal-count"></span><button type="button" class="fs-modal-close" aria-label="Close">${CLOSE_SVG}</button></header><div class="fs-modal-body"></div></div>`;
    el.querySelector('h2').textContent = title;
    el.querySelector('.fs-modal-close').addEventListener('click', () => closeModal(el));
    el.addEventListener('mousedown', (event) => { if (event.target === el) closeModal(el); });
    document.body.appendChild(el);
    return { el, body: el.querySelector('.fs-modal-body'), count: el.querySelector('.fs-modal-count') };
  }
  // One popup at a time: opening one closes whichever is open (they used to pile up, and the covered one could no longer
  // be opened again). The button that opened a popup toggles it: a second click closes it.
  function openModal(modal) {
    const others = [...document.querySelectorAll('.fs-modal:not([hidden])')].filter((el) => el !== modal.el);
    if (!others.length) lastFocus = document.activeElement; // the first popup remembers where focus was; a switch keeps that
    others.forEach((el) => { el.hidden = true; });
    modal.el.hidden = false;
    modal.el.querySelector('.fs-modal-close').focus();
  }
  /** Opens the popup, or closes it when it is the one showing. Returns whether it is open now. */
  function toggleModal(modal) {
    if (!modal.el.hidden) { closeModal(modal.el); return false; }
    openModal(modal);
    return true;
  }
  function closeModal(el) {
    if (el.hidden) return;
    el.hidden = true;
    if (el.id === 'cliSetupModal') vscode.postMessage({ type: 'completeCliSetup' });
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = document.querySelector('.fs-modal:not([hidden])');
    if (open) { event.preventDefault(); closeModal(open); }
  });
  // P17-X: the exact catalog tier ("Claude Opus 5.5 High") when the task recorded one.
  function modelPill(model, modelId) {
    const pill = document.createElement('span');
    pill.className = `model-pill model-${model}`;
    pill.innerHTML = (window.AGENT_ICONS && window.AGENT_ICONS[model]) || `<span class="dot dot-${model}"></span>`;
    const exact = modelId && (window.MODEL_CATALOG || []).find((entry) => entry.id === modelId);
    pill.append(exact ? exact.label : MODEL_LABELS[model] || model);
    return pill;
  }
  // P17-X: 24h unless the user picks '12h', or 'auto' (the editor language's own convention).
  const TIME_PREFS = window.TIME_PREFS || {};
  const HOUR_CYCLE = { '24h': 'h23', '12h': 'h12' }[TIME_PREFS.timeFormat || '24h'];
  const clockParts = (extra) => ({ ...extra, hour: '2-digit', minute: '2-digit', ...(HOUR_CYCLE ? { hourCycle: HOUR_CYCLE } : {}) });
  function formatWhen(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(TIME_PREFS.locale, clockParts({ month: 'short', day: 'numeric' }));
  }
  // When a task will actually fire: its fixed time, else its model's next quota reset.
  function fireTimeOf(task) {
    if (task.dispatchTrigger === 'fixed-time') return Date.parse(task.dispatchTime) || null;
    const resetsAt = lastQuotas[task.model]?.resetsAt;
    return typeof resetsAt === 'number' ? resetsAt * 1000 : null;
  }
  function formatCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}h ${pad(m)}m ${pad(sec)}s` : m ? `${m}m ${pad(sec)}s` : `${sec}s`;
  }
  // The pill's countdown, one unit to a line (days, hours, minutes, seconds from the largest that is not zero), right-aligned
  // so the units stack in a column.
  function countdownLines(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const parts = [[Math.floor(s / 86400), 'd'], [Math.floor((s % 86400) / 3600), 'h'], [Math.floor((s % 3600) / 60), 'm'], [s % 60, 's']];
    const first = parts.findIndex(([n]) => n > 0);
    return parts.slice(first < 0 ? 3 : first).map(([n, unit], i) => `${i === 0 ? n : String(n).padStart(2, '0')}${unit}`);
  }
  // FLIP: siblings glide to their new slots instead of jumping.
  function flip(container, mutate) {
    const items = [...container.children];
    const before = new Map(items.map((item) => [item, item.getBoundingClientRect().top]));
    mutate();
    for (const item of items) {
      const dy = before.get(item) - item.getBoundingClientRect().top;
      if (dy) item.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    }
  }

  // Queue manager
  const queueModal = createModal('queueModal', 'Scheduled Prompts');
  const queueBtn = document.getElementById('queueBtn');
  const queueBadge = document.getElementById('queueBadge');
  let schedulerTasks = [];
  const activeTasks = () => schedulerTasks.filter((task) => task.status === 'pending' || task.status === 'dispatched');
  const queueCountdown = document.getElementById('queueCountdown');
  const queueTip = queueBtn.querySelector('.round-btn-tip');
  let queueTick = null;
  let pulseOnShow = false;
  let queuePinned = false; // opened from the launcher's clock: it stays open (empty) when the queue drains
  // P17-X: a live 1s countdown to whichever task (any agent) fires first.
  function tickQueueCountdown() {
    const times = activeTasks().filter((task) => task.status === 'pending').map(fireTimeOf).filter(Boolean);
    const next = times.length ? Math.min(...times) : null;
    const lines = next ? countdownLines(next - Date.now()) : [];
    const key = lines.length;
    // one element per line; only the text changes each second
    if (queueCountdown.childElementCount !== key) queueCountdown.replaceChildren(...lines.map(() => document.createElement('span')));
    lines.forEach((text, i) => { const el = queueCountdown.children[i]; if (el.textContent !== text) el.textContent = text; });
    queueCountdown.title = next ? formatCountdown(next - Date.now()) : '';
    document.querySelectorAll('.turn-queue-item.is-scheduled').forEach((row) => { // the strip's own countdowns
      const task = schedulerTasks.find((item) => item.id === row.dataset.taskId); const at = task && fireTimeOf(task);
      if (at && task.dispatchTrigger === 'quota-reset') row.querySelector('.turn-queue-when').textContent = `at reset · ${formatCountdown(at - Date.now())}`;
    });
    queueBtn.classList.toggle('is-pill', Boolean(next));
  }
  function renderQueueButton() {
    const count = activeTasks().length;
    queueBtn.hidden = count === 0;
    queueBadge.textContent = String(count);
    queueBadge.dataset.count = String(count);
    queueBtn.title = `${count} scheduled prompt${count === 1 ? '' : 's'}`;
    tickQueueCountdown();
    if (count && !queueTick) queueTick = setInterval(tickQueueCountdown, 1000);
    if (!count && queueTick) { clearInterval(queueTick); queueTick = null; }
    if (!count && !queuePinned) closeModal(queueModal.el);
    if (count && pulseOnShow) { pulseOnShow = false; pulseQueueSaved(); }
  }
  // Persistence guarantee: pull the eye from the composer to the pill, confirm the disk write.
  function pulseQueueSaved() {
    if (queueBtn.hidden) { pulseOnShow = true; return; } // the queue broadcast lands right after taskScheduled
    queueBtn.classList.remove('is-saved');
    void queueBtn.offsetWidth; // restart the animation
    queueBtn.classList.add('is-saved');
    clearTimeout(pulseQueueSaved.timer);
    pulseQueueSaved.timer = setTimeout(() => queueBtn.classList.remove('is-saved'), 1000);
  }
  function beginEdit(card, task) {
    const promptEl = card.querySelector('.queue-prompt');
    if (!promptEl || card.querySelector('textarea')) return;
    const area = document.createElement('textarea');
    area.className = 'queue-edit';
    area.value = task.prompt;
    const grow = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const next = area.value.trim();
      if (save && next && next !== task.prompt) { task.prompt = next; vscode.postMessage({ type: 'editScheduledTask', taskId: task.id, prompt: next }); }
      promptEl.textContent = task.prompt;
      area.replaceWith(promptEl);
    };
    area.addEventListener('input', grow);
    area.addEventListener('blur', () => finish(true));
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(true); }
    });
    promptEl.replaceWith(area);
    grow();
    area.focus();
  }
  function renderQueue() {
    const tasks = activeTasks();
    queueModal.count.textContent = String(tasks.length);
    queueModal.body.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'fs-modal-empty';
      empty.textContent = 'No scheduled prompts.';
      queueModal.body.append(empty);
      return;
    }
    // P17-X: one bundle per agent (logo, next reset, its own numbering and reorder lane).
    for (const agent of AGENT_IDS) {
      const items = tasks.filter((task) => task.model === agent);
      if (!items.length) continue;
      const group = document.createElement('section');
      group.className = 'queue-group';
      const groupHead = document.createElement('header');
      groupHead.className = 'queue-group-head';
      groupHead.innerHTML = AGENT_ICONS[agent] || '';
      const name = document.createElement('span');
      name.className = 'queue-group-name';
      name.textContent = AGENT_NAMES[agent] || agent;
      const resetsAt = lastQuotas[agent]?.resetsAt;
      const reset = document.createElement('span');
      reset.className = 'queue-group-reset';
      reset.textContent = typeof resetsAt === 'number' ? `Quota resets ${formatWhen(resetsAt * 1000)}` : '';
      groupHead.append(name, reset);
      const list = document.createElement('div');
      list.className = 'queue-list';
      items.forEach((task, index) => list.append(queueCard(task, index)));
      bindQueueReorder(list, agent);
      group.append(groupHead, list);
      queueModal.body.append(group);
    }
  }
  function queueCard(task, index) {
    const pending = task.status === 'pending';
    const card = document.createElement('article');
    card.className = `queue-card${pending ? '' : ' is-dispatched'}`;
    card.dataset.id = task.id;
    const head = document.createElement('div');
    head.className = 'queue-card-head';
    if (pending) {
      const handle = document.createElement('button');
      handle.type = 'button'; handle.className = 'queue-handle'; handle.title = 'Drag to reorder'; handle.innerHTML = HANDLE_SVG;
      handle.addEventListener('pointerdown', () => { card.draggable = true; });
      head.append(handle);
    }
    const position = document.createElement('span');
    position.className = 'queue-index';
    position.textContent = `#${index + 1}`;
    const when = document.createElement('time');
    when.className = 'queue-time';
    when.dateTime = task.createdAt || '';
    when.textContent = pending ? formatWhen(task.createdAt) : 'Dispatching\u2026';
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'queue-delete'; remove.innerHTML = `${TRASH_SVG}<span>Delete</span>`;
    remove.addEventListener('click', () => {
      card.classList.add('is-leaving');
      vscode.postMessage({ type: 'cancelScheduledTask', taskId: task.id });
    });
    // P17-Z: escape hatches for a long wait: send through Auto now, or take it back into the composer.
    const take = (icon, label, title, type) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'queue-delete queue-take'; btn.title = title; btn.innerHTML = `${icon}<span>${label}</span>`;
      btn.addEventListener('click', () => { card.classList.add('is-leaving'); vscode.postMessage({ type, taskId: task.id }); closeModal(queueModal.el); });
      return btn;
    };
    head.append(position, modelPill(task.model, task.modelId), when);
    if (pending) { // a dispatched task is already running
      head.append(
        take(QUEUE_ICONS.steer, 'Send Now', 'Unschedule and send now via Auto (routes to a model with quota left)', 'dispatchNowWithAutoRoute'),
        take(QUEUE_ICONS.unschedule, 'Unschedule', 'Move back into the composer as an editable draft', 'unscheduleToComposer'),
        remove);
    }
    const promptEl = document.createElement('div');
    promptEl.className = 'queue-prompt';
    promptEl.textContent = task.prompt;
    if (pending) {
      promptEl.tabIndex = 0;
      promptEl.title = 'Click to edit';
      promptEl.addEventListener('click', () => beginEdit(card, task));
      promptEl.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); beginEdit(card, task); } });
    }
    card.append(head, promptEl);
    return card;
  }
  // Drag-to-reorder within one agent's bundle; the store swaps only these tasks among their own slots.
  function bindQueueReorder(list, agent) {
    let dragging = null;
    list.addEventListener('dragstart', (event) => {
      dragging = event.target.closest('.queue-card');
      if (!dragging) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragging.dataset.id);
      requestAnimationFrame(() => dragging && dragging.classList.add('is-dragging'));
    });
    list.addEventListener('dragover', (event) => {
      if (!dragging) return;
      event.preventDefault();
      const siblings = [...list.querySelectorAll('.queue-card:not(.is-dispatched)')].filter((card) => card !== dragging);
      const after = siblings.find((card) => { const r = card.getBoundingClientRect(); return event.clientY < r.top + r.height / 2; });
      if ((after || null) === dragging.nextElementSibling || (!after && list.lastElementChild === dragging)) return;
      flip(list, () => list.insertBefore(dragging, after || null));
    });
    list.addEventListener('dragend', () => {
      if (!dragging) return;
      dragging.classList.remove('is-dragging');
      dragging.draggable = false;
      dragging = null;
      const ids = [...list.querySelectorAll('.queue-card:not(.is-dispatched)')].map((card) => card.dataset.id);
      list.querySelectorAll('.queue-index').forEach((el, i) => { el.textContent = `#${i + 1}`; });
      const before = activeTasks().filter((task) => task.status === 'pending' && task.model === agent).map((task) => task.id);
      if (ids.join() !== before.join()) vscode.postMessage({ type: 'reorderScheduledTasks', ids });
    });
  }

  // Manage Chats: chats with an agent running (or run in the last five minutes) on top, history below.
  const historyModal = createModal('historyModal', 'Manage Chats');
  // Chat Settings: a popup like Manage Chats, opened from the launcher's gear. Its page is settings.js.
  const settingsModal = createModal('settingsModal', 'Chat Settings');
  const chatSettings = window.initChatSettings({ vscode, body: settingsModal.body });
  const cliSetupModal = createModal('cliSetupModal', 'Welcome to Clanker');
  const cliSetup = window.initCliSetup({ vscode, body: cliSetupModal.body, onClose: () => closeModal(cliSetupModal.el) });
  let cliSetupSeen = false;
  let currentChatId = null;

  // ---------- Auto-Verify ----------
  // A standing switch, not a one-shot, and it lives in the model menu (renderModelMenu): while on, every turn of every
  // model also tells the agent to run the project's checks (the aiChatPanel.verifyCommand setting, or its own test
  // script) after it changes files, and fix what fails. The agent's own shell tool does the running; this only asks.
  let autoVerify = Boolean(vscode.getState()?.autoVerify);
  let modelPromptIds = new Set(); // models that carry a prompt of the user's own (Settings > Models); the menu marks them
  let verifyCommand = ''; // the pinned check (aiChatPanel.verifyCommand), told by the host; empty: the agent finds the project's own
  // The switch in the menu says what will run (the host knows the setting); /verify <command> sets it without opening Settings.
  function setAutoVerify(on) {
    autoVerify = on;
    try { vscode.setState({ ...(vscode.getState() || {}), autoVerify }); } catch {}
    renderVerify();
    if (on) vscode.postMessage({ type: 'verifyInfo' });
  }
  if (autoVerify) vscode.postMessage({ type: 'verifyInfo' });

  // ---------- P16-J: inline schedule toggle ----------
  // One input, not two: the composer's clock button arms "schedule instead
  // of send" for the next submit (Enter or the send arrow), queued for the
  // active model's next quota reset.
  const scheduleBtn = document.createElement('button');
  scheduleBtn.type = 'button'; scheduleBtn.id = 'scheduleBtn'; scheduleBtn.className = 'composer-icon-btn schedule-toggle';
  scheduleBtn.setAttribute('aria-pressed', 'false');
  // The clock wears the icon of its mode (schedule-timer.css picks one by data-mode): off, usage reset (a usage ring
  // turning back to the start, as in the sidebar), timer, calendar.
  const scheduleIcon = (name, paths) => `<svg class="sc-ico sc-ico-${name}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  scheduleBtn.innerHTML = scheduleIcon('off', '<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.2"/>')
    + scheduleIcon('reset', '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.75v2.5h-2.5"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/>')
    + scheduleIcon('timer', '<circle cx="8" cy="9" r="5"/><path d="M8 6.5V9l1.6 1M6.5 2h3"/>')
    + scheduleIcon('calendar', '<rect x="2.5" y="3.5" width="11" height="10" rx="2.5"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>');
  scheduleBtn.dataset.mode = 'off';
  document.querySelector('.composer-actions').insertBefore(scheduleBtn, sendBtn);
  // Hovering the clock opens the timer pill (schedule-timer.js); picking a time arms scheduling for it.
  const scheduleTime = document.createElement('span');
  scheduleTime.className = 'schedule-time';
  scheduleBtn.append(scheduleTime);
  const scheduleTimer = window.initScheduleTimer({
    button: scheduleBtn,
    composer: document.querySelector('.composer'),
    preferred: window.SCHEDULE_MODE, // the mode the last scheduled prompt used (saved by the host)
    // The chosen model's two limits, for the usage-reset mode: what it waits for and when that comes.
    usage: () => {
      const quota = lastQuotas[scheduleModel()];
      return { windows: [
        { key: '5h', name: '5h', remaining: quota?.remaining ?? null, resetsAt: quota?.resetsAt ?? null },
        { key: '7d', name: '7d', remaining: quota?.secondary?.remaining ?? null, resetsAt: quota?.secondary?.resetsAt ?? null },
      ] };
    },
    onChange: () => { scheduleChoice = true; refreshScheduleDefault(); },
  });
  const countdownClock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  };
  // Beside its icon the clock shows what the mode holds: the countdown to the reset it waits for, the delay, the day
  // and time. Off, it shows the countdown to the next of this chat's already sent scheduled prompts, if any.
  function renderScheduleTime() {
    let text = '';
    if (scheduleTimer.mode) text = scheduleTimer.short();
    else {
      const sent = activeTasks().filter((task) => task.status === 'pending' && task.chatId === currentChatId).map(fireTimeOf).filter(Boolean);
      if (sent.length) text = countdownClock(Math.min(...sent) - Date.now());
    }
    if (scheduleTime.textContent !== text) scheduleTime.textContent = text;
    scheduleBtn.classList.toggle('has-time', Boolean(text));
  }
  setInterval(renderScheduleTime, 1000);

  const AGENT_LABELS = AGENT_NAMES;
  const DEFAULT_PLACEHOLDER = promptInput.placeholder;
  let scheduleArmed = false;
  let pendingScheduleLabel = null;
  let pendingScheduleWhen = '';
  // Declared before selectModel() first runs at startup: lastReplyAgent() reads it.
  let turnRoutedAgent = null; // who ran the current turn (set by 'routing')
  // 'auto' has no quota of its own to wait for; scheduling needs a real model.
  // The picked provider; on Auto, whoever answered last in this chat (a "continue" must reach the same agent).
  function lastReplyAgent() {
    const agent = turnRoutedAgent || [...transcriptEl.querySelectorAll('.msg-assistant[data-agent], [data-agent]')].pop()?.dataset.agent;
    return AGENT_IDS.includes(agent) ? agent : null;
  }
  function scheduleModel() { return activeAgent === 'auto' ? lastReplyAgent() || 'claude' : activeAgent; }
  function setScheduleArmed(armed, { outOfUsage = false } = {}) {
    scheduleArmed = armed;
    // Armed with no mode yet (turned on by the model being out of usage): the usage reset is what that means.
    if (armed && !scheduleTimer.mode) scheduleTimer.select('reset');
    else if (!armed && scheduleTimer.mode) scheduleTimer.clear();
    scheduleBtn.classList.toggle('is-scheduled', armed);
    scheduleBtn.setAttribute('aria-pressed', String(armed));
    const modeName = { reset: 'when the usage resets', timer: 'after a delay', calendar: 'at a chosen day and time' }[scheduleTimer.mode];
    scheduleBtn.title = armed && outOfUsage
      ? `${AGENT_LABELS[scheduleModel()]} is out of usage, so messages are scheduled for its reset. Click to change how, or to send now.`
      : armed ? `The next message is scheduled ${modeName}. Click for the next mode: usage reset, timer, calendar, off.` : 'Schedule the next message: click to choose when (usage reset, timer or calendar)';
    document.querySelector('.composer').classList.toggle('is-scheduled', armed);
    promptInput.placeholder = armed
      ? `Schedule prompt for ${AGENT_LABELS[scheduleModel()]} (will auto-dispatch ${scheduleTimer.describe() || 'when quota resets'})\u2026` // the clock is drawn by CSS (.composer.is-scheduled)
      : DEFAULT_PLACEHOLDER;
    renderScheduleTime();
  }

  // With the chat's model out of usage, scheduling is on by default, so a run of prompts can be queued
  // without pressing the clock each time. Out of usage: the quota feed shows nothing left, or the
  // model just answered with a usage-limit message; a normal reply from it clears that again.
  // The clock still overrides (send anyway, or schedule while usage is left) until the model or chat changes.
  const limitHitAgents = new Set();
  let scheduleChoice = null; // the clock's own pick; null follows the model's usage
  function isOutOfUsage(agent) {
    const remaining = lastQuotas[agent]?.remaining;
    return limitHitAgents.has(agent) || (typeof remaining === 'number' && remaining < 1);
  }
  /** The usage display shows real room left for this provider (a few percent, not a rounding leftover). */
  function hasHeadroom(agent) {
    const remaining = lastQuotas[agent]?.remaining;
    return typeof remaining === 'number' && remaining >= 5;
  }
  // A reply that *is* the CLI's limit notice (one or two short lines), not an answer that happens to
  // talk about limits: those used to match too, and put "Continue when … resets" under normal replies.
  const { isLimitNotice, LIMIT_RE } = window.limitNotice; // limit-notice.js, shared with the extension
  function refreshScheduleDefault() {
    const outOfUsage = isOutOfUsage(scheduleModel());
    setScheduleArmed(scheduleChoice ?? outOfUsage, { outOfUsage: scheduleChoice === null && outOfUsage });
  }
  // Each click is the next mode: the one last used, the other two in turn, then off (send as usual).
  scheduleBtn.addEventListener('click', () => { scheduleChoice = scheduleTimer.advance() !== null; refreshScheduleDefault(); promptInput.focus(); });
  setScheduleArmed(false);

  function schedulePrompt(text) {
    const model = scheduleModel();
    pendingScheduleLabel = AGENT_LABELS[model];
    pendingScheduleWhen = scheduleTimer.describe();
    const modelId = activeAgent === model ? activeModelId : undefined;
    // Timer and calendar make a fixed-time task (a delay counts from this send); the usage reset waits for the limit chosen.
    const at = scheduleTimer.resolve();
    const trigger = at ? { dispatchTrigger: 'fixed-time', dispatchTime: new Date(at).toISOString() } : { dispatchTrigger: 'quota-reset', resetWindow: scheduleTimer.resetWindow };
    // The mode this used is what the next click from "off" starts with, here and after a restart.
    scheduleTimer.setPreferred(scheduleTimer.mode);
    vscode.postMessage({ type: 'scheduleMode', mode: scheduleTimer.mode });
    // resumeHere: it fires into this chat, with its context, not a fresh headless one.
    vscode.postMessage({ type: 'scheduleTask', task: { model, modelId, prompt: text, ...trigger, resumeHere: true }, attachments: attachments.map((attachment) => attachment.path) });
  }

  // "Scheduled" confirmation: a bud of the composer pill (Dynamic Island), readable for a while,
  // held while hovered, then it sinks back into the pill.
  const CLOCK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8.5" r="5.75"/><path d="M8 5.5v3.2l2.1 1.3"/></svg>';
  const scheduleBud = document.createElement('div');
  scheduleBud.className = 'schedule-bud island-bud';
  scheduleBud.setAttribute('role', 'status');
  scheduleBud.hidden = true;
  document.querySelector('.compose-row').insertBefore(scheduleBud, document.querySelector('.compose-row > .composer'));
  let scheduleBudTimer = null;
  function hideScheduleBud() {
    clearTimeout(scheduleBudTimer);
    scheduleBud.classList.add('is-leaving');
    scheduleBudTimer = setTimeout(() => { scheduleBud.hidden = true; scheduleBud.classList.remove('is-leaving'); }, 280);
  }
  function showScheduleBud(text) {
    clearTimeout(scheduleBudTimer);
    scheduleBud.innerHTML = `${CLOCK_SVG}<span></span>`;
    scheduleBud.querySelector('span').textContent = text;
    scheduleBud.classList.remove('is-leaving');
    scheduleBud.hidden = true;
    void scheduleBud.offsetWidth; // replay the bud's grow-out animation
    scheduleBud.hidden = false;
    // Long enough to read at a glance after looking back up from the composer: 9s, or more for longer text.
    scheduleBudTimer = setTimeout(hideScheduleBud, Math.max(9000, text.split(/\s+/).length * 600));
  }
  scheduleBud.addEventListener('mouseenter', () => clearTimeout(scheduleBudTimer));
  scheduleBud.addEventListener('mouseleave', () => { scheduleBudTimer = setTimeout(hideScheduleBud, 3500); });
  scheduleBud.addEventListener('click', hideScheduleBud);

  function showToast(text, { error } = {}) {
    const toast = document.createElement('div');
    toast.className = `toast glass${error ? ' toast-error' : ''}`;
    toast.textContent = text;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    setTimeout(() => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 250);
    }, Math.max(3500, text.split(/\s+/).length * 400));
  }

  function formatSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
  // P17-J/K: one shared lightbox for composer chips and transcript images. The X, a click outside the image, or Esc closes it.
  function openLightbox(src, caption = '') {
    const box = document.createElement('div');
    box.className = 'image-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const frame = document.createElement('div');
    frame.className = 'image-lightbox-frame';
    const image = document.createElement('img');
    image.src = src; image.alt = caption;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'image-lightbox-close';
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    frame.append(image, closeBtn);
    const label = document.createElement('div');
    label.className = 'image-lightbox-caption'; label.textContent = caption;
    box.append(frame, label);
    const close = () => { box.classList.remove('is-open'); document.removeEventListener('keydown', onKey, true); setTimeout(() => box.remove(), 220); };
    // Capture phase: Esc closes the preview before anything else sees it.
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    box.addEventListener('click', (event) => { if (event.target !== image) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(box);
    requestAnimationFrame(() => { box.classList.add('is-open'); closeBtn.focus({ preventScroll: true }); });
  }
  function renderAttachments() {
    attachmentStrip.replaceChildren(...attachments.map((attachment) => attachmentChip(attachment, () => {
      vscode.postMessage({ type: 'removeAttachment', path: attachment.path }); attachments = attachments.filter((item) => item.path !== attachment.path); renderAttachments();
    })));
    saveQueueEdit();
  }
  // Files are stored as "<timestamp>_<name>"; people read the name.
  const shownName = (name) => String(name || '').replace(/^\d{10,}_/, '');
  // Click the name on a composer chip to rename the file: a plain field, no model. Enter or clicking away saves, Esc cancels.
  function renameAttachmentInline(nameEl, attachment) {
    const input = document.createElement('input');
    input.className = 'attachment-rename';
    const ext = attachment.name.includes('.') ? attachment.name.slice(attachment.name.lastIndexOf('.')) : '';
    input.value = shownName(attachment.name).slice(0, shownName(attachment.name).length - ext.length);
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Image name');
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const next = input.value.trim();
      if (save && next && next !== input.defaultValue) vscode.postMessage({ type: 'renameAttachment', path: attachment.path, name: next });
      input.replaceWith(nameEl);
    };
    input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finish(true); } if (event.key === 'Escape') { event.preventDefault(); finish(false); } });
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('blur', () => finish(true));
  }
  // A composer chip (with remove) or, without onRemove, a sent bubble's read-only pill.
  function attachmentChip(attachment, onRemove) {
    const chip = document.createElement('div'); chip.className = 'attachment-chip';
    const isImage = attachment.mime?.startsWith('image/') && attachment.uri;
    const label = document.createElement('span');
    const name = document.createElement('span'); name.className = 'attachment-name'; name.textContent = shownName(attachment.name);
    const meta = document.createElement('span'); meta.className = 'attachment-meta';
    const withPx = (dims) => (dims ? `${dims} px` : '');
    meta.textContent = isImage ? withPx(attachment.dims) : formatSize(attachment.size);
    label.append(name, meta);
    if (isImage) {
      const image = document.createElement('img'); image.src = attachment.uri; image.alt = '';
      if (!attachment.dims) image.addEventListener('load', () => { attachment.dims = `${image.naturalWidth}×${image.naturalHeight}`; meta.textContent = withPx(attachment.dims); }, { once: true });
      chip.appendChild(image);
      chip.classList.add('is-previewable');
      chip.title = `Preview ${shownName(attachment.name)}`;
      chip.addEventListener('click', () => openLightbox(attachment.uri, `${shownName(attachment.name)}  ${withPx(attachment.dims)}`.trim()));
    }
    chip.append(label);
    if (onRemove) {
      name.title = 'Click to rename';
      name.classList.add('is-renamable');
      name.addEventListener('click', (event) => { event.stopPropagation(); renameAttachmentInline(name, attachment); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = `Remove ${attachment.name}`;
      remove.addEventListener('click', (event) => { event.stopPropagation(); onRemove(); });
      chip.append(remove);
    }
    return chip;
  }
  // A pasted or dropped image is kept at 2000px on its long edge at most. The models shrink anything larger themselves
  // (Claude to 1568 or 2576px, GPT to 2048px), so the extra pixels only cost upload time and disk, and a request holding
  // more than 20 images is rejected by the Claude API if any of them is over 2000px. Smaller images are stored untouched.
  const MAX_IMAGE_EDGE = 2000;
  async function capImage(file) {
    if (!/^image\/(png|jpeg)$/.test(file.type)) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height);
      if (scale >= 1) { bitmap.close(); return file; }
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return await canvas.convertToBlob({ type: file.type, quality: 0.92 }); // PNG stays lossless; a JPEG is re-encoded once
    } catch { return file; }
  }
  function readAttachment(file) {
    const chatId = currentChatId;
    void capImage(file).then((image) => {
      const reader = new FileReader();
      reader.onload = () => vscode.postMessage({ type: 'attachmentData', chatId, name: file.name || `paste-${Date.now()}.png`, mime: file.type || 'application/octet-stream', data: reader.result });
      reader.readAsDataURL(image);
    });
  }
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachments', chatId: currentChatId }));
  promptInput.addEventListener('paste', (event) => { for (const item of event.clipboardData?.items || []) { if (item.type.startsWith('image/')) { event.preventDefault(); readAttachment(item.getAsFile()); } } });
  // The whole window is one drop zone. The IDE only hands a drag to a webview while
  // Shift is held (otherwise its own "Upload to Agent" overlay takes it), so the
  // overlay says what happens on release and the attach tooltip teaches the Shift.
  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'drop-overlay';
  dropOverlay.setAttribute('aria-hidden', 'true');
  dropOverlay.innerHTML = '<div class="drop-overlay-card"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25M3 13.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Drop to reference in this chat</span></div>';
  document.body.appendChild(dropOverlay);
  let dragDepth = 0;
  const endDrag = () => { dragDepth = 0; document.body.classList.remove('attachment-dragging'); };
  document.addEventListener('dragenter', (event) => { if (!event.dataTransfer?.types.includes('Files') && !event.dataTransfer?.types.some((type) => /uri-list/.test(type))) return; dragDepth++; document.body.classList.add('attachment-dragging'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) endDrag(); });
  document.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', (event) => {
    event.preventDefault(); endDrag();
    // P17-Q: Explorer drags carry URIs, not file blobs; the host turns them into workspace-relative @-mentions.
    const uris = (event.dataTransfer?.getData('application/vnd.code.uri-list') || event.dataTransfer?.getData('text/uri-list') || '')
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => /^file:/i.test(line));
    if (uris.length) { vscode.postMessage({ type: 'mentionUris', uris }); return; }
    for (const file of event.dataTransfer?.files || []) readAttachment(file);
  });
  attachBtn.title = 'Attach files (or hold Shift while dragging files in)';

  // ---------- P17-Q: @-mentions ----------
  // The textarea keeps plain `@relative/path` tokens (what the CLI receives);
  // each one also shows as a badge chip above the composer, and Backspace
  // right behind a token removes it whole.
  let workspaceFiles = null; // null: not asked yet; []: asked, pending
  let workspaceRoot = '';
  const mentioned = new Set();
  const mentionStrip = document.createElement('div');
  mentionStrip.className = 'attachment-strip mention-strip island-bud';
  document.querySelector('.compose-row').insertBefore(mentionStrip, document.querySelector('.composer'));
  const mentionMenu = document.createElement('div');
  mentionMenu.className = 'mention-menu glass';
  mentionMenu.setAttribute('role', 'listbox');
  mentionMenu.hidden = true;
  // Outside the composer: the dock's goo filter (.compose-row) would clip a 260px menu.
  document.body.appendChild(mentionMenu);
  let mentionHits = [];
  let mentionIndex = 0;

  // Codex actions come from the installed CLI, not a renderer-maintained list.
  // Reuse the existing autocomplete surface so slash preview inherits its
  // keyboard behavior, accessibility, and visual language without new chrome.
  let slashCommands = null;
  let slashHits = [];
  let slashIndex = 0;
  // A bud of the dock (like queued turns and attachments): right above the pill, fused by the goo.
  const slashMenu = document.createElement('div');
  slashMenu.className = 'mention-menu slash-bud island-bud';
  slashMenu.setAttribute('role', 'listbox');
  slashMenu.setAttribute('aria-label', 'Commands');
  slashMenu.hidden = true;
  document.querySelector('.compose-row').insertBefore(slashMenu, document.querySelector('.compose-row > .composer'));

  function slashAtCaret() {
    if (promptInput.selectionStart !== promptInput.value.length || promptInput.selectionEnd !== promptInput.value.length) return null;
    return /^\/([^\s]*)$/.exec(promptInput.value);
  }
  function closeSlashMenu() { slashMenu.hidden = true; slashHits = []; }
  function slashScore(command, query) {
    const q = query.toLowerCase();
    const name = command.name.toLowerCase();
    if (!q) return 1;
    if (name.startsWith(q)) return 100;
    if (name.includes(q)) return 80;
    const flat = `${name} ${command.description || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const needle = q.replace(/[^a-z0-9]+/g, '');
    if (flat.includes(needle)) return 60;
    let i = 0;
    for (const ch of flat) if (ch === needle[i]) i++;
    return i === needle.length ? 10 : 0;
  }
  function updateSlashMenu() {
    const match = slashAtCaret();
    if (!match) return closeSlashMenu();
    closeMentionMenu();
    // Asked fresh each time the menu opens: the CLIs gain commands (skills, plugins) without this panel reloading.
    if (slashCommands === null) slashCommands = [];
    if (!match[1] && slashMenu.hidden) vscode.postMessage({ type: 'querySlashCommands' });
    // The picked provider's CLI only; Auto shows every CLI's commands.
    const pool = activeAgent === 'auto' ? slashCommands : slashCommands.filter((command) => command.panel || (command.agent || 'codex') === activeAgent);
    slashHits = pool.map((command) => [command, slashScore(command, match[1])]).filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 50).map(([command]) => command);
    slashIndex = Math.min(slashIndex, Math.max(0, slashHits.length - 1));
    slashMenu.replaceChildren(...slashHits.map((command, i) => {
      const item = document.createElement('div');
      item.className = 'mention-item' + (i === slashIndex ? ' is-active' : '');
      item.setAttribute('role', 'option');
      const name = document.createElement('span'); name.className = 'mention-name'; name.textContent = `/${command.name}`;
      const description = document.createElement('span'); description.className = 'model-option-hint'; description.textContent = `${command.panel ? 'Clanker' : AGENT_LABELS[command.agent] || 'Codex'}${command.description ? ` · ${command.description}` : ''}`;
      if (command.description) item.title = command.description; // the hint shows two lines; the rest on hover
      const copy = document.createElement('span'); copy.className = 'model-option-text'; copy.append(name, description);
      item.append(copy);
      item.addEventListener('mousedown', (event) => { event.preventDefault(); insertSlashCommand(command); });
      return item;
    }));
    slashMenu.hidden = !slashHits.length;
    if (slashMenu.hidden) return;
    slashMenu.children[slashIndex]?.scrollIntoView({ block: 'nearest' }); // arrowing through a long list
  }
  function insertSlashCommand(command) {
    promptInput.value = `/${command.name} `;
    promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
    closeSlashMenu();
    promptInput.dispatchEvent(new Event('input'));
    promptInput.focus();
  }

  function requestWorkspaceFiles() { if (workspaceFiles === null) { workspaceFiles = []; vscode.postMessage({ type: 'queryFiles' }); } }
  promptInput.addEventListener('focus', requestWorkspaceFiles, { once: true });
  function mentionAtCaret() { return /(^|\s)@([^\s@]*)$/.exec(promptInput.value.slice(0, promptInput.selectionStart)); }
  function fuzzyScore(file, query) {
    if (!query) return 1;
    const f = file.toLowerCase();
    const q = query.toLowerCase();
    const base = f.slice(f.lastIndexOf('/') + 1);
    if (base.startsWith(q)) return 100 - base.length / 100;
    if (base.includes(q)) return 60;
    if (f.includes(q)) return 30;
    let i = 0;
    for (const ch of f) if (ch === q[i]) i++;
    return i === q.length ? 10 - f.length / 1000 : 0;
  }
  function closeMentionMenu() { mentionMenu.hidden = true; mentionHits = []; }
  function updateMentionMenu() {
    const match = mentionAtCaret();
    if (!match) return closeMentionMenu();
    requestWorkspaceFiles();
    mentionHits = workspaceFiles.map((file) => [file, fuzzyScore(file, match[2])]).filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([file]) => file);
    mentionIndex = Math.min(mentionIndex, Math.max(0, mentionHits.length - 1));
    mentionMenu.replaceChildren(...mentionHits.map((file, i) => {
      const item = document.createElement('div');
      item.className = 'mention-item' + (i === mentionIndex ? ' is-active' : '');
      item.setAttribute('role', 'option');
      const slash = file.lastIndexOf('/');
      const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
      item.dataset.ext = ext;
      item.innerHTML = FILE_ICONS[FILE_KIND[ext] || 'doc'];
      const name = document.createElement('span'); name.className = 'mention-name'; name.textContent = file.slice(slash + 1);
      const dir = document.createElement('span'); dir.className = 'mention-dir'; dir.textContent = slash > 0 ? file.slice(0, slash) : '';
      item.append(name, dir);
      item.addEventListener('mousedown', (event) => { event.preventDefault(); insertMention(file, true); });
      return item;
    }));
    mentionMenu.hidden = !mentionHits.length;
    if (mentionMenu.hidden) return;
    const dock = document.querySelector('.compose-row').getBoundingClientRect();
    Object.assign(mentionMenu.style, { left: `${dock.left + 8}px`, width: `${dock.width - 16}px`, bottom: `${innerHeight - dock.top + 6}px` });
  }
  function insertMention(file, replaceQuery) {
    if (!file) return;
    const caret = promptInput.selectionStart;
    const match = replaceQuery ? mentionAtCaret() : null;
    const start = match ? caret - match[2].length - 1 : caret;
    const before = promptInput.value.slice(0, start);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const token = `${lead}@${file} `;
    promptInput.value = before + token + promptInput.value.slice(caret);
    promptInput.selectionStart = promptInput.selectionEnd = start + token.length;
    mentioned.add(file);
    closeMentionMenu();
    promptInput.dispatchEvent(new Event('input'));
    promptInput.focus();
  }
  function renderMentions() {
    for (const file of mentioned) if (!promptInput.value.includes(`@${file}`)) mentioned.delete(file);
    mentionStrip.replaceChildren(...[...mentioned].map((file) => {
      const chip = document.createElement('span');
      chip.className = 'mention-chip';
      chip.innerHTML = fileBadge(file) || '';
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.title = `Remove @${file}`;
      remove.addEventListener('click', () => {
        promptInput.value = promptInput.value.split(`@${file} `).join('').split(`@${file}`).join('');
        promptInput.dispatchEvent(new Event('input'));
      });
      chip.append(remove);
      chip.querySelector('.file-badge')?.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: file }));
      return chip;
    }));
  }
  promptInput.addEventListener('input', () => { mentionIndex = 0; slashIndex = 0; renderMentions(); updateMentionMenu(); updateSlashMenu(); });
  promptInput.addEventListener('keyup', (event) => { if (event.key !== 'Escape') updateSlashMenu(); });
  promptInput.addEventListener('mouseup', updateSlashMenu);
  promptInput.addEventListener('blur', () => setTimeout(() => { closeMentionMenu(); closeSlashMenu(); }, 120));
  promptInput.addEventListener('keydown', (event) => {
    if (!mentionMenu.hidden && mentionHits.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionHits.length) % mentionHits.length;
        updateMentionMenu();
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault(); event.stopImmediatePropagation();
        insertMention(mentionHits[mentionIndex], true);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); closeMentionMenu(); return; }
    }
    if (event.key === 'Backspace' && promptInput.selectionStart === promptInput.selectionEnd) {
      const before = promptInput.value.slice(0, promptInput.selectionStart);
      const token = /(?:^|\s)(@([^\s@]+) ?)$/.exec(before);
      if (token && mentioned.has(token[2])) {
        event.preventDefault();
        const start = before.length - token[1].length;
        promptInput.value = before.slice(0, start) + promptInput.value.slice(before.length);
        promptInput.selectionStart = promptInput.selectionEnd = start;
        promptInput.dispatchEvent(new Event('input'));
      }
    }
  });
  promptInput.addEventListener('keydown', (event) => {
    if (slashMenu.hidden || !slashHits.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation();
      slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + slashHits.length) % slashHits.length;
      updateSlashMenu();
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeSlashMenu(); return; }
    if (event.key === 'Tab') {
      event.preventDefault(); event.stopImmediatePropagation(); insertSlashCommand(slashHits[slashIndex]);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation();
      promptInput.value = `/${slashHits[slashIndex].name}`;
      closeSlashMenu();
      sendPrompt({ steer: event.ctrlKey || event.metaKey });
    }
  });
  // ---------- Model picker: a pill in the composer, menu opens above it ----------
  const modelMenu = document.createElement('div');
  modelMenu.id = 'modelMenu';
  modelMenu.className = 'model-menu glass';
  modelMenu.setAttribute('role', 'listbox');
  modelMenu.setAttribute('aria-label', 'Model');
  // The menu and its two fillets share one goo-filtered stage (#msg-goo, as the bubble
  // dock), so the menu grows out of the composer's top edge and rests fused to it.
  const modelMenuStage = document.createElement('div');
  modelMenuStage.className = 'model-menu-stage';
  const modelMenuFillets = document.createElement('div');
  modelMenuFillets.className = 'model-menu-fillets';
  modelMenuStage.append(modelMenu, modelMenuFillets);
  document.body.appendChild(modelMenuStage); // outside the composer, above the transcript

  // A small shield after the model's name while Auto-Verify is on, so it is never on without you seeing it.
  const verifyMark = document.createElement('span');
  verifyMark.className = 'model-picker-verify';
  verifyMark.title = 'Auto-Verify is on';
  verifyMark.innerHTML = VERIFY_SVG;
  modelPickerBtn.querySelector('.model-picker-chevron').before(verifyMark);
  function renderVerify() {
    modelPickerBtn.classList.toggle('has-verify', autoVerify);
    for (const row of modelMenu.querySelectorAll('.model-verify')) {
      row.setAttribute('aria-checked', String(autoVerify));
      row.querySelector('.model-option-hint').textContent = !autoVerify ? 'Check the work after every change, for every model'
        : verifyCommand ? `Runs "${verifyCommand}" after every change` : "Runs the project's own checks after every change";
    }
  }
  renderVerify();

  const optionFor = (id) => MODEL_OPTIONS.find((option) => option.id === id) || availableModels.find((option) => option.id === id);
  const brandOf = (option) => option.agent; // one mark and accent per company: Opus looks like any Claude model
  const iconFor = (brand) => (brand === 'auto' ? AUTO_ICON : AGENT_ICONS[brand] || '');
  function quotaText(agent) {
    const quota = lastQuotas[agent];
    return typeof quota?.remaining === 'number' ? `${Math.round(quota.remaining)}% ${quota.windowLabel || ''}`.trim() : '';
  }

  function selectModel(modelId, { notifyExtension = true } = {}) {
    const option = optionFor(modelId);
    if (!option) { pendingModelId = modelId; return; }
    pendingModelId = null;
    activeModelId = option.id;
    activeAgent = option.agent;
    modelPickerBtn.dataset.agent = option.agent;
    modelPickerBtn.dataset.brand = brandOf(option);
    modelPickerBtn.querySelector('.model-picker-icon').innerHTML = iconFor(brandOf(option));
    // "Claude Opus 5.5 Medium": the family word hides first when the composer is narrow (the icon already says it).
    const [family, ...rest] = option.label.split(' ');
    const label = modelPickerBtn.querySelector('.model-picker-label');
    label.replaceChildren();
    if (rest.length) { const span = document.createElement('span'); span.className = 'model-picker-family'; span.textContent = `${family} `; label.append(span, rest.join(' ')); }
    else label.textContent = option.label;
    modelPickerBtn.title = `Model: ${option.label}`;
    for (const item of modelMenu.querySelectorAll('.model-option')) item.setAttribute('aria-selected', String(item.dataset.modelId === option.id));
    if (scheduleChoice === false) scheduleChoice = null; // a "send anyway" was for the previous model
    refreshScheduleDefault(); // on if this model is out of usage; the placeholder names it
    if (slashMenu && !slashMenu.hidden) updateSlashMenu();
    try { vscode.setState({ ...(vscode.getState() || {}), modelId: option.id }); } catch {}
    // Picking a model only retargets the next message; it never reveals the
    // real terminal (that's the dedicated Terminal button).
    if (notifyExtension) {
      modelPickerBtn.dispatchEvent(new Event('clanker:model-change'));
      vscode.postMessage({ type: 'setModel', modelId: option.id });
    }
  }

  // An agent chosen from outside the picker (voice routing): keep the current
  // model if it already runs on that agent, else that agent's first model.
  function selectAgent(agentId) {
    if (agentId === activeAgent) return;
    const option = MODEL_OPTIONS.find((candidate) => candidate.agent === agentId);
    if (option) selectModel(option.id, { notifyExtension: false });
  }

  function renderModelMenu() {
    const current = optionFor(activeModelId);
    const visibleIds = new Set([...MODEL_OPTIONS.map((option) => option.id), current?.id]);
    const options = availableModels.length ? [MODEL_OPTIONS[0], ...availableModels.filter((option) => visibleIds.has(option.id))] : MODEL_OPTIONS;
    const groups = [['auto', options.filter((option) => option.agent === 'auto')], ...AGENT_IDS.map((agent) => [agent, options.filter((option) => option.agent === agent)])];
    modelMenu.replaceChildren();
    for (const [agent, options] of groups) {
      if (!options.length) continue;
      const group = document.createElement('div');
      group.className = 'model-group';
      group.setAttribute('role', 'group');
      if (agent !== 'auto') {
        const head = document.createElement('div');
        head.className = 'model-group-head';
        const name = document.createElement('span');
        name.textContent = AGENT_NAMES[agent] || agent;
        const quota = document.createElement('span');
        quota.className = 'model-group-quota';
        quota.textContent = quotaText(agent);
        head.append(name, quota);
        group.setAttribute('aria-label', name.textContent);
        group.appendChild(head);
      }
      for (const option of options) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'model-option';
        item.dataset.modelId = option.id;
        item.dataset.agent = option.agent;
        item.dataset.brand = brandOf(option);
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.id === activeModelId));
        item.innerHTML = `<span class="model-option-icon">${iconFor(brandOf(option))}</span><span class="model-option-text"><span class="model-option-label"></span>${option.hint ? '<span class="model-option-hint"></span>' : ''}</span><svg class="model-option-check" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        item.querySelector('.model-option-label').textContent = option.label;
        if (option.hint) item.querySelector('.model-option-hint').textContent = option.hint;
        if (modelPromptIds.has(option.id)) {
          const note = document.createElement('span');
          note.className = 'model-option-note';
          note.title = 'Your own prompt is sent with every message to this model (Settings > Models)';
          note.innerHTML = NOTE_SVG;
          item.querySelector('.model-option-check').before(note);
        }
        item.addEventListener('click', () => { selectModel(option.id); closeModelMenu(); });
        group.appendChild(item);
      }
      modelMenu.appendChild(group);
    }
    // Auto-Verify applies to every model, so it sits under all of them rather than inside one group.
    const footer = document.createElement('div');
    footer.className = 'model-group model-footer';
    const verify = document.createElement('button');
    verify.type = 'button';
    verify.className = 'model-verify';
    verify.setAttribute('role', 'switch');
    verify.innerHTML = `<span class="model-verify-icon">${VERIFY_SVG}</span><span class="model-option-text"><span class="model-option-label">Auto-Verify</span><span class="model-option-hint">Check the work after every change, for every model</span></span><span class="model-verify-switch" aria-hidden="true"></span>`;
    verify.addEventListener('click', () => setAutoVerify(!autoVerify));
    footer.appendChild(verify);
    modelMenu.appendChild(footer);
    renderVerify();
  }

  function placeModelMenu() {
    const rect = modelPickerBtn.getBoundingClientRect();
    const composerTop = modelPickerBtn.closest('.composer').getBoundingClientRect().top;
    const css = getComputedStyle(modelMenuStage);
    const fillet = parseFloat(css.getPropertyValue('--menu-fillet'));
    // The seam sits 1px into the composer, over its top hairline; the root hangs below it, clipped.
    modelMenuStage.style.bottom = `${window.innerHeight - composerTop - 1 - parseFloat(css.getPropertyValue('--menu-root'))}px`;
    modelMenuStage.style.right = `${Math.max(10, window.innerWidth - rect.right) - fillet}px`;
    const menuLeft = modelMenuStage.getBoundingClientRect().left + fillet;
    modelMenuStage.style.setProperty('--bud-x', `${rect.left + rect.width / 2 - menuLeft}px`);
  }
  const menuOpen = () => modelMenu.classList.contains('is-open');
  function openModelMenu() {
    renderModelMenu();
    placeModelMenu();
    modelMenu.classList.add('is-open');
    modelPickerBtn.setAttribute('aria-expanded', 'true');
    (modelMenu.querySelector('.model-option[aria-selected="true"]') || modelMenu.querySelector('.model-option'))?.focus({ preventScroll: true });
  }
  function closeModelMenu({ refocus = false } = {}) {
    if (!menuOpen()) return;
    modelMenu.classList.remove('is-open');
    modelPickerBtn.setAttribute('aria-expanded', 'false');
    if (refocus) modelPickerBtn.focus();
  }
  modelPickerBtn.addEventListener('click', () => (menuOpen() ? closeModelMenu() : openModelMenu()));
  modelMenu.addEventListener('keydown', (event) => {
    const items = [...modelMenu.querySelectorAll('.model-option')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeModelMenu({ refocus: true });
    } else if (event.key === 'Tab') {
      closeModelMenu();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (menuOpen() && !modelMenu.contains(event.target) && !modelPickerBtn.contains(event.target)) closeModelMenu();
  });
  window.addEventListener('resize', () => closeModelMenu());

  const savedModel = (() => { try { return vscode.getState()?.modelId; } catch { return null; } })();
  selectModel(optionFor(savedModel) ? savedModel : 'auto', { notifyExtension: Boolean(optionFor(savedModel)) && savedModel !== 'auto' });
  if (savedModel && !optionFor(savedModel)) pendingModelId = savedModel;

  // Ctrl+0 = Auto, Ctrl+1..9 = the picker's models in order.
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey) return;
    const digit = /^Digit(\d)$/.exec(event.code)?.[1];
    const option = digit === undefined ? null : MODEL_OPTIONS[Number(digit)];
    if (!option) return;
    event.preventDefault();
    selectModel(option.id);
  });

  // P17-G: the composer is a squircle whenever the text has a newline or would
  // wrap inside the one-line pill. While already a squircle, the wrap check is
  // measured at the pill's (narrower) text width without dropping the class, so
  // layout never flip-flops per keystroke and the lift animation never replays.
  const composerEl = document.querySelector('.composer');
  const composerActions = composerEl.querySelector('.composer-actions');
  function autoGrow() {
    const value = promptInput.value;
    // Empty is always the one-line pill. Measuring scrollHeight here would size
    // the box to the placeholder, which wraps whenever the pill is a little too
    // narrow for it, giving a two-line-tall pill: neither pill nor squircle.
    if (!value) { composerEl.classList.remove('is-multiline'); promptInput.style.height = ''; return; }
    let multiline = value.includes('\n');
    if (!multiline && value) {
      if (composerEl.classList.contains('is-multiline')) {
        promptInput.style.width = `${promptInput.offsetWidth - attachBtn.offsetWidth - composerActions.offsetWidth - 8}px`;
      }
      promptInput.style.height = 'auto';
      multiline = promptInput.scrollHeight > 32;
      promptInput.style.width = '';
    }
    composerEl.classList.toggle('is-multiline', multiline);
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140)}px`;
  }
  promptInput.addEventListener('input', autoGrow);
  window.addEventListener('resize', autoGrow);

  // ---------- P17-F: Stop, in-session turn queue, Steer Now ----------
  // Idle: send arrow. Busy + empty composer: the arrow gives way to a crimson
  // Stop: only this button stops a turn, never a key. Busy + text: Stop plus a Queue button; Enter queues the turn,
  // Ctrl+Enter steers (interrupts and sends now). Queued turns dispatch FIFO
  // in the extension even when this chat isn't visible. Pause holds the next turn; Stop also interrupts the current one.
  const SEND_SVG = sendBtn.innerHTML;
  const SAVE_EDIT_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.25 3.25L13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const QUEUE_SVG = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6.5 13V4.5M3 8l3.5-3.5L10 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 9.5v4M10.5 11.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const STOP_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.75" fill="currentColor"/></svg>';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button'; stopBtn.id = 'stopBtn'; stopBtn.className = 'composer-icon-btn stop-btn'; stopBtn.title = 'Stop'; stopBtn.hidden = true;
  stopBtn.setAttribute('aria-label', 'Stop the running turn');
  stopBtn.innerHTML = STOP_SVG;
  composerActions.insertBefore(stopBtn, sendBtn);

  let busy = false;
  let isCompacting = false;
  let activeCompactDivider = null;
  let queuePaused = false;
  let awaitingInterruptAck = false; // the host's turn_complete for a turn this window already closed out
  let turnQueue = []; // { id, text, modelId, attachments }
  let editingQueue = null;
  let composerDraft = null;
  function saveQueueEdit(finish = false) {
    if (!editingQueue) return;
    const turn = { ...editingQueue.turn, text: promptInput.value, modelId: pendingModelId || activeModelId, attachments: attachments.map(file => file.path), files: attachments.slice() };
    if (!editingQueue.taskId) {
      const original = turnQueue.find(item => item.id === turn.id);
      if (original) Object.assign(original, turn);
    }
    queueAction(editingQueue.taskId ? 'saveScheduledDraft' : 'editQueuedTurn', { chatId: editingQueue.chatId, taskId: editingQueue.taskId, turn, editing: !finish });
    if (finish) editingQueue = null;
  }
  function editQueuePrompt(turn, taskId = null) {
    if (!editingQueue) composerDraft = { text: promptInput.value, files: attachments.slice(), modelId: pendingModelId || activeModelId };
    saveQueueEdit(true);
    editingQueue = { turn, taskId, chatId: currentChatId };
    promptInput.value = turn.text;
    attachments = (turn.files || []).slice();
    selectModel(turn.modelId || 'auto');
    if (!taskId) queueAction('editQueuedTurn', { turn, editing: true });
    renderAttachments(); autoGrow(); renderComposerState(); renderTurnQueue(); promptInput.focus();
  }
  function finishQueueEdit() {
    saveQueueEdit(true);
    const draft = composerDraft;
    composerDraft = null;
    promptInput.value = draft?.text || '';
    attachments = draft?.files || [];
    if (draft?.modelId) selectModel(draft.modelId);
    renderAttachments(); autoGrow(); renderComposerState(); renderTurnQueue();
  }

  function renderComposerState() {
    const queueing = !editingQueue && (busy || turnQueue.length > 0) && !scheduleArmed && Boolean(promptInput.value.trim());
    stopBtn.hidden = !busy;
    sendBtn.hidden = !editingQueue && busy && !queueing && !scheduleArmed;
    const mode = editingQueue ? 'edit' : queueing ? 'queue' : 'send';
    if (sendBtn.dataset.mode !== mode) {
      sendBtn.dataset.mode = mode;
      sendBtn.classList.toggle('is-queue', queueing);
      sendBtn.innerHTML = editingQueue ? SAVE_EDIT_SVG : queueing ? QUEUE_SVG : SEND_SVG;
    }
    sendBtn.title = queueing ? (queuePaused ? 'Add to the paused queue (Enter). Ctrl+Enter sends now.' : 'Queue for after this turn (Enter). Ctrl+Enter sends now.') : 'Send';
    if (editingQueue) sendBtn.title = 'Save queue edits (Enter). Ctrl+Enter sends now.';
    // Stop and send together: send steps in left of the clock (style.css), so the clock under your pointer never moves.
    composerActions.classList.toggle('is-queueing', !stopBtn.hidden && !sendBtn.hidden);
    autoGrow(); // Stop/Queue buttons change the text column's width, so re-measure
  }
  function setBusy(next) { busy = next; renderComposerState(); syncPending(); }

  // Pending indicator: the moment a turn starts, and again whenever the agent
  // goes quiet mid-turn (after a tool card), a glass "Thinking" pill sits at
  // the end of the transcript. It steps aside while reply text streams and
  // while a card waits on you. One observer covers every append path.
  const pendingEl = document.createElement('div');
  pendingEl.className = 'msg-pending';
  pendingEl.setAttribute('role', 'status');
  pendingEl.innerHTML = '<span class="pending-orb" aria-hidden="true"></span><span class="pending-label">Thinking</span><span class="pending-time" aria-hidden="true"></span><span class="pending-tokens"></span><span class="pending-cost"></span><span class="pending-thought"></span>';
  const pendingTime = pendingEl.querySelector('.pending-time');
  const pendingTokens = pendingEl.querySelector('.pending-tokens');
  const pendingThought = pendingEl.querySelector('.pending-thought');
  // Beside the context: what this whole chat would have cost at pay-per-token API prices (the extension adds each turn,
  // compactions included, since it is still the same chat). A comparison for the subscription, never a charge.
  const pendingCost = pendingEl.querySelector('.pending-cost');
  pendingCost.title = 'API value of this chat: what its tokens would cost at the providers’ pay-per-token API prices. An estimate for comparison. Your subscriptions cover this work; nothing is charged.';
  function renderChatCost(usd) {
    pendingCost.textContent = usd > 0 ? `≈ ${window.apiValue.formatUsd(usd)} API value` : '';
  }
  // The running clock for the turn; it becomes the "Worked for" figure at the end.
  setInterval(() => {
    if (pendingEl.isConnected && turnStartedAt) pendingTime.textContent = Date.now() - turnStartedAt >= 1000 ? formatDuration(Date.now() - turnStartedAt) : '';
  }, 1000);

  // P17-T: live reasoning. Streams into the pending pill's second line (the
  // plain "Thinking" pill when a model sends none), then folds into a closed
  // drawer above whatever comes next.
  let turnThought = '';
  function appendThought(text) {
    turnThought += text;
    pendingEl.classList.add('has-thought');
    pendingThought.textContent = turnThought.replace(/\s+/g, ' ').trim().slice(-220);
    syncPending();
  }
  function foldThought() {
    if (!turnThought.trim()) return;
    const fold = document.createElement('details');
    fold.className = 'thought-fold';
    const summary = document.createElement('summary');
    summary.textContent = 'Thought process';
    const body = document.createElement('div');
    body.className = 'thought-body';
    body.textContent = turnThought.trim();
    fold.append(summary, body);
    turnHost().insertBefore(fold, pendingEl.isConnected && pendingEl.parentNode === turnHost() ? pendingEl : null);
    resetThought();
  }
  function resetThought() {
    turnThought = '';
    pendingEl.classList.remove('has-thought');
    pendingThought.textContent = '';
  }
  function syncPending() {
    const last = [...turnHost().children].reverse().find((el) => el !== pendingEl);
    const show = busy && !isCompacting && Boolean(last) && last !== currentAssistantBubble && !last.matches('.approval-card, .question-card');
    if (show && turnHost().lastElementChild !== pendingEl) { turnHost().appendChild(pendingEl); scrollTranscriptToEnd(); }
    else if (!show && pendingEl.isConnected) pendingEl.remove();
  }
  new MutationObserver(syncPending).observe(transcriptEl, { childList: true, subtree: true });

  let lastTurn = null; // P17-I: what an upstream_error card's Retry resends
  function dispatchTurn(turn, steer = true) { // steer false: a queued turn taking its turn, which the host lines up behind whatever it has running
    lastTurn = turn;
    if (turn.modelId !== activeModelId) selectModel(turn.modelId);
    if (emptyMascot) {
      const isVisibleFreshChat = transcriptEl && !transcriptEl.querySelector('.msg-user, .msg-assistant, .compact-divider, .chat-turn');
      if (isVisibleFreshChat) emptyMascot.launch();
      else emptyMascot.dispose();
      emptyMascot = null;
    }
    appendUserMessage(turn.text, undefined, turn.files);
    setBusy(true);
    dropUndo(); // the last turn's undo is only for the last turn
    vscode.postMessage({ type: 'send', chatId: currentChatId, modelId: turn.modelId, text: turn.text, attachments: turn.attachments, submit: true, steer, verify: Boolean(turn.verify), pipeline: Boolean(turn.pipeline) });
  }

  function appendInterruptedPill() {
    foldSteps();
    const pill = document.createElement('div');
    pill.className = 'chat-notice is-interrupted';
    pill.innerHTML = STOP_SVG;
    pill.append('Interrupted by user');
    turnHost().appendChild(pill);
    scrollTranscriptToEnd();
  }

  // Closes the running turn out in this window right away; the host's own
  // turn_complete for it (if the process was still alive) is then swallowed.
  function interruptLocally() {
    awaitingInterruptAck = true;
    if (isCompacting) { finishCompactDivider('interrupted'); isCompacting = false; }
    for (const [id, card] of pendingCards) { settleCard(card, 'Turn stopped', 'denied'); pendingCards.delete(id); }
    document.querySelectorAll('.tool-card.is-running').forEach((card) => {
      finishToolCard(card, { output: card.querySelector('.tool-body')?.textContent || '' });
      card.classList.add('is-cancelled');
    });
    foldThought(); // what it was thinking when stopped stays readable
    appendInterruptedPill();
    endAssistantTurn();
    collapseTurn(turnAnchor, Date.now() - turnStartedAt);
    turnAnchor = null;
    setBusy(false);
  }

  function stopTurn() {
    if (!busy) return;
    vscode.postMessage({ type: 'stop' });
    interruptLocally();
    if (turnQueue.length) { queuePaused = true; renderTurnQueue(); }
  }

  function steerTurn(turn) {
    if (busy) interruptLocally(); // the host interrupts the process itself when the send lands
    dispatchTurn(turn);
  }

  const queueStrip = document.createElement('div');
  queueStrip.className = 'turn-queue-strip island-bud';
  queueStrip.hidden = true;
  queueStrip.setAttribute('aria-label', 'Queued turns');
  // Inside the dock, so it fuses with the pill (docs/dynamic-island-composer-spec.md).
  document.querySelector('.compose-row').prepend(queueStrip);

  // P17-L: hairline icons, no emoji.
  const queueSvg = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const QUEUE_ICONS = {
    steer: queueSvg('<path d="M9 1.75 3.5 9h4L7 14.25 12.5 7h-4z"/>'),
    edit: PENCIL_SVG,
    remove: queueSvg(TRASH_PATH),
    unschedule: queueSvg('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h6.75a4 4 0 0 1 0 8H7"/>'),
    grip: queueSvg('<path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" stroke-width="2"/>'),
    pause: queueSvg('<path d="M5.5 4v8M10.5 4v8"/>'),
    play: queueSvg('<path d="m5.5 3.5 7 4.5-7 4.5z"/>'),
  };
  const queueAction = (type, details = {}) => vscode.postMessage({ type, chatId: currentChatId, ...details });

  // P17-M: the dragged row follows the pointer; siblings spring aside by one
  // row pitch (transform only, no reflow). On drop the queue re-renders in the
  // new order and the row FLIPs from where it was let go into its slot.
  function startQueueDrag(event, row, turn) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rows = [...queueStrip.querySelectorAll('.turn-queue-item')];
    const from = rows.indexOf(row);
    const tops = rows.map((r) => r.offsetTop);
    const pitch = rows.length > 1 ? tops[1] - tops[0] : row.offsetHeight;
    const startY = event.clientY;
    const grip = event.currentTarget;
    let to = from;
    let dy = 0;
    grip.setPointerCapture(event.pointerId);
    queueStrip.classList.add('is-sorting');
    row.classList.add('is-dragging');
    const move = (e) => {
      dy = Math.max(tops[0] - tops[from], Math.min(tops[rows.length - 1] - tops[from], e.clientY - startY));
      row.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / pitch)));
      rows.forEach((r, i) => {
        if (r === row) return;
        const shift = i > from && i <= to ? -pitch : i < from && i >= to ? pitch : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      const letGoAt = tops[from] + dy;
      if (to !== from) turnQueue.splice(to, 0, ...turnQueue.splice(from, 1));
      queueAction('reorderQueuedTurns', { ids: turnQueue.map((item) => item.id) });
      renderTurnQueue();
      const settled = queueStrip.querySelector(`[data-id="${CSS.escape(turn.id)}"]`);
      if (settled) {
        settled.style.transition = 'none';
        settled.style.transform = `translateY(${letGoAt - settled.offsetTop}px)`;
        settled.getBoundingClientRect();
        settled.style.transition = '';
        settled.style.transform = '';
      }
      setTimeout(() => queueStrip.classList.remove('is-sorting'), 420);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }
  // A queued turn's files: up to three overlapping thumbnails plus "3 photos" /
  // "2 files"; narrow rows drop the thumbnails, then the word (style.css).
  function queuedFilesBadge(files) {
    const photos = files.filter((file) => file.mime?.startsWith('image/') && file.uri);
    const allPhotos = photos.length === files.length;
    const badge = document.createElement('span');
    badge.className = 'turn-queue-files';
    badge.title = files.map((file) => file.name).join('\n');
    const thumbs = document.createElement('span');
    thumbs.className = 'turn-queue-thumbs';
    for (const photo of photos.slice(0, 3)) {
      const img = document.createElement('img');
      img.src = photo.uri; img.alt = '';
      thumbs.append(img);
    }
    const icon = document.createElement('span');
    icon.className = 'turn-queue-files-icon';
    icon.innerHTML = queueSvg(allPhotos
      ? '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="6.5" r="1.1"/><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3"/>'
      : '<path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2"/>');
    const count = document.createElement('span');
    count.className = 'turn-queue-files-count';
    const word = document.createElement('span');
    word.className = 'turn-queue-files-word';
    word.textContent = allPhotos ? (files.length === 1 ? ' photo' : ' photos') : (files.length === 1 ? ' file' : ' files');
    count.append(String(files.length), word);
    if (photos.length) badge.append(thumbs);
    badge.append(icon, count);
    return badge;
  }

  // This chat's scheduled prompts (the scheduler holds them; the chat shows them where the queue is).
  const scheduledHere = () => activeTasks().filter((task) => task.status === 'pending' && task.chatId && task.chatId === currentChatId);
  function scheduledRow(task) {
    const row = document.createElement('div');
    row.className = 'turn-queue-item is-scheduled';
    row.dataset.taskId = task.id;
    const mark = document.createElement('span');
    mark.className = 'turn-queue-grip turn-queue-clock';
    mark.innerHTML = CLOCK_SVG;
    mark.title = 'Scheduled';
    const option = optionFor(task.modelId) || MODEL_OPTIONS.find((candidate) => candidate.agent === task.model) || MODEL_OPTIONS[0];
    const pill = document.createElement('span');
    pill.className = 'model-pill';
    pill.dataset.brand = brandOf(option);
    pill.innerHTML = iconFor(brandOf(option));
    pill.append(option.shortLabel || option.label);
    const text = document.createElement('span');
    text.className = 'turn-queue-text';
    text.textContent = task.prompt;
    text.title = task.prompt;
    const when = document.createElement('span');
    when.className = 'turn-queue-when';
    const at = fireTimeOf(task);
    when.textContent = task.dispatchTrigger === 'quota-reset' ? (at ? `at reset · ${formatCountdown(at - Date.now())}` : 'at reset') : at ? formatWhen(at) : '';
    const button = (icon, label, title, cls, type) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = `turn-queue-btn ${cls}`; btn.innerHTML = icon; btn.title = title;
      if (label) btn.append(label); else btn.setAttribute('aria-label', title);
      btn.addEventListener('click', () => vscode.postMessage({ type, taskId: task.id }));
      return btn;
    };
    row.append(mark, pill, text, when,
      button(QUEUE_ICONS.steer, 'Send Now', 'Send this now instead of waiting', 'is-primary', 'dispatchNowWithAutoRoute'),
      button(QUEUE_ICONS.edit, '', 'Move back into the composer', 'is-icon', 'unscheduleToComposer'),
      button(QUEUE_ICONS.remove, '', 'Delete', 'is-danger is-icon', 'cancelScheduledTask'));
    return row;
  }

  function renderTurnQueue() {
    const scheduled = scheduledHere();
    queueStrip.hidden = !(turnQueue.length || scheduled.length);
    queueStrip.replaceChildren();
    if (!(turnQueue.length || scheduled.length)) return;
    const head = document.createElement('div');
    head.className = 'turn-queue-head';
    const title = document.createElement('span');
    const parts = [];
    if (turnQueue.length) parts.push(queuePaused ? `${turnQueue.length} queued · paused` : `${turnQueue.length} queued · sends after this turn`);
    if (scheduled.length) parts.push(`${scheduled.length} scheduled`);
    title.textContent = parts.join(' · ');
    head.append(title);
    const transport = document.createElement('button');
    transport.type = 'button'; transport.className = 'turn-queue-btn is-icon queue-transport';
    transport.innerHTML = queuePaused ? QUEUE_ICONS.play : QUEUE_ICONS.pause;
    transport.title = queuePaused ? 'Resume queue' : 'Pause queue after the current task';
    transport.setAttribute('aria-label', queuePaused ? 'Resume queue' : 'Pause queue');
    transport.addEventListener('click', () => {
      queuePaused = !queuePaused;
      queueAction('pauseTurnQueue', { paused: queuePaused });
      renderTurnQueue();
      renderComposerState();
      queueStrip.querySelector('.queue-transport')?.focus({ preventScroll: true });
    });
    if (turnQueue.length) head.append(transport);
    queueStrip.append(head);
    // Scheduled prompts sit in the same list, marked with a clock: they wait for a time (or the usage reset) instead of the
    // previous turn, and then join the queue.
    for (const task of scheduled) if (task.id !== editingQueue?.taskId) queueStrip.append(scheduledRow(task));
    for (const turn of turnQueue) {
      if (!editingQueue?.taskId && turn.id === editingQueue?.turn.id) continue;
      const row = document.createElement('div');
      row.className = 'turn-queue-item';
      row.dataset.id = turn.id;
      const grip = document.createElement('span');
      grip.className = 'turn-queue-grip';
      grip.title = 'Drag to reorder';
      grip.innerHTML = QUEUE_ICONS.grip;
      grip.addEventListener('pointerdown', (event) => startQueueDrag(event, row, turn));
      row.append(grip);
      const option = optionFor(turn.modelId) || MODEL_OPTIONS[0];
      const pill = document.createElement('span');
      pill.className = 'model-pill';
      pill.dataset.brand = brandOf(option);
      pill.innerHTML = iconFor(brandOf(option));
      pill.append(option.shortLabel || option.label);
      const text = document.createElement('span');
      text.className = 'turn-queue-text';
      text.textContent = turn.text;
      text.title = turn.text;
      const button = (icon, label, title, cls, onClick) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = `turn-queue-btn ${cls}`; btn.innerHTML = icon; btn.title = title;
        if (label) btn.append(label); else btn.setAttribute('aria-label', title);
        btn.addEventListener('click', onClick);
        return btn;
      };
      const remove = () => { queueAction('removeQueuedTurn', { id: turn.id }); turnQueue = turnQueue.filter((item) => item !== turn); renderTurnQueue(); };
      row.append(pill, text);
      if (turn.files?.length) row.append(queuedFilesBadge(turn.files));
      row.append(
        button(QUEUE_ICONS.steer, 'Steer Now', busy ? 'Interrupt the running turn and send this now' : 'Send this now', 'is-primary', () => { queueAction('steerQueuedTurn', { id: turn.id }); }),
        button(QUEUE_ICONS.edit, '', 'Move back into the composer', 'is-icon', () => {
          editQueuePrompt(turn);
        }),
        button(QUEUE_ICONS.remove, '', 'Delete', 'is-danger is-icon', () => {
          for (const file of turn.files || []) vscode.postMessage({ type: 'removeAttachment', path: file.path }); // as a composer chip's ×
          remove();
        }));
      queueStrip.append(row);
    }
  }

  function sendPrompt({ steer = false } = {}) {
    let text = promptInput.value.trim();
    if (editingQueue && !steer) { finishQueueEdit(); return; }
    if (!text) return;
    // /undo is Clanker's own: the host asks, then puts the last turn's file changes back.
    if (/^\/undo\s*$/i.test(text)) {
      vscode.postMessage({ type: 'undoTurn' });
      promptInput.value = '';
      closeSlashMenu(); autoGrow(); renderComposerState();
      return;
    }
    // /verify toggles Auto-Verify; /verify npm test pins that command and turns it on; /verify off clears it.
    const verify = /^\/verify(?:\s+([\s\S]+))?$/i.exec(text);
    if (verify) {
      const command = (verify[1] || '').trim();
      if (!command) setAutoVerify(!autoVerify);
      else if (/^(off|none|auto)$/i.test(command)) { vscode.postMessage({ type: 'setVerifyCommand', command: '' }); setAutoVerify(true); }
      else { vscode.postMessage({ type: 'setVerifyCommand', command }); setAutoVerify(true); }
      promptInput.value = '';
      closeSlashMenu(); autoGrow(); renderComposerState();
      return;
    }
    // /architect <task>: a planning model, then a building one (models: aiChatPanel.architectModel / editorModel).
    const architect = /^\/architect(?:\s+([\s\S]+))?$/i.exec(text);
    if (architect && !architect[1]) { appendNotice('Give /architect a task: "/architect move the header links into a menu".'); return; }
    const pipeline = Boolean(architect);
    if (pipeline) text = architect[1].trim();
    // A panel command, not a turn: hands this chat's Claude session to the phone (see extension.js).
    if (/^\/(remote-control|rc)(\s|$)/i.test(text)) {
      vscode.postMessage({ type: 'remoteControl' });
      promptInput.value = '';
      closeSlashMenu(); autoGrow(); renderComposerState();
      return;
    }
    flushVoiceDraft(text);
    const turn = { id: crypto.randomUUID(), text, modelId: pendingModelId || activeModelId, attachments: attachments.map((attachment) => attachment.path), files: attachments.slice(), verify: autoVerify, pipeline };
    if (editingQueue) {
      queueAction(editingQueue.taskId ? 'cancelScheduledTask' : 'removeQueuedTurn', { chatId: editingQueue.chatId, taskId: editingQueue.taskId, id: editingQueue.turn.id });
      editingQueue = null;
    }
    if (scheduleArmed) {
      schedulePrompt(text);
      scheduleChoice = null;
      scheduleTimer.clear(); // the pick was for this prompt; the next one starts from the default again
      refreshScheduleDefault(); // stays on while the model is out of usage, so the next prompt queues too
    } else if ((busy || turnQueue.length) && !steer) {
      turnQueue.push(turn);
      queueAction('queueTurn', { turn });
      renderTurnQueue();
    } else {
      steerTurn(turn);
    }
    attachments = [];
    renderAttachments();
    mentioned.clear();
    renderMentions();
    promptInput.value = '';
    if (composerDraft) {
      promptInput.value = composerDraft.text;
      attachments = composerDraft.files;
      selectModel(composerDraft.modelId);
      composerDraft = null;
      renderAttachments();
    }
    closeSlashMenu();
    autoGrow();
    renderComposerState();
  }

  sendBtn.addEventListener('click', () => sendPrompt());
  stopBtn.addEventListener('click', () => { stopTurn(); promptInput.focus(); });
  scheduleBtn.addEventListener('click', renderComposerState);
  promptInput.addEventListener('input', renderComposerState);
  promptInput.addEventListener('input', () => saveQueueEdit());

  promptInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendPrompt({ steer: event.ctrlKey || event.metaKey });
    }
  });

  micBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'micToggle' });
  });
  // Esc drops the recording without transcribing it.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !composerEl.classList.contains('is-voice') || composerEl.classList.contains('is-voice-processing')) return;
    event.preventDefault();
    vscode.postMessage({ type: 'micCancel' });
  });

  // ---------- P17-ZA: live mic meter in the composer ----------
  // One symmetric voice meter: thin bars swell from the centre with the speaker's level and a soft ripple travels
  // outward; in silence they rest as an even row of dots. The edge fade is a CSS mask. The mic button's ring follows
  // the same level (--mic-level). Stop squeezes the bars into a shimmer beam while Whisper runs; the draft then
  // fades in where the beam was. The recording also ends by itself after a pause in speech (VOICE_SILENCE_MS).
  const WAVE_BARS = 31;
  const voiceOverlay = document.createElement('div');
  voiceOverlay.id = 'composerVoiceOverlay'; voiceOverlay.className = 'voice-overlay'; voiceOverlay.hidden = true;
  voiceOverlay.setAttribute('aria-hidden', 'true');
  const waveBars = Array.from({ length: WAVE_BARS }, () => { const bar = document.createElement('span'); bar.className = 'waveform-bar'; return bar; });
  voiceOverlay.append(...waveBars);
  composerEl.appendChild(voiceOverlay);
  const WAVE_MIN = 3; // px: a resting dot
  const WAVE_MAX = 28; // px: the loudest centre bar
  const VOICE_SPEECH = 0.12; // a level above this is speech, not room noise
  const VOICE_MIN_SPEECH_MS = 300; // a cough does not arm the auto-stop
  let micLevel = 0; // latest level, 0..1
  let micLevelAt = 0;
  let waveLevel = 0; // micLevel smoothed per frame: quick to rise, slow to fall
  let waveFrame = 0;
  let speechMs = 0; // speech heard so far in this recording
  let lastSpeechAt = 0;
  let lastVolumeAt = 0;
  let voiceStopSent = false; // the auto-stop fires once per recording
  let lastVoiceDraft = null; // { original, raw }: what the transcript said, to learn from the user's fixes
  const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
  function waveStep(now) {
    const target = now - micLevelAt < 300 ? micLevel : 0;
    waveLevel += (target - waveLevel) * (target > waveLevel ? 0.35 : 0.1);
    const t = now / 1000;
    const mid = (WAVE_BARS - 1) / 2;
    for (let i = 0; i < WAVE_BARS; i++) {
      const x = Math.abs(i - mid) / mid; // 0 at the centre, 1 at the edges
      const swell = (1 - x ** 1.7) * (0.74 + 0.26 * Math.sin(t * 7 - x * 5)); // bell-shaped, rippling outward
      const s = Math.min(1, waveLevel * swell * 1.15);
      waveBars[i].style.height = `${(WAVE_MIN + (WAVE_MAX - WAVE_MIN) * s).toFixed(1)}px`;
      waveBars[i].style.opacity = (0.3 + 0.7 * s).toFixed(2);
    }
    micBtn.style.setProperty('--mic-level', waveLevel.toFixed(3));
    waveFrame = requestAnimationFrame(waveStep);
  }
  function setVoiceState(state) {
    const recording = state === 'recording';
    const processing = state === 'processing';
    cancelAnimationFrame(waveFrame);
    emptyMascot?.setListening?.(recording);
    if (recording) {
      voiceOverlay.hidden = false;
      micLevelAt = 0; micLevel = 0; waveLevel = 0; speechMs = 0; lastSpeechAt = 0; lastVolumeAt = 0; voiceStopSent = false;
      if (!REDUCED_MOTION.matches) waveFrame = requestAnimationFrame(waveStep);
    } else {
      micBtn.style.removeProperty('--mic-level');
    }
    if (processing) {
      waveBars.forEach((bar) => { bar.style.opacity = ''; bar.style.height = ''; }); // CSS collapses them to the 4px baseline
      promptInput.placeholder = 'Transcribing & formatting with Whisper…';
    }
    composerEl.classList.toggle('is-voice', recording || processing);
    composerEl.classList.toggle('is-voice-processing', processing);
    if (!recording && !processing) {
      setScheduleArmed(scheduleArmed); // restores the placeholder
      setTimeout(() => { if (!composerEl.classList.contains('is-voice')) voiceOverlay.hidden = true; }, 280);
    }
  }
  // The transcript lands as an editable draft: text fades in and the composer springs to its new height.
  function insertVoiceDraft(text) {
    const from = promptInput.offsetHeight;
    promptInput.value = promptInput.value.trim() ? `${promptInput.value}\n${text}` : text;
    autoGrow();
    renderComposerState();
    const to = promptInput.offsetHeight;
    if (!REDUCED_MOTION.matches) {
      promptInput.animate([{ height: `${from}px`, opacity: 0 }, { height: `${to}px`, opacity: 1 }], { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    }
    promptInput.focus();
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  }
  // Called on send/schedule: whatever the user changed from the transcript teaches the dictionary.
  function flushVoiceDraft(sent) {
    if (!lastVoiceDraft) return;
    if (sent && sent !== lastVoiceDraft.original) vscode.postMessage({ type: 'voiceDraftSubmitted', original: lastVoiceDraft.original, edited: sent });
    lastVoiceDraft = null;
  }
  promptInput.addEventListener('input', () => { if (!promptInput.value.trim()) lastVoiceDraft = null; }); // cleared = abandoned
  // Navigating away counts too: hiding the window keeps what was fixed so far (switching chats flushes in chatLoaded).
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushVoiceDraft(promptInput.value.trim()); });

  // The pill is the way back to the prompts: it jumps to the chat holding the next one to go out; with scheduled prompts in
  // several chats, hovering lists them all (the same marks and names as Recent in the sidebar).
  const scheduledChats = () => {
    const byChat = new Map();
    for (const task of activeTasks().filter((entry) => entry.status === 'pending' && entry.chatId)) {
      const entry = byChat.get(task.chatId) || { id: task.chatId, count: 0, at: Infinity, agent: task.model };
      entry.count += 1;
      entry.at = Math.min(entry.at, fireTimeOf(task) || Infinity);
      byChat.set(task.chatId, entry);
    }
    return [...byChat.values()].sort((a, b) => a.at - b.at);
  };
  const schedPop = document.createElement('div');
  schedPop.className = 'sched-pop';
  schedPop.hidden = true;
  document.body.appendChild(schedPop);
  let schedPopTimer;
  function showSchedPop() {
    clearTimeout(schedPopTimer);
    const chats = scheduledChats();
    if (chats.length < 2) { schedPop.hidden = true; return; }
    schedPop.replaceChildren(...chats.map((entry) => {
      const session = historySessions.find((item) => item.id === entry.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sched-pop-row';
      row.dataset.agent = (session?.models || []).at(-1) || entry.agent;
      row.innerHTML = '<span class="sched-pop-mark"></span><span class="sched-pop-title"></span><span class="sched-pop-meta"></span>';
      row.querySelector('.sched-pop-mark').innerHTML = (window.AGENT_ICONS && window.AGENT_ICONS[row.dataset.agent]) || '';
      row.querySelector('.sched-pop-title').textContent = session?.title || session?.preview || 'Chat';
      row.querySelector('.sched-pop-meta').textContent = `${entry.count} scheduled${Number.isFinite(entry.at) ? ` · ${formatCountdown(entry.at - Date.now())}` : ''}`;
      row.classList.toggle('is-here', entry.id === currentChatId);
      row.addEventListener('click', () => { schedPop.hidden = true; if (entry.id !== currentChatId) vscode.postMessage({ type: 'restoreChat', id: entry.id }); });
      return row;
    }));
    const rect = queueBtn.getBoundingClientRect();
    schedPop.hidden = false;
    schedPop.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - schedPop.offsetHeight - 12))}px`;
    schedPop.style.right = `${window.innerWidth - rect.left + 10}px`;
  }
  const hideSchedPop = () => { schedPopTimer = setTimeout(() => { schedPop.hidden = true; }, 220); };
  queueBtn.addEventListener('mouseenter', showSchedPop);
  queueBtn.addEventListener('mouseleave', hideSchedPop);
  schedPop.addEventListener('mouseenter', () => clearTimeout(schedPopTimer));
  schedPop.addEventListener('mouseleave', hideSchedPop);
  queueBtn.addEventListener('click', () => {
    const chats = scheduledChats();
    // Tasks from before they were tied to a chat have no chat to jump to: the old list opens.
    if (!chats.length) { if (!queueModal.el.hidden) { closeModal(queueModal.el); return; } queuePinned = false; renderQueue(); openModal(queueModal); return; }
    schedPop.hidden = true;
    if (chats[0].id !== currentChatId) vscode.postMessage({ type: 'restoreChat', id: chats[0].id }); else promptInput.focus();
  });
  newChatBtn.addEventListener('click', () => { if (editingQueue) finishQueueEdit(); attachments = []; renderAttachments(); clearEmptyState(); vscode.postMessage({ type: 'newChat' }); });
  historyBtn.addEventListener('click', () => { if (toggleModal(historyModal)) vscode.postMessage({ type: 'requestHistory' }); });
  terminalBtn?.addEventListener('click', () => {
    // The only action that ever reveals the real VS Code terminal — an
    // explicit escape hatch for debugging, not something a tab click does.
    vscode.postMessage({ type: 'focusTerminal', agentId: activeAgent });
  });


  // ---------- Markdown rendering (no remote scripts: CSP forbids them) ----------

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  // Everything is escaped first; only the constructs below turn back into
  // markup, so agent output can never inject arbitrary HTML into the webview.
  // Math goes through the bundled KaTeX (media/vendor/katex).

  function renderMath(tex, display) {
    try {
      if (window.katex) return window.katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' });
    } catch { /* fall through to the raw source */ }
    return `<code class="math-fallback">${escapeHtml(tex.trim())}</code>`;
  }

  function renderEmphasis(s) {
    return s
      .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  }

  // A short list of harmless inline HTML, plus a colour-only <span>.
  const SAFE_TAGS = /&lt;(\/?)(mark|kbd|sub|sup|u|s|del|ins|small|details|summary|br)\s*\/?&gt;/gi;
  const COLOR_SPAN = /&lt;span style=(?:&quot;|&#39;)\s*color:\s*(#[0-9a-f]{3,8}|[a-z]{3,20})\s*;?\s*(?:&quot;|&#39;)&gt;/gi;
  function allowHtml(s) {
    return s.replace(SAFE_TAGS, '<$1$2>').replace(COLOR_SPAN, '<span style="color:$1">').replace(/&lt;\/span&gt;/gi, '</span>');
  }

  // P17-P: file references become badges: type icon, basename, full path on hover, click opens at the line.
  const FILE_REF = /^(?:file:\/\/\/?)?([^\s<>"|?*]+\.([a-z][a-z0-9]{0,7}))(?:#L?(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)?$/i;
  const fileSvg = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const FILE_ICONS = {
    doc: fileSvg('<path d="M9.5 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V4.75z"/><path d="M9.5 1.75v3h3M5.5 8.5h5M5.5 11h3.5"/>'),
    code: fileSvg('<path d="M9.5 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V4.75z"/><path d="M9.5 1.75v3h3M6.75 8 5.5 9.5l1.25 1.5M9.25 8l1.25 1.5-1.25 1.5"/>'),
    image: fileSvg('<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5"/><circle cx="6" cy="6.5" r="1.1"/><path d="m13.75 10.5-3.5-3.25-6.5 6"/>'),
  };
  // Which FILE_ICONS glyph an extension gets; anything unlisted is a plain doc.
  const FILE_KIND = Object.fromEntries([
    ...['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'astro', 'css', 'scss', 'html', 'json', 'py', 'ps1', 'sh', 'bash', 'yml', 'yaml', 'toml'].map((ext) => [ext, 'code']),
    ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].map((ext) => [ext, 'image']),
  ]);
  const KNOWN_FILE_EXTENSIONS = new Set([
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'astro', 'css', 'scss', 'html', 
    'json', 'py', 'ps1', 'sh', 'bash', 'yml', 'yaml', 'md', 'txt', 'toml', 
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'
  ]);
  function fileBadge(ref) {
    const match = FILE_REF.exec(ref);
    if (!match || /^(https?|mailto):/i.test(ref)) return null;
    let file = match[1];
    try { file = decodeURIComponent(file); } catch { /* keep as written */ }
    const ext = match[2].toLowerCase();
    if (!KNOWN_FILE_EXTENSIONS.has(ext)) return null;
    const line = match[3] || match[4] || '';
    const base = file.split(/[\\/]/).pop();
    const shown = file.replace(/^\/?[a-z]:\//i, '');
    return `<button type="button" class="file-badge" data-ext="${escapeHtml(ext)}" data-path="${escapeHtml(file)}" data-line="${line}" title="${escapeHtml(shown + (line ? `:${line}` : ''))}">${FILE_ICONS[FILE_KIND[ext] || 'doc']}<span>${escapeHtml(base)}${line ? `<small>:${line}</small>` : ''}</span></button>`;
  }
  transcriptEl.addEventListener('click', (event) => {
    const badge = event.target.closest?.('.file-badge');
    if (badge) vscode.postMessage({ type: 'openFile', path: badge.dataset.path, line: Number(badge.dataset.line) || null });
  });

  function renderInline(text, notes) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = String(text)
      .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
        const badge = /[\\/]/.test(code) && !/\s/.test(code.trim()) ? fileBadge(code.trim()) : null;
        return hold(badge || `<code>${escapeHtml(code.trim())}</code>`);
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, _label, target) => { const badge = fileBadge(target); return badge ? hold(badge) : whole; })
      .replace(/\$\$([^$]+?)\$\$/g, (_, tex) => hold(renderMath(tex, true)))
      .replace(/\\\((.+?)\\\)/g, (_, tex) => hold(renderMath(tex, false)))
      .replace(/(^|[\s([{])\$(?!\s|\$|\d)([^$\n`=;|+]{1,120}?)(?<!\s|\$)\$(?=[\s)\]},.:;!?]|$)/g, (whole, pre, tex) => {
        if (/\$[a-zA-Z_]/.test(tex)) return whole;
        return pre + hold(renderMath(tex, false));
      });
    s = escapeHtml(s)
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, label, url) => hold(`<a href="${url}" title="${url}">${renderEmphasis(label)}</a>`))
      .replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g, (_, pre, url) => pre + hold(`<a href="${url}">${url}</a>`))
      .replace(/(^|[\s(])((?:(?:\.{1,2}[\\/])|[a-zA-Z]:[\\/]|[\w@-]{2,}[\\/])(?:[\w.@-]+[\\/])*[\w@-]+\.[a-z][a-z0-9]{0,7}(?::\d+(?::\d+)?)?)(?=[\s),;!?]|[.:](?:\s|$)|$)/gi, (whole, pre, ref) => {
        const badge = fileBadge(ref);
        return badge ? pre + hold(badge) : whole;
      })
      .replace(/\[\^([^\]\s]+)\]/g, (_, id) => hold(footnoteRef(id, notes)));
    s = allowHtml(renderEmphasis(s));
    while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[n]);
    return s;
  }

  function footnoteRef(id, notes) {
    if (!notes.order.includes(id)) notes.order.push(id);
    return `<sup class="fn-ref"><a href="#fn-${notes.prefix}-${escapeHtml(id)}">${notes.order.indexOf(id) + 1}</a></sup>`;
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const FOOTNOTE_RE = /^\[\^([^\]\s]+)\]:\s*(.*)$/;
  const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const MATH_OPEN_RE = /^\s*(\$\$|\\\[)/;
  const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const isTableStart = (line, next) => line.includes('|') && next !== undefined && next.includes('|') && TABLE_SEP_RE.test(next);
  const startsBlock = (line, next) => /^\s{0,3}#{1,6}\s/.test(line) || HR_RE.test(line) || /^\s*>/.test(line)
    || LIST_RE.test(line) || MATH_OPEN_RE.test(line) || FOOTNOTE_RE.test(line) || isTableStart(line, next);

  function dedent(lines) {
    const min = Math.min(...lines.filter((line) => line.trim()).map(indentOf));
    return lines.map((line) => line.replace(/\t/g, '    ').slice(Math.min(min, indentOf(line)))).join('\n');
  }

  function tableCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  }

  function renderTable(lines, start, notes) {
    const align = tableCells(lines[start + 1]).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left'));
    const row = (cells, tag) => `<tr>${cells.map((cell, c) => `<${tag} style="text-align:${align[c] || 'left'}">${renderInline(cell, notes)}</${tag}>`).join('')}</tr>`;
    let i = start + 2;
    const body = [];
    while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(row(tableCells(lines[i++]), 'td'));
    return [`<div class="table-wrap"><table><thead>${row(tableCells(lines[start]), 'th')}</thead><tbody>${body.join('')}</tbody></table></div>`, i];
  }

  function renderList(lines, start, notes) {
    const base = indentOf(lines[start]);
    const ordered = /\d/.test(lines[start].match(LIST_RE)[2]);
    const sibling = (line) => { const m = line.match(LIST_RE); return m && indentOf(line) === base && /\d/.test(m[2]) === ordered; };
    const items = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (sibling(line)) { items.push({ text: line.match(LIST_RE)[3], body: [] }); i += 1; continue; }
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (j < lines.length && (indentOf(lines[j]) > base || sibling(lines[j]))) { items[items.length - 1].body.push(''); i += 1; continue; }
        break;
      }
      if (indentOf(line) > base) { items[items.length - 1].body.push(line); i += 1; continue; }
      break;
    }
    const html = items.map(({ text, body }) => {
      const task = text.match(/^\[([ xX])\]\s+(.*)$/);
      const done = task && task[1] !== ' ';
      const head = task ? `<span class="task-box" aria-hidden="true"></span>${renderInline(task[2], notes)}` : renderInline(text, notes);
      const nested = body.some((line) => line.trim()) ? renderBlocks(dedent(body), notes) : '';
      return `<li${task ? ` class="task${done ? ' is-done' : ''}"` : ''}>${head}${nested}</li>`;
    }).join('');
    const number = ordered ? parseInt(lines[start].match(LIST_RE)[2], 10) : 1;
    const tag = ordered ? 'ol' : 'ul';
    return [`<${tag}${number !== 1 ? ` start="${number}"` : ''}>${html}</${tag}>`, i];
  }

  function renderBlocks(src, notes) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) { i += 1; continue; }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push(`<h${m[1].length}>${renderInline(m[2], notes)}</h${m[1].length}>`); i += 1; continue; }
      if (HR_RE.test(line)) { out.push('<hr>'); i += 1; continue; }
      if ((m = line.match(FOOTNOTE_RE))) { notes.defs.set(m[1], m[2]); i += 1; continue; }
      if ((m = line.match(MATH_OPEN_RE))) {
        const close = m[1] === '$$' ? '$$' : '\\]';
        const body = [];
        let rest = line.trim().slice(2);
        i += 1;
        while (!rest.includes(close) && i < lines.length) { body.push(rest); rest = lines[i]; i += 1; }
        body.push(rest.includes(close) ? rest.slice(0, rest.indexOf(close)) : rest);
        out.push(`<div class="math-block">${renderMath(body.join('\n'), true)}</div>`);
        continue;
      }
      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${renderBlocks(body.join('\n'), notes)}</blockquote>`);
        continue;
      }
      if (isTableStart(line, lines[i + 1])) { const [html, next] = renderTable(lines, i, notes); out.push(html); i = next; continue; }
      if (LIST_RE.test(line)) { const [html, next] = renderList(lines, i, notes); out.push(html); i = next; continue; }
      // Paragraph: single newlines stay line breaks, as in any chat.
      const para = [];
      while (i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
      const html = para.map((text) => renderInline(text, notes)).join('<br>');
      out.push(/^<details/i.test(html) ? html : `<p>${html}</p>`);
    }
    return out.join('');
  }

  function appendMarkdownHtml(frag, segment, notes) {
    if (!segment.trim()) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderBlocks(segment, notes);
    while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
  }

  // ---------- Syntax colouring: Shiki (media/vendor/shiki) with the editor's own theme ----------
  // The host sends the active colour theme as { type: 'editorTheme' }. Until both
  // it and the grammar bundle are ready, code stays plain text; then every block
  // on screen is coloured. Results are cached, so streaming re-renders stay cheap.
  let highlighter = null;
  let editorTheme = null;
  let editorThemeName = null;
  let themeVersion = 0;
  const highlightCache = new Map();
  const FONT_STYLE = [[1, 'font-style:italic'], [2, 'font-weight:600'], [4, 'text-decoration:underline']];

  function highlightInto(codeEl) {
    if (!highlighter || !editorThemeName) return;
    const code = codeEl.textContent;
    const key = `${codeEl.dataset.lang}\u0000${code}`;
    let html = highlightCache.get(key);
    if (html === undefined) {
      try {
        html = highlighter.codeToTokensBase(code, { lang: codeEl.dataset.lang, theme: editorThemeName })
          .map((line) => line.map((token) => {
            const style = [token.color && `color:${token.color}`, ...FONT_STYLE.filter(([bit]) => token.fontStyle > 0 && token.fontStyle & bit).map(([, css]) => css)].filter(Boolean).join(';');
            return style ? `<span style="${style}">${escapeHtml(token.content)}</span>` : escapeHtml(token.content);
          }).join(''))
          .join('\n');
      } catch { html = null; } // a language not in the bundle stays plain
      if (highlightCache.size > 300) highlightCache.clear();
      highlightCache.set(key, html);
    }
    if (html) codeEl.innerHTML = html;
  }

  async function applyEditorTheme() {
    if (!highlighter || !editorTheme) return;
    const name = `editor-${++themeVersion}`;
    await highlighter.loadTheme({ ...editorTheme, name });
    editorThemeName = name;
    highlightCache.clear();
    document.querySelectorAll('.code-block code[data-lang]').forEach((codeEl) => { codeEl.textContent = codeEl.textContent; highlightInto(codeEl); });
  }

  window.addEventListener('load', async () => {
    if (!window.createCodeHighlighter) return;
    try { highlighter = await window.createCodeHighlighter(); await applyEditorTheme(); } catch { highlighter = null; }
  });

  function buildCodeBlock(lang, code) {
    const block = document.createElement('div');
    block.className = 'code-block';

    const header = document.createElement('div');
    header.className = 'code-block-header';
    const langSpan = document.createElement('span');
    langSpan.textContent = lang || 'text';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-btn';
    copyBtn.innerHTML = COPY_ICON;
    copyBtn.title = 'Copy code';
    copyBtn.setAttribute('aria-label', 'Copy code');
    copyBtn.addEventListener('click', () => {
      const done = () => {
        copyBtn.innerHTML = CHECK_ICON;
        copyBtn.classList.add('copied');
        copyBtn.title = 'Copied';
        setTimeout(() => {
          copyBtn.innerHTML = COPY_ICON;
          copyBtn.classList.remove('copied');
          copyBtn.title = 'Copy code';
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done).catch(() => {});
      }
    });
    header.append(langSpan, copyBtn);

    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    if (lang) { codeEl.dataset.lang = lang.toLowerCase(); highlightInto(codeEl); }
    pre.appendChild(codeEl);

    block.append(header, pre);
    return block;
  }

  function buildMessageBody(text) {
    const frag = document.createDocumentFragment();
    const notes = { prefix: Math.random().toString(36).slice(2, 7), order: [], defs: new Map() };
    // An unclosed fence (still streaming) runs to the end as code instead of flashing raw backticks.
    const fenceRe = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
    let lastIndex = 0;
    let match;
    while ((match = fenceRe.exec(text)) && match[0]) {
      if (match.index > lastIndex) appendMarkdownHtml(frag, text.slice(lastIndex, match.index), notes);
      frag.appendChild(buildCodeBlock(match[1].trim().split(/\s+/)[0], match[2].replace(/\n$/, '')));
      lastIndex = fenceRe.lastIndex;
    }
    if (lastIndex < text.length) appendMarkdownHtml(frag, text.slice(lastIndex), notes);
    if (notes.defs.size) {
      const ids = [...notes.order, ...[...notes.defs.keys()].filter((id) => !notes.order.includes(id))];
      const section = document.createElement('section');
      section.className = 'footnotes';
      section.innerHTML = `<ol>${ids.filter((id) => notes.defs.has(id)).map((id) => `<li id="fn-${notes.prefix}-${escapeHtml(id)}">${renderInline(notes.defs.get(id), notes)}</li>`).join('')}</ol>`;
      frag.appendChild(section);
    }
    return frag;
  }

  // ---------- Agents viewer: Claude's subagents, apart from the reply ----------
  // The engine tags every subagent message with the call that spawned it; they collect here
  // instead of in the transcript. The robot chip counts the ones still working; its sheet
  // shows each one's task, reply and steps, and how long ago it last did anything.
  const AGENT_QUIET_MS = 90000; // a working agent silent this long reads as "quiet", worth a look
  const AGENT_STATUS = { running: 'Working', background: 'Working in the background', done: 'Done', failed: 'Failed', stopped: 'Stopped', ended: 'Ended with the session' };
  const agentsBtn = document.getElementById('agentsBtn');
  const agentsModal = createModal('agentsModal', 'Agents');
  agentsModal.body.classList.add('agents-body');
  agentsModal.body.innerHTML = '<div class="agents-tabs pill-track" role="tablist" aria-label="Agents"></div><div class="agents-pane" role="tabpanel"></div>';
  const agentTabs = agentsModal.body.querySelector('.agents-tabs');
  const agentPane = agentsModal.body.querySelector('.agents-pane');
  const subagents = new Map(); // tool_use id -> { id, description, subagentType, status, lastAt, events }
  let shownAgentId = null;
  let agentLog = null; // the shown agent's log: { el, bubble, cards }
  let agentsTicker = null;

  const agentWorking = (agent) => agent.status === 'running' || agent.status === 'background';
  function sinceText(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  }
  function agentState(agent) {
    if (!agentWorking(agent)) return { cls: `is-${agent.status}`, text: `${AGENT_STATUS[agent.status]} · ${sinceText(agent.lastAt)}` };
    const quiet = Date.now() - agent.lastAt > AGENT_QUIET_MS;
    return { cls: quiet ? 'is-quiet' : 'is-running', text: `${AGENT_STATUS[agent.status]} · last activity ${sinceText(agent.lastAt)}` };
  }
  // Its description, else the first line of its task (agents replayed without a start event).
  function agentName(agent) {
    const task = agent.events.find((e) => e.type === 'task')?.text || '';
    return agent.description || task.split('\n').find((line) => line.trim())?.trim().slice(0, 80) || agent.subagentType;
  }
  function agentFor(id, at) {
    if (!subagents.has(id)) subagents.set(id, { id, provider: 'claude', description: '', subagentType: 'agent', status: 'running', lastAt: at, events: [] });
    return subagents.get(id);
  }

  function applySubagent(message) {
    if (message.type === 'subagent_settle') { settleAgents(message.interrupted); return; } // a replayed turn end
    if (message.type === 'subagent_status' && !subagents.has(message.id)) return; // a status for an id no start event opened is not an agent
    const at = message.at || Date.now();
    const agent = agentFor(message.id, at);
    if (message.agent) agent.provider = message.agent;
    agent.lastAt = at;
    if (message.type === 'subagent_start') {
      Object.assign(agent, { description: message.description, subagentType: message.subagentType, status: 'running' });
      if (message.prompt && !agent.events.some((e) => e.type === 'task')) pushAgentEvent(agent, { type: 'task', text: message.prompt });
    } else if (message.type === 'subagent_event') {
      if (message.event.type !== 'task' || !agent.events.some((e) => e.type === 'task')) pushAgentEvent(agent, message.event);
    } else if (message.type === 'subagent_end') {
      agent.status = message.launched ? 'background' : message.error ? 'failed' : 'done';
    } else if (message.type === 'subagent_status') {
      const settled = { completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped', ended: 'ended' }[message.status];
      if (settled) agent.status = settled;
    }
    refreshAgents();
  }
  function pushAgentEvent(agent, event) {
    agent.events.push(event);
    if (agent.id === shownAgentId) renderAgentEvent(event, true);
  }
  // A turn that ends takes its foreground agents with it; background ones keep going.
  function settleAgents(interrupted) {
    for (const agent of subagents.values()) if (agent.status === 'running') agent.status = interrupted ? 'stopped' : 'done';
    refreshAgents();
  }
  function resetAgents() {
    subagents.clear();
    shownAgentId = null;
    delete agentTabs.dataset.shown;
    agentLog = null;
    agentPane.textContent = '';
    closeModal(agentsModal.el);
    refreshAgents();
  }

  // The host keeps subagent events in memory only, so a window reload used to hide the chip and
  // lose the history. Each chat's agents are also kept in the webview state and restored with the chat.
  const AGENT_SAVED_CHATS = 6;
  const AGENT_SAVED_EVENTS = 150;
  let agentsSaveTimer = null;
  function saveAgents() {
    if (agentsSaveTimer || !currentChatId || !subagents.size) return;
    agentsSaveTimer = setTimeout(() => {
      agentsSaveTimer = null;
      try {
        const state = vscode.getState() || {};
        const saved = { ...(state.agents || {}) };
        delete saved[currentChatId]; // re-added last, so it counts as the most recent
        saved[currentChatId] = [...subagents.values()].map((agent) => ({ ...agent, events: agent.events.slice(-AGENT_SAVED_EVENTS) }));
        for (const id of Object.keys(saved).slice(0, -AGENT_SAVED_CHATS)) delete saved[id];
        vscode.setState({ ...state, agents: saved });
      } catch {}
    }, 800);
  }
  // Whatever was still working when the window went away has ended with it.
  function restoreAgents() {
    let saved;
    try { saved = vscode.getState()?.agents?.[currentChatId]; } catch {}
    for (const agent of saved || []) {
      subagents.set(agent.id, { ...agent, status: agentWorking(agent) ? 'ended' : agent.status });
    }
    if (subagents.size) refreshAgents();
  }

  function refreshAgents() {
    const all = [...subagents.values()];
    const working = all.filter(agentWorking);
    agentsBtn.hidden = !all.length;
    saveAgents();
    agentsBtn.classList.toggle('is-idle', !working.length);
    agentsBtn.classList.toggle('is-quiet', working.some((agent) => agentState(agent).cls === 'is-quiet'));
    agentsBtn.querySelector('.agents-chip-count').textContent = String(working.length || all.length);
    const label = working.length ? `${working.length} ${working.length === 1 ? 'agent' : 'agents'} working` : `${all.length} ${all.length === 1 ? 'agent' : 'agents'} finished`;
    agentsBtn.title = `${label}: click to watch`;
    agentsBtn.setAttribute('aria-label', label);
    agentsModal.count.textContent = working.length ? `${working.length} working` : String(all.length);
    // The "last activity" clocks tick while anything works or the sheet is open.
    const tick = working.length || !agentsModal.el.hidden;
    if (tick && !agentsTicker) agentsTicker = setInterval(refreshAgents, 1000);
    if (!tick && agentsTicker) { clearInterval(agentsTicker); agentsTicker = null; }
    if (!agentsModal.el.hidden) renderAgentTabs();
  }

  // Five robot characters in the 16px line style. An agent's robot steps through the set by its
  // order (offset by the first agent's id), so up to five agents never share one; its colour is a
  // shade of its provider's (Claude orange, Antigravity blue, Codex purple), one shade per sibling.
  const BOTS = [
    '<rect x="3" y="5" width="10" height="8" rx="2.5"/><path d="M8 5V2.75M1.75 8.25v2M14.25 8.25v2"/><circle cx="8" cy="2.25" r="0.9" fill="currentColor"/><circle cx="6.1" cy="8.75" r="1" fill="currentColor"/><circle cx="9.9" cy="8.75" r="1" fill="currentColor"/>',
    '<rect x="2.5" y="4.5" width="11" height="8.5" rx="4"/><path d="M8 4.5V2M6 2h4"/><circle cx="8" cy="8.75" r="2.1"/><circle cx="8" cy="8.75" r="0.8" fill="currentColor"/>',
    '<path d="M3 13V9a5 5 0 0 1 10 0v4z"/><path d="M5.5 4.2 4.5 2M10.5 4.2 11.5 2M6.5 11.2h3"/><circle cx="6" cy="8.6" r="0.95" fill="currentColor"/><circle cx="10" cy="8.6" r="0.95" fill="currentColor"/>',
    '<rect x="3.5" y="4" width="9" height="9" rx="1.5"/><rect x="5" y="6" width="6" height="2.4" rx="1.2"/><path d="M8 4V2M6 10.5v1.75M8 10.5v1.75M10 10.5v1.75"/>',
    '<circle cx="8" cy="8.75" r="5.25"/><path d="M8 3.5V1.75M6 7.5v2M10 7.5v2M6.6 11.5q1.4 0.9 2.8 0"/>',
  ];
  const BOT_HUES = { claude: 24, gemini: 212, codex: 268 };
  const BOT_SHADES = [[0, 90, 60], [-8, 85, 72], [8, 95, 50], [-14, 80, 80], [14, 100, 66]]; // hue shift, saturation, lightness
  function paintBot(el, agent, stateCls) {
    const all = [...subagents.values()];
    const seed = [...String(all[0].id)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const index = (all.indexOf(agent) * 3 + seed) % BOTS.length;
    const [shift, sat, light] = BOT_SHADES[all.filter((a) => a.provider === agent.provider).indexOf(agent) % BOT_SHADES.length];
    const color = `hsl(${(BOT_HUES[agent.provider] ?? BOT_HUES.claude) + shift} ${sat}% ${light}%)`;
    // Swapped only when it changes, so the running bob isn't restarted by the once-a-second refresh.
    if (el.dataset.bot !== String(index)) { el.dataset.bot = index; el.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BOTS[index]}</svg>`; }
    el.className = `agents-bot ${stateCls}`;
    el.style.setProperty('--bot', color);
    return color;
  }

  // Tabs run newest activity first (ties: newest agent first), so the latest one is never off-screen.
  // Robots and shades follow creation order instead, so an agent keeps its look as the tabs reorder.
  const agentsByRecent = () => [...subagents.values()].reverse().sort((a, b) => b.lastAt - a.lastAt);

  // A wheel over the strip scrolls it sideways; the scrollbar is hidden.
  agentTabs.addEventListener('wheel', (event) => {
    if (event.deltaX || !event.deltaY) return;
    agentTabs.scrollLeft += event.deltaY;
    event.preventDefault();
  }, { passive: false });

  function renderAgentTabs() {
    const all = agentsByRecent();
    while (agentTabs.children.length < all.length) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'agents-tab';
      tab.setAttribute('role', 'tab');
      tab.innerHTML = '<span class="agents-bot"></span><span class="agents-tab-name"></span>';
      tab.addEventListener('click', () => showAgent(tab.dataset.id));
      agentTabs.appendChild(tab);
    }
    while (agentTabs.children.length > all.length) agentTabs.lastChild.remove();
    all.forEach((agent, index) => {
      const tab = agentTabs.children[index];
      const state = agentState(agent);
      tab.dataset.id = agent.id;
      tab.setAttribute('aria-selected', String(agent.id === shownAgentId));
      if (agent.id === shownAgentId && agentTabs.dataset.shown !== agent.id) { agentTabs.dataset.shown = agent.id; tab.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }
      tab.title = state.text;
      const color = paintBot(tab.querySelector('.agents-bot'), agent, state.cls);
      if (agent.id === shownAgentId) agentTabs.style.setProperty('--pill-tint', color); // the sliding pill takes the shown agent's colour
      tab.querySelector('.agents-tab-name').textContent = agentName(agent);
    });
    const shown = subagents.get(shownAgentId);
    const head = agentPane.querySelector('.agents-head');
    if (shown && head) {
      const state = agentState(shown);
      paintBot(head.querySelector('.agents-bot'), shown, state.cls);
      head.querySelector('.agents-status').textContent = state.text;
      const steps = shown.events.filter((e) => e.type === 'tool_start').length;
      head.querySelector('.agents-steps').textContent = `${steps} ${steps === 1 ? 'step' : 'steps'}`;
    }
  }

  function showAgent(id) {
    const agent = subagents.get(id);
    if (!agent) return;
    shownAgentId = id;
    agentPane.textContent = '';
    const head = document.createElement('div');
    head.className = 'agents-head';
    head.innerHTML = '<span class="agents-bot"></span><span class="agents-type"></span><span class="agents-status"></span><span class="agents-steps"></span>';
    head.querySelector('.agents-type').textContent = agent.subagentType;
    // The tab truncates its name; here it reads in full.
    const title = document.createElement('div');
    title.className = 'agents-title';
    title.textContent = agentName(agent);
    const log = document.createElement('div');
    log.className = 'agents-log';
    agentPane.append(title, head, log);
    agentLog = { el: log, bubble: null, cards: new Map() };
    for (const event of agent.events) renderAgentEvent(event, false);
    log.scrollTop = log.scrollHeight;
    renderAgentTabs();
  }

  function renderAgentEvent(event, follow) {
    if (!agentLog) return;
    const log = agentLog.el;
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    if (event.type === 'task') {
      const task = document.createElement('div');
      task.className = 'agents-task';
      const label = document.createElement('div');
      label.className = 'agents-task-label';
      label.textContent = 'Task';
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.appendChild(buildMessageBody(event.text || ''));
      task.append(label, body);
      log.appendChild(task);
    } else if (event.type === 'delta' && event.text) {
      // Text blocks in a row read as one reply; a step in between starts a new one.
      if (!agentLog.bubble || log.lastElementChild !== agentLog.bubble) {
        agentLog.bubble = document.createElement('div');
        agentLog.bubble.className = 'msg msg-assistant';
        agentLog.bubble.dataset.raw = '';
        agentLog.bubble.innerHTML = '<div class="msg-body"></div>';
        log.appendChild(agentLog.bubble);
      }
      const bubble = agentLog.bubble;
      bubble.dataset.raw += (bubble.dataset.raw ? '\n\n' : '') + event.text.trim();
      const body = bubble.querySelector('.msg-body');
      body.textContent = '';
      body.appendChild(buildMessageBody(bubble.dataset.raw));
    } else if (event.type === 'thought' && event.text) {
      const thought = document.createElement('details');
      thought.className = 'agents-thought';
      thought.innerHTML = '<summary>Thinking</summary><div class="agents-thought-text"></div>';
      thought.querySelector('.agents-thought-text').textContent = event.text;
      log.appendChild(thought);
    } else if (event.type === 'tool_start') {
      const command = event.command || event.file;
      const card = appendToolCard({ name: event.name, command, output: { text: '' }, done: event.done, diff: event.diff, host: log });
      // The summary line truncates; opening the step shows the whole command above its output.
      if (command) {
        const full = document.createElement('div');
        full.className = 'agents-tool-command';
        full.textContent = command;
        card.insertBefore(full, card.querySelector('.tool-body'));
      }
      if (event.toolId) agentLog.cards.set(event.toolId, card);
    } else if (event.type === 'tool_end') {
      finishToolCard(agentLog.cards.get(event.toolId), { output: event.output, error: event.error });
    }
    if (follow && pinned) log.scrollTop = log.scrollHeight;
  }

  agentsBtn.addEventListener('click', () => {
    const all = agentsByRecent();
    if (!subagents.has(shownAgentId)) shownAgentId = (all.find(agentWorking) || all[0])?.id || null;
    openModal(agentsModal);
    if (shownAgentId) showAgent(shownAgentId);
    refreshAgents();
  });

  // ---------- Transcript ----------

  function clearEmptyState() {
    emptyMascot?.dispose();
    emptyMascot = null;
    const empty = transcriptEl.querySelector('.empty-state');
    if (empty) empty.remove();
  }
  // Clanker's interactive rig lives only in the empty state; launching never delays the chat stream.
  function emptyState() {
    emptyMascot?.dispose();
    const el = document.createElement('div');
    el.className = 'empty-state';
    el.innerHTML = `<div class="empty-mark"></div>
      <h2 class="empty-title">What are we working on?</h2>
      <p class="empty-lead">Claude, Codex and Gemini share this chat. Pick a model below, or leave it on Auto.</p>
      <ul class="empty-tips"><li><button type="button" data-mascot-action="mention"><kbd>@</kbd>mention a file</button></li><li><button type="button" data-mascot-action="action"><kbd>/</kbd>run an action</button></li><li><button type="button" data-mascot-action="image"><kbd>+</kbd>attach an image</button></li></ul>`;
    emptyMascot = window.createClankerMascot({ root: el, input: promptInput, modelPicker: modelPickerBtn, attach: attachBtn, mic: micBtn, transcript: transcriptEl });
    return el;
  }
  transcriptEl.querySelector('.empty-state')?.replaceWith(emptyState());

  // P17-E: streaming output only follows the tail while the reader is already
  // there; scrolling up to read earlier output is never yanked back down.
  // Only an upward scroll that ends away from the bottom lets go of the tail;
  // a burst of output landing between our scroll and its scroll event never does.
  let stickToEnd = true;
  let lastScrollTop = 0;
  function isTranscriptNearBottom(threshold = 80) {
    return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight <= threshold;
  }
  function updateTranscriptFade() {
    const top = transcriptEl.scrollTop;
    if (top <= 1) {
      transcriptEl.classList.remove('has-fade');
      transcriptEl.style.setProperty('--fade', '0px');
    } else {
      const px = Math.min(100, Math.max(0, Math.round((top / 60) * 100)));
      transcriptEl.style.setProperty('--fade', `${px}px`);
      transcriptEl.classList.add('has-fade');
    }
  }
  transcriptEl.addEventListener('scroll', () => {
    updateTranscriptFade();
    const top = transcriptEl.scrollTop;
    if (isTranscriptNearBottom()) stickToEnd = true;
    else if (top < lastScrollTop) stickToEnd = false;
    lastScrollTop = top;
  }, { passive: true });
  function scrollTranscriptToEnd(force = false) {
    if (!force && !stickToEnd) return;
    stickToEnd = true;
    requestAnimationFrame(() => {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      updateTranscriptFade();
    });
  }
  // P17-N: content that grows after the scroll (code highlighting, KaTeX,
  // images decoding, a turn collapsing) re-pins the tail while stuck to it.
  const pinToEnd = new ResizeObserver(() => {
    if (stickToEnd) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      updateTranscriptFade();
    }
  });
  const observeTail = () => {
    pinToEnd.disconnect();
    pinToEnd.observe(transcriptEl); // the composer growing shrinks the viewport too
    for (const el of transcriptEl.children) pinToEnd.observe(el);
  };
  observeTail();
  new MutationObserver(observeTail).observe(transcriptEl, { childList: true });
  updateTranscriptFade();
  // A tool card opened at the tail keeps the tail in view; anywhere else,
  // CSS overflow-anchor holds the viewport steady. (`toggle` doesn't bubble.)
  transcriptEl.addEventListener('toggle', (event) => {
    if (event.target.matches?.('.tool-card') && event.target.open && stickToEnd) scrollTranscriptToEnd(true);
  }, true);

  // ---------- Message actions: time, copy, revert ----------
  const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 3.5 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const REVERT_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 3 2.5 6l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 6h6.75a4 4 0 0 1 0 8H7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const REPLY_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

  function formatTime(at) {
    const date = at ? new Date(at) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString(TIME_PREFS.locale, clockParts()) : '';
  }

  function iconAction(icon, label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-action';
    btn.innerHTML = icon;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => onClick(btn));
    return btn;
  }

  function copyText(btn, text) {
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_ICON; }, 1400);
    }, () => showToast('Could not copy to the clipboard.', { error: true }));
  }

  function messageActions(at, getText, extra = []) {
    const row = document.createElement('div');
    row.className = 'msg-actions';
    const time = document.createElement('time');
    time.className = 'msg-time';
    time.textContent = formatTime(at);
    if (at) time.dateTime = new Date(at).toISOString();
    row.append(time);
    row.append(iconAction(COPY_ICON, 'Copy', (btn) => copyText(btn, getText())), ...extra);
    return row;
  }

  // The droid's voice (aiChatPanel.droidSounds): pitch-bent triangle waves, 600-2400 Hz. A rising chirp for done,
  // a low falling warble for an error. Nothing is loaded; the notes are drawn here.
  let droidAudio = null;
  function playDroid(kind) {
    try {
      droidAudio = droidAudio || new AudioContext();
      if (droidAudio.state === 'suspended') droidAudio.resume();
      // [from Hz, to Hz, start s, length s]
      const notes = kind === 'warn' ? [[520, 380, 0, 0.16], [440, 300, 0.14, 0.16], [380, 240, 0.28, 0.22]] : [[900, 1300, 0, 0.09], [1200, 1800, 0.1, 0.09], [1700, 2400, 0.2, 0.16]];
      const now = droidAudio.currentTime;
      for (const [from, to, start, length] of notes) {
        const osc = droidAudio.createOscillator();
        const gain = droidAudio.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(from, now + start);
        osc.frequency.exponentialRampToValueAtTime(to, now + start + length);
        gain.gain.setValueAtTime(0.0001, now + start);
        gain.gain.exponentialRampToValueAtTime(0.07, now + start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
        osc.connect(gain).connect(droidAudio.destination);
        osc.start(now + start);
        osc.stop(now + start + length + 0.02);
      }
    } catch { /* no audio device: silence is fine */ }
  }

  // Undo turn: the last reply gets one more action when its turn changed files (lib/turn-undo.js; /undo does the same).
  const UNDO_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3 2.75v2.5h2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function dropUndo() { transcriptEl.querySelectorAll('.undo-action').forEach((el) => el.remove()); }
  function offerUndo(count) {
    dropUndo();
    const turn = count ? transcriptEl.lastElementChild : null; // the latest turn only, even when it ended in tools with no reply text
    if (!turn) return;
    let row = [...turn.querySelectorAll('.msg-assistant .msg-actions')].pop();
    if (!row) { row = document.createElement('div'); row.className = 'msg-actions'; turn.append(row); }
    const label = `${count} file${count === 1 ? '' : 's'}`;
    const undo = iconAction(UNDO_ICON, `Undo this turn: ${label} go back to how they were before it`, () => vscode.postMessage({ type: 'undoTurn' }));
    undo.classList.add('undo-action');
    undo.append(`Undo · ${label}`); // labelled: an icon alone hid the one action that matters after a bad turn
    row.append(undo);
  }

  // Your message: hovering shows time, Copy, and Revert. Revert forks the
  // chat just before this message and puts the message back in the composer.
  // The goo that fuses your bubble and its dock: blur, sharpen the alpha into one
  // liquid silhouette, then draw the untouched original back on top (text stays crisp).
  document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><filter id="msg-goo" x="-10%" y="-10%" width="120%" height="130%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/><feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo"/><feComposite in="SourceGraphic" in2="goo" operator="atop"/></filter><filter id="tip-goo" filterUnits="userSpaceOnUse" x="-320" y="-40" width="420" height="140" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/><feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo"/><feComposite in="SourceGraphic" in2="goo" operator="atop"/></filter></svg>'); // tip-goo: same goo, a wide fixed region for a tag hanging off a 32px button

  // P17-K: a prompt longer than three lines clamps behind a fade with a Show more / Show less toggle.
  function clampUserBubble(bubble, body, actions) {
    const line = parseFloat(getComputedStyle(body).lineHeight) || 20;
    if (body.scrollHeight <= line * 3 + 4) return;
    bubble.classList.add('is-clamped');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'msg-action msg-clamp-toggle';
    toggle.textContent = 'Show more';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      const expanded = bubble.classList.toggle('is-expanded');
      toggle.textContent = expanded ? 'Show less' : 'Show more';
      toggle.setAttribute('aria-expanded', String(expanded));
    });
    actions.querySelector('.msg-time').after(toggle);
  }

  function appendUserMessage(text, at = new Date().toISOString(), files = [], { scheduled = false } = {}) {
    clearEmptyState();
    const group = document.createElement('div');
    group.className = 'msg-group msg-group-user';
    // Sent by the scheduler, not typed just now: the same bubble, with a quiet clock tag above it.
    if (scheduled) {
      const tag = document.createElement('div');
      tag.className = 'msg-scheduled-tag';
      tag.innerHTML = CLOCK_SVG;
      tag.append('Scheduled');
      group.appendChild(tag);
    }
    const bubble = document.createElement('div');
    bubble.className = 'msg msg-user';
    if (files?.length) {
      const strip = document.createElement('div');
      strip.className = 'attachment-strip msg-attachments';
      strip.append(...files.map((file) => attachmentChip(file)));
      bubble.appendChild(strip);
    }
    const body = document.createElement('div');
    body.className = 'msg-user-text';
    body.appendChild(buildMessageBody(text));
    bubble.appendChild(body);
    const index = transcriptEl.querySelectorAll('.msg-group-user').length; // nth user message = its place in the stored chat
    const revert = iconAction(REVERT_ICON, 'Revert to here (forks the chat, message goes back to the composer)', () => vscode.postMessage({ type: 'revertToMessage', index }));
    const actions = messageActions(at, () => text, [revert]);
    group.append(bubble, actions);
    const turn = document.createElement('div');
    turn.className = 'turn';
    turn.appendChild(group);
    transcriptEl.appendChild(turn); // always top level, never inside the previous turn
    clampUserBubble(bubble, body, actions);
    currentTurnEl = turn;
    turnAnchor = group;
    turnStartedAt = Date.now();
    currentAssistantBubble = null;
    scrollTranscriptToEnd(true);
  }

  // The auto-assigned role, as one quiet line in the reply header instead of the
  // paragraph the agent used to write about it. The tooltip says how to override it.
  const ROLE_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  function roleChip(roleName) {
    const chip = document.createElement('span');
    chip.className = 'msg-role-chip';
    chip.title = 'Assigned automatically on this agent’s first turn in this chat. To work outside it, just say so in your message.';
    chip.append('Role: ' + roleName);
    chip.insertAdjacentHTML('beforeend', ROLE_ICON);
    return chip;
  }

  function appendAssistantDelta(textChunk, model, label = null, roleName = null) {
    if (!textChunk) return;
    clearEmptyState();
    // Text that arrives after a tool/approval/question card continues in a
    // new bubble BELOW that card, never back up in the one above it.
    const continued = currentAssistantBubble && turnHost().lastElementChild !== currentAssistantBubble;
    if (continued) {
      currentAssistantBubble = null;
      textChunk = textChunk.replace(/^\s+/, '');
      if (!textChunk) return;
    }
    if (!currentAssistantBubble) {
      foldSteps();
      currentAssistantBubble = document.createElement('div');
      currentAssistantBubble.className = `msg msg-assistant${continued ? ' msg-continued' : ''}`;
      currentAssistantBubble.dataset.raw = '';
      if (model && !continued) {
        const roleLabel = document.createElement('div');
        roleLabel.className = 'msg-role';
        roleLabel.dataset.agent = model;
        roleLabel.innerHTML = AGENT_ICONS[model] || '';
        roleLabel.append(label || REPLY_NAMES[model] || model); // the exact model, e.g. "GPT 6 Sol High"
        if (roleName) roleLabel.append(roleChip(roleName));
        currentAssistantBubble.appendChild(roleLabel);
      }
      const body = document.createElement('div');
      body.className = 'msg-body';
      currentAssistantBubble.appendChild(body);
      turnHost().appendChild(currentAssistantBubble);
      turnBubbles.push(currentAssistantBubble);
    }
    currentAssistantBubble.dataset.raw += textChunk;
    const body = currentAssistantBubble.querySelector('.msg-body');
    body.innerHTML = '';
    body.appendChild(buildMessageBody(currentAssistantBubble.dataset.raw));
    scrollTranscriptToEnd();
  }

  // A reply can span several bubbles (text, tool card, more text). The last one
  // is the answer: it gets the footer, and Copy takes just that text.
  let turnBubbles = [];
  let turnRoleName = null; // set only on the turn that handed this agent its role
  let turnModelLabel = null; // the running turn's model, from the host's routing message
  // "You've hit your usage limit" (Claude, Codex) / quota exhausted (Gemini): the turn stopped because
  // the plan ran out, so offer to send "continue" into this chat once that agent's limit resets.
  // Claude: "You've hit your session limit"; Codex: "You've hit your usage limit"; Gemini: "Quota exceeded" /
  // "You have exhausted your daily quota" / RESOURCE_EXHAUSTED.
  let limitHitThisTurn = false; // an upstream_error card already said so
  let restoringHistory = false; // old limit replies in a restored transcript get no button; only the last may
  function offerContinueAtReset(host) {
    const agent = turnRoutedAgent || lastReplyAgent(); // routing can be missed (reload mid-turn): the reply's own label
    if (!host || !AGENT_IDS.includes(agent) || host.querySelector('.continue-at-reset')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'continue-at-reset';
    btn.dataset.resetAgent = agent; // removed again once this provider's usage is back
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.2"/></svg><span>Continue when ${AGENT_LABELS[agent] || agent} resets</span>`;
    btn.title = 'Sends "continue" into this chat automatically once the usage limit resets';
    btn.addEventListener('click', () => {
      pendingScheduleLabel = AGENT_LABELS[agent];
      vscode.postMessage({ type: 'scheduleTask', task: { model: agent, prompt: 'continue', dispatchTrigger: 'quota-reset', resumeHere: true }, attachments: [] });
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Scheduled: "continue" sends when the limit resets';
    }, { once: true });
    host.append(btn);
  }

  function endAssistantTurn(at = new Date().toISOString()) {
    const last = turnBubbles[turnBubbles.length - 1];
    if (last && !last.querySelector('.msg-actions')) last.append(messageActions(at, () => last.dataset.raw.trim(), []));
    const limitHit = limitHitThisTurn || isLimitNotice(last?.dataset.raw);
    const replied = turnRoutedAgent || lastReplyAgent();
    // Only when there is something to continue (the turn was cut off by the limit) and a reason to
    // wait: the usage display doesn't show headroom for that provider.
    if (!restoringHistory && limitHit && !hasHeadroom(replied)) offerContinueAtReset(last || turnHost());
    // The model's own answer is the freshest word on its usage: a limit reply turns scheduling on, a normal one off.
    if (!restoringHistory && AGENT_IDS.includes(replied)) {
      if (limitHit) limitHitAgents.add(replied); else limitHitAgents.delete(replied);
      refreshScheduleDefault();
    }
    limitHitThisTurn = false;
    turnBubbles = [];
    currentAssistantBubble = null;
  }

  // ---------- "Worked for 4m 12s": a finished turn folds its steps away ----------
  // While a turn runs, its tool cards and in-between text stream in as usual.
  // When it ends, everything between your message and the answer moves into
  // one collapsed row; clicking it shows the steps again.
  let turnAnchor = null; // the user message that started the running turn
  let turnStartedAt = 0;
  const CHEVRON = '<svg class="work-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function formatDuration(ms) {
    const total = Math.max(1, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m${s ? ` ${s}s` : ''}` : `${s}s`;
  }

  function workSummary(label, steps = []) {
    const block = document.createElement('details');
    block.className = `work-summary${steps.length ? '' : ' is-empty'}`;
    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="work-label"></span>${steps.length ? CHEVRON : ''}`;
    summary.firstChild.textContent = label;
    if (!steps.length) summary.tabIndex = -1;
    const body = document.createElement('div');
    body.className = 'work-steps';
    body.append(...steps);
    block.append(summary, body);
    return block;
  }

  // Steps stay in order with the reply text: the tool calls (and thinking,
  // approvals, questions) since the last text fold into one "N steps" row the
  // moment new text arrives, and once more when the turn ends.
  const STEP = '.tool-card, .thought-fold, .approval-card, .question-card';
  function foldSteps(host = turnHost()) {
    const steps = [];
    for (let el = host.lastElementChild; el; el = el.previousElementSibling) {
      if (el === pendingEl) continue;
      if (!el.matches(STEP) || el.matches('.is-running')) break;
      steps.unshift(el);
    }
    // A card still waiting on your click never folds away.
    const waiting = new Set(pendingCards.values());
    if (!steps.length || steps.some((el) => waiting.has(el))) return;
    const next = steps[steps.length - 1].nextElementSibling;
    host.insertBefore(workSummary(`${steps.length} step${steps.length === 1 ? '' : 's'}`, steps), next);
  }

  function collapseTurn(anchor, ms) {
    if (!anchor?.isConnected) return;
    const turn = anchor.closest('.turn');
    if (turn) {
      turn.classList.add('is-done');
      turn.dataset.agent ||= turn.querySelector('.msg-role')?.dataset.agent || '';
      if (turn === currentTurnEl) currentTurnEl = null;
    }
    foldSteps(anchor.parentElement);
    if (ms > 0) anchor.after(workSummary(`Worked for ${formatDuration(ms)}`));
  }

  // Tool cards, matched to their result by toolId (Claude tool_use id, Codex
  // item id, agy step) so parallel or interleaved tools never cross wires.
  const toolCards = new Map();
  const SHELL_TOOLS = /^(bash|powershell|shell|run_command|command_execution)$/i;
  const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|write_to_file|(multi_)?replace_file_content|file_change|edit_file|create_file)$/i;
  const READ_TOOLS = /^(read|view_file|view|list_dir|view_content|read_file)$/i;
  const SEARCH_TOOLS = /^(glob|grep|grep_search|find_by_name|search_in_file|find_file)$/i;
  const WEB_TOOLS = /^(web_?(fetch|search)|search_?web|read_?url_?content|read_?browser_?page|browser_?page)$/i;
  const TASK_TOOLS = /^(manage_?task)$/i;
  const AGENT_TOOLS = /^(agent|task|invoke_?subagent|manage_?subagents|define_?subagent)$/i;

  function toolKind(name) {
    const raw = String(name || '').trim();
    if (TASK_TOOLS.test(raw)) return 'task';
    if (SHELL_TOOLS.test(raw)) return 'shell';
    if (EDIT_TOOLS.test(raw)) return 'edit';
    if (READ_TOOLS.test(raw)) return 'read';
    if (WEB_TOOLS.test(raw)) return 'web';
    if (SEARCH_TOOLS.test(raw)) return 'search';
    if (AGENT_TOOLS.test(raw)) return 'agent';
    // The rarer tools each get a glyph; anything still unknown keeps the clock.
    for (const [kind, pattern] of TOOL_PATTERNS) if (pattern.test(raw)) return kind;
    return 'other';
  }
  const TOOL_PATTERNS = [
    ['task', /^(manage_?task)$/i],
    ['handback', /^subagent_?handback$/i],
    ['message', /^(send_?message|push_?notification)$/i],
    ['web', /^(web_?(fetch|search)|search_?web|read_?url_?content|read_?browser_?page|browser_?page)$/i],
    ['image', /^(generate_?image|image_?generate)$/i],
    ['question', /^(ask_?question|ask_?user_?question|ask_?followup_?question)$/i],
    ['todo', /^(todowrite|task(create|update|list|get)|update_plan)$/i],
    ['plan', /^(enter|exit)planmode$/i],
    ['skill', /^skill$/i],
    ['schedule', /^(schedule|cron(create|delete|list)|schedulewakeup)$/i],
    ['monitor', /^(monitor|bashoutput|taskoutput)$/i],
    ['stop', /^(taskstop|killshell|kill_bash)$/i],
    ['plug', /^(mcp__|toolsearch$|listmcpresources$|readmcpresource$)/i],
    ['worktree', /^(enter|exit)worktree$/i],
    ['remote', /^remotetrigger$/i],
  ];

  function toolDisplayName(name, kind) {
    const raw = String(name || '').trim();
    const clean = raw.toLowerCase().replace(/[-_]/g, '');

    if (kind === 'shell') return 'Run';
    if (kind === 'edit') return 'Edit';
    if (kind === 'read' || /^(viewfile|readfile|view|read|listdir|viewcontent)$/i.test(clean)) return 'View';
    if (/^(searchweb|websearch)$/i.test(clean)) return 'Web Search';
    if (/^(readurlcontent|webfetch)$/i.test(clean)) return 'Web Fetch';
    if (/^(readbrowserpage|browserpage)$/i.test(clean)) return 'Browser';
    if (/^(managetask)$/i.test(clean)) return 'ManageTask';
    if (/^(managesubagents)$/i.test(clean)) return 'ManageSubagents';
    if (/^(definesubagent)$/i.test(clean)) return 'DefineSubagent';
    if (/^(invokesubagent)$/i.test(clean)) return 'Subagent';
    if (/^(sendmessage|pushnotification)$/i.test(clean)) return 'Message';
    if (/^(subagenthandback|handback)$/i.test(clean)) return 'Handback';
    if (/^(generateimage|imagegenerate)$/i.test(clean)) return 'Image';
    if (/^(askquestion|askuserquestion|askfollowupquestion)$/i.test(clean)) return 'Question';
    if (/^(schedule|schedulewakeup|croncreate|crondelete|cronlist)$/i.test(clean)) return 'Schedule';
    if (/^(grepsearch|searchinfile|grep)$/i.test(clean)) return 'Grep';
    if (/^(findbyname|findfile|glob)$/i.test(clean)) return 'Glob';
    if (/^(todowrite|taskcreate|taskupdate|tasklist|taskget|updateplan)$/i.test(clean)) return 'Todo';
    if (/^(enterplanmode|exitplanmode)$/i.test(clean)) return 'Plan';
    if (/^(skill)$/i.test(clean)) return 'Skill';
    if (/^(monitor|bashoutput|taskoutput)$/i.test(clean)) return 'Monitor';
    if (/^(taskstop|killshell|killbash)$/i.test(clean)) return 'Stop';
    if (/^(enterworktree|exitworktree)$/i.test(clean)) return 'Worktree';
    if (/^(remotetrigger)$/i.test(clean)) return 'Remote';
    if (/^mcp__/i.test(raw)) return raw.replace(/^mcp__/, '');
    if (raw.includes('_') || raw.includes('-')) {
      return raw.split(/[-_]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
    return raw || 'Tool';
  }

  const lineIcon = (body) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const TOOL_ICONS = {
    shell: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5 6.5 8 3 11.5M8 11.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: PENCIL_SVG,
    search: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.5"/><path d="m10.2 10.2 3.3 3.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    read: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 8S4.25 3.5 8 3.5 14.25 8 14.25 8 11.75 12.5 8 12.5 1.75 8 1.75 8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/></svg>',
    task: lineIcon('<rect x="3" y="3" width="10" height="10.5" rx="1.5"/><path d="M6 1.75h4v2.5H6z"/><path d="m5.5 8 1.8 1.8 3.2-3.2"/>'),
    other: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 5.5v3l2 1.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    // The composer's agents chip robot (extension.js #agentsBtn), so the step and the chip read as one thing.
    agent: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5V2.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="2.25" r="0.9" fill="currentColor"/><circle cx="6.1" cy="8.75" r="1" fill="currentColor"/><circle cx="9.9" cy="8.75" r="1" fill="currentColor"/><path d="M1.75 8.25v2M14.25 8.25v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    handback: lineIcon('<path d="M6.25 3.75 2.5 7.5l3.75 3.75"/><path d="M2.5 7.5h6.75a4.25 4.25 0 0 1 4.25 4.25v.75"/>'), // a reply arrow: the subagent's answer coming back
    message: lineIcon('<path d="M14 2 2 6.8l4.6 2 2 4.6z"/><path d="M6.6 8.8 14 2"/>'),
    web: lineIcon('<circle cx="8" cy="8" r="5.5"/><ellipse cx="8" cy="8" rx="2.4" ry="5.5"/><path d="M2.5 8h11"/>'),
    image: lineIcon('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="5.75" cy="5.75" r="1.25"/><path d="m13.5 11-3.5-3.5-5.5 5.5"/>'),
    question: lineIcon('<circle cx="8" cy="8" r="5.5"/><path d="M6.5 6.25a1.5 1.5 0 0 1 2.8.75c0 1-1.3 1.5-1.3 2.5M8 12.25v.1"/>'),
    todo: lineIcon('<path d="m2.5 4.5 1.2 1.2 2-2.4M2.5 10.5l1.2 1.2 2-2.4M8 5h5.5M8 11h5.5"/>'),
    plan: lineIcon('<rect x="3.5" y="3" width="9" height="10.5" rx="1.5"/><rect x="6" y="1.75" width="4" height="2.5" rx="0.8"/><path d="M6 8h4M6 10.5h2.5"/>'),
    skill: lineIcon('<path d="M8 2c.4 3 1.4 4.6 6 6-4.6 1.4-5.6 3-6 6-.4-3-1.4-4.6-6-6 4.6-1.4 5.6-3 6-6z"/>'),
    schedule: lineIcon('<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>'),
    monitor: lineIcon('<path d="M1.75 8h3l1.5-4 3 8 1.5-4h3.5"/>'),
    stop: lineIcon('<circle cx="8" cy="8" r="5.5"/><rect x="6" y="6" width="4" height="4" rx="0.8" fill="currentColor"/>'),
    plug: lineIcon('<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7V8a3.5 3.5 0 0 1-7 0zM8 11.5V14"/>'),
    worktree: lineIcon('<circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="6" r="1.5"/><path d="M4.5 5.5v5M11.5 7.5c0 2.5-3 2-7 3.5"/>'),
    remote: lineIcon('<path d="M9 2 3.5 9H7.5L7 14l5.5-7h-4z"/>'),
  };
  // `host`: where the card goes (the agents viewer passes its own pane); default, the running turn.
  function appendToolCard({ name, command, output, toolId, done, error, diff, host = null }) {
    if (!host) clearEmptyState();
    const kind = toolKind(name);
    // An edit's own "-"/"+" lines become its body and its +N -N count.
    const diffLines = kind === 'edit' && diff ? diff.split('\n') : null;
    if (diffLines) output = { ...output, added: diffLines.filter((l) => l[0] === '+').length, removed: diffLines.filter((l) => l[0] === '-').length };
    const details = document.createElement('details');
    details.className = `tool-card tool-${kind}${done ? '' : ' is-running'}${error ? ' is-error' : ''}`;

    const summary = document.createElement('summary');
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.innerHTML = TOOL_ICONS[kind] || TOOL_ICONS.other;
    const tool = document.createElement('span');
    tool.className = 'tool-name';
    tool.textContent = toolDisplayName(name, kind);
    const label = document.createElement('span');
    label.className = 'tool-label';
    label.title = command || '';
    // A file path reads like the Explorer: the name up front, its folder dimmed after it.
    const isPath = (kind === 'read' || kind === 'edit') && typeof command === 'string' && !command.includes('\n') && (
      /^[^\s"]+$/.test(command) || /^(?:[a-zA-Z]:[\\/]|[\\/]|(?:\.\.?[\\/])|[\w.-]+[\\/])/.test(command.trim())
    );
    const path = isPath ? command.trim().match(/^(.*[\\/])?([^\\/]+)$/) : null;
    if (path) {
      label.classList.add('is-path');
      const file = document.createElement('span');
      file.className = 'tool-file';
      file.textContent = path[2];
      const dir = document.createElement('span');
      dir.className = 'tool-dir';
      dir.textContent = (path[1] || '').replace(/[\\/]$/, '');
      label.append(file, dir);
    } else {
      label.textContent = command || '';
    }
    const meta = document.createElement('span');
    meta.className = 'tool-meta';
    const state = document.createElement('span');
    state.className = 'tool-state';
    summary.append(icon, tool, label, meta, state);

    if (output && (typeof output.added === 'number' || typeof output.removed === 'number')) {
      const stat = document.createElement('span');
      stat.className = 'diff-stat';
      const add = document.createElement('span');
      add.className = 'diff-add';
      add.textContent = `+${output.added || 0}`;
      const del = document.createElement('span');
      del.className = 'diff-del';
      del.textContent = `-${output.removed || 0}`;
      stat.append(add, del);
      summary.appendChild(stat);
    }
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'tool-body';
    if (diffLines) {
      details.dataset.diff = '1';
      body.classList.add('is-diff');
      for (const line of diffLines) {
        const row = document.createElement('div');
        row.className = line[0] === '+' ? 'diff-line diff-add' : line[0] === '-' ? 'diff-line diff-del' : 'diff-line';
        row.textContent = line;
        body.appendChild(row);
      }
    } else {
      body.textContent = (output && output.text) || '';
    }
    details.appendChild(body);
    if (host) { host.appendChild(details); return details; }
    turnHost().appendChild(details);
    if (toolId) toolCards.set(toolId, details);
    scrollTranscriptToEnd();
    return details;
  }
  function finishToolCard(card, { output, error }) {
    if (!card) return;
    card.classList.remove('is-running');
    card.classList.toggle('is-error', Boolean(error));
    const body = card.querySelector('.tool-body');
    // A diff card keeps its diff; only a failure replaces it with the reason.
    if (body && (!card.dataset.diff || (error && output))) body.textContent = output || '';
    // What came back, at a glance: lines read, results found.
    const meta = card.querySelector('.tool-meta');
    const lines = typeof output === 'string' && output.trim() && !/^No (matches|files) found/i.test(output.trim()) ? output.trim().split('\n').length : 0;
    if (meta && !error && lines && (card.classList.contains('tool-read') || card.classList.contains('tool-search'))) {
      meta.textContent = card.classList.contains('tool-read') ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : `${lines} ${lines === 1 ? 'result' : 'results'}`;
    }
    // Errors stay open so the reason is visible; successes fold away.
    card.open = Boolean(error && output);
  }


  // P16-I: an agent CLI missing on this workstation gets a setup card
  // (what was checked, a re-probe, the install command) instead of a raw
  // spawn ENOENT dumped into the transcript as if the model had said it.
  const INSTALL_HINTS = {
    claude: 'npm install -g @anthropic-ai/claude-code',
    codex: 'npm install -g @openai/codex',
  };
  const WARN_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.75 15 14.25H1z"/><path d="M8 6.25v3.5"/><path d="M8 11.9v.1"/></svg>';
  function appendBinaryMissingCard({ agent, checked }) {
    clearEmptyState();
    const card = document.createElement('div');
    card.className = 'setup-card';
    card.dataset.agent = agent;
    const head = document.createElement('div');
    head.className = 'setup-head';
    head.innerHTML = WARN_SVG;
    const title = document.createElement('span');
    title.textContent = `Agent Binary Not Found: "${agent}"`;
    head.append(title);

    const paths = document.createElement('details');
    paths.className = 'setup-paths';
    const summary = document.createElement('summary');
    summary.textContent = `Checked ${checked.length} location${checked.length === 1 ? '' : 's'}`;
    const list = document.createElement('ul');
    for (const file of checked) { const li = document.createElement('li'); li.textContent = file; list.append(li); }
    paths.append(summary, list);

    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const locateBtn = document.createElement('button');
    locateBtn.type = 'button';
    locateBtn.className = 'approval-btn setup-locate';
    locateBtn.textContent = 'Auto-Locate';
    locateBtn.addEventListener('click', () => {
      locateBtn.disabled = true;
      locateBtn.textContent = 'Searching\u2026';
      vscode.postMessage({ type: 'locateBinaries', agent });
    });
    actions.append(locateBtn);
    const hint = INSTALL_HINTS[agent];
    if (hint) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'approval-btn setup-copy';
      copyBtn.textContent = 'Copy install command';
      copyBtn.title = hint;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(hint).then(() => showToast(`Copied: ${hint}`), () => showToast(hint));
      });
      actions.append(copyBtn);
    }
    const note = document.createElement('div');
    note.className = 'setup-note';
    if (hint) {
      const code = document.createElement('code');
      code.textContent = hint;
      note.append('Install it with ', code, ', or put it on PATH, then Auto-Locate.');
    } else {
      note.textContent = 'Install the Antigravity CLI (agy) or put it on PATH, then Auto-Locate.';
    }
    card.append(head, paths, note, actions);
    turnHost().appendChild(card);
    card.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  const RETRY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.25v3.5h-3.5"/></svg>';
  // P17-I: the engine already backed off twice; one card, one Retry, the raw error folded away.
  function appendUpstreamErrorCard({ agent, detail }) {
    clearEmptyState();
    const card = document.createElement('div');
    card.className = 'setup-card is-upstream'; // no data-agent: Auto-Locate results must not resolve this card
    const head = document.createElement('div');
    head.className = 'setup-head';
    head.innerHTML = WARN_SVG;
    const title = document.createElement('span');
    title.textContent = `${agent} is unavailable right now`;
    head.append(title);
    const note = document.createElement('div');
    note.className = 'setup-note';
    note.textContent = 'The upstream service returned 503 after two automatic retries. It is usually back within a minute.';
    const raw = document.createElement('details');
    raw.className = 'setup-paths';
    const summary = document.createElement('summary');
    summary.textContent = 'Error details';
    const pre = document.createElement('pre');
    pre.textContent = detail;
    raw.append(summary, pre);
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'approval-btn setup-locate';
    retryBtn.innerHTML = RETRY_SVG;
    retryBtn.append('Retry');
    retryBtn.disabled = !lastTurn;
    retryBtn.addEventListener('click', () => {
      if (busy || !lastTurn) return;
      card.remove();
      dispatchTurn(lastTurn);
    });
    actions.append(retryBtn);
    card.append(head, note, ...(detail ? [raw] : []), actions);
    turnHost().appendChild(card);
    card.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function resolveBinaryCards(results) {
    for (const result of results || []) {
      for (const card of transcriptEl.querySelectorAll(`.setup-card[data-agent="${result.agent}"]`)) {
        const btn = card.querySelector('.setup-locate');
        if (result.path) {
          card.classList.add('resolved');
          const status = document.createElement('div');
          status.className = 'approval-status';
          status.textContent = `Found: ${result.path}. Send your message again.`;
          card.querySelector('.approval-actions').replaceWith(status);
        } else if (btn) {
          btn.disabled = false;
          btn.textContent = 'Auto-Locate';
          showToast(`Still no "${result.agent}" binary on this machine.`, { error: true });
        }
      }
    }
  }

  const AGENT_TITLES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  const pendingCards = new Map(); // actionId -> card, for expiry
  function settleCard(card, text, tone) {
    card.classList.add('resolved', `is-${tone}`);
    card.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    if (card.matches('.question-card')) {
      // Folds to one row: the question's tag and the answer; click it to see everything again.
      card.querySelector('.question-title').textContent = card.dataset.label;
      card.querySelector('.question-answer').textContent = text;
      card.open = false;
      return;
    }
    let status = card.querySelector('.approval-status');
    if (!status) {
      status = document.createElement('div');
      status.className = 'approval-status';
      card.appendChild(status);
    }
    status.textContent = text;
  }

  // Permission request: what, exactly, the agent wants to do, with the
  // command or file shown verbatim so the decision is informed.
  function appendApprovalCard({ agent, description, actionId, tool, command, file, preview, canAlwaysAllow }) {
    clearEmptyState();
    const card = document.createElement('div');
    card.className = 'approval-card';
    card.dataset.actionId = actionId;
    card.setAttribute('role', 'group');

    const head = document.createElement('div');
    head.className = 'approval-head';
    head.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.75 13.5 4v4c0 3-2.3 5.4-5.5 6.25C4.8 13.4 2.5 11 2.5 8V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 5.5v3M8 10.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    const title = document.createElement('span');
    title.className = 'approval-title';
    title.textContent = `${AGENT_TITLES[agent] || 'The agent'} wants to use `;
    const pill = document.createElement('span');
    pill.className = 'approval-tool';
    pill.textContent = toolDisplayName(tool, toolKind(tool)) || tool || 'a tool';
    title.appendChild(pill);
    head.appendChild(title);
    card.appendChild(head);

    if (description && description !== file && description !== command) {
      const desc = document.createElement('div');
      desc.className = 'approval-text';
      desc.textContent = description;
      card.appendChild(desc);
    }
    const target = command || file;
    if (target || preview) {
      const pre = document.createElement('pre');
      pre.className = 'approval-preview';
      pre.textContent = [target, preview && preview !== target ? preview : ''].filter(Boolean).join('\n\n');
      card.appendChild(pre);
    }

    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const button = (label, cls, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `approval-btn ${cls}`;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      actions.appendChild(btn);
      return btn;
    };
    const resolve = (approved, always) => {
      const settled = { text: approved ? (always ? 'Allowed for this session' : 'Allowed') : 'Denied', tone: approved ? 'allowed' : 'denied' }; // other windows on this chat settle theirs the same way
      vscode.postMessage({ type: 'approvalResponse', approved, always, actionId, settled });
      pendingCards.delete(actionId);
      settleCard(card, settled.text, settled.tone);
      promptInput.focus();
    };
    const allow = button('Allow', 'approval-approve', () => resolve(true, false));
    if (canAlwaysAllow) button('Allow for session', 'approval-always', () => resolve(true, true));
    button('Deny', 'approval-reject', () => resolve(false, false));
    card.appendChild(actions);
    // Keyboard: Enter allows, Escape denies, while the card has focus.
    card.tabIndex = -1;
    card.addEventListener('keydown', (event) => {
      if (card.classList.contains('resolved')) return;
      if (event.key === 'Escape') { event.preventDefault(); resolve(false, false); }
    });
    turnHost().appendChild(card);
    pendingCards.set(actionId, card);
    scrollTranscriptToEnd();
    allow.focus({ preventScroll: true });
  }

  // AskUserQuestion: one block per question, options as tappable pills
  // (radio or multi-select), plus a free "Other" answer.
  function appendQuestionCard({ agent, actionId, questions }) {
    clearEmptyState();
    // A <details> like the tool steps: open while it waits, one summary row once answered, click to read it again.
    const card = document.createElement('details');
    card.className = 'question-card';
    card.open = true;
    card.dataset.actionId = actionId;
    card.dataset.label = questions[0]?.header || 'Question';
    const answers = new Map();
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'approval-btn approval-approve question-submit';
    submit.textContent = 'Send answer';
    const refresh = () => { submit.disabled = questions.some((q) => !(answers.get(q.question) || []).length); };

    const head = document.createElement('summary');
    head.className = 'question-summary';
    head.innerHTML = '<span class="question-icon"><svg class="icon-ask" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.2 6.2a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3M8 11.6v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><svg class="icon-done" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 8.4 2.7 2.6L12 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="question-title"></span><span class="question-answer"></span><svg class="question-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    head.querySelector('.question-title').textContent = `${AGENT_TITLES[agent] || 'The agent'} has a question`;
    head.addEventListener('click', (event) => { if (!card.classList.contains('resolved')) event.preventDefault(); }); // only foldable once answered
    card.appendChild(head);
    const body = document.createElement('div');
    body.className = 'question-body';
    card.appendChild(body);

    questions.forEach((q, qi) => {
      const block = document.createElement('div');
      block.className = 'question-block';
      if (q.header) {
        const chip = document.createElement('span');
        chip.className = 'question-chip';
        chip.textContent = q.header;
        block.appendChild(chip);
      }
      const text = document.createElement('div');
      text.className = 'question-text';
      text.textContent = q.question;
      block.appendChild(text);
      const list = document.createElement('div');
      list.className = q.multiSelect ? 'question-options' : 'question-options pill-track'; // a single choice gets the gliding pill
      list.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup');
      list.setAttribute('aria-label', q.question);
      const pick = (label, on) => {
        const current = new Set(answers.get(q.question) || []);
        if (!q.multiSelect) current.clear();
        if (on) current.add(label); else current.delete(label);
        answers.set(q.question, [...current]);
        list.querySelectorAll('.question-option').forEach((b) => b.setAttribute('aria-checked', String(current.has(b.dataset.label))));
        refresh();
      };
      (q.options || []).forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'question-option';
        btn.dataset.label = opt.label;
        btn.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio');
        btn.setAttribute('aria-checked', 'false');
        const radio = document.createElement('span');
        radio.className = 'question-radio';
        btn.appendChild(radio);
        // "(Recommended)" becomes a small tag; the answer sent back still carries the full label.
        const recommended = /\s*\(Recommended\)\s*$/i.test(opt.label);
        const l = document.createElement('span');
        l.className = 'question-option-label';
        l.textContent = recommended ? opt.label.replace(/\s*\(Recommended\)\s*$/i, '') : opt.label;
        if (recommended) {
          const tag = document.createElement('span');
          tag.className = 'question-tag';
          tag.textContent = 'Recommended';
          l.appendChild(tag);
        }
        btn.appendChild(l);
        if (opt.description) {
          const d = document.createElement('span');
          d.className = 'question-option-desc';
          d.textContent = opt.description;
          btn.appendChild(d);
        }
        btn.addEventListener('click', () => pick(opt.label, btn.getAttribute('aria-checked') !== 'true'));
        list.appendChild(btn);
      });
      block.appendChild(list);
      const other = document.createElement('input');
      other.className = 'question-other';
      other.placeholder = 'Other answer\u2026';
      other.setAttribute('aria-label', `Other answer for: ${q.question}`);
      other.addEventListener('input', () => {
        const label = other.value.trim();
        const current = (answers.get(q.question) || []).filter((a) => (q.options || []).some((o) => o.label === a));
        if (!q.multiSelect && label) list.querySelectorAll('.question-option').forEach((b) => b.setAttribute('aria-checked', 'false'));
        answers.set(q.question, label ? (q.multiSelect ? [...current, label] : [label]) : q.multiSelect ? current : []);
        refresh();
      });
      other.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !submit.disabled) submit.click(); });
      block.appendChild(other);
      body.appendChild(block);
      if (qi === 0) queueMicrotask(() => list.querySelector('.question-option')?.focus({ preventScroll: true }));
    });

    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'approval-btn approval-reject';
    skip.textContent = 'Skip';
    actions.append(submit, skip);
    body.appendChild(actions);
    submit.addEventListener('click', () => {
      const payload = Object.fromEntries(questions.map((q) => [q.question, (answers.get(q.question) || []).join(', ')]));
      const settled = { text: Object.values(payload).join(' \u00b7 '), tone: 'allowed' };
      vscode.postMessage({ type: 'questionResponse', actionId, answers: payload, settled });
      pendingCards.delete(actionId);
      settleCard(card, settled.text, settled.tone);
      promptInput.focus();
    });
    skip.addEventListener('click', () => {
      vscode.postMessage({ type: 'approvalResponse', approved: false, actionId, settled: { text: 'Skipped', tone: 'denied' } });
      pendingCards.delete(actionId);
      settleCard(card, 'Skipped', 'denied');
    });
    refresh();
    turnHost().appendChild(card);
    pendingCards.set(actionId, card);
    scrollTranscriptToEnd();
  }

  function appendNotice(text) {
    clearEmptyState();
    const note = document.createElement('div');
    note.className = 'chat-notice';
    note.textContent = text;
    turnHost().appendChild(note);
    scrollTranscriptToEnd();
  }


  // ---------- P17-R: context window, one number ----------
  // How full the context window is right now. It shows in the Thinking pill
  // while the agent works, and as a warning above the composer from 75% on.
  // Every model in the picker runs a 1M-token window (Opus 5.5 and Sonnet 5.5 per Anthropic's model table; Gemini's is 2^20).
  const CONTEXT_LIMITS = { claude: 1000000, codex: 1000000, gemini: 1048576 };
  const CONTEXT_WARN_PCT = 75;
  const contextWarning = document.createElement('div');
  contextWarning.className = 'context-warning island-bud';
  contextWarning.hidden = true;
  contextWarning.innerHTML = `${WARN_SVG}<span class="context-warning-text"></span><button type="button" class="context-compact">Compact</button>`;
  // A bud of the dock right above the pill; the dock's goo fuses the two (docs/dynamic-island-composer-spec.md).
  composerEl.before(contextWarning);
  const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `${Math.max(1, Math.round(n / 1000))}k`);
  function renderContextGauge(context) {
    const tokens = context?.tokens || 0;
    const limit = CONTEXT_LIMITS[context?.agent] || 1000000;
    const remaining = Math.max(0, limit - tokens);
    const pct = Math.min(100, Math.round((tokens / limit) * 100));
    const isEst = context?.estimated ? '~' : '';
    pendingTokens.textContent = tokens ? `${isEst}${kTokens(tokens)} / ${kTokens(limit)} Token Context` : '';
    pendingTokens.title = `${context?.agent ? AGENT_NAMES[context.agent] || context.agent : 'Model'} context: ${tokens.toLocaleString()} tokens used (${pct}%), ${remaining.toLocaleString()} tokens remaining in ${limit.toLocaleString()} window.`;
    contextWarning.hidden = pct < CONTEXT_WARN_PCT;
    if (contextWarning.hidden) return;
    contextWarning.querySelector('.context-warning-text').textContent = `Context ${pct}% full (${kTokens(remaining)} left)`;
    contextWarning.title = `${AGENT_NAMES[context.agent] || context.agent} context window: ${context.estimated ? 'approximately ' : ''}${tokens.toLocaleString()} of ${limit.toLocaleString()} tokens (${remaining.toLocaleString()} left). Compacting retains up to roughly 100,000 tokens in a detailed checkpoint.`;
  }
  const COMPACT_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="compact-arrow-top" d="M4 2.5 8 6l4-3.5"/><path class="compact-arrow-bottom" d="M4 13.5 8 10l4 3.5"/></svg>';
  const compactVisibility = new IntersectionObserver((entries) => {
    entries.forEach((entry) => entry.target.classList.toggle('is-visible', entry.isIntersecting));
  });
  // One status for both the hidden handoff and its thinking; it settles into the history divider.
  function appendCompactDivider(auto, active = false, outcome = 'complete') {
    const divider = document.createElement('div');
    divider.className = `compact-divider${active ? ' is-compacting' : ''}`;
    divider.dataset.completeLabel = auto ? 'Context auto-compacted' : 'Context compacted';
    divider.setAttribute('role', 'status');
    divider.innerHTML = `<span class="compact-status">${COMPACT_SVG}<span class="compact-label"></span><span class="compact-thinking" aria-hidden="true"${active ? '' : ' hidden'}><i></i><i></i><i></i></span></span>`;
    divider.querySelector('.compact-label').textContent = active ? 'Thinking · compacting context' : outcome === 'complete' ? divider.dataset.completeLabel : `Context compaction ${outcome}`;
    if (active) activeCompactDivider = divider;
    transcriptEl.appendChild(divider);
    if (active) compactVisibility.observe(divider);
    scrollTranscriptToEnd();
  }
  function finishCompactDivider(outcome = 'complete') {
    if (!activeCompactDivider) return;
    const divider = activeCompactDivider;
    activeCompactDivider = null;
    compactVisibility.unobserve(divider);
    divider.classList.remove('is-compacting');
    divider.classList.add('is-settled');
    divider.querySelector('.compact-thinking').hidden = true;
    divider.querySelector('.compact-label').textContent = outcome === 'complete' && !divider.dataset.failed ? divider.dataset.completeLabel : `Context compaction ${divider.dataset.failed ? 'failed' : outcome}`;
  }
  contextWarning.querySelector('.context-compact').addEventListener('click', () => {
    if (busy) { showToast('Compaction runs once the current turn is done.'); return; }
    renderContextGauge(null);
    setBusy(true);
    vscode.postMessage({ type: 'compact' }); // the host answers with 'compacting'
  });

  /** `running`: the host's routing message for a turn still in progress. Its reply
   * so far stays open, and the stream picks up where it is. */
  function restoreChat(chat, running = null) {
    currentChatId = chat.id;
    if (chat.modelId) selectModel(chat.modelId, { notifyExtension: false });
    try { vscode.setState({ ...(vscode.getState() || {}), chatId: chat.id }); } catch {} // reopened here after a restart
    turnRoutedAgent = null; // the restored transcript's own last reply says who answered here
    isCompacting = Boolean(running?.compact);
    if (activeCompactDivider) compactVisibility.unobserve(activeCompactDivider);
    activeCompactDivider = null;
    renderContextGauge(chat.context);
    renderChatCost(chat.apiCostUsd);
    clearEmptyState();
    transcriptEl.replaceChildren();
    currentAssistantBubble = null;
    turnBubbles = [];
    const messages = chat.messages || [];
    const live = running ? messages.findLastIndex((message) => message.role === 'assistant') : -1;
    // Each stored turn collapses the same way a live one does; its duration is
    // the gap between the user message's and the reply's timestamps.
    let anchor = null;
    let startedAt = null;
    let endedAt = null;
    const flush = () => { if (anchor) collapseTurn(anchor, startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null); anchor = null; };
    const storedTool = (message) => appendToolCard({ name: message.event?.name, command: message.event?.command || message.event?.file, output: { text: message.event?.output || '' }, done: true, error: message.error, diff: message.event?.diff });
    const placed = new Set();
    let hiddenCompactTurn = false;
    restoringHistory = true;
    messages.forEach((message, index) => {
      if (message.role === 'user') {
        flush();
        hiddenCompactTurn = Boolean(message.compact);
        if (hiddenCompactTurn) {
          const reply = messages.slice(index + 1).find((entry) => entry.role === 'assistant');
          const active = isCompacting && messages.findLastIndex((entry) => entry.role === 'user') === index;
          const outcome = reply?.interrupted ? 'interrupted' : /^(Claude|Gemini|Codex) error:/i.test(reply?.text || '') ? 'failed' : 'complete';
          appendCompactDivider(message.auto, active, outcome);
          if (active) { currentTurnEl = null; currentAssistantBubble = null; }
          return;
        }
        appendUserMessage(message.text || '', message.at || null, message.files, { scheduled: message.scheduled });
        anchor = currentTurnEl.firstElementChild; startedAt = message.at; endedAt = null;
      }
      else if (hiddenCompactTurn) return;
      else if (message.role === 'assistant') {
        // The tools that follow a reply record where in its text they ran, so
        // text and steps come back in the order they happened (older chats: tools last).
        const text = message.text || '';
        let from = 0;
        for (let next = index + 1; messages[next]?.role === 'tool' && Number.isFinite(messages[next].offset); next++) {
          appendAssistantDelta(text.slice(from, messages[next].offset), message.agent, message.modelLabel, message.roleName);
          storedTool(messages[next]);
          placed.add(next);
          from = messages[next].offset;
        }
        appendAssistantDelta(text.slice(from), message.agent, message.modelLabel, message.roleName);
        if (index === live) return;
        if (message.interrupted) appendInterruptedPill();
        endAssistantTurn(message.at || null);
        endedAt = message.at;
      }
      else if (message.role === 'tool' && !placed.has(index)) storedTool(message);
    });
    restoringHistory = false;
    const latest = messages.findLastIndex((entry) => entry.role === 'assistant' && !entry.compact);
    if (!running && messages[latest]?.undo?.count && !messages[latest].undone && !messages.slice(latest).some((entry) => entry.role === 'user' && !entry.compact)) offerUndo(messages[latest].undo.count);
    scheduleChoice = null; // a new chat starts from its own model's usage, not the last chat's clock pick
    scheduleTimer.clear();
    refreshScheduleDefault();
    if (running) {
      turnAnchor = anchor;
      turnStartedAt = running.startedAt || Date.now();
      turnModelLabel = running.modelLabel || null;
      turnRoleName = running.roleName || null;
      pendingEl.dataset.agent = running.agentId || '';
      if (currentTurnEl) currentTurnEl.dataset.agent = running.agentId || '';
      turnRoutedAgent = running.agentId || null; // a reload mid-turn must still know who hits a limit
    } else {
      flush();
      turnAnchor = null;
      // Reopened after the limit hit (reload, restart, next morning): the last reply still offers the button.
      const lastMessage = messages.findLast((message) => message.role !== 'tool');
      if (lastMessage?.role === 'assistant' && isLimitNotice(lastMessage.text) && !hasHeadroom(lastMessage.agent)) {
        turnRoutedAgent = lastMessage.agent || null;
        offerContinueAtReset([...transcriptEl.querySelectorAll('.msg-assistant')].pop());
      }
    }
    if (!transcriptEl.childElementCount) transcriptEl.append(emptyState());
    scrollTranscriptToEnd(true);
  }

  // Inline rename: the name turns into a field. Enter or clicking away saves,
  // Esc cancels, and an empty name goes back to the first message.
  function editTitle(el, current, onSave) {
    const input = document.createElement('input');
    input.className = 'title-edit';
    input.value = current;
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Chat name');
    el.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name !== current) { el.textContent = name || el.textContent; onSave(name); }
      input.replaceWith(el);
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('blur', () => finish(true));
  }

  // Manage Chats: a search field above the list, Active Chats first, the rest grouped by day (Today, Yesterday, ...).
  const timeOptions = () => ({ locale: TIME_PREFS.locale, hourCycle: HOUR_CYCLE });
  const chatWhen = (iso) => window.chatTime.chatTime(iso, timeOptions());
  const fullWhen = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(TIME_PREFS.locale, clockParts({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })); };
  const historySearch = document.createElement('input');
  historySearch.type = 'search';
  historySearch.className = 'history-search';
  historySearch.placeholder = 'Search chats';
  historySearch.setAttribute('aria-label', 'Search chats');
  historySearch.autocomplete = 'off';
  historyModal.body.before(historySearch);
  let historySessions = [];
  historySearch.addEventListener('input', () => renderHistory(historySessions));
  // "5 minutes ago" ages while the list is open.
  setInterval(() => {
    if (historyModal.el.hidden) return;
    historyModal.body.querySelectorAll('.history-when[data-at]').forEach((label) => { const text = chatWhen(label.dataset.at); if (label.textContent !== text) label.textContent = text; });
  }, 30000);

  function renderHistory(sessions) {
    historySessions = sessions || [];
    const all = historySessions;
    const working = all.filter((session) => session.state).length;
    historyBtn.title = working ? `${working} chat${working === 1 ? '' : 's'} running` : 'Manage chats';
    const query = historySearch.value.trim().toLowerCase();
    const list = query ? all.filter((session) => [session.title, session.projectName, session.preview, session.lastMessage?.text].some((field) => String(field || '').toLowerCase().includes(query))) : all;
    historyModal.count.textContent = query ? `${list.length} of ${all.length}` : String(all.length);
    historySearch.hidden = !all.length;
    const scrolled = historyModal.body.scrollTop; // a live refresh keeps your place
    historyModal.body.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'fs-modal-empty';
      empty.textContent = all.length ? `No chats match “${historySearch.value.trim()}”.` : 'No conversations yet.';
      historyModal.body.append(empty);
      return;
    }
    const active = list.filter((session) => session.active);
    if (active.length) historyModal.body.append(historySection('Active Chats', active));
    const groups = [];
    for (const session of list.filter((entry) => !entry.active)) {
      const label = window.chatTime.chatDayGroup(session.updatedAt, timeOptions());
      if (groups.at(-1)?.label === label) groups.at(-1).sessions.push(session); else groups.push({ label, sessions: [session] });
    }
    for (const group of groups) historyModal.body.append(historySection(group.label || 'Older', group.sessions));
    historyModal.body.scrollTop = scrolled;
  }

  const CHAT_ICONS = {
    stop: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor"/></svg>',
    rename: PENCIL_SVG,
    // The Source Control mark: one trunk, one branch splitting off, a node on each end.
    fork: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.6-2 3.4-4.3 3.9-1.5.3-2.7.7-2.7 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    delete: TRASH_SVG,
  };
  function historySection(label, sessions) {
    const section = document.createElement('section');
    section.className = 'history-section';
    if (label) {
      const heading = document.createElement('h3');
      heading.className = 'history-section-label';
      heading.textContent = label;
      section.append(heading);
    }
    const wrap = document.createElement('div');
    wrap.className = 'queue-list';
    for (const session of sessions) {
      const card = document.createElement('article');
      // The same look as the rail's Recent tiles: a chat bubble whose rim is white for the chat in this window, blue for
      // one that ran in the last minutes, orange when it waits for you; a running chat wears the orb on its top right.
      card.className = `history-card${session.state ? ` is-${session.state}` : ''}${session.active ? ' is-recent' : ''}${session.id === currentChatId ? ' is-current' : ''}`;
      card.dataset.id = session.id;
      const head = document.createElement('div');
      head.className = 'queue-card-head';
      // (A chat waiting for you says so with its yellow, pulsing rim, not in words.)
      // The providers that answered, as their marks (the name is the tooltip), like the tile in the rail.
      for (const model of session.models || []) {
        const mark = document.createElement('span');
        mark.className = 'agent-mark';
        mark.title = MODEL_LABELS[model] || model;
        mark.setAttribute('aria-label', mark.title);
        mark.innerHTML = (window.AGENT_ICONS && window.AGENT_ICONS[model]) || '';
        head.append(mark);
      }
      const latest = (session.models || []).at(-1);
      if (latest) card.dataset.agent = latest; // the orb's colour
      if (session.state === 'running') {
        const orb = document.createElement('span');
        orb.className = 'pending-orb history-spinner';
        orb.setAttribute('aria-hidden', 'true');
        card.append(orb);
      }
      const titleEl = document.createElement('span');
      titleEl.className = 'history-title';
      titleEl.textContent = session.title || session.preview || 'New chat';
      titleEl.title = session.title || session.preview || 'New chat';
      head.append(titleEl);

      // Under the title, left-aligned with every other card's: when it was last active, in the messenger style of
      // chat-time.js, then how long the chat is. The label ages ("5 minutes ago"), so it is refreshed (see below).
      const meta = document.createElement('div');
      meta.className = 'history-meta';
      if (session.projectName) { const project = document.createElement('span'); project.textContent = session.projectName; meta.append(project); }
      const when = document.createElement('time');
      when.className = 'history-when';
      when.dateTime = session.updatedAt || '';
      when.dataset.at = session.updatedAt || '';
      when.textContent = chatWhen(session.updatedAt);
      when.title = fullWhen(session.updatedAt);
      const count = document.createElement('span');
      count.className = 'history-count';
      count.textContent = `${session.messageCount || 0} message${session.messageCount === 1 ? '' : 's'}`;
      meta.append(when, count);

      const preview = document.createElement('div');
      preview.className = 'queue-prompt history-preview';
      if (session.lastMessage && session.lastMessage.text) {
        const sender = document.createElement('span');
        sender.className = 'history-preview-sender';
        const senderName = session.lastMessage.role === 'user'
          ? 'You'
          : (session.lastMessage.agent ? (session.lastMessage.agent.charAt(0).toUpperCase() + session.lastMessage.agent.slice(1)) : 'AI');
        sender.textContent = `${senderName}: `;
        const text = document.createElement('span');
        text.className = 'history-preview-text';
        text.textContent = session.lastMessage.text;
        preview.append(sender, text);
      } else {
        preview.textContent = 'No messages yet';
      }

      const actions = document.createElement('div');
      actions.className = 'history-actions';
      const action = (icon, label, handler, cls = '') => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `history-icon-btn ${cls}`;
        btn.innerHTML = CHAT_ICONS[icon];
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.addEventListener('click', (event) => { event.stopPropagation(); handler(); });
        actions.append(btn);
      };
      if (session.state) action('stop', 'Stop', () => vscode.postMessage({ type: 'stopChat', id: session.id }));
      action('rename', 'Rename', () => editTitle(titleEl, session.title || session.preview || '', (title) => vscode.postMessage({ type: 'renameChat', id: session.id, title })));
      action('fork', 'Fork into a new chat', () => { vscode.postMessage({ type: 'forkChat', id: session.id }); closeModal(historyModal.el); });
      action('delete', 'Delete', () => { card.classList.add('is-leaving'); vscode.postMessage({ type: 'deleteChat', id: session.id }); }, 'is-danger');
      head.append(actions);
      // The whole card opens the chat; whatever runs in the current one keeps going in the background.
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Open chat${session.state === 'waiting' ? ' (waiting for your input)' : ''}: ${session.title || session.preview || 'New chat'}`);
      if (session.state === 'waiting') card.title = 'Waiting for your input';
      const open = (event) => {
        if (event?.target?.closest('.history-actions') || event?.target?.tagName === 'INPUT') return;
        if (session.id !== currentChatId) vscode.postMessage({ type: 'restoreChat', id: session.id });
        closeModal(historyModal.el);
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (event) => {
        if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); }
      });
      card.prepend(head, meta, preview);
      wrap.append(card);
      window.shapeBubbleCard?.(card);
    }
    section.append(wrap);
    return section;
  }


  window.addEventListener('message', (event) => {
    const message = event.data;
    // Chat navigation reveals the thread instead of leaving a popup over it.
    if (message.type === 'chatLoading' || message.type === 'chatLoaded') {
      document.querySelectorAll('.fs-modal:not([hidden])').forEach(closeModal);
    }
    switch (message.type) {
      case 'attachmentSaved': {
        if (message.chatId && message.chatId !== currentChatId) {
          const draft = chatDrafts.get(message.chatId) || { text: '', files: [], mentions: [] };
          draft.files.push(message.attachment); chatDrafts.set(message.chatId, draft);
        } else { attachments.push(message.attachment); renderAttachments(); }
        break;
      }
      case 'attachmentRenamed': { const at = attachments.findIndex((item) => item.path === message.from); if (at >= 0) { attachments[at] = { ...attachments[at], ...message.attachment, dims: attachments[at].dims }; renderAttachments(); } break; }
      case 'history': {
        // A rename in progress would lose its text to a live refresh; its own save refreshes again.
        if (!historyModal.body.querySelector('input')) renderHistory(message.sessions);
        break;
      }
      case 'project': {
        projectBar.hidden = false;
        projectBtn.textContent = message.project?.name || 'Choose project';
        projectBtn.title = message.project ? (message.project.root || 'Planning project — attach a folder through Manage projects') : 'Select a project before sending this chat';
        projectBtn.classList.toggle('needs-project', Boolean(message.required));
        explorerBtn.hidden = !message.project?.root;
        break;
      }
      case 'editorTheme': editorTheme = message.theme; void applyEditorTheme(); break;
      // A chat switch has started: the old thread goes, shimmering placeholders stand in until chatLoaded renders the new one.
      case 'chatLoading': {
        if (editingQueue) finishQueueEdit();
        clearEmptyState();
        const bar = (width) => `<i class="skeleton" style="width:${width}%"></i>`;
        transcriptEl.innerHTML = `<div class="chat-skeleton" aria-busy="true" aria-label="Loading chat">
          <div class="skel-user"><i class="skeleton" style="width:58%"></i></div>
          <div class="skel-reply">${[92, 84, 68].map(bar).join('')}</div>
          <div class="skel-user"><i class="skeleton" style="width:42%"></i></div>
          <div class="skel-reply">${[88, 61].map(bar).join('')}</div></div>`;
        break;
      }
      case 'chatLoaded': {
        if (message.chat?.id !== currentChatId) {
          if (editingQueue) finishQueueEdit();
          if (currentChatId) chatDrafts.set(currentChatId, { text: promptInput.value, files: attachments.slice(), mentions: [...mentioned] });
          const draft = chatDrafts.get(message.chat?.id);
          promptInput.value = draft?.text || '';
          attachments = draft?.files || [];
          mentioned.clear();
          for (const mention of draft?.mentions || []) mentioned.add(mention);
          workspaceFiles = null; workspaceRoot = '';
          closeSlashMenu(); renderAttachments(); renderMentions(); autoGrow();
        }
        // The extension keeps every chat's queue running, independently of the visible thread.
        flushVoiceDraft(promptInput.value.trim());
        awaitingInterruptAck = false;
        const state = vscode.getState();
        // Migrate all old queues, including chats not currently shown. A host acknowledgement removes each old copy.
        const legacy = { ...state?.queues };
        if (state?.queue?.chatId && !legacy[state.queue.chatId]) legacy[state.queue.chatId] = state.queue.turns;
        for (const [chatId, turns] of Object.entries(legacy)) if (Array.isArray(turns) && turns.length) vscode.postMessage({ type: 'importTurnQueue', chatId, turns });
        turnQueue = message.chat?.turnQueue?.turns || [];
        queuePaused = message.chat?.turnQueue?.paused === true;
        busy = false;
        resetThought();
        resetAgents(); // the new chat's own agents follow in a subagentReplay
        restoreChat(message.chat, message.running);
        renderTurnQueue();
        restoreAgents();
        setBusy(Boolean(message.running));
        break;
      }
      case 'turnQueue': {
        // Clear acknowledged legacy copies before checking visibility, so they can't reappear on a later switch.
        try {
          const state = vscode.getState() || {};
          const queues = { ...state.queues };
          delete queues[message.chatId];
          const next = { ...state, queues };
          if (next.queue?.chatId === message.chatId) delete next.queue;
          vscode.setState(next);
        } catch {}
        if (message.chatId !== currentChatId) break;
        const transportFocused = document.activeElement?.matches('.queue-transport');
        turnQueue = message.turns || [];
        queuePaused = message.paused === true;
        renderTurnQueue();
        renderComposerState();
        if (transportFocused) queueStrip.querySelector('.queue-transport')?.focus({ preventScroll: true });
        break;
      }
      // Auto mode is a standing preference, not a one-shot pick — keep the
      // Auto tab selected across turns instead of jumping to whichever
      // agent this particular message landed on (the resolved agent still
      // shows as the role label on the reply bubble itself).
      case 'quotas': {
        lastQuotas = message.quotas || {};
        for (const quota of modelMenu.querySelectorAll('.model-group-head')) {
          const agent = quota.parentElement.querySelector('.model-option')?.dataset.agent;
          quota.querySelector('.model-group-quota').textContent = quotaText(agent);
        }
        // Usage is back: a limit this session no longer holds, and an unused "Continue when … resets"
        // has nothing left to wait for.
        for (const agent of AGENT_IDS) {
          if (!hasHeadroom(agent)) continue;
          limitHitAgents.delete(agent);
          transcriptEl.querySelectorAll(`.continue-at-reset[data-reset-agent="${agent}"]:not(:disabled)`).forEach((btn) => btn.remove());
        }
        refreshScheduleDefault();
        break;
      }
      case 'setActive': {
        selectModel(message.modelId, { notifyExtension: false });
        break;
      }
      case 'micState': {
        micBtn.classList.toggle('recording', message.state === 'recording');
        micBtn.classList.toggle('is-busy', message.state === 'starting' || message.state === 'processing');
        micBtn.disabled = message.state === 'processing' || message.state === 'starting';
        micBtn.title =
          message.state === 'recording'
            ? `Listening${message.device ? ` on ${message.device}` : ''}\u2026 stops by itself after a pause. Click to stop now, Esc to cancel`
            : message.state === 'processing'
              ? 'Transcribing and routing\u2026'
              : message.state === 'starting'
                ? 'Opening microphone\u2026'
                : 'Voice input (click to record)';
        setVoiceState(message.state);
        break;
      }
      case 'micVolume': {
        const rms = Math.max(0, Number(message.rms) || 0);
        const peak = Math.max(0, Number(message.peak) || 0);
        const crest = Math.min(peak, rms * 4);
        const legacyEnergy = rms * 0.78 + crest * 0.22;
        const legacyLevel = legacyEnergy <= 0.0035 ? 0 : Math.min(1, ((legacyEnergy - 0.0035) / 0.0915) ** 0.58);
        const level = Math.max(0, Math.min(1, Number.isFinite(Number(message.level)) ? Number(message.level) : legacyLevel));
        const now = performance.now();
        micLevel = level;
        micLevelAt = now;
        // Hands-free end: once real speech has been heard, a pause of VOICE_SILENCE_MS stops and transcribes, like a click would.
        if (level > VOICE_SPEECH) { speechMs += lastVolumeAt ? Math.min(now - lastVolumeAt, 100) : 40; lastSpeechAt = now; }
        lastVolumeAt = now;
        if (window.VOICE_SILENCE_MS && !voiceStopSent && speechMs >= VOICE_MIN_SPEECH_MS && now - lastSpeechAt > window.VOICE_SILENCE_MS) {
          voiceStopSent = true;
          vscode.postMessage({ type: 'micToggle' });
        }
        break;
      }
      case 'voiceError': {
        showToast(message.message || 'Voice input failed.', { error: true });
        break;
      }
      // P17-ZA: never auto-sent. The router's pick preselects the model; the text waits in the composer.
      case 'voiceResult': {
        const text = message.output?.cleanedPrompt || '';
        // The router's pick only fills in for Auto; a model the user chose stays put.
        if (activeModelId === 'auto' && message.output?.decision?.targetModel) selectAgent(message.output.decision.targetModel);
        if (text) {
          insertVoiceDraft(text);
          lastVoiceDraft = { original: promptInput.value.trim(), raw: message.rawTranscript || '' }; // includes any text typed before
        }
        break;
      }
      case 'voiceTermsLearned': {
        if (message.terms?.length) showToast(`Added to voice dictionary: ${message.terms.join(', ')}`);
        break;
      }
      // aiChatPanel.injectPrompt with submit:false (e.g. a batch dispatch the
      // user should review before sending) drops the prompt into the
      // composer instead of sending it immediately.
      // Files dropped in, or sent here from the Explorer's "Add to Clanker Controller".
      case 'insertMentions': {
        for (const file of message.paths || []) insertMention(file, false);
        promptInput.focus();
        break;
      }
      case 'prefillPrompt': {
        if (editingQueue) finishQueueEdit();
        promptInput.value = message.text || '';
        autoGrow();
        promptInput.focus();
        break;
      }
      // P17-Z: a task taken off the schedule. Send Now goes through Auto (next in line if a turn is running);
      // Unschedule lands it in the composer as an editable draft with its attachments.
      case 'restoreScheduledDraft': {
        const files = Array.isArray(message.files) ? message.files : [];
        const text = message.text || '';
        if (message.sendNow) {
          const turn = { id: `${Date.now()}-now`, text, modelId: message.modelId || 'auto', attachments: files.map((file) => file.path), files };
          if (busy) { turnQueue.unshift(turn); renderTurnQueue(); } else dispatchTurn(turn);
          break;
        }
        editQueuePrompt({ text, files, modelId: message.modelId }, message.taskId);
        break;
      }
      // Forward-compatible with the Unified Event Protocol the headless
      // streaming bridge (P13-E) will emit; inert until that lands.
      case 'thought': {
        if (!isCompacting) appendThought(message.text || '');
        break;
      }
      case 'subagent_start':
      case 'subagent_event':
      case 'subagent_end':
      case 'subagent_status': applySubagent(message); break;
      case 'subagentReplay': // the host's log is the complete one; it replaces the restored copy
        if (message.events?.length) resetAgents();
        for (const event of message.events || []) applySubagent(event);
        break;
      case 'delta': {
        if (isCompacting) {
          if (/^(Claude|Gemini|Codex) error:/i.test(message.text || '')) {
            if (activeCompactDivider) activeCompactDivider.dataset.failed = 'true';
            appendNotice(message.text);
          }
          break;
        }
        foldThought();
        appendAssistantDelta(message.text, message.model, turnModelLabel, turnRoleName);
        break;
      }
      case 'tool_start': {
        if (isCompacting) break;
        foldThought();
        openToolCard = appendToolCard({ name: message.name, command: message.command || message.file, output: { text: '' }, toolId: message.toolId, done: message.done, diff: message.diff });
        break;
      }
      case 'tool_end': {
        if (isCompacting) break;
        const card = (message.toolId && toolCards.get(message.toolId)) || openToolCard;
        finishToolCard(card, { output: message.output, error: message.error });
        if (card === openToolCard) openToolCard = null;
        break;
      }
      case 'question_required': {
        appendQuestionCard({ agent: message.agent, actionId: message.actionId, questions: Array.isArray(message.questions) ? message.questions : [] });
        break;
      }
      case 'approval_cancelled': {
        const card = pendingCards.get(message.actionId);
        if (card) { settleCard(card, 'No longer needed', 'denied'); pendingCards.delete(message.actionId); }
        break;
      }
      case 'notice': {
        appendNotice(message.text || '');
        break;
      }
      // Answered in another window showing this chat: the card settles here exactly as it did there.
      case 'cardSettled': {
        const card = pendingCards.get(message.actionId);
        if (card) { settleCard(card, message.text, message.tone); pendingCards.delete(message.actionId); }
        break;
      }
      case 'binary_missing': {
        appendBinaryMissingCard({ agent: message.agent, checked: Array.isArray(message.checked) ? message.checked : [] });
        break;
      }
      case 'compacting': {
        // The handoff streams invisibly; its thinking and compaction share one live status.
        isCompacting = true;
        currentAssistantBubble = null;
        currentTurnEl = null;
        turnAnchor = null;
        appendCompactDivider(message.auto, true);
        renderContextGauge(null);
        setBusy(true);
        break;
      }
      case 'usage': {
        renderContextGauge({ agent: message.agent, tokens: message.contextTokens, estimated: message.estimated });
        break;
      }
      case 'workspaceFiles': {
        workspaceFiles = Array.isArray(message.files) ? message.files : [];
        workspaceRoot = message.root || '';
        if (document.activeElement === promptInput) updateMentionMenu();
        break;
      }
      case 'slashCommands': {
        slashCommands = Array.isArray(message.commands) ? message.commands : [];
        if (document.activeElement === promptInput) updateSlashMenu();
        break;
      }
      case 'upstream_error': {
        if (isCompacting && activeCompactDivider) activeCompactDivider.dataset.failed = 'true';
        appendUpstreamErrorCard({ agent: message.agent, detail: message.detail || '' });
        if (LIMIT_RE.test(message.detail || '')) limitHitThisTurn = true;
        break;
      }
      case 'binariesLocated': {
        resolveBinaryCards(message.results);
        break;
      }
      case 'approval_required': {
        appendApprovalCard(message);
        break;
      }
      case 'turn_complete': {
        if (Number.isFinite(message.chatCostUsd)) renderChatCost(message.chatCostUsd); // every turn, compactions too: the same chat goes on
        settleAgents(Boolean(message.interrupted));
        if (awaitingInterruptAck) { awaitingInterruptAck = false; isCompacting = false; break; } // already closed out by Stop / Steer Now
        const completedCompaction = isCompacting;
        if (completedCompaction) finishCompactDivider(message.interrupted ? 'interrupted' : 'complete');
        isCompacting = false;
        // Anything still unanswered can't be answered any more.
        for (const [id, card] of pendingCards) { settleCard(card, 'Turn ended', 'denied'); pendingCards.delete(id); }
        if (!completedCompaction) {
          document.querySelectorAll('.tool-card.is-running').forEach((card) => {
            finishToolCard(card, { output: card.querySelector('.tool-body')?.textContent || '' });
            if (message.interrupted) card.classList.add('is-cancelled');
          });
          foldThought();
          if (message.interrupted) appendInterruptedPill(); // interrupted host-side (a voice turn)
          endAssistantTurn(undefined);
          collapseTurn(turnAnchor, Date.now() - turnStartedAt);
        } else resetThought();
        turnAnchor = null;
        setBusy(false);
        break;
      }
      case 'routing': {
        awaitingInterruptAck = false; // the new turn has started; nothing older can still arrive
        turnRoutedAgent = message.agentId || null;
        pendingEl.dataset.agent = message.agentId || '';
        if (currentTurnEl) currentTurnEl.dataset.agent = message.agentId || '';
        turnModelLabel = message.modelLabel || null;
        turnRoleName = message.roleName || null;
        resetThought();
        setBusy(true);
        break;
      }
      // The launcher's dock points at these two popups.
      // Each one toggles: the same button again closes it, another one switches to its popup.
      case 'openQueue':
        if (!queueModal.el.hidden) closeModal(queueModal.el);
        else { queuePinned = true; renderQueue(); openModal(queueModal); }
        break;
      case 'openHistory': if (toggleModal(historyModal)) vscode.postMessage({ type: 'requestHistory' }); break;
      case 'openSettings':
        if (toggleModal(settingsModal)) {
          vscode.postMessage({ type: 'requestFleet' });
          if (message.tab) chatSettings.showTab(message.tab);
        }
        break;
      case 'fleet': chatSettings.fleet(message); break;
      case 'cliStatus': chatSettings.cliStatus(message); break;
      case 'cliConnections':
        chatSettings.cliConnections(message);
        cliSetup.update(message);
        if (message.setupNeeded && !cliSetupSeen) { cliSetupSeen = true; openModal(cliSetupModal); }
        if (!message.setupNeeded && !cliSetupModal.el.hidden) closeModal(cliSetupModal.el);
        break;
      case 'modelPrompts': modelPromptIds = new Set(message.models || []); break;
      // Settings and the picker share discovered names. A restored chat keeps
      // its exact model even when that model is not currently favorited.
      case 'modelCatalog':
        window.MODEL_CATALOG = message.catalog;
        MODEL_OPTIONS.splice(1, MODEL_OPTIONS.length, ...message.catalog); // the menu re-renders each time it opens
        availableModels = message.available || [];
        selectModel(pendingModelId || activeModelId, { notifyExtension: Boolean(pendingModelId && optionFor(pendingModelId)) });
        if (menuOpen()) renderModelMenu();
        break;
      case 'schedulerQueue': {
        schedulerTasks = Array.isArray(message.queue) ? message.queue : [];
        renderQueueButton();
        if (!queueStrip.querySelector('.is-dragging')) renderTurnQueue();
        if (!queueModal.el.hidden && !queueModal.el.querySelector('textarea, .is-dragging')) renderQueue();
        break;
      }
      // A turn that didn't come from this composer (a scheduled prompt, Remote Control): your bubble.
      case 'undoOffer': offerUndo(Number(message.count) || 0); break;
      case 'droid': playDroid(message.kind); break;
      case 'verifyInfo': verifyCommand = message.command || ''; renderVerify(); break;
      case 'userMessage': {
        appendUserMessage(message.text || '', message.at || undefined, message.files || [], { scheduled: message.scheduled });
        break;
      }
      case 'taskScheduled': {
        pendingScheduleLabel = null;
        pendingScheduleWhen = '';
        renderScheduleTime();
        pulseQueueSaved();
        break;
      }
      case 'scheduleTaskFailed': {
        showToast(message.error || 'Could not schedule task.', { error: true });
        break;
      }
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'requestQuotas' });
  vscode.postMessage({ type: 'requestProject' });
  vscode.postMessage({ type: 'requestCliConnections' });
})();
