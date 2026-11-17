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
  dispose() { this.disposed = true; this.server?.dispose(); }
}

module.exports = { CodexThreadTitles, codexThreadTitle };
