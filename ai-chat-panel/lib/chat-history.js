'use strict';

// Keep whole turns together: tool offsets and Revert refer to the original history.
// A single large turn is allowed through intact even when it exceeds the record budget.
function historyPage(messages = [], before = messages.length, after = 0) {
  const end = Number.isSafeInteger(before) ? Math.max(0, Math.min(before, messages.length)) : messages.length;
  const minStart = Number.isSafeInteger(after) ? Math.max(0, Math.min(after, end)) : 0;
  let start = end, turns = 0;
  while (start > minStart) {
    start--;
    if (messages[start].role === 'user' && (++turns >= 12 || end - start >= 120)) break;
  }
  let userStart = 0;
  for (let i = 0; i < start; i++) if (messages[i].role === 'user') userStart++;
  let userEnd = userStart;
  for (let i = start; i < end; i++) if (messages[i].role === 'user') userEnd++;
  return { messages: messages.slice(start, end), historyStart: start, historyEnd: end, historyUserStart: userStart, historyUserEnd: userEnd };
}

// Symmetric forward page for scrolling downward into a skipped history gap.
function historyPageForward(messages = [], after = 0, before = messages.length) {
  const start = Number.isSafeInteger(after) ? Math.max(0, Math.min(after, messages.length)) : 0;
  const maxEnd = Number.isSafeInteger(before) ? Math.max(start, Math.min(before, messages.length)) : messages.length;
  let end = start, turns = 0;
  while (end < maxEnd) {
    if (messages[end].role === 'user') {
      if (end > start && (turns >= 12 || end - start >= 120)) break;
      turns++;
    }
    end++;
  }
  let userStart = 0;
  for (let i = 0; i < start; i++) if (messages[i].role === 'user') userStart++;
  let userEnd = userStart;
  for (let i = start; i < end; i++) if (messages[i].role === 'user') userEnd++;
  return { messages: messages.slice(start, end), historyStart: start, historyEnd: end, historyUserStart: userStart, historyUserEnd: userEnd };
}

module.exports = { historyPage, historyPageForward };
