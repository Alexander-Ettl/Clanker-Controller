'use strict';

// Keep whole turns together: tool offsets and Revert refer to the original history.
// A single large turn is allowed through intact even when it exceeds the record budget.
function historyPage(messages = [], before = messages.length) {
  const end = Number.isSafeInteger(before) ? Math.max(0, Math.min(before, messages.length)) : messages.length;
  let start = end, turns = 0;
  while (start > 0) {
    start--;
    if (messages[start].role === 'user' && (++turns >= 12 || end - start >= 120)) break;
  }
  let userStart = 0;
  for (let i = 0; i < start; i++) if (messages[i].role === 'user') userStart++;
  return { messages: messages.slice(start, end), historyStart: start, historyEnd: end, historyUserStart: userStart };
}

module.exports = { historyPage };
