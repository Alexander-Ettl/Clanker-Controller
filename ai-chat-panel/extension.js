'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TerminalSessionManager } = require('./lib/pty-session.js');
const log = require('./lib/log.js'); // the Logs popup and the "Clanker Controller" output channel
const { readQuotas, onDidChangeQuotas, recordClaudeUsage, claudeUsageAge } = require('./lib/quota-bridge.js');
const { probeClaudeUsage } = require('./lib/claude-usage.js');

// Claude's real usage after a restart or a quiet spell: `claude -p /usage` is a local command
// (0 tokens), so it's asked whenever the last real reading is 15+ minutes old or a window rolled over.
const USAGE_PROBE_AFTER_MS = 15 * 60 * 1000;
let usageProbe = null;
const WAITING_PROBE_AFTER_MS = 90 * 1000; // a prompt is waiting for Claude's reset: look often enough to notice a manual one
function refreshClaudeUsage(cwd, maxAge = USAGE_PROBE_AFTER_MS) {
  if (usageProbe || claudeUsageAge() < maxAge) return usageProbe;
  usageProbe = probeClaudeUsage(cwd).then((windows) => recordClaudeUsage(windows)).catch(() => {}).finally(() => { usageProbe = null; });
  return usageProbe;
}
const { readMarkup, writeMarkup, cleanMarkup, sidecarPath } = require('./lib/markup.js');
const { VoiceCapture } = require('./lib/voice-capture.js');
const { learnedTerms } = require('./lib/voice-learn.js');
const providers = require('./lib/providers'); // the coding-agent CLIs Clanker drives (docs/adding-a-provider.md)
const { VoiceHotkey, createHotkeyHandlers } = require('./lib/voice-hotkey.js');
const { GroqAccount } = require('./lib/groq-account.js');
const voiceDictionary = require('./lib/voice-dictionary.js');
const { scanProject } = require('./lib/voice-scan.js');
const { resolveSessionDir } = require('./lib/session-dir.js');
const { writeMicroHandoff, formatMicroHandoffPrompt } = require('./lib/handoff.js');

// The Routing tab's setup guides link here by key, so the webview can't open arbitrary addresses.
const ROUTING_LINKS = {
  cfSignup: 'https://dash.cloudflare.com/sign-up',
  cfAi: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
  groqKeys: 'https://console.groq.com/keys',
  groqLimits: 'https://console.groq.com/dashboard/limits',
};
// Settings behind the Loops tab's switches. Only these two can be written from the webview.
const COMPLIANCE_SETTINGS = { scout: 'complianceScout', redact: 'complianceRedact' };
const { execFile, spawn } = require('node:child_process');
const { StreamEngine } = require('./lib/stream-engine.js');
const { locate, refresh: refreshBinaries, resolveShim, terminalCommand } = require('./lib/binary-locator.js');
const { ChatStore, markActive, ACTIVE_WINDOW_MS, deriveFallbackTitle, recoverInterruptedChat, ownedByAnotherHost } = require('./lib/chat-store.js');
const { CodexThreadTitles, codexThreadTitle } = require('./lib/codex-thread-titles.js');
const { readAgentTitle, hasAgentTitles } = require('./lib/agent-titles.js');
const { CodexChatSync, inputHash, repairImportedPrompts } = require('./lib/codex-chat-sync.js');
const { historyPage } = require('./lib/chat-history.js');
const { route, routeBest } = require('./lib/auto-router.js');
const { runtime: routingRuntime, projectStack } = require('./lib/routing-runtime.js');
const { contextAssets } = require('./lib/work-context.js');
let contextAssetsJson = null; // the rail's category list and icons, read once from media/context-icons
const { windowOf, GROQ_MODEL } = require('./lib/routing.js');
const { MODEL_CATALOG, AVAILABLE_MODELS, defaultModel, modelOption, resolveModel, quotaFor } = require('./lib/model-catalog.js');
const { CliHub, providerBusy } = require('./lib/cli-tools.js');
const { CliAccounts } = require('./lib/cli-accounts.js');
const { promptFor, permissionFor, appendInstructions } = require('./media/model-prompts.js');
const { CostMeter, chatTotal, chatCost, LEDGER_VERSION } = require('./lib/api-cost.js');
const { isLimitNotice, LIMIT_RE, resetsInMs } = require('./media/limit-notice.js');
const { accessFailure } = require('./lib/provider-access.js');
const { AuthGate } = require('./lib/auth-gate.js');
const clankerAgent = require('./lib/clanker-agent.js');
const { showAuthPrompt } = require('./lib/auth-prompt.js');
const { SchedulerQueue, ACTIVE_STATUSES, isDue, resetObserved, firstPrompt } = require('./lib/scheduler-queue.js');
const { keepAwake } = require('./lib/keep-awake');
const { SessionWarmup } = require('./lib/session-warmup');
const { CloudWarmup } = require('./lib/cloud-warmup');
const { subscriptionBilled } = require('./lib/billing-mode');
const { installInvestigations } = require('./lib/investigation-commands.js');
const { createInvestigationBridge, investigationOptions } = require('./lib/investigation-bridge.js');
const { ProjectRegistry, projectFiles, describe: describeProject, findIcon } = require('./lib/projects.js');
const { resolveFileRef } = require('./lib/file-links.js');
const { TelegramBridge, DOCK_KEYBOARD, escapeHtml, markdownToTelegramHtml } = require('./lib/telegram-bridge.js');
const { configureTelegram: setupTelegram, TOKEN_KEY, CHAT_KEY, OWNER_KEY } = require('./lib/telegram-setup.js');
const { forwardRequest, bindTelegramControls } = require('./lib/telegram-control.js');
const { resolveEditorTheme } = require('./lib/editor-theme.js');
const { buildHandoff, buildCompactionHandoff, taskState, checkpointStart, estimateTokens, COMPACT_DIRECTIVE, COMPACT_TARGET_TOKENS } = require('./lib/chat-handoff.js');
const { RECORDED_OUTPUT_CHARS } = require('./lib/chat-transcript.js');
const { CodexCommandCatalog } = require('./lib/codex-commands.js');
const { SlashCommandCatalog } = require('./lib/slash-commands.js');

// Context windows (the webview's gauge uses the same numbers) and the point
// where the panel compacts Gemini itself: agy has no compaction of its own,
// while Claude Code and Codex auto-compact natively (both on by default).
const CONTEXT_LIMITS = { claude: 1000000, codex: 1000000, gemini: 1048576 };
const AUTO_COMPACT_RATIO = 0.90;
const DELTA_BATCH_MS = 33; // reply text reaches the window at most about every second frame, see ChatRun.postEvent
const SUBAGENT_LOG_LIMIT = 3000; // subagent events kept per chat for the agents viewer
const { notifyReply, textAfterLastTool } = require('./lib/notify.js');
const { sweepStorage } = require('./lib/storage-gc.js');
const voiceArchive = require('./lib/voice-archive.js');
const { planUndo, applyUndo, fileCount, fileList } = require('./lib/turn-undo.js');
const { verifyInstruction, ARCHITECT_PREFIX, buildInstruction } = require('./lib/turn-extras.js');

// P17-X: clock locale + format shared by both webviews ('24h' default, 'auto' follows vscode.env.language).
// Which Antigravity usage the launcher's Gemini ring draws (Settings > General): 'split' is one arc per pool (Gemini and
// Argon); the others draw one pool's windows. The rest always stays in the hover pill.
const ANTIGRAVITY_RINGS = ['split', 'argon', 'gemini', 'claude-gpt'];
const antigravityRing = () => {
  const value = vscode.workspace.getConfiguration('aiChatPanel').get('antigravityRing', 'split');
  return ANTIGRAVITY_RINGS.includes(value) ? value : 'split';
};
// Who names a new chat (Settings > General): 'agent' (default) uses the title the agent wrote itself where it writes one
// (lib/agent-titles.js) and Groq elsewhere; 'groq' always asks Groq.
const CHAT_NAME_SOURCES = ['agent', 'groq'];
const chatNameSource = () => {
  const value = vscode.workspace.getConfiguration('aiChatPanel').get('chatNames', 'agent');
  return CHAT_NAME_SOURCES.includes(value) ? value : 'agent';
};
const timePrefs = () => JSON.stringify({ locale: vscode.env.language || 'en', timeFormat: vscode.workspace.getConfiguration('aiChatPanel').get('timeFormat', '24h') });

const QUOTA_POLL_MS = 5000;
const WATCHDOG_POLL_MS = 15000; // a timer that reaches 0 should not wait up to a minute for the next look
const WATCHDOG_THRESHOLD_PCT = 20;

function recordToolEnd(chat, event) {
  if (!event.toolId) return;
  const step = chat.messages.findLast(entry => entry.role === 'tool' && entry.event?.toolId === event.toolId);
  if (!step) return;
  const startedAt = step.startedAt ?? step.event?.startedAt;
  const durationMs = Number.isFinite(event.durationMs) ? event.durationMs : (Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined);
  if (Number.isFinite(durationMs)) { step.durationMs = durationMs; event.durationMs = durationMs; }
  step.done = true;
  step.error = Boolean(event.error);
  step.event = { ...step.event, ...(Number.isFinite(durationMs) ? { durationMs } : {}), output: String(event.output || '').slice(0, RECORDED_OUTPUT_CHARS), diff: event.diff || step.event.diff, ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}) };
}

function quotaAvailable(quotas, modelOrTask) {
  const agent = typeof modelOrTask === 'string' ? modelOrTask : modelOrTask?.model;
  const quota = typeof modelOrTask === 'string' ? quotas?.[agent] : quotaFor(quotas, modelOrTask?.modelId, agent);
  return agent === 'gemini' && typeof quota?.remaining !== 'number'
    ? true // no live Antigravity number: never block it
    : typeof quota?.remaining === 'number' && quota.remaining > WATCHDOG_THRESHOLD_PCT;
}

