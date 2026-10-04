'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TerminalSessionManager } = require('./lib/pty-session.js');
const { readQuotas, onDidChangeQuotas, recordClaudeUsage, claudeUsageAge } = require('./lib/quota-bridge.js');
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
const providers = require('./lib/providers'); // the coding-agent CLIs Clanker drives (docs/adding-a-provider.md)
const { VoiceHotkey, createHotkeyHandlers } = require('./lib/voice-hotkey.js');
const { GroqAccount } = require('./lib/groq-account.js');
const voiceDictionary = require('./lib/voice-dictionary.js');
const { resolveSessionDir } = require('./lib/session-dir.js');
const { writeMicroHandoff, formatMicroHandoffPrompt } = require('./lib/handoff.js');

// The Routing tab's setup guides link here by key, so the webview can't open arbitrary addresses.
const ROUTING_LINKS = {
  cfSignup: 'https://dash.cloudflare.com/sign-up',
  cfAi: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
  groqKeys: 'https://console.groq.com/keys',
  groqLimits: 'https://console.groq.com/dashboard/limits',
};
const { execFile, spawn } = require('node:child_process');
const { StreamEngine } = require('./lib/stream-engine.js');
const { locate, refresh: refreshBinaries, resolveShim, terminalCommand } = require('./lib/binary-locator.js');
const { ChatStore, markActive, ACTIVE_WINDOW_MS, deriveFallbackTitle, recoverInterruptedChat, ownedByAnotherHost } = require('./lib/chat-store.js');
const { route, routeBest } = require('./lib/auto-router.js');
const { runtime: routingRuntime, compactSource, projectStack } = require('./lib/routing-runtime.js');
const { windowOf, GROQ_MODEL } = require('./lib/routing.js');
const { MODEL_CATALOG, AVAILABLE_MODELS, defaultModel, modelOption, resolveModel } = require('./lib/model-catalog.js');
const { CliHub } = require('./lib/cli-tools.js');
const { CliAccounts } = require('./lib/cli-accounts.js');
const { promptFor, permissionFor, appendInstructions } = require('./media/model-prompts.js');
const { CostMeter, legacyChatCost, chatCost, LEDGER_VERSION } = require('./lib/api-cost.js');
const { isLimitNotice } = require('./media/limit-notice.js');
const { SchedulerQueue, ACTIVE_STATUSES, isDue } = require('./lib/scheduler-queue.js');
const { ProjectRegistry, projectFiles } = require('./lib/projects.js');
const { TelegramBridge, DOCK_KEYBOARD, escapeHtml, markdownToTelegramHtml } = require('./lib/telegram-bridge.js');
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
const SUBAGENT_LOG_LIMIT = 3000; // subagent events kept per chat for the agents viewer
const { notifyReply } = require('./lib/notify.js');
const { sweepStorage } = require('./lib/storage-gc.js');
const { planUndo, applyUndo, fileCount, fileList } = require('./lib/turn-undo.js');
const { verifyInstruction, ARCHITECT_PREFIX, buildInstruction } = require('./lib/turn-extras.js');

// P17-X: clock locale + format shared by both webviews ('24h' default, 'auto' follows vscode.env.language).
const timePrefs = () => JSON.stringify({ locale: vscode.env.language || 'en', timeFormat: vscode.workspace.getConfiguration('aiChatPanel').get('timeFormat', '24h') });

const QUOTA_POLL_MS = 5000;
const WATCHDOG_POLL_MS = 15000; // a timer that reaches 0 should not wait up to a minute for the next look
const WATCHDOG_THRESHOLD_PCT = 20;

function recordToolEnd(chat, event) {
  if (!event.toolId) return;
  const step = chat.messages.findLast(entry => entry.role === 'tool' && entry.event?.toolId === event.toolId);
  if (!step) return;
  step.done = true;
  step.error = Boolean(event.error);
  step.event = { ...step.event, output: String(event.output || '').slice(0, 16000), diff: event.diff || step.event.diff };
}

function quotaAvailable(quotas, model) {
  const quota = quotas?.[model];
  return model === 'gemini' && typeof quota?.remaining !== 'number'
    ? true // no live Antigravity number: never block it
    : typeof quota?.remaining === 'number' && quota.remaining > WATCHDOG_THRESHOLD_PCT;
}

