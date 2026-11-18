// @ts-check
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const providers = require('./providers');
const { ToolOutputStore } = require('./tool-output-store');
const { renderTranscript } = require('./chat-transcript');
const { readStored } = require('./work-context');

/** @typedef {import('../types/chat').Chat} Chat */
/** @typedef {import('../types/chat').ChatMessage} ChatMessage */
/** @typedef {import('../types/chat').ChatSummary} ChatSummary */
/** @typedef {{ trusted?: string | null }} CommitOptions */
/** @typedef {{ chat: Chat, settled: number, due: number, timer: ReturnType<typeof setTimeout> | null }} PendingCheckpoint */
/** @typedef {{ chat: Chat, promise?: Promise<void>, error?: unknown }} ChatWrite */
/** @typedef {{ count: number, first: ChatMessage | undefined, last: ChatMessage | undefined, at: number, bytes: Buffer }} SettledHead */
/** @typedef {{ stamp: string, summary: ChatSummary, files: string[] }} CachedSummary */

/** @param {unknown} error @returns {string | undefined} */
const codeOf = (error) => (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined);
/** @param {unknown} error @returns {string} */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** @param {unknown} value */
function safeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, ''); }

// Same-folder temp file, then rename. An agent reading the transcript on Windows can hold it open,
// which makes the rename fail; then the file is rewritten in place (the content is only a copy).
/** @param {string} file @param {string} text */
function writeTranscript(file, text) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    try { fs.renameSync(temporary, file); } catch { fs.writeFileSync(file, text, 'utf8'); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** @param {{ messages?: ChatMessage[] }} chat */
function ownedByAnotherHost(chat) {
  return (chat.messages || []).some(message => {
    const pid = message.hostPid;
    if (!message.inProgress || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return codeOf(error) === 'EPERM'; }
  });
}

// Only called when a run is restored from disk, never against a live run.
/** @param {Chat} chat */
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

/** @param {string} file @returns {Chat} */
function readChat(file) {
  const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!chat?.id || !Array.isArray(chat.messages)) throw new Error('Invalid chat snapshot');
  return chat;
}

// A checkpoint of a long chat used to re-read and parse the whole existing file just to see whether another IDE window owned
// it (over 100 ms for 18 MB), then copy it to .bak, all on the extension host's thread. `trusted` is the stamp this store left
// on the files after its own last commit: while it still matches nobody else has written, so the parse is skipped, and the
// backup (only a few hundred milliseconds older than the file itself) is refreshed at most every BACKUP_EVERY_MS.
const BACKUP_EVERY_MS = 15000;
const CHECKPOINT_MS = 250;
const HEAD_MAX_AGE_MS = 60000; // the cached history is rebuilt at least this often, a bound on any staleness
const SUMMARY_SCHEMA = 1; // bump when the shape of a cached summary changes, so an older index is ignored
const INDEX_WRITE_DELAY_MS = 2000;
const MESSAGES_TOKEN = `__clanker_messages_${crypto.randomUUID()}__`;
/** @param {string} file @param {string} temporary @param {CommitOptions} [options] */
function commitChat(file, temporary, { trusted = null } = {}) {
  /** @type {Chat | undefined} */
  let previous;
  let exists = false;
  if (trusted && snapshotStamp(file) === trusted) exists = true;
  else {
    try { previous = readChat(file); exists = true; } catch (error) {
      if (codeOf(error) !== 'ENOENT' && !(error instanceof SyntaxError) && messageOf(error) !== 'Invalid chat snapshot') throw error;
    }
    if (previous && ownedByAnotherHost(previous)) throw new Error('This chat is running in another IDE window. Continue it in that window.');
  }
  // Never overwrite a good backup with a damaged primary snapshot.
  if (exists) {
    let fresh = false;
    if (trusted) try { fresh = Date.now() - fs.statSync(file + '.bak').mtimeMs < BACKUP_EVERY_MS; } catch { /* no backup yet */ }
    if (!fresh) fs.copyFileSync(file, file + '.bak');
  }
  fs.renameSync(temporary, file);
}

