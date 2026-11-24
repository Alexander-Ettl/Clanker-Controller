'use strict';

// SCHED-01: runs scheduled turns that come due while the editor is closed (a prompt waiting for a quota reset at 2 a.m.).
// It reads the same disk-backed queue and chat store as the editor, runs each due turn through the same stream engine in the
// chat's own project folder, and writes the reply into the chat so it is there when the editor reopens.
//
// Never runs beside an editor: lib/runner-lock.js makes the editor and the runner take turns. No vscode is loaded here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StreamEngine } = require('./stream-engine.js');
const { SchedulerQueue, isDue, firstPrompt } = require('./scheduler-queue.js');
const { ChatStore, ownedByAnotherHost } = require('./chat-store.js');
const { ProjectRegistry } = require('./projects.js');
const { RunnerLock } = require('./runner-lock.js');
const { recordToolEnd, quotaAvailable } = require('./turn-record.js');
const { modelOption, defaultModel, setModelCatalog, setEnabledAgents } = require('./model-catalog.js');
const providers = require('./providers');
const { promptFor, permissionFor, appendInstructions } = require('../media/model-prompts.js');
const { accessFailure } = require('./provider-access.js');
const { buildHandoff, taskState } = require('./chat-handoff.js');

const homeDir = () => process.env.CLANKER_HOME || path.join(os.homedir(), '.clanker');
/** Where the editor leaves what the runner cannot read from VS Code's settings: the session folder, models, prompts. */
const settingsFile = () => path.join(homeDir(), 'runner.json');

/** The editor calls this whenever the facts change (activation, settings). Atomic, and a no-op when nothing changed. */
function publishSettings(settings) {
  const file = settingsFile();
  const next = JSON.stringify({ version: 1, ...settings });
  try { if (fs.readFileSync(file, 'utf8') === next) return false; } catch { /* first write */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, next);
  fs.renameSync(temporary, file);
  return true;
}

function readSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return settings?.version === 1 && typeof settings.sessionDir === 'string' ? settings : null;
  } catch { return null; }
}

/** One turn: starts the engine, mirrors its events into the chat, and resolves with how it ended. */
function runTurn({ engine, start, chat, reply, chatStore, signal }) {
  return new Promise((resolve) => {
    let failed = '';
    let output = '';
    const done = (result) => { engine.off('event', onEvent); signal?.removeEventListener?.('abort', onAbort); resolve(result); };
    const onAbort = () => engine.cancel();
    const onEvent = (event) => {
      if (event.type === 'tool_start') {
        if (!event.done && !Number.isFinite(event.startedAt)) event.startedAt = Date.now();
        chat.messages.push({ role: 'tool', event, offset: reply.text.length, done: Boolean(event.done), ...(Number.isFinite(event.startedAt) ? { startedAt: event.startedAt } : {}) });
        chatStore.save(chat);
      } else if (event.type === 'tool_end') {
        recordToolEnd(chat, event);
        chatStore.save(chat);
      } else if (event.type === 'session' && event.sessionId && event.agent === start.agent) {
        chat.sessions = { ...chat.sessions, [event.agent]: { ...chat.sessions?.[event.agent], id: event.sessionId } };
      } else if (event.type === 'delta') {
        const text = String(event.text || '');
        output = (output + text).slice(0, 800);
        reply.text += text;
        chatStore.checkpoint(chat);
        if (/^Unable to start\b/i.test(text)) failed = text;
      } else if (event.type === 'binary_missing') failed = `Agent binary not found: "${event.agent}"`;
      else if (event.type === 'upstream_error') failed = `Upstream unavailable (${event.agent}): ${event.detail}`;
      else if (event.type === 'approval_required' || event.type === 'question_required') {
        // Nobody is here to answer. Say so in the chat instead of hanging until a timeout.
        failed = 'The agent asked for approval or an answer, and no one is at the editor. Run this prompt from the editor, or allow what it needs.';
        engine.cancel();
      } else if (event.type === 'turn_complete') {
        const outage = !event.interrupted ? accessFailure(reply.text || output) : null;
        if (outage) failed = `${outage.reason} ${outage.detail}`;
        done({ failed, output, interrupted: Boolean(event.interrupted), outage, agent: event.agent });
      }
    };
    engine.on('event', onEvent);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try { engine.start(start); } catch (error) { failed = error.message; done({ failed, output, interrupted: false }); }
  });
}

/**
 * Runs every due task, one at a time, then returns. Safe to call from a timer every few minutes.
 * @param {object} options
 * @param {string} [options.sessionDir]    defaults to what the editor published
 * @param {object} [options.settings]      defaults to what the editor published
 * @param {() => Promise<object>} options.readQuotas
 * @param {(agent: string, text: string, title: string) => void} [options.notify]
 * @param {(options: object) => StreamEngine} [options.createEngine] for tests
 * @param {number} [options.maxTasks]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ skipped?: string, ran: { id: string, status: string }[] }>}
 */
