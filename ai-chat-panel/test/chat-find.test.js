'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatFind, plainText, normalize, countIn, historyRange, historyWindow } = require('../lib/chat-find');
const { historyPage, historyPageForward } = require('../lib/chat-history');

const chat = [
  { role: 'user', text: 'Why does the **login** button fail on phones?' },
  { role: 'assistant', text: 'The cookie banner covers the login button. See [the banner](src/Banner.tsx).' },
  { role: 'tool', event: { output: 'login login login' } },
  { role: 'user', text: 'compact', compact: true },
  { role: 'assistant', text: 'Summary mentioning login', compact: true },
  { role: 'user', text: 'And the sign-up page?' },
  { role: 'assistant', text: '```js\nconst login = 1;\n```\nThe Login form there is fine.' },
];

test('counts per turn, numbered like the window, skipping tool output and hidden compaction turns', () => {
  assert.deepEqual(new ChatFind().find(chat, 'login'), [[0, 2], [2, 2]]);
  assert.deepEqual(new ChatFind().find(chat, 'LOGIN BUTTON'), [[0, 2]], 'case-insensitive; the bold marks are not text');
  assert.deepEqual(new ChatFind().find(chat, 'the banner'), [[0, 1]], 'a link counts by its text, not its target');
  assert.deepEqual(new ChatFind().find(chat, 'banner.tsx'), [], 'the link target is not on screen');
  assert.deepEqual(new ChatFind().find(chat, '  '), [], 'whitespace alone finds nothing');
});

test('a reply that grows is normalised again; untouched messages come from the cache', () => {
  const find = new ChatFind();
  const reply = { role: 'assistant', text: 'one match' };
  const messages = [{ role: 'user', text: 'go' }, reply];
  assert.deepEqual(find.find(messages, 'match'), [[0, 1]]);
  reply.text += ', and another match';
  assert.deepEqual(find.find(messages, 'match'), [[0, 2]]);
});

test('plain text drops markdown syntax the reader never sees, and keeps identifiers intact', () => {
  assert.equal(plainText('## Title\n- **bold** and *em* and `code_name`'), 'Title\nbold and em and code_name');
  assert.equal(plainText('| a | b |\n|---|---|\n| 1 | 2 |').replace(/\s+/g, ' ').trim(), 'a b 1 2');
  assert.equal(normalize('Line\n\n  Two'), 'line two');
  assert.equal(countIn('aaaa', 'aa'), 2, 'non-overlapping, as a find bar steps');
});

test('historyRange loads from the start of a turn up to what the window already has', () => {
  const messages = [];
  for (let turn = 0; turn < 40; turn++) messages.push({ role: 'user', text: `q${turn}` }, { role: 'assistant', text: `a${turn}` });
  const tail = historyPage(messages);
  const range = historyRange(messages, 3, tail.historyStart);
  assert.equal(range.historyStart, 6);
  assert.equal(range.historyEnd, tail.historyStart);
  assert.equal(range.historyUserStart, 3);
  assert.equal(range.messages[0].text, 'q3');
  assert.equal(historyRange(messages, 39, tail.historyStart), null, 'already loaded');
  assert.equal(historyRange(messages, -1, 10), null);
});

test('historyWindow returns a small window around a far turn and snaps away tiny edge stubs', () => {
  const messages = [];
  for (let turn = 0; turn < 60; turn++) messages.push({ role: 'user', text: `q${turn}` }, { role: 'assistant', text: `a${turn}` });
  const tail = historyPage(messages); // last 12 turns: 48..59
  const at0 = historyWindow(messages, 0, 0, tail.historyStart);
  assert.equal(at0.historyStart, 0);
  assert.equal(at0.historyUserStart, 0);
  assert.equal(at0.historyUserEnd, 5, 'turn 0 plus 4 turns after');
  assert.equal(at0.historyEnd, 10);
  assert.equal(at0.rangeStart, 0);
  assert.equal(at0.rangeEnd, tail.historyStart);

  // Jumping into the middle gap [10, tail.historyStart) loads a window around turn 25 and leaves gaps on both sides.
  const at25 = historyWindow(messages, 25, at0.historyEnd, tail.historyStart);
  assert.equal(at25.historyUserStart, 24);
  assert.equal(at25.historyUserEnd, 30);
  assert.ok(at25.historyStart > at0.historyEnd && at25.historyEnd < tail.historyStart);

  // Edge snap: jumping to turn 2 inside [0, tail.historyStart) snaps start to 0 rather than leaving a 1-turn stub.
  const at2 = historyWindow(messages, 2, 0, tail.historyStart);
  assert.equal(at2.historyUserStart, 0);

  // Out-of-range target returns null.
  assert.equal(historyWindow(messages, 50, 0, tail.historyStart), null);

  // Forward and backward paging inside a gap clamp cleanly to the gap bounds.
  const fwd = historyPageForward(messages, at0.historyEnd, at25.historyStart);
  assert.equal(fwd.historyStart, at0.historyEnd);
  assert.equal(fwd.historyUserStart, 5);
  assert.equal(fwd.historyUserEnd, 17);
  const back = historyPage(messages, at25.historyStart, at0.historyEnd);
  assert.equal(back.historyEnd, at25.historyStart);
  assert.equal(back.historyUserEnd, 24);
  assert.equal(back.historyUserStart, 12);
});
