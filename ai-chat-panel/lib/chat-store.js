'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const providers = require('./providers');
const { ToolOutputStore } = require('./tool-output-store');
const { renderTranscript } = require('./chat-transcript');
const { readStored } = require('./work-context');

function safeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, ''); }

// Same-folder temp file, then rename. An agent reading the transcript on Windows can hold it open,
// which makes the rename fail; then the file is rewritten in place (the content is only a copy).
function writeTranscript(file, text) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    try { fs.renameSync(temporary, file); } catch { fs.writeFileSync(file, text, 'utf8'); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function ownedByAnotherHost(chat) {
  return (chat.messages || []).some(message => {
    if (!message.inProgress || !Number.isInteger(message.hostPid) || message.hostPid <= 0 || message.hostPid === process.pid) return false;
    try { process.kill(message.hostPid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  });
}

// Only called when a run is restored from disk, never against a live run.
function recoverInterruptedChat(chat) {
  if (ownedByAnotherHost(chat)) return false;
  let recovered = false;
  let interruptedTurn = false;
  for (const message of chat.messages || []) {
    if (message.role === 'user') interruptedTurn = false;
    if (message.role === 'tool' && interruptedTurn && message.done === false) message.interrupted = true;
    if (message.role === 'assistant') interruptedTurn = message.interruptionReason === 'host_shutdown';
    if (message.role !== 'assistant' || !(message.inProgress || (!message.at && !message.interrupted))) continue;
    delete message.inProgress;
    delete message.hostPid;
    message.interrupted = true;
    message.interruptionReason = 'host_shutdown';
    message.at = chat.updatedAt || new Date().toISOString();
    recovered = true;
    interruptedTurn = true;
  }
  if (recovered && chat.turnQueue?.turns?.length) chat.turnQueue.paused = true;
  return recovered;
}

function readChat(file) {
  const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!chat?.id || !Array.isArray(chat.messages)) throw new Error('Invalid chat snapshot');
  return chat;
}

function commitChat(file, temporary) {
  let previous;
  try { previous = readChat(file); } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && error.message !== 'Invalid chat snapshot') throw error;
  }
  if (previous && ownedByAnotherHost(previous)) throw new Error('This chat is running in another IDE window. Continue it in that window.');
  // Never overwrite a good backup with a damaged primary snapshot.
  if (previous) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(temporary, file);
}

