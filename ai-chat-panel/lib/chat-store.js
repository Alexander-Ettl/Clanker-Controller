'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function safeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, ''); }

class ChatStore {
  constructor(sessionDir) {
    this.dir = path.join(sessionDir, 'chats');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create() {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, messages: [] };
  }

  fileFor(id) {
    const clean = safeId(id);
    const match = fs.readdirSync(this.dir).find((name) => name.endsWith(`_${clean}.json`));
    return match ? path.join(this.dir, match) : path.join(this.dir, `${Date.now()}_${clean}.json`);
  }

  save(chat) {
    const clean = { ...chat, id: safeId(chat.id), updatedAt: new Date().toISOString(), messages: Array.isArray(chat.messages) ? chat.messages : [] };
    fs.writeFileSync(this.fileFor(clean.id), JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  list() {
    return fs.readdirSync(this.dir).filter((name) => name.endsWith('.json')).map((name) => {
      try {
        const chat = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        return {
          id: chat.id,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          lastRunAt: chat.lastRunAt,
          preview: chat.title || messages.find((message) => message.role === 'user')?.text?.slice(0, 400) || 'New chat',
          // P16-K/M: which agents answered, for model badges on history cards.
          models: [...new Set(messages.map((message) => message.agent).filter((agent) => ['claude', 'codex', 'gemini'].includes(agent)))],
          messageCount: messages.filter((message) => message.role === 'user' || message.role === 'assistant').length,
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  load(id) {
    try { return JSON.parse(fs.readFileSync(this.fileFor(id), 'utf8')); } catch { return null; }
  }

  /** Sets a chat's name; an empty name falls back to its first message. */
  rename(id, title) {
    const chat = this.load(id);
    if (!chat) return null;
    const name = String(title || '').trim().slice(0, 120);
    if (name) chat.title = name; else delete chat.title;
    fs.writeFileSync(this.fileFor(chat.id), JSON.stringify(chat, null, 2), 'utf8');
    return chat;
  }

  delete(id) {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
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

module.exports = { ChatStore, markActive, ACTIVE_WINDOW_MS };
