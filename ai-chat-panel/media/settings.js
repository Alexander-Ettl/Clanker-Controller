/**
 * Chat Settings: the popup (opened from the launcher's gear). Four tabs so nothing is a wall of rows:
 * General (CLI accounts, Groq API, permissions, time format, terminal), Models (favorite models), Voice (dictation
 * hotkey and sounds) and Remote (Telegram, tunnel). main.js gives it a modal body; the extension answers its messages
 * (the launcher's handler, replying into the chat window).
 */
(function () {
  'use strict';

  // Providers are the extension's registry (lib/providers), injected as window.PROVIDERS; this fallback is for a bare page.
  const REGISTRY = window.PROVIDERS || [
    { id: 'claude', name: 'Claude Code', cli: 'claude', company: 'Anthropic' },
    { id: 'codex', name: 'Codex', cli: 'codex', company: 'OpenAI' },
    { id: 'gemini', name: 'Antigravity', accountName: 'Gemini / Antigravity', cli: 'agy', company: 'Google' },
    { id: 'copilot', name: 'GitHub Copilot', cli: 'copilot', company: 'GitHub', optional: true },
  ];
  const CLI_NAMES = Object.fromEntries(REGISTRY.map((provider) => [provider.id, provider.cli]));
  const PROVIDERS = window.PROVIDER_IDS || ['claude', 'codex', 'gemini', 'copilot']; // from the extension's registry (agent-icons.js)

  const svg = (paths) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    globe: svg('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.7 1.6 2.5 3.4 2.5 5.5S9.7 11.9 8 13.5M8 2.5C6.3 4.1 5.5 5.9 5.5 8s.8 3.9 2.5 5.5"/>'),
    folder: svg('<path d="M2 5.2A1.7 1.7 0 0 1 3.7 3.5h2.2l1.4 1.6h5A1.7 1.7 0 0 1 14 6.8v4.5a1.7 1.7 0 0 1-1.7 1.7H3.7A1.7 1.7 0 0 1 2 11.3z"/>'),
    loop: svg('<path d="M3 7.5V7a2.5 2.5 0 0 1 2.5-2.5H13M10.5 2l2.5 2.5-2.5 2.5M13 8.5V9a2.5 2.5 0 0 1-2.5 2.5H3M5.5 9 3 11.5 5.5 14"/>'),
    clock: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.1 1.3"/>'),
    terminal: svg('<path d="M3 4.5 6.5 8 3 11.5M8 11.5h5"/>'),
    telegram: svg('<path d="M14 2 2 6.8l4.6 2 2 4.6z"/><path d="M6.6 8.8 14 2"/>'),
    tunnel: svg('<path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.6 1 2.6 2.6 0 0 1-.3 5z"/>'),
    refresh: svg('<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>'),
    server: svg('<rect x="2.5" y="3" width="11" height="4" rx="1.2"/><rect x="2.5" y="9" width="11" height="4" rx="1.2"/><path d="M5 5h.01M5 11h.01"/>'),
    shield: svg('<path d="M8 2.2 3 4.2v4.3c0 3.3 2.1 6.3 5 7.3 2.9-1 5-4 5-7.3V4.2z"/>'),
    note: svg('<path d="M3 4.5h10M3 8h10M3 11.5h6"/>'),
    heart: svg('<path d="M8 13.6S2.2 10.2 2.2 6.3A3.1 3.1 0 0 1 8 4.8a3.1 3.1 0 0 1 5.8 1.5c0 3.9-5.8 7.3-5.8 7.3z"/>'),
    search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'),
    close: svg('<path d="m4.5 4.5 7 7m0-7-7 7"/>'),
    mic: svg('<rect x="6" y="2" width="4" height="7" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2"/>'),
    key: svg('<circle cx="5.5" cy="10.5" r="2.5"/><path d="m7.3 8.7 6.2-6.2M11 5l1.8 1.8M9.5 6.5l1.5 1.5"/>'),
    chart: svg('<path d="M3 13V8M8 13V3M13 13V6"/>'),
    sound: svg('<path d="M3 6.5h2L8 4v8L5 9.5H3zM10.5 6a3 3 0 0 1 0 4M12 4.5a5.5 5.5 0 0 1 0 7"/>'),
    hold: svg('<path d="M8 2.5v6M5.5 6 8 8.5 10.5 6M3.5 11.5h9"/>'),
    trash: svg('<path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.4M6.75 7v4M9.25 7v4"/>'),
    up: svg('<path d="M8 13V3M4 7l4-4 4 4"/>'),
    plug: svg('<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0zM8 11.2v2.3"/>'),
    sliders: svg('<path d="M3 5h6M12 5h1M3 11h1M7 11h6"/><circle cx="10.5" cy="5" r="1.5"/><circle cx="5.5" cy="11" r="1.5"/>'),
    reset: svg('<path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.8v2.6h2.6"/>'),
    cube: svg('<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5zM2.7 5.1 8 8.2l5.3-3.1M8 8.2v6"/>'),
    check: svg('<path d="m3.5 8.5 3 3 6-7"/>'),
    route: svg('<circle cx="4" cy="4" r="1.6"/><circle cx="12" cy="12" r="1.6"/><path d="M5.6 4h3.4a2.5 2.5 0 0 1 0 5H7a2.5 2.5 0 0 0 0 5h3.4"/>'),
    bolt: svg('<path d="M9 1.8 3.5 9H8l-1 5.2L12.5 7H8z"/>'),
    ext: svg('<path d="M9 3h4v4M13 3 7.5 8.5M11 9v3.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1H7"/>'),
    lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.6"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>'),
    image: svg('<rect x="2.5" y="3" width="11" height="10" rx="2"/><circle cx="6" cy="6.5" r="1.1"/><path d="m3 12 3.5-3.2 2.5 2.2 1.5-1.4 3 2.4"/>'),
    layers: svg('<path d="m8 2.5 5.5 3L8 8.5l-5.5-3zM2.5 8.2 8 11.2l5.5-3M2.5 10.8 8 13.8l5.5-3"/>'),
    gauge: svg('<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11 10.5 6.5"/>'),
    chevron: svg('<path d="m4 6 4 4 4-4"/>'),
    down: svg('<path d="M8 3v10M4 9l4 4 4-4"/>'),
    book: svg('<path d="M3.5 3.2h6.3a2 2 0 0 1 2 2v8.1H5.5a2 2 0 0 1-2-2zM3.5 11.3a2 2 0 0 1 2-2h6.3"/>'),
    plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
    pencil: svg('<path d="m10.2 3.3 2.5 2.5M3 13l.6-2.8 7-7 2.2 2.2-7 7z"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1"/>'),
  };

  // A provider's logo (agent-icons.js) for headings and labels; '' for one without.
  const LOGO = new Proxy({}, { get: (_, agent) => window.AGENT_ICONS?.[agent] || '' });
  const CLI_LABELS = Object.fromEntries(REGISTRY.map((provider) => [provider.id, provider.accountName || provider.name]));
  const COMPANIES = Object.fromEntries(REGISTRY.map((provider) => [provider.id, provider.company]));
  function connectionDetails(connection = {}) {
    const ready = ['connected', 'ready'].includes(connection.auth);
    return {
      ready,
      tag: !connection.enabled ? 'Not added' : ready ? connection.auth === 'ready' ? 'Ready' : 'Connected' : connection.settingUp ? 'Setting up' : !connection.installed ? 'Not installed' : connection.auth === 'broken' ? 'Broken' : 'Sign in',
      action: connection.settingUp && !ready ? 'Open setup' : !connection.installed ? 'Install & sign in' : connection.auth === 'broken' ? 'Repair & sign in' : ready ? 'Add CLI' : 'Sign in / Sign up',
      description: connection.note || (connection.auth === 'ready' ? 'CLI is ready. Complete Google sign-in in its terminal if prompted.' : ready ? 'Account connected on this computer.' : ''),
    };
  }
  function connectionActions(agent, connection, vscode) {
    const details = connectionDetails(connection);
    const actions = document.createElement('div');
    actions.className = 'cs-actions cs-connection-actions';
    const button = (label, type, className = '') => {
      const el = document.createElement('button');
      el.type = 'button'; el.className = `cs-btn ${className}`; el.textContent = label;
      el.addEventListener('click', () => vscode.postMessage({ type, agent }));
      actions.append(el);
    };
    if (!connection.enabled || !details.ready) button(details.action, 'connectCli', 'is-primary');
    if (connection.enabled) button('Remove', 'removeCli', 'is-quiet');
    return actions;
  }

  window.initCliSetup = function ({ vscode, body, onClose, onOpenSettings, onStartOnboardingChat, onModelsStep }) {
    body.classList.add('cs', 'cs-setup');
    body.innerHTML = `<div class="cs-setup-step" data-role="setupConnections"><p class="cs-note">Step 1 of 2 · Connect your CLIs</p><div class="cs-setup-hero"><span class="cs-setup-mark"><img src="${window.CLANKER_MARK || ''}" alt="" /></span><h2>Your models. One place.</h2><p>Connect the CLIs you use — Claude Code, Codex, Antigravity, or GitHub Copilot — then choose your favorite models.</p></div>
      <div class="cs-setup-tools"><button class="cs-btn is-primary" data-role="connectAll" type="button">Set up all</button><button class="cs-btn" data-role="checkConnections" type="button">${ICON.refresh}<span>Check connections</span></button></div>
      <div class="cs-setup-providers" data-role="setupProviders"></div>
      <p class="cs-note cs-setup-note" role="status" data-role="setupProgress">Choose a provider to get started.</p>
      <section class="cs-card cs-setup-extras" data-role="setupExtras">
        <div class="cs-row">
          <span class="cs-icon">${ICON.mic}</span>
          <div class="cs-info"><span class="cs-title">Voice dictation (Groq)</span><span class="cs-desc">Free global hotkey, Whisper transcription, and custom dictionary.</span></div>
          <button class="cs-btn is-small" data-role="setupOpenVoice" type="button">Voice</button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.route}</span>
          <div class="cs-info"><span class="cs-title">Smart routing (Cloudflare + Groq)</span><span class="cs-desc">Free Auto mode that picks the best CLI model for each prompt.</span></div>
          <button class="cs-btn is-small" data-role="setupOpenRouting" type="button">Routing</button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.bolt}</span>
          <div class="cs-info"><span class="cs-title">Guided AI setup &amp; Copilot fine-tuning</span><span class="cs-desc">Prepares a chat prompt briefed on Clanker settings and provider descriptors.</span></div>
          <button class="cs-btn is-small is-primary" data-role="setupWithAi" type="button">Set up with AI</button>
        </div>
      </section>
      <div class="cs-setup-footer"><button class="cs-btn is-quiet" data-role="setupLater" type="button">Set up later</button><button class="cs-btn is-primary" data-role="setupContinue" type="button" disabled>Next: favorite models</button></div></div>
      <div class="cs-setup-step cs-setup-models" data-role="setupModels" hidden>
        <p class="cs-note">Step 2 of 2 · Favorite models</p><h2>Choose your favorite models</h2>
        <p class="cs-note">Use the hearts to choose the models you want in your chat picker. You can change them later in Settings.</p>
        <div data-role="setupModelPicker"></div>
        <div class="cs-setup-footer"><button class="cs-btn" data-role="setupBack" type="button">Back</button><button class="cs-btn is-primary" data-role="setupFinish" type="button" disabled>Start chatting</button></div>
      </div>`;
    const $ = role => body.querySelector(`[data-role="${role}"]`);
    $('connectAll').addEventListener('click', () => vscode.postMessage({ type: 'connectAllClis' }));
    $('checkConnections').addEventListener('click', () => vscode.postMessage({ type: 'checkCliConnections' }));
    $('setupOpenVoice').addEventListener('click', () => {
      if (onOpenSettings) onOpenSettings('voice');
      else vscode.postMessage({ type: 'openSettings', tab: 'voice' });
    });
    $('setupOpenRouting').addEventListener('click', () => {
      if (onOpenSettings) onOpenSettings('routing');
      else vscode.postMessage({ type: 'openSettings', tab: 'routing' });
    });
    $('setupWithAi').addEventListener('click', () => {
      if (onStartOnboardingChat) onStartOnboardingChat();
      else vscode.postMessage({ type: 'startOnboardingChat' });
    });
    $('setupLater').addEventListener('click', onClose);
    function showStep(models) {
      $('setupConnections').hidden = models;
      $('setupModels').hidden = !models;
      onModelsStep?.(models ? $('setupModelPicker') : null);
      body.scrollTop = 0;
      if (models) $('setupModels').querySelector('input')?.focus();
      else $('setupContinue').focus();
    }
    $('setupContinue').addEventListener('click', () => showStep(true));
    $('setupBack').addEventListener('click', () => showStep(false));
    $('setupFinish').addEventListener('click', onClose);
    return {
      show: () => showStep(false),
      update(snapshot) {
        const providers = snapshot.providers || {};
        const total = PROVIDERS.length;
        const ready = PROVIDERS.filter(agent => providers[agent]?.enabled && connectionDetails(providers[agent]).ready).length;
        $('setupContinue').disabled = ready === 0 || snapshot.checking;
        $('setupFinish').disabled = ready === 0 || snapshot.checking;
        $('connectAll').disabled = ready === total || snapshot.checking;
        $('checkConnections').disabled = snapshot.checking;
        $('checkConnections').querySelector('span').textContent = snapshot.checking ? 'Checking…' : 'Check connections';
        $('setupProgress').textContent = snapshot.checking ? 'Checking your CLI connections…' : ready ? `${ready} of ${total} CLIs ready. You can add or fine-tune the others in Settings whenever you like.` : 'Finish sign-in, then check connections. One CLI is enough to start.';
        $('setupProviders').replaceChildren(...PROVIDERS.map(agent => {
          const connection = providers[agent] || {};
          const details = connectionDetails(connection);
          const card = document.createElement('section');
          card.className = 'cs-card cs-provider'; card.dataset.agent = agent;
          card.innerHTML = `<div class="cs-row"><span class="cs-icon">${window.AGENT_ICONS?.[agent] || ICON.terminal}</span><div class="cs-info"><span class="cs-title">${CLI_LABELS[agent]}</span><span class="cs-desc">${COMPANIES[agent]}</span></div><span class="cs-tag"></span></div><p class="cs-connection-note"></p>`;
          const tag = card.querySelector('.cs-tag');
          tag.textContent = details.tag;
          tag.classList.toggle('is-ok', connection.enabled && details.ready);
          card.querySelector('.cs-connection-note').textContent = details.description;
          card.querySelector('.cs-connection-note').hidden = !details.description;
          card.append(connectionActions(agent, connection, vscode));
          return card;
        }));
      },
    };
  };

  const MARKUP = `
    <div class="cs-settings-search" data-role="settingsSearchBox">
      <div class="cs-settings-search-field">${ICON.search}<input data-role="settingsSearch" type="search" role="combobox" aria-label="Search settings" aria-autocomplete="list" aria-expanded="false" aria-controls="cs-settings-search-results" placeholder="Search settings…" autocomplete="off" spellcheck="false"><button class="cs-icon-btn" data-role="settingsSearchClear" type="button" aria-label="Clear settings search" hidden>${ICON.close}</button></div>
      <div class="cs-settings-search-results" id="cs-settings-search-results" data-role="settingsSearchResults" role="listbox" aria-label="Matching settings" hidden></div>
      <p class="cs-settings-search-status" data-role="settingsSearchStatus" role="status" hidden></p>
    </div>
    <div class="cs-tabs pill-track" role="tablist" aria-label="Clanker Controller settings">
      <button class="cs-tab" role="tab" data-tab="general" aria-selected="true" aria-label="General" title="General" type="button">${ICON.sliders}<span>General</span></button>
      <button class="cs-tab" role="tab" data-tab="models" aria-selected="false" aria-label="Models" title="Models" type="button">${ICON.cube}<span>Models</span></button>
      <button class="cs-tab" role="tab" data-tab="routing" aria-selected="false" aria-label="Routing" title="Routing" type="button">${ICON.server}<span>Routing</span></button>
      <button class="cs-tab" role="tab" data-tab="voice" aria-selected="false" aria-label="Voice" title="Voice" type="button">${ICON.mic}<span>Voice</span></button>
      <button class="cs-tab" role="tab" data-tab="remote" aria-selected="false" aria-label="Remote" title="Remote" type="button">${ICON.tunnel}<span>Remote</span></button>
      <button class="cs-tab" role="tab" data-tab="loops" aria-selected="false" aria-label="Loops" title="Loops" type="button">${ICON.loop}<span>Loops</span></button>
    </div>

    <div class="cs-pane" data-pane="general" role="tabpanel">
      <section class="cs-card">
        <div class="cs-row">
          <span class="cs-icon">${ICON.shield}</span>
          <div class="cs-info">
            <span class="cs-title">Permissions</span>
            <span class="cs-desc" data-role="permissionDesc">Execution permissions for Claude, Codex, and Gemini.</span>
          </div>
          <div class="permission-mode-picker pill-track" role="radiogroup" aria-label="Permission mode">
            <button class="permission-pill" data-mode="ask" type="button" title="Ask when the provider can show approval prompts; headless Gemini skips blocked actions">Ask</button>
            <button class="permission-pill" data-mode="auto" type="button" title="Automated safety classifier where supported">Auto</button>
            <button class="permission-pill" data-mode="fullAccess" type="button" title="Full execution access without confirmation prompts">Full Access</button>
          </div>
        </div>
        <div class="cs-permission-support" data-role="permissionSupport">
          <div class="cs-support-item">
            <span class="cs-support-name" data-agent="claude">${LOGO.claude}Claude Code</span>
            <span class="cs-support-status is-ok" data-role="claudePerm">Supported</span>
          </div>
          <div class="cs-support-item">
            <span class="cs-support-name" data-agent="codex">${LOGO.codex}Codex</span>
            <span class="cs-support-status is-ok" data-role="codexPerm">Supported</span>
          </div>
          <div class="cs-support-item">
            <span class="cs-support-name" data-agent="gemini">${LOGO.gemini}Gemini (Antigravity)</span>
            <span class="cs-support-status" data-role="geminiPerm">Supported</span>
          </div>
        </div>
      </section>

      <section class="cs-card">
        <div class="cs-row">
          <span class="cs-icon">${ICON.clock}</span>
          <div class="cs-info"><span class="cs-title">Time format</span><span class="cs-desc">Timestamps in chats and the queue.</span></div>
          <div class="time-format-picker pill-track" role="radiogroup" aria-label="Time format">
            <button class="format-pill" data-format="24h" type="button">24h</button>
            <button class="format-pill" data-format="12h" type="button">12h</button>
            <button class="format-pill" data-format="auto" type="button">Auto</button>
          </div>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.note}</span>
          <div class="cs-info"><span class="cs-title">Chat names</span><span class="cs-desc">Agent: use the name the agent writes itself. Antigravity does; Claude Code and Codex don't for chats run here, so Groq names those. Groq: always name chats with Groq.</span></div>
          <div class="chat-names-picker pill-track" role="radiogroup" aria-label="Chat names">
            <button class="names-pill" data-names="agent" type="button" title="The agent's own title where it writes one, Groq otherwise">Agent</button>
            <button class="names-pill" data-names="groq" type="button" title="Always name chats with Groq">Groq</button>
          </div>
        </div>
        <div class="cs-row cs-row-wrap">
          <span class="cs-icon">${ICON.chart}</span>
          <div class="cs-info"><span class="cs-title">Antigravity usage circle</span><span class="cs-desc">What the Gemini circle in the launcher draws. Hovering it still lists every group.</span></div>
          <div class="ring-source-picker pill-track" role="radiogroup" aria-label="Antigravity usage circle">
            <button class="ring-source-pill" data-ring="split" type="button" title="Two half circles: Gemini models and Gemini 4 Argon">Split</button>
            <button class="ring-source-pill" data-ring="argon" type="button" title="Gemini 4 Argon, 7-day window">Argon 7d</button>
            <button class="ring-source-pill" data-ring="gemini" type="button" title="Gemini models, 5h and 7d">Gemini</button>
            <button class="ring-source-pill" data-ring="claude-gpt" type="button" title="Claude and GPT models, 5h and 7d">Claude</button>
          </div>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.clock}</span>
          <div class="cs-info"><span class="cs-title">Automatically continue after usage resets</span><span class="cs-desc">When a task hits its usage limit, schedule Continue in the same chat and model for the reset, ahead of later prompts.</span></div>
          <button class="cs-switch" data-role="autoContinueOnLimit" role="switch" aria-checked="true" aria-label="Automatically continue after usage resets" type="button"></button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.up}</span>
          <div class="cs-info"><span class="cs-title">Automatically update idle CLIs</span><span class="cs-desc">Update connected providers silently when they have no active work and you have not typed with them for 30 seconds. Other providers can update while you chat. Turn off to update manually.</span></div>
          <button class="cs-switch" data-role="autoUpdateClis" role="switch" aria-checked="true" aria-label="Automatically update idle CLIs" type="button"></button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.sound}</span>
          <div class="cs-info"><span class="cs-title">Completion sound</span><span class="cs-desc">Play a chime when a reply finishes and nothing you queued is left to run. The notification while the IDE is in the background stays.</span></div>
          <button class="cs-switch" data-role="completionSound" role="switch" aria-checked="true" aria-label="Completion sound" type="button"></button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.note}</span>
          <div class="cs-info"><span class="cs-title">Work-context icons</span><span class="cs-desc">Classify prompts with the configured free routing service and show category icons beside chats.</span></div>
          <button class="cs-switch" data-role="workContextIcons" role="switch" aria-checked="false" aria-label="Work-context icons" type="button"></button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.sliders}</span>
          <div class="cs-info"><span class="cs-title">Projects in the sidebar</span><span class="cs-desc">The chat's own project always stays, then up to two pinned favorites, then the most recent. Choose All on a very large monitor.</span></div>
          <select class="cs-select" data-role="railProjects" aria-label="Projects in the sidebar"><option value="1">1</option><option value="2">2</option><option value="3">3 (default)</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="8">8</option><option value="10">10</option><option value="0">All</option></select>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.sliders}</span>
          <div class="cs-info"><span class="cs-title">Recent chats in the sidebar</span><span class="cs-desc">Running and recently used chats come first. Choose All to list every chat.</span></div>
          <select class="cs-select" data-role="railChats" aria-label="Recent chats in the sidebar"><option value="3">3</option><option value="5">5 (default)</option><option value="8">8</option><option value="10">10</option><option value="15">15</option><option value="20">20</option><option value="0">All</option></select>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.clock}</span>
          <div class="cs-info"><span class="cs-title">Start usage windows early</span><span class="cs-desc" data-role="sessionWarmupDesc">Every 5 hours, sends "respond with 1" to the cheapest model of each connected CLI in the background, so a 5-hour window is nearly always already under way when you start. Subscription sign-ins only: a CLI billed per token through an API key is skipped.</span></div>
          <button class="cs-switch" data-role="sessionWarmup" role="switch" aria-checked="true" aria-label="Start usage windows early" type="button"></button>
        </div>
        <div class="cs-row cs-warmup-status" data-role="sessionWarmupStatusRow" hidden>
          <div class="cs-info"><span class="cs-desc" data-role="sessionWarmupStatus"></span></div>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.server}</span>
          <div class="cs-info"><span class="cs-title">Start windows in Google Cloud <span class="cs-tag">Experimental</span></span><span class="cs-desc">Use your weekly work calendar even while this computer is off. Runs in your own Google Cloud account.</span></div>
          <button class="cs-switch" data-role="cloudWarmupEnabled" role="switch" aria-checked="false" aria-label="Start windows in Google Cloud" type="button"></button>
        </div>
        <div class="cs-cloud-warmup" data-role="cloudWarmupPanel" hidden>
          <p class="cs-note cs-cloud-warning">Google Cloud could charge you if set up incorrectly or if you exceed its shared free allowances. More providers, retries, builds, image storage and networking can add costs. Budget alerts do not cap spending.</p>
          <p class="cs-desc">Cloud sign-ins are separate from your desktop. Subscription credentials are stored in your private Google Cloud project. API keys are skipped. No shared Clanker backend.</p>
          <div class="cs-actions cs-cloud-actions">
            <button class="cs-btn is-primary" data-role="cloudWarmupConnect" type="button">Connect Google Cloud</button>
            <button class="cs-btn is-quiet" data-role="cloudWarmupInstall" type="button">Get Google Cloud CLI</button>
          </div>
          <p class="cs-desc" data-role="cloudWarmupProject"></p>
          <fieldset class="cs-cloud-calendar"><legend>Weekly work calendar</legend>
            <label class="cs-cloud-zone">Timezone <input class="cs-area" data-role="cloudWarmupTimezone" aria-label="Work calendar timezone" placeholder="Europe/Berlin" spellcheck="false"></label>
            <label class="cs-cloud-zone">Start windows <select class="cs-select" data-role="cloudWarmupLead" aria-label="Hours before work"><option value="1">1 hour before work</option><option value="2">2 hours before work</option><option value="3" selected>3 hours before work</option><option value="4">4 hours before work</option></select></label>
            <div class="cs-cloud-days" data-role="cloudWarmupDays"></div>
            <p class="cs-desc">Same-day shifts, on the hour. Planned starts repeat every five hours until work ends, then pause overnight. A running provider window cannot be moved. Local-clock schedules follow daylight saving; duplicate slots are skipped.</p>
            <button class="cs-btn" data-role="cloudWarmupSave" type="button">Save calendar</button>
          </fieldset>
          <p class="cs-desc" data-role="cloudWarmupEstimate"></p>
          <p class="cs-desc" data-role="cloudWarmupExpiry"></p>
          <div class="cs-actions cs-cloud-actions">
            <button class="cs-btn is-primary" data-role="cloudWarmupDeploy" type="button">Review &amp; deploy</button>
            <button class="cs-btn" data-role="cloudWarmupRefresh" type="button">Refresh status</button>
            <button class="cs-btn" data-role="cloudWarmupRenew" type="button">Renew for 30 days</button>
          </div>
          <div class="cs-cloud-providers" data-role="cloudWarmupProviders"></div>
          <p class="cs-desc">Antigravity is unavailable here: its desktop sign-in cannot currently be connected to this runner. The same calendar applies to supported cloud providers.</p>
          <p class="cs-note" role="status" aria-live="polite" data-role="cloudWarmupStatus">Off. No Google resources have been created.</p>
          <p class="cs-desc">Stops prompts after 30 days unless renewed. Login warnings appear when Clanker is open; phone or email alerts while the PC is off are not configured. Pausing retains cloud resources and credentials.</p>
          <div class="cs-actions cs-cloud-actions"><button class="cs-btn is-quiet" data-role="cloudWarmupConsole" type="button">Open Google console</button><button class="cs-btn is-quiet" data-role="cloudWarmupRemove" type="button">Remove cloud runner &amp; credentials</button></div>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.server}</span>
          <div class="cs-info"><span class="cs-title">Status bar item</span><span class="cs-desc">Show the tunnel state at the bottom of the window.</span></div>
          <button class="cs-switch" data-role="statusBar" role="switch" aria-checked="false" aria-label="Status bar item" type="button"></button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.terminal}</span>
          <div class="cs-info"><span class="cs-title">Agent terminal</span><span class="cs-desc">Raw session output, for debugging.</span></div>
          <button class="cs-btn" data-role="openTerminal" type="button">Open</button>
        </div>
      </section>

      <details class="cs-card cs-group cs-api-value">
        <summary class="cs-row">
          <span class="cs-icon">${ICON.clock}</span>
          <div class="cs-info"><span class="cs-title">API value</span><span class="cs-desc">Estimated value of your work at pay-per-token prices.</span></div>
          ${ICON.chevron}
        </summary>
        <div class="cs-api-value-body">
          <div class="cs-api-value-total" data-role="apiValueTotal">Loading estimate…</div>
          <div class="cs-desc" data-role="apiValueRange"></div>
          <div class="cs-desc" data-role="apiValueChat">Current chat ≈ $0</div>
          <p class="cs-note">What this work would have cost at the providers' pay-per-token API prices. This is an estimate covered by your subscriptions, not a charge.</p>
          <div class="cs-api-value-rows" data-role="apiValueRows"></div>
          <p class="cs-note" data-role="apiValueFoot"></p>
        </div>
      </details>

      <details class="cs-card cs-group cs-project-icons">
        <summary class="cs-row">
          <span class="cs-icon">${ICON.image}</span>
          <div class="cs-info"><span class="cs-title">Project icons</span><span class="cs-desc">Customize the icons in your project rail.</span></div>
          <span class="cs-tag" data-role="projectIconCount"></span>
          ${ICON.chevron}
        </summary>
        <div class="cs-project-list" data-role="projectIcons"><p class="cs-project-empty" role="status">Loading projects…</p></div>
      </details>
    </div>

    <div class="cs-pane" data-pane="voice" role="tabpanel" hidden>
      <section class="cs-card">
        <div class="cs-row">
          <span class="cs-icon">${ICON.mic}</span>
          <div class="cs-info"><span class="cs-title">Dictation hotkey</span><span class="cs-desc" data-role="hotkeyDesc">Dictate from anywhere, without the mic button.</span></div>
          <button class="cs-btn is-quiet" data-role="hotkeyClear" type="button" hidden>Clear</button>
          <button class="cs-btn cs-keycap" data-role="hotkeyBtn" type="button">Set hotkey</button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.hold}</span>
          <div class="cs-info"><span class="cs-title">Hotkey behavior</span><span class="cs-desc" data-role="modeDesc"></span></div>
          <div class="voice-mode-picker pill-track" role="radiogroup" aria-label="Hotkey behavior">
            <button class="mode-pill" data-mode="toggle" type="button">Press to talk</button>
            <button class="mode-pill" data-mode="hold" type="button">Hold to talk</button>
          </div>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.sound}</span>
          <div class="cs-info"><span class="cs-title">Recording sounds</span><span class="cs-desc">A short tone when the microphone goes live and when it stops.</span></div>
          <button class="cs-switch" data-role="voiceSounds" role="switch" aria-checked="true" aria-label="Recording sounds" type="button"></button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.sound}</span>
          <div class="cs-info"><span class="cs-title">Pause background media</span><span class="cs-desc">Pause music and videos while you talk, then resume when recording ends. Works with Windows media controls.</span></div>
          <button class="cs-switch" data-role="voicePauseMedia" role="switch" aria-checked="true" aria-label="Pause background media" type="button"></button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.mic}</span>
          <div class="cs-info"><span class="cs-title">Microphone</span><span class="cs-desc" data-role="micDesc">Used for dictation. A change applies to the next recording.</span></div>
          <div class="cs-dd" data-role="micSelect">
            <button class="cs-dd-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Microphone"><span class="cs-dd-value"></span>${ICON.chevron}</button>
            <div class="cs-dd-menu" role="listbox" aria-label="Microphone" hidden></div>
          </div>
        </div>
      </section>

      <section class="cs-card cs-dict" data-role="dictionary">
        <div class="cs-row">
          <span class="cs-icon">${ICON.book}</span>
          <div class="cs-info"><span class="cs-title">Dictionary</span><span class="cs-desc" data-role="dictDesc">Every project has its own words, plus a few shared ones.</span></div>
          <span class="cs-tag" data-role="dictTag">0 words</span>
        </div>
        <div class="cs-dict-tools">
          <select class="cs-select cs-dict-scope" data-role="dictScope" aria-label="Whose words to show"></select>
          <label class="cs-model-search">${ICON.search}<input data-role="dictSearch" type="search" placeholder="Search words" aria-label="Search the dictionary" autocomplete="off" spellcheck="false"></label>
          <div class="cs-dict-add">
            <input class="cs-field" data-role="dictNew" type="text" maxlength="60" placeholder="Add a word or name…" aria-label="New dictionary word" autocomplete="off" spellcheck="false">
            <button class="cs-btn is-primary is-small" data-role="dictAdd" type="button">${ICON.plus}<span>Add</span></button>
          </div>
        </div>
        <div class="cs-dict-suggest" data-role="dictSuggest" hidden></div>
        <div class="cs-dict-list" data-role="dictList" role="list" aria-label="Dictionary words"></div>
        <p class="cs-status" data-role="dictStatus" role="status"></p>
        <div class="cs-row cs-dict-scan">
          <span class="cs-icon">${ICON.search}</span>
          <div class="cs-info"><span class="cs-title">Scan your projects</span><span class="cs-desc">Finds the class, product and tool names each project uses and gives every project its own words. It runs on this computer, needs no AI and only reads files. Scanning again refreshes the scanned words and keeps yours.</span></div>
        </div>
        <div class="cs-dict-scanall"><button class="cs-btn is-primary is-small" data-role="dictScanAll" type="button">${ICON.search}<span>Scan all projects</span></button></div>
        <div class="cs-dict-projects" data-role="dictProjects" aria-label="Scan one project again"></div>
        <div class="cs-dict-report" data-role="dictReport" role="list" aria-label="What the last scan found" hidden></div>
        <div class="cs-actions cs-dict-actions">
          <button class="cs-btn is-small" data-role="dictAI" type="button" title="Have a chat model edit the dictionary file for you">${ICON.bolt}<span>Edit with AI</span></button>
          <button class="cs-btn is-small is-quiet" data-role="dictClearScanned" type="button" hidden>Remove scanned words</button>
        </div>
      </section>

      <section class="cs-card cs-provider cs-api" data-role="groqAccount">
        <div class="cs-row">
          <span class="cs-icon">${ICON.key}</span>
          <div class="cs-info"><div class="cs-title-line"><span class="cs-title">Groq</span><span class="cs-tag">API</span></div><span class="cs-desc">Dictation, chat titles, and automatic model routing. Runs in the background; unavailable in the chat model picker.</span></div>
          <span class="cs-tag" data-role="groqTag">No key</span>
        </div>
        <p class="cs-provider-note" data-role="groqDesc">Paste an API key to connect your account.</p>
        <div class="cs-actions">
          <input class="cs-field" data-role="groqKey" type="password" placeholder="gsk_…" aria-label="Groq API key" autocomplete="off" spellcheck="false">
          <button class="cs-btn is-primary" data-role="groqSave" type="button">Save and verify</button>
        </div>
        <p class="cs-status" data-role="groqStatus" role="status"></p>
        <div class="cs-actions">
          <button class="cs-btn" data-role="groqGetKey" type="button">Get a key</button>
          <button class="cs-btn is-danger" data-role="groqRemove" type="button" hidden>Remove key</button>
        </div>
        <div class="cs-row cs-api-usage">
          <span class="cs-icon">${ICON.chart}</span>
          <div class="cs-info"><span class="cs-title">Today's usage</span><span class="cs-desc" data-role="usageDesc"></span></div>
          <button class="cs-btn is-small" data-role="groqCheck" type="button">${ICON.refresh}<span>Check now</span></button>
        </div>
        <div class="cs-usage" data-role="usageList"></div>
        <div class="cs-actions"><button class="cs-btn is-quiet" data-role="groqUsagePage" type="button">Open Groq's usage page</button></div>
      </section>
    </div>


    <div class="cs-pane" data-pane="remote" role="tabpanel" hidden>
      <section class="cs-card">
        <div class="cs-row">
          <span class="cs-icon">${ICON.telegram}</span>
          <div class="cs-info"><span class="cs-title">Telegram</span><span class="cs-desc" data-role="telegramDesc">Approve tasks and get alerts on your phone.</span></div>
          <span class="cs-tag" data-role="telegramTag">Off</span>
        </div>
        <div class="cs-actions">
          <button class="cs-btn is-primary" data-role="configureTelegram" type="button">Set up</button>
          <button class="cs-btn" data-role="testTelegram" type="button" hidden>Send test</button>
          <button class="cs-btn is-danger" data-role="disconnectTelegram" type="button" hidden>Disconnect</button>
        </div>
      </section>

      <section class="cs-card">
        <div class="cs-row">
          <span class="cs-icon">${ICON.tunnel}</span>
          <div class="cs-info"><span class="cs-title">Cloudflare tunnel</span><span class="cs-desc" data-role="tunnelDesc">Live webhooks without port forwarding.</span></div>
          <span class="cs-tag" data-role="tunnelTag">Off</span>
        </div>
        <div class="cs-actions">
          <button class="cs-btn is-primary" data-role="toggleTunnel" type="button">Start tunnel</button>
        </div>
      </section>
    </div>

    <div class="cs-pane" data-pane="loops" role="tabpanel" hidden>
      <p class="cs-note">Options for loops. The EU check lists indicators for you to judge. It is technical guidance, not legal advice.</p>
      <section class="cs-card">
        <div class="cs-row">
          <span class="cs-icon">${ICON.shield}</span>
          <div class="cs-info"><span class="cs-title">EU compliance check in loops</span><span class="cs-desc">One more scout and free text checks look for GDPR and TDDDG indicators: remote fonts, trackers, CDNs, embeds, a missing imprint or privacy page, forms without a notice, personal data in logs. They are listed for you to judge and never fixed automatically.</span></div>
          <button class="cs-switch" data-role="complianceScout" role="switch" aria-checked="true" aria-label="EU compliance check in loops" type="button"></button>
        </div>
        <div class="cs-row">
          <span class="cs-icon">${ICON.lock}</span>
          <div class="cs-info"><span class="cs-title">Hide personal data from cloud models</span><span class="cs-desc">Before a loop sends project text to a cloud model, real-looking e-mail addresses, IBANs and phone numbers are replaced with placeholders. Your files and the loop's private copy keep the real values.</span></div>
          <button class="cs-switch" data-role="complianceRedact" role="switch" aria-checked="true" aria-label="Hide personal data from cloud models" type="button"></button>
        </div>
      </section>
    </div>

    <div class="cs-pane" data-pane="models" role="tabpanel" hidden>
      <p class="cs-note">Configure your favorite models. Add more favorites in General.</p>
      <div class="cs-cli-heading"><div class="cs-info"><span class="cs-title">Your CLIs</span><span class="cs-desc">Removing one only disconnects it from Clanker.</span></div><div class="cs-actions"><button class="cs-btn is-small" data-role="connectAllClis" type="button">${ICON.plug}<span>Set up all</span></button><button class="cs-btn is-small" data-role="checkCliConnections" type="button">${ICON.refresh}<span>Check</span></button></div></div>
      <div class="cs-providers" data-role="providers"></div>
      <section class="cs-card">
        <div class="cs-row">
          <span class="cs-icon">${ICON.note}</span>
          <div class="cs-info"><span class="cs-title">Favorite models</span><span class="cs-desc">Set instructions, permissions, and reasoning for each favorite.</span></div>
        </div>
        <div class="cs-prompt-list" data-role="promptList"></div>
        <div class="cs-retired" data-role="retired" hidden>
          <div class="cs-model-head">Earlier models</div>
          <p class="cs-note">Saved prompts outside your favorites. Add the model again in General or copy its prompt into a favorite.</p>
          <div class="cs-prompt-list" data-role="retiredList"></div>
        </div>
      </section>
      <section class="cs-card">
        <div class="cs-row">
          <span class="cs-icon">${ICON.heart}</span>
          <div class="cs-info"><span class="cs-title">Available models</span><span class="cs-desc" data-role="availableDesc">Favorite a model to add it to the chat's model picker.</span></div>
          <button class="cs-btn" data-role="refreshModels" type="button">${ICON.refresh}<span>Refresh</span></button>
        </div>
        <div class="cs-model-tools">
          <label class="cs-model-search">${ICON.search}<input data-role="modelSearch" type="search" placeholder="Search models…" aria-label="Search available models" autocomplete="off" spellcheck="false"></label>
          <div class="cs-company-filters" role="group" aria-label="Filter models by CLI" data-role="companyFilters"></div>
          <span class="cs-model-count" data-role="modelCount" role="status"></span>
        </div>
        <div class="cs-model-list" data-role="modelList"></div>
      </section>
      <div class="cs-footer">
        <button class="cs-btn" data-role="pingClis" type="button">${ICON.refresh}<span>Check CLIs</span></button>
        <button class="cs-btn is-quiet" data-role="openSetupGuide" type="button">${ICON.book}<span>Setup guide</span></button>
        <button class="cs-btn is-quiet" data-role="openLogs" type="button" title="Errors and messages from Clanker Controller, for when something does not work">${ICON.note}<span>Logs</span></button>
        <button class="cs-btn is-quiet" data-role="modelSettings" type="button">${ICON.sliders}<span>Advanced settings</span></button>
        <button class="cs-btn is-quiet" data-role="resetCache" type="button" title="Forget resolved CLI paths and look them up again">${ICON.reset}<span>Reset CLI cache</span></button>
      </div>
    </div>`;

  window.initChatSettings = function initChatSettings({ vscode, body, onOpenSetupGuide, onOpenLogs }) {
    body.classList.add('cs');
    body.innerHTML = MARKUP;
    // ---------- Routing: a free model picks the CLI model for each message ----------
    // The page runs in the order of the work: what it is and its mode, what it has used, connecting the two services,
    // which one is asked first, then the fine print in collapsed groups.
    const routingPane = document.createElement('div');
    routingPane.className = 'cs-pane'; routingPane.dataset.pane = 'routing'; routingPane.hidden = true; routingPane.setAttribute('role', 'tabpanel');
    body.append(routingPane);
    let routingSig = '', routingPending = null, routingAction = null;
    const el = (tag, className, html) => { const node = document.createElement(tag); if (className) node.className = className; if (html != null) node.innerHTML = html; return node; };
    const routingStatus = el('p', 'cs-status cs-route-status'); routingStatus.setAttribute('role', 'status');
    const setRoutingStatus = (text, state = '') => { routingStatus.className = `cs-status cs-route-status${state ? ` is-${state}` : ''}`; routingStatus.textContent = text; };
    const credField = (placeholder, label) => { const input = el('input', 'cs-field'); input.type = 'password'; input.placeholder = placeholder; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', label); return input; };
    // Credential inputs outlive every re-render, so a half-typed key survives a refresh of the page.
    const creds = { cloudflareAccount: credField('Account ID (32 characters)', 'Cloudflare Account ID'), cloudflareKey: credField('API token', 'Cloudflare API token'), groqKey: credField('gsk_…', 'Groq API key') };

    const MODE_NAMES = { manual: 'Manual', auto: 'Auto' };
    const SERVICES = {
      cloudflare: {
        name: 'Cloudflare Workers AI', icon: ICON.tunnel, tint: '#f6821f',
        blurb: 'Reads your message (and screenshots) and picks the model. Also takes over Groq\'s text work (GPT OSS 120B) when Groq is nearly used up.',
        note: 'Stay on the Workers Free plan (10,000 Neurons a day, no card needed) so overage can never be billed. Cloudflare does not train on your prompts or share them with other customers.',
        steps: [
          ['Create a free Cloudflare account, or sign in.', ['Sign up', 'cfSignup']],
          ['Open <b>Workers AI</b>, press <b>Use REST API</b> and copy your <b>Account ID</b>.', ['Open Workers AI', 'cfAi']],
          ['Press <b>Create a Workers AI API Token</b>, then <b>Create API Token</b>. Copy it now; Cloudflare shows it once.'],
          ['Paste both below and press <b>Save and test</b>.'],
        ],
      },
      groq: {
        name: 'Groq', icon: ICON.bolt, tint: '#ffb08a',
        blurb: 'The fallback router, and the free model for simple text tasks. Shares its key with dictation.',
        note: 'Free-tier limits differ by account. Check yours on the limits page and match them under Free-tier limits below.',
        steps: [
          ['Create a free Groq account, or sign in.', ['Open console', 'groqKeys']],
          ['Open <b>API Keys</b>, press <b>Create API Key</b> and copy it. It starts with <code>gsk_</code>.'],
          ['Paste it below and press <b>Save and test</b>.'],
          ['Optional: see your daily limits.', ['Limits', 'groqLimits']],
        ],
      },
    };
    const TIERS = ['cloudflare', 'groq'];
    const TIER_CAPS = { image_width: 1024, image_bytes: 190000, timeout_ms: 5000, retention_days: 365, cloudflare_neurons: 10000, groq_rpm: 30, groq_rpd: 1000, groq_tpm: 8000, groq_tpd: 200000 };

    function routing(snapshot) {
      if (!snapshot) return;
      const sig = JSON.stringify(snapshot);
      if (sig === routingSig) return;
      // Re-rendering under someone's cursor would drop the field they are typing in; wait until they leave it.
      if (routingPane.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { routingPending = snapshot; return; }
      routingSig = sig; routingPending = null;
      renderRouting(snapshot);
    }
    routingPane.addEventListener('focusout', () => setTimeout(() => { if (routingPending) routing(routingPending); }, 0));

    function renderRouting(snapshot) {
      const before = new Map([...routingPane.querySelectorAll('details[data-key]')].map((node) => [node.dataset.key, node.open]));
      const cfg = snapshot.config;
      const connected = snapshot.connected || {};
      if(snapshot.configError)setRoutingStatus(snapshot.configError,'error');
      const save = (change) => { change(cfg); vscode.postMessage({ type: 'routingSave', config: cfg }); routingAction = { kind: 'save' }; setRoutingStatus('Saving…'); };
      const labelled = (title, hint) => el('div', 'cs-section', `<span class="cs-section-title">${title}</span><span class="cs-section-hint">${hint}</span>`);
      const button = (label, onClick, className = '', icon = '') => { const node = el('button', `cs-btn ${className}`, `${icon}<span></span>`); node.type = 'button'; node.querySelector('span').textContent = label; node.addEventListener('click', onClick); return node; };
      const link = (label, key) => button(label, () => vscode.postMessage({ type: 'openRoutingLink', key }), 'is-small is-quiet', ICON.ext);

      // Controls. Each one saves itself the moment it changes.
      const sw = (value, onChange, label) => { const node = el('button', 'cs-switch'); node.type = 'button'; node.setAttribute('role', 'switch'); node.setAttribute('aria-checked', String(!!value)); node.setAttribute('aria-label', label); node.addEventListener('click', () => { const next = node.getAttribute('aria-checked') !== 'true'; node.setAttribute('aria-checked', String(next)); onChange(next); }); return node; };
      const num = (value, name, onChange) => { const node = el('input', 'cs-num'); node.type = 'number'; node.min = '1'; if (TIER_CAPS[name]) node.max = String(TIER_CAPS[name]); node.value = value; node.addEventListener('change', () => onChange(Number(node.value))); return node; };
      const percent = (value, onChange) => {
        const wrap = el('div', 'cs-slider'); const range = el('input'); range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1'; range.value = Math.round(value * 100);
        const out = el('output', '', `${range.value}%`); range.addEventListener('input', () => { out.textContent = `${range.value}%`; }); range.addEventListener('change', () => onChange(Number(range.value) / 100)); wrap.append(range, out); return wrap;
      };
      const pick = (choices, value, onChange, label) => { const node = el('select', 'cs-select'); node.setAttribute('aria-label', label); for (const [id, text] of choices) { const option = el('option'); option.value = id; option.textContent = text; node.append(option); } node.value = value; node.addEventListener('change', () => onChange(node.value)); return node; };
      const setting = (title, desc, control, stacked = false) => { const node = el('div', `cs-set${stacked ? ' is-stack' : ''}`, '<div class="cs-info"><span class="cs-title"></span><span class="cs-desc"></span></div>'); node.querySelector('.cs-title').textContent = title; node.querySelector('.cs-desc').textContent = desc; node.append(control); return node; };
      const group = (key, icon, title, summary, rows) => {
        const node = el('details', 'cs-card cs-group'); node.dataset.key = key; node.open = before.get(key) ?? false;
        const head = el('summary', 'cs-row', `<span class="cs-icon">${icon}</span><div class="cs-info"><span class="cs-title"></span><span class="cs-desc"></span></div>${ICON.chevron}`);
        head.querySelector('.cs-title').textContent = title; head.querySelector('.cs-desc').textContent = summary;
        const list = el('div', 'cs-set-list'); list.append(...rows); node.append(head, list); return node;
      };

      // 1. Today's usage, in the bars the Voice tab uses. Compact: it is the part worth glancing at.
      const usage = snapshot.usage || {};
      const bar = (name, used, cap) => {
        const pct = Math.min(100, Math.round((used / cap) * 100));
        const row = el('div', 'cs-usage-row', `<div class="cs-usage-head"><span></span><span></span></div><div class="cs-usage-bar${pct >= 80 ? ' is-high' : ''}"><b style="--used:${pct}"></b></div>`);
        const [a, b] = row.querySelectorAll('.cs-usage-head span'); a.textContent = name; b.textContent = `${Math.round(used).toLocaleString()} of ${cap.toLocaleString()}`; return row;
      };
      const usageCard = el('section', 'cs-card cs-route-usage', `<div class="cs-usage-title"><span class="cs-title">Used today</span><span class="cs-desc"></span></div>`);
      usageCard.querySelector('.cs-desc').textContent = `Counted on this computer. Resets at ${new Date(snapshot.reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      const bars = el('div', 'cs-usage'); bars.append(bar('Cloudflare Neurons', usage.neurons || 0, cfg.cloudflare_neurons), bar('Groq requests', usage.groq_requests || 0, cfg.groq_rpd), bar('Groq tokens', usage.groq_tokens || 0, cfg.groq_tpd));
      usageCard.append(bars);
      const counts = usage.destination_turns || {};
      const distribution = el('p', 'cs-usage-foot');
      distribution.textContent = `CLI tasks today: Claude ${counts.claude || 0} · Codex ${counts.codex || 0} · Gemini ${counts.gemini || 0}`;
      distribution.title = 'Counts include manual sends; router benchmarks are excluded. Task counts are not token usage.';
      usageCard.append(distribution);

      // 2. Smart routing and its two services in one card. Setup is done once, so each service is a single row that opens
      // into the guide and the credentials only when wanted (and starts open until it is connected).
      const serviceRow = (name) => {
        const info = SERVICES[name], ok = !!connected[name];
        const row = el('details', 'cs-svc'); row.dataset.key = `svc:${name}`; row.dataset.service = name; row.open = before.get(row.dataset.key) ?? !ok;
        row.style.setProperty('--tint', info.tint);
        const head = el('summary', '', `<span class="cs-icon">${info.icon}</span><span class="cs-title"></span><span class="cs-tag ${ok ? 'is-ok' : 'is-warn'}">${ok ? 'Connected' : 'Not connected'}</span>${ICON.chevron}`);
        head.querySelector('.cs-title').textContent = info.name;
        const inner = el('div', 'cs-svc-body');
        const blurb = el('p', 'cs-guide-note'); blurb.textContent = info.blurb;
        const steps = el('ol', 'cs-steps');
        for (const [html, action] of info.steps) { const li = el('li', '', `<span>${html}</span>`); if (action) li.append(link(...action)); steps.append(li); }
        const note = el('p', 'cs-guide-note'); note.textContent = info.note;
        const keyField = creds[`${name}Key`];
        creds.cloudflareAccount.placeholder = ok ? 'Saved. Paste again to replace' : 'Account ID (32 characters)';
        keyField.placeholder = ok ? 'Saved. Paste again to replace' : { groq: 'gsk_…' }[name] || 'API token';
        const fields = el('div', 'cs-cred');
        if (name === 'cloudflare') fields.append(creds.cloudflareAccount);
        fields.append(keyField);
        const test = button('Test', () => { routingAction = { kind: 'test', provider: name }; setRoutingStatus('Testing the connection…'); vscode.postMessage({ type: 'routingTest', provider: name }); });
        test.disabled = !ok;
        fields.append(el('div', 'cs-cred-actions'));
        fields.lastChild.append(button('Save and test', () => {
          const account = creds.cloudflareAccount.value.trim(), key = keyField.value.trim();
          if (name === 'cloudflare' && !/^[a-f0-9]{32}$/i.test(account)) return setRoutingStatus('The Account ID is 32 letters and digits. Copy it from the Workers AI page.', 'error');
          if (!key) return setRoutingStatus(name === 'cloudflare' ? 'Paste your API token first.' : `Paste your ${SERVICES[name].name} key first.`, 'error');
          routingAction = { kind: 'connect', provider: name }; setRoutingStatus('Saving…');
          vscode.postMessage({ type: 'routingConnect', provider: name, account, key });
        }, 'is-primary'), test);
        inner.append(blurb, steps, note, fields);
        row.append(head, inner);
        return row;
      };
      const anyConnected = TIERS.some((name) => connected[name]);
      const routeCard = el('details', 'cs-card cs-route-hero'); routeCard.dataset.key = 'route'; routeCard.open = before.get('route') ?? !anyConnected;
      const routeHead = el('summary', 'cs-row', `<span class="cs-icon">${ICON.route}</span><div class="cs-info"><span class="cs-title">Smart routing</span><span class="cs-desc"></span></div><span class="cs-dots">${TIERS.map((name) => `<i class="${connected[name] ? 'is-ok' : ''}" title="${SERVICES[name].name} ${connected[name] ? 'connected' : 'not connected'}"></i>`).join('')}</span>${ICON.chevron}`);
      routeHead.querySelector('.cs-desc').textContent = `A free AI picks the model for each message. Mode: ${MODE_NAMES[cfg.router_mode]}.`;
      const serviceList = el('div', 'cs-svc-list'); serviceList.append(serviceRow('cloudflare'), serviceRow('groq'));
      routeCard.append(routeHead, serviceList);

      // 4. Which service is asked first. The order is the primary tier, then the rest; the local fallback is always last.
      const order = cfg.tiers.includes(cfg.primary) ? [cfg.primary, ...cfg.tiers.filter((t) => t !== cfg.primary && t !== 'deterministic')] : [];
      const rows = [...order, ...TIERS.filter((t) => !order.includes(t))];
      const setOrder = (list) => save((c) => { c.tiers = [...list, 'deterministic']; c.primary = list[0] || 'deterministic'; });
      const orderCard = el('section', 'cs-card cs-order');
      rows.forEach((tier, index) => {
        const on = order.includes(tier);
        const item = el('div', `cs-order-row${on ? '' : ' is-off'}`, `<span class="cs-order-no">${on ? index + 1 : ''}</span><span class="cs-icon">${SERVICES[tier].icon}</span><div class="cs-info"><span class="cs-title"></span><span class="cs-desc"></span></div>`);
        item.querySelector('.cs-title').textContent = SERVICES[tier].name;
        const desc = item.querySelector('.cs-desc');
        desc.textContent = !on ? 'Skipped' : !connected[tier] ? 'On, but not connected yet' : index === 0 ? 'Asked first' : 'Asked if the first one fails';
        desc.classList.toggle('is-warn', on && !connected[tier]);
        const move = (delta) => { const list = [...order]; [list[index], list[index + delta]] = [list[index + delta], list[index]]; setOrder(list); };
        const arrows = el('div', 'cs-order-move');
        const up = el('button', 'cs-icon-btn', ICON.up); up.type = 'button'; up.setAttribute('aria-label', `Move ${SERVICES[tier].name} up`); up.disabled = !on || index === 0; up.addEventListener('click', () => move(-1));
        const down = el('button', 'cs-icon-btn', ICON.down); down.type = 'button'; down.setAttribute('aria-label', `Move ${SERVICES[tier].name} down`); down.disabled = !on || index >= order.length - 1; down.addEventListener('click', () => move(1));
        arrows.append(up, down);
        item.append(arrows, sw(on, (next) => setOrder(next ? [...order, tier] : order.filter((t) => t !== tier)), `Use ${SERVICES[tier].name}`));
        orderCard.append(item);
      });
      orderCard.append(el('div', 'cs-order-row is-fixed', `<span class="cs-order-no">•</span><span class="cs-icon">${ICON.cube}</span><div class="cs-info"><span class="cs-title">Simple local rules</span><span class="cs-desc">Always last. Works offline and never leaves this computer.</span></div>`));

      // 5. The fine print, in collapsed groups with a one-line summary each.
      const pct = (v) => `${Math.round(v * 100)}%`;
      const privateArea = el('textarea', 'cs-area'); privateArea.rows = 3; privateArea.value = cfg.never_send.join('\n'); privateArea.placeholder = 'One project ID or path per line'; privateArea.setAttribute('aria-label', 'Private projects');
      privateArea.addEventListener('change', () => save((c) => { c.never_send = privateArea.value.split('\n').map((x) => x.trim()).filter(Boolean); }));
      const textField=(value,label,change)=>{const node=el('input','cs-field');node.value=value;node.setAttribute('aria-label',label);node.addEventListener('change',()=>change(node.value));return node;};
      const groups = [
        group('g:decide', ICON.sliders, 'How it decides', `Confidence ${pct(cfg.confidence)} · ${cfg.retry ? 'retries' : 'no retry'} · ${cfg.switching ? 'may switch models' : 'keeps the model'}`, [
          setting('Spread usage across providers', 'Aim for an even share of tasks when models fit similarly. Manual choices still win.', sw(cfg.balance_providers, (v) => save((c) => { c.balance_providers = v; }), 'Balance provider usage')),
          setting('Confidence needed', 'Below this, the router uses your editable fallback policy or eligible default.', percent(cfg.confidence, (v) => save((c) => { c.confidence = v; }))),
          setting('Retry with the stronger Cloudflare model', 'When the quick answer is not confident enough.', sw(cfg.retry, (v) => save((c) => { c.retry = v; }), 'Retry low confidence')),
          setting('Default model', 'Used when the router is unsure.', pick([['', 'Follow fallback policy'], ...snapshot.models.map((m) => [m.id, m.label || m.id])], cfg.default_model, (v) => save((c) => { c.default_model = v; }), 'Default model')),
          setting('Switch models within a provider', 'Lets the router move between models of the same CLI mid-chat.', sw(cfg.switching, (v) => save((c) => { c.switching = v; }), 'Allow switching')),
          setting('Switching threshold', 'How much better a model must fit before the router changes.', percent(cfg.hysteresis, (v) => save((c) => { c.hysteresis = v; }))),
        ]),
        group('g:session', ICON.layers, 'Chat sessions', `${cfg.session_mode === 'always_new' ? 'Always new' : 'Continues when possible'} · new session at ${pct(cfg.context_threshold)} full`, [
          setting('Sessions', 'Continuing keeps the CLI\'s cache warm.', pick([['continue_when_possible', 'Continue when possible'], ['always_new', 'Always start new']], cfg.session_mode, (v) => save((c) => { c.session_mode = v; }), 'Session mode')),
          setting('Start a new session at', 'How full the model\'s context may get.', percent(cfg.context_threshold, (v) => save((c) => { c.context_threshold = v; }))),
          setting('Prepare a summary at', 'Must be lower than the value above.', percent(cfg.summary_start, (v) => save((c) => { c.summary_start = v; }))),
        ]),
        group('g:image', ICON.image, 'Screenshots', cfg.screenshot ? `Sent downscaled, up to ${cfg.image_width}px` : 'Never sent to the router', [
          setting('Send a screenshot copy', 'Pixels may contain secrets. The original goes to your CLI either way.', sw(cfg.screenshot, (v) => save((c) => { c.screenshot = v; }), 'Send screenshot copy')),
          setting('Maximum width', `Pixels, up to ${TIER_CAPS.image_width}.`, num(cfg.image_width, 'image_width', (v) => save((c) => { c.image_width = v; }))),
          setting('Maximum size', `Bytes, up to ${TIER_CAPS.image_bytes.toLocaleString()}.`, num(cfg.image_bytes, 'image_bytes', (v) => save((c) => { c.image_bytes = v; }))),
        ]),
        group('g:privacy', ICON.lock, 'Privacy and logs', `${cfg.redaction ? 'Redacts secrets' : 'No redaction'} · ${cfg.never_send.length} private project${cfg.never_send.length === 1 ? '' : 's'} · ${cfg.logging ? `logs ${cfg.retention_days} days` : 'no log'}`, [
          setting('Redact secrets', 'Strips keys and tokens before anything leaves this computer.', sw(cfg.redaction, (v) => save((c) => { c.redaction = v; }), 'Redact external routing input')),
          setting('Private projects', 'Never sent to Cloudflare or Groq. Chats there use the local rules.', privateArea, true),
          setting('Log routing decisions', 'Kept in this extension\'s storage on your computer.', sw(cfg.logging, (v) => save((c) => { c.logging = v; }), 'Log routing decisions')),
          setting('Keep logs for', `Days, up to ${TIER_CAPS.retention_days}.`, num(cfg.retention_days, 'retention_days', (v) => save((c) => { c.retention_days = v; }))),
        ]),
        group('g:limits', ICON.gauge, 'Free-tier limits', `${cfg.cloudflare_neurons.toLocaleString()} Neurons · ${cfg.groq_rpd.toLocaleString()} Groq requests a day`, [
          setting('Cloudflare Neurons a day', `Up to ${TIER_CAPS.cloudflare_neurons.toLocaleString()}, the free allowance.`, num(cfg.cloudflare_neurons, 'cloudflare_neurons', (v) => save((c) => { c.cloudflare_neurons = v; }))),
          setting('Groq requests a minute', `Up to ${TIER_CAPS.groq_rpm}.`, num(cfg.groq_rpm, 'groq_rpm', (v) => save((c) => { c.groq_rpm = v; }))),
          setting('Groq requests a day', `Up to ${TIER_CAPS.groq_rpd.toLocaleString()}.`, num(cfg.groq_rpd, 'groq_rpd', (v) => save((c) => { c.groq_rpd = v; }))),
          setting('Groq tokens a minute', `Up to ${TIER_CAPS.groq_tpm.toLocaleString()}. Match your account's limit.`, num(cfg.groq_tpm, 'groq_tpm', (v) => save((c) => { c.groq_tpm = v; }))),
          setting('Groq tokens a day', `Up to ${TIER_CAPS.groq_tpd.toLocaleString()}.`, num(cfg.groq_tpd, 'groq_tpd', (v) => save((c) => { c.groq_tpd = v; }))),
          setting('Move Groq work to Cloudflare at', 'Past this share of any Groq limit, text work (cleanup, titles, summaries, routing) goes to Cloudflare GPT OSS 120B, which also takes over whenever Groq refuses. It draws on the Neurons above.', percent(cfg.groq_spill, (v) => save((c) => { c.groq_spill = v; }))),
          setting('Answer simple tasks with Groq', 'When every CLI model is out of usage, Groq can answer short text-only tasks.', sw(cfg.groq_destination, (v) => save((c) => { c.groq_destination = v; }), 'Groq as destination')),
          setting('Give up after', `Milliseconds, up to ${TIER_CAPS.timeout_ms.toLocaleString()}.`, num(cfg.timeout_ms, 'timeout_ms', (v) => save((c) => { c.timeout_ms = v; }))),
        ]),
      ];

      const profiles=cfg.task_profiles||{};
      const profileRows=Object.entries(profiles).map(([id,p])=>{
        const patch=(key,value)=>save(c=>{c.task_profiles[id]={...c.task_profiles[id],[key]:value};});
        const rows=[
          setting('Name','Shown to the classifier.',textField(p.label,'Profile name '+id,v=>patch('label',v))),
          setting('Keywords','Comma-separated phrases that suggest this task.',textField(p.keywords.join(', '),'Keywords '+id,v=>patch('keywords',v.split(',').map(x=>x.trim()).filter(Boolean))),true),
          setting('Excluded keywords','A match suppresses this profile.',textField(p.exclude_keywords.join(', '),'Excluded keywords '+id,v=>patch('exclude_keywords',v.split(',').map(x=>x.trim()).filter(Boolean))),true),
          setting('Priority','Higher wins when several profiles match.',textField(p.priority,'Priority '+id,v=>patch('priority',Number(v)))),
          setting('Complexity','Used by the local fallback.',percent(p.complexity,v=>patch('complexity',v))),
          button('Remove profile',()=>save(c=>{delete c.task_profiles[id];for(const model of Object.values(c.models))for(const key of ['tasks','avoid_tasks'])if(model[key])model[key]=model[key].filter(x=>x!==id);}), 'is-quiet')
        ];
        return group('profile:'+id,ICON.sliders,p.label,id,rows);
      });
      profileRows.push(button('Add task profile',()=>{let id='custom';let n=1;while(profiles[id])id='custom_'+n++;save(c=>{c.task_profiles[id]={label:'Custom task',keywords:[],exclude_keywords:[],priority:0,complexity:.5};});}));
      groups.push(group('g:profiles',ICON.sliders,'Task profiles','Editable hints and fallback assignments',profileRows));
      const policyRows=Object.entries(cfg.policy||{}).map(([key,value])=>setting(key.replaceAll('_',' '),'Applied to routing decisions and request preparation.',textField(value,key,v=>save(c=>{c.policy[key]=Number(v);})))) ;
      for(const agent of [...new Set(snapshot.models.map(m=>m.agent))])policyRows.push(setting(agent+' share weight','1 for each provider gives equal targets; 2 gives twice the target share.',textField(cfg.provider_weights?.[agent]||1,agent+' share weight',v=>save(c=>{c.provider_weights={...c.provider_weights,[agent]:Number(v)};}))));
      policyRows.push(setting('Fallback order','Comma-separated: profiles, probabilities, capacity.',textField(cfg.fallback_order.join(', '),'Fallback order',v=>save(c=>{c.fallback_order=v.split(',').map(x=>x.trim()).filter(Boolean);})),true));
      groups.push(group('g:policy',ICON.gauge,'Routing policy','Balance margins, quota cutoff and input limits',policyRows));
      const json=el('textarea','cs-area');json.rows=12;json.value=JSON.stringify(cfg,null,2);json.setAttribute('aria-label','Routing configuration JSON');
      groups.push(group('g:json',ICON.cube,'Full configuration','The same JSON used by the router',[json,button('Apply JSON',()=>{try{const next=JSON.parse(json.value);save(c=>{for(const key of Object.keys(c))delete c[key];Object.assign(c,next);});}catch(e){setRoutingStatus(e.message,'error');}})]));

      // Per-model capabilities, grouped by CLI.
      const modelRows = [];
      const byAgent = {};
      for (const model of snapshot.models) (byAgent[model.agent || 'other'] ||= []).push(model);
      for (const [agent, list] of Object.entries(byAgent)) {
        const head = el('div', 'cs-model-head', `<span class="cs-head-icon">${LOGO[agent] || ICON.cube}</span><span class="cs-head-name"></span><span class="cs-head-count">${list.length}</span>`);
        head.dataset.agent = agent; head.querySelector('.cs-head-name').textContent = CLI_LABELS[agent] || agent; modelRows.push(head);
        for (const model of list) {
          const own = cfg.models[model.id] || {};
          const patch = (field, value) => save((c) => { c.models[model.id] = { ...c.models[model.id], [field]: value }; });
          const node = el('details', 'cs-model-card'); node.dataset.key = `model:${model.id}`; node.open = before.get(node.dataset.key) ?? false;
          const summary = el('summary', '', `<span class="cs-model-label"></span>${own.enabled === false ? '<span class="cs-tag">Off</span>' : ''}${ICON.chevron}`); summary.querySelector('.cs-model-label').textContent = model.label || model.id;
          const text = el('input', 'cs-field'); text.value = own.description || model.description || ''; text.placeholder = 'Strengths, speed and cost'; text.addEventListener('change', () => patch('description', text.value));
          const ctx = el('input', 'cs-num'); ctx.type = 'number'; ctx.min = '1024'; ctx.value = own.context || model.context || model.contextWindow || cfg.policy?.default_context || 128000; ctx.addEventListener('change', () => patch('context', Number(ctx.value)));
          const assigned=el('div');
          for(const [id,p] of Object.entries(profiles)){const label=el('label','cs-set');const check=el('input');check.type='checkbox';check.checked=(own.tasks||[]).includes(id);check.addEventListener('change',()=>patch('tasks',check.checked?[...new Set([...(own.tasks||[]),id])]:(own.tasks||[]).filter(x=>x!==id)));label.append(check,document.createTextNode(p.label));assigned.append(label);}
          node.append(summary,
            setting('Preferred tasks','Used by Clef and the local fallback. No assignments means general capacity ranking.',assigned,true),
            setting('Avoid tasks','Comma-separated profile IDs.',textField((own.avoid_tasks||[]).join(', '),'Avoid tasks '+model.id,v=>patch('avoid_tasks',v.split(',').map(x=>x.trim()).filter(Boolean))),true),
            setting('Use this model', 'Off keeps the router from choosing it.', sw(own.enabled !== false, (v) => patch('enabled', v), 'Enabled')),
            setting('Use in Auto', 'Off keeps this model available for manual selection only.', sw(own.auto_enabled !== false, (v) => patch('auto_enabled', v), 'Use in Auto')),
            setting('Understands images', 'Needed for screenshots.', sw(own.vision ?? model.vision ?? false, (v) => patch('vision', v), 'Vision supported')),
            setting('Context window', 'Tokens.', ctx),
            setting('Capability', 'How hard a task it should be given.', percent(own.complexity ?? .5, (v) => patch('complexity', v))),
            setting('Description', 'Helps the router choose.', text, true));
          modelRows.push(node);
        }
      }
      const modelGroup = group('g:models', ICON.cube, 'Models', `${snapshot.models.length} models the router can choose from`, modelRows);

      // Reset, export and import: rarely needed, so quiet and last.
      const footer = el('div', 'cs-footer');
      footer.append(
        button('Open config',()=>vscode.postMessage({type:'openRoutingConfig'}),'is-quiet'),
        button('Edit with AI',()=>vscode.postMessage({type:'editRoutingConfigWithAI'}),'is-quiet'),
        button('Reset to defaults', () => { routingAction = { kind: 'save' }; vscode.postMessage({ type: 'routingReset' }); }, 'is-quiet', ICON.reset),
        button('Export', () => { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })); a.href = url; a.download = 'routing-config.json'; a.click(); URL.revokeObjectURL(url); }, 'is-quiet', ICON.up),
        button('Import', () => { const file = document.createElement('input'); file.type = 'file'; file.accept = '.json'; file.onchange = async () => { try { routingAction = { kind: 'save' }; vscode.postMessage({ type: 'routingSave', config: JSON.parse(await file.files[0].text()) }); } catch { setRoutingStatus('That file is not valid JSON.', 'error'); } }; file.click(); }, 'is-quiet', ICON.down),
      );

      routingPane.replaceChildren(
        routingStatus, usageCard, routeCard,
        labelled('Order', 'Who is asked first'), orderCard,
        labelled('Fine-tune', 'The defaults are fine'), ...groups, modelGroup, footer,
      );
    }
    function routingResult(result) {
      const action = routingAction || {};
      if (!result.ok) { setRoutingStatus(result.error, 'error'); routingSig = ''; vscode.postMessage({ type: 'requestFleet' }); return; } // show what is really stored
      if (action.kind === 'connect') {
        creds.cloudflareAccount.value = ''; creds.cloudflareKey.value = ''; creds.groqKey.value = '';
        routingAction = { kind: 'test', provider: action.provider }; setRoutingStatus('Saved. Testing the connection…');
        vscode.postMessage({ type: 'routingTest', provider: action.provider });
      } else if (action.kind === 'test') setRoutingStatus(`${SERVICES[action.provider]?.name || 'Service'} is working.`, 'ok');
      else setRoutingStatus('Saved.', 'ok');
    }
    // The same live picker visits onboarding Step 2, keeping its listeners, state and host updates intact.
    const modelPickerCard = body.querySelector('[data-role="modelList"]').closest('.cs-card');
    // A number typed into settings.json that the list lacks (say 7) still shows up as itself.
    const setRailSelect = (select, value) => {
      if (!select || !Number.isInteger(value)) return;
      if (![...select.options].some(option => Number(option.value) === value)) {
        const option = new Option(String(value), String(value));
        select.insertBefore(option, [...select.options].find(item => Number(item.value) > value || Number(item.value) === 0) || null);
      }
      select.value = String(value);
    };
    const $ = (role) => body.querySelector(`[data-role="${role}"]`) || modelPickerCard.querySelector(`[data-role="${role}"]`);
    // Setup belongs to General; Models contains only the favorite editors.
    const general = body.querySelector('[data-pane="general"]');
    general.prepend($('providers').previousElementSibling, $('providers'));
    $('providers').after($('groqAccount'));
    const updateAll = document.createElement('button');
    updateAll.type = 'button';
    updateAll.className = 'cs-btn is-small is-primary';
    updateAll.textContent = 'Update all';
    updateAll.hidden = true;
    updateAll.addEventListener('click', () => vscode.postMessage({ type: 'updateAllClis' }));
    $('checkCliConnections').before(updateAll);
    general.append($('modelList').closest('.cs-card'), body.querySelector('.cs-footer'));
    const modelPickerHome = document.createComment('available models');
    modelPickerCard.before(modelPickerHome);
    const ICONS = window.AGENT_ICONS || {};
    const MP = window.modelPrompts;
    const names = window.AGENT_NAMES || { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity' };
    const tabs = body.querySelectorAll('.cs-tab');
    const panes = body.querySelectorAll('.cs-pane');
    const pingLabel = $('pingClis').querySelector('span');
    const formatPills = body.querySelectorAll('.format-pill');
    const ringPills = body.querySelectorAll('.ring-source-pill');
    const namesPills = body.querySelectorAll('.names-pill');
    const permissionPills = body.querySelectorAll('.permission-pill');

    function renderPermissionSupport(mode = 'fullAccess') {
      const claude = $('claudePerm');
      const codex = $('codexPerm');
      const gemini = $('geminiPerm');
      const desc = $('permissionDesc');
      if (mode === 'ask') {
        if (desc) desc.textContent = 'Ask when a provider needs approval. Headless Gemini skips blocked actions.';
        if (claude) { claude.className = 'cs-support-status is-ok'; claude.textContent = 'Supported (prompt on action)'; }
        if (codex) { codex.className = 'cs-support-status is-ok'; codex.textContent = 'Supported (on-request approval)'; }
        if (gemini) { gemini.className = 'cs-support-status is-warn'; gemini.textContent = 'No headless prompts — blocked actions skipped'; }
      } else if (mode === 'auto') {
        if (desc) desc.textContent = 'Automated risk review where supported. Headless Gemini skips blocked actions.';
        if (claude) { claude.className = 'cs-support-status is-ok'; claude.textContent = 'Supported (auto classifier)'; }
        if (codex) { codex.className = 'cs-support-status is-ok'; codex.textContent = 'Supported (auto-review sandbox)'; }
        if (gemini) { gemini.className = 'cs-support-status is-warn'; gemini.textContent = 'No auto review — blocked actions skipped'; }
      } else {
        if (desc) desc.textContent = 'Full execution access across all providers without confirmation prompts.';
        if (claude) { claude.className = 'cs-support-status is-ok'; claude.textContent = 'Supported (bypass permissions)'; }
        if (codex) { codex.className = 'cs-support-status is-ok'; codex.textContent = 'Supported (danger-full-access)'; }
        if (gemini) { gemini.className = 'cs-support-status is-ok'; gemini.textContent = 'Supported (auto-approve all)'; }
      }
    }

    let lastFleet = null; // until the first fleet message the provider cards would all read "Missing"
    let status = { versions: {}, updating: {}, notes: {}, fetched: [], modelErrors: {}, favorites: [], catalog: [], prompts: {}, modelsBusy: false };
    let modelsRequested = false;
    let connections = null;
    function showTab(name) {
      tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.tab === name)));
      panes.forEach((pane) => { pane.hidden = pane.dataset.pane !== name; });
      // The CLIs are only asked for their model lists once, when the Models tab is first looked at.
      if (name === 'general' && !modelsRequested) { modelsRequested = true; vscode.postMessage({ type: 'refreshModels' }); }
      if (name === 'general') vscode.postMessage({ type: 'requestCliConnections' });
      if (name === 'general') vscode.postMessage({ type: 'requestProjectIcons' });
      if (name === 'voice') { // devices come and go and an AI may have edited the dictionary, so look each time the tab opens
        vscode.postMessage({ type: 'requestMicDevices' });
        vscode.postMessage({ type: 'requestVoiceDictionary' });
        vscode.postMessage({ type: 'requestProjectIcons' }); // the project list the scan buttons are made from
      }
    }
    tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

    // Read the actual labels on each search, so newly loaded models and routing controls are searchable too.
    const searchInput = $('settingsSearch'), searchResults = $('settingsSearchResults');
    let searchMatches = [], searchActive = 0, searchHighlight = null, searchHighlightTimer;
    const searchText = text => text.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    function closeSettingsSearch() {
      searchResults.hidden = true; $('settingsSearchStatus').hidden = true;
      searchInput.setAttribute('aria-expanded', 'false'); searchInput.removeAttribute('aria-activedescendant');
    }
    function selectSearchResult(index) {
      const match = searchMatches[index];
      if (!match?.target.isConnected) { renderSettingsSearch(); return; }
      showTab(match.tab);
      if (match.target.matches('.cs-prompt-head[aria-expanded="false"]')) match.target.click();
      for (let node = match.target; node && node !== body; node = node.parentElement) {
        if (node.tagName === 'DETAILS') node.open = true;
        if (node.classList.contains('cs-prompt-editor') && node.hidden) node.parentElement.querySelector('.cs-prompt-head')?.click();
      }
      searchInput.value = ''; $('settingsSearchClear').hidden = true; closeSettingsSearch();
      if (searchHighlight) searchHighlight.classList.remove('cs-search-target');
      clearTimeout(searchHighlightTimer);
      searchHighlight = match.target; searchHighlight.classList.add('cs-search-target');
      searchHighlightTimer = setTimeout(() => searchHighlight?.classList.remove('cs-search-target'), 2200);
      const control = match.target.matches('button, input, select, textarea, summary') ? match.target : match.target.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), summary');
      const focus = control || match.target;
      if (!control) focus.setAttribute('tabindex', '-1');
      focus.focus({ preventScroll: true });
      match.target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
    function activateSearchResult(index) {
      searchActive = index;
      [...searchResults.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
      const option = searchResults.children[index];
      if (option) { searchInput.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
      else searchInput.removeAttribute('aria-activedescendant');
    }
    function renderSettingsSearch() {
      const query = searchText(searchInput.value), words = query.split(' ');
      $('settingsSearchClear').hidden = !searchInput.value;
      if (!query) { closeSettingsSearch(); return; }
      const matches = [], seen = new Set();
      for (const label of body.querySelectorAll('.cs-pane .cs-title, .cs-pane .cs-section-title, .cs-pane .cs-model-label, .cs-pane label.cs-set, .cs-pane button[aria-label], .cs-pane input[aria-label], .cs-pane select[aria-label], .cs-pane textarea[aria-label], .cs-pane .cs-footer .cs-btn')) {
        const pane = label.closest('.cs-pane');
        const target = label.closest('.cs-set, .cs-row, summary, .cs-prompt-head, .cs-section, .cs-cli-heading, .cs-usage-title') || label;
        let unavailable = label.hidden;
        for (let n = label.parentElement; n && n !== pane; n = n.parentElement) if (n.hidden && !n.classList.contains('cs-prompt-editor')) unavailable = true;
        if (seen.has(target) || unavailable) continue;
        const name = (label.matches('[aria-label]') ? label.getAttribute('aria-label') : label.textContent).trim();
        if (!name) continue;
        seen.add(target);
        const tab = pane.dataset.pane;
        const path = [body.querySelector(`.cs-tab[data-tab="${tab}"]`)?.getAttribute('aria-label') || tab];
        const modelName = target.closest('.cs-prompt-row')?.querySelector('.cs-model-label')?.textContent.trim();
        if (modelName && modelName !== name) path.push(modelName);
        for (let n = target.parentElement; n && n !== pane; n = n.parentElement) {
          if (n.tagName === 'DETAILS') { const head = n.querySelector(':scope > summary'); const title = head?.querySelector('.cs-title, .cs-model-label'); if (title) path.splice(1, 0, title.textContent.trim()); }
        }
        const haystack = searchText(`${name} ${path.join(' ')} ${target.querySelector('.cs-desc')?.textContent || ''}`);
        if (words.every(word => haystack.includes(word))) matches.push({ name, target, tab, path: path.join(' › '), rank: searchText(name) === query ? 0 : searchText(name).startsWith(query) ? 1 : 2 });
      }
      matches.sort((a, b) => a.rank - b.rank);
      searchMatches = matches.slice(0, 12);
      searchResults.replaceChildren(...searchMatches.map((match, i) => {
        const option = document.createElement('div'); option.className = 'cs-settings-search-option'; option.id = `cs-settings-search-option-${i}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(i === 0));
        const name = document.createElement('span'); name.className = 'cs-title'; name.textContent = match.name;
        const path = document.createElement('span'); path.className = 'cs-desc'; path.textContent = match.path;
        option.append(name, path); option.addEventListener('mousedown', event => event.preventDefault()); option.addEventListener('click', () => selectSearchResult(i)); return option;
      }));
      searchResults.hidden = !searchMatches.length;
      $('settingsSearchStatus').hidden = false;
      $('settingsSearchStatus').textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'setting' : 'settings'} found${matches.length > 12 ? ' · showing the first 12' : ''}. Use ↑ ↓ and Enter to jump.` : 'No settings found. Try another name or keyword.';
      searchInput.setAttribute('aria-expanded', String(Boolean(searchMatches.length)));
      activateSearchResult(0);
    }
    searchInput.addEventListener('input', renderSettingsSearch);
    searchInput.addEventListener('focus', renderSettingsSearch);
    searchInput.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && searchInput.value) { event.preventDefault(); event.stopPropagation(); searchInput.value = ''; renderSettingsSearch(); }
      else if (event.key === 'Enter' && !searchResults.hidden) { event.preventDefault(); selectSearchResult(searchActive); }
      else if (['ArrowDown', 'ArrowUp'].includes(event.key) && searchMatches.length && !searchResults.hidden) { event.preventDefault(); activateSearchResult((searchActive + (event.key === 'ArrowDown' ? 1 : -1) + searchMatches.length) % searchMatches.length); }
    });
    $('settingsSearchClear').addEventListener('click', () => { searchInput.value = ''; renderSettingsSearch(); searchInput.focus(); });
    body.addEventListener('focusout', event => { if (!$('settingsSearchBox').contains(event.relatedTarget)) closeSettingsSearch(); });
    body.addEventListener('click', event => { if (!$('settingsSearchBox').contains(event.target)) closeSettingsSearch(); });
    new MutationObserver(changes => {
      if (document.activeElement === searchInput && searchInput.value && changes.some(change => change.target.parentElement?.closest('.cs-pane'))) renderSettingsSearch();
    }).observe(body, { childList: true, subtree: true, characterData: true });

    function setTag(el, state, text) {
      el.className = `cs-tag${state ? ` is-${state}` : ''}`; // ok | warn | (none = off)
      el.textContent = text;
    }

    // One compact card per provider: logo with a status dot, name and version, what it will run, and icon actions.
    // Removing asks first, in a panel over the card (confirming holds the agent whose panel is open across re-renders).
    let confirming = null;
    const iconButton = (icon, label, className = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `cs-icon-btn ${className}`;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = icon;
      return button;
    };

    function removePanel(card, agent) {
      const panel = document.createElement('div');
      panel.className = 'cs-confirm';
      panel.setAttribute('role', 'alertdialog');
      panel.innerHTML = `<span class="cs-confirm-icon">${ICON.trash}</span><div class="cs-confirm-text"><b></b><span>Disconnects it here; its install and account stay.</span></div><div class="cs-confirm-actions"><button class="cs-btn is-small" data-act="cancel" type="button">Cancel</button><button class="cs-btn is-small is-danger" data-act="remove" type="button">${ICON.trash}<span>Remove</span></button></div>`;
      panel.querySelector('b').textContent = `Remove ${names[agent] || agent}?`;
      const close = () => { confirming = null; panel.remove(); };
      panel.querySelector('[data-act="cancel"]').addEventListener('click', close);
      panel.querySelector('[data-act="remove"]').addEventListener('click', () => { confirming = null; vscode.postMessage({ type: 'removeCli', agent }); });
      panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
      card.append(panel);
      panel.querySelector('[data-act="cancel"]').focus({ preventScroll: true });
    }

    function providerCard(agent, models, cli = {}, pinged, currentPermMode = 'fullAccess') {
      const card = document.createElement('section');
      card.className = 'cs-card cs-provider';
      card.dataset.agent = agent;
      if (cli.path) card.title = cli.path;

      const connection = connections?.providers?.[agent] || (connections ? { enabled: false, installed: Boolean(cli.path), auth: 'missing' } : null);
      const details = connection && connectionDetails(connection);
      const connected = !connection || (connection.enabled && details.ready);
      const unavailable = connection?.enabled ? connection.unavailable : null; // added, but the plan ended, credits ran out or the sign-in broke
      const info = status.versions[agent] || {};
      const updating = status.updating[agent];
      const version = info.version || cli.version;
      const note = status.notes[agent];

      // [dot / text colour, text]: the one thing that most needs your attention comes first.
      const [tone, text] = !cli.path ? ['', 'Not installed']
        : unavailable ? ['warn', 'Not available']
        : !connected ? ['warn', details.tag]
          : updating ? ['warn', 'Updating…']
            : info.outdated ? ['warn', 'Update available']
              : pinged && cli.version === null && !version ? ['warn', 'Version check failed']
                : !version ? [status.checking ? '' : 'warn', status.checking ? 'Checking…' : 'Version unknown']
                  : status.checking ? ['', 'Checking for updates…']
                    : info.latest ? ['ok', 'Up to date'] : ['', 'Update check unavailable'];

      const permission = REGISTRY.find((provider) => provider.id === agent)?.headlessApprovals === false && currentPermMode !== 'fullAccess' ? 'Restricted (no prompts)'
        : currentPermMode === 'fullAccess' ? 'Full Access' : currentPermMode === 'auto' ? 'Auto' : 'Ask';
      const labels = unavailable ? [unavailable.reason] : [permission, ...models.map((model) => model.label.replace(/^Claude /, ''))];

      const row = document.createElement('div');
      row.className = 'cs-row';
      row.innerHTML = `<span class="cs-icon">${ICONS[agent] || ''}<i class="cs-dot${tone ? ` is-${tone}` : ''}"></i></span><div class="cs-info"><span class="cs-title-line"><span class="cs-title"></span><code class="cs-ver"></code></span><span class="cs-models"></span></div><span class="cs-state${tone ? ` is-${tone}` : ''}"></span><div class="cs-ractions"></div>`;
      row.querySelector('.cs-title').textContent = names[agent] || agent;
      const ver = row.querySelector('.cs-ver');
      ver.textContent = version ? `v${version}` : '';
      ver.hidden = !version;
      row.querySelector('.cs-state').textContent = text === 'Update available' ? '' : text; // the update button says it already
      row.querySelector('.cs-state').title = info.error || '';
      const modelLine = row.querySelector('.cs-models');
      modelLine.textContent = labels.join(' · ');
      modelLine.title = unavailable?.detail ? `${unavailable.reason}\n${unavailable.detail}` : labels.join('\n');
      card.append(row);

      const actions = row.querySelector('.cs-ractions');
      const pill = (icon, label, primary, onClick, disabled = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `cs-btn is-small${primary ? ' is-primary' : ''}`;
        button.disabled = disabled;
        button.innerHTML = `${icon}<span></span>`;
        button.querySelector('span').textContent = label;
        button.addEventListener('click', onClick);
        actions.append(button);
      };
      if (unavailable) pill(ICON.refresh, 'Try again', true, () => vscode.postMessage({ type: 'restoreCli', agent }));
      else if (connection && !connected) pill(ICON.plug, details.action, true, () => vscode.postMessage({ type: 'connectCli', agent }));
      else if (cli.path && (info.outdated || updating)) pill(ICON.up, updating ? 'Updating…' : info.latest, !updating, () => vscode.postMessage({ type: 'updateCli', agent }), Boolean(updating));
      if (connection?.enabled) {
        const trash = iconButton(ICON.trash, `Remove ${names[agent] || agent}`, 'is-danger');
        trash.addEventListener('click', () => { confirming = agent; removePanel(card, agent); });
        actions.append(trash);
      }

      if (cli.path && updating) {
        // No CLI reports its progress, so the bar paces itself on the last update's duration and stops short of full
        // (negative delay = where it should be now, so a re-render does not restart it); the CLI's own last line sits under it.
        const progress = document.createElement('div');
        progress.className = 'cs-progress';
        progress.innerHTML = '<div class="cs-progress-track"><i class="cs-progress-bar"></i></div><span class="cs-progress-time"></span><span class="cs-progress-line"></span>';
        progress.dataset.startedAt = updating.startedAt;
        progress.dataset.estimateMs = updating.estimateMs;
        progress.querySelector('.cs-progress-bar').style.animation = `cs-progress ${updating.estimateMs}ms cubic-bezier(0.1, 0.6, 0.3, 1) ${-(Date.now() - updating.startedAt)}ms forwards`;
        progress.querySelector('.cs-progress-line').textContent = updating.line || 'Starting…';
        card.append(progress);
      } else if (cli.path && note && (!note.ok || Date.now() - note.completedAt < 5000)) {
        const outcome = document.createElement('p');
        outcome.className = `cs-update-note ${note.ok ? 'is-ok' : 'is-error'} cs-provider-note`;
        outcome.textContent = note.ok ? 'Update complete.' : note.text;
        card.append(outcome);
      }
      if (connection && !connected && details.description) {
        const hint = document.createElement('p');
        hint.className = 'cs-provider-note';
        hint.textContent = details.description;
        card.append(hint);
      }
      if (confirming === agent) removePanel(card, agent);
      return card;
    }

    let company = 'all';
    let availableSignature = '';
    // Group models by the CLI that serves them, including cross-provider models.
    $('companyFilters').replaceChildren(...[{ id: 'all', label: 'All' }, ...REGISTRY.map((provider) => ({ id: provider.id, label: provider.id === 'gemini' ? 'Antigravity CLI' : provider.name }))].map(({ id, label }) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'cs-company'; button.dataset.company = id;
      if (id !== 'all') button.dataset.agent = id;
      button.innerHTML = `${id === 'all' ? '' : LOGO[id]}<span></span>`;
      button.querySelector('span').textContent = label;
      button.setAttribute('aria-pressed', String(id === 'all'));
      return button;
    }));
    const companyPills = body.querySelectorAll('.cs-company');
    $('modelSearch').addEventListener('input', () => { renderAvailable(); $('modelList').scrollTop = 0; });
    companyPills.forEach((pill) => pill.addEventListener('click', () => {
      company = pill.dataset.company;
      companyPills.forEach((button) => button.setAttribute('aria-pressed', String(button === pill)));
      renderAvailable();
      $('modelList').scrollTop = 0;
    }));

    // Keep existing rows on favorite updates: scroll, focus and the heart's motion survive host replies.
    // A provider's group heading in the model lists: its logo in its colour, its name, and how many models follow.
    function providerHead(agent, count) {
      const head = document.createElement('div');
      head.className = 'cs-model-head';
      head.dataset.agent = agent;
      head.innerHTML = `<span class="cs-head-icon">${LOGO[agent]}</span><span class="cs-head-name"></span><span class="cs-head-count"></span>`;
      head.querySelector('.cs-head-name').textContent = names[agent] || agent;
      head.querySelector('.cs-head-count').textContent = count;
      return head;
    }

    function renderAvailable() {
      const starred = new Set(status.favorites);
      const all = status.fetched;
      const query = $('modelSearch').value.trim().toLowerCase();
      const visible = all.filter((entry) => (company === 'all' || entry.agent === company)
        && `${entry.label} ${entry.model} ${entry.effort || ''}`.toLowerCase().includes(query));
      const list = $('modelList');
      const errors = status.modelErrors || {};
      const signature = JSON.stringify([visible, errors, company]);
      $('modelCount').textContent = `${visible.length} of ${all.length} models`;
      $('refreshModels').disabled = status.modelsBusy;
      $('availableDesc').textContent = status.modelsBusy ? 'Asking the installed CLIs…' : all.length ? 'Favorite a model to add it to the chat\'s model picker.' : 'No model list yet. Refresh to ask the CLIs.';
      if (signature !== availableSignature) {
        availableSignature = signature;
        const scrollTop = list.scrollTop;
        list.replaceChildren(...PROVIDERS.flatMap((agent) => {
          const entries = visible.filter((entry) => entry.agent === agent);
          if (errors[agent] && (company === 'all' || company === agent)) {
            const note = document.createElement('p');
            note.className = 'cs-note is-error';
            note.setAttribute('role', 'alert');
            note.textContent = errors[agent];
            return [providerHead(agent, 0), note];
          }
          if (!entries.length) return [];
          return [providerHead(agent, entries.length), ...entries.map((entry) => {
            const row = document.createElement('div');
            row.className = 'cs-model-row';
            const label = document.createElement('span');
            label.className = 'cs-model-label';
            label.textContent = entry.label;
            label.title = entry.model + (entry.effort ? ` · ${entry.effort}` : '');
            const heart = document.createElement('button');
            heart.type = 'button';
            heart.className = 'cs-heart';
            heart.dataset.modelId = entry.id;
            heart.innerHTML = ICON.heart;
            heart.setAttribute('aria-pressed', String(starred.has(entry.id)));
            heart.setAttribute('aria-label', `Favorite ${entry.label}`);
            heart.title = starred.has(entry.id) ? 'Remove from the picker' : 'Add to the picker';
            heart.addEventListener('animationend', () => heart.classList.remove('is-popping'));
            heart.addEventListener('click', () => {
              const pressed = heart.getAttribute('aria-pressed') !== 'true';
              heart.setAttribute('aria-pressed', String(pressed));
              heart.title = pressed ? 'Remove from the picker' : 'Add to the picker';
              heart.classList.remove('is-popping');
              requestAnimationFrame(() => heart.classList.add('is-popping'));
              vscode.postMessage({ type: 'toggleFavoriteModel', id: entry.id });
            });
            row.append(label, heart);
            return row;
          })];
        }));
        if (!visible.length && !list.querySelector('.cs-note.is-error')) {
          const empty = document.createElement('p');
          empty.className = 'cs-note';
          empty.textContent = all.length ? 'No models match your search and company filter.' : 'Refresh to discover available models.';
          list.append(empty);
        }
        list.scrollTop = scrollTop;
      }
      list.querySelectorAll('.cs-heart').forEach((heart) => {
        const pressed = starred.has(heart.dataset.modelId);
        heart.setAttribute('aria-pressed', String(pressed));
        heart.title = pressed ? 'Remove from the picker' : 'Add to the picker';
      });
    }

    // ---- Model prompts: one row per model in the picker; the row opens an editor. A prompt belongs to that exact model, so
    // when a model leaves the picker its prompt moves to "Earlier models", unsent, to copy into a newer one.
    const drafts = {}; // model -> text typed but not saved, kept while the list redraws
    const openEditors = new Set();
    const firstLine = (text) => text.split(/\r?\n/).find((line) => line.trim()) || '';

    function promptRow(row, saved) {
      const key = row.id;
      const wrap = document.createElement('div');
      wrap.dataset.modelId = key;
      wrap.className = `cs-prompt-row${saved ? ' has-prompt' : ''}${openEditors.has(key) ? ' is-open' : ''}`;
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'cs-prompt-head';
      head.setAttribute('aria-expanded', String(openEditors.has(key)));
      head.innerHTML = '<span class="cs-model-label"></span><span class="cs-prompt-state"></span><svg class="cs-prompt-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>';
      head.querySelector('.cs-model-label').textContent = row.label;
      head.querySelector('.cs-prompt-state').textContent = saved ? firstLine(saved) : 'Configure';

      const editor = document.createElement('div');
      editor.className = 'cs-prompt-editor';
      editor.hidden = !openEditors.has(key);
      const controls = document.createElement('div');
      controls.className = 'cs-model-controls';
      const field = (title, choices, value, change, icon = '') => {
        const label = document.createElement('label');
        label.className = 'cs-model-field';
        const caption = document.createElement('span');
        caption.className = 'cs-field-caption';
        caption.innerHTML = icon;
        caption.append(title);
        const select = document.createElement('select');
        select.setAttribute('aria-label', `${title} for ${row.label}`);
        for (const [id, text] of choices) { const option = document.createElement('option'); option.value = id; option.textContent = text; select.append(option); }
        select.value = value;
        select.disabled = choices.length < 2;
        select.addEventListener('change', () => change(select.value));
        label.append(caption, select); controls.append(label);
      };
      const base = (entry) => entry.model.replace(/-(low|medium|high|xhigh|max|ultra)$/, '');
      const variants = status.fetched.filter((entry) => entry.agent === row.agent && base(entry) === base(row));
      field('Reasoning', (variants.length ? variants : [row]).map((entry) => {
        const level = entry.effort || /-(low|medium|high|xhigh|max|ultra)$/.exec(entry.model)?.[1];
        return [entry.id, level ? level.charAt(0).toUpperCase() + level.slice(1) : 'Default'];
      }), key,
        (id) => {
          openEditors.delete(key); openEditors.add(id);
          if (drafts[key] !== undefined) { drafts[id] = drafts[key]; delete drafts[key]; }
          vscode.postMessage({ type: 'changeFavoriteModel', id: key, nextId: id });
        }, ICON.sliders);
      field('Permissions', [['inherit', 'Use General setting'], ['ask', 'Ask'], ['auto', 'Auto'], ['fullAccess', 'Full Access']], status.modelSettings?.[key]?.permissionMode || 'inherit',
        (permissionMode) => vscode.postMessage({ type: 'setModelSettings', id: key, permissionMode }), ICON.shield);
      const area = document.createElement('textarea');
      area.className = 'cs-prompt-text';
      area.rows = 4;
      area.maxLength = MP.MAX_PROMPT;
      area.placeholder = 'e.g. If this is a design change, verify your work by rendering it out yourself before sending.';
      area.value = drafts[key] ?? saved;
      area.setAttribute('aria-label', `Model prompt for ${row.label}`);
      const actions = document.createElement('div');
      actions.className = 'cs-prompt-actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'cs-btn is-primary';
      save.innerHTML = `${ICON.check}<span>Save</span>`;
      save.disabled = area.value.trim() === saved;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cs-btn is-quiet';
      remove.innerHTML = `${ICON.reset}<span>Clear prompt</span>`;
      remove.hidden = !saved;
      const hint = document.createElement('span');
      hint.className = 'cs-desc';
      hint.textContent = 'Applies to this favorite.';
      const unfavorite = document.createElement('button');
      unfavorite.type = 'button'; unfavorite.className = 'cs-btn is-quiet'; unfavorite.innerHTML = `${ICON.heart}<span>Remove favorite</span>`;
      unfavorite.addEventListener('click', () => vscode.postMessage({ type: 'toggleFavoriteModel', id: key }));
      actions.append(save, remove, hint);
      editor.append(controls, area, actions, unfavorite);

      head.addEventListener('click', () => {
        const open = editor.hidden;
        editor.hidden = !open;
        head.setAttribute('aria-expanded', String(open));
        wrap.classList.toggle('is-open', open);
        if (open) { openEditors.add(key); area.focus(); } else openEditors.delete(key);
      });
      area.addEventListener('input', () => { drafts[key] = area.value; save.disabled = area.value.trim() === saved; });
      save.addEventListener('click', () => { delete drafts[key]; vscode.postMessage({ type: 'setModelPrompt', model: key, label: row.label, text: area.value }); });
      remove.addEventListener('click', () => { delete drafts[key]; vscode.postMessage({ type: 'setModelPrompt', model: key, label: row.label, text: '' }); });
      wrap.append(head, editor);
      return wrap;
    }

    function retiredRow({ model, label, text }) {
      const wrap = document.createElement('div');
      wrap.className = 'cs-prompt-row is-retired';
      const top = document.createElement('div');
      top.className = 'cs-retired-top';
      const name = document.createElement('span');
      name.className = 'cs-model-label';
      name.textContent = label;
      name.title = model;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'cs-btn';
      const copyFace = (text, icon) => { copy.innerHTML = `${icon}<span>${text}</span>`; };
      copyFace('Copy', ICON.copy);
      copy.addEventListener('click', () => {
        const done = () => { copyFace('Copied', ICON.check); setTimeout(() => copyFace('Copy', ICON.copy), 1400); };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => {});
        else { const scratch = document.createElement('textarea'); scratch.value = text; body.append(scratch); scratch.select(); document.execCommand('copy'); scratch.remove(); done(); }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cs-btn is-quiet';
      remove.innerHTML = `${ICON.trash}<span>Delete</span>`;
      remove.addEventListener('click', () => vscode.postMessage({ type: 'setModelPrompt', model, label, text: '' }));
      top.append(name, copy, remove);
      const preview = document.createElement('p');
      preview.className = 'cs-retired-text';
      preview.textContent = text;
      wrap.append(top, preview);
      return wrap;
    }

    let promptSignature = '';
    function renderPrompts() {
      const prompts = status.prompts || {};
      const catalog = status.catalog || [];
      const signature = JSON.stringify([catalog, prompts, status.modelSettings, status.fetched.map((entry) => entry.id)]);
      if (signature === promptSignature) return;
      promptSignature = signature;
      const focused = $('promptList').contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
      const rows = catalog;
      $('promptList').replaceChildren(...PROVIDERS.flatMap((agent) => {
        const list = rows.filter((row) => row.agent === agent);
        if (!list.length) return [];
        return [providerHead(agent, list.length), ...list.map((row) => promptRow(row, MP.promptFor(prompts, row)))];
      }));
      if (!rows.length) { const empty = document.createElement('p'); empty.className = 'cs-note'; empty.textContent = 'No favorites yet. Add models in General to configure them here.'; $('promptList').append(empty); }
      const retired = MP.retiredPrompts(prompts, catalog);
      $('retired').hidden = !retired.length;
      $('retiredList').replaceChildren(...retired.map(retiredRow));
      if (focused) [...$('promptList').querySelectorAll('[aria-label]')].find((element) => element.getAttribute('aria-label') === focused)?.focus({ preventScroll: true });
    }

    function renderUpdateTimes() {
      for (const progress of $('providers').querySelectorAll('.cs-progress')) {
        const elapsed = Math.max(0, Date.now() - Number(progress.dataset.startedAt));
        const estimate = Number(progress.dataset.estimateMs);
        const seconds = Math.floor(elapsed / 1000);
        progress.querySelector('.cs-progress-time').textContent = `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed · ${elapsed < estimate ? `about ${Math.ceil((estimate - elapsed) / 1000)}s remaining` : 'finishing…'} (estimate)`;
      }
    }
    setInterval(renderUpdateTimes, 1000);

    let updateNoteTimer;
    function cliStatus(next) {
      status = next;
      clearTimeout(updateNoteTimer);
      const remaining = Object.values(status.notes).filter(note => note?.ok && note.completedAt)
        .map(note => note.completedAt + 5000 - Date.now()).filter(ms => ms > 0);
      if (remaining.length) updateNoteTimer = setTimeout(() => cliStatus(status), Math.min(...remaining));
      const active = Object.keys(status.updating).length;
      const due = PROVIDERS.filter(agent => status.versions[agent]?.outdated && connections?.providers?.[agent]?.enabled !== false).length;
      updateAll.hidden = !due && !active;
      updateAll.disabled = active > 0;
      updateAll.textContent = active ? 'Updating…' : 'Update all';
      $('providers').previousElementSibling.querySelector('.cs-desc').textContent = active
        ? `${active} CLI update${active === 1 ? '' : 's'} running in parallel.`
        : due ? `${due} update${due === 1 ? '' : 's'} available. Update all with one click.` : 'Removing one only disconnects it from Clanker.';
      renderProviders();
      renderUpdateTimes();
      renderPrompts();
      renderAvailable();
    }

    function renderProviders() {
      if (!lastFleet) return;
      $('providers').replaceChildren(...PROVIDERS.map((agent) => providerCard(agent, lastFleet.models.filter((m) => m.agent === agent), lastFleet.clis[agent], lastFleet.pinged, lastFleet.permission)));
    }

    function cliConnections(next) {
      connections = next;
      $('checkCliConnections').disabled = next.checking;
      $('checkCliConnections').querySelector('span').textContent = next.checking ? 'Checking…' : 'Check';
      $('connectAllClis').disabled = next.checking;
      renderProviders();
    }
    $('connectAllClis').addEventListener('click', () => vscode.postMessage({ type: 'connectAllClis' }));
    $('checkCliConnections').addEventListener('click', () => vscode.postMessage({ type: 'checkCliConnections' }));

    function fleet({ models = [], clis = {}, services = {}, pinged = false }) {
      routing(services.routing);
      const currentPermMode = services.permissionMode || 'fullAccess';
      lastFleet = { models, clis, pinged, permission: currentPermMode };
      renderProviders();

      const tg = services.telegram || {};
      const configured = typeof tg === 'boolean' ? tg : tg.configured;
      if (configured) {
        setTag($('telegramTag'), 'ok', 'Connected');
        $('telegramDesc').textContent = `Chat ${tg.maskedChatId || 'linked'} · ${tg.mode === 'webhook' ? 'live webhook' : 'long-polling'}`;
        $('configureTelegram').textContent = 'Edit';
        $('configureTelegram').classList.remove('is-primary');
      } else {
        setTag($('telegramTag'), '', 'Off');
        $('telegramDesc').textContent = 'Approve tasks and get alerts on your phone.';
        $('configureTelegram').textContent = 'Set up';
        $('configureTelegram').classList.add('is-primary');
      }
      $('testTelegram').hidden = !configured;
      $('disconnectTelegram').hidden = !configured;

      const tn = typeof services.tunnel === 'string' ? { status: services.tunnel, url: services.tunnelUrl } : (services.tunnel || {});
      const live = tn.status === 'live';
      const connecting = tn.status === 'connecting';
      setTag($('tunnelTag'), live ? 'ok' : connecting ? 'warn' : '', live ? 'Live' : connecting ? 'Connecting' : 'Off');
      $('tunnelDesc').textContent = live ? tn.url : 'Live webhooks without port forwarding.';
      $('toggleTunnel').textContent = live ? 'Stop tunnel' : connecting ? 'Connecting…' : 'Start tunnel';
      $('toggleTunnel').classList.toggle('is-primary', !live);
      $('toggleTunnel').disabled = connecting;

      if (services.voice) voice(services.voice);
      $('statusBar').setAttribute('aria-checked', String(Boolean(services.statusBar)));
      $('autoContinueOnLimit').setAttribute('aria-checked', String(services.autoContinueOnLimit !== false));
      $('autoUpdateClis').setAttribute('aria-checked', String(services.autoUpdateClis !== false));
      $('completionSound').setAttribute('aria-checked', String(services.completionSound !== false));
      $('workContextIcons').setAttribute('aria-checked', String(services.workContextIcons === true));
      if (services.rail) for (const [key, value] of [['railProjects', services.rail.projects], ['railChats', services.rail.chats]]) setRailSelect($(key), value);
      renderWarmup(services.sessionWarmup);
      renderCloudWarmup(services.cloudWarmup);
      renderLoops(services.compliance);
      const currentFormat = services.timeFormat || '24h';
      for (const pill of formatPills) pill.classList.toggle('active', pill.dataset.format === currentFormat);
      for (const pill of namesPills) pill.classList.toggle('active', pill.dataset.names === (services.chatNames || 'agent'));
      for (const pill of ringPills) pill.classList.toggle('active', pill.dataset.ring === (services.antigravityRing || 'split'));
      for (const pill of permissionPills) pill.classList.toggle('active', pill.dataset.mode === currentPermMode);
      renderPermissionSupport(currentPermMode);

      $('pingClis').disabled = false;
      pingLabel.textContent = 'Check CLIs';
    }

    $('pingClis').addEventListener('click', () => { $('pingClis').disabled = true; pingLabel.textContent = 'Checking…'; vscode.postMessage({ type: 'pingClis' }); });
    $('openLogs').addEventListener('click', () => {
      if (onOpenLogs) onOpenLogs();
      else vscode.postMessage({ type: 'openLogs' });
    });
    $('openSetupGuide').addEventListener('click', () => {
      if (onOpenSetupGuide) onOpenSetupGuide();
      else vscode.postMessage({ type: 'openSetupGuide' });
    });
    $('refreshModels').addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
    $('modelSettings').addEventListener('click', () => vscode.postMessage({ type: 'openModelSettings' }));
    $('resetCache').addEventListener('click', () => vscode.postMessage({ type: 'resetCliCache' }));
    $('configureTelegram').addEventListener('click', () => vscode.postMessage({ type: 'configureTelegram' }));
    $('testTelegram').addEventListener('click', () => vscode.postMessage({ type: 'testTelegram' }));
    $('disconnectTelegram').addEventListener('click', () => vscode.postMessage({ type: 'disconnectTelegram' }));
    $('toggleTunnel').addEventListener('click', () => vscode.postMessage({ type: $('toggleTunnel').textContent.startsWith('Stop') ? 'stopTunnel' : 'startTunnel' }));
    for (const pill of formatPills) {
      pill.addEventListener('click', () => {
        for (const p of formatPills) p.classList.remove('active');
        pill.classList.add('active');
        vscode.postMessage({ type: 'setTimeFormat', format: pill.dataset.format });
      });
    }
    for (const pill of namesPills) {
      pill.addEventListener('click', () => {
        for (const p of namesPills) p.classList.remove('active');
        pill.classList.add('active');
        vscode.postMessage({ type: 'setChatNames', value: pill.dataset.names });
      });
    }
    for (const pill of ringPills) {
      pill.addEventListener('click', () => {
        for (const p of ringPills) p.classList.remove('active');
        pill.classList.add('active');
        vscode.postMessage({ type: 'setAntigravityRing', value: pill.dataset.ring });
      });
    }
    for (const pill of permissionPills) {
      pill.addEventListener('click', () => {
        for (const p of permissionPills) p.classList.remove('active');
        pill.classList.add('active');
        renderPermissionSupport(pill.dataset.mode);
        vscode.postMessage({ type: 'setPermissionMode', mode: pill.dataset.mode });
      });
    }
    $('statusBar').addEventListener('click', () => {
      const on = $('statusBar').getAttribute('aria-checked') !== 'true';
      $('statusBar').setAttribute('aria-checked', String(on));
      vscode.postMessage({ type: 'setStatusBar', enabled: on });
    });
    $('autoContinueOnLimit').addEventListener('click', () => {
      const enabled = $('autoContinueOnLimit').getAttribute('aria-checked') !== 'true';
      $('autoContinueOnLimit').setAttribute('aria-checked', String(enabled));
      vscode.postMessage({ type: 'setAutoContinueOnLimit', enabled });
    });
    $('autoUpdateClis').addEventListener('click', () => {
      const enabled = $('autoUpdateClis').getAttribute('aria-checked') !== 'true';
      $('autoUpdateClis').setAttribute('aria-checked', String(enabled));
      vscode.postMessage({ type: 'setAutoUpdateClis', enabled });
    });
    $('completionSound').addEventListener('click', () => {
      const enabled = $('completionSound').getAttribute('aria-checked') !== 'true';
      $('completionSound').setAttribute('aria-checked', String(enabled));
      vscode.postMessage({ type: 'setCompletionSound', enabled });
    });
    for (const key of ['railProjects', 'railChats']) $(key).addEventListener('change', () => vscode.postMessage({ type: 'setRailLimit', key, value: Number($(key).value) }));
    $('workContextIcons').addEventListener('click', () => {
      const enabled = $('workContextIcons').getAttribute('aria-checked') !== 'true';
      $('workContextIcons').setAttribute('aria-checked', String(enabled));
      vscode.postMessage({ type: 'setWorkContextIcons', enabled });
    });
    $('sessionWarmup').addEventListener('click', () => {
      const enabled = $('sessionWarmup').getAttribute('aria-checked') !== 'true';
      $('sessionWarmup').setAttribute('aria-checked', String(enabled));
      if (!enabled) $('sessionWarmupStatusRow').hidden = true;
      vscode.postMessage({ type: 'setSessionWarmup', enabled });
    });
    // What the last pings did, one clause per CLI: "Claude Haiku 5.5 Low 06:30, 21 tokens".
    let cloudSnapshot = null, cloudDraft = false;
    const cloudPost = (action, extra = {}) => vscode.postMessage({ type: 'cloudWarmup', action, ...extra });
    const cloudDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (const day of [1, 2, 3, 4, 5, 6, 0]) {
      const row = document.createElement('div'); row.className = 'cs-cloud-day'; row.dataset.day = day;
      const label = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.field = 'enabled'; check.setAttribute('aria-label', `${cloudDayNames[day]} work day`);
      label.append(check, cloudDayNames[day].slice(0, 3)); row.append(label);
      for (const [field, title] of [['start', 'Start'], ['end', 'End']]) {
        const select = document.createElement('select'); select.className = 'cs-select'; select.dataset.field = field; select.setAttribute('aria-label', `${cloudDayNames[day]} work ${title.toLowerCase()}`);
        for (let hour = field === 'start' ? 0 : 1; hour <= (field === 'start' ? 23 : 24); hour++) {
          const option = document.createElement('option'); option.value = hour; option.textContent = `${String(hour).padStart(2, '0')}:00`; select.append(option);
        }
        const wrapper = document.createElement('label'); wrapper.append(title, select); row.append(wrapper);
      }
      const preview = document.createElement('span'); preview.className = 'cs-desc cs-cloud-preview'; row.append(preview);
      $('cloudWarmupDays').append(row);
    }
    function cloudSchedule() {
      const days = Array(7);
      for (const row of $('cloudWarmupDays').children) days[Number(row.dataset.day)] = { enabled: row.querySelector('[data-field=enabled]').checked, start: Number(row.querySelector('[data-field=start]').value), end: Number(row.querySelector('[data-field=end]').value) };
      return { timezone: $('cloudWarmupTimezone').value.trim(), leadHours: Number($('cloudWarmupLead').value), days };
    }
    function cloudPreview() {
      const schedule = cloudSchedule();
      for (const row of $('cloudWarmupDays').children) {
        const d = schedule.days[Number(row.dataset.day)], times = [];
        for (let h = d.start - schedule.leadHours; d.enabled && h >= 0 && h < d.end && times.length < 5; h += 5) times.push(`${String(h).padStart(2, '0')}:00`);
        row.querySelector('.cs-cloud-preview').textContent = d.enabled ? times.length ? `Start ${times.join(' · ')}` : 'Choose valid work hours' : 'Rest day';
        for (const select of row.querySelectorAll('select')) select.disabled = !d.enabled || Boolean(cloudSnapshot?.busy);
      }
    }
    for (const el of [$('cloudWarmupDays'), $('cloudWarmupTimezone'), $('cloudWarmupLead')]) el.addEventListener('change', () => { cloudDraft = true; cloudPreview(); });
    $('cloudWarmupTimezone').addEventListener('input', () => { cloudDraft = true; });
    $('cloudWarmupEnabled').addEventListener('click', () => cloudPost('enable', { enabled: $('cloudWarmupEnabled').getAttribute('aria-checked') !== 'true' }));
    $('cloudWarmupSave').addEventListener('click', () => { cloudDraft = false; cloudPost('save', { schedule: cloudSchedule() }); });
    $('cloudWarmupDeploy').addEventListener('click', () => {
      if (cloudDraft) { $('cloudWarmupStatus').textContent = 'Save your calendar before deploying.'; return; }
      cloudPost('deploy');
    });
    for (const [role, action] of [['Connect', 'connect'], ['Install', 'install'], ['Refresh', 'refresh'], ['Renew', 'renew'], ['Remove', 'remove'], ['Console', 'console']]) $('cloudWarmup' + role).addEventListener('click', () => cloudPost(action));
    function renderCloudWarmup(snapshot) {
      cloudSnapshot = snapshot || { enabled: false, providers: [] };
      const { enabled, deployed, connected, busy } = cloudSnapshot;
      $('cloudWarmupEnabled').setAttribute('aria-checked', String(Boolean(enabled)));
      $('cloudWarmupEnabled').disabled = Boolean(busy);
      $('cloudWarmupPanel').hidden = !enabled && !deployed && !connected;
      $('cloudWarmupStatus').textContent = cloudSnapshot.status || 'Off. No Google resources have been created.';
      $('cloudWarmupProject').textContent = connected ? `Project: ${cloudSnapshot.project} · ${cloudSnapshot.region || 'us-central1'}` : 'Requires the Google Cloud CLI and a project with billing enabled.';
      for (const button of $('cloudWarmupPanel').querySelectorAll('button')) button.disabled = Boolean(busy);
      $('cloudWarmupDeploy').disabled = Boolean(busy || !enabled || !connected);
      $('cloudWarmupRefresh').disabled = Boolean(busy || !deployed);
      $('cloudWarmupRenew').disabled = Boolean(busy || !deployed);
      $('cloudWarmupRemove').hidden = !connected;
      $('cloudWarmupConsole').hidden = !connected;
      if (!cloudDraft) {
        const schedule = cloudSnapshot.schedule || { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, leadHours: 3, days: Array.from({ length: 7 }, (_, d) => ({ enabled: d > 0 && d < 6, start: 9, end: 18 })) };
        $('cloudWarmupTimezone').value = schedule.timezone; $('cloudWarmupLead').value = schedule.leadHours;
        for (const row of $('cloudWarmupDays').children) {
          const d = schedule.days[Number(row.dataset.day)];
          row.querySelector('[data-field=enabled]').checked = d.enabled;
          for (const field of ['start', 'end']) row.querySelector(`[data-field=${field}]`).value = d[field];
        }
      }
      for (const input of $('cloudWarmupPanel').querySelectorAll('input, select')) input.disabled = Boolean(busy);
      cloudPreview();
      $('cloudWarmupEstimate').textContent = cloudSnapshot.estimate ? `Selected providers: ${cloudSnapshot.providers.filter(p => p.selected).length}. Approx. ${cloudSnapshot.estimate.callsPerWeek} prompts/week; ${cloudSnapshot.estimate.cpuSeconds.toLocaleString()} vCPU-seconds/month. Estimate excludes other Google usage and storage/build costs.` : '';
      $('cloudWarmupExpiry').textContent = cloudSnapshot.expiresAt ? `Prompt permission expires ${new Date(cloudSnapshot.expiresAt).toLocaleString()}. The timer and stored resources remain until removed.` : '';
      $('cloudWarmupProviders').replaceChildren(...(cloudSnapshot.providers || []).map(p => {
        const row = document.createElement('div'); row.className = 'cs-row';
        const info = document.createElement('div'); info.className = 'cs-info';
        const title = document.createElement('span'); title.className = 'cs-title'; title.textContent = p.label;
        const desc = document.createElement('span'); desc.className = 'cs-desc';
        const state = cloudSnapshot.states?.[p.agent];
        desc.textContent = !p.selected ? 'Not deployed; connect a subscription locally, then deploy.' : state?.status === 'reconnect' ? 'Reconnect required. Cloud prompts paused for this provider.' : p.connected ? `${state?.status || 'Ready'}${state?.at ? ` · ${new Date(state.at).toLocaleString()}` : ''}` : 'Separate cloud sign-in required.';
        info.append(title, desc); row.append(info);
        const button = document.createElement('button'); button.className = 'cs-btn'; button.type = 'button'; button.textContent = p.connected ? 'Reconnect' : 'Connect'; button.disabled = Boolean(busy || !deployed || !p.selected);
        button.addEventListener('click', () => cloudPost('authenticate', { agent: p.agent })); row.append(button); return row;
      }));
    }
    function renderWarmup(warmup) {
      const on = Boolean(warmup?.enabled);
      $('sessionWarmup').setAttribute('aria-checked', String(on));
      if (!warmup) return;
      const clock = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const parts = Object.values(warmup.last || {}).filter(item => item?.at && Date.now() - item.at < 12 * 3600000).map(item => item.status === 'running' ? `${item.label}: window already running`
        : item.status === 'failed' ? `${item.label}: failed, ${item.error || 'no answer'}` : `${item.label} ${clock(item.at)}${item.tokens != null ? `, ${item.tokens.toLocaleString()} tokens` : ''}`);
      $('sessionWarmupStatus').textContent = parts.join(' · ');
      $('sessionWarmupStatusRow').hidden = !on || !parts.length;
    }
    $('openTerminal').addEventListener('click', () => vscode.postMessage({ type: 'openTerminal' }));

    // ---------- Loops: the two switches that change what a loop does with your project ----------
    function renderLoops(state = {}) {
      $('complianceScout').setAttribute('aria-checked', String(state.scout !== false));
      $('complianceRedact').setAttribute('aria-checked', String(state.redact !== false));
    }
    for (const [role, key] of [['complianceScout', 'scout'], ['complianceRedact', 'redact']]) {
      $(role).addEventListener('click', () => {
        const on = $(role).getAttribute('aria-checked') !== 'true';
        $(role).setAttribute('aria-checked', String(on));
        vscode.postMessage({ type: 'setCompliance', key, value: on });
      });
    }
    renderLoops();

    // ---------- Voice: the hotkey, how it behaves, the sounds, the Groq key and today's usage ----------
    const modePills = body.querySelectorAll('.mode-pill');
    const hotkeyBtn = $('hotkeyBtn');
    const MODE_TEXT = {
      toggle: 'Press once to start, press again to send.',
      hold: 'Hold while you speak, release to send.',
    };
    const HOTKEY_HINT = 'Press the keys. Esc cancels, Backspace clears.';
    const GROQ_INTRO = 'Paste an API key to connect your account.';
    let voiceState = null;
    let capturing = false;
    let captureEndedAt = 0;

    const untilReset = (at) => {
      const minutes = Math.max(1, Math.round((at - Date.now()) / 60000));
      return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    };

    function renderGroq(groq) {
      const tag = groq.source === 'account' ? ['ok', 'Account key'] : groq.source === 'env' ? ['ok', 'Key from .env'] : ['', 'No key'];
      setTag($('groqTag'), ...tag);
      $('groqDesc').textContent = !groq.source ? GROQ_INTRO
        : groq.source === 'env' ? `Connected with ${groq.masked}, from voice-router/.env. Paste a key below to use your own account instead.`
          : `Connected with ${groq.masked}.`;
      $('groqRemove').hidden = groq.source !== 'account';
      const kinds = [['chat', 'Background tasks'], ['transcription', 'Transcription']].filter(([kind]) => groq.limits[kind]);
      $('usageDesc').textContent = `${groq.today.calls} request${groq.today.calls === 1 ? '' : 's'} from here today (UTC)${kinds.length ? '' : '. Press Check now to see the daily limit.'}`;
      $('usageList').replaceChildren(...kinds.map(([kind, label]) => {
        const seen = groq.limits[kind];
        const used = Math.max(0, seen.limit - seen.remaining);
        const row = document.createElement('div');
        row.className = 'cs-usage-row';
        row.innerHTML = '<div class="cs-usage-head"><span></span><span></span></div><div class="cs-usage-bar"><b></b></div>';
        const [name, left] = row.querySelectorAll('.cs-usage-head span');
        name.textContent = `${label} · ${used} / ${seen.limit}`;
        left.textContent = `${seen.remaining} left${seen.resetsAt ? ` · resets ${untilReset(seen.resetsAt)}` : ''}`;
        const bar = row.querySelector('.cs-usage-bar');
        bar.style.setProperty('--used', seen.limit ? Math.min(100, (used / seen.limit) * 100).toFixed(1) : 0);
        bar.classList.toggle('is-high', seen.limit > 0 && used / seen.limit >= 0.8);
        return row;
      }));
    }

    // The microphone list comes from the host (ffmpeg's view of the Windows capture devices); the saved choice
    // stays selectable, marked, when its device is unplugged, so opening Settings never silently changes it.
    let micList = null;
    let micAuto = ''; // the microphone Automatic resolves to (Windows' default input), shown beside the word
    const micRoot = $('micSelect');
    const micTrigger = micRoot.querySelector('.cs-dd-trigger');
    const micMenu = micRoot.querySelector('.cs-dd-menu');
    function renderMics() {
      const chosen = voiceState?.micDevice || '';
      const missing = micList && chosen && !micList.includes(chosen);
      const options = [['', micAuto ? `Automatic (${micAuto})` : 'Automatic'], ...(micList || (chosen ? [chosen] : [])).map((name) => [name, name]), ...(missing ? [[chosen, `${chosen} (not connected)`]] : [])];
      micMenu.replaceChildren(...options.map(([value, text]) => {
        const option = document.createElement('button');
        option.type = 'button'; option.className = 'cs-dd-option'; option.setAttribute('role', 'option');
        option.innerHTML = `<span class="cs-dd-text"></span>${ICON.check}`;
        option.querySelector('.cs-dd-text').textContent = text;
        option.dataset.value = value; option.title = text;
        option.setAttribute('aria-selected', String(value === chosen));
        option.classList.toggle('is-selected', value === chosen);
        return option;
      }));
      const label = (options.find(([value]) => value === chosen) || options[0])[1];
      micTrigger.querySelector('.cs-dd-value').textContent = label;
      micTrigger.title = label;
      $('micDesc').textContent = micList && !micList.length ? 'No microphone found. Plug one in and reopen this tab.'
        : missing ? 'This microphone is not connected, so dictation uses the first one available.'
          : 'Used for dictation. A change applies to the next recording.';
    }
    function setMicOpen(open) {
      micRoot.classList.toggle('is-open', open);
      micTrigger.setAttribute('aria-expanded', String(open));
      micMenu.hidden = !open;
      if (open) (micMenu.querySelector('.is-selected') || micMenu.firstElementChild)?.focus();
    }
    function pickMic(value) {
      voiceState = { ...voiceState, micDevice: value };
      renderMics();
      setMicOpen(false);
      micTrigger.focus();
      vscode.postMessage({ type: 'setVoiceMic', device: value });
    }
    micTrigger.addEventListener('click', () => setMicOpen(micMenu.hidden));
    micTrigger.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMicOpen(true); } });
    micMenu.addEventListener('click', (event) => { const option = event.target.closest('.cs-dd-option'); if (option) pickMic(option.dataset.value); });
    micMenu.addEventListener('keydown', (event) => {
      const items = [...micMenu.children];
      const at = items.indexOf(document.activeElement);
      const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
      if (move != null) { event.preventDefault(); items[(move + items.length) % items.length]?.focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMicOpen(false); micTrigger.focus(); }
      else if (event.key === 'Tab') setMicOpen(false);
    });
    document.addEventListener('pointerdown', (event) => { if (!micMenu.hidden && !micRoot.contains(event.target)) setMicOpen(false); });

    function renderVoice() {
      const state = voiceState;
      if (!state) return;
      hotkeyBtn.textContent = capturing ? 'Press keys…' : state.hotkey || 'Set hotkey';
      $('hotkeyClear').hidden = !state.hotkey || capturing;
      $('hotkeyDesc').textContent = capturing ? HOTKEY_HINT
        : !state.supported ? 'Global hotkeys need Windows.'
          : !state.hotkey ? 'Start and stop dictation from anywhere, without the mic button.'
            : state.hotkeyActive ? 'Works in any app. Pick keys the app in front does not use.'
              : 'Saved, but not listening. Reload the window to retry.';
      for (const pill of modePills) pill.classList.toggle('active', pill.dataset.mode === state.mode);
      $('modeDesc').textContent = MODE_TEXT[state.mode];
      $('voiceSounds').setAttribute('aria-checked', String(state.sounds));
      $('voicePauseMedia').setAttribute('aria-checked', String(state.pauseMedia !== false));
      renderMics();
      renderGroq(state.groq);
    }

    function stopCapture() {
      capturing = false;
      captureEndedAt = Date.now();
      hotkeyBtn.classList.remove('is-listening');
      renderVoice();
    }
    // Captured before anything else hears the keys (the popup's own Esc included), while the button is listening.
    window.addEventListener('keydown', (event) => {
      if (!capturing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { stopCapture(); return; }
      if (event.key === 'Backspace' || event.key === 'Delete') { vscode.postMessage({ type: 'setVoiceHotkey', hotkey: '' }); stopCapture(); return; }
      const combo = window.voiceHotkey.fromKeyEvent(event);
      if (combo) { vscode.postMessage({ type: 'setVoiceHotkey', hotkey: combo }); stopCapture(); }
      else if (!/^(Control|Alt|Shift|Meta|OS)/.test(event.code)) $('hotkeyDesc').textContent = 'Add Ctrl, Alt or Win (an F key works alone).';
    }, true);
    hotkeyBtn.addEventListener('click', () => {
      if (Date.now() - captureEndedAt < 400) return; // the key that ended the capture, released on the button
      capturing = !capturing;
      hotkeyBtn.classList.toggle('is-listening', capturing);
      renderVoice();
    });
    hotkeyBtn.addEventListener('blur', () => { if (capturing) stopCapture(); });
    $('hotkeyClear').addEventListener('click', () => vscode.postMessage({ type: 'setVoiceHotkey', hotkey: '' }));
    for (const pill of modePills) {
      pill.addEventListener('click', () => {
        for (const p of modePills) p.classList.toggle('active', p === pill);
        $('modeDesc').textContent = MODE_TEXT[pill.dataset.mode];
        vscode.postMessage({ type: 'setVoiceMode', mode: pill.dataset.mode });
      });
    }
    $('voiceSounds').addEventListener('click', () => {
      const on = $('voiceSounds').getAttribute('aria-checked') !== 'true';
      $('voiceSounds').setAttribute('aria-checked', String(on));
      vscode.postMessage({ type: 'setVoiceSounds', enabled: on });
    });
    $('voicePauseMedia').addEventListener('click', () => {
      const on = $('voicePauseMedia').getAttribute('aria-checked') !== 'true';
      $('voicePauseMedia').setAttribute('aria-checked', String(on));
      voiceState = { ...voiceState, pauseMedia: on };
      vscode.postMessage({ type: 'setVoicePauseMedia', enabled: on });
    });

    const groqStatus = (text, state = '') => { $('groqStatus').className = `cs-status${state ? ` is-${state}` : ''}`; $('groqStatus').textContent = text; };
    function saveGroqKey() {
      if (!$('groqKey').value.trim()) { groqStatus('Paste a key first.', 'error'); return; }
      $('groqSave').disabled = true;
      groqStatus('Checking the key with Groq…');
      vscode.postMessage({ type: 'saveGroqKey', key: $('groqKey').value });
    }
    $('groqSave').addEventListener('click', saveGroqKey);
    $('groqKey').addEventListener('keydown', (event) => { if (event.key === 'Enter') saveGroqKey(); });
    $('groqRemove').addEventListener('click', () => { groqStatus('Key removed.'); vscode.postMessage({ type: 'clearGroqKey' }); });
    $('groqGetKey').addEventListener('click', () => vscode.postMessage({ type: 'openGroqConsole' }));
    $('groqUsagePage').addEventListener('click', () => vscode.postMessage({ type: 'openGroqConsole', page: 'usage' }));
    $('groqCheck').addEventListener('click', () => {
      $('groqCheck').disabled = true;
      $('groqCheck').querySelector('span').textContent = 'Checking…';
      vscode.postMessage({ type: 'checkGroqUsage' });
    });
    function groqResult({ action, ok, error }) {
      if (action === 'save') {
        $('groqSave').disabled = false;
        groqStatus(ok ? 'Key saved. Background tasks now use your account.' : error, ok ? 'ok' : 'error');
        if (ok) $('groqKey').value = '';
      } else {
        $('groqCheck').disabled = false;
        $('groqCheck').querySelector('span').textContent = 'Check now';
        groqStatus(ok ? '' : `Could not check: ${error}`, ok ? '' : 'error');
      }
    }
    function voice(state) { voiceState = state; renderVoice(); }
    function micDevices(devices, automatic = '') { micList = devices; micAuto = automatic; renderMics(); }

    // Dictionary: every project has its own words and a few shared ones work in all of them. The list shows one dictionary
    // at a time (or all), searchable. The host owns the file and answers every action with the whole list, so what an AI
    // wrote into it shows up the same way. The limits and the project list arrive with the data.
    const dictStatus = (text, state = '') => { $('dictStatus').className = `cs-status${state ? ` is-${state}` : ''}`; $('dictStatus').textContent = text; };
    const SCOPE_ALL = '*';
    let dictEntries = [];
    let dictUsage = null;
    let dictProjects = [];        // the project list (projectIcons)
    let dictKnown = [];           // the dictionary's own view of it: { id, name, hasFolder }
    let dictCurrent = '';         // the project of the chat window in front
    let dictScope = null;         // SCOPE_ALL, '' (the shared words) or a project id; chosen when the first list arrives
    let dictSuggestions = { add: [], share: [] };
    let dictReport = [];
    let dictEditing = null;
    let dictReveal = '';
    let dictScanning = false;
    const DICT_ROWS = 300; // a long dictionary is searched, not scrolled: drawing thousands of rows would only slow the window

    const dictProjectList = () => (dictKnown.length ? dictKnown : dictProjects.map((project) => ({ id: project.id, name: project.name, hasFolder: Boolean(project.root) })));
    const dictName = (id) => (id ? dictProjectList().find((project) => project.id === id)?.name || 'Removed project' : 'Shared');
    const dictEditKey = (entry) => `${entry.projectId || ''}|${entry.term}`;
    const dictInScope = (entry) => dictScope === SCOPE_ALL || (entry.projectId || '') === dictScope;
    /** Where a new word goes: the dictionary on show, or, when showing everything, the project in front. */
    const dictTarget = () => (dictScope === SCOPE_ALL ? (dictProjectList().some((project) => project.id === dictCurrent) ? dictCurrent : '') : dictScope);

    function dictRow(entry, showScope) {
      const row = document.createElement('div');
      row.className = 'cs-dict-row';
      row.setAttribute('role', 'listitem');
      row.classList.toggle('is-off', !entry.enabled);
      const owner = entry.projectId || '';
      const startEdit = () => { dictEditing = dictEditKey(entry); renderDictionary(); };
      let label;
      if (dictEditing === dictEditKey(entry)) {
        label = document.createElement('input');
        label.className = 'cs-field cs-dict-edit'; label.type = 'text'; label.maxLength = 60; label.value = entry.term;
        label.spellcheck = false; label.setAttribute('aria-label', `Rename ${entry.term}`);
        const finish = (save) => {
          if (dictEditing !== dictEditKey(entry)) return;
          dictEditing = null;
          const next = label.value.trim();
          if (save && next && next !== entry.term) vscode.postMessage({ type: 'voiceDictionaryEdit', term: entry.term, projectId: owner, next });
          else renderDictionary();
        };
        label.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); finish(true); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
        });
        label.addEventListener('blur', () => finish(true));
        queueMicrotask(() => { label.focus(); label.select(); });
      } else {
        label = document.createElement('span');
        label.className = 'cs-dict-term'; label.textContent = entry.term; label.title = entry.term;
        label.addEventListener('dblclick', startEdit);
      }
      const main = document.createElement('div');
      main.className = 'cs-dict-main';
      const tags = document.createElement('div');
      tags.className = 'cs-dict-tags';
      main.append(label, tags);
      row.append(main);
      const tag = (text, title, className = '') => {
        const node = document.createElement('span');
        node.className = `cs-dict-source${className ? ` ${className}` : ''}`; node.textContent = text; node.title = title;
        tags.append(node);
      };
      if (showScope) tag(owner ? dictName(owner) : 'Shared', owner ? `Only used when dictating in ${dictName(owner)}` : 'Used in every project', owner ? 'is-project' : 'is-shared');
      if (entry.source === 'scan') tag('scan', `Found by scanning ${entry.project || 'a project'}`);
      else if (entry.source === 'ai') tag('AI', 'Added by an AI');
      tags.hidden = !tags.children.length;
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'cs-switch is-small'; toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(entry.enabled)); toggle.setAttribute('aria-label', `Use ${entry.term} in dictation`);
      toggle.title = entry.enabled ? 'On: used in dictation' : 'Off: kept, but not used';
      toggle.addEventListener('click', () => vscode.postMessage({ type: 'voiceDictionaryEdit', term: entry.term, projectId: owner, enabled: !entry.enabled }));
      const iconButton = (icon, title, className, onClick) => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = `cs-icon-btn ${className}`; button.innerHTML = icon; button.title = title;
        button.setAttribute('aria-label', `${title} ${entry.term}`);
        button.addEventListener('click', onClick);
        return button;
      };
      const buttons = [];
      const home = owner ? '' : (dictScope !== SCOPE_ALL && dictScope ? dictScope : dictProjectList().some((project) => project.id === dictCurrent) ? dictCurrent : '');
      if (owner) buttons.push(iconButton(ICON.globe, 'Share with every project:', '', () => vscode.postMessage({ type: 'voiceDictionaryMove', term: entry.term, projectId: owner, to: '' })));
      else if (home) buttons.push(iconButton(ICON.folder, `Use only in ${dictName(home)}:`, '', () => vscode.postMessage({ type: 'voiceDictionaryMove', term: entry.term, projectId: '', to: home })));
      const acts = document.createElement('div');
      acts.className = 'cs-dict-acts';
      acts.append(...buttons, iconButton(ICON.pencil, 'Rename', '', startEdit),
        iconButton(ICON.trash, 'Delete', 'is-danger', () => vscode.postMessage({ type: 'voiceDictionaryRemove', term: entry.term, projectId: owner })));
      row.append(toggle, acts);
      if (entry.term === dictReveal) { dictReveal = ''; queueMicrotask(() => row.scrollIntoView({ block: 'nearest' })); }
      return row;
    }

    function renderDictScope() {
      const select = $('dictScope');
      const counts = dictUsage?.byProject || {};
      const shared = dictUsage?.shared ?? dictEntries.filter((entry) => !entry.projectId).length;
      const options = [[SCOPE_ALL, `All words (${dictEntries.length.toLocaleString('en')})`], ['', `Shared by every project (${shared.toLocaleString('en')})`],
        ...dictProjectList().map((project) => [project.id, `${project.name} (${(counts[project.id] || 0).toLocaleString('en')})`])];
      select.replaceChildren(...options.map(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; return option; }));
      select.value = dictScope === null ? SCOPE_ALL : dictScope;
    }

    function renderDictSuggestions() {
      const box = $('dictSuggest');
      const items = [...dictSuggestions.share.map((item) => ({ ...item, kind: 'share' })), ...dictSuggestions.add.map((item) => ({ ...item, kind: 'add' }))];
      box.hidden = !items.length;
      if (!items.length) { box.replaceChildren(); return; }
      const head = document.createElement('span');
      head.className = 'cs-dict-suggest-head'; head.textContent = 'Suggested';
      const rows = items.map((item) => {
        const line = document.createElement('div');
        line.className = 'cs-dict-hint'; line.setAttribute('role', 'listitem');
        const text = document.createElement('span');
        text.className = 'cs-dict-hint-text';
        const word = document.createElement('b'); word.textContent = item.term;
        text.append(word, item.kind === 'share' ? ` was used in ${item.projects} projects. Share it with all of them?` : ` came up in ${item.count} of your messages in ${dictName(item.projectId)}. Add it there?`);
        const act = (accept) => vscode.postMessage({ type: 'voiceDictionarySuggestion', kind: item.kind, term: item.term, projectId: item.projectId, accept });
        const yes = document.createElement('button');
        yes.type = 'button'; yes.className = 'cs-btn is-small'; yes.textContent = item.kind === 'share' ? 'Share' : 'Add';
        yes.setAttribute('aria-label', `${yes.textContent} ${item.term}`);
        yes.addEventListener('click', () => act(true));
        const no = document.createElement('button');
        no.type = 'button'; no.className = 'cs-icon-btn'; no.innerHTML = ICON.close; no.title = 'Dismiss'; no.setAttribute('aria-label', `Dismiss ${item.term}`);
        no.addEventListener('click', () => act(false));
        line.append(text, yes, no);
        return line;
      });
      box.replaceChildren(head, ...rows);
    }

    function renderDictionary() {
      const limits = dictUsage?.limits || {};
      const query = $('dictSearch').value.trim().toLowerCase();
      renderDictScope();
      const scoped = dictEntries.filter(dictInScope);
      const shown = scoped.filter((entry) => !query || entry.term.toLowerCase().includes(query));
      const nearFull = limits.entries && dictEntries.length >= limits.entries * 0.95; // the count is only worth a number when the file is about to refuse words
      setTag($('dictTag'), nearFull ? 'warn' : '', nearFull ? `${dictEntries.length.toLocaleString('en')} / ${limits.entries.toLocaleString('en')}` : `${scoped.length.toLocaleString('en')} words`);
      const target = dictTarget();
      $('dictNew').placeholder = target ? `Add a word for ${dictName(target)}…` : 'Add a shared word or name…';
      $('dictDesc').textContent = dictScope === SCOPE_ALL ? 'Every project has its own words, plus a few shared ones.'
        : dictScope ? `Used only when dictating in ${dictName(dictScope)}, with a few shared words.` : 'Used in every project, but only a few fit each recording.';
      if (shown.length) {
        const visible = shown.slice(0, DICT_ROWS);
        const fresh = shown.find((entry) => entry.term === dictReveal);
        if (fresh && !visible.includes(fresh)) visible.push(fresh); // a word just added always shows
        const rows = visible.map((entry) => dictRow(entry, dictScope === SCOPE_ALL));
        if (shown.length > visible.length) {
          const more = document.createElement('p');
          more.className = 'cs-dict-empty';
          more.textContent = `${(shown.length - visible.length).toLocaleString('en')} more. Search to find a word.`;
          rows.push(more);
        }
        $('dictList').replaceChildren(...rows);
      }
      else {
        const empty = document.createElement('p');
        empty.className = 'cs-dict-empty';
        empty.textContent = query ? `No word matches “${$('dictSearch').value.trim()}”.`
          : dictScope && dictScope !== SCOPE_ALL ? `No words for ${dictName(dictScope)} yet. Scan the project, add one above, or correct a dictated word in its chat.`
            : 'No words yet. Add one above, scan your projects, or correct a dictated word in the composer and Clanker offers to keep it.';
        $('dictList').replaceChildren(empty);
      }
      const scanned = scoped.filter((entry) => entry.source === 'scan').length;
      $('dictClearScanned').hidden = !scanned;
      $('dictClearScanned').textContent = `Remove ${scanned} scanned word${scanned === 1 ? '' : 's'}`;
      renderDictSuggestions();
      renderDictProjects();
      renderDictReport();
    }

    function renderDictProjects() {
      $('dictScanAll').disabled = dictScanning;
      const withFolder = dictProjectList().filter((project) => project.hasFolder);
      $('dictProjects').hidden = !withFolder.length;
      $('dictProjects').replaceChildren(...withFolder.map((project) => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'cs-btn is-small'; button.textContent = project.name; button.title = `Scan ${project.name} again`; button.disabled = dictScanning;
        button.addEventListener('click', () => {
          dictScanning = true;
          renderDictProjects();
          dictStatus(`Scanning ${project.name}…`);
          vscode.postMessage({ type: 'voiceDictionaryScan', id: project.id });
        });
        return button;
      }));
    }

    function renderDictReport() {
      const box = $('dictReport');
      box.hidden = !dictReport.length;
      box.replaceChildren(...dictReport.map((item) => {
        const row = document.createElement('div');
        row.className = 'cs-dict-report-row'; row.setAttribute('role', 'listitem');
        const name = document.createElement('span'); name.className = 'cs-dict-report-name'; name.textContent = item.name;
        const result = document.createElement('span'); result.className = 'cs-dict-report-result';
        result.textContent = item.status === 'no-folder' ? 'no folder' : item.status === 'error' ? 'could not read'
          : `${item.added} new · ${item.updated} refreshed${item.removed ? ` · ${item.removed} dropped` : ''}`;
        row.append(name, result);
        return row;
      }));
    }

    function voiceDictionary({ entries = [], usage = null, error = '', notice = '', progress = '', scanning, projects, current, suggestions, report }) {
      dictEntries = entries; dictUsage = usage;
      if (Array.isArray(projects)) dictKnown = projects;
      if (typeof current === 'string') dictCurrent = current;
      if (suggestions) dictSuggestions = { add: suggestions.add || [], share: suggestions.share || [] };
      if (Array.isArray(report)) dictReport = report;
      if (typeof scanning === 'boolean') dictScanning = scanning;
      if (error) dictStatus(error, 'error'); else if (progress) dictStatus(progress); else if (notice) dictStatus(notice, 'ok');
      const known = dictProjectList();
      if (dictScope === null) dictScope = known.some((project) => project.id === dictCurrent) ? dictCurrent : SCOPE_ALL; // open on the project you are working in
      else if (dictScope && dictScope !== SCOPE_ALL && !known.some((project) => project.id === dictScope)) dictScope = SCOPE_ALL;
      if (dictEditing && !entries.some((entry) => dictEditKey(entry) === dictEditing)) dictEditing = null;
      renderDictionary();
    }
    function addDictWord() {
      const term = $('dictNew').value.trim();
      if (!term) { dictStatus('Type a word first.', 'error'); return; }
      dictStatus('');
      dictReveal = term;
      $('dictSearch').value = '';
      $('dictNew').value = '';
      vscode.postMessage({ type: 'voiceDictionaryAdd', term, projectId: dictTarget() });
    }
    $('dictAdd').addEventListener('click', addDictWord);
    $('dictNew').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addDictWord(); } });
    $('dictSearch').addEventListener('input', renderDictionary);
    $('dictScope').addEventListener('change', () => { dictScope = $('dictScope').value; dictEditing = null; renderDictionary(); });
    $('dictScanAll').addEventListener('click', () => {
      dictScanning = true;
      dictReport = [];
      renderDictionary();
      dictStatus('Scanning all projects…');
      vscode.postMessage({ type: 'voiceDictionaryScan', all: true });
    });
    $('dictAI').addEventListener('click', () => vscode.postMessage({ type: 'voiceDictionaryWithAI' }));
    $('dictClearScanned').addEventListener('click', () => vscode.postMessage({ type: 'voiceDictionaryClearScanned', ...(dictScope === SCOPE_ALL ? {} : { projectId: dictScope }) }));

    // Project icons: one row per registered project. The extension owns the storage (projects.json) and answers every
    // action with a fresh 'projectIcons' list, so a favicon an AI wrote into the file appears here too.
    const monogram = (name) => {
      const words = String(name || '?').split(/[\s\-_.]+/).filter(Boolean);
      return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).replace(/^./, (c) => c.toUpperCase());
    };
    function projectIcons(projects) {
      dictProjects = projects;
      renderDictionary();
      $('projectIconCount').textContent = `${projects.length}`;
      $('projectIconCount').setAttribute('aria-label', `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`);
      if (!projects.length) {
        const empty = document.createElement('p');
        empty.className = 'cs-project-empty'; empty.textContent = 'Add a project from the rail to customize its icon.';
        $('projectIcons').replaceChildren(empty);
        return;
      }
      $('projectIcons').replaceChildren(...projects.map((project) => {
        const row = document.createElement('div');
        row.className = 'cs-row cs-project';
        const tile = document.createElement('span');
        tile.className = 'cs-project-tile';
        tile.textContent = monogram(project.name);
        if (project.iconUri) { // the initials stay until the image has loaded, and if it never does
          const img = document.createElement('img');
          img.alt = '';
          img.addEventListener('load', () => { img.classList.toggle('is-dark', Boolean(window.isDarkIcon?.(img))); tile.replaceChildren(img); });
          img.src = project.iconUri;
        }
        const info = document.createElement('div');
        info.className = 'cs-info';
        const title = document.createElement('span');
        title.className = 'cs-title'; title.textContent = project.name; title.title = project.name;
        const desc = document.createElement('span');
        desc.className = 'cs-desc';
        desc.textContent = project.icon ? (project.iconUri ? project.icon : 'Image unavailable · using initials') : 'Using initials';
        desc.title = project.icon || 'Choose an image, or detect one in the project folder.';
        desc.classList.toggle('is-warn', Boolean(project.icon && !project.iconUri));
        const actions = document.createElement('div');
        actions.className = 'cs-project-actions';
        const action = (label, title, type, hidden = false) => {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'cs-btn is-small'; button.textContent = label; button.title = title; button.hidden = hidden;
          button.setAttribute('aria-label', `${label.replace('…', '')} icon for ${project.name}`);
          button.addEventListener('click', () => vscode.postMessage({ type, id: project.id }));
          return button;
        };
        actions.append(
          action('Choose…', 'Pick an image file', 'pickProjectIcon'),
          action('Detect', 'Look for a favicon or logo in the project folder', 'detectProjectIcon', !project.root),
          action('Ask AI', 'Have the chat find it and save it for you', 'projectIconWithAI', !project.root),
          action('Clear', 'Back to the initials', 'clearProjectIcon', !project.icon),
        );
        info.append(title, desc);
        row.append(tile, info, actions);
        return row;
      }));
    }

    function apiValue(value) {
      const fmt = window.apiValue.formatUsd;
      $('apiValueTotal').textContent = `≈ ${fmt(value.totalUsd)}`;
      $('apiValueRange').textContent = `${window.apiValue.formatRange(value.totalUsd)} · ±20%`;
      $('apiValueRows').replaceChildren(...REGISTRY.map(provider => {
        const row = document.createElement('div');
        row.className = 'cs-row';
        const mark = document.createElement('span');
        mark.className = 'cs-icon'; mark.innerHTML = ICONS[provider.id] || '';
        const name = document.createElement('span');
        name.className = 'cs-info cs-title'; name.textContent = provider.name;
        const amount = document.createElement('span');
        amount.className = 'cs-api-value-amount'; amount.textContent = fmt(value.byAgent?.[provider.id]);
        row.append(mark, name, amount);
        return row;
      }));
      const day = iso => iso ? new Date(iso).toLocaleDateString(window.TIME_PREFS?.locale, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const prices = value.prices?.liveAt ? `prices updated ${day(value.prices.liveAt)}` : value.prices?.verified ? `prices as of ${day(value.prices.verified)}` : '';
      $('apiValueFoot').textContent = [`This month ≈ ${fmt(value.monthUsd)}`, value.since ? `since ${day(value.since)}` : '', prices, value.unpriced ? `${value.unpriced} turn${value.unpriced === 1 ? '' : 's'} of unlisted models not counted` : ''].filter(Boolean).join(' · ');
    }

    showTab('general');
    return { fleet, cliStatus, cliConnections, showTab, voice, micDevices, projectIcons, voiceDictionary, groqResult, routingResult, apiValue,
      mountModelPicker(container) {
        if (container) {
          container.append(modelPickerCard);
          vscode.postMessage({ type: 'requestCliStatus' });
          if (!status.fetched.length && !status.modelsBusy) vscode.postMessage({ type: 'refreshModels' });
        } else modelPickerHome.after(modelPickerCard);
      },
      chatCost: usd => { $('apiValueChat').textContent = `Current chat ≈ ${window.apiValue.formatUsd(usd)}`; },
    };
  };
})();
