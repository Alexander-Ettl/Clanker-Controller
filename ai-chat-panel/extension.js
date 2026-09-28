'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TerminalSessionManager } = require('./lib/pty-session.js');
const { readQuotas, onDidChangeQuotas, quotaBridgeConnected, recordClaudeUsage, claudeUsageAge } = require('./lib/quota-bridge.js');
const { probeClaudeUsage } = require('./lib/claude-usage.js');

// Claude's real usage after a restart or a quiet spell: `claude -p /usage` is a local command
// (0 tokens), so it's asked whenever the last real reading is 15+ minutes old or a window rolled over.
const USAGE_PROBE_AFTER_MS = 15 * 60 * 1000;
let usageProbe = null;
function refreshClaudeUsage(cwd) {
  if (usageProbe || claudeUsageAge() < USAGE_PROBE_AFTER_MS) return usageProbe;
  usageProbe = probeClaudeUsage(cwd).then((windows) => recordClaudeUsage(windows)).catch(() => {}).finally(() => { usageProbe = null; });
  return usageProbe;
}
const { VoiceCapture } = require('./lib/voice-capture.js');
const { learnedTerms } = require('./lib/voice-learn.js');
const { writeMicroHandoff, formatMicroHandoffPrompt } = require('./lib/handoff.js');
const { execFile, spawn } = require('node:child_process');
const { StreamEngine } = require('./lib/stream-engine.js');
const { locate, refresh: refreshBinaries, resolveShim, terminalCommand } = require('./lib/binary-locator.js');
const { ChatStore, markActive, ACTIVE_WINDOW_MS } = require('./lib/chat-store.js');
const { route } = require('./lib/auto-router.js');
const { MODEL_CATALOG, modelOption, resolveModel } = require('./lib/model-catalog.js');
const { SchedulerQueue, ACTIVE_STATUSES } = require('./lib/scheduler-queue.js');
const { TelegramBridge, DOCK_KEYBOARD } = require('./lib/telegram-bridge.js');
const { configureTelegram: setupTelegram, TOKEN_KEY, CHAT_KEY, OWNER_KEY } = require('./lib/telegram-setup.js');
const { forwardRequest, bindTelegramControls } = require('./lib/telegram-control.js');
const { resolveEditorTheme } = require('./lib/editor-theme.js');
const { buildHandoff, buildCompactionHandoff, checkpointStart, estimateTokens, COMPACT_DIRECTIVE, COMPACT_TARGET_TOKENS } = require('./lib/chat-handoff.js');
const { CodexCommandCatalog } = require('./lib/codex-commands.js');
const { SlashCommandCatalog } = require('./lib/slash-commands.js');

// Context windows (the webview's gauge uses the same numbers) and the point
// where the panel compacts Gemini itself: agy has no compaction of its own,
// while Claude Code and Codex auto-compact natively (both on by default).
const CONTEXT_LIMITS = { claude: 1000000, codex: 1000000, gemini: 1048576 };
const AUTO_COMPACT_RATIO = 0.90;
const { notifyReply } = require('./lib/notify.js');

// P17-X: clock locale + format shared by both webviews ('24h' default, 'auto' follows vscode.env.language).
const timePrefs = () => JSON.stringify({ locale: vscode.env.language || 'en', timeFormat: vscode.workspace.getConfiguration('aiChatPanel').get('timeFormat', '24h') });

const QUOTA_POLL_MS = 5000;
const WATCHDOG_POLL_MS = 60000;
const WATCHDOG_THRESHOLD_PCT = 20;

function quotaAvailable(quotas, model) {
  const quota = quotas?.[model];
  return model === 'gemini' && typeof quota?.remaining !== 'number'
    ? true // no live Antigravity number: never block it
    : typeof quota?.remaining === 'number' && quota.remaining > WATCHDOG_THRESHOLD_PCT;
}

// ---------- Astro Visual Editor setup (scripts/setup-site.mjs does the work; this only launches it) ----------
/** The editor checkout this extension belongs to (or ASTRO_VISUAL_EDITOR_PATH), wherever the extension is installed. */
function editorRoot() {
  return [
    process.env.ASTRO_VISUAL_EDITOR_PATH,
    path.join(__dirname, '..', '..'),
    path.join(require('node:os').homedir(), 'Nextcloud', 'Eigene Projekte', 'Portfolio', '2026', 'astro-visual-editor'),
  ].find((dir) => dir && fs.existsSync(path.join(dir, 'scripts', 'setup-site.mjs'))) || null;
}
function siteSetupState() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return { hasFolder: Boolean(folder), ready: Boolean(folder && fs.existsSync(path.join(folder, 'astro-visual-editor.config.json'))) };
}
async function copyAdaptPrompt() {
  const root = editorRoot();
  if (!root) return void vscode.window.showWarningMessage('Astro Visual Editor: editor checkout not found (set ASTRO_VISUAL_EDITOR_PATH).');
  await vscode.env.clipboard.writeText(fs.readFileSync(path.join(root, 'templates', 'site', 'ADAPT_PROMPT.md'), 'utf8'));
  vscode.window.showInformationMessage('Copied. Paste it into Claude or Codex in this folder (or into a chat here).');
}
async function setupVisualEditor() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return void vscode.window.showWarningMessage('Open a folder first (an empty one for a new site, or your Astro project), then click Set up again.');
  const root = editorRoot();
  if (!root) return void vscode.window.showErrorMessage('Astro Visual Editor: editor checkout not found (set ASTRO_VISUAL_EDITOR_PATH).');
  // A task, not a hidden child process: npm's progress and any error stay visible in the terminal.
  const task = new vscode.Task({ type: 'astroVisualEditorSetup' }, vscode.TaskScope.Workspace, 'Set up Astro Visual Editor', 'Astro Visual Editor',
    new vscode.ProcessExecution('node', [path.join(root, 'scripts', 'setup-site.mjs'), folder], { cwd: folder }));
  const execution = await vscode.tasks.executeTask(task);
  const done = vscode.tasks.onDidEndTaskProcess(async (event) => {
    if (event.execution !== execution) return;
    done.dispose();
    if (event.exitCode !== 0) return void vscode.window.showErrorMessage('Astro Visual Editor setup stopped; the terminal says why.');
    const pick = await vscode.window.showInformationMessage('Astro Visual Editor is set up. Start the dev server?', 'Start dev server', 'Copy AI adapt prompt');
    if (pick === 'Copy AI adapt prompt') void copyAdaptPrompt();
    if (pick === 'Start dev server') {
      void vscode.tasks.executeTask(new vscode.Task({ type: 'astroVisualEditorDev' }, vscode.TaskScope.Workspace, 'astro dev', 'Astro Visual Editor', new vscode.ShellExecution('npm run dev', { cwd: folder })));
      void vscode.env.openExternal(vscode.Uri.parse('http://localhost:4321/?edit=1'));
    }
  });
}

class SchedulerWatchdog {
  constructor({ queue, workspaceDir, getModels, telegram, onQueueChange, chatStore, onHistoryChange, notify, resumeInChat }) {
    this.notify = notify || null;
    this.resumeInChat = resumeInChat || null;
    this.queue = queue; this.workspaceDir = workspaceDir; this.getModels = getModels; this.telegram = telegram;
    this.onQueueChange = onQueueChange || (() => {});
    this.chatStore = chatStore || null; this.onHistoryChange = onHistoryChange || (() => {});
    this.timer = null; this.running = false; this.activeTaskId = null; this.output = ''; this.failed = ''; this.chat = null; this.reply = null;
    this.engine = new StreamEngine({ cwd: workspaceDir, models: getModels() });
    this.engine.on('event', (event) => void this.handleEvent(event));
  }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.tick(), WATCHDOG_POLL_MS); void this.tick(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.engine.cancel(); this.activeTaskId = null; }
  async tick() {
    if (this.running || this.activeTaskId) return;
    this.running = true;
    try {
      await refreshClaudeUsage(this.workspaceDir); // real numbers before deciding a Claude task may run
      const queue = await this.queue.getQueue();
      const next = queue.find((task) => task.status === 'pending' && (task.dispatchTrigger !== 'fixed-time' || Date.parse(task.dispatchTime) <= Date.now()));
      if (!next || !quotaAvailable(await readQuotas(), next.model)) return;
      await this.dispatch(next);
    } catch (error) { this.failed = error.message; }
    finally { this.running = false; }
  }
  /** P17-H: Run Now on an interrupted card dispatches at once, quota or not. False while another task runs. */
  async runNow(taskId) {
    if (this.running || this.activeTaskId) return false;
    this.running = true;
    try {
      const task = (await this.queue.getQueue()).find((item) => item.id === taskId && item.status === 'interrupted');
      if (!task) return false;
      await this.dispatch(task);
      return true;
    } finally { this.running = false; }
  }
  async dispatch(task) {
    await this.queue.markDispatched(task.id);
    this.onQueueChange();
    // "Continue when the limit resets": the message goes back into the chat it came from, so the
    // agent resumes its own session there instead of starting a context-free headless run.
    if (task.chatId && this.resumeInChat?.(task)) {
      await this.queue.markCompleted(task.id, 'Sent into its chat');
      this.onQueueChange();
      return;
    }
    this.activeTaskId = task.id; this.output = ''; this.failed = ''; this.engine.models = this.getModels();
    // P17-H: a headless run is a real chat, so it lands in the Recent tab.
    if (this.chatStore) {
      this.reply = { role: 'assistant', text: '', agent: task.model };
      this.chat = this.chatStore.save({ ...this.chatStore.create(), title: `Scheduled: ${task.prompt.slice(0, 40)}`, messages: [{ role: 'user', text: task.prompt, agent: task.model }, this.reply] });
      this.onHistoryChange();
    }
    const { model, effort } = MODEL_CATALOG.find((entry) => entry.agent === task.model) || {}; // the same model Auto would run
    this.engine.start({ agent: task.model, prompt: task.prompt, model, effort, attachments:task.attachments.map((attachment) => path.resolve(this.workspaceDir, attachment.relativePath)) });
  }
  async handleEvent(event) {
    if (event.type === 'rate_limits' && event.agent === 'claude') recordClaudeUsage(event.windows);
    if (!this.activeTaskId) return;
    if (event.type === 'tool_start' && this.chat) { this.chat.messages.push({ role: 'tool', event }); this.chat = this.chatStore.save(this.chat); }
    if (event.type === 'delta') {
      this.output = (this.output + String(event.text || '')).slice(0, 800);
      if (this.reply) this.reply.text += String(event.text || '');
      if (/^Unable to start\b/i.test(String(event.text || ''))) this.failed = String(event.text);
    }
    if (event.type === 'binary_missing') this.failed = `Agent binary not found: "${event.agent}"`;
    if (event.type === 'upstream_error') this.failed = `Upstream unavailable (${event.agent}): ${event.detail}`;
    if (event.type === 'approval_required' || event.type === 'question_required') {
      await forwardRequest(this.telegram, event, { engine: this.engine, title: `Scheduled task ${this.activeTaskId}`, respond: (_id, callback) => callback(this.engine) });
      return;
    }
    if (event.type !== 'turn_complete') return;
    const taskId = this.activeTaskId; this.activeTaskId = null;
    if (this.chat) { this.chatStore.save(this.chat); this.chat = null; this.reply = null; this.onHistoryChange(); }
    if (this.failed) { await this.queue.markFailed(taskId, this.failed); await this.telegram?.sendMarkdown(`Scheduler retry/failure for \`${taskId}\`: ${this.failed}`); }
    else {
      await this.queue.markCompleted(taskId, this.output);
      await this.telegram?.sendMarkdown(`Scheduler completed \`${taskId}\` (${this.output || 'no output'}).`);
      this.notify?.(event.agent, this.output, 'Scheduled task');
    }
    this.onQueueChange();
    void this.tick();
  }
}

