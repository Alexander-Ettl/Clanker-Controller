(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const historyList = document.getElementById('historyList');
  const modelCards = document.getElementById('modelCards');
  const ICONS = window.AGENT_ICONS || {};
  const names = window.AGENT_NAMES || { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity', opus: 'Claude Opus 5.5' };

  let lastQuotas = null;
  let lastApiValue = null; // the API value message (renderApiValue), also read by the usage rings' tooltips

  // The iOS app-icon shape for the chat tiles: a superellipse (|x|^5 + |y|^5 = 1), whose curvature flows into the
  // straight edges instead of jumping the way a circular corner radius does. CSS `border-radius` cannot draw it, so it
  // is a clip path in bounding-box units (any element can use clip-path: url(#squircle)).
  (function defineSquircle(n = 5, steps = 120) {
    const points = [];
    for (let i = 0; i < steps; i++) {
      const t = (2 * Math.PI * i) / steps;
      const c = Math.cos(t);
      const s = Math.sin(t);
      points.push(`${(0.5 + 0.5 * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(4)} ${(0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(4)}`);
    }
    // The chat tiles are the same squircle plus a bubble tail, in a 40x46 box: the squircle fills the top 40px and the
    // 6px-tall tail hangs below its bottom edge, set in from the right corner: a diagonal down to a rounded tip, then a
    // straight edge back up. It is ONE closed contour (the tail is spliced into the squircle's bottom edge), so there
    // is one outline, not a body and a tail overlapping.
    // The rim is the tile's own background; the fill (--bubble-fill-mask) is this same contour with a 2px black stroke
    // erased out of it, which removes exactly the 1px just inside the edge (the half outside is off the shape anyway),
    // all the way round the tail too.
    const bubblePath = (m) => {
      const yb = (x) => 20 + 20 * (1 - (Math.abs(x - 20) / 20) ** n) ** (1 / n);
      let d = '';
      let tailDone = false;
      for (let i = 0; i < steps; i++) {
        const t = (2 * Math.PI * i) / steps;
        const c = Math.cos(t);
        const s = Math.sin(t);
        const x = 20 + 20 * Math.sign(c) * Math.abs(c) ** (2 / n);
        const y = 20 + 20 * Math.sign(s) * Math.abs(s) ** (2 / n);
        if (y > 20 && x < 31 && x > 22.4) {
          if (!tailDone) d += `L${m(31, yb(31))}L${m(31, 44.6)}Q${m(31, 46.4)} ${m(29.6, 45.3)}L${m(22.4, yb(22.4))}`;
          tailDone = true;
          continue;
        }
        d += `${d ? 'L' : 'M'}${m(x, y)}`;
      }
      return `${d}Z`;
    };
    const fractions = (x, y) => `${(x / 40).toFixed(4)} ${(y / 46).toFixed(4)}`;
    const absolute = (x, y) => `${x.toFixed(2)} ${y.toFixed(2)}`;
    const fillMask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 46"><mask id="m"><path d="${bubblePath(absolute)}" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></mask><rect width="40" height="46" mask="url(#m)"/></svg>`;
    document.documentElement.style.setProperty('--bubble-fill-mask', `url("data:image/svg+xml,${encodeURIComponent(fillMask)}")`);
    document.body.insertAdjacentHTML('afterbegin', `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><clipPath id="squircle" clipPathUnits="objectBoundingBox"><path d="M${points.join('L')}Z"/></clipPath><clipPath id="bubble" clipPathUnits="objectBoundingBox"><path d="${bubblePath(fractions)}"/></clipPath></defs></svg>`);
  })();

  // The rail lives in the chat's own webview. New chat, Manage chats and the Scheduled timer pill are the chat's own
  // buttons (main.js finds them by id); Settings, and the "+N" chip below, open their popup with the same window
  // message the host used to send.
  const openInChat = (type, extra) => window.postMessage({ type, ...extra }, '*');
  document.getElementById('settingsBtn').addEventListener('click', () => openInChat('openSettings'));
  // Pop out: a new, empty chat in an editor tab beside this one (no rail there, the same chat window otherwise), for
  // working on several chats at once. Never a second view of this chat.
  document.getElementById('popOutBtn').addEventListener('click', () => vscode.postMessage({ type: 'newChatWindow' }));
  // One click opens General and starts every available CLI update.
  const updatesBtn = document.getElementById('updatesBtn');
  updatesBtn.addEventListener('click', () => openInChat('openSettings', { tab: 'general', updateAll: true }));

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

  // The 5h reset as a bare countdown ("1h 50m", "45m", "2d 3h"), small and dim under the percentage; the tooltip spells it out.
  function resetShort(resetsAt) {
    if (!resetsAt) return '';
    const minutes = Math.round((resetsAt * 1000 - Date.now()) / 60000);
    if (!(minutes > 0)) return 'now';
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  // One ring per provider: the 5h window outside, the week inside, the provider's mark in the middle.
  // Beside it: % left (5h, then the week) and when the 5h window resets; the names live in the tooltip.
  const ringCircles = (r) => `<circle class="ring-track" cx="18" cy="18" r="${r}"/><circle class="ring-fill" cx="18" cy="18" r="${r}" pathLength="100"/>`;
  const pctOf = (window) => (typeof window?.remaining === 'number' ? Math.max(0, Math.min(100, Math.round(window.remaining))) : null);

  function modelCard(agent, quota) {
    const card = document.createElement('div');
    card.className = `model-card model-card-${agent}`;
    card.dataset.agent = agent;
    // Hovering the ring grows .ring-pill leftward out of it: both windows as bars with the exact % and reset (launcher.css).
    const pillRow = (label) => `<span class="ring-row"><span class="ring-row-name">${label}</span><i class="ring-bar"><b></b></i><span class="ring-row-pct"></span><span class="ring-row-eta"></span></span>`;
    card.innerHTML = `<span class="ring" tabindex="0" title=""><span class="ring-pill" aria-hidden="true"><span class="ring-burn"><b class="ring-burn-val"></b><span class="ring-burn-label"></span></span><span class="ring-rows">${pillRow('5h')}${pillRow('7d')}</span></span><svg viewBox="0 0 36 36" aria-hidden="true">${ringCircles(15)}${ringCircles(10)}</svg><span class="ring-logo">${ICONS[agent] || ''}</span></span><b class="model-card-5h"></b><span class="model-card-7d"></span><span class="model-card-reset"></span>`;
    return updateModelCard(card, quota);
  }

  function updateModelCard(card, quota) {
    const five = pctOf(quota);
    const week = pctOf(quota?.secondary);
    [five, week].forEach((pct, i) => {
      const fill = card.querySelectorAll('.ring-fill')[i];
      fill.style.setProperty('--pct', pct ?? 0);
      fill.style.visibility = pct > 0 ? 'visible' : 'hidden';
      fill.classList.toggle('is-low', pct !== null && pct <= 20);
    });
    [[five, quota], [week, quota?.secondary]].forEach(([pct, win], i) => {
      const row = card.querySelectorAll('.ring-row')[i];
      row.style.setProperty('--pct', pct ?? 0);
      row.classList.toggle('is-low', pct !== null && pct <= 20);
      row.querySelector('.ring-row-pct').textContent = pct === null ? '—' : `${pct}%`;
      row.querySelector('.ring-row-eta').textContent = resetShort(win?.resetsAt);
    });
    card.querySelector('.model-card-5h').textContent = five === null ? '—' : `${five}%`;
    card.querySelector('.model-card-7d').textContent = week === null ? '—' : `${week}%`;
    card.querySelector('.model-card-reset').textContent = resetShort(quota?.resetsAt);
    card.classList.toggle('is-empty', five === null);
    const agent = card.dataset.agent;
    const burn = window.burnRate.describe(quota);
    const pace = window.burnRate.estimate(quota);
    const burnLabel = card.querySelector('.ring-burn');
    // One line, "7m of Usage remaining": the time until the quota is spent at the pace so far, or "Lasts" when the window resets first.
    // The full sentence stays in the tooltip.
    burnLabel.querySelector('.ring-burn-label').textContent = pace?.resetsFirst ? 'until the reset' : pace?.minutesLeft === 0 ? 'Usage is spent' : 'of Usage remaining';
    burnLabel.querySelector('.ring-burn-val').textContent = !pace ? '–' : pace.resetsFirst ? 'Lasts' : pace.minutesLeft === 0 ? 'Now' : window.burnRate.duration(pace.minutesLeft);
    burnLabel.classList.toggle('is-low', pace?.resetsFirst === false);
    const value = lastApiValue?.byAgent?.[agent];
    card.title = `${names[agent] || agent}: ${five === null ? 'no live quota' : `${five}% of the 5h window left`}${week === null ? '' : `, ${week}% of the week`}${quota?.resetsAt ? `, ${resetsIn(quota.resetsAt)}` : ''}${value > 0 ? `
API value so far: ≈ ${window.apiValue.formatUsd(value)} (at pay-per-token prices; not billed)` : ''}`;
    card.title += `\n${burn}\nAverage since this quota window started; includes idle time.`;
    card.querySelector('.ring').setAttribute('aria-label', card.title);
    return card;
  }

  // Re-render in place (same nodes) so the rings sweep instead of popping.
  // No Opus card: it runs on the Claude account, so the Claude ring already shows its windows.
  function renderModelCards(quotas) {
    const agents = window.PROVIDER_IDS || ['claude', 'codex', 'gemini'];
    if (modelCards.childElementCount !== agents.length) { modelCards.replaceChildren(...agents.map((agent) => modelCard(agent, quotas?.[agent]))); return; }
    agents.forEach((agent, i) => updateModelCard(modelCards.children[i], quotas?.[agent]));
  }
  setInterval(() => lastQuotas && renderModelCards(lastQuotas), 30000); // countdowns
  // Until the first quotas message arrives the cards are shimmering skeletons (see .is-loading in launcher.css).
  modelCards.classList.add('is-loading');
  modelCards.setAttribute('aria-busy', 'true');
  renderModelCards();
  modelCards.querySelectorAll('.model-card').forEach((card) => { card.title = 'Loading usage…'; });

  // P17-X: 24h unless the user picks '12h', or 'auto' (the editor language's own convention).
  const TIME_PREFS = window.TIME_PREFS || {};
  const HOUR_CYCLE = { '24h': 'h23', '12h': 'h12' }[TIME_PREFS.timeFormat || '24h'];
  const clockParts = (extra) => ({ ...extra, hour: '2-digit', minute: '2-digit', ...(HOUR_CYCLE ? { hourCycle: HOUR_CYCLE } : {}) });

  function modelMark(agent) {
    const mark = document.createElement('span');
    mark.className = 'agent-mark';
    mark.title = names[agent] || agent;
    mark.setAttribute('aria-label', mark.title);
    mark.innerHTML = ICONS[agent] || '';
    return mark;
  }

  // Under each tile, the Manage Chats wording in its short form (chat-time.js): "Just now", "4 min ago", the clock time today,
  // "Yesterday", then the date ("Sep 28"; "Sep 2025" once a year old).
  const railTime = (iso) => window.chatTime.chatTime(iso, { locale: TIME_PREFS.locale, hourCycle: HOUR_CYCLE, compact: true });
  setInterval(() => historyList.querySelectorAll('.history-time').forEach((label) => { label.textContent = railTime(label.dataset.at); }), 30000);

  // Hovering a tile pulls its left edge out over the chat into a preview (launcher.css): the same bubble outline at the
  // wider size, so the two left corners keep their curvature and the tail stays put. CSS animates the width; this redraws
  // the outline (fill, sheen, rim, and the clip that keeps the rim to the 1px inside the edge) at every width it passes.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let peekCount = 0;
  const peekShapes = new ResizeObserver((entries) => entries.forEach(({ target, contentRect }) => {
    if (!contentRect.width) return;
    const outline = window.bubbleOutline(contentRect.width, 46, 6);
    target.querySelectorAll('.history-peek-shape path').forEach((path) => path.setAttribute('d', outline));
  }));

  function historyPeek(session, rowClasses, agent, title) {
    const id = ++peekCount;
    const peek = document.createElement('div');
    peek.className = `history-peek ${rowClasses.replace('history-row', '').trim()}`;
    peek.setAttribute('aria-hidden', 'true');
    peek.innerHTML = `<svg class="history-peek-shape"><defs><clipPath id="peek-clip-${id}"><path/></clipPath><linearGradient id="peek-sheen-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".045"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><g clip-path="url(#peek-clip-${id})"><path class="history-peek-fill"/><path fill="url(#peek-sheen-${id})"/><path class="history-peek-rim"/></g></svg><div class="history-peek-text"><div class="history-peek-title"></div><div class="history-peek-meta"><span class="history-peek-project"></span><span class="history-peek-last"></span></div></div><span class="history-peek-mark"></span>`;
    peek.querySelector('.history-peek-title').textContent = title;
    // Like the preview in Manage Chats: the project it last worked in, then who spoke last and what they said.
    const project = peek.querySelector('.history-peek-project');
    project.textContent = session.projectNames?.[0] || session.projectName || '';
    const last = peek.querySelector('.history-peek-last');
    const message = session.lastMessage;
    if (message?.text) {
      const sender = document.createElement('b');
      sender.textContent = `${message.role === 'user' ? 'You' : (message.agent ? message.agent.charAt(0).toUpperCase() + message.agent.slice(1) : 'AI')}: `;
      last.append(sender, message.text);
    } else {
      last.textContent = 'No messages yet';
    }
    // The mark stays where it is on the tile, at the right end of the preview.
    const mark = peek.querySelector('.history-peek-mark');
    if (agent) { const logo = modelMark(agent); logo.removeAttribute('title'); mark.append(logo); }
    else mark.innerHTML = '<span class="slot-mark" aria-hidden="true"></span>';
    // It covers the tile while open, so it opens the chat too.
    peek.addEventListener('click', () => vscode.postMessage({ type: 'restoreChat', id: session.id }));
    peekShapes.observe(peek);
    return peek;
  }

  // Every row is just a provider mark, so a long history is a wall of look-alikes: the rail shows the live chats
  // and the latest few, and a "9+" chip opens Manage Chats (which also renames and deletes) for the rest.
  const RAIL_CHATS = 5;
  let recentTimer;

  function renderHistory(sessions) {
    clearTimeout(recentTimer);
    historyList.replaceChildren();
    if (!sessions || !sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No conversations yet.';
      historyList.appendChild(empty);
      return;
    }
    const now = Date.now();
    const isRecent = (session) => Number(session.recentUntil) > now;
    const nextExpiry = Math.min(...sessions.map((session) => Number(session.recentUntil)).filter((until) => until > now));
    if (Number.isFinite(nextExpiry)) recentTimer = setTimeout(() => vscode.postMessage({ type: 'requestHistory' }), nextExpiry - now + 20);
    // Keep the selected chat and recently selected or running chats visible before the older ones.
    const ordered = [
      ...sessions.filter((s) => s.selected),
      ...sessions.filter((s) => !s.selected && (isRecent(s) || s.state === 'running')),
      ...sessions.filter((s) => !s.selected && !isRecent(s) && s.state !== 'running'),
    ];
    // Past the latest few, the Chats button above is the one way into the rest (no second "+N" door).
    for (const session of ordered.slice(0, RAIL_CHATS)) {
      // A plain div, not a button: it hosts its own nested delete <button>,
      // and a <button> may not contain another <button> (HTML would silently
      // reparent it, breaking the click target).
      const row = document.createElement('div');
      row.className = `history-row${session.state === 'waiting' ? ' is-waiting' : ''}${isRecent(session) ? ' is-recent' : ''}${session.selected ? ' is-selected' : ''}`;
      if (session.selected) row.setAttribute('aria-current', 'true');
      // One pill per chat: the coding environment it last ran on (just one; two or three don't fit), then the name.
      // The tooltip names both and gives the time.
      const agent = (session.models || []).at(-1);
      const title = session.title || session.preview || 'New chat';
      const lastText = session.lastMessage?.text ? ` · "${session.lastMessage.text.slice(0, 60)}…"` : '';
      // The hover preview shows all of this; the label is for screen readers.
      row.setAttribute('aria-label', `${title}${lastText} · ${agent ? `${names[agent] || agent} · ` : ''}${window.chatTime.chatTime(session.updatedAt, { locale: TIME_PREFS.locale, hourCycle: HOUR_CYCLE })}${session.state === 'waiting' ? ' · Needs input' : ''}`);

      const lead = document.createElement('span');
      lead.className = 'history-lead';
      if (agent) lead.append(modelMark(agent));
      else lead.innerHTML = '<span class="slot-mark" aria-hidden="true"></span>'; // no turn yet: an open slot, not a blank tile
      row.addEventListener('click', () => vscode.postMessage({ type: 'restoreChat', id: session.id }));
      row.append(lead);
      const time = document.createElement('span');
      time.className = 'history-time';
      time.dataset.at = session.updatedAt || '';
      time.textContent = railTime(session.updatedAt);
      const item = document.createElement('div');
      item.className = 'history-item';
      if (agent) item.dataset.agent = agent; // the provider's colour for the orb
      item.append(row, time, historyPeek(session, row.className, agent, title));
      if (session.state === 'running') {
        // The same orb as the chat's "Thinking" pill (.pending-orb, style.css).
        const orb = document.createElement('span');
        orb.className = 'pending-orb history-spinner';
        orb.setAttribute('aria-hidden', 'true');
        item.append(orb);
      }
      historyList.appendChild(item);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'history': renderHistory(message.sessions); break;
      case 'cliStatus': {
        const due = message.updates || [];
        updatesBtn.hidden = !due.length;
        updatesBtn.title = due.map((agent) => `${names[agent] || agent} ${message.versions[agent].version} → ${message.versions[agent].latest}`).join('\n');
        break;
      }
      case 'apiValue': renderApiValue(message); break;
      case 'quotas':
        lastQuotas = message.quotas;
        modelCards.classList.remove('is-loading');
        modelCards.removeAttribute('aria-busy');
        renderModelCards(lastQuotas);
        break;
      default: break;
    }
  });

  // ---- API value: the running total at pay-per-token API prices, per provider in the card (and in each usage ring's tooltip).
  const apiValueEl = document.getElementById('apiValue');
  function renderApiValue(value) {
    lastApiValue = value;
    const fmt = window.apiValue.formatUsd;
    apiValueEl.hidden = !(value.totalUsd > 0);
    document.getElementById('apiValueAmount').textContent = `≈ ${fmt(value.totalUsd)}`;
    document.getElementById('apiValueTotal').textContent = `≈ ${fmt(value.totalUsd)}`;
    document.getElementById('apiValueRange').textContent = window.apiValue.formatRange(value.totalUsd);
    document.getElementById('apiValueRows').replaceChildren(...(window.PROVIDER_IDS || ['claude', 'codex', 'gemini']).map((agent) => {
      const row = document.createElement('div');
      row.className = 'api-value-row';
      row.dataset.agent = agent;
      row.innerHTML = `<span class="api-value-mark">${ICONS[agent] || ''}</span><span class="api-value-name"></span><span class="api-value-bar"><b></b></span><span class="api-value-usd"></span>`;
      const usd = value.byAgent?.[agent] || 0;
      row.querySelector('.api-value-name').textContent = names[agent] || agent;
      row.querySelector('.api-value-usd').textContent = fmt(usd);
      row.style.setProperty('--pct', value.totalUsd > 0 ? (usd / value.totalUsd) * 100 : 0);
      return row;
    }));
    const day = (iso) => (iso ? new Date(iso).toLocaleDateString(TIME_PREFS.locale, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
    const prices = value.prices?.liveAt ? `prices updated ${day(value.prices.liveAt)}` : `prices as of ${day(value.prices?.verified)}`;
    document.getElementById('apiValueFoot').textContent = [`This month ≈ ${fmt(value.monthUsd)}`, `since ${day(value.since)}`, prices, value.unpriced ? `${value.unpriced} turn${value.unpriced === 1 ? '' : 's'} of unlisted models not counted` : ''].filter(Boolean).join(' · ');
    renderModelCards(lastQuotas);
  }

  vscode.postMessage({ type: 'requestHistory' });
  vscode.postMessage({ type: 'requestQuotas' });
  vscode.postMessage({ type: 'requestApiValue' });
  vscode.postMessage({ type: 'requestCliStatus' });
})();
