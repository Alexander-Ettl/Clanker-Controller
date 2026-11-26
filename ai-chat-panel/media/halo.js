/* Halo, the minimal appearance (aiChatPanel.appearance = "halo"). The look is halo.css, scoped to body.ui-halo; this file
   adds the two things CSS cannot: a slim header (Chats, New chat, More) that replaces the sidebar rail and the editor
   tab's top bar, and the More menu. Every entry drives a control the chat already has (the rail's and top bar's
   buttons stay in the page, hidden), so queue counts, loop timers and update progress keep one source of truth.
   The host sends { type: 'appearance', appearance } when the setting changes; the switch is live, no reload. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
  const ICON = {
    chats: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/>'),
    newChat: svg('<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M17.6 3.6a2 2 0 0 1 2.8 2.8L12 14.8l-3.6.8.8-3.6z"/>'),
    more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>'),
    popOut: svg('<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
    queue: svg('<path d="M4 6h12M4 11h12M4 16h7"/><path d="M15.5 15.5h5M18 13v5"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    loops: svg('<path d="M16.5 3.5 20 7l-3.5 3.5"/><path d="M4 11.5V10a3 3 0 0 1 3-3h13"/><path d="M7.5 20.5 4 17l3.5-3.5"/><path d="M20 12.5V14a3 3 0 0 1-3 3H4"/>'),
    update: svg('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>'),
    settings: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><path d="M15 5v4M9 15v4"/>'),
    find: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>'),
  };

  let header = null, menu = null, moreBtn = null, dot = null;

  function build() {
    header = document.createElement('div');
    header.className = 'halo-top';
    header.innerHTML = `
      <button class="halo-btn" type="button" data-halo="chats" title="Chats" aria-label="Chats">${ICON.chats}</button>
      <span class="halo-spacer"></span>
      <button class="halo-btn" type="button" data-halo="find" title="Find in chat (Ctrl+F)" aria-label="Find in chat">${ICON.find}</button>
      <button class="halo-btn" type="button" data-halo="new" title="New chat" aria-label="New chat">${ICON.newChat}</button>
      <button class="halo-btn" type="button" data-halo="more" title="More" aria-label="More" aria-haspopup="menu" aria-expanded="false" aria-controls="haloMenu">${ICON.more}<span class="halo-dot" hidden></span></button>`;
    const transcript = $('transcript');
    transcript.parentNode.insertBefore(header, transcript);
    moreBtn = header.querySelector('[data-halo="more"]');
    dot = moreBtn.querySelector('.halo-dot');

    menu = document.createElement('div');
    menu.className = 'halo-menu';
    menu.id = 'haloMenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'More');
    menu.hidden = true;
    menu.innerHTML = `
      <button class="halo-item" role="menuitem" type="button" data-halo="popOut">${ICON.popOut}<span>Open in editor</span></button>
      <button class="halo-item" role="menuitem" type="button" data-halo="queue">${ICON.queue}<span>Scheduled prompts</span><span class="halo-count"></span></button>
      <button class="halo-item" role="menuitem" type="button" data-halo="schedule">${ICON.clock}<span>Schedule next message</span></button>
      <button class="halo-item" role="menuitem" type="button" data-halo="loops">${ICON.loops}<span>Loops</span><span class="halo-meta"></span></button>
      <button class="halo-item" role="menuitem" type="button" data-halo="update">${ICON.update}<span>Update CLIs</span></button>
      <div class="halo-sep" role="separator"></div>
      <button class="halo-item" role="menuitem" type="button" data-halo="settings">${ICON.settings}<span>Settings</span></button>`;
    document.body.appendChild(menu);

    header.addEventListener('click', (event) => {
      const action = event.target.closest('[data-halo]')?.dataset.halo;
      if (action === 'chats') $('historyBtn')?.click();
      else if (action === 'new') $('newChatBtn')?.click();
      else if (action === 'find') $('findBtn')?.click();
      else if (action === 'more') toggleMenu();
    });
    menu.addEventListener('click', (event) => {
      const action = event.target.closest('[data-halo]')?.dataset.halo;
      if (!action) return;
      closeMenu(false);
      run(action);
    });
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll('.halo-item:not([hidden])')];
      const at = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
      else if (event.key === 'Tab') closeMenu(false);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!menu.hidden && !menu.contains(event.target) && !moreBtn.contains(event.target)) closeMenu(false);
    }, true);
    window.addEventListener('resize', () => closeMenu(false));

    // The dot on More: something in the menu wants a look. The source buttons already track it.
    const watched = ['queueBtn', 'loopsBtn', 'updatesBtn'].map($).filter(Boolean);
    const observer = new MutationObserver(() => { refreshDot(); if (!menu.hidden) refreshItems(); });
    for (const el of watched) observer.observe(el, { attributes: true, attributeFilter: ['hidden', 'class'] });
    const status = $('updatesBtn')?.querySelector('.upd-status');
    if (status) observer.observe(status, { childList: true, characterData: true, subtree: true });
    refreshDot();
  }

  function run(action) {
    if (action === 'popOut') $('popOutBtn')?.click();
    else if (action === 'queue') $('queueBtn')?.click();
    else if (action === 'schedule') { $('scheduleBtn')?.click(); $('promptInput')?.focus(); }
    else if (action === 'loops') $('loopsBtn')?.click();
    else if (action === 'update') $('updatesBtn')?.click();
    else if (action === 'settings') window.postMessage({ type: 'openSettings' }, '*');
  }

  const visible = (el) => Boolean(el) && !el.hidden;
  function refreshDot() {
    const queue = $('queueBtn'), loops = $('loopsBtn'), updates = $('updatesBtn');
    const wants = visible(queue) || Boolean(loops?.classList.contains('is-running')) || visible(updates);
    if (dot) dot.hidden = !wants;
  }

  function refreshItems() {
    const queue = $('queueBtn'), loops = $('loopsBtn'), updates = $('updatesBtn');
    const item = (name) => menu.querySelector(`[data-halo="${name}"]`);
    item('popOut').hidden = !$('popOutBtn'); // the sidebar only: an editor tab is already one
    item('queue').hidden = !visible(queue);
    item('queue').querySelector('.halo-count').textContent = $('queueBadge')?.textContent || '';
    item('loops').querySelector('.halo-meta').textContent = $('loopElapsed')?.textContent || '';
    item('loops').hidden = !loops;
    item('update').hidden = !visible(updates);
    // The rail's update button is hidden in Halo, so its progress shows here: "Updating 2 CLIs…", then done or failed.
    const status = updates?.querySelector('.upd-status')?.textContent.trim();
    const busy = Boolean(updates?.classList.contains('is-updating'));
    item('update').querySelector('span').textContent = (busy || updates?.classList.contains('is-done') || updates?.classList.contains('is-failed')) && status ? status : 'Update CLIs';
    item('update').disabled = busy;
    const armed = $('scheduleBtn')?.classList.contains('is-scheduled');
    item('schedule').querySelector('span').textContent = armed ? 'Change send time' : 'Schedule next message';
  }

  function toggleMenu() { if (menu.hidden) openMenu(); else closeMenu(true); }
  function openMenu() {
    refreshItems();
    const r = moreBtn.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.right = `${Math.max(10, Math.round(window.innerWidth - r.right))}px`;
    menu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    menu.querySelector('.halo-item:not([hidden])')?.focus();
  }
  function closeMenu(refocus) {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    if (refocus) moreBtn.focus();
  }

  function apply(appearance) {
    const halo = appearance === 'halo';
    if (document.body.classList.contains('ui-halo') === halo) return;
    document.body.classList.toggle('ui-halo', halo);
    if (!halo) closeMenu(false);
    // Settings may be open: its Look picker follows the switch, whoever made it.
    for (const pill of document.querySelectorAll('.look-pill')) {
      const on = pill.dataset.look === (halo ? 'halo' : 'clanker');
      pill.classList.toggle('active', on);
      pill.setAttribute('aria-checked', String(on));
    }
    // The composer and docks change shape: let the measuring code (composer fit, the liquid-glass island) see it.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'appearance') apply(event.data.appearance);
  });
  build();
  document.body.classList.toggle('ui-halo', window.CLANKER_APPEARANCE === 'halo');
})();