class SchedulerWatchdog {
  constructor({ queue, workspaceDir, getModels, getPermissionMode, getModelPrompts, getModelSettings, telegram, onQueueChange, chatStore, onHistoryChange, notify, resumeInChat, isAgentEnabled, projects }) {
    this.projects = projects;
    this.isAgentEnabled = isAgentEnabled || (() => true);
    this.notify = notify || null;
    this.getModelSettings = getModelSettings;
    this.resumeInChat = resumeInChat || null;
    this.queue = queue; this.workspaceDir = workspaceDir; this.getModels = getModels; this.getPermissionMode = getPermissionMode || null; this.getModelPrompts = getModelPrompts || null; this.telegram = telegram;
    this.onQueueChange = onQueueChange || (() => {});
    this.chatStore = chatStore || null; this.onHistoryChange = onHistoryChange || (() => {});
    this.timer = null; this.running = false; this.activeTaskId = null; this.output = ''; this.failed = ''; this.chat = null; this.reply = null;
    this.engine = new StreamEngine({ cwd: workspaceDir, models: getModels(), permissionMode: getPermissionMode ? getPermissionMode() : 'fullAccess' });
    this.engine.on('event', (event) => void this.handleEvent(event));
  }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.tick(), WATCHDOG_POLL_MS); void this.tick(); } }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reply) {
      delete this.reply.inProgress;
      delete this.reply.hostPid;
      Object.assign(this.reply, { interrupted: true, interruptionReason: 'host_shutdown', at: new Date().toISOString() });
      this.chatStore.save(this.chat);
    }
    this.engine.dispose(); this.activeTaskId = null;
  }
  async tick() {
    if (this.running || this.activeTaskId) return;
    this.running = true;
    try {
      await refreshClaudeUsage(this.workspaceDir); // real numbers before deciding a Claude task may run
      // Tasks that go back into their chat finish at once, so every due one is released in turn (the chat runs them one after
      // another); a headless run holds the watchdog until it ends.
      for (let guard = 0; guard < 50; guard++) {
        const queue = await this.queue.getQueue();
        const next = queue.find((task) => task.status === 'pending' && this.isAgentEnabled(task.model) && isDue(task, Date.now()) && this.projectAvailable(task));
        if (!next || !quotaAvailable(await readQuotas(), next.model)) return;
        await this.dispatch(next);
        if (this.activeTaskId) return;
      }
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
    if (!this.isAgentEnabled(task.model)) throw new Error('This CLI was removed from Clanker. Add it in Settings before running this task.');
    const projectId = task.projectId || (task.chatId && this.chatStore?.load(task.chatId)?.projectId);
    const context = this.projects?.context(projectId);
    if (task.chatId && task.projectId && this.chatStore?.load(task.chatId)?.projectId !== task.projectId) throw new Error('Scheduled task project does not match its conversation.');
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
    if (context) {
      this.engine.dispose(); // Native server sessions must not carry over between project directories.
      this.engine = new StreamEngine({ cwd: context.workspaceDir, models: this.getModels(), permissionMode: this.getPermissionMode?.() || 'fullAccess' });
      this.engine.on('event', event => void this.handleEvent(event));
    }
    this.engine.permissionMode = this.getPermissionMode ? this.getPermissionMode() : 'fullAccess';
    // P17-H: a headless run is a real chat, so it lands in the Recent tab.
    if (this.chatStore) {
      this.reply = { role: 'assistant', text: '', agent: task.model, inProgress: true, hostPid: process.pid };
      this.chat = this.chatStore.save({ ...this.chatStore.create(), projectId, title: `Scheduled: ${task.prompt.slice(0, 40)}`, messages: [{ role: 'user', text: task.prompt, agent: task.model }, this.reply] });
      this.onHistoryChange();
    }
    // The model the task was scheduled with; only a task without one (or a stale id) falls back to what Auto would run.
    const chosen = modelOption(task.modelId);
    const option = (chosen?.agent === task.model ? chosen : defaultModel(task.model)) || {};
    const { model, effort } = option;
    this.engine.start({ agent: task.model, prompt: appendInstructions(task.prompt, { modelPrompt: promptFor(this.getModelPrompts?.(), option) }), model, effort, permissionMode: permissionFor(this.getModelSettings?.(), option, this.getPermissionMode?.() || 'fullAccess'), attachments: task.attachments.map((attachment) => path.resolve(task.workspaceDir || this.queue.workspaceDir || this.workspaceDir, attachment.absolutePath || attachment.relativePath)) });
  }
  projectAvailable(task) {
    if (!this.projects) return true;
    try {
      this.projects.context(task.projectId || (task.chatId && this.chatStore?.load(task.chatId)?.projectId));
      return true;
    } catch { return false; }
  }
  async handleEvent(event) {
    if (event.type === 'rate_limits' && event.agent === 'claude') recordClaudeUsage(event.windows);
    if (!this.activeTaskId) return;
    if (event.type === 'tool_start' && this.chat) { this.chat.messages.push({ role: 'tool', event, offset: this.reply?.text.length, done: Boolean(event.done) }); this.chat = this.chatStore.save(this.chat); }
    if (event.type === 'tool_end' && this.chat) { recordToolEnd(this.chat, event); this.chat = this.chatStore.save(this.chat); }
    if (event.type === 'delta') {
      this.output = (this.output + String(event.text || '')).slice(0, 800);
      if (this.reply) this.reply.text += String(event.text || '');
      if (this.chat) this.chatStore.checkpoint(this.chat);
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
    if (this.chat) {
      delete this.reply.inProgress;
      delete this.reply.hostPid;
      this.reply.at = new Date().toISOString();
      if (event.interrupted) this.reply.interrupted = true;
      this.chatStore.save(this.chat); this.chat = null; this.reply = null; this.onHistoryChange();
    }
    if (this.failed) { await this.queue.markFailed(taskId, this.failed); await this.telegram?.sendMarkdown(`Scheduler retry/failure for \`${taskId}\`: ${this.failed}`); }
    else {
      await this.queue.markCompleted(taskId, this.output);
      await this.telegram?.sendMarkdown(`Scheduler completed \`${taskId}\` (${this.output || 'no output'}).`);
      this.notify?.(event.agent, this.output, 'Scheduled task', { chime: false }); // scheduled work never chimes
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
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(__dirname, '..', 'voice-router');
}
const VOICE_ROUTER_DIR = getVoiceRouterDir();

// The AI bridge's version and what this provider implements (docs/ai-bridge-interface.md).
const BRIDGE_API_VERSION = 1;
const BRIDGE_CAPABILITIES = ['routePrompt', 'injectPrompt', 'runBatch', 'favoriteModels', 'routingMode'];

// Clanker's own state (chats, attachments, scheduler queue, handoff, voice dictionary): its per-user storage,
// resolved in activate() by lib/session-dir.js. Nothing here belongs to a project or to another extension.
let SESSION_DIR;

// P16-I: resolved per workstation by lib/binary-locator.js at activation.
function agentList() {
  return [
    { id: 'claude', label: 'Claude Code', command: terminalCommand('claude') },
    { id: 'codex', label: 'Codex', command: terminalCommand('codex') },
    { id: 'gemini', label: 'Antigravity', command: terminalCommand('gemini') },
    { id: 'opus', label: resolveModel('opus')?.label.replace(/\s+\S+$/, '') || 'Claude Opus', command: opusTerminalCommand() },
  ];
}

// P17-D: a one-click Opus terminal. A claude CLI too old for the model id
// or --effort exits non-zero right at startup; only that fast failure (not a
// normal quit later on) relaunches the same terminal on Sonnet.
function claudeLaunch(modelId) {
  const option = modelOption(modelId);
  if (!option) return terminalCommand('claude');
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  return terminalCommand('claude', `--model ${quote(option.model)}${option.effort ? ` --effort ${quote(option.effort)}` : ''}`);
}
function opusTerminalCommand() {
  const opus = resolveModel('opus');
  const sonnet = resolveModel('sonnet');
  if (!opus || !sonnet) return claudeLaunch(opus?.id);
  return `$t = Get-Date; ${claudeLaunch(opus.id)}; if ($LASTEXITCODE -and ((Get-Date) - $t).TotalSeconds -lt 15) { Write-Host 'This claude CLI cannot run the selected Opus model. Starting Sonnet.'; ${claudeLaunch(sonnet.id)} }`;
}

// P17-D: an injectPrompt / Telegram target is an agent id or any model name
// resolveModel knows ('opus', 'Claude Opus 5.5', a catalog id).
function injectTarget(name) {
  if (providers.has(name)) return { agentId: name, modelId: null };
  const option = resolveModel(name);
  return option ? { agentId: option.agent, modelId: option.id } : null;
}

function getNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function titleFor(chat) {
  if (chat.title) return `Clanker: ${chat.title}`;
  const firstUser = chat.messages?.find((message) => message.role === 'user')?.text;
  if (firstUser) {
    const fallback = deriveFallbackTitle(chat.messages);
    return `Clanker: ${fallback}`;
  }
  return 'Clanker: New Session';
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
let groqAccount = null; // set in activate(): the saved Groq key and its usage (lib/groq-account.js)
function loadVoiceRouterModules() {
  if (!voiceRouterModulesPromise) {
    loadVoiceRouterEnv();
    const libDir = path.join(VOICE_ROUTER_DIR, 'lib');
    voiceRouterModulesPromise = Promise.all([
      import(pathToFileURL(path.join(libDir, 'quota-reader.mjs')).href),
      import(pathToFileURL(path.join(libDir, 'groq-client.mjs')).href),
    ]).then((modules) => { groqAccount?.attach(modules[1]); return modules; }); // Settings counts the Groq requests from here on
  }
  return voiceRouterModulesPromise;
}

// P17-ZA: Clanker's own voice dictionary (lib/voice-dictionary.js) plus OpenWhispr's custom words.
const WHISPER_PROMPT_TERMS = 40; // Whisper's `prompt` holds ~224 tokens
const voicePaths = () => ({ dictionaryFile: path.join(SESSION_DIR, 'voice-dictionary.json') });
const voiceVocabulary = () => voiceDictionary.vocabulary(voicePaths());

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
 * own sends and by windowless runs (routed-prompt chats fed by routePrompt).
 * `message.modelId` is the picker's model ('auto' or a catalog id).
 */
/**
 * The model a chat was working with on `agent`: its last reply's exact model, else the picker's choice saved on the
 * chat, else that agent's default. A "continue" after a usage limit goes back to the same model (Sonnet stays Sonnet).
 */
function chatModelFor(chat, agent) {
  const lastReply = [...(chat?.messages || [])].reverse().find((entry) => entry.role === 'assistant' && entry.agent === agent && entry.modelLabel);
  const byLabel = lastReply && [...MODEL_CATALOG, ...AVAILABLE_MODELS].find((option) => option.agent === agent && option.label === lastReply.modelLabel);
  const saved = modelOption(chat?.modelId);
  return byLabel || (saved?.agent === agent ? saved : null) || defaultModel(agent);
}

async function chooseAutoModel(task, models, quotas, deps, context = []) {
  const modules = await loadVoiceRouterModules();
  return modules[1].selectFavoriteModel(task, models.map(model => ({
    id: model.id, agent: model.agent, brand: model.brand, model: model.model, label: model.label, effort: model.effort,
    description: model.description, instructions: promptFor(deps.getModelPrompts?.(), model),
  })), quotas, context);
}

async function planTurn(run, message, deps) {
  run.requireProject(); // Validate the pinned project; never fall back to the active editor.
  if (deps.ensureModels) await deps.ensureModels();
  const text = message.text;
  const quotas = await readQuotas();
  let option = modelOption(message.modelId);
  if (message.modelId && message.modelId !== 'auto' && !option) throw new Error(`Selected model ${message.modelId} is unavailable. Refresh Models or choose another model.`);
  const accounts = deps.cliAccounts;
  if (accounts && !accounts.enabledAgents().length) throw new Error('Add a CLI in Settings > Models to start chatting.');
  if (option && accounts?.isEnabled(option.agent) === false) throw new Error('This CLI was removed from Clanker. Add it in Settings > Models, or choose another model.');
  const requested = option ? option.agent : 'auto';
  // "/simplify" and the like go to the CLI that has them, as typed: a briefing in front would hide the command.
  // Under Remote Control every message goes to the live Claude session (as typed: it already has the context).
  const slashAgent = run.remote ? 'claude' : await deps.slashCommands?.owner(text, requested);
  if (slashAgent && accounts?.isEnabled(slashAgent) === false) throw new Error('The CLI for this action was removed. Add it in Settings > Models.');
  const codexCommand = slashAgent === 'codex' ? await deps.codexCommands.resolve(text) : null;
  let routingDecision = null;
  if (!slashAgent && deps.routing) {
    const previous = modelOption(run.chat.routingModelId) || chatModelFor(run.chat, run.chat.context?.agent);
    const attachments = safeAttachmentPaths(deps, message.attachments);
    // Favorites bound Auto's choices; a manually selected discovered model can
    // still be used after its favorite is removed or its effort is changed.
    const candidates = MODEL_CATALOG.filter(m => !accounts || accounts.isEnabled(m.agent));
    if (option && !candidates.some(m => m.id === option.id)) candidates.push(option);
    routingDecision = await deps.routing.router.route({ prompt: text, project: run.chat.projectId || deps.workspaceDir, project_aliases: [deps.workspaceDir, deps.projects?.get(run.chat.projectId)?.name], stack: projectStack(deps.workspaceDir), previous, manual_pick: option?.id, screenshot: attachments.some(f => /\.(png|jpe?g|webp)$/i.test(f)), attachments, context_tokens: run.chat.context?.tokens || 0, context_pct: previous ? (run.chat.context?.tokens || 0) / windowOf({...previous,...deps.routing.getConfig().models[previous.id]}) * 100 : 0, turns_since_switch: run.chat.routingTurns || 0, retry: message.retry === true, new_chat: message.newChat === true }, candidates, quotas);
    if (routingDecision.exhausted) throw new Error('No enabled model can accept this prompt with the remaining quota and image/context requirements.');
    option = modelOption(routingDecision.pick) || (routingDecision.pick === GROQ_MODEL.id ? GROQ_MODEL : null);
    if (previous?.id !== option?.id) run.chat.routingTurns = 0;
    else run.chat.routingTurns = (run.chat.routingTurns || 0) + 1;
    run.chat.routingModelId = option?.id;
    void deps.routing.prepareSummary(run.chat, option, run.chat.projectId || deps.workspaceDir, [deps.workspaceDir, deps.projects?.get(run.chat.projectId)?.name]);
  }
  const dispatch = routingDecision
    ? { agent: option.agent, modelId: option.id, directive: '', contract: '', roleName: null, split: false }
    : codexCommand
    ? { agent: 'codex', directive: '', contract: '', roleName: null, split: false }
    : slashAgent
      ? { agent: slashAgent, directive: '', contract: '', roleName: null, split: false }
      : requested === 'auto'
        ? await routeBest(text, quotas, accounts?.enabledAgents(), deps.chooseAutoModel || ((task, models, quotas) => chooseAutoModel(task, models, quotas, deps,
          run.chat.messages.slice(-4).map(entry => ({ role: entry.role, text: String(entry.text || '').slice(0, 1500) })))))
        : route(text, quotas, requested);
  const rerouted = Boolean(option && dispatch.agent !== option.agent);
  if (rerouted) option = defaultModel(dispatch.agent);
  // Auto preserves the selected favorite's exact model and reasoning effort.
  const used = option || modelOption(dispatch.modelId) || defaultModel(dispatch.agent);
  // Normalize Gemini aliases (e.g. /grillme -> /grill-me) for CLI execution
  let promptText = text;
  if (dispatch.agent === 'gemini' && /^\/grillme(\b|\s|$)/i.test(promptText)) {
    promptText = promptText.replace(/^\/grillme(\b|\s|$)/i, '/grill-me$1');
  }
  // Auto-Verify and Architect/Editor wrap the prompt the agent gets, never a slash command, and never the transcript.
  // Your text, then the answering model's own prompt (Settings > Models: only for this exact model), then Auto-Verify's / the
  // pipeline's suffix, which asks for the last step. A slash command goes as typed.
  const modelPrompt = promptFor(deps.getModelPrompts?.(), used);
  if (!slashAgent && (message.promptPrefix || message.promptSuffix || modelPrompt)) promptText = [message.promptPrefix, appendInstructions(promptText, { modelPrompt, verify: message.promptSuffix })].filter(Boolean).join('\n\n');
  // Memory across turns and agents: the agent resumes its own session in this
  // chat (it remembers its turns), and is briefed on the turns it missed while
  // other agents answered. Clear old Auto role boundaries in resumed sessions.
  const session = routingDecision?.action === 'new' ? null : run.chat.sessions?.[dispatch.agent] || null;
  if (routingDecision?.action === 'new') run.chat.sessions = {};
  // Never further back than the last compaction: its summary stands in for everything before it.
  const briefing = (from) => deps.routing
    ? (run.chat.messages.length ? `PROJECT: ${run.chat.projectId || deps.workspaceDir}\nCOMPACT HANDOFF:\n${run.chat.routingSummary || compactSource(run.chat)}` : `PROJECT: ${run.chat.projectId || deps.workspaceDir}`)
    : buildHandoff(run.chat.messages.slice(Math.max(from, checkpointStart(run.chat.messages))), dispatch.agent);
  const manualReset = session?.id ? `${requested !== 'auto' ? 'The model was selected manually. ' : ''}Earlier Auto-mode role restrictions no longer apply. Follow the user's current request.` : '';
  const compose = (handoff, fresh) => [manualReset, fresh ? dispatch.directive : '', dispatch.contract, handoff, promptText].filter(Boolean).join('\n\n');
  const prompt = codexCommand ? codexCommand.prompt : slashAgent ? promptText : session?.id ? compose(briefing(session.seen || 0), false) : compose(briefing(0), true);
  const freshPrompt = codexCommand || slashAgent ? null : session?.id ? compose(briefing(0), true) : null;
  return {
    agent: dispatch.agent,
    rerouted,
    begin: {
      agent: dispatch.agent,
      user: { role: 'user', text, at: new Date().toISOString(), agent: dispatch.agent, modelId: message.modelId, attachments: Array.isArray(message.attachments) ? message.attachments : [], ...(message.scheduled ? { scheduled: true } : {}), ...(message.queued ? { queued: true } : {}), ...(message.pipelineBuild ? { pipelineBuild: true } : {}) },
      reply: { role: 'assistant', text: '', agent: dispatch.agent, modelId: used?.id, modelLabel: used?.label, roleName: session?.id ? undefined : dispatch.roleName, routing: routingDecision || (dispatch.split ? 'contract-lock' : undefined) },
      routing: { agentId: dispatch.agent, modelLabel: used?.label, roleName: session?.id ? null : dispatch.roleName, auto: requested === 'auto', split: dispatch.split },
      run: { agent: dispatch.agent, prompt, freshPrompt, resume: session?.id || null, groqRouter: deps.routing?.router, contextWindow: used ? windowOf({ ...used, ...deps.routing?.getConfig().models[used.id] }) : undefined, codexCommand: codexCommand?.name || null, codexCommandArgs: codexCommand?.args || [], attachments: safeAttachmentPaths(deps, message.attachments), model: used?.model, effort: used?.effort, permissionMode: permissionFor(deps.getModelSettings?.(), used, deps.getPermissionMode?.() || 'fullAccess') },
    },
  };
}

class ChatRun {
  constructor(chat, deps) {
    if (recoverInterruptedChat(chat)) chat = deps.chatStore.save(chat);
    // Codex's number is kept as recorded: its app-server reports each request's real context
    // size (thread/tokenUsage/updated: last.totalTokens). It used to be replaced on every load by
    // an estimate of the handoff briefing, which leaves out Codex's own turns, so a mostly-Codex
    // chat read ~1k tokens however long it ran.
    this.chat = chat;
    this.deps = deps; // { chatStore, workspaceDir, getModels, getPermissionMode, notify, notifyHistory, chatWindowManager }
    // Every window showing this chat (the sidebar's and any editor tabs). The run is the one source of truth;
    // a window only draws it, so they all stay in step. The last one is the window used most recently.
    this.hosts = new Set();
    this.activeAssistantMessage = null;
    this.turnAgent = null;
    this.turn = null; // the running turn's routing message, replayed when a window attaches
    this.pending = new Map(); // unanswered approval/question cards, replayed the same way
    this.queue = Array.isArray(chat.turnQueue?.turns) ? chat.turnQueue.turns.map((turn) => ({ ...turn, queued: true, editing: false })) : [];
    this.queuePaused = chat.turnQueue?.paused === true;
    this.starting = false; // a queued message is being planned; its turn hasn't begun yet
    this.planning = 0;
    this.startVersion = 0;
    this.subagentLog = []; // this chat's subagent events, for the agents viewer (not saved to disk)
    this.streamEngine = new StreamEngine({ cwd: deps.workspaceDir, models: deps.getModels(), permissionMode: deps.getPermissionMode?.() || 'fullAccess', interactive: true });
    this.streamEngine.on('event', (event) => this.handleStreamEvent(event));
    // The chat's API value so far (api-cost.js). Chats saved before it was kept get theirs from their replies' figures.
    if (!Number.isFinite(this.chat.apiCostUsd)) this.chat.apiCostUsd = legacyChatCost(this.chat.messages);
  }

  // Background agents count as running after the turn ends: the orb stays on the chat while they work.
  get state() { return !this.turn ? (this.streamEngine.hasBackgroundAgents ? 'running' : null) : this.pending.size ? 'waiting' : 'running'; }
  requireProject() {
    if (!this.deps.projects) return;
    const context = this.deps.projects.context(this.chat.projectId);
    if (context.workspaceDir !== this.deps.workspaceDir) throw new Error('This project’s folder changed. Reopen the conversation to use its new location.');
  }
  /** The window to run a queued turn in: the one used most recently. */
  get host() { return [...this.hosts].at(-1) || null; }
  /** Sends to every window showing this chat (`except`: the one that already knows). */
  post(message, { except } = {}) { for (const host of this.hosts) if (host !== except) host.panel.webview.postMessage(message); }
  retitle() { for (const host of this.hosts) host.panel.title = titleFor(this.chat); }
  /** Marks `host` as the window in use (it moves to the end of the set). */
  focus(host) { this.hosts.delete(host); this.hosts.add(host); }
  /** A turn one window started: the others repaint with your message and the empty reply, then follow the stream. */
  syncWindows(origin) { for (const host of this.hosts) if (host !== origin) host.replay(); }
  save() {
    this.chat = this.deps.chatStore.save(this.chat);
    this.retitle();
  }

  /** Pushes the user message and the empty reply it streams into, then starts the agent. */
  begin({ agent, user, reply, routing, run }) {
    this.turnAgent = agent;
    this.turnModel = run.model || null; // what this turn's tokens are priced as
    let contextEstimate = null;
    if (!run.codexCommand && !reply.compact) {
      const limit = run.contextWindow || CONTEXT_LIMITS[agent] || 1000000;
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
    reply.inProgress = true;
    reply.hostPid = process.pid;
    this.activeAssistantMessage = reply;
    this.chat.messages.push(reply);
    this.chat.lastRunAt = new Date().toISOString();
    this.save();
    const isFirstUserMessage = !this.chat.title && !this.chat.customTitle &&
      this.chat.messages.filter((m) => m.role === 'user').length === 1;
    if (isFirstUserMessage && user?.text) {
      void this.autoGenerateTitle(user.text);
    }
    // The composer draws what you type itself; a scheduled prompt arrives from the queue, so the
    // window is told to draw it as your bubble, the same as if you had just sent it.
    if (user.scheduled || user.pipelineBuild || user.queued) {
      for (const host of this.hosts) host.panel.webview.postMessage({ type: 'userMessage', text: user.text, at: user.at, scheduled: Boolean(user.scheduled), files: host.webviewFiles(user.attachments) });
    }
    this.turn = { ...routing, startedAt: Date.now() };
    this.post({ type: 'routing', ...routing });
    if (contextEstimate) this.post({ type: 'usage', agent, contextTokens: contextEstimate.tokens, estimated: true });
    this.streamEngine.models = this.deps.getModels();
    this.streamEngine.permissionMode = this.deps.getPermissionMode?.() || 'fullAccess';
    this.streamEngine.turnBases = null; // set again by start(), unless the turn goes to a process that is already running
    this.streamEngine.start(run);
    // What "Undo turn" goes back to: the repos as this turn found them.
    const bases = this.streamEngine.turnBases;
    this.turnUndo = bases?.size && !reply.compact ? { bases: [...bases], startedAt: this.streamEngine.turnStartedAt } : null;
    this.deps.notifyHistory();
  }

  /** Turn end: notes on the reply which files the turn changed (nothing is kept when none), and tells the window. */
  recordUndo(reply) {
    const undo = this.turnUndo;
    this.turnUndo = null;
    if (!undo || !reply || reply.compact) return 0;
    const count = fileCount(planUndo(undo.bases, undo.startedAt));
    if (count) reply.undo = { ...undo, count };
    return count;
  }

  /**
   * /architect: one model plans, another builds. The plan turn ends here; its text goes to the editor model as the
   * next turn (queued ahead of anything you queued, drained by the turn-end below). Stop, or a turn without a plan, ends it.
   */
  continuePipeline(event, reply) {
    const pipeline = this.pipeline;
    if (!pipeline || !reply || reply.compact) return;
    this.pipeline = null;
    const plan = reply.text.trim();
    if (event.interrupted) return;
    if (!plan || /^(Claude|Gemini|Codex) error:/.test(plan)) { this.post({ type: 'notice', text: 'The architect turn ended without a plan, so nothing was built.' }); return; }
    this.post({ type: 'notice', text: `Plan ready. Handing it to ${modelOption(pipeline.editorModel)?.shortLabel || 'the editor model'}.` });
    this.queue.unshift({
      text: 'Build the plan above.',
      modelId: pipeline.editorModel,
      pipelineBuild: true,
      promptPrefix: buildInstruction(plan, pipeline.task),
      promptSuffix: pipeline.verify ? verifyInstruction(pipeline.verifyCommand) : undefined,
      attachments: [],
    });
  }

  async autoGenerateTitle(promptText) {
    try {
      const modules = await loadVoiceRouterModules();
      const generateTopicTitle = modules?.[1]?.generateTopicTitle;
      if (!generateTopicTitle) return;
      const topic = await generateTopicTitle(promptText);
      if (!topic) return;
      if (this.chat.customTitle) return;
      this.chat.title = topic;
      this.save();
      this.deps.notifyHistory();
    } catch {
      // Non-fatal: if Groq is unavailable, ChatStore falls back to deriveFallbackTitle
    }
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
    const name = String(this.chat.title || this.chat.messages?.find((entry) => entry.role === 'user')?.text || 'Clanker').replace(/\s+/g, ' ').slice(0, 60);
    const used = modelOption(this.chat.modelId)?.agent === 'claude' ? modelOption(this.chat.modelId) : defaultModel('claude');
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
    const reply = { role: 'assistant', text: '', agent: 'claude', modelLabel: label, inProgress: true, hostPid: process.pid };
    this.chat.messages.push(user, reply);
    this.activeAssistantMessage = reply;
    this.chat.lastRunAt = new Date().toISOString();
    this.save();
    const isFirstUserMessage = !this.chat.title && !this.chat.customTitle &&
      this.chat.messages.filter((m) => m.role === 'user').length === 1;
    if (isFirstUserMessage && text) {
      void this.autoGenerateTitle(text);
    }
    this.turn = { agentId: 'claude', modelLabel: label, startedAt: Date.now(), remote: true };
    this.post({ type: 'userMessage', text, at: user.at });
    this.post({ type: 'routing', agentId: 'claude', modelLabel: label });
    this.deps.notifyHistory();
  }

  /** The extension owns the queue; closing or switching a webview never stops it. */
  queueState() { return { turns: this.queue.filter((next) => next.queued), paused: this.queuePaused }; }
  queueChanged() {
    this.chat.turnQueue = this.queueState();
    this.save();
    for (const host of this.hosts) host.postTurnQueue();
    this.deps.notifyHistory();
  }
  pauseQueue(paused) {
    this.queuePaused = Boolean(paused);
    this.queueChanged();
    if (!this.queuePaused) void this.drain();
  }
  stop() {
    this.startVersion++; // Stop also cancels an Auto decision still in flight.
    // Stop is an explicit emergency stop; don't launch follow-ups behind it.
    if (this.queue.length) this.pauseQueue(true);
    this.afterCompact = null;
    this.streamEngine.interrupt();
  }
  removeQueuedTurn(id) {
    const index = this.queue.findIndex((next) => next.queued && next.id === id);
    if (index < 0) return null;
    const [turn] = this.queue.splice(index, 1);
    this.queueChanged();
    return turn;
  }
  editQueuedTurn(message) {
    const turn = this.queue.find(next => next.queued && next.id === message.turn?.id);
    if (!turn) return;
    Object.assign(turn, { text: String(message.turn.text || ''), modelId: message.turn.modelId, attachments: safeAttachmentPaths(this.deps, message.turn.attachments), editing: message.editing === true });
    this.queueChanged();
    if (!turn.editing) void this.drain();
  }
  reorderQueuedTurns(ids) {
    const turns = this.queue.filter((next) => next.queued);
    const ordered = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => turns.find((next) => next.id === id)).filter(Boolean);
    ordered.push(...turns.filter((next) => !ordered.includes(next)));
    this.queue = this.queue.map((next) => next.queued ? ordered.shift() : next);
    this.queueChanged();
  }

  async scheduleQueuedUntilReset(agent, noticeText) {
    const scheduler = this.deps.schedulerQueue;
    const turns = this.queue.filter((next) => next.queued && (!next.modelId || next.modelId === 'auto' || modelOption(next.modelId)?.agent === agent));
    if (!scheduler || !turns.length) return;
    this.queue = this.queue.filter((next) => !turns.includes(next)); // out of the queue at once, so nothing starts behind the limit
    this.queueChanged();
    const quota = (await readQuotas())?.[agent];
    const resetsAt = /weekly/i.test(noticeText) ? quota?.secondary?.resetsAt : quota?.resetsAt;
    const notBefore = typeof resetsAt === 'number' && resetsAt * 1000 > Date.now() ? new Date(resetsAt * 1000).toISOString() : undefined;
    const failed = [];
    for (const turn of turns) {
      try {
        const modelId = modelOption(turn.modelId)?.agent === agent ? turn.modelId : chatModelFor(this.chat, agent)?.id;
        await scheduler.enqueue({ model: agent, modelId, prompt: turn.text, chatId: this.chat.id, projectId: this.chat.projectId, workspaceDir: this.deps.workspaceDir, dispatchTrigger: 'quota-reset', ...(notBefore ? { notBefore } : {}) }, safeAttachmentPaths(this.deps, turn.attachments));
      } catch { failed.push(turn); }
    }
    if (failed.length) { this.queue.unshift(...failed); this.queueChanged(); } // could not be scheduled: they stay queued
    this.deps.notifySchedulerQueue?.();
    this.post({ type: 'notice', text: `${turns.length - failed.length} queued prompt${turns.length - failed.length === 1 ? '' : 's'} will send when usage resets.` });
  }

  /** FIFO: a message runs once every earlier one in this chat has finished. */
  enqueue(message) {
    if (message.queued && this.queue.some((next) => next.id === message.id)) return;
    // What you queued yourself goes before anything the scheduler sent in, whichever arrived first.
    const firstScheduled = message.scheduled ? -1 : this.queue.findIndex((next) => next.scheduled);
    if (firstScheduled >= 0) this.queue.splice(firstScheduled, 0, message); else this.queue.push(message);
    this.queueChanged();
    void this.drain();
  }

  drain() {
    if (this.turn || this.starting || this.queuePaused || !this.queue.length) return;
    const next = this.queue[0];
    if (next.editing || !next.text.trim()) return;
    return this.startTurn({ ...next, steer: true }, { queued: next })
      .then((started) => { if (started === false) setImmediate(() => this.drain()); })
      .catch((error) => {
        console.error('[ai-chat-panel] queued turn failed to start:', error);
        this.post({ type: 'notice', text: 'Could not start the queued task: ' + error.message + '. It is still in the queue.' });
      })
      .finally(() => { this.deps.chatWindowManager.release(this); this.deps.notifyHistory(); });
  }

  async startTurn(message, { origin = null, queued = null } = {}) {
    const text = String(message.text || '').trim();
    if (!text) return;
    this.requireProject();
    if (this.turn?.compact) { this.afterCompact = message; return; }
    if (message.steer === false && (this.turn || this.starting)) { this.enqueue({ ...message, text }); return; }
    const version = ++this.startVersion;
    this.planning++;
    this.starting = true;
    try {
      if (!queued) this.streamEngine.interrupt();
      const config = vscode.workspace.getConfiguration('aiChatPanel');
      if (this.deps.ensureModels) await this.deps.ensureModels();
      const pipelineModel = (key, agent) => {
        const option = modelOption(config.get(key)) || defaultModel(agent);
        if (!option) throw new Error(`No ${agent} models available. Refresh Models in Chat Settings.`);
        return option.id;
      };
      const pinned = Boolean(message.pipeline || message.pipelineBuild);
      let selected = message.modelId || this.host?.activeModelId || this.chat.modelId || 'auto';
      if (message.pipelineBuild) selected = this.chat.modelId || selected; // the builder doesn't replace your picker preference
      if (!message.modelId && message.agentId) {
        selected = message.agentId === 'auto' ? 'auto' : modelOption(selected)?.agent === message.agentId ? selected : defaultModel(message.agentId)?.id || selected;
      }
      const verifyCommand = config.get('verifyCommand', '');
      const extras = message.pipelineBuild ? { promptPrefix: message.promptPrefix, promptSuffix: message.promptSuffix }
        : message.pipeline ? { promptPrefix: ARCHITECT_PREFIX, promptSuffix: undefined }
          : { promptPrefix: undefined, promptSuffix: message.verify ? verifyInstruction(verifyCommand) : undefined };
      const modelId = message.pipeline ? pipelineModel('architectModel', 'claude') : pinned ? pipelineModel('editorModel', 'codex') : selected;
      const plan = await planTurn(this, { ...message, text, ...extras, modelId }, this.deps);
      // Pause, delete, or reorder during planning takes effect before a task starts.
      if (version !== this.startVersion || (queued && (queued.editing || this.turn || this.queuePaused || this.queue[0] !== queued))) return false;
      if (queued) { this.queue.shift(); this.queueChanged(); }
      if (plan.rerouted && !pinned) selected = defaultModel(plan.agent)?.id || selected;
      this.chat.modelId = selected;
      for (const host of this.hosts) { host.lastRoutedAgent = plan.agent; host.selectModel(selected); }
      this.post({ type: 'setActive', modelId: selected });
      this.pipeline = message.pipeline ? { task: text, editorModel: pipelineModel('editorModel', 'codex'), verify: Boolean(message.verify), verifyCommand } : null;
      this.begin(plan.begin);
      if (!message.queued) this.syncWindows(origin);
      if (message.pipeline) this.post({ type: 'notice', text: `Architect: ${modelOption(modelId).shortLabel} plans, then ${modelOption(this.pipeline.editorModel).shortLabel} builds. Stop ends it; the models are set in Settings (aiChatPanel.architectModel, aiChatPanel.editorModel).` });
      return true;
    } finally {
      this.planning--;
      this.starting = this.planning > 0;
      if (!queued && !this.turn) setImmediate(() => this.drain());
    }
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
    try { this.requireProject(); } catch (error) {
      this.post({ type: 'notice', text: error.message });
      if (!auto) this.post({ type: 'turn_complete', interrupted: true });
      return;
    }
    if (this.deps.cliAccounts?.isEnabled(agent) === false) {
      this.post({ type: 'notice', text: 'Add this CLI in Settings > Models before compacting its context.' });
      if (!auto) this.post({ type: 'turn_complete' });
      return;
    }
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
      run: { agent, prompt: native ? '' : resume ? COMPACT_DIRECTIVE : fromTranscript, resume, freshPrompt: resume && !native ? fromTranscript : null, codexCommand: native && agent === 'codex' ? 'compact' : null, model: used?.model, effort: used?.effort, compact: true, autoCompact: auto },
    });
  }

  handleStreamEvent(event) {
    // Subagents live in the agents viewer, not the reply: kept here (in memory) so a
    // window that attaches later, or switches back to this chat, can replay them.
    if (event.type.startsWith('subagent_')) {
      const stamped = { ...event, at: Date.now() };
      this.subagentLog.push(stamped);
      if (this.subagentLog.length > SUBAGENT_LOG_LIMIT) this.subagentLog.splice(0, this.subagentLog.length - SUBAGENT_LOG_LIMIT);
      this.post(stamped);
      // Once the last background agent settles (after the engine has let go of its process) the orb goes and the chat can be freed.
      if (!this.turn && event.type !== 'subagent_event') setTimeout(() => { this.deps.chatWindowManager.release(this); this.deps.notifyHistory(); }, 0);
      return;
    }
    // Replays need the turn's end too, or its foreground agents would read as working forever.
    if (event.type === 'turn_complete' && this.subagentLog.length) this.subagentLog.push({ type: 'subagent_settle', interrupted: Boolean(event.interrupted) });
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
    if (event.type === 'usage' && this.deps.routing) {
      const model = modelOption(this.chat.routingModelId);
      if (model) void this.deps.routing.prepareSummary(this.chat, model, this.chat.projectId || this.deps.workspaceDir, [this.deps.workspaceDir, this.deps.projects?.get(this.chat.projectId)?.name]).then(() => this.save());
    }
    if (event.type === 'delta' && this.activeAssistantMessage) this.activeAssistantMessage.text += event.text;
    // `offset`: how much reply text came before this tool, so a reload shows them in order.
    if (event.type === 'tool_start') this.chat.messages.push({ role: 'tool', event, offset: this.activeAssistantMessage?.text.length, done: Boolean(event.done) });
    // Results and failed steps survive reloads along with their text position.
    if (event.type === 'tool_end') recordToolEnd(this.chat, event);
    // A background chat waiting on you shows as "Needs input" in Manage Chats.
    if (event.type === 'approval_required' || event.type === 'question_required') { this.pending.set(event.actionId, event); this.deps.notifyHistory(); }
    if (event.type === 'approval_cancelled') this.pending.delete(event.actionId);
    let compacted = null;
    let autoCompact = null;
    let contextEstimate = null;
    let undoCount = 0;
    if (event.type === 'turn_complete' && this.activeAssistantMessage) {
      const reply = this.activeAssistantMessage;
      delete reply.inProgress;
      delete reply.hostPid;
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
        autoCompact = AVAILABLE_MODELS.find((entry) => entry.agent === reply.agent && entry.label === reply.modelLabel) || defaultModel(reply.agent);
      }
    }
    if (event.type === 'turn_complete') {
      // The chime every agent plays in its own UI; a Windows toast too when you're in another app.
      if (!event.interrupted && this.activeAssistantMessage) {
        const reply = this.activeAssistantMessage;
        // One chime for a run of turns: only after the last one you queued (the window's queue strip, or a message
        // waiting here), never for a scheduled prompt, which is not something you are waiting on.
        const more = this.queue.some((next) => !next.scheduled);
        const scheduled = Boolean(this.chat.messages.findLast((entry) => entry.role === 'user')?.scheduled);
        if (!reply.compact && !more) this.deps.notify?.(reply.agent, reply.text, this.chat.title || this.chat.messages.find((entry) => entry.role === 'user')?.text?.slice(0, 40), { chime: !scheduled });
        // Opt-in droid voice (docs/clanker-controller-mascot-spec.md §4): same moments as the chime, played by the window itself.
        if (!reply.compact && !more && !scheduled && vscode.workspace.getConfiguration('aiChatPanel').get('droidSounds', false)) this.post({ type: 'droid', kind: /^(Claude|Gemini|Codex) error:/.test(reply.text.trim()) ? 'warn' : 'done' });
        if (reply.agent === 'codex' && !reply.compact && this.chat.context?.estimated) {
          this.chat.context.tokens = Math.min(CONTEXT_LIMITS.codex, this.chat.context.tokens + estimateTokens(reply.text));
          contextEstimate = this.chat.context;
        }
      }
      if (this.activeAssistantMessage) this.activeAssistantMessage.at = new Date().toISOString();
      if (this.activeAssistantMessage && event.totalTokens) this.activeAssistantMessage.tokens = event.totalTokens; // P17-V
      if (this.activeAssistantMessage && event.usage) this.activeAssistantMessage.usage = event.usage;
      // API value: this turn's tokens at API prices join the chat's total, which a compaction never resets (same chat).
      const meter = this.deps.getCostMeter?.();
      if (meter && (event.costUsd || event.usage || event.totalTokens)) {
        const turnAgent = this.activeAssistantMessage?.agent || event.agent || this.turnAgent || 'claude';
        const turnModel = this.turnModel || defaultModel(turnAgent)?.model || this.chat.modelId;
        const cost = meter.turnCost({ model: turnModel, reportedUsd: event.costUsd, usage: event.usage || event.totalTokens });
        this.chat.apiCostUsd = (this.chat.apiCostUsd || 0) + (cost?.usd || 0);
        if (this.activeAssistantMessage && cost) this.activeAssistantMessage.apiCost = { usd: cost.usd, source: cost.source, model: turnModel };
        meter.record(turnAgent, cost);
        if (!cost && turnModel) void meter.refreshPrices([turnModel]); // a model the tables did not know yet
      }
      event.chatCostUsd = this.chat.apiCostUsd;
      // The model said its limit is used up: what is queued for it would only fail one after another, so it becomes scheduled
      // prompts for the reset, in the same order (and goes out one after another then, as ordinary queued ones).
      if (!event.interrupted && this.activeAssistantMessage && isLimitNotice(this.activeAssistantMessage.text)) void this.scheduleQueuedUntilReset(this.activeAssistantMessage.agent, this.activeAssistantMessage.text);
      undoCount = this.recordUndo(this.activeAssistantMessage);
      this.continuePipeline(event, this.activeAssistantMessage);
      if (event.interrupted && this.activeAssistantMessage) this.activeAssistantMessage.interrupted = true;
      this.chat.lastRunAt = new Date().toISOString();
      this.save();
      this.activeAssistantMessage = null;
      this.turn = null;
      this.pending.clear();
    }
    // Session IDs and tool boundaries must survive immediately; text and context
    // are checkpointed during the turn even when no window is showing it.
    if (event.type === 'session' || event.type === 'tool_start' || event.type === 'tool_end') this.save();
    else if (event.type === 'delta' || event.type === 'usage') this.deps.chatStore.checkpoint(this.chat);
    this.post(autoCompact ? { ...event, compacting: true } : event);
    if (undoCount) this.post({ type: 'undoOffer', count: undoCount });
    if (compacted) this.post({ type: 'usage', agent: compacted.agent, contextTokens: compacted.tokens, estimated: true });
    else if (contextEstimate) this.post({ type: 'usage', agent: contextEstimate.agent, contextTokens: contextEstimate.tokens, estimated: true });
    // An agent past 90% of its window compacts before the next turn can overflow it.
    if (autoCompact) this.compact(autoCompact.agent || 'gemini', autoCompact, { auto: true });
    if (event.type === 'turn_complete' && !autoCompact && this.afterCompact) {
      const next = this.afterCompact;
      this.afterCompact = null;
      this.queue.unshift(next);
      this.queueChanged();
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
    const launcherDeps = deps.chatWindowManager.launcherDeps;
    if (launcherDeps) {
      this.settingsPane = new LauncherViewProvider(extensionUri, launcherDeps);
      this.settingsPane.view = { webview: panel.webview };
    }

    panel.iconPath = { light: vscode.Uri.joinPath(extensionUri, 'media', 'clanker.svg'), dark: vscode.Uri.joinPath(extensionUri, 'media', 'clanker-dark.svg') };
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.file(deps.sessionDir)],
    };
    panel.webview.html = this.renderHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    panel.onDidDispose(() => {
      this.releaseQueueEdits();
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      // A running turn carries on in the background (or in the other windows showing it); Manage Chats reopens it.
      this.run.hosts.delete(this);
      this.deps.chatWindowManager.release(this.run);
    });

    void this.pushQuotas();
    void this.pushRoutingMode();
    this.postHistory();
    this.attach(run);
    panel.webview.postMessage({ type: 'editorTheme', theme: deps.getEditorTheme?.() || null });
    panel.webview.postMessage({ type: 'modelPrompts', models: AVAILABLE_MODELS.filter((option) => promptFor(launcherDeps?.cliHub?.prompts, option)).map((option) => option.id) });
    const meter = deps.getCostMeter?.();
    if (meter) panel.webview.postMessage(meter.message());
    void this.pushSchedulerQueue();
    this.pollTimer = setInterval(() => this.pushQuotas(), QUOTA_POLL_MS);
  }

  async pushRoutingMode() {
    const routing = this.deps.routing;
    if (routing) this.panel.webview.postMessage({ type: 'routingMode', ...await routing.mode() });
  }

  async handleMessage(message) {
    switch (message.type) {
      // Picking a model in the composer stays headless: it never reveals the
      // real VS Code terminal (only the Terminal button does). 'auto' is the
      // routing preference for the next `send`.
      case 'setModel': this.selectModel(message.modelId); break;
      // The composer's smart-routing switch. Every window and the settings pane follow through routing.onDidChange.
      case 'setRoutingMode': void this.deps.routing?.setMode(message.mode).catch(() => this.pushRoutingMode()); break;
      case 'requestRoutingMode': void this.pushRoutingMode(); break;
      case 'send': await this.startTurn(message); break;
      case 'stop': this.run.stop(); break;
      case 'stopChat': this.deps.chatWindowManager.runs.get(message.id)?.stop(); break;
      case 'focusTerminal': {
        if (this.deps.projects) { this.focusProjectTerminal(); break; }
        // An Opus pick opens the Opus terminal (P17-D), not the plain Claude one.
        const brand = modelOption(this.activeModelId)?.brand;
        const agentId = this.activeAgent === 'auto' ? this.lastRoutedAgent || 'claude' : this.activeAgent;
        this.deps.sessionManager.get(brand && this.deps.sessionManager.get(brand) ? brand : agentId)?.focus();
        break;
      }
      case 'approvalResponse': this.answerCard(message, (engine) => engine.respondToApproval(message.actionId, Boolean(message.approved), { always: Boolean(message.always) })); break;
      case 'questionResponse': this.answerCard(message, (engine) => engine.respondToQuestion(message.actionId, message.answers)); break;
      case 'newChat': this.resetToFreshChat(); break;
      case 'requestProject': this.postProject(); break;
      case 'chooseProject': await this.chooseProject(); break;
      case 'manageProjects': await this.manageProjects(); break;
      case 'openProjectExplorer': await this.openProjectExplorer(); break;
      case 'requestHistory': this.postHistory(); break;
      case 'restoreChat': this.restoreChat(message.id); break;
      case 'deleteChat': this.deps.chatWindowManager.deleteChat(message.id); break;
      case 'renameChat': this.deps.renameChat(message.id, message.title); break;
      case 'pickAttachments': await this.pickAttachments(message); break;
      case 'attachmentData': this.saveAttachment(message); break;
      case 'removeAttachment': this.removeAttachment(message.path); break;
      case 'renameAttachment': this.renameAttachment(message.path, message.name); break;
      case 'queueTurn': {
        const run = this.deps.chatWindowManager.runFor(message.chatId);
        const turn = message.turn;
        if (run && turn?.id && typeof turn.text === 'string' && turn.text.trim()) run.enqueue({ id: String(turn.id), text: turn.text, modelId: turn.modelId, attachments: safeAttachmentPaths(this.deps, turn.attachments), verify: Boolean(turn.verify), pipeline: Boolean(turn.pipeline), queued: true });
        break;
      }
      case 'pauseTurnQueue': this.deps.chatWindowManager.runFor(message.chatId)?.pauseQueue(message.paused); break;
      case 'removeQueuedTurn': this.deps.chatWindowManager.runFor(message.chatId)?.removeQueuedTurn(message.id); break;
      case 'editQueuedTurn': {
        const run = this.deps.chatWindowManager.runFor(message.chatId);
        const key = `${message.chatId}:${message.turn?.id}`;
        this.queueEdits ||= new Map();
        if (message.editing) this.queueEdits.set(key, { run, id: message.turn?.id }); else this.queueEdits.delete(key);
        run?.editQueuedTurn(message);
        break;
      }
      case 'saveScheduledDraft': {
        try {
          const task = (await this.deps.schedulerQueue.getQueue()).find(item => item.id === message.taskId);
          const scope = this.deps.projects && task ? this.deps.projects.context(task.projectId || this.deps.chatStore.load(task.chatId)?.projectId) : this.deps;
          await this.deps.schedulerQueue.saveDraft(message.taskId, message.turn, safeAttachmentPaths(scope, message.turn?.attachments), message.editing);
          if (!message.editing) this.scheduledEdits?.delete(message.taskId);
          this.deps.notifySchedulerQueue?.();
        } catch (error) { this.panel.webview.postMessage({ type: 'scheduleTaskFailed', error: error.message }); }
        break;
      }
      case 'reorderQueuedTurns': this.deps.chatWindowManager.runFor(message.chatId)?.reorderQueuedTurns(message.ids); break;
      case 'importTurnQueue': {
        const run = this.deps.chatWindowManager.runFor(message.chatId);
        // Import the old webview-only queue once. Old versions never persisted an intentional pause.
        if (run && !run.chat.turnQueueImported && Array.isArray(message.turns)) {
          run.chat.turnQueueImported = true;
          for (const turn of message.turns) if (turn?.id && typeof turn.text === 'string' && turn.text.trim() && !run.queue.some((next) => next.id === String(turn.id))) run.queue.push({ id: String(turn.id), text: turn.text, modelId: turn.modelId, attachments: safeAttachmentPaths(this.deps, turn.attachments), verify: Boolean(turn.verify), pipeline: Boolean(turn.pipeline), queued: true });
          run.queueChanged();
          void run.drain();
        } else if (run) this.postTurnQueue(run);
        break;
      }
      case 'steerQueuedTurn': {
        const run = this.deps.chatWindowManager.runFor(message.chatId);
        const turn = run?.removeQueuedTurn(message.id);
        if (turn) await run.startTurn({ ...turn, steer: true });
        break;
      }
      case 'openFile': await this.openFile(message.path, message.line); break;
      case 'queryFiles': await this.postWorkspaceFiles(); break;
      case 'querySlashCommands': {
        const run = this.run;
        const commands = await this.deps.slashCommands.list();
        if (this.run === run) this.panel.webview.postMessage({ type: 'slashCommands', commands });
        break;
      }
      case 'mentionUris': this.postMentions((message.uris || []).map((uri) => vscode.Uri.parse(uri))); break;
      case 'compact': this.compactSession(); break;
      case 'requestQuotas': await this.pushQuotas(); break;
      case 'micToggle': await this.handleMicToggle(); break;
      case 'micCancel': await this.handleMicCancel(); break;
      case 'voiceDraftSubmitted': await this.learnVoiceCorrections(message.original, message.edited); break;
      case 'scheduleTask': await this.scheduleTask(message); break;
      case 'scheduleMode': this.deps.setScheduleMode?.(message.mode); break; // the mode the last scheduled prompt used
      case 'remoteControl': void this.run.toggleRemote(); break;
      case 'undoTurn': void this.undoLastTurn(); break;
      case 'verifyInfo': this.panel.webview.postMessage({ type: 'verifyInfo', command: vscode.workspace.getConfiguration('aiChatPanel').get('verifyCommand', '') }); break;
      case 'setVerifyCommand': {
        const command = String(message.command || '').replace(/[`\r\n]+/g, ' ').trim().slice(0, 200);
        void vscode.workspace.getConfiguration('aiChatPanel').update('verifyCommand', command, vscode.ConfigurationTarget.Global).then(() => this.panel.webview.postMessage({ type: 'verifyInfo', command }));
        break;
      }
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
        const fork = this.deps.chatStore.save({ ...this.deps.chatStore.create(), projectId: source.projectId, forkedFrom: source.id, messages: (source.messages || []).map((entry) => ({ ...entry })) });
        this.restoreChat(fork.id);
        this.postHistory();
        break;
      }
      case 'locateBinaries': {
        refreshBinaries();
        this.deps.codexCommands.refresh();
        const results = providers.ids().map((agent) => locate(agent));
        this.deps.sessionManager.refreshCommands?.(agentList());
        this.panel.webview.postMessage({ type: 'binariesLocated', results, agent: message.agent });
        this.panel.webview.postMessage({ type: 'slashCommands', commands: await this.deps.slashCommands.list() });
        break;
      }
      // The Chat Settings popup (fleet, Telegram, tunnel, site setup, ...): the launcher's handler answers, into this window.
      default: this.settingsPane?.handleMessage(message); break;
    }
  }

  /** Answers an approval or question card; the other windows showing this chat settle theirs the way this one did (`message.settled`). */
  answerCard(message, reply) {
    if (this.run.respond(message.actionId, reply) === false || !message.settled) return;
    this.run.post({ type: 'cardSettled', actionId: message.actionId, text: String(message.settled.text || ''), tone: message.settled.tone === 'allowed' ? 'allowed' : 'denied' }, { except: this });
  }

  async scheduleTask({ task, attachments } = {}) {
    // A limit-reset "continue" belongs to this chat (the webview may not know a fresh chat's id yet).
    // A scheduled prompt belongs to the chat it was written in (it comes back there, in the queue strip) and a "continue"
    // goes in front of the others.
    task = { ...task, chatId: this.run.chat.id, projectId: this.chat.projectId, workspaceDir: this.deps.workspaceDir, modelId: task.modelId || (task.resumeHere ? chatModelFor(this.run.chat, task.model)?.id : undefined) };
    try {
      this.deps.projects?.context(this.chat.projectId);
      // "When the usage resets" waits for that moment even while there is quota left; without this a prompt scheduled with
      // 3 hours to go was sent within seconds, because the watchdog only asked whether usage was available.
      if (task?.dispatchTrigger === 'quota-reset') {
        const quota = (await readQuotas())?.[task.model];
        const resetsAt = task.resetWindow === '7d' ? quota?.secondary?.resetsAt : quota?.resetsAt; // the week's reset, or the 5-hour window's
        if (typeof resetsAt === 'number' && resetsAt * 1000 > Date.now()) task = { ...task, notBefore: new Date(resetsAt * 1000).toISOString() };
      }
      const saved = await this.deps.schedulerQueue.enqueue(task, this.safeAttachmentPaths(attachments));
      if (task.resumeHere) {
        const mine = (await this.deps.schedulerQueue.getQueue()).filter((item) => item.status === 'pending' && item.chatId === task.chatId && item.id !== saved.id);
        await this.deps.schedulerQueue.reorder([saved.id, ...mine.map((item) => item.id)]);
      }
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
    if (this.deps.projects) {
      const projectId = task.projectId || this.deps.chatStore.load(task.chatId)?.projectId;
      try { this.deps.projects.context(projectId); } catch (error) { this.panel.webview.postMessage({ type: 'notice', text: error.message }); return; }
      if (this.chat.projectId !== projectId) {
        this.panel.webview.postMessage({ type: 'chatLoading' });
        this.attach(this.deps.chatWindowManager.runFor(task.chatId, projectId) || this.deps.chatWindowManager.runFor(null, projectId));
      }
    }
    if (!sendNow) {
      await this.deps.schedulerQueue.update(taskId, item => { if (item.status === 'pending') item.editing = true; });
      this.scheduledEdits ||= new Set();
      this.scheduledEdits.add(taskId);
    }
    // Staged copies live in the scheduler's folder; the composer only accepts its own attachments dir, so copy them over first.
    const files = [];
    for (const attachment of task.attachments || []) {
      const file = path.join(this.deps.attachmentsDir, `${Date.now()}_${attachment.name}`);
      try { fs.copyFileSync(path.resolve(task.workspaceDir || this.deps.schedulerQueue.workspaceDir || this.deps.workspaceDir, attachment.absolutePath || attachment.relativePath), file); files.push(this.attachmentMetadata(file, attachment.mimeType || '')); } catch {
        if (!sendNow) {
          await this.deps.schedulerQueue.update(taskId, item => { item.editing = false; });
          this.scheduledEdits?.delete(taskId);
          this.panel.webview.postMessage({ type: 'notice', text: 'Could not open this prompt for editing because an attachment is unavailable. The original queued prompt has been kept.' });
          return;
        }
      }
    }
    if (sendNow) await this.deps.schedulerQueue.dequeue(taskId);
    this.deps.notifySchedulerQueue?.();
    this.panel.reveal(undefined, false);
    // Sent now, it keeps the provider it was scheduled for; Auto would reroute it by quota (e.g. to Gemini).
    const modelId = task.modelId || defaultModel(task.model)?.id || 'auto';
    this.panel.webview.postMessage({ type: 'restoreScheduledDraft', taskId: task.id, text: task.prompt, files, sendNow: Boolean(sendNow), modelId });
  }

  get chat() { return this.run.chat; }
  async addProject(planning = false) {
    const folders = planning ? null : await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use project folder' });
    if (!planning && !folders?.length) return null;
    const root = folders?.[0]?.fsPath || null;
    const name = await vscode.window.showInputBox({ title: 'Name your Clanker project', value: root ? path.basename(root) : 'Planning', prompt: 'This name follows the project wherever its folder lives.' });
    if (!name?.trim()) return null;
    return this.deps.projects.add(name, root);
  }
  async chooseProject() {
    const registry = this.deps.projects;
    if (!registry) return;
    try {
      const picked = await vscode.window.showQuickPick([
        ...registry.list().map(project => ({ label: project.name, description: project.root || 'Planning only', project })),
        { label: '$(add) Add project…', add: true },
        { label: '$(lightbulb) New planning project…', planning: true },
        { label: '$(gear) Manage projects…', manage: true },
      ], { title: this.chat.projectId ? 'Open a project conversation' : 'Choose the project for this chat', placeHolder: 'Conversations stay bound to their own project.' });
      if (!picked) return;
      if (picked.manage) return this.manageProjects();
      const project = picked.project || await this.addProject(Boolean(picked.planning));
      if (!project) return;
      const manager = this.deps.chatWindowManager;
      manager.selectedProjectId = project.id;
      void manager.deps.sidebarState?.update('selectedProjectId', project.id);
      this.panel.webview.postMessage({ type: 'chatLoading' });
      if (!this.chat.projectId) {
        const previous = this.run;
        const run = manager.bindProject(previous, project.id);
        for (const host of [...previous.hosts]) host.attach(run);
        if (this.run !== run) this.attach(run);
      } else if (this.chat.projectId !== project.id) {
        const recent = manager.listChats().find(chat => chat.projectId === project.id);
        this.attach(manager.runFor(recent?.id || null, project.id));
      } else this.replay();
      this.postHistory();
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  async manageProjects() {
    const registry = this.deps.projects;
    if (!registry) return;
    try {
      const picked = await vscode.window.showQuickPick([
        ...registry.list().map(project => ({ label: project.name, description: project.root || 'Planning only', project })),
        { label: '$(add) Add project…', add: true },
      ], { title: 'Manage Clanker projects' });
      if (!picked) return;
      if (picked.add) { await this.addProject(); return; }
      const project = picked.project;
      const action = await vscode.window.showQuickPick(['Rename', 'Locate / attach folder', 'Open in Explorer'], { title: project.name });
      if (action === 'Open in Explorer') return this.openProjectExplorer(project.id);
      if (action === 'Rename') {
        const name = await vscode.window.showInputBox({ title: 'Rename project', value: project.name });
        if (name?.trim()) registry.update(project.id, { name });
      } else if (action === 'Locate / attach folder') {
        const runs = [...this.deps.chatWindowManager.runs.values()].filter(run => run.chat.projectId === project.id);
        if (runs.some(run => run.turn || run.starting || run.remote || run.streamEngine.hasBackgroundAgents)) throw new Error('Finish or stop this project’s running work before changing its folder.');
        const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Locate project folder' });
        if (!folders?.length) return;
        registry.update(project.id, { root: folders[0].fsPath });
        for (const run of runs) {
          const hosts = [...run.hosts];
          run.streamEngine.dispose();
          run.chat.sessions = {}; // A native session may still be tied to the previous working directory.
          run.save();
          this.deps.chatWindowManager.runs.delete(run.chat.id);
          const replacement = this.deps.chatWindowManager.runFor(run.chat.id);
          for (const host of hosts) host.attach(replacement);
        }
      }
      for (const host of this.deps.chatWindowManager.hosts) host.postProject();
      this.deps.notifyHistory();
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  async openProjectExplorer(id = this.chat.projectId) {
    try {
    const project = this.deps.projects?.get(id);
    if (!project?.root) return vscode.window.showInformationMessage('Attach a folder using Manage projects first.');
    this.deps.projects.context(id);
    const uri = vscode.Uri.file(project.root);
    if (!vscode.workspace.workspaceFolders?.some(folder => path.resolve(folder.uri.fsPath).toLowerCase() === project.root.toLowerCase())) {
      const manager = this.deps.chatWindowManager;
      const active = [...(manager?.runs.values() || [])].filter(run => run.state || run.starting || run.remote || run.planning);
      const count = active.length + (this.deps.watchdog?.activeTaskId ? 1 : 0);
      if (count) {
        const choice = await vscode.window.showWarningMessage(
          `${count} active chat${count === 1 ? '' : 's'} running in the background.`,
          { modal: true, detail: 'Adding this project to Explorer may restart VS Code’s extension host and interrupt running chats. Open a new window to keep them working here, or switch anyway. Saved responses and queued messages will be kept.' },
          'Open in New Window', 'Switch Anyway', { title: 'Cancel', isCloseAffordance: true });
        if (choice === 'Open in New Window') {
          await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
          return;
        }
        if (choice !== 'Switch Anyway') return;
      }
      // Persist while the host still exists; a restart need not call dispose().
      for (const run of manager?.runs.values() || []) run.save();
      if (this.deps.watchdog?.chat) this.deps.chatStore.save(this.deps.watchdog.chat);
      const added = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri, name: project.name });
      if (!added) throw new Error('VS Code could not add this folder. Use File > Add Folder to Workspace.');
    }
    await vscode.commands.executeCommand('workbench.view.explorer');
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  postProject() {
    if (!this.deps.projects) return;
    const project = this.deps.projects.get(this.chat.projectId);
    this.panel.webview.postMessage({ type: 'project', project, required: !project });
  }
  focusProjectTerminal() {
    try {
      const { project, workspaceDir } = this.deps.projects.context(this.chat.projectId);
      const agent = this.activeAgent === 'auto' ? this.lastRoutedAgent || 'claude' : this.activeAgent;
      const binary = locate(agent).path;
      if (!binary) throw new Error('Add this CLI in Settings before opening its terminal.');
      const shim = /\.cmd$/i.test(binary) ? resolveShim(binary) : null;
      vscode.window.createTerminal({ name: `${project.name} · ${agent}`, cwd: workspaceDir, shellPath: shim?.command || binary, shellArgs: shim?.args || [] }).show(true);
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  releaseQueueEdits() {
    for (const { run, id } of this.queueEdits?.values() || []) {
      const turn = run?.queue.find(item => item.id === id);
      if (turn) { turn.editing = false; run.queueChanged(); void run.drain(); }
    }
    this.queueEdits?.clear();
    for (const id of this.scheduledEdits || []) void this.deps.schedulerQueue.update(id, task => { task.editing = false; });
    this.scheduledEdits?.clear();
  }

  /** Shows `run` in this window. The run shown before keeps going in the background (or in the other windows showing it);
   * a turn in progress comes back with its partial reply and any card still waiting on you. */
  attach(run) {
    const previous = this.run;
    this.deps = { ...this.deps, ...run.deps };
    previous?.hosts.delete(this);
    run.focus(this);
    this.run = run;
    this.deps.chatWindowManager.rebind(previous?.chat.id, run.chat.id, this);
    if (previous) this.deps.chatWindowManager.release(previous);
    this.replay();
  }

  /** Paints this window with the run it shows: the saved thread, the turn in progress with its partial reply, any card waiting on you. */
  replay() {
    const run = this.run;
    this.panel.title = titleFor(run.chat);
    // The picker follows the chat: the model it last ran on (older chats: the last reply's model label).
    const lastReply = [...run.chat.messages].reverse().find((entry) => entry.role === 'assistant' && entry.modelLabel);
    const modelId = run.chat.modelId || AVAILABLE_MODELS.find((option) => option.label === lastReply?.modelLabel)?.id;
    if (modelId && modelId !== this.activeModelId && (modelId === 'auto' || modelOption(modelId))) {
      this.selectModel(modelId);
      this.panel.webview.postMessage({ type: 'setActive', modelId });
    }
    this.panel.webview.postMessage({ type: 'chatLoaded', chat: this.webviewChat(run.chat), running: run.turn });
    this.postProject();
    this.postTurnQueue();
    void run.drain();
    for (const event of run.pending.values()) this.panel.webview.postMessage(event);
    if (run.subagentLog.length) this.panel.webview.postMessage({ type: 'subagentReplay', events: run.subagentLog });
  }

  resetToFreshChat() {
    this.attach(this.deps.chatWindowManager.runFor(null, this.chat.projectId));
    this.postHistory();
  }

  /** Switches this window's thread. A thread another window shows too is simply shown here as well: both follow the same run. */
  restoreChat(id) {
    // Tell the window first, so it paints a skeleton while the chat loads from disk and is sent over.
    const switching = id !== this.chat.id;
    if (switching) this.panel.webview.postMessage({ type: 'chatLoading' });
    const run = this.deps.chatWindowManager.runFor(id);
    if (run && run !== this.run) this.attach(run);
    else if (switching) this.panel.webview.postMessage({ type: 'chatLoaded', chat: this.webviewChat(this.chat), running: this.run.turn }); // chat gone: put the current one back
  }

  /** Revert on the Nth user message: a fork holding everything before it opens
   * here, and that message goes back into the composer. The original chat stays in history. */
  revertToMessage(index) {
    const at = this.chat.messages.reduce((found, entry, i) => (entry.role === 'user' ? [...found, i] : found), [])[index];
    if (at === undefined) return;
    const text = this.chat.messages[at].text || '';
    const fork = this.deps.chatStore.save({ ...this.deps.chatStore.create(), projectId: this.chat.projectId, forkedFrom: this.chat.id, messages: this.chat.messages.slice(0, at).map((entry) => ({ ...entry })) });
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
    const name = String(this.chat.title || this.chat.messages?.find((entry) => entry.role === 'user')?.text || 'Clanker').replace(/\s+/g, ' ').slice(0, 40);
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
    try {
      const run = message.chatId ? this.deps.chatWindowManager.runFor(message.chatId) : this.run;
      if (!run) throw new Error('The conversation is no longer available. Open a new project chat.');
      return await run.startTurn(message, { origin: this.run === run ? this : null });
    }
    catch (error) {
      this.panel.webview.postMessage({ type: 'notice', text: error.message });
      this.panel.webview.postMessage({ type: 'turn_complete' });
    }
  }

  /** /undo and the reply's Undo button: the last turn's file changes go back to how the turn found them (after you confirm). */
  async undoLastTurn() {
    const run = this.run;
    const post = (message) => run.post(message);
    const notice = (text) => post({ type: 'notice', text });
    if (run.turn) return notice('Undo waits until the running turn is done.');
    const messages = run.chat.messages;
    const at = messages.findLastIndex((entry) => entry.role === 'assistant' && !entry.compact);
    const last = messages[at];
    if (!last?.undo || last.undone || messages.slice(at).some((entry) => entry.role === 'user' && !entry.compact)) return notice('Nothing to undo: the last turn changed no files.');
    const plans = planUndo(last.undo.bases, last.undo.startedAt);
    const count = fileCount(plans);
    if (!count) {
      post({ type: 'undoOffer', count: 0 });
      return notice(plans.some((plan) => plan.missing) ? 'Git no longer has the snapshot from before that turn, so it can\'t be undone.' : 'Those files already match how they were before the turn.');
    }
    const files = fileList(plans, this.deps.workspaceDir);
    const shown = files.slice(0, 12).join('\n') + (files.length > 12 ? `\n… and ${files.length - 12} more` : '');
    const answer = await vscode.window.showWarningMessage(`Undo the last turn? ${count} file${count === 1 ? '' : 's'} go back to how they were before it.`, { modal: true, detail: `${shown}\n\nEdits of your own in these files since the turn started are undone too.` }, 'Undo turn');
    if (answer !== 'Undo turn') return;
    const done = applyUndo(plans);
    last.undone = true;
    run.save();
    post({ type: 'undoOffer', count: 0 });
    notice(`Undid the last turn: ${done.restored} restored, ${done.removed} removed${done.failed.length ? `, ${done.failed.length} could not be changed (${done.failed.slice(0, 3).join(', ')})` : ''}.`);
  }

  /** The Compact button: compacts whichever agent's context the gauge shows (see ChatRun.compact). */
  compactSession() {
    const option = modelOption(this.activeModelId);
    const agent = this.chat.context?.agent || this.lastRoutedAgent || (option?.agent !== 'auto' ? option?.agent : null);
    if (!agent) return;
    this.run.compact(agent, option?.agent === agent ? option : defaultModel(agent));
  }

  postHistory() { this.panel.webview.postMessage({ type: 'history', sessions: this.deps.chatWindowManager.listChats() }); }
  async pushSchedulerQueue() { if (this.deps.schedulerQueue) this.panel.webview.postMessage({ type: 'schedulerQueue', queue: await this.deps.schedulerQueue.getQueue() }); }
  safeAttachmentPaths(paths) { return safeAttachmentPaths(this.deps, paths); }
  attachmentMetadata(file, mime = '') { const stat = fs.statSync(file); return { path: file, name: path.basename(file), size: stat.size, mime, uri: this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString() }; }
  webviewFiles(paths) { return this.safeAttachmentPaths(paths).map((file) => this.attachmentMetadata(file, /\.(png|jpe?g|gif|webp|bmp)$/i.test(file) ? 'image/*' : '')); }
  postTurnQueue(run = this.run) {
    const state = run.queueState();
    this.panel.webview.postMessage({ type: 'turnQueue', chatId: run.chat.id, paused: state.paused, turns: state.turns.map((turn) => ({ ...turn, files: this.webviewFiles(turn.attachments) })) });
  }
  /** P17-Q: the @-mention list. The webview filters it locally, so one query per composer session. */
  async postWorkspaceFiles() {
    const root = this.deps.workspaceDir;
    const chatId = this.chat.id;
    let files;
    if (this.deps.projects) {
      try { this.run.requireProject(); files = await projectFiles(root); }
      catch (error) { this.panel.webview.postMessage({ type: 'notice', text: error.message }); files = []; }
    } else {
      const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,.astro,.next,out,build,coverage}/**', 5000);
      files = uris.map(uri => path.relative(root, uri.fsPath).split(path.sep).join('/')).filter(file => !file.startsWith('..')).sort();
    }
    if (this.chat.id !== chatId) return;
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
    const apiCostUsd = chat.apiCostUsd || chatCost(chat, this.deps.getCostMeter?.()?.live?.prices);
    return { ...chat, ...(apiCostUsd > 0 ? { apiCostUsd } : {}), messages: (chat.messages || []).map((m) => {
      const { compactContext, compactPreviousContext, ...visible } = m;
      if (visible.role === 'assistant' && visible.compact) visible.text = '';
      return visible.role === 'user' && visible.attachments?.length ? { ...visible, files: this.webviewFiles(visible.attachments) } : visible;
    }) };
  }
  saveAttachment({ name, mime, data, chatId } = {}) {
    if (typeof data !== 'string' || data.length > 28 * 1024 * 1024) return;
    const run = chatId ? this.deps.chatWindowManager.runFor(chatId) : this.run;
    if (!run) return;
    const filename = path.basename(String(name || 'attachment.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(run.deps.attachmentsDir, `${Date.now()}_${filename}`);
    try {
      fs.writeFileSync(file, Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64'));
      this.panel.webview.postMessage({ type: 'attachmentSaved', chatId: run.chat.id, attachment: this.attachmentMetadata(file, mime) });
    } catch (error) { vscode.window.showErrorMessage(`Clanker Controller:could not save attachment (${error.message}).`); }
  }
  async pickAttachments({ chatId } = {}) {
    const run = chatId ? this.deps.chatWindowManager.runFor(chatId) : this.run;
    if (!run) return;
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'svg'], Documents: ['md', 'json', 'ts', 'js', 'txt'] } });
    for (const uri of files || []) {
      const filename = path.basename(uri.fsPath).replace(/[^a-zA-Z0-9._-]/g, '_');
      const target = path.join(run.deps.attachmentsDir, `${Date.now()}_${filename}`);
      fs.copyFileSync(uri.fsPath, target);
      this.panel.webview.postMessage({ type: 'attachmentSaved', chatId: run.chat.id, attachment: this.attachmentMetadata(target) });
    }
  }
  /** A name the user gave an attached image: the file keeps its timestamp prefix (so names never collide) and its extension. */
  renameAttachment(file, name) {
    const [safe] = this.safeAttachmentPaths([file]);
    if (!safe) return;
    const ext = path.extname(safe);
    const stamp = /^\d{10,}_/.exec(path.basename(safe))?.[0] || `${Date.now()}_`;
    const base = String(name || '').replace(ext, '').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'image';
    let target = path.join(path.dirname(safe), `${stamp}${base}${ext}`);
    for (let n = 2; fs.existsSync(target) && target !== safe; n++) target = path.join(path.dirname(safe), `${stamp}${base} ${n}${ext}`);
    try { if (target !== safe) fs.renameSync(safe, target); } catch { return; }
    this.panel.webview.postMessage({ type: 'attachmentRenamed', from: file, attachment: this.attachmentMetadata(target, /\.(png|jpe?g|gif|webp|bmp)$/i.test(target) ? 'image/*' : '') });
  }
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

  /** P17-ZA: spellings the user fixed in a dictated draft go into the voice dictionary. */
  async learnVoiceCorrections(original, edited) {
    const terms = learnedTerms(original, edited);
    if (!terms.length) return;
    for (const term of terms) { try { voiceDictionary.addTerm(voicePaths(), term); } catch { /* too long or unwritable: skip */ } }
    this.panel.webview.postMessage({ type: 'voiceTermsLearned', terms });
  }

  /** Esc while listening: stop the capture and throw the recording away, no transcription. */
  async handleMicCancel() {
    const capture = this.deps.voiceCapture;
    if (!capture.isRecording()) return;
    capture.onVolume = null;
    this.panel.webview.postMessage({ type: 'micState', state: 'idle' });
    try { fs.promises.unlink(await capture.stop()).catch(() => {}); } catch { /* nothing to discard */ }
  }

  /** `hold`: started by the hold-to-talk hotkey, so it ends when the keys are released, not on a pause in speech. */
  async handleMicToggle({ hold = false } = {}) {
    const capture = this.deps.voiceCapture;
    const cue = vscode.workspace.getConfiguration('aiChatPanel').get('voiceSounds', true); // the window plays a short tone when recording starts and when it ends
    if (capture.starting) return; // double click while ffmpeg is still opening the device
    if (!capture.isRecording()) {
      this.panel.webview.postMessage({ type: 'micState', state: 'starting' });
      // P17-ZA: live levels go to the window that is recording (the capture is shared across windows).
      capture.onVolume = ({ rms, peak, level }) => this.panel.webview.postMessage({ type: 'micVolume', rms, peak, level });
      try {
        capture.owner = this; // the window the hotkey ends this recording in
        await capture.start();
      } catch (error) {
        capture.onVolume = null;
        this.voiceError(error);
        return;
      }
      this.panel.webview.postMessage({ type: 'micState', state: 'recording', device: capture.device, hold, cue });
      return;
    }

    capture.onVolume = null;
    this.panel.webview.postMessage({ type: 'micState', state: 'processing', cue });
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
    const modelId = agentId === 'auto' ? 'auto' : current?.agent === agentId ? current.id : defaultModel(agentId)?.id;
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
    const mascotUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'clanker-mascot.js'));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'agent-icons.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const settingsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'settings.css'));
    const settingsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'settings.js'));
    const timerStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'schedule-timer.css'));
    const bubbleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'bubble-shape.js'));
    const chatTimeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat-time.js'));
    const burnRateUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'burn-rate.js'));
    const apiValueUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'api-value.js'));
    const voiceHotkeyUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'voice-hotkey.js'));
    const limitNoticeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'limit-notice.js'));
    const modelPromptsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'model-prompts.js'));
    const timerUri =webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'schedule-timer.js'));
    const katexUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'katex', 'katex.min.js'));
    const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'katex', 'katex.min.css'));
    const shikiUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'shiki', 'shiki.bundle.js'));
    const nonce = getNonce();
    // Only the chat in the secondary sidebar carries the launcher rail (recent chats, usage, buttons) down its right edge.
    const rail = Boolean(this.panel.sidebar);
    const railStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.css'));
    const railScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.js'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:;">
<link rel="stylesheet" href="${katexCssUri}">
<link rel="stylesheet" href="${styleUri}">
<link rel="stylesheet" href="${settingsStyleUri}">
<link rel="stylesheet" href="${timerStyleUri}">
<style>${providers.accentCss()}</style>
${rail ? `<link rel="stylesheet" href="${railStyleUri}">` : ''}
<title>Clanker Controller</title>
</head>
<body${rail ? ' class="has-rail"' : ''}>
${rail ? railMarkup(CHAT_BUTTONS) : `<div class="topbar"><div class="topbar-actions">${CHAT_BUTTONS.queue}${CHAT_BUTTONS.history}${CHAT_BUTTONS.newChat}</div></div>`}

  <div class="transcript" id="transcript" aria-live="polite">
    <div class="empty-state"></div><!-- drawn by main.js (emptyState), the same for a fresh chat and a loaded empty one -->
  </div>

  <div class="compose-row">
    <div class="composer glass">
      <textarea id="promptInput" rows="1" placeholder="Ask anything, @ to mention, / for actions"></textarea>
      <div class="composer-actions">
        <button class="agents-chip" id="agentsBtn" type="button" hidden aria-haspopup="dialog">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5V2.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="2.25" r="0.9" fill="currentColor"/><circle cx="6.1" cy="8.75" r="1" fill="currentColor"/><circle cx="9.9" cy="8.75" r="1" fill="currentColor"/><path d="M1.75 8.25v2M14.25 8.25v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          <span class="agents-chip-count">0</span>
        </button>
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

  <script nonce="${nonce}">window.CLANKER_MARK = ${JSON.stringify(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'clanker-dark.svg')).toString())}; window.MODEL_CATALOG = ${JSON.stringify(MODEL_CATALOG)}; window.AVAILABLE_MODELS = ${JSON.stringify(AVAILABLE_MODELS.filter((entry) => this.deps.cliAccounts?.isEnabled(entry.agent) !== false))}; window.TIME_PREFS = ${timePrefs()}; window.SCHEDULE_MODE = ${JSON.stringify(this.deps.getScheduleMode?.() || 'reset')}; window.VOICE_SILENCE_MS = ${Math.max(0, Number(vscode.workspace.getConfiguration('aiChatPanel').get('voiceAutoStopSeconds', 2)) || 0) * 1000};</script>
  <script nonce="${nonce}">window.PROVIDERS = ${JSON.stringify(providers.displayList()).replace(/</g, '\\u003c')};</script>
  <script nonce="${nonce}" src="${iconsUri}"></script>
  <script nonce="${nonce}" src="${katexUri}"></script>
  <script nonce="${nonce}" src="${modelPromptsUri}"></script>
  <script nonce="${nonce}" src="${voiceHotkeyUri}"></script>
  <script nonce="${nonce}" src="${settingsUri}"></script>
  <script nonce="${nonce}" src="${timerUri}"></script>
  ${rail ? `<script nonce="${nonce}">{ const api = acquireVsCodeApi(); window.acquireVsCodeApi = () => api; } /* a webview may acquire the API once; the chat and the rail share it */</script>` : ''}
  <script nonce="${nonce}" src="${chatTimeUri}"></script>
  <script nonce="${nonce}" src="${burnRateUri}"></script>
  <script nonce="${nonce}" src="${apiValueUri}"></script>
  <script nonce="${nonce}" src="${limitNoticeUri}"></script>
  <script nonce="${nonce}" src="${bubbleUri}"></script>
  <script nonce="${nonce}" src="${mascotUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  ${rail ? `<script nonce="${nonce}" src="${railScriptUri}"></script>` : ''}
  <script nonce="${nonce}" src="${shikiUri}" defer></script>
</body>
</html>`;
  }
}

/** Tracks every currently-open floating chat window, keyed by ChatStore id,
 * and every ChatRun that is on screen or still has a turn going. */
const SIDEBAR_CHAT_KEY = 'aiChatPanel.sidebarChatId';

/** Gives a sidebar WebviewView the few WebviewPanel members a ChatWindowHost uses, so a chat can live in the secondary sidebar. */
function viewAsPanel(view) {
  const panel = {
    sidebar: true,
    webview: view.webview,
    get title() { return view.title || ''; },
    set title(value) { view.title = value; },
    set iconPath(_) { /* a view takes its icon from its container */ },
    get active() { return view.visible; },
    reveal: (_column, preserveFocus) => view.show(preserveFocus),
    onDidDispose: (listener) => view.onDidDispose(listener),
    onDidChangeViewState: (listener) => view.onDidChangeVisibility(() => listener({ webviewPanel: panel })),
    dispose() { /* the sidebar owns the view */ },
  };
  return panel;
}

class ChatWindowManager {
  constructor(extensionUri, deps) {
    this.extensionUri = extensionUri;
    this.deps = deps;
    this.sidebar = null; // the ChatWindowHost in the secondary sidebar, while that view exists
    this.hosts = new Set(); // every open chat window, the sidebar's included; several may show the same chat (they share its run)
    this.runs = new Map(); // chatId -> ChatRun
    this.activeHost = null; // the window used last
    this.recentSelections = new Map(); // sidebar chats left in the last five minutes
  }

  /** The window already showing `chatId`, if any (an editor tab before the sidebar). */
  hostFor(chatId) {
    return [...this.hosts].reverse().find((host) => host.chat.id === chatId) || null;
  }

  /** The live run for `chatId` (it may be streaming in the background), else one loaded from disk. Null id: a fresh chat. */
  runFor(chatId, projectId = this.selectedProjectId ?? this.deps.defaultProjectId) {
    if (chatId && this.runs.has(chatId)) {
      const cached = this.runs.get(chatId);
      const context = this.deps.projects?.context(cached.chat.projectId, { allowMissing: true });
      if (!context || context.workspaceDir === cached.deps.workspaceDir || cached.state || cached.starting || cached.remote) return cached;
      const hosts = [...cached.hosts];
      cached.streamEngine.dispose(); cached.chat.sessions = {}; cached.save(); this.runs.delete(chatId);
      const replacement = this.runFor(chatId);
      for (const host of hosts) host.attach(replacement);
      return replacement;
    }
    const chat = chatId ? this.deps.chatStore.load(chatId) : this.deps.chatStore.create();
    if (!chat) return null;
    if (ownedByAnotherHost(chat)) {
      void vscode.window.showInformationMessage('This chat is running in another IDE window. Continue it there, or open a new chat here.');
      return null;
    }
    let scoped = {};
    if (this.deps.projects) {
      if (!chatId) { chat.projectId = projectId || null; this.deps.chatStore.save(chat); }
      scoped = this.projectDeps(chat.projectId);
      if (chat.projectRoot !== scoped.workspaceDir) {
        chat.sessions = {};
        chat.projectRoot = scoped.workspaceDir;
        this.deps.chatStore.save(chat);
      }
    }
    const run = new ChatRun(chat, { ...this.deps, ...scoped, chatWindowManager: this });
    this.runs.set(chat.id, run);
    return run;
  }
  projectDeps(id) {
    const context = this.deps.projects.context(id, { allowMissing: true });
    const config = () => vscode.workspace.getConfiguration('aiChatPanel', vscode.Uri.file(context.workspaceDir));
    return { ...context,
      getModels: () => { const models = config().get('models', {}); return Object.fromEntries(providers.ids().map(agent => [agent, models[agent] || defaultModel(agent)?.model])); },
      getPermissionMode: () => config().get('permissionMode', 'fullAccess'),
      slashCommands: new SlashCommandCatalog({ codexCommands: this.deps.codexCommands, workspaceDir: context.workspaceDir, cacheFile: path.join(context.sessionDir, 'slash-commands.json') }),
    };
  }
  bindProject(run, projectId) {
    if (run.chat.projectId) throw new Error('An existing conversation cannot be moved between projects. Open a new chat instead.');
    const context = this.deps.projects.context(projectId);
    const copies = new Map();
    const copyFiles = files => (files || []).map(file => {
      if (copies.has(file)) return copies.get(file);
      if (!fs.existsSync(file)) return file;
      const target = path.join(context.attachmentsDir, `${crypto.randomUUID()}_${path.basename(file)}`);
      fs.copyFileSync(file, target); copies.set(file, target); return target;
    });
    for (const message of run.chat.messages) if (message.attachments) message.attachments = copyFiles(message.attachments);
    for (const turn of run.queue) turn.attachments = copyFiles(turn.attachments);
    run.chat.projectId = projectId;
    run.chat.projectRoot = context.workspaceDir;
    run.chat.sessions = {};
    run.chat.turnQueue = run.queueState();
    run.save(); run.streamEngine.dispose(); this.runs.delete(run.chat.id);
    return this.runFor(run.chat.id);
  }

  /** Forgets a run nobody is watching and that has nothing left to do. */
  release(run) {
    // A chat under Remote Control stays alive with no window: the phone is still driving it.
    // Nor is one whose background agents are still working: disposing the engine would kill them mid-task.
    if (!run.host && !run.turn && !run.starting && !run.queue.length && !run.remote && !run.streamEngine.hasBackgroundAgents && this.runs.get(run.chat.id) === run) {
      run.streamEngine.dispose();
      this.runs.delete(run.chat.id);
      const scheduled = this.deps.schedulerQueue?.tasks.some(task => task.chatId === run.chat.id && !['done', 'cancelled'].includes(task.status));
      if (!run.chat.messages.length && !scheduled) {
        this.deps.chatStore.delete(run.chat.id);
        this.recentSelections.delete(run.chat.id);
        this.notifyOpenChanged();
      }
    }
  }

  /** Remove empty history left by older versions, after loading scheduled prompts from disk. */
  async pruneEmptyChats() {
    const tasks = await this.deps.schedulerQueue?.getQueue() || [];
    const keep = new Set([
      ...this.runs.keys(),
      this.sidebar?.chat.id || this.deps.sidebarState?.get(SIDEBAR_CHAT_KEY),
      ...tasks.filter(task => !['done', 'cancelled'].includes(task.status)).map(task => task.chatId),
    ]);
    let removed = false;
    for (const session of this.deps.chatStore.list()) {
      if (!session.empty || keep.has(session.id)) continue;
      this.deps.chatStore.delete(session.id);
      this.recentSelections.delete(session.id);
      removed = true;
    }
    if (removed) this.notifyOpenChanged();
  }

  /** History for Manage Chats: conversations and the active empty chat, flagged with recent agent activity. */
  listChats() {
    const live = new Map([...this.runs.values()].filter((run) => run.state).map((run) => [run.chat.id, run.state]));
    const now = Date.now();
    for (const [id, leftAt] of this.recentSelections) if (now - leftAt >= ACTIVE_WINDOW_MS) this.recentSelections.delete(id);
    const selectedId = this.sidebar?.chat.id;
    const activeId = selectedId || this.activeHost?.chat.id;
    const openIds = new Set([...this.hosts].map((host) => host.chat.id));
    const scheduledIds = new Set((this.deps.schedulerQueue?.tasks || []).filter(task => !['done', 'cancelled'].includes(task.status)).map(task => task.chatId));
    // Keep `open` for existing consumers; the rail uses the sidebar's single `selected` chat.
    const sessions = this.deps.chatStore.list().filter(session => !session.empty || session.id === activeId || this.runs.get(session.id)?.starting || live.has(session.id) || scheduledIds.has(session.id));
    return markActive(sessions, live, now).map((session) => ({
      ...session,
      projectName: this.deps.projects?.get(session.projectId)?.name || (this.deps.projects ? 'Choose project' : null),
      open: openIds.has(session.id),
      selected: session.id === selectedId,
      recentUntil: this.recentSelections.has(session.id) ? this.recentSelections.get(session.id) + ACTIVE_WINDOW_MS : null,
    }));
  }

  /** A chat still running with no window on it stops too; one open in a window keeps its thread in memory. */
  deleteChat(id) {
    const run = this.runs.get(id);
    if (run && !run.host) { run.streamEngine.dispose(); this.runs.delete(id); }
    this.deps.chatStore.delete(id);
    this.recentSelections.delete(id);
    this.deps.notifyHistory();
  }

  /**
   * The chat in the secondary sidebar (aiChatPanel.chatView): the default home for chats, so they
   * sit beside the code instead of in an editor tab. It shows one chat at a time, remembered per
   * workspace; extra chats still open as editor windows (`detached`).
   */
  attachSidebar(view) {
    const panel = viewAsPanel(view);
    const run = this.runFor(this.deps.sidebarState.get(SIDEBAR_CHAT_KEY)) || this.runFor(null);
    this.sidebar = this.wire(panel, run);
    view.onDidDispose(() => { if (this.sidebar?.panel === panel) this.sidebar = null; });
  }

  /**
   * Opens (or reveals, if already open) the chat window for `chatId`. Omit chatId to start a fresh thread.
   * `detached` opens an editor tab even with the sidebar chat there: the sidebar's "open in editor" button, for
   * working on several chats at once. The tab is the same window as the sidebar chat minus its launcher rail.
   */
  open(chatId, { viewColumn = vscode.ViewColumn.Beside, preserveFocus = false, detached = false, projectId = this.activeHost ? this.activeHost.chat.projectId : this.selectedProjectId || this.deps.defaultProjectId } = {}) {
    const existing = chatId && this.hostFor(chatId);
    if (existing) {
      existing.panel.reveal(viewColumn, preserveFocus);
      return existing;
    }
    if (this.sidebar && !detached) {
      if (chatId) this.sidebar.restoreChat(chatId); else this.sidebar.attach(this.runFor(null, projectId));
      this.sidebar.panel.reveal(undefined, preserveFocus);
      return this.sidebar;
    }

    const run = this.runFor(chatId, projectId) || this.runFor(null, projectId);
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
      if (!event.webviewPanel.active) return;
      this.activeHost = host;
      host.run.focus(host);
    });
    panel.onDidDispose(() => {
      this.hosts.delete(host);
      if (this.activeHost === host) this.activeHost = null;
      this.notifyOpenChanged();
    });
    return host;
  }

  /** Called by a ChatWindowHost when its own thread id changes (new chat / restore chat), and as it starts. */
  rebind(oldChatId, newChatId, host) {
    if (host.panel.sidebar && oldChatId && oldChatId !== newChatId) this.recentSelections.set(oldChatId, Date.now());
    this.hosts.add(host);
    this.activeHost = host;
    if (host.chat.projectId) {
      this.selectedProjectId = host.chat.projectId;
      void this.deps.sidebarState?.update('selectedProjectId', host.chat.projectId);
    }
    if (host.panel.sidebar) void this.deps.sidebarState.update(SIDEBAR_CHAT_KEY, newChatId);
    this.notifyOpenChanged();
  }

  /** Which chat is open changed: refresh the rail's highlight, after the switch itself has been sent (listing re-reads every chat file). */
  notifyOpenChanged() {
    clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => { try { this.deps.notifyHistory(); } catch { /* a window closed under us */ } }, 0);
    this.openTimer.unref?.();
  }

  /**
   * aiChatPanel.routePrompt (part of the AI bridge, docs/ai-bridge-interface.md): Auto picks
   * the agent, and the message joins that agent's one "Routed prompts" chat -- same thread and
   * context for every prompt it gets, queued behind the ones still running. The chats run
   * without a window and show under Active Chats in Manage Chats.
   */
  async routePrompt(prompt, { newChat = false, targetModel = 'auto', attachments = [], projectId = this.activeHost ? this.activeHost.chat.projectId : this.selectedProjectId || this.deps.defaultProjectId } = {}) {
    const text = String(prompt || '').trim();
    if (!text) return false;
    this.deps.projects?.context(projectId);
    if (this.deps.ensureModels) await this.deps.ensureModels();
    // The editor supplies project-relative snapshots; copy originals into this project's attachment store.
    const projectContext = this.deps.projects ? this.projectDeps(projectId) : this.deps;
    attachments = (Array.isArray(attachments) ? attachments : []).filter(f => typeof f === 'string').map(f => {
      const source = path.resolve(projectContext.workspaceDir, f);
      const projectRoot = path.resolve(projectContext.workspaceDir) + path.sep;
      const attachmentRoot = path.resolve(projectContext.attachmentsDir) + path.sep;
      if (!source.startsWith(projectRoot) && !source.startsWith(attachmentRoot)) return null;
      if (!/\.(png|jpe?g|webp)$/i.test(source) || !fs.existsSync(source) || fs.statSync(source).size > 20000000) return null;
      fs.mkdirSync(projectContext.attachmentsDir, { recursive: true });
      const destination = path.join(projectContext.attachmentsDir, `${crypto.randomUUID()}${path.extname(source)}`);
      fs.copyFileSync(source, destination); return destination;
    }).filter(Boolean);
    const selected = targetModel === 'auto' ? null : MODEL_CATALOG.find(model => model.id === targetModel);
    if (targetModel !== 'auto' && !selected) throw new Error('This favorite model is no longer available. Choose another model in Visor.');
    if (newChat) {
      const chat = this.deps.chatStore.save({ ...this.deps.chatStore.create(), projectId, title: `Visor · ${text.replace(/\s+/g, ' ').slice(0, 60)}`, modelId: targetModel });
      const run = this.runFor(chat.id);
      run.enqueue({ text, modelId: targetModel, attachments, newChat });
      this.open(chat.id, { preserveFocus: true });
      this.deps.notifyHistory();
      return true;
    }
    const routingDeps = this.deps.projects ? { ...this.deps, ...this.projectDeps(projectId) } : this.deps;
    const { agent, modelId } = this.deps.routing ? { agent: 'routing', modelId: targetModel } : selected ? { agent: selected.agent, modelId: selected.id } : await routeBest(text, await readQuotas(), this.deps.cliAccounts?.enabledAgents(),
      this.deps.chooseAutoModel || ((task, models, quotas) => chooseAutoModel(task, models, quotas, routingDeps)));
    const lanesFile = path.join(this.deps.sessionDir, 'routed-chats.json');
    let lanes = {};
    try { lanes = JSON.parse(fs.readFileSync(lanesFile, 'utf8')) || {}; } catch { /* first use */ }
    const lane = this.deps.projects ? `${projectId}:${agent}` : agent;
    let run = lanes[lane] ? this.runFor(lanes[lane]) : null;
    if (!run) {
      const name = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[agent] || agent;
      run = this.runFor(this.deps.chatStore.save({ ...this.deps.chatStore.create(), projectId, title: `Routed prompts · ${name}` }).id);
      lanes[lane] = run.chat.id;
      fs.mkdirSync(path.dirname(lanesFile), { recursive: true });
      fs.writeFileSync(lanesFile, JSON.stringify(lanes, null, 2));
    }
    // Locked to the agent Auto chose, so a lane never hands its own turns to another agent.
    run.enqueue({ text, modelId, attachments });
    this.deps.notifyHistory();
    return true;
  }

  /** A scheduled task bound to a chat (limit-reset "continue"): queued into that chat, false if the chat is gone. */
  resumeChat(task) {
    const run = this.runFor(task.chatId);
    if (!run) return false;
    if (task.projectId && run.chat.projectId !== task.projectId) throw new Error('Scheduled task project does not match its conversation.');
    this.deps.projects?.context(run.chat.projectId);
    const attachments = (task.attachments || []).map(file => {
      const target = path.join(run.deps.attachmentsDir, `${crypto.randomUUID()}_${file.name}`);
      fs.copyFileSync(path.resolve(task.workspaceDir || this.deps.workspaceDir, file.absolutePath || file.relativePath), target);
      return target;
    });
    run.enqueue({ text: task.prompt, modelId: task.modelId || chatModelFor(run.chat, task.model)?.id || 'auto', attachments, scheduled: true });
    this.deps.notifyHistory();
    return true;
  }

  /** Used by cross-extension IPC (injectPrompt, batch dispatch): the currently focused
   * window if there is one, else the most recently opened one, else a brand-new window. */
  getOrCreateActive() {
    if (this.activeHost && this.hosts.has(this.activeHost)) return this.activeHost;
    return [...this.hosts].at(-1) || this.open();
  }

  dispose() {
    // Invalidate pending routing and stop queues before closing the webviews.
    for (const run of this.runs.values()) {
      run.startVersion++;
      if (run.queue.length) run.queuePaused = true;
      run.chat.turnQueue = run.queueState();
      if (run.activeAssistantMessage) {
        delete run.activeAssistantMessage.inProgress;
        delete run.activeAssistantMessage.hostPid;
        Object.assign(run.activeAssistantMessage, { interrupted: true, interruptionReason: 'host_shutdown', at: new Date().toISOString() });
      }
      run.save();
    }
    for (const { panel } of this.hosts) panel.dispose();
    this.hosts.clear();
    for (const run of this.runs.values()) run.streamEngine.dispose();
    this.runs.clear();
    this.deps.chatStore.flush();
  }
}

/**
 * Older versions painted the launcher's sidebar header transparent (`sideBarTitle.foreground`) while it was showing.
 * The launcher no longer has a sidebar of its own, so this only puts a colour left behind by such a version back.
 */
const HEADER_COLOR_KEY = 'sideBarTitle.foreground';
const HEADER_HIDDEN = '#00000000';
let headerUserColor; // the user's own sideBarTitle.foreground, kept while the launcher covers it
let headerQueue = Promise.resolve();
function setLauncherHeaderHidden(hidden) {
  headerQueue = headerQueue.then(async () => {
    const config = vscode.workspace.getConfiguration('workbench');
    const current = { ...(config.inspect('colorCustomizations')?.globalValue || {}) };
    if (hidden) {
      if (current[HEADER_COLOR_KEY] === HEADER_HIDDEN) return;
      headerUserColor = current[HEADER_COLOR_KEY];
      current[HEADER_COLOR_KEY] = HEADER_HIDDEN;
    } else {
      if (current[HEADER_COLOR_KEY] !== HEADER_HIDDEN) return;
      if (headerUserColor) current[HEADER_COLOR_KEY] = headerUserColor; else delete current[HEADER_COLOR_KEY];
      headerUserColor = undefined;
    }
    await config.update('colorCustomizations', Object.keys(current).length ? current : undefined, vscode.ConfigurationTarget.Global);
  }).catch(() => { /* a header colour is never worth an error */ });
  return headerQueue;
}

class LauncherViewProvider {
  constructor(extensionUri, deps) {
    this.extensionUri = extensionUri;
    this.deps = deps; // { chatStore, chatWindowManager }
    this.view = null;
    this.pollTimer = null;
  }

  /**
   * The launcher is a slim rail, too narrow for the Scheduled queue and Settings. Both open as popups in the
   * chat itself (the same layer as Manage Chats): this shows the chat window and tells it which one.
   */
  showInChat(type) {
    const host = this.deps.chatWindowManager.getOrCreateActive();
    host.panel.reveal(undefined, false);
    void host.panel.webview.postMessage({ type });
  }

  /**
   * The Activity Bar icon is only a doorway. The launcher rail lives inside the chat in the secondary sidebar (the
   * chat's own webview, see railMarkup), so whenever this view is shown it opens that chat and puts the primary
   * sidebar away again. The view itself stays empty, in the sidebar's own colour, for the moment it is on screen.
   */
  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = '<!DOCTYPE html><html><body style="background:var(--vscode-sideBar-background)"></body></html>';
    const openChat = () => {
      if (!webviewView.visible) return;
      void vscode.commands.executeCommand('aiChatPanel.chatView.focus').then(() => vscode.commands.executeCommand('workbench.action.closeSidebar'));
    };
    openChat();
    webviewView.onDidChangeVisibility(openChat);
  }

  handleMessage(message) {
    if (/^routing(?:Get|Save|Reset|Connect|Test)$/.test(message.type) && this.deps.routing) {
      void this.deps.routing.handle(message).then(async result => {
        this.view?.webview.postMessage({ type: 'routingResult', ...result });
        await this.pushFleet();
      }).catch(error => this.view?.webview.postMessage({ type: 'routingResult', ok: false, error: error.message }));
      return;
    }
    switch (message.type) {
      case 'newChatWindow': this.deps.chatWindowManager.open(undefined, { detached: true }); break; // the rail's button: another chat, in an editor tab
      case 'openScheduled': this.showInChat('openQueue'); break;
      case 'openHistory': this.showInChat('openHistory'); break;
      case 'openSettings': this.showInChat('openSettings'); break;
      case 'openChat': this.deps.chatWindowManager.open(message.id); break;
      case 'deleteChat': this.deps.chatWindowManager.deleteChat(message.id); break;
      case 'renameChat': this.deps.renameChat(message.id, message.title); break;
      case 'requestHistory': this.postHistory(); break;
      case 'requestQuotas': void this.pushQuotas(); break;
      case 'requestApiValue': {
        const meter = this.deps.getCostMeter?.();
        if (meter) this.view?.webview.postMessage(meter.message());
        break;
      }
      case 'requestSchedulerQueue': void this.pushSchedulerQueue(); break;
      case 'cancelScheduledTask': void this.cancelScheduledTask(message.taskId); break;
      case 'rescheduleTask': void this.deps.schedulerQueue.reschedule(message.taskId).then(() => this.deps.notifySchedulerQueue()); break;
      case 'dispatchInterruptedTask': void this.runInterrupted(message.taskId); break;
      case 'unscheduleToComposer': void this.deps.chatWindowManager.getOrCreateActive().takeScheduledTask(message.taskId, false); break;
      case 'dispatchNowWithAutoRoute': void this.deps.chatWindowManager.getOrCreateActive().takeScheduledTask(message.taskId, true); break;
      case 'requestFleet': {
        void this.pushFleet();
        const snapshot = this.deps.cliHub.snapshot();
        this.view?.webview.postMessage(snapshot);
        // Retry failed release lookups too: a known installed version does not
        // mean the startup network check succeeded.
        if (Object.values(snapshot.versions || {}).some((entry) => !entry?.version || !entry?.latest) || !Object.keys(snapshot.versions || {}).length) void this.deps.cliHub.check();
        break;
      }
      case 'requestCliStatus': this.view?.webview.postMessage(this.deps.cliHub.snapshot()); break;
      case 'requestCliConnections':
        this.view?.webview.postMessage(this.deps.cliAccounts.snapshot());
        void this.deps.cliAccounts.check();
        break;
      case 'connectCli': void this.deps.cliAccounts.connect(message.agent); break;
      case 'connectAllClis': void this.deps.cliAccounts.connectAll(); break;
      case 'removeCli': void this.deps.cliAccounts.remove(message.agent); break;
      case 'checkCliConnections': void this.deps.cliAccounts.check(); break;
      case 'completeCliSetup': void this.deps.cliAccounts.complete(); break;
      case 'checkCliUpdates': void this.deps.cliHub.check(); break;
      case 'updateCli': void this.deps.cliHub.update(message.agent); break;
      case 'updateAllClis': void this.deps.cliHub.updateAll(); break;
      case 'refreshModels': void this.deps.cliHub.refreshModels(); break;
      case 'toggleFavoriteModel': this.deps.cliHub.toggleFavorite(message.id); break;
      case 'setModelPrompt': this.deps.cliHub.setPrompt(message.model, message.label, message.text); break;
      case 'setModelSettings': this.deps.cliHub.setModelSettings(message.id, message.permissionMode); break;
      case 'changeFavoriteModel': this.deps.cliHub.changeFavorite(message.id, message.nextId); break;
      case 'pingClis': void this.pushFleet(true); break;
      case 'openModelSettings': void vscode.commands.executeCommand('workbench.action.openSettings', 'aiChatPanel.models'); break;
      case 'resetCliCache': refreshBinaries(); void this.pushFleet(); break;
      case 'configureTelegram': void this.deps.configureTelegram?.().then(() => this.pushFleet()); break;
      case 'testTelegram': {
        const bridge = this.deps.getTelegramBridge?.();
        if (!bridge || !bridge.isConfigured()) {
          vscode.window.showWarningMessage('Clanker Controller:Configure Telegram before sending a test ping.');
          break;
        }
        bridge.sendMessage('🚀 Clanker Controller:Test message from your workspace! Connection verified.')
          .then((ok) => {
            if (ok) vscode.window.showInformationMessage('Clanker Controller:Test message sent successfully.');
            else vscode.window.showErrorMessage('Clanker Controller:Failed to send Telegram test message.');
          })
          .catch((err) => vscode.window.showErrorMessage(`Clanker Controller:Telegram error (${err.message}).`));
        break;
      }
      case 'disconnectTelegram': void this.deps.disconnectTelegram?.().then(() => this.pushFleet()); break;
      case 'startTunnel': {
        this.deps.startTunnel?.()
          .then(() => this.pushFleet())
          .catch((err) => {
            vscode.window.showErrorMessage(`Clanker Controller:Unable to start Cloudflare Tunnel (${err.message}). Make sure 'cloudflared' is installed.`);
            this.pushFleet();
          });
        break;
      }
      case 'stopTunnel': void this.deps.stopTunnel?.().then(() => this.pushFleet()); break;
      case 'setStatusBar': void vscode.workspace.getConfiguration('aiChatPanel').update('showStatusBar', Boolean(message.enabled), vscode.ConfigurationTarget.Global); break;
      case 'setTimeFormat': {
        if (message.format) {
          void vscode.workspace.getConfiguration('aiChatPanel').update('timeFormat', message.format, vscode.ConfigurationTarget.Global);
        }
        break;
      }
      // Settings > Voice. The configuration listener in activate() restarts the hotkey and tells every window.
      case 'setVoiceHotkey': void vscode.workspace.getConfiguration('aiChatPanel').update('voiceHotkey', String(message.hotkey || ''), vscode.ConfigurationTarget.Global); break;
      case 'setVoiceMode': void vscode.workspace.getConfiguration('aiChatPanel').update('voiceHotkeyMode', message.mode === 'hold' ? 'hold' : 'toggle', vscode.ConfigurationTarget.Global); break;
      case 'setVoiceSounds': void vscode.workspace.getConfiguration('aiChatPanel').update('voiceSounds', Boolean(message.enabled), vscode.ConfigurationTarget.Global); break;
      case 'saveGroqKey': void this.deps.groqAccount.save(message.key).then((result) => this.view?.webview.postMessage({ type: 'groqResult', action: 'save', ...result })); break;
      case 'clearGroqKey': void this.deps.groqAccount.clear(); break;
      case 'checkGroqUsage':
        void loadVoiceRouterModules()
          .then(([, groq]) => this.deps.groqAccount.check(groq.probeRateLimits))
          .then((result) => this.view?.webview.postMessage({ type: 'groqResult', action: 'check', ...result }));
        break;
      case 'openGroqConsole': void vscode.env.openExternal(vscode.Uri.parse(message.page === 'usage' ? 'https://console.groq.com/dashboard/usage' : 'https://console.groq.com/keys')); break;
      case 'openRoutingLink': {
        const url = ROUTING_LINKS[message.key];
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'setPermissionMode': {
        if (message.mode) {
          void vscode.workspace.getConfiguration('aiChatPanel').update('permissionMode', message.mode, vscode.ConfigurationTarget.Global);
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
    for (const agent of providers.ids()) {
      const found = locate(agent).path;
      clis[agent] = { path: found, version: ping && found ? await version(found) : undefined };
    }
    const models = MODEL_CATALOG.map(({ id, label, agent, model, effort }) => ({ id, label, agent, model, effort }));
    const services = {
      watchdog: Boolean(this.deps.watchdog?.timer),
      ...(this.deps.getServices?.() || {}),
      statusBar: vscode.workspace.getConfiguration('aiChatPanel').get('showStatusBar', false),
      permissionMode: vscode.workspace.getConfiguration('aiChatPanel').get('permissionMode', 'fullAccess'),
      voice: this.deps.getVoice?.(),
      routing: await this.deps.routing?.snapshot(),
    };
    this.view.webview.postMessage({ type: 'fleet', models, clis, services, pinged: ping });
  }

  async runInterrupted(taskId) {
    try {
      if (!await this.deps.watchdog.runNow(taskId)) vscode.window.showInformationMessage('Clanker Controller:another scheduled task is still running. Reschedule this one, or run it once that finishes.');
    } catch (error) { vscode.window.showWarningMessage(error.message); }
  }

  postHistory() { this.view?.webview.postMessage({ type: 'history', sessions: this.deps.chatWindowManager.listChats() }); }
  async pushQuotas(quotas) {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'quotas', quotas: quotas || await readQuotas() });
    const meter = this.deps.getCostMeter?.();
    if (meter) this.view.webview.postMessage(meter.message());
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

}

/** The launcher rail, down the right edge of the sidebar chat: buttons, then usage, then chats (styled by launcher.css, driven by launcher.js). */
/**
 * The chat's three header buttons: the Scheduled-prompts timer pill (hidden until something is queued), Manage chats
 * and New chat. main.js finds them by id, so it is the same three elements wherever they sit: in the rail of the
 * sidebar chat, or in a topbar over a chat opened as an editor tab.
 */
const CHAT_BUTTONS = {
  queue: `<button class="round-btn round-btn-queue" id="queueBtn" type="button" aria-label="Scheduled prompts" hidden>
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 5.5v3l2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="queue-countdown" id="queueCountdown"></span>
        <span class="queue-badge" id="queueBadge">0</span>
        <span class="round-btn-tip" aria-hidden="true">Queue</span>
      </button>`,
  history: `<button class="round-btn" id="historyBtn" type="button" aria-label="Manage chats">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M8 4v4.3l3 1.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <path d="M2 2.5v2.4h2.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="round-btn-tip" aria-hidden="true">Chats</span>
      </button>`,
  // The bubble of sources/pencil-chat-svgrepo-com.svg with a plus where its pen was (top right); the Activity Bar icon is the Clanker Controller logo, media/clanker.svg.
  newChat: `<button class="round-btn" id="newChatBtn" type="button" aria-label="New chat">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11,1.48H5.32A3.82,3.82,0,0,0,1.5,5.3v9.54a3.82,3.82,0,0,0,3.82,3.82H9.14L12,21.52l2.86-2.86h3.82a3.82,3.82,0,0,0,3.82-3.82V13"/><path d="M18.2 2.2v7.2M14.6 5.8h7.2" stroke-width="2.2"/></g></svg>
        <span class="round-btn-tip" aria-hidden="true">New Chat</span>
      </button>`,
};

function railMarkup(buttons) {
  return `<aside class="rail" aria-label="Chats and usage">
  <!-- Project (added by main.js), buttons, usage, then chats. Scheduled, Settings and Manage Chats all open as popups over the chat.
       .rail-scroll scrolls them when the window is short. -->
  <div class="rail-scroll">
  <div class="launcher-actions">
    ${buttons.newChat}
    <button class="round-btn" id="popOutBtn" type="button" aria-label="Open a new chat in an editor tab">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 9v2.5a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2H7"/><path d="M10 2.5h3.5V6M13.5 2.5 8 8"/></svg>
      <span class="round-btn-tip" aria-hidden="true">Pop out</span>
    </button>
    ${buttons.history}
    ${buttons.queue}
    <button class="round-btn" id="settingsBtn" type="button" title="Chat settings" aria-label="Chat settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>
    <button class="round-btn round-btn-update" id="updatesBtn" type="button" aria-label="CLI updates" hidden>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4"/></svg>
      <span class="round-btn-tip" aria-hidden="true">Update</span>
    </button>
  </div>

  <section class="launcher-section">
    <div class="launcher-label">Usage</div>
    <div class="model-cards" id="modelCards" aria-label="Model quotas"></div>
  </section>

  <!-- API value: what the work done here would have cost at pay-per-token API prices (api-cost.js). A comparison, never a
       charge, and it says so on the figure and in its card. launcher.js fills it. -->
  <section class="launcher-section api-value" id="apiValue" hidden>
    <div class="launcher-label">API value</div>
    <div class="api-value-figure" id="apiValueFigure" tabindex="0" aria-describedby="apiValueCard">
      <span class="api-value-amount" id="apiValueAmount"></span>
      <span class="api-value-note">not billed</span>
      <div class="api-value-card" id="apiValueCard" role="tooltip">
        <div class="api-value-card-head"><span>API value</span><b id="apiValueTotal"></b></div>
        <div class="api-value-range"><span id="apiValueRange"></span><i>±20%</i></div>
        <p class="api-value-card-lead">What the work done here would have cost at the providers' pay-per-token API prices. Billing details aren't public, so this is an estimate. Your subscriptions cover it: a comparison, not a charge.</p>
        <div class="api-value-rows" id="apiValueRows"></div>
        <p class="api-value-card-foot" id="apiValueFoot"></p>
      </div>
    </div>
  </section>

  <section class="launcher-section is-grow">
    <div class="launcher-label">Recent</div>
    <div class="history-list" id="historyList">
      <div class="history-empty">No conversations yet.</div>
    </div>
  </section>
  </div>
</aside>`;
}

function activate(context) {
  refreshBinaries();
  const AGENTS = agentList();
  const sessionManager = new TerminalSessionManager(vscode, AGENTS);
  const pendingResets = new Set();
  // VS Code reports "c:\..."; Claude Code keys folder trust by the exact path
  // string, and the trusted entry is "C:/...". A lowercase drive letter made
  // every panel run count as an untrusted workspace.
  const workspaceDir = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  SESSION_DIR = resolveSessionDir({
    storageDir: context.globalStorageUri.fsPath,
    // Earlier versions kept this in a site's `.astro/session`; copied over once, never read again.
    legacyDirs: [process.env.ASTRO_CONTENT_EDITOR_SESSION_DIR, path.join(workspaceDir, 'site', '.astro', 'session'), path.join(workspaceDir, '.astro', 'session')],
  });
  const chatStore = new ChatStore(SESSION_DIR);
  const projects = new ProjectRegistry(SESSION_DIR);
  const workspaceProjects = (vscode.workspace.workspaceFolders || []).filter(folder => fs.existsSync(folder.uri.fsPath)).map(folder => projects.add(folder.name, folder.uri.fsPath));
  const rememberedProject = context.workspaceState.get('selectedProjectId');
  const defaultProjectId = projects.get(rememberedProject)?.id || workspaceProjects[0]?.id || null;
  const cliAccounts = new CliAccounts({
    vscode, cwd: workspaceDir,
    store: { get: () => context.globalState.get('cliConnections'), set: (value) => context.globalState.update('cliConnections', value) },
    existingUser: Boolean(context.globalState.get('discoveredModels', []).length || context.globalState.get('favoriteModels', []).length || chatStore.list().length),
    broadcast: (message) => { for (const host of chatWindowManager?.hosts || []) void host.panel.webview.postMessage(message); },
    onChange: () => cliHub.connectionsChanged(),
    onChecked: () => {
      if (!cliHub.modelsBusy) cliHub.ready = cliHub.refreshModels();
      return cliHub.ready;
    },
  });
  context.subscriptions.push(cliAccounts,
    vscode.window.onDidCloseTerminal((terminal) => cliAccounts.terminalClosed(terminal)),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && cliAccounts.terminals.size) void cliAccounts.check();
    }),
  );
  const voiceCapture = new VoiceCapture();
  const attachmentsDir = path.join(SESSION_DIR, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  // A minute after start, out of the way of everything else: drop attachments and finished tasks' staging that nothing
  // points to any more and that are two weeks old (lib/storage-gc.js).
  setTimeout(() => {
    const removed = sweepStorage(SESSION_DIR);
    if (removed.attachments || removed.staging) console.log(`[ai-chat-panel] storage sweep: ${removed.attachments} unused attachments (${(removed.bytes / 1048576).toFixed(1)} MB), ${removed.staging} finished task folders`);
  }, 60000).unref?.();
  const codexCommands = new CodexCommandCatalog();
  const slashCommands = new SlashCommandCatalog({ codexCommands, workspaceDir, cacheFile: path.join(SESSION_DIR, 'slash-commands.json') });

  function getModels() {
    const configured = vscode.workspace.getConfiguration('aiChatPanel').get('models', {});
    return Object.fromEntries(providers.ids().map((agent) => [agent, configured[agent] || defaultModel(agent)?.model]));
  }

  function getPermissionMode() {
    return vscode.workspace.getConfiguration('aiChatPanel').get('permissionMode', 'fullAccess');
  }

  const schedulerQueue = new SchedulerQueue({ workspaceDir, sessionDir: SESSION_DIR });
  let launcher = null;
  let chatWindowManager = null;
  // Launcher list and every open chat window's Queue badge/manager.
  function notifySchedulerQueue() {
    void launcher?.pushSchedulerQueue();
    for (const host of chatWindowManager?.hosts || []) void host.pushSchedulerQueue();
  }

  // P16-M: quota poll -> launcher gauges and chat headers, live.
  context.subscriptions.push(onDidChangeQuotas((quotas) => {
    void launcher?.pushQuotas(quotas);
    for (const host of chatWindowManager?.hosts || []) host.panel.webview.postMessage({ type: 'quotas', quotas });
  }));

  chatWindowManager = new ChatWindowManager(context.extensionUri, {
    sessionManager, chatStore, projects, defaultProjectId, cliAccounts, voiceCapture, workspaceDir, sessionDir: SESSION_DIR, attachmentsDir, getModels, getPermissionMode, getModelPrompts: () => cliHub.prompts, getModelSettings: () => cliHub.modelSettings, getCostMeter: () => costMeter, codexCommands, slashCommands, schedulerQueue, notifySchedulerQueue, renameChat, getEditorTheme: () => editorTheme, notify, notifyHistory, onTelegramEvent,
    // Which scheduling mode (usage reset, timer, calendar) the clock starts with: the one used last, kept for good.
    getScheduleMode: () => context.globalState.get('scheduleMode', 'reset'),
    setScheduleMode: (mode) => { if (['reset', 'timer', 'calendar'].includes(mode)) void context.globalState.update('scheduleMode', mode); },
    sidebarState: context.workspaceState,
  });
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
    for (const folder of event.added) {
      if (fs.existsSync(folder.uri.fsPath)) projects.add(folder.name, folder.uri.fsPath);
    }
    for (const host of chatWindowManager.hosts) host.postProject();
  }));
  // Chat windows come back after a restart in the tab spot they had, showing the same chat
  // (the webview keeps its chat id in its saved state; activation event onWebviewPanel:aiChatPanel.chatWindow).
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('aiChatPanel.chatWindow', {
    async deserializeWebviewPanel(panel, state) { chatWindowManager.restore(panel, state?.chatId || null); },
  }));
  let telegram = null;
  const tunnelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -2);
  // Off unless `aiChatPanel.showStatusBar` is on (Chat Settings > General has the switch).
  const applyStatusBar = () => { if (vscode.workspace.getConfiguration('aiChatPanel').get('showStatusBar', false)) tunnelStatus.show(); else tunnelStatus.hide(); };
  applyStatusBar();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('aiChatPanel.showStatusBar')) applyStatusBar();
    if (event.affectsConfiguration('aiChatPanel.permissionMode')) {
      const mode = getPermissionMode();
      if (watchdog?.engine) watchdog.engine.permissionMode = mode;
      for (const run of chatWindowManager?.runs.values() || []) {
        if (run?.streamEngine) run.streamEngine.permissionMode = mode;
      }
      void launcher?.pushFleet();
      for (const host of chatWindowManager?.hosts || []) {
        void host.settingsPane?.pushFleet();
      }
    }
  }));
  // Code blocks use the editor's own syntax colours; follow theme switches and customizations live.
  let editorTheme = resolveEditorTheme(vscode);
  function pushEditorTheme() {
    editorTheme = resolveEditorTheme(vscode);
    for (const host of chatWindowManager?.hosts || []) host.panel.webview.postMessage({ type: 'editorTheme', theme: editorTheme });
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
      if (chat.title) {
        open.chat.title = chat.title;
        open.chat.customTitle = true;
      } else {
        delete open.chat.title;
        delete open.chat.customTitle;
      }
      open.retitle();
    }
    notifyHistory();
  }
  // Chime when a reply finishes and nothing you queued is left to run; a Windows toast as well when the IDE is not the
  // focused window. `chime: false` (scheduled tasks) leaves the toast, which is silent, and drops the sound.
  function notify(agent, text, chatTitle, { chime = true } = {}) {
    notifyReply({ appName: vscode.env.appName, chime, toast: vscode.window.state.focused ? null : { agent, text, chatTitle } });
  }
  function notifyHistory() {
    launcher?.postHistory();
    for (const host of chatWindowManager?.hosts || []) host.postHistory();
  }
  const watchdog = new SchedulerWatchdog({ queue: schedulerQueue, projects, workspaceDir, getModels, getPermissionMode, getModelPrompts: () => cliHub.prompts, getModelSettings: () => cliHub.modelSettings, telegram: null, onQueueChange: notifySchedulerQueue, chatStore, onHistoryChange: notifyHistory, notify, isAgentEnabled: (agent) => cliAccounts.isEnabled(agent), resumeInChat: (task) => chatWindowManager?.resumeChat(task) });

  function onTelegramEvent(run, event) {
    const bridge = telegram;
    if (!bridge?.running) return;
    // Short id only to tell same-named chats apart; forum topic names cut at the '('.
    const title = `${run.chat.title || 'Chat'} (${String(run.chat.id).slice(0, 8)})`;
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
      const agentName = event.agent ? event.agent[0].toUpperCase() + event.agent.slice(1) : 'Agent';
      const statusText = event.interrupted ? 'stopped' : 'replied';
      const body = run.activeAssistantMessage.text ? markdownToTelegramHtml(run.activeAssistantMessage.text) : '<i>No text response.</i>';
      const replyText = `${statusIcon} <b>${escapeHtml(agentName)} ${statusText}</b>\n📁 ${escapeHtml(title)}\n\n${body}`;
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
      void bridge.sendMessage(replyText, options).catch(() => {});
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
    vscode.window.showInformationMessage('Clanker Controller:Telegram bridge disconnected.');
  }

  void (async () => {
    const token = await context.secrets.get(TOKEN_KEY);
    const chatId = await context.secrets.get(CHAT_KEY);
    const ownerId = await context.secrets.get(OWNER_KEY);
    if (token && chatId) await startTelegram(token, chatId, '', ownerId);
  })().catch((error) => vscode.window.showWarningMessage(`Telegram could not reconnect: ${error.message}. Use Configure to check the connection.`));
  void chatWindowManager.pruneEmptyChats().catch(error => console.error('[clanker] Could not clean up empty chats:', error.message));
  watchdog.start();

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => sessionManager.handleTerminalClosed(terminal)),
  );

  // Live service state for the launcher's Settings tab.
  const routing = routingRuntime(context, () => MODEL_CATALOG, SESSION_DIR);
  chatWindowManager.deps.routing = routing;
  // The mode lives in the composer's picker, so a change from anywhere (a window, Visor, the settings pane) reaches every window.
  context.subscriptions.push(routing.onDidChange(() => {
    for (const host of chatWindowManager.hosts || []) void host.pushRoutingMode();
    void launcher?.pushFleet();
    for (const host of chatWindowManager.hosts || []) void host.settingsPane?.pushFleet();
  }));
  context.subscriptions.push(require('./lib/routing-command').serve(context, routing, () => MODEL_CATALOG, SESSION_DIR, readQuotas));
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
    permissionMode: getPermissionMode(),
  });
  // CLI versions, the update icon and the starred models (Settings > Models) share one hub; every chat window hears it.
  const cliHub = new CliHub({
    accounts: cliAccounts,
    store: { get: () => context.globalState.get('favoriteModels', []), set: (entries) => void context.globalState.update('favoriteModels', entries) },
    promptStore: { get: () => context.globalState.get('modelPrompts', {}), set: (prompts) => void context.globalState.update('modelPrompts', prompts) },
    settingsStore: { get: () => context.globalState.get('favoriteModelSettings', {}), set: (settings) => void context.globalState.update('favoriteModelSettings', settings) },
    cacheStore: { get: () => context.globalState.get('discoveredModels', []), set: (entries) => void context.globalState.update('discoveredModels', entries) },
    broadcast: (message) => {
      for (const host of chatWindowManager.hosts) {
        if (message.type === 'modelCatalog' && modelOption(host.chat.modelId)) host.selectModel(host.chat.modelId);
        void host.panel.webview.postMessage(message);
      }
      if (message.type === 'modelCatalog') sessionManager.refreshCommands?.(agentList());
    },
  });
  cliHub.ready = cliHub.refreshModels();
  chatWindowManager.deps.ensureModels = () => cliHub.ready;
  void cliHub.check();
  // API value (api-cost.js): what the work would have cost at pay-per-token prices; every window shows the running total.
  const costMeter = new CostMeter({
    store: { get: () => context.globalState.get('apiValueLedger', null), set: (ledger) => void context.globalState.update('apiValueLedger', ledger) },
    priceStore: { get: () => context.globalState.get('apiPrices', null), set: (prices) => void context.globalState.update('apiPrices', prices) },
    broadcast: (message) => { for (const host of chatWindowManager.hosts) void host.panel.webview.postMessage(message); },
    livePrices: () => vscode.workspace.getConfiguration('aiChatPanel').get('livePrices', true),
  });
  const storedLedger = context.globalState.get('apiValueLedger');
  const needsSeed = !storedLedger
    || storedLedger.v !== LEDGER_VERSION
    || !storedLedger.byAgent?.codex
    || !storedLedger.byAgent?.gemini
    || !storedLedger.byAgent?.claude;
  if (needsSeed) {
    try { costMeter.seed(chatStore.list().map((session) => chatStore.load(session.id)).filter(Boolean), { force: true }); } catch { /* a start from zero */ }
  }
  void costMeter.refreshPrices(MODEL_CATALOG.map((entry) => entry.model));
  const updateTimer = setInterval(() => void cliHub.check(), 6 * 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(updateTimer) });
  // Dictation (Settings > Voice): the Groq key and its usage, and the global hotkey that starts and stops recording.
  const voiceConfig = () => vscode.workspace.getConfiguration('aiChatPanel');
  const hotkeyMode = () => (voiceConfig().get('voiceHotkeyMode', 'toggle') === 'hold' ? 'hold' : 'toggle');
  const recordingWindow = () => voiceCapture.owner || chatWindowManager.getOrCreateActive();
  const voiceHotkey = new VoiceHotkey({
    handlers: createHotkeyHandlers({
      mode: hotkeyMode,
      isRecording: () => voiceCapture.isRecording(),
      begin: () => chatWindowManager.getOrCreateActive().handleMicToggle({ hold: hotkeyMode() === 'hold' }),
      finish: () => recordingWindow().handleMicToggle(),
      cancel: () => recordingWindow().handleMicCancel(),
    }),
    onError: (reason) => vscode.window.showWarningMessage(`Clanker Controller:the dictation hotkey stopped (${reason}).`),
  });
  const voiceState = () => ({
    hotkey: voiceConfig().get('voiceHotkey', ''), mode: hotkeyMode(), sounds: voiceConfig().get('voiceSounds', true),
    hotkeyActive: Boolean(voiceHotkey.child), supported: process.platform === 'win32', groq: groqAccount.snapshot(),
  });
  const broadcastVoice = () => { for (const host of chatWindowManager.hosts) void host.panel.webview.postMessage({ type: 'voice', voice: voiceState() }); };
  groqAccount = new GroqAccount({
    secrets: context.secrets,
    store: { get: () => context.globalState.get('groqUsage', null), set: (usage) => void context.globalState.update('groqUsage', usage) },
    loadEnv: loadVoiceRouterEnv,
    onChange: broadcastVoice,
  });
  void groqAccount.init();
  voiceHotkey.start(voiceConfig().get('voiceHotkey', ''));
  context.subscriptions.push(
    { dispose: () => voiceHotkey.stop() },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('aiChatPanel.voiceHotkey')) voiceHotkey.start(voiceConfig().get('voiceHotkey', ''));
      if (['voiceHotkey', 'voiceHotkeyMode', 'voiceSounds'].some((name) => event.affectsConfiguration(`aiChatPanel.${name}`))) broadcastVoice();
    }),
  );
  const launcherDeps = {
    groqAccount, getVoice: voiceState, routing,
    cliHub, cliAccounts, chatStore, chatWindowManager, schedulerQueue, getModels, getPermissionMode, watchdog, notifySchedulerQueue, renameChat,
    getServices, configureTelegram, disconnectTelegram, startTunnel: () => tunnel.start(), stopTunnel: () => tunnel.stop(),
    getTelegramBridge: () => telegram, sessionManager, getCostMeter: () => costMeter,
  };
  launcher = new LauncherViewProvider(context.extensionUri, launcherDeps);
  chatWindowManager.launcherDeps = launcherDeps; // the chat windows' Chat Settings popup runs on the same handlers
  void setLauncherHeaderHidden(false); // a window closed while the launcher was showing leaves its header colour behind
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiChatPanel.mainView', launcher));
  // The chat itself lives in the secondary sidebar. Kept alive while hidden so a streaming reply survives a toggle.
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiChatPanel.chatView', { resolveWebviewView: (view) => chatWindowManager.attachSidebar(view) }, { webviewOptions: { retainContextWhenHidden: true } }));
  // Antigravity restores its own Agent panel into that sidebar on every start, so the chat claims it each time
  // (and once more a moment later, in case the built-in panel comes up after this extension).
  const showSidebarChat = () => void vscode.commands.executeCommand('aiChatPanel.chatView.focus');
  showSidebarChat();
  const sidebarRetry = setTimeout(showSidebarChat, 4000);
  context.subscriptions.push({ dispose: () => clearTimeout(sidebarRetry) });

  context.subscriptions.push(
    vscode.commands.registerCommand('aiChatPanel.open', () => {
      void vscode.commands.executeCommand('workbench.view.extension.aiChatPanel');
    }),
    // The palette command keeps its name: an extra chat in its own editor window, beside the sidebar chat.
    // Dictate without reaching for the button: bind a key to this in Keyboard Shortcuts. It ends by itself after a pause.
    vscode.commands.registerCommand('aiChatPanel.toggleMic', () => void chatWindowManager.getOrCreateActive().handleMicToggle()),
    vscode.commands.registerCommand('aiChatPanel.chooseProject', () => chatWindowManager.getOrCreateActive().chooseProject()),
    vscode.commands.registerCommand('aiChatPanel.manageProjects', () => chatWindowManager.getOrCreateActive().manageProjects()),
    vscode.commands.registerCommand('aiChatPanel.listProjects', () => projects.list()),
    vscode.commands.registerCommand('aiChatPanel.newChatWindow', () => {
      chatWindowManager.open(undefined, { detached: true });
    }),
    // Explorer right-click: the selection lands as @-mentions in the focused chat window.
    vscode.commands.registerCommand('aiChatPanel.addToChat', (uri, uris) => {
      const picked = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
      chatWindowManager.getOrCreateActive().postMentions(picked);
    }),
    vscode.commands.registerCommand('aiChatPanel.configureTelegram', () => configureTelegram()),
    vscode.commands.registerCommand('aiChatPanel.startTunnel', async () => {
      try { await tunnel.start(); }
      catch (error) { vscode.window.showErrorMessage(`Clanker Controller:unable to start Cloudflare Tunnel (${error.message}).`); }
    }),
    vscode.commands.registerCommand('aiChatPanel.stopTunnel', () => tunnel.stop()),
    // The AI bridge (docs/ai-bridge-interface.md): the commands another extension calls to hand Clanker work,
    // without Clanker knowing who calls. `bridge.info` is how a caller finds out it is there and what it can do.
    vscode.commands.registerCommand('aiChatPanel.bridge.info', () => ({ apiVersion: BRIDGE_API_VERSION, name: 'Clanker Controller', capabilities: BRIDGE_CAPABILITIES })),
    vscode.commands.registerCommand('aiChatPanel.favoriteModels', async () => {
      await cliHub.ready;
      return MODEL_CATALOG.map(({ id, label, agent }) => ({ id, label, agent }));
    }),
    // injectPrompt targets the active floating chat window (or opens a new one on the right) instead of ever
    // touching the left Activity Bar, so a caller never displaces the File Explorer.
    vscode.commands.registerCommand('aiChatPanel.injectPrompt', (payload) => {
      const { targetModel, prompt, submit, projectId } = payload || {};
      const target = injectTarget(targetModel);
      if (!target) {
        vscode.window.showWarningMessage(`Clanker Controller:unknown target model "${targetModel}".`);
        return;
      }
      let host;
      if (projectId) {
        try { projects.context(projectId); } catch (error) { vscode.window.showWarningMessage(error.message); return; }
        const recent = chatWindowManager.listChats().find(chat => chat.projectId === projectId);
        host = chatWindowManager.open(recent?.id || null, { projectId });
      } else host = chatWindowManager.getOrCreateActive();
      host.revealAndInject(target.agentId, prompt, submit !== false, target.modelId);
    }),
    // The smart-routing mode (manual / shadow / auto), for a caller with its own model picker. With a mode it sets it first.
    vscode.commands.registerCommand('aiChatPanel.routingMode', (payload) => payload?.mode ? routing.setMode(payload.mode) : routing.mode()),
    vscode.commands.registerCommand('aiChatPanel.routePrompt', (payload) => chatWindowManager.routePrompt(payload?.prompt, { newChat: payload?.newChat === true, attachments: payload?.attachments || [], ...(payload?.targetModel ? { targetModel: payload.targetModel } : {}), ...(payload?.projectId ? { projectId: payload.projectId } : {}) })),
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
        vscode.window.showWarningMessage(`Clanker Controller:unknown target model "${targetModel}".`);
        return;
      }
      if (!batchPrompt) {
        vscode.window.showWarningMessage('Clanker Controller:runNextBatchInCleanSession requires a batchPrompt.');
        return;
      }
      // Guards the one real race available here: a duplicate invocation
      // (e.g. a double-click) firing a second confirmation/reset for the
      // same agent while the first is still awaiting the user's answer.
      if (pendingResets.has(targetModel)) return;
      pendingResets.add(targetModel);
      try {
        const summary = writeMicroHandoff(path.join(SESSION_DIR, 'handoff.json'), handoffSummary);
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
