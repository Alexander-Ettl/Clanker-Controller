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
  ];
  const CLI_NAMES = Object.fromEntries(REGISTRY.map((provider) => [provider.id, provider.cli]));
  const PROVIDERS = window.PROVIDER_IDS || ['claude', 'codex', 'gemini']; // from the extension's registry (agent-icons.js)

  const svg = (paths) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
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
      tag: !connection.enabled ? 'Not added' : ready ? connection.auth === 'ready' ? 'Ready' : 'Connected' : connection.settingUp ? 'Setting up' : !connection.installed ? 'Not installed' : 'Sign in',
      action: connection.settingUp && !ready ? 'Open setup' : !connection.installed ? 'Install & sign in' : ready ? 'Add CLI' : 'Sign in / Sign up',
      description: connection.note || (connection.auth === 'ready' ? 'CLI is ready. Complete Google sign-in in its terminal if prompted.' : ready ? 'Account connected on this computer.' : 'Use your existing account, or create one during sign-in.'),
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

  window.initCliSetup = function ({ vscode, body, onClose }) {
    body.classList.add('cs', 'cs-setup');
    body.innerHTML = `<div class="cs-setup-hero"><span class="cs-setup-mark"><img src="${window.CLANKER_MARK || ''}" alt="" /></span><h2>Your models. One place.</h2><p>Connect your first CLI, or set up all three. Each provider opens its own sign-in so you can log in or create an account.</p></div>
      <div class="cs-setup-tools"><button class="cs-btn is-primary" data-role="connectAll" type="button">Set up all three</button><button class="cs-btn" data-role="checkConnections" type="button">${ICON.refresh}<span>Check connections</span></button></div>
      <div class="cs-setup-providers" data-role="setupProviders"></div>
      <p class="cs-note cs-setup-note" role="status" data-role="setupProgress">Choose a provider to get started.</p>
      <div class="cs-setup-footer"><button class="cs-btn is-quiet" data-role="setupLater" type="button">Set up later</button><button class="cs-btn is-primary" data-role="setupContinue" type="button" disabled>Start chatting</button></div>`;
    const $ = role => body.querySelector(`[data-role="${role}"]`);
    $('connectAll').addEventListener('click', () => vscode.postMessage({ type: 'connectAllClis' }));
    $('checkConnections').addEventListener('click', () => vscode.postMessage({ type: 'checkCliConnections' }));
    $('setupLater').addEventListener('click', onClose);
    $('setupContinue').addEventListener('click', onClose);
    return {
      update(snapshot) {
        const providers = snapshot.providers || {};
        const ready = PROVIDERS.filter(agent => providers[agent]?.enabled && connectionDetails(providers[agent]).ready).length;
        $('setupContinue').disabled = ready === 0 || snapshot.checking;
        $('connectAll').disabled = ready === 3 || snapshot.checking;
        $('checkConnections').disabled = snapshot.checking;
        $('checkConnections').querySelector('span').textContent = snapshot.checking ? 'Checking…' : 'Check connections';
        $('setupProgress').textContent = snapshot.checking ? 'Checking your CLI connections…' : ready ? `${ready} of 3 CLIs ready. You can add the others in Settings whenever you like.` : 'Finish sign-in, then check connections. One CLI is enough to start.';
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
          card.append(connectionActions(agent, connection, vscode));
          return card;
        }));
      },
    };
  };

  const MARKUP = `
    <div class="cs-tabs pill-track" role="tablist" aria-label="Clanker Controller settings">
      <button class="cs-tab" role="tab" data-tab="general" aria-selected="true" type="button">${ICON.sliders}<span>General</span></button>
      <button class="cs-tab" role="tab" data-tab="models" aria-selected="false" type="button">${ICON.cube}<span>Models</span></button>
      <button class="cs-tab" role="tab" data-tab="routing" aria-selected="false" type="button">${ICON.server}<span>Routing</span></button>
      <button class="cs-tab" role="tab" data-tab="voice" aria-selected="false" type="button">${ICON.mic}<span>Voice</span></button>
      <button class="cs-tab" role="tab" data-tab="remote" aria-selected="false" type="button">${ICON.tunnel}<span>Remote</span></button>
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
          <div class="cs-company-filters" role="group" aria-label="Filter models by company" data-role="companyFilters"></div>
          <span class="cs-model-count" data-role="modelCount" role="status"></span>
        </div>
        <div class="cs-model-list" data-role="modelList"></div>
      </section>
      <div class="cs-footer">
        <button class="cs-btn" data-role="pingClis" type="button">${ICON.refresh}<span>Check CLIs</span></button>
        <button class="cs-btn is-quiet" data-role="modelSettings" type="button">${ICON.sliders}<span>Advanced settings</span></button>
        <button class="cs-btn is-quiet" data-role="resetCache" type="button" title="Forget resolved CLI paths and look them up again">${ICON.reset}<span>Reset CLI cache</span></button>
      </div>
    </div>`;

  window.initChatSettings = function initChatSettings({ vscode, body }) {
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

    const MODE_NAMES = { manual: 'Manual', shadow: 'Shadow', auto: 'Auto' };
    const SERVICES = {
      cloudflare: {
        name: 'Cloudflare Workers AI', icon: ICON.tunnel, tint: '#f6821f',
        blurb: 'Reads your message (and screenshots) and picks the model. Fast and free.',
        note: 'Stay on the Workers Free plan (10,000 Neurons a day, no card needed) so overage can never be billed.',
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
    const TIER_CAPS = { image_width: 1024, image_bytes: 190000, timeout_ms: 5000, retention_days: 365, cloudflare_neurons: 10000, groq_rpm: 30, groq_rpd: 1000, groq_tpm: 18000, groq_tpd: 200000 };

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
      const save = (change) => { change(cfg); vscode.postMessage({ type: 'routingSave', config: cfg }); routingAction = { kind: 'save' }; setRoutingStatus('Saving…'); };
      const labelled = (n, title, hint) => el('div', 'cs-section', `<span class="cs-step-no">${n}</span><span class="cs-section-title">${title}</span><span class="cs-section-hint">${hint}</span>`);
      const button = (label, onClick, className = '', icon = '') => { const node = el('button', `cs-btn ${className}`, `${icon}<span></span>`); node.type = 'button'; node.querySelector('span').textContent = label; node.addEventListener('click', onClick); return node; };
      const link = (label, key) => button(label, () => vscode.postMessage({ type: 'openRoutingLink', key }), 'is-small is-quiet', ICON.ext);

      // Controls. Each one saves itself the moment it changes.
      const sw = (value, onChange, label) => { const node = el('button', 'cs-switch'); node.type = 'button'; node.setAttribute('role', 'switch'); node.setAttribute('aria-checked', String(!!value)); node.setAttribute('aria-label', label); node.addEventListener('click', () => { const next = node.getAttribute('aria-checked') !== 'true'; node.setAttribute('aria-checked', String(next)); onChange(next); }); return node; };
      const num = (value, name, onChange) => { const node = el('input', 'cs-num'); node.type = 'number'; node.min = '1'; if (TIER_CAPS[name]) node.max = String(TIER_CAPS[name]); node.value = value; node.addEventListener('change', () => onChange(Number(node.value))); return node; };
      const percent = (value, onChange) => {
        const wrap = el('div', 'cs-slider'); const range = el('input'); range.type = 'range'; range.min = '5'; range.max = '95'; range.step = '1'; range.value = Math.round(value * 100);
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

      // 1. What it is. The mode itself is switched in the chat's model menu, where it is used; here it is only shown.
      const hero = el('section', 'cs-card cs-route-hero');
      const chip = (name) => `<span class="cs-chip-state${connected[name] ? ' is-ok' : ''}"><i></i>${name === 'groq' ? 'Groq' : 'Cloudflare'} ${connected[name] ? 'connected' : 'not connected'}</span>`;
      hero.innerHTML = `<div class="cs-row"><span class="cs-icon">${ICON.route}</span><div class="cs-info"><span class="cs-title">Smart routing</span><span class="cs-desc">A small, free AI reads each message and picks the best model for it, so easy tasks do not burn your best model's quota.</span></div></div><div class="cs-chip-states">${chip('cloudflare')}${chip('groq')}</div><p class="cs-mode-note"></p>`;
      hero.querySelector('.cs-mode-note').textContent = `Mode: ${MODE_NAMES[cfg.router_mode]}. Switch it in the chat's model menu (Manual, Shadow or Auto). Connect a service below first.`;

      // 2. Today's usage, in the bars the Voice tab uses.
      const usage = snapshot.usage || {};
      const bar = (name, used, cap) => {
        const pct = Math.min(100, Math.round((used / cap) * 100));
        const row = el('div', 'cs-usage-row', `<div class="cs-usage-head"><span></span><span></span></div><div class="cs-usage-bar${pct >= 80 ? ' is-high' : ''}"><b style="--used:${pct}"></b></div>`);
        const [a, b] = row.querySelectorAll('.cs-usage-head span'); a.textContent = name; b.textContent = `${Math.round(used).toLocaleString()} of ${cap.toLocaleString()}`; return row;
      };
      const usageCard = el('section', 'cs-card cs-route-usage', `<div class="cs-row"><span class="cs-icon">${ICON.chart}</span><div class="cs-info"><span class="cs-title">Used today</span><span class="cs-desc"></span></div></div>`);
      usageCard.querySelector('.cs-desc').textContent = `Counted on this computer. Resets at ${new Date(snapshot.reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
      const bars = el('div', 'cs-usage'); bars.append(bar('Cloudflare Neurons', usage.neurons || 0, cfg.cloudflare_neurons), bar('Groq requests', usage.groq_requests || 0, cfg.groq_rpd), bar('Groq tokens', usage.groq_tokens || 0, cfg.groq_tpd));
      usageCard.append(bars);

      // 3. Connect the services: a guide (open until connected) and the credentials.
      const serviceCard = (name) => {
        const info = SERVICES[name], ok = !!connected[name];
        const card = el('section', 'cs-card cs-provider cs-service', `<div class="cs-row"><span class="cs-icon">${info.icon}</span><div class="cs-info"><div class="cs-title-line"><span class="cs-title"></span><span class="cs-tag">Free tier</span></div><span class="cs-desc"></span></div><span class="cs-tag ${ok ? 'is-ok' : 'is-warn'}">${ok ? 'Connected' : 'Not connected'}</span></div>`);
        card.dataset.service = name;
        card.style.setProperty('--tint', info.tint);
        card.querySelector('.cs-title').textContent = info.name; card.querySelector('.cs-desc').textContent = info.blurb;
        const guide = el('details', 'cs-guide'); guide.dataset.key = `guide:${name}`; guide.open = before.get(guide.dataset.key) ?? !ok;
        guide.append(el('summary', '', `${ICON.chevron}<span>${ok ? 'Setup guide' : 'How to set this up'}</span>`));
        const steps = el('ol', 'cs-steps');
        for (const [html, action] of info.steps) { const li = el('li', '', `<span>${html}</span>`); if (action) li.append(link(...action)); steps.append(li); }
        const note = el('p', 'cs-guide-note'); note.textContent = info.note;
        guide.append(steps, note); card.append(guide);
        const keyField = name === 'cloudflare' ? creds.cloudflareKey : creds.groqKey;
        creds.cloudflareAccount.placeholder = ok ? 'Saved. Paste again to replace' : 'Account ID (32 characters)';
        keyField.placeholder = ok ? 'Saved. Paste again to replace' : name === 'groq' ? 'gsk_…' : 'API token';
        const fields = el('div', 'cs-cred');
        if (name === 'cloudflare') fields.append(creds.cloudflareAccount);
        fields.append(keyField);
        const test = button('Test', () => { routingAction = { kind: 'test', provider: name }; setRoutingStatus('Testing the connection…'); vscode.postMessage({ type: 'routingTest', provider: name }); });
        test.disabled = !ok;
        fields.append(el('div', 'cs-cred-actions'));
        fields.lastChild.append(button('Save and test', () => {
          const account = creds.cloudflareAccount.value.trim(), key = keyField.value.trim();
          if (name === 'cloudflare' && !/^[a-f0-9]{32}$/i.test(account)) return setRoutingStatus('The Account ID is 32 letters and digits. Copy it from the Workers AI page.', 'error');
          if (!key) return setRoutingStatus(name === 'groq' ? 'Paste your Groq key first.' : 'Paste your API token first.', 'error');
          routingAction = { kind: 'connect', provider: name }; setRoutingStatus('Saving…');
          vscode.postMessage({ type: 'routingConnect', provider: name, account, key });
        }, 'is-primary'), test);
        card.append(fields);
        return card;
      };

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
      const groups = [
        group('g:decide', ICON.sliders, 'How it decides', `Confidence ${pct(cfg.confidence)} · ${cfg.retry ? 'retries' : 'no retry'} · ${cfg.switching ? 'may switch models' : 'keeps the model'}`, [
          setting('Confidence needed', 'Below this, the router falls back to your default model.', percent(cfg.confidence, (v) => save((c) => { c.confidence = v; }))),
          setting('Retry with the stronger Cloudflare model', 'When the quick answer is not confident enough.', sw(cfg.retry, (v) => save((c) => { c.retry = v; }), 'Retry low confidence')),
          setting('Default model', 'Used when the router is unsure.', pick([['', 'First eligible model'], ...snapshot.models.map((m) => [m.id, m.label || m.id])], cfg.default_model, (v) => save((c) => { c.default_model = v; }), 'Default model')),
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
          setting('Answer simple tasks with Groq', 'When every CLI model is out of usage, Groq can answer short text-only tasks.', sw(cfg.groq_destination, (v) => save((c) => { c.groq_destination = v; }), 'Groq as destination')),
          setting('Give up after', `Milliseconds, up to ${TIER_CAPS.timeout_ms.toLocaleString()}.`, num(cfg.timeout_ms, 'timeout_ms', (v) => save((c) => { c.timeout_ms = v; }))),
        ]),
      ];

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
          const ctx = el('input', 'cs-num'); ctx.type = 'number'; ctx.min = '1024'; ctx.value = own.context || model.context || model.contextWindow || 128000; ctx.addEventListener('change', () => patch('context', Number(ctx.value)));
          node.append(summary,
            setting('Use this model', 'Off keeps the router from choosing it.', sw(own.enabled !== false, (v) => patch('enabled', v), 'Enabled')),
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
        button('Reset to defaults', () => { routingAction = { kind: 'save' }; vscode.postMessage({ type: 'routingReset' }); }, 'is-quiet', ICON.reset),
        button('Export', () => { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })); a.href = url; a.download = 'routing-config.json'; a.click(); URL.revokeObjectURL(url); }, 'is-quiet', ICON.up),
        button('Import', () => { const file = document.createElement('input'); file.type = 'file'; file.accept = '.json'; file.onchange = async () => { try { routingAction = { kind: 'save' }; vscode.postMessage({ type: 'routingSave', config: JSON.parse(await file.files[0].text()) }); } catch { setRoutingStatus('That file is not valid JSON.', 'error'); } }; file.click(); }, 'is-quiet', ICON.down),
      );

      routingPane.replaceChildren(
        routingStatus, hero, usageCard,
        labelled(1, 'Connect', 'Either one is enough'), serviceCard('cloudflare'), serviceCard('groq'),
        labelled(2, 'Order', 'Who is asked first'), orderCard,
        labelled(3, 'Fine-tune', 'The defaults are fine'), ...groups, modelGroup, footer,
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
    const $ = (role) => body.querySelector(`[data-role="${role}"]`);
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
    const ICONS = window.AGENT_ICONS || {};
    const MP = window.modelPrompts;
    const names = window.AGENT_NAMES || { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity' };
    const tabs = body.querySelectorAll('.cs-tab');
    const panes = body.querySelectorAll('.cs-pane');
    const pingLabel = $('pingClis').querySelector('span');
    const formatPills = body.querySelectorAll('.format-pill');
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
    let status = { versions: {}, updating: {}, notes: {}, fetched: [], favorites: [], catalog: [], prompts: {}, modelsBusy: false };
    let modelsRequested = false;
    let connections = null;
    function showTab(name) {
      tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.tab === name)));
      panes.forEach((pane) => { pane.hidden = pane.dataset.pane !== name; });
      // The CLIs are only asked for their model lists once, when the Models tab is first looked at.
      if (name === 'general' && !modelsRequested) { modelsRequested = true; vscode.postMessage({ type: 'refreshModels' }); }
      if (name === 'general') vscode.postMessage({ type: 'requestCliConnections' });
    }
    tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

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

      const connection = connections?.providers?.[agent];
      const details = connection && connectionDetails(connection);
      const connected = !connection || (connection.enabled && details.ready);
      const info = status.versions[agent] || {};
      const updating = status.updating[agent];
      const version = info.version || cli.version;
      const note = status.notes[agent];

      // [dot / text colour, text]: the one thing that most needs your attention comes first.
      const [tone, text] = !cli.path ? ['', 'Not installed']
        : !connected ? ['warn', details.tag]
          : updating ? ['warn', 'Updating…']
            : info.outdated ? ['warn', 'Update available']
              : pinged && cli.version === null && !version ? ['warn', 'Version check failed']
                : !version ? [status.checking ? '' : 'warn', status.checking ? 'Checking…' : 'Version unknown']
                  : status.checking ? ['', 'Checking for updates…']
                    : info.latest ? ['ok', 'Up to date'] : ['', 'Update check unavailable'];

      const permission = REGISTRY.find((provider) => provider.id === agent)?.headlessApprovals === false && currentPermMode !== 'fullAccess' ? 'Restricted (no prompts)'
        : currentPermMode === 'fullAccess' ? 'Full Access' : currentPermMode === 'auto' ? 'Auto' : 'Ask';
      const labels = [permission, ...models.map((model) => model.label.replace(/^Claude /, ''))];

      const row = document.createElement('div');
      row.className = 'cs-row';
      row.innerHTML = `<span class="cs-icon">${ICONS[agent] || ''}<i class="cs-dot${tone ? ` is-${tone}` : ''}"></i></span><div class="cs-info"><span class="cs-title-line"><span class="cs-title"></span><code class="cs-ver"></code><span class="cs-state${tone ? ` is-${tone}` : ''}"></span></span><span class="cs-models"></span></div><div class="cs-ractions"></div>`;
      row.querySelector('.cs-title').textContent = names[agent] || agent;
      const ver = row.querySelector('.cs-ver');
      ver.textContent = version ? `v${version}` : '';
      ver.hidden = !version;
      row.querySelector('.cs-state').textContent = text === 'Update available' ? '' : text; // the update button says it already
      row.querySelector('.cs-state').title = info.error || '';
      const modelLine = row.querySelector('.cs-models');
      modelLine.textContent = labels.join(' · ');
      modelLine.title = labels.join('\n');
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
      if (connection && !connected) pill(ICON.plug, details.action, true, () => vscode.postMessage({ type: 'connectCli', agent }));
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
      } else if (cli.path && note) {
        const outcome = document.createElement('p');
        outcome.className = `cs-update-note ${note.ok ? 'is-ok' : 'is-error'} cs-provider-note`;
        outcome.textContent = note.ok ? 'Update complete.' : note.text;
        card.append(outcome);
      }
      if (connection && !connected) {
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
    // Company filters are independent of the CLI that serves a model.
    $('companyFilters').replaceChildren(...[{ id: 'all', label: 'All' }, ...REGISTRY.filter((provider, i) => REGISTRY.findIndex((other) => other.company === provider.company) === i).map((provider) => ({ id: provider.id, label: provider.company }))].map(({ id, label }) => {
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
      const visible = all.filter((entry) => (company === 'all' || (entry.company || COMPANIES[entry.agent]) === COMPANIES[company])
        && `${entry.label} ${entry.model} ${entry.effort || ''}`.toLowerCase().includes(query));
      const list = $('modelList');
      const signature = JSON.stringify(visible);
      $('modelCount').textContent = `${visible.length} of ${all.length} models`;
      $('refreshModels').disabled = status.modelsBusy;
      $('availableDesc').textContent = status.modelsBusy ? 'Asking the installed CLIs…' : all.length ? 'Favorite a model to add it to the chat\'s model picker.' : 'No model list yet. Refresh to ask the CLIs.';
      if (signature !== availableSignature) {
        availableSignature = signature;
        const scrollTop = list.scrollTop;
        list.replaceChildren(...PROVIDERS.flatMap((agent) => {
          const entries = visible.filter((entry) => entry.agent === agent);
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
        if (!visible.length) {
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

    function cliStatus(next) {
      status = next;
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
      const currentFormat = services.timeFormat || '24h';
      for (const pill of formatPills) pill.classList.toggle('active', pill.dataset.format === currentFormat);
      for (const pill of permissionPills) pill.classList.toggle('active', pill.dataset.mode === currentPermMode);
      renderPermissionSupport(currentPermMode);

      $('pingClis').disabled = false;
      pingLabel.textContent = 'Check CLIs';
    }

    $('pingClis').addEventListener('click', () => { $('pingClis').disabled = true; pingLabel.textContent = 'Checking…'; vscode.postMessage({ type: 'pingClis' }); });
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
    $('openTerminal').addEventListener('click', () => vscode.postMessage({ type: 'openTerminal' }));

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

    showTab('general');
    return { fleet, cliStatus, cliConnections, showTab, voice, groqResult, routingResult };
  };
})();
