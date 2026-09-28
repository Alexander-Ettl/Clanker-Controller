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
  const MODEL_OPTIONS = [{ id: 'auto', agent: 'auto', label: 'Auto', hint: 'Routes each message' }, ...(window.MODEL_CATALOG || [])];
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

  const attachmentStrip = document.createElement('div');
  attachmentStrip.className = 'attachment-strip island-bud';
  document.querySelector('.compose-row').insertBefore(attachmentStrip, document.querySelector('.composer'));
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button'; attachBtn.id = 'attachBtn'; attachBtn.className = 'composer-icon-btn'; attachBtn.title = 'Attach files';
  attachBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  document.querySelector('.composer').insertBefore(attachBtn, promptInput);

  // ---------- P16-K: full-screen Liquid Glass modals (queue + history) ----------
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
  function openModal(modal) {
    lastFocus = document.activeElement;
    modal.el.hidden = false;
    modal.el.querySelector('.fs-modal-close').focus();
  }
  function closeModal(el) {
    if (el.hidden) return;
    el.hidden = true;
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
  // P17-X: a live 1s countdown to whichever task (any agent) fires first.
  function tickQueueCountdown() {
    const times = activeTasks().filter((task) => task.status === 'pending').map(fireTimeOf).filter(Boolean);
    const next = times.length ? Math.min(...times) : null;
    queueCountdown.textContent = next ? formatCountdown(next - Date.now()) : '';
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
    if (!count) closeModal(queueModal.el);
    if (count && pulseOnShow) { pulseOnShow = false; pulseQueueSaved(); }
  }
  // Persistence guarantee: pull the eye from the composer to the pill, confirm the disk write.
  function pulseQueueSaved() {
    if (queueBtn.hidden) { pulseOnShow = true; return; } // the queue broadcast lands right after taskScheduled
    queueBtn.classList.remove('is-saved');
    void queueBtn.offsetWidth; // restart the animation
    queueTip.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg><span>Saved to disk · survives a restart</span>';
    queueBtn.classList.add('is-saved');
    clearTimeout(pulseQueueSaved.timer);
    pulseQueueSaved.timer = setTimeout(() => {
      queueBtn.classList.remove('is-saved');
      pulseQueueSaved.timer = setTimeout(() => { queueTip.textContent = 'Queue'; }, 350); // after the tag sinks back
    }, 5000);
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
    remove.type = 'button'; remove.className = 'queue-delete'; remove.innerHTML = `${CLOSE_SVG}<span>Delete</span>`;
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
  const runningBadge = document.getElementById('runningBadge');
  let currentChatId = null;

  // ---------- P16-J: inline schedule toggle ----------
  // One input, not two: the composer's clock button arms "schedule instead
  // of send" for the next submit (Enter or the send arrow), queued for the
  // active model's next quota reset.
  const scheduleBtn = document.createElement('button');
  scheduleBtn.type = 'button'; scheduleBtn.id = 'scheduleBtn'; scheduleBtn.className = 'composer-icon-btn schedule-toggle';
  scheduleBtn.setAttribute('aria-pressed', 'false');
  scheduleBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 5.5v3l2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  document.querySelector('.composer-actions').insertBefore(scheduleBtn, sendBtn);

  const AGENT_LABELS = AGENT_NAMES;
  const DEFAULT_PLACEHOLDER = promptInput.placeholder;
  let scheduleArmed = false;
  let pendingScheduleLabel = null;
  // 'auto' has no quota of its own to wait for; scheduling needs a real model.
  // The picked provider; on Auto, whoever answered last in this chat (a "continue" must reach the same agent).
  function lastReplyAgent() {
    const agent = turnRoutedAgent || [...transcriptEl.querySelectorAll('.msg-assistant[data-agent], [data-agent]')].pop()?.dataset.agent;
    return AGENT_IDS.includes(agent) ? agent : null;
  }
  function scheduleModel() { return activeAgent === 'auto' ? lastReplyAgent() || 'claude' : activeAgent; }
  function setScheduleArmed(armed, { outOfUsage = false } = {}) {
    scheduleArmed = armed;
    scheduleBtn.classList.toggle('is-scheduled', armed);
    scheduleBtn.setAttribute('aria-pressed', String(armed));
    scheduleBtn.title = armed && outOfUsage
      ? `${AGENT_LABELS[scheduleModel()]} is out of usage, so messages are scheduled for its reset. Click to send now instead.`
      : armed ? 'Scheduling is on: the next message is queued instead of sent' : 'Schedule the next message for the next quota reset';
    document.querySelector('.composer').classList.toggle('is-scheduled', armed);
    promptInput.placeholder = armed
      ? `\u23F0 Schedule prompt for ${AGENT_LABELS[scheduleModel()]} (will auto-dispatch when quota resets)\u2026`
      : DEFAULT_PLACEHOLDER;
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
  function isLimitNotice(raw) {
    const text = String(raw || '').trim();
    return text.length > 0 && text.length <= 400 && LIMIT_RE.test(text);
  }
  function refreshScheduleDefault() {
    const outOfUsage = isOutOfUsage(scheduleModel());
    setScheduleArmed(scheduleChoice ?? outOfUsage, { outOfUsage: scheduleChoice === null && outOfUsage });
  }
  scheduleBtn.addEventListener('click', () => { scheduleChoice = !scheduleArmed; refreshScheduleDefault(); promptInput.focus(); });
  setScheduleArmed(false);

  function schedulePrompt(text) {
    const model = scheduleModel();
    pendingScheduleLabel = AGENT_LABELS[model];
    const modelId = activeAgent === model ? activeModelId : undefined;
    // resumeHere: it fires into this chat, with its context, not a fresh headless one.
    vscode.postMessage({ type: 'scheduleTask', task: { model, modelId, prompt: text, dispatchTrigger: 'quota-reset', resumeHere: true }, attachments: attachments.map((attachment) => attachment.path) });
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
  }
  // A composer chip (with remove) or, without onRemove, a sent bubble's read-only pill.
  function attachmentChip(attachment, onRemove) {
    const chip = document.createElement('div'); chip.className = 'attachment-chip';
    const isImage = attachment.mime?.startsWith('image/') && attachment.uri;
    const label = document.createElement('span');
    const name = document.createElement('span'); name.className = 'attachment-name'; name.textContent = attachment.name;
    const meta = document.createElement('span'); meta.className = 'attachment-meta';
    meta.textContent = isImage ? (attachment.dims || '') : formatSize(attachment.size);
    label.append(name, meta);
    if (isImage) {
      const image = document.createElement('img'); image.src = attachment.uri; image.alt = '';
      if (!attachment.dims) image.addEventListener('load', () => { attachment.dims = `${image.naturalWidth}×${image.naturalHeight}`; meta.textContent = attachment.dims; }, { once: true });
      chip.appendChild(image);
      chip.classList.add('is-previewable');
      chip.title = `Preview ${attachment.name}`;
      chip.addEventListener('click', () => openLightbox(attachment.uri, `${attachment.name}  ${attachment.dims || ''}`.trim()));
    }
    chip.append(label);
    if (onRemove) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = `Remove ${attachment.name}`;
      remove.addEventListener('click', (event) => { event.stopPropagation(); onRemove(); });
      chip.append(remove);
    }
    return chip;
  }
  function readAttachment(file) {
    const reader = new FileReader();
    reader.onload = () => vscode.postMessage({ type: 'attachmentData', name: file.name || `paste-${Date.now()}.png`, mime: file.type || 'application/octet-stream', data: reader.result });
    reader.readAsDataURL(file);
  }
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachments' }));
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
    const pool = activeAgent === 'auto' ? slashCommands : slashCommands.filter((command) => (command.agent || 'codex') === activeAgent);
    slashHits = pool.map((command) => [command, slashScore(command, match[1])]).filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 50).map(([command]) => command);
    slashIndex = Math.min(slashIndex, Math.max(0, slashHits.length - 1));
    slashMenu.replaceChildren(...slashHits.map((command, i) => {
      const item = document.createElement('div');
      item.className = 'mention-item' + (i === slashIndex ? ' is-active' : '');
      item.setAttribute('role', 'option');
      const name = document.createElement('span'); name.className = 'mention-name'; name.textContent = `/${command.name}`;
      const description = document.createElement('span'); description.className = 'model-option-hint'; description.textContent = `${AGENT_LABELS[command.agent] || 'Codex'}${command.description ? ` · ${command.description}` : ''}`;
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

  const optionFor = (id) => MODEL_OPTIONS.find((option) => option.id === id);
  const brandOf = (option) => option.agent; // one mark and accent per company: Opus looks like any Claude model
  const iconFor = (brand) => (brand === 'auto' ? AUTO_ICON : AGENT_ICONS[brand] || '');
  function quotaText(agent) {
    const quota = lastQuotas[agent];
    return typeof quota?.remaining === 'number' ? `${Math.round(quota.remaining)}% ${quota.windowLabel || ''}`.trim() : '';
  }

  function selectModel(modelId, { notifyExtension = true } = {}) {
    const option = optionFor(modelId);
    if (!option) return;
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
    if (notifyExtension) vscode.postMessage({ type: 'setModel', modelId: option.id });
  }

  // An agent chosen from outside the picker (voice routing): keep the current
  // model if it already runs on that agent, else that agent's first model.
  function selectAgent(agentId) {
    if (agentId === activeAgent) return;
    const option = MODEL_OPTIONS.find((candidate) => candidate.agent === agentId);
    if (option) selectModel(option.id, { notifyExtension: false });
  }

  function renderModelMenu() {
    const groups = [['auto', MODEL_OPTIONS.filter((option) => option.agent === 'auto')], ...AGENT_IDS.map((agent) => [agent, MODEL_OPTIONS.filter((option) => option.agent === agent)])];
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
        item.addEventListener('click', () => { selectModel(option.id); closeModelMenu(); });
        group.appendChild(item);
      }
      modelMenu.appendChild(group);
    }
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
  // when a turn ends on its own; a Stop pauses the queue instead.
  const SEND_SVG = sendBtn.innerHTML;
  const QUEUE_SVG = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6.5 13V4.5M3 8l3.5-3.5L10 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 9.5v4M10.5 11.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const STOP_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.75" fill="currentColor"/></svg>';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button'; stopBtn.id = 'stopBtn'; stopBtn.className = 'composer-icon-btn stop-btn'; stopBtn.title = 'Stop'; stopBtn.hidden = true;
  stopBtn.setAttribute('aria-label', 'Stop the running turn');
  stopBtn.innerHTML = STOP_SVG;
  composerActions.insertBefore(stopBtn, sendBtn);

  let busy = false;
  let isCompacting = false;
  let queuePaused = false;
  let awaitingInterruptAck = false; // the host's turn_complete for a turn this window already closed out
  let turnQueue = []; // { id, text, modelId, attachments }

  function renderComposerState() {
    const queueing = busy && !scheduleArmed && Boolean(promptInput.value.trim());
    stopBtn.hidden = !busy;
    sendBtn.hidden = busy && !queueing && !scheduleArmed;
    if (sendBtn.classList.contains('is-queue') !== queueing) {
      sendBtn.classList.toggle('is-queue', queueing);
      sendBtn.innerHTML = queueing ? QUEUE_SVG : SEND_SVG;
    }
    sendBtn.title = queueing ? 'Queue for after this turn (Enter). Ctrl+Enter sends now.' : 'Send';
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
  pendingEl.innerHTML = '<span class="pending-orb" aria-hidden="true"></span><span class="pending-label">Thinking</span><span class="pending-time" aria-hidden="true"></span><span class="pending-tokens"></span><span class="pending-thought"></span>';
  const pendingTime = pendingEl.querySelector('.pending-time');
  const pendingTokens = pendingEl.querySelector('.pending-tokens');
  const pendingThought = pendingEl.querySelector('.pending-thought');
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
    const show = busy && Boolean(last) && last !== currentAssistantBubble && !last.matches('.approval-card, .question-card');
    if (show && turnHost().lastElementChild !== pendingEl) { turnHost().appendChild(pendingEl); scrollTranscriptToEnd(); }
    else if (!show && pendingEl.isConnected) pendingEl.remove();
  }
  new MutationObserver(syncPending).observe(transcriptEl, { childList: true, subtree: true });

  let lastTurn = null; // P17-I: what an upstream_error card's Retry resends
  function dispatchTurn(turn) {
    lastTurn = turn;
    if (turn.modelId !== activeModelId) selectModel(turn.modelId);
    appendUserMessage(turn.text, undefined, turn.files);
    setBusy(true);
    vscode.postMessage({ type: 'send', modelId: turn.modelId, text: turn.text, attachments: turn.attachments, submit: true });
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
    remove: queueSvg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    unschedule: queueSvg('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h6.75a4 4 0 0 1 0 8H7"/>'),
    grip: queueSvg('<path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" stroke-width="2"/>'),
  };

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

  function renderTurnQueue() {
    queueStrip.hidden = !turnQueue.length;
    queueStrip.replaceChildren();
    if (!turnQueue.length) return;
    const head = document.createElement('div');
    head.className = 'turn-queue-head';
    const title = document.createElement('span');
    title.textContent = queuePaused ? `${turnQueue.length} queued · paused` : `${turnQueue.length} queued · sends after this turn`;
    head.append(title);
    if (queuePaused) {
      const resume = document.createElement('button');
      resume.type = 'button'; resume.className = 'turn-queue-btn is-primary'; resume.textContent = 'Resume';
      resume.addEventListener('click', () => {
        queuePaused = false;
        if (!busy && turnQueue.length) dispatchTurn(turnQueue.shift());
        renderTurnQueue();
      });
      head.append(resume);
    }
    queueStrip.append(head);
    for (const turn of turnQueue) {
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
      const remove = () => { turnQueue = turnQueue.filter((item) => item !== turn); renderTurnQueue(); };
      row.append(pill, text);
      if (turn.files?.length) row.append(queuedFilesBadge(turn.files));
      row.append(
        button(QUEUE_ICONS.steer, 'Steer Now', busy ? 'Interrupt the running turn and send this now' : 'Send this now', 'is-primary', () => { remove(); queuePaused = false; renderTurnQueue(); steerTurn(turn); }),
        button(QUEUE_ICONS.edit, 'Edit', 'Move back into the composer', '', () => {
          remove();
          promptInput.value = promptInput.value.trim() ? `${promptInput.value}\n${turn.text}` : turn.text;
          // The queued files come back with the text (they were dropped here before).
          const held = new Set(attachments.map((attachment) => attachment.path));
          attachments.push(...(turn.files || []).filter((file) => !held.has(file.path)));
          renderAttachments();
          autoGrow(); renderComposerState(); promptInput.focus();
        }),
        button(QUEUE_ICONS.remove, '', 'Delete', 'is-danger is-icon', () => {
          for (const file of turn.files || []) vscode.postMessage({ type: 'removeAttachment', path: file.path }); // as a composer chip's ×
          remove();
        }));
      queueStrip.append(row);
    }
  }

  function sendPrompt({ steer = false } = {}) {
    const text = promptInput.value.trim();
    if (!text) return;
    // A panel command, not a turn: hands this chat's Claude session to the phone (see extension.js).
    if (/^\/(remote-control|rc)(\s|$)/i.test(text)) {
      vscode.postMessage({ type: 'remoteControl' });
      promptInput.value = '';
      closeSlashMenu(); autoGrow(); renderComposerState();
      return;
    }
    flushVoiceDraft(text);
    const turn = { id: `${Date.now()}-${turnQueue.length}`, text, modelId: activeModelId, attachments: attachments.map((attachment) => attachment.path), files: attachments.slice() };
    if (scheduleArmed) {
      schedulePrompt(text);
      scheduleChoice = null;
      refreshScheduleDefault(); // stays on while the model is out of usage, so the next prompt queues too
    } else if (busy && !steer) {
      turnQueue.push(turn);
      renderTurnQueue();
    } else {
      steerTurn(turn);
    }
    attachments = [];
    renderAttachments();
    mentioned.clear();
    renderMentions();
    promptInput.value = '';
    closeSlashMenu();
    autoGrow();
    renderComposerState();
  }

  sendBtn.addEventListener('click', () => sendPrompt());
  stopBtn.addEventListener('click', () => { stopTurn(); promptInput.focus(); });
  scheduleBtn.addEventListener('click', renderComposerState);
  promptInput.addEventListener('input', renderComposerState);

  promptInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendPrompt({ steer: event.ctrlKey || event.metaKey });
    }
  });

  micBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'micToggle' });
  });

  // ---------- P17-ZA: live mic meter in the composer ----------
  // A scrolling level history: every WAVE_STEP_MS the loudest RMS since the last
  // step enters on the right, so each syllable becomes a spike that glides left and
  // leaves after ~2s. Below the noise gate the line stays perfectly flat.
  // Stop squeezes the bars into a shimmer beam while Whisper runs; the draft then
  // fades in where the beam was. Bars animate height (round pill caps), the scroll is a transform.
  const WAVE_BARS = 24;
  const voiceOverlay = document.createElement('div');
  voiceOverlay.id = 'composerVoiceOverlay'; voiceOverlay.className = 'voice-overlay'; voiceOverlay.hidden = true;
  voiceOverlay.setAttribute('aria-hidden', 'true');
  const waveBars = Array.from({ length: WAVE_BARS }, () => { const bar = document.createElement('span'); bar.className = 'waveform-bar'; return bar; });
  voiceOverlay.append(...waveBars);
  composerEl.appendChild(voiceOverlay);
  const WAVE_STEP_MS = 90; // ~2.16s speech history across 24 columns
  const waveHeights = new Float32Array(WAVE_BARS); // 0..1 per bar, index 0 = oldest (left)
  let micLevel = 0; // peak speech level since last step
  let micLevelSum = 0; // accumulator for average
  let micLevelSamples = 0; // count of volume events in window
  let micLevelAt = 0;
  let waveFrame = 0;
  let waveShiftAt = 0;
  let wavePitch = 0;
  let lastVoiceDraft = null; // { original, raw }: what the transcript said, to learn from the user's fixes
  const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
  function waveStep(now) {
    if (!waveShiftAt) waveShiftAt = now;
    let heightsChanged = false;
    while (now - waveShiftAt >= WAVE_STEP_MS) {
      waveShiftAt += WAVE_STEP_MS;
      const fresh = now - micLevelAt < 300;
      const average = micLevelSamples ? micLevelSum / micLevelSamples : 0;
      const target = fresh ? micLevel * 0.68 + average * 0.32 : 0;
      const previous = waveHeights[WAVE_BARS - 1];
      const response = target > previous ? 0.78 : 0.38;
      const level = previous + (target - previous) * response;
      micLevel = 0; micLevelSum = 0; micLevelSamples = 0;
      waveHeights.copyWithin(0, 1);
      waveHeights[WAVE_BARS - 1] = level < 0.025 ? 0 : level;
      heightsChanged = true;
    }
    // Between steps every bar glides one pitch left, so the history scrolls instead of ticking.
    const frac = (now - waveShiftAt) / WAVE_STEP_MS;
    const shift = (-frac * wavePitch).toFixed(2);
    for (let i = 0; i < WAVE_BARS; i++) {
      const pos = i - frac; // continuous across steps, so edge fades never jump
      waveBars[i].style.transform = `translateX(${shift}px)`;
      if (heightsChanged) waveBars[i].style.height = `${(6 + 22 * waveHeights[i]).toFixed(1)}px`;
      waveBars[i].style.opacity = Math.max(0, Math.min(1, pos + 0.35, WAVE_BARS - 0.65 - pos)).toFixed(2);
    }
    waveFrame = requestAnimationFrame(waveStep);
  }
  function setVoiceState(state) {
    const recording = state === 'recording';
    const processing = state === 'processing';
    cancelAnimationFrame(waveFrame);
    if (recording) {
      voiceOverlay.hidden = false;
      micLevelAt = 0; micLevel = 0; micLevelSum = 0; micLevelSamples = 0; waveShiftAt = 0;
      waveHeights.fill(0);
      wavePitch = waveBars.length > 1 ? waveBars[1].offsetLeft - waveBars[0].offsetLeft : 0;
      if (!REDUCED_MOTION.matches) waveFrame = requestAnimationFrame(waveStep);
    }
    if (processing) {
      waveBars.forEach((bar) => { bar.style.transform = ''; bar.style.opacity = ''; bar.style.height = ''; }); // CSS collapses them to the 4px baseline
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

  queueBtn.addEventListener('click', () => { renderQueue(); openModal(queueModal); });
  newChatBtn.addEventListener('click', () => { attachments = []; renderAttachments(); vscode.postMessage({ type: 'newChat' }); });
  historyBtn.addEventListener('click', () => { vscode.postMessage({ type: 'requestHistory' }); openModal(historyModal); });
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
    if (!subagents.has(id)) subagents.set(id, { id, description: '', subagentType: 'agent', status: 'running', lastAt: at, events: [] });
    return subagents.get(id);
  }

  function applySubagent(message) {
    if (message.type === 'subagent_settle') { settleAgents(message.interrupted); return; } // a replayed turn end
    const at = message.at || Date.now();
    const agent = agentFor(message.id, at);
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
    agentLog = null;
    agentPane.textContent = '';
    closeModal(agentsModal.el);
    refreshAgents();
  }

  function refreshAgents() {
    const all = [...subagents.values()];
    const working = all.filter(agentWorking);
    agentsBtn.hidden = !all.length;
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

  function renderAgentTabs() {
    const all = [...subagents.values()];
    if (agentTabs.children.length !== all.length) {
      agentTabs.textContent = '';
      for (const agent of all) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'agents-tab';
        tab.setAttribute('role', 'tab');
        tab.innerHTML = '<span class="agents-dot"></span><span class="agents-tab-name"></span>';
        tab.addEventListener('click', () => showAgent(agent.id));
        agentTabs.appendChild(tab);
      }
    }
    all.forEach((agent, index) => {
      const tab = agentTabs.children[index];
      const state = agentState(agent);
      tab.setAttribute('aria-selected', String(agent.id === shownAgentId));
      tab.title = state.text;
      tab.querySelector('.agents-dot').className = `agents-dot ${state.cls}`;
      tab.querySelector('.agents-tab-name').textContent = agentName(agent);
    });
    const shown = subagents.get(shownAgentId);
    const head = agentPane.querySelector('.agents-head');
    if (shown && head) {
      const state = agentState(shown);
      head.querySelector('.agents-dot').className = `agents-dot ${state.cls}`;
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
    head.innerHTML = '<span class="agents-dot"></span><span class="agents-type"></span><span class="agents-status"></span><span class="agents-steps"></span>';
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
    const all = [...subagents.values()];
    if (!subagents.has(shownAgentId)) shownAgentId = (all.find(agentWorking) || all[all.length - 1])?.id || null;
    openModal(agentsModal);
    if (shownAgentId) showAgent(shownAgentId);
    refreshAgents();
  });

  // ---------- Transcript ----------

  function clearEmptyState() {
    const empty = transcriptEl.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  // P17-E: streaming output only follows the tail while the reader is already
  // there; scrolling up to read earlier output is never yanked back down.
  // Only an upward scroll that ends away from the bottom lets go of the tail;
  // a burst of output landing between our scroll and its scroll event never does.
  let stickToEnd = true;
  let lastScrollTop = 0;
  function isTranscriptNearBottom(threshold = 80) {
    return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight <= threshold;
  }
  transcriptEl.addEventListener('scroll', () => {
    const top = transcriptEl.scrollTop;
    if (isTranscriptNearBottom()) stickToEnd = true;
    else if (top < lastScrollTop) stickToEnd = false;
    lastScrollTop = top;
  }, { passive: true });
  function scrollTranscriptToEnd(force = false) {
    if (!force && !stickToEnd) return;
    stickToEnd = true;
    requestAnimationFrame(() => { transcriptEl.scrollTop = transcriptEl.scrollHeight; });
  }
  // P17-N: content that grows after the scroll (code highlighting, KaTeX,
  // images decoding, a turn collapsing) re-pins the tail while stuck to it.
  const pinToEnd = new ResizeObserver(() => { if (stickToEnd) transcriptEl.scrollTop = transcriptEl.scrollHeight; });
  const observeTail = () => {
    pinToEnd.disconnect();
    pinToEnd.observe(transcriptEl); // the composer growing shrinks the viewport too
    for (const el of transcriptEl.children) pinToEnd.observe(el);
  };
  observeTail();
  new MutationObserver(observeTail).observe(transcriptEl, { childList: true });
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
    row.append(time, iconAction(COPY_ICON, 'Copy', (btn) => copyText(btn, getText())), ...extra);
    return row;
  }

  // Your message: hovering shows time, Copy, and Revert. Revert forks the
  // chat just before this message and puts the message back in the composer.
  // The goo that fuses your bubble and its dock: blur, sharpen the alpha into one
  // liquid silhouette, then draw the untouched original back on top (text stays crisp).
  document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><filter id="msg-goo" x="-10%" y="-10%" width="120%" height="130%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/><feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo"/><feComposite in="SourceGraphic" in2="goo" operator="atop"/></filter><filter id="tip-goo" filterUnits="userSpaceOnUse" x="-320" y="-40" width="420" height="140" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/><feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo"/><feComposite in="SourceGraphic" in2="goo" operator="atop"/></filter></svg>'); // tip-goo: same goo, a wide fixed region for a tag hanging off a 32px button

  // P17-K: a prompt longer than three lines clamps behind a fade with a Show more / Show less toggle.
  function clampUserBubble(bubble, body) {
    const line = parseFloat(getComputedStyle(body).lineHeight) || 20;
    if (body.scrollHeight <= line * 3 + 4) return;
    bubble.classList.add('is-clamped');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'msg-clamp-toggle';
    toggle.textContent = 'Show more';
    toggle.addEventListener('click', () => {
      const expanded = bubble.classList.toggle('is-expanded');
      toggle.textContent = expanded ? 'Show less' : 'Show more';
    });
    bubble.appendChild(toggle);
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
    group.append(bubble, messageActions(at, () => text, [revert]));
    const turn = document.createElement('div');
    turn.className = 'turn';
    turn.appendChild(group);
    transcriptEl.appendChild(turn); // always top level, never inside the previous turn
    clampUserBubble(bubble, body);
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
  const LIMIT_RE = /\b(usage|session|weekly|daily|rate)\s+limit\b|hit your .{0,24}limit|limit (reached|exceeded)|quota (exceeded|exhausted)|exhausted (your|the) .{0,24}(quota|limit)|RESOURCE_EXHAUSTED|out of (usage|credits)/i;
  let turnRoutedAgent = null; // who ran the current turn (set by 'routing')
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
    if (last && !last.querySelector('.msg-actions')) last.append(messageActions(at, () => last.dataset.raw.trim()));
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
  const SHELL_TOOLS = /^(bash|powershell|shell|run_command)$/i;
  const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|write_to_file|replace_file_content)$/i;
  function toolKind(name) {
    if (SHELL_TOOLS.test(name || '')) return 'shell';
    if (EDIT_TOOLS.test(name || '')) return 'edit';
    if (/^(glob|grep|grep_search|find_by_name)$/i.test(name || '')) return 'search';
    if (/^(read|view_file|list_dir)$/i.test(name || '')) return 'read';
    return 'other';
  }
  const TOOL_ICONS = {
    shell: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5 6.5 8 3 11.5M8 11.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: PENCIL_SVG,
    search: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.5"/><path d="m10.2 10.2 3.3 3.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    read: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 8S4.25 3.5 8 3.5 14.25 8 14.25 8 11.75 12.5 8 12.5 1.75 8 1.75 8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/></svg>',
    other: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 5.5v3l2 1.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
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
    icon.innerHTML = TOOL_ICONS[kind];
    const tool = document.createElement('span');
    tool.className = 'tool-name';
    tool.textContent = kind === 'shell' ? 'Run' : kind === 'edit' ? 'Edit' : name || 'Tool';
    const label = document.createElement('span');
    label.className = 'tool-label';
    label.title = command || '';
    // A file path reads like the Explorer: the name up front, its folder dimmed after it.
    const path = (kind === 'read' || kind === 'edit') && /^[^\s"]+$/.test(command || '') ? command.match(/^(.*[\\/])?([^\\/]+)$/) : null;
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
    pill.textContent = tool || 'a tool';
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
      vscode.postMessage({ type: 'approvalResponse', approved, always, actionId });
      pendingCards.delete(actionId);
      settleCard(card, approved ? (always ? 'Allowed for this session' : 'Allowed') : 'Denied', approved ? 'allowed' : 'denied');
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
    const card = document.createElement('div');
    card.className = 'question-card';
    card.dataset.actionId = actionId;
    const answers = new Map();
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'approval-btn approval-approve question-submit';
    submit.textContent = 'Send answer';
    const refresh = () => { submit.disabled = questions.some((q) => !(answers.get(q.question) || []).length); };

    const head = document.createElement('div');
    head.className = 'approval-head';
    head.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M6.4 6.3a1.7 1.7 0 1 1 2.4 1.6c-.5.2-.8.6-.8 1.1v.3M8 11.2v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const title = document.createElement('span');
    title.className = 'approval-title';
    title.textContent = `${AGENT_TITLES[agent] || 'The agent'} has a question`;
    head.appendChild(title);
    card.appendChild(head);

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
      list.className = 'question-options';
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
        const l = document.createElement('span');
        l.className = 'question-option-label';
        l.textContent = opt.label;
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
      card.appendChild(block);
      if (qi === 0) queueMicrotask(() => list.querySelector('.question-option')?.focus({ preventScroll: true }));
    });

    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'approval-btn approval-reject';
    skip.textContent = 'Skip';
    actions.append(submit, skip);
    card.appendChild(actions);
    submit.addEventListener('click', () => {
      const payload = Object.fromEntries(questions.map((q) => [q.question, (answers.get(q.question) || []).join(', ')]));
      vscode.postMessage({ type: 'questionResponse', actionId, answers: payload });
      pendingCards.delete(actionId);
      settleCard(card, `Answered: ${Object.values(payload).join(' \u00b7 ')}`, 'allowed');
      promptInput.focus();
    });
    skip.addEventListener('click', () => {
      vscode.postMessage({ type: 'approvalResponse', approved: false, actionId });
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
  // Every model in the picker runs a 1M-token window (Opus 5.5 and Sonnet 5 per Anthropic's model table; Gemini's is 2^20).
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
  const COMPACT_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5 8 6l4-3.5M4 13.5 8 10l4 3.5"/></svg>';
  // The history stays on screen; only a quiet divider marks the hidden handoff.
  function appendCompactDivider(auto) {
    const divider = document.createElement('div');
    divider.className = 'compact-divider';
    divider.innerHTML = COMPACT_SVG;
    divider.append(auto ? 'Context auto-compacted' : 'Context compacted');
    transcriptEl.appendChild(divider);
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
    try { vscode.setState({ ...(vscode.getState() || {}), chatId: chat.id }); } catch {} // reopened here after a restart
    turnRoutedAgent = null; // the restored transcript's own last reply says who answered here
    isCompacting = Boolean(running?.compact);
    renderContextGauge(chat.context);
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
        if (hiddenCompactTurn) { appendCompactDivider(message.auto); return; }
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
    scheduleChoice = null; // a new chat starts from its own model's usage, not the last chat's clock pick
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
    if (!transcriptEl.childElementCount) transcriptEl.innerHTML = '<div class="empty-state"><p>Start a new conversation.</p></div>';
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

  const STATE_LABELS = { running: 'Running', waiting: 'Needs input' };
  function renderHistory(sessions) {
    const list = sessions || [];
    const working = list.filter((session) => session.state).length;
    runningBadge.hidden = !working;
    runningBadge.textContent = String(working);
    historyBtn.title = working ? `${working} chat${working === 1 ? '' : 's'} running` : 'Manage chats';
    historyModal.count.textContent = String(list.length);
    historyModal.body.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'fs-modal-empty';
      empty.textContent = 'No conversations yet.';
      historyModal.body.append(empty);
      return;
    }
    const active = list.filter((session) => session.active);
    const rest = list.filter((session) => !session.active);
    if (active.length) historyModal.body.append(historySection('Active Chats', active));
    if (rest.length) historyModal.body.append(historySection(active.length ? 'Chat History' : '', rest));
  }

  const CHAT_ICONS = {
    stop: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor"/></svg>',
    rename: PENCIL_SVG,
    // The Source Control mark: one trunk, one branch splitting off, a node on each end.
    fork: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.6-2 3.4-4.3 3.9-1.5.3-2.7.7-2.7 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    delete: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.4M6.75 7v4M9.25 7v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
      card.className = `history-card${session.state ? ` is-${session.state}` : ''}${session.id === currentChatId ? ' is-current' : ''}`;
      card.dataset.id = session.id;
      const head = document.createElement('div');
      head.className = 'queue-card-head';
      if (session.state || session.id === currentChatId) {
        const status = document.createElement('span');
        status.className = 'history-status';
        status.textContent = [STATE_LABELS[session.state], session.id === currentChatId ? 'This window' : ''].filter(Boolean).join(' · ');
        head.append(status);
      }
      for (const model of session.models || []) head.append(modelPill(model));
      const when = document.createElement('time');
      when.className = 'queue-time';
      when.dateTime = session.updatedAt || '';
      when.textContent = formatWhen(session.updatedAt);
      const count = document.createElement('span');
      count.className = 'history-count';
      count.textContent = `${session.messageCount || 0} message${session.messageCount === 1 ? '' : 's'}`;
      head.append(when, count);
      const preview = document.createElement('div');
      preview.className = 'queue-prompt history-preview';
      preview.textContent = session.preview || 'New chat';
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
      action('rename', 'Rename', () => editTitle(preview, session.preview || '', (title) => vscode.postMessage({ type: 'renameChat', id: session.id, title })));
      action('fork', 'Fork into a new chat', () => { vscode.postMessage({ type: 'forkChat', id: session.id }); closeModal(historyModal.el); });
      action('delete', 'Delete', () => { card.classList.add('is-leaving'); vscode.postMessage({ type: 'deleteChat', id: session.id }); }, 'is-danger');
      head.append(actions);
      // The whole card opens the chat; whatever runs in the current one keeps going in the background.
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Open chat: ${session.preview || 'New chat'}`);
      const open = () => {
        if (session.id !== currentChatId) vscode.postMessage({ type: 'restoreChat', id: session.id });
        closeModal(historyModal.el);
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (event) => {
        if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); }
      });
      card.append(head, preview);
      wrap.append(card);
    }
    section.append(wrap);
    return section;
  }


  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'attachmentSaved': { attachments.push(message.attachment); renderAttachments(); break; }
      case 'history': {
        // A rename in progress would lose its text to a live refresh; its own save refreshes again.
        if (!historyModal.body.querySelector('input')) renderHistory(message.sessions);
        break;
      }
      case 'editorTheme': editorTheme = message.theme; void applyEditorTheme(); break;
      case 'chatLoaded': {
        // Whatever ran in the previous thread keeps going in the background;
        // queued turns belonged to that thread.
        flushVoiceDraft(promptInput.value.trim());
        awaitingInterruptAck = false; queuePaused = false; turnQueue = [];
        renderTurnQueue();
        busy = false;
        resetThought();
        resetAgents(); // the new chat's own agents follow in a subagentReplay
        restoreChat(message.chat, message.running);
        setBusy(Boolean(message.running));
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
            ? `Recording${message.device ? ` from ${message.device}` : ''}\u2026 click to stop`
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
        micLevel = Math.max(micLevel, level);
        micLevelSum += level;
        micLevelSamples += 1;
        micLevelAt = performance.now();
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
      // Files dropped in, or sent here from the Explorer's "Add to AI Chat".
      case 'insertMentions': {
        for (const file of message.paths || []) insertMention(file, false);
        promptInput.focus();
        break;
      }
      case 'prefillPrompt': {
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
        promptInput.value = promptInput.value.trim() ? `${promptInput.value}\n${text}` : text;
        attachments.push(...files);
        renderAttachments();
        autoGrow(); renderComposerState(); promptInput.focus();
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
      case 'subagentReplay': for (const event of message.events || []) applySubagent(event); break;
      case 'delta': {
        if (isCompacting) {
          if (/^(Gemini|Codex) error:/i.test(message.text || '')) appendNotice(message.text);
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
      case 'binary_missing': {
        appendBinaryMissingCard({ agent: message.agent, checked: Array.isArray(message.checked) ? message.checked : [] });
        break;
      }
      case 'compacting': {
        // The handoff streams invisibly; the transcript only gets this divider.
        isCompacting = true;
        currentAssistantBubble = null;
        currentTurnEl = null;
        turnAnchor = null;
        appendCompactDivider(message.auto);
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
        settleAgents(Boolean(message.interrupted));
        if (awaitingInterruptAck) { awaitingInterruptAck = false; isCompacting = false; break; } // already closed out by Stop / Steer Now
        const completedCompaction = isCompacting;
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
          endAssistantTurn();
          collapseTurn(turnAnchor, Date.now() - turnStartedAt);
        } else resetThought();
        turnAnchor = null;
        setBusy(false);
        if (!message.interrupted && !message.compacting && !queuePaused && turnQueue.length) { dispatchTurn(turnQueue.shift()); renderTurnQueue(); }
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
      case 'schedulerQueue': {
        schedulerTasks = Array.isArray(message.queue) ? message.queue : [];
        renderQueueButton();
        if (!queueModal.el.hidden && !queueModal.el.querySelector('textarea, .is-dragging')) renderQueue();
        break;
      }
      // A turn that didn't come from this composer (a scheduled prompt, Remote Control): your bubble.
      case 'userMessage': {
        appendUserMessage(message.text || '', message.at || undefined, [], { scheduled: message.scheduled });
        break;
      }
      case 'taskScheduled': {
        showScheduleBud(`Scheduled for ${pendingScheduleLabel || 'the agent'}: sends when its usage limit resets`);
        pendingScheduleLabel = null;
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
})();
