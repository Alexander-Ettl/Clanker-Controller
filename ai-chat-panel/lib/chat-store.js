'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const providers = require('./providers');

function safeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, ''); }

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

function writeChat(file, chat) {
  let previous;
  try { previous = readChat(file); } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && error.message !== 'Invalid chat snapshot') throw error;
  }
  if (previous && ownedByAnotherHost(previous)) throw new Error('This chat is running in another IDE window. Continue it in that window.');
  const text = JSON.stringify(chat);
  JSON.parse(text);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Never overwrite a good backup with a damaged primary snapshot.
    if (previous) fs.copyFileSync(file, file + '.bak');
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function deriveFallbackTitle(messages) {
  const firstUser = (messages || []).find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  if (!firstUser) return 'New chat';
  const cleaned = firstUser.text
    .replace(/^(\/[a-z0-9_-]+|\s+|[#*`>~_-])+/gi, ' ')
    .replace(/["'(){}\[\]]/g, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return 'New chat';
  return words.slice(0, 5).join(' ');
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

class ChatStore {
  constructor(sessionDir) {
    this.dir = path.join(sessionDir, 'chats');
    this.checkpoints = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
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
    this.cancelCheckpoint(chat.id);
    const clean = { ...chat, id: safeId(chat.id), updatedAt: new Date().toISOString(), messages: Array.isArray(chat.messages) ? chat.messages : [] };
    writeChat(this.fileFor(clean.id), clean);
    return clean;
  }

  // Throttle rather than debounce: a continuous response is saved every 250 ms.
  checkpoint(chat) {
    if (this.checkpoints.has(chat.id)) return;
    const timer = setTimeout(() => {
      this.checkpoints.delete(chat.id);
      try { this.save(chat); } catch (error) { console.error('[clanker] Could not checkpoint chat:', error.message); }
    }, 250);
    timer.unref?.();
    this.checkpoints.set(chat.id, { timer, chat });
  }

  cancelCheckpoint(id) {
    clearTimeout(this.checkpoints.get(id)?.timer);
    this.checkpoints.delete(id);
  }

  flush() { for (const { chat } of [...this.checkpoints.values()]) this.save(chat); }

  list() {
    const names = [...new Set(fs.readdirSync(this.dir).filter((name) => /\.json(?:\.bak)?$/.test(name)).map((name) => name.replace(/\.bak$/, '')))];
    return names.map((name) => {
      try {
        const file = path.join(this.dir, name);
        let chat;
        try { chat = readChat(file); } catch { chat = readChat(file + '.bak'); }
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        const title = chat.title || deriveFallbackTitle(messages);
        const lastMessage = findLastMessage(messages);
        return {
          id: chat.id,
          projectId: chat.projectId || null,
          title,
          customTitle: Boolean(chat.customTitle),
          lastMessage,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          lastRunAt: chat.lastRunAt,
          telegramTopicId: chat.telegramTopicId,
          telegramChatId: chat.telegramChatId,
          preview: title,
          // P16-K/M: which agents answered, for model badges on history cards.
          models: [...new Set(messages.map((message) => message.agent).filter((agent) => providers.has(agent)))],
          messageCount: messages.filter((message) => message.role === 'user' || message.role === 'assistant').length,
          empty: messages.length === 0 && !chat.turnQueue?.turns?.length,
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  load(id) {
    const file = this.fileFor(id);
    try { return readChat(file); } catch {
      try { return readChat(file + '.bak'); } catch { return null; }
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
    this.cancelCheckpoint(chat.id);
    writeChat(this.fileFor(chat.id), chat);
    return chat;
  }

  delete(id) {
    const file = this.fileFor(id);
    if (ownedByAnotherHost(this.load(id) || {})) throw new Error('This chat is running in another IDE window. Stop it there before deleting it.');
    this.cancelCheckpoint(id);
    const exists = fs.existsSync(file) || fs.existsSync(file + '.bak');
    for (const target of [file, file + '.bak']) if (fs.existsSync(target)) fs.unlinkSync(target);
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

