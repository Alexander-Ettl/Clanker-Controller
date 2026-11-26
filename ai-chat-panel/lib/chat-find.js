'use strict';
// Find in chat (Ctrl+F in the chat window, media/chat-find.js): counts where a phrase occurs in the whole conversation,
// including the history the window has not loaded yet. Only message text is searched: your prompts and the replies, not
// tool output or thoughts. A turn is numbered like the window numbers it (data-user-index): the how-many-th user message
// it starts with, so a hit in history that was never sent to the window can still be loaded and shown.
//
// Cheap per keystroke: each message's searchable text is normalised once and cached against its length, so only a reply
// that is still streaming is normalised again; a search is one indexOf pass per message.

/** Markdown as the reader sees it: no fences, emphasis markers, link targets, list or heading marks. */
function plainText(markdown) {
  return String(markdown || '')
    .replace(/^\s*(```|~~~)[^\n]*$/gm, ' ') // fence lines and their language tags
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images: their alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: their text
    .replace(/<\/?[a-z][^>]*>/gi, ' ') // inline HTML tags
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '') // heading, quote and list marks
    .replace(/\*\*|__|~~|`/g, '') // strong, strike and code marks
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1$2') // *emphasis*
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ' ') // table rules
    .replace(/\|/g, ' '); // table cells
}

/** What both sides compare: lower case, every run of whitespace one space. */
function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ');
}

/** Non-overlapping occurrences, the way a find bar steps through them. */
function countIn(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

class ChatFind {
  constructor() {
    this.texts = new WeakMap(); // message -> { length, text }
  }

  textOf(message) {
    const raw = typeof message.text === 'string' ? message.text : '';
    const cached = this.texts.get(message);
    if (cached && cached.length === raw.length && cached.raw === raw) return cached.text;
    const text = normalize(plainText(raw));
    this.texts.set(message, { length: raw.length, raw, text });
    return text;
  }

  /**
   * [[turn, count], ...] for every turn with a match, oldest first. Hidden turns (a compaction the window shows as a
   * divider) and the record of a compaction's summary are skipped, as the window skips them.
   */
  find(messages = [], query = '') {
    const needle = normalize(query);
    if (!needle.trim()) return [];
    const out = [];
    let turn = -1, hidden = false, count = 0;
    const close = () => { if (turn >= 0 && !hidden && count) out.push([turn, count]); count = 0; };
    for (const message of messages) {
      if (message?.role === 'user') {
        close();
        turn++;
        hidden = Boolean(message.compact);
        if (!hidden) count += countIn(this.textOf(message), needle);
      } else if (message?.role === 'assistant' && turn >= 0 && !hidden && !message.compact) {
        count += countIn(this.textOf(message), needle);
      }
    }
    close();
    return out;
  }
}

/**
 * The stored records from the start of turn `fromTurn` up to `before`: kept for callers that want the full stretch.
 * Same shape as historyPage(). Null when the turn is not before `before`.
 */
function historyRange(messages = [], fromTurn, before) {
  if (!Number.isSafeInteger(fromTurn) || fromTurn < 0) return null;
  const end = Math.min(before, messages.length);
  let turn = -1;
  for (let index = 0; index < end; index++) {
    if (messages[index].role !== 'user' || ++turn !== fromTurn) continue;
    let userEnd = fromTurn;
    for (let j = index; j < end; j++) if (messages[j].role === 'user') userEnd++;
    return { messages: messages.slice(index, end), historyStart: index, historyEnd: end, historyUserStart: fromTurn, historyUserEnd: userEnd, rangeStart: 0, rangeEnd: end };
  }
  return null;
}

/**
 * A small window of whole turns around `targetTurn` inside the unloaded stretch `[rangeStart, rangeEnd)`.
 * Keeps jumps instant and memory flat on huge chats: only the target turn plus a few neighbours cross IPC,
 * leaving any remaining stretch as a lazy gap the reader can scroll or click into.
 */
function historyWindow(messages = [], targetTurn, rangeStart = 0, rangeEnd = messages.length, { beforeTurns = 1, afterTurns = 4, maxRecords = 120 } = {}) {
  if (!Number.isSafeInteger(targetTurn) || targetTurn < 0) return null;
  const lo = Number.isSafeInteger(rangeStart) ? Math.max(0, Math.min(rangeStart, messages.length)) : 0;
  const hi = Number.isSafeInteger(rangeEnd) ? Math.max(lo, Math.min(rangeEnd, messages.length)) : messages.length;
  const turnStarts = [];
  let turn = -1;
  for (let index = 0; index < hi; index++) {
    if (messages[index].role !== 'user') continue;
    turn++;
    if (index >= lo) turnStarts.push({ turn, index });
  }
  const pos = turnStarts.findIndex((entry) => entry.turn === targetTurn);
  if (pos === -1) return null;
  const endOf = (i) => (i + 1 < turnStarts.length ? turnStarts[i + 1].index : hi);

  let left = pos;
  let right = pos;
  while (right + 1 < turnStarts.length && right - pos < afterTurns && endOf(right + 1) - turnStarts[left].index <= maxRecords) right++;
  while (left > 0 && pos - left < beforeTurns && endOf(right) - turnStarts[left - 1].index <= maxRecords) left--;

  // Avoid leaving tiny 1-2 turn stub gaps when the edge is already right next to the window.
  const snapBudget = Math.round(maxRecords * 1.5);
  if (left > 0 && left <= 2 && endOf(right) - turnStarts[0].index <= snapBudget) left = 0;
  if (right < turnStarts.length - 1 && turnStarts.length - 1 - right <= 2 && hi - turnStarts[left].index <= snapBudget) right = turnStarts.length - 1;

  const start = turnStarts[left].index;
  const end = endOf(right);
  const userStart = turnStarts[left].turn;
  const userEnd = right + 1 < turnStarts.length ? turnStarts[right + 1].turn : turnStarts[right].turn + 1;
  return { messages: messages.slice(start, end), historyStart: start, historyEnd: end, historyUserStart: userStart, historyUserEnd: userEnd, rangeStart: lo, rangeEnd: hi };
}

module.exports = { ChatFind, plainText, normalize, countIn, historyRange, historyWindow };