async function runDue({ settings = readSettings(), sessionDir = settings?.sessionDir, readQuotas, refreshUsage = null, notify = null, createEngine = (opts) => new StreamEngine(opts), maxTasks = 10, signal = null, log = () => {} } = {}) {
  if (!sessionDir) return { skipped: 'not-set-up', ran: [] };
  const lock = new RunnerLock(sessionDir);
  const taken = lock.acquire();
  if (!taken.ok) return { skipped: taken.reason, ran: [] };
  const ran = [];
  try {
    const workspaceDir = settings?.workspaceDir || os.homedir();
    const queue = new SchedulerQueue({ workspaceDir, sessionDir });
    const chatStore = new ChatStore(sessionDir);
    const projects = new ProjectRegistry(sessionDir);
    await queue.load();
    const enabled = Array.isArray(settings?.enabledAgents) ? new Set(settings.enabledAgents) : null;
    // The editor's model picker (discovered models, which CLIs are on) is what task.modelId refers to.
    if (enabled) setEnabledAgents([...enabled]); else setEnabledAgents(providers.ids());
    if (Array.isArray(settings?.catalog) && settings.catalog.length) setModelCatalog(settings.catalog);
    const reachable = (task) => { try { const chat = task.chatId && chatStore.load(task.chatId); projects.context(task.projectId || chat?.projectId, { worktree: chat?.worktree }); return true; } catch { return false; } };

    for (let count = 0; count < maxTasks; count++) {
      if (signal?.aborted) break;
      // The editor was opened mid-run: finish nothing new, it takes the queue over.
      if (count && lock.ideAppeared()) return { skipped: 'ide-opened', ran };
      const tasks = await queue.getQueue();
      const states = new Map();
      const stateOf = (chatId) => { if (!states.has(chatId)) states.set(chatId, chatStore.load(chatId)?.turnQueue || {}); return states.get(chatId); };
      const due = tasks.filter((task) => task.status === 'pending' && (!enabled || enabled.has(task.model)) && isDue(task, Date.now()) && reachable(task)
        && (!task.chatId || firstPrompt(stateOf(task.chatId), tasks.filter((item) => item.chatId === task.chatId))?.id === task.id));
      if (!due.length) break;
      await refreshUsage?.(workspaceDir);
      const quotas = await readQuotas();
      const next = due.find((task) => quotaAvailable(quotas, task));
      if (!next) break; // everything due is waiting for usage; the next timer tick looks again
      const status = await runTask({ task: next, queue, chatStore, projects, settings, createEngine, notify, signal, log });
      ran.push({ id: next.id, status });
      if (status === 'busy') break;
    }
    return { ran };
  } finally { lock.release(); }
}

/** @returns {Promise<'done' | 'failed' | 'busy'>} */
async function runTask({ task, queue, chatStore, projects, settings, createEngine, notify, signal, log }) {
  const existing = task.chatId ? chatStore.load(task.chatId) : null;
  // A chat whose reply is still being written by some process is not ours to touch.
  if (existing && ownedByAnotherHost(existing)) return 'busy';
  if (existing && task.projectId && existing.projectId !== task.projectId) { await queue.markFailed(task.id, 'Scheduled task project does not match its conversation.'); return 'failed'; }
  const projectId = task.projectId || existing?.projectId;
  const { workspaceDir } = projects.context(projectId, { worktree: existing?.worktree });
  await queue.markDispatched(task.id);

  const chosen = modelOption(task.modelId);
  const option = (chosen?.agent === task.model ? chosen : defaultModel(task.model)) || {};
  const permissionMode = permissionFor(settings?.modelSettings, option, settings?.permissionMode || 'fullAccess');
  const engine = createEngine({ cwd: workspaceDir, models: settings?.models || {}, permissionMode });

  const reply = { role: 'assistant', text: '', agent: task.model, ...(option.id ? { modelId: option.id, modelLabel: option.label } : {}), inProgress: true, hostPid: process.pid };
  const user = { role: 'user', text: task.prompt, at: new Date().toISOString(), agent: task.model, ...(task.modelId ? { modelId: task.modelId } : {}), scheduled: true };
  let chat = existing || { ...chatStore.create(), projectId, title: `Scheduled: ${task.prompt.slice(0, 40)}`, messages: [] };
  const session = existing?.sessions?.[task.model] || null;
  const before = chat.messages.length;
  chat.messages.push(user, reply);
  chat = chatStore.save(chat);
  // The turn the agent sees: its own session when the chat has one; otherwise the chat so far, so it still knows what "continue" means.
  const text = appendInstructions(task.prompt, { modelPrompt: promptFor(settings?.modelPrompts, option) });
  const briefing = session?.id || !before ? '' : [`TASK STATE:\n${JSON.stringify(taskState(chat.messages.slice(0, before), { transcript: chatStore.transcript?.(chat) || null }))}`, buildHandoff(chat.messages.slice(0, before), task.model, { structured: true })].join('\n\n');
  const start = {
    agent: task.model,
    prompt: [briefing, text].filter(Boolean).join('\n\n'),
    model: option.model, effort: option.effort, permissionMode,
    resume: session?.id || null,
    attachments: (task.attachments || []).map((attachment) => path.resolve(task.workspaceDir || queue.workspaceDir, attachment.absolutePath || attachment.relativePath)),
  };
  log(`running ${task.id} with ${task.model} in ${workspaceDir}`);
  let result;
  try { result = await runTurn({ engine, start, chat, reply, chatStore, signal }); } finally { engine.dispose?.(); }

  delete reply.inProgress; delete reply.hostPid;
  reply.at = new Date().toISOString();
  if (result.interrupted) reply.interrupted = true;
  if (result.failed && !reply.text.trim()) reply.text = `Scheduled turn failed: ${result.failed}`;
  if (chat.sessions?.[task.model]) chat.sessions[task.model].seen = chat.messages.length;
  chatStore.save(chat);
  chatStore.flush?.(chat.id);

  if (result.failed) { await queue.markFailed(task.id, result.failed); return 'failed'; }
  if (result.interrupted) {
    // Stopped from outside (the machine is shutting down): the card offers Run now instead of pretending it finished.
    await queue.update(task.id, (item) => { item.status = 'interrupted'; item.interruptedAt = new Date().toISOString(); item.interruptedReason = 'The headless runner was stopped before the turn finished.'; });
    return 'failed';
  }
  await queue.markCompleted(task.id, result.output);
  notify?.(task.model, result.output, 'Scheduled task');
  return 'done';
}

module.exports = { runDue, publishSettings, readSettings, settingsFile, runTurn };
