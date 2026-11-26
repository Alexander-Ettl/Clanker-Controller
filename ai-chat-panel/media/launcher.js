(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const historyList = document.getElementById('historyList');
  const modelCards = document.getElementById('modelCards');
  const ICONS = window.AGENT_ICONS || {};
  const names = window.AGENT_NAMES || { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity', opus: 'Claude Opus 5.5' };

  let lastQuotas = null;

  // The iOS app-icon shape for the chat tiles: a superellipse (|x|^5 + |y|^5 = 1), whose curvature flows into the
  // straight edges instead of jumping the way a circular corner radius does. CSS `border-radius` cannot draw it, so it
  // is a clip path in bounding-box units (any element can use clip-path: url(#squircle)).
  // The usage rings are gel glass (.ring > svg in launcher.css points its filter here). One filter on the whole ring, no extra
  // nodes, and no neon: the arc stays a translucent body of its own colour; a soft highlight runs along the lit (top left)
  // shoulder, and a thin denser edge on the far side gives it thickness, the way a drop of gel holds light. Nothing darkens
  // and nothing glows, so it reads the same on a light and a dark rail. The light comes from (1,-1) in the ring's own frame
  // (the ring svg is rotated -90deg on screen): azimuth 315 and the offset below.
  const RING_TUBE = `<filter id="ring-tube" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="0.9" result="h"/>
    <feSpecularLighting in="h" surfaceScale="2.2" specularConstant="0.5" specularExponent="26" lighting-color="#fff" result="s"><feDistantLight azimuth="315" elevation="55"/></feSpecularLighting>
    <feComposite in="s" in2="SourceAlpha" operator="in" result="spec"/>
    <feOffset in="SourceAlpha" dx="0.55" dy="-0.55" result="lit"/>
    <feComposite in="SourceAlpha" in2="lit" operator="out" result="edge"/>
    <feGaussianBlur in="edge" stdDeviation="0.25" result="edge2"/>
    <feComposite in="SourceGraphic" in2="edge2" operator="in" result="rim"/>
    <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.82 0" result="body"/>
    <feMerge><feMergeNode in="body"/><feMergeNode in="rim"/><feMergeNode in="spec"/></feMerge>
  </filter>`;
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
    const squircleAbs = [];
    for (let i = 0; i < steps; i++) {
      const t = (2 * Math.PI * i) / steps;
      const c = Math.cos(t);
      const s = Math.sin(t);
      squircleAbs.push(`${(20 + 20 * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(2)} ${(20 + 20 * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(2)}`);
    }
    const squircleMask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><mask id="m"><path d="M${squircleAbs.join('L')}Z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></mask><rect width="40" height="40" mask="url(#m)"/></svg>`;
    const fillMask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 46"><mask id="m"><path d="${bubblePath(absolute)}" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></mask><rect width="40" height="46" mask="url(#m)"/></svg>`;
    document.documentElement.style.setProperty('--squircle-fill-mask', `url("data:image/svg+xml,${encodeURIComponent(squircleMask)}")`);
    document.documentElement.style.setProperty('--bubble-fill-mask', `url("data:image/svg+xml,${encodeURIComponent(fillMask)}")`);
    document.body.insertAdjacentHTML('afterbegin', `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><clipPath id="squircle" clipPathUnits="objectBoundingBox"><path d="M${points.join('L')}Z"/></clipPath><clipPath id="bubble" clipPathUnits="objectBoundingBox"><path d="${bubblePath(fractions)}"/></clipPath>${RING_TUBE}</defs></svg>`);
  })();

  // The rail lives in the chat's own webview. New chat, Manage chats and the Scheduled timer pill are the chat's own
  // buttons (main.js finds them by id); Settings, and the "+N" chip below, open their popup with the same window
  // message the host used to send.
  const openInChat = (type, extra) => window.postMessage({ type, ...extra }, '*');
  document.getElementById('settingsBtn').addEventListener('click', () => openInChat('openSettings'));
  // Pop out: a new, empty chat in an editor tab beside this one (no rail there, the same chat window otherwise), for
  // working on several chats at once. Never a second view of this chat.
  document.getElementById('popOutBtn').addEventListener('click', () => vscode.postMessage({ type: 'newChatWindow' }));
  // One click starts every available CLI update without leaving the chat.
  const updatesBtn = document.getElementById('updatesBtn');
  updatesBtn.addEventListener('click', () => vscode.postMessage({ type: 'updateAllClis' }));

  // While a CLI updates, the arrow circulates and hovering opens a pill with one progress row per CLI. When the last one
  // ends the button shows a check (or "!") and the pill opens by itself for a few seconds: "Update is done".
  // No CLI reports its progress, so the bar is paced on how long that CLI's last update took (the host's estimate).
  const RESULT_HOLD_MS = 7000;
  const updateRows = new Map(); // agent -> { state: running | done | failed, from, to, startedAt, estimateMs, row, bar, pct, ver }
  let updateDue = [], updateHold = null, updateTick = null;
  const statusLine = updatesBtn.querySelector('.upd-status');
  const rowsBox = updatesBtn.querySelector('.upd-rows');

  const paced = (entry) => {
    const t = Math.min(1, Math.max(0, (Date.now() - entry.startedAt) / entry.estimateMs));
    return 0.94 * (1 - (1 - t) ** 3);
  };
  const versionText = (entry) => (entry.to && entry.from && entry.to !== entry.from ? `${entry.from} → ${entry.to}` : entry.to || entry.from || '');

  function updateRow(agent, entry) {
    if (!entry.row) {
      const row = document.createElement('span');
      row.className = 'upd-row';
      row.style.setProperty('--agent', `var(--${agent}-color)`);
      row.innerHTML = `<span class="upd-mark">${ICONS[agent] || ''}</span><span class="upd-main"><span class="upd-title"><span class="upd-name"></span><span class="upd-ver"></span></span><i class="upd-bar"><b></b></i></span><span class="upd-pct"></span>`;
      Object.assign(entry, { row, bar: row.querySelector('.upd-bar b'), pct: row.querySelector('.upd-pct'), ver: row.querySelector('.upd-ver') });
      rowsBox.append(row);
    }
    const progress = entry.state === 'running' ? paced(entry) : entry.state === 'done' ? 1 : entry.frozen;
    entry.row.classList.toggle('is-done', entry.state === 'done');
    entry.row.classList.toggle('is-failed', entry.state === 'failed');
    entry.row.querySelector('.upd-name').textContent = entry.state === 'done' ? `${names[agent] || agent}: update is done` : names[agent] || agent;
    entry.bar.style.setProperty('--p', progress.toFixed(3));
    entry.pct.textContent = entry.state === 'done' ? '✓' : entry.state === 'failed' ? '!' : progress >= 0.93 ? '…' : `${Math.round(progress * 100)}%`;
    entry.ver.textContent = versionText(entry);
    entry.row.title = entry.state === 'failed' ? entry.text || 'Update failed' : '';
  }

  function renderUpdates() {
    const entries = [...updateRows.entries()];
    const running = entries.filter(([, entry]) => entry.state === 'running');
    const failed = entries.filter(([, entry]) => entry.state === 'failed');
    const state = running.length ? 'updating' : failed.length ? 'failed' : entries.length ? 'done' : '';
    for (const [agent, entry] of entries) updateRow(agent, entry);
    updatesBtn.classList.toggle('is-updating', state === 'updating');
    updatesBtn.classList.toggle('is-done', state === 'done');
    updatesBtn.classList.toggle('is-failed', state === 'failed');
    updatesBtn.classList.toggle('is-single', entries.length === 1);
    updatesBtn.style.setProperty('--rows', entries.length);
    statusLine.textContent = state === 'updating' ? `Updating ${running.length} CLI${running.length === 1 ? '' : 's'}…`
      : state === 'failed' ? (failed.length === entries.length ? 'Update failed' : 'Update finished with errors') : state === 'done' ? 'Update is done' : '';
    updatesBtn.hidden = !state && !updateDue.length;
    updatesBtn.title = state ? '' : updateDue.map(([agent, info]) => `${names[agent] || agent} ${info.version} → ${info.latest}`).join('\n');
    updatesBtn.setAttribute('aria-label', state === 'done' ? `${entries.map(([agent]) => names[agent] || agent).join(' and ')}: update is done` : statusLine.textContent || 'CLI updates');
    clearInterval(updateTick);
    updateTick = running.length ? setInterval(() => renderUpdates(), 300) : null;
  }

  function finishUpdates() {
    updatesBtn.classList.remove('is-peek');
    updatesBtn.classList.add('is-collapsing');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    updateHold = setTimeout(() => {
      if (!updateDue.length) updatesBtn.classList.add('is-exiting');
      updateHold = setTimeout(() => {
        updateRows.clear();
        rowsBox.replaceChildren();
        renderUpdates();
        updatesBtn.classList.remove('is-collapsing', 'is-exiting');
      }, reduced || updateDue.length ? 0 : 360);
    }, reduced ? 0 : 600);
  }

  function updatesStatus({ updating = {}, notes = {}, versions = {}, updates = [] }) {
    updateDue = updates.filter((agent) => versions[agent]).map((agent) => [agent, versions[agent]]);
    if (Object.keys(updating).length) {
      clearTimeout(updateHold);
      updatesBtn.classList.remove('is-collapsing', 'is-exiting');
    }
    for (const [agent, info] of Object.entries(updating)) {
      const entry = updateRows.get(agent);
      if (entry?.state === 'running') Object.assign(entry, { startedAt: info.startedAt, estimateMs: info.estimateMs || 20000 });
      else {
        if (entry) entry.row?.remove();
        updateRows.set(agent, { state: 'running', from: versions[agent]?.version, to: versions[agent]?.latest, startedAt: info.startedAt, estimateMs: info.estimateMs || 20000 });
      }
    }
    let ended = false;
    for (const [agent, entry] of updateRows) {
      if (entry.state !== 'running' || updating[agent]) continue;
      const note = notes[agent];
      Object.assign(entry, { state: note?.ok === false ? 'failed' : 'done', frozen: paced(entry), text: note?.text, to: versions[agent]?.version || entry.to });
      ended = true;
    }
    renderUpdates();
    if (ended && ![...updateRows.values()].some((entry) => entry.state === 'running')) {
      updatesBtn.classList.add('is-peek');
      clearTimeout(updateHold);
      updateHold = setTimeout(finishUpdates, RESULT_HOLD_MS);
    } else if (!updateRows.size || [...updateRows.values()].some((entry) => entry.state === 'running')) {
      clearTimeout(updateHold); // a new update started while the last result was still showing
      updatesBtn.classList.remove('is-peek');
    }
  }

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

  // Split mode: the Gemini circle is cut into one arc per quota pool, each with its own percentage and reset underneath.
  // To add a pool (say the Claude and GPT models), add its id here and a getter in `splitPools`; the arcs, gaps and labels
  // follow, up to four. A pool with no quota (no Argon on this plan) simply has no arc.
  const SPLIT_POOLS = ['gemini', 'argon'];
  const SEGMENT_SLOTS = window.ringSegments.MAX_SEGMENTS;
  // Per arc: the outer ring (track, fill) and the inner one. A pool with one window uses only the first pair, drawn thick.
  const segmentMarkup = () => Array.from({ length: SEGMENT_SLOTS }, () => '<path class="seg-track"/><path class="seg-fill" pathLength="100"/><path class="seg-track"/><path class="seg-fill" pathLength="100"/>').join('');
  // A pool's windows, the 5h first and the week second; one that has only a week has just that. The first is the pool's
  // headline: its percentage and reset sit under the arc, the week is the inner ring and the hover card.
  function splitPools(quota, { fiveHour, weekly, argonWeek }) {
    const week7d = (win) => win && { windowMinutes: 10080, ...win };
    const pools = {
      gemini: { label: 'Gemini', windows: [quota, quota?.secondary] },
      argon: { label: 'Argon', windows: [week7d(argonWeek)] },
      'claude-gpt': { label: 'Claude/GPT', windows: [fiveHour, week7d(weekly)] },
    };
    return SPLIT_POOLS.map((id) => { const windows = pools[id].windows.filter(Boolean); return { id, label: pools[id].label, windows, win: windows[0] }; });
  }
  const windowName = (win) => (win?.windowMinutes === 10080 ? '7d' : '5h');
  const windowSummary = (win) => `${windowName(win)} ${pctOf(win) === null ? 'no live quota' : `${pctOf(win)}% left`}${win?.resetsAt ? `, ${resetsIn(win.resetsAt)}` : ''}`;
  // The reset as tightly as it reads ("45m", "1h50m", "2d4h"): two of these sit side by side under a 47px ring.
  function resetTight(resetsAt) {
    if (!resetsAt) return '';
    const minutes = Math.round((resetsAt * 1000 - Date.now()) / 60000);
    if (!(minutes > 0)) return 'now';
    const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
    return d ? `${d}d${h ? `${h}h` : ''}` : h ? `${h}h${m ? `${m}m` : ''}` : `${m}m`;
  }

  function modelCard(agent, quota, extras, connection) {
    const card = document.createElement('div');
    card.className = `model-card model-card-${agent}`;
    card.dataset.agent = agent;
    // Hovering the ring grows .ring-pill leftward out of it: both windows as bars with the exact % and reset (launcher.css).
    const pillRow = (label) => `<span class="ring-row"><span class="ring-row-name">${label}</span><i class="ring-bar"><b></b></i><span class="ring-row-pct"></span><span class="ring-row-eta"></span></span>`;
    card.innerHTML = `<span class="ring" tabindex="0" title=""><span class="ring-pill" aria-hidden="true"><span class="ring-burn"><b class="ring-burn-val"></b><span class="ring-burn-label"></span></span><span class="ring-rows">${pillRow('5h')}${pillRow('7d')}</span><span class="ring-fault"><span class="ring-fault-text"><span class="ring-fault-head"><b class="ring-fault-title"></b><i class="ring-fault-code"></i></span><span class="ring-fault-detail"></span></span><button class="ring-fault-btn" type="button"></button></span></span><svg viewBox="0 0 36 36" aria-hidden="true">${ringCircles(15)}${ringCircles(10)}<g class="ring-split">${agent === 'gemini' ? segmentMarkup() : ''}</g></svg><span class="ring-logo">${ICONS[agent] || ''}</span></span><b class="model-card-5h"></b><span class="model-card-7d"></span><span class="model-card-reset"></span><span class="model-card-split"></span>`;
    if (agent === 'gemini') {
      card.querySelector('.ring-rows').insertAdjacentHTML('afterbegin', '<span class="ring-group-name">Gemini Models</span>');
      card.querySelector('.ring-rows').insertAdjacentHTML('afterend', `<span class="ring-rows ring-rows-claude-gpt"><span class="ring-group-name">Claude and GPT models</span>${pillRow('5h')}${pillRow('7d')}</span><span class="ring-rows ring-rows-argon"><span class="ring-group-name">Gemini 4 Argon</span>${pillRow('7d')}</span>`);
    }
    if (agent === 'copilot') { // one monthly allowance, not a 5h window and a week
      const rows = card.querySelectorAll('.ring-row');
      rows[0].querySelector('.ring-row-name').textContent = 'Month';
      rows[1].hidden = true;
    }
    card.querySelector('.ring-fault-btn').addEventListener('click', () => card._fault && vscode.postMessage({ type: card._fault.action, agent }));
    return updateModelCard(card, quota, extras, connection);
  }

  // Draws the arcs (reusing the same nodes, so a change sweeps) and the label under each: its percentage, and when it resets.
  function drawSegments(card, segments) {
    const { RINGS, layout, arcPath } = window.ringSegments;
    const arcs = [...card.querySelectorAll('.ring-split path')];
    for (let slot = 0; slot < SEGMENT_SLOTS; slot++) {
      const pool = segments[slot];
      // Two windows: 5h outside, week inside. One window: a single thick arc. None (no live quota): two empty tracks.
      const windows = !pool ? [] : pool.windows.length ? pool.windows : [null, null];
      const specs = windows.length === 1 ? [RINGS.thick] : [RINGS.outer, RINGS.inner];
      for (let i = 0; i < 2; i++) {
        const [track, fill] = [arcs[slot * 4 + i * 2], arcs[slot * 4 + i * 2 + 1]];
        const used = i < windows.length;
        track.style.display = fill.style.display = used ? '' : 'none';
        if (!used) continue;
        const spec = specs[i];
        const d = arcPath(spec.radius, ...layout(segments.length, spec.radius, spec.trim)[slot]);
        if (track.getAttribute('d') !== d) { track.setAttribute('d', d); fill.setAttribute('d', d); }
        track.classList.toggle('is-thick', spec === RINGS.thick);
        fill.classList.toggle('is-thick', spec === RINGS.thick);
        const pct = pctOf(windows[i]);
        fill.style.setProperty('--pct', pct ?? 0);
        fill.style.visibility = pct > 0 ? 'visible' : 'hidden';
        fill.classList.toggle('is-low', pct !== null && pct <= 20);
      }
    }
    const labels = card.querySelector('.model-card-split');
    labels.classList.toggle('is-crowded', segments.length > 2); // three or four labels drop the % sign to fit the rail
    if ([...labels.children].map((el) => el.dataset.pool).join() !== segments.map((pool) => pool.id).join()) {
      labels.replaceChildren(...segments.map((pool) => {
        const col = document.createElement('span');
        col.className = 'split-col';
        col.dataset.pool = pool.id;
        col.innerHTML = '<b class="split-pct"></b><span class="split-eta"></span>';
        return col;
      }));
    }
    segments.forEach((pool, i) => {
      const col = labels.children[i];
      const pct = pctOf(pool.win);
      col.classList.toggle('is-low', pct !== null && pct <= 20);
      col.querySelector('.split-pct').textContent = pct === null ? '—' : String(pct);
      col.querySelector('.split-eta').textContent = resetTight(pool.win?.resetsAt);
      col.title = `${pool.label}: ${pool.windows.length ? pool.windows.map(windowSummary).join('; ') : 'no live quota'}`;
    });
  }

  // What the Gemini circle draws: 'split' (default, one arc per pool), or one pool: 'argon', 'gemini' or 'claude-gpt' (aiChatPanel.antigravityRing).
  let ringSource = window.ANTIGRAVITY_RING || 'split';

  function updateModelCard(card, quota, extras, connection) {
    const gemini = card.dataset.agent === 'gemini';
    // The circle is the quota's two windows (5h outside, week inside). Antigravity has three pools, so Settings picks which one
    // the circle draws; a pool with only a weekly window is one circle, as wide as the outer ring.
    let first = quota, second = quota?.secondary, single = false;
    let fiveHour, weekly, argonWeek, segments = null;
    if (gemini) {
      // A weekly-only pool (the language server sometimes reports just that bucket) shows no 5h row.
      const weeklyOnly = (pool) => pool?.windowMinutes === 10080;
      const { claudeGpt, argon } = extras || {};
      fiveHour = weeklyOnly(claudeGpt) ? null : claudeGpt;
      weekly = weeklyOnly(claudeGpt) ? claudeGpt : claudeGpt?.secondary;
      argonWeek = weeklyOnly(argon) ? argon : argon?.secondary;
      const week7d = (win) => win && { windowMinutes: 10080, ...win };
      // Ultra shares Argon with the Gemini pool, so the language server may not list it: then the circle falls back to Gemini's.
      if (ringSource === 'split') {
        // Arcs for the pools that have a quota (the first always stays, so an empty ring still draws). The least-left one drives
        // the burn rate and the headline numbers.
        const pools = splitPools(quota, { fiveHour, weekly, argonWeek });
        segments = pools.filter((pool) => pool.win);
        if (!segments.length) segments = pools.slice(0, 1);
        first = window.ringSegments.binding(...segments.flatMap((pool) => pool.windows)) || quota;
        second = null;
      } else if (ringSource === 'argon' && argonWeek) { first = week7d(argonWeek); second = null; single = true; }
      else if (ringSource === 'claude-gpt' && (fiveHour || weekly)) {
        if (fiveHour) { first = fiveHour; second = weekly; } else { first = week7d(weekly); second = null; single = true; }
      }
    }
    const five = pctOf(first);
    const week = pctOf(second);
    const circles = card.querySelectorAll('.ring-fill');
    card.classList.toggle('ring-single', single);
    card.querySelectorAll('.ring > svg circle').forEach((circle, i) => {
      if (i < 2) circle.style.display = single ? 'none' : '';
      else circle.setAttribute('r', single ? 15 : 10);
    });
    (single ? [null, five] : [five, week]).forEach((pct, i) => {
      const fill = circles[i];
      fill.style.setProperty('--pct', pct ?? 0);
      fill.style.visibility = pct > 0 ? 'visible' : 'hidden';
      fill.classList.toggle('is-low', pct !== null && pct <= 20);
    });
    card.classList.toggle('is-split', Boolean(segments));
    if (segments) drawSegments(card, segments);
    const windows = [[pctOf(quota), quota], [pctOf(quota?.secondary), quota?.secondary]];
    if (gemini) {
      windows.push([pctOf(fiveHour), fiveHour], [pctOf(weekly), weekly], [pctOf(argonWeek), argonWeek]);
      const { argon } = extras || {};
      // Ultra shares Argon with the Gemini pool, so the language server may not list it: then there is nothing to show.
      card.querySelector('.ring-rows-argon').hidden = !argon;
      card.classList.toggle('has-argon', Boolean(argon));
    }
    windows.forEach(([pct, win], i) => {
      const row = card.querySelectorAll('.ring-row')[i];
      row.style.setProperty('--pct', pct ?? 0);
      row.classList.toggle('is-low', pct !== null && pct <= 20);
      row.querySelector('.ring-row-pct').textContent = pct === null ? '—' : `${pct}%`;
      row.querySelector('.ring-row-eta').textContent = resetShort(win?.resetsAt);
    });
    card.querySelector('.model-card-5h').textContent = five === null ? '—' : `${five}%`;
    card.querySelector('.model-card-7d').textContent = week === null ? (card.dataset.agent === 'copilot' ? '' : '—') : `${week}%`;
    card.querySelector('.model-card-reset').textContent = resetShort(first?.resetsAt);
    card.classList.toggle('is-empty', five === null);
    const agent = card.dataset.agent;
    const spent = first && !first.stale && !first.assumedReset && Number.isFinite(first.remaining)
      && first.remaining <= 0 && first.resetsAt * 1000 > Date.now();
    const burn = spent ? 'Usage is spent' : window.burnRate.describe(first);
    const pace = spent ? null : window.burnRate.estimate(first);
    const burnLabel = card.querySelector('.ring-burn');
    // One line, "7m of Usage remaining": the time until the quota is spent at the pace so far, or "Lasts" when the window resets first.
    // The full sentence stays in the tooltip.
    burnLabel.querySelector('.ring-burn-label').textContent = spent ? '' : pace?.resetsFirst ? 'until the reset' : 'of Usage remaining';
    burnLabel.querySelector('.ring-burn-val').textContent = spent ? 'Usage is spent' : !pace ? '–' : pace.resetsFirst ? 'Lasts' : window.burnRate.duration(pace.minutesLeft);
    burnLabel.classList.toggle('is-spent', Boolean(spent));
    burnLabel.classList.toggle('is-low', spent || pace?.resetsFirst === false);
    card.title = segments
      ? `${names[agent] || agent}: ${segments.map((pool) => `${pool.label} ${pool.windows.length ? pool.windows.map(windowSummary).join(', ') : 'no live quota'}`).join(' · ')}`
      : `${names[agent] || agent}: ${five === null ? 'no live quota' : `${five}% of the ${first?.windowMinutes > 10080 ? `month's ${first.detail?.what || 'allowance'}` : single ? 'week' : '5h window'} left`}${week === null ? '' : `, ${week}% of the week`}${first?.resetsAt ? `, ${resetsIn(first.resetsAt)}` : ''}`;
    if (first?.detail && first.windowMinutes > 10080) {
      const { plan, used, entitlement, what } = first.detail;
      const count = Number(used).toLocaleString(undefined, { maximumFractionDigits: what === 'AI credits' ? 3 : 0 });
      card.title += `\n${plan}: ${count} of ${entitlement} ${what} used this month`;
    }
    card.title += spent ? `\n${burn}` : `\n${burn}\nAverage since this quota window started; includes idle time.`;
    if (agent === 'gemini') {
      const describe = ([pct, win], label) => `${label}: ${pct === null ? 'no live quota' : `${pct}% left`}${win?.resetsAt ? `, ${resetsIn(win.resetsAt)}` : ''}`;
      card.title += `\nGemini models: ${describe(windows[0], '5h')}; ${describe(windows[1], '7d')}`;
      card.title += `\nClaude and GPT models: ${describe(windows[2], '5h')}; ${describe(windows[3], '7d')}`;
      if (extras?.argon) card.title += `\nGemini 4 Argon: ${describe(windows[4], '7d')}`;
    }
    // A provider that cannot be used (not signed in, broken install, plan ended): a full red ring, "Not available", and on hover
    // the exit code, the reason and the one button that fixes it. `connection.fault` comes from CliAccounts.fault().
    const fault = connection?.fault || null;
    card._fault = fault;
    card.classList.toggle('is-faulty', Boolean(fault));
    const pill = card.querySelector('.ring-pill');
    if (fault) {
      pill.removeAttribute('aria-hidden'); // its button must be reachable
      card.querySelectorAll('.ring-fill, .seg-fill').forEach((fill) => { fill.style.setProperty('--pct', 100); fill.style.visibility = 'visible'; fill.classList.remove('is-low'); });
      card.querySelector('.model-card-5h').textContent = 'Not available';
      card.querySelector('.model-card-reset').textContent = '';
      card.querySelector('.ring-fault-title').textContent = fault.title;
      const code = card.querySelector('.ring-fault-code');
      code.textContent = fault.code ? `Exit code ${fault.code}` : '';
      code.hidden = !fault.code;
      const detail = card.querySelector('.ring-fault-detail');
      detail.textContent = fault.detail;
      detail.title = fault.detail;
      const button = card.querySelector('.ring-fault-btn');
      button.textContent = connection.settingUp && (fault.action === 'connectCli' || fault.action === 'fixCli') ? 'Waiting for sign-in…' : fault.label;
      card.title = `${names[agent] || agent} is not available: ${fault.title}${fault.code ? ` (exit code ${fault.code})` : ''}\n${fault.detail}`;
    } else pill.setAttribute('aria-hidden', 'true');
    card.querySelector('.ring').setAttribute('aria-label', card.title);
    return card;
  }

  // Re-render in place (same nodes) so the rings sweep instead of popping.
  // No Opus card: it runs on the Claude account, so the Claude ring already shows its windows.
  // Only show enabled providers with favorites. Keep a favorited provider's fault card so it can be fixed from the rail.
  let connections = null;
  let favoriteAgents = new Set((window.MODEL_CATALOG || []).map((model) => model.agent));
  const usableAgents = () => (window.PROVIDER_IDS || ['claude', 'codex', 'gemini'])
    .filter((agent) => favoriteAgents.has(agent) && (!connections || connections[agent]?.enabled));
  const poolsOf = (quotas) => ({ claudeGpt: quotas?.antigravityClaudeGpt, argon: quotas?.antigravityArgon });
  function renderModelCards(quotas) {
    const agents = usableAgents();
    if ([...modelCards.children].map((card) => card.dataset.agent).join() !== agents.join()) { modelCards.replaceChildren(...agents.map((agent) => modelCard(agent, quotas?.[agent], poolsOf(quotas), connections?.[agent]))); return; }
    agents.forEach((agent, i) => updateModelCard(modelCards.children[i], quotas?.[agent], poolsOf(quotas), connections?.[agent]));
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
  setInterval(() => historyList.querySelectorAll('.history-time[data-at]').forEach((label) => { label.textContent = railTime(label.dataset.at); }), 30000);

  // Hovering a tile pulls its left edge out over the chat into a preview (launcher.css): the same bubble outline at the
  // wider size, so the two left corners keep their curvature and the tail stays put. CSS animates the width; this redraws
  // the outline (fill, sheen, rim, and the clip that keeps the rim to the 1px inside the edge) at every width it passes.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let peekCount = 0;
  const peekShapes = new ResizeObserver((entries) => entries.forEach(({ target, contentRect }) => {
    if (!contentRect.width) return;
    const isFolder = target.classList.contains('is-folder-peek');
    const outline = window.bubbleOutline(contentRect.width, isFolder ? 40 : 46, isFolder ? 0 : 6);
    target.querySelectorAll('.history-peek-shape path').forEach((path) => path.setAttribute('d', outline));
  }));

  // A tile's main mark is the chat's project (the rail's project icon); its provider is told by the tint of the work icon on the
  // corner and by the label. A chat without a project keeps the provider's logo, and one with no turn yet an open slot. While the
  // project list is still loading the mark stays blank, so the logo never flashes before the icon replaces it.
  function tileMark(session, agent) {
    if (session.projectId) {
      const project = window.railProjectMark?.(session.projectId);
      if (project) { project.classList.add('is-tile'); return project; }
      if (!window.railProjectsReady?.()) {
        const mark = document.createElement('span');
        mark.className = 'rail-skeleton-mark skeleton';
        mark.setAttribute('aria-hidden', 'true');
        return mark;
      }
    }
    if (agent) { const logo = modelMark(agent); logo.removeAttribute('title'); return logo; }
    const slot = document.createElement('span');
    slot.className = 'slot-mark';
    slot.setAttribute('aria-hidden', 'true'); // no turn yet: an open slot, not a blank tile
    return slot;
  }

  // What the chat is working on right now (lib/work-context.js): a bundled icon and its name, or null (no category yet, or no icon file).
  const CONTEXT = window.CONTEXT_ASSETS || { categories: [], icons: {} };
  function contextOf(session) {
    const id = session.workContext?.categoryId;
    const category = CONTEXT.categories.find((entry) => entry.id === id);
    return category && CONTEXT.icons[id] ? { label: category.label, svg: CONTEXT.icons[id] } : null;
  }

  function historyPeek(session, rowClasses, agent, title, context) {
    const id = ++peekCount;
    const peek = document.createElement('div');
    peek.className = `history-peek ${rowClasses.replace('history-row', '').trim()}`;
    peek.setAttribute('aria-hidden', 'true');
    peek.innerHTML = `<svg class="history-peek-shape"><defs><clipPath id="peek-clip-${id}"><path/></clipPath><linearGradient id="peek-sheen-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".045"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><g clip-path="url(#peek-clip-${id})"><path class="history-peek-fill"/><path fill="url(#peek-sheen-${id})"/><path class="history-peek-rim"/></g></svg><div class="history-peek-text"><div class="history-peek-head"><div class="history-peek-title"></div><span class="history-peek-context" hidden></span></div><div class="history-peek-meta"><span class="history-peek-icons"></span><span class="history-peek-project"></span><span class="history-peek-last"></span></div></div><span class="history-peek-mark"></span>`;
    peek.querySelector('.history-peek-title').textContent = title;
    if (context) {
      const chip = peek.querySelector('.history-peek-context');
      chip.hidden = false;
      chip.innerHTML = context.svg;
      chip.append(context.label);
    }
    // Like the preview in Manage Chats: the project it last worked in, then who spoke last and what they said.
    const project = peek.querySelector('.history-peek-project');
    project.textContent = session.projectNames?.[0] || session.projectName || '';
    // Their icons lead the line, the same marks as the rail's project tiles (up to three, the latest first).
    const icons = peek.querySelector('.history-peek-icons');
    for (const id of [...new Set([...(session.touchedProjectIds || []), session.projectId])].slice(0, 3)) {
      const icon = window.railProjectMark?.(id);
      if (icon) icons.append(icon);
    }
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
    peek.querySelector('.history-peek-mark').append(tileMark(session, agent));
    // The surrounding item opens the chat from either the tile or this expanded preview.
    peekShapes.observe(peek);
    return peek;
  }

  // Every row is a provider mark with a small work icon, so a long history is still a wall of look-alikes: the rail shows the live chats
  // and the latest few, and a "9+" chip opens Manage Chats (which also renames and deletes) for the rest.
  // Settings sets how many (window.RAIL_LIMITS.chats, 0 = all); 5 is the default.
  const railChats = () => window.RAIL_LIMITS?.chats || Infinity;
  let recentTimer;

  let lastSessions;
  let lastFolders = [];
  let chatFoldersEnabled = window.CHAT_FOLDERS_ENABLED !== false;
  let expandedFolderId = null;
  const FOLDER_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.2A1.7 1.7 0 0 1 3.7 3.5h2.2l1.4 1.6h5A1.7 1.7 0 0 1 14 6.8v4.5a1.7 1.7 0 0 1-1.7 1.7H3.7A1.7 1.7 0 0 1 2 11.3z"/></svg>';
  const FOLDER_OPEN_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 9.8 3.5-3.6 3.5 3.6"/></svg>';
  const PIN_BADGE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path class="pin-head" d="M9.2 3.5h5.6l-.5 6 3.2 3.6H6.5l3.2-3.6z"/><path d="M12 13.1v7.4"/></svg>';

  // The project list arrives separately from the chats (main.js); the previews pick up its icons when it does.
  window.addEventListener('rail-projects', () => lastSessions && renderHistory(lastSessions, lastFolders));
  window.addEventListener('rail-limits', () => lastSessions && renderHistory(lastSessions, lastFolders));

  function folderMiniGrid(members) {
    if (!members.length) {
      const icon = document.createElement('span');
      icon.className = 'folder-empty-mark';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = FOLDER_ICON_SVG;
      return icon;
    }
    const grid = document.createElement('span');
    grid.className = 'folder-mini-grid';
    grid.setAttribute('aria-hidden', 'true');
    for (const member of members.slice(0, 4)) {
      const cell = document.createElement('span');
      cell.className = 'folder-mini-cell';
      const agent = member.latestAgent || (member.models || []).at(-1);
      cell.append(tileMark(member, agent));
      grid.append(cell);
    }
    return grid;
  }

  function folderPeek(entry, rowClasses, expanded) {
    const { folder, members } = entry;
    const id = ++peekCount;
    const peek = document.createElement('div');
    peek.className = `history-peek is-folder-peek ${rowClasses.replace('history-row', '').replace('is-folder-tile', '').trim()}`;
    peek.setAttribute('aria-hidden', 'true');
    peek.innerHTML = `<svg class="history-peek-shape"><defs><clipPath id="peek-clip-${id}"><path/></clipPath><linearGradient id="peek-sheen-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".045"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><g clip-path="url(#peek-clip-${id})"><path class="history-peek-fill"/><path fill="url(#peek-sheen-${id})"/><path class="history-peek-rim"/></g></svg><div class="history-peek-text"><div class="history-peek-head"><div class="history-peek-title"></div><span class="history-peek-context"></span></div><div class="history-peek-meta"><span class="history-peek-last"></span></div></div><span class="history-peek-mark"></span>`;
    peek.querySelector('.history-peek-title').textContent = folder.name;
    const chip = peek.querySelector('.history-peek-context');
    chip.textContent = members.length ? `${members.length} chat${members.length === 1 ? '' : 's'}` : 'Empty';
    const last = peek.querySelector('.history-peek-last');
    if (expanded) {
      last.textContent = 'Click to collapse folder';
    } else if (members.length) {
      last.textContent = members.slice(0, 3).map(s => s.title || s.preview || 'New chat').join(' · ');
    } else {
      last.textContent = 'No chats in folder';
    }
    const mark = peek.querySelector('.history-peek-mark');
    if (expanded) {
      const icon = document.createElement('span');
      icon.className = 'folder-collapse-mark';
      icon.innerHTML = FOLDER_OPEN_SVG;
      mark.append(icon);
    } else {
      mark.append(folderMiniGrid(members));
    }
    peekShapes.observe(peek);
    return peek;
  }

  function renderChatItem(session, isRecent) {
    // A plain div, not a button: it hosts its own nested controls cleanly.
    const row = document.createElement('div');
    row.className = `history-row${session.state === 'waiting' ? ' is-waiting' : ''}${isRecent(session) ? ' is-recent' : ''}${session.selected ? ' is-selected' : ''}`;
    if (session.selected) row.setAttribute('aria-current', 'true');
    // The last agent that actually worked in the chat (not the first one, and not the model picked in the composer).
    const agent = session.latestAgent || (session.models || []).at(-1);
    const context = contextOf(session);
    const title = session.title || session.preview || 'New chat';
    const lastText = session.lastMessage?.text ? ` · "${session.lastMessage.text.slice(0, 60)}…"` : '';
    // The hover preview shows all of this; the label is for screen readers.
    row.setAttribute('aria-label', `${session.pinned ? 'Pinned · ' : ''}${title}${lastText} · ${session.projectName ? `${session.projectName} · ` : ''}${agent ? `${names[agent] || agent} · ` : ''}${context ? `${context.label} · ` : ''}${window.chatTime.chatTime(session.updatedAt, { locale: TIME_PREFS.locale, hourCycle: HOUR_CYCLE })}${session.state === 'waiting' ? ' · Needs input' : ''}`);

    const lead = document.createElement('span');
    lead.className = 'history-lead';
    lead.append(tileMark(session, agent));
    row.append(lead);
    const time = document.createElement('span');
    time.className = 'history-time';
    time.dataset.at = session.updatedAt || '';
    time.textContent = railTime(session.updatedAt);
    const item = document.createElement('div');
    item.className = 'history-item';
    item.tabIndex = 0;
    item.dataset.id = session.id;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', row.getAttribute('aria-label'));
    if (session.selected) item.setAttribute('aria-current', 'true');
    item.addEventListener('click', () => vscode.postMessage({ type: 'restoreChat', id: session.id }));
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); }
    });
    if (agent) item.dataset.agent = agent; // the provider's colour for the orb
    item.append(row, time, historyPeek(session, row.className, agent, title, context));
    if (context) {
      // The work icon sits on the tile's lower-left corner, on the item (the tile itself is clipped to the bubble).
      const badge = document.createElement('span');
      badge.className = 'history-context';
      badge.setAttribute('aria-hidden', 'true');
      badge.innerHTML = context.svg;
      item.append(badge);
    }
    if (session.pinned) {
      // A pushpin on the tile's top-left corner (the same glyph as the project pins); pinned chats lead the list.
      const pin = document.createElement('span');
      pin.className = 'history-pin';
      pin.setAttribute('aria-hidden', 'true');
      pin.innerHTML = PIN_BADGE_SVG;
      item.append(pin);
    }
    if (session.state === 'running') {
      // The same orb as the chat's "Thinking" pill (.pending-orb, style.css).
      const orb = document.createElement('span');
      orb.className = 'pending-orb history-spinner';
      orb.setAttribute('aria-hidden', 'true');
      item.append(orb);
    }
    return item;
  }

  function renderFolderItem(entry, expanded) {
    const { folder, members } = entry;
    const row = document.createElement('div');
    row.className = `history-row is-folder-tile${expanded ? ' is-expanded' : ''}${entry.waiting ? ' is-waiting' : ''}${entry.recent ? ' is-recent' : ''}${entry.selected ? ' is-selected' : ''}`;
    const lead = document.createElement('span');
    lead.className = 'history-lead';
    if (expanded) {
      const closeIcon = document.createElement('span');
      closeIcon.className = 'folder-collapse-mark';
      closeIcon.innerHTML = FOLDER_OPEN_SVG;
      lead.append(closeIcon);
    } else {
      lead.append(folderMiniGrid(members));
    }
    row.append(lead);
    const label = document.createElement('span');
    label.className = 'history-time history-folder-label';
    label.textContent = folder.name;
    const item = document.createElement('div');
    item.className = `history-item is-folder${expanded ? ' is-expanded' : ''}`;
    item.tabIndex = 0;
    item.dataset.id = `folder:${folder.id}`;
    item.dataset.folderId = folder.id;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-expanded', String(expanded));
    item.setAttribute('aria-label', `${folder.pinned ? 'Pinned · ' : ''}Folder: ${folder.name} · ${members.length} chat${members.length === 1 ? '' : 's'}${entry.waiting ? ' · Needs input' : ''}${expanded ? ' · Expanded' : ''}`);
    const toggle = () => {
      expandedFolderId = expanded ? null : folder.id;
      renderHistory(lastSessions, lastFolders);
    };
    item.addEventListener('click', toggle);
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
      else if (event.key === 'Escape' && expanded) { event.preventDefault(); expandedFolderId = null; renderHistory(lastSessions, lastFolders); historyList.querySelector(`.history-item[data-folder-id="${CSS.escape(folder.id)}"]`)?.focus(); }
    });
    if (entry.latestAgent) item.dataset.agent = entry.latestAgent;
    item.append(row, label, folderPeek(entry, row.className, expanded));
    if (folder.pinned) {
      const pin = document.createElement('span');
      pin.className = 'history-pin';
      pin.setAttribute('aria-hidden', 'true');
      pin.innerHTML = PIN_BADGE_SVG;
      item.append(pin);
    }
    if (entry.running && !expanded) {
      const orb = document.createElement('span');
      orb.className = 'pending-orb history-spinner';
      orb.setAttribute('aria-hidden', 'true');
      item.append(orb);
    }
    return item;
  }

  function renderHistory(sessions, folders = lastFolders) {
    historyList.removeAttribute('aria-busy');
    lastSessions = sessions;
    lastFolders = Array.isArray(folders) ? folders : [];
    const activeFolders = chatFoldersEnabled ? lastFolders : [];
    clearTimeout(recentTimer);
    // Where each tile was, so the ones that move glide smoothly into place.
    const before = new Map([...historyList.querySelectorAll('.history-item[data-id]')].map((el) => [el.dataset.id, el.getBoundingClientRect().top]));
    const wasExpanded = expandedFolderId;
    historyList.replaceChildren();
    const hasSessions = Array.isArray(sessions) && sessions.length > 0;
    const hasPinnedEmptyFolder = activeFolders.some(folder => folder.pinned);
    if (!hasSessions && !hasPinnedEmptyFolder) {
      expandedFolderId = null;
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No conversations yet.';
      historyList.appendChild(empty);
      return;
    }
    const list = sessions || [];
    const now = Date.now();
    const isRecent = (session) => Number(session.recentUntil) > now;
    const nextExpiry = Math.min(...list.map((session) => Number(session.recentUntil)).filter((until) => until > now));
    if (Number.isFinite(nextExpiry)) recentTimer = setTimeout(() => vscode.postMessage({ type: 'requestHistory' }), nextExpiry - now + 20);

    if (!activeFolders.length) {
      expandedFolderId = null;
      // Keep the selected chat and recently selected or running chats visible before the older ones.
      // Pinned chats come first, in pin order, even if they fill more than the configured slots.
      const pinned = list.filter((s) => s.pinned).sort((a, b) => a.pinOrder - b.pinOrder);
      const rest = list.filter((s) => !s.pinned);
      const ordered = [
        ...pinned,
        ...rest.filter((s) => s.selected),
        ...rest.filter((s) => !s.selected && (isRecent(s) || s.state === 'running')),
        ...rest.filter((s) => !s.selected && !isRecent(s) && s.state !== 'running'),
      ];
      for (const session of ordered.slice(0, Math.max(railChats(), pinned.length))) historyList.appendChild(renderChatItem(session, isRecent));
      glideHistory(before);
      return;
    }

    if (expandedFolderId && !activeFolders.some(folder => folder.id === expandedFolderId)) expandedFolderId = null;
    const sessionById = new Map(list.map(session => [session.id, session]));
    const folderOfChat = new Map();
    for (const folder of activeFolders) {
      for (const id of folder.chatIds || []) if (sessionById.has(id) && !folderOfChat.has(id)) folderOfChat.set(id, folder);
    }

    const sortSessions = (items) => {
      const pinned = items.filter(s => s.pinned).sort((a, b) => a.pinOrder - b.pinOrder);
      const rest = items.filter(s => !s.pinned);
      return [
        ...pinned,
        ...rest.filter(s => s.selected),
        ...rest.filter(s => !s.selected && (isRecent(s) || s.state === 'running' || s.state === 'waiting')),
        ...rest.filter(s => !s.selected && !isRecent(s) && s.state !== 'running' && s.state !== 'waiting'),
      ];
    };

    const folderEntries = [];
    for (const folder of activeFolders) {
      const members = sortSessions((folder.chatIds || []).map(id => sessionById.get(id)).filter(Boolean));
      if (!folder.pinned && !members.length && folder.id !== expandedFolderId) continue;
      const selected = members.some(s => s.selected);
      const waiting = members.some(s => s.state === 'waiting');
      const running = members.some(s => s.state === 'running');
      const recent = members.some(s => isRecent(s));
      const updatedAt = members.reduce((best, s) => (String(s.updatedAt || '') > best ? String(s.updatedAt || '') : best), folder.updatedAt || folder.createdAt || '');
      const leadChat = members.find(s => s.state === 'waiting') || members.find(s => s.state === 'running') || members.find(s => s.selected) || members[0];
      const latestAgent = leadChat?.latestAgent || (leadChat?.models || []).at(-1) || null;
      folderEntries.push({ kind: 'folder', id: folder.id, folder, members, pinned: Boolean(folder.pinned), pinnedAt: folder.pinnedAt ?? 0, selected, waiting, running, recent, updatedAt, latestAgent });
    }

    const standalone = list.filter(s => !folderOfChat.has(s.id)).map(session => ({
      kind: 'chat',
      id: session.id,
      session,
      pinned: Boolean(session.pinned),
      pinOrder: session.pinOrder ?? 0,
      selected: Boolean(session.selected),
      waiting: session.state === 'waiting',
      running: session.state === 'running',
      recent: isRecent(session),
      updatedAt: session.updatedAt || '',
    }));

    const pinnedItems = [
      ...folderEntries.filter(e => e.pinned).sort((a, b) => a.pinnedAt - b.pinnedAt),
      ...standalone.filter(e => e.pinned).sort((a, b) => a.pinOrder - b.pinOrder),
    ];
    const rankOf = (entry) => (entry.selected ? 0 : (entry.recent || entry.running || entry.waiting) ? 1 : 2);
    const unpinnedItems = [...folderEntries.filter(e => !e.pinned), ...standalone.filter(e => !e.pinned)]
      .sort((a, b) => (rankOf(a) - rankOf(b)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

    const visibleLimit = Math.max(railChats(), pinnedItems.length);
    const visible = [...pinnedItems, ...unpinnedItems].slice(0, visibleLimit);

    // An expanded folder moves to the very top position in Recent, with all of its chats listed directly below.
    const expandedEntry = expandedFolderId ? folderEntries.find(entry => entry.id === expandedFolderId) : null;
    if (expandedEntry) {
      const group = document.createElement('div');
      group.className = 'history-folder-group is-expanded';
      group.dataset.folderId = expandedEntry.id;
      group.setAttribute('role', 'region');
      group.setAttribute('aria-label', `${expandedEntry.folder.name} folder`);
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          expandedFolderId = null;
          renderHistory(lastSessions, lastFolders);
          historyList.querySelector(`.history-item[data-folder-id="${CSS.escape(expandedEntry.id)}"]`)?.focus();
        }
      });
      group.appendChild(renderFolderItem(expandedEntry, true));
      const contents = document.createElement('div');
      contents.className = `history-folder-contents${wasExpanded !== expandedEntry.id ? ' is-opening' : ''}`;
      if (expandedEntry.members.length) {
        for (const member of expandedEntry.members) contents.appendChild(renderChatItem(member, isRecent));
      } else {
        const emptyNote = document.createElement('span');
        emptyNote.className = 'history-folder-empty-rail';
        emptyNote.textContent = 'Empty';
        contents.appendChild(emptyNote);
      }
      group.appendChild(contents);
      historyList.appendChild(group);
    }

    for (const entry of visible) {
      if (expandedEntry && entry.kind === 'folder' && entry.id === expandedEntry.id) continue;
      if (entry.kind === 'folder') historyList.appendChild(renderFolderItem(entry, false));
      else historyList.appendChild(renderChatItem(entry.session, isRecent));
    }
    glideHistory(before);
  }

  // A short, soft slide (FLIP): each tile that kept its chat but changed place starts at its old spot and eases to the new one.
  // The one travelling furthest up (the chat just opened) passes over the others. Skipped for reduced motion.
  const HISTORY_GLIDE_MS = 260;
  function glideHistory(before) {
    if (!before.size || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let rising = null;
    for (const item of historyList.querySelectorAll('.history-item[data-id]')) {
      const from = before.get(item.dataset.id);
      if (from === undefined) continue;
      const dy = from - item.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      // A tile stepping down dips a little in opacity while the rising one crosses it, so the two never read as overlapping.
      const frames = dy > 0 ? [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }] : [{ transform: `translateY(${dy}px)`, opacity: 0.55 }, { transform: 'translateY(0)', opacity: 1 }];
      const glide = item.animate(frames, { duration: HISTORY_GLIDE_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      if (dy > 0 && (!rising || dy > rising.dy)) rising = { item, glide, dy };
    }
    if (rising) {
      rising.item.style.zIndex = '2';
      const done = () => { rising.item.style.zIndex = ''; };
      rising.glide.addEventListener('finish', done);
      rising.glide.addEventListener('cancel', done);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'history':
        if (typeof message.chatFoldersEnabled === 'boolean') chatFoldersEnabled = message.chatFoldersEnabled;
        renderHistory(message.sessions, Array.isArray(message.folders) ? message.folders : []);
        break;
      case 'cliStatus': updatesStatus(message); break;
      case 'modelCatalog':
        favoriteAgents = new Set(message.catalog.map((model) => model.agent));
        renderModelCards(lastQuotas);
        break;
      case 'antigravityRing':
        ringSource = message.value || 'argon';
        renderModelCards(lastQuotas);
        break;
      case 'cliConnections':
        connections = message.providers;
        renderModelCards(lastQuotas);
        break;
      case 'quotas':
        lastQuotas = message.quotas;
        modelCards.classList.remove('is-loading');
        modelCards.removeAttribute('aria-busy');
        renderModelCards(lastQuotas);
        break;
      default: break;
    }
  });

  vscode.postMessage({ type: 'requestHistory' });
  vscode.postMessage({ type: 'requestQuotas' });
  vscode.postMessage({ type: 'requestCliStatus' });
  vscode.postMessage({ type: 'requestCliAvailability' });
})();