/** @param {string} file @param {unknown} chat */
function writeChat(file, chat) {
  const text = JSON.stringify(chat);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    commitChat(file, temporary);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/**
 * @param {string} file
 * @param {unknown} chat a chat to stringify, or its snapshot already as text or bytes
 * @param {() => boolean} isCurrent
 * @param {CommitOptions} [options]
 * @returns {Promise<boolean>}
 */
async function writeChatAsync(file, chat, isCurrent, options) {
  const text = typeof chat === 'string' || Buffer.isBuffer(chat) ? chat : JSON.stringify(chat);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = await fs.promises.open(temporary, 'wx');
    try { await fd.writeFile(text, 'utf8'); await fd.sync(); } finally { await fd.close(); }
    // The commit is synchronous and guarded: an intervening final save, delete or
    // shutdown flush invalidates this checkpoint before it can replace newer data.
    if (!isCurrent()) return false;
    commitChat(file, temporary, options);
    return true;
  } finally { await fs.promises.unlink(temporary).catch(error => { if (codeOf(error) !== 'ENOENT') throw error; }); }
}

/** @param {ChatMessage[] | undefined} messages */
function deriveFallbackTitle(messages) {
  const firstUser = (messages || []).find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  if (!firstUser) return 'New chat';
  const cleaned = (firstUser.text || '')
    .split(/\r?\n/).find((line) => line.trim())
    ?.replace(/^(?:\/[a-z0-9_-]+\s*|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*#+\s*)/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]/g, '')
    .replace(/["'(){}\[\]]/g, '')
    .trim() || '';
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return 'New chat';
  return words.slice(0, 5).join(' ');
}

// The rail sorts chats by `updatedAt`, which has millisecond precision; saves within one millisecond tied and came out in
// directory order, so cleanup could drop a newer draft. Every stamp this process issues is later than the one before.
let lastStamp = 0;
function stamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

// A save stamps `updatedAt` even when nothing was said (closing a chat, switching away, the IDE shutting down), which made
// day-old chats read "Just now". When the chat is idle, "last active" is its newest message's own time instead.
/** @param {Chat} chat */
function lastActivityAt(chat) {
  const messages = chat.messages || [];
  if (messages.some((message) => message.inProgress)) return chat.updatedAt;
  let newest = '';
  for (const message of messages) if ((message.role === 'user' || message.role === 'assistant') && typeof message.at === 'string' && message.at > newest) newest = message.at;
  return newest && newest < String(chat.updatedAt) ? newest : chat.updatedAt;
}

/** @param {ChatMessage[] | undefined} messages @returns {ChatSummary['lastMessage']} */
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

/** @param {string} file */
function snapshotStamp(file) {
  return [file, file + '.bak'].map(target => {
    try { const stat = fs.statSync(target); return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
    catch (error) { if (codeOf(error) === 'ENOENT') return '-'; throw error; }
  }).join('|');
}

class ChatStore {
  /** @param {string} sessionDir */
  constructor(sessionDir) {
    this.dir = path.join(sessionDir, 'chats');
    /** @type {Map<string, PendingCheckpoint>} */
    this.checkpoints = new Map();
    /** @type {Map<string, ChatWrite>} */
    this.writes = new Map();
    /** @type {Map<string, string>} */
    this.stamps = new Map(); // file -> what its files looked like after this store's own last commit
    /** @type {Map<string, string>} */
    this.paths = new Map(); // chat id -> its snapshot file
    /** @type {Map<string, SettledHead>} */
    this.heads = new Map(); // chat id -> serialised settled messages, see serialise()
    /** @type {Map<string, number>} */
    this.writeCost = new Map(); // chat id -> how long its last checkpoint took, so long chats are written less often
    this.outputs = new ToolOutputStore(this.dir);
    /** @type {Map<string, CachedSummary>} */
    this.summaries = new Map(); // metadata only; never retain full transcripts or tool output
    /** @type {Map<string, string>} */
    this.transcripts = new Map(); // chat id -> hash of the transcript last written, so an unchanged chat is not rewritten
    // The summaries are also kept on disk, keyed by each snapshot's stamp. Without it the first listing after a restart parsed every
    // saved chat (about 2.4 s for 285 chats, 350 MB) on the extension host's thread; with it a listing only re-reads what changed.
    this.indexFile = path.join(sessionDir, 'chat-summaries.json');
    this.indexLoaded = false;
    this.indexDirty = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.indexTimer = null;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  loadIndex() {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    try {
      const index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (index?.v !== SUMMARY_SCHEMA || !index.entries || typeof index.entries !== 'object') return;
      for (const [name, entry] of Object.entries(index.entries)) {
        if (entry && typeof entry.stamp === 'string' && typeof entry.summary?.id === 'string' && Array.isArray(entry.files) && Array.isArray(entry.summary.models)) this.summaries.set(path.join(this.dir, name), entry);
      }
    } catch { /* no index yet, or damaged: summaries are rebuilt from the snapshots */ }
  }

  scheduleIndex() {
    if (!this.indexDirty || this.indexTimer) return;
    this.indexTimer = setTimeout(() => { this.indexTimer = null; void this.writeIndex(); }, INDEX_WRITE_DELAY_MS);
    this.indexTimer.unref?.();
  }

  /** Writes the summaries (a cache: no fsync, and a failure costs only the next cold listing). */
  async writeIndex() {
    this.indexDirty = false;
    /** @type {Record<string, CachedSummary>} */
    const entries = {};
    for (const [file, cached] of this.summaries) entries[path.basename(file)] = cached;
    const temporary = `${this.indexFile}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ v: SUMMARY_SCHEMA, entries }), 'utf8');
      await fs.promises.rename(temporary, this.indexFile);
    } catch (error) {
      this.indexDirty = true;
      await fs.promises.unlink(temporary).catch(() => {});
      require('./log.js').error('chat store', 'Could not write the chat summary index:', error);
    }
  }

  /**
   * The plain-text transcript of a chat, beside the snapshots: `chats/transcripts/<id>.md`. A subfolder, so neither list() nor the storage sweep sees it.
   * @param {string} id
   */
  transcriptFile(id) { return path.join(this.dir, 'transcripts', `${safeId(id)}.md`); }

  /**
   * Writes (when it changed) and indexes the chat's transcript for a briefing: `{ file, locate, turnOf }`,
   * or null when it cannot be written, so a briefing never points at a file that is not there.
   * @param {Chat} chat
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
    const now = stamp();
    return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, messages: [] };
  }

  /** @param {string} id */
  fileFor(id) {
    const clean = safeId(id);
    const names = fs.readdirSync(this.dir);
    const match = names.find((name) => name.endsWith(`_${clean}.json`)) || names.find((name) => name.endsWith(`_${clean}.json.bak`))?.slice(0, -4);
    return match ? path.join(this.dir, match) : path.join(this.dir, `${Date.now()}_${clean}.json`);
  }

  /** @param {Chat} chat @returns {Chat} */
  save(chat) {
    /** @type {Chat} */
    const clean = { ...chat, id: safeId(chat.id), updatedAt: stamp(), messages: Array.isArray(chat.messages) ? chat.messages : [] };
    const file = this.fileFor(clean.id);
    writeChat(file, this.outputs.encode(clean));
    this.cancelCheckpoint(chat.id);
    this.outputs.release(clean);
    this.cacheSummary(file, clean);
    return clean;
  }

  // Throttle rather than debounce: a continuous response is saved every 250 ms (longer when a write of a very long chat
  // takes longer than that, so saving never becomes the thing the host spends its time on).
  // `settled`: how many leading messages cannot change while this turn runs. Their serialised form is kept between
  // checkpoints, so a long chat is not stringified again for every few words of the reply. Whatever edits one of those messages
  // in place must save() the chat (which drops the kept form) rather than checkpoint it. `delay` brings a checkpoint
  // forward (tool boundaries), never beyond the throttle.
  /** @param {Chat} chat @param {{ settled?: number, delay?: number }} [options] */
  checkpoint(chat, { settled = 0, delay = CHECKPOINT_MS } = {}) {
    const wait = delay === 0 ? 0 : Math.max(delay, this.writeCost.get(chat.id) || 0); // delay 0 (a new session id) is never held back by the cost of earlier writes
    const pending = this.checkpoints.get(chat.id);
    if (pending) {
      pending.chat = chat; pending.settled = settled;
      if (!(wait < pending.due - Date.now())) return;
      if (pending.timer) clearTimeout(pending.timer);
    }
    /** @type {PendingCheckpoint} */
    const entry = pending || { chat, settled, due: 0, timer: null };
    entry.due = Date.now() + wait;
    entry.timer = setTimeout(() => this.runCheckpoint(entry), wait);
    entry.timer.unref?.();
    this.checkpoints.set(chat.id, entry);
  }

  /** @param {PendingCheckpoint} entry */
  runCheckpoint(entry) {
    const id = entry.chat.id;
    if (this.checkpoints.get(id) !== entry) return;
    const { chat: latest, settled } = entry;
    this.checkpoints.delete(id);
    /** @type {ChatWrite} */
    const write = { chat: latest };
    const previous = this.writes.get(id);
    this.writes.set(id, write);
    write.promise = (async () => {
      if (previous) await previous.promise;
      if (this.writes.get(id) !== write) return;
      const started = Date.now();
      const clean = { ...latest, updatedAt: stamp() };
      const file = this.cachedFile(id);
      const trusted = this.stamps.get(file) || null;
      const text = this.serialise(clean, settled);
      if (await writeChatAsync(file, text, () => this.writes.get(id) === write, { trusted })) {
        this.stamps.set(file, snapshotStamp(file));
        this.outputs.release(clean); this.summaries.delete(file);
        this.writeCost.set(id, Math.min(2000, Math.round((Date.now() - started) * 1.5)));
      }
    })().catch(error => {
      require('./log.js').error('chat store', 'Could not checkpoint chat:', error);
      // Keep failed work flushable at shutdown or the next explicit save.
      write.error = error;
    }).finally(() => { if (!write.error && this.writes.get(id) === write) this.writes.delete(id); });
  }

  /**
   * The snapshot (text, or bytes when the settled history is reused). With `settled`, the first `settled` messages come
   * from the previous serialisation when it is still valid.
   * @param {Chat} chat @param {number} settled @returns {string | Buffer}
   */
  serialise(chat, settled) {
    const messages = chat.messages || [];
    if (!(settled > 0 && settled <= messages.length)) { this.heads.delete(chat.id); return JSON.stringify(this.outputs.encode(chat)); }
    let head = this.heads.get(chat.id);
    if (!head || head.count !== settled || head.first !== messages[0] || head.last !== messages[settled - 1] || Date.now() - head.at > HEAD_MAX_AGE_MS) {
      const encoded = this.outputs.encode({ ...chat, messages: messages.slice(0, settled) }).messages;
      head = { count: settled, first: messages[0], last: messages[settled - 1], at: Date.now(), bytes: Buffer.from(encoded.map(message => JSON.stringify(message)).join(','), 'utf8') };
      this.heads.set(chat.id, head);
    }
    const tail = this.outputs.encode({ ...chat, messages: messages.slice(settled) });
    const shell = JSON.stringify({ ...tail, messages: MESSAGES_TOKEN });
    const at = shell.indexOf(`"${MESSAGES_TOKEN}"`);
    if (at < 0) return JSON.stringify(this.outputs.encode(chat));
    const rest = tail.messages.map(message => JSON.stringify(message)).join(',');
    // Bytes, not text: the settled part is encoded to UTF-8 once, not at every write.
    return Buffer.concat([Buffer.from(`${shell.slice(0, at)}[`, 'utf8'), head.bytes, Buffer.from(`${head.bytes.length && rest ? ',' : ''}${rest}]${shell.slice(at + MESSAGES_TOKEN.length + 2)}`, 'utf8')]);
  }

  /**
   * The chat's file without listing the folder each time; a missing file is looked up again.
   * @param {string} id
   */
  cachedFile(id) {
    const known = this.paths.get(id);
    if (known && fs.existsSync(known)) return known;
    const file = this.fileFor(id);
    this.paths.set(id, file);
    return file;
  }

  /** @param {string} id */
  cancelCheckpoint(id) {
    const timer = this.checkpoints.get(id)?.timer;
    if (timer) clearTimeout(timer);
    this.checkpoints.delete(id);
    this.writes.delete(id);
    this.heads.delete(id);
    this.writeCost.delete(id);
  }

  /** @param {string | null} [id] */
  flush(id = null) {
    const dirty = new Map([...this.writes.values(), ...this.checkpoints.values()].map(({ chat }) => [chat.id, chat]));
    for (const chat of dirty.values()) if (id === null || chat.id === id) this.save(chat);
  }

  /** @param {string} file @param {Chat} chat @param {string} [stamp] @returns {CachedSummary} */
  cacheSummary(file, chat, stamp = snapshotStamp(file)) {
    const messages = chat.messages || [];
    const title = chat.title || deriveFallbackTitle(messages);
    /** @type {ChatSummary} */
    const summary = {
      id: chat.id, projectId: chat.projectId || null, title, customTitle: Boolean(chat.customTitle),
      lastMessage: findLastMessage(messages), createdAt: chat.createdAt, updatedAt: lastActivityAt(chat),
      lastRunAt: chat.lastRunAt, telegramTopicId: chat.telegramTopicId, telegramChatId: chat.telegramChatId,
      preview: title,
      models: [...new Set(/** @type {string[]} */ (messages.map(message => message.agent).filter(agent => agent && providers.has(agent))))],
      // `models` lists agents by first appearance; the rail shows who actually worked last (Claude, Codex, Claude: Claude).
      latestAgent: messages.findLast(message => message.role === 'assistant' && !message.compact && providers.has(message.agent || ''))?.agent || null,
      workContext: readStored(chat.workContext),
      messageCount: messages.filter(message => message.role === 'user' || message.role === 'assistant').length,
      hasTypedMessage: Boolean(chat.textEntered || chat.draft?.length || chat.draftAttachments?.length),
      empty: messages.length === 0 && !chat.turnQueue?.turns?.length,
    };
    const files = [...new Set(messages.filter(message => message.role === 'tool' && typeof message.event?.file === 'string').map(message => String(message.event?.file)).reverse())];
    const cached = { stamp, summary, files };
    this.summaries.set(file, cached);
    this.indexDirty = true;
    return cached;
  }

  /**
   * `projectOf(file)` names the project a file belongs to; each chat then lists the projects its tools touched, latest first.
   * @param {((file: string) => string | null | undefined) | null} [projectOf]
   */
  list(projectOf = null) {
    this.loadIndex();
    const names = [...new Set(fs.readdirSync(this.dir).filter((name) => /\.json(?:\.bak)?$/.test(name)).map((name) => name.replace(/\.bak$/, '')))];
    const present = new Set(names.map(name => path.join(this.dir, name)));
    for (const file of this.summaries.keys()) if (!present.has(file)) { this.summaries.delete(file); this.indexDirty = true; }
    const listed = names.map((name) => {
      try {
        const file = path.join(this.dir, name);
        const stamp = snapshotStamp(file);
        let cached = this.summaries.get(file);
        if (!cached || cached.stamp !== stamp) {
          /** @type {Chat} */
          let chat;
          try { chat = readChat(file); } catch { chat = readChat(file + '.bak'); }
          cached = this.cacheSummary(file, chat, stamp);
        }
        const { summary, files } = cached;
        return { ...summary, lastMessage: summary.lastMessage && { ...summary.lastMessage }, models: [...summary.models], workContext: summary.workContext && { ...summary.workContext },
          touchedProjectIds: projectOf ? [...new Set(files.map(projectOf).filter(Boolean))] : [] };
      } catch { return null; }
    }).filter(/** @template T @param {T | null} entry @returns {entry is T} */ (entry) => entry !== null).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    this.scheduleIndex();
    return listed;
  }

  /** @param {string} id @returns {Chat | null} */
  load(id) {
    const file = this.fileFor(id);
    try { return this.outputs.decode(readChat(file)); } catch {
      try { return this.outputs.decode(readChat(file + '.bak')); } catch { return null; }
    }
  }

  /**
   * Sets a chat's name; an empty name falls back to its first message.
   * @param {string} id @param {unknown} title
   */
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

  /** @param {string} id */
  delete(id) {
    const file = this.fileFor(id);
    if (ownedByAnotherHost(this.load(id) || {})) throw new Error('This chat is running in another IDE window. Stop it there before deleting it.');
    this.cancelCheckpoint(id);
    const exists = fs.existsSync(file) || fs.existsSync(file + '.bak');
    for (const target of [file, file + '.bak', this.transcriptFile(id)]) if (fs.existsSync(target)) fs.unlinkSync(target);
    this.summaries.delete(file);
    this.transcripts.delete(id);
    this.paths.delete(id);
    this.stamps.delete(file);
    return exists;
  }
}

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Manage Chats: a chat is active while an agent runs in it (`live`: id -> 'running' | 'waiting'), or ran one in the last five minutes.
 * @template {{ id: string, lastRunAt?: string }} S
 * @param {S[]} sessions @param {Map<string, string>} [live] @param {number} [now]
 */
function markActive(sessions, live = new Map(), now = Date.now()) {
  return sessions.map((session) => {
    const state = live.get(session.id) || null;
    const ranAt = session.lastRunAt ? Date.parse(session.lastRunAt) : NaN;
    return { ...session, state, active: Boolean(state) || now - ranAt < ACTIVE_WINDOW_MS };
  });
}

module.exports = { ChatStore, markActive, ACTIVE_WINDOW_MS, deriveFallbackTitle, findLastMessage, recoverInterruptedChat, ownedByAnotherHost };
