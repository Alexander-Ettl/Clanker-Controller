'use strict';

const { CodexAppServer } = require('./codex-app-server');
const { taskState } = require('./chat-handoff');

const textOf = item => item.type === 'userMessage' ? (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim() : item.text || '';
const iso = seconds => Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

// Bootstrap older Clanker chats from their last original user message, never from the handoff prefix.
function anchorTurn(chat, turns) {
  if (chat.codexSync?.threadId === chat.sessions?.codex?.id) return turns.some(turn => turn.id === chat.codexSync.turnId) ? chat.codexSync.turnId : null;
  const user = chat.messages.findLast(message => message.role === 'user' && message.agent === 'codex');
  if (!user) return null;
  return [...turns].reverse().find(turn => turn.items.some(item => item.type === 'userMessage' &&
    textOf(item).endsWith(user.text.trim()) && Math.abs(turn.startedAt * 1000 - Date.parse(user.at)) < 120000))?.id || null;
}

function mergeTurns(chat, turns, anchor) {
  const threadId = chat.sessions.codex.id;
  const anchorIndex = turns.findIndex(turn => turn.id === anchor);
  if (anchorIndex < 0) return { changed: false, active: false };
  let changed = false, active = false;
  const before = chat.messages.length;
  for (const turn of turns.slice(anchorIndex + 1)) {
    active = turn.status === 'inProgress';
    const records = [];
    for (const item of turn.items || []) {
      if (['commandExecution', 'mcpToolCall', 'webSearch', 'fileChange'].includes(item.type)) {
        const previous = records.findLast(record => record.role === 'assistant');
        const output = item.aggregatedOutput || item.result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || '';
        records.push({ role: 'tool', event: { type: 'tool_start', agent: 'codex', toolId: item.id,
          name: item.type === 'commandExecution' ? 'bash' : item.type === 'mcpToolCall' ? `${item.server}.${item.tool}` : item.type === 'webSearch' ? 'search_web' : 'edit',
          command: item.command || item.query || JSON.stringify(item.arguments || item.changes || {}), output },
          offset: previous?.text.length || 0, done: item.status !== 'inProgress', error: item.status === 'failed',
          codexThreadId: threadId, codexTurnId: turn.id, codexItemId: item.id });
        continue;
      }
      if (!['userMessage', 'agentMessage'].includes(item.type)) continue;
      const text = textOf(item);
      if (!text) continue;
      records.push({ role: item.type === 'userMessage' ? 'user' : 'assistant', text, agent: 'codex',
        ...(item.type === 'agentMessage' ? { modelLabel: 'ChatGPT / Codex', interrupted: turn.status === 'interrupted' } : {}),
        at: Number.isFinite(item.startedAtMs) ? new Date(item.startedAtMs).toISOString() : iso(turn.startedAt),
        codexThreadId: threadId, codexTurnId: turn.id, codexItemId: item.id });
    }
    for (const record of records) {
      const existing = chat.messages.find(message => message.codexThreadId === threadId && message.codexItemId === record.codexItemId);
      if (!existing) { chat.messages.push(record); changed = true; }
      else if (JSON.stringify(existing) !== JSON.stringify(record)) { Object.assign(existing, record); changed = true; }
    }
  }
  // Only advance over completed external turns. Keep the anchor while a partial answer is growing.
  const latest = [...turns.slice(anchorIndex)].reverse().find(turn => turn.status !== 'inProgress');
  if (latest && chat.codexSync?.turnId !== latest.id) {
    chat.codexSync = { threadId, turnId: latest.id };
    changed = true;
  }
  if (changed && chat.sessions.codex.seen === before) chat.sessions.codex.seen = chat.messages.length;
  return { changed, active };
}

class CodexChatSync {
  constructor({ cwd, runs = () => [], server = null, onError = error => require('./log.js').warn('codex chat sync', error), intervalMs = 2000 } = {}) {
    this.cwd = cwd; this.runs = runs; this.server = server; this.onError = onError;
    this.pending = new Map();
    this.timer = setInterval(() => { for (const run of this.runs()) if (run.hosts.size || run.externalCodexTurn && run.queue.length) void this.sync(run); }, intervalMs);
    this.timer.unref?.();
  }
  sync(run) {
    if (this.disposed || run.turn || run.starting || !run.chat.sessions?.codex?.id) return Promise.resolve();
    if (this.pending.has(run)) return this.pending.get(run);
    const task = this.read(run).catch(this.onError).finally(() => this.pending.delete(run));
    this.pending.set(run, task);
    return task;
  }
  async read(run) {
    const chat = run.chat, threadId = chat.sessions.codex.id;
    this.server ||= new CodexAppServer({ cwd: this.cwd });
    let turns = [], cursor = null, anchor = null;
    do {
      const page = await this.server.request('thread/turns/list', { threadId, limit: 50, itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
      turns = [...page.data].reverse().concat(turns);
      anchor = anchorTurn(chat, turns);
      cursor = page.nextCursor;
    } while (!anchor && cursor && !this.disposed);
    // A local send or a thread switch during the read owns the chat now.
    if (this.disposed || run.turn || run.starting || run.chat !== chat || chat.sessions.codex.id !== threadId || !anchor) return;
    const { changed, active } = mergeTurns(chat, turns, anchor);
    const activityChanged = Boolean(run.externalCodexTurn) !== active;
    run.externalCodexTurn = active;
    if (changed) { chat.taskState = taskState(chat.messages); run.save(); run.deps.notifyHistory(); }
    if (changed || activityChanged) for (const host of run.hosts) host.replay({ synced: true });
    if (!active && activityChanged) void run.drain();
  }
  dispose() { this.disposed = true; clearInterval(this.timer); this.server?.dispose(); }
}

module.exports = { CodexChatSync, mergeTurns, anchorTurn };
