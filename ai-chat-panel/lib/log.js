/**
 * The extension's log: what the Logs popup (media/log-viewer.js) and the "Clanker Controller" output channel show.
 *
 * One shared instance, so any module can `require('./log')` and write to it without being handed it. Entries are
 * kept in memory (the newest MAX_ENTRIES) for the popup; once activate() attaches a LogOutputChannel they also go
 * there, which VS Code keeps in its log folder for the session. Errors in the chat webview arrive through
 * `fromWebview` (media/error-report.js posts them).
 */
'use strict';

const MAX_ENTRIES = 2000;
const LEVELS = ['debug', 'info', 'warn', 'error'];
const MAX_TEXT = 8000; // one runaway message must not fill the buffer

let nextId = 1;
const entries = [];
const listeners = new Set();
let channel = null;

function clip(text) {
  const value = String(text ?? '');
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}… (${value.length - MAX_TEXT} more characters)` : value;
}

/** Turns what a caller passed (an Error, a string, an object) into a message and an optional stack/details text. */
function describe(value) {
  if (value instanceof Error) return { text: value.message || value.name, stack: value.stack || '' };
  if (value === undefined) return { text: '' };
  if (typeof value === 'string') return { text: value };
  try { return { text: JSON.stringify(value) }; } catch { return { text: String(value) }; }
}

/**
 * Adds an entry. `parts` are joined like console arguments; the first Error among them supplies the stack.
 * @returns the stored entry
 */
function write(level, source, ...parts) {
  if (!LEVELS.includes(level)) level = 'info';
  let stack = '';
  const texts = [];
  for (const part of parts) {
    const { text, stack: partStack } = describe(part);
    if (text) texts.push(text);
    if (!stack && partStack) stack = partStack;
  }
  return append({ level, source: String(source || 'extension'), message: texts.join(' '), stack });
}

function append({ level, source, message, stack = '', details = '', origin = 'host', time = Date.now() }) {
  const entry = { id: nextId++, time, level, source: clip(source).slice(0, 80), message: clip(message), stack: clip(stack), details: clip(details), origin };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    // Clicks and message traces go first, so a busy session does not push out the error you came to look for.
    const debug = entries.findIndex(item => item.level === 'debug');
    entries.splice(debug >= 0 ? debug : 0, 1);
  }
  if (channel) {
    const line = `[${entry.source}] ${entry.message}${entry.details ? `\n${entry.details}` : ''}${entry.stack ? `\n${entry.stack}` : ''}`;
    try {
      if (level === 'error') channel.error(line);
      else if (level === 'warn') channel.warn(line);
      else if (level === 'debug') channel.debug(line);
      else channel.info(line);
    } catch { /* a disposed channel during shutdown */ }
  }
  for (const listener of listeners) { try { listener(entry); } catch { /* a viewer that went away */ } }
  return entry;
}

/** A report from the chat webview. Only plain fields are kept, and each is clipped. */
function fromWebview(report) {
  if (!report || typeof report !== 'object') return null;
  return append({
    level: LEVELS.includes(report.level) ? report.level : 'error',
    source: typeof report.source === 'string' && report.source ? `webview: ${report.source}` : 'webview',
    message: typeof report.message === 'string' ? report.message : describe(report.message).text,
    stack: typeof report.stack === 'string' ? report.stack : '',
    details: typeof report.details === 'string' ? report.details : '',
    origin: 'webview',
  });
}

module.exports = {
  LEVELS,
  MAX_ENTRIES,
  debug: (source, ...parts) => write('debug', source, ...parts),
  info: (source, ...parts) => write('info', source, ...parts),
  warn: (source, ...parts) => write('warn', source, ...parts),
  error: (source, ...parts) => write('error', source, ...parts),
  write,
  /** Adds a prepared entry: { level, source, message, stack?, details? }. */
  add: (entry) => append({ ...entry, level: LEVELS.includes(entry?.level) ? entry.level : 'info', source: String(entry?.source || 'extension'), message: String(entry?.message ?? '') }),
  fromWebview,
  /** The stored entries, oldest first. */
  entries: () => entries.slice(),
  clear() { entries.length = 0; for (const listener of listeners) { try { listener(null); } catch { /* ignore */ } } },
  /** Called with each new entry, or with null after clear(). Returns an unsubscribe function. */
  onEntry(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  /** Mirrors entries into a VS Code LogOutputChannel (or anything with error/warn/info/debug). */
  attachChannel(next) { channel = next; },
  channel: () => channel,
  /** Plain text of the given entries, for Copy and for pasting into a bug report or a chat. */
  format(list = entries) {
    return list.map(entry => {
      const time = new Date(entry.time).toISOString().replace('T', ' ').replace('Z', '');
      return `${time} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}] ${entry.message}${entry.details ? `\n${entry.details}` : ''}${entry.stack ? `\n${entry.stack}` : ''}`;
    }).join('\n');
  },
};
