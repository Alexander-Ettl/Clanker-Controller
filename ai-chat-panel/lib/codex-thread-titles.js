'use strict';

const { CodexAppServer } = require('./codex-app-server');
const { deriveFallbackTitle } = require('./chat-store');

function codexThreadTitle(chat, project) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  return `🤖 ${clean(project?.name) || 'Clanker Controller'} · ${clean(chat.title || deriveFallbackTitle(chat.messages))}`;
}

// One metadata-only connection for all chats, including saved threads that aren't open in a panel.
class CodexThreadTitles {
  constructor({ cwd, server = null, onError = error => require('./log.js').warn('codex thread title', error) } = {}) {
    this.cwd = cwd;
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
      } catch (error) { this.onError(error); }
      finally { if (this.pending.get(threadId) === name) this.pending.delete(threadId); }
    });
    return this.queue;
  }
  repairSaved(chatStore, projects) {
    let entries, index = 0;
    // Loading a chat parses its whole file on the host's thread (100 ms for the largest), so the pause between chats follows what the
    // last one cost: the repair takes about a fifth of the host's time and never a solid run of stalls.
    const next = () => {
      if (this.disposed) return;
      const started = Date.now();
      try {
        entries ||= chatStore.list().filter(chat => chat.models.includes('codex'));
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
