#!/usr/bin/env node
// Renders a piece of the panel's UI with the REAL stylesheets and prints the path of a PNG, so a visual change can be
// looked at in one command instead of reloading the IDE. Not a test: nothing is asserted, you read the picture.
//
//   node test/render.mjs rail        the launcher's Recent list (states, spinners, times)
//   node test/render.mjs settings    the Chat Settings popup (tabs, pickers, close button)
//   node test/render.mjs routing     Chat Settings > Routing (connect Cloudflare and Groq)
//   node test/render.mjs model-menu  the composer menu's smart routing and Auto-Verify rows
//   node test/render.mjs queue       queued-turn rows (model pills, photo previews)
//   options: --scale=4 (pixel ratio), --width=<css px> (window width), --chrome=<path> (else CHROME_PATH or a search)
//
// Fixtures are hand-written markup shaped like what launcher.js / main.js build, so keep them in step when those change.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { accentCss, displayList } = createRequire(import.meta.url)('../lib/providers');
const { DEFAULTS: ROUTING_DEFAULTS } = createRequire(import.meta.url)('../lib/routing');

const media = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'media');
const read = (file) => fs.readFileSync(path.join(media, file), 'utf8');

const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const name = args.find((arg) => !arg.startsWith('--'));
const scale = Number(flag('scale', 4));

// The squircle/bubble clip paths launcher.js defines on load: reused as they are, cut out of the file.
function bubbleSetup() {
  const lines = read('launcher.js').split('\n');
  const start = lines.findIndex((line) => line.includes('defineSquircle'));
  let end = start;
  while (!lines[end].startsWith('  })();')) end++;
  return lines.slice(start, end + 1).join('\n');
}

const historyItem = (agent, state, time, running) =>
  `<div class="history-item" ${agent ? `data-agent="${agent}"` : ''}><div class="history-row ${state}"><span class="history-lead">${agent ? `<span class="agent-mark" data-agent="${agent}"></span>` : '<span class="slot-mark"></span>'}</span></div><span class="history-time">${time}</span>${running ? '<span class="pending-orb history-spinner"></span>' : ''}</div>`;

// The usage ring (launcher.js modelCard) and the API value figure, held in their hover state with the class `force`.
const ringCircles = (r, pct) => `<circle class="ring-track" cx="18" cy="18" r="${r}"/><circle class="ring-fill" style="--pct:${pct}" cx="18" cy="18" r="${r}" pathLength="100"/>`;
const ringRow = (name, pct, eta) => `<span class="ring-row" style="--pct:${pct}"><span class="ring-row-name">${name}</span><i class="ring-bar"><b></b></i><span class="ring-row-pct">${pct}%</span><span class="ring-row-eta">${eta}</span></span>`;
const modelCard = (agent, five, week, rate, low, force) =>
  `<div class="model-card model-card-${agent}" data-agent="${agent}"><span class="ring ${force ? 'force' : ''}"><span class="ring-pill"><span class="ring-burn ${low ? 'is-low' : ''}"><span class="ring-burn-label">BURN</span><b class="ring-burn-val">${rate}</b><i>%/h</i></span><span class="ring-rows">${ringRow('5h', five, '4h 53m')}${ringRow('7d', week, '6d 23h')}</span></span><svg viewBox="0 0 36 36">${ringCircles(15, five)}${ringCircles(10, week)}</svg><span class="ring-logo" data-logo="${agent}"></span></span><b class="model-card-5h">${five}%</b></div>`;
const apiRow = (agent, name, usd, pct) => `<div class="api-value-row" data-agent="${agent}" style="--pct:${pct}"><span class="api-value-mark"><span class="agent-mark" data-agent="${agent}"></span></span><span class="api-value-name">${name}</span><span class="api-value-bar"><b></b></span><span class="api-value-usd">${usd}</span></div>`;
const apiValue = (force) => `<section class="launcher-section api-value"><div class="launcher-label">API value</div><div class="api-value-figure ${force ? 'force' : ''}" tabindex="0"><span class="api-value-amount">≈ $568</span><span class="api-value-note">not billed</span><div class="api-value-card"><div class="api-value-card-head"><span>API value</span><b>≈ $568</b></div><div class="api-value-range"><span>$454 – $682</span><i>±20%</i></div><p class="api-value-card-lead">What the work done here would have cost at the providers' pay-per-token API prices. Billing details aren't public, so this is an estimate. Your subscriptions cover it: a comparison, not a charge.</p><div class="api-value-rows">${apiRow('claude', 'Claude Code', '$497', 87)}${apiRow('codex', 'Codex', '$55', 10)}${apiRow('gemini', 'Antigravity', '$16', 3)}</div><p class="api-value-card-foot">This month ≈ $300 · since Sep 22, 2026 · prices updated Oct 1, 2026</p></div></div></section>`;

