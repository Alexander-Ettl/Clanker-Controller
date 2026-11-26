(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const AGENT_IDS = window.PROVIDER_IDS || ['claude', 'codex', 'gemini']; // the extension's provider registry (agent-icons.js)
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
  const micWrap = document.getElementById('micWrap');
  const polishBtn = document.getElementById('polishBtn');
  polishBtn.disabled = !promptInput.value.trim();
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
  const pendingAttachments = new Map();
  let waitingToSend = null;
  let emptyMascot = null;
  const chatDrafts = new Map();
  const projectBar = document.createElement('div');
  projectBar.className = 'project-toolbar'; projectBar.hidden = true;
  const projectBtn = document.createElement('button');
  projectBtn.type = 'button'; projectBtn.className = 'project-picker'; projectBtn.textContent = 'Choose project';
  projectBtn.setAttribute('aria-label', 'Choose project');
  projectBtn.addEventListener('click', () => { if (editingQueue) finishQueueEdit(); vscode.postMessage({ type: 'chooseProject' }); });
  projectBar.append(projectBtn);
  // This chat's git worktree (/worktree new): its branch and how many files it has changed. Hidden for a chat in the project folder.
  const worktreeChip = document.createElement('button');
  worktreeChip.type = 'button'; worktreeChip.className = 'worktree-chip'; worktreeChip.hidden = true;
  worktreeChip.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="6" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.6c0 2.6-3 2.2-7 3.6"/></svg><span></span>';
  worktreeChip.addEventListener('click', () => vscode.postMessage({ type: 'worktreeMenu' }));
  projectBar.append(worktreeChip);
  // The rail is one glass pill with a squircle tile per registered project, drawn like the chat tiles under it. The
  // chat's own project wears the white rim. While a turn runs, a ring glides to the project the agent's tools are
  // editing (matched by file path against the project roots), so a hop into Visor or Clanker shows itself as the
  // ring. The chat stays bound to its own project. Fed by 'project' and the history snapshots.
  const projectList = document.createElement('div');
  projectList.className = 'project-pill'; projectList.setAttribute('role', 'list');
  let railPinnedProjects = [], projectModal = null;
  let railProjectsLoaded = false;
  // A pushpin standing upright: the head fills when the project is pinned (CSS), the needle stays a line.
  const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="pin-head" d="M9.2 3.5h5.6l-.5 6 3.2 3.6H6.5l3.2-3.6z"/><path d="M12 13.1v7.4"/></svg>';
  const SEARCH_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
  const PLUS_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
  const projectFocus = document.createElement('span');
  projectFocus.className = 'project-focus'; projectFocus.setAttribute('aria-hidden', 'true');
  const railIconsLoaded = new Map(); // icon data URI -> whether it is too dark to read on the tile
  // A mostly dark glyph (a black logo) vanishes on the dark tile, so it gets a light plate; coloured and light icons sit bare.
  window.isDarkIcon = isDarkIcon; // Settings > Project icons judges its previews the same way
  function isDarkIcon(image) {
    try {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, 16, 16);
      const data = context.getImageData(0, 0, 16, 16).data;
      let light = 0, weight = 0;
      for (let at = 0; at < data.length; at += 4) { const alpha = data[at + 3] / 255; light += alpha * (0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2]) / 255; weight += alpha; }
      return weight > 0 && light / weight < 0.4;
    } catch { return false; }
  }
  let railProjects = [], railActiveProject = null, railChatId = null, railSessions = [], railWorking = null, railWorkingShown = null;
  const railPath = (file) => String(file || '').replace(/\\/g, '/').toLowerCase();
  function noteWorkingFile(file) {
    if (!file || !/^([a-z]:[\\/]|\/)/i.test(file)) return;
    const target = railPath(file);
    const hit = railProjects.filter((project) => project.root).map((project) => ({ id: project.id, root: railPath(project.root).replace(/\/$/, '') }))
      .sort((a, b) => b.root.length - a.root.length).find((item) => target === item.root || target.startsWith(`${item.root}/`));
    if (hit && hit.id !== railWorking) { railWorking = hit.id; renderProjectList(); }
  }
  const projectMonogram = (name) => {
    const words = String(name || '?').split(/[\s\-_.]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).replace(/^./, (c) => c.toUpperCase());
  };
  const projectHue = (id) => { let hash = 2166136261; for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0) % 360; };
  let projectPeekCount = 0, projectEditing = false; // a rename in progress keeps the list as it is until it ends
  const projectPeekShapes = new ResizeObserver((entries) => entries.forEach(({ target, contentRect }) => {
    if (!contentRect.width || !window.bubbleOutline) return;
    const outline = window.bubbleOutline(contentRect.width, 40, 0); // no tail: the tile's squircle at the card's width
    target.querySelectorAll('.project-peek-shape path').forEach((path) => path.setAttribute('d', outline));
  }));
  function projectMark(project) {
    const mark = document.createElement('span');
    mark.className = 'project-mark'; mark.textContent = projectMonogram(project.name);
    if (project.iconUri) {
      // The project's own favicon replaces the initials once it has loaded; if it never does, the initials stay.
      const icon = document.createElement('img');
      icon.className = 'project-icon'; icon.alt = ''; icon.draggable = false;
      const show = () => { icon.classList.toggle('is-dark', railIconsLoaded.get(project.iconUri)); mark.replaceChildren(icon); };
      icon.addEventListener('load', () => { if (!railIconsLoaded.has(project.iconUri)) railIconsLoaded.set(project.iconUri, isDarkIcon(icon)); show(); });
      icon.src = project.iconUri;
      if (railIconsLoaded.has(project.iconUri)) show(); // a rebuild of the list never flashes the initials
    }
    return mark;
  }
  // The rail's recent chats (launcher.js) wear the same project marks in their hover preview.
  let railMarks = '';
  window.railProjectsReady = () => railProjectsLoaded;
  window.railProjectMark = (id) => {
    const project = railProjects.find((item) => item.id === id);
    if (!project) return null;
    const icon = document.createElement('span');
    icon.className = 'history-project-icon'; icon.style.setProperty('--hue', projectHue(id));
    icon.append(projectMark(project));
    return icon;
  };
  // The card's width comes from its name. It is set before the hover, so the width transition never has to change its target.
  const sizePeek = (item) => { const label = item.querySelector('.project-peek-text span'); if (label) item.style.setProperty('--peek-w', `${Math.min(260, Math.max(150, label.scrollWidth + 18 + 34 + 40 + 6))}px`); };
  function renderProjectList() {
    if (!railProjectsLoaded) return;
    if (projectEditing) return;
    const chat = railSessions.find((session) => session.id === railChatId);
    const touched = new Set(chat?.touchedProjectIds || []);
    const running = new Set(railSessions.filter((session) => session.state && session.id !== railChatId).map((session) => session.projectId));
    const target = busy ? railWorking || railActiveProject : null;
    const recentIds = [...railSessions].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).map(session => session.projectId);
    // The chat's own project always stays, then the pinned favorites, then the most recent; Settings sets how many fit (0 = all).
    const unique = (ids) => ids.map(id => railProjects.find(project => project.id === id)).filter((project, index, projects) => project && projects.findIndex(item => item?.id === project.id) === index);
    const limit = window.RAIL_LIMITS?.projects || Infinity;
    const keep = new Set(unique([railActiveProject, ...railPinnedProjects, ...recentIds, ...railProjects.map(project => project.id)]).slice(0, limit));
    const visible = unique([...railPinnedProjects, railActiveProject, ...recentIds, ...railProjects.map(project => project.id)]).filter(project => keep.has(project));
    const items = visible.map((project) => {
      const active = project.id === railActiveProject;
      const item = document.createElement('div');
      item.className = 'project-item'; item.setAttribute('role', 'listitem'); item.dataset.id = project.id;
      item.style.setProperty('--hue', projectHue(project.id));
      const tile = document.createElement('button');
      tile.type = 'button'; tile.className = 'project-tile';
      tile.classList.toggle('is-active', active);
      tile.classList.toggle('is-touched', !active && touched.has(project.id));
      tile.classList.toggle('is-working', project.id === target);
      tile.title = `${project.name}${project.root ? `\n${project.root}` : '\nPlanning project'}${project.id === target && !active ? '\nThe agent is working here' : ''}`;
      tile.setAttribute('aria-label', `${project.name}${active ? ' (this chat)' : ''}${project.id === target ? ', working here now' : ''}`);
      if (active) tile.setAttribute('aria-current', 'true');
      else tile.addEventListener('click', () => { if (editingQueue) finishQueueEdit(); vscode.postMessage({ type: 'openProject', projectId: project.id }); });
      tile.append(projectMark(project));
      // Hover: the tile grows to the left into a card with the name beside the icon, drawn like a chat's preview in the Recent
      // list (launcher.js historyPeek). Its width is set from the name, so a short name gets a short card.
      const peek = document.createElement('div');
      peek.className = 'project-peek'; peek.setAttribute('aria-hidden', 'true');
      for (const state of ['is-active', 'is-touched', 'is-working']) peek.classList.toggle(state, tile.classList.contains(state));
      const clipId = `project-peek-${++projectPeekCount}`;
      peek.innerHTML = `<svg class="project-peek-shape"><defs><clipPath id="${clipId}"><path/></clipPath></defs><g clip-path="url(#${clipId})"><path class="project-peek-fill"/><path class="project-peek-rim"/></g></svg><div class="project-peek-text"><span></span></div><button type="button" class="project-edit" title="Rename project" aria-label="Rename project">${PENCIL_SVG}</button><span class="project-peek-mark"></span>`;
      const label = peek.querySelector('.project-peek-text span');
      label.textContent = project.name;
      peek.querySelector('.project-peek-mark').append(projectMark(project));
      peek.addEventListener('click', () => tile.click());
      projectPeekShapes.observe(peek);
      item.addEventListener('mouseenter', () => { if (!item.classList.contains('is-editing')) sizePeek(item); });
      // The pencil turns the name into a field in place; Enter or leaving it saves, Escape keeps the old name.
      peek.querySelector('.project-edit').addEventListener('click', (event) => {
        event.stopPropagation();
        const input = document.createElement('input');
        input.className = 'project-rename'; input.value = project.name; input.maxLength = 120; input.spellcheck = false;
        input.setAttribute('aria-label', 'Project name');
        let done = false;
        const finish = (save) => {
          if (done) return; done = true;
          projectEditing = false; item.classList.remove('is-editing');
          const name = input.value.trim();
          if (save && name && name !== project.name) vscode.postMessage({ type: 'renameProject', projectId: project.id, name });
          renderProjectList();
        };
        input.addEventListener('keydown', (key) => { if (key.key === 'Enter') finish(true); else if (key.key === 'Escape') finish(false); key.stopPropagation(); });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', (click) => click.stopPropagation());
        projectEditing = true; item.classList.add('is-editing'); item.style.setProperty('--peek-w', '260px');
        label.replaceChildren(input); input.focus(); input.select();
      });
      item.append(tile, peek);
      if (running.has(project.id)) { const dot = document.createElement('i'); dot.className = 'project-live'; dot.title = 'A chat is running here'; item.append(dot); }
      if (!active) {
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'project-x'; remove.textContent = '×';
        remove.title = `Remove ${project.name} from Clanker`; remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', () => vscode.postMessage({ type: 'removeProject', projectId: project.id }));
        item.append(remove);
      }
      return item;
    });
    const all = document.createElement('div');
    all.className = 'project-item is-all'; all.setAttribute('role', 'listitem');
    const hiddenRunning = railProjects.filter(project => !visible.includes(project) && (running.has(project.id) || project.id === target)).length;
    const label = `All projects · ${railProjects.length}${hiddenRunning ? ` · ${hiddenRunning} hidden project${hiddenRunning === 1 ? '' : 's'} running` : ''}`;
    all.innerHTML = '<button type="button" class="project-tile" id="allProjectsBtn" aria-haspopup="dialog"><span class="project-mark"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="4.5" height="4.5" rx="1"/><rect x="9.5" y="2" width="4.5" height="4.5" rx="1"/><rect x="2" y="9.5" width="4.5" height="4.5" rx="1"/><rect x="9.5" y="9.5" width="4.5" height="4.5" rx="1"/></svg></span></button>';
    all.firstChild.title = label; all.firstChild.setAttribute('aria-label', label);
    all.firstChild.setAttribute('aria-expanded', String(projectModal?.el.hidden === false));
    all.firstChild.addEventListener('click', () => { renderProjectGallery(); toggleModal(projectModal); });
    if (hiddenRunning) { const dot = document.createElement('i'); dot.className = 'project-overflow-live'; all.append(dot); }
    projectList.replaceChildren(projectFocus, ...items, all);
    items.forEach(sizePeek);
    const focusItem = target && items.find((item) => item.dataset.id === target);
    projectList.classList.toggle('is-busy', Boolean(focusItem));
    if (focusItem) {
      projectFocus.style.transform = `translateY(${focusItem.offsetTop - 4}px)`;
      if (railWorkingShown && railWorkingShown !== target) focusItem.firstChild.animate([{ scale: '0.9' }, { scale: '1.06', offset: 0.55 }, { scale: '1' }], { duration: 520, easing: 'cubic-bezier(0.34, 1.36, 0.64, 1)' });
    }
    railWorkingShown = target;
    renderProjectGallery();
  }
  const topbar = document.querySelector('.topbar');
  const railScroll = document.querySelector('.rail-scroll');
  if (railScroll) {
    // The sidebar chat keeps its project under the usage, labelled like the other sections.
    projectBar.classList.add('launcher-section', 'is-rail');
    const label = document.createElement('div');
    label.className = 'launcher-label'; label.textContent = 'Project';
    projectBar.prepend(label);
    projectBar.insertBefore(projectList, projectBtn);
    projectBar.hidden = false;
    projectBtn.hidden = true;
    projectList.setAttribute('aria-busy', 'true');
    projectList.setAttribute('aria-label', 'Projects');
    projectList.innerHTML = Array.from({ length: 3 }, () => '<div class="project-item rail-skeleton" aria-hidden="true"><i class="rail-skeleton-tile skeleton"></i></div>').join('');
    railScroll.querySelector('.launcher-section.is-grow').before(projectBar);
  } else if (topbar) topbar.prepend(projectBar); else transcriptEl.before(projectBar);

  const attachmentStrip = document.createElement('div');
  attachmentStrip.className = 'attachment-strip attachment-grid island-bud';
  document.querySelector('.compose-row').insertBefore(attachmentStrip, document.querySelector('.composer'));
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button'; attachBtn.id = 'attachBtn'; attachBtn.className = 'composer-icon-btn'; attachBtn.title = 'Attach files';
  attachBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  document.querySelector('.composer-tools').prepend(attachBtn); // left edge of the bottom bar, the model picker right behind it

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
    others.forEach((el) => {
      if (['historyModal', 'projectsModal', 'agentsModal', 'logsModal'].includes(el.id)) closeModal(el);
      else el.hidden = true;
    });
    document.getElementById('loopsBtn')?.setAttribute('aria-expanded', String(modal.el.id === 'loopsModal'));
    document.getElementById('allProjectsBtn')?.setAttribute('aria-expanded', String(modal.el.id === 'projectsModal'));
    modal.el.hidden = false;
    if (modal === settingsModal) chatSettings.mountModelPicker();
    if (modal === historyModal) renderHistory(historySessions);
    if (modal === projectModal) renderProjectGallery();
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
    el.querySelector('.history-card input, .history-folder-card input.title-edit, .project-gallery input')?.blur();
    el.hidden = true;
    if (el.id === 'historyModal') {
      closeFolderMenu();
      closeFolderCreator();
      editingFolderChatsId = null;
      historyModal.body.replaceChildren();
      reusableHistoryCards.clear();
    }
    if (el.id === 'agentsModal') { agentPane.replaceChildren(); agentLog = null; }
    if (el.id === 'projectsModal') projectModal.body.querySelector('.project-gallery').replaceChildren();
    if (el.id === 'loopsModal') document.getElementById('loopsBtn')?.setAttribute('aria-expanded', 'false');
    if (el.id === 'projectsModal') document.getElementById('allProjectsBtn')?.setAttribute('aria-expanded', 'false');
    if (el.id === 'cliSetupModal') { chatSettings.mountModelPicker(); vscode.postMessage({ type: 'completeCliSetup' }); }
    if (el.id === 'logsModal') logViewer?.hide();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    else if (el.id === 'projectsModal') document.getElementById('allProjectsBtn')?.focus();
  }
  projectModal = createModal('projectsModal', 'All projects');
  projectModal.body.innerHTML = `<div class="project-gallery-tools"><label class="project-gallery-searchbox">${SEARCH_SVG}<input class="project-gallery-search cs-field" type="search" aria-label="Search projects" placeholder="Find a project…"></label><span class="project-gallery-quota" title="Pinned favorites">${PIN_SVG}<span></span></span></div><p class="project-gallery-note">Pin up to two favorites. The current project always stays visible, and the others keep running.</p><div class="project-gallery"></div><div class="project-gallery-actions"><button type="button" class="cs-btn" data-action="add">${PLUS_SVG}Add project</button><button type="button" class="cs-btn is-quiet" data-action="manage">Manage projects</button></div>`;
  const projectSearch = projectModal.body.querySelector('.project-gallery-search');
  projectSearch.addEventListener('input', () => renderProjectGallery());
  for (const action of ['add', 'manage']) projectModal.body.querySelector(`[data-action="${action}"]`).addEventListener('click', () => {
    closeModal(projectModal.el);
    if (editingQueue) finishQueueEdit();
    vscode.postMessage({ type: action === 'add' ? 'addProject' : 'manageProjects' });
  });
  let galleryEditing = false;
  function renderProjectGallery(focusAfter) {
    if (!projectModal || projectModal.el.hidden || document.hidden) return;
    if (!projectModal || galleryEditing) return; // a rename in progress keeps its field; its own save redraws
    const grid = projectModal.body.querySelector('.project-gallery');
    const focusId = focusAfter || document.activeElement.closest('.project-gallery-card')?.dataset.id;
    const focusSelector = focusAfter ? '.project-gallery-edit' : ['.project-gallery-pin', '.project-gallery-edit', '.project-gallery-remove'].find(selector => document.activeElement.matches(selector)) || '.project-gallery-open';
    const query = projectSearch.value.trim().toLocaleLowerCase();
    const projects = railProjects.filter(project => `${project.name} ${project.root || ''}`.toLocaleLowerCase().includes(query));
    projectModal.count.textContent = String(railProjects.length);
    const quota = projectModal.body.querySelector('.project-gallery-quota');
    quota.lastElementChild.textContent = `${railPinnedProjects.length} / 2`;
    quota.classList.toggle('is-full', railPinnedProjects.length >= 2);
    grid.replaceChildren(...projects.map(project => {
      const card = document.createElement('div'); card.className = 'project-gallery-card'; card.dataset.id = project.id;
      card.style.setProperty('--hue', projectHue(project.id));
      const open = document.createElement('button'); open.type = 'button'; open.className = 'project-gallery-open';
      const active = project.id === railActiveProject;
      const sessions = railSessions.filter(session => session.projectId === project.id && session.state);
      const state = sessions.some(session => session.state === 'waiting') ? 'Needs input' : sessions.length || (busy && (railWorking || railActiveProject) === project.id) ? 'Running' : '';
      open.classList.toggle('is-active', active); if (active) open.setAttribute('aria-current', 'true');
      open.title = `${project.name}${project.root ? `\n${project.root}` : '\nPlanning project'}`;
      const name = document.createElement('span'); name.className = 'project-gallery-name'; name.textContent = project.name;
      const status = document.createElement('span'); status.className = 'project-gallery-status'; status.classList.toggle('is-running', Boolean(state));
      status.classList.toggle('is-waiting', state === 'Needs input');
      status.textContent = active ? `Current project${state ? ` · ${state}` : ''}` : state || (project.root ? 'Ready' : 'Planning project');
      const text = document.createElement('span'); text.className = 'project-gallery-text'; text.append(name, status);
      open.append(projectMark(project), text);
      open.addEventListener('click', () => {
        closeModal(projectModal.el);
        if (!active) { if (editingQueue) finishQueueEdit(); vscode.postMessage({ type: 'openProject', projectId: project.id }); }
      });
      const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'project-gallery-pin'; pin.innerHTML = PIN_SVG;
      const pinned = railPinnedProjects.includes(project.id);
      card.classList.toggle('is-pinned', pinned);
      pin.setAttribute('aria-pressed', String(pinned)); pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${project.name}`);
      pin.disabled = !pinned && railPinnedProjects.length >= 2;
      pin.title = pin.disabled ? 'Unpin a favorite first' : `${pinned ? 'Unpin' : 'Pin'} ${project.name}`;
      pin.addEventListener('click', () => vscode.postMessage({ type: 'pinProject', projectId: project.id, pinned: !pinned }));
      // Rename and Remove appear when the row is hovered or focused, left of the pin. The chat's own project cannot be removed.
      const more = document.createElement('span'); more.className = 'project-gallery-more';
      const tool = (cls, icon, label) => { const button = document.createElement('button'); button.type = 'button'; button.className = `project-gallery-tool ${cls}`; button.innerHTML = icon; button.title = label; button.setAttribute('aria-label', label); more.append(button); return button; };
      tool('project-gallery-edit', PENCIL_SVG, `Rename ${project.name}`).addEventListener('click', () => {
        const input = document.createElement('input');
        input.className = 'project-gallery-rename'; input.value = project.name; input.maxLength = 120; input.spellcheck = false;
        input.setAttribute('aria-label', 'Project name');
        let done = false;
        const finish = (save, refocus) => {
          if (done) return; done = true; galleryEditing = false;
          const next = input.value.trim();
          if (save && next && next !== project.name) { project.name = next; vscode.postMessage({ type: 'renameProject', projectId: project.id, name: next }); }
          renderProjectGallery(refocus ? project.id : undefined);
        };
        input.addEventListener('keydown', (key) => {
          if (key.key === 'Enter' || key.key === 'Escape') key.preventDefault(); // else Enter would also press the pencil focus returns to
          if (key.key === 'Enter') finish(true, true); else if (key.key === 'Escape') finish(false, true);
          key.stopPropagation();
        });
        input.addEventListener('blur', () => finish(true));
        galleryEditing = true; card.classList.add('is-editing'); card.append(input); input.focus(); input.select();
      });
      if (!active) tool('project-gallery-remove is-danger', TRASH_SVG, `Remove ${project.name} from Clanker`).addEventListener('click', () => vscode.postMessage({ type: 'removeProject', projectId: project.id }));
      card.append(open, more, pin);
      return card;
    }));
    if (!projects.length) { const empty = document.createElement('p'); empty.className = 'project-gallery-note'; empty.textContent = query ? 'No matching projects.' : 'Add a project to get started.'; grid.append(empty); }
    if (focusId) [...grid.children].find(card => card.dataset.id === focusId)?.querySelector(focusSelector)?.focus();
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
  const TOOL_PREFS = { openFailed: false, ...(window.TOOL_PREFS || {}) }; // aiChatPanel.openFailedToolCards, kept current by the 'toolPrefs' message
  const HOUR_CYCLE = { '24h': 'h23', '12h': 'h12' }[TIME_PREFS.timeFormat || '24h'];
  const clockParts = (extra) => ({ ...extra, hour: '2-digit', minute: '2-digit', ...(HOUR_CYCLE ? { hourCycle: HOUR_CYCLE } : {}) });
  function formatWhen(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : window.chatTime.formatDate(date, TIME_PREFS.locale, clockParts({ month: 'short', day: 'numeric' }));
  }
  function quotaForEntry(option, fallbackAgent) {
    const agent = option?.agent || fallbackAgent;
    if (!option) return lastQuotas[agent] || null;
    if (agent === 'gemini') {
      if (/argon/i.test(option.model || option.id || '')) return lastQuotas.antigravityArgon || lastQuotas.gemini || null;
      if ((option.company && option.company !== 'Google') || /^(?:gemini:)?(?:claude|gpt)-/i.test(option.id || option.model || '')) return lastQuotas.antigravityClaudeGpt || lastQuotas.gemini || null;
    }
    if (agent === 'claude' && option.brand === 'opus') return lastQuotas.opus || lastQuotas.claude || null;
    return lastQuotas[agent] || null;
  }
  function queuedTurnBlocked(entry) {
    const agent = optionFor(entry?.modelId)?.agent;
    return !entry?.scheduled && schedulerTasks.some(task => task.status === 'pending' && task.chatId === currentChatId && task.model === agent
      && (agent !== 'gemini' || !task.modelId || !entry?.modelId || task.modelId === entry.modelId) && resetWaiting(task));
  }
  // When a task will actually fire: its fixed time, else its model's next quota reset.
  function fireTimeOf(task) {
    if (task.dispatchTrigger === 'fixed-time') return Date.parse(task.dispatchTime) || null;
    // Keep the reset this task was scheduled for, even after the provider starts a new window.
    const saved = Date.parse(task.notBefore);
    if (Number.isFinite(saved)) return saved;
    const resetsAt = quotaForEntry(optionFor(task.modelId), task.model)?.resetsAt;
    return typeof resetsAt === 'number' ? resetsAt * 1000 : null;
  }
  function resetWaiting(task) {
    const quota = quotaForEntry(optionFor(task?.modelId), task?.model);
    return task?.dispatchTrigger === 'quota-reset' && (Date.parse(task.notBefore) > Date.now() || quota?.remaining === 0 || quota?.secondary?.remaining === 0);
  }
  function resetLabel(task) {
    const at = fireTimeOf(task);
    return at && at > Date.now() ? `at reset · ${formatCountdown(at - Date.now())}` : resetWaiting(task) ? 'waiting for usage' : '';
  }
  // The time beside a scheduled row's clock. "at reset · 45m 43s" keeps "at reset · " in its own span, so a narrow row can show
  // just the countdown (style.css), and the whole label is the tooltip for when even that is dropped.
  function setWhenLabel(row, label) {
    const text = row.querySelector('.turn-queue-when-text');
    if (text.textContent === label) return;
    const [, lead, rest] = /^(at reset · )(.+)$/.exec(label) || [];
    if (!lead) text.textContent = label;
    else if (text.firstElementChild?.className === 'tq-lead') text.lastChild.textContent = rest;
    else {
      const span = document.createElement('span');
      span.className = 'tq-lead'; span.textContent = lead;
      text.replaceChildren(span, rest);
    }
    const when = text.parentElement;
    if (when.title !== label) when.title = label;
  }
  function scheduledLabel(task) {
    const repeat = task.recurrence ? `repeats every ${formatEvery(task.recurrence.everyMinutes)}, run ${task.recurrence.run} of ${task.recurrence.maxRuns}` : '';
    if (dueNow(task)) return repeat;
    const at = fireTimeOf(task);
    const when = task.dispatchTrigger === 'quota-reset' ? resetLabel(task) : at ? formatWhen(at) : '';
    return repeat && when ? `${when} \u00b7 ${repeat}` : when || repeat;
  }
  function formatEvery(minutes) {
    return minutes % 60 === 0 ? `${minutes / 60} h` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }
  // A scheduled prompt whose time has come only waits for its chat's turn: that is a queued prompt, not a third state.
  function dueNow(task) {
    return task.dispatchTrigger === 'quota-reset' ? !resetWaiting(task) && !(fireTimeOf(task) > Date.now()) : !(fireTimeOf(task) > Date.now());
  }
  let schedulerQueueLoaded = false;
  let isChatSwitching = false;
  let chatLoadingQueueCount = (() => {
    if (window.INITIAL_QUEUE_LOADING === null) return null;
    if (typeof window.INITIAL_QUEUE_LOADING === 'number') return Math.max(0, window.INITIAL_QUEUE_LOADING);
    try { return Math.min(3, Math.max(0, Number(vscode.getState()?.queueSkeletonCount) || 0)); } catch { return 0; }
  })();
  // Placeholder rows only for prompts known to be on their way. An unknown count (null) shows nothing: a "Loading prompts…" strip
  // that may turn out to hold no prompts at all is just noise.
  const loadingQueueCount = () => (chatLoadingQueueCount === null ? 0 : Math.min(3, Math.max(0, Number(chatLoadingQueueCount) || 0)));
  function persistQueueHint(count) {
    try {
      const next = Math.min(3, Math.max(0, count));
      const state = vscode.getState() || {};
      if ((state.queueSkeletonCount || 0) !== next) vscode.setState({ ...state, queueSkeletonCount: next });
    } catch {}
  }
  const hasQueuedTransport = () => !isChatSwitching && (turnQueue.length > 0 || scheduledHere().some(dueNow));
  const hasPausedDue = () => queuePaused && !isChatSwitching && scheduledHere().some(dueNow);
  function turnQueueTitle() {
    const loading = loadingQueueCount();
    const scheduled = isChatSwitching ? [] : scheduledHere();
    const queued = isChatSwitching ? [] : turnQueue;
    const due = scheduled.filter(dueNow).length, waiting = scheduled.length - due;
    const parts = [queued.length + due && `${queued.length + due}${queuePaused ? ' queued · paused' : ' queued · sends after this turn'}`, waiting && `${waiting} scheduled`].filter(Boolean);
    if (loading) parts.push(parts.length ? 'loading scheduled…' : (isChatSwitching ? 'Loading prompts…' : 'Loading scheduled prompts…'));
    return parts.join(' · ');
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
    const times = activeTasks().filter((task) => task.status === 'pending').map(fireTimeOf).filter(at => at > Date.now());
    const next = times.length ? Math.min(...times) : null;
    const lines = next ? countdownLines(next - Date.now()) : [];
    const key = lines.length;
    // one element per line; only the text changes each second
    if (queueCountdown.childElementCount !== key) queueCountdown.replaceChildren(...lines.map(() => document.createElement('span')));
    lines.forEach((text, i) => { const el = queueCountdown.children[i]; if (el.textContent !== text) el.textContent = text; });
    queueCountdown.title = next ? formatCountdown(next - Date.now()) : '';
    document.querySelectorAll('.turn-queue-item.is-scheduled').forEach((row) => { // the strip's own countdowns
      const task = schedulerTasks.find((item) => item.id === row.dataset.taskId);
      if (!task) return;
      renderQueueMark(row, true);
      setWhenLabel(row, scheduledLabel(task));
    });
    document.querySelectorAll('.turn-queue-item .is-primary').forEach(button => {
      const row = button.closest('.turn-queue-item'), entry = row.queueEntry;
      button.disabled = row.classList.contains('is-scheduled') ? resetWaiting(entry) : queuedTurnBlocked(entry);
    });
    document.querySelectorAll('.queue-card .queue-take[data-reset-send]').forEach(button => {
      button.disabled = resetWaiting(schedulerTasks.find(task => task.id === button.dataset.resetSend));
    });
    const heading = document.querySelector('.turn-queue-head > span');
    if (heading && heading.textContent !== turnQueueTitle()) heading.textContent = turnQueueTitle();
    const transport = document.querySelector('.turn-queue-head > .queue-transport');
    if (transport) {
      const showTransport = hasQueuedTransport();
      if (transport.hidden !== !showTransport) transport.hidden = !showTransport;
    }
    queueBtn.classList.toggle('is-pill', Boolean(next));
    renderSchedPill(); // refresh countdowns; close only when no chats remain
  }
  function renderQueueButton() {
    const count = activeTasks().length;
    queueBtn.hidden = count === 0;
    queueBadge.textContent = String(count);
    queueBadge.dataset.count = String(count);
    if (!queueBtn.classList.contains('is-sched-open')) queueBtn.title = `${count} scheduled prompt${count === 1 ? '' : 's'}`;
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
      if (type === 'dispatchNowWithAutoRoute') { btn.dataset.resetSend = task.id; btn.disabled = resetWaiting(task); }
      btn.addEventListener('click', () => { card.classList.add('is-leaving'); vscode.postMessage({ type, taskId: task.id }); closeModal(queueModal.el); });
      return btn;
    };
    head.append(position, modelPill(task.model, task.modelId), when);
    if (pending) { // a dispatched task is already running
      head.append(
        take(QUEUE_ICONS.send, 'Send Now', 'Send when this prompt is ready', 'dispatchNowWithAutoRoute'),
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
    if (task.files?.length) card.append(queuedFilesBadge(task.files));
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
  const cliSetupModal = createModal('cliSetupModal', 'Welcome to Clanker');
  // Logs: what went wrong (lib/log.js). Opened from Settings > General, or the "Show Logs" command. Its page is log-viewer.js.
  const logsModal = createModal('logsModal', 'Logs');
  var logViewer = window.initLogViewer ? window.initLogViewer({ vscode, modal: logsModal }) : null;
  function openLogs(level) { if (!logViewer) return; openModal(logsModal); logViewer.show(level); }
  const chatSettings = window.initChatSettings({
    vscode,
    body: settingsModal.body,
    onOpenSetupGuide: () => {
      closeModal(settingsModal.el);
      cliSetup.show();
      openModal(cliSetupModal);
      vscode.postMessage({ type: 'requestCliConnections' });
    },
    onOpenLogs: () => openLogs(),
  });
  vscode.postMessage({ type: 'requestApiValue' });
  const loopsModal = createModal('loopsModal', 'Loops');
  loopsModal.body.classList.add('cs');
  const loopsBtn = document.getElementById('loopsBtn');
  const loopElapsed = document.getElementById('loopElapsed');
  let loopState = null, loopWasActive = false, loopFinishedUntil = 0, loopFinishedLabel = '', loopTick = null;
  function tickLoopElapsed() {
    const activeIds = loopState?.activeRunIds || (loopState?.activeRunId ? [loopState.activeRunId] : []);
    const jobs = (loopState?.jobs || []).filter(job => job.enabled || loopState.runs.some(run => run.jobId === job.id && activeIds.includes(run.id)));
    const active = jobs.length > 0 || activeIds.length > 0;
    if (active) {
      const starts = jobs.map(job => job.startedAt || loopState.runs.find(run => run.jobId === job.id && run.status !== 'skipped')?.startedAt || job.createdAt);
      starts.push(...loopState.runs.filter(run => activeIds.includes(run.id)).map(run => run.startedAt));
      const started = Math.min(...starts.filter(Number.isFinite));
      const seconds = Math.max(0, Math.floor((Date.now() - (Number.isFinite(started) ? started : Date.now())) / 1000));
      const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
      loopElapsed.textContent = hours ? `${hours}h ${minutes}m` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      loopsBtn.title = `${jobs.length || activeIds.length} loop${(jobs.length || activeIds.length) === 1 ? '' : 's'} active · ${loopElapsed.textContent} elapsed`;
      loopFinishedUntil = 0;
    } else {
      if (loopWasActive) {
        loopFinishedUntil = Date.now() + 6000;
        const last = (loopState.jobs || []).filter(job => job.startedAt || loopState.runs.some(run => run.jobId === job.id)).at(-1);
        loopFinishedLabel = /paused|no new source/i.test(last?.reason || '') ? 'Paused' : /finished|limit reached|expired/i.test(last?.reason || '') ? 'Done' : 'Stopped';
      }
      loopElapsed.textContent = Date.now() < loopFinishedUntil ? loopFinishedLabel : '';
      loopsBtn.title = loopElapsed.textContent ? `Loops · ${loopElapsed.textContent}` : 'Loops';
    }
    loopWasActive = active;
    loopsBtn.classList.toggle('is-pill', Boolean(loopElapsed.textContent));
    loopsBtn.classList.toggle('is-running', active);
    loopsBtn.classList.toggle('is-finished', !active && Boolean(loopElapsed.textContent));
    if (!active && !loopElapsed.textContent) { clearInterval(loopTick); loopTick = null; }
  }
  const investigations = window.initInvestigations({ vscode, root: loopsModal.body, onState: state => {
    loopState = state; tickLoopElapsed();
    if ((loopWasActive || loopFinishedUntil > Date.now()) && !loopTick) loopTick = setInterval(tickLoopElapsed, 1000);
  } });
  function openLoops() { openModal(loopsModal); investigations.show(); }
  loopsBtn.addEventListener('click', () => { if (toggleModal(loopsModal)) investigations.show(); });
  investigations.watch();
  const cliSetup = window.initCliSetup({
    vscode,
    body: cliSetupModal.body,
    onModelsStep: container => chatSettings.mountModelPicker(container),
    onClose: () => closeModal(cliSetupModal.el),
    onOpenSettings: (tab) => {
      closeModal(cliSetupModal.el);
      openModal(settingsModal);
      vscode.postMessage({ type: 'requestFleet' });
      if (tab) chatSettings.showTab(tab);
    },
    onStartOnboardingChat: () => {
      closeModal(cliSetupModal.el);
      const guidePrompt = 'Help me finish setting up Clanker Controller for my machine. Walk me through checking my connected CLIs (including GitHub Copilot in `ai-chat-panel/lib/providers/copilot.js` and `docs/adding-a-provider.md`), favorite models, voice dictation, and smart routing.';
      promptInput.value = guidePrompt;
      autoGrow();
      renderComposerState();
      promptInput.focus();
    },
  });
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

  // Routing is one picker choice. The host retains its mode API for Settings and Visor.
  let routingMode = 'manual';
  let routingConnected = { cloudflare: false, groq: false };

  // ---------- P16-J: inline schedule toggle ----------
  // One input, not two: the composer's clock button arms "schedule instead
  // of send" for the next submit (Enter or the send arrow), queued for the
  // active model's next quota reset.
  let scheduleTitle = 'Schedule the next message: click to choose when (usage reset, timer or calendar)'; // the tooltip without the time
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
  document.querySelector('.composer-actions').insertBefore(scheduleBtn, micWrap); // clock, format, dictate, then the one send/stop slot
  // Hovering the clock opens the timer pill (schedule-timer.js); picking a time arms scheduling for it.
  const scheduleTime = document.createElement('span');
  scheduleTime.className = 'schedule-time';
  scheduleBtn.append(scheduleTime);
  const scheduleMenu = createIslandMenu('schedule-menu', 'Schedule');
  scheduleMenu.setAttribute('role', 'dialog');
  const scheduleTimer = window.initScheduleTimer({
    button: scheduleBtn,
    composer: document.querySelector('.composer'),
    // The picker is a menu on the composer's upper glass slab, like the model and permission menus (createIslandMenu).
    menu: scheduleMenu,
    placeMenu: (centerX) => placeIslandMenu(scheduleMenu, centerX, 248),
    setMenuOpen: (open) => {
      if (open) { closeMentionMenu(); closeSlashMenu(); closeModelMenu(); closePermMenu(); }
      setIslandMenuOpen(scheduleMenu, open);
    },
    preferred: window.SCHEDULE_MODE, // the mode the last scheduled prompt used (saved by the host)
    // The chosen model's two limits, for the usage-reset mode: what it waits for and when that comes.
    usage: () => {
      const quota = quotaForEntry(activeAgent === 'auto' ? null : optionFor(activeModelId), scheduleModel());
      return { windows: [
        { key: '5h', name: '5h', remaining: quota?.remaining ?? null, resetsAt: quota?.resetsAt ?? null },
        { key: '7d', name: '7d', remaining: quota?.secondary?.remaining ?? null, resetsAt: quota?.secondary?.resetsAt ?? null },
      ] };
    },
    onChange: (nextMode = scheduleTimer.mode) => {
      scheduleChoice = nextMode !== null;
      if (editingQueue) editingQueue.scheduleTouched = true;
      refreshScheduleDefault();
      renderComposerState();
      if (nextMode === null) promptInput.focus();
    },
  });
  const countdownClock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  };
  // Beside its icon the clock shows only what scheduling mode is active for the message currently being composed
  // (reset countdown, timer delay, or calendar date/time); when off, already-sent prompts do not echo here.
  function renderScheduleTime() {
    let text = '';
    if (scheduleTimer.mode) {
      text = scheduleTimer.short();
      if (!text && scheduleTimer.mode === 'reset' && editingQueue?.taskId && !editingQueue.scheduleTouched && editingQueue.notBefore > Date.now()) {
        text = countdownClock(editingQueue.notBefore - Date.now());
      }
    }
    if (scheduleTime.textContent !== text) scheduleTime.textContent = text;
    scheduleBtn.classList.toggle('has-time', Boolean(text));
    // On a narrow composer the time is not drawn beside the icon (style.css fit-time), so the tooltip carries it.
    const title = text ? `${text} · ${scheduleTitle}` : scheduleTitle;
    if (scheduleBtn.title !== title) scheduleBtn.title = title;
  }
  setInterval(renderScheduleTime, 1000);

  const AGENT_LABELS = AGENT_NAMES;
  const DEFAULT_PLACEHOLDER = promptInput.placeholder;
  let editingQueue = null;
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
    scheduleTitle = armed && outOfUsage
      ? `${AGENT_LABELS[scheduleModel()]} is out of usage, so messages are scheduled for its reset. Click to change how, or to send now.`
      : armed ? `The next message is scheduled ${modeName}. Click for the next mode: usage reset, timer, calendar, off.` : 'Schedule the next message: click to choose when (usage reset, timer or calendar)';
    document.querySelector('.composer').classList.toggle('is-scheduled', armed);
    promptInput.placeholder = armed
      ? `Click to type a prompt for ${AGENT_LABELS[scheduleModel()]}. It sends ${scheduleTimer.describe() || 'when quota resets'}\u2026`
      : DEFAULT_PLACEHOLDER;
    renderScheduleTime();
  }

  // With the chat's model out of usage, scheduling is on by default, so a run of prompts can be queued
  // without pressing the clock each time. Out of usage: the quota feed shows nothing left, or the
  // model just answered with a usage-limit message; a normal reply from it clears that again.
  // The clock still overrides (send anyway, or schedule while usage is left) until the model or chat changes.
  const limitHitAgents = new Set();
  let scheduleChoice = null; // the clock's own pick; null follows the model's usage
  function activeModelOption() { return activeAgent === 'auto' ? null : optionFor(activeModelId); }
  function limitScope(agent, modelId) { return agent === 'gemini' && modelId ? `gemini:${modelId}` : agent; }
  function modelIdForLabel(agent, label) {
    return (label && [...MODEL_OPTIONS, ...availableModels].find((option) => option.agent === agent && option.label === label)?.id) || null;
  }
  function isOutOfUsage(agent, option = activeModelOption()) {
    const quota = quotaForEntry(option, agent);
    const scope = limitScope(agent, option?.id);
    const hit = limitHitAgents.has(agent) || (scope !== agent && limitHitAgents.has(scope));
    return hit || (typeof quota?.remaining === 'number' && quota.remaining < 1);
  }
  /** The usage display shows real room left for this provider (a few percent, not a rounding leftover). */
  function hasHeadroom(agent, option = null) {
    const remaining = quotaForEntry(option, agent)?.remaining;
    return typeof remaining === 'number' && remaining >= 5;
  }
  // A reply that *is* the CLI's limit notice (one or two short lines), not an answer that happens to
  // talk about limits: those used to match too, and put "Continue when … resets" under normal replies.
  const { isLimitNotice, LIMIT_RE, limitActive } = window.limitNotice; // limit-notice.js, shared with the extension
  function refreshScheduleDefault() {
    const outOfUsage = isOutOfUsage(scheduleModel());
    setScheduleArmed(scheduleChoice ?? outOfUsage, { outOfUsage: scheduleChoice === null && outOfUsage });
  }
  // Each click is the next mode: the one last used, the other two in turn, then off (send as usual).
  scheduleBtn.addEventListener('click', () => { scheduleChoice = scheduleTimer.advance() !== null; if (editingQueue) editingQueue.scheduleTouched = true; refreshScheduleDefault(); promptInput.focus(); });
  setScheduleArmed(false);

  function schedulePrompt(text, queuedEdit = null) {
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
    const task = { model, modelId, prompt: text, ...trigger, resumeHere: true };
    if (queuedEdit) queueAction('scheduleQueuedTurn', { chatId: queuedEdit.chatId, id: queuedEdit.turn.id, task, turn: { ...queuedEdit.turn, text, modelId: pendingModelId || activeModelId, attachments: attachments.map(file => file.path) } });
    else vscode.postMessage({ type: 'scheduleTask', task, attachments: attachments.map((attachment) => attachment.path) });
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
  const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 3.5 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const DOWNLOAD_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v7.25M5.25 7.25 8 10l2.75-2.75M3.25 12.75h9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Files are stored as "<timestamp>_<name>" (or "<uuid>_<timestamp>_<name>"); people read and download the clean name.
  const shownName = (name) => String(name || '').replace(/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[_-]|\d{10,}_)+/i, '');

  function downloadAttachment(attachment) {
    if (!attachment) return;
    const name = shownName(attachment.name) || 'image.png';
    if (attachment.path) {
      vscode.postMessage({ type: 'downloadAttachment', path: attachment.path, name });
      return;
    }
    if (!attachment.uri) return;
    const a = document.createElement('a');
    a.href = attachment.uri;
    a.download = name;
    a.click();
  }

  async function imageToPngBlob(src, imageEl) {
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      if (blob.type === 'image/png') return blob;
    } catch { /* fall through to canvas */ }
    const img = imageEl?.complete && imageEl.naturalWidth ? imageEl : await new Promise((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = src;
    });
    const width = img.naturalWidth || img.width || 512;
    const height = img.naturalHeight || img.height || 512;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode image')), 'image/png'));
  }

  async function copyImageToClipboard(attachment, imageEl) {
    const src = attachment?.uri || imageEl?.src;
    const name = shownName(attachment?.name) || 'image.png';
    if (!src && !attachment?.path) return;
    try {
      if (src && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const blob = await imageToPngBlob(src, imageEl);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        if (attachment?.path) vscode.postMessage({ type: 'copyAttachment', path: attachment.path, silent: true });
        showToast(`Copied ${name} to clipboard.`);
        return;
      }
    } catch { /* fall back to host clipboard */ }
    if (attachment?.path) {
      vscode.postMessage({ type: 'copyAttachment', path: attachment.path });
      return;
    }
    showToast('Could not copy image to the clipboard.', { error: true });
  }

  let closeImageMenu = null;
  function openImageContextMenu(x, y, attachment, imageEl, onRename, onMarkup = null) {
    const entries = [
      { icon: COPY_ICON, text: 'Copy', action: 'copy', run: () => { void copyImageToClipboard(attachment, imageEl); } },
      { icon: DOWNLOAD_ICON, text: 'Download', action: 'download', run: () => downloadAttachment(attachment) },
      { icon: PENCIL_SVG, text: 'Rename', action: 'rename', run: () => onRename?.() },
    ];
    if (onMarkup) entries.push({ icon: MARKUP_ICON, text: 'Mark up', action: 'markup', run: onMarkup });
    showContextMenu(x, y, `Actions for ${shownName(attachment?.name) || 'image'}`, entries);
  }

  // One small glass menu for every right-click: entries are { icon, text, action, hint?, run }. The first entry has focus.
  function showContextMenu(x, y, label, entries) {
    closeImageMenu?.();
    const menu = document.createElement('div');
    menu.className = 'image-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    const items = entries.map(({ icon, text, action, hint, run }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'image-context-item';
      btn.dataset.action = action;
      btn.setAttribute('role', 'menuitem');
      btn.innerHTML = `${icon}<span>${escapeHtml(text)}</span>${hint ? `<kbd class="image-context-hint">${escapeHtml(hint)}</kbd>` : ''}`;
      btn.addEventListener('click', (event) => { event.stopPropagation(); closeImageMenu?.(); run(); });
      return btn;
    });
    const copyBtn = items[0];
    menu.append(...items);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    const onPointerDown = (event) => { if (!menu.contains(event.target)) closeImageMenu?.(); };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeImageMenu?.(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const idx = items.indexOf(document.activeElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        (items[(idx + step + items.length) % items.length] || items[0]).focus({ preventScroll: true });
      }
    };
    const dismiss = () => closeImageMenu?.();
    closeImageMenu = () => {
      closeImageMenu = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('blur', dismiss);
      menu.remove();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', dismiss);
    copyBtn.focus({ preventScroll: true });
  }

  const OPEN_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const MARKUP_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 3.5l2 2M3 13l.7-2.8 7-7 2.1 2.1-7 7L3 13z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function lightboxButton(cls, label, html, text = '') {
    const button = document.createElement('button');
    button.type = 'button'; button.className = cls; button.title = label; button.setAttribute('aria-label', label);
    button.innerHTML = text ? `${html}<span>${text}</span>` : html;
    return button;
  }
  // Marks are drawn on the untouched original; the host keeps both files and tells the agents where the marks are.
  function openMarkup(attachment) {
    if (!attachment?.path || !window.attachmentMarkup) return;
    void window.attachmentMarkup.open({
      src: attachment.markup?.originalUri || attachment.uri, name: shownName(attachment.name) || 'image', items: attachment.markup?.items || [],
      onDone: ({ dataUrl, markup }) => vscode.postMessage({ type: 'saveMarkup', chatId: currentChatId, path: attachment.path, data: dataUrl, markup }),
      onCancel: (problem) => { if (problem) showToast(problem, { error: true }); },
    });
  }
  // P17-J/K: one shared lightbox for composer chips and transcript images. The X, a click outside the image, or Esc closes it.
  // `extra.viewer` is a document preview ({ element, dispose } from attachment-docs.js); `extra.markup` opens the markup editor on the image.
  function openLightbox(src, caption = '', pdf = false, attachment = null, onChipRenamed = null, extra = {}) {
    const previousFocus = document.activeElement;
    const box = document.createElement('div');
    box.className = 'image-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const frame = document.createElement('div');
    frame.className = 'image-lightbox-frame';
    const toolbar = document.createElement('div');
    toolbar.className = 'image-lightbox-toolbar';
    const viewer = extra.viewer || (pdf ? window.attachmentPdf.viewer(src, caption) : null);
    const image = viewer?.element || document.createElement('img');
    const targetAttachment = attachment || { uri: src, name: caption.split('  ')[0] || 'image.png' };
    const label = document.createElement('div');
    label.className = 'image-lightbox-caption'; label.textContent = caption;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'image-lightbox-close';
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    if (extra.className) box.classList.add(extra.className);
    if (extra.viewer) {
      // Text, tables, Word, Excel, audio and video: a bounded preview inside the window, the original in the editor or the file dialog.
      box.classList.add('is-doc');
      box.setAttribute('aria-label', caption || 'Attachment preview');
      const openBtn = lightboxButton('image-lightbox-open', `Open ${caption} in editor`, OPEN_ICON);
      openBtn.addEventListener('click', (event) => { event.stopPropagation(); if (targetAttachment.path) vscode.postMessage({ type: 'openFile', path: targetAttachment.path }); });
      const downloadBtn = lightboxButton('image-lightbox-download', `Download ${caption}`, DOWNLOAD_ICON);
      downloadBtn.addEventListener('click', (event) => { event.stopPropagation(); downloadAttachment(targetAttachment); });
      toolbar.append(...(targetAttachment.path ? [openBtn] : []), ...(extra.noDownload ? [] : [downloadBtn]), closeBtn);
    } else if (!pdf) {
      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.className = 'image-lightbox-download';
      const syncLightboxName = () => {
        const clean = shownName(targetAttachment.name) || 'image.png';
        const dims = targetAttachment.dims ? `${targetAttachment.dims} px` : '';
        const nextCaption = `${clean}  ${dims}`.trim();
        label.textContent = nextCaption;
        image.alt = nextCaption;
        box.setAttribute('aria-label', nextCaption);
        const downloadTitle = `Download ${clean}`;
        downloadBtn.title = downloadTitle;
        downloadBtn.setAttribute('aria-label', downloadTitle);
        onChipRenamed?.();
      };
      syncLightboxName();
      downloadBtn.innerHTML = DOWNLOAD_ICON;
      downloadBtn.addEventListener('click', (event) => { event.stopPropagation(); downloadAttachment(targetAttachment); });
      image.src = src;
      if (/\.svg(?:\s|$)/i.test(caption)) image.classList.add('attachment-svg-preview');
      image.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openImageContextMenu(event.clientX, event.clientY, targetAttachment, image, () => renameAttachmentInline(label, targetAttachment, syncLightboxName));
      });
      if (extra.markup) {
        const markBtn = lightboxButton('image-lightbox-markup', 'Mark up image', MARKUP_ICON, 'Mark up');
        markBtn.addEventListener('click', (event) => { event.stopPropagation(); close(); extra.markup(); });
        toolbar.append(markBtn);
      }
      if (extra.openPath) {
        const openBtn = lightboxButton('image-lightbox-open', `Open ${caption} in editor`, OPEN_ICON);
        openBtn.addEventListener('click', (event) => { event.stopPropagation(); vscode.postMessage({ type: 'openFile', path: extra.openPath }); });
        toolbar.append(openBtn);
      }
      toolbar.append(downloadBtn, closeBtn);
    } else {
      box.classList.add('is-pdf');
      box.setAttribute('aria-label', caption || 'Attachment preview');
      toolbar.append(closeBtn);
    }
    frame.append(toolbar, image);
    box.append(frame, label);
    let closed = false;
    const close = () => { if (closed) return; closed = true; closeImageMenu?.(); viewer?.dispose(); box.classList.remove('is-open'); document.removeEventListener('keydown', onKey, true); previousFocus?.focus({ preventScroll: true }); setTimeout(() => box.remove(), 220); };
    // Capture phase: Esc closes the preview before anything else sees it (unless context menu or inline rename is active).
    const onKey = (event) => {
      if (closeImageMenu || box.querySelector('.attachment-rename')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const buttons = [...box.querySelectorAll('button:not(:disabled)')];
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    closeBtn.addEventListener('click', close);
    box.addEventListener('click', (event) => { if (event.target === box || event.target === frame || event.target === toolbar || event.target === label) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(box);
    requestAnimationFrame(() => { if (!closed) { box.classList.add('is-open'); closeBtn.focus({ preventScroll: true }); } });
  }
  function renderAttachments() {
    attachmentStrip.replaceChildren(...attachments.map((attachment) => attachmentChip(attachment, () => {
      if (attachment.pending) {
        const pending = pendingAttachments.get(attachment.requestId);
        pending?.finish(true);
        URL.revokeObjectURL(attachment.uri);
      }
      vscode.postMessage({ type: 'removeAttachment', path: attachment.path }); attachments = attachments.filter((item) => item.path !== attachment.path); renderAttachments();
    })));
    saveQueueEdit();
    saveDraft(); // attached files keep the chat alive like typed text does
  }
  // Click the name on a composer chip (or pick Rename from the image right-click menu) to rename the file. Enter or clicking away saves, Esc cancels.
  function renameAttachmentInline(nameEl, attachment, onRenamed) {
    if (!nameEl?.isConnected) return;
    const input = document.createElement('input');
    input.className = 'attachment-rename';
    const clean = shownName(attachment.name);
    const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.')) : '';
    const currentBase = clean.slice(0, clean.length - ext.length);
    input.value = currentBase;
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Image name');
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const next = input.value.trim().replace(new RegExp(`${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '').trim();
      input.replaceWith(nameEl);
      if (save && next && next !== currentBase) {
        const stamp = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[_-]|\d{10,}_)+/i.exec(attachment.name)?.[0] || '';
        attachment.name = `${stamp}${next}${ext}`;
        onRenamed?.();
        if (attachment.path) vscode.postMessage({ type: 'renameAttachment', path: attachment.path, name: next });
      }
    };
    input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finish(true); } if (event.key === 'Escape') { event.preventDefault(); finish(false); } });
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('blur', () => finish(true));
  }
  // A composer chip (with remove) or, without onRemove, a sent bubble's read-only pill.
  function attachmentChip(attachment, onRemove) {
    const chip = document.createElement('div'); chip.className = 'attachment-chip';
    const isPdf = Boolean(attachment.uri && (attachment.mime === 'application/pdf' || /\.pdf$/i.test(attachment.name)));
    const isSvg = /\.svg$/i.test(attachment.name) || attachment.mime === 'image/svg+xml';
    const isImage = attachment.uri && (attachment.mime?.startsWith('image/') || isSvg);
    // Text, tables, Word, Excel, audio and video get a tile and a bounded preview (attachment-docs.js).
    const docKind = !isImage && !isPdf ? window.attachmentDocs?.kind(attachment) : null;
    // Only still, drawable images can be marked up, and only before they are sent.
    const canMark = Boolean(onRemove && isImage && !isSvg && attachment.mime !== 'image/gif' && attachment.path && window.attachmentMarkup);
    const label = document.createElement('span'); label.className = 'attachment-label';
    const name = document.createElement('span'); name.className = 'attachment-name'; name.textContent = shownName(attachment.name);
    const meta = document.createElement('span'); meta.className = 'attachment-meta';
    const withPx = (dims) => (dims ? `${dims} px` : '');
    const imageMeta = () => `${withPx(attachment.dims)}${attachment.markup ? `${attachment.dims ? ' · ' : ''}marked up` : ''}`;
    meta.textContent = attachment.pending ? 'Attaching…' : isImage ? imageMeta() : formatSize(attachment.size);
    if (attachment.pending) { chip.classList.add('is-attaching'); chip.setAttribute('aria-busy', 'true'); }
    label.append(name, meta);
    if (attachment.markup) chip.classList.add('is-marked');
    let remove = null;
    const syncChip = () => {
      const clean = shownName(attachment.name);
      name.textContent = clean;
      if (isImage) meta.textContent = imageMeta();
      if (docKind) { chip.title = `Preview ${clean}`; chip.setAttribute('aria-label', chip.title); }
      if (isImage || isPdf) {
        chip.title = isPdf ? `Open ${clean} in editor` : `Preview ${clean}`;
        chip.setAttribute('aria-label', chip.title);
      }
      if (remove) {
        remove.title = `Remove ${clean}`;
        remove.setAttribute('aria-label', remove.title);
      }
    };
    chip._attachment = attachment;
    chip._syncChip = syncChip;
    if (isImage || isPdf) {
      const image = document.createElement('img'); image.alt = '';
      if (isSvg) image.classList.add('attachment-svg');
      if (isPdf) {
        image.classList.add('attachment-pdf'); image.hidden = true;
        const placeholder = document.createElement('span'); placeholder.className = 'attachment-preview-placeholder'; placeholder.textContent = 'PDF'; chip.append(placeholder);
        meta.textContent = 'Loading preview…';
        void window.attachmentPdf.thumbnail(attachment.uri).then(result => {
          image.src = result.uri; image.hidden = false; placeholder.remove();
          meta.textContent = `${result.pages} ${result.pages === 1 ? 'page' : 'pages'} · ${formatSize(attachment.size)}`;
        }).catch(() => { meta.textContent = `${formatSize(attachment.size)} · Preview unavailable`; });
      } else image.src = attachment.uri;
      if (!isPdf && !attachment.dims) image.addEventListener('load', () => { attachment.dims = `${image.naturalWidth}×${image.naturalHeight}`; if (!attachment.pending) meta.textContent = imageMeta(); }, { once: true });
      chip.appendChild(image);
      chip.classList.add('is-previewable');
      chip.title = `Preview ${shownName(attachment.name)}`;
      chip.tabIndex = 0;
      chip.setAttribute('aria-label', chip.title);
      if (isPdf) { chip.title = `Open ${shownName(attachment.name)} in editor`; chip.setAttribute('aria-label', chip.title); }
      const preview = () => isPdf ? vscode.postMessage({ type: 'openFile', path: attachment.path }) : openLightbox(attachment.uri, `${shownName(attachment.name)}  ${withPx(attachment.dims)}`.trim(), false, attachment, syncChip, { markup: canMark ? () => openMarkup(attachment) : null });
      chip.addEventListener('click', preview);
      chip.addEventListener('keydown', event => { if (event.target === chip && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); preview(); } });
    } else if (docKind) {
      const tile = window.attachmentDocs.thumbnail(attachment, formatSize);
      chip.append(tile.element);
      void tile.ready.then((text) => { if (text && chip.isConnected !== false) meta.textContent = text; });
      chip.classList.add('is-previewable'); chip.tabIndex = 0;
      chip.title = `Preview ${shownName(attachment.name)}`; chip.setAttribute('aria-label', chip.title);
      const preview = () => {
        const caption = shownName(attachment.name);
        openLightbox(attachment.uri, caption, false, attachment, syncChip, { viewer: window.attachmentDocs.viewer(attachment, caption, formatSize) });
      };
      chip.addEventListener('click', preview);
      chip.addEventListener('keydown', event => { if (event.target === chip && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); preview(); } });
    }
    chip.append(label);
    if (isImage) {
      chip.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openImageContextMenu(event.clientX, event.clientY, attachment, chip.querySelector('img'), () => renameAttachmentInline(name, attachment, syncChip), canMark ? () => openMarkup(attachment) : null);
      });
    }
    if (onRemove) {
      name.title = 'Click to rename';
      name.classList.add('is-renamable');
      name.addEventListener('click', (event) => { event.stopPropagation(); if (!attachment.pending) renameAttachmentInline(name, attachment, syncChip); });
      remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×'; remove.title = `Remove ${shownName(attachment.name)}`; remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', (event) => { event.stopPropagation(); onRemove(); });
      remove.addEventListener('keydown', (event) => event.stopPropagation());
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
  function readAttachment(file, fallbackUri = '') {
    if (!file) return;
    const chatId = currentChatId;
    const requestId = crypto.randomUUID();
    const preview = { requestId, path: `pending:${requestId}`, name: file.name || 'image.png', mime: file.type, size: file.size, uri: URL.createObjectURL(file), pending: true };
    let resolve;
    const done = new Promise(finish => { resolve = finish; });
    const pending = { chatId, preview, done, finish(ok) { clearTimeout(pending.timer); pendingAttachments.delete(requestId); resolve(ok); } };
    pending.timer = setTimeout(() => attachmentFinished(requestId, null, 'Attaching timed out. Please paste the image again.'), 60000);
    pendingAttachments.set(requestId, pending);
    attachments.push(preview);
    renderAttachments(); // paint and start the dock animation before decoding or resizing
    const fallbackOrFail = (msg) => {
      if (fallbackUri) {
        attachmentFinished(requestId, null, '');
        vscode.postMessage({ type: 'attachUris', uris: [fallbackUri], chatId });
        return;
      }
      attachmentFinished(requestId, null, msg);
    };
    void capImage(file).then((image) => {
      const reader = new FileReader();
      reader.onload = () => { if (pendingAttachments.has(requestId)) vscode.postMessage({ type: 'attachmentData', requestId, chatId, name: file.name || 'image.png', mime: file.type || 'application/octet-stream', data: reader.result }); };
      reader.onerror = () => fallbackOrFail('Could not read the attachment. Please paste it again.');
      reader.readAsDataURL(image);
    }).catch(() => fallbackOrFail('Could not prepare the attachment. Please paste it again.'));
  }
  function attachmentFinished(requestId, attachment, error) {
    const pending = pendingAttachments.get(requestId);
    if (!pending) { if (attachment) vscode.postMessage({ type: 'removeAttachment', path: attachment.path }); return; }
    const files = pending.chatId === currentChatId ? attachments : chatDrafts.get(pending.chatId)?.files;
    const at = files?.findIndex(file => file.requestId === requestId) ?? -1;
    if (at >= 0) files.splice(at, 1, ...(attachment ? [attachment] : []));
    URL.revokeObjectURL(pending.preview.uri);
    pending.finish(Boolean(attachment));
    if (pending.chatId === currentChatId) renderAttachments();
    if (error) showToast(error, { error: true });
  }
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachments', chatId: currentChatId }));
  promptInput.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file');
    if (files.length) {
      event.preventDefault();
      for (const item of files) readAttachment(item.getAsFile());
      return;
    }
    // Linux file managers (Dolphin/GTK) copy files onto the clipboard as text/uri-list rather than File items.
    const types = event.clipboardData?.types ? [...event.clipboardData.types] : [];
    if (types.some(t => /(?:uri-?list|gnome-copied-files)/i.test(t))) {
      const uris = window.dropZone?.droppedUris?.(event.clipboardData) || [];
      if (uris.length) { event.preventDefault(); vscode.postMessage({ type: 'attachUris', uris, chatId: currentChatId }); }
    }
  });
  // The whole window is one drop zone. External OS file drops land directly when dragged onto the chat panel;
  // drags starting inside VS Code (Explorer / editor tabs) still require Shift because VS Code's outer workbench captures them.
  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'drop-overlay';
  dropOverlay.setAttribute('aria-hidden', 'true');
  dropOverlay.innerHTML = '<div class="drop-overlay-card"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25M3 13.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Drop files to attach or reference</span></div>';
  document.body.appendChild(dropOverlay);
  // drop-zone.js ends the overlay on its own when the IDE swallows the drag (Shift released, Esc, drop elsewhere).
  window.dropZone.createDropZone({
    doc: document,
    win: window,
    setActive: (on) => document.body.classList.toggle('attachment-dragging', on),
    onDrop: (event) => {
      const result = window.dropZone.classifyDrop(event.dataTransfer);
      if (result.kind === 'mentions') { vscode.postMessage({ type: 'mentionUris', uris: result.uris }); return; }
      if (result.kind === 'uris') { vscode.postMessage({ type: 'attachUris', uris: result.uris, chatId: currentChatId }); return; }
      if (result.kind === 'files') {
        result.files.forEach((file, i) => readAttachment(file, result.uris.length === result.files.length ? result.uris[i] : ''));
      }
    },
  });
  attachBtn.title = 'Attach files (drop files in, or hold Shift from Explorer)';

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
  // ---------- Menus on the composer's upper glass slab ----------
  // The model picker, the permission picker and the @ / "/" lists are one kind of surface: a menu resting on the composer's
  // top edge, above any queued prompts, fused to the composer by the upper slab (liquid-glass.js) the way the model menu always was.
  // Each lives in its own stage on the body: the dock's goo filter (.compose-row) would clip a menu this tall.
  function createIslandMenu(className, label) {
    const menu = document.createElement('div');
    menu.className = `model-menu glass ${className}`.trim();
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label);
    const stage = document.createElement('div');
    stage.className = 'model-menu-stage';
    const fillets = document.createElement('div');
    fillets.className = 'model-menu-fillets';
    stage.append(menu, fillets);
    document.body.appendChild(stage);
    return menu;
  }
  const islandMenuOpen = (menu) => menu.classList.contains('is-open');
  // While a menu grows or sinks it carries its own backing (see .is-moving in style.css); the island glass catches up after.
  const movingTimers = new WeakMap();
  function setIslandMenuOpen(menu, open) {
    if (islandMenuOpen(menu) === open) return;
    menu.classList.add('is-moving');
    clearTimeout(movingTimers.get(menu));
    movingTimers.set(menu, setTimeout(() => menu.classList.remove('is-moving'), 450));
    menu.classList.toggle('is-open', open);
  }
  /** Rests the menu on the composer's top edge, its foot centred on `centerX` (clamped to stay inside the chat column). */
  function placeIslandMenu(menu, centerX, width) {
    const stage = menu.parentElement;
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const css = getComputedStyle(stage);
    const fillet = parseFloat(css.getPropertyValue('--menu-fillet'));
    // The seam sits 1px into the composer, over its top hairline; the root hangs below it, clipped.
    stage.style.bottom = `${window.innerHeight - composer.top - 1 - parseFloat(css.getPropertyValue('--menu-root'))}px`;
    if (width) menu.style.width = `${width}px`;
    const menuWidth = menu.offsetWidth;
    const left = Math.max(10, Math.min(centerX - menuWidth / 2, Math.min(composer.right, window.innerWidth - 10) - menuWidth));
    stage.style.right = `${window.innerWidth - left - menuWidth - fillet}px`;
    stage.style.setProperty('--bud-x', `${centerX - left}px`);
  }
  /** The @ and / lists run nearly the composer's width, centred on it; the fillets need ~28px of composer edge on each side. */
  function placeListMenu(menu) {
    const composer = document.querySelector('.composer').getBoundingClientRect();
    placeIslandMenu(menu, composer.left + composer.width / 2, Math.max(180, composer.width - 56));
  }
  /** Arrow keys, Home/End, Escape and Tab for a menu whose rows are `.model-option` buttons. */
  function menuKeys(menu, close) {
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll('.model-option')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close({ refocus: true });
      } else if (event.key === 'Tab') close();
    });
  }
  // The lists belong to the text box: clicking one (or dragging its scrollbar) must not take the focus away and close it.
  const listMenu = (className, label) => {
    const menu = createIslandMenu(`list-menu ${className}`, label);
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    return menu;
  };
  const mentionMenu = listMenu('mention-list', 'Files');
  let mentionHits = [];
  let mentionIndex = 0;

  // Codex actions come from the installed CLI, not a renderer-maintained list.
  // Reuse the existing autocomplete surface so slash preview inherits its
  // keyboard behavior, accessibility, and visual language without new chrome.
  let slashCommands = null;
  let slashHits = [];
  let slashIndex = 0;
  const slashMenu = listMenu('slash-list', 'Commands');

  function slashAtCaret() {
    if (promptInput.selectionStart !== promptInput.value.length || promptInput.selectionEnd !== promptInput.value.length) return null;
    return /^\/([^\s]*)$/.exec(promptInput.value);
  }
  function closeSlashMenu() { setIslandMenuOpen(slashMenu, false); slashHits = []; }
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
    if (!match[1] && !islandMenuOpen(slashMenu)) vscode.postMessage({ type: 'querySlashCommands' });
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
    if (!slashHits.length) { setIslandMenuOpen(slashMenu, false); return; }
    closeModelMenu(); closePermMenu();
    placeListMenu(slashMenu);
    setIslandMenuOpen(slashMenu, true);
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
  function closeMentionMenu() { setIslandMenuOpen(mentionMenu, false); mentionHits = []; }
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
    if (!mentionHits.length) { setIslandMenuOpen(mentionMenu, false); return; }
    closeModelMenu(); closePermMenu();
    placeListMenu(mentionMenu);
    setIslandMenuOpen(mentionMenu, true);
    mentionMenu.children[mentionIndex]?.scrollIntoView({ block: 'nearest' });
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
    if (islandMenuOpen(mentionMenu) && mentionHits.length) {
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
    if (!islandMenuOpen(slashMenu) || !slashHits.length) return;
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
  // The menu and its two fillets share one goo-filtered stage (#msg-goo, as the bubble
  // dock), so the menu grows out of the composer's top edge and rests fused to it.
  const modelMenu = createIslandMenu('', 'Model');
  modelMenu.id = 'modelMenu';

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
    if (notifyExtension) {
      routingMode = option.id === 'auto' ? 'auto' : 'manual';
      vscode.postMessage({ type: 'setRoutingMode', mode: routingMode });
    }
    modelPickerBtn.dataset.agent = option.agent;
    modelPickerBtn.dataset.brand = brandOf(option);
    modelPickerBtn.querySelector('.model-picker-icon').innerHTML = iconFor(brandOf(option));
    renderRouting();
    if (editingQueue && editingQueue.turn.modelId !== option.id) editingQueue.modelTouched = true;
    if (scheduleChoice === false || (editingQueue?.taskId && scheduleTimer.mode === 'reset' && (optionFor(editingQueue.turn.modelId)?.agent !== option.agent || (option.agent === 'gemini' && editingQueue.turn.modelId !== option.id)))) scheduleChoice = null;
    refreshScheduleDefault(); // on if this model is out of usage; the placeholder names it
    renderPermission();
    if (islandMenuOpen(slashMenu)) updateSlashMenu();
    try { vscode.setState({ ...(vscode.getState() || {}), modelId: option.id }); } catch {}
    // Picking a model only retargets the next message; it never reveals the
    // real terminal (that's the dedicated Terminal button).
    if (notifyExtension) {
      modelPickerBtn.dispatchEvent(new Event('clanker:model-change'));
      vscode.postMessage({ type: 'setModel', modelId: option.id });
    }
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
    renderRouting();
    renderVerify();
  }

  function setRoutingMode(mode, connected = routingConnected) {
    routingMode = mode === 'auto' ? 'auto' : 'manual';
    routingConnected = connected;
    renderRouting();
  }
  function renderRouting() {
    for (const row of modelMenu.querySelectorAll('.model-option')) {
      row.setAttribute('aria-selected', String(row.dataset.modelId === activeModelId));
      if (row.dataset.modelId === 'auto') {
        row.querySelector('.model-option-hint').textContent = 'Picks a model for each task';
        row.title = routingConnected.cloudflare || routingConnected.groq
          ? 'Router chooses a favorite for each message; local fallback if unavailable'
          : 'Chooses a favorite locally; connect an AI router in Settings';
      }
    }
    const option = optionFor(activeModelId);
    if (option) {
      // Hide a redundant family prefix or trailing pool tag when narrow; never hide the model's own name.
      const label = modelPickerBtn.querySelector('.model-picker-label');
      const familyMatch = /^((?:Claude|Gemini|Codex|Copilot|GPT(?:-[\w.]+)?)\s+)(.+)$/i.exec(option.label);
      const qualifierMatch = !familyMatch && /^(.+?)(\s+\([^)]+\))$/.exec(option.label);
      label.replaceChildren();
      if (familyMatch || qualifierMatch) {
        const span = document.createElement('span');
        span.className = 'model-picker-family';
        span.textContent = familyMatch ? familyMatch[1] : qualifierMatch[2];
        label.append(...(familyMatch ? [span, familyMatch[2]] : [qualifierMatch[1], span]));
      } else label.textContent = option.label;
      modelPickerBtn.querySelector('.model-picker-icon').innerHTML = iconFor(brandOf(option));
      modelPickerBtn.title = `Model: ${option.label}`;
    }
  }

  const placeModelMenu = () => {
    const rect = modelPickerBtn.getBoundingClientRect();
    placeIslandMenu(modelMenu, rect.left + rect.width / 2); // centred above the selected model
  };
  const menuOpen = () => islandMenuOpen(modelMenu);
  function openModelMenu() {
    closeMentionMenu(); closeSlashMenu(); closePermMenu();
    renderModelMenu();
    placeModelMenu();
    setIslandMenuOpen(modelMenu, true);
    modelPickerBtn.setAttribute('aria-expanded', 'true');
    (modelMenu.querySelector('.model-option[aria-selected="true"]') || modelMenu.querySelector('.model-option'))?.focus({ preventScroll: true });
  }
  function closeModelMenu({ refocus = false } = {}) {
    if (!menuOpen()) return;
    setIslandMenuOpen(modelMenu, false);
    modelPickerBtn.setAttribute('aria-expanded', 'false');
    if (refocus) modelPickerBtn.focus();
  }
  modelPickerBtn.addEventListener('click', () => (menuOpen() ? closeModelMenu() : openModelMenu()));
  menuKeys(modelMenu, closeModelMenu);
  document.addEventListener('pointerdown', (event) => {
    if (menuOpen() && !modelMenu.contains(event.target) && !modelPickerBtn.contains(event.target)) closeModelMenu();
    if (islandMenuOpen(permMenu) && !permMenu.contains(event.target) && !permBtn.contains(event.target)) closePermMenu();
  });
  window.addEventListener('resize', () => { closeModelMenu(); closePermMenu(); });

  // ---------- Permission chip: what the model may do on this PC, switchable from the bar ----------
  // The mode a turn runs with is the model's own override (Settings > Models) when it has one, else the general setting.
  // The chip shows that effective mode; picking one changes the same thing it was read from, so nothing is hidden behind it.
  const permBtn = document.getElementById('permBtn');
  const PERM_SVG = {
    ask: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.25" y="7" width="9.5" height="6.75" rx="1.8"/><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7"/></svg>',
    auto: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.75 2.75 3.75v4c0 3 2.2 5.2 5.25 6.5 3.05-1.3 5.25-3.5 5.25-6.5v-4z"/><path d="M8.7 5.1 6.3 8.5h3.2l-2.2 2.6"/></svg>',
    // A key (Lucide "key", ISC): an open lock is too close to the closed one at 15px, a key is a different shape.
    fullAccess: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 21 9.6-9.6"/><path d="m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19"/><circle cx="15.5" cy="7.5" r="5.5"/></svg>',
  };
  const PERMISSIONS = [
    { id: 'ask', label: 'Ask', hint: 'Asks before risky actions. Gemini skips them instead of asking.' },
    { id: 'auto', label: 'Auto', hint: 'An automated safety check approves routine actions.' },
    { id: 'fullAccess', label: 'Full Access', hint: 'Runs commands and edits files on this PC without asking.' },
  ];
  let generalPermission = 'fullAccess';
  let modelPermissions = {}; // { [modelId]: { permissionMode } }, the per-model overrides
  const validPermission = (mode) => PERMISSIONS.some((entry) => entry.id === mode);
  const modelOverride = () => (validPermission(modelPermissions[activeModelId]?.permissionMode) ? modelPermissions[activeModelId].permissionMode : null);
  const effectivePermission = () => modelOverride() || generalPermission;
  const permMenu = createIslandMenu('perm-menu', 'Permissions');
  permMenu.id = 'permMenu';
  function renderPermission() {
    const mode = effectivePermission();
    const entry = PERMISSIONS.find((item) => item.id === mode);
    permBtn.dataset.mode = mode;
    permBtn.innerHTML = `${PERM_SVG[mode]}<span class="perm-chip-label">${entry.label}</span>`;
    const scope = modelOverride() ? 'this model only' : 'all models';
    permBtn.title = `Permissions: ${entry.label} (${scope}). ${entry.hint} Click to change.`;
    permBtn.setAttribute('aria-label', `Permissions: ${entry.label}. Change`);
    for (const row of permMenu.querySelectorAll('.model-option')) row.setAttribute('aria-selected', String(row.dataset.mode === mode));
  }
  function renderPermMenu() {
    const head = document.createElement('div');
    head.className = 'model-group-head';
    const title = document.createElement('span');
    title.textContent = 'Permissions';
    const scope = document.createElement('span');
    scope.className = 'model-group-quota';
    scope.textContent = modelOverride() ? 'This model only' : 'All models';
    head.append(title, scope);
    const rows = PERMISSIONS.map((entry) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-option perm-option';
      item.dataset.mode = entry.id;
      item.setAttribute('role', 'option');
      item.innerHTML = `<span class="model-option-icon">${PERM_SVG[entry.id]}</span><span class="model-option-text"><span class="model-option-label"></span><span class="model-option-hint"></span></span><svg class="model-option-check" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      item.querySelector('.model-option-label').textContent = entry.label;
      item.querySelector('.model-option-hint').textContent = entry.hint;
      item.addEventListener('click', () => { choosePermission(entry.id); closePermMenu({ refocus: true }); });
      return item;
    });
    permMenu.replaceChildren(head, ...rows);
    renderPermission();
  }
  function choosePermission(mode) {
    if (!validPermission(mode)) return;
    if (modelOverride()) { modelPermissions = { ...modelPermissions, [activeModelId]: { permissionMode: mode } }; vscode.postMessage({ type: 'setModelSettings', id: activeModelId, permissionMode: mode }); }
    else { generalPermission = mode; vscode.postMessage({ type: 'setPermissionMode', mode }); }
    renderPermission();
  }
  function openPermMenu() {
    closeMentionMenu(); closeSlashMenu(); closeModelMenu();
    renderPermMenu();
    const rect = permBtn.getBoundingClientRect();
    placeIslandMenu(permMenu, rect.left + rect.width / 2, Math.min(300, window.innerWidth - 20));
    setIslandMenuOpen(permMenu, true);
    permBtn.setAttribute('aria-expanded', 'true');
    (permMenu.querySelector('.model-option[aria-selected="true"]') || permMenu.querySelector('.model-option'))?.focus({ preventScroll: true });
  }
  function closePermMenu({ refocus = false } = {}) {
    if (!islandMenuOpen(permMenu)) return;
    setIslandMenuOpen(permMenu, false);
    permBtn.setAttribute('aria-expanded', 'false');
    if (refocus) permBtn.focus();
  }
  permBtn.addEventListener('click', () => (islandMenuOpen(permMenu) ? closePermMenu() : openPermMenu()));
  menuKeys(permMenu, closePermMenu);
  /** The host's state: the general mode and/or the per-model overrides; a missing part keeps what it was. */
  function receivePermission({ mode, models } = {}) {
    if (validPermission(mode)) generalPermission = mode;
    if (models && typeof models === 'object') modelPermissions = models;
    renderPermission();
  }
  renderPermission();
  vscode.postMessage({ type: 'requestPermission' });

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

  // The composer is one squircle at every width: the text spans the full width on top, the buttons run along the bottom
  // (the attach, model, agents and permission chips on the left; clock, dictate and the one send/stop slot on the right).
  // There is no pill state any more, so only the textarea's height follows what is typed.
  const composerEl = document.querySelector('.composer');
  const composerActions = composerEl.querySelector('.composer-actions');
  let savedDraft = null;
  function saveDraft(userInput = false) {
    if (!currentChatId) return;
    const text = editingQueue ? composerDraft?.text || '' : promptInput.value;
    const files = (editingQueue ? composerDraft?.files || [] : attachments).filter(file => !file.pending).map((file) => file.path);
    const signature = JSON.stringify([currentChatId, text, files]);
    if (signature === savedDraft && !userInput) return;
    savedDraft = signature;
    vscode.postMessage({ type: 'saveDraft', chatId: currentChatId, text, attachments: files, ...(userInput && text.length ? { userInput: true } : {}) });
  }
  // While dictation runs under existing text, the composer reserves one extra "live row" below it (two lines of the future text)
  // for the meter and then the ghost lines; the written text above stays on screen. See openVoiceRow.
  const VOICE_ROW = 40; // px, matches --voice-row in style.css
  let voiceRowOpen = false;
  function syncComposerShape() {
    if (!promptInput.value) { promptInput.style.height = ''; return; }
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140 + (voiceRowOpen ? VOICE_ROW : 0))}px`;
  }
  function autoGrow(event) {
    if (event?.type === 'input') vscode.postMessage({ type: 'composerActivity' });
    saveDraft(event?.type === 'input' && !editingQueue);
    syncComposerShape();
  }
  promptInput.addEventListener('input', autoGrow);
  // A width change re-wraps the text and can crowd the bar. The composer also changes height on every wrapped line and every animation
  // frame of its growth; neither re-wraps anything, so only a new width runs the two measurements (each one forces a layout).
  let composerWidth = -1;
  const onComposerResize = (entries) => {
    const width = entries[entries.length - 1].contentRect.width;
    if (width === composerWidth) return;
    composerWidth = width;
    syncComposerShape();
    fitComposerBar();
  };

  // The bar is always one line. Too tight, it sheds text in steps (permission text, model name, the clock's time, then the buttons
  // shrink and the agents count goes) until it fits; wider again, the text returns in the reverse order. The steps are the
  // fit-* classes in style.css. Measured, not guessed from the width, so a long model name or a long time takes the room it needs.
  const FIT_STEPS = ['fit-perm', 'fit-model', 'fit-time', 'fit-tight', 'fit-bare'];
  const composerBar = composerEl.querySelector('.composer-bar');
  const composerTools = composerEl.querySelector('.composer-tools');
  // The bar is measured from layout geometry (offsetLeft/offsetWidth), never scrollWidth or getBoundingClientRect: those count
  // transforms. The right-hand buttons sit flush with the bar's edge and scale and rotate on entering and on hover, so a 1px
  // overshoot mid-animation read as "too tight" and shrank every control, and nothing measured again once it ended.
  // Everything in the bar shares the composer as offset parent; hidden items have none and are skipped.
  const composerActionsBar = composerEl.querySelector('.composer-actions');
  const barItems = (box) => [...box.querySelectorAll(':scope > *, :scope > .mic-wrap > *')].filter((item) => item.offsetParent);
  const rightEdge = (item) => item.offsetLeft + item.offsetWidth;
  const tight = () => {
    const toolsLimit = composerTools.offsetLeft + composerTools.clientWidth, barLimit = composerBar.offsetLeft + composerBar.clientWidth;
    return barItems(composerTools).some((item) => rightEdge(item) > toolsLimit + 1) || barItems(composerActionsBar).some((item) => rightEdge(item) > barLimit + 1);
  };
  function fitComposerBar() {
    composerEl.classList.remove(...FIT_STEPS);
    for (const step of FIT_STEPS) { if (!tight()) break; composerEl.classList.add(step); }
    fitWatch?.takeRecords(); // our own class changes are not news
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(onComposerResize).observe(composerEl);
  // The bar's content and any class on the bar or the composer (is-voice hides the polish button, has-time widens the clock) can change its width.
  let fitWatch = null;
  if (typeof MutationObserver === 'function') {
    fitWatch = new MutationObserver(fitComposerBar);
    fitWatch.observe(composerBar, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    fitWatch.observe(composerEl, { attributes: true, attributeFilter: ['class'] });
  }
  document.fonts?.ready.then(fitComposerBar);
  fitComposerBar();

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
  let queueOrder = []; // the strip's one list, as the user dragged it: "turn:<id>" / "scheduled:<id>" keys
  let pendingQueueOrder = null; // keep the drop visible through intermediate host snapshots
  const pendingQueueEdits = new Map();
  function receiveQueueTurns(turns, chatId) {
    const result = (turns || []).slice();
    for (const [key, pending] of pendingQueueEdits) {
      if (pending.chatId !== chatId) continue;
      const at = result.findIndex(turn => turn.id === pending.turn.id);
      if (at >= 0 && result[at].clientEditId === pending.turn.clientEditId) pendingQueueEdits.delete(key);
      else if (at >= 0) result[at] = { ...result[at], ...pending.turn, editing: pending.editing };
      else result.push({ ...pending.turn, queued: true, editing: pending.editing });
    }
    return result;
  }
  function receiveQueueOrder(order) {
    const received = Array.isArray(order) ? order : [];
    if (pendingQueueOrder?.chatId !== currentChatId) pendingQueueOrder = null;
    if (pendingQueueOrder && received.join() !== pendingQueueOrder.order.join()) queueOrder = pendingQueueOrder.order;
    else { queueOrder = received; pendingQueueOrder = null; }
  }
  let composerDraft = null;
  /** Deletes the queued or scheduled prompt being edited and closes the edit. */
  function dropQueueEdit() {
    const { taskId, chatId, turn } = editingQueue;
    queueAction(taskId ? 'cancelScheduledTask' : 'removeQueuedTurn', { chatId, taskId, id: turn.id });
    if (!taskId) { const at = turnQueue.findIndex(item => item.id === turn.id); if (at >= 0) turnQueue.splice(at, 1); }
    editingQueue = null;
  }
  function saveQueueEdit(finish = false, { submit = false } = {}) {
    if (attachments.some(file => file.pending)) return;
    if (!editingQueue) return;
    // Everything removed (text, files and pictures) and the edit is being closed: the prompt is gone, not saved empty.
    if (finish && !promptInput.value.trim() && !attachments.length) {
      dropQueueEdit();
      return;
    }
    const turn = { ...editingQueue.turn, text: promptInput.value, modelId: pendingModelId || activeModelId, attachments: attachments.map(file => file.path), files: attachments.slice() };
    if (!editingQueue.taskId) {
      const original = turnQueue.find(item => item.id === turn.id);
      if (original) Object.assign(original, turn);
    }
    const clearReset = Boolean(finish && editingQueue.wasQuotaReset && (editingQueue.chooseModel || editingQueue.modelTouched) && !scheduleArmed);
    let nextSchedule = null;
    if (finish && editingQueue.taskId && editingQueue.scheduleTouched && scheduleArmed) {
      const at = scheduleTimer.resolve();
      nextSchedule = at ? { dispatchTrigger: 'fixed-time', dispatchTime: new Date(at).toISOString() } : { dispatchTrigger: 'quota-reset', resetWindow: scheduleTimer.resetWindow };
      if (submit && scheduleTimer.mode) {
        scheduleTimer.setPreferred(scheduleTimer.mode);
        vscode.postMessage({ type: 'scheduleMode', mode: scheduleTimer.mode });
      }
    }
    queueAction(editingQueue.taskId ? 'saveScheduledDraft' : 'editQueuedTurn', {
      chatId: editingQueue.chatId,
      taskId: editingQueue.taskId,
      turn,
      editing: !finish,
      ...(clearReset ? { clearReset: true } : {}),
      ...(nextSchedule ? { schedule: nextSchedule } : {}),
    });
    if (finish) editingQueue = null;
  }
  function editQueuePrompt(turn, taskId = null, { chooseModel = false, schedule = null } = {}) {
    if (!editingQueue) composerDraft = { text: promptInput.value, files: attachments.slice(), modelId: pendingModelId || activeModelId };
    saveQueueEdit(true);
    const taskSchedule = schedule || (taskId && schedulerTasks.find(item => item.id === taskId));
    const wasQuotaReset = Boolean(taskSchedule?.dispatchTrigger === 'quota-reset');
    const notBefore = Number.isFinite(Date.parse(taskSchedule?.notBefore || '')) ? Date.parse(taskSchedule.notBefore) : 0;
    editingQueue = { turn, taskId, chatId: currentChatId, wasQuotaReset, notBefore, chooseModel, modelTouched: false, scheduleTouched: false };
    promptInput.value = turn.text;
    attachments = (turn.files || []).slice();
    const hadSchedule = Boolean(taskId && taskSchedule && scheduleTimer.load(taskSchedule));
    scheduleChoice = hadSchedule ? true : (taskId ? false : null);
    selectModel(turn.modelId || 'auto');
    if (pendingModelId) refreshScheduleDefault();
    if (!taskId) queueAction('editQueuedTurn', { turn, editing: true });
    renderAttachments(); autoGrow(); renderComposerState(); renderTurnQueue(); promptInput.focus();
  }
  function finishQueueEdit({ schedule = false, submit = false } = {}) {
    if (schedule && editingQueue && !editingQueue.taskId && promptInput.value.trim()) {
      schedulePrompt(promptInput.value.trim(), editingQueue);
      editingQueue = null;
    } else if (submit && editingQueue?.taskId && editingQueue.scheduleTouched && !scheduleArmed && promptInput.value.trim()) {
      const text = promptInput.value.trim();
      flushVoiceDraft(text);
      const turn = { id: crypto.randomUUID(), text, modelId: pendingModelId || activeModelId, attachments: attachments.map(file => file.path), files: attachments.slice(), verify: autoVerify, pipeline: false };
      queueAction('cancelScheduledTask', { taskId: editingQueue.taskId });
      editingQueue = null;
      if (busy || turnQueue.length) { turnQueue.push(turn); queueAction('queueTurn', { turn }); }
      else steerTurn(turn);
    } else saveQueueEdit(true, { submit });
    const draft = composerDraft;
    composerDraft = null;
    scheduleChoice = null;
    scheduleTimer.clear();
    promptInput.value = draft?.text || '';
    attachments = draft?.files || [];
    if (draft?.modelId) selectModel(draft.modelId); else refreshScheduleDefault();
    renderAttachments(); autoGrow(); renderComposerState(); renderTurnQueue();
  }

  function renderComposerState() {
    const unscheduling = Boolean(editingQueue?.taskId && editingQueue.scheduleTouched && !scheduleArmed);
    const held = busy || turnQueue.length > 0 || hasPausedDue();
    const queueing = (!editingQueue && held && !scheduleArmed && Boolean(promptInput.value.trim()))
      || (unscheduling && held);
    const hasText = Boolean(promptInput.value.trim());
    // Dictation owns the composer until it ends (the microphone again, or Esc): sending now would send a half-finished draft.
    // Only the window the text lands in shows dictation (the host tells every other window `idle`), so it alone is locked.
    const dictating = composerEl.classList.contains('is-voice');
    // The bottom-right slot holds exactly one of the two, so the bar never reshuffles under the pointer: send whenever there is
    // something to send (or an edit to save), stop only while a turn runs and there is nothing typed.
    const sending = Boolean(editingQueue) || !busy || hasText || unscheduling;
    stopBtn.hidden = sending;
    sendBtn.hidden = !sending;
    sendBtn.disabled = dictating || (unscheduling && !hasText);
    const mode = unscheduling ? (queueing ? 'queue' : 'send') : editingQueue ? 'edit' : queueing ? 'queue' : 'send';
    if (sendBtn.dataset.mode !== mode) {
      sendBtn.dataset.mode = mode;
      sendBtn.classList.toggle('is-queue', queueing);
      sendBtn.innerHTML = mode === 'edit' ? SAVE_EDIT_SVG : queueing ? QUEUE_SVG : SEND_SVG;
    }
    sendBtn.title = dictating ? 'Finish dictating first: click the microphone to stop, or press Esc to cancel'
      : unscheduling
      ? (queueing ? 'Remove schedule and queue after this turn (Enter). Ctrl+Enter sends now.' : 'Remove schedule and send now (Enter)')
      : queueing ? (queuePaused ? 'Add to the paused queue (Enter). Ctrl+Enter sends now.' : 'Queue for after this turn (Enter). Ctrl+Enter sends now.')
      : editingQueue ? (promptInput.value.trim() || attachments.length ? 'Save queue edits (Enter). Ctrl+Enter sends now.' : 'Nothing left: delete this queued prompt (Enter)') : 'Send';
    polishBtn.disabled = micWrap.classList.contains('is-polishing') || !promptInput.value.trim();
    autoGrow(); // Stop/Queue buttons change the text column's width, so re-measure
  }
  function setBusy(next) {
    const changed = busy !== next;
    busy = next;
    document.body.classList.toggle('is-turn-busy', next); // Halo draws its glow round the composer from this
    if (!next) railWorking = null;
    renderComposerState(); syncPending(); renderProjectList();
    if (changed) renderTurnQueue();
  }

  // Pending indicator: the moment a turn starts, and again whenever the agent
  // goes quiet mid-turn (after a tool card), a glass "Thinking" pill sits at
  // the end of the transcript. It steps aside while reply text streams and
  // while a card waits on you. One observer covers every append path.
  const pendingEl = document.createElement('div');
  pendingEl.className = 'msg-pending';
  pendingEl.setAttribute('role', 'status');
  pendingEl.innerHTML = '<span class="pending-orb" aria-hidden="true"></span><span class="pending-label">Thinking</span><span class="pending-time" aria-hidden="true"></span><span class="pending-tokens"></span>';
  const pendingLabel = pendingEl.querySelector('.pending-label');
  const pendingTime = pendingEl.querySelector('.pending-time');
  const pendingTokens = pendingEl.querySelector('.pending-tokens');
  // Monetary comparisons live in Settings, including the current chat's estimate.
  function renderChatCost(usd) {
    chatSettings.chatCost(usd);
  }
  // While the agent only waits on a running tool (a Monitor, or a shell that is just a sleep) the pill is a "Timer":
  // it counts down a known sleep, otherwise up from when the wait began. Anything else is "Thinking" with the turn's clock.
  function renderPendingClock() {
    const now = Date.now();
    for (const card of document.querySelectorAll('.tool-card.is-running[data-started-at]')) {
      const elapsed = now - Number(card.dataset.startedAt);
      const text = elapsed >= 1000 ? formatDuration(elapsed) : '';
      const time = card.querySelector('.tool-time');
      if (time && time.textContent !== text) time.textContent = text;
    }
    const wait = pendingEl.isConnected ? turnHost().querySelector('.tool-card.is-running[data-wait-start]') : null;
    pendingEl.classList.toggle('is-timer', Boolean(wait));
    const label = wait ? 'Timer' : 'Thinking';
    if (pendingLabel.textContent !== label) pendingLabel.textContent = label;
    let ms = turnStartedAt ? Date.now() - turnStartedAt : 0;
    if (wait) {
      ms = Date.now() - Number(wait.dataset.waitStart);
      const total = Number(wait.dataset.waitSecs) * 1000;
      if (total > ms) ms = total - ms;
    }
    if (liveThought) { const t = Date.now() - liveThought.startedAt >= 1000 ? formatDuration(Date.now() - liveThought.startedAt) : ''; if (liveThought.time.textContent !== t) liveThought.time.textContent = t; }
    const clock = (wait || turnStartedAt) && ms >= 1000 ? formatDuration(ms) : '';
    if (pendingTime.textContent !== clock) pendingTime.textContent = clock; // the pill sits inside the observed transcript: only a real change may mutate it
  }
  // The running clock for the turn; it becomes the "Worked for" figure at the end.
  setInterval(renderPendingClock, 1000);

  // Live reasoning. It stays open while the model thinks and while its tools run, so you can read what it is working out
  // and steer it. When the next thought arrives, the previous thought collapses to one line and the completed tool calls
  // between them bundle into a collapsed "N steps" row. When reply text arrives or the turn ends, all thoughts and their
  // tool groups fold together into one summary above the answer.
  // Digital circuit brain icon: airy wired-brain silhouette using the full 16x16 box so circuit traces stay legible at 15-16px.
  const THOUGHT_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.2 2.4c-1.7-.4-3.4.6-3.7 2.2-1.2.4-2 1.6-1.9 3 .1 1.2.9 2.2 2 2.5.2 1.8 1.6 3.2 3.6 3.3V2.4Z"/><path d="M8.8 2.4c1.7-.4 3.4.6 3.7 2.2 1.2.4 2 1.6 1.9 3-.1 1.2-.9 2.2-2 2.5-.2 1.8-1.6 3.2-3.6 3.3V2.4Z"/><path d="M7.2 5.6H5.2M7.2 9.4H5.4M8.8 5.6h2M8.8 9.4h1.8" stroke-width="1.05"/><circle cx="4.4" cy="5.6" r=".9" fill="currentColor" stroke="none"/><circle cx="4.7" cy="9.4" r=".9" fill="currentColor" stroke="none"/><circle cx="11.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/><circle cx="11.3" cy="9.4" r=".9" fill="currentColor" stroke="none"/></svg>';
  let liveThought = null; // { fold, body, preview, time, text, startedAt, pinned } — currently streaming thought chunks
  let openThought = null; // last shown thought, kept open across tool steps until the next thought, reply text, or turn end
  const thoughtPreview = (text) => {
    const flat = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/g, '$1')
      .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1$2')
      .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
    return flat.length > 110 ? `${flat.slice(0, 109)}…` : flat;
  };
  function syncThoughtFade(body) {
    if (!body) return;
    body.dataset.fadeTop = body.scrollTop > 4 ? '1' : '0';
    body.dataset.fadeBottom = body.scrollHeight - body.scrollTop - body.clientHeight > 6 ? '1' : '0';
  }
  function startThought() {
    // A new thought closes the previous open thought and bundles the completed tool steps between them.
    foldThought();
    foldToolSteps();
    const fold = document.createElement('details');
    fold.className = 'thought-fold is-live';
    fold.open = true;
    const summary = document.createElement('summary');
    summary.setAttribute('aria-label', 'Thought process');
    const icon = document.createElement('span');
    icon.className = 'thought-icon';
    icon.innerHTML = THOUGHT_ICON;
    const label = document.createElement('span');
    label.className = 'thought-label';
    label.textContent = 'Thought process';
    const preview = document.createElement('span');
    preview.className = 'thought-preview';
    const time = document.createElement('span');
    time.className = 'thought-time';
    summary.append(icon, label, preview, time);
    const body = document.createElement('div');
    body.className = 'thought-body';
    fold.append(summary, body);
    const host = turnHost();
    host.insertBefore(fold, pendingEl.isConnected && pendingEl.parentNode === host ? pendingEl : null);
    liveThought = { fold, body, preview, time, text: '', startedAt: Date.now(), pinned: true };
    body.addEventListener('scroll', () => {
      if (liveThought && liveThought.body === body) liveThought.pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
      syncThoughtFade(body);
    }, { passive: true });
    fold.addEventListener('toggle', () => { if (fold.open) requestAnimationFrame(() => syncThoughtFade(body)); });
    syncPending();
  }
  function appendThought(text) {
    if (!text) return;
    if (!liveThought) {
      if (!text.trim()) return;
      startThought();
    }
    liveThought.text += text;
    liveThought.body.replaceChildren(buildMessageBody(liveThought.text.trim()));
    if (liveThought.pinned) liveThought.body.scrollTop = liveThought.body.scrollHeight; // the newest words stay in view unless you scrolled up to re-read
    syncThoughtFade(liveThought.body);
    scrollTranscriptToEnd();
  }
  /** Ends the live shimmer when tool usage starts, while keeping the thought card open to read. */
  function settleThought() {
    if (!liveThought) return;
    const thought = liveThought;
    liveThought = null;
    if (!thought.text.trim()) { thought.fold.remove(); syncPending(); return; }
    thought.fold.classList.remove('is-live');
    thought.fold.querySelector('.thought-label').textContent = 'Thought process';
    thought.preview.textContent = thoughtPreview(thought.text);
    const ms = Date.now() - thought.startedAt;
    thought.time.textContent = ms >= 1000 ? formatDuration(ms) : '';
    openThought = thought;
    syncPending();
  }
  /** Closes the live or last-open thought (or Update Steps checklist card) into its one-line form. */
  function foldThought({ immediate = false } = {}) {
    const thought = liveThought || openThought;
    if (!thought) return;
    const wasLive = thought === liveThought;
    liveThought = null;
    openThought = null;
    const { fold, body, preview, time, text, startedAt, isCard } = thought;
    if (!isCard) {
      if (!text.trim()) { fold.remove(); syncPending(); return; }
      if (wasLive) {
        fold.classList.remove('is-live');
        fold.querySelector('.thought-label').textContent = 'Thought process';
        preview.textContent = thoughtPreview(text);
        const ms = Date.now() - startedAt;
        time.textContent = ms >= 1000 ? formatDuration(ms) : '';
      }
      body.scrollTop = 0;
    }
    if (!fold.open) { syncPending(); return; } // you closed it yourself
    if (immediate || REDUCED_MOTION.matches || !fold.isConnected || !body) {
      fold.open = false;
      fold.classList.remove('is-closing');
      if (body) body.style.maxHeight = '';
      syncPending();
      return;
    }
    // Fold shut, not snap shut: the body's height runs down to nothing, then the details closes.
    const height = body.getBoundingClientRect().height;
    body.style.maxHeight = `${height}px`;
    void body.offsetHeight;
    fold.classList.add('is-closing');
    body.style.maxHeight = '0px';
    const done = () => { fold.open = false; fold.classList.remove('is-closing'); body.style.maxHeight = ''; syncPending(); };
    body.addEventListener('transitionend', done, { once: true });
    setTimeout(() => { if (fold.classList.contains('is-closing')) done(); }, 420); // a missed transitionend must not leave it half-open
  }
  /** Drops what a thought was showing without folding (a new turn starts): what was streamed stays as the one-line card. */
  function resetThought() { foldThought({ immediate: true }); }
  function syncPending() {
    const last = [...turnHost().children].reverse().find((el) => el !== pendingEl);
    const show = busy && !isCompacting && !liveThought && Boolean(last) && !last.matches('.approval-card, .question-card');
    if (show && turnHost().lastElementChild !== pendingEl) {
      pendingEl.classList.toggle('is-entering', !pendingEl.isConnected);
      turnHost().appendChild(pendingEl);
      // Moving the pill restarts every CSS animation. Pinning the loops to the document timeline's zero keeps orb, glow
      // and text sweep on one clock, so a move or a busy main thread never knocks them out of step or back to frame 0.
      for (const anim of pendingEl.getAnimations({ subtree: true })) {
        if (anim.animationName?.startsWith('pending-') && anim.animationName !== 'pending-in') anim.startTime = 0;
      }
      scrollTranscriptToEnd();
    }
    else if (!show && pendingEl.isConnected) pendingEl.remove();
    renderPendingClock();
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
    appendUserMessage(turn.text, undefined, turn.files, { clientTurnId: turn.id });
    setBusy(true);
    dropUndo(); // the last turn's undo is only for the last turn
    vscode.postMessage({ type: 'send', chatId: currentChatId, clientTurnId: turn.id, modelId: turn.modelId, text: turn.text, attachments: turn.attachments, submit: true, steer, retry: Boolean(turn.retry), verify: Boolean(turn.verify), pipeline: Boolean(turn.pipeline) });
  }

  function appendInterruptedPill(reason) {
    foldSteps();
    const pill = document.createElement('div');
    pill.className = 'chat-notice is-interrupted';
    pill.innerHTML = STOP_SVG;
    pill.append(reason === 'recovered_incomplete' ? 'Recovered output · No completed reply was recorded'
      : reason === 'host_shutdown' ? 'Interrupted by IDE restart · Saved output restored' : 'Interrupted by user');
    turnHost().appendChild(pill);
    scrollTranscriptToEnd();
  }

  // Closes the running turn out in this window right away; the host's own
  // turn_complete for it (if the process was still alive) is then swallowed.
  function interruptLocally() {
    awaitingInterruptAck = true;
    if (isCompacting) { finishCompactDivider('interrupted'); isCompacting = false; }
    for (const [id, card] of pendingCards) { if (card.dataset.deferred === 'true') continue; settleCard(card, 'Turn stopped', 'denied'); pendingCards.delete(id); }
    document.querySelectorAll('.tool-card.is-running').forEach((card) => {
      finishToolCard(card, { output: rawToolOutput(card) });
      card.classList.add('is-cancelled');
    });
    foldThought({ immediate: true }); // what it was thinking when stopped stays readable
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
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => !queueStrip.hidden && updateQueueMaxHeight()).observe(queueStrip);

  // P17-L: hairline icons, no emoji.
  const queueSvg = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const QUEUE_ICONS = {
    send: queueSvg('<path d="M3 8h9.5"/><path d="M8.75 4.25 12.5 8l-3.75 3.75"/>'),
    up: queueSvg('<path d="m4.5 9.75 3.5-3.5 3.5 3.5"/>'),
    down: queueSvg('<path d="m4.5 6.25 3.5 3.5 3.5-3.5"/>'),
    edit: PENCIL_SVG,
    remove: queueSvg(TRASH_PATH),
    unschedule: queueSvg('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h6.75a4 4 0 0 1 0 8H7"/>'),
    pause: queueSvg('<path d="M5.5 4v8M10.5 4v8"/>'),
    play: queueSvg('<path d="m5.5 3.5 7 4.5-7 4.5z"/>'),
  };
  const queueAction = (type, details = {}) => {
    const chatId = details.chatId || currentChatId;
    if ((type === 'editQueuedTurn' || type === 'queueTurn') && details.turn?.id) {
      details = { ...details, turn: { ...details.turn, clientEditId: crypto.randomUUID() } };
      pendingQueueEdits.set(`${chatId}:${details.turn.id}`, { chatId, turn: details.turn, editing: details.editing === true });
    } else if (type === 'removeQueuedTurn' || type === 'steerQueuedTurn') pendingQueueEdits.delete(`${chatId}:${details.id}`);
    vscode.postMessage({ type, chatId, ...details });
  };

  // P17-M: the dragged row follows the pointer; siblings spring aside by one
  // row pitch (transform only, no reflow). On drop the queue re-renders in the
  // new order and the row FLIPs from where it was let go into its slot.
  // The new strip order (keys "turn:<id>" / "scheduled:<id>"): remembered per chat by the host, and each kind's own order
  // is also sent to its store, so a turn still runs after the ones above it and scheduled prompts keep their own priority.
  function applyQueueOrder(order, before) {
    if (order.join() === before.join()) return;
    queueOrder = order;
    pendingQueueOrder = { chatId: currentChatId, order: order.slice() };
    const idsOf = (keys, kind) => keys.filter((key) => key.startsWith(`${kind}:`)).map((key) => key.slice(kind.length + 1));
    const turnIds = idsOf(order, 'turn'), taskIds = idsOf(order, 'scheduled');
    if (turnIds.length > 1 && turnIds.join() !== idsOf(before, 'turn').join()) {
      const rank = new Map(turnIds.map((id, i) => [id, i]));
      turnQueue = turnQueue.slice().sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
      queueAction('reorderQueuedTurns', { ids: turnIds });
    }
    if (taskIds.length > 1 && taskIds.join() !== idsOf(before, 'scheduled').join()) {
      const byId = new Map(scheduledHere().map((task) => [task.id, task]));
      const sorted = taskIds.map((id) => byId.get(id)).filter(Boolean);
      const moved = new Set(sorted.map((task) => task.id));
      let index = 0;
      schedulerTasks = schedulerTasks.map((task) => (moved.has(task.id) ? sorted[index++] : task));
      queueAction('reorderScheduledTasks', { ids: taskIds });
    }
    queueAction('setQueueOrder', { order });
  }
  // One list: queued turns and scheduled prompts are dragged among each other. Rows can differ in height (a wrapped prompt,
  // a time label), so the slots come from each row's own measured box, not one shared pitch.
  // The whole row is the handle: anything that is not a control (the prompt text, empty space, the file badge) drags it.
  function startQueueDrag(event, row) {
    if (event.button !== 0 || event.target.closest('button, a, input, textarea, [role="button"]')) return;
    event.preventDefault();
    const rows = [...queueStrip.querySelectorAll('.turn-queue-item:not(.turn-queue-skeleton)')];
    const from = rows.indexOf(row);
    if (from < 0) return;
    const keyOf = (r) => r.dataset.queueKey;
    const tops = rows.map((r) => r.offsetTop), heights = rows.map((r) => r.offsetHeight);
    const mids = rows.map((r, i) => tops[i] + heights[i] / 2);
    const gap = rows.length > 1 ? Math.max(0, tops[1] - tops[0] - heights[0]) : 0;
    const last = rows.length - 1;
    const startY = event.clientY;
    const grip = row;
    let engaged = false;
    const chatId = currentChatId;
    const before = rows.map(keyOf);
    let to = from;
    let dy = 0;
    grip.setPointerCapture(event.pointerId);
    // A plain click on the text does nothing; the row only lifts once the pointer has really moved.
    const engage = () => {
      engaged = true;
      queueStrip.classList.add('is-sorting');
      for (const sibling of rows) sibling.classList.remove('is-entering');
      row.classList.add('is-dragging');
    };
    const move = (e) => {
      if (!engaged) { if (Math.abs(e.clientY - startY) < 4) return; engage(); }
      dy = Math.max(tops[0] - tops[from], Math.min(tops[last] + heights[last] - heights[from] - tops[from], e.clientY - startY));
      row.style.transform = `translateY(${dy}px)`;
      // The row takes a slot once its leading edge passes that row's middle, so a tall row can still reach a short one at an end.
      const top = tops[from] + dy, bottom = top + heights[from];
      to = from;
      rows.forEach((_, i) => {
        if (i > from && bottom >= mids[i]) to = Math.max(to, i);
        if (i < from && top <= mids[i]) to = Math.min(to, i);
      });
      const step = heights[from] + gap;
      rows.forEach((r, i) => {
        if (r === row) return;
        const shift = i > from && i <= to ? -step : i < from && i >= to ? step : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      if (!engaged) return;
      row.classList.remove('is-dragging');
      for (const sibling of rows) sibling.style.transform = '';
      if (chatId !== currentChatId) return;
      const letGoAt = tops[from] + dy;
      const order = before.slice();
      order.splice(to, 0, ...order.splice(from, 1));
      applyQueueOrder(order, before);
      renderTurnQueue();
      const settled = [...queueStrip.querySelectorAll('.turn-queue-item')].find((r) => keyOf(r) === keyOf(row));
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
  // The up / down arrows beside a row's number: the same reorder as dragging, one step at a time. The row slides to its new slot
  // (a FLIP, like a dropped drag), and the arrow keeps keyboard focus even though its row is re-inserted.
  function moveQueueRow(row, delta) {
    const rows = [...queueStrip.querySelectorAll('.turn-queue-item:not(.turn-queue-skeleton)')];
    const before = rows.map((r) => r.dataset.queueKey);
    const from = before.indexOf(row.dataset.queueKey), to = from + delta;
    if (from < 0 || to < 0 || to >= rows.length) return;
    const tops = new Map(rows.map((r) => [r.dataset.queueKey, r.offsetTop]));
    const order = before.slice();
    order.splice(to, 0, ...order.splice(from, 1));
    applyQueueOrder(order, before);
    renderTurnQueue();
    const moved = [...queueStrip.querySelectorAll('.turn-queue-item:not(.turn-queue-skeleton)')];
    if (!REDUCED_MOTION.matches) {
      queueStrip.classList.add('is-sorting');
      for (const r of moved) {
        r.classList.remove('is-entering');
        const dy = (tops.get(r.dataset.queueKey) ?? r.offsetTop) - r.offsetTop;
        if (dy) { r.style.transition = 'none'; r.style.transform = `translateY(${dy}px)`; }
      }
      queueStrip.getBoundingClientRect();
      for (const r of moved) { r.style.transition = ''; r.style.transform = ''; }
      setTimeout(() => queueStrip.classList.remove('is-sorting'), 420);
    }
    const settled = moved.find((r) => r.dataset.queueKey === row.dataset.queueKey);
    const next = settled?.querySelector(delta < 0 ? '.is-up:not([hidden])' : '.is-down:not([hidden])') || settled?.querySelector('.turn-queue-move:not([hidden])');
    next?.focus({ preventScroll: true });
  }
  // A queued turn's files: a photo (or paperclip) icon plus "3 photos" / "2 files"; narrow rows drop the word (style.css).
  // No thumbnails: at this size they were unreadable and cost decoding work for every row.
  function queuedFilesBadge(files) {
    const allPhotos = files.every((file) => file.mime?.startsWith('image/'));
    const badge = document.createElement('span');
    badge.className = 'turn-queue-files';
    badge.title = files.map((file) => file.name).join('\n');
    const icon = document.createElement('span');
    icon.className = 'turn-queue-files-icon';
    icon.innerHTML = queueSvg(allPhotos
      ? '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="10.4" cy="6" r="1.1"/><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3"/>'
      : '<path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2"/>');
    const count = document.createElement('span');
    count.className = 'turn-queue-files-count';
    const word = document.createElement('span');
    word.className = 'turn-queue-files-word';
    word.textContent = allPhotos ? (files.length === 1 ? ' photo' : ' photos') : (files.length === 1 ? ' file' : ' files');
    count.append(String(files.length), word);
    badge.append(icon, count);
    return badge;
  }

  // This chat's scheduled prompts (the scheduler holds them; the chat shows them where the queue is).
  const scheduledHere = () => activeTasks().filter((task) => task.status === 'pending' && task.chatId && task.chatId === currentChatId);
  function renderQueueMark(row, scheduled) {
    const entry = row.queueEntry;
    const clock = scheduled && (fireTimeOf(entry) > Date.now() || resetWaiting(entry));
    if (row.queueClock === clock) return;
    row.queueClock = clock;
    // A row that is still waiting wears a clock before its time.
    const when = row.querySelector('.turn-queue-when');
    if (!when) return;
    const icon = when.querySelector('.turn-queue-clock');
    if (clock && !icon) when.insertAdjacentHTML('afterbegin', CLOCK_SVG.replace('<svg ', '<svg class="turn-queue-clock" '));
    else if (!clock && icon) icon.remove();
  }
  function queueRow(entry, scheduled, row) {
    if (!row) {
      row = document.createElement('div');
      row.className = 'turn-queue-item' + (REDUCED_MOTION.matches ? '' : ' is-entering') + (scheduled ? ' is-scheduled' : '');
      row.dataset.queueKey = (scheduled ? 'scheduled:' : 'turn:') + entry.id;
      if (scheduled) row.dataset.taskId = entry.id; else row.dataset.id = entry.id;
      row.addEventListener('animationend', event => { if (event.target === row && event.animationName === 'msg-in') row.classList.remove('is-entering'); });
      row.addEventListener('pointerdown', event => startQueueDrag(event, row));
      // Position in the order the prompts go out, with a step up above it and a step down below it.
      const mark = document.createElement('span');
      mark.className = 'turn-queue-rank';
      const moveButton = (cls, icon, label, delta) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'turn-queue-move ' + cls; btn.innerHTML = icon; btn.title = label; btn.setAttribute('aria-label', label);
        btn.addEventListener('click', () => moveQueueRow(row, delta));
        return btn;
      };
      const num = document.createElement('span'); num.className = 'turn-queue-num';
      mark.append(moveButton('is-up', QUEUE_ICONS.up, 'Move up', -1), num, moveButton('is-down', QUEUE_ICONS.down, 'Move down', 1));
      // The current model is also the way to change it: click the pill, pick another model in the composer's menu.
      const pill = document.createElement('span');
      pill.className = 'model-pill is-changeable';
      pill.setAttribute('role', 'button'); pill.tabIndex = 0; pill.setAttribute('aria-label', 'Change model');
      const changeModel = () => {
        if (scheduled) vscode.postMessage({ type: 'unscheduleToComposer', taskId: row.queueEntry.id, chooseModel: true });
        else { editQueuePrompt(row.queueEntry, null, { chooseModel: true }); openModelMenu(); }
      };
      pill.addEventListener('click', changeModel);
      pill.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); changeModel(); } });
      const text = document.createElement('span');
      text.className = 'turn-queue-text';
      const button = (icon, label, title, cls, onClick) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'turn-queue-btn ' + cls; btn.innerHTML = icon; btn.title = title;
        if (label) btn.append(label); else btn.setAttribute('aria-label', title);
        btn.addEventListener('click', onClick);
        return btn;
      };
      row.append(mark, pill, text);
      const controls = document.createElement('span'); controls.className = 'turn-queue-controls';
      const actions = document.createElement('span'); actions.className = 'turn-queue-actions';
      if (scheduled) {
        const when = document.createElement('span'); when.className = 'turn-queue-when'; when.innerHTML = '<span class="turn-queue-when-text"></span>';
        actions.append(
          button(QUEUE_ICONS.remove, '', 'Delete', 'is-danger is-icon', () => vscode.postMessage({ type: 'cancelScheduledTask', taskId: row.queueEntry.id })),
          button(QUEUE_ICONS.edit, '', 'Move back into the composer', 'is-icon', () => vscode.postMessage({ type: 'unscheduleToComposer', taskId: row.queueEntry.id })),
          button(QUEUE_ICONS.send, '', 'Send this now instead of waiting', 'is-primary is-icon', () => vscode.postMessage({ type: 'dispatchNowWithAutoRoute', taskId: row.queueEntry.id })));
        controls.append(when, actions);
      } else {
        actions.append(
          button(QUEUE_ICONS.remove, '', 'Delete', 'is-danger is-icon', () => {
            const turn = row.queueEntry;
            for (const file of turn.files || []) vscode.postMessage({ type: 'removeAttachment', path: file.path });
            queueAction('removeQueuedTurn', { id: turn.id });
            turnQueue = turnQueue.filter(item => item.id !== turn.id);
            renderTurnQueue();
          }),
          button(QUEUE_ICONS.edit, '', 'Move back into the composer', 'is-icon', () => editQueuePrompt(row.queueEntry)),
          button(QUEUE_ICONS.send, '', 'Send this now', 'is-primary is-icon', () => queueAction('steerQueuedTurn', { id: row.queueEntry.id })));
        controls.append(actions);
      }
      row.append(controls);
      row.querySelector('.is-primary').setAttribute('aria-label', 'Send Now'); // the title explains the state; the name stays put
    }
    // Keep controls mounted; their handlers always read the latest host snapshot.
    row.queueEntry = entry;
    renderQueueMark(row, scheduled);
    const option = optionFor(entry.modelId) || (scheduled && MODEL_OPTIONS.find(candidate => candidate.agent === entry.model)) || MODEL_OPTIONS[0];
    const brand = brandOf(option), label = option.shortLabel || option.label, fullLabel = option.label || label, icon = iconFor(brand);
    const modelKey = JSON.stringify([brand, label, fullLabel, icon]);
    if (row.queueModelKey !== modelKey) {
      const pill = row.querySelector('.model-pill');
      pill.dataset.brand = brand; pill.innerHTML = icon;
      const labelEl = document.createElement('span'); labelEl.className = 'model-pill-label'; labelEl.textContent = label; // its own element, so a narrow row can drop it
      pill.append(labelEl);
      pill.title = fullLabel;
      row.queueModelKey = modelKey;
    }
    const text = row.querySelector('.turn-queue-text');
    const prompt = (scheduled ? entry.prompt : entry.text) || '';
    if (text.textContent !== prompt) text.textContent = prompt;
    if (text.title !== prompt) text.title = prompt;
    const files = entry.files || (scheduled ? (entry.attachments || []).map(file => ({ name: file.name, mime: file.mimeType })) : []);
    const filesKey = JSON.stringify(files);
    if (row.queueFilesKey !== filesKey) {
      row.querySelector('.turn-queue-files')?.remove();
      if (files.length) row.insertBefore(queuedFilesBadge(files), row.querySelector(':scope > .turn-queue-controls'));
      row.queueFilesKey = filesKey;
    }
    if (scheduled) {
      const value = scheduledLabel(entry);
      setWhenLabel(row, value);
    } else {
      const steer = row.querySelector('.is-primary');
      const title = busy ? 'Interrupt the running turn and send this now' : 'Send this now';
      if (steer.title !== title) steer.title = title;
    }
    const sendButton = row.querySelector('.is-primary');
    sendButton.disabled = scheduled ? resetWaiting(entry) : queuedTurnBlocked(entry);
    return row;
  }

  function queueSkeletonRow(index) {
    const row = document.createElement('div');
    row.className = 'turn-queue-item turn-queue-skeleton';
    row.dataset.queueKey = `skel:${index}`;
    row.setAttribute('aria-hidden', 'true');
    const pill = document.createElement('i'); pill.className = 'turn-queue-skel-pill skeleton';
    const text = document.createElement('i'); text.className = 'turn-queue-skel-text skeleton';
    text.style.maxWidth = `${[62, 48, 56][index % 3]}%`;
    const actions = document.createElement('span'); actions.className = 'turn-queue-skel-actions';
    const btn = document.createElement('i'); btn.className = 'turn-queue-skel-btn skeleton';
    const edit = document.createElement('i'); edit.className = 'turn-queue-skel-icon skeleton';
    const del = document.createElement('i'); del.className = 'turn-queue-skel-icon skeleton';
    actions.append(btn, edit, del);
    row.append(pill, text, actions);
    return row;
  }

  const QUEUE_VISIBLE_LIMIT = 7;
  function updateQueueMaxHeight() {
    const rows = queueStrip.querySelectorAll('.turn-queue-item');
    const head = queueStrip.querySelector('.turn-queue-head');
    if (rows.length <= QUEUE_VISIBLE_LIMIT || !head) {
      queueStrip.style.removeProperty('--queue-max-h');
      return;
    }
    const padTop = parseFloat(getComputedStyle(queueStrip).paddingTop) || 6;
    const cap = Math.floor(rows[QUEUE_VISIBLE_LIMIT].offsetTop - head.offsetTop + padTop);
    if (cap > 0) queueStrip.style.setProperty('--queue-max-h', `${cap}px`);
  }

  function renderTurnQueue() {
    if (queueStrip.dataset.chatId === (currentChatId || '') && queueStrip.querySelector('.is-dragging')) return; // reconcile pending snapshots on pointer release
    const scheduled = isChatSwitching ? [] : scheduledHere();
    const queued = isChatSwitching ? [] : turnQueue;
    const loading = loadingQueueCount();
    const hidden = !(queued.length || scheduled.length || loading);
    if (queueStrip.hidden !== hidden) queueStrip.hidden = hidden;
    if (queueStrip.dataset.chatId !== (currentChatId || '') || hidden) {
      queueStrip.classList.remove('is-sorting');
      if (queueStrip.childElementCount) queueStrip.replaceChildren();
      queueStrip.dataset.chatId = currentChatId || '';
    }
    queueStrip.classList.toggle('is-loading', loading > 0);
    if (loading > 0) queueStrip.setAttribute('aria-busy', 'true');
    else queueStrip.removeAttribute('aria-busy');
    if (schedulerQueueLoaded && !isChatSwitching) persistQueueHint(scheduled.length + queued.length);
    if (hidden) return;
    let head = queueStrip.querySelector('.turn-queue-head');
    if (!head) {
      head = document.createElement('div');
      head.className = 'turn-queue-head';
      const title = document.createElement('span');
      const transport = document.createElement('button');
      transport.type = 'button'; transport.className = 'turn-queue-btn is-icon queue-transport';
      transport.addEventListener('click', () => {
        queuePaused = !queuePaused;
        queueAction('pauseTurnQueue', { paused: queuePaused });
        renderTurnQueue();
        renderComposerState();
        transport.focus({ preventScroll: true });
      });
      head.append(title, transport);
      queueStrip.append(head);
    }
    const title = head.querySelector('span'), label = turnQueueTitle();
    if (title.textContent !== label) title.textContent = label;
    const transport = head.querySelector('.queue-transport');
    const showTransport = queued.length + scheduled.filter(dueNow).length > 0;
    if (transport.hidden !== !showTransport) transport.hidden = !showTransport;
    if (transport.dataset.paused !== String(queuePaused)) {
      transport.dataset.paused = String(queuePaused);
      transport.innerHTML = queuePaused ? QUEUE_ICONS.play : QUEUE_ICONS.pause;
      transport.title = queuePaused ? 'Resume queue' : 'Pause queue after the current task';
      transport.setAttribute('aria-label', queuePaused ? 'Resume queue' : 'Pause queue');
    }
    // Scheduled and queued prompts share a stable list, with distinct ID namespaces.
    const existing = new Map([...queueStrip.querySelectorAll('.turn-queue-item')].map(row => [row.dataset.queueKey, row]));
    const skeletons = loading > 0 ? Array.from({ length: loading }, (_, i) => [null, 'skel', i]) : [];
    // One list. Prompts the user never placed keep the default (scheduled first, then queued) after the ones they did.
    // Ranked by id alone: a scheduled prompt that comes due moves into the chat's queue under the same id and keeps its place.
    const rank = new Map(queueOrder.map((key, i) => [key.slice(key.indexOf(':') + 1), i]));
    const keyed = [
      ...scheduled.filter(task => task.id !== editingQueue?.taskId).map(task => [task, 'scheduled']),
      ...queued.filter(turn => editingQueue?.taskId || turn.id !== editingQueue?.turn.id).map(turn => [turn, 'turn']),
    ].sort((a, b) => (rank.get(a[0].id) ?? 1e9) - (rank.get(b[0].id) ?? 1e9));
    const desired = [...skeletons, ...keyed];
    desired.forEach(([entry, kind, skelIndex], index) => {
      const key = kind === 'skel' ? `skel:${skelIndex}` : `${kind}:${entry.id}`;
      const row = kind === 'skel' ? (existing.get(key) || queueSkeletonRow(skelIndex)) : queueRow(entry, kind === 'scheduled', existing.get(key));
      existing.delete(key);
      const before = queueStrip.children[index + 1] || null;
      if (before !== row) {
        if (row.parentElement === queueStrip) row.classList.remove('is-entering');
        queueStrip.insertBefore(row, before);
      }
    });
    for (const row of existing.values()) row.remove();
    const placed = [...queueStrip.querySelectorAll('.turn-queue-item:not(.turn-queue-skeleton)')];
    placed.forEach((item, i) => {
      const label = `#${i + 1}`, num = item.querySelector('.turn-queue-num');
      if (num.textContent !== label) num.textContent = label;
      const up = item.querySelector('.is-up'), down = item.querySelector('.is-down');
      if (up.hidden !== (i === 0)) up.hidden = i === 0; // the first prompt can't go up, the last can't go down, a lone one neither
      if (down.hidden !== (i === placed.length - 1)) down.hidden = i === placed.length - 1;
    });
    updateQueueMaxHeight();
  }

  async function sendPrompt({ steer = false } = {}) {
    if (waitingToSend) return;
    const pending = attachments.filter(file => file.pending).map(file => pendingAttachments.get(file.requestId)?.done).filter(Boolean);
    if (pending.length) {
      const chatId = currentChatId, text = promptInput.value;
      const intent = {};
      waitingToSend = intent;
      promptInput.readOnly = true;
      let results, canceled;
      try { results = await Promise.all(pending); }
      finally {
        canceled = waitingToSend !== intent;
        if (!canceled) { waitingToSend = null; promptInput.readOnly = false; }
      }
      if (canceled || chatId !== currentChatId || text !== promptInput.value || results.some(ok => !ok)) return;
      return sendPrompt({ steer }); // include any further paste that arrived while waiting
    }
    if (polishing) return; // the draft is being rewritten; sending now would send the old text
    if (composerEl.classList.contains('is-voice')) return; // dictating: finish or cancel it first
    let text = promptInput.value.trim();
    if (editingQueue && !steer) { finishQueueEdit({ schedule: scheduleArmed, submit: true }); return; }
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
    // /loop 5m <prompt> repeats a prompt in this chat; /loop stop ends it (host: ChatWindowHost.loopCommand, lib/loop-command.js).
    const loop = /^\/loop(?:\s+([\s\S]*))?$/i.exec(text);
    if (loop) {
      vscode.postMessage({ type: 'loopCommand', args: loop[1] || '', modelId: pendingModelId || activeModelId });
      promptInput.value = '';
      closeSlashMenu(); autoGrow(); renderComposerState();
      return;
    }
    // /worktree new|status|diff|open|remove: this chat's own git worktree (host: ChatWindowHost.worktreeCommand, lib/chat-worktree.js).
    const worktree = /^\/worktree(?:\s+([\s\S]*))?$/i.exec(text);
    if (worktree) {
      vscode.postMessage({ type: 'worktreeCommand', args: worktree[1] || '' });
      promptInput.value = '';
      closeSlashMenu(); autoGrow(); renderComposerState();
      return;
    }
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
      dropQueueEdit();
      if (!scheduleArmed) { scheduleChoice = null; scheduleTimer.clear(); if (!composerDraft) refreshScheduleDefault(); }
    }
    if (scheduleArmed) {
      schedulePrompt(text);
      scheduleChoice = null;
      scheduleTimer.clear(); // the pick was for this prompt; the next one starts from the default again
      refreshScheduleDefault(); // stays on while the model is out of usage, so the next prompt queues too
    } else if ((busy || turnQueue.length || hasPausedDue()) && !steer) {
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

  // A click on the mic of a chat that is not recording, while another chat is, only moves the dictation here. The pointerdown
  // already made this window the target (windowActive), and the host's answer can land before the click does, so the click
  // must not read it as "recording, so stop". It is decided on pointerdown, from what this window knew before the press.
  let micMoveOnly = false;
  micBtn.addEventListener('pointerdown', () => { micMoveOnly = micElsewhere === 'recording'; });
  micBtn.addEventListener('click', () => {
    if (micMoveOnly || micElsewhere) { micMoveOnly = false; return; } // moved here, or another chat is transcribing: nothing to start or stop
    warmMicCue(); // a click is the gesture that lets the start cue play the instant the microphone is live
    if (!micBtn.classList.contains('recording')) applyMicState({ state: 'starting' }); // answer now; the host confirms a moment later
    vscode.postMessage({ type: 'micToggle' });
  });

  // Polish sits beside the mic: the typed draft goes through dictation's cleanup and comes back
  // structured. It replaces the text through the editing stack, so Ctrl+Z brings the original back.
  let polishRequest = 0;
  let polishing = false;
  function setPolishing(on) {
    polishing = on;
    promptInput.readOnly = on;
    polishBtn.disabled = on || !promptInput.value.trim();
    micWrap.classList.toggle('is-polishing', on);
    composerEl.classList.toggle('is-polishing', on);
    voiceOverlay.hidden = false;
    if (!on && (micBtn.classList.contains('recording') || micBtn.classList.contains('is-busy'))) return; // a recording took over the composer meanwhile
    composerEl.classList.toggle('is-voice', on);
    composerEl.classList.toggle('is-voice-processing', on);
    if (!on) setTimeout(parkVoiceOverlay, 280);
    renderComposerState();
  }
  function parkVoiceOverlay() {
    if (composerEl.classList.contains('is-voice')) return;
    voiceOverlay.hidden = true;
    delete voiceOverlay.dataset.row;
  }
  // The live row: reserved under existing text while dictation runs. The overlay is pinned to the exact spot where the new
  // text will start (--row-top), so the ghost lines stand where the words will appear, even after the box has grown.
  function animateComposerHeight(from) {
    const to = promptInput.offsetHeight;
    if (REDUCED_MOTION.matches || from === to) return;
    promptInput.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  }
  function openVoiceRow() {
    if (voiceRowOpen || !promptInput.value.trim()) return;
    const from = promptInput.offsetHeight;
    voiceRowOpen = true;
    composerEl.classList.add('has-voice-row');
    syncComposerShape();
    promptInput.scrollTop = promptInput.scrollHeight;
    voiceOverlay.dataset.row = '1';
    voiceOverlay.style.setProperty('--row-top', `${Math.max(0, promptInput.scrollHeight - VOICE_ROW - promptInput.scrollTop)}px`);
    animateComposerHeight(from);
  }
  function closeVoiceRow(animate = true) {
    clearTimeout(voiceRowTimer);
    if (!voiceRowOpen) return;
    const from = promptInput.offsetHeight;
    voiceRowOpen = false;
    composerEl.classList.remove('has-voice-row');
    syncComposerShape();
    if (animate) animateComposerHeight(from);
  }
  let voiceRowTimer;
  /**
   * New text wipes in from `keep` px down (the end of what was already written) while the old text stays put: a soft edge
   * travels top to bottom through a mask, so the words appear line by line where the ghost lines stood.
   */
  function revealFrom(keep) {
    if (REDUCED_MOTION.matches || !promptInput.animate) return;
    const start = Math.max(0, keep - promptInput.scrollTop);
    const distance = promptInput.clientHeight - start;
    if (distance <= 0) return;
    promptInput.style.setProperty('--keep', `${start}px`);
    promptInput.classList.add('is-revealing');
    const done = () => { promptInput.classList.remove('is-revealing'); promptInput.style.removeProperty('--keep'); };
    const wipe = promptInput.animate([{ '--wipe': '0px' }, { '--wipe': `${distance}px` }], { duration: Math.min(1100, 380 + distance * 3.2), easing: 'cubic-bezier(0.33, 1, 0.68, 1)' });
    wipe.onfinish = done; wipe.oncancel = done;
  }
  polishBtn.addEventListener('click', () => {
    const text = promptInput.value;
    if (polishing || !text.trim()) return;
    setPolishing(true);
    vscode.postMessage({ type: 'polishPrompt', text, requestId: ++polishRequest });
  });
  function applyPolished(text) {
    resetVoiceCorrections(); lastVoiceDraft = null;
    const from = promptInput.offsetHeight;
    promptInput.focus();
    promptInput.select();
    if (!document.execCommand('insertText', false, text)) promptInput.value = text; // execCommand keeps the native undo stack
    autoGrow(); renderComposerState();
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
    animateComposerHeight(from);
    revealFrom(0); // the rewritten draft wipes in from the top
  }
  // Esc drops the recording without transcribing it.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !composerEl.classList.contains('is-voice') || composerEl.classList.contains('is-voice-processing') || composerEl.classList.contains('is-voice-starting')) return;
    event.preventDefault();
    vscode.postMessage({ type: 'micCancel' });
  });

  // ---------- P17-ZA: live mic meter in the composer ----------
  // One symmetric voice meter: thin bars swell from the centre with the speaker's level and a soft ripple travels
  // outward; in silence they rest as an even row of dots. The edge fade is a CSS mask. The mic button's ring follows
  // the same level (--mic-level). Stop squeezes the bars into a shimmer beam while Whisper runs; the draft then
  // fades in where the beam was. Silence only stops recording when explicitly enabled (VOICE_SILENCE_MS).
  const WAVE_BARS = 31;
  const voiceOverlay = document.createElement('div');
  voiceOverlay.id = 'composerVoiceOverlay'; voiceOverlay.className = 'voice-overlay'; voiceOverlay.hidden = true;
  voiceOverlay.setAttribute('aria-hidden', 'true');
  const waveBars = Array.from({ length: WAVE_BARS }, () => { const bar = document.createElement('span'); bar.className = 'waveform-bar'; return bar; });
  voiceOverlay.append(...waveBars);
  composerEl.appendChild(voiceOverlay);
  const WAVE_MIN = 3; // px: a resting dot
  const WAVE_MAX = 28; // px: the loudest centre bar
  const WAVE_DASH = 6; // px: a closed-shutter dash while the microphone opens (the bar lying on its side)
  const WAVE_TURN_MS = 380; // one bar's quarter turn, from horizontal to upright
  const WAVE_STAGGER_MS = 170; // the turn travels from the centre to the edges
  const WAVE_HANDOVER_MS = WAVE_TURN_MS + WAVE_STAGGER_MS; // closed dashes -> live meter
  const VOICE_SPEECH = 0.12; // a level above this is speech, not room noise
  const VOICE_MIN_SPEECH_MS = 300; // a cough does not arm the auto-stop
  let micLevel = 0; // latest level, 0..1
  let micLevelAt = 0;
  let waveLevel = 0; // micLevel smoothed per frame: quick to rise, slow to fall
  let waveFrame = 0;
  let waveRunning = false;
  let waveLiveAt = 0; // when the microphone went live; 0 while it is still opening
  let speechMs = 0; // speech heard so far in this recording
  let lastSpeechAt = 0;
  let lastVolumeAt = 0;
  let voiceStopSent = false; // the auto-stop fires once per recording
  let voiceHold = false; // started by the hold-to-talk hotkey: no auto-stop, the release ends it
  let lastVoiceDraft = null; // { original, raw }: what the transcript said, to learn from the user's fixes
  let voiceEditTimer;
  let voiceEditRequest = 0;
  let voiceEditSnapshot = null;
  const dismissedVoiceTerms = new Set();
  const voiceDictionaryTimers = new Map();
  const VOICE_DICTIONARY_CANCEL_MS = 10000;
  let voiceDictionaryVisibilityAt = performance.now();
  document.addEventListener('visibilitychange', () => { voiceDictionaryVisibilityAt = performance.now(); });
  const voiceDictionaryBud = document.createElement('div');
  voiceDictionaryBud.className = 'voice-dictionary-bud island-bud';
  voiceDictionaryBud.hidden = true;
  voiceDictionaryBud.setAttribute('aria-live', 'polite');
  composerEl.before(voiceDictionaryBud);
  // keepRows: only drop the pending edit check. Notices already counting down keep their clock, so typing or sending never
  // restarts a cancel window; a full reset (chat switch, polish, cleared prompt) clears them.
  function resetVoiceCorrections(keepRows = false) {
    clearTimeout(voiceEditTimer);
    voiceEditRequest++;
    voiceEditSnapshot = null;
    if (keepRows) return;
    for (const timer of voiceDictionaryTimers.values()) clearInterval(timer);
    voiceDictionaryTimers.clear();
    voiceDictionaryBud.replaceChildren();
    voiceDictionaryBud.hidden = true;
  }
  function checkVoiceCorrections(edited = promptInput.value) {
    clearTimeout(voiceEditTimer);
    if (!lastVoiceDraft || !edited.trim()) return;
    // Text outside the dictated region (before prefix or after suffix) is excluded from learning.
    if (!edited.startsWith(lastVoiceDraft.prefix)) return;
    const suffix = lastVoiceDraft.suffix || '';
    if (suffix && !edited.endsWith(suffix)) return;
    const editedEnd = suffix ? edited.length - suffix.length : edited.length;
    if (editedEnd < lastVoiceDraft.prefix.length) return;
    resetVoiceCorrections(true);
    voiceEditSnapshot = { original: lastVoiceDraft.original, edited: edited.slice(lastVoiceDraft.prefix.length, editedEnd) };
    vscode.postMessage({ type: 'voiceDraftEdited', ...voiceEditSnapshot, requestId: ++voiceEditRequest });
  }
  function showVoiceCorrections(terms) {
    const existing = new Map([...voiceDictionaryBud.children].map(row => [row.dataset.term, row]));
    // A row whose word is no longer suggested goes away unless it is already saving or showing an error.
    for (const [term, row] of existing) {
      if (terms.includes(term) || row.dataset.state !== 'pending') continue;
      clearInterval(voiceDictionaryTimers.get(term)); voiceDictionaryTimers.delete(term);
      row.remove(); existing.delete(term);
    }
    for (const term of terms.filter(term => !dismissedVoiceTerms.has(term) && !existing.has(term))) {
      const row = document.createElement('div'); row.className = 'voice-dictionary-row';
      const label = document.createElement('span'); label.textContent = `Adding “${term}” to dictionary`;
      label.className = 'voice-dictionary-label';
      const countdown = document.createElement('span'); countdown.className = 'voice-dictionary-countdown'; countdown.textContent = '10s';
      countdown.setAttribute('aria-live', 'off');
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'voice-dictionary-retry'; retry.textContent = 'Retry'; retry.hidden = true;
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'voice-dictionary-cancel';
      dismiss.setAttribute('aria-label', `Cancel adding ${term} to voice dictionary`);
      dismiss.title = 'Cancel dictionary addition';
      dismiss.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h10M6 4V2h4v2M4 4l.7 9h6.6l.7-9M6.5 6.5v4M9.5 6.5v4"/></svg>';
      const snapshot = { ...voiceEditSnapshot, requestId: voiceEditRequest };
      // Pointing at or focusing the notice holds the countdown so there is time to decide; leaving lets it run on and save.
      let hovered = false, focused = false;
      const hold = () => { row.toggleAttribute('data-held', hovered || focused); };
      row.addEventListener('pointerenter', () => { hovered = true; hold(); });
      row.addEventListener('pointerleave', () => { hovered = false; hold(); });
      row.addEventListener('focusin', () => { focused = true; hold(); });
      row.addEventListener('focusout', () => { focused = false; hold(); });
      function startCountdown() {
        let remaining = VOICE_DICTIONARY_CANCEL_MS;
        let lastTick = performance.now();
        retry.hidden = true; countdown.textContent = '10s';
        label.textContent = `Adding “${term}” to dictionary`;
        row.style.setProperty('--dictionary-remaining', '1');
        row.dataset.state = 'pending';
        const timer = setInterval(() => {
          const now = performance.now();
          // Give the user ten seconds on screen; hidden windows and a held notice do not consume the cancel window.
          if (!document.hidden && !row.hasAttribute('data-held')) remaining -= now - Math.max(lastTick, voiceDictionaryVisibilityAt);
          lastTick = now;
          countdown.textContent = row.hasAttribute('data-held') ? 'Paused' : `${Math.max(0, Math.ceil(remaining / 1000))}s`;
          row.style.setProperty('--dictionary-remaining', String(Math.max(0, remaining / VOICE_DICTIONARY_CANCEL_MS)));
          if (remaining > 0) return;
          clearInterval(timer); voiceDictionaryTimers.delete(term);
          row.dataset.state = 'saving'; label.textContent = `Saving “${term}” to dictionary…`;
          countdown.textContent = ''; dismiss.disabled = true;
          vscode.postMessage({ type: 'voiceDictionarySave', ...snapshot, term });
        }, 100);
        voiceDictionaryTimers.set(term, timer);
      }
      retry.addEventListener('click', startCountdown);
      dismiss.addEventListener('click', () => {
        clearInterval(voiceDictionaryTimers.get(term)); voiceDictionaryTimers.delete(term);
        dismissedVoiceTerms.add(term); row.remove(); voiceDictionaryBud.hidden = !voiceDictionaryBud.childElementCount;
        showToast(`Dictionary addition cancelled: ${term}`);
      });
      row.dataset.term = term;
      row.append(label, countdown, retry, dismiss); voiceDictionaryBud.append(row);
      startCountdown();
    }
    voiceDictionaryBud.hidden = !voiceDictionaryBud.childElementCount;
  }
  const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
  // The meter was redrawn on every display frame: 31 bars restyled (height forces a layout) and a custom property written on
  // the whole composer, which repainted its blurred glow. That was the dictation lag. Now it draws at most ~30 times a second,
  // and only what changed: a quiet room costs nothing once the bars have settled.
  const WAVE_FRAME_MS = 30;
  const WAVE_LEVEL_STEPS = 40; // --mic-level moves in 1/40 steps; a finer change is not visible
  const waveDrawn = new Array(WAVE_BARS).fill(''); // what each bar was last given, so an unchanged bar is not touched
  let waveDrawnAt = 0;
  let waveLevelDrawn = -1;
  function waveStep(now) {
    waveFrame = requestAnimationFrame(waveStep);
    if (now - waveDrawnAt < WAVE_FRAME_MS) return;
    waveDrawnAt = now;
    const target = now - micLevelAt < 300 ? micLevel : 0;
    waveLevel += (target - waveLevel) * (target > waveLevel ? 0.35 : 0.1);
    const t = now / 1000;
    const mid = (WAVE_BARS - 1) / 2;
    // Loading: the bars lie on their side as one flat dashed line, a shut shutter, and a soft glint travels along it. It is
    // deliberately not a wave: nothing is being heard yet. When the microphone is live (the same moment as the start cue)
    // every dash turns a quarter turn into an upright bar, centre first, like louvres opening, and the meter takes over.
    const live = waveLiveAt ? now - waveLiveAt : -1;
    const glint = ((t * 0.7) % 1.6) - 0.3; // 0..1 spans the row, the rest lets it enter and leave
    for (let i = 0; i < WAVE_BARS; i++) {
      const x = Math.abs(i - mid) / mid; // 0 at the centre, 1 at the edges
      const swell = (1 - x ** 1.7) * (0.74 + 0.26 * Math.sin(t * 7 - x * 5)); // bell-shaped, rippling outward
      const p = live < 0 ? 0 : Math.min(1, Math.max(0, (live - x * WAVE_STAGGER_MS) / WAVE_TURN_MS));
      const ease = (v) => 1 - (1 - v) ** 3; // ease-out: the shutter snaps open, then settles
      const turn = ease(Math.min(1, p / 0.7)); // the turn finishes at full dash length...
      const settle = ease(Math.max(0, (p - 0.55) / 0.45)); // ...then the upright bar relaxes to the meter's height
      const s = Math.min(1, waveLevel * swell * 1.15);
      const meter = WAVE_MIN + (WAVE_MAX - WAVE_MIN) * s;
      const shut = 0.34 + 0.3 * Math.exp(-((((i / (WAVE_BARS - 1)) - glint) / 0.12) ** 2));
      const height = `${(WAVE_DASH + (meter - WAVE_DASH) * settle).toFixed(1)}px`;
      const transform = turn < 1 ? `rotate(${(90 * (1 - turn)).toFixed(1)}deg)` : '';
      const opacity = (shut + (0.3 + 0.7 * s - shut) * settle).toFixed(2);
      const drawn = `${height}|${transform}|${opacity}`;
      if (waveDrawn[i] === drawn) continue;
      waveDrawn[i] = drawn;
      const style = waveBars[i].style;
      style.height = height; style.transform = transform; style.opacity = opacity;
    }
    const level = Math.round(waveLevel * WAVE_LEVEL_STEPS) / WAVE_LEVEL_STEPS;
    if (level !== waveLevelDrawn) {
      waveLevelDrawn = level;
      micBtn.style.setProperty('--mic-level', level.toFixed(3));
      composerEl.style.setProperty('--mic-level', level.toFixed(3));
    }
  }
  let micStartingTimer;
  // One microphone, and only the window the text will land in (the one used last) shows it: the host sends every other window
  // `idle`, with `elsewhere` set while a recording or transcription runs in another chat. A click or focus here makes this window
  // the target, and a recording that is still running then moves here.
  let micElsewhere = ''; // '' | 'recording' | 'processing': what another chat is doing with the microphone
  for (const type of ['pointerdown', 'focusin']) document.addEventListener(type, () => vscode.postMessage({ type: 'windowActive' }), true);
  window.addEventListener('focus', () => vscode.postMessage({ type: 'windowActive' }));
  function applyMicState(message) {
    const { state } = message;
    clearTimeout(micStartingTimer);
    if (state === 'starting') micStartingTimer = setTimeout(() => applyMicState({ state: 'idle' }), 8000); // the host always answers; this only unlocks a lost reply
    if (state === 'recording') voiceHold = Boolean(message.hold);
    micElsewhere = state === 'idle' ? message.elsewhere || '' : '';
    if (message.cue && (state === 'recording' || state === 'processing')) playMicCue(state === 'recording' ? 'start' : 'stop');
    micBtn.classList.toggle('recording', state === 'recording');
    micBtn.classList.toggle('is-starting', state === 'starting');
    micBtn.classList.toggle('is-busy', state === 'starting' || state === 'processing');
    micBtn.disabled = state === 'processing' || state === 'starting';
    micBtn.title =
      micElsewhere === 'recording'
        ? 'Another chat is recording. Click to move dictation to this chat'
      : micElsewhere === 'processing'
        ? 'Another chat is transcribing'
      : state === 'recording'
        ? `Listening${message.device ? ` on ${message.device}` : ''}\u2026 ${message.hold ? 'release the hotkey to transcribe' : window.VOICE_SILENCE_MS ? 'stops by itself after a pause. Click to stop now' : 'click or press the hotkey again to stop and transcribe'}, Esc to cancel`
        : state === 'processing'
          ? 'Transcribing and cleaning up\u2026'
          : state === 'starting'
            ? 'Opening microphone\u2026'
            : 'Voice input (click to record)';
    setVoiceState(state);
  }
  function setVoiceState(state) {
    const starting = state === 'starting';
    const recording = state === 'recording';
    const processing = state === 'processing';
    emptyMascot?.setListening?.(recording);
    if (starting && composerEl.classList.contains('is-voice-starting')) return; // the host's confirmation of the click's own start
    if (starting || recording) {
      voiceOverlay.hidden = false;
      micLevelAt = 0; micLevel = 0; speechMs = 0; lastSpeechAt = 0; lastVolumeAt = 0; voiceStopSent = false;
      if (starting) { waveLevel = 0; waveLiveAt = 0; waveDrawn.fill(''); waveLevelDrawn = -1; } // the bars may have been cleared since the last recording
      else if (!waveLiveAt) waveLiveAt = performance.now(); // the closed dashes open into the live meter from here
      // One loop serves both: opening the microphone and listening are the same animation, one fading into the other.
      if (!REDUCED_MOTION.matches && !waveRunning) { waveRunning = true; waveFrame = requestAnimationFrame(waveStep); }
    } else {
      waveRunning = false;
      waveLiveAt = 0;
      cancelAnimationFrame(waveFrame);
      micBtn.style.removeProperty('--mic-level');
      composerEl.style.removeProperty('--mic-level');
    }
    if (processing) { waveDrawn.fill(''); waveBars.forEach((bar) => { bar.style.opacity = ''; bar.style.height = ''; bar.style.transform = ''; }); } // CSS collapses them to the 4px baseline
    // Written text stays visible: the meter and then the ghost lines take a row under it .
    if (starting || recording || processing) { clearTimeout(voiceRowTimer); openVoiceRow(); }
    composerEl.classList.toggle('is-voice', starting || recording || processing);
    composerEl.classList.toggle('is-voice-starting', starting);
    composerEl.classList.toggle('is-voice-processing', processing);
    if (!starting && !recording && !processing) {
      setScheduleArmed(scheduleArmed); // restores the placeholder
      setTimeout(parkVoiceOverlay, 280);
      // On success the transcript follows this message at once and closes the row itself; on a cancel or an error nothing comes.
      clearTimeout(voiceRowTimer); voiceRowTimer = setTimeout(closeVoiceRow, 180);
    }
    renderComposerState(); // send is greyed out while dictating
  }
  let voiceInserting = false;
  // Last cursor/selection position placed in the composer, paired with the draft value it belongs to so a chat switch,
  // send, or programmatic replacement can never apply a stale offset.
  let voiceCursor = null;
  function rememberVoiceCursor() {
    if (typeof promptInput.selectionStart !== 'number') return;
    voiceCursor = { start: promptInput.selectionStart, end: promptInput.selectionEnd, value: promptInput.value };
  }
  for (const eventName of ['select', 'keyup', 'mouseup', 'pointerup', 'click', 'focus', 'blur']) {
    promptInput.addEventListener(eventName, rememberVoiceCursor);
  }
  function resolveVoiceSelection(value) {
    if (document.activeElement === promptInput && typeof promptInput.selectionStart === 'number') {
      return { start: promptInput.selectionStart, end: promptInput.selectionEnd };
    }
    if (voiceCursor && voiceCursor.value === value) {
      return {
        start: Math.max(0, Math.min(voiceCursor.start, value.length)),
        end: Math.max(0, Math.min(voiceCursor.end, value.length)),
      };
    }
    return { start: value.length, end: value.length };
  }
  // Computes where and how a dictated transcript lands inside `currentValue` for the given cursor/selection range.
  // Empty box replaces whitespace; collapsed cursor at the end keeps the new-line landing (unless already preceded by
  // whitespace); cursor in the middle or over a selection inserts right there with smart spacing.
  function planVoiceInsertion(currentValue, selStart, selEnd, text) {
    if (!currentValue.trim()) {
      return { start: 0, end: currentValue.length, lead: '', trail: '', added: text, atEnd: true, cursorAfter: text.length };
    }
    const start = Math.max(0, Math.min(selStart, currentValue.length));
    const end = Math.max(start, Math.min(selEnd, currentValue.length));
    if (start === end && start === currentValue.length) {
      const lead = /\s$/.test(currentValue) ? '' : '\n';
      const added = `${lead}${text}`;
      return { start, end, lead, trail: '', added, atEnd: true, cursorAfter: start + added.length };
    }
    const before = currentValue.slice(0, start);
    const after = currentValue.slice(end);
    const lead = !before || /\s$/.test(before) || /^[,.;:!?)\]}]/.test(text) ? '' : ' ';
    const trail = !after || /^\s/.test(after) || /^[,.;:!?)\]}]/.test(after) ? '' : ' ';
    const added = `${lead}${text}${trail}`;
    return { start, end, lead, trail, added, atEnd: false, cursorAfter: start + lead.length + text.length };
  }
  // The transcript lands at the user's blinking cursor (or replaces the active selection). It goes in through the editing
  // stack (execCommand), so one Ctrl+Z takes the whole dictation back. When appending at the end, the new lines wipe in
  // where the ghost lines stood and the composer springs to its new height.
  function insertVoiceDraft(text) {
    clearTimeout(voiceRowTimer);
    const currentValue = promptInput.value;
    const had = currentValue.trim();
    const { start, end } = resolveVoiceSelection(currentValue);
    const plan = planVoiceInsertion(currentValue, start, end, text);
    const from = promptInput.offsetHeight;
    const keep = had && plan.atEnd ? promptInput.scrollHeight - (voiceRowOpen ? VOICE_ROW : 0) : 0; // where the old text ends
    voiceRowOpen = false;
    composerEl.classList.remove('has-voice-row');
    promptInput.focus();
    promptInput.setSelectionRange(plan.start, plan.end);
    voiceInserting = true;
    if (!document.execCommand('insertText', false, plan.added)) {
      promptInput.value = `${currentValue.slice(0, plan.start)}${plan.added}${currentValue.slice(plan.end)}`;
    }
    voiceInserting = false;
    autoGrow(); renderComposerState();
    promptInput.setSelectionRange(plan.cursorAfter, plan.cursorAfter);
    voiceCursor = { start: plan.cursorAfter, end: plan.cursorAfter, value: promptInput.value };
    if (plan.atEnd) promptInput.scrollTop = promptInput.scrollHeight;
    animateComposerHeight(from);
    if (plan.atEnd) revealFrom(keep);
    return {
      prefix: `${currentValue.slice(0, plan.start)}${plan.lead}`,
      suffix: `${plan.trail}${currentValue.slice(plan.end)}`,
    };
  }
  // Sending ends edit monitoring; detected corrections retain their visible cancel window.
  function flushVoiceDraft(sent) {
    if (!lastVoiceDraft) return;
    if (sent) checkVoiceCorrections(sent);
    else resetVoiceCorrections();
    lastVoiceDraft = null;
  }
  promptInput.addEventListener('input', (event) => {
    if (voiceInserting) return; // the dictation landing is not an edit of it
    rememberVoiceCursor();
    resetVoiceCorrections(!!promptInput.value.trim());
    // Ctrl+Z / Ctrl+Y over a dictation is not a correction either; learning from it would read "everything deleted".
    if (!promptInput.value.trim() || event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { lastVoiceDraft = null; resetVoiceCorrections(); }
    if (lastVoiceDraft) voiceEditTimer = setTimeout(() => checkVoiceCorrections(), 700);
  });

  // The pill is the way back to the prompts: it jumps to the chat holding the next one to go out;
  // hovering grows the pill leftward into a card listing its chats (the marks and names of Recent in the
  // sidebar: each chat's project icon). The card is a child of the pill, like the usage ring's, so the two are one surface.
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
  const schedPill = document.createElement('span');
  schedPill.className = 'sched-pill';
  schedPill.inert = true; // not focusable or clickable until it is open
  queueBtn.prepend(schedPill);
  let schedLeaveTimer;
  const queueTitle = () => `${activeTasks().length} scheduled prompt${activeTasks().length === 1 ? '' : 's'}`;
  /** The chat's project icon, as in Recent; a chat without a project (or before the projects arrive) keeps the agent's logo. */
  function schedMark(session, agent) {
    const project = session?.projectId ? window.railProjectMark?.(session.projectId) : null;
    if (project) return project;
    const logo = document.createElement('span');
    logo.className = 'sched-pill-agent';
    logo.innerHTML = AGENT_ICONS[agent] || '';
    return logo;
  }
  /** Fills the card. Rebuilt when the set of chats changes; otherwise only the countdowns move. */
  function renderSchedPill() {
    if (!queueBtn.classList.contains('is-sched-open')) return;
    const chats = scheduledChats();
    if (!chats.length) { closeSchedPill(true); return; }
    const key = JSON.stringify([railMarks, chats.map(entry => {
      const session = historySessions.find(item => item.id === entry.id);
      return [entry.id, entry.count, session?.title, session?.preview, session?.projectId, session?.models];
    })]);
    const metaOf = (entry) => `${entry.count} scheduled${Number.isFinite(entry.at) ? ` · ${formatCountdown(entry.at - Date.now())}` : ''}`;
    if (schedPill.dataset.key !== key) {
      schedPill.dataset.key = key;
      schedPill.style.setProperty('--rows', chats.length);
      schedPill.replaceChildren(...chats.map((entry) => {
        const session = historySessions.find((item) => item.id === entry.id);
        const agent = (session?.models || []).at(-1) || entry.agent;
        const row = document.createElement('span');
        row.className = 'sched-pill-row';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.innerHTML = '<span class="sched-pill-mark"></span><span class="sched-pill-title"></span><span class="sched-pill-meta"></span>';
        row.querySelector('.sched-pill-mark').append(schedMark(session, agent));
        row.querySelector('.sched-pill-title').textContent = session?.title || session?.preview || 'Chat';
        row.classList.toggle('is-here', entry.id === currentChatId);
        const go = (event) => { event.stopPropagation(); closeSchedPill(true); if (entry.id !== currentChatId) vscode.postMessage({ type: 'restoreChat', id: entry.id }); };
        row.addEventListener('click', go);
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(event); } });
        return row;
      }));
    }
    chats.forEach((entry, i) => { schedPill.children[i].querySelector('.sched-pill-meta').textContent = metaOf(entry); });
  }
  function openSchedPill() {
    clearTimeout(schedLeaveTimer);
    if (queueBtn.classList.contains('is-sched-open') || !scheduledChats().length) return;
    queueBtn.classList.add('is-sched-open');
    queueBtn.removeAttribute('title'); // the native tooltip would sit on top of the card
    schedPill.inert = false;
    renderSchedPill();
  }
  function closeSchedPill(now = false) {
    clearTimeout(schedLeaveTimer);
    const close = () => {
      queueBtn.classList.remove('is-sched-open');
      schedPill.inert = true;
      queueBtn.title = queueTitle();
    };
    if (now) close(); else schedLeaveTimer = setTimeout(close, 140);
  }
  queueBtn.addEventListener('mouseenter', openSchedPill);
  queueBtn.addEventListener('mouseleave', () => closeSchedPill());
  queueBtn.addEventListener('focusin', () => { if (queueBtn.matches(':focus-visible, :has(:focus-visible)')) openSchedPill(); });
  queueBtn.addEventListener('focusout', (event) => { if (!queueBtn.contains(event.relatedTarget)) closeSchedPill(); });
  queueBtn.addEventListener('keydown', (event) => { if (event.key === 'Escape' && queueBtn.classList.contains('is-sched-open')) { event.stopPropagation(); closeSchedPill(true); queueBtn.focus(); } });
  queueBtn.addEventListener('click', () => {
    const chats = scheduledChats();
    // Tasks from before they were tied to a chat have no chat to jump to: the old list opens.
    if (!chats.length) { if (!queueModal.el.hidden) { closeModal(queueModal.el); return; } queuePinned = false; renderQueue(); openModal(queueModal); return; }
    if (chats[0].id !== currentChatId) vscode.postMessage({ type: 'restoreChat', id: chats[0].id }); else promptInput.focus();
  });
  newChatBtn.addEventListener('click', () => { if (editingQueue) finishQueueEdit(); clearEmptyState(); vscode.postMessage({ type: 'newChat' }); });
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
  const FILE_REF = /^(?:file:\/\/\/?)?([^<>"|?*\r\n]+\.([a-z][a-z0-9]{0,7}))(?:#L?(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)?$/i;
  const fileSvg = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const FILE_ICONS = {
    doc: fileSvg('<path d="M9.5 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V4.75z"/><path d="M9.5 1.75v3h3M5.5 8.5h5M5.5 11h3.5"/>'),
    code: fileSvg('<path d="M9.5 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V4.75z"/><path d="M9.5 1.75v3h3M6.75 8 5.5 9.5l1.25 1.5M9.25 8l1.25 1.5-1.25 1.5"/>'),
    image: fileSvg('<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5"/><circle cx="6" cy="6.5" r="1.1"/><path d="m13.75 10.5-3.5-3.25-6.5 6"/>'),
  };
  // Which FILE_ICONS glyph an extension gets; anything unlisted is a plain doc.
  const FILE_KIND = Object.fromEntries([
    ...['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'astro', 'css', 'scss', 'html', 'htm', 'json', 'py', 'ps1', 'sh', 'bash', 'yml', 'yaml', 'toml'].map((ext) => [ext, 'code']),
    ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].map((ext) => [ext, 'image']),
  ]);
  const KNOWN_FILE_EXTENSIONS = new Set([
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'astro', 'css', 'scss', 'html', 'htm',
    'json', 'py', 'ps1', 'sh', 'bash', 'yml', 'yaml', 'md', 'txt', 'toml', 'env',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'pdf'
  ]);
  const CHAT_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']);
  const CHAT_IMAGE_CAP = 4; // sweet spot: 1 featured, 2 side-by-side before/after, or up to 2x2 grid; extra fold behind a pill
  const STANDALONE_IMAGE_RE = /^\s*!\[([^\]\r\n]*)\]\((?:<([^<>\r\n]+)>|([^\r\n)]+))\)\s*$/;
  // Dotenv files (.env, .env.local, .env.production) have no real extension, so they get their own test.
  const ENV_FILE = /(?:^|[\\/])\.env(?:\.[\w-]+)*$/i;
  function parseLocalImageRef(ref) {
    if (!ref || /^(https?|mailto):/i.test(ref)) return null;
    const match = FILE_REF.exec(ref);
    if (!match) return null;
    let file = match[1];
    try { file = decodeURIComponent(file); } catch { /* keep as written */ }
    if (!file || file.includes('\u0000')) return null;
    const ext = match[2].toLowerCase();
    if (!CHAT_IMAGE_EXTS.has(ext)) return null;
    return { file, ext, base: file.split(/[\\/]/).pop() || file };
  }
  const normImageKey = (file) => String(file || '').replaceAll('\\', '/').replace(/\/+/g, '/').trim();
  function chatImageCardHtml({ file, ext, label, explicit }) {
    const shown = label || file.split(/[\\/]/).pop() || file;
    return `<figure class="chat-image-card is-loading${ext === 'svg' ? ' is-svg' : ''}" data-path="${escapeHtml(file)}" data-label="${escapeHtml(shown)}" data-ext="${escapeHtml(ext)}" data-explicit="${explicit ? '1' : '0'}"${explicit ? '' : ' hidden'}><div class="chat-image-head"><figcaption class="chat-image-caption" title="${escapeHtml(shown)}">${escapeHtml(shown)}</figcaption><button type="button" class="chat-image-popout" title="Open in VS Code" aria-label="Open ${escapeHtml(shown)} in VS Code">${OPEN_ICON}</button></div><button type="button" class="chat-image-stage" aria-label="Preview ${escapeHtml(shown)}"><span class="chat-image-skeleton" aria-hidden="true"></span></button></figure>`;
  }
  function fileBadge(ref, label) {
    const match = ENV_FILE.test(ref) ? [ref, ref.replace(/^file:\/\/\/?/i, ''), 'env'] : FILE_REF.exec(ref);
    if (!match || /^(https?|mailto):/i.test(ref)) return null;
    let file = match[1];
    try { file = decodeURIComponent(file); } catch { /* keep as written */ }
    if (file.includes('\u0000')) return null;
    const ext = match[2].toLowerCase();
    if (!KNOWN_FILE_EXTENSIONS.has(ext)) return null;
    const line = match[3] || match[4] || '';
    const base = file.split(/[\\/]/).pop();
    const shown = file.replace(/^\/?[a-z]:\//i, '');
    const browser = /^html?$/.test(ext) && !line;
    return `<button type="button" class="file-badge" data-ext="${escapeHtml(ext)}" data-path="${escapeHtml(file)}" data-line="${line}" title="${escapeHtml((ext === 'pdf' ? 'Open in editor: ' : browser ? 'Open in browser: ' : '') + shown + (line ? `:${line}` : ''))}">${FILE_ICONS[FILE_KIND[ext] || 'doc']}<span>${escapeHtml(label || base)}${line ? `<small>:${line}</small>` : ''}</span></button>`;
  }
  function openChatImageCard(card) {
    const path = card?.dataset.path;
    if (!path) return;
    const open = (reply) => {
      if (!reply || reply.error || !reply.uri) { showToast(`${reply?.error || 'Could not preview image'}: ${baseName(path)}`, { error: true }); return; }
      const label = card.dataset.label || reply.name || baseName(path);
      openLightbox(reply.uri, label, false, { uri: reply.uri, name: reply.name || baseName(path), path: reply.path || path }, null, { openPath: reply.path || path });
    };
    if (card._preview) { open(card._preview); return; }
    void loadPreview(path).then(open);
  }
  transcriptEl.addEventListener('click', (event) => {
    const popout = event.target.closest?.('.chat-image-popout');
    if (popout) {
      event.stopPropagation();
      const card = popout.closest('.chat-image-card');
      if (card) vscode.postMessage({ type: 'openFile', path: card._preview?.path || card.dataset.path });
      return;
    }
    const stage = event.target.closest?.('.chat-image-stage');
    if (stage) {
      const card = stage.closest('.chat-image-card');
      if (card) openChatImageCard(card);
      return;
    }
    const more = event.target.closest?.('.chat-image-more');
    if (more) {
      expandChatImageOverflow(more);
      return;
    }
    const badge = event.target.closest?.('.file-badge');
    if (badge) vscode.postMessage({ type: 'openFile', path: badge.dataset.path, line: Number(badge.dataset.line) || null });
    const link = event.target.closest?.('a[data-external-url]');
    if (link) vscode.postMessage({ type: 'openUrl', url: link.dataset.externalUrl });
  });
  transcriptEl.addEventListener('keydown', (event) => {
    const link = event.target.closest?.('a[data-external-url]');
    if (event.key === 'Enter' && !event.repeat && link) {
      event.preventDefault();
      link.click();
    }
  });

  // External URLs go through the extension host. An href also lets the editor's webview
  // opener handle the click, which can prompt even after Clanker has opened the link.
  function externalLink(url, label, className = '') {
    return `<a role="link" tabindex="0" data-external-url="${url}" title="${url}"${className ? ` class="${className}"` : ''}>${label}</a>`;
  }

  function renderInline(text, notes) {
    const slots = [];
    const raws = [];
    const hold = (html, raw) => { raws[slots.length] = raw; return `\u0000${slots.push(html) - 1}\u0000`; };
    // A link label like [`.env`](...) holds a code slot; the badge wants its plain text.
    const plain = (label) => label.replace(/\u0000(\d+)\u0000/g, (_, n) => raws[n] ?? '').replace(/^(\*{1,3}|_{1,3}|~~)(?=\S)([\s\S]*?\S)\1$/, '$2');
    let s = String(text).replaceAll('\u0000', '')
      .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
        const ref = code.trim();
        // A bare URL in backticks (how agents usually print dev-server addresses) stays code-styled but clickable.
        if (/^https?:\/\/[^\s<>"]+$/i.test(ref)) return hold(externalLink(escapeHtml(ref), `<code>${escapeHtml(ref)}</code>`, 'code-link'));
        const badge = /[\\/]|\.pdf$/i.test(ref) ? fileBadge(ref) : null;
        return hold(badge || `<code>${escapeHtml(ref)}</code>`, ref);
      })
      .replace(/!\[([^\]\r\n]*)\]\((?:<([^<>\r\n]+)>|([^\r\n)]+))\)/g, (whole, alt, wrapped, target) => {
        const badge = fileBadge((wrapped || target).trim(), plain(alt));
        return badge ? hold(badge) : whole;
      })
      .replace(/\[([^\]\r\n]+)\]\((?:<([^<>\r\n]+)>|([^\r\n)]+))\)/g, (whole, label, wrapped, target) => { const badge = fileBadge((wrapped || target).trim(), plain(label)); return badge ? hold(badge) : whole; })
      .replace(/\$\$([^$]+?)\$\$/g, (_, tex) => hold(renderMath(tex, true)))
      .replace(/\\\((.+?)\\\)/g, (_, tex) => hold(renderMath(tex, false)))
      .replace(/(^|[\s([{])\$(?!\s|\$|\d)([^$\n`=;|+]{1,120}?)(?<!\s|\$)\$(?=[\s)\]},.:;!?]|$)/g, (whole, pre, tex) => {
        if (/\$[a-zA-Z_]/.test(tex)) return whole;
        return pre + hold(renderMath(tex, false));
      });
    s = escapeHtml(s)
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)\u0000]+)\)/g, (_, label, url) => hold(externalLink(url, renderEmphasis(label))))
      .replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]*[^\s<\u0000.,;:!?)\]'"])/g, (_, pre, url) => pre + hold(externalLink(url, url)))
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
    || LIST_RE.test(line) || MATH_OPEN_RE.test(line) || FOOTNOTE_RE.test(line) || STANDALONE_IMAGE_RE.test(line) || isTableStart(line, next);

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
      if (STANDALONE_IMAGE_RE.test(line)) {
        const cards = [];
        let j = i;
        while (j < lines.length) {
          const im = lines[j].match(STANDALONE_IMAGE_RE);
          if (!im) break;
          const parsed = parseLocalImageRef((im[2] || im[3] || '').trim());
          if (!parsed) break;
          cards.push(chatImageCardHtml({ file: parsed.file, ext: parsed.ext, label: im[1].trim() || parsed.base, explicit: true }));
          j += 1;
        }
        if (cards.length) {
          out.push(`<div class="chat-image-grid" data-inline-images="explicit" data-count="${cards.length}">${cards.join('')}</div>`);
          i = j;
          continue;
        }
      }
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
  const toolViews = new Set(); // tool output views holding Shiki colours, repainted when the theme changes
  const HIGHLIGHT_BUDGET = 2 * 1024 * 1024;
  let highlightBytes = 0;
  let highlighterLoading = null;
  let themeApplying = Promise.resolve();
  const observedCode = new Set();
  const codeVisibility = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) if (isIntersecting) {
      codeVisibility.unobserve(target); observedCode.delete(target);
      if (!document.hidden) void ensureHighlighter().then(() => { if (target.isConnected && !document.hidden) highlightInto(target); });
    }
  }, { rootMargin: '160px' });
  let codeFrame = 0;
  new MutationObserver(records => {
    if (!observedCode.size || !records.some(record => record.removedNodes.length)) return;
    for (const el of observedCode) if (!el.isConnected) { codeVisibility.unobserve(el); observedCode.delete(el); }
  }).observe(document.body, { childList: true, subtree: true });
  function queueCode(codeEl) {
    if (codeEl.textContent.length > 100000) return;
    observedCode.add(codeEl);
    if (codeFrame) return;
    codeFrame = requestAnimationFrame(() => {
      codeFrame = 0;
      for (const el of observedCode) {
        if (!el.isConnected) { codeVisibility.unobserve(el); observedCode.delete(el); }
        else if (!document.hidden) codeVisibility.observe(el);
      }
    });
  }
  function ensureHighlighter() {
    if (highlighterLoading) return highlighterLoading;
    highlighterLoading = (async () => {
      if (!window.createCodeHighlighter) await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = window.SHIKI_URI;
        script.onload = resolve; script.onerror = reject;
        document.head.append(script);
      });
      highlighter = await window.createCodeHighlighter();
      await applyEditorTheme();
    })().catch(() => { highlighterLoading = null; });
    return highlighterLoading;
  }
  const FONT_STYLE = [[1, 'font-style:italic'], [2, 'font-weight:600'], [4, 'text-decoration:underline']];

  // The coloured HTML for `code` (one string, lines joined by a newline), or null while Shiki or the theme isn't ready or the language is unknown.
  function highlightHtml(code, lang, complete) {
    if (!highlighter || !editorThemeName || !lang) return null;
    if (code.length > 100000) return null; // very large blocks remain readable without blocking the UI
    const key = `${lang}\u0000${code}`;
    let html = highlightCache.get(key);
    if (html === undefined) {
      try {
        html = highlighter.codeToTokensBase(code, { lang, theme: editorThemeName })
          .map((line) => line.map((token) => {
            const style = [token.color && `color:${token.color}`, ...FONT_STYLE.filter(([bit]) => token.fontStyle > 0 && token.fontStyle & bit).map(([, css]) => css)].filter(Boolean).join(';');
            return style ? `<span style="${style}">${escapeHtml(token.content)}</span>` : escapeHtml(token.content);
          }).join(''))
          .join('\n');
      } catch { html = null; } // a language not in the bundle stays plain
      const bytes = 2 * (key.length + (html?.length || 0));
      if (complete && bytes <= HIGHLIGHT_BUDGET) {
        while (highlightCache.size && (highlightBytes + bytes > HIGHLIGHT_BUDGET || highlightCache.size >= 300)) {
          const oldest = highlightCache.keys().next().value;
          highlightBytes -= 2 * (oldest.length + (highlightCache.get(oldest)?.length || 0));
          highlightCache.delete(oldest);
        }
        highlightCache.set(key, html); highlightBytes += bytes;
      }
    }
    return html;
  }
  function highlightInto(codeEl) {
    const html = highlightHtml(codeEl.textContent, codeEl.dataset.lang, codeEl.dataset.complete === 'true');
    if (html) codeEl.innerHTML = html;
  }

  function applyEditorTheme() {
    if (!highlighter || !editorTheme) return Promise.resolve();
    const theme = editorTheme;
    themeApplying = themeApplying.catch(() => {}).then(async () => {
      if (theme !== editorTheme) return;
      const previous = editorThemeName;
      const name = `editor-${++themeVersion}`;
      // This bundled Shiki has no unloadTheme API. Replacing and disposing its
      // context releases old theme/grammar state instead of retaining each theme.
      const next = previous ? await window.createCodeHighlighter() : highlighter;
      try { await next.loadTheme({ ...theme, name }); }
      catch (error) { if (next !== highlighter) next.dispose(); throw error; }
      if (next !== highlighter) { highlighter.dispose(); highlighter = next; }
      editorThemeName = name;
      highlightCache.clear(); highlightBytes = 0;
      for (const view of toolViews) { if (view.isConnected) view.paint(); else toolViews.delete(view); }
      document.querySelectorAll('.code-block code[data-lang]').forEach(codeEl => {
        codeEl.textContent = codeEl.textContent; queueCode(codeEl);
      });
    });
    return themeApplying;
  }
  document.addEventListener('visibilitychange', () => {
    refreshAgents();
    if (document.hidden) return;
    if (!agentsModal.el.hidden && shownAgentId) showAgent(shownAgentId);
    if (!historyModal.el.hidden) renderHistory(historySessions);
    document.querySelectorAll('.code-block code[data-lang]').forEach(queueCode);
  });

  function buildCodeBlock(lang, code, complete = true) {
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
    if (lang) { codeEl.dataset.lang = lang.toLowerCase(); codeEl.dataset.complete = String(complete); queueCode(codeEl); }
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
      frag.appendChild(buildCodeBlock(match[1].trim().split(/\s+/)[0], match[2].replace(/\n$/, ''), match[0].endsWith('```')));
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
    if (message.model) agent.model = message.model;
    if (message.effort) agent.effort = message.effort;
    if (message.external) agent.external = true;
    agent.lastAt = at;
    if (message.type === 'subagent_start') {
      Object.assign(agent, { description: message.description, subagentType: message.subagentType, status: 'running' });
      if (message.prompt && !agent.events.some((e) => e.type === 'task')) pushAgentEvent(agent, { type: 'task', text: message.prompt });
    } else if (message.type === 'subagent_event') {
      if (message.event.type !== 'task' || !agent.events.some((e) => e.type === 'task')) pushAgentEvent(agent, message.event);
    } else if (message.type === 'subagent_end') {
      agent.status = message.launched ? 'background' : message.error ? 'failed' : 'done';
    } else if (message.type === 'subagent_status') {
      const settled = { background: 'background', completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped', ended: 'ended' }[message.status];
      if (settled) agent.status = settled;
    }
    refreshAgents();
    saveAgents();
  }
  function pushAgentEvent(agent, event) {
    agent.events.push(event);
    agent.eventBytes = (agent.eventBytes || 0) + JSON.stringify(event).length * 2;
    let trimmed = false;
    while (agent.events.length && (agent.events.length > 300 || agent.eventBytes > 256 * 1024)) {
      agent.eventBytes -= JSON.stringify(agent.events.shift()).length * 2;
      trimmed = true;
    }
    let total = [...subagents.values()].reduce((bytes, item) => bytes + (item.eventBytes || 0), 0);
    for (const item of subagents.values()) while (item.events.length && total > 2 * 1024 * 1024) {
      const bytes = JSON.stringify(item.events.shift()).length * 2;
      item.eventBytes -= bytes; total -= bytes;
      if (item.id === shownAgentId) trimmed = true;
    }
    if (!agentsModal.el.hidden && !document.hidden) {
      if (trimmed && shownAgentId) showAgent(shownAgentId);
      else if (agent.id === shownAgentId) renderAgentEvent(event, true);
    }
  }
  // A turn that ends takes its foreground agents with it; background ones keep going.
  function settleAgents(interrupted) {
    for (const agent of subagents.values()) if (agent.status === 'running') agent.status = interrupted ? 'stopped' : 'done';
    refreshAgents();
    saveAgents();
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
        while (Object.keys(saved).length && JSON.stringify(saved).length * 2 > 2 * 1024 * 1024) delete saved[Object.keys(saved)[0]];
        vscode.setState({ ...state, agents: saved });
      } catch {}
    }, 800);
  }
  // Whatever was still working when the window went away has ended with it.
  function restoreAgents() {
    let saved;
    try { saved = vscode.getState()?.agents?.[currentChatId]; } catch {}
    for (const agent of saved || []) {
      const events = [];
      const restored = { ...agent, events, eventBytes: 0, status: agentWorking(agent) ? 'ended' : agent.status };
      for (const event of agent.events || []) {
        events.push(event); restored.eventBytes += JSON.stringify(event).length * 2;
        while (events.length && (events.length > 300 || restored.eventBytes > 256 * 1024)) restored.eventBytes -= JSON.stringify(events.shift()).length * 2;
      }
      subagents.set(agent.id, restored);
    }
    if (subagents.size) refreshAgents();
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
    const tick = !document.hidden && !agentsModal.el.hidden;
    if (tick && !agentsTicker) agentsTicker = setInterval(refreshAgents, 1000);
    if (!tick && agentsTicker) { clearInterval(agentsTicker); agentsTicker = null; }
    if (!agentsModal.el.hidden && !document.hidden) renderAgentTabs();
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
    head.querySelector('.agents-type').textContent = [agent.subagentType, agent.model, agent.effort].filter(Boolean).join(' · ');
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
    } else if (event.type === 'notice' && event.text) {
      const notice = document.createElement('div');
      notice.className = 'msg msg-notice';
      notice.textContent = event.text;
      log.appendChild(notice);
    } else if (event.type === 'thought' && event.text) {
      const thought = document.createElement('details');
      thought.className = 'agents-thought';
      thought.innerHTML = '<summary>Thinking</summary><div class="agents-thought-text"></div>';
      thought.querySelector('.agents-thought-text').textContent = event.text;
      log.appendChild(thought);
    } else if (event.type === 'tool_start') {
      const command = event.command || event.file;
      const card = appendToolCard({ name: event.name, command, intent: event.summary, output: { text: '' }, done: event.done, diff: event.diff, startedAt: event.startedAt ?? event.at, durationMs: event.durationMs, host: log });
      // The summary line truncates; opening the step shows the whole command above its output.
      if (command) {
        const full = document.createElement('div');
        full.className = 'agents-tool-command';
        full.textContent = command;
        card.insertBefore(full, card.querySelector('.tool-body'));
      }
      if (event.toolId) agentLog.cards.set(event.toolId, card);
    } else if (event.type === 'tool_progress') {
      updateToolProgress(agentLog.cards.get(event.toolId), event);
    } else if (event.type === 'tool_end') {
      finishToolCard(agentLog.cards.get(event.toolId), { output: event.output, error: event.error, durationMs: event.durationMs });
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
      <div class="halo-hello"><h2>${window.CLANKER_GREETING_NAME ? `Hi ${escapeHtml(window.CLANKER_GREETING_NAME)}` : 'Hello'}</h2><p>What are we making today?</p></div>
      <ul class="empty-tips"><li><button type="button" data-mascot-action="mention"><kbd>@</kbd>mention a file</button></li><li><button type="button" data-mascot-action="action"><kbd>/</kbd>run an action</button></li><li><button type="button" data-mascot-action="image"><kbd>+</kbd>attach an image</button></li></ul>`;
    emptyMascot = window.createClankerMascot({ root: el, input: promptInput, modelPicker: modelPickerBtn, attach: attachBtn, mic: micBtn, schedule: scheduleBtn, transcript: transcriptEl });
    return el;
  }
  transcriptEl.querySelector('.empty-state')?.replaceWith(emptyState());

  // P17-E: streaming output only follows the tail while the reader is already
  // there; scrolling up to read earlier output is never yanked back down.
  // Only an upward scroll that ends away from the bottom lets go of the tail;
  // a burst of output landing between our scroll and its scroll event never does.
  let stickToEnd = true;
  let lastScrollTop = 0;
  let transcriptScrollFrame = 0;
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
    const scrollingUp = top < lastScrollTop;
    if (isTranscriptNearBottom()) stickToEnd = true;
    else if (scrollingUp) stickToEnd = false;
    lastScrollTop = top;
    if (!chatFind?.isJumping) {
      if (scrollingUp) loadEarlierHistory(true);
      loadVisibleGaps(scrollingUp);
    }
  }, { passive: true });
  function scrollTranscriptToEnd(force = false) {
    if (restoringHistory) return;
    if (!force && !stickToEnd) return;
    stickToEnd = true;
    if (transcriptScrollFrame) return;
    const chatId = currentChatId;
    transcriptScrollFrame = requestAnimationFrame(() => {
      transcriptScrollFrame = 0;
      if (chatId !== currentChatId || !stickToEnd) return;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      lastScrollTop = transcriptEl.scrollTop;
      updateTranscriptFade();
      loadEarlierHistory(); // short pages fill the viewport without loading the whole conversation
    });
  }
  // P17-N: content that grows after the scroll (code highlighting, KaTeX,
  // images decoding, a turn collapsing) re-pins the tail while stuck to it.
  const pinToEnd = new ResizeObserver(() => {
    transcriptEl.style.setProperty('--transcript-h', `${transcriptEl.clientHeight}px`); // the first message sits at a share of this
    if (stickToEnd) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      lastScrollTop = transcriptEl.scrollTop;
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
  const REVERT_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 3 2.5 6l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 6h6.75a4 4 0 0 1 0 8H7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const REPLY_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  transcriptEl.addEventListener('contextmenu', (event) => {
    const img = event.target.closest('img:not(.attachment-pdf)');
    if (!img || img.closest('.attachment-chip')) return;
    event.preventDefault();
    event.stopPropagation();
    const rawName = (img.getAttribute('alt') || img.src.split('/').pop()?.split('?')[0] || 'image.png').trim();
    openImageContextMenu(event.clientX, event.clientY, { uri: img.src, name: /\.[a-z0-9]{2,5}$/i.test(rawName) ? rawName : 'image.png' }, img);
  });

  // Right-click copies what is under the pointer: the selection, a file, link, code block, table cell, paragraph or the whole
  // message (media/copy-targets.js decides). Typing fields and Shift+right-click keep the browser's own menu.
  async function copyToClipboard(text, noun) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('no clipboard API');
    } catch {
      const area = document.createElement('textarea');
      area.value = text; area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(area); area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) { showToast('Could not copy to the clipboard.', { error: true }); return; }
    }
    showToast(`Copied ${noun || 'text'}.`);
  }
  function selectionUnderPointer(event) {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return '';
    const rects = [...selection.getRangeAt(0).getClientRects()];
    const hit = rects.some((r) => event.clientX >= r.left - 2 && event.clientX <= r.right + 2 && event.clientY >= r.top - 2 && event.clientY <= r.bottom + 2);
    return hit ? selection.toString() : '';
  }
  document.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented || event.shiftKey || !window.copyTargets) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const targets = window.copyTargets.targetsAt(event.target, { selection: selectionUnderPointer(event) });
    event.preventDefault(); // never the generic Cut/Copy/Paste, which copies nothing unless something is selected
    if (!targets.length) { closeImageMenu?.(); return; }
    const entries = targets.map((target) => {
      switch (target.kind) {
        case 'openFile': return { icon: OPEN_ICON, text: target.label, action: 'open', run: () => vscode.postMessage({ type: 'openFile', path: target.path, line: target.line }) };
        case 'openUrl': return { icon: OPEN_ICON, text: target.label, action: 'open-link', run: () => vscode.postMessage({ type: 'openUrl', url: target.url }) };
        case 'download': return { icon: DOWNLOAD_ICON, text: target.label, action: 'download', run: () => downloadAttachment(target.attachment) };
        case 'copyPath': return { icon: COPY_ICON, text: target.label, action: 'copy-path', run: () => vscode.postMessage({ type: 'copyFilePath', path: target.path, mode: 'path' }) };
        case 'copyFile': return { icon: COPY_ICON, text: target.label, action: 'copy-file', run: () => vscode.postMessage({ type: 'copyFilePath', path: target.path, mode: 'file' }) };
        default: return { icon: COPY_ICON, text: target.label, action: 'copy', hint: target.hint, run: () => { void copyToClipboard(target.text, target.noun); } };
      }
    });
    showContextMenu(event.clientX, event.clientY, 'Copy actions', entries);
  });

  function formatTime(at) {
    return at ? window.chatTime.messageTime(at, { locale: TIME_PREFS.locale, hourCycle: HOUR_CYCLE }) : '';
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

  // Dictation cues (aiChatPanel.voiceSounds), played once the microphone is really recording and when it stops: a rising
  // pair of sine blips for "you are live", a single falling one for "got it".
  function warmMicCue() {
    try {
      droidAudio = droidAudio || new AudioContext();
      if (droidAudio.state === 'suspended') droidAudio.resume();
    } catch { /* no audio device: the cue stays silent */ }
  }
  function playMicCue(kind) {
    try {
      droidAudio = droidAudio || new AudioContext();
      if (droidAudio.state === 'suspended') droidAudio.resume();
      // [Hz, start s, length s]
      const notes = kind === 'start' ? [[660, 0, 0.08], [990, 0.09, 0.11]] : [[760, 0, 0.12]];
      const now = droidAudio.currentTime;
      for (const [hz, start, length] of notes) {
        const osc = droidAudio.createOscillator();
        const gain = droidAudio.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(hz, now + start);
        gain.gain.setValueAtTime(0.0001, now + start);
        gain.gain.exponentialRampToValueAtTime(0.12, now + start + 0.01);
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
  function offerUndo(count, diff) {
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
    if (diff?.files?.length) turn.append(turnDiffList(diff));
  }

  // What the turn changed: "3 files, +42 / -11", opening to the files. A file opens the editor's diff (host: ChatRun.openTurnDiff).
  function turnDiffList(diff) {
    const box = document.createElement('details');
    box.className = 'undo-action turn-diff';
    const head = document.createElement('summary');
    const total = document.createElement('span');
    total.textContent = `${diff.count} file${diff.count === 1 ? '' : 's'} changed`;
    const sum = document.createElement('span');
    sum.className = 'turn-diff-sum';
    sum.append(Object.assign(document.createElement('span'), { className: 'turn-diff-add', textContent: `+${diff.add}` }), ' ', Object.assign(document.createElement('span'), { className: 'turn-diff-del', textContent: `\u2212${diff.del}` }));
    head.append(total, sum);
    box.append(head);
    const list = document.createElement('div');
    list.className = 'turn-diff-files';
    diff.files.forEach((file, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'turn-diff-file';
      item.title = `Open the diff for ${file.path}`;
      const status = Object.assign(document.createElement('span'), { className: `turn-diff-status status-${file.status}`, textContent: file.status === 'A' ? 'new' : file.status === 'D' ? 'deleted' : 'edited' });
      const name = Object.assign(document.createElement('span'), { className: 'turn-diff-name', textContent: file.path });
      const counts = Object.assign(document.createElement('span'), { className: 'turn-diff-counts', textContent: file.add === null ? 'binary' : `+${file.add} \u2212${file.del}` });
      item.append(status, name, counts);
      item.addEventListener('click', () => vscode.postMessage({ type: 'openTurnDiff', index }));
      list.append(item);
    });
    if (diff.count > diff.files.length) list.append(Object.assign(document.createElement('div'), { className: 'turn-diff-more', textContent: `\u2026 and ${diff.count - diff.files.length} more` }));
    box.append(list);
    return box;
  }

  // Your message: hovering shows time, Copy, and Revert. Revert forks the
  // chat just before this message and puts the message back in the composer.
  // The goo that fuses your bubble and its dock: blur, sharpen the alpha into one
  // liquid silhouette, then draw the untouched original back on top (text stays crisp).
  document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><filter id="msg-goo" x="-10%" y="-10%" width="120%" height="130%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/><feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo"/><feComposite in="SourceGraphic" in2="goo" operator="atop"/></filter><filter id="tip-goo" filterUnits="userSpaceOnUse" x="-320" y="-40" width="420" height="140" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/><feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo"/><feComposite in="SourceGraphic" in2="goo" operator="atop"/></filter></svg>'); // tip-goo: same goo, a wide fixed region for a tag hanging off a 32px button

  // P17-K: a prompt longer than three lines clamps behind a fade with a Show more / Show less toggle.
  // Dynamic: the clamp follows the text. Resizing the panel, loading a font or revealing a hidden chat re-measures it, so the
  // toggle appears only while there is more to show, and goes away when the whole prompt fits in three lines.
  function clampUserBubble(bubble, body) {
    bubble.classList.add('is-clamped');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'msg-clamp-toggle';
    toggle.textContent = 'Show more';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', body.id);
    toggle.addEventListener('click', () => {
      const expanded = bubble.classList.toggle('is-expanded');
      toggle.textContent = expanded ? 'Show less' : 'Show more';
      toggle.setAttribute('aria-expanded', String(expanded));
    });
    bubble.querySelector('.msg-user-content').append(toggle);
  }

  function unclampUserBubble(bubble) {
    bubble.classList.remove('is-clamped', 'is-expanded');
    bubble.querySelector('.msg-clamp-toggle')?.remove();
  }

  const userClampBubbles = new Map(); // body -> bubble, for every prompt the observer is watching
  const dirtyUserClamps = new Set();
  let userClampFrame = 0;
  function settleUserClamps() {
    userClampFrame = 0;
    const bodies = [...dirtyUserClamps];
    dirtyUserClamps.clear();
    // Read every height first, then change classes: one layout for the whole batch.
    const verdicts = bodies.map((body) => {
      const bubble = userClampBubbles.get(body);
      const hidden = !bubble?.isConnected || !body.clientWidth; // hidden (another tab, collapsed): nothing to measure, keep as is
      return { body, bubble, hidden, overflows: !hidden && body.scrollHeight > (parseFloat(getComputedStyle(body).lineHeight) || 20) * 3 + 4 };
    });
    for (const { body, bubble, hidden, overflows } of verdicts) {
      if (!bubble?.isConnected) { userClampObserver.unobserve(body); userClampBubbles.delete(body); continue; }
      if (hidden) continue;
      const clamped = bubble.classList.contains('is-clamped');
      if (overflows && !clamped) clampUserBubble(bubble, body);
      else if (!overflows && clamped) unclampUserBubble(bubble);
    }
  }
  const userClampObserver = new ResizeObserver((records) => {
    for (const { target } of records) dirtyUserClamps.add(target);
    if (!userClampFrame) userClampFrame = requestAnimationFrame(settleUserClamps); // not in the observer: a class change resizes the box
  });
  function queueUserClamp(bubble, body) {
    userClampBubbles.set(body, bubble);
    userClampObserver.observe(body); // also reports once straight away, which does the first measurement
  }

  // Claude woke up on its own (a background agent reported back). Nobody typed it, so it is a quiet divider, not a bubble.
  const isBackgroundPrompt = (message) => Boolean(message?.background || (message?.remote && message.text === 'Background work continued'));

  function insertContextHandoff(turn, handoff) {
    if (!handoff?.from?.label || !handoff?.to?.label || turn.previousElementSibling?.classList.contains('model-handoff-divider')) return;
    const divider = document.createElement('div');
    divider.className = 'model-handoff-divider';
    divider.setAttribute('role', 'note');
    divider.setAttribute('aria-label', `Context handoff from ${handoff.from.label} to ${handoff.to.label}`);
    const capsule = document.createElement('div');
    capsule.className = 'model-handoff-status';
    const title = document.createElement('span');
    title.className = 'model-handoff-title';
    title.textContent = 'Context handoff';
    const route = document.createElement('span');
    route.className = 'model-handoff-route';
    const model = ({ agent, label }) => {
      const node = document.createElement('span');
      node.className = 'model-handoff-model';
      node.dataset.agent = agent;
      node.textContent = label;
      node.title = label;
      return node;
    };
    const arrow = document.createElement('span');
    arrow.className = 'model-handoff-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    route.append(model(handoff.from), arrow, model(handoff.to));
    capsule.append(title, route);
    divider.append(capsule);
    turn.before(divider);
  }

  function appendUserMessage(text, at = new Date().toISOString(), files = [], { scheduled = false, clientTurnId = null, background = false, contextHandoff } = {}) {
    const existing = clientTurnId && [...transcriptEl.querySelectorAll('.msg-group-user')].find(group => group.dataset.clientTurnId === clientTurnId);
    if (existing) {
      insertContextHandoff(existing.parentElement, contextHandoff);
      if (contextHandoff) scrollTranscriptToEnd();
      return;
    }
    clearEmptyState();
    const group = document.createElement('div');
    group.className = 'msg-group msg-group-user';
    if (clientTurnId) group.dataset.clientTurnId = clientTurnId;
    if (background) {
      group.classList.add('msg-group-background');
      const label = document.createElement('div');
      label.className = 'msg-background-divider';
      label.textContent = text || 'Background work continued';
      group.append(label);
      const index = nextUserIndex++; // keeps stored user positions aligned
      group.dataset.userIndex = index;
      const turn = document.createElement('div');
      turn.className = 'turn';
      turn.appendChild(group);
      transcriptEl.appendChild(turn);
      currentTurnEl = turn;
      turnAnchor = group;
      turnStartedAt = Date.now();
      currentAssistantBubble = null;
      scrollTranscriptToEnd(true);
      return;
    }
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
    bubble.dataset.raw = text; // right-click "Copy message" copies exactly what was sent
    if (files?.length) {
      const strip = document.createElement('div');
      strip.className = 'attachment-strip msg-attachments';
      strip.append(...files.map((file) => attachmentChip(file)));
      bubble.appendChild(strip);
    }
    const body = document.createElement('div');
    body.className = 'msg-user-text';
    body.appendChild(buildMessageBody(text));
    const content = document.createElement('div');
    content.className = 'msg-user-content';
    content.append(body);
    bubble.append(content);
    const index = nextUserIndex++; // absolute position, including history not fetched yet
    body.id = `message-text-${index}`;
    group.dataset.userIndex = index;
    const revert = iconAction(REVERT_ICON, 'Revert to here (forks the chat, message goes back to the composer)', () => vscode.postMessage({ type: 'revertToMessage', index }));
    const actions = messageActions(at, () => text, [revert]);
    group.append(bubble, actions);
    const turn = document.createElement('div');
    turn.className = 'turn';
    turn.appendChild(group);
    transcriptEl.appendChild(turn); // always top level, never inside the previous turn
    insertContextHandoff(turn, contextHandoff);
    queueUserClamp(bubble, body);
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

  function buildRoleLabel(model, label = null, roleName = null) {
    const roleLabel = document.createElement('div');
    roleLabel.className = 'msg-role';
    roleLabel.dataset.agent = model;
    if (label) roleLabel.dataset.modelLabel = label;
    roleLabel.innerHTML = AGENT_ICONS[model] || '';
    roleLabel.append(label || REPLY_NAMES[model] || model); // the exact model, e.g. "GPT 6 Sol High"
    if (roleName) roleLabel.append(roleChip(roleName));
    return roleLabel;
  }

  function ensureTurnRole(model, label = null, roleName = null) {
    if (!model || !currentTurnEl?.isConnected) return null;
    currentTurnEl.dataset.agent ||= model;
    const existing = currentTurnEl.querySelector(':scope > .msg-role');
    const next = buildRoleLabel(model, label, roleName);
    if (existing) {
      if ((label && existing.dataset.modelLabel !== label) || (roleName && !existing.querySelector('.msg-role-chip'))) {
        existing.replaceWith(next);
        return next;
      }
      return existing;
    }
    if (turnAnchor?.parentElement === currentTurnEl) turnAnchor.after(next);
    else currentTurnEl.prepend(next);
    return next;
  }

  function appendAssistantDelta(textChunk, model, label = null, roleName = null) {
    if (!textChunk) return;
    clearEmptyState();
    // Text that arrives after a tool/approval/question card continues in a
    // new bubble BELOW that card, never back up in the one above it.
    const last = turnHost().lastElementChild;
    const continued = currentAssistantBubble && (last === pendingEl ? last.previousElementSibling : last) !== currentAssistantBubble;
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
        if (currentTurnEl?.isConnected) ensureTurnRole(model, label, roleName);
        else currentAssistantBubble.appendChild(buildRoleLabel(model, label, roleName));
      }
      const body = document.createElement('div');
      body.className = 'msg-body';
      currentAssistantBubble.appendChild(body);
      turnHost().appendChild(currentAssistantBubble);
      turnBubbles.push(currentAssistantBubble);
    }
    currentAssistantBubble.dataset.raw += textChunk;
    if (restoringHistory) renderAssistantBody(currentAssistantBubble);
    else {
      pendingAssistantBodies.add(currentAssistantBubble);
      if (!assistantRenderFrame) assistantRenderFrame = requestAnimationFrame(() => {
        assistantRenderFrame = 0;
        for (const bubble of pendingAssistantBodies) if (bubble.isConnected) renderAssistantBody(bubble);
        pendingAssistantBodies.clear();
        scrollTranscriptToEnd();
      });
    }
    scrollTranscriptToEnd();
  }

  const pendingAssistantBodies = new Set();
  let assistantRenderFrame = 0;
  // A streaming reply used to be re-parsed and replaced whole on every frame, so a long answer cost quadratic work and
  // lost any text selection. Finished blocks now stay in the DOM and only the tail after the last safe cut is rebuilt.
  // stableCut() picks cuts the renderer would have made anyway (so the result matches a full render, see
  // test/stream-incremental.mjs): the end of a closed code fence, and a blank line that no list, table, maths block or
  // footnote can reach across.
  const FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)(```|$)/g;
  const NO_INCREMENTAL = /\[\^|<details/i;
  const BLANK_LINES = /\n(?:[ \t]*\n)+/g;
  const LIST_ANYWHERE_RE = new RegExp(LIST_RE.source, 'm'); // the renderer's own list-line test, over a whole chunk
  function paragraphCut(text, from, to) {
    let cut = from;
    BLANK_LINES.lastIndex = from;
    let sep;
    while ((sep = BLANK_LINES.exec(text)) && sep.index + sep[0].length <= to) {
      const end = sep.index + sep[0].length;
      const chunk = text.slice(cut, end);
      if (/\$\$|\\\[/.test(chunk)) continue; // a maths block may span a blank line
      // A list goes on past a blank line while the next line is indented or another item; a line that starts with a letter ends it.
      if (LIST_ANYWHERE_RE.test(chunk) && !(end < to && /\p{L}/u.test(text[end]))) continue;
      cut = end;
    }
    return cut;
  }
  function stableCut(text, from) {
    let cut = from, start = from, m;
    FENCE_RE.lastIndex = from;
    while ((m = FENCE_RE.exec(text))) {
      if (m.index > start) cut = Math.max(cut, paragraphCut(text, start, m.index));
      if (m[3] !== '```') return Math.max(cut, m.index); // an unclosed fence is still growing
      start = cut = FENCE_RE.lastIndex;
    }
    return Math.max(cut, paragraphCut(text, start, text.length));
  }
  // ---------- Inline chat images (shared lightbox + VS Code pop-out + smart 4-image cap) ----------
  const chatImagePendingBubbles = new WeakMap(); // bubble -> Set<card> awaiting viewport intersection
  const chatImageObserver = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      chatImageObserver.unobserve(target);
      const cards = chatImagePendingBubbles.get(target);
      if (!cards) continue;
      chatImagePendingBubbles.delete(target);
      for (const card of cards) hydrateSingleChatImage(card);
    }
  }, { root: transcriptEl, rootMargin: '240px' });

  function updateChatImageGridCount(grid) {
    if (!grid) return;
    const visible = [...grid.querySelectorAll(':scope > .chat-image-card:not([hidden])')].length;
    if (visible > 0) grid.dataset.count = String(visible);
    const gallery = grid.closest('.chat-image-gallery');
    if (gallery) {
      const moreBtn = gallery.querySelector('.chat-image-more');
      const hasMore = Boolean(moreBtn && !moreBtn.hidden);
      gallery.hidden = visible === 0 && !hasMore;
    }
  }

  function hydrateSingleChatImage(card) {
    if (!card || !card.isConnected || card.dataset.hydrated) return;
    card.dataset.hydrated = '1';
    const file = card.dataset.path;
    const explicit = card.dataset.explicit === '1';
    const grid = card.closest('.chat-image-grid');
    void loadPreview(file).then((reply) => {
      if (!card.isConnected) return;
      card.classList.remove('is-loading');
      if (!reply || reply.error || !reply.uri) {
        if (explicit) {
          // Explicit ![alt](missing.png) degrades cleanly to a clickable file link instead of a broken box.
          const fallback = fileBadge(file, card.dataset.label);
          if (fallback) {
            const tmp = document.createElement('span');
            tmp.innerHTML = fallback;
            card.replaceWith(tmp.firstElementChild);
          } else card.remove();
          if (grid && !grid.querySelector('.chat-image-card')) grid.remove();
          else updateChatImageGridCount(grid);
        } else {
          const gallery = card.closest('.chat-image-gallery');
          card.remove();
          // Promote the next overflow image if one is queued so a non-existent example path never steals a slot.
          if (gallery?._overflow?.length) {
            const next = gallery._overflow.shift();
            const tmp = document.createElement('div');
            tmp.innerHTML = chatImageCardHtml({ file: next.file, ext: next.ext, label: next.label, explicit: false });
            const nextCard = tmp.firstElementChild;
            grid.append(nextCard);
            observeChatImage(nextCard);
            syncChatImageMoreButton(gallery);
          }
          updateChatImageGridCount(grid);
        }
        return;
      }
      card._preview = reply;
      const stage = card.querySelector('.chat-image-stage');
      if (stage) {
        const img = document.createElement('img');
        img.src = reply.uri;
        img.alt = card.dataset.label || reply.name || baseName(file);
        img.draggable = false;
        img.loading = 'lazy';
        stage.replaceChildren(img);
      }
      if (!explicit) card.hidden = false;
      card.classList.add('is-ready');
      updateChatImageGridCount(grid);
    });
  }

  function observeChatImage(card, immediate = false) {
    if (!card || card.dataset.observed) return;
    card.dataset.observed = '1';
    if (immediate) { hydrateSingleChatImage(card); return; }
    const anchor = card.closest('.msg-assistant') || card;
    let queue = chatImagePendingBubbles.get(anchor);
    if (!queue) {
      queue = new Set();
      chatImagePendingBubbles.set(anchor, queue);
      chatImageObserver.observe(anchor);
    }
    queue.add(card);
  }

  function syncChatImageMoreButton(gallery) {
    const remaining = gallery?._overflow?.length || 0;
    let btn = gallery.querySelector('.chat-image-more');
    if (remaining <= 0) { btn?.remove(); return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-image-more';
      gallery.append(btn);
    }
    btn.textContent = `Show ${remaining} more ${remaining === 1 ? 'image' : 'images'}`;
  }

  function expandChatImageOverflow(moreBtn) {
    const gallery = moreBtn.closest('.chat-image-gallery');
    const grid = gallery?.querySelector('.chat-image-grid');
    if (!gallery || !grid) return;
    const extras = gallery._overflow || [];
    gallery._overflow = [];
    moreBtn.remove();
    const frag = document.createDocumentFragment();
    const touchedGrids = new Set([grid]);
    const toHydrate = [];
    for (const item of extras) {
      if (item.card) {
        item.card.hidden = false;
        toHydrate.push(item.card);
        const parentGrid = item.card.closest('.chat-image-grid');
        if (parentGrid) touchedGrids.add(parentGrid);
      } else {
        const tmp = document.createElement('div');
        tmp.innerHTML = chatImageCardHtml({ file: item.file, ext: item.ext, label: item.label, explicit: false });
        const card = tmp.firstElementChild;
        frag.append(card);
        toHydrate.push(card);
      }
    }
    if (frag.childNodes.length) grid.append(frag);
    for (const card of toHydrate) observeChatImage(card, true);
    for (const g of touchedGrids) updateChatImageGridCount(g);
  }

  function hydrateChatImages(bubble) {
    if (!bubble?.isConnected) return;
    const body = bubble.querySelector('.msg-body');
    if (!body) return;
    const seen = new Set();
    let visibleBudget = CHAT_IMAGE_CAP;

    // 1. Explicit ![alt](path) cards placed directly between paragraphs.
    const explicitCards = [...body.querySelectorAll('.chat-image-card[data-explicit="1"]')];
    const explicitOverflow = [];
    for (const card of explicitCards) {
      const key = normImageKey(card.dataset.path);
      if (seen.has(key)) { card.remove(); continue; }
      seen.add(key);
      if (visibleBudget > 0) {
        visibleBudget -= 1;
        observeChatImage(card);
      } else {
        card.hidden = true;
        explicitOverflow.push({ card });
      }
    }
    for (const grid of body.querySelectorAll('.chat-image-grid[data-inline-images="explicit"]')) {
      updateChatImageGridCount(grid);
    }

    // 2. Linked local image files ([before.png](...), etc.) embedded cleanly below the prose up to the 4-image cap.
    const autoCandidates = [];
    for (const badge of body.querySelectorAll('.file-badge')) {
      const ext = (badge.dataset.ext || '').toLowerCase();
      if (!CHAT_IMAGE_EXTS.has(ext)) continue;
      const file = badge.dataset.path;
      const key = normImageKey(file);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const label = badge.querySelector('span')?.textContent?.trim() || baseName(file);
      autoCandidates.push({ file, ext, label });
    }

    const totalAutoSig = autoCandidates.map((item) => item.file).join('\n') + '|' + explicitOverflow.length;
    let gallery = bubble.querySelector(':scope > .chat-image-gallery');
    if (gallery && gallery.dataset.sig === totalAutoSig) return;
    if (!autoCandidates.length && !explicitOverflow.length) { gallery?.remove(); return; }

    if (!gallery) {
      gallery = document.createElement('div');
      gallery.className = 'chat-image-gallery';
      gallery.hidden = true;
      const grid = document.createElement('div');
      grid.className = 'chat-image-grid is-auto';
      grid.dataset.count = '0';
      gallery.append(grid);
      const actions = bubble.querySelector(':scope > .msg-actions');
      if (actions) bubble.insertBefore(gallery, actions);
      else bubble.append(gallery);
    }
    gallery.dataset.sig = totalAutoSig;
    const grid = gallery.querySelector('.chat-image-grid');
    const existingKeys = new Set([...grid.querySelectorAll('.chat-image-card')].map((c) => normImageKey(c.dataset.path)));
    let gridSlots = Math.max(0, visibleBudget - existingKeys.size);
    const overflow = [...explicitOverflow];
    for (const item of autoCandidates) {
      const key = normImageKey(item.file);
      if (existingKeys.has(key)) continue;
      if (gridSlots > 0) {
        gridSlots -= 1;
        const tmp = document.createElement('div');
        tmp.innerHTML = chatImageCardHtml({ file: item.file, ext: item.ext, label: item.label, explicit: false });
        const card = tmp.firstElementChild;
        grid.append(card);
        observeChatImage(card);
      } else {
        overflow.push(item);
      }
    }
    gallery._overflow = overflow;
    syncChatImageMoreButton(gallery);
    updateChatImageGridCount(grid);
  }

  function renderAssistantBody(bubble) {
    const body = bubble.querySelector('.msg-body');
    const raw = bubble.dataset.raw;
    let inc = bubble._incremental;
    if (restoringHistory || NO_INCREMENTAL.test(raw)) {
      bubble._incremental = null;
      body.replaceChildren(buildMessageBody(raw));
      hydrateChatImages(bubble);
      return;
    }
    if (!inc || inc.body !== body || !raw.startsWith(inc.prefix)) {
      inc = bubble._incremental = { body, prefix: '', cut: 0, count: 0 };
      body.replaceChildren();
    }
    const cut = stableCut(raw, inc.cut);
    while (body.childNodes.length > inc.count) body.lastChild.remove(); // the previous tail
    if (cut > inc.cut) {
      const stable = buildMessageBody(raw.slice(inc.cut, cut));
      inc.count += stable.childNodes.length;
      inc.cut = cut;
      inc.prefix = raw.slice(0, cut);
      body.appendChild(stable);
      hydrateChatImages(bubble);
    }
    if (raw.length > inc.cut) body.appendChild(buildMessageBody(raw.slice(inc.cut)));
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
  let nextUserIndex = 0;
  let historyStart = 0;
  let historyUserStart = 0;
  let historyRequest = 0;
  let loadingHistory = false;
  let continueSentAfterLimit = false;
  function hasQueuedContinue(agent) {
    return continueSentAfterLimit || turnQueue.some(turn => /^\s*continue\s*[.!]?\s*$/i.test(turn.text)) || schedulerTasks.some(task => task.chatId === currentChatId && task.model === agent && ['pending', 'dispatched', 'interrupted'].includes(task.status) && /^\s*continue\s*[.!]?\s*$/i.test(task.prompt));
  }
  function offerContinueAtReset(host) {
    const agent = turnRoutedAgent || lastReplyAgent(); // routing can be missed (reload mid-turn): the reply's own label
    if (!host || !AGENT_IDS.includes(agent) || hasQueuedContinue(agent) || host.querySelector('.continue-at-reset')) return;
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
    });
    host.append(btn);
  }

  function endAssistantTurn(at = new Date().toISOString()) {
    for (const bubble of turnBubbles) hydrateChatImages(bubble);
    const last = turnBubbles[turnBubbles.length - 1];
    if (last && !last.querySelector('.msg-actions')) last.append(messageActions(at, () => last.dataset.raw.trim(), []));
    const limitHit = limitHitThisTurn || isLimitNotice(last?.dataset.raw);
    const replied = turnRoutedAgent || lastReplyAgent();
    if (!restoringHistory && limitHit) continueSentAfterLimit = false;
    // Only when there is something to continue (the turn was cut off by the limit) and a reason to
    // wait: the usage display doesn't show headroom for that provider.
    // A notice that names its own reset time (agy: "Resets in 4h43m") beats the rail, which reads a different pool for Claude and GPT through agy.
    if (!restoringHistory && limitHit && (limitActive(last?.dataset.raw) ?? !hasHeadroom(replied))) offerContinueAtReset(last || turnHost());
    // The model's own answer is the freshest word on its usage: a limit reply turns scheduling on, a normal one off.
    const repliedLabel = turnModelLabel || [...transcriptEl.querySelectorAll('.msg-role[data-model-label]')].pop()?.dataset.modelLabel || null;
    const repliedModelId = replied === 'gemini' ? (modelIdForLabel(replied, repliedLabel) || (activeAgent === 'gemini' ? activeModelId : null)) : null;
    if (!restoringHistory && AGENT_IDS.includes(replied)) {
      const scope = limitScope(replied, repliedModelId);
      if (limitHit) limitHitAgents.add(scope);
      else {
        limitHitAgents.delete(scope);
        if (scope === replied) for (const entry of [...limitHitAgents]) if (entry.startsWith(`${replied}:`)) limitHitAgents.delete(entry);
      }
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

  function workSummary(label, steps = [], { thoughtSteps = false, count = steps.length } = {}) {
    const block = document.createElement('details');
    block.className = `work-summary${steps.length ? '' : ' is-empty'}${thoughtSteps ? ' is-thought-steps' : ''}`;
    if (steps.length) block.dataset.stepCount = String(count);
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

  // Steps stay in order with the reply text: tool calls between thoughts or update_steps checklists
  // bundle into a collapsed "N steps" row when the next thought/checklist arrives; when reply text
  // arrives or the turn ends, the thoughts, checklists and their tool bundles fold into one summary.
  const TOOL_STEP = '.tool-card:not(.tool-todo), .approval-card, .question-card';
  const CHECKPOINT = '.thought-fold, .tool-todo';
  const STEP = '.tool-card, .thought-fold, .work-summary.is-thought-steps, .approval-card, .question-card';
  function foldToolSteps(host = turnHost()) {
    const steps = [];
    for (let el = host.lastElementChild; el; el = el.previousElementSibling) {
      if (el === pendingEl) continue;
      if (!el.matches(TOOL_STEP) || el.matches('.is-running')) break;
      steps.unshift(el);
    }
    const waiting = new Set(pendingCards.values());
    if (!steps.length || steps.some((el) => waiting.has(el))) return;
    const next = steps[steps.length - 1].nextElementSibling;
    host.insertBefore(workSummary(`${steps.length} step${steps.length === 1 ? '' : 's'}`, steps, { thoughtSteps: true }), next);
  }
  function foldSteps(host = turnHost()) {
    const steps = [];
    for (let el = host.lastElementChild; el; el = el.previousElementSibling) {
      if (el === pendingEl) continue;
      if (!el.matches(STEP) || el.matches('.is-running, .is-live')) break;
      steps.unshift(el);
    }
    // A card still waiting on your click never folds away.
    const waiting = new Set(pendingCards.values());
    if (!steps.length || steps.some((el) => waiting.has(el))) return;
    // When earlier thoughts/checklists already bundled their tools, bundle trailing tools after the last one too.
    const hasThoughtGroups = steps.some((el) => el.matches('.work-summary.is-thought-steps'));
    const lastCheckpointIndex = steps.findLastIndex((el) => el.matches(CHECKPOINT));
    if (hasThoughtGroups && lastCheckpointIndex >= 0 && lastCheckpointIndex < steps.length - 1) {
      const trailing = steps.slice(lastCheckpointIndex + 1);
      if (trailing.every((el) => el.matches(TOOL_STEP))) {
        const bundle = workSummary(`${trailing.length} step${trailing.length === 1 ? '' : 's'}`, trailing, { thoughtSteps: true });
        steps.splice(lastCheckpointIndex + 1, trailing.length, bundle);
      }
    }
    for (const el of steps) {
      if (el.matches(CHECKPOINT) && el.open) {
        el.open = false;
        el.classList.remove('is-closing');
        const body = el.querySelector('.thought-body, .tool-body');
        if (body) body.style.maxHeight = '';
      }
    }
    const total = steps.reduce((sum, el) => sum + (el.matches('.work-summary.is-thought-steps') ? (Number(el.dataset.stepCount) || 1) : 1), 0);
    const next = steps[steps.length - 1].nextElementSibling;
    host.insertBefore(workSummary(`${total} step${total === 1 ? '' : 's'}`, steps, { count: total }), next);
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
    if (ms > 0) {
      const role = anchor.parentElement?.querySelector(':scope > .msg-role');
      (role || anchor).after(workSummary(`Worked for ${formatDuration(ms)}`));
    }
  }

  // Tool cards, matched to their result by toolId (Claude tool_use id, Codex
  // item id, agy step) so parallel or interleaved tools never cross wires.
  const toolCards = new Map();
  const SHELL_TOOLS = /^(bash|powershell|shell|run_command|command_execution|(?:read|write|list)_(?:bash|powershell))$/i;
  const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|write_to_file|write_file|(multi_)?replace_file_content|file_change|edit_file|create_file)$/i;
  const READ_TOOLS = /^(read|view_file|view|list_dir|view_content|read_file)$/i;
  const SEARCH_TOOLS = /^(glob|grep|grep_search|find_by_name|search_in_file|find_file)$/i;
  const WEB_TOOLS = /^(web_?(fetch|search)|search_?web|read_?url_?content|read_?browser_?page|browser_?page)$/i;
  const TASK_TOOLS = /^(manage_?task)$/i;
  const AGENT_TOOLS = /^(agent|task|invoke_?subagent|manage_?subagents|define_?subagent)$/i;

  // Classify at render time so saved chats and the agents viewer get the same cards.
  // Claude has Skill/Read; Codex reads through its shell; Antigravity uses view_file.
  function loadedSkillNames(name, command = '') {
    if (/^(skill|load[ _-]?skill)$/i.test(name)) return command ? [command] : [];
    let reads = [];
    if (/^(read|view_file|read_file|view_content)$/i.test(name)) reads = [command];
    else if (SHELL_TOOLS.test(name)) {
      const shell = command.replace(/^.*?\s-(?:Command|c|lc)\s+(['"])([\s\S]*)\1\s*$/i, '$2');
      reads = [...shell.matchAll(/(?:^|[;&|\n])\s*(?:Get-Content|cat|head|tail|more|type|sed\s+-n)\s+([^;&|\n]*)/gi)].map(match => match[1]);
    }
    const skills = reads.flatMap(read => [...read.replace(/\\+/g, '/').matchAll(/(?:^|\/)([^/"'\r\n*?<>|;]+)\/SKILL\.md(?=$|[\s"'`,)])/gi)].map(match => match[1].trim()));
    if (!skills.length && reads.some(read => /^SKILL\.md$/i.test(read.trim()))) skills.push('SKILL.md');
    return [...new Set(skills)];
  }

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
    ['question', /^(ask_?question|ask_?user(?:_?question)?|ask_?followup_?question)$/i],
    ['todo', /^(todowrite|task(create|update|list|get)|update_plan|update_?steps)$/i],
    ['plan', /^(enter|exit)planmode$/i],
    ['skill', /^(skill|load[ _-]?skill)$/i],
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

    if (kind === 'skill') return 'Load Skill';
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
    if (kind === 'question') return 'Question';
    if (/^(schedule|schedulewakeup|croncreate|crondelete|cronlist)$/i.test(clean)) return 'Schedule';
    if (/^(grepsearch|searchinfile|grep)$/i.test(clean)) return 'Grep';
    if (/^(findbyname|findfile|glob)$/i.test(clean)) return 'Glob';
    if (/^(todowrite|taskcreate|taskupdate|tasklist|taskget|updateplan)$/i.test(clean)) return 'Todo';
    if (/^(enterplanmode|exitplanmode)$/i.test(clean)) return 'Plan';
    if (/^(monitor|bashoutput|taskoutput)$/i.test(clean)) return 'Monitor';
    if (/^(taskstop|killshell|killbash)$/i.test(clean)) return 'Stop';
    if (/^(enterworktree|exitworktree)$/i.test(clean)) return 'Worktree';
    if (/^(remotetrigger)$/i.test(clean)) return 'Remote';
    if (/^mcp__/i.test(raw)) return raw.slice(5).replace('__', ' · ');
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
  // A tool that only waits: a Monitor/TaskOutput poll, or a shell that is just a sleep. Returns the seconds a leading
  // `sleep N` promises (0 when unknown), or null when the tool does real work.
  function waitSeconds(kind, command) {
    const shell = String(command || '').replace(/^.*?\s-(?:Command|c|lc)\s+(['"])([\s\S]*)\1\s*$/i, '$2');
    const sleep = shell.match(/^\s*(?:sleep|start-sleep)\s+(?:-s(?:econds)?\s+)?(\d+(?:\.\d+)?)\s*([smh]?)\s*(?:;|$)/i);
    if (kind !== 'monitor' && !(sleep && !shell.slice(sleep[0].length).trim())) return null;
    return sleep ? Math.round(Number(sleep[1]) * { s: 1, m: 60, h: 3600 }[sleep[2].toLowerCase() || 's']) : 0;
  }
  // What a tool card can show or open (tool-targets.js): a viewed picture previews in the lightbox, a read or edited file
  // opens in the editor, a fetched page in the browser, and the paths in a Grep or Glob result open on click.
  const PEEK_ICONS = {
    image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 8S4.25 3.5 8 3.5 14.25 8 14.25 8 11.75 12.5 8 12.5 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="2"/></svg>',
    file: OPEN_ICON,
    url: OPEN_ICON,
  };
  const PEEK_TITLES = { image: 'Preview picture', file: 'Open in editor', url: 'Open in browser' };
  const previewCache = new Map(); // path -> the host's reply, so a second look is instant
  const previewWaiting = new Map(); // requestId -> resolve
  let previewSeq = 0;
  const baseName = (file) => String(file).split(/[\\/]/).pop();
  function loadPreview(file) {
    if (previewCache.has(file)) return Promise.resolve(previewCache.get(file));
    return new Promise((resolve) => {
      const requestId = `peek-${++previewSeq}`;
      const timer = setTimeout(() => { previewWaiting.delete(requestId); resolve({ error: 'The preview took too long' }); }, 15000);
      previewWaiting.set(requestId, (reply) => {
        clearTimeout(timer);
        if (!reply.error) { previewCache.set(file, reply); if (previewCache.size > 20) previewCache.delete(previewCache.keys().next().value); }
        resolve(reply);
      });
      vscode.postMessage({ type: 'previewFile', path: file, requestId });
    });
  }
  function peek(target, trigger = null) {
    if (!target) return;
    if (target.type === 'url') { vscode.postMessage({ type: 'openUrl', url: target.value }); return; }
    if (target.type === 'file') { vscode.postMessage({ type: 'openFile', path: target.value, line: target.line }); return; }
    trigger?.classList.add('is-loading');
    void loadPreview(target.value).then((reply) => {
      trigger?.classList.remove('is-loading');
      if (reply.error) { showToast(`${reply.error}: ${baseName(target.value)}`, { error: true }); return; }
      openLightbox(reply.uri, reply.name || baseName(target.value), false, { uri: reply.uri, name: reply.name }, null, { openPath: reply.path });
    });
  }
  // Grep and Glob results: each line that names a file opens it (at its line), a picture previews.
  function linkifyResults(body, text) {
    const targets = window.toolTargets?.resultTargets(text) || [];
    if (!targets.some(Boolean)) return;
    const lines = text.split('\n');
    const nodes = [];
    lines.forEach((line, index) => {
      const target = targets[index];
      if (target) {
        const hit = document.createElement('span');
        hit.className = 'tool-hit'; hit.dataset.i = String(index); hit.textContent = line;
        hit.setAttribute('role', 'button'); hit.tabIndex = 0; hit.title = PEEK_TITLES[target.type];
        nodes.push(hit);
      } else nodes.push(document.createTextNode(line));
      if (index < lines.length - 1) nodes.push(document.createTextNode('\n'));
    });
    body.replaceChildren(...nodes);
    const open = (event) => {
      const hit = event.target.closest?.('.tool-hit');
      if (!hit) return;
      event.preventDefault();
      peek(targets[Number(hit.dataset.i)], hit);
    };
    body.addEventListener('click', open);
    body.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(event); });
  }
  // ---------- Tool output views ----------
  // A card's raw output becomes a view that suits the tool (shapes are read by media/tool-format.js): a file read is code
  // with a line-number gutter and the editor's colours; Grep matches group by file; Glob is a file list; WebSearch is a
  // link list; shell output keeps its terminal colours under the command; edits are coloured diffs. Wide lines scroll
  // sideways instead of wrapping (a wrap button flips that), and the expand button opens the same view large.
  // Views are built when a card first opens, so hundreds of closed steps cost nothing.
  const toolRawOutput = new WeakMap(); // card -> its output text, kept once a view has replaced the body's own text
  const toolInfo = new WeakMap(); // card -> { name, kind, command, diffLines }
  const TV_ROWS = 1200; // rows drawn at once; the rest is one click away
  const TV_ICONS = {
    wrap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h8.25a2.25 2.25 0 0 1 0 4.5H8.5"/><path d="m10 11 -1.75 1.5L10 14M2.5 12h2.5"/></svg>',
    expand: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/></svg>',
    file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.75h5l3.5 3.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1z"/><path d="M9 1.75v3.5h3.5"/></svg>',
    image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="5.75" cy="5.75" r="1.1"/><path d="m13.5 11-3.5-3.5-5.5 5.5"/></svg>',
    link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><ellipse cx="8" cy="8" rx="2.4" ry="5.5"/><path d="M2.5 8h11"/></svg>',
  };
  const rawToolOutput = (card) => toolRawOutput.get(card) ?? card.querySelector('.tool-body')?.textContent ?? '';
  const tvEl = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };

  function tvButton(title, icon, onClick) {
    const button = tvEl('button', 'tv-btn');
    button.type = 'button'; button.title = title; button.setAttribute('aria-label', title); button.innerHTML = icon;
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); onClick(button); });
    return button;
  }

  // Code-like rows: [{ n | label, text | segments, kind, gap }] -> a sideways-scrolling block with a sticky gutter.
  // `lang` colours the text through Shiki; rows keep their own kind tint (diff add/del, grep context, log tone).
  function tvRows(rows, { lang = '', gutter = true, scroll = true } = {}) {
    const holder = tvEl('div', `tv-scroll${gutter ? '' : ' no-gutter'}${scroll ? '' : ' is-flat'}`);
    const list = tvEl('div', 'tv-rows');
    holder.append(list);
    const widest = rows.reduce((max, row) => Math.max(max, String(row.n ?? row.label ?? '').length), 0);
    list.style.setProperty('--tv-nw', `${Math.max(widest, 2)}ch`);
    const cells = []; // { el, index }: where each real line's colours go
    let codeIndex = 0;
    for (const row of rows) if (!row.gap) row.index = codeIndex++;
    const draw = (batch) => {
      const frag = document.createDocumentFragment();
      for (const row of batch) {
        const line = tvEl('div', `tv-row${row.gap ? ' is-gap' : ''}${row.kind ? ` is-${row.kind}` : ''}`);
        if (row.target) { line.dataset.line = String(row.n); line.classList.add('is-link'); }
        if (gutter) line.append(tvEl('span', 'tv-n', row.gap ? '⋮' : String(row.label ?? row.n ?? '')));
        const cell = tvEl('span', 'tv-c');
        if (row.segments) for (const seg of row.segments) { if (seg.cls) cell.append(Object.assign(tvEl('span', seg.cls), { textContent: seg.text })); else cell.append(seg.text); }
        else cell.textContent = row.gap ? '' : (row.text || '');
        line.append(cell);
        if (!row.gap) cells.push({ el: cell, index: row.index, text: row.text });
        frag.append(line);
      }
      return frag;
    };
    list.append(draw(rows.slice(0, TV_ROWS)));
    const paint = () => {
      if (!lang) return;
      const html = highlightHtml(rows.filter((row) => !row.gap).map((row) => row.text).join('\n'), lang, true);
      if (!html) return;
      const parts = html.split('\n');
      for (const cell of cells) if (parts[cell.index] !== undefined && cell.el.textContent === cell.text) cell.el.innerHTML = parts[cell.index];
    };
    if (rows.length > TV_ROWS) {
      const more = tvEl('button', 'tv-more', `Show ${rows.length - TV_ROWS} more lines`);
      more.type = 'button';
      more.addEventListener('click', () => { more.remove(); list.append(draw(rows.slice(TV_ROWS))); paint(); });
      list.after(more);
    }
    return { el: holder, paint };
  }

  // The frame every view sits in: a slim bar (what it is, how big; wrap / copy / expand) over the content.
  function tvFrame({ left = [], content, painters = [], copy = '', wrap = false, expand = null, className = '' }) {
    const frame = tvEl('div', `tv${wrap ? ' is-wrap' : ''}${className ? ` ${className}` : ''}`);
    const bar = tvEl('div', 'tv-bar');
    const info = tvEl('div', 'tv-bar-left');
    for (const part of left) info.append(part);
    const actions = tvEl('div', 'tv-actions');
    const wrapButton = tvButton('Wrap long lines', TV_ICONS.wrap, (button) => { frame.classList.toggle('is-wrap'); button.classList.toggle('is-on', frame.classList.contains('is-wrap')); });
    wrapButton.classList.toggle('is-on', wrap);
    actions.append(wrapButton);
    if (copy) actions.append(tvButton('Copy', COPY_ICON, (button) => {
      void navigator.clipboard?.writeText(copy).then(() => {
        button.innerHTML = CHECK_ICON; button.title = 'Copied';
        setTimeout(() => { button.innerHTML = COPY_ICON; button.title = 'Copy'; }, 1400);
      }).catch(() => {});
    }));
    if (expand) actions.append(tvButton('View larger', TV_ICONS.expand, expand));
    bar.append(info, actions);
    frame.append(bar, ...(Array.isArray(content) ? content : [content]));
    if (painters.length) {
      frame.paint = () => painters.forEach((paint) => paint());
      toolViews.add(frame);
      if (highlighter && editorThemeName) frame.paint();
      else void ensureHighlighter().then(() => { if (frame.isConnected) frame.paint(); });
    }
    return frame;
  }
  const tvChip = (text, cls = '') => tvEl('span', `tv-chip${cls ? ` ${cls}` : ''}`, text);
  const tvLabel = (text) => tvEl('span', 'tv-label', text);
  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
  const langLabel = (lang) => ({ javascript: 'JS', typescript: 'TS', powershell: 'PowerShell', bash: 'Shell', markdown: 'MD', bat: 'Batch' }[lang] || lang.toUpperCase());

  function tvNote(lines) {
    const note = tvEl('div', 'tv-note', lines.join('\n').trim());
    return note.textContent ? note : null;
  }

  function viewRead(info, parsed, big, expand) {
    const lang = window.toolFormat.langFor(info.command);
    const rows = tvRows(parsed.rows, { lang });
    const first = parsed.rows[0].n, last = parsed.rows[parsed.rows.length - 1].n;
    const range = first === 1 ? plural(parsed.rows.length, 'line') : `lines ${first}–${last}`;
    const notes = tvNote([...parsed.head, ...parsed.tail]);
    return tvFrame({ left: [...(lang ? [tvChip(langLabel(lang))] : []), tvLabel(range)], content: [rows.el, ...(notes ? [notes] : [])], painters: [rows.paint], copy: parsed.rows.map((row) => row.text).join('\n'), expand: big ? null : expand });
  }

  function viewDiff(info, big, expand) {
    const lang = window.toolFormat.langFor(info.command);
    const sign = { '+': '+', '-': '−' };
    const rows = tvRows(info.diffLines.map((line) => ({ label: sign[line[0]] || '', text: line.slice(1), kind: line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : '' })), { lang });
    const add = info.diffLines.filter((line) => line[0] === '+').length, del = info.diffLines.filter((line) => line[0] === '-').length;
    const stat = tvEl('span', 'tv-label');
    stat.append(Object.assign(tvEl('span', 'diff-add'), { textContent: `+${add}` }), ' ', Object.assign(tvEl('span', 'diff-del'), { textContent: `−${del}` }));
    return tvFrame({ left: [...(lang ? [tvChip(langLabel(lang))] : []), stat], content: rows.el, painters: [rows.paint], copy: info.diffLines.join('\n'), expand: big ? null : expand });
  }

  // path:line:text matches, grouped under their file; a file header or a line number opens the editor there.
  function viewGrep(info, grep, big, expand) {
    const groups = tvEl('div', 'tv-groups');
    const painters = [];
    for (const group of grep.groups) {
      const { name, dir } = window.toolFormat.splitPath(group.file);
      const head = tvEl('button', 'tv-file');
      head.type = 'button'; head.dataset.path = group.file; head.title = `Open ${group.file}`;
      head.append(tvEl('span', 'tv-file-icon'), tvEl('span', 'tv-file-name', name), tvEl('span', 'tv-file-dir', dir), tvEl('span', 'tv-file-count', String(group.rows.filter((row) => !row.gap && !row.context).length)));
      head.firstChild.innerHTML = TV_ICONS.file;
      const lang = window.toolFormat.langFor(group.file);
      const rows = tvRows(group.rows.map((row) => row.gap ? { gap: true } : { n: row.n, text: row.text, kind: row.context ? 'ctx' : '', target: true }), { lang, scroll: false });
      rows.el.dataset.path = group.file;
      painters.push(rows.paint);
      groups.append(head, rows.el);
    }
    const open = (event) => {
      const row = event.target.closest?.('.tv-row[data-line]');
      const file = event.target.closest?.('.tv-file');
      if (row) peek({ type: 'file', value: row.closest('[data-path]').dataset.path, line: Number(row.dataset.line) });
      else if (file) peek({ type: 'file', value: file.dataset.path });
    };
    groups.addEventListener('click', open);
    const left = [tvLabel(`${plural(grep.hits, 'match', 'matches')} in ${plural(grep.files, 'file')}`)];
    const notes = tvNote(grep.loose);
    const copy = grep.groups.flatMap((group) => group.rows.filter((row) => !row.gap).map((row) => `${group.file}:${row.n}:${row.text}`)).join('\n');
    return tvFrame({ left, content: [groups, ...(notes ? [notes] : [])], painters, copy, expand: big ? null : expand });
  }

  function viewList(list, big, expand) {
    const box = tvEl('div', 'tv-list');
    const shown = list.items.slice(0, TV_ROWS);
    const draw = (items) => {
      for (const item of items) {
        const { name, dir } = window.toolFormat.splitPath(item.line);
        const row = tvEl('button', 'tv-item');
        row.type = 'button'; row.title = item.line;
        row.append(Object.assign(tvEl('span', 'tv-file-icon'), { innerHTML: TV_ICONS[item.target.type] || TV_ICONS.file }), tvEl('span', 'tv-file-name', name), tvEl('span', 'tv-file-dir', dir));
        row.addEventListener('click', () => peek(item.target, row));
        box.append(row);
      }
    };
    draw(shown);
    if (list.items.length > TV_ROWS) {
      const more = tvEl('button', 'tv-more', `Show ${list.items.length - TV_ROWS} more files`);
      more.type = 'button';
      more.addEventListener('click', () => { more.remove(); draw(list.items.slice(TV_ROWS)); });
      box.append(more);
    }
    const notes = tvNote(list.tail);
    const holder = tvEl('div', 'tv-scroll is-flat');
    holder.append(box);
    return tvFrame({ left: [tvLabel(plural(list.items.length, 'file'))], content: [holder, ...(notes ? [notes] : [])], copy: list.items.map((item) => item.line).join('\n'), expand: big ? null : expand });
  }

  function viewSearch(info, search) {
    const links = tvEl('div', 'tv-list');
    for (const link of search.links) {
      const row = tvEl('button', 'tv-item tv-link');
      row.type = 'button'; row.title = link.url;
      row.append(Object.assign(tvEl('span', 'tv-file-icon'), { innerHTML: TV_ICONS.link }), tvEl('span', 'tv-file-name', link.title), tvEl('span', 'tv-file-dir', window.toolFormat.hostOf(link.url)));
      row.addEventListener('click', () => peek({ type: 'url', value: link.url }));
      links.append(row);
    }
    const content = [links];
    if (search.summary) { const summary = tvEl('div', 'tv-md msg-body'); summary.append(buildMessageBody(search.summary)); content.push(summary); }
    return tvFrame({ left: [tvLabel(search.query ? `“${search.query}”` : 'Search'), tvLabel(plural(search.links.length, 'result'))], content, copy: `${search.links.map((link) => `${link.title}\n${link.url}`).join('\n')}\n\n${search.summary}`.trim(), wrap: true });
  }

  function viewMarkdown(text) {
    const md = tvEl('div', 'tv-md msg-body');
    md.append(buildMessageBody(text.trim()));
    return tvFrame({ left: [tvLabel('Result')], content: md, copy: text.trim(), wrap: true });
  }

  // The command as typed (highlighted, under a prompt), then its output with terminal colours kept.
  function viewShell(info, text, running, failed, big, expand) {
    const format = window.toolFormat;
    const { script, lang } = format.unwrapCommand(info.name, info.command);
    const scriptLines = String(script).replace(/\r\n/g, '\n').split('\n');
    const command = tvRows(scriptLines.map((line, index) => ({ label: index ? '' : (lang === 'powershell' ? 'PS' : '$'), text: line })), { lang });
    command.el.classList.add('tv-cmd');
    const painters = [command.paint];
    const content = [command.el];
    let outputRows = null, outputLang = '';
    if (text.trim()) {
      const body = format.hasAnsi(text) ? format.parseAnsi(text) : null;
      let lines = body ? null : text.replace(/\n+$/, '').split('\n');
      if (body) { while (body.length > 1 && !body[body.length - 1].length) body.pop(); }
      if (body) outputRows = body.map((segments) => { const line = segments.map((seg) => seg.text).join(''); return { segments, text: line, kind: segments.some((seg) => seg.cls) ? '' : format.lineTone(line) }; }); // coloured lines keep their own colours
      else if (format.looksLikeJson(text)) {
        outputLang = 'json';
        let pretty = text.trim();
        if (!pretty.includes('\n')) { try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* keep it as it came */ } }
        lines = pretty.split('\n');
        outputRows = lines.map((line) => ({ text: line }));
      } else if (format.looksLikeDiff(text)) outputRows = lines.map((line) => ({ text: line, kind: format.diffTone(line) }));
      else outputRows = lines.map((line) => ({ text: line, kind: format.lineTone(line) }));
      const out = tvRows(outputRows, { lang: outputLang, gutter: false });
      out.el.classList.add('tv-out');
      content.push(out.el); painters.push(out.paint);
    } else if (!running) content.push(tvEl('div', 'tv-note', 'No output'));
    else content.push(tvEl('div', 'tv-note is-running', 'Running…'));
    const count = outputRows ? outputRows.length : 0;
    const left = [tvChip(lang === 'powershell' ? 'PowerShell' : 'Shell'), ...(failed ? [tvChip('Failed', 'is-error')] : []), ...(count ? [tvLabel(plural(count, 'line'))] : [])];
    return tvFrame({ left, content, painters, copy: text.trim() ? (outputRows || []).map((row) => row.text).join('\n') : script, expand: big ? null : expand, className: 'tv-shell' });
  }

  function viewJson(text, big, expand) {
    let pretty = text.trim();
    try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* shown as it came */ }
    const rows = tvRows(pretty.split('\n').map((line, index) => ({ n: index + 1, text: line })), { lang: 'json' });
    return tvFrame({ left: [tvChip('JSON')], content: rows.el, painters: [rows.paint], copy: pretty, expand: big ? null : expand });
  }

  const TODO_STATE_ICONS = {
    done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke-width="1.3" opacity="0.45"/><path d="m5.4 8.2 1.8 1.8 3.5-3.8"/></svg>',
    active: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4" opacity="0.4"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>',
    pending: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.3"/></svg>',
  };

  function viewChecklist(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;
    const list = document.createElement('ul');
    list.className = 'todo-steps';
    lines.forEach((raw, index) => {
      let state = 'pending';
      let title = raw;
      if (/^(?:✓|✔|☑|\[x\]|-\s*\[x\])\s*/i.test(raw)) {
        state = 'done';
        title = raw.replace(/^(?:✓|✔|☑|\[x\]|-\s*\[x\])\s*/i, '');
      } else if (/^(?:▸|▶|►|→|•|\[-\]|-\s*\[-\])\s*/.test(raw)) {
        state = 'active';
        title = raw.replace(/^(?:▸|▶|►|→|•|\[-\]|-\s*\[-\])\s*/, '');
      } else if (/^(?:○|◯|☐|\[ \]|-\s*\[ \])\s*/.test(raw)) {
        state = 'pending';
        title = raw.replace(/^(?:○|◯|☐|\[ \]|-\s*\[ \])\s*/, '');
      }
      const item = document.createElement('li');
      item.className = `todo-step is-${state}`;
      const mark = document.createElement('span');
      mark.className = 'todo-step-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = TODO_STATE_ICONS[state];
      const num = document.createElement('span');
      num.className = 'todo-step-num';
      num.textContent = `${index + 1}.`;
      const label = document.createElement('span');
      label.className = 'todo-step-text';
      label.textContent = title || raw;
      item.append(mark, num, label);
      list.append(item);
    });
    return list;
  }

  // The view for one card, or null to leave its plain text. `big` is the expanded copy in the viewer.
  function buildToolView(card, big = false) {
    const info = toolInfo.get(card);
    if (!info || !window.toolFormat) return null;
    const expand = () => openToolViewer(card);
    if (info.diffLines) return viewDiff(info, big, expand);
    const text = window.toolFormat.normalize(rawToolOutput(card));
    const running = card.classList.contains('is-running'), failed = card.classList.contains('is-error');
    if (info.kind === 'shell') return viewShell(info, text, running, failed, big, expand);
    if (!text.trim()) return null;
    if (!failed && info.kind === 'todo') return viewChecklist(text);
    const format = window.toolFormat;
    const display = toolDisplayName(info.name, info.kind);
    if (info.kind === 'read') { const parsed = format.parseNumbered(text); if (parsed) return viewRead(info, parsed, big, expand); }
    if (display === 'Grep') { const grep = format.parseGrep(text); if (grep) return viewGrep(info, grep, big, expand); }
    if (display === 'Grep' || display === 'Glob' || info.kind === 'read') { const list = format.parseFileList(text); if (list) return viewList(list, big, expand); }
    if (!failed && info.kind === 'web') { const search = format.parseSearch(text); return search ? viewSearch(info, search) : viewMarkdown(text); }
    if (!failed && info.kind === 'agent') return viewMarkdown(text);
    if (!failed && format.looksLikeJson(text)) return viewJson(text, big, expand);
    return null;
  }

  const lazyToolOutputs = new WeakMap(); // card -> { index, toolId, length, requested }
  const lazyById = new Map(); // `${chatId}:${index}` -> card, while the host is answering
  // True while the card's full output is still on its way (the preview stays in view until it lands).
  function requestFullOutput(card) {
    const lazy = lazyToolOutputs.get(card);
    if (!lazy) return false;
    if (!lazy.requested) {
      lazy.requested = true;
      lazyById.set(`${currentChatId}:${lazy.index}`, card);
      card.classList.add('is-loading-output');
      vscode.postMessage({ type: 'requestToolOutput', chatId: currentChatId, index: lazy.index, toolId: lazy.toolId });
    }
    return true;
  }
  function receiveToolOutput(message) {
    const card = lazyById.get(`${message.chatId}:${message.index}`);
    lazyById.delete(`${message.chatId}:${message.index}`);
    if (!card) return;
    card.classList.remove('is-loading-output');
    const lazy = lazyToolOutputs.get(card);
    if (typeof message.text !== 'string') { if (lazy) lazy.requested = false; return; } // opening it again asks again
    lazyToolOutputs.delete(card); card.classList.remove('is-lazy');
    resetToolView(card, message.text); // draws the view when the card is open
  }
  function ensureToolView(card) {
    if (card.dataset.view === '1') return;
    const info = toolInfo.get(card), body = card.querySelector('.tool-body');
    if (!info || !body) return;
    if (card.classList.contains('is-running') && info.kind !== 'shell' && !rawToolOutput(card)) return; // nothing to show yet
    const raw = rawToolOutput(card);
    const view = buildToolView(card);
    card.dataset.view = '1';
    if (!view) return;
    toolRawOutput.set(card, raw);
    body.classList.add('has-view');
    body.replaceChildren(view);
  }
  // A card whose output changed (a finished step, a rerun) forgets its view and draws again if it is open.
  function resetToolView(card, text) {
    const body = card.querySelector('.tool-body');
    delete card.dataset.view;
    toolRawOutput.delete(card);
    if (!body) return;
    body.classList.remove('has-view');
    body.textContent = text;
    if (card.open) ensureToolView(card);
  }

  function openToolViewer(card) {
    const info = toolInfo.get(card);
    const view = buildToolView(card, true);
    if (!view || !info) return;
    view.classList.add('is-big');
    const isFile = (info.kind === 'read' || info.kind === 'edit') && window.toolTargets?.cardTarget(info.kind, info.command)?.type === 'file';
    const caption = isFile ? baseName(info.command) : card.querySelector('.tool-label')?.textContent?.slice(0, 120) || toolDisplayName(info.name, info.kind);
    openLightbox('', caption, false, isFile ? { name: caption, path: info.command } : { name: caption }, null, { viewer: { element: view, dispose() { toolViews.delete(view); } }, className: 'is-code', noDownload: true });
  }

  // `host`: where the card goes (the agents viewer passes its own pane); default, the running turn.
  function appendToolCard({ name, command, intent = '', output, toolId, done, error, diff, cancelled, startedAt, durationMs, host = null }) {
    if (!host) clearEmptyState();
    const skills = loadedSkillNames(name, command || '');
    const kind = skills.length ? 'skill' : toolKind(name);
    if (kind === 'stop') command = window.toolFormat?.stopTarget?.(output?.text, command) || command || '';
    // An edit's own "-"/"+" lines become its body and its +N -N count.
    const diffLines = kind === 'edit' && diff ? diff.split('\n') : null;
    if (diffLines) output = { ...output, added: diffLines.filter((l) => l[0] === '+').length, removed: diffLines.filter((l) => l[0] === '-').length };
    const details = document.createElement('details');
    toolInfo.set(details, { name, kind, command: command || '', diffLines });
    details.className = `tool-card tool-${kind}${done ? '' : ' is-running'}${error ? ' is-error' : ''}${cancelled ? ' is-cancelled' : ''}`;
    if (cancelled) details.title = 'Interrupted before a result was saved';
    const startMs = Number.isFinite(Number(startedAt)) && Number(startedAt) > 0 ? Number(startedAt) : Date.now();
    if (!done) details.dataset.startedAt = String(startMs);
    const wait = done || host ? null : waitSeconds(kind, command);
    if (wait !== null) {
      details.dataset.waitStart = String(startMs);
      if (wait) details.dataset.waitSecs = String(wait);
    }

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
    } else if (intent && (kind === 'shell' || kind === 'other') && !skills.length) {
      // Gemini says in its own words what a step is for. That is the row; the command itself is the first thing inside the card.
      label.textContent = intent;
      label.title = `${intent}\n\n${command || ''}`.trim();
      details.classList.add('has-summary');
    } else {
      label.textContent = skills.length ? skills.join(', ') : command || '';
    }
    // Clicking the name (or the small icon beside it) shows what the agent is looking at; the rest of the row still folds the card.
    const target = window.toolTargets?.cardTarget(kind, command) || null;
    let peekButton = null;
    if (target) {
      details.dataset.peek = target.type;
      const hit = label.querySelector('.tool-file');
      if (hit) hit.classList.add('tool-hit');
      else { const link = document.createElement('span'); link.className = 'tool-hit'; link.textContent = label.textContent; label.replaceChildren(link); }
      label.title = `${PEEK_TITLES[target.type]}: ${command}`;
      peekButton = document.createElement('button');
      peekButton.type = 'button';
      peekButton.className = 'tool-peek';
      peekButton.title = PEEK_TITLES[target.type];
      peekButton.setAttribute('aria-label', `${PEEK_TITLES[target.type]}: ${command}`);
      peekButton.innerHTML = PEEK_ICONS[target.type];
      const act = (event) => { event.preventDefault(); event.stopPropagation(); peek(target, details); };
      peekButton.addEventListener('click', act);
      label.addEventListener('click', (event) => { if (event.target.closest('.tool-hit')) act(event); });
    }
    const meta = document.createElement('span');
    meta.className = 'tool-meta';
    const time = document.createElement('span');
    time.className = 'tool-time';
    const initialMs = done ? Number(durationMs) : Date.now() - startMs;
    if (Number.isFinite(initialMs) && initialMs >= 1000) time.textContent = formatDuration(initialMs);
    const state = document.createElement('span');
    state.className = 'tool-state';
    summary.append(icon, tool, label, ...(peekButton ? [peekButton] : []), meta, time, state);

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
    if (kind === 'skill' && SHELL_TOOLS.test(name) && !host) {
      const full = document.createElement('div');
      full.className = 'agents-tool-command';
      full.textContent = command;
      details.appendChild(full);
    }
    if (details.classList.contains('has-summary') && command && kind !== 'shell') { // a shell card's own view starts with `$ command`
      const full = document.createElement('div');
      full.className = 'agents-tool-command';
      full.textContent = command;
      details.appendChild(full);
    }
    if (diffLines) details.dataset.diff = '1'; // the diff is drawn when the card opens (ensureToolView)
    else body.textContent = (output && output.text) || '';
    // A long output arrives as a preview; the rest is fetched when the card opens (see 'toolOutput').
    if (output?.lazy && !diffLines) { lazyToolOutputs.set(details, output.lazy); details.classList.add('is-lazy'); }
    details.appendChild(body);
    details.addEventListener('toggle', () => { if (details.open && !requestFullOutput(details)) ensureToolView(details); });
    // A picture shows itself when the card opens, so you see what the agent saw without another click.
    if (target?.type === 'image') {
      details.addEventListener('toggle', () => {
        if (!details.open || details.querySelector('.tool-thumb, .tool-thumb-note')) return;
        const thumb = document.createElement('button');
        thumb.type = 'button'; thumb.className = 'tool-thumb is-loading'; thumb.title = 'Preview picture';
        details.insertBefore(thumb, body);
        void loadPreview(target.value).then((reply) => {
          thumb.classList.remove('is-loading');
          if (reply.error) { thumb.replaceWith(Object.assign(document.createElement('div'), { className: 'tool-thumb-note', textContent: reply.error })); return; }
          const img = document.createElement('img'); img.src = reply.uri; img.alt = reply.name || ''; img.draggable = false;
          thumb.append(img);
          thumb.addEventListener('click', () => peek(target, thumb));
        });
      });
    }
    if (/^(Grep|Glob)$/.test(toolDisplayName(name, kind))) details.dataset.results = '1';
    if (host) { host.appendChild(details); return details; }
    turnHost().appendChild(details);
    if (toolId) toolCards.set(toolId, details);
    scrollTranscriptToEnd();
    return details;
  }
  function updateToolProgress(card, { output, sequence }) {
    if (!card?.classList.contains('is-running') || card.dataset.diff) return;
    const info = toolInfo.get(card);
    if (Number.isInteger(sequence)) {
      if (sequence <= (info.outputSequence ?? -1)) return;
      output = ((info.outputSequence == null ? '' : info.progressOutput) + output).slice(-16000);
      info.outputSequence = sequence;
    } else if (info.outputSequence != null) return; // Copilot sends both formats during migration.
    info.progressOutput = output;
    resetToolView(card, output);
  }

  function finishToolCard(card, { output, error, durationMs }) {
    if (!card) return;
    const startedAt = Number(card.dataset.startedAt);
    delete card.dataset.startedAt;
    const elapsed = Number.isFinite(Number(durationMs)) ? Number(durationMs) : (startedAt > 0 ? Date.now() - startedAt : 0);
    const time = card.querySelector('.tool-time');
    if (time) time.textContent = elapsed >= 1000 ? formatDuration(elapsed) : '';
    card.classList.remove('is-running');
    syncPending(); // a finished wait turns the Timer back into "Thinking"
    card.classList.toggle('is-error', Boolean(error));
    const body = card.querySelector('.tool-body');
    output ||= toolInfo.get(card)?.progressOutput;
    // TaskStop/KillShell returns the stopped command in its result; show it on the row once the step finishes.
    if (card.classList.contains('tool-stop')) {
      const info = toolInfo.get(card);
      const stopped = window.toolFormat?.stopTarget?.(output, info?.command || '');
      if (stopped) {
        if (info) info.command = stopped;
        const label = card.querySelector('.tool-label');
        if (label) { label.textContent = stopped; label.title = stopped; }
      }
    }
    // A diff card keeps its diff; only a failure replaces it with the reason.
    if (error && output && toolInfo.get(card)) toolInfo.get(card).diffLines = null;
    if (body && (!card.dataset.diff || (error && output))) resetToolView(card, output || '');
    // What came back, at a glance: lines read, results found.
    const meta = card.querySelector('.tool-meta');
    const lines = typeof output === 'string' && output.trim() && !/^No (matches|files) found/i.test(output.trim()) ? output.trim().split('\n').length : 0;
    if (meta && !error && lines && (card.classList.contains('tool-read') || card.classList.contains('tool-search'))) {
      meta.textContent = card.classList.contains('tool-read') ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : `${lines} ${lines === 1 ? 'result' : 'results'}`;
    }
    // A failure shows in the row (red, "Failed"); it opens by itself only if the user asked for that (Settings > General).
    // Active Update Steps checklists stay open (like the active thought) until the next thought, update_steps, reply text, or turn end.
    const keepOpen = openThought?.fold === card && card.open;
    card.open = keepOpen || Boolean(TOOL_PREFS.openFailed && error && output);
    if (card.open) ensureToolView(card);
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
    note.textContent = /selected model is at capacity/i.test(detail)
      ? 'The selected model is still at capacity after two automatic retries. Retry later or choose another model.'
      : 'The upstream service is unavailable after two automatic retries. Try again later.';
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
      dispatchTurn({ ...lastTurn, retry: true });
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
  function appendQuestionCard({ agent, actionId, questions, deferred = false, modelId, settled: storedSettlement }) {
    clearEmptyState();
    // A <details> like the tool steps: open while it waits, one summary row once answered, click to read it again.
    const card = document.createElement('details');
    card.className = 'question-card';
    card.open = true;
    card.dataset.actionId = actionId;
    card.dataset.deferred = String(deferred);
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
      if (deferred) {
        // The host settles the card and puts its answer ahead of queued work atomically.
        vscode.postMessage({ type: 'deferredQuestionSettled', actionId, settled, answers: payload, verify: autoVerify });
        pendingCards.delete(actionId);
      } else {
        vscode.postMessage({ type: 'questionResponse', actionId, answers: payload, settled });
        pendingCards.delete(actionId);
      }
      settleCard(card, settled.text, settled.tone);
      promptInput.focus();
    });
    skip.addEventListener('click', () => {
      if (deferred) {
        vscode.postMessage({ type: 'deferredQuestionSettled', actionId, settled: { text: 'Skipped', tone: 'denied' } });
        pendingCards.delete(actionId);
      }
      if (!deferred) {
        vscode.postMessage({ type: 'approvalResponse', approved: false, actionId, settled: { text: 'Skipped', tone: 'denied' } });
        pendingCards.delete(actionId);
      }
      settleCard(card, 'Skipped', 'denied');
    });
    refresh();
    turnHost().appendChild(card);
    if (storedSettlement) settleCard(card, storedSettlement.text, storedSettlement.tone);
    else pendingCards.set(actionId, card);
    scrollTranscriptToEnd();
  }

  function renderAuthHold(hold) {
    let card = transcriptEl.querySelector('.auth-hold');
    if (hold.cleared) { card?.remove(); return; }
    if (!card) {
      card = document.createElement('div');
      card.className = 'auth-hold';
      card.setAttribute('role', 'alert');
      transcriptEl.append(card);
    }
    const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text) el.textContent = text; return el; };
    const icon = make('span', 'auth-hold-icon');
    icon.innerHTML = WARN_SVG;
    const body = make('div', 'auth-hold-body');
    body.append(make('strong', '', hold.title), make('span', '', hold.message));
    for (const step of hold.steps || []) body.append(make('span', 'auth-hold-step', step));
    if (hold.error) body.append(make('span', 'auth-hold-error', hold.error));
    const actions = make('div', 'auth-hold-actions');
    if (hold.button) {
      const primary = make('button', 'context-compact auth-hold-primary', hold.busy ? 'Waiting…' : hold.button);
      primary.type = 'button';
      primary.disabled = Boolean(hold.busy);
      primary.addEventListener('click', () => vscode.postMessage({ type: 'authAction', agent: hold.agent }));
      actions.append(primary);
    }
    const recheck = make('button', 'context-compact', 'Check again');
    recheck.type = 'button';
    recheck.addEventListener('click', () => vscode.postMessage({ type: 'authRecheck', agent: hold.agent }));
    actions.append(recheck);
    card.replaceChildren(icon, body, actions);
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
  // The Thinking pill shows the active context while the agent works.
  const CONTEXT_LIMITS = { claude: 1000000, codex: 1000000, gemini: 1048576 };
  const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `${Math.max(1, Math.round(n / 1000))}k`);
  function renderContextGauge(context) {
    const tokens = context?.tokens || 0;
    const limit = context?.limit > 0 ? context.limit : CONTEXT_LIMITS[context?.agent] || 1000000; // the CLI's own window when it named one
    const remaining = Math.max(0, limit - tokens);
    const pct = Math.min(100, Math.round((tokens / limit) * 100));
    const isEst = context?.estimated ? '~' : '';
    pendingTokens.textContent = tokens ? `${isEst}${kTokens(tokens)} / ${kTokens(limit)} Token Context` : '';
    pendingTokens.title = `${context?.agent ? AGENT_NAMES[context.agent] || context.agent : 'Model'} context: ${tokens.toLocaleString()} tokens used (${pct}%), ${remaining.toLocaleString()} tokens remaining in ${limit.toLocaleString()} window.`;
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
  /** A reset nobody asked for (the CLI compacted itself, or Clanker started a fresh session): the compaction divider, with the reason under it. */
  function appendContextReset(record) {
    clearEmptyState();
    const divider = document.createElement('div');
    divider.className = 'compact-divider is-settled';
    divider.dataset.kind = record.kind || '';
    divider.setAttribute('role', 'status');
    divider.innerHTML = `<span class="compact-status">${COMPACT_SVG}<span class="compact-label"></span></span><small></small>`;
    divider.querySelector('.compact-label').textContent = record.title || 'Context reset';
    divider.querySelector('small').textContent = record.detail || '';
    turnHost().appendChild(divider);
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

  /** `running`: the host's routing message for a turn still in progress. Its reply
   * so far stays open, and the stream picks up where it is. */
  function restoreChat(chat, running = null, synced = false) {
    const previousTop = transcriptEl.scrollTop, follow = stickToEnd;
    if (transcriptScrollFrame) cancelAnimationFrame(transcriptScrollFrame);
    transcriptScrollFrame = 0;
    const lastLimit = (chat.messages || []).findLastIndex(message => message.role === 'assistant' && isLimitNotice(message.text));
    continueSentAfterLimit = lastLimit >= 0 && chat.messages.slice(lastLimit + 1).some(message => message.role === 'user' && /^\s*continue\s*[.!]?\s*$/i.test(message.text));
    currentChatId = chat.id;
    if (chat.modelId && !synced) selectModel(chat.modelId, { notifyExtension: false });
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
    historyStart = chat.historyStart || 0;
    historyUserStart = chat.historyUserStart || 0;
    loadingHistory = false;
    historyRequest++;
    settleFindLoad(false);
    pendingAssistantBodies.clear();
    toolCards.clear(); pendingCards.clear(); openToolCard = null;
    currentTurnEl = null;
    const { anchor, flush } = renderStoredMessages(messages, running, chat.historyUserStart || 0, chat.historyStart || 0);
    const latest = messages.findLastIndex((entry) => entry.role === 'assistant' && !entry.compact);
    if (!running && messages[latest]?.undo?.count && !messages[latest].undone && !messages.slice(latest).some((entry) => entry.role === 'user' && !entry.compact)) offerUndo(messages[latest].undo.count);
    if (!synced) {
      scheduleChoice = null; // a new chat starts from its own model's usage, not the last chat's clock pick
      scheduleTimer.clear();
      refreshScheduleDefault();
    }
    if (running) {
      turnAnchor = anchor;
      turnStartedAt = running.startedAt || Date.now();
      turnModelLabel = running.modelLabel || null;
      turnRoleName = running.roleName || null;
      pendingEl.dataset.agent = running.agentId || '';
      if (currentTurnEl) currentTurnEl.dataset.agent = running.agentId || '';
      turnRoutedAgent = running.agentId || null;
      if (!running.compact && currentTurnEl?.isConnected && running.agentId) ensureTurnRole(running.agentId, running.modelLabel, running.roleName);
    } else {
      flush();
      turnAnchor = null;
      const lastMessage = messages.findLast((message) => message.role !== 'tool');
      if (lastMessage?.role === 'assistant' && isLimitNotice(lastMessage.text) && (limitActive(lastMessage.text, lastMessage.at) ?? !hasHeadroom(lastMessage.agent))) {
        turnRoutedAgent = lastMessage.agent || null;
        offerContinueAtReset([...transcriptEl.querySelectorAll('.msg-assistant')].pop());
      }
    }
    if (!transcriptEl.childElementCount) transcriptEl.append(emptyState());
    lastScrollTop = transcriptEl.scrollTop;
    if (!synced || follow) scrollTranscriptToEnd(true);
    else {
      if (transcriptScrollFrame) cancelAnimationFrame(transcriptScrollFrame);
      transcriptScrollFrame = 0;
      stickToEnd = false; transcriptEl.scrollTop = previousTop;
    }
  }

  function renderStoredMessages(messages, running = null, userStart = 0, firstIndex = 0) {
    nextUserIndex = userStart;
    const live = running ? messages.findLastIndex((message) => message.role === 'assistant') : -1;
    // Each stored turn collapses the same way a live one does; its duration is
    // the gap between the user message's and the reply's timestamps.
    let anchor = null;
    let startedAt = null;
    let endedAt = null;
    const flush = () => { if (anchor) collapseTurn(anchor, startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null); anchor = null; };
    const storedTool = (message, at) => message.event?.type === 'question_required' && message.event.deferred
      ? appendQuestionCard(message.event)
      : appendToolCard({ name: message.event?.name, command: message.event?.command || message.event?.file, intent: message.event?.summary, output: { text: message.event?.output || '', ...(message.event?.outputTruncated ? { lazy: { index: firstIndex + at, toolId: message.event.toolId, length: message.event.outputTruncated } } : {}) }, toolId: message.event?.toolId, done: message.done !== false || !running || message.interrupted, cancelled: message.interrupted, error: message.error, diff: message.event?.diff, startedAt: message.startedAt ?? message.event?.startedAt ?? (message.done === false && running ? (running.startedAt || Date.parse(startedAt)) : undefined), durationMs: message.durationMs ?? message.event?.durationMs });
    const placed = new Set();
    let hiddenCompactTurn = false;
    restoringHistory = true;
    messages.forEach((message, index) => {
      if (message.role === 'user') {
        flush();
        hiddenCompactTurn = Boolean(message.compact);
        if (hiddenCompactTurn) {
          nextUserIndex++;
          const reply = messages.slice(index + 1).find((entry) => entry.role === 'assistant');
          const active = Boolean(running?.compact) && messages.findLastIndex((entry) => entry.role === 'user') === index;
          const outcome = reply?.interrupted ? 'interrupted' : /^(Claude|Gemini|Codex) error:/i.test(reply?.text || '') ? 'failed' : 'complete';
          appendCompactDivider(message.auto, active, outcome);
          if (active) { currentTurnEl = null; currentAssistantBubble = null; }
          return;
        }
        appendUserMessage(message.text || '', message.at || null, message.files, { scheduled: message.scheduled, clientTurnId: message.clientTurnId, background: isBackgroundPrompt(message), contextHandoff: message.contextHandoff });
        anchor = currentTurnEl.firstElementChild; startedAt = message.at; endedAt = null;
      }
      else if (hiddenCompactTurn) return;
      else if (message.role === 'assistant') {
        if (message.agent) ensureTurnRole(message.agent, message.modelLabel, message.roleName);
        for (const record of message.contextResets || []) appendContextReset(record);
        // The tools that follow a reply record where in its text they ran, so
        // text and steps come back in the order they happened (older chats: tools last).
        const text = message.text || '';
        let from = 0;
        for (let next = index + 1; messages[next]?.role === 'tool' && Number.isFinite(messages[next].offset); next++) {
          appendAssistantDelta(text.slice(from, messages[next].offset), message.agent, message.modelLabel, message.roleName);
          storedTool(messages[next], next);
          placed.add(next);
          from = messages[next].offset;
        }
        appendAssistantDelta(text.slice(from), message.agent, message.modelLabel, message.roleName);
        if (index === live) return;
        if (message.interrupted) appendInterruptedPill(message.interruptionReason);
        endAssistantTurn(message.at || null);
        endedAt = message.at;
      }
      else if (message.role === 'tool' && !placed.has(index)) storedTool(message, index);
    });
    restoringHistory = false;
    return { anchor, flush };
  }

  function loadEarlierHistory(fromScroll = false) {
    if (!historyStart || loadingHistory || restoringHistory || transcriptScrollFrame || transcriptEl.scrollTop > 320) return;
    // Opening a chat stays at its recent tail. Only underfilled viewports load another page automatically.
    if (stickToEnd && !fromScroll && transcriptEl.scrollHeight > transcriptEl.clientHeight + 1) return;
    if (fromScroll) stickToEnd = false;
    loadingHistory = true;
    vscode.postMessage({ type: 'requestChatHistory', chatId: currentChatId, before: historyStart, requestId: ++historyRequest });
  }

  // Find in chat (media/chat-find.js). A match in history the window has not loaded fetches a small window around its turn,
  // leaving any skipped stretch as a lazy .history-gap button so jumping around a huge chat never bloats the DOM.
  let findLoad = null;
  const settleFindLoad = (loaded) => { const done = findLoad; findLoad = null; done?.(loaded); };
  function createHistoryGap(start, end, userStart, userEnd) {
    const count = Math.max(1, userEnd - userStart);
    const label = `Show ${count} skipped ${count === 1 ? 'turn' : 'turns'}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-gap';
    btn.dataset.start = String(start);
    btn.dataset.end = String(end);
    btn.dataset.userStart = String(userStart);
    btn.dataset.userEnd = String(userEnd);
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<span>${label}</span>`;
    btn.addEventListener('click', () => loadGap(btn, 'down'));
    return btn;
  }
  function findUnloadedRegion(turn) {
    if (historyStart > 0 && turn < historyUserStart) return { after: 0, before: historyStart };
    for (const gap of transcriptEl.querySelectorAll('.history-gap')) {
      const userStart = Number(gap.dataset.userStart);
      const userEnd = Number(gap.dataset.userEnd);
      if (turn >= userStart && turn < userEnd) return { after: Number(gap.dataset.start), before: Number(gap.dataset.end) };
    }
    return null;
  }
  function loadGap(gap, direction = 'down') {
    if (!gap?.isConnected || loadingHistory || restoringHistory || transcriptScrollFrame || !currentChatId) return;
    loadingHistory = true;
    gap.disabled = true;
    vscode.postMessage({ type: 'requestChatHistory', chatId: currentChatId, after: Number(gap.dataset.start), before: Number(gap.dataset.end), direction, requestId: ++historyRequest });
  }
  function loadVisibleGaps(scrollingUp) {
    if (loadingHistory || restoringHistory || transcriptScrollFrame || !currentChatId) return;
    const gaps = transcriptEl.querySelectorAll('.history-gap');
    if (!gaps.length) return;
    const box = transcriptEl.getBoundingClientRect();
    for (const gap of gaps) {
      const rect = gap.getBoundingClientRect();
      if (rect.bottom >= box.top - 260 && rect.top <= box.bottom + 260) {
        loadGap(gap, scrollingUp ? 'up' : 'down');
        break;
      }
    }
  }
  function loadHistoryFrom(turn) {
    const region = findUnloadedRegion(turn);
    if (!region || !currentChatId) return Promise.resolve(false);
    settleFindLoad(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (findLoad === settle) { loadingHistory = false; settleFindLoad(false); } }, 8000);
      const settle = (loaded) => { clearTimeout(timer); resolve(loaded); };
      findLoad = settle;
      stickToEnd = false;
      loadingHistory = true;
      vscode.postMessage({ type: 'requestChatHistory', chatId: currentChatId, after: region.after, before: region.before, fromTurn: turn, requestId: ++historyRequest });
    });
  }
  const chatFind = window.createChatFind?.({
    transcript: transcriptEl,
    post: (message) => vscode.postMessage({ ...message, chatId: currentChatId }),
    releaseStick: () => { stickToEnd = false; },
    loadFromTurn: loadHistoryFrom,
  });
  document.getElementById('findBtn')?.addEventListener('click', () => chatFind?.open());

  // Renders stored records away from the live tail and hands them back as a fragment: the tail's nodes, handlers and renderer
  // state stay as they were. A marker, not the last element, says where the new nodes begin, so an empty transcript works too.
  function renderHistoryFragment(records, userStart, start) {
    const mark = document.createComment('history');
    transcriptEl.append(mark);
    const saved = { currentTurnEl, currentAssistantBubble, turnBubbles, turnAnchor, turnStartedAt, nextUserIndex, turnRoutedAgent, limitHitThisTurn };
    const cards = new Map(toolCards);
    currentTurnEl = null; currentAssistantBubble = null; turnBubbles = []; turnRoutedAgent = null;
    try {
      const { flush } = renderStoredMessages(records, null, userStart, start);
      flush();
      const fragment = document.createDocumentFragment();
      while (mark.nextSibling) fragment.append(mark.nextSibling);
      return fragment;
    } finally {
      mark.remove();
      ({ currentTurnEl, currentAssistantBubble, turnBubbles, turnAnchor, turnStartedAt, nextUserIndex, turnRoutedAgent, limitHitThisTurn } = saved);
      for (const [id, card] of cards) toolCards.set(id, card);
      restoringHistory = false;
    }
  }

  function prependHistory(page) {
    if (!loadingHistory || page.chatId !== currentChatId || page.requestId !== historyRequest) return;
    const rangeStart = Number.isSafeInteger(page.rangeStart) ? page.rangeStart : 0;
    const rangeEnd = Number.isSafeInteger(page.rangeEnd) ? page.rangeEnd : page.historyEnd;
    const pageUserEnd = Number.isSafeInteger(page.historyUserEnd)
      ? page.historyUserEnd
      : page.historyUserStart + (page.messages || []).filter((entry) => entry.role === 'user').length;
    const wasFindLoad = Boolean(findLoad);

    if (rangeStart === 0 && rangeEnd === historyStart) {
      const first = transcriptEl.firstElementChild;
      const top = first?.getBoundingClientRect().top;
      const followTail = stickToEnd;
      stickToEnd = false;
      let fragment;
      try { fragment = renderHistoryFragment(page.messages, page.historyUserStart, page.historyStart); }
      finally { loadingHistory = false; }
      const gap = page.historyEnd < historyStart ? createHistoryGap(page.historyEnd, historyStart, pageUserEnd, historyUserStart) : null;
      if (gap) transcriptEl.insertBefore(gap, first);
      transcriptEl.insertBefore(fragment, gap || first);
      historyStart = page.historyStart;
      historyUserStart = page.historyUserStart;
      if (first && Number.isFinite(top)) transcriptEl.scrollTop += first.getBoundingClientRect().top - top;
      lastScrollTop = transcriptEl.scrollTop;
      updateTranscriptFade();
      if (followTail) scrollTranscriptToEnd(true);
      else if (!wasFindLoad) requestAnimationFrame(() => loadEarlierHistory());
      settleFindLoad(true);
      return;
    }

    const gap = [...transcriptEl.querySelectorAll('.history-gap')].find((el) => Number(el.dataset.start) === rangeStart && Number(el.dataset.end) === rangeEnd);
    if (!gap) { loadingHistory = false; settleFindLoad(false); return; }
    const afterEl = gap.nextElementSibling;
    const box = transcriptEl.getBoundingClientRect();
    const anchorBelow = !wasFindLoad && afterEl && gap.getBoundingClientRect().bottom <= box.top + box.height * 0.5;
    const afterTop = anchorBelow ? afterEl.getBoundingClientRect().top : NaN;
    const gapUserStart = Number(gap.dataset.userStart);
    const gapUserEnd = Number(gap.dataset.userEnd);
    let fragment;
    try { fragment = renderHistoryFragment(page.messages, page.historyUserStart, page.historyStart); }
    finally { loadingHistory = false; }
    if (page.historyStart > rangeStart) transcriptEl.insertBefore(createHistoryGap(rangeStart, page.historyStart, gapUserStart, page.historyUserStart), gap);
    transcriptEl.insertBefore(fragment, gap);
    if (page.historyEnd < rangeEnd) transcriptEl.insertBefore(createHistoryGap(page.historyEnd, rangeEnd, pageUserEnd, gapUserEnd), gap);
    gap.remove();
    if (anchorBelow && Number.isFinite(afterTop)) transcriptEl.scrollTop += afterEl.getBoundingClientRect().top - afterTop;
    lastScrollTop = transcriptEl.scrollTop;
    updateTranscriptFade();
    settleFindLoad(true);
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
  const fullWhen = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : window.chatTime.formatDate(date, TIME_PREFS.locale, clockParts({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })); };
  const historySearch = document.createElement('input');
  historySearch.type = 'search';
  historySearch.className = 'history-search';
  historySearch.placeholder = 'Search chats';
  historySearch.setAttribute('aria-label', 'Search chats');
  historySearch.autocomplete = 'off';
  // Beside the search field, a Filter button opens a panel: which projects and providers to show, which chats (all, active,
  // waiting for you) and how to sort. A sort other than "Last active" lists the chats flat instead of by day.
  const HISTORY_SORTS = [
    ['recent', 'Last active', (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))],
    ['created', 'Newest', (a, b) => String(b.createdAt || b.updatedAt).localeCompare(String(a.createdAt || a.updatedAt))],
    ['oldest', 'Oldest', (a, b) => String(a.createdAt || a.updatedAt).localeCompare(String(b.createdAt || b.updatedAt))],
    ['title', 'Title A–Z', (a, b) => String(a.title || a.preview || '').localeCompare(String(b.title || b.preview || ''), undefined, { sensitivity: 'base', numeric: true })],
    ['messages', 'Most messages', (a, b) => (b.messageCount || 0) - (a.messageCount || 0)],
  ];
  const HISTORY_STATUSES = [['all', 'All'], ['active', 'Active'], ['waiting', 'Needs input']];
  const historyFilter = { projects: new Set(), models: new Set(), status: 'all', sort: 'recent' };
  const filterCount = () => historyFilter.projects.size + historyFilter.models.size + (historyFilter.status !== 'all') + (historyFilter.sort !== 'recent');
  const sessionProjectIds = (session) => { const ids = [...new Set([session.projectId, ...(session.touchedProjectIds || [])].filter(Boolean))]; return ids.length ? ids : ['']; };
  const historyTools = document.createElement('div');
  historyTools.className = 'history-tools';
  const filterBtn = document.createElement('button');
  filterBtn.type = 'button';
  filterBtn.className = 'history-filter-btn';
  filterBtn.setAttribute('aria-expanded', 'false');
  filterBtn.setAttribute('aria-controls', 'historyFilterPanel');
  filterBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"/></svg><span>Filter</span><b class="history-filter-badge" hidden></b>';
  const FOLDER_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.2A1.7 1.7 0 0 1 3.7 3.5h2.2l1.4 1.6h5A1.7 1.7 0 0 1 14 6.8v4.5a1.7 1.7 0 0 1-1.7 1.7H3.7A1.7 1.7 0 0 1 2 11.3z"/></svg>';
  const FOLDER_PLUS_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.2A1.7 1.7 0 0 1 3.7 3.5h2.2l1.4 1.6h5A1.7 1.7 0 0 1 14 6.8v4.5a1.7 1.7 0 0 1-1.7 1.7H3.7A1.7 1.7 0 0 1 2 11.3z"/><path d="M8 7.1v3.4M6.3 8.8h3.4"/></svg>';
  const CHEVRON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
  const newFolderBtn = document.createElement('button');
  newFolderBtn.type = 'button';
  newFolderBtn.className = 'history-folder-add-btn';
  newFolderBtn.title = 'New folder';
  newFolderBtn.setAttribute('aria-label', 'New folder');
  newFolderBtn.setAttribute('aria-expanded', 'false');
  newFolderBtn.setAttribute('aria-controls', 'historyFolderCreator');
  newFolderBtn.innerHTML = FOLDER_PLUS_SVG;
  const filterPanel = document.createElement('div');
  filterPanel.className = 'history-filter-panel';
  filterPanel.id = 'historyFilterPanel';
  filterPanel.hidden = true;
  const folderCreator = document.createElement('form');
  folderCreator.className = 'history-folder-creator';
  folderCreator.id = 'historyFolderCreator';
  folderCreator.hidden = true;
  historyTools.append(historySearch, filterBtn, newFolderBtn);
  historyModal.body.before(historyTools, filterPanel, folderCreator);
  let historySessions = [];
  let historyFolders = [];
  let chatFoldersEnabled = window.CHAT_FOLDERS_ENABLED !== false;
  const expandedManageFolders = new Set();
  let editingFolderChatsId = null;
  let activeFolderMenu = null;
  const reusableHistoryCards = new Map();
  let draggedChatId = null;
  function closeFolderMenu() {
    if (!activeFolderMenu) return;
    activeFolderMenu.menu.remove();
    activeFolderMenu.trigger?.setAttribute('aria-expanded', 'false');
    activeFolderMenu = null;
  }
  function closeFolderCreator() {
    if (folderCreator.hidden) return;
    folderCreator.hidden = true;
    folderCreator.replaceChildren();
    newFolderBtn.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('pointerdown', (event) => {
    if (activeFolderMenu && !activeFolderMenu.menu.contains(event.target) && !activeFolderMenu.trigger.contains(event.target)) closeFolderMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeFolderMenu) {
      const trigger = activeFolderMenu.trigger;
      closeFolderMenu();
      trigger?.focus();
    }
  });
  function openFolderCreator() {
    if (!chatFoldersEnabled) return;
    if (!folderCreator.hidden) { closeFolderCreator(); return; }
    filterPanel.hidden = true;
    filterBtn.setAttribute('aria-expanded', 'false');
    closeFolderMenu();
    const picked = new Set();
    const row = document.createElement('div');
    row.className = 'history-folder-creator-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'cs-field history-folder-name-input';
    nameInput.placeholder = 'Folder name…';
    nameInput.maxLength = 60;
    nameInput.setAttribute('aria-label', 'Folder name');
    const createBtn = document.createElement('button');
    createBtn.type = 'submit';
    createBtn.className = 'cs-btn is-primary history-folder-submit';
    createBtn.textContent = 'Create';
    createBtn.disabled = true;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cs-btn is-quiet';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { closeFolderCreator(); newFolderBtn.focus(); });
    nameInput.addEventListener('input', () => { createBtn.disabled = !nameInput.value.trim(); });
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeFolderCreator(); newFolderBtn.focus(); }
    });
    row.append(nameInput, createBtn, cancelBtn);
    folderCreator.replaceChildren(row);
    if (historySessions.length) {
      const folderByChat = new Map();
      for (const folder of historyFolders) for (const id of folder.chatIds || []) folderByChat.set(id, folder.name);
      const pickWrap = document.createElement('div');
      pickWrap.className = 'history-folder-pick-wrap';
      const pickLabel = document.createElement('span');
      pickLabel.className = 'history-filter-label';
      pickLabel.textContent = 'Bundle chats (optional)';
      const pickList = document.createElement('div');
      pickList.className = 'history-folder-pick-list';
      for (const session of historySessions.slice(0, 40)) {
        const option = document.createElement('label');
        option.className = 'history-folder-pick-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = session.id;
        box.addEventListener('change', () => { if (box.checked) picked.add(session.id); else picked.delete(session.id); });
        const title = document.createElement('span');
        title.className = 'history-folder-pick-title';
        title.textContent = session.title || session.preview || 'New chat';
        option.append(box, title);
        const existingFolder = folderByChat.get(session.id);
        if (existingFolder) {
          const tag = document.createElement('span');
          tag.className = 'history-folder-pick-tag';
          tag.textContent = existingFolder;
          option.append(tag);
        }
        pickList.append(option);
      }
      pickWrap.append(pickLabel, pickList);
      folderCreator.append(pickWrap);
    }
    folderCreator.onsubmit = (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      vscode.postMessage({ type: 'createChatFolder', name, chatIds: [...picked] });
      closeFolderCreator();
    };
    folderCreator.hidden = false;
    newFolderBtn.setAttribute('aria-expanded', 'true');
    nameInput.focus();
  }
  newFolderBtn.addEventListener('click', openFolderCreator);
  historySearch.addEventListener('input', () => renderHistory(historySessions));
  filterBtn.addEventListener('click', () => {
    closeFolderCreator();
    filterPanel.hidden = !filterPanel.hidden;
    filterBtn.setAttribute('aria-expanded', String(!filterPanel.hidden));
    if (!filterPanel.hidden) renderFilterPanel();
  });
  function renderFilterPanel() {
    const badge = filterBtn.querySelector('.history-filter-badge');
    badge.hidden = !filterCount();
    badge.textContent = String(filterCount());
    filterBtn.classList.toggle('is-filtered', filterCount() > 0);
    if (filterPanel.hidden) return;
    const row = (label, chips) => {
      const section = document.createElement('div');
      section.className = 'history-filter-row';
      const heading = document.createElement('span');
      heading.className = 'history-filter-label';
      heading.textContent = label;
      const group = document.createElement('div');
      group.className = 'history-filter-chips';
      group.append(...chips);
      section.append(heading, group);
      return section;
    };
    const chip = (text, pressed, onClick, lead) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-chip';
      btn.setAttribute('aria-pressed', String(pressed));
      if (lead) btn.append(lead);
      btn.append(Object.assign(document.createElement('span'), { textContent: text }));
      btn.addEventListener('click', () => { onClick(); renderFilterPanel(); renderHistory(historySessions); });
      return btn;
    };
    const toggle = (set, key) => () => { if (!set.delete(key)) set.add(key); };
    const counts = new Map();
    for (const session of historySessions) for (const id of sessionProjectIds(session)) counts.set(id, (counts.get(id) || 0) + 1);
    const projectChips = railProjects.filter((project) => counts.has(project.id)).map((project) => {
      const icon = document.createElement('span');
      icon.className = 'history-project-icon'; icon.style.setProperty('--hue', projectHue(project.id));
      icon.append(projectMark(project));
      return chip(`${project.name} · ${counts.get(project.id)}`, historyFilter.projects.has(project.id), toggle(historyFilter.projects, project.id), icon);
    });
    if (counts.has('')) projectChips.push(chip(`No project · ${counts.get('')}`, historyFilter.projects.has(''), toggle(historyFilter.projects, '')));
    const models = [...new Set(historySessions.flatMap((session) => session.models || []))];
    const modelChips = models.map((model) => {
      const mark = document.createElement('span');
      mark.className = 'agent-mark'; mark.innerHTML = (window.AGENT_ICONS && window.AGENT_ICONS[model]) || '';
      return chip(MODEL_LABELS[model] || model, historyFilter.models.has(model), toggle(historyFilter.models, model), mark);
    });
    const rows = [];
    if (projectChips.length) rows.push(row('Project', projectChips));
    if (modelChips.length) rows.push(row('Provider', modelChips));
    rows.push(row('Show', HISTORY_STATUSES.map(([key, label]) => chip(label, historyFilter.status === key, () => { historyFilter.status = key; }))));
    rows.push(row('Sort by', HISTORY_SORTS.map(([key, label]) => chip(label, historyFilter.sort === key, () => { historyFilter.sort = key; }))));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'history-filter-reset';
    reset.textContent = 'Reset';
    reset.hidden = !filterCount();
    reset.addEventListener('click', () => { Object.assign(historyFilter, { status: 'all', sort: 'recent' }); historyFilter.projects.clear(); historyFilter.models.clear(); renderFilterPanel(); renderHistory(historySessions); });
    const focusAt = [...filterPanel.querySelectorAll('button')].indexOf(document.activeElement);
    filterPanel.replaceChildren(...rows, reset);
    if (focusAt >= 0) filterPanel.querySelectorAll('button')[focusAt]?.focus({ preventScroll: true });
  }
  // "5 minutes ago" ages while the list is open.
  setInterval(() => {
    if (historyModal.el.hidden || document.hidden) return;
    historyModal.body.querySelectorAll('.history-when[data-at]').forEach((label) => { const text = chatWhen(label.dataset.at); if (label.textContent !== text) label.textContent = text; });
  }, 30000);

  function renderHistory(sessions, folders = historyFolders) {
    historySessions = sessions || [];
    historyFolders = Array.isArray(folders) ? folders : [];
    const activeFolders = chatFoldersEnabled ? historyFolders : [];
    const all = historySessions;
    const working = all.filter((session) => session.state).length;
    historyBtn.title = working ? `${working} chat${working === 1 ? '' : 's'} running` : 'Manage chats';
    newFolderBtn.hidden = !chatFoldersEnabled;
    if (!chatFoldersEnabled) { closeFolderCreator(); closeFolderMenu(); editingFolderChatsId = null; }
    if (historyModal.el.hidden || document.hidden || historyModal.body.querySelector('input.title-edit')) return;
    closeFolderMenu();
    const query = historySearch.value.trim().toLowerCase();
    const { projects, models, status, sort } = historyFilter;
    // Dates search too: "yesterday", "oct 29", "october", "29.10." all find the chats last active then.
    const dateText = (session) => [chatWhen(session.updatedAt), window.chatTime.chatDayGroup(session.updatedAt, timeOptions()), fullWhen(session.updatedAt), window.chatTime.formatDate(new Date(session.updatedAt), TIME_PREFS.locale, { year: 'numeric', month: 'numeric', day: 'numeric' })];
    const matches = fields => fields.some(field => String(field || '').toLowerCase().includes(query));
    const matchesFilters = (session) => (!projects.size || sessionProjectIds(session).some((id) => projects.has(id)))
      && (!models.size || (session.models || []).some((model) => models.has(model)))
      && (status === 'all' || (status === 'active' ? session.active : session.state === 'waiting'));
    const matchesQuery = (session) => !query || matches([session.title, session.projectName, ...(session.projectNames || []), session.preview, session.lastMessage?.text]) || matches(dateText(session));
    const list = all.filter((session) => matchesQuery(session) && matchesFilters(session));
    if (sort !== 'recent') list.sort(HISTORY_SORTS.find(([key]) => key === sort)[2]);
    const narrowed = Boolean(query) || projects.size > 0 || models.size > 0 || status !== 'all';
    const hasNonQueryFilter = projects.size > 0 || models.size > 0 || status !== 'all';
    historyModal.count.textContent = narrowed ? `${list.length} of ${all.length}` : String(all.length);
    historyTools.hidden = !all.length;
    if (!all.length) { filterPanel.hidden = true; closeFolderCreator(); }
    renderFilterPanel();
    const scrolled = historyModal.body.scrollTop; // a live refresh keeps your place
    const focused = document.activeElement;
    // Keep filtered-out cards only while the dialog is open, so clearing a search does not rebuild the whole list.
    const known = new Set(all.map(session => session.id));
    for (const id of reusableHistoryCards.keys()) if (!known.has(id)) reusableHistoryCards.delete(id);
    for (const card of historyModal.body.querySelectorAll('.history-card')) reusableHistoryCards.set(card.dataset.id, card);
    historyModal.body.replaceChildren();

    const sessionById = new Map(all.map(session => [session.id, session]));
    const folderOfChat = new Map();
    for (const folder of activeFolders) {
      for (const id of folder.chatIds || []) if (sessionById.has(id) && !folderOfChat.has(id)) folderOfChat.set(id, folder);
    }
    if (editingFolderChatsId && !activeFolders.some(folder => folder.id === editingFolderChatsId)) editingFolderChatsId = null;

    // Resolve each folder's visible member chats and derived activity timestamp.
    const sortFn = sort !== 'recent' ? HISTORY_SORTS.find(([key]) => key === sort)[2] : null;
    const folderEntries = [];
    for (const folder of activeFolders) {
      const allMembers = (folder.chatIds || []).map(id => sessionById.get(id)).filter(Boolean);
      const nameMatches = Boolean(query) && folder.name.toLowerCase().includes(query);
      const visibleMembers = allMembers.filter(session => matchesFilters(session) && (!query || nameMatches || matchesQuery(session)));
      if (narrowed && !visibleMembers.length && !(nameMatches && !hasNonQueryFilter)) continue;
      if (sortFn) visibleMembers.sort(sortFn);
      else visibleMembers.sort((a, b) => {
        if (a.pinned || b.pinned) return a.pinned && b.pinned ? a.pinOrder - b.pinOrder : a.pinned ? -1 : 1;
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
      const latestUpdatedAt = allMembers.reduce((best, s) => (String(s.updatedAt || '') > best ? String(s.updatedAt || '') : best), folder.updatedAt || folder.createdAt || '');
      folderEntries.push({ folder, allMembers, visibleMembers, latestUpdatedAt, autoExpand: narrowed && visibleMembers.length > 0 });
    }

    const standaloneList = activeFolders.length ? list.filter(session => !folderOfChat.has(session.id)) : list;
    if (!standaloneList.length && !folderEntries.length) {
      const empty = document.createElement('p');
      empty.className = 'fs-modal-empty';
      empty.textContent = !all.length ? 'No conversations yet.' : query ? `No chats match “${historySearch.value.trim()}”.` : 'No chats match the filter.';
      historyModal.body.append(empty);
      if (!all.length) reusableHistoryCards.clear();
      return;
    }

    const pinnedFolders = folderEntries.filter(entry => entry.folder.pinned).sort((a, b) => (a.folder.pinnedAt ?? 0) - (b.folder.pinnedAt ?? 0));
    const unpinnedFolders = folderEntries.filter(entry => !entry.folder.pinned).sort((a, b) => String(b.latestUpdatedAt).localeCompare(String(a.latestUpdatedAt)));

    // Pinned folders and pinned chats stand on top whatever the sort, in pin order; each chat shows once.
    const pinnedChats = standaloneList.filter((session) => session.pinned).sort((a, b) => a.pinOrder - b.pinOrder);
    if (pinnedFolders.length || pinnedChats.length) {
      const section = document.createElement('section');
      section.className = 'history-section';
      const heading = document.createElement('h3');
      heading.className = 'history-section-label';
      heading.textContent = 'Pinned';
      const wrap = document.createElement('div');
      wrap.className = 'queue-list';
      for (const entry of pinnedFolders) wrap.append(buildFolderCard(entry, all, folderOfChat, activeFolders));
      for (const session of pinnedChats) wrap.append(buildHistoryCard(session, folderOfChat, activeFolders));
      section.append(heading, wrap);
      historyModal.body.append(section);
    }

    if (unpinnedFolders.length) {
      const section = document.createElement('section');
      section.className = 'history-section';
      const heading = document.createElement('h3');
      heading.className = 'history-section-label';
      heading.textContent = 'Folders';
      const wrap = document.createElement('div');
      wrap.className = 'queue-list';
      for (const entry of unpinnedFolders) wrap.append(buildFolderCard(entry, all, folderOfChat, activeFolders));
      section.append(heading, wrap);
      historyModal.body.append(section);
    }

    const unpinned = standaloneList.filter((session) => !session.pinned);
    const makeUngroupedSection = (label, entries) => {
      const section = historySection(label, entries, folderOfChat, activeFolders);
      if (activeFolders.length) wireUngroupedDrop(section, folderOfChat);
      return section;
    };
    if (sort !== 'recent') { if (unpinned.length) historyModal.body.append(makeUngroupedSection(HISTORY_SORTS.find(([key]) => key === sort)[1], unpinned)); }
    else {
      const active = unpinned.filter((session) => session.active);
      if (active.length) historyModal.body.append(makeUngroupedSection('Active Chats', active));
      const groups = [];
      for (const session of unpinned.filter((entry) => !entry.active)) {
        const label = window.chatTime.chatDayGroup(session.updatedAt, timeOptions());
        if (groups.at(-1)?.label === label) groups.at(-1).sessions.push(session); else groups.push({ label, sessions: [session] });
      }
      for (const group of groups) historyModal.body.append(makeUngroupedSection(group.label || 'Older', group.sessions));
    }
    if (focused?.isConnected && focused !== document.activeElement) focused.focus({ preventScroll: true });
    historyModal.body.scrollTop = scrolled;
  }

  function wireUngroupedDrop(section, folderOfChat) {
    section.addEventListener('dragover', (event) => {
      if (!draggedChatId || !folderOfChat.has(draggedChatId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      section.classList.add('is-drop-ungroup');
    });
    section.addEventListener('dragleave', (event) => {
      if (!section.contains(event.relatedTarget)) section.classList.remove('is-drop-ungroup');
    });
    section.addEventListener('drop', (event) => {
      section.classList.remove('is-drop-ungroup');
      const chatId = draggedChatId || event.dataTransfer?.getData('text/plain');
      if (!chatId || !folderOfChat.has(chatId)) return;
      event.preventDefault();
      draggedChatId = null;
      vscode.postMessage({ type: 'setChatFolder', chatId, folderId: null });
    });
  }

  const CHAT_ICONS = {
    stop: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor"/></svg>',
    pin: PIN_SVG, // the project pin's pushpin
    folder: FOLDER_SVG,
    plus: PLUS_SVG,
    rename: PENCIL_SVG,
    // The Source Control mark: one trunk, one branch splitting off, a node on each end.
    fork: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="4.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.1v5.8M11.5 6.1c0 2.6-2 3.4-4.3 3.9-1.5.3-2.7.7-2.7 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    delete: TRASH_SVG,
  };

  function openChatFolderMenu(trigger, session, currentFolder, folders) {
    if (activeFolderMenu?.trigger === trigger) { closeFolderMenu(); return; }
    closeFolderMenu();
    const menu = document.createElement('div');
    menu.className = 'history-folder-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `Move ${session.title || 'chat'} to folder`);
    for (const folder of folders) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'history-folder-menu-item';
      item.setAttribute('role', 'menuitemradio');
      const selected = currentFolder?.id === folder.id;
      item.setAttribute('aria-checked', String(selected));
      const check = document.createElement('span');
      check.className = 'history-folder-menu-check';
      check.innerHTML = selected ? CHECK_SVG : '';
      const name = document.createElement('span');
      name.className = 'history-folder-menu-name';
      name.textContent = folder.name;
      item.append(check, name);
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        closeFolderMenu();
        vscode.postMessage({ type: 'setChatFolder', chatId: session.id, folderId: selected ? null : folder.id });
      });
      menu.append(item);
    }
    if (currentFolder) {
      const divider = document.createElement('div');
      divider.className = 'history-folder-menu-sep';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'history-folder-menu-item is-remove';
      remove.setAttribute('role', 'menuitem');
      remove.textContent = 'Remove from folder';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        closeFolderMenu();
        vscode.postMessage({ type: 'setChatFolder', chatId: session.id, folderId: null });
      });
      menu.append(divider, remove);
    }
    menu.addEventListener('click', (event) => event.stopPropagation());
    document.body.append(menu);
    const rect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(10, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 10));
    const top = rect.bottom + 6 + menuRect.height > window.innerHeight - 10 ? Math.max(10, rect.top - menuRect.height - 6) : rect.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    trigger.setAttribute('aria-expanded', 'true');
    activeFolderMenu = { menu, trigger };
    menu.querySelector('button')?.focus();
  }

  function folderMiniMark(session) {
    const cell = document.createElement('span');
    cell.className = 'history-folder-mini';
    const project = session.projectId && railProjects.find(item => item.id === session.projectId);
    if (project) {
      cell.classList.add('is-project');
      cell.style.setProperty('--hue', projectHue(project.id));
      cell.append(projectMark(project));
      return cell;
    }
    const agent = session.latestAgent || (session.models || []).at(-1);
    if (agent && window.AGENT_ICONS?.[agent]) {
      cell.innerHTML = window.AGENT_ICONS[agent];
      return cell;
    }
    cell.classList.add('is-slot');
    return cell;
  }

  function buildFolderCard(entry, allSessions, folderOfChat, activeFolders) {
    const { folder, allMembers, visibleMembers, latestUpdatedAt, autoExpand } = entry;
    const isExpanded = autoExpand || expandedManageFolders.has(folder.id) || editingFolderChatsId === folder.id;
    const hasCurrent = allMembers.some(s => s.id === currentChatId);
    const hasWaiting = allMembers.some(s => s.state === 'waiting');
    const hasRunning = allMembers.some(s => s.state === 'running');
    const hasRecent = allMembers.some(s => s.active);
    const latestAgent = (allMembers.find(s => s.state === 'waiting') || allMembers.find(s => s.state === 'running') || allMembers[0])?.latestAgent
      || (allMembers[0]?.models || []).at(-1);

    const card = document.createElement('article');
    card.className = `history-folder-card${isExpanded ? ' is-expanded' : ''}${folder.pinned ? ' is-pinned' : ''}${hasRunning ? ' is-running' : ''}${hasWaiting ? ' is-waiting' : ''}${hasRecent ? ' is-recent' : ''}${hasCurrent ? ' is-current' : ''}`;
    card.dataset.folderId = folder.id;
    if (latestAgent) card.dataset.agent = latestAgent;

    if (hasRunning && !isExpanded) {
      const orb = document.createElement('span');
      orb.className = 'pending-orb history-spinner';
      orb.setAttribute('aria-hidden', 'true');
      card.append(orb);
    }

    const head = document.createElement('div');
    head.className = 'history-folder-head';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(isExpanded));
    head.setAttribute('aria-label', `${folder.pinned ? 'Pinned folder' : 'Folder'}: ${folder.name}, ${allMembers.length} chat${allMembers.length === 1 ? '' : 's'}`);

    const thumb = document.createElement('span');
    thumb.className = `history-folder-thumb${allMembers.length ? '' : ' is-empty'}`;
    thumb.setAttribute('aria-hidden', 'true');
    if (allMembers.length) {
      for (const member of allMembers.slice(0, 4)) thumb.append(folderMiniMark(member));
    } else {
      thumb.innerHTML = FOLDER_SVG;
    }

    const info = document.createElement('div');
    info.className = 'history-folder-info';
    const titleRow = document.createElement('div');
    titleRow.className = 'history-folder-title-row';
    const titleEl = document.createElement('span');
    titleEl.className = 'history-folder-title';
    titleEl.textContent = folder.name;
    titleEl.title = folder.name;
    const countEl = document.createElement('span');
    countEl.className = 'history-folder-count';
    countEl.textContent = allMembers.length ? `${allMembers.length} chat${allMembers.length === 1 ? '' : 's'}` : 'Empty';
    titleRow.append(titleEl, countEl);

    const meta = document.createElement('div');
    meta.className = 'history-folder-meta';
    if (allMembers.length) {
      const when = document.createElement('time');
      when.className = 'history-when';
      when.dateTime = latestUpdatedAt;
      when.dataset.at = latestUpdatedAt;
      when.textContent = chatWhen(latestUpdatedAt);
      const names = document.createElement('span');
      names.className = 'history-folder-preview';
      names.textContent = allMembers.slice(0, 3).map(s => s.title || s.preview || 'New chat').join(', ');
      meta.append(when, names);
    } else {
      meta.textContent = 'No chats yet';
    }
    info.append(titleRow, meta);

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const action = (icon, label, handler, cls = '') => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `history-icon-btn ${cls}`;
      btn.innerHTML = CHAT_ICONS[icon];
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.addEventListener('click', (event) => { event.stopPropagation(); handler(btn); });
      actions.append(btn);
      return btn;
    };
    const bundleBtn = action('plus', 'Add or remove chats', () => {
      editingFolderChatsId = editingFolderChatsId === folder.id ? null : folder.id;
      if (editingFolderChatsId === folder.id) expandedManageFolders.add(folder.id);
      renderHistory(historySessions, historyFolders);
    }, 'is-bundle');
    bundleBtn.setAttribute('aria-pressed', String(editingFolderChatsId === folder.id));
    const pinBtn = action('pin', `${folder.pinned ? 'Unpin' : 'Pin'} folder`, () => {
      vscode.postMessage({ type: 'pinChatFolder', id: folder.id, pinned: !folder.pinned });
    }, 'is-pin');
    pinBtn.setAttribute('aria-pressed', String(Boolean(folder.pinned)));
    action('rename', 'Rename folder', () => editTitle(titleEl, folder.name, (name) => vscode.postMessage({ type: 'renameChatFolder', id: folder.id, name })));
    action('delete', 'Delete folder (keeps chats)', () => {
      expandedManageFolders.delete(folder.id);
      if (editingFolderChatsId === folder.id) editingFolderChatsId = null;
      vscode.postMessage({ type: 'deleteChatFolder', id: folder.id });
    }, 'is-danger');

    const chevron = document.createElement('span');
    chevron.className = 'history-folder-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = CHEVRON_SVG;

    head.append(thumb, info, actions, chevron);
    const toggle = (event) => {
      if (event?.target?.closest('.history-actions') || event?.target?.tagName === 'INPUT') return;
      if (expandedManageFolders.has(folder.id)) {
        expandedManageFolders.delete(folder.id);
        if (editingFolderChatsId === folder.id) editingFolderChatsId = null;
      } else {
        expandedManageFolders.add(folder.id);
      }
      renderHistory(historySessions, historyFolders);
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
      if (event.target === head && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); }
    });
    card.append(head);

    if (editingFolderChatsId === folder.id) {
      const editor = document.createElement('div');
      editor.className = 'history-folder-editor';
      const selected = new Set(folder.chatIds || []);
      const pickList = document.createElement('div');
      pickList.className = 'history-folder-pick-list';
      for (const session of allSessions.slice(0, 60)) {
        const option = document.createElement('label');
        option.className = 'history-folder-pick-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = selected.has(session.id);
        box.addEventListener('change', () => { if (box.checked) selected.add(session.id); else selected.delete(session.id); });
        const title = document.createElement('span');
        title.className = 'history-folder-pick-title';
        title.textContent = session.title || session.preview || 'New chat';
        option.append(box, title);
        const owner = folderOfChat.get(session.id);
        if (owner && owner.id !== folder.id) {
          const tag = document.createElement('span');
          tag.className = 'history-folder-pick-tag';
          tag.textContent = owner.name;
          option.append(tag);
        }
        pickList.append(option);
      }
      const footer = document.createElement('div');
      footer.className = 'history-folder-editor-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'cs-btn is-primary';
      saveBtn.textContent = 'Done';
      saveBtn.addEventListener('click', () => {
        editingFolderChatsId = null;
        vscode.postMessage({ type: 'setFolderChats', id: folder.id, chatIds: [...selected] });
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'cs-btn is-quiet';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        editingFolderChatsId = null;
        renderHistory(historySessions, historyFolders);
      });
      footer.append(saveBtn, cancelBtn);
      editor.append(pickList, footer);
      card.append(editor);
    }

    if (isExpanded) {
      const body = document.createElement('div');
      body.className = 'history-folder-body';
      if (visibleMembers.length) {
        const listWrap = document.createElement('div');
        listWrap.className = 'queue-list';
        for (const session of visibleMembers) listWrap.append(buildHistoryCard(session, folderOfChat, activeFolders));
        body.append(listWrap);
      } else if (editingFolderChatsId !== folder.id) {
        const empty = document.createElement('div');
        empty.className = 'history-folder-empty';
        empty.textContent = 'No chats in this folder yet.';
        const addLink = document.createElement('button');
        addLink.type = 'button';
        addLink.className = 'history-filter-reset';
        addLink.textContent = 'Add chats';
        addLink.addEventListener('click', () => {
          editingFolderChatsId = folder.id;
          renderHistory(historySessions, historyFolders);
        });
        empty.append(addLink);
        body.append(empty);
      }
      card.append(body);
    }

    card.addEventListener('dragover', (event) => {
      if (!draggedChatId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('is-drop-target');
    });
    card.addEventListener('dragleave', (event) => {
      if (!card.contains(event.relatedTarget)) card.classList.remove('is-drop-target');
    });
    card.addEventListener('drop', (event) => {
      card.classList.remove('is-drop-target');
      const chatId = draggedChatId || event.dataTransfer?.getData('text/plain');
      if (!chatId) return;
      event.preventDefault();
      event.stopPropagation();
      draggedChatId = null;
      expandedManageFolders.add(folder.id);
      vscode.postMessage({ type: 'setChatFolder', chatId, folderId: folder.id });
    });

    return card;
  }

  function buildHistoryCard(session, folderOfChat = new Map(), activeFolders = []) {
    const currentFolder = folderOfChat.get(session.id) || null;
    const folderSig = activeFolders.length ? [currentFolder?.id || '', activeFolders.map(f => `${f.id}:${f.name}`).join('|')] : '';
    const signature = JSON.stringify([session, currentChatId, railMarks, timeOptions(), folderSig]);
    const existing = reusableHistoryCards.get(session.id);
    if (existing?.dataset.signature === signature) return existing;
    const card = document.createElement('article');
    card.dataset.signature = signature;
    reusableHistoryCards.set(session.id, card);
    // The same look as the rail's Recent tiles: a chat bubble whose rim is white for the chat in this window, blue for
    // one that ran in the last minutes, orange when it waits for you; a running chat wears the orb on its top right.
    card.className = `history-card${session.state ? ` is-${session.state}` : ''}${session.active ? ' is-recent' : ''}${session.id === currentChatId ? ' is-current' : ''}`;
    card.dataset.id = session.id;
    if (activeFolders.length) {
      card.draggable = true;
      card.addEventListener('dragstart', (event) => {
        draggedChatId = session.id;
        card.classList.add('is-dragging');
        event.dataTransfer?.setData('text/plain', session.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        draggedChatId = null;
        card.classList.remove('is-dragging');
        historyModal.body.querySelectorAll('.is-drop-target, .is-drop-ungroup').forEach(el => el.classList.remove('is-drop-target', 'is-drop-ungroup'));
      });
    }
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
    // Every project the chat worked in, the latest first (they follow the chat as its tools touch other projects).
    const projectNames = session.projectNames?.length ? session.projectNames : [session.projectName].filter(Boolean);
    // Their icons lead the line (up to three, overlapping), the same marks as the rail's tiles.
    const projectIcons = [...new Set([...(session.touchedProjectIds || []), session.projectId])].map(id => railProjects.find(item => item.id === id)).filter(Boolean).slice(0, 3);
    if (projectIcons.length) {
      const icons = document.createElement('span');
      icons.className = 'history-project-icons'; icons.setAttribute('aria-hidden', 'true');
      for (const item of projectIcons) {
        const icon = document.createElement('span'); icon.className = 'history-project-icon'; icon.style.setProperty('--hue', projectHue(item.id));
        icon.append(projectMark(item)); icons.append(icon);
      }
      meta.append(icons);
    }
    if (projectNames.length) {
      const project = document.createElement('span');
      project.className = 'history-projects';
      project.textContent = projectNames.join(', ');
      project.title = projectNames.join('\n');
      meta.append(project);
    }
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
      btn.addEventListener('click', (event) => { event.stopPropagation(); handler(btn); });
      actions.append(btn);
      return btn;
    };
    if (session.state) action('stop', 'Stop', () => vscode.postMessage({ type: 'stopChat', id: session.id }));
    // Pin keeps the chat at the top of Manage Chats and of the rail's Recent list; it is also the mark of a pinned chat.
    const pin = action('pin', `${session.pinned ? 'Unpin' : 'Pin'} chat`, () => vscode.postMessage({ type: 'pinChat', id: session.id, pinned: !session.pinned }), 'is-pin');
    pin.setAttribute('aria-pressed', String(Boolean(session.pinned)));
    card.classList.toggle('is-pinned', Boolean(session.pinned));
    if (activeFolders.length) {
      const moveBtn = action('folder', currentFolder ? `Folder: ${currentFolder.name}` : 'Move to folder', (btn) => openChatFolderMenu(btn, session, currentFolder, activeFolders), currentFolder ? 'is-folder is-in-folder' : 'is-folder');
      moveBtn.setAttribute('aria-haspopup', 'menu');
      moveBtn.setAttribute('aria-expanded', 'false');
    }
    action('rename', 'Rename', () => editTitle(titleEl, session.title || session.preview || '', (title) => vscode.postMessage({ type: 'renameChat', id: session.id, title })));
    action('rename', 'Choose work category', () => vscode.postMessage({ type: 'setChatCategory', id: session.id }));
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
    window.shapeBubbleCard?.(card);
    return card;
  }

  function historySection(label, sessions, folderOfChat = new Map(), activeFolders = []) {
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
    for (const session of sessions) wrap.append(buildHistoryCard(session, folderOfChat, activeFolders));
    section.append(wrap);
    return section;
  }


  window.addEventListener('message', (event) => {
    const message = event.data;
    // Chat navigation reveals the thread instead of leaving a popup over it.
    if (message.type === 'chatLoading' || message.type === 'chatLoaded') {
      waitingToSend = null;
      promptInput.readOnly = false;
      document.querySelectorAll('.fs-modal:not([hidden])').forEach(closeModal);
    }
    if (logViewer?.handle(message)) return;
    switch (message.type) {
      case 'openLogs': if (logsModal.el.hidden) openLogs(message.level); break;
      case 'attachmentSaved': {
        if (message.requestId) { attachmentFinished(message.requestId, message.attachment); break; }
        if (message.chatId && message.chatId !== currentChatId) {
          const draft = chatDrafts.get(message.chatId) || { text: '', files: [], mentions: [] };
          draft.files.push(message.attachment); chatDrafts.set(message.chatId, draft);
        } else { attachments.push(message.attachment); renderAttachments(); }
        break;
      }
      case 'attachmentFailed': {
        if (!message.requestId) { showToast(message.error || 'Could not attach the file.', { error: true }); break; }
        attachmentFinished(message.requestId, null, message.error || 'Could not attach the image.');
        break;
      }
      case 'attachmentRenamed': {
        const at = attachments.findIndex((item) => item.path === message.from);
        if (at >= 0) {
          attachments[at] = { ...attachments[at], ...message.attachment, dims: attachments[at].dims };
          renderAttachments();
        }
        for (const chip of document.querySelectorAll('.attachment-chip')) {
          if (chip._attachment && (chip._attachment.path === message.from || chip._attachment.path === message.attachment?.path)) {
            Object.assign(chip._attachment, message.attachment, { dims: chip._attachment.dims });
            const img = chip.querySelector('img');
            if (img && message.attachment?.uri) img.src = message.attachment.uri;
            chip._syncChip?.();
          }
        }
        break;
      }
      case 'attachmentMarkedUp': {
        // The marked copy (or, with no marks left, the original) takes the old file's place in the composer.
        const at = attachments.findIndex((item) => item.path === message.from);
        if (at >= 0) { attachments[at] = message.attachment; renderAttachments(); }
        else if (message.chatId && message.chatId !== currentChatId) {
          const draft = chatDrafts.get(message.chatId), index = draft?.files.findIndex((item) => item.path === message.from) ?? -1;
          if (index >= 0) draft.files[index] = message.attachment;
        }
        break;
      }
      case 'attachmentCopied': {
        if (message.ok) showToast(`Copied ${message.name || 'image'} to clipboard.`);
        else showToast(message.error || 'Could not copy image to the clipboard.', { error: true });
        break;
      }
      case 'attachmentDownloaded': {
        if (message.name) showToast(`Saved ${message.name}`);
        break;
      }
      case 'history': {
        // A rename in progress would lose its text to a live refresh; its own save refreshes again.
        if (typeof message.chatFoldersEnabled === 'boolean') chatFoldersEnabled = message.chatFoldersEnabled;
        renderHistory(message.sessions, Array.isArray(message.folders) ? message.folders : []);
        railSessions = message.sessions || []; renderProjectList();
        break;
      }
      case 'project': {
        railProjectsLoaded = true;
        projectList.removeAttribute('aria-busy');
        projectBar.hidden = false;
        railProjects = message.projects || []; railActiveProject = message.project?.id || null; railChatId = message.chatId || railChatId;
        railPinnedProjects = (Array.isArray(message.pinnedProjectIds) ? message.pinnedProjectIds : [])
          .filter((id, index, ids) => railProjects.some(project => project.id === id) && ids.indexOf(id) === index).slice(0, 2);
        const tiles = projectList.isConnected && railProjects.length; // tiles and All projects cover it; the picker stays for an empty rail
        projectBtn.hidden = Boolean(tiles); projectBtn.textContent = message.project?.name || 'Choose project';
        renderProjectList();
        const marks = JSON.stringify(railProjects.map((item) => [item.id, item.name, item.iconUri]));
        if (marks !== railMarks) { railMarks = marks; window.dispatchEvent(new Event('rail-projects')); } // the Recent previews redraw their project icons
        if (historySessions.length && !historyModal.body.querySelector('input.title-edit')) renderHistory(historySessions, historyFolders); // the chats' project icons follow a rename or a new icon
        projectBtn.title = message.project ? (message.project.root || 'Planning project — attach a folder through Manage projects') : 'Select a project before sending this chat';
        projectBtn.classList.toggle('needs-project', Boolean(message.required));
        break;
      }
      case 'worktree': {
        const info = message.worktree;
        worktreeChip.hidden = !info;
        if (!info) break;
        const label = info.branch.replace(/^clanker\//, '');
        worktreeChip.querySelector('span').textContent = info.missing ? 'worktree missing' : `${label}${info.dirty ? ` · ${info.dirty}` : ''}`;
        if (info.dirty > 0 && !info.missing) worktreeChip.dataset.count = String(info.dirty); else delete worktreeChip.dataset.count;
        worktreeChip.classList.toggle('is-dirty', info.dirty > 0);
        worktreeChip.classList.toggle('is-missing', Boolean(info.missing));
        worktreeChip.title = info.missing ? `The worktree folder is gone: ${info.path}\nType /worktree remove to go back to the project folder.`
          : `This chat works in its own worktree on ${info.branch}\n${info.path}\n${info.dirty} uncommitted file${info.dirty === 1 ? '' : 's'}${info.ahead ? `, ${info.ahead} commit${info.ahead === 1 ? '' : 's'} ahead` : ''}`;
        break;
      }
      // Settings changed how many projects and chats the rail lists.
      case 'railLimits': window.RAIL_LIMITS = message.value; renderProjectList(); window.dispatchEvent(new Event('rail-limits')); break;
      case 'editorTheme': editorTheme = message.theme; void applyEditorTheme().catch(() => {}); break;
      // A chat switch has started: the old thread goes, shimmering placeholders stand in until chatLoaded renders the new one.
      case 'chatLoading': {
        historyStart = 0; historyUserStart = 0; loadingHistory = false; historyRequest++;
        settleFindLoad(false);
        isChatSwitching = true;
        chatLoadingQueueCount = message.queueCount === null ? null : Math.max(0, Number(message.queueCount) || 0);
        renderTurnQueue();
        renderScheduleTime();
        pendingAssistantBodies.clear();
        resetVoiceCorrections(); lastVoiceDraft = null;
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
      case 'chatSynced':
      case 'chatLoaded': {
        if (message.type === 'chatSynced' && message.chat?.id !== currentChatId) break;
        isChatSwitching = false;
        if (message.chat?.id !== currentChatId) {
          resetVoiceCorrections(); lastVoiceDraft = null; dismissedVoiceTerms.clear();
          if (editingQueue) finishQueueEdit();
          if (currentChatId) chatDrafts.set(currentChatId, { text: promptInput.value, files: attachments.slice(), mentions: [...mentioned] });
          const draft = chatDrafts.get(message.chat?.id);
          promptInput.value = draft?.text ?? message.chat?.draft ?? '';
          attachments = draft?.files || message.chat?.draftFiles || [];
          mentioned.clear();
          for (const mention of draft?.mentions || []) mentioned.add(mention);
          workspaceFiles = null; workspaceRoot = '';
          currentChatId = message.chat?.id;
          closeSlashMenu(); renderAttachments(); renderMentions(); autoGrow();
        }
        // The extension keeps every chat's queue running, independently of the visible thread.
        awaitingInterruptAck = false;
        const state = vscode.getState();
        // Migrate all old queues, including chats not currently shown. A host acknowledgement removes each old copy.
        const legacy = { ...state?.queues };
        if (state?.queue?.chatId && !legacy[state.queue.chatId]) legacy[state.queue.chatId] = state.queue.turns;
        for (const [chatId, turns] of Object.entries(legacy)) if (Array.isArray(turns) && turns.length) vscode.postMessage({ type: 'importTurnQueue', chatId, turns });
        turnQueue = receiveQueueTurns(message.chat?.turnQueue?.turns, currentChatId);
        receiveQueueOrder(message.chat?.turnQueue?.order);
        queuePaused = message.chat?.turnQueue?.paused === true;
        const pendingScheduled = message.chat?.scheduledPending;
        chatLoadingQueueCount = !schedulerQueueLoaded && (pendingScheduled === null || (typeof pendingScheduled === 'number' && pendingScheduled > 0)) ? pendingScheduled : 0;
        busy = false;
        resetThought();
        resetAgents(); // the new chat's own agents follow in a subagentReplay
        restoreChat(message.chat, message.running, message.type === 'chatSynced');
        chatFind?.reset(); // matches belong to the chat on screen
        renderTurnQueue();
        restoreAgents();
        setBusy(Boolean(message.running));
        break;
      }
      case 'chatHistory': prependHistory(message); break;
      case 'findResults': if (message.chatId === currentChatId) chatFind?.onResults(message); break;
      case 'toolOutput': receiveToolOutput(message); break;
      case 'filePreview': {
        const resolve = previewWaiting.get(message.requestId);
        previewWaiting.delete(message.requestId);
        resolve?.(message);
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
        turnQueue = receiveQueueTurns(message.turns, currentChatId);
        receiveQueueOrder(message.order);
        for (const warning of transcriptEl.querySelectorAll('.queue-usage-warning')) if (!turnQueue.some(turn => turn.id === warning.dataset.queueId)) warning.remove();
        for (const button of transcriptEl.querySelectorAll('.continue-at-reset')) if (hasQueuedContinue(button.dataset.resetAgent)) button.remove();
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
        tickQueueCountdown();
        for (const quota of modelMenu.querySelectorAll('.model-group-head')) {
          const agent = quota.parentElement.querySelector('.model-option')?.dataset.agent;
          quota.querySelector('.model-group-quota').textContent = quotaText(agent);
        }
        // Usage is back: a limit this session no longer holds, and an unused "Continue when … resets"
        // has nothing left to wait for.
        for (const agent of AGENT_IDS) {
          if (!hasHeadroom(agent)) continue;
          limitHitAgents.delete(agent);
          transcriptEl.querySelectorAll(`.continue-at-reset[data-reset-agent="${agent}"]:not(:disabled)`).forEach((btn) => {
            if (agent === 'gemini' && limitActive(btn.closest('.msg-assistant')?.dataset.raw) === true) return;
            btn.remove();
          });
        }
        refreshScheduleDefault();
        break;
      }
      case 'setActive': {
        selectModel(message.modelId, { notifyExtension: false });
        break;
      }
      case 'micState': applyMicState(message); break;
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
        if (window.VOICE_SILENCE_MS && !voiceHold && !voiceStopSent && speechMs >= VOICE_MIN_SPEECH_MS && now - lastSpeechAt > window.VOICE_SILENCE_MS) {
          voiceStopSent = true;
          vscode.postMessage({ type: 'micToggle' });
        }
        break;
      }
      case 'voiceError': {
        showToast(message.message || 'Voice input failed.', { error: true });
        break;
      }
      // Dictation never selects a model or sends: routing runs when the draft is submitted.
      case 'voiceResult': {
        const text = message.output?.cleanedPrompt || '';
        if (message.warning) showToast(message.warning, { error: true });
        if (text) {
          resetVoiceCorrections(); dismissedVoiceTerms.clear();
          const { prefix, suffix } = insertVoiceDraft(text);
          lastVoiceDraft = { original: text, prefix, suffix, raw: message.rawTranscript || '' };
        }
        break;
      }
      case 'polishResult': {
        if (message.requestId !== polishRequest) break;
        setPolishing(false);
        if (message.error) { showToast(message.error, { error: true }); break; }
        if (message.text && message.text !== promptInput.value) { applyPolished(message.text); showToast('Prompt polished. Ctrl+Z restores what you wrote.'); }
        else showToast('Nothing to improve. The prompt is already clear.');
        break;
      }
      case 'voiceDictionarySuggestions': {
        if (message.requestId === voiceEditRequest) showVoiceCorrections(message.terms || []);
        break;
      }
      case 'voiceTermsLearned': {
        if (message.terms?.length) showToast(`Added to voice dictionary: ${message.terms.join(', ')}`);
        // Rows are matched by word: typing after the countdown started bumps the request id but the save is still theirs.
        for (const row of [...voiceDictionaryBud.children]) if (message.terms?.includes(row.dataset.term)) row.remove();
        voiceDictionaryBud.hidden = !voiceDictionaryBud.childElementCount;
        break;
      }
      case 'voiceDictionaryError': {
        showToast(message.message, { error: true });
        const row = [...voiceDictionaryBud.children].find(row => row.dataset.term === message.term);
        if (row) {
          row.dataset.state = 'error'; row.style.setProperty('--dictionary-remaining', '0');
          row.querySelector('.voice-dictionary-label').textContent = `Could not add “${message.term}” to dictionary`;
          row.querySelector('.voice-dictionary-retry').hidden = false;
          row.querySelector('.voice-dictionary-cancel').disabled = false;
        }
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
        if (message.routingConfig || message.closeSettings) closeModal(settingsModal.el);
        if (message.closeLogs) closeModal(logsModal.el);
        if (editingQueue) finishQueueEdit();
        promptInput.value = message.text || '';
        if (Array.isArray(message.files)) { attachments = message.files; renderAttachments(); }
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
        editQueuePrompt({ text, files, modelId: message.modelId }, message.taskId, { chooseModel: Boolean(message.chooseModel), schedule: message.schedule });
        if (message.chooseModel) openModelMenu();
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
        foldThought({ immediate: true });
        appendAssistantDelta(message.text, message.model || turnRoutedAgent, turnModelLabel, turnRoleName);
        break;
      }
      case 'tool_start': {
        if (isCompacting) break;
        const isTodo = toolKind(message.name) === 'todo';
        if (isTodo) {
          foldThought();
          foldToolSteps();
        } else {
          settleThought();
        }
        noteWorkingFile(message.file);
        openToolCard = appendToolCard({ name: message.name, command: message.command || message.file, intent: message.summary, output: { text: '' }, toolId: message.toolId, done: message.done, diff: message.diff, startedAt: message.startedAt, durationMs: message.durationMs });
        if (isTodo && openToolCard) {
          openToolCard.open = true;
          openThought = { fold: openToolCard, body: openToolCard.querySelector('.tool-body'), isCard: true };
          ensureToolView(openToolCard);
          syncPending();
        }
        break;
      }
      case 'tool_end': {
        if (isCompacting) break;
        const card = message.toolId ? toolCards.get(message.toolId) : openToolCard;
        finishToolCard(card, { output: message.output, error: message.error, durationMs: message.durationMs });
        if (card === openToolCard) openToolCard = null;
        break;
      }
      case 'tool_progress': {
        if (!isCompacting) updateToolProgress(toolCards.get(message.toolId), message);
        break;
      }
      case 'question_required': {
        appendQuestionCard({ ...message, questions: Array.isArray(message.questions) ? message.questions : [] });
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
      case 'toast': {
        if (message.text) showToast(String(message.text), { error: message.error === true });
        break;
      }
      case 'queueUsageWarning': {
        if (message.chatId && message.chatId !== currentChatId) break;
        let warning = [...transcriptEl.querySelectorAll('.queue-usage-warning')].find(el => el.dataset.queueId === message.id);
        if (!warning) {
          warning = document.createElement('div');
          warning.className = 'queue-usage-warning';
          warning.dataset.queueId = message.id;
          warning.setAttribute('role', 'alert');
          warning.innerHTML = `${WARN_SVG}<span></span><button type="button" class="context-compact">Schedule at reset</button>`;
          warning.querySelector('button').addEventListener('click', () => queueAction('scheduleQueuedTurn', { id: message.id, agent: message.agent }));
          transcriptEl.append(warning);
        }
        warning.querySelector('span').textContent = message.text;
        const last = [...transcriptEl.querySelectorAll('.msg-assistant')].pop();
        if (last && isLimitNotice(last.dataset.raw)) {
          turnRoutedAgent = message.agent || lastReplyAgent();
          offerContinueAtReset(last);
        }
        scrollTranscriptToEnd();
        break;
      }
      // The queue is waiting for a signed-out CLI (lib/auth-gate.js): what is wrong, the button that fixes it, and a re-check.
      case 'authHold': {
        if (message.chatId && message.chatId !== currentChatId) break;
        renderAuthHold(message);
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
      case 'contextReset': {
        appendContextReset(message);
        break;
      }
      case 'compacting': {
        // The handoff streams invisibly; its thinking and compaction share one live status.
        nextUserIndex++;
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
        renderContextGauge({ agent: message.agent, tokens: message.contextTokens, limit: message.contextWindow, estimated: message.estimated });
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
        for (const [id, card] of pendingCards) { if (card.dataset.deferred === 'true') continue; settleCard(card, 'Turn ended', 'denied'); pendingCards.delete(id); }
        if (!completedCompaction) {
          document.querySelectorAll('.tool-card.is-running').forEach((card) => {
            finishToolCard(card, { output: rawToolOutput(card) });
            if (message.interrupted) card.classList.add('is-cancelled');
          });
          foldThought({ immediate: true });
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
        if (!isCompacting && !message.compact && currentTurnEl?.isConnected && turnRoutedAgent) ensureTurnRole(turnRoutedAgent, turnModelLabel, turnRoleName);
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
        if (message.tab === 'loops') { openLoops(); break; } // older commands still reach the moved popup
        if (message.updateAll) {
          openModal(settingsModal);
          chatSettings.showTab('general');
          settingsModal.el.querySelector('.fs-modal-body').scrollTop = 0;
          vscode.postMessage({ type: 'requestFleet' });
          vscode.postMessage({ type: 'updateAllClis' });
        } else if (message.tab) {
          // Asked for by tab (a command): open it, never toggle it shut.
          if (settingsModal.el.hidden) openModal(settingsModal);
          vscode.postMessage({ type: 'requestFleet' });
          chatSettings.showTab(message.tab);
        } else if (toggleModal(settingsModal)) {
          vscode.postMessage({ type: 'requestFleet' });
        }
        break;
      case 'routingMode': setRoutingMode(message.mode, message.connected); break;
      case 'fleet': chatSettings.fleet(message); receivePermission({ mode: message.services?.permissionMode }); break;
      case 'permission': receivePermission(message); break;
      case 'apiValue': chatSettings.apiValue(message); break;
      case 'voice': chatSettings.voice(message.voice); break;
      case 'toolPrefs': TOOL_PREFS.openFailed = message.openFailed === true; break;
      case 'micDevices': chatSettings.micDevices(message.devices, message.automatic); break;
      case 'projectIcons': chatSettings.projectIcons(message.projects); break;
      case 'voiceDictionary': chatSettings.voiceDictionary(message); break;
      case 'groqResult': chatSettings.groqResult(message); break;
      case 'routingResult': chatSettings.routingResult(message); break;
      case 'openLoops': openLoops(); break;
      case 'investigationsResult': case 'investigationsState': investigations.message(message); break;
      case 'cliStatus': chatSettings.cliStatus(message); receivePermission({ models: message.modelSettings || {} }); break;
      case 'cliConnections':
        chatSettings.cliConnections(message);
        cliSetup.update(message);
        if (message.setupNeeded && !cliSetupSeen) { cliSetupSeen = true; openModal(cliSetupModal); }
        break;
      case 'modelPrompts': modelPromptIds = new Set(message.models || []); break;
      // Settings and the picker share discovered names. A restored chat keeps
      // its exact model even when that model is not currently favorited.
      case 'modelCatalog':
        window.MODEL_CATALOG = message.catalog;
        MODEL_OPTIONS.splice(1, MODEL_OPTIONS.length, ...message.catalog); // the menu re-renders each time it opens
        availableModels = message.available || [];
        selectModel(pendingModelId || activeModelId, { notifyExtension: Boolean(pendingModelId && optionFor(pendingModelId)) });
        // Its CLI was removed or turned unavailable (plan ended, credits out): Auto instead of a model that can no longer be used.
        if (pendingModelId && availableModels.length && !optionFor(pendingModelId)) selectModel('auto');
        if (menuOpen()) renderModelMenu();
        if (!queueStrip.querySelector('.is-dragging')) renderTurnQueue();
        break;
      case 'schedulerQueue': {
        schedulerQueueLoaded = true;
        chatLoadingQueueCount = 0;
        schedulerTasks = Array.isArray(message.queue) ? message.queue : [];
        for (const button of transcriptEl.querySelectorAll('.continue-at-reset')) if (hasQueuedContinue(button.dataset.resetAgent)) button.remove();
        renderQueueButton();
        if (!queueStrip.querySelector('.is-dragging')) renderTurnQueue();
        if (!queueModal.el.hidden && !queueModal.el.querySelector('textarea, .is-dragging')) renderQueue();
        break;
      }
      // A turn that didn't come from this composer (a scheduled prompt, Remote Control): your bubble.
      case 'undoOffer': offerUndo(Number(message.count) || 0, message.diff); break;
      case 'droid': playDroid(message.kind); break;
      case 'verifyInfo': verifyCommand = message.command || ''; renderVerify(); break;
      case 'userMessage': {
        if (/^\s*continue\s*[.!]?\s*$/i.test(message.text || '')) {
          continueSentAfterLimit = true;
          transcriptEl.querySelectorAll('.continue-at-reset').forEach(button => button.remove());
        }
        appendUserMessage(message.text || '', message.at || undefined, message.files || [], { scheduled: message.scheduled, clientTurnId: message.clientTurnId, background: isBackgroundPrompt(message), contextHandoff: message.contextHandoff });
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
        for (const button of transcriptEl.querySelectorAll('.continue-at-reset')) {
          button.disabled = false;
          button.querySelector('span').textContent = `Continue when ${AGENT_LABELS[button.dataset.resetAgent]} resets`;
        }
        showToast(message.error || 'Could not schedule task.', { error: true });
        break;
      }
      default:
        break;
    }
  });

  // Skeleton rows for a queue that is still loading; drawn here because renderTurnQueue needs state declared further down.
  if (loadingQueueCount() > 0) renderTurnQueue();
  window.CLANKER_UI_INITIALIZED = true;
  vscode.postMessage({ type: 'chatReady' });
  vscode.postMessage({ type: 'requestQuotas' });
  vscode.postMessage({ type: 'requestProject' });
  vscode.postMessage({ type: 'requestCliConnections' });
})();