function writeChat(file, chat) {
  const text = JSON.stringify(chat);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    commitChat(file, temporary);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function writeChatAsync(file, chat, isCurrent) {
  const text = JSON.stringify(chat);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = await fs.promises.open(temporary, 'wx');
    try { await fd.writeFile(text, 'utf8'); await fd.sync(); } finally { await fd.close(); }
    // The commit is synchronous and guarded: an intervening final save, delete or
    // shutdown flush invalidates this checkpoint before it can replace newer data.
    if (!isCurrent()) return false;
    commitChat(file, temporary);
    return true;
  } finally { await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function deriveFallbackTitle(messages) {
  const firstUser = (messages || []).find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  if (!firstUser) return 'New chat';
  const cleaned = firstUser.text
    .split(/\r?\n/).find((line) => line.trim())
    .replace(/^(?:\/[a-z0-9_-]+\s*|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*#+\s*)/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]/g, '')
    .replace(/["'(){}\[\]]/g, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return 'New chat';
  return words.slice(0, 5).join(' ');
}

// A save stamps `updatedAt` even when nothing was said (closing a chat, switching away, the IDE shutting down), which made
// day-old chats read "Just now". When the chat is idle, "last active" is its newest message's own time instead.
function lastActivityAt(chat) {
  const messages = chat.messages || [];
  if (messages.some((message) => message.inProgress)) return chat.updatedAt;
  let newest = '';
  for (const message of messages) if ((message.role === 'user' || message.role === 'assistant') && typeof message.at === 'string' && message.at > newest) newest = message.at;
  return newest && newest < String(chat.updatedAt) ? newest : chat.updatedAt;
}

function findLastMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim()) {
      return {
        role: m.role,
        agent: m.agent || null,
        modelLabel: m.modelLabel || null,
        text: m.text.trim().slice(0, 400),
        at: m.at || null,
      };
    }
  }
  return null;
}

function snapshotStamp(file) {
  return [file, file + '.bak'].map(target => {
    try { const stat = fs.statSync(target); return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
    catch (error) { if (error.code === 'ENOENT') return '-'; throw error; }
  }).join('|');
}

class ChatStore {
  constructor(sessionDir) {
    this.dir = path.join(sessionDir, 'chats');
    this.checkpoints = new Map();
    this.writes = new Map();
    this.outputs = new ToolOutputStore(this.dir);
    this.summaries = new Map(); // metadata only; never retain full transcripts or tool output
    this.transcripts = new Map(); // chat id -> hash of the transcript last written, so an unchanged chat is not rewritten
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** The plain-text transcript of a chat, beside the snapshots: `chats/transcripts/<id>.md`. A subfolder, so neither list() nor the storage sweep sees it. */
  transcriptFile(id) { return path.join(this.dir, 'transcripts', `${safeId(id)}.md`); }

  /**
   * Writes (when it changed) and indexes the chat's transcript for a briefing: `{ file, locate, turnOf }`,
   * or null when it cannot be written, so a briefing never points at a file that is not there.
   */
  transcript(chat) {
    try {
      const model = renderTranscript(chat);
      const file = this.transcriptFile(chat.id);
      const hash = crypto.createHash('sha256').update(model.text).digest('hex');
      if (this.transcripts.get(chat.id) !== hash || !fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeTranscript(file, model.text);
        this.transcripts.set(chat.id, hash);
      }
      return { file, locate: model.locate, turnOf: model.turnOf };
    } catch (error) {
      require('./log.js').error('chat store', 'Could not write chat transcript:', error);
      return null;
    }
  }

  create() {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, messages: [] };
  }

  fileFor(id) {
    const clean = safeId(id);
    const names = fs.readdirSync(this.dir);
    const match = names.find((name) => name.endsWith(`_${clean}.json`)) || names.find((name) => name.endsWith(`_${clean}.json.bak`))?.slice(0, -4);
    return match ? path.join(this.dir, match) : path.join(this.dir, `${Date.now()}_${clean}.json`);
  }

  save(chat) {
    const clean = { ...chat, id: safeId(chat.id), updatedAt: new Date().toISOString(), messages: Array.isArray(chat.messages) ? chat.messages : [] };
    const file = this.fileFor(clean.id);
    writeChat(file, this.outputs.encode(clean));
    this.cancelCheckpoint(chat.id);
    this.outputs.release(clean);
    this.cacheSummary(file, clean);
    return clean;
  }

  // Throttle rather than debounce: a continuous response is saved every 250 ms.
  checkpoint(chat) {
    if (this.checkpoints.has(chat.id)) { this.checkpoints.get(chat.id).chat = chat; return; }
    const timer = setTimeout(() => {
      const latest = this.checkpoints.get(chat.id)?.chat;
      this.checkpoints.delete(chat.id);
      const write = { chat: latest };
      const previous = this.writes.get(chat.id);
      this.writes.set(chat.id, write);
      write.promise = (async () => {
        if (previous) await previous.promise;
        if (this.writes.get(chat.id) !== write) return;
        const clean = { ...latest, updatedAt: new Date().toISOString() };
        const file = this.fileFor(chat.id);
        if (await writeChatAsync(file, this.outputs.encode(clean), () => this.writes.get(chat.id) === write)) {
          this.outputs.release(clean); this.summaries.delete(file);
        }
      })().catch(error => {
        require('./log.js').error('chat store', 'Could not checkpoint chat:', error);
        // Keep failed work flushable at shutdown or the next explicit save.
        write.error = error;
      }).finally(() => { if (!write.error && this.writes.get(chat.id) === write) this.writes.delete(chat.id); });
    }, 250);
    timer.unref?.();
    this.checkpoints.set(chat.id, { timer, chat });
  }

  cancelCheckpoint(id) {
    clearTimeout(this.checkpoints.get(id)?.timer);
    this.checkpoints.delete(id);
    this.writes.delete(id);
  }

  flush(id = null) {
    const dirty = new Map([...this.writes.values(), ...this.checkpoints.values()].map(({ chat }) => [chat.id, chat]));
    for (const chat of dirty.values()) if (id === null || chat.id === id) this.save(chat);
  }

  cacheSummary(file, chat, stamp = snapshotStamp(file)) {
    const messages = chat.messages || [];
    const title = chat.title || deriveFallbackTitle(messages);
    const summary = {
      id: chat.id, projectId: chat.projectId || null, title, customTitle: Boolean(chat.customTitle),
      lastMessage: findLastMessage(messages), createdAt: chat.createdAt, updatedAt: lastActivityAt(chat),
      lastRunAt: chat.lastRunAt, telegramTopicId: chat.telegramTopicId, telegramChatId: chat.telegramChatId,
      preview: title,
      models: [...new Set(messages.map(message => message.agent).filter(agent => providers.has(agent)))],
      // `models` lists agents by first appearance; the rail shows who actually worked last (Claude, Codex, Claude: Claude).
      latestAgent: messages.findLast(message => message.role === 'assistant' && !message.compact && providers.has(message.agent))?.agent || null,
      workContext: readStored(chat.workContext),
      messageCount: messages.filter(message => message.role === 'user' || message.role === 'assistant').length,
      hasTypedMessage: Boolean(chat.textEntered || chat.draft?.length || chat.draftAttachments?.length),
      empty: messages.length === 0 && !chat.turnQueue?.turns?.length,
    };
    const files = [...new Set(messages.filter(message => message.role === 'tool' && typeof message.event?.file === 'string').map(message => message.event.file).reverse())];
    const cached = { stamp, summary, files };
    this.summaries.set(file, cached);
    return cached;
  }

  /** `projectOf(file)` names the project a file belongs to; each chat then lists the projects its tools touched, latest first. */
  list(projectOf = null) {
    const names = [...new Set(fs.readdirSync(this.dir).filter((name) => /\.json(?:\.bak)?$/.test(name)).map((name) => name.replace(/\.bak$/, '')))];
    const present = new Set(names.map(name => path.join(this.dir, name)));
    for (const file of this.summaries.keys()) if (!present.has(file)) this.summaries.delete(file);
    return names.map((name) => {
      try {
        const file = path.join(this.dir, name);
        const stamp = snapshotStamp(file);
        let cached = this.summaries.get(file);
        if (!cached || cached.stamp !== stamp) {
          let chat;
          try { chat = readChat(file); } catch { chat = readChat(file + '.bak'); }
          cached = this.cacheSummary(file, chat, stamp);
        }
        const { summary, files } = cached;
        return { ...summary, lastMessage: summary.lastMessage && { ...summary.lastMessage }, models: [...summary.models], workContext: summary.workContext && { ...summary.workContext },
          touchedProjectIds: projectOf ? [...new Set(files.map(projectOf).filter(Boolean))] : [] };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  load(id) {
    const file = this.fileFor(id);
    try { return this.outputs.decode(readChat(file)); } catch {
      try { return this.outputs.decode(readChat(file + '.bak')); } catch { return null; }
    }
  }

  /** Sets a chat's name; an empty name falls back to its first message. */
  rename(id, title) {
    const chat = this.load(id);
    if (!chat) return null;
    const name = String(title || '').trim().slice(0, 120);
    if (name) {
      chat.title = name;
      chat.customTitle = true;
    } else {
      delete chat.title;
      delete chat.customTitle;
    }
    const file = this.fileFor(chat.id);
    writeChat(file, this.outputs.encode(chat));
    this.cancelCheckpoint(chat.id);
    this.outputs.release(chat);
    this.cacheSummary(file, chat);
    return chat;
  }

  delete(id) {
    const file = this.fileFor(id);
    if (ownedByAnotherHost(this.load(id) || {})) throw new Error('This chat is running in another IDE window. Stop it there before deleting it.');
    this.cancelCheckpoint(id);
    const exists = fs.existsSync(file) || fs.existsSync(file + '.bak');
    for (const target of [file, file + '.bak', this.transcriptFile(id)]) if (fs.existsSync(target)) fs.unlinkSync(target);
    this.summaries.delete(file);
    this.transcripts.delete(id);
    return exists;
  }
}

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** Manage Chats: a chat is active while an agent runs in it (`live`: id -> 'running' | 'waiting'), or ran one in the last five minutes. */
function markActive(sessions, live = new Map(), now = Date.now()) {
  return sessions.map((session) => {
    const state = live.get(session.id) || null;
    const ranAt = session.lastRunAt ? Date.parse(session.lastRunAt) : NaN;
    return { ...session, state, active: Boolean(state) || now - ranAt < ACTIVE_WINDOW_MS };
  });
}

module.exports = { ChatStore, markActive, ACTIVE_WINDOW_MS, deriveFallbackTitle, findLastMessage, recoverInterruptedChat, ownedByAnotherHost };