const photos = (colors) => `<span class="turn-queue-thumbs">${colors.map((color) => `<img alt="" src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${color}"/><circle cx="8" cy="8" r="4" fill="#fff"/></svg>`)}">`).join('')}</span>`;
const queueRow = (brand, model, text, files) =>
  `<div class="turn-queue-item"><span class="model-pill" data-brand="${brand}">${model}</span><span class="turn-queue-text">${text}</span>${files ? `<span class="turn-queue-files">${photos(files.colors)}<span class="turn-queue-files-count">${files.colors.length}<span class="turn-queue-files-word"> ${files.colors.length === 1 ? 'photo' : 'photos'}</span></span></span>` : ''}<button class="turn-queue-btn is-primary" type="button">Steer Now</button></div>`;

const roundBtn = '<button class="round-btn" type="button"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg></button>';
function sidebar(scrolled) {
  return `<div style="display:grid;grid-template-columns:minmax(0,1fr) 75px;height:420px;position:relative;margin:-12px"><div style="padding:20px;color:#777;font:12px sans-serif">chat</div><aside class="rail"><div class="rail-scroll">
    <section class="launcher-section"><div class="launcher-label">Usage</div><div class="model-cards">${modelCard('claude', 99, 100, '8.2', false, scrolled)}${modelCard('codex', 41, 77, '31', true, false)}</div></section>
    ${apiValue(false)}
    <div class="project-toolbar launcher-section is-rail"><div class="launcher-label">Project</div><button class="project-picker" type="button">2026</button><button class="round-btn" type="button"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4a1 1 0 0 1 1-1h4l2 2h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/></svg></button></div>
    <div class="launcher-actions">${roundBtn}${roundBtn}${roundBtn}</div>
    <section class="launcher-section"><div class="launcher-label">Recent</div><div class="history-list">${historyItem(null, '', 'Just now', false)}${historyItem('claude', 'is-selected', 'now', false)}</div></section>
  </div></aside></div>${scrolled ? '<script>document.querySelector(".rail-scroll").scrollTop = 9999;</script>' : ''}`;
}

// Sample model lists for the settings fixtures: [agent, label, model, effort].
const SAMPLE_MODELS = [['claude', 'Claude Opus 5.5 Medium', 'claude-opus-5-5', 'medium'], ['claude', 'Claude Sonnet 5.5 High', 'claude-sonnet-5-5', 'high'], ['codex', 'GPT 6.1 Sol Medium', 'gpt-6.1-sol', 'medium'], ['codex', 'GPT 6.1 Sol High', 'gpt-6.1-sol', 'high'], ['gemini', 'Gemini 3.8 Flash High', 'gemini-3.8-flash-high', null]]
  .map(([agent, label, model, effort]) => ({ id: `${model}-${effort || 'x'}`, agent, label, model, effort }));

function cliFixture(confirm) {
  return {
    width: 440,
    scripts: ['model-prompts.js', 'voice-hotkey.js', 'settings.js'],
    body: '<div class="fs-modal" id="settingsModal" style="position:static;display:block"><div class="fs-modal-sheet glass"><div class="fs-modal-body" id="csBody"></div></div></div>',
    init: `const api = window.initChatSettings({ vscode: { postMessage() {} }, body: document.getElementById('csBody') });
      const models = [['claude', 'Claude Opus 5.5 Medium'], ['claude', 'Claude Sonnet 5.5 High'], ['codex', 'GPT 6.1 Sol Medium'], ['codex', 'GPT 6.1 Sol High'], ['gemini', 'Gemini 3.8 Flash High']].map(([agent, label]) => ({ agent, label, model: label }));
      const provider = (extra) => ({ enabled: true, installed: true, auth: 'connected', ...extra });
      api.cliConnections({ providers: { claude: provider(), codex: provider(), gemini: provider({ auth: 'ready' }) } });
      api.cliStatus({ versions: { claude: { version: '2.1.286', latest: '2.1.287', outdated: true }, codex: { version: '0.159.3', latest: '0.159.3', outdated: false }, gemini: { version: '1.2.14', latest: '1.2.14', outdated: false } },
        updating: {}, notes: {}, fetched: ${JSON.stringify(SAMPLE_MODELS)}, favorites: [], catalog: [], prompts: {}, modelsBusy: false });
      api.fleet({ models, clis: { claude: { path: 'claude.exe' }, codex: { path: 'codex.exe' }, gemini: { path: 'agy.exe' } }, services: {} });
      ${confirm ? "document.querySelector('[data-agent=\"codex\"] .cs-icon-btn').click();" : ''}`,
  };
}