class SchedulerWatchdog {
  constructor({ queue, workspaceDir, getModels, getPermissionMode, getModelPrompts, getModelSettings, telegram, onQueueChange, chatStore, onHistoryChange, notify, resumeInChat, isChatBusy, getQueueState, isAgentEnabled, projects, authGate }) {
    this.projects = projects; this.authGate = authGate || null;
    this.isChatBusy = isChatBusy || (() => false);
    this.getQueueState = getQueueState || (id => chatStore?.load(id)?.turnQueue || {});
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
      await this.releaseObservedResets();
      // A task that goes back into its chat is handed over once that chat is idle, and only one at a time: the model finishes
      // the "continue" (or any earlier prompt) before it is given the next one. A headless run holds the watchdog until it ends.
      for (let guard = 0; guard < 50; guard++) {
        const queue = await this.queue.getQueue();
        const states = new Map(); // a chat without an open run is read from disk: once per chat, not once per due task
        const stateOf = (chatId) => { if (!states.has(chatId)) states.set(chatId, this.getQueueState(chatId)); return states.get(chatId); };
        const due = queue.filter((task) => task.status === 'pending' && this.isAgentEnabled(task.model) && isDue(task, Date.now()) && this.projectAvailable(task) &&
          (!task.chatId || firstPrompt(stateOf(task.chatId), queue.filter(item => item.chatId === task.chatId))?.id === task.id) && !(task.chatId && this.isChatBusy(task.chatId, task)));
        if (!due.length) return;
        // The first due task may wait on an exhausted model; it must not hold back tasks for models that still have quota.
        const quotas = await readQuotas();
        // Signed out (or otherwise unusable) models keep their prompts pending: the gate tells you and sends them once it works again.
        let next = null;
        for (const task of due) if (quotaAvailable(quotas, task) && !(await this.authGate?.check(task.model))) { next = task; break; }
        if (!next) return;
        await this.dispatch(next);
        if (this.activeTaskId) return;
      }
    } catch (error) { this.failed = error.message; }
    finally { this.running = false; }
  }
  /** A usage reset that comes early (you reset it by hand, or the provider did) frees the prompts waiting for the old reset time. */
  async releaseObservedResets() {
    const waiting = (await this.queue.getQueue()).filter((task) => task.status === 'pending' && task.dispatchTrigger === 'quota-reset' && Date.parse(task.notBefore) > Date.now() && this.isAgentEnabled(task.model));
    if (!waiting.length) return;
    if (waiting.some((task) => task.model === 'claude')) await refreshClaudeUsage(this.workspaceDir, WAITING_PROBE_AFTER_MS);
    const quotas = await readQuotas();
    const released = waiting.filter((task) => resetObserved(task, quotaFor(quotas, task.modelId, task.model)));
    if (!released.length) return;
    const now = new Date().toISOString(); // a time in the past reads as "ready" everywhere, not as the new window's countdown
    for (const task of released) await this.queue.update(task.id, (item) => { if (item.status === 'pending') item.notBefore = now; });
    this.onQueueChange();
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
    await this.waitForCliUpdate?.(task.model);
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
    if (event.type === 'tool_start' && this.chat) {
      if (!event.done && !Number.isFinite(event.startedAt)) event.startedAt = Date.now();
      this.chat.messages.push({ role: 'tool', event, offset: this.reply?.text.length, done: Boolean(event.done), ...(Number.isFinite(event.startedAt) ? { startedAt: event.startedAt } : {}) });
      this.chat = this.chatStore.save(this.chat);
    }
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
    const outage = !event.interrupted ? accessFailure(this.reply?.text || this.output) : null;
    if (outage) {
      this.failed = `${outage.reason} ${outage.detail}`;
      if (outage.kind === 'auth') this.authGate?.expired(event.agent, outage.detail);
      else await this.authGate?.accounts.markUnavailable(event.agent, outage);
    }
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
const POLISH_MAX_CHARS = 12000; // what the composer's Polish button sends to the cleanup model in one go

// The AI bridge's version and what this provider implements (docs/ai-bridge-interface.md).
const BRIDGE_API_VERSION = 1;
const BRIDGE_CAPABILITIES = ['routePrompt', 'injectPrompt', 'runBatch', 'favoriteModels', 'routingMode', 'summarize'];

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

// Strictly increasing, so several files saved in one tick (a multi-file drop) never share a prefix and overwrite each other.
let lastAttachmentStamp = 0;
function attachmentStamp() {
  lastAttachmentStamp = Math.max(Date.now(), lastAttachmentStamp + 1);
  return lastAttachmentStamp;
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
let routingRuntimeRef = null; // set in activate(): lets the voice client share Groq's limits with Cloudflare (lib/routing.js)
function loadVoiceRouterModules() {
  if (!voiceRouterModulesPromise) {
    loadVoiceRouterEnv();
    const libDir = path.join(VOICE_ROUTER_DIR, 'lib');
    voiceRouterModulesPromise = Promise.all([
      import(pathToFileURL(path.join(libDir, 'quota-reader.mjs')).href),
      import(pathToFileURL(path.join(libDir, 'groq-client.mjs')).href),
    ]).then((modules) => { groqAccount?.attach(modules[1]); routingRuntimeRef?.attachVoice(modules[1]); return modules; }); // Settings counts the Groq requests from here on
  }
  return voiceRouterModulesPromise;
}

// P17-ZA: Clanker's own voice dictionary (lib/voice-dictionary.js) plus OpenWhispr's custom words.
const voicePaths = () => ({ dictionaryFile: path.join(SESSION_DIR, 'voice-dictionary.json') });
// The words sent to the models are ranked per recording for the chat's project (lib/voice-dictionary.js); nobody picks them.
const voiceVocabulary = (projectId, projects) => voiceDictionary.vocabulary(voicePaths(), undefined, { projectId, projectName: projects?.get(projectId)?.name });
/** Words dictated or sent count as used. Bookkeeping only: it must never get in the way of a message. */
const noteVoiceUse = (text, projectId) => { try { voiceDictionary.recordUse(voicePaths(), text, { projectId }); } catch { /* the dictionary file is optional */ } };

/**
 * One chat thread and its own StreamEngine, independent of any window: a turn
 * keeps streaming and saving after its window switches to another chat or
 * closes. At most one ChatWindowHost watches it at a time; the
 * ChatWindowManager keeps it alive while it runs or is on screen.
 */
/** A saved strip order: unique "turn:<id>" / "scheduled:<id>" keys, capped. */
function cleanQueueOrder(order) {
  return [...new Set(Array.isArray(order) ? order.filter((key) => typeof key === 'string' && /^(turn|scheduled):\S+$/.test(key)) : [])].slice(0, 200);
}

function safeAttachmentPaths(deps, paths) {
  const root = path.resolve(deps.attachmentsDir) + path.sep;
  return (Array.isArray(paths) ? paths : []).filter((file) => { const resolved = path.resolve(file); return resolved.startsWith(root) && fs.existsSync(resolved); });
}

// Types the chat can preview itself; the CLI always receives the original file. Text and tables are recognised by extension in the webview.
const ATTACHMENT_TYPES = {
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const PREVIEW_MAX_BYTES = 25 * 1048576;

function cleanAttachmentName(name) {
  return path.basename(String(name || '')).replace(/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[_-]|\d{10,}_)+/i, '') || 'image.png';
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
  if (option && accounts?.isUnavailable(option.agent)) throw new Error(`${providers.get(option.agent).name} is not available: ${accounts.unavailable[option.agent].reason} Choose another model, or try it again in Settings > General.`);
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
    routingDecision = await deps.routing.router.route({ prompt: text, project: run.chat.projectId || deps.workspaceDir, project_name: deps.projects?.get(run.chat.projectId)?.name, project_aliases: [deps.workspaceDir, deps.projects?.get(run.chat.projectId)?.name], stack: projectStack(deps.workspaceDir), language: vscode.env.language, recent_work: run.chat.messages.filter(m=>m.role==='user'||m.role==='assistant').slice(-deps.routing.getConfig().policy.recent_messages), previous, manual_pick: option?.id, screenshot: attachments.some(f => /\.(png|jpe?g|webp)$/i.test(f)), attachments, context_tokens: run.chat.context?.tokens || 0, context_pct: previous ? (run.chat.context?.tokens || 0) / windowOf({...previous,...deps.routing.getConfig().models[previous.id]},deps.routing.getConfig().policy.default_context) * 100 : 0, turns_since_switch: run.chat.routingTurns || 0, retry: message.retry === true, new_chat: message.newChat === true }, candidates, quotas);
    if (routingDecision.exhausted) throw new Error('No enabled model can accept this prompt with the remaining quota and image/context requirements.');
    option = modelOption(routingDecision.pick) || (routingDecision.pick === GROQ_MODEL.id ? GROQ_MODEL : null);
    if (previous?.id !== option?.id) run.chat.routingTurns = 0;
    else run.chat.routingTurns = (run.chat.routingTurns || 0) + 1;
    run.chat.routingModelId = option?.id;
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
  // other agents answered.
  // Without a session id (new/reset session or transcript-based compaction),
  // even this agent's own replies must be replayed: the fresh CLI has no memory.
  // A failed native resume likewise receives freshPrompt with the full briefing.
  const session = routingDecision?.action === 'new' ? null : run.chat.sessions?.[dispatch.agent] || null;
  if (routingDecision?.action === 'new') run.chat.sessions = {};
  // Never further back than the last compaction: its summary stands in for everything before it.
  // The agent reads this, so it names the project; the registry id stays the router's key.
  const projectLabel = deps.projects?.get(run.chat.projectId)?.name || deps.workspaceDir;
  // Whatever a briefing shortens stays readable in the chat's transcript file (written once, only when a briefing is needed).
  let transcript;
  const transcriptFile = () => (transcript === undefined ? (transcript = deps.chatStore?.transcript?.(run.chat) || null) : transcript);
  const briefing = (from) => {
    const missed = run.chat.messages.slice(Math.max(from, checkpointStart(run.chat.messages)));
    return [
      `PROJECT: ${projectLabel}`,
      !from && run.chat.messages.length ? `TASK STATE:\n${JSON.stringify(taskState(run.chat.messages, { transcript: transcriptFile() }))}` : '',
      buildHandoff(missed, dispatch.agent, { structured: true, transcript: missed.length ? transcriptFile() : null }),
    ].filter(Boolean).join('\n\n');
  };
  const compose = (handoff, fresh) => [fresh ? dispatch.directive : '', dispatch.contract, handoff, promptText].filter(Boolean).join('\n\n');
  const prompt = codexCommand ? codexCommand.prompt : slashAgent ? promptText : session?.id ? compose(briefing(session.seen || 0), false) : compose(briefing(0), true);
  const freshPrompt = codexCommand || slashAgent ? null : session?.id ? compose(briefing(0), true) : null;
  return {
    agent: dispatch.agent,
    rerouted,
    begin: {
      agent: dispatch.agent,
      user: { role: 'user', text, at: new Date().toISOString(), agent: dispatch.agent, modelId: message.modelId, attachments: Array.isArray(message.attachments) ? message.attachments : [], ...(message.clientTurnId ? { clientTurnId: message.clientTurnId } : {}), ...(message.scheduled ? { scheduled: true } : {}), ...(message.queued ? { queued: true } : {}), ...(message.pipelineBuild ? { pipelineBuild: true } : {}) },
      reply: { role: 'assistant', text: '', agent: dispatch.agent, modelId: used?.id, modelLabel: used?.label, roleName: session?.id ? undefined : dispatch.roleName, routing: routingDecision || (dispatch.split ? 'contract-lock' : undefined) },
      routing: { agentId: dispatch.agent, modelLabel: used?.label, roleName: session?.id ? null : dispatch.roleName, auto: requested === 'auto', split: dispatch.split },
      run: { agent: dispatch.agent, prompt, freshPrompt, resume: session?.id || null, groqRouter: deps.routing?.router, contextWindow: used ? windowOf({ ...used, ...deps.routing?.getConfig().models[used.id] },deps.routing?.getConfig().policy.default_context) : undefined, codexCommand: codexCommand?.name || null, codexCommandArgs: codexCommand?.args || [], attachments: safeAttachmentPaths(deps, message.attachments), model: used?.model, effort: used?.effort, permissionMode: permissionFor(deps.getModelSettings?.(), used, deps.getPermissionMode?.() || 'fullAccess') },
    },
  };
}

class ChatRun {
  constructor(chat, deps) {
    const repaired = repairImportedPrompts(chat);
    if (repaired) chat.taskState = taskState(chat.messages);
    if (recoverInterruptedChat(chat) || repaired) chat = deps.chatStore.save(chat);
    // Codex's number is kept as recorded: its app-server reports each request's real context
    // size (thread/tokenUsage/updated: last.totalTokens). It used to be replaced on every load by
    // an estimate of the handoff briefing, which leaves out Codex's own turns, so a mostly-Codex
    // chat read ~1k tokens however long it ran.
    this.chat = chat;
    this.deps = deps; // { chatStore, workspaceDir, getModels, getPermissionMode, notify, notifyHistory, chatWindowManager }
    // Every window showing this chat (the sidebar's and any editor tabs). The run is the one source of truth;
    // a window only draws it, so they all stay in step. The last one is the window used most recently.
    this.hosts = new Set();
    this.pendingDelta = null; // reply text waiting to be sent, see postEvent()
    this.deltaTimer = null;
    this.lastDeltaAt = 0;
    this.activeAssistantMessage = null;
    this.turnAgent = null;
    this.turn = null; // the running turn's routing message, replayed when a window attaches
    this.pending = new Map(); // unanswered approval/question cards, replayed the same way
    this.queue = Array.isArray(chat.turnQueue?.turns) ? chat.turnQueue.turns.map((turn) => ({ ...turn, queued: true, editing: false, scheduling: false })) : [];
    this.queuePaused = chat.turnQueue?.paused === true;
    this.queueOrder = cleanQueueOrder(chat.turnQueue?.order);
    this.authHold = null; // { agent, resend }: the queue waits for this CLI to be signed in (lib/auth-gate.js); `resend` is the turn that hit the sign-in error
    this.starting = false; // a queued message is being planned; its turn hasn't begun yet
    this.planning = 0;
    this.startVersion = 0;
    this.subagentLog = []; // this chat's subagent events, for the agents viewer (not saved to disk)
    this.subagentLogBytes = 0;
    this.streamEngine = new StreamEngine({ cwd: deps.workspaceDir, chatId: chat.id, models: deps.getModels(), permissionMode: deps.getPermissionMode?.() || 'fullAccess', interactive: true });
    this.streamEngine.on('event', (event) => this.handleStreamEvent(event));
    // The chat's API value so far (api-cost.js). Chats saved before it was kept, or before the last pricing fix, get theirs rebuilt from their replies.
    if (!Number.isFinite(this.chat.apiCostUsd) || this.chat.apiCostV !== LEDGER_VERSION) {
      this.chat.apiCostUsd = chatTotal(this.chat, deps.getCostMeter?.()?.live?.prices);
      this.chat.apiCostV = LEDGER_VERSION;
    }
  }

  // Background agents count as running after the turn ends: the orb stays on the chat while they work.
  get waitingQuestion() { return this.chat.messages.find(entry => entry.event?.deferred && entry.event.type === 'question_required' && !entry.event.settled)?.event; }
  get state() { return this.waitingQuestion ? 'waiting' : !this.turn ? (this.externalCodexTurn || this.streamEngine.hasBackgroundAgents ? 'running' : null) : this.pending.size ? 'waiting' : 'running'; }
  requireProject() {
    if (!this.deps.projects) return;
    const context = this.deps.projects.context(this.chat.projectId);
    if (context.workspaceDir !== this.deps.workspaceDir) throw new Error('This project’s folder changed. Reopen the conversation to use its new location.');
  }
  /** The window to run a queued turn in: the one used most recently. */
  get host() { return [...this.hosts].at(-1) || null; }
  /** Sends to every window showing this chat (`except`: the one that already knows). */
  post(message, { except } = {}) {
    if (this.pendingDelta && message !== this.pendingDelta) this.flushDelta(); // nothing overtakes text that is waiting to go out
    for (const host of this.hosts) if (host !== except) host.panel.webview.postMessage(message);
  }
  /**
   * Reply text goes to the windows in batches: the page draws once per frame anyway, and every message is a trip through the
   * IDE's process boundary. The first chunk after a pause leaves at once; chunks that follow within DELTA_BATCH_MS join one message.
   * Anything else sent in between, a window attaching or replaying, flushes the batch first, so order and content never change.
   */
  postEvent(event) {
    const batchable = event.type === 'delta' && typeof event.text === 'string' && !event.block && !event.fallback;
    if (!batchable) { this.post(event); return; }
    const pending = this.pendingDelta;
    if (pending && Object.keys(event).every((key) => key === 'text' || pending[key] === event[key]) && Object.keys(pending).length === Object.keys(event).length) { pending.text += event.text; return; }
    this.flushDelta();
    if (Date.now() - this.lastDeltaAt >= DELTA_BATCH_MS) { this.lastDeltaAt = Date.now(); this.post(event); return; }
    this.pendingDelta = { ...event };
    this.deltaTimer = setTimeout(() => this.flushDelta(), DELTA_BATCH_MS);
    this.deltaTimer.unref?.();
  }
  flushDelta() {
    clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    const pending = this.pendingDelta;
    if (!pending) return;
    this.pendingDelta = null;
    this.lastDeltaAt = Date.now();
    this.post(pending);
  }
  retitle() {
    for (const host of this.hosts) host.panel.title = titleFor(this.chat);
    void this.deps.codexThreadTitles?.sync(this.chat, this.deps.projects?.get(this.chat.projectId));
  }
  /** Marks `host` as the window in use (it moves to the end of the set). */
  focus(host) { this.flushDelta(); this.hosts.delete(host); this.hosts.add(host); }
  /** A turn one window started: the others repaint with your message and the empty reply, then follow the stream. */
  syncWindows(origin) { for (const host of this.hosts) if (host !== origin) host.replay(); }
  save() {
    this.chat = this.deps.chatStore.save(this.chat);
    this.retitle();
  }
  /** The messages before the running turn's user message cannot change until it ends (an idle chat's never do); the store keeps their serialised form between checkpoints. */
  settledCount() {
    if (!this.activeAssistantMessage) return this.turn ? 0 : this.chat.messages.length;
    const at = this.chat.messages.lastIndexOf(this.activeAssistantMessage);
    return at > 0 ? at - 1 : 0;
  }

  /** Pushes the user message and the empty reply it streams into, then starts the agent. */
  begin({ agent, user, reply, routing, run }) {
    if (agent === 'codex' && !run.codexCommand) {
      const { attachmentPrompt } = require('./lib/attachments');
      user.codexInputHashes = [run.prompt, run.freshPrompt].filter(Boolean).map(prompt => inputHash(attachmentPrompt(prompt, run.attachments)));
    }
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
    const isFirstUserMessage = !this.chat.title && !this.chat.customTitle;
    if (isFirstUserMessage && user?.text) {
      void this.autoGenerateTitle(user.text);
    }
    if (!reply.compact) this.considerWorkContext(); // the category is predicted from the prompt as soon as it is sent
    // Confirm local sends too: a replay during planning may have replaced their optimistic bubble.
    if (user.clientTurnId || user.scheduled || user.pipelineBuild || user.queued) {
      for (const host of this.hosts) host.panel.webview.postMessage({ type: 'userMessage', clientTurnId: user.clientTurnId, text: user.text, at: user.at, scheduled: Boolean(user.scheduled), files: host.webviewFiles(user.attachments) });
    }
    this.turn = { ...routing, startedAt: Date.now() };
    this.post({ type: 'routing', ...routing });
    if (contextEstimate) this.post({ type: 'usage', agent, contextTokens: contextEstimate.tokens, estimated: true });
    this.streamEngine.models = this.deps.getModels();
    this.streamEngine.permissionMode = this.deps.getPermissionMode?.() || 'fullAccess';
    this.streamEngine.turnBases = null; // set again by start(), unless the turn goes to a process that is already running
    // The name `claude --resume` lists the session under in a terminal (Codex gets the same name over thread/name/set).
    this.streamEngine.sessionName = codexThreadTitle(this.chat, this.deps.projects?.get(this.chat.projectId));
    this.streamEngine.start(run);
    if (!reply.compact) this.deps.routing?.router.recordDestination?.(agent);
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

  // Restored runs can predate routing initialization; resolve the service from the manager.
  workContextService() { return (this.deps.chatWindowManager?.deps.routing || this.deps.routing)?.workContext; }

  /** A prompt was just sent (or a restored chat has no category yet): the rail re-reads what this chat is working on from the prompt, at once (lib/work-context.js; off unless the free-plan setting is on). */
  considerWorkContext({ initial = false } = {}) {
    this.workContextService()?.consider(this, { initial, project: this.chat.projectId || this.deps.workspaceDir, aliases: [this.deps.workspaceDir, this.deps.projects?.get(this.chat.projectId)?.name] });
  }

  /** Antigravity writes its own name partway through the first turn: that name is taken when the turn ends (adoptAgentTitle), not asked of Groq. */
  async autoGenerateTitle(promptText, { fallback = false } = {}) {
    if (this.titlePending) return;
    if (!fallback && chatNameSource() === 'agent' && hasAgentTitles(this.turnAgent)) return;
    this.titlePending = true;
    try {
      promptText = this.chat.messages.find((m) => m.role === 'user' && m.text?.trim())?.text || promptText;
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
    } finally {
      this.titlePending = false;
    }
  }

  /** A turn with an agent that names chats itself just ended: use its name, or Groq's when it wrote none (it can take a moment to appear). */
  async adoptAgentTitle(agent) {
    if (this.chat.title || this.chat.customTitle || this.titlePending || chatNameSource() !== 'agent' || !hasAgentTitles(agent)) return;
    const sessionId = this.chat.sessions?.[agent]?.id;
    let title = '';
    this.titlePending = true;
    try {
      for (let attempt = 0; attempt < 2 && !title; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, this.deps.agentTitleRetryMs ?? 2000));
        title = await readAgentTitle(agent, sessionId);
      }
      if (title && !this.chat.title && !this.chat.customTitle) {
        this.chat.title = title;
        this.save();
        this.deps.notifyHistory();
      }
    } finally {
      this.titlePending = false;
    }
    if (!title) await this.autoGenerateTitle(this.chat.messages.find((m) => m.role === 'user' && m.text?.trim())?.text || '', { fallback: true });
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
  beginRemoteTurn(text, background = false) {
    this.turnAgent = 'claude';
    const label = this.remote?.model?.label || this.chat.messages.findLast((message) => message.role === 'assistant' && message.agent === 'claude')?.modelLabel;
    // background: Claude started on its own (a background agent finished); nobody typed `text`.
    const user = { role: 'user', text, at: new Date().toISOString(), agent: 'claude', remote: true, ...(background ? { background: true } : {}) };
    const reply = { role: 'assistant', text: '', agent: 'claude', modelLabel: label, inProgress: true, hostPid: process.pid };
    this.chat.messages.push(user, reply);
    this.activeAssistantMessage = reply;
    this.chat.lastRunAt = new Date().toISOString();
    this.save();
    const isFirstUserMessage = !this.chat.title && !this.chat.customTitle;
    if (isFirstUserMessage && text && !background) {
      void this.autoGenerateTitle(text);
    }
    this.considerWorkContext();
    this.turn = { agentId: 'claude', modelLabel: label, startedAt: Date.now(), remote: true };
    this.post({ type: 'userMessage', text, at: user.at, background });
    this.post({ type: 'routing', agentId: 'claude', modelLabel: label });
    this.deps.notifyHistory();
  }

  /** The extension owns the queue; closing or switching a webview never stops it. */
  queueState() { return { turns: this.queue.filter((next) => next.queued), paused: this.queuePaused, ...(this.queueOrder.length ? { order: this.queueOrder } : {}) }; }
  /** The strip shows queued turns and scheduled prompts as one list; this is the order the user dragged it into ("turn:<id>" / "scheduled:<id>"). */
  setQueueOrder(order) {
    this.queueOrder = cleanQueueOrder(order);
    this.startVersion++;
    this.queueChanged();
    void this.drain();
  }
  queueChanged() {
    this.syncAwake();
    this.chat.turnQueue = this.queueState();
    this.save();
    for (const host of this.hosts) host.postTurnQueue();
    this.deps.notifyHistory();
  }
  syncAwake() {
    const needed = !this.disposed && (this.turn || this.starting || this.queue.length || this.streamEngine.hasBackgroundAgents);
    if (needed && !this.awake && this.deps.keepAwake) this.awake = this.deps.keepAwake();
    else if (!needed && this.awake) { this.awake.release(); this.awake = null; }
  }
  pauseQueue(paused) {
    this.queuePaused = Boolean(paused);
    this.queueChanged();
    if (!this.queuePaused) void this.drain();
  }
  stop() {
    this.startVersion++; // Stop also cancels an Auto decision still in flight.
    if (this.externalCodexTurn && !this.turn) {
      if (this.queue.length) this.pauseQueue(true);
      for (const host of this.hosts) host.replay({ synced: true });
      this.post({ type: 'notice', text: 'This turn is running in ChatGPT. Stop it there; Clanker will pick up the change automatically.' });
      return;
    }
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
    Object.assign(turn, { text: String(message.turn.text || ''), modelId: message.turn.modelId, attachments: safeAttachmentPaths(this.deps, message.turn.attachments), editing: message.editing === true,
      clientEditId: typeof message.turn.clientEditId === 'string' ? message.turn.clientEditId : undefined });
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

  /**
   * The prompt a limit reply answered when the limit stopped it before any work: it never ran, so it is scheduled again
   * (a task cut off midway is carried on by "continue" instead).
   */
  unrunPrompt(reply) {
    const at = this.chat.messages.indexOf(reply);
    const user = this.chat.messages[at - 1];
    if (at < 1 || user?.role !== 'user' || user.compact || !String(user.text || '').trim() || /^\s*continue\s*[.!]?\s*$/i.test(user.text)) return null;
    if (String(reply.text || '').trim().length > 400 || this.chat.messages.slice(at + 1).some((entry) => entry.role === 'tool')) return null;
    return { text: user.text, modelId: user.modelId, attachments: user.attachments };
  }

  async scheduleQueuedUntilReset(agent, noticeText, { continueTask = false, modelId, unrun = null, notBefore: savedReset } = {}) {
    const scheduler = this.deps.schedulerQueue;
    const turns = this.queue.filter((next) => next.queued && (!next.modelId || next.modelId === 'auto' || modelOption(next.modelId)?.agent === agent));
    if (!scheduler || (!turns.length && !continueTask && !unrun)) return;
    this.queue = this.queue.filter((next) => !turns.includes(next)); // out of the queue at once, so nothing starts behind the limit
    this.queueChanged();
    const quota = quotaFor(await readQuotas(), modelId, agent);
    const resetsAt = /weekly/i.test(noticeText) ? quota?.secondary?.resetsAt : quota?.resetsAt;
    // agy names its own reset ("Resets in 4h43m1s"); the rail's Gemini pool is not the one Claude and GPT run on through agy.
    const named = resetsInMs(noticeText);
    const notBefore = savedReset || (named !== null ? new Date(Date.now() + named).toISOString() : typeof resetsAt === 'number' && resetsAt * 1000 > Date.now() ? new Date(resetsAt * 1000).toISOString() : undefined);
    const front = []; // "continue", the prompt that never ran, then what was queued in the chat: all ahead of what was scheduled for this chat earlier
    if (continueTask) {
      try {
        front.push((await scheduler.enqueue({ model: agent, modelId: modelId || chatModelFor(this.chat, agent)?.id, prompt: 'continue', chatId: this.chat.id, projectId: this.chat.projectId, workspaceDir: this.deps.workspaceDir, dispatchTrigger: 'quota-reset', ...(notBefore ? { notBefore } : {}) })).id);
        this.post({ type: 'notice', text: 'Continue is scheduled for when usage resets.' });
      } catch (error) {
        this.post({ type: 'notice', text: `Could not schedule Continue: ${error.message}. Use Continue when the limit resets to try again.` });
      }
    }
    const schedule = (turn) => scheduler.enqueue({ model: agent, modelId: modelOption(turn.modelId)?.agent === agent ? turn.modelId : chatModelFor(this.chat, agent)?.id, prompt: turn.text, chatId: this.chat.id, projectId: this.chat.projectId, workspaceDir: this.deps.workspaceDir, dispatchTrigger: 'quota-reset', ...(notBefore ? { notBefore } : {}) }, safeAttachmentPaths(this.deps, turn.attachments));
    let rescheduled = 0;
    if (unrun) {
      try { front.push((await schedule(unrun)).id); rescheduled++; } catch (error) { this.post({ type: 'notice', text: `Could not schedule your last prompt again: ${error.message}` }); }
    }
    const failed = [];
    for (const turn of turns) {
      try {
        const task = await schedule(turn);
        front.push(task.id);
        this.queueOrder = this.queueOrder.map(key => key === `turn:${turn.id}` ? `scheduled:${task.id}` : key);
        rescheduled++;
      } catch { failed.push(turn); }
    }
    if (front.length > 1) {
      const mine =(await scheduler.getQueue()).filter((item) => item.status === 'pending' && item.chatId === this.chat.id && !front.includes(item.id));
      await scheduler.reorder([...front, ...mine.map((item) => item.id)]);
    }
    if (failed.length) this.queue.unshift(...failed); // could not be scheduled: they stay queued
    // The strip ranks by queueOrder and puts unranked prompts last: "continue" and the others must be ranked at the very top.
    if (front.length) this.queueOrder = [...front.map(id => `scheduled:${id}`), ...this.queueOrder.filter(key => !front.includes(key.slice(key.indexOf(':') + 1)))];
    this.queueChanged();
    this.deps.notifySchedulerQueue?.();
    if (rescheduled) this.post({ type: 'notice', text: `${rescheduled} prompt${rescheduled === 1 ? '' : 's'} will send when usage resets, one after the other.` });
  }

  /** FIFO: a message runs once every earlier one in this chat has finished. */
  enqueue(message) {
    if (message.queued && this.queue.some((next) => next.id === message.id)) return;
    if (/^\s*continue\s*[.!]?\s*$/i.test(message.text)) {
      this.queue.unshift(message);
      this.queueChanged();
      void this.drain();
      return;
    }
    this.queue.push(message);
    this.queueChanged();
    void this.drain();
  }

  pendingUsageReset(modelId) {
    const agent = modelOption(modelId)?.agent;
    if (!agent) return null;
    return this.deps.schedulerQueue?.tasks?.find(task => task.status === 'pending' && task.chatId === this.chat.id && task.model === agent
      && (agent !== 'gemini' || !task.modelId || !modelId || task.modelId === modelId)
      && task.dispatchTrigger === 'quota-reset' && Date.parse(task.notBefore) > Date.now()) || null;
  }

  /**
   * A queued, scheduled or "continue" prompt is about to go out and its CLI is signed out: it stays queued. The window shows
   * why and what fixes it; `authResolved` sends it once the CLI works again. `resend` is the turn that hit the sign-in error:
   * it goes to the front of the queue, so it is saved with the rest and survives a reload.
   */
  holdForAuth(agent, block, resend = null) {
    this.authHold = { agent };
    if (resend) { this.queue.unshift({ id: crypto.randomUUID(), text: resend.text, modelId: resend.modelId, attachments: resend.attachments || [], queued: true }); this.queueChanged(); }
    this.postAuthHold(block);
  }
  authHoldMessage(block) {
    return block ? { type: 'authHold', chatId: this.chat.id, ...block, held: this.queue.length } : { type: 'authHold', chatId: this.chat.id, cleared: true };
  }
  postAuthHold(block) { this.post(this.authHoldMessage(block)); }
  authChanged(block) { if (this.authHold?.agent === block.agent) this.postAuthHold(block); }
  authResolved(agent) {
    if (this.authHold?.agent !== agent) return;
    this.authHold = null;
    this.postAuthHold(null);
    void this.drain();
  }
  heldCount(agent) { return this.authHold?.agent === agent ? this.queue.length : 0; }
  /** What to send again after a sign-in error ended a turn: its prompt if no work happened, else "continue" (the session carries on). */
  resendAfterAuth(reply) {
    const at = this.chat.messages.indexOf(reply);
    const user = this.chat.messages[at - 1];
    if (at < 1 || user?.role !== 'user' || user.compact || !String(user.text || '').trim()) return { text: 'continue', modelId: this.chat.modelId };
    const worked = String(reply.text || '').trim().length > 400 || this.chat.messages.slice(at + 1).some((entry) => entry.role === 'tool');
    return worked ? { text: 'continue', modelId: user.modelId } : { text: user.text, modelId: user.modelId, attachments: safeAttachmentPaths(this.deps, user.attachments) };
  }

  drain() {
    if (this.turn || this.starting || this.externalCodexTurn || this.waitingQuestion || this.queuePaused || this.authHold || !this.queue.length) return;
    const scheduler = this.deps.schedulerQueue;
    // Scheduled prompts only order the queue. A scheduler file that cannot be read must not hold back what you queued yourself.
    if (scheduler && !scheduler.loaded && !this.schedulerUnreadable) {
      return scheduler.load().catch((error) => { this.schedulerUnreadable = true; console.error('[ai-chat-panel] scheduler queue unavailable, draining without it:', error.message); }).then(() => this.drain());
    }
    const tasks = scheduler?.loaded ? scheduler.tasks : [];
    const next = this.queue[0].queued ? firstPrompt(this.queueState(), tasks.filter(task => task.chatId === this.chat.id)) : this.queue[0];
    if (!this.queue.includes(next)) return; // the top scheduled prompt holds the rows beneath it
    this.queue.splice(this.queue.indexOf(next), 1);
    this.queue.unshift(next);
    if (next.editing || next.scheduling || !next.text.trim()) return;
    const waiting = !next.scheduled && this.pendingUsageReset(next.modelId);
    if (waiting) {
      return this.scheduleQueuedUntilReset(waiting.model, '', { notBefore: waiting.notBefore });
    }
    return this.startTurn({ ...next, steer: true }, { queued: next })
      .then((started) => { if (started === false) setImmediate(() => this.drain()); })
      .catch((error) => {
        log.error('queue', 'A queued turn failed to start:', error);
        this.post({ type: /out of usage/i.test(error.message) ? 'queueUsageWarning' : 'notice', chatId: this.chat.id, id: next.id, agent: modelOption(next.modelId)?.agent || this.activeAssistantMessage?.agent, text: 'Could not start the queued task: ' + error.message + ' It is still in the queue.' });
      })
      .finally(() => { this.deps.chatWindowManager.release(this); this.deps.notifyHistory(); });
  }

  async startTurn(message, { origin = null, queued = null } = {}) {
    const text = String(message.text || '').trim();
    if (!text) return;
    if (this.deps.codexChatSync && this.chat.sessions?.codex?.id) {
      const readVersion = ++this.startVersion;
      await this.deps.codexChatSync.sync(this);
      if (readVersion !== this.startVersion) return false;
    }
    if (this.externalCodexTurn) { if (!queued) this.enqueue({ ...message, text }); return false; }
    if (this.waitingQuestion) { this.enqueue({ ...message, text }); return; }
    this.requireProject();
    if (!queued) noteVoiceUse(text, this.chat.projectId);
    if (this.turn?.compact) { this.afterCompact = message; return; }
    if (message.steer === false && (this.turn || this.starting)) { this.enqueue({ ...message, text }); return; }
    const version = ++this.startVersion;
    this.planning++;
    this.starting = true;
    this.syncAwake();
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
      // A provider picked while its idle update is finishing starts on the new binary.
      await this.deps.waitForCliUpdate?.(plan.agent);
      // Look before sending what nobody is watching (queued, scheduled, "continue"): a signed-out CLI keeps it queued and says why.
      const blocked = queued ? await this.deps.authGate?.check(plan.agent) : null;
      // Pause, delete, or reorder during planning takes effect before a task starts.
      if (version !== this.startVersion || (queued && (queued.editing || this.turn || this.queuePaused || this.queue[0] !== queued))) return false;
      if (blocked) { if (this.deps.authGate.incident(plan.agent)) this.holdForAuth(plan.agent, blocked); return false; } // false: drain looks again, and holds or sends
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
      this.syncAwake();
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

  rememberSubagent(event) {
    this.subagentLog.push(event);
    this.subagentLogBytes = (this.subagentLogBytes || 0) + Buffer.byteLength(JSON.stringify(event));
    while (this.subagentLog.length && (this.subagentLog.length > SUBAGENT_LOG_LIMIT || this.subagentLogBytes > 2 * 1024 * 1024)) {
      this.subagentLogBytes -= Buffer.byteLength(JSON.stringify(this.subagentLog.shift()));
    }
  }

  handleStreamEvent(event) {
    if (event.type === 'turn_complete') this.streamEngine.bridgeAgents?.poll(this.streamEngine.cwd);
    // Subagents live in the agents viewer, not the reply: kept here (in memory) so a
    // window that attaches later, or switches back to this chat, can replay them.
    if (event.type.startsWith('subagent_')) {
      const stamped = { ...event, at: Date.now() };
      this.rememberSubagent(stamped);
      this.post(stamped);
      // Once the last background agent settles (after the engine has let go of its process) the orb goes and the chat can be freed.
      if (!this.turn && event.type !== 'subagent_event') setTimeout(() => { this.deps.chatWindowManager.release(this); this.deps.notifyHistory(); }, 0);
      return;
    }
    // Replays need the turn's end too, or its foreground agents would read as working forever.
    if (event.type === 'turn_complete' && this.subagentLog.length) this.rememberSubagent({ type: 'subagent_settle', interrupted: Boolean(event.interrupted) });
    this.deps.onTelegramEvent?.(this, event);
    if (event.type === 'rate_limits' && event.agent === 'claude') recordClaudeUsage(event.windows);
    if (event.type === 'remote_prompt') { this.beginRemoteTurn(event.text, Boolean(event.background)); return; }
    if (event.type === 'remote_state') {
      // The live process ended or the bridge dropped: say so, and fall back to per-turn runs.
      if (event.state === 'ended' && this.remote) { this.remote = null; this.post({ type: 'remoteState', on: false }); this.post({ type: 'notice', text: 'Remote Control ended (the Claude process exited). Send /remote-control to start it again.' }); }
      if ((event.state === 'disconnected' || event.state === 'failed') && this.remote) this.post({ type: 'notice', text: `Remote Control ${event.state}; Claude Code reconnects on its own when it can.` });
      return;
    }
    if (event.type === 'upstream_error' && event.agent === this.turnAgent && LIMIT_RE.test(event.detail || '')) this.limitNotice = event.detail;
    if (event.type === 'session' && event.agent === 'claude' && this.deps.slashCommands?.recordClaude(event.slashCommands)) {
      void this.deps.slashCommands.list().then((commands) => this.post({ type: 'slashCommands', commands }));
    }
    if (event.type === 'session' && event.sessionId && this.turnAgent === event.agent) {
      this.chat.sessions = { ...this.chat.sessions, [event.agent]: { ...this.chat.sessions?.[event.agent], id: event.sessionId } };
      if (event.agent === 'codex') this.retitle();
    }
    // Everything up to here is in that agent's own session now.
    if (event.type === 'turn_complete' && this.turnAgent && this.chat.sessions?.[this.turnAgent]) {
      if (this.turnAgent === 'codex' && event.codexTurnId) this.chat.codexSync = { threadId: this.chat.sessions.codex.id, turnId: event.codexTurnId };
      this.chat.sessions[this.turnAgent].seen = this.chat.messages.length;
      void this.adoptAgentTitle(this.turnAgent).catch(() => {}); // a missing name is not an error: the chat keeps its first-words name
      this.turnAgent = null;
    }
    // agy gave only the turn's new tokens: the conversation is that much longer than before.
    if (event.type === 'usage' && event.contextGrowth) {
      const before = this.chat.context?.agent === event.agent ? this.chat.context.tokens || 0 : 0;
      event.contextTokens = Math.min(CONTEXT_LIMITS[event.agent] || 1000000, before + event.contextGrowth);
    }
    if (event.type === 'usage' && this.turnAgent === event.agent) this.chat.context = { agent: event.agent, tokens: event.contextTokens }; // P17-R: saved with the turn
    if (event.type === 'delta' && this.activeAssistantMessage) this.activeAssistantMessage.text += event.text;
    // `offset`: how much reply text came before this tool, so a reload shows them in order.
    if (event.type === 'tool_start') {
      if (!event.done && !Number.isFinite(event.startedAt)) event.startedAt = Date.now();
      this.chat.messages.push({ role: 'tool', event, offset: this.activeAssistantMessage?.text.length, done: Boolean(event.done), ...(Number.isFinite(event.startedAt) ? { startedAt: event.startedAt } : {}) });
    }
    if (event.type === 'question_required' && event.deferred) {
      event.modelId = this.activeAssistantMessage?.modelId || AVAILABLE_MODELS.find(option => option.agent === event.agent && option.label === this.activeAssistantMessage?.modelLabel)?.id || this.chat.modelId;
      this.chat.messages.push({ role: 'tool', event, offset: this.activeAssistantMessage?.text.length, done: true });
      this.save();
    }
    // Results and failed steps survive reloads along with their text position.
    if (event.type === 'tool_end') recordToolEnd(this.chat, event);
    if (event.type === 'turn_complete') {
      for (const entry of this.chat.messages) {
        const startedAt = entry.startedAt ?? entry.event?.startedAt;
        if (entry.role === 'tool' && entry.done === false && !Number.isFinite(entry.durationMs) && Number.isFinite(startedAt)) {
          entry.durationMs = Math.max(0, Date.now() - startedAt);
          if (entry.event) entry.event.durationMs = entry.durationMs;
        }
      }
    }
    // A background chat waiting on you shows as "Needs input" in Manage Chats.
    if ((event.type === 'approval_required' || event.type === 'question_required') && !event.deferred) { this.pending.set(event.actionId, event); this.deps.notifyHistory(); }
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
        if (!reply.compact && !more) this.deps.notify?.(reply.agent, textAfterLastTool(reply, this.chat.messages), this.chat.title || this.chat.messages.find((entry) => entry.role === 'user')?.text?.slice(0, 40), { chime: !scheduled });
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
        this.chat.apiCostV = LEDGER_VERSION;
        if (this.activeAssistantMessage && cost) this.activeAssistantMessage.apiCost = { usd: cost.usd, source: cost.source, model: turnModel };
        meter.record(turnAgent, cost);
        if (!cost && turnModel) void meter.refreshPrices([turnModel]); // a model the tables did not know yet
      }
      event.chatCostUsd = this.chat.apiCostUsd;
      // The model said its limit is used up: what is queued for it would only fail one after another, so it becomes scheduled
      // prompts for the reset, in the same order (and goes out one after another then, as ordinary queued ones).
      const reply = this.activeAssistantMessage;
      const limitNotice = this.limitNotice || (isLimitNotice(reply?.text) ? reply.text : null);
      this.limitNotice = null;
      // The plan ended, credits ran out or the sign-in broke: this CLI drops out of the picker, the rail and Auto until it is tried again.
      const outage = !event.interrupted && reply && !reply.compact ? accessFailure(reply.text) : null;
      if (outage) this.pipeline = null; // A failed architect response must never become a build plan.
      // A sign-in that ended mid-run is not a lost CLI: the popup offers the browser sign-in, and the turn that hit it (or
      // "continue" after partial work) is sent again with whatever waits behind it once you are signed in.
      if (outage?.kind === 'blocked') {
        this.pauseQueue(true);
        const resend = this.resendAfterAuth(reply);
        this.queue.unshift({ id: crypto.randomUUID(), ...resend, attachments: resend.attachments || [], queued: true });
        this.queueChanged();
        void this.deps.cliAccounts?.markUnavailable(reply.agent, outage);
        this.post({ type: 'notice', text: `${outage.reason} The provider rejected the request before a normal API response. This does not establish that your login expired. Queue paused; the failed task is kept first and no follow-up will be sent automatically. Check https://status.claude.com/ before allowing a retry and resuming the queue.` });
      } else if (outage?.kind === 'auth' && this.deps.authGate) this.holdForAuth(reply.agent, this.deps.authGate.expired(reply.agent, outage.detail), this.resendAfterAuth(reply));
      else if (outage) { this.pauseQueue(true); void this.deps.cliAccounts?.markUnavailable(reply.agent, outage); }
      // A CLI that dies with an exit code (not signed in, damaged install) turns its usage ring red: re-check it now, not at the next 30-minute round.
      else if (!event.interrupted && /\bexited with code [1-9]/i.test(reply?.text || '')) void this.deps.cliAccounts?.check();
      const autoContinue = vscode.workspace.getConfiguration('aiChatPanel').get('autoContinueOnLimit', true);
      if (!event.interrupted && reply && !reply.compact && limitNotice) void this.scheduleQueuedUntilReset(reply.agent, limitNotice, {
        continueTask: autoContinue,
        modelId: AVAILABLE_MODELS.find(option => option.agent === reply.agent && option.label === reply.modelLabel)?.id,
        unrun: autoContinue ? this.unrunPrompt(reply) : null,
      });
      undoCount = this.recordUndo(this.activeAssistantMessage);
      this.continuePipeline(event, this.activeAssistantMessage);
      if (event.interrupted && this.activeAssistantMessage) this.activeAssistantMessage.interrupted = true;
      this.chat.lastRunAt = new Date().toISOString();
      this.chat.taskState = taskState(this.chat.messages);
      this.save();
      this.activeAssistantMessage = null;
      this.turn = null;
      this.pending.clear();
    }
    // Session IDs and tool boundaries are saved within moments, text and context during the turn even when no window shows it.
    // All go through the throttled, off-thread checkpoint: a full synchronous save of a long chat (stringify, fsync, parse of
    // the old file) used to stall the whole extension host at every tool call.
    const delay = event.type === 'session' ? 0 : event.type === 'tool_start' || event.type === 'tool_end' ? 50 : undefined;
    if (delay !== undefined || event.type === 'delta' || event.type === 'usage') this.deps.chatStore.checkpoint(this.chat, { settled: this.settledCount(), delay });
    if (event.type === 'session') this.retitle();
    this.postEvent(autoCompact ? { ...event, compacting: true } : event);
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
    this.syncAwake();
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
/** Webview messages sent too often (each keystroke, each scroll) to be worth a debug line each. */
const QUIET_MESSAGES = new Set(['composerActivity', 'saveDraft', 'saveScroll', 'requestQuotas', 'requestFleet', 'requestApiValue', 'windowActive']);

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
    this.investigationBridge = createInvestigationBridge({
      getInvestigations: () => { const installed = deps.chatWindowManager.deps.investigations; return installed?.manager ? installed : null; },
      getOptions: () => this.investigationOptions(),
      review: request => this.reviewInNewChat(request),
      post: (message) => panel.webview.postMessage(message),
    });
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
    this.logsOpen = false; // whether this window's Logs popup is showing, and so wants each new entry
    panel.webview.onDidReceiveMessage((message) => this.receive(message));
    panel.webview.html = this.renderHtml(panel.webview, run);
    panel.onDidDispose(() => {
      this.investigationBridge.dispose();
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

  /**
   * Every message from the webview comes through here, so a handler that throws (a button "doing nothing") ends up in
   * the log with the message that caused it instead of disappearing as an unhandled rejection.
   */
  receive(message) {
    const type = typeof message?.type === 'string' ? message.type : '(no type)';
    if (this.handleLogMessage(message)) return;
    if (!QUIET_MESSAGES.has(type)) log.debug('message', `← ${type}${message?.chatId ? ` (chat ${String(message.chatId).slice(0, 8)})` : ''}`);
    let pending;
    try { pending = this.handleMessage(message); }
    catch (error) { log.error('message', `Handling "${type}" failed:`, error); return; }
    if (pending && typeof pending.then === 'function') pending.then(undefined, error => log.error('message', `Handling "${type}" failed:`, error));
  }
  /** The Logs popup's own messages, and the errors media/error-report.js sends. */
  handleLogMessage(message) {
    switch (message?.type) {
      case 'clientLog': log.fromWebview(message); return true;
      case 'logsSubscribe': this.logsOpen = true; void this.panel.webview.postMessage({ type: 'logEntries', entries: log.entries() }); return true;
      case 'logsUnsubscribe': this.logsOpen = false; return true;
      case 'openLogs': void this.panel.webview.postMessage({ type: 'openLogs' }); return true;
      case 'clearLogs': log.clear(); return true;
      case 'showLogOutput': log.channel()?.show(true); return true;
      case 'copyText': if (typeof message.text === 'string') void vscode.env.clipboard.writeText(message.text); return true;
      case 'askAboutLogEntry': {
        const entry = log.entries().find(item => item.id === message.id);
        if (!entry) return true;
        const text = `Something went wrong in Clanker Controller. Find the cause and fix it. This is the log entry:\n\n\`\`\`\n${log.format([entry])}\n\`\`\``;
        void this.panel.webview.postMessage({ type: 'prefillPrompt', text, closeLogs: true });
        return true;
      }
      default: return false;
    }
  }

  async handleMessage(message) {
    switch (message.type) {
      // Initial postMessage calls can precede the webview's message listener,
      // especially when several editor/pop-out windows restore together.
      case 'chatReady':
        this.replay();
        this.postHistory();
        void this.pushRoutingMode();
        void this.pushSchedulerQueue();
        this.panel.webview.postMessage({ type: 'setActive', modelId: this.activeModelId });
        break;
      // Picking a model in the composer stays headless: it never reveals the
      // real VS Code terminal (only the Terminal button does). 'auto' is the
      // routing preference for the next `send`.
      case 'setModel': this.selectModel(message.modelId); break;
      case 'composerActivity': this.typingAt = Date.now(); break;
      // Settings > Loops: validated requests to the investigation manager (lib/investigation-bridge.js).
      case 'investigations': void this.investigationBridge.handle(message); break;
      // The composer's smart-routing switch. Every window and the settings pane follow through routing.onDidChange.
      case 'setRoutingMode': void this.deps.routing?.setMode(message.mode).catch(() => this.pushRoutingMode()); break;
      case 'requestRoutingMode': void this.pushRoutingMode(); break;
      case 'send': await this.startTurn(message); break;
      case 'saveDraft': {
        if (message.chatId !== this.chat.id || typeof message.text !== 'string') break;
        this.chat.draft = message.text;
        if (message.userInput === true && message.text.length) this.chat.textEntered = true;
        // Attached files are part of the draft: a chat holding only images must not read as empty.
        if (Array.isArray(message.attachments)) {
          const files = this.safeAttachmentPaths(message.attachments.filter(file => typeof file === 'string'));
          if (files.length) this.chat.draftAttachments = files; else delete this.chat.draftAttachments;
        }
        delete this.chat.hasTypedMessage;
        this.deps.chatStore.checkpoint(this.chat, { settled: this.run.settledCount() });
        break;
      }
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
      case 'deferredQuestionSettled': {
        const stored = this.chat.messages.find(entry => entry.event?.type === 'question_required' && entry.event.deferred && entry.event.actionId === message.actionId);
        if (!stored || stored.event.settled) break;
        stored.event.settled = { text: String(message.settled?.text || ''), tone: message.settled?.tone === 'allowed' ? 'allowed' : 'denied' };
        if (stored.event.settled.tone === 'allowed') {
          const text = stored.event.questions.map(q => `${q.question}\n${String(message.answers?.[q.question] || '')}`).join('\n\n');
          this.run.queue.unshift({ id: crypto.randomUUID(), text, modelId: stored.event.modelId, attachments: [], queued: true, verify: message.verify === true });
          this.run.queueChanged();
        }
        this.run.save();
        this.run.post({ type: 'cardSettled', actionId: message.actionId, ...stored.event.settled }, { except: this });
        this.deps.notifyHistory();
        void this.run.drain();
        break;
      }
      case 'newChat': this.resetToFreshChat(); break;
      case 'requestProject': this.postProject(); break;
      case 'chooseProject': await this.chooseProject(); break;
      case 'addProject': { const project = await this.addProject(); if (project) { this.postProject(); await this.openProject(project); } break; }
      case 'removeProject': await this.removeProject(message.projectId); break;
      case 'renameProject': await this.renameProject(message.projectId, message.name); break;
      case 'openProject': { const project = this.deps.projects?.get(message.projectId); if (project && project.id !== this.chat.projectId) await this.openProject(project); break; }
      case 'pinProject': await this.pinProject(message.projectId, message.pinned); break;
      case 'manageProjects': await this.manageProjects(); break;
      case 'requestHistory': this.postHistory(); break;
      case 'restoreChat': this.restoreChat(message.id); break;
      case 'deleteChat': this.deps.chatWindowManager.deleteChat(message.id); break;
      case 'renameChat': this.deps.renameChat(message.id, message.title); break;
      case 'setChatCategory': {
        const run = this.deps.chatWindowManager.runs.get(message.id);
        const chat = run?.chat || this.deps.chatStore.load(message.id);
        if (!chat) break;
        const { CATEGORIES } = require('./lib/work-context.js');
        const choice = await vscode.window.showQuickPick([{ label: 'Automatic', id: null }, ...CATEGORIES.map(c => ({ label: c.label, id: c.id }))], { placeHolder: 'Choose this chat’s work category' });
        if (!choice) break;
        if (choice.id) chat.workContext = { version: 1, categoryId: choice.id, manual: true, updatedAt: new Date().toISOString() };
        else delete chat.workContext;
        if (run) { run.save(); if (!choice.id) run.considerWorkContext({ initial: true }); }
        else this.deps.chatStore.save(chat);
        this.deps.notifyHistory();
        break;
      }
      case 'pickAttachments': await this.pickAttachments(message); break;
      case 'attachmentData': await this.saveAttachment(message); break;
      case 'removeAttachment': this.removeAttachment(message.path); break;
      case 'renameAttachment': this.renameAttachment(message.path, message.name); break;
      case 'saveMarkup': this.saveMarkup(message); break;
      case 'downloadAttachment': await this.downloadAttachment(message.path, message.name); break;
      case 'copyAttachment': await this.copyAttachment(message.path, { silent: message.silent === true }); break;
      case 'queueTurn': {
        const run = this.deps.chatWindowManager.runFor(message.chatId);
        const turn = message.turn;
        if (run && turn?.id && typeof turn.text === 'string' && turn.text.trim()) run.enqueue({ id: String(turn.id), text: turn.text, modelId: turn.modelId, attachments: safeAttachmentPaths(this.deps, turn.attachments), verify: Boolean(turn.verify), pipeline: Boolean(turn.pipeline), queued: true,
          clientEditId: typeof turn.clientEditId === 'string' ? turn.clientEditId : undefined });
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
          let turn = message.turn;
          if (!message.editing && turn?.modelId === 'auto') {
            try {
              const routed = route(String(turn.text || task?.prompt || ''), await readQuotas(), 'auto', this.deps.cliAccounts?.enabledAgents());
              if (routed?.modelId) turn = { ...turn, modelId: routed.modelId };
            } catch { /* keep the task's current model if Auto has no usable favorite */ }
          }
          let schedule = !message.editing && message.schedule && ['fixed-time', 'quota-reset'].includes(message.schedule.dispatchTrigger) ? { ...message.schedule } : null;
          if (schedule?.dispatchTrigger === 'quota-reset') {
            const targetModelId = turn?.modelId && turn.modelId !== 'auto' ? turn.modelId : task?.modelId;
            const targetModel = modelOption(targetModelId)?.agent || task?.model;
            const targetRun = (task?.chatId && this.deps.chatWindowManager?.runFor(task.chatId)) || this.run;
            const notBefore = targetModel ? await this.quotaResetNotBefore({ model: targetModel, modelId: targetModelId, resetWindow: schedule.resetWindow }, targetRun) : null;
            if (notBefore) schedule.notBefore = notBefore;
          }
          await this.deps.schedulerQueue.saveDraft(message.taskId, turn, safeAttachmentPaths(scope, turn?.attachments), message.editing, { clearReset: message.clearReset === true, ...(schedule ? { schedule } : {}) });
          if (!message.editing) this.scheduledEdits?.delete(message.taskId);
          this.deps.notifySchedulerQueue?.(!message.editing);
        } catch (error) { this.panel.webview.postMessage({ type: 'scheduleTaskFailed', error: error.message }); }
        break;
      }
      case 'reorderQueuedTurns': this.deps.chatWindowManager.runFor(message.chatId)?.reorderQueuedTurns(message.ids); break;
      case 'setQueueOrder': this.deps.chatWindowManager.runFor(message.chatId)?.setQueueOrder(message.order); break;
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
        const queued = run?.queue.find(turn => turn.id === message.id);
        const waiting = queued && !queued.scheduled && run.pendingUsageReset(queued.modelId);
        if (waiting) {
          await run.scheduleQueuedUntilReset(waiting.model, '', { notBefore: waiting.notBefore });
          break;
        }
        const turn = run?.removeQueuedTurn(message.id);
        if (turn) await run.startTurn({ ...turn, steer: true });
        break;
      }
      case 'openFile': await this.openFile(message.path, message.line); break;
      case 'previewFile': await this.previewFile(message.path, message.requestId); break;
      case 'copyFilePath': await this.copyFileRef(message.path, message.mode); break;
      case 'openUrl': if (/^(https?:|mailto:)/i.test(String(message.url || ''))) void vscode.env.openExternal(vscode.Uri.parse(message.url)); break;
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
      case 'windowActive': this.deps.chatWindowManager.setActive(this); break;
      case 'micToggle': await this.handleMicToggle(); break;
      case 'micCancel': await this.handleMicCancel(); break;
      case 'polishPrompt': await this.polishPrompt(message); break;
      case 'voiceDraftEdited': {
        const known = new Set(voiceDictionary.listEnabledTerms(voicePaths()));
        const terms = learnedTerms(message.original, message.edited).filter(term => term.length <= 60 && !known.has(term));
        this.panel.webview.postMessage({ type: 'voiceDictionarySuggestions', requestId: message.requestId, terms });
        break;
      }
      case 'voiceDictionarySave': await this.learnVoiceCorrections(message.original, message.edited, message.term, message.requestId); break;
      case 'scheduleTask': await this.scheduleTask(message); break;
      case 'authAction': if (providers.has(message.agent)) void this.deps.authGate?.act(message.agent); break; // the sign-in banner's main button
      case 'authRecheck': if (providers.has(message.agent)) void this.deps.authGate?.recheck(message.agent); break;
      case 'scheduleQueuedTurn': {
        const run = this.deps.chatWindowManager.runFor(message.chatId);
        const turn = run?.queue.find(item => item.queued && item.id === message.id);
        if (!turn || turn.scheduling) break;
        turn.scheduling = true;
        turn.editing = true; // Hold its slot until the scheduled copy is safely persisted.
        const draft = message.turn || turn;
        const model = modelOption(draft.modelId)?.agent || message.task?.model || message.agent || chatModelFor(run.chat, 'claude')?.agent || 'claude';
        const saved = await this.scheduleTask({ task: { ...message.task, model, modelId: draft.modelId === 'auto' ? undefined : draft.modelId, prompt: draft.text, dispatchTrigger: message.task?.dispatchTrigger || 'quota-reset' }, attachments: draft.attachments, run });
        if (saved) run.removeQueuedTurn(turn.id);
        else { delete turn.scheduling; turn.editing = false; run.queueChanged(); }
        this.queueEdits?.delete(`${message.chatId}:${turn.id}`);
        break;
      }
      case 'scheduleMode': this.deps.setScheduleMode?.(message.mode); break; // the mode the last scheduled prompt used
      case 'remoteControl': void this.run.toggleRemote(); break;
      case 'undoTurn': void this.undoLastTurn(); break;
      case 'requestChatHistory': {
        if (message.chatId !== this.chat.id || !Number.isSafeInteger(message.before) || message.before <= 0 || message.before > this.chat.messages.length) break;
        const page = historyPage(this.chat.messages, message.before);
        this.panel.webview.postMessage({ type: 'chatHistory', chatId: this.chat.id, requestId: message.requestId, ...page, messages: this.webviewMessages(page.messages) });
        break;
      }
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
      case 'unscheduleToComposer': await this.takeScheduledTask(message.taskId, false, message.chooseModel === true); break;
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

  async scheduleTask({ task, attachments, run = this.run } = {}) {
    // A limit-reset "continue" belongs to this chat (the webview may not know a fresh chat's id yet).
    // A scheduled prompt belongs to the chat it was written in (it comes back there, in the queue strip) and a "continue"
    // goes in front of the others.
    task = { ...task, chatId: run.chat.id, projectId: run.chat.projectId, workspaceDir: run.deps.workspaceDir, modelId: task.modelId || chatModelFor(run.chat, task.model)?.id };
    try {
      const scope = this.deps.projects?.context(run.chat.projectId) || run.deps;
      const continuing = /^\s*continue\s*[.!]?\s*$/i.test(task.prompt);
      if (continuing) {
        const existing = (await this.deps.schedulerQueue.getQueue()).find(item => item.chatId === task.chatId && item.model === task.model && ['pending', 'dispatched', 'interrupted'].includes(item.status) && /^\s*continue\s*[.!]?\s*$/i.test(item.prompt));
        const lastLimit = run.chat.messages.findLastIndex(item => item.role === 'assistant' && isLimitNotice(item.text));
        if (existing || (lastLimit >= 0 && run.chat.messages.slice(lastLimit + 1).some(item => item.role === 'user' && /^\s*continue\s*[.!]?\s*$/i.test(item.text)))) {
          this.panel.webview.postMessage({ type: 'taskScheduled' });
          this.deps.notifySchedulerQueue?.();
          return true;
        }
      }
      // "When the usage resets" waits for that moment even while there is quota left; without this a prompt scheduled with
      // 3 hours to go was sent within seconds, because the watchdog only asked whether usage was available.
      if (task?.dispatchTrigger === 'quota-reset') {
        const notBefore = await this.quotaResetNotBefore(task, run);
        if (notBefore) task = { ...task, notBefore };
      }
      const saved = await this.deps.schedulerQueue.enqueue(task, safeAttachmentPaths(scope, attachments));
      if (continuing) {
        const mine = (await this.deps.schedulerQueue.getQueue()).filter((item) => item.status === 'pending' && item.chatId === task.chatId && item.id !== saved.id);
        await this.deps.schedulerQueue.reorder([saved.id, ...mine.map((item) => item.id)]);
      }
      this.panel.webview.postMessage({ type: 'taskScheduled' });
      this.deps.notifySchedulerQueue?.();
      return true;
    } catch (error) {
      this.panel.webview.postMessage({ type: 'scheduleTaskFailed', error: error.message });
      return false;
    }
  }

  /** Resolves the reset deadline ISO string for a quota-reset task from the latest limit notice or live quota. */
  async quotaResetNotBefore(task, run = this.run) {
    const quota = quotaFor(await readQuotas(), task.modelId, task.model);
    const resetsAt = task.resetWindow === '7d' ? quota?.secondary?.resetsAt : quota?.resetsAt; // the week's reset, or the 5-hour window's
    const lastReply = run?.chat?.messages?.findLast(item => item.role === 'assistant');
    const sameSource = lastReply && lastReply.agent === task.model && (task.model !== 'gemini' || !lastReply.modelLabel || !task.modelId || modelOption(task.modelId)?.label === lastReply.modelLabel);
    const named = sameSource && isLimitNotice(lastReply.text) ? resetsInMs(lastReply.text) : null; // the limit notice's own reset time wins
    const namedAt = named === null ? 0 : (Date.parse(lastReply.at) || Date.now()) + named;
    if (namedAt > Date.now()) return new Date(namedAt).toISOString();
    if (typeof resetsAt === 'number' && resetsAt * 1000 > Date.now()) return new Date(resetsAt * 1000).toISOString();
    return null;
  }

  /** P17-Z: a pending task leaves the queue for this window, back into the composer or straight out through the auto-router. */
  async takeScheduledTask(taskId, sendNow, chooseModel = false) {
    const task = (await this.deps.schedulerQueue.getQueue()).find((item) => item.id === taskId && item.status === 'pending');
    if (!task) return;
    if (sendNow && task.dispatchTrigger === 'quota-reset') {
      const quota = quotaFor(await readQuotas(), task.modelId, task.model);
      if (Date.parse(task.notBefore) > Date.now() || quota?.remaining === 0 || quota?.secondary?.remaining === 0) {
        this.panel.webview.postMessage({ type: 'notice', text: 'This prompt is waiting for its usage reset. It remains scheduled.' });
        return;
      }
    }
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
    const schedule = {
      dispatchTrigger: task.dispatchTrigger,
      ...(task.dispatchTime ? { dispatchTime: task.dispatchTime } : {}),
      ...(task.resetWindow ? { resetWindow: task.resetWindow } : {}),
      ...(task.notBefore ? { notBefore: task.notBefore } : {}),
    };
    this.panel.webview.postMessage({ type: 'restoreScheduledDraft', taskId: task.id, text: task.prompt, files, sendNow: Boolean(sendNow), modelId, chooseModel, schedule });
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
      if (project) await this.openProject(project);
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  /** Binds this chat (or opens the project's latest chat) to `project`; the picker and the rail's project list both land here. */
  async openProject(project) {
    try {
      const manager = this.deps.chatWindowManager;
      manager.selectedProjectId = project.id;
      void manager.deps.sidebarState?.update('selectedProjectId', project.id);
      this.panel.webview.postMessage({ type: 'chatLoading' });
      // A chat without a project, or a fresh one nothing was sent in, moves to the clicked project (keeping the picked model);
      // a chat with history opens the project's latest chat instead.
      if (this.chat.projectId === project.id) this.replay();
      else if (!this.chat.projectId || manager.isUntouched(this.run)) {
        const previous = this.run;
        const run = manager.bindProject(previous, project.id);
        for (const host of [...previous.hosts]) host.attach(run);
        if (this.run !== run) this.attach(run);
      } else {
        const recent = manager.listChats().find(chat => chat.projectId === project.id);
        this.attach(manager.runFor(recent?.id || null, project.id));
      }
      this.postHistory();
      // Opening a project shows its folder in the Explorer, adding it to the workspace if needed.
      if (project.root) await this.openProjectExplorer(project.id);
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  /** Renames a project from its card on the rail; the folder and the chats bound to it are untouched. */
  async renameProject(id, name) {
    try {
      if (!String(name || '').trim()) return;
      this.deps.projects?.update(id, { name });
      for (const entry of this.deps.chatStore.list().filter(chat => chat.projectId === id && chat.models.includes('codex'))) {
        const chat = this.deps.chatWindowManager.runs.get(entry.id)?.chat || this.deps.chatStore.load(entry.id);
        if (chat) void this.deps.codexThreadTitles?.sync(chat, this.deps.projects.get(id));
      }
      for (const host of this.deps.chatWindowManager.hosts) host.postProject();
      this.deps.notifyHistory();
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  /** Takes a project off the rail after a confirmation; never touches its folder, and never the one this chat is bound to. */
  async removeProject(id) {
    try {
      const project = this.deps.projects?.get(id);
      if (!project || project.id === this.chat.projectId) return;
      const manager = this.deps.chatWindowManager;
      const runs = [...manager.runs.values()].filter(run => run.chat.projectId === id);
      if (runs.some(run => run.turn || run.starting || run.remote || run.streamEngine.hasBackgroundAgents)) throw new Error('Finish or stop this project’s running work before removing it.');
      const bound = manager.listChats().filter(chat => chat.projectId === id).length;
      const confirmed = await vscode.window.showWarningMessage(`Remove "${project.name}" from Clanker?`, { modal: true, detail: `Its folder is not touched.${bound ? ` ${bound} chat${bound === 1 ? '' : 's'} bound to it will ask for another project when opened.` : ''}` }, 'Remove');
      if (confirmed !== 'Remove') return;
      this.deps.projects.remove(id);
      for (const host of manager.hosts) host.postProject();
      this.deps.notifyHistory();
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
      // Persist while the host still exists; a restart need not call dispose().
      for (const run of manager?.runs.values() || []) run.save();
      if (this.deps.watchdog?.chat) this.deps.chatStore.save(this.deps.watchdog.chat);
      const added = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri, name: project.name });
      if (!added) throw new Error('VS Code could not add this folder. Use File > Add Folder to Workspace.');
    }
    await vscode.commands.executeCommand('workbench.view.explorer');
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  projectPins() {
    const projects = this.deps.projects?.list() || [];
    const saved = this.deps.projectPinStore?.get();
    return (Array.isArray(saved) ? saved : [])
      .filter((id, index, ids) => projects.some(project => project.id === id) && ids.indexOf(id) === index).slice(0, 2);
  }
  async pinProject(id, pinned) {
    if (!this.deps.projects?.get(id) || typeof pinned !== 'boolean' || !this.deps.projectPinStore) return;
    const ids = this.projectPins().filter(projectId => projectId !== id);
    if (pinned && ids.length >= 2) {
      this.panel.webview.postMessage({ type: 'notice', text: 'Unpin a favorite before pinning another. The current project always has its own slot.' });
      return;
    }
    if (pinned) ids.push(id);
    try {
      await this.deps.projectPinStore.set(ids);
      for (const host of this.deps.chatWindowManager.hosts) host.postProject();
    } catch (error) {
      this.panel.webview.postMessage({ type: 'notice', text: `Could not save project favorites: ${error.message}` });
      this.postProject();
    }
  }
  postProject() {
    if (!this.deps.projects) return;
    const project = this.deps.projects.get(this.chat.projectId);
    const projects = this.deps.projects.list().map(describeProject);
    this.panel.webview.postMessage({ type: 'project', project, projects, pinnedProjectIds: this.projectPins(), chatId: this.chat.id, required: !project });
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
  replay({ synced = false } = {}) {
    const run = this.run;
    run.flushDelta(); // the replay below already holds this text; the windows that showed the chat before it need it first
    this.panel.title = titleFor(run.chat);
    // The picker follows the chat: the model it last ran on (older chats: the last reply's model label).
    const lastReply = [...run.chat.messages].reverse().find((entry) => entry.role === 'assistant' && entry.modelLabel);
    const modelId = run.chat.modelId || AVAILABLE_MODELS.find((option) => option.label === lastReply?.modelLabel)?.id;
    if (!synced && modelId && modelId !== this.activeModelId && (modelId === 'auto' || modelOption(modelId))) {
      this.selectModel(modelId);
      this.panel.webview.postMessage({ type: 'setActive', modelId });
    }
    this.panel.webview.postMessage({ type: synced ? 'chatSynced' : 'chatLoaded', chat: this.webviewChat(run.chat), running: run.turn || (run.externalCodexTurn ? { agentId: 'codex' } : null) });
    this.postProject();
    this.postTurnQueue();
    void run.drain();
    const hold = run.authHold && this.deps.authGate?.incident(run.authHold.agent);
    if (hold) this.panel.webview.postMessage(run.authHoldMessage(hold));
    for (const event of run.pending.values()) this.panel.webview.postMessage(event);
    if (run.subagentLog.length) this.panel.webview.postMessage({ type: 'subagentReplay', events: run.subagentLog });
  }

  /** What the Loops tab offers (lib/investigation-bridge.js decides which models are Flash and which may review). */
  investigationOptions() {
    const accounts = this.deps.chatWindowManager.launcherDeps?.cliAccounts;
    return { ...investigationOptions({ projects: this.deps.projects?.list() || [], projectId: this.chat.projectId || null, models: AVAILABLE_MODELS, isEnabled: (agent) => Boolean(accounts?.isEnabled(agent)) }),
      roles: this.deps.chatWindowManager.deps.investigations?.roleOptions?.() || {} };
  }

  /** "Review with…": a new chat bound to the report's project, the chosen model selected, the handoff as a draft. Nothing is sent. */
  async reviewInNewChat({ projectId, prompt, modelId }) {
    this.deps.projects.context(projectId); // throws when the project was removed or moved
    this.attach(this.deps.chatWindowManager.runFor(null, projectId));
    this.selectModel(modelId);
    this.panel.webview.postMessage({ type: 'setActive', modelId });
    this.panel.webview.postMessage({ type: 'prefillPrompt', text: prompt, closeSettings: true });
    this.postHistory();
    return { projectId, modelId };
  }

  resetToFreshChat() {
    this.attach(this.deps.chatWindowManager.runFor(null, this.chat.projectId));
    this.postHistory();
  }

  /** Switches this window's thread. A thread another window shows too is simply shown here as well: both follow the same run. */
  restoreChat(id) {
    // Tell the window first, so it paints a skeleton while the chat loads from disk and is sent over.
    const switching = id !== this.chat.id;
    if (switching) {
      const queueCount = this.pendingQueueCount(id);
      this.panel.webview.postMessage({ type: 'chatLoading', ...(queueCount !== 0 ? { queueCount } : {}) });
    }
    const run = this.deps.chatWindowManager.runFor(id);
    if (run && run !== this.run) this.attach(run);
    else if (switching) this.panel.webview.postMessage({ type: 'chatLoaded', chat: this.webviewChat(this.chat), running: this.run.turn }); // chat gone: put the current one back
  }

  /** Revert on the Nth user message: a fork holding everything before it opens
   * here, and that message goes back into the composer. The original chat stays in history. */
  revertToMessage(index) {
    const at = this.chat.messages.reduce((found, entry, i) => (entry.role === 'user' ? [...found, i] : found), [])[index];
    if (at === undefined) return;
    const message = this.chat.messages[at];
    const text = message.text || '';
    const files = [];
    try {
      // Composer remove/rename actions must never change the original message's files.
      for (const file of this.safeAttachmentPaths(message.attachments)) {
        const name = path.basename(file).replace(/^\d{10,}_/, '');
        let stamp = Date.now(), target;
        do { target = path.join(this.deps.attachmentsDir, `${stamp++}_${name}`); } while (fs.existsSync(target));
        fs.copyFileSync(file, target);
        files.push(this.attachmentMetadata(target));
      }
    } catch (error) {
      this.panel.webview.postMessage({ type: 'notice', text: `Could not restore attachments: ${error.message}` });
      return;
    }
    const fork = this.deps.chatStore.save({ ...this.deps.chatStore.create(), projectId: this.chat.projectId, forkedFrom: this.chat.id, messages: this.chat.messages.slice(0, at).map((entry) => ({ ...entry })) });
    this.restoreChat(fork.id);
    this.postHistory();
    this.panel.webview.postMessage({ type: 'prefillPrompt', text, files });
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
  async pushSchedulerQueue(attempt = 0) {
    const scheduler = this.deps.schedulerQueue;
    if (!scheduler) return;
    let tasks;
    try { tasks = await scheduler.getQueue(); } catch {
      // An unreadable queue file must not leave the panel on its loading skeleton for good: try again shortly.
      if (attempt < 5) setTimeout(() => this.pushSchedulerQueue(attempt + 1).catch(() => {}), 2000 * (attempt + 1)); // a closed panel just throws
      return;
    }
    const queue = tasks.map(task => ({ ...task, files: (task.attachments || []).flatMap(attachment => {
      const paths = safeAttachmentPaths({ ...this.deps, attachmentsDir: scheduler.stagingDir }, [attachment.absolutePath || path.resolve(this.deps.workspaceDir, attachment.relativePath || '')]);
      return paths.length ? paths.map(file => this.attachmentMetadata(file, attachment.mimeType)) : [{ name: attachment.name, mime: attachment.mimeType }];
    }) }));
    this.panel.webview.postMessage({ type: 'schedulerQueue', queue });
  }
  safeAttachmentPaths(paths) { return safeAttachmentPaths(this.deps, paths); }
  attachmentMetadata(file, mime = '') {
    const stat = fs.statSync(file);
    const ext = path.extname(file).toLowerCase();
    const uri = (target) => this.panel.webview.asWebviewUri(vscode.Uri.file(target)).toString();
    const metadata = { path: file, name: path.basename(file), size: stat.size, mime: ATTACHMENT_TYPES[ext] || mime, uri: uri(file) };
    const markup = ATTACHMENT_TYPES[ext]?.startsWith('image/') ? readMarkup(file) : null;
    // A marked-up image carries its marks and the untouched original, so the composer can reopen the editor on it.
    if (markup && fs.existsSync(markup.original)) metadata.markup = { ...markup, originalUri: uri(markup.original) };
    return metadata;
  }
  webviewFiles(paths) { return this.safeAttachmentPaths(paths).map((file) => this.attachmentMetadata(file)); }
  postTurnQueue(run = this.run) {
    const state = run.queueState();
    this.panel.webview.postMessage({ type: 'turnQueue', chatId: run.chat.id, paused: state.paused, order: state.order || [], turns: state.turns.map((turn) => ({ ...turn, files: this.webviewFiles(turn.attachments) })) });
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
  /** File links: PDFs use the editor's registered viewer, HTML opens in the browser, source opens at the line. */
  async openFile(file, line) {
    if (typeof file !== 'string' || !file) return;
    // Relative references resolve against this chat's project, searching its folders when the root alone misses.
    const resolved = await resolveFileRef(file, this.deps.workspaceDir);
    if (!resolved) {
      const project = this.deps.projects?.get(this.chat?.projectId)?.name;
      vscode.window.showWarningMessage(`File not found${project ? ` in ${project}` : ''}: ${file}`);
      return;
    }
    const uri = vscode.Uri.file(resolved);
    // Markdown reads best formatted: the Office Viewer's markdown editor. A line reference wants the text editor.
    if (/\.(md|markdown)$/i.test(uri.fsPath) && !line && vscode.extensions.getExtension('cweijan.vscode-office')) {
      try { await vscode.commands.executeCommand('vscode.openWith', uri, 'cweijan.markdownViewer', vscode.ViewColumn.One); return; }
      catch { /* fall through to the text editor */ }
    }
    if (/\.pdf$/i.test(uri.fsPath)) {
      try {
        await vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.One);
      } catch (error) { vscode.window.showWarningMessage(`Could not open PDF: ${file} (${error.message})`); }
      return;
    }
    if (/\.html?$/i.test(uri.fsPath) && !line) {
      if (!await vscode.env.openExternal(uri)) vscode.window.showWarningMessage(`Could not open in browser: ${file}`);
      return;
    }
    const row = Math.max(0, (Number(line) || 1) - 1);
    try {
      await vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(row, 0, row, 0) });
    } catch {
      await vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.One); // images and other binaries
    }
  }
  /** A picture a tool card names (the agent viewed or wrote it): the file as a data URI for the preview. Images only, capped. */
  async previewFile(file, requestId) {
    const reply = (data) => this.panel?.webview.postMessage({ type: 'filePreview', requestId, path: file, ...data });
    try {
      const resolved = typeof file === 'string' && file ? await resolveFileRef(file, this.deps.workspaceDir) : null;
      if (!resolved) return reply({ error: 'File not found' });
      const ext = path.extname(resolved).toLowerCase();
      const mime = ext === '.ico' ? 'image/x-icon' : ATTACHMENT_TYPES[ext];
      if (!mime?.startsWith('image/')) return reply({ error: 'Not a picture' });
      const stat = await fs.promises.stat(resolved);
      if (stat.size > PREVIEW_MAX_BYTES) return reply({ error: `Too large to preview (${Math.round(stat.size / 1048576)} MB)`, path: resolved });
      const bytes = await fs.promises.readFile(resolved);
      reply({ uri: `data:${mime};base64,${bytes.toString('base64')}`, name: path.basename(resolved), size: stat.size, path: resolved });
    } catch (error) { reply({ error: error.message || 'Could not read the file' }); }
  }
  /** Right-click on a file badge: its full path as text, or the file itself so Explorer can paste it (Windows). */
  async copyFileRef(file, mode) {
    if (typeof file !== 'string' || !file) return;
    const resolved = await resolveFileRef(file, this.deps.workspaceDir);
    const notify = (text, error = false) => this.panel?.webview.postMessage({ type: 'toast', text, error });
    if (!resolved) { notify(`File not found: ${file}`, true); return; }
    try {
      if (mode === 'file') {
        if (process.platform !== 'win32') throw new Error('Copying the file itself is only supported on Windows.');
        await new Promise((resolve, reject) => {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Set-Clipboard -LiteralPath $env:CLANKER_CLIP_FILE'], { env: { ...process.env, CLANKER_CLIP_FILE: resolved }, windowsHide: true, timeout: 8000 }, (error) => error ? reject(error) : resolve());
        });
        notify(`Copied file ${path.basename(resolved)}.`);
      } else {
        await vscode.env.clipboard.writeText(resolved);
        notify('Copied path.');
      }
    } catch (error) { notify(`Could not copy: ${error.message}`, true); }
  }
  scheduledPendingCount(chatId) {
    const scheduler = this.deps?.schedulerQueue;
    if (!scheduler || (!Array.isArray(scheduler.tasks) && scheduler.loaded !== false)) return 0;
    if (scheduler.loaded === false) return null;
    return scheduler.tasks.filter((task) => task.status === 'pending' && task.chatId === chatId).length;
  }
  pendingQueueCount(chatOrId) {
    const chatId = typeof chatOrId === 'string' ? chatOrId : chatOrId?.chat?.id;
    const run = typeof chatOrId === 'string' ? this.deps?.chatWindowManager?.runs.get(chatId) : chatOrId;
    const turns = run?.queue?.length || 0;
    const scheduled = chatId ? this.scheduledPendingCount(chatId) : (this.deps?.schedulerQueue?.loaded === false ? null : 0);
    return scheduled === null ? null : turns + scheduled;
  }
  /** P17-K: stored user messages keep attachment paths; the webview needs names and URIs for their pills. */
  webviewChat(chat) {
    const apiCostUsd = chatCost(chat,this.deps.getCostMeter?.()?.live?.prices);
    const page = historyPage(chat.messages);
    const scheduledPending = this.scheduledPendingCount(chat.id);
    return { ...chat, ...(chat.draftAttachments?.length ? { draftFiles: this.webviewFiles(chat.draftAttachments) } : {}), ...(apiCostUsd > 0 ? { apiCostUsd } : {}), ...(scheduledPending !== 0 ? { scheduledPending } : {}), ...page, messages: this.webviewMessages(page.messages) };
  }
  webviewMessages(messages) {
    return messages.map((m) => {
      const { compactContext, compactPreviousContext, ...visible } = m;
      if (visible.role === 'assistant' && visible.compact) visible.text = '';
      return visible.role === 'user' && visible.attachments?.length ? { ...visible, files: this.webviewFiles(visible.attachments) } : visible;
    });
  }
  async saveAttachment({ name, mime, data, chatId, requestId } = {}) {
    const failed = error => this.panel.webview.postMessage({ type: 'attachmentFailed', chatId, requestId, error });
    if (typeof data !== 'string' || data.length > 28 * 1024 * 1024) { failed('Attachment is too large or invalid.'); return; }
    const run = chatId ? this.deps.chatWindowManager.runFor(chatId) : this.run;
    if (!run) { failed('The attachment’s chat is no longer available.'); return; }
    const filename = path.basename(String(name || 'attachment.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(run.deps.attachmentsDir, `${attachmentStamp()}_${filename}`);
    try {
      await fs.promises.writeFile(file, Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64'));
      this.panel.webview.postMessage({ type: 'attachmentSaved', chatId: run.chat.id, requestId, attachment: this.attachmentMetadata(file, mime) });
    } catch (error) { failed(`Could not save attachment (${error.message}).`); }
  }
  async pickAttachments({ chatId } = {}) {
    const run = chatId ? this.deps.chatWindowManager.runFor(chatId) : this.run;
    if (!run) return;
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', filters: { 'All files': ['*'], Images: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'svg'], Documents: ['md', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'pdf', 'docx', 'xlsx', 'ts', 'js', 'txt', 'log'], 'Audio and video': ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4', 'webm', 'mov'] } });
    for (const uri of files || []) {
      const filename = path.basename(uri.fsPath).replace(/[^a-zA-Z0-9._-]/g, '_');
      const target = path.join(run.deps.attachmentsDir, `${attachmentStamp()}_${filename}`);
      fs.copyFileSync(uri.fsPath, target);
      this.panel.webview.postMessage({ type: 'attachmentSaved', chatId: run.chat.id, attachment: this.attachmentMetadata(target) });
    }
  }
  /** A name the user gave an attached image: the file keeps its timestamp prefix (so names never collide) and its extension. */
  renameAttachment(file, name) {
    const safe = this.safeReadableAttachmentPath(file) || this.safeAttachmentPaths([file])[0];
    if (!safe) return;
    const ext = path.extname(safe);
    const stamp = /^\d{10,}_/.exec(path.basename(safe))?.[0] || `${Date.now()}_`;
    const base = String(name || '').replace(new RegExp(`${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'image';
    let target = path.join(path.dirname(safe), `${stamp}${base}${ext}`);
    for (let n = 2; fs.existsSync(target) && target !== safe; n++) target = path.join(path.dirname(safe), `${stamp}${base} ${n}${ext}`);
    try { if (target !== safe) fs.renameSync(safe, target); } catch { return; }
    if (target !== safe && fs.existsSync(sidecarPath(safe))) { try { fs.renameSync(sidecarPath(safe), sidecarPath(target)); } catch { /* the marks are lost, the picture stays */ } }
    if (this.run?.chat && target !== safe) {
      let changed = false;
      const swap = (list) => Array.isArray(list) ? list.map((p) => (p === file || p === safe ? (changed = true, target) : p)) : list;
      for (const msg of this.run.chat.messages || []) {
        if (msg.attachments?.length) msg.attachments = swap(msg.attachments);
      }
      if (this.run.chat.draftAttachments?.length) this.run.chat.draftAttachments = swap(this.run.chat.draftAttachments);
      for (const turn of this.run.queue || []) {
        if (turn.attachments?.length) turn.attachments = swap(turn.attachments);
      }
      if (changed) this.run.save?.();
    }
    this.panel.webview.postMessage({ type: 'attachmentRenamed', from: file, attachment: this.attachmentMetadata(target) });
  }
  removeAttachment(file) { const [safe] = this.safeAttachmentPaths([file]); if (safe) { fs.promises.unlink(safe).catch(() => {}); fs.promises.unlink(sidecarPath(safe)).catch(() => {}); } }
  /**
   * Image markup (ATT-04). The webview sends the flattened PNG and the vector marks; the file the user marked up is never
   * overwritten. Re-marking an already marked image starts again from its original and replaces only the flattened copy.
   * Sending no marks puts the original back.
   */
  saveMarkup({ chatId, path: file, data, markup } = {}) {
    const run = chatId ? this.deps.chatWindowManager.runFor(chatId) : this.run;
    const [safe] = run ? safeAttachmentPaths(run.deps, [file]) : [];
    if (!safe) return;
    const previous = readMarkup(safe);
    const original = previous && fs.existsSync(previous.original) ? previous.original : safe;
    const clean = cleanMarkup(markup);
    if (!clean) return;
    const post = (attachment) => this.panel.webview.postMessage({ type: 'attachmentMarkedUp', chatId: run.chat.id, from: file, attachment });
    // Earlier composites may still belong to sent messages, drafts or queued turns; retention owns their cleanup.
    try {
      if (!clean?.items.length) { post(this.attachmentMetadata(original)); return; }
      if (typeof data !== 'string' || data.length > 40 * 1024 * 1024) return;
      const base = cleanAttachmentName(path.basename(original)).replace(/\.[^.]+$/, '').replace(/-markup$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'image';
      const target = path.join(run.deps.attachmentsDir, `${attachmentStamp()}_${base}-markup.png`);
      const png = Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64');
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
      fs.writeFileSync(target, png);
      writeMarkup(target, original, clean);
      post(this.attachmentMetadata(target));
    } catch (error) { vscode.window.showErrorMessage(`Clanker Controller: could not save the markup (${error.message}).`); }
  }
  safeReadableAttachmentPath(file) {
    if (typeof file !== 'string' || !file) return null;
    for (const attachmentsDir of [this.run?.deps?.attachmentsDir, this.deps.attachmentsDir, this.deps.schedulerQueue?.stagingDir].filter(Boolean)) {
      const [safe] = safeAttachmentPaths({ attachmentsDir }, [file]);
      if (safe) return safe;
    }
    return null;
  }
  async downloadAttachment(file, name) {
    const safe = this.safeReadableAttachmentPath(file);
    if (!safe) {
      this.panel?.webview.postMessage({ type: 'notice', text: 'Could not download image: file not found.' });
      return null;
    }
    const cleanName = cleanAttachmentName(name || path.basename(safe)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const baseDir = this.lastDownloadDir && fs.existsSync(this.lastDownloadDir)
      ? this.lastDownloadDir
      : (fs.existsSync(downloadsDir) ? downloadsDir : os.homedir());
    const ext = path.extname(cleanName).replace(/^\./, '').toLowerCase();
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(baseDir, cleanName)),
      saveLabel: 'Download',
      ...(ext ? { filters: { Images: [ext], 'All files': ['*'] } } : {}),
    });
    if (!target?.fsPath) return null;
    try {
      this.lastDownloadDir = path.dirname(target.fsPath);
      await fs.promises.copyFile(safe, target.fsPath);
      this.panel?.webview.postMessage({ type: 'attachmentDownloaded', name: path.basename(target.fsPath), path: target.fsPath });
      return target.fsPath;
    } catch (error) {
      vscode.window.showErrorMessage?.(`Clanker Controller: could not save image (${error.message}).`);
      return null;
    }
  }
  async copyAttachment(file, { silent = false } = {}) {
    const safe = this.safeReadableAttachmentPath(file);
    if (!safe) {
      if (!silent) this.panel?.webview.postMessage({ type: 'attachmentCopied', ok: false, error: 'Image file not found.' });
      return false;
    }
    try {
      if (this.deps.copyImageToClipboard) {
        await this.deps.copyImageToClipboard(safe);
      } else if (process.platform === 'win32') {
        const script = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $img = [System.Drawing.Image]::FromFile($env:CLANKER_CLIP_FILE); try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }';
        await new Promise((resolve, reject) => {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { env: { ...process.env, CLANKER_CLIP_FILE: safe }, windowsHide: true, timeout: 8000 }, (error) => error ? reject(error) : resolve());
        });
      } else {
        throw new Error('Image clipboard copy is only supported on Windows.');
      }
      if (!silent) this.panel?.webview.postMessage({ type: 'attachmentCopied', ok: true, name: cleanAttachmentName(safe) });
      return true;
    } catch (error) {
      if (!silent) this.panel?.webview.postMessage({ type: 'attachmentCopied', ok: false, error: error.message });
      return false;
    }
  }

  // P16-L: every failure path ends in micState 'idle' plus a readable toast,
  // so the mic button can never stay locked in "processing".
  voiceError(error) {
    const devices = error?.devices?.length ? ` Available devices: ${error.devices.map((name) => `"${name}"`).join(', ')}.` : '';
    const message = error?.code === 'AUDIO_CAPTURE_FAILED'
      ? `\u26A0\uFE0F Audio Capture Failed: ${error.message}.${devices}`
      : `\u26A0\uFE0F Voice input failed: ${error?.message || error}`;
    this.postMic({ state: 'idle' });
    this.panel.webview.postMessage({ type: 'voiceError', message });
  }

  /** Every window shows the shared microphone's state; this one is the dictation target (see ChatWindowManager.broadcastMic). */
  postMic(message) { this.deps.chatWindowManager.broadcastMic(this, message); }

  /** Save only the correction the user accepted; never report a failed write as learned. */
  async learnVoiceCorrections(original, edited, term, requestId) {
    if (!learnedTerms(original, edited).includes(term)) return;
    try {
      voiceDictionary.addTerm(voicePaths(), term, { replaceSpelling: true, source: 'learned' });
      this.panel.webview.postMessage({ type: 'voiceTermsLearned', terms: [term], requestId });
    } catch (error) {
      this.panel.webview.postMessage({ type: 'voiceDictionaryError', term, requestId, message: `Could not save to voice dictionary: ${error.message}` });
    }
  }

  /** Esc while listening: stop the capture and throw the recording away, no transcription. */
  async handleMicCancel() {
    const capture = this.deps.voiceCapture;
    if (!capture.isRecording()) return;
    capture.onVolume = null;
    this.postMic({ state: 'idle' });
    const dir = capture.dir;
    capture.pipeline?.cancel();
    capture.pipeline = null;
    try { await capture.stop(); } catch { /* nothing recorded */ }
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); // Esc is a deliberate discard: the only recording that is not kept
  }

  /** `hold`: started by the hold-to-talk hotkey, so it ends when the keys are released, not on a pause in speech. */
  async handleMicToggle({ hold = false } = {}) {
    const capture = this.deps.voiceCapture;
    const cue = vscode.workspace.getConfiguration('aiChatPanel').get('voiceSounds', true); // the window plays a short tone when recording starts and when it ends
    if (capture.starting) return; // double click while ffmpeg is still opening the device
    if (!capture.isRecording()) {
      this.postMic({ state: 'starting' });
      // P17-ZA: live levels go to every window, so all of them animate the one shared microphone in step.
      const manager = this.deps.chatWindowManager;
      capture.onVolume = ({ rms, peak, level }) => manager.broadcastMicVolume({ rms, peak, level });
      let dir = null;
      capture.pipeline?.cancel();
      capture.pipeline = null;
      try {
        capture.owner = this; // the window the hotkey ends this recording in; ChatWindowManager.setActive moves it
        dir = voiceArchive.newRecordingDir(this.deps.voiceDir); // audio goes straight to disk here, in parts, and stays 7 days
        await capture.start({ pauseMedia: vscode.workspace.getConfiguration('aiChatPanel').get('voicePauseMedia', true), dir });
      } catch (error) {
        if (dir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        capture.onVolume = null;
        this.voiceError(error);
        return;
      }
      manager.broadcastMic(capture.owner, { state: 'recording', device: capture.device, hold, cue }); // the target may have changed while the microphone opened
      // From here on every finished 5-minute part is transcribed and cleaned while you keep talking. A short prompt never gets that far.
      this.createDictationPipeline(dir).then((pipeline) => {
        if (capture.dir === dir && capture.isRecording()) { capture.pipeline = pipeline; pipeline.start(); }
      }).catch(() => { /* the end-of-recording pass does all the work instead */ });
      return;
    }

    capture.onVolume = null;
    this.postMic({ state: 'processing', cue });
    const dir = capture.dir;
    const pipeline = capture.pipeline;
    capture.pipeline = null;
    try {
      await capture.stop();
    } catch (error) {
      pipeline?.cancel();
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); // nothing was recorded, so there is nothing to keep
      this.voiceError(error);
      return;
    }
    await this.dictateFromFolder(dir, pipeline);
  }

  /** Speech to text and cleanup for one recording folder, as a job that can run during the recording (lib/voice-archive.js). */
  async createDictationPipeline(dir) {
    const [, { transcribeAudio, cleanDictationPart, splitTranscript }] = await loadVoiceRouterModules();
    // P17-ZA: saved spellings bias Whisper's decoding and the cleanup pass repairs toward them.
    const terms = await voiceVocabulary(this.chat.projectId, this.deps.projects); // ranked, so only what the models take (voiceDictionary.LIMITS) is used, however long the dictionary is
    const vocabularyPrompt = voiceDictionary.promptTerms(terms).join(', ');
    const dictionaryTerms = terms.slice(0, voiceDictionary.LIMITS.cleanupTerms);
    return new voiceArchive.DictationPipeline(dir, {
      transcribe: voiceArchive.withSilenceTrim((file) => transcribeAudio(file, { vocabularyPrompt }), { ffmpeg: this.deps.voiceCapture.ffmpeg() }),
      clean: (text, { number, multi }) => cleanDictationPart(text, { dictionaryTerms, ...(multi ? { number } : {}) }),
      split: splitTranscript,
    });
  }

  /**
   * Finishes a recording folder: the pipeline (started during the recording, or made now for "Recover Voice Recording")
   * transcribes what is left, cleans the text and puts it in the composer. Each ~5-minute part is saved as it comes back,
   * so a failure midway loses nothing.
   */
  async dictateFromFolder(dir, pipeline = null) {
    try {
      pipeline ||= await this.createDictationPipeline(dir);
      const result = await pipeline.finish();
      const rawTranscript = result.text;
      if (result.total && result.failed.length === result.total) throw new Error(`Transcription failed: ${result.lastError}`);
      if (!rawTranscript.trim()) {
        voiceArchive.updateMeta(dir, { status: 'empty' });
        throw new Error('No speech detected. Try recording again.');
      }
      const output = { cleanedPrompt: result.cleaned };
      const cleanupFailed = result.cleanFailed > 0;
      const warnings = [];
      if (result.failed.length) warnings.push(`${result.failed.length} of ${result.total} parts could not be transcribed (marked in the text; ${result.lastError}). The audio stays in ${dir} for 7 days; "Clanker Controller: Recover Voice Recording" tries again.`);
      if (cleanupFailed) warnings.push(`${result.cleanFailed === result.chunks ? 'Voice cleanup failed' : `${result.cleanFailed} of ${result.chunks} sections could not be cleaned`}; ${result.cleanFailed === result.chunks ? 'your unformatted transcript is' : 'those sections are unformatted'} ready to edit. ${result.lastCleanError}`);
      voiceArchive.finishRecording(dir, { cleaned: output.cleanedPrompt, raw: rawTranscript, partial: result.failed.length > 0, cleanupFailed });

      // Dictation produces a draft only. The current router selects a model when the user sends.
      this.postMic({ state: 'idle' });
      this.panel.webview.postMessage({ type: 'voiceResult', output, rawTranscript, warning: warnings.join(' ') || undefined, autoSend: false });
    } catch (error) {
      this.voiceError(new Error(`${error.message} Your recording is kept in ${dir} for 7 days ("Clanker Controller: Recover Voice Recording" retries).`));
    }
  }

  /** The composer's Polish button: the typed draft goes through the dictation cleanup (written mode) and comes back as text to review. */
  async polishPrompt({ text, requestId }) {
    const fail = (message) => this.panel.webview.postMessage({ type: 'polishResult', requestId, error: message });
    const draft = String(text || '').trim();
    if (!draft) return fail('Write something first, then polish it.');
    if (draft.length > POLISH_MAX_CHARS) return fail(`That draft is too long to polish (${draft.length.toLocaleString('en')} of ${POLISH_MAX_CHARS.toLocaleString('en')} characters).`);
    try {
      const [, { cleanDictation }] = await loadVoiceRouterModules();
      const terms = (await voiceVocabulary(this.chat.projectId, this.deps.projects)).slice(0, voiceDictionary.LIMITS.cleanupTerms);
      const polished = await cleanDictation(draft, { dictionaryTerms: terms, written: true });
      this.panel.webview.postMessage({ type: 'polishResult', requestId, text: polished });
    } catch (error) {
      fail(`Could not polish the prompt: ${error.message}`);
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

  renderHtml(webview, run = this.run) {
    const initialQueueLoading = this.pendingQueueCount(run);
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const errorReportUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'error-report.js'));
    const logViewerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'log-viewer.js'));
    const attachmentPreviewUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'attachment-preview.js'));
    const attachmentDocsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'attachment-docs.css'));
    const glassUiStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'glass-ui.css'));
    const attachmentDocsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'attachment-docs.js'));
    const attachmentMarkupUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'attachment-markup.js'));
    const mascotUri =webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'clanker-mascot.js'));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'agent-icons.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const settingsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'settings.css'));
    const settingsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'settings.js'));
    const loopsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'investigations.css'));
    const loopsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'investigations.js'));
    const timerStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'schedule-timer.css'));
    const bubbleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'bubble-shape.js'));
    const themePaletteUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'theme-palette.js'));
    const liquidGlassUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'liquid-glass.js'));
    const copyTargetsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'copy-targets.js'));
    const toolTargetsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'tool-targets.js'));
    const chatTimeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat-time.js'));
    const burnRateUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'burn-rate.js'));
    const ringSegmentsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'ring-segments.js'));
    const apiValueUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'api-value.js'));
    const voiceHotkeyUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'voice-hotkey.js'));
    const limitNoticeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'limit-notice.js'));
    const dropZoneUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'drop-zone.js'));
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
<html lang="en" data-ui-loading>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} blob:; img-src ${webview.cspSource} data: blob:; media-src ${webview.cspSource} data: blob:;">
<style>html[data-ui-loading] { background: var(--vscode-editor-background, #111216); } html[data-ui-loading] body { opacity: 0; pointer-events: none; } .startup-error { padding: 16px; font: 13px var(--vscode-font-family, sans-serif); color: var(--vscode-editor-foreground, #ddd); }</style>
<link rel="stylesheet" href="${katexCssUri}">
<link rel="stylesheet" href="${styleUri}">
<link rel="stylesheet" href="${settingsStyleUri}">
<link rel="stylesheet" href="${loopsStyleUri}">
<link rel="stylesheet" href="${timerStyleUri}">
<link rel="stylesheet" href="${attachmentDocsStyleUri}">
<link rel="stylesheet" href="${glassUiStyleUri}">
<style>${providers.accentCss()}</style>
${rail ? `<link rel="stylesheet" href="${railStyleUri}">` : ''}
<title>Clanker Controller</title>
</head>
<body inert${rail ? ' class="has-rail"' : ''}>
${rail ? railMarkup(CHAT_BUTTONS) : `<div class="topbar"><div class="topbar-actions"><div hidden>${CHAT_BUTTONS.queue}${CHAT_BUTTONS.loops}</div>${CHAT_BUTTONS.history}${CHAT_BUTTONS.newChat}</div></div>`}

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
        <span class="mic-wrap" id="micWrap">
          <button class="composer-icon-btn polish-btn" id="polishBtn" type="button" title="Polish prompt: restructure what you typed (Ctrl+Z undoes it)" aria-label="Polish prompt">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 3.75h11M2.5 7.75h7M2.5 11.75h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M12 8.5C12.84 10.66 12.84 10.66 15 11.5C12.84 12.34 12.84 12.34 12 14.5C11.16 12.34 11.16 12.34 9 11.5C11.16 10.66 11.16 10.66 12 8.5Z" fill="currentColor"/>
            </svg>
          </button>
          <button class="composer-icon-btn mic-pill" id="micBtn" title="Voice input (click to record)">
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2Z" stroke="currentColor" stroke-width="1.2"/>
              <path d="M4.5 7.5v.5a3.5 3.5 0 0 0 7 0v-.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
              <path d="M8 11.5v2.5M6 14h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </button>
        </span>
        <button class="composer-icon-btn send-btn" id="sendBtn" title="Send">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M2.5 8h10.5M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${errorReportUri}"></script>
  <script nonce="${nonce}">window.CLANKER_MARK = ${JSON.stringify(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'clanker-dark.svg')).toString())}; window.MODEL_CATALOG = ${JSON.stringify(MODEL_CATALOG)}; window.AVAILABLE_MODELS = ${JSON.stringify(AVAILABLE_MODELS.filter((entry) => this.deps.cliAccounts?.isEnabled(entry.agent) !== false))}; window.TIME_PREFS = ${timePrefs()}; window.ANTIGRAVITY_RING = ${JSON.stringify(antigravityRing())}; window.SCHEDULE_MODE = ${JSON.stringify(this.deps.getScheduleMode?.() || 'reset')}; window.VOICE_SILENCE_MS = ${Math.max(0, Number(vscode.workspace.getConfiguration('aiChatPanel').get('voiceAutoStopSeconds', 0)) || 0) * 1000}; window.INITIAL_QUEUE_LOADING = ${JSON.stringify(initialQueueLoading)};</script>
  <script nonce="${nonce}">window.PROVIDERS = ${JSON.stringify(providers.displayList()).replace(/</g, '\\u003c')};</script>
  <script defer nonce="${nonce}" src="${themePaletteUri}"></script>
  <script defer nonce="${nonce}" src="${liquidGlassUri}"></script>
  <script defer nonce="${nonce}" src="${copyTargetsUri}"></script>
  <script defer nonce="${nonce}" src="${toolTargetsUri}"></script>
  <script defer nonce="${nonce}" src="${iconsUri}"></script>
  <script defer nonce="${nonce}" src="${katexUri}"></script>
  <script defer nonce="${nonce}" src="${modelPromptsUri}"></script>
  <script defer nonce="${nonce}" src="${voiceHotkeyUri}"></script>
  <script defer nonce="${nonce}" src="${loopsUri}"></script>
  <script defer nonce="${nonce}" src="${settingsUri}"></script>
  <script defer nonce="${nonce}" src="${timerUri}"></script>
  ${rail ? `<script nonce="${nonce}">{ const api = acquireVsCodeApi(); window.acquireVsCodeApi = () => api; } /* a webview may acquire the API once; the chat and the rail share it */</script>` : ''}
  <script defer nonce="${nonce}" src="${chatTimeUri}"></script>
  <script defer nonce="${nonce}" src="${burnRateUri}"></script>
  <script defer nonce="${nonce}" src="${ringSegmentsUri}"></script>
  <script defer nonce="${nonce}" src="${apiValueUri}"></script>
  <script defer nonce="${nonce}" src="${limitNoticeUri}"></script>
  <script defer nonce="${nonce}" src="${dropZoneUri}"></script>
  <script defer nonce="${nonce}" src="${bubbleUri}"></script>
  <script defer nonce="${nonce}" src="${mascotUri}"></script>
<script defer nonce="${nonce}" src="${attachmentPreviewUri}"></script>
<script defer nonce="${nonce}" src="${attachmentDocsUri}"></script>
<script defer nonce="${nonce}" src="${attachmentMarkupUri}"></script>
<script defer nonce="${nonce}" src="${logViewerUri}"></script>
<script defer nonce="${nonce}" src="${scriptUri}"></script>
  ${rail ? `<script nonce="${nonce}">window.CONTEXT_ASSETS = ${(contextAssetsJson ||= JSON.stringify(contextAssets(path.join(__dirname, 'media')))).replace(/</g, '\\u003c')};</script>` : ''}
  ${rail ? `<script defer nonce="${nonce}" src="${railScriptUri}"></script>` : ''}
  <script nonce="${nonce}">window.SHIKI_URI = ${JSON.stringify(shikiUri.toString())};</script>
  <script nonce="${nonce}">
    document.addEventListener('DOMContentLoaded', () => {
      const reveal = () => {
        document.body.inert = false;
        document.documentElement.removeAttribute('data-ui-loading');
        document.dispatchEvent(new Event('clanker-ui-ready'));
      };
      if (!window.CLANKER_UI_INITIALIZED || getComputedStyle(document.documentElement).getPropertyValue('--clanker-style-ready').trim() !== '1' || ![...document.querySelectorAll('link[rel="stylesheet"]')].every(link => link.sheet)) {
        document.body.replaceChildren(Object.assign(document.createElement('p'), { className: 'startup-error', textContent: 'Clanker could not finish loading. Reload the window to try again.' }));
        reveal();
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(reveal));
    }, { once: true });
  </script>
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
    if (!chat.workContext) run.considerWorkContext({ initial: true });
    return run;
  }
  refreshWorkContexts() {
    if (!this.deps.routing?.workContext?.enabled()) return;
    // Seed only the visible recent tiles, using the normal privacy, confidence and budget guards.
    for (const session of this.deps.chatStore.list().filter(session => !session.empty).slice(0, 5)) {
      const restored = this.runs.has(session.id);
      const run = this.runFor(session.id);
      if (restored && run && !run.chat.workContext) run.considerWorkContext({ initial: true });
    }
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
  /** A chat nothing has happened in yet: no messages, queue, running work or scheduled prompt that would stay behind in the old project. */
  isUntouched(run) {
    const scheduled = this.deps.schedulerQueue?.tasks.some(task => task.chatId === run.chat.id && !['done', 'cancelled'].includes(task.status));
    return !run.chat.messages.length && !run.queue.length && !run.turn && !run.starting && !run.remote && !run.streamEngine.hasBackgroundAgents && !scheduled;
  }
  bindProject(run, projectId) {
    if (run.chat.projectId && !this.isUntouched(run)) throw new Error('An existing conversation cannot be moved between projects. Open a new chat instead.');
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
      this.deps.chatStore.flush(run.chat.id); // persist pending edits; an unchanged chat needs no full snapshot write
      this.runs.delete(run.chat.id);
      this.cleanupEmptyChats();
    }
  }

  /** Remove empty history left by older versions, after loading scheduled prompts from disk. */
  async pruneEmptyChats() {
    const tasks = await this.deps.schedulerQueue?.getQueue() || [];
    this.cleanupEmptyChats(tasks);
  }

  /** Drafts survive while visible in the rail's five slots; live and scheduled work always survives. */
  cleanupEmptyChats(tasks = this.deps.schedulerQueue?.tasks || []) {
    const recent = new Set(this.listChats().slice(0, 5).map(session => session.id));
    const keep = new Set([
      ...this.runs.keys(),
      this.sidebar?.chat.id || this.deps.sidebarState?.get(SIDEBAR_CHAT_KEY),
      ...tasks.filter(task => !['done', 'cancelled'].includes(task.status)).map(task => task.chatId),
    ]);
    let removed = false;
    for (const session of this.deps.chatStore.list()) {
      if (!session.empty || keep.has(session.id) || (session.hasTypedMessage && recent.has(session.id))) continue;
      this.deps.chatStore.delete(session.id);
      this.recentSelections.delete(session.id);
      removed = true;
    }
    if (removed) this.notifyOpenChanged();
  }

  /** History in rail order: selected, recently selected or running, then older chats. */
  listChats() {
    const live = new Map([...this.runs.values()].filter((run) => run.state).map((run) => [run.chat.id, run.state]));
    const now = Date.now();
    for (const [id, leftAt] of this.recentSelections) if (now - leftAt >= ACTIVE_WINDOW_MS) this.recentSelections.delete(id);
    const selectedId = this.sidebar?.chat.id;
    const activeId = selectedId || this.activeHost?.chat.id;
    const openIds = new Set([...this.hosts].map((host) => host.chat.id));
    const scheduledIds = new Set((this.deps.schedulerQueue?.tasks || []).filter(task => !['done', 'cancelled'].includes(task.status)).map(task => task.chatId));
    // Keep `open` for existing consumers; the rail uses the sidebar's single `selected` chat.
    const projectOf = this.deps.projects?.resolver();
    const sessions = this.deps.chatStore.list(projectOf).filter(session => !session.empty || session.hasTypedMessage || session.id === activeId || this.runs.get(session.id)?.starting || live.has(session.id) || scheduledIds.has(session.id));
    return markActive(sessions, live, now).map((session) => ({
      ...session,
      projectName: this.deps.projects?.get(session.projectId)?.name || (this.deps.projects ? 'Choose project' : null),
      // Every project the chat worked in, the latest first; the chat's own project stands in until a tool has touched a file.
      projectNames: [...new Set([...session.touchedProjectIds, session.projectId])].map(id => this.deps.projects?.get(id)?.name).filter(Boolean),
      open: openIds.has(session.id),
      selected: session.id === selectedId,
      recentUntil: this.recentSelections.has(session.id) ? this.recentSelections.get(session.id) + ACTIVE_WINDOW_MS : null,
    })).sort((a, b) => {
      const rank = session => session.selected ? 0 : session.recentUntil > now || session.state === 'running' ? 1 : 2;
      return rank(a) - rank(b);
    });
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
      this.setActive(host);
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
    this.setActive(host);
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
  async routePrompt(prompt, { newChat = false, targetModel = 'auto', attachments = [], projectRoot, projectId = this.activeHost ? this.activeHost.chat.projectId : this.selectedProjectId || this.deps.defaultProjectId } = {}) {
    const request = String(prompt || '').trim();
    if (!request) return false;
    const text = projectRoot ? `Astro site root: ${path.resolve(projectRoot)}\n\n${request}` : request;
    if (projectRoot) {
      const project = this.deps.projects?.forFile(projectRoot);
      if (!project) throw new Error('Register the Visor site in Clanker Manage projects before sending a message.');
      projectId = project.id;
    }
    this.deps.projects?.context(projectId);
    if (this.deps.ensureModels) await this.deps.ensureModels();
    // Visor paths are relative to the supplied Astro site, which can be nested inside the registered project.
    // Validate every image before copying or enqueuing: dropping one silently changes the user's request.
    const projectContext = this.deps.projects ? this.projectDeps(projectId) : this.deps;
    const imageSources = [...new Set(Array.isArray(attachments) ? attachments : [])].map(f => {
      if (typeof f !== 'string' || !f.trim()) throw new Error('An attached image has no valid file path. Attach it again before sending.');
      const source = path.resolve(projectRoot || projectContext.workspaceDir, f);
      const workspaceRoot = path.resolve(projectContext.workspaceDir) + path.sep;
      const attachmentRoot = path.resolve(projectContext.attachmentsDir) + path.sep;
      if (!source.startsWith(workspaceRoot) && !source.startsWith(attachmentRoot)) throw new Error(`Attached image is outside the selected project: ${f}`);
      if (!/\.(png|jpe?g|webp|gif)$/i.test(source)) throw new Error(`Unsupported attached image: ${f}`);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Attached image was not found: ${source}`);
      if (fs.statSync(source).size > 20000000) throw new Error(`Attached image exceeds 20 MB: ${f}`);
      return source;
    });
    attachments = imageSources.map(source => {
      fs.mkdirSync(projectContext.attachmentsDir, { recursive: true });
      const destination = path.join(projectContext.attachmentsDir, `${crypto.randomUUID()}-${path.basename(source)}`);
      fs.copyFileSync(source, destination); return destination;
    });
    const selected = targetModel === 'auto' ? null : MODEL_CATALOG.find(model => model.id === targetModel);
    if (targetModel !== 'auto' && !selected) throw new Error('This favorite model is no longer available. Choose another model in Visor.');
    if (newChat) {
      const chat = this.deps.chatStore.save({ ...this.deps.chatStore.create(), projectId, title: `Visor · ${request.replace(/\s+/g, ' ').slice(0, 60)}`, modelId: targetModel });
      const run = this.runFor(chat.id);
      run.enqueue({ id: crypto.randomUUID(), text, modelId: targetModel, attachments, newChat, queued: true });
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
    run.enqueue({ id: crypto.randomUUID(), text, modelId, attachments, queued: true });
    this.deps.notifyHistory();
    return true;
  }

  /** Also holds scheduled work while an unanswered deferred question is saved in an unloaded chat. */
  isChatBusy(chatId, scheduled = null) {
    const run = this.runs.get(chatId);
    return Boolean(run ? (run.turn || run.starting || run.externalCodexTurn || run.waitingQuestion || run.queuePaused || run.authHold || (!scheduled && run.queue.length)) : this.deps.chatStore.load(chatId)?.messages.some(entry => entry.event?.deferred && entry.event.type === 'question_required' && !entry.event.settled));
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
    // The scheduler releases its card after handoff; the chat queue must show and persist it until it starts.
    if (!run.queueOrder.some(key => key.slice(key.indexOf(':') + 1) === task.id)) run.queueOrder.unshift(`scheduled:${task.id}`);
    run.enqueue({ id: task.id, text: task.prompt, modelId: task.modelId || chatModelFor(run.chat, task.model)?.id || 'auto', attachments, scheduled: true, queued: true });
    this.deps.notifyHistory();
    return true;
  }

  /**
   * The window used last: where the dictation hotkey records and where its text lands. A window reports it on any click
   * or focus inside it (`windowActive`), so a popup chat counts as soon as it is used, not only when its tab is switched to.
   * While a recording is running the dictation target follows: the next hotkey press ends it in this window.
   */
  setActive(host) {
    if (this.activeHost === host) return;
    this.activeHost = host;
    if (this.mic?.state === 'starting' || this.mic?.state === 'recording') {
      this.deps.voiceCapture.owner = host;
      this.broadcastMic(host, this.mic);
    }
  }

  /**
   * Dictation is one shared microphone, so every window shows its state; `target` is the window the text will land in.
   * Only the target plays the cue (the others would stack the same tone) and gets the full animation.
   */
  broadcastMic(target, message) {
    this.mic = message.state === 'idle' ? null : { ...message, cue: false }; // replayed when the target changes mid-recording
    for (const host of this.hosts) void host.panel.webview.postMessage({ type: 'micState', ...message, cue: Boolean(message.cue) && host === target, target: host === target });
  }

  broadcastMicVolume(volume) {
    for (const host of this.hosts) void host.panel.webview.postMessage({ type: 'micVolume', ...volume });
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
      run.disposed = true; run.syncAwake();
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
  showInChat(type, extra = {}) {
    const host = this.deps.chatWindowManager.getOrCreateActive();
    host.panel.reveal(undefined, false);
    void host.panel.webview.postMessage({ type, ...extra });
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

  /** Every chat window's rail and Settings popup learn about a change to the project registry. */
  refreshProjects() {
    for (const host of this.deps.chatWindowManager.hosts) { host.postProject(); host.settingsPane?.postProjectIcons(); }
  }
  /** The Voice tab's dictionary: every word, how many of them reach each model, and the limits. */
  async postVoiceDictionary(extra = {}) {
    if (!this.view) return;
    const paths = voicePaths();
    this.view.webview.postMessage({ type: 'voiceDictionary', entries: voiceDictionary.listTerms(paths).map(({ term, enabled, source, project }) => ({ term, enabled, source, project })), usage: voiceDictionary.usage(paths), ...extra });
  }
  /** One dictionary action from Settings. A refusal (a duplicate, a full dictionary) goes back as a sentence to show. */
  async changeVoiceDictionary(message) {
    const paths = voicePaths();
    let note = {};
    try {
      switch (message.type) {
        case 'voiceDictionaryAdd': voiceDictionary.addTerm(paths, message.term); break;
        case 'voiceDictionaryEdit': voiceDictionary.updateTerm(paths, message.term, { next: message.next, enabled: message.enabled }); break;
        case 'voiceDictionaryRemove': voiceDictionary.removeTerm(paths, message.term); break;
        case 'voiceDictionaryClearScanned': note = { notice: `Removed ${voiceDictionary.removeScanned(paths)} scanned words.` }; break;
      }
    } catch (error) { note = { error: error.message }; }
    await this.postVoiceDictionary(note);
  }
  /** Reads a project's folder for technical words and adds the best ones, within the dictionary's limits. */
  async scanVoiceDictionary(message) {
    const registered = message.id ? this.deps.chatWindowManager.deps.projects?.get(message.id) : null;
    let root = registered?.root, name = registered?.name;
    if (!message.id) { // "Choose folder…": an existing folder that is not registered, or a new project not added yet
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Scan this folder', title: 'Find technical words in a project' });
      root = picked?.[0]?.fsPath; name = root && path.basename(root);
      if (!root) { await this.postVoiceDictionary({ scanning: false }); return; }
    }
    if (!root) { await this.postVoiceDictionary({ scanning: false, error: 'That project has no folder to scan.' }); return; }
    try {
      const { terms, stats } = await scanProject(root, { name });
      const result = voiceDictionary.addScanned(voicePaths(), terms, name);
      const limit = result.full ? ' The dictionary reached its limit for scanned words, so the rest were left out.' : '';
      await this.postVoiceDictionary({ scanning: false, notice: `${name}: found ${terms.length} technical words in ${stats.files} files, added ${result.added}${stats.truncated ? ' (a large project: the scan stopped early)' : ''}.${limit}` });
    } catch (error) { await this.postVoiceDictionary({ scanning: false, error: `Could not scan ${name}: ${error.message}` }); }
  }
  refreshVoiceDictionary() {
    for (const host of this.deps.chatWindowManager.hosts) void host.settingsPane?.postVoiceDictionary();
  }
  postProjectIcons() {
    const registry = this.deps.chatWindowManager.deps.projects;
    if (registry) this.view?.webview.postMessage({ type: 'projectIcons', projects: registry.list().map(describeProject) });
  }
  /** Applies `pick(project)` as the project's icon ('' clears it; null leaves it alone), then tells every window. */
  setProjectIcon(id, pick) {
    try {
      const registry = this.deps.chatWindowManager.deps.projects;
      const project = registry?.get(id);
      if (!project) return;
      const icon = pick(project);
      if (icon !== null) registry.update(id, { icon });
      this.refreshProjects();
    } catch (error) { vscode.window.showErrorMessage(`Clanker: ${error.message}`); }
  }
  async pickProjectIcon(id) {
    const project = this.deps.chatWindowManager.deps.projects?.get(id);
    if (!project) return;
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: 'Use as icon', title: `Icon for ${project.name}`,
      defaultUri: project.root ? vscode.Uri.file(project.root) : undefined,
      filters: { Images: ['svg', 'png', 'ico', 'jpg', 'jpeg', 'webp', 'gif'] },
    });
    if (picked?.length) this.setProjectIcon(id, () => picked[0].fsPath);
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
      case 'openRoutingConfig':
        void vscode.window.showTextDocument(vscode.Uri.file(this.deps.routing.configFile)).then(undefined,error=>vscode.window.showErrorMessage(error.message)); break;
      case 'editRoutingConfigWithAI':
        this.showInChat('prefillPrompt',{routingConfig:true,text:'Help me adjust my model routing configuration at '+this.deps.routing.configFile+'. First read it and the guide at '+path.join(this.extensionUri.fsPath,'..','docs','routing-config.md')+'. Preserve unrelated settings and existing model IDs. Task profiles, model tasks and avoid_tasks, fallback_order, provider_weights, prompts and policy are editable. Validate with ai-chat-panel/lib/routing.js config(). Do not put credentials in the config. My requested changes: '}); break;
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
        void this.deps.cliHub.refreshInstalled();
        const snapshot = this.deps.cliHub.snapshot();
        this.view?.webview.postMessage(snapshot);
        // Retry failed release lookups too: a known installed version does not
        // mean the startup network check succeeded.
        if (Object.values(snapshot.versions || {}).some((entry) => !entry?.version || !entry?.latest) || !Object.keys(snapshot.versions || {}).length) void this.deps.cliHub.check();
        break;
      }
      case 'requestCliStatus': this.view?.webview.postMessage(this.deps.cliHub.snapshot()); break;
      case 'requestCliAvailability': this.view?.webview.postMessage(this.deps.cliAccounts.snapshot()); break;
      case 'requestCliConnections':
        this.view?.webview.postMessage(this.deps.cliAccounts.snapshot());
        void this.deps.cliAccounts.check();
        break;
      case 'connectCli': void this.deps.cliAccounts.connect(message.agent); break;
      case 'fixCli': if (providers.has(message.agent)) void this.deps.authGate.act(message.agent); break; // the rail's sign-in button: the same fix as the popup's
      case 'connectAllClis': void this.deps.cliAccounts.connectAll(); break;
      case 'removeCli': void this.deps.cliAccounts.remove(message.agent); break;
      case 'restoreCli': void this.deps.cliAccounts.restore(message.agent); break;
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
      case 'setSessionWarmup': {
        const config = vscode.workspace.getConfiguration('aiChatPanel');
        if (typeof message.enabled === 'boolean') void config.update('sessionWarmup', message.enabled, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'cloudWarmup': void this.deps.cloudWarmup?.handle(message); break;
      case 'setAutoContinueOnLimit': if (typeof message.enabled === 'boolean') void vscode.workspace.getConfiguration('aiChatPanel').update('autoContinueOnLimit', message.enabled, vscode.ConfigurationTarget.Global); break;
      case 'setAutoUpdateClis': if (typeof message.enabled === 'boolean') void vscode.workspace.getConfiguration('aiChatPanel').update('autoUpdateClis', message.enabled, vscode.ConfigurationTarget.Global); break;
      case 'setCompletionSound': if (typeof message.enabled === 'boolean') void vscode.workspace.getConfiguration('aiChatPanel').update('completionSound', message.enabled, vscode.ConfigurationTarget.Global); break;
      case 'setWorkContextIcons': if (typeof message.enabled === 'boolean') void vscode.workspace.getConfiguration('aiChatPanel').update('workContextIcons', message.enabled, vscode.ConfigurationTarget.Global); break;
      case 'setCompliance': if (COMPLIANCE_SETTINGS[message.key]) void vscode.workspace.getConfiguration('aiChatPanel').update(COMPLIANCE_SETTINGS[message.key], Boolean(message.value), vscode.ConfigurationTarget.Global); break;
      case 'setChatNames': if (CHAT_NAME_SOURCES.includes(message.value)) void vscode.workspace.getConfiguration('aiChatPanel').update('chatNames', message.value, vscode.ConfigurationTarget.Global); break;
      case 'setAntigravityRing': if (ANTIGRAVITY_RINGS.includes(message.value)) void vscode.workspace.getConfiguration('aiChatPanel').update('antigravityRing', message.value, vscode.ConfigurationTarget.Global); break;
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
      case 'setVoicePauseMedia': void vscode.workspace.getConfiguration('aiChatPanel').update('voicePauseMedia', Boolean(message.enabled), vscode.ConfigurationTarget.Global); break;
      case 'setVoiceMic': void vscode.workspace.getConfiguration('aiChatPanel').update('voiceMicDevice', String(message.device || ''), vscode.ConfigurationTarget.Global); break;
      // Settings > General > Project icons. The registry file is the storage; the watcher in activate() also covers an AI editing it.
      case 'requestProjectIcons': this.postProjectIcons(); break;
      case 'pickProjectIcon': void this.pickProjectIcon(message.id); break;
      case 'detectProjectIcon': this.setProjectIcon(message.id, project => findIcon(project.root) || (vscode.window.showInformationMessage(`No favicon or logo found in ${project.name}. Choose one, or ask an AI.`), null)); break;
      case 'clearProjectIcon': this.setProjectIcon(message.id, () => ''); break;
      case 'projectIconWithAI': {
        const project = this.deps.chatWindowManager.deps.projects?.get(message.id);
        if (!project?.root) break;
        this.showInChat('prefillPrompt', { closeSettings: true, text: `Find the best favicon or logo for my project "${project.name}" in ${project.root}. Look for favicon files and brand logos, pick a square-ish PNG, SVG or ICO under 256 KB, and set its absolute path as the "icon" field of this project's entry (id ${project.id}) in ${this.deps.chatWindowManager.deps.projects.file}. The file is a JSON array: keep every other field and entry as they are. The chat rail then shows the icon instead of the initials. If nothing suitable exists, say so rather than guessing.` });
        break;
      }
      // Settings > Voice > Dictionary. The file in the session directory is the storage; an AI editing it shows up here too.
      case 'requestVoiceDictionary': void this.postVoiceDictionary(); break;
      case 'voiceDictionaryAdd': case 'voiceDictionaryEdit': case 'voiceDictionaryRemove': case 'voiceDictionaryClearScanned': void this.changeVoiceDictionary(message); break;
      case 'voiceDictionaryScan': void this.scanVoiceDictionary(message); break;
      case 'voiceDictionaryWithAI': {
        const { LIMITS } = voiceDictionary;
        this.showInChat('prefillPrompt', { closeSettings: true, text: `Help me edit my dictation dictionary, the spellings speech-to-text should favour. It is the JSON file ${voicePaths().dictionaryFile}: { "terms": [{ "term": "SimTalk", "enabled": true, "addedAt": 0, "source": "ai" }], "ignored": [] }. Read it first and keep every entry and field you are not asked to change (entries with "source": "scan" came from a project scan). A term is one word or short name of at most ${voiceDictionary.MAX_TERM_LENGTH} characters, spelled exactly as it should appear, and each term appears once, ignoring case. Keep the file under ${LIMITS.entries} entries. Clanker ranks the words itself for every recording (recent use, project), so the order does not matter and there is nothing to prioritise; the fields uses, lastUsedAt and usedIn are its own bookkeeping, so leave them as they are. Set "enabled": false instead of deleting a word I might want back. Write valid JSON and nothing else to the file. My requested changes: ` });
        break;
      }
      case 'requestMicDevices': void Promise.resolve(this.deps.listMicDevices?.()).then((found) => this.view?.webview.postMessage({ type: 'micDevices', devices: [...new Set(found?.devices || [])], automatic: found?.automatic || '' })); break;
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
      autoContinueOnLimit: vscode.workspace.getConfiguration('aiChatPanel').get('autoContinueOnLimit', true),
      autoUpdateClis: vscode.workspace.getConfiguration('aiChatPanel').get('autoUpdateClis', true),
      completionSound: vscode.workspace.getConfiguration('aiChatPanel').get('completionSound', true),
      workContextIcons: vscode.workspace.getConfiguration('aiChatPanel').get('workContextIcons', false),
      sessionWarmup: this.deps.getSessionWarmup?.(),
      cloudWarmup: this.deps.cloudWarmup?.snapshot(),
      permissionMode: vscode.workspace.getConfiguration('aiChatPanel').get('permissionMode', 'fullAccess'),
      compliance: { scout: vscode.workspace.getConfiguration('aiChatPanel').get('complianceScout', true), redact: vscode.workspace.getConfiguration('aiChatPanel').get('complianceRedact', true) },
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
 * The chat's header buttons: Scheduled prompts, Loops, Manage chats and New chat.
 * main.js finds them by id, so they are the same elements wherever they sit: in the rail of the
 * sidebar chat, or in a topbar over a chat opened as an editor tab.
 */
const CHAT_BUTTONS = {
  loops: `<button class="round-btn round-btn-queue round-btn-loop" id="loopsBtn" type="button" aria-label="Loops" aria-haspopup="dialog" aria-controls="loopsModal" aria-expanded="false">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 0 1 8.7-3.4L13 6M13 3v3h-3M13 8a5 5 0 0 1-8.7 3.4L3 10M3 13v-3h3"/></svg>
      <span class="queue-countdown" id="loopElapsed"></span>
      <span class="round-btn-tip" aria-hidden="true">Loops</span>
    </button>`,
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
  <!-- Buttons at the top right, then Usage, Project (added by main.js) and chats. Scheduled, Settings and Manage Chats open as popups over the chat.
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
    ${buttons.loops}
    <button class="round-btn" id="settingsBtn" type="button" title="Chat settings" aria-label="Chat settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>
    <button class="round-btn round-btn-update" id="updatesBtn" type="button" aria-label="CLI updates" hidden>
      <svg class="upd-icon upd-up" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4"/></svg>
      <svg class="upd-icon upd-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
      <svg class="upd-icon upd-ok" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>
      <svg class="upd-icon upd-fail" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v5.5M8 12v.01"/></svg>
      <span class="round-btn-tip" aria-hidden="true">Update</span>
      <span class="upd-pill" aria-hidden="true"><span class="upd-status"></span><span class="upd-rows"></span></span>
    </button>
  </div>

  <section class="launcher-section">
    <div class="launcher-label">Usage</div>
    <div class="model-cards" id="modelCards" aria-label="Model quotas"></div>
  </section>

  <section class="launcher-section is-grow">
    <div class="launcher-label">Recent</div>
    <div class="history-list" id="historyList" aria-busy="true" aria-label="Recent chats">
      ${Array.from({ length: 3 }, () => '<div class="history-item rail-skeleton" aria-hidden="true"><i class="history-row skeleton"></i><i class="rail-skeleton-time skeleton"></i></div>').join('')}
    </div>
  </section>
  </div>
</aside>`;
}

function activate(context) {
  installLog(context, () => chatWindowManager); // first, so everything after it can log
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
    // The Marketplace build has its own publisher ID; chats saved by the unpublished `local.ai-chat-panel` copy come along once.
    legacyDirs: [path.join(path.dirname(context.globalStorageUri.fsPath), 'local.ai-chat-panel', 'session'), process.env.ASTRO_CONTENT_EDITOR_SESSION_DIR, path.join(workspaceDir, 'site', '.astro', 'session'), path.join(workspaceDir, '.astro', 'session')],
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
    broadcast: (message) => {
      for (const host of chatWindowManager?.hosts || []) void host.panel.webview.postMessage(message);
      void launcher?.view?.webview.postMessage(message); // the rail drops the rings of CLIs that are removed or unavailable
    },
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
  const voiceDir = path.join(SESSION_DIR, 'voice'); // every dictation's audio and transcripts, kept 7 days (lib/voice-archive.js)
  // A minute after start, out of the way of everything else: drop attachments and finished tasks' staging that nothing
  // points to any more and that are two weeks old (lib/storage-gc.js).
  setTimeout(() => {
    const removed = sweepStorage(SESSION_DIR);
    if (removed.attachments || removed.staging) console.log(`[ai-chat-panel] storage sweep: ${removed.attachments} unused attachments (${(removed.bytes / 1048576).toFixed(1)} MB), ${removed.staging} finished task folders`);
  }, 60000).unref?.();
  const sweepVoice = () => {
    const removed = voiceArchive.sweepVoiceArchive(voiceDir);
    if (removed.recordings) console.log(`[ai-chat-panel] voice archive: removed ${removed.recordings} recordings older than 7 days (${(removed.bytes / 1048576).toFixed(1)} MB)`);
  };
  setTimeout(sweepVoice, 60000).unref?.();
  setInterval(sweepVoice, 6 * 60 * 60 * 1000).unref?.(); // IDE windows stay open for days
  const codexCommands = new CodexCommandCatalog();
  const codexThreadTitles = new CodexThreadTitles({ cwd: workspaceDir });
  context.subscriptions.push(codexThreadTitles);
  const codexChatSync = new CodexChatSync({ cwd: workspaceDir, runs: () => chatWindowManager?.runs.values() || [] });
  context.subscriptions.push(codexChatSync);
  // Repair old prompt-derived names without resuming threads or sending model prompts.
  codexThreadTitles.repairSaved(chatStore, projects);
  const slashCommands = new SlashCommandCatalog({ codexCommands, workspaceDir, cacheFile: path.join(SESSION_DIR, 'slash-commands.json') });

  function getModels() {
    const configured = vscode.workspace.getConfiguration('aiChatPanel').get('models', {});
    return Object.fromEntries(providers.ids().map((agent) => [agent, configured[agent] || defaultModel(agent)?.model]));
  }

  function getPermissionMode() {
    return vscode.workspace.getConfiguration('aiChatPanel').get('permissionMode', 'fullAccess');
  }

  const schedulerQueue = new SchedulerQueue({ workspaceDir, sessionDir: SESSION_DIR, keepAwake });
  context.subscriptions.push(schedulerQueue);
  let launcher = null;
  let chatWindowManager = null;
  // Prompts that go out unattended (queued, scheduled, "continue") first ask whether their CLI is signed in; if not, they
  // wait, a Windows popup offers the browser sign-in, and they are sent when it works (lib/auth-gate.js).
  const authGate = new AuthGate({
    accounts: cliAccounts, showPrompt: showAuthPrompt,
    pending: (agent) => [...(chatWindowManager?.runs.values() || [])].reduce((sum, run) => sum + run.heldCount(agent), 0)
      + schedulerQueue.tasks.filter((task) => task.status === 'pending' && task.model === agent).length,
  });
  authGate.on('change', (block) => { for (const run of chatWindowManager?.runs.values() || []) run.authChanged(block); });
  authGate.on('resolved', (agent) => { for (const run of chatWindowManager?.runs.values() || []) run.authResolved(agent); void watchdog?.tick(); });
  context.subscriptions.push({ dispose: () => authGate.dispose() });
  // Launcher list and every open chat window's Queue badge/manager.
  function notifySchedulerQueue(dispatch = false) {
    void launcher?.pushSchedulerQueue();
    for (const host of chatWindowManager?.hosts || []) void host.pushSchedulerQueue();
    setImmediate(() => { for (const run of chatWindowManager?.runs.values() || []) void run.drain(); });
    if (dispatch === true) void watchdog.tick();
  }

  // P16-M: quota poll -> launcher gauges and chat headers, live.
  context.subscriptions.push(onDidChangeQuotas((quotas) => {
    void launcher?.pushQuotas(quotas);
    for (const host of chatWindowManager?.hosts || []) host.panel.webview.postMessage({ type: 'quotas', quotas });
  }));

  chatWindowManager = new ChatWindowManager(context.extensionUri, {
    sessionManager, chatStore, projects, defaultProjectId, cliAccounts, voiceCapture, voiceDir, workspaceDir, sessionDir: SESSION_DIR, attachmentsDir, getModels, getPermissionMode, getModelPrompts: () => cliHub.prompts, getModelSettings: () => cliHub.modelSettings, getCostMeter: () => costMeter, codexCommands, codexThreadTitles, codexChatSync, slashCommands, schedulerQueue, notifySchedulerQueue, renameChat, getEditorTheme: () => editorTheme, notify, notifyHistory, onTelegramEvent, keepAwake,
    authGate,
    // Which scheduling mode (usage reset, timer, calendar) the clock starts with: the one used last, kept for good.
    getScheduleMode: () => context.globalState.get('scheduleMode', 'reset'),
    setScheduleMode: (mode) => { if (['reset', 'timer', 'calendar'].includes(mode)) void context.globalState.update('scheduleMode', mode); },
    sidebarState: context.workspaceState,
    projectPinStore: { get: () => context.globalState.get('pinnedProjectIds'), set: ids => context.globalState.update('pinnedProjectIds', ids) },
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
    if (event.affectsConfiguration('aiChatPanel.workContextIcons')) chatWindowManager?.refreshWorkContexts();
    if (event.affectsConfiguration('aiChatPanel.showStatusBar')) applyStatusBar();
    if (event.affectsConfiguration('aiChatPanel.antigravityRing')) {
      for (const host of chatWindowManager?.hosts || []) {
        host.panel.webview.postMessage({ type: 'antigravityRing', value: antigravityRing() });
        void host.settingsPane?.pushFleet();
      }
    }
    if (event.affectsConfiguration('aiChatPanel.sessionWarmup')) {
      void sessionWarmup.tick();
      void launcher?.pushFleet();
      for (const host of chatWindowManager?.hosts || []) void host.settingsPane?.pushFleet();
    }
    if (event.affectsConfiguration('aiChatPanel.autoContinueOnLimit') || event.affectsConfiguration('aiChatPanel.autoUpdateClis')) {
      void launcher?.pushFleet();
      for (const host of chatWindowManager?.hosts || []) void host.settingsPane?.pushFleet();
    }
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
    void codexThreadTitles.sync(chat, projects.get(chat.projectId));
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
    chime = chime && vscode.workspace.getConfiguration('aiChatPanel').get('completionSound', true) !== false;
    notifyReply({ appName: vscode.env.appName, chime, toast: vscode.window.state.focused ? null : { agent, text, chatTitle } });
  }
  function notifyHistory() {
    launcher?.postHistory();
    for (const host of chatWindowManager?.hosts || []) host.postHistory();
  }
  const watchdog = new SchedulerWatchdog({ queue: schedulerQueue, projects, workspaceDir, getModels, getPermissionMode, getModelPrompts: () => cliHub.prompts, getModelSettings: () => cliHub.modelSettings, telegram: null, onQueueChange: notifySchedulerQueue, chatStore, onHistoryChange: notifyHistory, notify, isAgentEnabled: (agent) => cliAccounts.isEnabled(agent), resumeInChat: (task) => chatWindowManager?.resumeChat(task), isChatBusy: (chatId, task) => chatWindowManager?.isChatBusy(chatId, task), getQueueState: id => chatWindowManager?.runs.get(id)?.queueState() || chatStore.load(id)?.turnQueue || {}, authGate });
  const warmupConfig = () => vscode.workspace.getConfiguration('aiChatPanel');
  const warmupChanged = () => { void launcher?.pushFleet(); for (const host of chatWindowManager?.hosts || []) void host.settingsPane?.pushFleet(); };
  const cloudWarmup = new CloudWarmup({ context, vscode, models: () => AVAILABLE_MODELS, locate: agent => locate(agent).path || '',
    enabledAgents: () => cliAccounts.enabledAgents(), subscription: agent => subscriptionBilled(agent), readQuotas, onChange: warmupChanged });
  cloudWarmup.start();
  context.subscriptions.push(cloudWarmup);
  const sessionWarmup = new SessionWarmup({
    getConfig: () => ({ enabled: warmupConfig().get('sessionWarmup', true) }),
    models: () => AVAILABLE_MODELS, agents: () => cliAccounts.enabledAgents().filter(agent => !cloudWarmup.owns(agent)), locate: (agent) => locate(agent).path || '', readQuotas, record: (_agent, windows) => recordClaudeUsage(windows),
    subscription: (agent) => subscriptionBilled(agent),
    hasScheduled: async (agent) => cloudWarmup.coolingDown(agent) || Boolean(cliHub.updating[agent]) || (await schedulerQueue.getQueue()).some((task) => task.status === 'pending' && task.model === agent && task.dispatchTrigger === 'quota-reset'),
    store: { get: () => context.globalState.get('sessionWarmup', {}), set: (value) => context.globalState.update('sessionWarmup', value) },
    onChange: () => { void launcher?.pushFleet(); for (const host of chatWindowManager?.hosts || []) void host.settingsPane?.pushFleet(); },
  });
  sessionWarmup.start();
  context.subscriptions.push(sessionWarmup);
  const investigations = installInvestigations({ vscode, context, storageDir: SESSION_DIR, projects,
    availableModels: () => cliAccounts.isEnabled('gemini') ? AVAILABLE_MODELS.filter(model => model.agent === 'gemini').map(model => model.model) : [],
    fixers: { isEnabled: agent => cliAccounts.isEnabled(agent), modelFor: agent => defaultModel(agent), readQuotas },
    roles: { models: () => AVAILABLE_MODELS, isEnabled: agent => cliAccounts.isEnabled(agent), defaultModel },
    // A loop that was running when the IDE closed resumes by itself; tell open windows as soon as the manager is up.
    onReady: ready => { for (const host of chatWindowManager?.hosts || []) host.panel.webview.postMessage({ type: 'investigationsState', available: true, state: ready.manager.snapshot() }); },
    isForegroundBusy: () => Boolean(watchdog.activeTaskId) || Object.keys(cliHub.updating).length > 0 || [...chatWindowManager.runs.values()].some(run => run.turn || run.starting || run.remote || run.streamEngine.hasBackgroundAgents) });
  // Frontend work can subscribe to manager.change and call its API without another scheduler.
  chatWindowManager.deps.investigations = investigations;

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
        log.error('telegram', 'Could not store the new Telegram chat ID:', err);
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
  void chatWindowManager.pruneEmptyChats().catch(error => log.error('chats', 'Could not clean up empty chats:', error));
  watchdog.start();

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => sessionManager.handleTerminalClosed(terminal)),
  );

  // Live service state for the launcher's Settings tab.
  const routing = routingRuntime(context, () => MODEL_CATALOG, SESSION_DIR);
  chatWindowManager.deps.routing = routing; routingRuntimeRef = routing;
  // Work-context icons spend Cloudflare Neurons, so they stay off until you confirm the connected account is on the Workers Free plan.
  Object.assign(routing.workContext, {
    enabled: () => vscode.workspace.getConfiguration('aiChatPanel').get('workContextIcons', false) === true,
    isLive: (run) => chatWindowManager.runs.get(run.chat.id) === run,
    onChange: () => notifyHistory(),
    log: (text) => console.log('[clanker]', text),
  });
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
    antigravityRing: antigravityRing(),
    chatNames: chatNameSource(),
    permissionMode: getPermissionMode(),
  });
  // CLI versions, the update icon and the starred models (Settings > Models) share one hub; every chat window hears it.
  // The `clanker-agent` command (skill clanker-load-agent) lets any agent hand a task to another vendor's model. It reads the picker's
  // models and starts through a launcher at ~/.clanker/clanker-agent.js, both written here whenever the model list changes.
  const publishAgentModels = () => { try { clankerAgent.publish({ models: AVAILABLE_MODELS.filter(entry => cliAccounts.isEnabled(entry.agent) !== false) }); } catch { /* the helper is optional */ } };
  const cliHub = new CliHub({
    accounts: cliAccounts,
    autoUpdateEnabled: () => vscode.workspace.getConfiguration('aiChatPanel').get('autoUpdateClis', true),
    isBusy: agent => watchdog.running || Boolean(watchdog.activeTaskId) || sessionWarmup.busy
      || Boolean(investigations.manager?.actives.size)
      || providerBusy(agent, { runs: chatWindowManager.runs.values(), hosts: chatWindowManager.hosts }),
    beforeUpdate: async agent => {
      if (agent !== 'codex') return;
      // Idle app servers keep codex.exe open on Windows. Release them before
      // replacement; the saved thread resumes through a fresh server next turn.
      const engines = [...chatWindowManager.runs.values()].map(run => run.streamEngine).concat(watchdog.engine);
      await Promise.all(engines.filter(engine => engine?.codexServer && !engine.codexActive).map(async engine => {
        const server = engine.codexServer, child = server.child;
        engine.codexServer = null;
        engine.codexThreadId = null;
        if (!child || child.exitCode !== null) { server.dispose(); return; }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.removeListener('close', closed); reject(new Error('Idle Codex server did not exit')); }, 5000);
          const closed = () => { clearTimeout(timer); resolve(); };
          child.once('close', closed);
          server.dispose();
        });
      }));
    },
    store: { get: () => context.globalState.get('favoriteModels', []), set: (entries) => void context.globalState.update('favoriteModels', entries) },
    promptStore: { get: () => context.globalState.get('modelPrompts', {}), set: (prompts) => void context.globalState.update('modelPrompts', prompts) },
    settingsStore: { get: () => context.globalState.get('favoriteModelSettings', {}), set: (settings) => void context.globalState.update('favoriteModelSettings', settings) },
    cacheStore: { get: () => context.globalState.get('discoveredModels', []), set: (entries) => void context.globalState.update('discoveredModels', entries) },
    broadcast: (message) => {
      void launcher?.view?.webview.postMessage(message);
      for (const host of chatWindowManager.hosts) {
        if (message.type === 'modelCatalog' && modelOption(host.chat.modelId)) host.selectModel(host.chat.modelId);
        void host.panel.webview.postMessage(message);
      }
      if (message.type === 'modelCatalog') { sessionManager.refreshCommands?.(agentList()); publishAgentModels(); }
    },
  });
  publishAgentModels();
  cliHub.ready = cliHub.refreshModels();
  chatWindowManager.deps.ensureModels = () => cliHub.ready;
  chatWindowManager.deps.waitForCliUpdate = agent => cliHub.updatePromises.get(agent);
  watchdog.waitForCliUpdate = chatWindowManager.deps.waitForCliUpdate;
  void cliHub.check();
  // Which CLIs are signed in and still on a plan that unlocks them (the rail and the picker hide the ones that are not).
  // Cheap: a status call per CLI, no prompt. Settings > General checks again whenever it is opened.
  void cliAccounts.check();
  const accessTimer = setInterval(() => void cliAccounts.check(), 30 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(accessTimer) });
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
  chatWindowManager.refreshWorkContexts(); // builds ChatRuns, which read costMeter: only valid once it is declared
  const updateTimer = setInterval(() => void cliHub.check(), 6 * 60 * 60 * 1000);
  const autoUpdateTimer = setInterval(() => void cliHub.autoUpdate(), 15000);
  const installedVersionTimer = setInterval(() => void cliHub.refreshInstalled(), 60000);
  context.subscriptions.push({ dispose: () => { clearInterval(updateTimer); clearInterval(autoUpdateTimer); clearInterval(installedVersionTimer); } });
  // Dictation (Settings > Voice): the Groq key and its usage, and the global hotkey that starts and stops recording.
  const voiceConfig = () => vscode.workspace.getConfiguration('aiChatPanel');
  const hotkeyMode = () => (voiceConfig().get('voiceHotkeyMode', 'toggle') === 'hold' ? 'hold' : 'toggle');
  // The hotkey starts and ends dictation in the window used last (ChatWindowManager.setActive), never a fixed one.
  const voiceHotkey = new VoiceHotkey({
    handlers: createHotkeyHandlers({
      mode: hotkeyMode,
      isRecording: () => voiceCapture.isRecording(),
      begin: () => chatWindowManager.getOrCreateActive().handleMicToggle({ hold: hotkeyMode() === 'hold' }),
      finish: () => chatWindowManager.getOrCreateActive().handleMicToggle(),
      cancel: () => chatWindowManager.getOrCreateActive().handleMicCancel(),
    }),
    onError: (reason) => vscode.window.showWarningMessage(`Clanker Controller:the dictation hotkey stopped (${reason}).`),
  });
  const voiceState = () => ({
    pauseMedia: voiceConfig().get('voicePauseMedia', true),
    hotkey: voiceConfig().get('voiceHotkey', ''), mode: hotkeyMode(), sounds: voiceConfig().get('voiceSounds', true),
    micDevice: voiceConfig().get('voiceMicDevice', ''), hotkeyActive: Boolean(voiceHotkey.child), supported: process.platform === 'win32', groq: groqAccount.snapshot(),
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
  const describeRecording = (recording) => `${recording.name} · ${Math.max(1, Math.round(recording.seconds / 60))} min · ${recording.status}`;
  async function recoverVoiceRecording(dir) {
    if (voiceCapture.isRecording()) { void vscode.window.showWarningMessage('Stop the current dictation first.'); return; }
    if (!dir) {
      const recordings = voiceArchive.listRecordings(voiceDir).filter((recording) => recording.segments);
      if (!recordings.length) { void vscode.window.showInformationMessage('No voice recordings from the last 7 days.'); return; }
      const pick = await vscode.window.showQuickPick(recordings.map((recording) => ({ label: recording.name, description: `${Math.max(1, Math.round(recording.seconds / 60))} min · ${recording.status}`, detail: recording.needsAttention ? 'Not fully transcribed' : 'Done; picking it puts the text in the chat again', recording })), { placeHolder: 'Which voice recording should go into the chat?' });
      if (!pick) return;
      dir = pick.recording.dir;
    }
    const host = chatWindowManager.getOrCreateActive();
    host.postMic({ state: 'processing' });
    void host.dictateFromFolder(dir);
  }
  // A recording that never got its text (the IDE closed, the network was down) is offered once, 20 s after start.
  setTimeout(() => {
    const pending = voiceArchive.listRecordings(voiceDir).filter((recording) => recording.needsAttention && !recording.meta.noticed && !(voiceCapture.isRecording() && recording.status === 'recording'));
    if (!pending.length) return;
    for (const recording of pending) voiceArchive.updateMeta(recording.dir, { noticed: true });
    const text = pending.length === 1 ? `A voice recording was never fully transcribed (${describeRecording(pending[0])}). The audio is kept for 7 days.` : `${pending.length} voice recordings were never fully transcribed. The audio is kept for 7 days.`;
    void vscode.window.showInformationMessage(text, 'Transcribe newest', 'Open folder').then((choice) => {
      if (choice === 'Transcribe newest') void recoverVoiceRecording(pending[0].dir);
      else if (choice === 'Open folder') void vscode.commands.executeCommand('aiChatPanel.openVoiceRecordings');
    });
  }, 20000).unref?.();
  const chooseMic = () => { voiceCapture.setPreferred(voiceConfig().get('voiceMicDevice', '')); void voiceCapture.warm(); }; // the probe runs now, not on the first click
  chooseMic();
  context.subscriptions.push(
    { dispose: () => { void voiceCapture.dispose(); } },
    { dispose: () => voiceHotkey.stop() },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('aiChatPanel.voiceHotkey')) voiceHotkey.start(voiceConfig().get('voiceHotkey', ''));
      if (event.affectsConfiguration('aiChatPanel.voiceMicDevice')) chooseMic();
      if (['voiceHotkey', 'voiceHotkeyMode', 'voiceSounds', 'voicePauseMedia', 'voiceMicDevice'].some((name) => event.affectsConfiguration(`aiChatPanel.${name}`))) broadcastVoice();
    }),
  );
  const launcherDeps = {
    groqAccount, getVoice: voiceState, listMicDevices: () => voiceCapture.probe(), routing, cloudWarmup,
    cliHub, cliAccounts, chatStore, chatWindowManager, schedulerQueue, getModels, getPermissionMode, watchdog, notifySchedulerQueue, renameChat,
    getServices, getSessionWarmup: () => sessionWarmup.snapshot(), configureTelegram, disconnectTelegram, startTunnel: () => tunnel.start(), stopTunnel: () => tunnel.stop(),
    getTelegramBridge: () => telegram, sessionManager, getCostMeter: () => costMeter, authGate,
  };
  launcher = new LauncherViewProvider(context.extensionUri, launcherDeps);
  chatWindowManager.launcherDeps = launcherDeps; // the chat windows' Chat Settings popup runs on the same handlers
  // An icon set from Settings, by hand or by an AI editing projects.json, shows up in every rail without a reload.
  try {
    let refreshTimer;
    const watcher = fs.watch(SESSION_DIR, (_event, name) => {
      if (name !== 'projects.json' && name !== 'voice-dictionary.json') return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => (name === 'projects.json' ? launcher.refreshProjects() : launcher.refreshVoiceDictionary()), 250);
    });
    context.subscriptions.push({ dispose: () => { clearTimeout(refreshTimer); watcher.close(); } });
  } catch { /* no watcher: a reload shows an icon that was set outside Settings */ }
  void setLauncherHeaderHidden(false); // a window closed while the launcher was showing leaves its header colour behind
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiChatPanel.mainView', launcher));
  context.subscriptions.push(vscode.commands.registerCommand('aiChatPanel.investigationsManage', () => launcher.showInChat('openLoops')));
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
    // Voice recordings are kept 7 days. If a long dictation broke, this transcribes whatever is missing and puts the text in the chat.
    vscode.commands.registerCommand('aiChatPanel.recoverVoiceRecording', () => recoverVoiceRecording()),
    vscode.commands.registerCommand('aiChatPanel.openVoiceRecordings', () => { fs.mkdirSync(voiceDir, { recursive: true }); return vscode.env.openExternal(vscode.Uri.file(voiceDir)); }),
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
    // The routing mode (manual / auto), for a caller with its own model picker. With a mode it sets it first.
    vscode.commands.registerCommand('aiChatPanel.routingMode', (payload) => payload?.mode ? routing.setMode(payload.mode) : routing.mode()),
    // A one-shot answer that comes back to the caller (no chat is created), for a status the caller shows itself.
    vscode.commands.registerCommand('aiChatPanel.summarize', (payload) => require('./lib/summarize').summarizeText(payload?.instruction, payload?.text)),
    vscode.commands.registerCommand('aiChatPanel.routePrompt', (payload) => chatWindowManager.routePrompt(payload?.prompt, { newChat: payload?.newChat === true, attachments: payload?.attachments || [], ...(payload?.targetModel ? { targetModel: payload.targetModel } : {}), ...(payload?.projectRoot ? { projectRoot: payload.projectRoot } : {}), ...(payload?.projectId ? { projectId: payload.projectId } : {}) })),
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

/**
 * The log (lib/log.js) goes to a "Clanker Controller" output channel as well as the Logs popup. Every error or warning
 * this extension shows as a notification is logged too, with the stack of the code that raised it.
 */
function installLog(context, manager) {
  try {
    const channel = vscode.window.createOutputChannel('Clanker Controller', { log: true });
    log.attachChannel(channel);
    context.subscriptions.push(channel, { dispose: () => log.attachChannel(null) });
  } catch (error) { console.warn('[clanker] No log output channel:', error.message); }
  for (const [name, level] of [['showErrorMessage', 'error'], ['showWarningMessage', 'warn']]) {
    const original = vscode.window[name];
    if (typeof original !== 'function') continue;
    try {
      vscode.window[name] = function (message, ...rest) {
        const raisedAt = new Error('raised').stack?.split('\n').slice(2, 8).join('\n') || '';
        log.add({ level, source: 'notification', message: typeof message === 'string' ? message : String(message), stack: raisedAt });
        return original.call(this, message, ...rest);
      };
    } catch { /* a frozen API object: notifications stay unlogged */ }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('aiChatPanel.showLogs', () => {
      const host = manager()?.getOrCreateActive();
      if (!host) { log.channel()?.show(true); return; }
      host.panel.reveal?.(undefined, false);
      void host.panel.webview.postMessage({ type: 'openLogs' });
    }),
    vscode.commands.registerCommand('aiChatPanel.showLogOutput', () => log.channel()?.show(true)),
  );
  const unsubscribe = log.onEntry(entry => {
    for (const host of manager()?.hosts || []) {
      if (host.logsOpen) void host.panel.webview.postMessage(entry ? { type: 'logEntry', entry } : { type: 'logCleared' });
    }
  });
  context.subscriptions.push({ dispose: unsubscribe });
  log.info('extension', `Clanker Controller activated (${vscode.env.appName} ${vscode.version}, ${process.platform})`);
}

function deactivate() {}

module.exports = { activate, deactivate, agentList, injectTarget, opusTerminalCommand, ChatWindowHost, ChatWindowManager, LauncherViewProvider, SchedulerWatchdog, TunnelManager, quotaAvailable, cleanAttachmentName };
