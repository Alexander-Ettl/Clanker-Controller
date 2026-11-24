'use strict';

const fs = require('node:fs');
const { CodexAppServer } = require('./codex-app-server');
const { deriveFallbackTitle } = require('./chat-store');

function codexThreadTitle(chat, project) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  return `🤖 ${clean(project?.name) || 'Clanker Controller'} · ${clean(chat.title || deriveFallbackTitle(chat.messages))}`;
}

function readState(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

// One metadata-only connection for all chats, including saved threads that aren't open in a panel.
class CodexThreadTitles {
  constructor({ cwd, server = null, stateFile = null, onError = error => require('./log.js').warn('codex thread title', error) } = {}) {
    this.cwd = cwd;
    // chat id -> the name last settled for it (sent, or answered "no rollout found": the thread is not on this computer).
    // Without it every start loaded every saved Codex chat again, on the host's thread, to send the names it already had.
    this.stateFile = stateFile;
    this.settled = readState(stateFile);
    this.server = server;
    this.onError = onError;
    this.names = new Map();
    this.pending = new Map();
    this.queue = Promise.resolve();
  }
  sync(chat, project) {
    const threadId = chat?.sessions?.codex?.id;
    if (!threadId || this.disposed) return Promise.resolve();
    const name = codexThreadTitle(chat, project);
    if (this.pending.get(threadId) === name || (!this.pending.has(threadId) && this.names.get(threadId) === name)) return this.queue;
    this.pending.set(threadId, name);
    this.queue = this.queue.then(async () => {
      if (this.disposed || this.pending.get(threadId) !== name) return;
      try {
        this.server ||= new CodexAppServer({ cwd: this.cwd });
        await this.server.request('thread/name/set', { threadId, name });
        this.names.set(threadId, name);
        this.settle(chat.id, name);
      } catch (error) {
        // A chat carried over from another computer names a thread this one never had. That will not change by retrying.
        if (/no rollout found/i.test(error?.message || '')) this.settle(chat.id, name);
        else this.onError(error);
      }
      finally { if (this.pending.get(threadId) === name) this.pending.delete(threadId); }
    });
    return this.queue;
  }
  settle(chatId, name) {
    if (!this.stateFile || !chatId || this.settled[chatId] === name) return;
    this.settled[chatId] = name;
    try { fs.writeFileSync(this.stateFile, JSON.stringify(this.settled), 'utf8'); } catch { /* only a cache: the next start looks again */ }
  }
  repairSaved(chatStore, projects) {
    let entries, index = 0;
    // Loading a chat parses its whole file on the host's thread (100 ms for the largest), so the pause between chats follows what the
    // last one cost: the repair takes about a fifth of the host's time and never a solid run of stalls.
    const next = () => {
      if (this.disposed) return;
      const started = Date.now();
      try {
        // The listing already holds each chat's title, so only chats whose name changed since it was settled are loaded.
        entries ||= chatStore.list().filter(chat => chat.models.includes('codex') && this.settled[chat.id] !== codexThreadTitle({ title: chat.title }, projects.get(chat.projectId)));
        const entry = entries[index++];
        if (!entry) return;
        const chat = chatStore.load(entry.id);
        if (chat) void this.sync(chat, projects.get(chat.projectId));
      } catch (error) { this.onError(error); }
      if (entries && index < entries.length) {
        this.repairTimer = setTimeout(next, Math.max(10, (Date.now() - started) * 4));
        this.repairTimer.unref?.();
      }
    };
    // Metadata maintenance must not read every saved conversation before the sidebar can open.
    this.repairTimer = setTimeout(next, 3000);
    this.repairTimer.unref?.();
  }
  dispose() { this.disposed = true; clearTimeout(this.repairTimer); this.server?.dispose(); }
}

module.exports = { CodexThreadTitles, codexThreadTitle };