const FIXTURES = {
  rail: {
    width: 100,
    body: `<div class="history-list">${[
      historyItem(null, '', 'Just now', false),
      historyItem('claude', 'is-selected', 'now', true),
      historyItem('codex', 'is-recent', '5min ago', true),
      historyItem('gemini', 'is-waiting', '36min ago', false),
      historyItem('codex', '', '17:20', false),
      historyItem('claude', '', 'Sep 28', false),
    ].join('')}<button class="history-more" type="button">+3</button></div>`,
  },
  // The rail's usage rings and API value, each at rest and open (the hover states, held with .force). They grow leftward
  // over the chat, so the picture is wide with the rail's 64px column at its right edge.
  usage: {
    width: 380,
    body: `<div style="display:flex;justify-content:flex-end"><div style="display:flex;flex-direction:column;gap:22px;width:64px;align-items:stretch">
      <section class="launcher-section"><div class="launcher-label">Usage</div><div class="model-cards">${modelCard('claude', 15, 95, '118', false, true)}${modelCard('codex', 41, 77, '31', true, false)}</div></section>
      ${apiValue(false)}
    </div></div>`,
  },
  'api-value': {
    width: 380,
    body: `<div style="display:flex;justify-content:flex-end"><div style="display:flex;flex-direction:column;gap:22px;width:64px;align-items:stretch">
      <section class="launcher-section"><div class="launcher-label">Usage</div><div class="model-cards">${modelCard('claude', 99, 100, '8.2', false, false)}${modelCard('codex', 41, 77, '31', true, false)}</div></section>
      ${apiValue(true)}
    </div></div>`,
  },
  // The whole rail in a short window, so it has to scroll: `sidebar` at the top, `sidebar-end` scrolled to the bottom.
  sidebar: { width: 360, height: 420, body: sidebar(false) }, // (sidebar-end holds its Claude ring open, to show the pill clears the scroller's edge)
  'sidebar-end': { width: 360, height: 420, body: sidebar(true) },
  'usage-rest': {
    width: 100,
    body: `<div style="display:flex;justify-content:flex-end"><div style="display:flex;flex-direction:column;gap:22px;width:64px;align-items:stretch">
      <section class="launcher-section"><div class="launcher-label">Usage</div><div class="model-cards">${modelCard('claude', 99, 100, '8.2', false, false)}${modelCard('codex', 41, 77, '31', true, false)}</div></section>
      ${apiValue(false)}
    </div></div>`,
  },
  // Chat Settings > General's CLI cards, drawn by the real settings.js; `clis-confirm` has Codex's trash can clicked.
  clis: cliFixture(false),
  // The same cards with a fourth provider that exists only as registry data (no logo, no CSS written for it).
  'clis-four': {
    ...cliFixture(false),
    providers: [...displayList(), { id: 'cursor', name: 'Cursor', company: 'Anysphere', color: '#22d3ee', cli: 'cursor-agent', headlessApprovals: true }],
    init: cliFixture(false).init
      .replace("['gemini', 'Gemini 3.8 Flash High']]", "['gemini', 'Gemini 3.8 Flash High'], ['cursor', 'Cursor Fast']]")
      .replace('gemini: provider({ auth: \'ready\' }) }', "gemini: provider({ auth: 'ready' }), cursor: provider({ enabled: false, auth: 'unknown', installed: false }) }")
      .replace("gemini: { path: 'agy.exe' } }", "gemini: { path: 'agy.exe' }, cursor: { path: null } }")
      .replace("gemini: { version: '1.2.14', latest: '1.2.14', outdated: false } }", "gemini: { version: '1.2.14', latest: '1.2.14', outdated: false }, cursor: {} }"),
  },
  'clis-confirm': cliFixture(true),
  // Chat Settings > Models, with the first favorite open.
  models: {
    width: 440,
    scripts: ['model-prompts.js', 'voice-hotkey.js', 'settings.js'],
    body: '<div class="fs-modal" id="settingsModal" style="position:static;display:block"><div class="fs-modal-sheet glass"><div class="fs-modal-body" id="csBody"></div></div></div>',
    init: `const api = window.initChatSettings({ vscode: { postMessage() {} }, body: document.getElementById('csBody') });
      const models = ${JSON.stringify(SAMPLE_MODELS)};
      api.cliStatus({ versions: {}, updating: {}, notes: {}, fetched: models, favorites: models.map((m) => m.id), catalog: models, prompts: {}, modelSettings: {}, modelsBusy: false });
      api.showTab('models');
      document.querySelector('.cs-prompt-head').click();`,
  },
  // Chat Settings > Voice, drawn by the real settings.js with sample state.
  voice: {
    width: 440,
    scripts: ['model-prompts.js', 'voice-hotkey.js', 'settings.js'],
    body: '<div class="fs-modal" id="settingsModal" style="position:static;display:block"><div class="fs-modal-sheet glass"><div class="fs-modal-body" id="csBody"></div></div></div>',
    init: `const api = window.initChatSettings({ vscode: { postMessage() {} }, body: document.getElementById('csBody') });
      api.showTab('voice');
      api.voice({ hotkey: 'Ctrl+Alt+Space', mode: 'hold', sounds: true, hotkeyActive: true, supported: true, groq: { source: 'account', masked: 'gsk_…x9Qa', today: { day: '2026-10-02', calls: 41 },
        limits: { chat: { limit: 1000, remaining: 612, resetsAt: Date.now() + 5.2 * 3600e3 }, transcription: { limit: 2000, remaining: 1960, resetsAt: Date.now() + 5.2 * 3600e3 } } } });`,
  },
  // Chat Settings > Routing: connecting Cloudflare and Groq, drawn by the real settings.js. The mode itself is in the model menu.
  routing: {
    width: 440,
    scripts: ['model-prompts.js', 'voice-hotkey.js', 'settings.js'],
    body: '<div class="fs-modal" id="settingsModal" style="position:static;display:block"><div class="fs-modal-sheet glass"><div class="fs-modal-body" id="csBody"></div></div></div>',
    init: `const api = window.initChatSettings({ vscode: { postMessage() {} }, body: document.getElementById('csBody') });
      api.showTab('routing');
      api.fleet({ models: [], clis: {}, services: { routing: { config: ${JSON.stringify(ROUTING_DEFAULTS)}, usage: { neurons: 1200, groq_requests: 14, groq_tokens: 9000 }, models: ${JSON.stringify(SAMPLE_MODELS)}, connected: { cloudflare: false, groq: false }, reset: new Date(Date.now() + 5 * 3600e3).toISOString() } } });`,
  },
  // The composer's model menu footer (main.js renderModelMenu): smart routing above Auto-Verify.
  'model-menu': {
    width: 300,
    body: `<div class="model-menu is-open glass" style="position:static;opacity:1;visibility:visible;transform:none;border-radius:16px"><div class="model-group"><button class="model-option" aria-selected="true"><span class="model-option-text"><span class="model-option-label">Auto</span><span class="model-option-hint">Best available favorite for each task</span></span></button></div><div class="model-group model-footer"><div class="model-routing"><div class="model-routing-head"><span class="model-verify-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="4" cy="4" r="1.6"/><circle cx="12" cy="12" r="1.6"/><path d="M5.6 4h3.4a2.5 2.5 0 0 1 0 5H7a2.5 2.5 0 0 0 0 5h3.4"/></svg></span><span class="model-option-text"><span class="model-option-label">Smart routing</span><span class="model-option-hint">A free AI reads each message and picks the best model for it.</span></span></div><div class="model-routing-modes pill-track" role="radiogroup"><button role="radio" aria-checked="false"><span>Manual</span></button><button role="radio" aria-checked="false"><span>Shadow</span></button><button role="radio" aria-checked="true"><span>Auto</span></button></div><button class="model-routing-setup">Connect Cloudflare or Groq</button></div><button class="model-verify" role="switch" aria-checked="false"><span class="model-verify-icon"></span><span class="model-option-text"><span class="model-option-label">Auto-Verify</span><span class="model-option-hint">Check the work after every change, for every model</span></span><span class="model-verify-switch"></span></button></div></div>`,
  },
  settings: {
    width: 440,
    body: `<div class="fs-modal" id="settingsModal" style="position:static;display:block"><div class="fs-modal-sheet glass"><header class="fs-modal-head"><h2>Chat Settings</h2><span class="fs-modal-count"></span><button type="button" class="fs-modal-close" aria-label="Close"><svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></header><div class="fs-modal-body"><div class="cs">
      <div class="cs-tabs pill-track"><button class="cs-tab" aria-selected="true" type="button">General</button><button class="cs-tab" aria-selected="false" type="button">Models</button><button class="cs-tab" aria-selected="false" type="button">Remote</button></div>
      <section class="cs-card"><div class="cs-row"><div class="cs-info"><span class="cs-title">Time format</span><span class="cs-desc">Timestamps in chats and the queue.</span></div><div class="time-format-picker pill-track"><button class="format-pill active" type="button">24h</button><button class="format-pill" type="button">12h</button><button class="format-pill" type="button">Auto</button></div></div></section>
    </div></div></div></div>`,
  },
  queue: {
    width: 520,
    body: `<div style="display:flex;flex-direction:column;gap:6px;padding:10px">${[
      queueRow('claude', 'Sonnet', 'Remove the breathing animation', { colors: ['#f97316', '#8b5cf6'] }),
      queueRow('claude', 'Opus', 'The selector pill is hard to read', { colors: ['#0ea5e9'] }),
      queueRow('codex', 'Sol', 'Rename the setting', null),
      queueRow('gemini', 'Flash', 'Summarise the docs', { colors: ['#f97316', '#8b5cf6', '#0ea5e9'] }),
    ].join('')}</div>`,
  },
};