async function waitForDns(hostname, { timeoutMs = 30000 } = {}) {
  try {
    const dns = require('node:dns').promises;
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const addrs = await resolver.resolve4(hostname);
        if (addrs && addrs.length > 0) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {}
  return false;
}

class TunnelManager {
  constructor({ statusItem, onLive, onOff }) {
    this.statusItem = statusItem; this.onLive = onLive; this.onOff = onOff;
    this.childProcess = null; this.status = 'off'; this.publicUrl = null; this.render();
  }
  render() {
    this.statusItem.text = this.status === 'live' ? '$(radio-tower) Tunnel: Live' : this.status === 'connecting' ? '$(radio-tower) Tunnel: Connecting' : '$(radio-tower) Tunnel: Off';
    this.statusItem.tooltip = this.publicUrl || 'Cloudflare Tunnel is not running';
  }
  async start() {
    if (this.status === 'live' || this.status === 'connecting') return this.publicUrl;
    await new Promise((resolve, reject) => execFile('cloudflared', ['--version'], { windowsHide: true }, (error) => error ? reject(error) : resolve()));
    this.status = 'connecting'; this.render();
    const child = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:57321'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.childProcess = child;
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cloudflare Tunnel did not provide a public URL.')), 30000);
      const consume = (chunk) => { const match = String(chunk).match(/https:\/\/[\w-]+\.trycloudflare\.com/); if (match) { clearTimeout(timer); resolve(match[0]); } };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { if (!this.publicUrl) { clearTimeout(timer); reject(new Error(`Cloudflare Tunnel exited (${code}).`)); } });
    }).catch((error) => { this.stop(); throw error; });
    try {
      this.publicUrl = url;
      try {
        const host = new URL(url).hostname;
        this.statusItem.text = '$(sync~spin) Tunnel: Propagating DNS...';
        await waitForDns(host, { timeoutMs: 30000 });
        await new Promise((r) => setTimeout(r, 2000));
      } catch {}
      await this.onLive(url);
      this.status = 'live';
      this.render();
      return url;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  stop() { if (this.childProcess && !this.childProcess.killed) this.childProcess.kill(); this.childProcess = null; this.publicUrl = null; this.status = 'off'; this.render(); return this.onOff(); }
  dispose() { return this.stop(); }
}
function getVoiceRouterDir() {
  const candidates = [
    process.env.VOICE_ROUTER_DIR,
    path.join(__dirname, '..', 'voice-router'),
    path.join(require('node:os').homedir(), 'Nextcloud', 'Eigene Projekte', 'Portfolio', '2026', 'tools', 'voice-router'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(__dirname, '..', 'voice-router');
}
const VOICE_ROUTER_DIR = getVoiceRouterDir();

// Same directory the Astro Content Editor already persists batch state to
// (site/packages/astro-content-editor/index.mjs's own `.astro/session/`) --
// the micro-handoff artifact lives alongside batch-tasks.json rather than
// inventing a second session-state location.
function getAstroSessionDir() {
  const candidates = [
    process.env.ASTRO_CONTENT_EDITOR_SESSION_DIR,
    path.join(__dirname, '..', '..', '..', 'site', '.astro', 'session'),
    path.join(require('node:os').homedir(), 'Nextcloud', 'Eigene Projekte', 'Portfolio', '2026', 'site', '.astro', 'session'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.dirname(dir))) return dir;
  }
  return candidates[candidates.length - 1];
}
const ASTRO_SESSION_DIR = getAstroSessionDir();

// P16-I: resolved per workstation by lib/binary-locator.js at activation.
function agentList() {
  return [
    { id: 'claude', label: 'Claude Sonnet', command: terminalCommand('claude') },
    { id: 'codex', label: 'Codex', command: terminalCommand('codex') },
    { id: 'gemini', label: 'Gemini 3.8', command: terminalCommand('gemini', '--model gemini-3.8-flash-high') },
    { id: 'opus', label: 'Claude Opus 5.5', command: opusTerminalCommand() },
  ];
}

// P17-D: a one-click Opus 5.5 terminal. A claude CLI too old for the model id
// or --effort exits non-zero right at startup; only that fast failure (not a
// normal quit later on) relaunches the same terminal on Sonnet.
function claudeLaunch(modelId) {
  const option = modelOption(modelId);
  return terminalCommand('claude', `--model ${option.model}${option.effort ? ` --effort ${option.effort}` : ''}`);
}
function opusTerminalCommand() {
  return `$t = Get-Date; ${claudeLaunch('claude-opus-5-5-medium')}; if ($LASTEXITCODE -and ((Get-Date) - $t).TotalSeconds -lt 15) { Write-Host 'This claude CLI cannot run Opus 5.5 yet. Starting Sonnet.'; ${claudeLaunch('claude-sonnet-5-high')} }`;
}

// P17-D: an injectPrompt / Telegram target is an agent id or any model name
// resolveModel knows ('opus', 'Claude Opus 5.5', a catalog id).
const AGENT_IDS = ['claude', 'codex', 'gemini'];
function injectTarget(name) {
  if (AGENT_IDS.includes(name)) return { agentId: name, modelId: null };
  const option = resolveModel(name);
  return option ? { agentId: option.agent, modelId: option.id } : null;
}

function getNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function titleFor(chat) {
  if (chat.title) return `AI Chat: ${chat.title}`;
  const preview = chat.messages?.find((message) => message.role === 'user')?.text?.slice(0, 40);
  return preview ? `AI Chat: ${preview}` : 'AI Chat: New Session';
}

// tools/voice-router/.env holds GROQ_API_KEY; the extension host is a
// separate process from any shell that might have it set, so load it the
// same way router.mjs does.
function loadVoiceRouterEnv() {
  let content;
  try {
    content = fs.readFileSync(path.join(VOICE_ROUTER_DIR, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

let voiceRouterModulesPromise = null;
function loadVoiceRouterModules() {
  if (!voiceRouterModulesPromise) {
    loadVoiceRouterEnv();
    const libDir = path.join(VOICE_ROUTER_DIR, 'lib');
    voiceRouterModulesPromise = Promise.all([
      import(pathToFileURL(path.join(libDir, 'quota-reader.mjs')).href),
      import(pathToFileURL(path.join(libDir, 'groq-client.mjs')).href),
    ]);
  }
  return voiceRouterModulesPromise;
}

// P17-ZA: the Astro editor's voice dictionary (same file, so both learn together)
// plus OpenWhispr's custom words (read-only, merged per recording, never copied in).
const VOICE_DICTIONARY_PATHS = { dictionaryFile: path.join(ASTRO_SESSION_DIR, 'voice-dictionary.json') };
const WHISPER_PROMPT_TERMS = 40; // Whisper's `prompt` holds ~224 tokens
let voiceDictionaryPromise = null;
function loadVoiceDictionary() {
  voiceDictionaryPromise ||= import(pathToFileURL(path.join(ASTRO_SESSION_DIR, '..', '..', 'packages', 'astro-content-editor', 'src', 'voice-dictionary.mjs')).href).catch(() => null);
  return voiceDictionaryPromise;
}
async function voiceVocabulary() {
  const dictionary = await loadVoiceDictionary();
  if (!dictionary) return [];
  let local = [];
  try { local = dictionary.listEnabledTerms(VOICE_DICTIONARY_PATHS); } catch { /* unreadable file: dictate without it */ }
  const { available = [] } = await dictionary.readOpenWhisprVocabulary().catch(() => ({}));
  const seen = new Set();
  return [...local, ...available.map((entry) => entry.term)].filter((term) => {
    const key = term.toLowerCase();
    return !seen.has(key) && seen.add(key);
  });
}

/**
 * One chat thread and its own StreamEngine, independent of any window: a turn
 * keeps streaming and saving after its window switches to another chat or
 * closes. At most one ChatWindowHost watches it at a time; the
 * ChatWindowManager keeps it alive while it runs or is on screen.
 */
function safeAttachmentPaths(deps, paths) {
  const root = path.resolve(deps.attachmentsDir) + path.sep;
  return (Array.isArray(paths) ? paths : []).filter((file) => { const resolved = path.resolve(file); return resolved.startsWith(root) && fs.existsSync(resolved); });
}

/**
 * Routes one message and builds the turn ChatRun.begin runs: the agent, its
 * model, and the prompt with the briefing it needs. Shared by a chat window's
 * own sends and by windowless runs (site-edit chats fed by routePrompt).
 * `message.modelId` is the picker's model ('auto' or a catalog id).
 */
async function planTurn(run, message, deps) {
  const text = message.text;
  const quotas = await readQuotas();
  let option = modelOption(message.modelId);
  const requested = option ? option.agent : 'auto';
  // "/simplify" and the like go to the CLI that has them, as typed: a briefing in front would hide the command.
  // Under Remote Control every message goes to the live Claude session (as typed: it already has the context).
  const slashAgent = run.remote ? 'claude' : await deps.slashCommands?.owner(text, requested);
  const codexCommand = slashAgent === 'codex' ? await deps.codexCommands.resolve(text) : null;
  const dispatch = codexCommand
    ? { agent: 'codex', directive: '', contract: '', roleName: null, split: false }
    : slashAgent
      ? { agent: slashAgent, directive: '', contract: '', roleName: null, split: false }
      : route(text, quotas, requested, option?.brand);
  const rerouted = Boolean(option && dispatch.agent !== option.agent);
  if (rerouted) option = MODEL_CATALOG.find((entry) => entry.agent === dispatch.agent) || null;
  // Auto runs the agent's first catalog model, so every reply can name the exact model it came from.
  const used = option || MODEL_CATALOG.find((entry) => entry.agent === dispatch.agent) || null;
  // Normalize Gemini aliases (e.g. /grillme -> /grill-me) for CLI execution
  let promptText = text;
  if (dispatch.agent === 'gemini' && /^\/grillme(\b|\s|$)/i.test(promptText)) {
    promptText = promptText.replace(/^\/grillme(\b|\s|$)/i, '/grill-me$1');
  }
  // Memory across turns and agents: the agent resumes its own session in this
  // chat (it remembers its turns), and is briefed on the turns it missed while
  // other agents answered. The role boundary goes out once, when the agent
  // first joins this chat (a new session); its session remembers it after that.
  const session = run.chat.sessions?.[dispatch.agent] || null;
  // Never further back than the last compaction: its summary stands in for everything before it.
  const briefing = (from) => buildHandoff(run.chat.messages.slice(Math.max(from, checkpointStart(run.chat.messages))), dispatch.agent);
  const compose = (handoff, fresh) => [fresh ? dispatch.directive : '', dispatch.contract, handoff, promptText].filter(Boolean).join('\n\n');
  const prompt = codexCommand ? codexCommand.prompt : slashAgent ? promptText : session?.id ? compose(briefing(session.seen || 0), false) : compose(briefing(0), true);
  const freshPrompt = codexCommand || slashAgent ? null : session?.id ? compose(briefing(0), true) : null;
  return {
    agent: dispatch.agent,
    rerouted,
    begin: {
      agent: dispatch.agent,
      user: { role: 'user', text, at: new Date().toISOString(), agent: dispatch.agent, attachments: Array.isArray(message.attachments) ? message.attachments : [], ...(message.scheduled ? { scheduled: true } : {}) },
      reply: { role: 'assistant', text: '', agent: dispatch.agent, modelLabel: used?.label, roleName: session?.id ? undefined : dispatch.roleName, routing: dispatch.split ? 'contract-lock' : undefined },
      routing: { agentId: dispatch.agent, modelLabel: used?.label, roleName: session?.id ? null : dispatch.roleName, auto: requested === 'auto', split: dispatch.split },
      run: { agent: dispatch.agent, prompt, freshPrompt, resume: session?.id || null, codexCommand: codexCommand?.name || null, codexCommandArgs: codexCommand?.args || [], attachments: safeAttachmentPaths(deps, message.attachments), model: used?.model, effort: used?.effort },
    },
  };
}

class ChatRun {
  constructor(chat, deps) {
    // Codex's number is kept as recorded: its app-server reports each request's real context
    // size (thread/tokenUsage/updated: last.totalTokens). It used to be replaced on every load by
    // an estimate of the handoff briefing, which leaves out Codex's own turns, so a mostly-Codex
    // chat read ~1k tokens however long it ran.
    this.chat = chat;
    this.deps = deps; // { chatStore, workspaceDir, getModels, notify, notifyHistory, chatWindowManager }
    this.host = null;
    this.activeAssistantMessage = null;
    this.turnAgent = null;
    this.turn = null; // the running turn's routing message, replayed when a window attaches
    this.pending = new Map(); // unanswered approval/question cards, replayed the same way
    this.queue = []; // routed messages waiting for this chat's current turn (site-edit chats)
    this.starting = false; // a queued message is being planned; its turn hasn't begun yet
    this.streamEngine = new StreamEngine({ cwd: deps.workspaceDir, models: deps.getModels(), interactive: true });
    this.streamEngine.on('event', (event) => this.handleStreamEvent(event));
  }

  get state() { return !this.turn ? null : this.pending.size ? 'waiting' : 'running'; }
  post(message) { this.host?.panel.webview.postMessage(message); }
  save() {
    this.chat = this.deps.chatStore.save(this.chat);
    if (this.host) this.host.panel.title = titleFor(this.chat);
  }

  /** Pushes the user message and the empty reply it streams into, then starts the agent. */
  begin({ agent, user, reply, routing, run }) {
    this.turnAgent = agent;
    let contextEstimate = null;
    if (!run.codexCommand && !reply.compact) {
      const limit = CONTEXT_LIMITS[agent] || 1000000;
      const baseTokens = this.chat.context?.agent === agent && this.chat.context.tokens > 0 && this.chat.context.tokens <= limit
        ? this.chat.context.tokens
        : estimateTokens(buildCompactionHandoff(this.chat.messages, agent));
      const promptTokens = estimateTokens(run.prompt || user?.text || '');
      const startingTokens = Math.min(limit, baseTokens + (run.resume ? promptTokens : 0));
      contextEstimate = {
        agent,
        tokens: startingTokens,
        estimated: !this.chat.context?.tokens || Boolean(this.chat.context?.estimated), // a real reading stays real, Codex's too
      };
      this.chat.context = contextEstimate;
    }
    this.chat.messages.push(user);
    this.activeAssistantMessage = reply;
    this.chat.messages.push(reply);
    this.chat.lastRunAt = new Date().toISOString();
    this.save();
    // The composer draws what you type itself; a scheduled prompt arrives from the queue, so the
    // window is told to draw it as your bubble, the same as if you had just sent it.
    if (user.scheduled) this.post({ type: 'userMessage', text: user.text, at: user.at, scheduled: true });
    this.turn = { ...routing, startedAt: Date.now() };
    this.post({ type: 'routing', ...routing });
    if (contextEstimate) this.post({ type: 'usage', agent, contextTokens: contextEstimate.tokens, estimated: true });
    this.streamEngine.models = this.deps.getModels();
    this.streamEngine.start(run);
    this.deps.notifyHistory();
  }

  /**
   * /remote-control: this chat's Claude session, live in the Claude app (Code). One headless
   * Claude process (lib/stream-engine.js live mode) resumes the chat's session and opens
   * Remote Control; the panel and the phone then drive that same process: steps, approvals
   * and replies show on both, and a prompt typed on the phone runs here as its own turn.
   * Sending /remote-control again closes it; later turns go back to one process each.
   */
  async toggleRemote() {
    const notice = (text) => this.post({ type: 'notice', text });
    if (this.remote) {
      await this.streamEngine.disableRemote();
      this.remote = null;
      this.post({ type: 'remoteState', on: false });
      notice('Remote Control is off. This chat runs in the panel only again.');
      this.deps.notifyHistory();
      return;
    }
    const name = String(this.chat.title || this.chat.messages?.find((entry) => entry.role === 'user')?.text || 'AI Chat').replace(/\s+/g, ' ').slice(0, 60);
    const used = modelOption(this.chat.modelId)?.agent === 'claude' ? modelOption(this.chat.modelId) : MODEL_CATALOG.find((entry) => entry.agent === 'claude');
    try {
      notice('Starting Remote Control…');
      const bridge = await this.streamEngine.enableRemote({ name, model: used?.model, effort: used?.effort, resume: this.chat.sessions?.claude?.id || null });
      this.remote = { url: bridge.session_url || null, model: used };
      this.post({ type: 'remoteState', on: true, url: this.remote.url });
      notice(`Remote Control is on: open the Claude app › Code › "${name}". Steps, approvals and replies show there live, and what you type on the phone runs here.${this.remote.url ? ` ${this.remote.url}` : ''}`);
      this.deps.notifyHistory();
    } catch (error) {
      this.remote = null;
      notice(`Remote Control didn't start: ${error.message}`);
    }
  }

  /** A prompt typed in the Claude app: shown and saved like any turn, run by the live process that received it. */
  beginRemoteTurn(text) {
    this.turnAgent = 'claude';
    const label = this.remote?.model?.label;
    const user = { role: 'user', text, at: new Date().toISOString(), agent: 'claude', remote: true };
    const reply = { role: 'assistant', text: '', agent: 'claude', modelLabel: label };
    this.chat.messages.push(user, reply);
    this.activeAssistantMessage = reply;
    this.chat.lastRunAt = new Date().toISOString();
    this.save();
    this.turn = { agentId: 'claude', modelLabel: label, startedAt: Date.now(), remote: true };
    this.post({ type: 'userMessage', text, at: user.at });
    this.post({ type: 'routing', agentId: 'claude', modelLabel: label });
    this.deps.notifyHistory();
  }

  /** FIFO: a routed message runs once every earlier one in this chat has finished. */
  enqueue(message) {
    this.queue.push(message);
    this.drain();
  }

  drain() {
    if (this.turn || this.starting || !this.queue.length) return;
    const next = this.queue.shift();
    this.starting = true;
    // With a window open, the window runs it (picker and transcript stay in step); windowless, the run does.
    const start = this.host ? this.host.startTurn(next) : planTurn(this, next, this.deps).then((plan) => {
      this.chat.modelId = next.modelId || 'auto';
      this.begin(plan.begin);
    });
    Promise.resolve(start)
      .catch((error) => console.error('[ai-chat-panel] queued turn failed to start:', error))
      .finally(() => { this.starting = false; this.deps.notifyHistory(); });
  }

  respond(actionId, reply) {
    const result = reply(this.streamEngine);
    if (result === false) return false;
    this.pending.delete(actionId);
    if (!this.pending.size) this.deps.notifyHistory();
    return result;
  }

  /**
   * P17-R: shrinks `agent`'s context to a checkpoint. Claude compacts its own
   * session natively (/compact). Codex resumes its native thread so its own
   * automatic compaction and complete history remain available while writing
   * the checkpoint. Gemini uses the bounded transcript fallback when needed.
   */
  compact(agent, used, { auto = false } = {}) {
    const session = this.chat.sessions?.[agent] || null;
    const lastCheckpoint = this.chat.messages.findLast((message) => message.role === 'assistant' && message.checkpoint);
    // Older checkpoints were only ~1k tokens. Re-read the complete stored
    // transcript once so the first rich checkpoint can recover what remains.
    const from = lastCheckpoint?.retainedTokens ? checkpointStart(this.chat.messages) : 0;
    const history = buildCompactionHandoff(this.chat.messages.slice(from), agent);
    const fromTranscript = [history, COMPACT_DIRECTIVE].filter(Boolean).join('\n\n');
    const overflowing = this.chat.context?.agent === agent && this.chat.context.tokens >= CONTEXT_LIMITS[agent];
    const native = (agent === 'claude' || agent === 'codex') && Boolean(session?.id);
    // Codex exec reports cumulative turn consumption, not live context size,
    // and auto-compacts resumable threads itself. Never discard that thread
    // because its usage total exceeded the nominal window.
    const resume = native || (session?.id && (agent === 'codex' || !overflowing)) ? session.id : null;
    const text = auto ? 'Auto-compact: context nearly full' : 'Compact session';
    const previousContext = this.chat.context;
    this.streamEngine.interrupt();
    this.chat.context = { agent, tokens: 0 };
    this.post({ type: 'compacting', text, auto });
    this.begin({
      agent,
      user: { role: 'user', text, compact: true, auto, at: new Date().toISOString(), agent },
      reply: { role: 'assistant', text: '', agent, modelLabel: used?.label, compact: true, compactContext: history, compactPreviousContext: previousContext },
      routing: { agentId: agent, modelLabel: used?.label, roleName: null, compact: true },
      run: { agent, prompt: native ? '' : resume ? COMPACT_DIRECTIVE : fromTranscript, resume, freshPrompt: resume && !native ? fromTranscript : null, codexCommand: native && agent === 'codex' ? 'compact' : null, model: used?.model, effort: used?.effort },
    });
  }

  handleStreamEvent(event) {
    this.deps.onTelegramEvent?.(this, event);
    if (event.type === 'rate_limits' && event.agent === 'claude') recordClaudeUsage(event.windows);
    if (event.type === 'remote_prompt') { this.beginRemoteTurn(event.text); return; }
    if (event.type === 'remote_state') {
      // The live process ended or the bridge dropped: say so, and fall back to per-turn runs.
      if (event.state === 'ended' && this.remote) { this.remote = null; this.post({ type: 'remoteState', on: false }); this.post({ type: 'notice', text: 'Remote Control ended (the Claude process exited). Send /remote-control to start it again.' }); }
      if ((event.state === 'disconnected' || event.state === 'failed') && this.remote) this.post({ type: 'notice', text: `Remote Control ${event.state}; Claude Code reconnects on its own when it can.` });
      return;
    }
    if (event.type === 'session' && event.agent === 'claude' && this.deps.slashCommands?.recordClaude(event.slashCommands)) {
      void this.deps.slashCommands.list().then((commands) => this.post({ type: 'slashCommands', commands }));
    }
    if (event.type === 'session' && event.sessionId && this.turnAgent === event.agent) {
      this.chat.sessions = { ...this.chat.sessions, [event.agent]: { ...this.chat.sessions?.[event.agent], id: event.sessionId } };
    }
    // Everything up to here is in that agent's own session now.
    if (event.type === 'turn_complete' && this.turnAgent && this.chat.sessions?.[this.turnAgent]) {
      this.chat.sessions[this.turnAgent].seen = this.chat.messages.length;
      this.turnAgent = null;
    }
    if (event.type === 'usage' && this.turnAgent === event.agent) this.chat.context = { agent: event.agent, tokens: event.contextTokens }; // P17-R: saved with the turn
    if (event.type === 'delta' && this.activeAssistantMessage) this.activeAssistantMessage.text += event.text;
    // `offset`: how much reply text came before this tool, so a reload shows them in order.
    if (event.type === 'tool_start') this.chat.messages.push({ role: 'tool', event, offset: this.activeAssistantMessage?.text.length });
    // A failed step keeps its red mark after a reload or a chat switch.
    if (event.type === 'tool_end' && event.error && event.toolId) {
      const step = this.chat.messages.findLast((entry) => entry.role === 'tool' && entry.event?.toolId === event.toolId);
      if (step) step.error = true;
    }
    // A background chat waiting on you shows as "Needs input" in Manage Chats.
    if (event.type === 'approval_required' || event.type === 'question_required') { this.pending.set(event.actionId, event); this.deps.notifyHistory(); }
    if (event.type === 'approval_cancelled') this.pending.delete(event.actionId);
    let compacted = null;
    let autoCompact = null;
    let contextEstimate = null;
    if (event.type === 'turn_complete' && this.activeAssistantMessage) {
      const reply = this.activeAssistantMessage;
      const summary = reply.text.trim();
      const previousContext = reply.compactPreviousContext;
      delete reply.compactPreviousContext;
      if (reply.compact && reply.agent !== 'claude' && !event.interrupted && summary && !/^(Gemini|Codex) error:/.test(summary)) {
        // The summary is the new starting point: no session id, so the next
        // turn opens a fresh session briefed from this checkpoint on. Codex's
        // native App Server compaction keeps the same thread instead.
        reply.checkpoint = true;
        if (reply.agent !== 'codex') this.chat.sessions = { ...this.chat.sessions, [reply.agent]: {} };
        reply.retainedTokens = Math.min(COMPACT_TARGET_TOKENS, estimateTokens(buildHandoff(this.chat.messages.slice(checkpointStart(this.chat.messages)), reply.agent)));
        // The latest checkpoint subsumes earlier hidden context. Keep saved
        // chat files bounded across repeated compactions.
        for (const message of this.chat.messages) if (message !== reply && message.checkpoint) delete message.compactContext;
        compacted = { agent: reply.agent, tokens: reply.retainedTokens, estimated: true };
        this.chat.context = compacted;
      } else if (reply.compact && reply.agent !== 'claude') {
        contextEstimate = previousContext || { agent: reply.agent, tokens: 0, estimated: true };
        this.chat.context = contextEstimate;
      } else if (!event.interrupted && !reply.compact && this.chat.context?.tokens >= (CONTEXT_LIMITS[reply.agent] || 1000000) * AUTO_COMPACT_RATIO) {
        autoCompact = MODEL_CATALOG.find((entry) => entry.agent === reply.agent && entry.label === reply.modelLabel) || MODEL_CATALOG.find((entry) => entry.agent === reply.agent);
      }
    }
    if (event.type === 'turn_complete') {
      // The chime every agent plays in its own UI; a Windows toast too when you're in another app.
      if (!event.interrupted && this.activeAssistantMessage) {
        const reply = this.activeAssistantMessage;
        if (!reply.compact) this.deps.notify?.(reply.agent, reply.text, this.chat.title || this.chat.messages.find((entry) => entry.role === 'user')?.text?.slice(0, 40));
        if (reply.agent === 'codex' && !reply.compact && this.chat.context?.estimated) {
          this.chat.context.tokens = Math.min(CONTEXT_LIMITS.codex, this.chat.context.tokens + estimateTokens(reply.text));
          contextEstimate = this.chat.context;
        }
      }
      if (this.activeAssistantMessage) this.activeAssistantMessage.at = new Date().toISOString();
      if (this.activeAssistantMessage && event.totalTokens) this.activeAssistantMessage.tokens = event.totalTokens; // P17-V
      if (event.interrupted && this.activeAssistantMessage) this.activeAssistantMessage.interrupted = true;
      this.chat.lastRunAt = new Date().toISOString();
      this.save();
      this.activeAssistantMessage = null;
      this.turn = null;
      this.pending.clear();
    }
    this.post(autoCompact ? { ...event, compacting: true } : event);
    if (compacted) this.post({ type: 'usage', agent: compacted.agent, contextTokens: compacted.tokens, estimated: true });
    else if (contextEstimate) this.post({ type: 'usage', agent: contextEstimate.agent, contextTokens: contextEstimate.tokens, estimated: true });
    // An agent past 90% of its window compacts before the next turn can overflow it.
    if (autoCompact) this.compact(autoCompact.agent || 'gemini', autoCompact, { auto: true });
    if (event.type === 'turn_complete' && !autoCompact && this.afterCompact) {
      const next = this.afterCompact;
      this.afterCompact = null;
      setImmediate(() => this.host?.startTurn(next));
    }
    // The next queued message follows a finished turn; a Stop pauses the queue until the next one arrives.
    if (event.type === 'turn_complete' && !event.interrupted && !autoCompact && !this.afterCompact) setImmediate(() => this.drain());
    if (event.type === 'turn_complete') {
      this.deps.chatWindowManager.release(this);
      this.deps.notifyHistory();
      // Drops out of Active Chats once the five minutes are up.
      setTimeout(() => this.deps.notifyHistory(), ACTIVE_WINDOW_MS + 1000).unref?.();
    }
  }
}

/**
 * One floating chat window (a `vscode.WebviewPanel`, opened via
 * ChatWindowManager). Shows one ChatRun at a time; switching chats detaches
 * the old run without stopping it, so several agents can work at once in one
 * window or across many (P13-J).
 */
class ChatWindowHost {
  constructor({ panel, extensionUri, run, deps }) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.run = null;
    this.deps = deps; // { sessionManager, chatStore, voiceCapture, workspaceDir, sessionDir, attachmentsDir, getModels, chatWindowManager }
    this.activeAgent = 'auto';
    this.activeModelId = 'auto'; // a MODEL_CATALOG id, or 'auto'
    this.lastRoutedAgent = 'claude';
    this.pollTimer = null;

    panel.iconPath = { light: vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg'), dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-dark.svg') };
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.file(deps.sessionDir)],
    };
    panel.webview.html = this.renderHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    panel.onDidDispose(() => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      // A running turn carries on in the background; Manage Chats reopens it.
      this.run.host = null;
      this.deps.chatWindowManager.release(this.run);
    });

    void this.pushQuotas();
    this.postHistory();
    this.attach(run);
    panel.webview.postMessage({ type: 'editorTheme', theme: deps.getEditorTheme?.() || null });
    void this.pushSchedulerQueue();
    this.pollTimer = setInterval(() => this.pushQuotas(), QUOTA_POLL_MS);
  }

  async handleMessage(message) {
    switch (message.type) {
      // Picking a model in the composer stays headless: it never reveals the
      // real VS Code terminal (only the Terminal button does). 'auto' is the
      // routing preference for the next `send`.
      case 'setModel': this.selectModel(message.modelId); break;
      case 'send': await this.startTurn(message); break;
      case 'stop': this.run.streamEngine.interrupt(); break;
      case 'stopChat': this.deps.chatWindowManager.runs.get(message.id)?.streamEngine.interrupt(); break;
      case 'focusTerminal': {
        // An Opus pick opens the Opus terminal (P17-D), not the plain Claude one.
        const brand = modelOption(this.activeModelId)?.brand;
        const agentId = this.activeAgent === 'auto' ? this.lastRoutedAgent || 'claude' : this.activeAgent;
        this.deps.sessionManager.get(brand && this.deps.sessionManager.get(brand) ? brand : agentId)?.focus();
        break;
      }
      case 'approvalResponse': this.run.respond(message.actionId, (engine) => engine.respondToApproval(message.actionId, Boolean(message.approved), { always: Boolean(message.always) })); break;
      case 'questionResponse': this.run.respond(message.actionId, (engine) => engine.respondToQuestion(message.actionId, message.answers)); break;
      case 'newChat': this.resetToFreshChat(); break;
      case 'requestHistory': this.postHistory(); break;
      case 'restoreChat': this.restoreChat(message.id); break;
      case 'deleteChat': this.deps.chatWindowManager.deleteChat(message.id); break;
      case 'renameChat': this.deps.renameChat(message.id, message.title); break;
      case 'pickAttachments': await this.pickAttachments(); break;
      case 'attachmentData': this.saveAttachment(message); break;
      case 'removeAttachment': this.removeAttachment(message.path); break;
      case 'openFile': await this.openFile(message.path, message.line); break;
      case 'queryFiles': await this.postWorkspaceFiles(); break;
      case 'querySlashCommands': this.panel.webview.postMessage({ type: 'slashCommands', commands: await this.deps.slashCommands.list() }); break;
      case 'mentionUris': this.postMentions((message.uris || []).map((uri) => vscode.Uri.parse(uri))); break;
      case 'compact': this.compactSession(); break;
      case 'requestQuotas': await this.pushQuotas(); break;
      case 'micToggle': await this.handleMicToggle(); break;
      case 'voiceDraftSubmitted': await this.learnVoiceCorrections(message.original, message.edited); break;
      case 'scheduleTask': await this.scheduleTask(message); break;
      case 'remoteControl': void this.run.toggleRemote(); break;
      case 'requestSchedulerQueue': await this.pushSchedulerQueue(); break;
      case 'cancelScheduledTask': if (message.taskId) { await this.deps.schedulerQueue.dequeue(message.taskId); this.deps.notifySchedulerQueue?.(); } break;
      case 'editScheduledTask': {
        try { await this.deps.schedulerQueue.editPrompt(message.taskId, message.prompt); } catch (error) { this.panel.webview.postMessage({ type: 'scheduleTaskFailed', error: error.message }); }
        this.deps.notifySchedulerQueue?.();
        break;
      }
      case 'reorderScheduledTasks': await this.deps.schedulerQueue.reorder(message.ids); this.deps.notifySchedulerQueue?.(); break;
      case 'unscheduleToComposer': await this.takeScheduledTask(message.taskId, false); break;
      case 'dispatchNowWithAutoRoute': await this.takeScheduledTask(message.taskId, true); break;
      case 'requestChatDetail': this.panel.webview.postMessage({ type: 'chatDetail', chat: this.deps.chatStore.load(message.id) }); break;
      case 'revertToMessage': this.revertToMessage(message.index); break;
      case 'forkChat': {
        const source = this.deps.chatStore.load(message.id);
        if (!source) break;
        const fork = this.deps.chatStore.save({ ...this.deps.chatStore.create(), forkedFrom: source.id, messages: (source.messages || []).map((entry) => ({ ...entry })) });
        this.restoreChat(fork.id);
        this.postHistory();
        break;
      }
      case 'locateBinaries': {
        refreshBinaries();
        this.deps.codexCommands.refresh();
        const results = ['claude', 'codex', 'gemini'].map((agent) => locate(agent));
        this.deps.sessionManager.refreshCommands?.(agentList());
        this.panel.webview.postMessage({ type: 'binariesLocated', results, agent: message.agent });
        this.panel.webview.postMessage({ type: 'slashCommands', commands: await this.deps.slashCommands.list() });
        break;
      }
      default: break;
    }
  }

  async scheduleTask({ task, attachments } = {}) {
    // A limit-reset "continue" belongs to this chat (the webview may not know a fresh chat's id yet).
    if (task?.resumeHere) task = { ...task, chatId: this.run.chat.id };
    try {
      await this.deps.schedulerQueue.enqueue(task, this.safeAttachmentPaths(attachments));
      this.panel.webview.postMessage({ type: 'taskScheduled' });
      this.deps.notifySchedulerQueue?.();
    } catch (error) {
      this.panel.webview.postMessage({ type: 'scheduleTaskFailed', error: error.message });
    }
  }

  /** P17-Z: a pending task leaves the queue for this window, back into the composer or straight out through the auto-router. */
  async takeScheduledTask(taskId, sendNow) {
    const task = (await this.deps.schedulerQueue.getQueue()).find((item) => item.id === taskId && item.status === 'pending');
    if (!task) return;
    // Staged copies live in the scheduler's folder; the composer only accepts its own attachments dir, so copy them over first.
    const files = [];
    for (const attachment of task.attachments || []) {
      const file = path.join(this.deps.attachmentsDir, `${Date.now()}_${attachment.name}`);
      try { fs.copyFileSync(path.resolve(this.deps.workspaceDir, attachment.relativePath), file); files.push(this.attachmentMetadata(file, attachment.mimeType || '')); } catch { /* staged file gone: the prompt still comes back */ }
    }
    await this.deps.schedulerQueue.dequeue(taskId);
    this.deps.notifySchedulerQueue?.();
    this.panel.reveal(undefined, false);
    // Sent now, it keeps the provider it was scheduled for; Auto would reroute it by quota (e.g. to Gemini).
    const modelId = task.modelId || MODEL_CATALOG.find((entry) => entry.agent === task.model)?.id || 'auto';
    this.panel.webview.postMessage({ type: 'restoreScheduledDraft', text: task.prompt, files, sendNow: Boolean(sendNow), modelId });
  }

  get chat() { return this.run.chat; }

  /** Shows `run` in this window. The run shown before keeps going in the background;
   * a turn in progress comes back with its partial reply and any card still waiting on you. */
  attach(run) {
    const previous = this.run;
    if (previous) previous.host = null;
    run.host = this;
    this.run = run;
    this.deps.chatWindowManager.rebind(previous?.chat.id, run.chat.id, this);
    if (previous) this.deps.chatWindowManager.release(previous);
    this.panel.title = titleFor(run.chat);
    // The picker follows the chat: the model it last ran on (older chats: the last reply's model label).
    const lastReply = [...run.chat.messages].reverse().find((entry) => entry.role === 'assistant' && entry.modelLabel);
    const modelId = run.chat.modelId || MODEL_CATALOG.find((option) => option.label === lastReply?.modelLabel)?.id;
    if (modelId && modelId !== this.activeModelId && (modelId === 'auto' || modelOption(modelId))) {
      this.selectModel(modelId);
      this.panel.webview.postMessage({ type: 'setActive', modelId });
    }
    this.panel.webview.postMessage({ type: 'chatLoaded', chat: this.webviewChat(run.chat), running: run.turn });
    for (const event of run.pending.values()) this.panel.webview.postMessage(event);
  }

  resetToFreshChat() {
    this.attach(this.deps.chatWindowManager.runFor(null));
    this.postHistory();
  }

  /** Switches this window's thread. If the requested thread is already open in
   * another window, reveals that one instead of opening a second view onto the same chat. */
  restoreChat(id) {
    const otherPanel = this.deps.chatWindowManager.panelFor(id);
    if (otherPanel && otherPanel !== this.panel) {
      otherPanel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const run = this.deps.chatWindowManager.runFor(id);
    if (run && run !== this.run) this.attach(run);
  }

  /** Revert on the Nth user message: a fork holding everything before it opens
   * here, and that message goes back into the composer. The original chat stays in history. */
  revertToMessage(index) {
    const at = this.chat.messages.reduce((found, entry, i) => (entry.role === 'user' ? [...found, i] : found), [])[index];
    if (at === undefined) return;
    const text = this.chat.messages[at].text || '';
    const fork = this.deps.chatStore.save({ ...this.deps.chatStore.create(), forkedFrom: this.chat.id, messages: this.chat.messages.slice(0, at).map((entry) => ({ ...entry })) });
    this.restoreChat(fork.id);
    this.postHistory();
    this.panel.webview.postMessage({ type: 'prefillPrompt', text });
  }

  /**
   * /remote-control: Claude Code's Remote Control works in a live interactive session, not in
   * this panel's one-process-per-turn runs. So it starts one in a terminal, resuming this chat's
   * Claude session and named after the chat, and the Claude app (Code) continues it from there.
   */
  startRemoteControl() {
    const notice = (text) => this.panel.webview.postMessage({ type: 'notice', text });
    const binary = locate('claude').path;
    if (!binary) return notice('Remote Control needs the Claude Code CLI, which wasn\'t found on this machine.');
    const session = this.chat.sessions?.claude?.id || null;
    const name = String(this.chat.title || this.chat.messages?.find((entry) => entry.role === 'user')?.text || 'AI Chat').replace(/\s+/g, ' ').slice(0, 40);
    const shim = process.platform === 'win32' && /\.cmd$/i.test(binary) ? resolveShim(binary) : null;
    const terminal = vscode.window.createTerminal({
      name: `Remote Control · ${name}`,
      cwd: this.deps.workspaceDir,
      shellPath: shim?.command || binary,
      shellArgs: [...(shim?.args || []), ...(session ? ['--resume', session] : []), '--remote-control', name],
      iconPath: new vscode.ThemeIcon('remote'),
    });
    terminal.show(true);
    notice(session
      ? `Remote Control is on: open the Claude app › Code and pick "${name}" to continue this chat. It runs in the "Remote Control" terminal; keep VS Code open, and don't send here while you're using it from the phone.`
      : `Remote Control is on as a new Claude session "${name}" (this chat has no Claude session yet). Open the Claude app › Code to use it; keep VS Code open.`);
  }

  async startTurn(message) {
    const text = String(message.text || '').trim();
    if (!text) return;
    // P17-F: a message that arrives mid-turn (Steer Now, voice) interrupts
    // that turn visibly instead of silently replacing it.
    const run = this.run;
    // A message sent while a compaction runs waits for it, instead of cutting the summary off.
    if (run.turn?.compact) { run.afterCompact = message; return; }
    run.streamEngine.interrupt();
    if (message.modelId) this.selectModel(message.modelId);
    else if (message.agentId) this.setActiveAgent(message.agentId);
    const plan = await planTurn(run, { ...message, text, modelId: this.activeModelId }, this.deps);
    this.lastRoutedAgent = plan.agent;
    // A low quota can reroute an explicit pick; the picker follows it. 'auto'
    // stays selected across turns (the reply bubble names the agent used).
    if (plan.rerouted) this.setActiveAgent(plan.agent);
    run.chat.modelId = this.activeModelId; // what the picker shows when you come back to this chat
    run.begin(plan.begin);
  }

  /** The Compact button: compacts whichever agent's context the gauge shows (see ChatRun.compact). */
  compactSession() {
    const option = modelOption(this.activeModelId);
    const agent = this.chat.context?.agent || this.lastRoutedAgent || (option?.agent !== 'auto' ? option?.agent : null);
    if (!agent) return;
    this.run.compact(agent, option?.agent === agent ? option : MODEL_CATALOG.find((entry) => entry.agent === agent) || null);
  }

  postHistory() { this.panel.webview.postMessage({ type: 'history', sessions: this.deps.chatWindowManager.listChats() }); }
  async pushSchedulerQueue() { if (this.deps.schedulerQueue) this.panel.webview.postMessage({ type: 'schedulerQueue', queue: await this.deps.schedulerQueue.getQueue() }); }
  safeAttachmentPaths(paths) { return safeAttachmentPaths(this.deps, paths); }
  attachmentMetadata(file, mime = '') { const stat = fs.statSync(file); return { path: file, name: path.basename(file), size: stat.size, mime, uri: this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString() }; }
  /** P17-Q: the @-mention list. The webview filters it locally, so one query per composer session. */
  async postWorkspaceFiles() {
    const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,.astro,.next,out,build,coverage}/**', 5000);
    const root = this.deps.workspaceDir;
    const files = uris.map((uri) => path.relative(root, uri.fsPath).split(path.sep).join('/')).filter((file) => !file.startsWith('..')).sort();
    this.panel.webview.postMessage({ type: 'workspaceFiles', root: root.split(path.sep).join('/'), files });
  }
  /** Dropped or Explorer-sent files become @-mentions: workspace-relative when inside it, absolute otherwise. */
  postMentions(uris) {
    const paths = uris.filter((uri) => uri?.scheme === 'file').map((uri) => {
      const relative = path.relative(this.deps.workspaceDir, uri.fsPath);
      return (relative.startsWith('..') || path.isAbsolute(relative) ? uri.fsPath : relative).split(path.sep).join('/');
    });
    if (!paths.length) return;
    this.panel.reveal(undefined, false);
    this.panel.webview.postMessage({ type: 'insertMentions', paths });
  }
  /** P17-P: a transcript file badge. Relative paths resolve against the workspace; text files open at the line. */
  async openFile(file, line) {
    if (typeof file !== 'string' || !file) return;
    let target = file.replace(/^file:\/\/\/?/i, '');
    try { target = decodeURIComponent(target); } catch { /* keep as written */ }
    if (/^\/[a-z]:/i.test(target)) target = target.slice(1);
    const uri = vscode.Uri.file(path.isAbsolute(target) ? target : path.join(this.deps.workspaceDir, target));
    if (!fs.existsSync(uri.fsPath)) { vscode.window.showWarningMessage(`File not found: ${file}`); return; }
    const row = Math.max(0, (Number(line) || 1) - 1);
    try {
      await vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(row, 0, row, 0) });
    } catch {
      await vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.One); // images and other binaries
    }
  }
  /** P17-K: stored user messages keep attachment paths; the webview needs names and URIs for their pills. */
  webviewChat(chat) {
    const files = (paths) => this.safeAttachmentPaths(paths).map((file) => this.attachmentMetadata(file, /\.(png|jpe?g|gif|webp|bmp)$/i.test(file) ? 'image/*' : ''));
    return { ...chat, messages: (chat.messages || []).map((m) => {
      const { compactContext, compactPreviousContext, ...visible } = m;
      if (visible.role === 'assistant' && visible.compact) visible.text = '';
      return visible.role === 'user' && visible.attachments?.length ? { ...visible, files: files(visible.attachments) } : visible;
    }) };
  }
  saveAttachment({ name, mime, data }) { if (typeof data !== 'string' || data.length > 28 * 1024 * 1024) return; const filename = path.basename(String(name || 'attachment.bin')).replace(/[^a-zA-Z0-9._-]/g, '_'); const file = path.join(this.deps.attachmentsDir, `${Date.now()}_${filename}`); try { fs.writeFileSync(file, Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64')); this.panel.webview.postMessage({ type: 'attachmentSaved', attachment: this.attachmentMetadata(file, mime) }); } catch (error) { vscode.window.showErrorMessage(`AI Chat Panel: could not save attachment (${error.message}).`); } }
  async pickAttachments() { const files = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'svg'], Documents: ['md', 'json', 'ts', 'js', 'txt'] } }); for (const uri of files || []) { const filename = path.basename(uri.fsPath).replace(/[^a-zA-Z0-9._-]/g, '_'); const target = path.join(this.deps.attachmentsDir, `${Date.now()}_${filename}`); fs.copyFileSync(uri.fsPath, target); this.panel.webview.postMessage({ type: 'attachmentSaved', attachment: this.attachmentMetadata(target) }); } }
  removeAttachment(file) { const [safe] = this.safeAttachmentPaths([file]); if (safe) fs.promises.unlink(safe).catch(() => {}); }

  // P16-L: every failure path ends in micState 'idle' plus a readable toast,
  // so the mic button can never stay locked in "processing".
  voiceError(error) {
    const devices = error?.devices?.length ? ` Available devices: ${error.devices.map((name) => `"${name}"`).join(', ')}.` : '';
    const message = error?.code === 'AUDIO_CAPTURE_FAILED'
      ? `\u26A0\uFE0F Audio Capture Failed: ${error.message}.${devices}`
      : `\u26A0\uFE0F Voice input failed: ${error?.message || error}`;
    this.panel.webview.postMessage({ type: 'micState', state: 'idle' });
    this.panel.webview.postMessage({ type: 'voiceError', message });
  }

  /** P17-ZA: spellings the user fixed in a dictated draft go into the shared voice dictionary. */
  async learnVoiceCorrections(original, edited) {
    const terms = learnedTerms(original, edited);
    const dictionary = terms.length ? await loadVoiceDictionary() : null;
    if (!dictionary) return;
    for (const term of terms) { try { dictionary.addTerm(VOICE_DICTIONARY_PATHS, term); } catch { /* too long or unwritable: skip */ } }
    this.panel.webview.postMessage({ type: 'voiceTermsLearned', terms });
  }

  async handleMicToggle() {
    const capture = this.deps.voiceCapture;
    if (capture.starting) return; // double click while ffmpeg is still opening the device
    if (!capture.isRecording()) {
      this.panel.webview.postMessage({ type: 'micState', state: 'starting' });
      // P17-ZA: live levels go to the window that is recording (the capture is shared across windows).
      capture.onVolume = ({ rms, peak, level }) => this.panel.webview.postMessage({ type: 'micVolume', rms, peak, level });
      try {
        await capture.start();
      } catch (error) {
        capture.onVolume = null;
        this.voiceError(error);
        return;
      }
      this.panel.webview.postMessage({ type: 'micState', state: 'recording', device: capture.device });
      return;
    }

    capture.onVolume = null;
    this.panel.webview.postMessage({ type: 'micState', state: 'processing' });
    let wavPath;
    try {
      wavPath = await capture.stop();
    } catch (error) {
      this.voiceError(error);
      return;
    }

    try {
      const [{ readQuotas: readVoiceQuotas }, { transcribeAudio, classify, buildRoutingOutput }] =
        await loadVoiceRouterModules();

      // P17-ZA: saved spellings bias Whisper's decoding and the cleanup pass repairs toward them.
      const terms = await voiceVocabulary();
      const rawTranscript = await transcribeAudio(wavPath, { vocabularyPrompt: terms.slice(0, WHISPER_PROMPT_TERMS).join(', ') });
      const quotas = readVoiceQuotas();
      const { cleanedPrompt, primaryIntent, confidence } = await classify(rawTranscript, { dictionaryTerms: terms });
      const output = buildRoutingOutput({ cleanedPrompt, primaryIntent, confidence, quotas });

      // Never auto-sent: the draft lands in the composer for review (in Auto mode the router's pick preselects the model).
      this.panel.webview.postMessage({ type: 'micState', state: 'idle' });
      this.panel.webview.postMessage({ type: 'voiceResult', output, rawTranscript, autoSend: false });
    } catch (error) {
      this.voiceError(error);
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
    }
  }

  async pushQuotas() {
    const quotas = await readQuotas();
    this.panel.webview.postMessage({ type: 'quotas', quotas });
  }

  selectModel(modelId) {
    const option = modelOption(modelId);
    if (!option && modelId !== 'auto') return;
    this.activeModelId = modelId;
    this.activeAgent = option ? option.agent : 'auto';
  }

  /** Select an agent from outside the picker: keeps the current model if it already runs on that agent. */
  setActiveAgent(agentId) {
    const current = modelOption(this.activeModelId);
    const modelId = agentId === 'auto' ? 'auto' : current?.agent === agentId ? current.id : MODEL_CATALOG.find((option) => option.agent === agentId)?.id;
    if (!modelId) return;
    this.selectModel(modelId);
    this.panel.webview.postMessage({ type: 'setActive', modelId });
  }

  /** External dispatch entry point for aiChatPanel.injectPrompt / other extensions. */
  revealAndInject(agentId, prompt, submit, modelId = null) {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    if (submit) {
      void this.startTurn({ text: prompt, modelId, agentId: agentId || this.activeAgent });
    } else {
      if (modelId) { this.selectModel(modelId); this.panel.webview.postMessage({ type: 'setActive', modelId }); }
      else if (agentId) this.setActiveAgent(agentId);
      this.panel.webview.postMessage({ type: 'prefillPrompt', text: prompt });
    }
  }

  renderHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'agent-icons.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const katexUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'katex', 'katex.min.js'));
    const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'katex', 'katex.min.css'));
    const shikiUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'shiki', 'shiki.bundle.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:;">
