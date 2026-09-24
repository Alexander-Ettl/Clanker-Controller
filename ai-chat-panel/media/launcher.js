(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const newChatWindowBtn = document.getElementById('newChatWindowBtn');
  const historyList = document.getElementById('historyList');
  const scheduledList = document.getElementById('scheduledList');
  const tabs = document.querySelectorAll('.launcher-tab');
  const panels = { recent: document.getElementById('recentPanel'), scheduled: document.getElementById('scheduledPanel'), settings: document.getElementById('settingsPanel') || document.getElementById('systemPanel') };
  const modelCards = document.getElementById('modelCards');
  const ICONS = window.AGENT_ICONS || {};
  const names = window.AGENT_NAMES || { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity', opus: 'Claude Opus 5.5' };

  let activeTab = 'recent';
  let lastQueue = [];
  let lastQuotas = null;

  newChatWindowBtn.addEventListener('click', () => vscode.postMessage({ type: 'newChatWindow' }));
  const siteSetupBtn = document.getElementById('siteSetupBtn');
  const sitePromptBtn = document.getElementById('sitePromptBtn');
  siteSetupBtn?.addEventListener('click', () => vscode.postMessage({ type: 'setupSite' }));
  sitePromptBtn?.addEventListener('click', () => vscode.postMessage({ type: 'copySitePrompt' }));
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'siteSetup') return;
    siteSetupBtn.hidden = event.data.ready; // shown with no folder too: the click explains what to open
    sitePromptBtn.hidden = !event.data.ready;
  });
  vscode.postMessage({ type: 'requestSiteSetup' });

  function setTab(tab) {
    if (!panels[tab] || tab === activeTab) return;
    activeTab = tab;
    for (const btn of tabs) btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
    for (const [id, panel] of Object.entries(panels)) panel.hidden = id !== tab;
    if (tab === 'scheduled') vscode.postMessage({ type: 'requestSchedulerQueue' });
    if (tab === 'settings' || tab === 'system') vscode.postMessage({ type: 'requestFleet' });
  }
  for (const btn of tabs) btn.addEventListener('click', () => setTab(btn.dataset.tab));

  // ---------- Settings tab (Fleet, Telegram, Tunnel, Preferences) ----------
  const fleetList = document.getElementById('fleetList');
  const pingClisBtn = document.getElementById('pingClisBtn');
  const telegramDot = document.getElementById('telegramDot');
  const telegramDesc = document.getElementById('telegramDesc');
  const configureTelegramBtn = document.getElementById('configureTelegramBtn');
  const testTelegramBtn = document.getElementById('testTelegramBtn');
  const disconnectTelegramBtn = document.getElementById('disconnectTelegramBtn');
  const tunnelDot = document.getElementById('tunnelDot');
  const tunnelDesc = document.getElementById('tunnelDesc');
  const toggleTunnelBtn = document.getElementById('toggleTunnelBtn');
  const formatPills = document.querySelectorAll('.format-pill');
  const openTerminalBtn = document.getElementById('openTerminalBtn');
  const CLI_NAMES = { claude: 'claude', codex: 'codex', gemini: 'agy' };
  function systemRow(state, title, detail, hint = '') {
    const row = document.createElement('div');
    row.className = 'system-row';
    const dot = document.createElement('span');
    dot.className = `system-dot is-${state}`; // ok | warn | off
    const text = document.createElement('div');
    text.className = 'system-text';
    const name = document.createElement('span'); name.className = 'system-name'; name.textContent = title;
    const sub = document.createElement('span'); sub.className = 'system-detail'; sub.textContent = detail;
    text.append(name, sub);
    row.append(dot, text);
    if (hint) row.title = hint;
    return row;
  }
  function renderFleet({ models = [], clis = {}, services = {}, pinged = false }) {
    const cliState = (agent) => {
      const cli = clis[agent] || {};
      if (!cli.path) return ['off', `${CLI_NAMES[agent]} not found`];
      if (pinged && cli.version === null) return ['warn', `${CLI_NAMES[agent]} found, but --version failed`];
      return ['ok', cli.version || `${CLI_NAMES[agent]} ready`];
    };
    if (fleetList) {
      fleetList.replaceChildren(
        systemRow('ok', 'Auto', 'Routes each prompt by role and remaining quota'),
        ...models.map((m) => {
          const [state, cliText] = cliState(m.agent);
          return systemRow(state, m.label, `${m.model || m.agent}${m.effort ? ` · ${m.effort}` : ''} · ${cliText}`, clis[m.agent]?.path || '');
        }),
      );
    }

    // 1. Telegram Bridge state
    if (telegramDot && telegramDesc && configureTelegramBtn) {
      const tg = services.telegram || {};
      const isTgConfigured = typeof tg === 'boolean' ? tg : tg.configured;
      if (isTgConfigured) {
        telegramDot.className = 'system-dot is-ok';
        const mode = tg.mode === 'webhook' ? 'live webhook' : 'long-polling';
        telegramDesc.textContent = `Connected (Chat ID: ${tg.maskedChatId || 'linked'}) · ${mode}`;
        configureTelegramBtn.textContent = 'Edit';
        if (testTelegramBtn) testTelegramBtn.style.display = 'inline-block';
        if (disconnectTelegramBtn) disconnectTelegramBtn.style.display = 'inline-block';
      } else {
        telegramDot.className = 'system-dot is-off';
        telegramDesc.textContent = 'Not configured. Receive mobile task alerts & approvals.';
        configureTelegramBtn.textContent = 'Configure';
        if (testTelegramBtn) testTelegramBtn.style.display = 'none';
        if (disconnectTelegramBtn) disconnectTelegramBtn.style.display = 'none';
      }
    }

    // 2. Cloudflare Tunnel state
    if (tunnelDot && tunnelDesc && toggleTunnelBtn) {
      const tn = typeof services.tunnel === 'string' ? { status: services.tunnel, url: services.tunnelUrl } : (services.tunnel || {});
      const isLive = tn.status === 'live';
      const isConnecting = tn.status === 'connecting';
      tunnelDot.className = `system-dot ${isLive ? 'is-ok' : isConnecting ? 'is-warn' : 'is-off'}`;
      tunnelDesc.textContent = isLive ? `Live: ${tn.url}` : isConnecting ? 'Connecting tunnel…' : 'Off. Instant webhook ingress requires an active tunnel.';
      toggleTunnelBtn.textContent = isLive ? 'Stop Tunnel' : isConnecting ? 'Connecting…' : 'Start Tunnel';
      toggleTunnelBtn.disabled = isConnecting;
    }

    // 3. Time format selector sync
    const currentFormat = services.timeFormat || '24h';
    for (const pill of formatPills) {
      pill.classList.toggle('active', pill.dataset.format === currentFormat);
    }

    if (pingClisBtn) {
      pingClisBtn.disabled = false;
      pingClisBtn.textContent = 'Check CLIs';
    }
  }
  pingClisBtn?.addEventListener('click', () => { pingClisBtn.disabled = true; pingClisBtn.textContent = 'Checking…'; vscode.postMessage({ type: 'pingClis' }); });
  document.getElementById('modelSettingsBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'openModelSettings' }));
  document.getElementById('resetCacheBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'resetCliCache' }));
  configureTelegramBtn?.addEventListener('click', () => vscode.postMessage({ type: 'configureTelegram' }));
  testTelegramBtn?.addEventListener('click', () => vscode.postMessage({ type: 'testTelegram' }));
  disconnectTelegramBtn?.addEventListener('click', () => vscode.postMessage({ type: 'disconnectTelegram' }));
  toggleTunnelBtn?.addEventListener('click', () => {
    const isLive = toggleTunnelBtn.textContent.startsWith('Stop');
    vscode.postMessage({ type: isLive ? 'stopTunnel' : 'startTunnel' });
  });
  for (const pill of formatPills) {
    pill.addEventListener('click', () => {
      for (const p of formatPills) p.classList.remove('active');
      pill.classList.add('active');
      vscode.postMessage({ type: 'setTimeFormat', format: pill.dataset.format });
    });
  }
  openTerminalBtn?.addEventListener('click', () => vscode.postMessage({ type: 'openTerminal' }));

  // P16-M: legible model cards with 5h and 7d "% remaining" gauges.
  function resetsIn(resetsAt) {
    if (!resetsAt) return '';
    const ms = resetsAt * 1000 - Date.now();
    if (!(ms > 0)) return 'resetting';
    const minutes = Math.round(ms / 60000);
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    return `resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`;
  }

  function gauge(label, window) {
    const row = document.createElement('div');
    row.className = 'gauge';
    const name = document.createElement('span');
    name.className = 'gauge-label';
    name.textContent = label;
    const track = document.createElement('span');
    track.className = 'gauge-track';
    const fill = document.createElement('span');
    fill.className = 'gauge-fill';
    const pct = typeof window?.remaining === 'number' ? Math.max(0, Math.min(100, Math.round(window.remaining))) : null;
    fill.style.setProperty('--pct', pct === null ? '0' : String(pct));
    track.append(fill);
    const value = document.createElement('span');
    value.className = 'gauge-value';
    value.textContent = pct === null ? '\u2014' : `${pct}%`;
    row.classList.toggle('is-low', pct !== null && pct <= 20);
    row.classList.toggle('is-empty', pct === null);
    row.append(name, track, value);
    return row;
  }

  function modelCard(agent, quota) {
    const card = document.createElement('div');
    card.className = `model-card model-card-${agent}`;
    card.dataset.agent = agent;
    const head = document.createElement('div');
    head.className = 'model-card-head';
    head.innerHTML = ICONS[agent] || '';
    const title = document.createElement('span');
    title.className = 'model-card-name';
    title.textContent = names[agent] || agent;
    const reset = document.createElement('span');
    reset.className = 'model-card-reset';
    reset.textContent = resetsIn(quota?.resetsAt);
    head.append(title, reset);
    card.append(head);
    card.append(gauge('5h', quota && typeof quota.remaining === 'number' ? quota : null));
    card.append(gauge('7d', quota?.secondary || null));
    card.title = `${names[agent]}: ${typeof quota?.remaining === 'number' ? `${Math.round(quota.remaining)}% of the 5h window left` : 'no live quota'}${quota?.secondary ? `, ${Math.round(quota.secondary.remaining)}% of the week` : ''}`;
    return card;
  }

  // Re-render in place (same nodes) so width changes animate instead of popping.
  // No Opus card: it runs on the Claude account, so the Claude card already shows its windows.
  function renderModelCards(quotas) {
    const next = ['claude', 'codex', 'gemini'].map((agent) => modelCard(agent, quotas?.[agent]));
    if (modelCards.childElementCount !== next.length) { modelCards.replaceChildren(...next); return; }
    next.forEach((card, i) => {
      const current = modelCards.children[i];
      current.title = card.title;
      current.querySelector('.model-card-name').textContent = card.querySelector('.model-card-name').textContent;
      current.querySelector('.model-card-reset').textContent = card.querySelector('.model-card-reset').textContent;
      const oldGauges = current.querySelectorAll('.gauge');
      const newGauges = card.querySelectorAll('.gauge');
      if (oldGauges.length !== newGauges.length) { current.replaceWith(card); return; }
      newGauges.forEach((g, j) => {
        const old = oldGauges[j];
        old.className = g.className;
        old.querySelector('.gauge-fill').style.setProperty('--pct', g.querySelector('.gauge-fill').style.getPropertyValue('--pct'));
        old.querySelector('.gauge-value').textContent = g.querySelector('.gauge-value').textContent;
      });
    });
  }
  setInterval(() => lastQuotas && renderModelCards(lastQuotas), 30000); // countdowns

  // P17-X: the exact catalog tier when the task recorded one.
  function modelBadge(agent, modelId) {
    const badge = document.createElement('span');
    badge.className = `agent-badge agent-badge-${agent}`;
    badge.innerHTML = ICONS[agent] || '';
    const exact = modelId && (window.MODEL_CATALOG || []).find((entry) => entry.id === modelId);
    badge.append(exact ? exact.label : names[agent] || agent);
    return badge;
  }

  // P17-X: 24h unless the user picks '12h', or 'auto' (the editor language's own convention).
  const TIME_PREFS = window.TIME_PREFS || {};
  const HOUR_CYCLE = { '24h': 'h23', '12h': 'h12' }[TIME_PREFS.timeFormat || '24h'];
  const clockParts = (extra) => ({ ...extra, hour: '2-digit', minute: '2-digit', ...(HOUR_CYCLE ? { hourCycle: HOUR_CYCLE } : {}) });
  function fireTimeOf(task) {
    if (task.dispatchTrigger === 'fixed-time') return Date.parse(task.dispatchTime) || null;
    const resetsAt = lastQuotas?.[task.model]?.resetsAt;
    return typeof resetsAt === 'number' ? resetsAt * 1000 : null;
  }
  function formatCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}h ${pad(m)}m ${pad(sec)}s` : m ? `${m}m ${pad(sec)}s` : `${sec}s`;
  }
  function tickCountdowns() {
    for (const el of scheduledList.querySelectorAll('.scheduled-countdown')) {
      const task = lastQueue.find((item) => item.id === el.closest('.scheduled-card').dataset.taskId);
      const fire = task && task.status === 'pending' ? fireTimeOf(task) : null;
      el.textContent = fire ? formatCountdown(fire - Date.now()) : '';
    }
  }
  setInterval(tickCountdowns, 1000);

  function modelMark(agent) {
    const mark = document.createElement('span');
    mark.className = 'agent-mark';
    mark.title = names[agent] || agent;
    mark.setAttribute('aria-label', mark.title);
    mark.innerHTML = ICONS[agent] || '';
    return mark;
  }

  function formatTimestamp(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
      ? date.toLocaleTimeString(TIME_PREFS.locale, clockParts())
      : date.toLocaleDateString(TIME_PREFS.locale, { month: 'short', day: 'numeric' });
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

  function renderHistory(sessions) {
    historyList.replaceChildren();
    if (!sessions || !sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No conversations yet.';
      historyList.appendChild(empty);
      return;
    }
    // Active chats (an agent running now or in the last five minutes) lead, as in Manage Chats.
    for (const session of [...sessions.filter((s) => s.active), ...sessions.filter((s) => !s.active)]) {
      // A plain div, not a button: it hosts its own nested delete <button>,
      // and a <button> may not contain another <button> (HTML would silently
      // reparent it, breaking the click target).
      const row = document.createElement('div');
      row.className = `history-row${session.active ? ' is-active' : ''}${session.state ? ` is-${session.state}` : ''}`;
      row.title = session.preview || 'New chat';

      const info = document.createElement('div');
      info.className = 'history-info';
      const title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = session.preview || 'New chat';
      const meta = document.createElement('div');
      meta.className = 'history-meta';
      if (session.state) {
        const live = document.createElement('span');
        live.className = 'history-live';
        live.textContent = session.state === 'waiting' ? 'Needs input' : 'Running';
        meta.append(live);
      }
      for (const agent of session.models || []) meta.append(modelMark(agent));
      const time = document.createElement('span');
      time.textContent = formatTimestamp(session.updatedAt);
      meta.append(time);
      info.append(title, meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'history-delete';
      remove.title = 'Delete chat';
      remove.textContent = '×';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'deleteChat', id: session.id });
      });

      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'history-rename';
      rename.title = 'Rename chat';
      rename.setAttribute('aria-label', 'Rename chat');
      rename.innerHTML = '<svg viewBox="7.99 7.95 496.01 496.06" fill="currentColor" aria-hidden="true"><path d="M339.24,100.59a8,8,0,0,0-11.32,0C21.76,406.75,39.26,388,37.51,393.51L8.76,483.11a16,16,0,0,0,20.13,20.13c97.07-31.14,92.2-28.84,96-32.67L411.41,184.08a8,8,0,0,0,0-11.32Z"/><path d="M403.22,25.29,361.86,66.65a8,8,0,0,0,0,11.31L434,150.14a8,8,0,0,0,11.31,0l41.36-41.36A58.65,58.65,0,0,0,504,67C504,14.85,440.44-11.93,403.22,25.29Z"/></svg>';
      rename.addEventListener('click', (event) => {
        event.stopPropagation();
        editTitle(title, session.preview || '', (name) => vscode.postMessage({ type: 'renameChat', id: session.id, title: name }));
      });

      row.addEventListener('click', () => vscode.postMessage({ type: 'openChat', id: session.id }));
      row.append(info, rename, remove);
      historyList.appendChild(row);
    }
  }

  function formatDispatchStatus(task) {
    if (task.dispatchTrigger === 'fixed-time' && task.dispatchTime) {
      const date = new Date(task.dispatchTime);
      return Number.isNaN(date.getTime())
        ? 'Dispatches at a scheduled time'
        : `Dispatches at ${date.toLocaleString(TIME_PREFS.locale, clockParts({ month: 'short', day: 'numeric' }))}`;
    }
    const quota = lastQuotas?.[task.model];
    return typeof quota?.remaining === 'number' ? `Waiting for quota (${quota.remaining}% left)` : 'Waiting for quota';
  }

  // P17-H: 'interrupted' = the extension host died mid-run (restart, crash, reload).
  const VISIBLE = new Set(['pending', 'dispatched', 'interrupted']);
  const WARN_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5 14 13H2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.2v.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  function setStatus(el, task) {
    el.className = `scheduled-status${task.status === 'dispatched' ? ' scheduled-status-active' : task.status === 'interrupted' ? ' scheduled-status-interrupted' : ''}`;
    el.textContent = task.status === 'dispatched' ? 'Dispatching…'
      : task.status === 'interrupted' ? 'Execution was interrupted (system restart or window reload).'
        : formatDispatchStatus(task);
  }

  const ACTION_ICONS = {
    now: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.75 3.5 9h4L7 14.25 12.5 7h-4z"/></svg>',
    unschedule: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h6.75a4 4 0 0 1 0 8H7"/></svg>',
  };

  function actionButton(label, className, type, taskId, icon = '', title = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `scheduled-action${className ? ` ${className}` : ''}`;
    btn.innerHTML = icon;
    btn.append(label);
    if (title) btn.title = title;
    btn.addEventListener('click', () => { btn.disabled = true; vscode.postMessage({ type, taskId }); });
    return btn;
  }

  function scheduledCard(task) {
    const card = document.createElement('div');
    card.className = `scheduled-card glass${task.status === 'interrupted' ? ' is-interrupted' : ''}`;
    card.dataset.taskId = task.id;
    card.dataset.status = task.status;

    const header = document.createElement('div');
    header.className = 'scheduled-card-header';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'scheduled-model';
    modelLabel.append(modelBadge(task.model, task.modelId));
    const countdown = document.createElement('span');
    countdown.className = 'scheduled-countdown';
    countdown.title = 'Time until this prompt fires';
    header.append(modelLabel, countdown);
    if (task.status === 'interrupted') {
      const badge = document.createElement('span');
      badge.className = 'scheduled-badge-interrupted';
      badge.innerHTML = WARN_ICON;
      badge.append('Interrupted');
      header.append(badge);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'scheduled-cancel';
    cancel.title = 'Cancel this task';
    cancel.textContent = '×';
    cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancelScheduledTask', taskId: task.id }));
    header.append(cancel);

    const status = document.createElement('div');
    setStatus(status, task);

    const prompt = document.createElement('div');
    prompt.className = 'scheduled-prompt';
    prompt.textContent = task.prompt || '';

    card.append(header, status, prompt);

    if (task.attachments && task.attachments.length) {
      const attachPill = document.createElement('div');
      attachPill.className = 'scheduled-attachments';
      attachPill.textContent = `${task.attachments.length} attachment${task.attachments.length === 1 ? '' : 's'}`;
      card.appendChild(attachPill);
    }

    if (task.status === 'interrupted') {
      const actions = document.createElement('div');
      actions.className = 'scheduled-actions';
      actions.append(
        actionButton('Run Now', 'is-primary', 'dispatchInterruptedTask', task.id),
        actionButton('Reschedule', '', 'rescheduleTask', task.id),
      );
      card.append(actions);
    }
    // P17-Z: don't want to wait for the reset? Send it now via Auto, or take it back into the composer.
    if (task.status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'scheduled-actions';
      actions.append(
        actionButton('Send Now', 'is-primary', 'dispatchNowWithAutoRoute', task.id, ACTION_ICONS.now, 'Unschedule and send now via Auto (routes to a model with quota left)'),
        actionButton('Unschedule', '', 'unscheduleToComposer', task.id, ACTION_ICONS.unschedule, 'Move back into the chat composer as an editable draft'),
      );
      card.append(actions);
    }
    return card;
  }

  // P17-H: quota polls arrive every 5s, and rebuilding the list on each one
  // replayed every card's entry animation (the flicker). The same tasks in the
  // same order update in place, a card whose status changed is swapped alone,
  // and only an added, removed, or reordered task rebuilds the list.
  function renderScheduled(queue) {
    // P17-X: bundled by agent (stable sort keeps each agent's dispatch order).
    const AGENTS = ['claude', 'codex', 'gemini'];
    const visible = (queue || []).filter((task) => VISIBLE.has(task.status))
      .sort((a, b) => AGENTS.indexOf(a.model) - AGENTS.indexOf(b.model));
    const cards = [...scheduledList.querySelectorAll('.scheduled-card')];
    if (!visible.length) {
      if (!cards.length && scheduledList.querySelector('.scheduled-empty')) return;
      const empty = document.createElement('div');
      empty.className = 'scheduled-empty';
      empty.textContent = 'No tasks scheduled. Tasks queued while quota is exhausted will appear here.';
      scheduledList.replaceChildren(empty);
      return;
    }
    const rebuilt = cards.length !== visible.length || cards.some((card, i) => card.dataset.taskId !== visible[i].id);
    if (rebuilt) {
      scheduledList.replaceChildren(...visible.flatMap((task, i) => {
        const card = scheduledCard(task);
        if (visible[i - 1]?.model === task.model) return [card];
        const head = document.createElement('div');
        head.className = 'scheduled-group-head';
        head.append(modelMark(task.model), names[task.model] || task.model);
        const reset = document.createElement('span');
        reset.className = 'scheduled-group-reset';
        reset.dataset.agent = task.model;
        head.append(reset);
        return [head, card];
      }));
    }
    for (const reset of scheduledList.querySelectorAll('.scheduled-group-reset')) {
      const resetsAt = lastQuotas?.[reset.dataset.agent]?.resetsAt;
      reset.textContent = typeof resetsAt === 'number' ? `Quota resets ${new Date(resetsAt * 1000).toLocaleTimeString(TIME_PREFS.locale, clockParts())}` : '';
    }
    if (!rebuilt) {
      visible.forEach((task, i) => {
        const card = cards[i];
        if (card.dataset.status !== task.status) { card.replaceWith(scheduledCard(task)); return; }
        setStatus(card.querySelector('.scheduled-status'), task);
        card.querySelector('.scheduled-prompt').textContent = task.prompt || '';
      });
    }
    tickCountdowns();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'history': renderHistory(message.sessions); break;
      case 'fleet': renderFleet(message); break;
      case 'quotas': {
        lastQuotas = message.quotas;
        renderModelCards(lastQuotas);
        if (activeTab === 'scheduled') renderScheduled(lastQueue);
        break;
      }
      case 'schedulerQueue': {
        lastQueue = message.queue || [];
        renderScheduled(lastQueue);
        break;
      }
      default: break;
    }
  });

  vscode.postMessage({ type: 'requestHistory' });
  vscode.postMessage({ type: 'requestQuotas' });
  vscode.postMessage({ type: 'requestSchedulerQueue' });
})();