const fixture = FIXTURES[name];
if (!fixture) {
  console.error(`Usage: node test/render.mjs <${Object.keys(FIXTURES).join('|')}> [--scale=4] [--width=px] [--chrome=path]`);
  process.exit(2);
}
const width = Number(flag('width', fixture.width));

const html = `<!doctype html><meta charset="utf-8"><style>
${['style.css', 'launcher.css', 'settings.css'].map(read).join('\n').replaceAll(':is(:hover, :focus-visible)', ':is(:hover, :focus-visible, .force)')}
*, *::before, *::after { animation: none !important; } /* a still picture, not a frame caught mid-entrance */
body { margin: 0; padding: 12px; width: ${width}px; background: #0d0d10; }
${fixture.providers ? accentCss(fixture.providers) : ''}</style><body>${fixture.body}
${fixture.providers ? `<script>window.PROVIDERS = ${JSON.stringify(fixture.providers)};</script>` : ''}
<script>${read('agent-icons.js')}</script>
<script>${bubbleSetup()}</script>
<script>document.querySelectorAll('.agent-mark[data-agent]').forEach((el) => { el.innerHTML = window.AGENT_ICONS[el.dataset.agent] || ''; });
document.querySelectorAll('[data-logo]').forEach((el) => { el.innerHTML = window.AGENT_ICONS[el.dataset.logo] || ''; });</script>
${(fixture.scripts || []).map((file) => `<script>${read(file)}</script>`).join('\n')}<script>${fixture.init || ''}</script></body>`;

function findChrome() {
  const candidates = [
    flag('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file));
}
const chrome = findChrome();
if (!chrome) { console.error('No Chrome or Edge found: pass --chrome=<path> or set CHROME_PATH.'); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-render-'));
const page = path.join(dir, `${name}.html`);
const png = path.join(dir, `${name}.png`);
fs.writeFileSync(page, html);
const height = Number(flag('height', 0)) || undefined;
execFileSync(chrome, [
  '--headless', '--disable-gpu', `--force-device-scale-factor=${scale}`,
  `--window-size=${width + 24},${height || 700}`, `--screenshot=${png}`, pathToFileURL(page).href,
], { stdio: 'ignore' });
console.log(png);