<link rel="stylesheet" href="${katexCssUri}">
<link rel="stylesheet" href="${styleUri}">
<title>AI Chat Panel</title>
</head>
<body>
  <div class="topbar">
    <div class="topbar-actions">
      <button class="round-btn round-btn-queue" id="queueBtn" type="button" aria-label="Scheduled prompts" hidden>
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 5.5v3l2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="queue-countdown" id="queueCountdown"></span>
        <span class="queue-badge" id="queueBadge">0</span>
        <span class="round-btn-tip" aria-hidden="true">Queue</span>
      </button>
      <button class="round-btn" id="historyBtn" type="button" aria-label="Manage chats">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M8 4v4.3l3 1.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <path d="M2 2.5v2.4h2.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="queue-badge running-badge" id="runningBadge" hidden>0</span>
        <span class="round-btn-tip" aria-hidden="true">Chats</span>
      </button>
      <button class="round-btn" id="newChatBtn" type="button" aria-label="New chat">
        <!-- Pencil-in-bubble (sources/pencil-chat-svgrepo-com.svg), so it never reads as the composer's attach "+". -->
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12,12h0a6.93,6.93,0,0,1,2-4.89l4.66-4.66a2,2,0,0,1,2.87,0h0a2,2,0,0,1,0,2.87L16.89,10A6.92,6.92,0,0,1,12,12Z"/><path d="M14.86,1.48H5.32A3.82,3.82,0,0,0,1.5,5.3v9.54a3.82,3.82,0,0,0,3.82,3.82H9.14L12,21.52l2.86-2.86h3.82a3.82,3.82,0,0,0,3.82-3.82V9.11"/></g></svg>
        <span class="round-btn-tip" aria-hidden="true">New Chat</span>
      </button>
    </div>
  </div>

  <div class="transcript" id="transcript" aria-live="polite">
    <div class="empty-state">
      <p>Agents run headlessly in the background and stream their output straight into this panel.
      Raw terminal sessions can be inspected from the Settings tab in the sidebar if ever needed.</p>
    </div>
  </div>

  <div class="compose-row">
    <div class="composer glass">
      <textarea id="promptInput" rows="1" placeholder="Ask anything, @ to mention, / for actions"></textarea>
      <div class="composer-actions">
        <button class="model-picker" id="modelPill" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="modelMenu">
          <span class="model-picker-icon" aria-hidden="true"></span><span class="model-picker-label"></span>
          <svg class="model-picker-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 10 8 6.5l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="composer-icon-btn mic-pill" id="micBtn" title="Voice input (click to record)">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2Z" stroke="currentColor" stroke-width="1.2"/>
            <path d="M4.5 7.5v.5a3.5 3.5 0 0 0 7 0v-.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <path d="M8 11.5v2.5M6 14h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="composer-icon-btn send-btn" id="sendBtn" title="Send">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M2.5 8h10.5M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">window.MODEL_CATALOG = ${JSON.stringify(MODEL_CATALOG)}; window.TIME_PREFS = ${timePrefs()};</script>
  <script nonce="${nonce}" src="${iconsUri}"></script>
  <script nonce="${nonce}" src="${katexUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${shikiUri}" defer></script>
</body>
</html>`;
  }
}

/** Tracks every currently-open floating chat window, keyed by ChatStore id,
 * and every ChatRun that is on screen or still has a turn going. */
class ChatWindowManager {
  constructor(extensionUri, deps) {
    this.extensionUri = extensionUri;
    this.deps = deps;
    this.hosts = new Map(); // chatId -> { panel, host }
    this.runs = new Map(); // chatId -> ChatRun
    this.activeChatId = null;
  }

  panelFor(chatId) {
    return this.hosts.get(chatId)?.panel || null;
  }

  /** The live run for `chatId` (it may be streaming in the background), else one loaded from disk. Null id: a fresh chat. */
  runFor(chatId) {
    if (chatId && this.runs.has(chatId)) return this.runs.get(chatId);
    const chat = chatId ? this.deps.chatStore.load(chatId) : this.deps.chatStore.create();
    if (!chat) return null;
    const run = new ChatRun(chat, { ...this.deps, chatWindowManager: this });
    this.runs.set(chat.id, run);
    return run;
  }

  /** Forgets a run nobody is watching and that has nothing left to do. */
  release(run) {
    // A chat under Remote Control stays alive with no window: the phone is still driving it.
    if (!run.host && !run.turn && !run.starting && !run.queue.length && !run.remote && this.runs.get(run.chat.id) === run) {
      run.streamEngine.dispose();
      this.runs.delete(run.chat.id);
    }
  }

  /** History for Manage Chats: every stored chat, flagged active if it runs now or ran in the last five minutes. */
  listChats() {
    const live = new Map([...this.runs.values()].filter((run) => run.state).map((run) => [run.chat.id, run.state]));
    return markActive(this.deps.chatStore.list(), live);
  }

  /** A chat still running with no window on it stops too; one open in a window keeps its thread in memory. */
  deleteChat(id) {
    const run = this.runs.get(id);
    if (run && !run.host) { run.streamEngine.dispose(); this.runs.delete(id); }
    this.deps.chatStore.delete(id);
    this.deps.notifyHistory();
  }

  /** Opens (or reveals, if already open) the chat window for `chatId`. Omit chatId to start a fresh thread. */
  open(chatId, { viewColumn = vscode.ViewColumn.Beside, preserveFocus = false } = {}) {
    const existing = chatId && this.hosts.get(chatId);
    if (existing) {
      existing.panel.reveal(viewColumn, preserveFocus);
      return existing.host;
    }

    const run = this.runFor(chatId) || this.runFor(null);
    const panel = vscode.window.createWebviewPanel(
      'aiChatPanel.chatWindow',
      titleFor(run.chat),
      { viewColumn, preserveFocus },
      { ...this.webviewOptions(), retainContextWhenHidden: true },
    );
    return this.wire(panel, run);
  }

  webviewOptions() {
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.file(this.deps.sessionDir)] };
  }

  /** A chat window VS Code restored after a restart, in the tab spot it had: shows the chat it was showing. */
  restore(panel, chatId) {
    panel.webview.options = this.webviewOptions();
    const run = (chatId && this.runFor(chatId)) || this.runFor(null);
    panel.title = titleFor(run.chat);
    return this.wire(panel, run);
  }

  wire(panel, run) {
    // The host attaches to its run (and registers itself via rebind) as it starts.
    const host = new ChatWindowHost({ panel, extensionUri: this.extensionUri, run, deps: { ...this.deps, chatWindowManager: this } });

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) this.activeChatId = host.chat.id;
    });
    panel.onDidDispose(() => {
      if (this.hosts.get(host.chat.id)?.host === host) this.hosts.delete(host.chat.id);
      if (this.activeChatId === host.chat.id) this.activeChatId = null;
    });
    return host;
  }

  /** Called by a ChatWindowHost when its own thread id changes (new chat / restore chat). */
  rebind(oldChatId, newChatId, host) {
    if (oldChatId && this.hosts.get(oldChatId)?.host === host) this.hosts.delete(oldChatId);
    this.hosts.set(newChatId, { panel: host.panel, host });
    this.activeChatId = newChatId;
  }

  /**
   * aiChatPanel.routePrompt (the site editor's Ask AI): Auto picks the agent,
   * and the message joins that agent's one "Site edits" chat -- same thread and
   * context for every edit it gets, queued behind the ones still running. The
   * chats run without a window and show under Active Chats in Manage Chats.
   */
  async routeToSiteEditChat(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return;
    const { agent } = route(text, await readQuotas(), 'auto');
    const lanesFile = path.join(this.deps.sessionDir, 'site-edit-chats.json');
    let lanes = {};
    try { lanes = JSON.parse(fs.readFileSync(lanesFile, 'utf8')) || {}; } catch { /* first use */ }
    let run = lanes[agent] ? this.runFor(lanes[agent]) : null;
    if (!run) {
      const name = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[agent] || agent;
      run = this.runFor(this.deps.chatStore.save({ ...this.deps.chatStore.create(), title: `Site edits · ${name}` }).id);
      lanes[agent] = run.chat.id;
      fs.mkdirSync(path.dirname(lanesFile), { recursive: true });
      fs.writeFileSync(lanesFile, JSON.stringify(lanes, null, 2));
    }
    // Locked to the agent Auto chose, so a lane never hands its own turns to another agent.
    run.enqueue({ text, modelId: MODEL_CATALOG.find((entry) => entry.agent === agent)?.id || 'auto' });
    this.deps.notifyHistory();
  }

  /** A scheduled task bound to a chat (limit-reset "continue"): queued into that chat, false if the chat is gone. */
  resumeChat(task) {
    const run = this.runFor(task.chatId);
    if (!run) return false;
    run.enqueue({ text: task.prompt, modelId: task.modelId || MODEL_CATALOG.find((entry) => entry.agent === task.model)?.id || 'auto', scheduled: true });
    this.deps.notifyHistory();
    return true;
  }

  /** Used by cross-extension IPC (injectPrompt, batch dispatch): the currently focused
   * window if there is one, else the most recently opened one, else a brand-new window. */
  getOrCreateActive() {
    if (this.activeChatId && this.hosts.has(this.activeChatId)) return this.hosts.get(this.activeChatId).host;
    const [mostRecent] = [...this.hosts.values()].slice(-1);
    if (mostRecent) return mostRecent.host;
    return this.open();
  }

  dispose() {
    for (const { panel } of this.hosts.values()) panel.dispose();
    this.hosts.clear();
    for (const run of this.runs.values()) run.streamEngine.dispose();
    this.runs.clear();
  }
}

/**
 * The Activity Bar sidebar view (`aiChatPanel.mainView`). P13-J shrinks this
 * from a full chat transcript (which used to fight the File Explorer for the
 * one Primary Side Bar slot) down to a lightweight launcher: a "New Chat
 * Window" button plus recent-thread history. Actual chat happens in floating
 * WebviewPanels on the right (ChatWindowManager), which coexist freely with
 * the File Explorer.
 */
class LauncherViewProvider {
  constructor(extensionUri, deps) {
    this.extensionUri = extensionUri;
    this.deps = deps; // { chatStore, chatWindowManager }
    this.view = null;
    this.pollTimer = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    // Set-up button while the folder has no astro-visual-editor.config.json, the AI prompt once it does.
    const postSiteSetup = () => this.view?.webview.postMessage({ type: 'siteSetup', ...siteSetupState() });
    postSiteSetup();
    const watcher = vscode.workspace.createFileSystemWatcher('**/astro-visual-editor.config.json');
    watcher.onDidCreate(postSiteSetup); watcher.onDidDelete(postSiteSetup);
    webviewView.onDidDispose(() => watcher.dispose());
    webviewView.onDidDispose(() => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.view = null;
    });

    this.postHistory();
    void this.pushQuotas();
    void this.pushSchedulerQueue();
    this.pollTimer = setInterval(() => this.pushQuotas(), QUOTA_POLL_MS);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'newChatWindow': this.deps.chatWindowManager.open(); break;
      case 'setupSite': void vscode.commands.executeCommand('aiChatPanel.setupVisualEditor'); break;
      case 'requestSiteSetup': this.view?.webview.postMessage({ type: 'siteSetup', ...siteSetupState() }); break;
      case 'copySitePrompt': void copyAdaptPrompt(); break;
      case 'openChat': this.deps.chatWindowManager.open(message.id); break;
      case 'deleteChat': this.deps.chatWindowManager.deleteChat(message.id); break;
      case 'renameChat': this.deps.renameChat(message.id, message.title); break;
      case 'requestHistory': this.postHistory(); break;
      case 'requestQuotas': void this.pushQuotas(); break;
      case 'requestSchedulerQueue': void this.pushSchedulerQueue(); break;
      case 'cancelScheduledTask': void this.cancelScheduledTask(message.taskId); break;
      case 'rescheduleTask': void this.deps.schedulerQueue.reschedule(message.taskId).then(() => this.deps.notifySchedulerQueue()); break;
      case 'dispatchInterruptedTask': void this.runInterrupted(message.taskId); break;
      case 'unscheduleToComposer': void this.deps.chatWindowManager.getOrCreateActive().takeScheduledTask(message.taskId, false); break;
      case 'dispatchNowWithAutoRoute': void this.deps.chatWindowManager.getOrCreateActive().takeScheduledTask(message.taskId, true); break;
      case 'requestFleet': void this.pushFleet(); break;
      case 'pingClis': void this.pushFleet(true); break;
      case 'openModelSettings': void vscode.commands.executeCommand('workbench.action.openSettings', 'aiChatPanel.models'); break;
      case 'resetCliCache': refreshBinaries(); void this.pushFleet(); break;
      case 'configureTelegram': void this.deps.configureTelegram?.().then(() => this.pushFleet()); break;
      case 'testTelegram': {
        const bridge = this.deps.getTelegramBridge?.();
        if (!bridge || !bridge.isConfigured()) {
          vscode.window.showWarningMessage('AI Chat Panel: Configure Telegram before sending a test ping.');
          break;
        }
        bridge.sendMessage('🚀 AI Chat Panel: Test message from your workspace! Connection verified.')
          .then((ok) => {
            if (ok) vscode.window.showInformationMessage('AI Chat Panel: Test message sent successfully.');
            else vscode.window.showErrorMessage('AI Chat Panel: Failed to send Telegram test message.');
          })
          .catch((err) => vscode.window.showErrorMessage(`AI Chat Panel: Telegram error (${err.message}).`));
        break;
      }
      case 'disconnectTelegram': void this.deps.disconnectTelegram?.().then(() => this.pushFleet()); break;
      case 'startTunnel': {
        this.deps.startTunnel?.()
          .then(() => this.pushFleet())
          .catch((err) => {
            vscode.window.showErrorMessage(`AI Chat Panel: Unable to start Cloudflare Tunnel (${err.message}). Make sure 'cloudflared' is installed.`);
            this.pushFleet();
          });
        break;
      }
      case 'stopTunnel': void this.deps.stopTunnel?.().then(() => this.pushFleet()); break;
      case 'setTimeFormat': {
        if (message.format) {
          void vscode.workspace.getConfiguration('aiChatPanel').update('timeFormat', message.format, vscode.ConfigurationTarget.Global);
        }
        break;
      }
      case 'openTerminal': {
        const brand = message.brand;
        const agent = message.agentId || 'claude';
        const session = this.deps.sessionManager?.get(brand && this.deps.sessionManager.get(brand) ? brand : agent);
        if (session) session.focus();
        else void vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
        break;
      }
      default: break;
    }
  }

  /**
   * P17-W: the System tab. Every catalog model with its resolved CLI, plus the
   * background services. `ping` also runs `<cli> --version` (headless, 8s cap).
   */
  async pushFleet(ping = false) {
    if (!this.view) return;
    const version = (file) => new Promise((resolve) => {
      const shim = /\.cmd$/i.test(file) ? resolveShim(file) : null;
      if (/\.cmd$/i.test(file) && !shim) { resolve(''); return; }
      execFile(shim ? shim.command : file, [...(shim ? shim.args : []), '--version'], { windowsHide: true, timeout: 8000 }, (error, stdout) => resolve(error ? null : String(stdout).trim().split(/\r?\n/)[0]));
    });
    const clis = {};
    for (const agent of ['claude', 'codex', 'gemini']) {
      const found = locate(agent).path;
      clis[agent] = { path: found, version: ping && found ? await version(found) : undefined };
    }
    const models = MODEL_CATALOG.map(({ id, label, agent, model, effort }) => ({ id, label, agent, model, effort }));
    const services = {
      watchdog: Boolean(this.deps.watchdog?.timer),
      quotaBridge: await quotaBridgeConnected(),
      ...(this.deps.getServices?.() || {}),
    };
    this.view.webview.postMessage({ type: 'fleet', models, clis, services, pinged: ping });
  }

  async runInterrupted(taskId) {
    if (!await this.deps.watchdog.runNow(taskId)) vscode.window.showInformationMessage('AI Chat Panel: another scheduled task is still running. Reschedule this one, or run it once that finishes.');
  }

  postHistory() { this.view?.webview.postMessage({ type: 'history', sessions: this.deps.chatWindowManager.listChats() }); }
  async pushQuotas(quotas) {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'quotas', quotas: quotas || await readQuotas() });
  }
  async pushSchedulerQueue() {
    if (!this.view) return;
    const queue = await this.deps.schedulerQueue.getQueue();
    this.view.webview.postMessage({ type: 'schedulerQueue', queue });
  }
  async cancelScheduledTask(taskId) {
    if (!taskId) return;
    await this.deps.schedulerQueue.dequeue(taskId);
    await this.pushSchedulerQueue();
  }

  renderHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.js'));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'agent-icons.js'));
    // Reuses the chat window's design tokens/`.glass`/`.dot-*`/`.icon-btn`
    // rules from style.css (Ponytail: reuse the existing token sheet rather
    // than re-declaring the whole palette); launcher.css adds only the
    // launcher-specific layout on top.
    const chatStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const launcherStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.css'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${chatStyleUri}">
<link rel="stylesheet" href="${launcherStyleUri}">
<title>AI Chat Launcher</title>
</head>
<body>
  <div class="launcher-tabs pill-track glass" role="tablist">
    <button class="launcher-tab" data-tab="recent" role="tab" aria-selected="true">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.75 3.75A1.75 1.75 0 0 1 4.5 2h7a1.75 1.75 0 0 1 1.75 1.75v5.5A1.75 1.75 0 0 1 11.5 11H7l-3.25 2.5V11h.75-.5A1.75 1.75 0 0 1 2.75 9.25z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span>Recent</span>
    </button>
    <button class="launcher-tab" data-tab="scheduled" role="tab" aria-selected="false">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8.5" r="5.75" stroke="currentColor" stroke-width="1.5"/><path d="M8 5.5v3.25l2 1.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Scheduled</span>
    </button>
    <button class="launcher-tab" data-tab="settings" role="tab" aria-selected="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      <span>Settings</span>
    </button>
  </div>

  <div class="launcher-panel" id="recentPanel">
    <button class="new-chat-btn glass" id="newChatWindowBtn" type="button">
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <span>New Chat Window</span>
    </button>
    <button class="new-chat-btn glass" id="siteSetupBtn" type="button" title="Adds the Astro Visual Editor to this folder: a starter site if it's empty, or wires it into your existing Astro project" hidden>
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M2.5 13.5 8 2.5l5.5 11M4.7 9.5h6.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Set up Astro Visual Editor</span>
    </button>
    <button class="new-chat-btn glass" id="sitePromptBtn" type="button" title="Copies a prompt that has Claude or Codex make the rest of this site editable" hidden>
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
        <path d="M3.5 10.5h-.5A1 1 0 0 1 2 9.5V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <span>Copy AI adapt prompt</span>
    </button>

    <div class="model-cards" id="modelCards" aria-label="Model quotas"></div>

    <div class="history-label">Recent</div>
    <div class="history-list" id="historyList">
      <div class="history-empty">No conversations yet.</div>
    </div>
  </div>

  <div class="launcher-panel" id="scheduledPanel" hidden>
    <div class="scheduled-list" id="scheduledList">
      <div class="scheduled-empty">No tasks scheduled. Tasks queued while quota is exhausted will appear here.</div>
    </div>
  </div>

  <div class="launcher-panel" id="settingsPanel" hidden>
    <div class="history-label">Remote Control</div>
    <div class="settings-card glass">
      <div class="settings-row" id="telegramRow">
        <div class="settings-header">
          <span class="system-dot is-off" id="telegramDot"></span>
          <div class="settings-info">
            <span class="settings-title">Telegram Bridge</span>
            <span class="settings-desc" id="telegramDesc">Remote task approvals and mobile notifications.</span>
          </div>
        </div>
        <div class="settings-actions">
          <button class="settings-btn" id="configureTelegramBtn" type="button">Configure</button>
          <button class="settings-btn secondary" id="testTelegramBtn" type="button" style="display:none">Test Ping</button>
          <button class="settings-btn danger" id="disconnectTelegramBtn" type="button" style="display:none">Disconnect</button>
        </div>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-row" id="tunnelRow">
        <div class="settings-header">
          <span class="system-dot is-off" id="tunnelDot"></span>
          <div class="settings-info">
            <span class="settings-title">Cloudflare Tunnel</span>
            <span class="settings-desc" id="tunnelDesc">Enables real-time webhook delivery without port forwarding.</span>
          </div>
        </div>
        <div class="settings-actions">
          <button class="settings-btn" id="toggleTunnelBtn" type="button">Start Tunnel</button>
        </div>
      </div>
    </div>

    <div class="history-label">Fleet & CLIs</div>
    <div class="system-list glass" id="fleetList"></div>
    <div class="system-actions">
      <button class="system-action" id="pingClisBtn" type="button">Check CLIs</button>
      <button class="system-action" id="modelSettingsBtn" type="button">Model settings</button>
      <button class="system-action" id="resetCacheBtn" type="button" title="Forget resolved CLI paths and look them up again">Reset CLI cache</button>
    </div>

    <div class="history-label">Preferences & Tools</div>
    <div class="settings-card glass">
      <div class="settings-row">
        <div class="settings-info">
          <span class="settings-title">Time Format</span>
          <span class="settings-desc">Timestamp style across chat cards and queue items.</span>
        </div>
        <div class="time-format-picker pill-track" role="radiogroup">
          <button class="format-pill" data-format="24h" type="button">24h</button>
          <button class="format-pill" data-format="12h" type="button">12h</button>
          <button class="format-pill" data-format="auto" type="button">Auto</button>
        </div>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-row">
        <div class="settings-info">
          <span class="settings-title">Agent Terminal</span>
          <span class="settings-desc">Inspect raw PTY session output for debugging.</span>
        </div>
        <button class="settings-btn" id="openTerminalBtn" type="button">Open Terminal</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">window.MODEL_CATALOG = ${JSON.stringify(MODEL_CATALOG)}; window.TIME_PREFS = ${timePrefs()};</script>
  <script nonce="${nonce}" src="${iconsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function activate(context) {
  refreshBinaries();
  const AGENTS = agentList();
  const sessionManager = new TerminalSessionManager(vscode, AGENTS);
  const pendingResets = new Set();
  const chatStore = new ChatStore(ASTRO_SESSION_DIR);
  const voiceCapture = new VoiceCapture();
  // VS Code reports "c:\..."; Claude Code keys folder trust by the exact path
  // string, and the trusted entry is "C:/...". A lowercase drive letter made
  // every panel run count as an untrusted workspace.
  const workspaceDir = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(ASTRO_SESSION_DIR)).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const attachmentsDir = path.join(ASTRO_SESSION_DIR, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const codexCommands = new CodexCommandCatalog();
  const slashCommands = new SlashCommandCatalog({ codexCommands, workspaceDir, cacheFile: path.join(ASTRO_SESSION_DIR, 'slash-commands.json') });

  function getModels() {
    const configured = vscode.workspace.getConfiguration('aiChatPanel').get('models', {});
    return { claude: configured.claude || 'claude', codex: configured.codex || 'gpt-6-sol', gemini: configured.gemini || 'gemini-3.8-flash-high' };
  }

  const schedulerQueue = new SchedulerQueue({ workspaceDir, sessionDir: path.join(workspaceDir, '.astro', 'session') });
  let launcher = null;
  let chatWindowManager = null;
  // Launcher list and every open chat window's Queue badge/manager.
  function notifySchedulerQueue() {
    void launcher?.pushSchedulerQueue();
    for (const { host } of chatWindowManager?.hosts.values() || []) void host.pushSchedulerQueue();
  }

  // P16-M: status-bar poll -> launcher gauges and chat headers, live.
  void onDidChangeQuotas((quotas) => {
    void launcher?.pushQuotas(quotas);
    for (const { host } of chatWindowManager?.hosts.values() || []) host.panel.webview.postMessage({ type: 'quotas', quotas });
  }).then((subscription) => context.subscriptions.push(subscription));

  chatWindowManager = new ChatWindowManager(context.extensionUri, {
    sessionManager, chatStore, voiceCapture, workspaceDir, sessionDir: ASTRO_SESSION_DIR, attachmentsDir, getModels, codexCommands, slashCommands, schedulerQueue, notifySchedulerQueue, renameChat, getEditorTheme: () => editorTheme, notify, notifyHistory, onTelegramEvent,
  });
  // Chat windows come back after a restart in the tab spot they had, showing the same chat
  // (the webview keeps its chat id in its saved state; activation event onWebviewPanel:aiChatPanel.chatWindow).
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('aiChatPanel.chatWindow', {
    async deserializeWebviewPanel(panel, state) { chatWindowManager.restore(panel, state?.chatId || null); },
  }));
  let telegram = null;
  const tunnelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -2);
  tunnelStatus.show();
  // Code blocks use the editor's own syntax colours; follow theme switches and customizations live.
  let editorTheme = resolveEditorTheme(vscode);
  function pushEditorTheme() {
    editorTheme = resolveEditorTheme(vscode);
    for (const { host } of chatWindowManager?.hosts.values() || []) host.panel.webview.postMessage({ type: 'editorTheme', theme: editorTheme });
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(pushEditorTheme),
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('editor.tokenColorCustomizations')) pushEditorTheme(); }),
  );

  // An open window holds its chat in memory and saves it whole, so it takes
  // the new name too; otherwise its next save would put the old one back.
  function renameChat(id, title) {
    const chat = chatStore.rename(id, title);
    if (!chat) return;
    const open = chatWindowManager.runs.get(chat.id);
    if (open) {
      if (chat.title) open.chat.title = chat.title; else delete open.chat.title;
      if (open.host) open.host.panel.title = titleFor(open.chat);
    }
    notifyHistory();
  }
  // Chime on every finished reply; a Windows toast as well when the IDE is not the focused window.
  function notify(agent, text, chatTitle) {
    notifyReply({ appName: vscode.env.appName, toast: vscode.window.state.focused ? null : { agent, text, chatTitle } });
  }
  function notifyHistory() {
    launcher?.postHistory();
    for (const { host } of chatWindowManager?.hosts.values() || []) host.postHistory();
  }
  const watchdog = new SchedulerWatchdog({ queue: schedulerQueue, workspaceDir, getModels, telegram: null, onQueueChange: notifySchedulerQueue, chatStore, onHistoryChange: notifyHistory, notify, resumeInChat: (task) => chatWindowManager?.resumeChat(task) });

  function onTelegramEvent(run, event) {
    const bridge = telegram;
    if (!bridge?.running) return;
    const title = `${run.chat.title || 'Chat'} (${run.chat.id})`;
    const threadId = run.chat.telegramTopicId && (!run.chat.telegramChatId || String(run.chat.telegramChatId) === String(bridge.chatId))
      ? run.chat.telegramTopicId : null;
    void forwardRequest(bridge, event, {
      engine: run.streamEngine, title, threadId,
      respond: (id, callback) => {
        const result = run.respond(id, callback);
        if (result !== false) run.post({ type: 'approval_cancelled', actionId: id });
        return result;
      },
    }).catch(() => {});
    if (event.type === 'turn_complete' && run.activeAssistantMessage && !run.activeAssistantMessage.compact) {
      if (bridge.isForum && threadId) {
        const cleanTitle = (run.chat.title || run.chat.id || 'Project').split('(')[0].trim();
        void bridge.editForumTopic(threadId, { name: `⚪ ${cleanTitle.slice(0, 26)}` }).catch(() => {});
      }
      const statusIcon = event.interrupted ? '⏹' : '✅';
      const statusText = event.interrupted ? 'Turn stopped' : 'Turn completed';
      const agentName = event.agent ? event.agent.toUpperCase() : 'AGENT';
      const replyText = `${statusIcon} <b>${agentName} — ${statusText}</b>\n📁 <code>${title}</code>\n\n${run.activeAssistantMessage.text || 'No text response.'}`;
      const reply_markup = {
        inline_keyboard: [
          [
            { text: '💬 Select This Chat', callback_data: `chat:use:${run.chat.id}` },
            { text: '📊 Cockpit', callback_data: 'nav:cockpit' }
          ]
        ]
      };
      const options = { reply_markup, parse_mode: 'HTML' };
      if (threadId) options.message_thread_id = threadId;
      void bridge.sendMessage(replyText, options).then((ok) => {
        if (!ok) void bridge.sendMessage(`${title}\n${event.agent || 'Agent'} ${event.interrupted ? 'stopped' : 'replied'}\n\n${run.activeAssistantMessage.text || 'No text response.'}`, threadId ? { message_thread_id: threadId } : {});
      }).catch(() => {});
    }
  }

  async function startTelegram(token, chatId, webhookPublicUrl = '', ownerId = '') {
    const previous = telegram;
    await previous?.stop();
    const storedOwner = ownerId || await context.secrets.get(OWNER_KEY);
    const effectiveOwner = storedOwner || (chatId && !chatId.startsWith('-') ? chatId : '');
    if (effectiveOwner && !storedOwner) {
      void context.secrets.store(OWNER_KEY, effectiveOwner).catch(() => {});
    }
    const next = new TelegramBridge({ botToken: token, chatId, ownerId: effectiveOwner, webhookPublicUrl });
    next.onChatIdChange = async (newChatId) => {
      try {
        await context.secrets.store(CHAT_KEY, newChatId);
      } catch (err) {
        console.error('[ai-chat-panel] failed to persist new telegram chat ID:', err);
      }
    };
    bindTelegramControls(next, { manager: chatWindowManager, watchdog, queue: schedulerQueue, readQuotas, models: MODEL_CATALOG, resolveTarget: injectTarget, notifyQueue: notifySchedulerQueue });
    try { await next.start(); }
    catch (error) {
      await next.stop();
      try { await previous?.start(); } catch { /* the caller shows the startup error */ }
      throw error;
    }
    telegram = next;
    watchdog.telegram = next;
    void next.sendMessage('🖥️ <b>Workstation Online & Ready!</b>\nTap any button in the dock below, or send a prompt directly to your active chat.', { reply_markup: DOCK_KEYBOARD, parse_mode: 'HTML' });
    for (const run of chatWindowManager.runs.values()) for (const event of run.pending.values()) onTelegramEvent(run, event);
    return next;
  }

  const tunnel = new TunnelManager({
    statusItem: tunnelStatus,
    onLive: async (url) => {
      if (!telegram) throw new Error('Configure Telegram before starting the tunnel.');
      const { botToken, chatId, ownerId } = telegram;
      await startTelegram(botToken, chatId, url, ownerId);
    },
    onOff: async () => {
      if (telegram?.webhookPublicUrl) await startTelegram(telegram.botToken, telegram.chatId, '', telegram.ownerId);
    },
  });

  let telegramSetup = null;
  function configureTelegram() {
    if (telegramSetup) return telegramSetup;
    telegramSetup = setupTelegram({
      vscode, secrets: context.secrets, getCurrent: () => telegram,
      onRestored: () => { for (const run of chatWindowManager.runs.values()) for (const event of run.pending.values()) onTelegramEvent(run, event); },
      connect: async (token, chatId) => {
        const previous = telegram;
        const oldToken = await context.secrets.get(TOKEN_KEY);
        const oldChat = await context.secrets.get(CHAT_KEY);
        const oldOwner = await context.secrets.get(OWNER_KEY);
        const next = await startTelegram(token, chatId, '', chatId);
        try {
          await context.secrets.store(TOKEN_KEY, token);
          await context.secrets.store(CHAT_KEY, chatId);
          await context.secrets.store(OWNER_KEY, chatId);
        } catch (error) {
          await next.stop();
          telegram = previous;
          watchdog.telegram = previous;
          for (const [key, value] of [[TOKEN_KEY, oldToken], [CHAT_KEY, oldChat], [OWNER_KEY, oldOwner]]) {
            if (value) await context.secrets.store(key, value);
            else await context.secrets.delete(key);
          }
          throw error;
        }
      },
    }).finally(() => { telegramSetup = null; });
    return telegramSetup;
  }

  async function disconnectTelegram() {
    if (telegramSetup) { vscode.window.showInformationMessage('Finish or cancel Telegram setup before disconnecting.'); return; }
    await context.secrets.delete(TOKEN_KEY);
    await context.secrets.delete(CHAT_KEY);
    await context.secrets.delete(OWNER_KEY);
    if (telegram) { await telegram.stop(); telegram = null; watchdog.telegram = null; }
    vscode.window.showInformationMessage('AI Chat Panel: Telegram bridge disconnected.');
  }

  void (async () => {
    const token = await context.secrets.get(TOKEN_KEY);
    const chatId = await context.secrets.get(CHAT_KEY);
    const ownerId = await context.secrets.get(OWNER_KEY);
    if (token && chatId) await startTelegram(token, chatId, '', ownerId);
  })().catch((error) => vscode.window.showWarningMessage(`Telegram could not reconnect: ${error.message}. Use Configure to check the connection.`));
  watchdog.start();

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => sessionManager.handleTerminalClosed(terminal)),
  );

  // Live service state for the launcher's Settings tab.
  const getServices = () => ({
    telegram: {
      configured: Boolean(telegram?.isConfigured()),
      running: Boolean(telegram?.running),
      maskedChatId: telegram?.chatId ? `${telegram.chatId.slice(0, 3)}***` : '',
      mode: telegram?.webhookPublicUrl ? 'webhook' : telegram?.running ? 'polling' : 'off',
    },
    tunnel: {
      status: tunnel.status || 'off',
      url: tunnel.publicUrl || '',
    },
    timeFormat: vscode.workspace.getConfiguration('aiChatPanel').get('timeFormat', '24h'),
  });
  launcher = new LauncherViewProvider(context.extensionUri, {
    chatStore, chatWindowManager, schedulerQueue, getModels, watchdog, notifySchedulerQueue, renameChat,
    getServices, configureTelegram, disconnectTelegram, startTunnel: () => tunnel.start(), stopTunnel: () => tunnel.stop(),
    getTelegramBridge: () => telegram, sessionManager,
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiChatPanel.mainView', launcher));

  context.subscriptions.push(
    vscode.commands.registerCommand('aiChatPanel.open', () => {
      void vscode.commands.executeCommand('workbench.view.extension.aiChatPanel');
    }),
    vscode.commands.registerCommand('aiChatPanel.newChatWindow', () => {
      chatWindowManager.open();
    }),
    // Explorer right-click: the selection lands as @-mentions in the focused chat window.
    vscode.commands.registerCommand('aiChatPanel.addToChat', (uri, uris) => {
      const picked = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
      chatWindowManager.getOrCreateActive().postMentions(picked);
    }),
    vscode.commands.registerCommand('aiChatPanel.configureTelegram', () => configureTelegram()),
    vscode.commands.registerCommand('aiChatPanel.startTunnel', async () => {
      try { await tunnel.start(); }
      catch (error) { vscode.window.showErrorMessage(`AI Chat Panel: unable to start Cloudflare Tunnel (${error.message}).`); }
    }),
    vscode.commands.registerCommand('aiChatPanel.stopTunnel', () => tunnel.stop()),
    // Cross-extension IPC target (see packages/vscode-astro-editor/src/webviewPanel.ts):
    // targets the active floating chat window (or opens a new one on the
    // right) instead of ever touching the left Activity Bar, so a batch
    // dispatch from the Astro Editor HUD never displaces the File Explorer.
    vscode.commands.registerCommand('aiChatPanel.injectPrompt', (payload) => {
      const { targetModel, prompt, submit } = payload || {};
      const target = injectTarget(targetModel);
      if (!target) {
        vscode.window.showWarningMessage(`AI Chat Panel: unknown target model "${targetModel}".`);
        return;
      }
      const host = chatWindowManager.getOrCreateActive();
      host.revealAndInject(target.agentId, prompt, submit !== false, target.modelId);
    }),
    vscode.commands.registerCommand('aiChatPanel.routePrompt', (payload) => chatWindowManager.routeToSiteEditChat(payload?.prompt)),
    vscode.commands.registerCommand('aiChatPanel.setupVisualEditor', setupVisualEditor),
  );

  // P12-D: Supervised Fresh-Session Chaining. Called with
  // { targetModel, handoffSummary: { decisions, modifiedExports, invariants }, batchPrompt }
  // once a batch has passed its own automated verification -- writes the
  // micro-handoff artifact, then requires an explicit modal confirmation
  // before ever touching the terminal (see pty-session.js's own comment on
  // why no automatic idle-prompt detection is possible here). This still
  // targets the real PTY terminal (not a chat window) -- it is specifically
  // about resetting that raw session, per P12-D.
  context.subscriptions.push(
    vscode.commands.registerCommand('aiChatPanel.runNextBatchInCleanSession', async (payload) => {
      const { targetModel, handoffSummary, batchPrompt } = payload || {};
      const session = sessionManager.get(targetModel);
      if (!session) {
        vscode.window.showWarningMessage(`AI Chat Panel: unknown target model "${targetModel}".`);
        return;
      }
      if (!batchPrompt) {
        vscode.window.showWarningMessage('AI Chat Panel: runNextBatchInCleanSession requires a batchPrompt.');
        return;
      }
      // Guards the one real race available here: a duplicate invocation
      // (e.g. a double-click) firing a second confirmation/reset for the
      // same agent while the first is still awaiting the user's answer.
      if (pendingResets.has(targetModel)) return;
      pendingResets.add(targetModel);
      try {
        const summary = writeMicroHandoff(path.join(ASTRO_SESSION_DIR, 'handoff.json'), handoffSummary);
        const CONFIRM_LABEL = '🚀 Run Next Batch in Clean Session';
        const choice = await vscode.window.showWarningMessage(
          `Batch verified for ${session.label}. Clear its terminal and start the next batch in a clean session? Only confirm once ${session.label} is genuinely idle -- this extension has no way to detect that automatically.`,
          { modal: true },
          CONFIRM_LABEL,
        );
        if (choice !== CONFIRM_LABEL) return;
        session.runNextBatchInCleanSession(formatMicroHandoffPrompt(summary), batchPrompt);
        session.focus();
      } finally {
        pendingResets.delete(targetModel);
      }
    }),
  );

  for (const agent of AGENTS) {
    const commandId = `aiChatPanel.focus${agent.id[0].toUpperCase()}${agent.id.slice(1)}`;
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, () => {
        sessionManager.get(agent.id).focus();
      }),
    );
  }

  context.subscriptions.push({ dispose: () => sessionManager.dispose() }, { dispose: () => chatWindowManager.dispose() }, { dispose: () => watchdog.stop() }, { dispose: () => { void telegram?.stop(); } }, tunnel, tunnelStatus);
}

function deactivate() {}

module.exports = { activate, deactivate, agentList, injectTarget, opusTerminalCommand, ChatWindowHost, ChatWindowManager, LauncherViewProvider, SchedulerWatchdog, TunnelManager, quotaAvailable };
