const test = require('node:test');
const assert = require('node:assert/strict');
const { targetsAt, toTsv } = require('../media/copy-targets');

// A tiny stand-in for the DOM: `ancestors` maps a selector to the node `closest` should return for it.
function node(text, ancestors = {}, extra = {}) {
  const self = { textContent: text, innerText: text, dataset: {}, getAttribute: (name) => extra[name] ?? null, querySelector: () => null, ...extra };
  self.closest = (selector) => {
    for (const [key, value] of Object.entries({ ...ancestors, [selector]: ancestors[selector] })) if (value && selector.split(',').map((part) => part.trim()).includes(key)) return value;
    return null;
  };
  return self;
}
const labels = (entries) => entries.map((entry) => entry.label);

test('a table becomes tab-separated lines that paste as a grid', () => {
  assert.equal(toTsv([['Tool', 'Cost'], ['Claude', '5\n6']]), 'Tool\tCost\nClaude\t5 6');
});

test('a selection under the pointer comes first and carries the Ctrl+C hint', () => {
  const entries = targetsAt(node('x'), { selection: 'chosen words' });
  assert.deepEqual(labels(entries), ['Copy']);
  assert.equal(entries[0].text, 'chosen words');
  assert.equal(entries[0].hint, 'Ctrl+C');
});

test('a file badge offers open, path, file and name, and nothing about the surrounding text', () => {
  const badge = node('main.js', {}, {});
  badge.dataset = { path: 'media/main.js', line: '12' };
  const entries = targetsAt(node('main.js', { '.file-badge': badge, '.msg': node('whole message') }));
  assert.deepEqual(labels(entries), ['Open', 'Copy path', 'Copy file', 'Copy name']);
  assert.equal(entries[0].line, 12);
  assert.equal(entries[3].text, 'main.js');
});

test('a link offers its address, opening it and its text; an email address drops mailto:', () => {
  const link = node('the docs', {}, { href: 'https://example.com/docs' });
  assert.deepEqual(labels(targetsAt(node('the docs', { 'a[href]': link }))), ['Copy link', 'Open link', 'Copy link text']);
  const mail = node('write to me', {}, { href: 'mailto:a@b.de' });
  const entries = targetsAt(node('x', { 'a[href]': mail }));
  assert.deepEqual(labels(entries), ['Copy email address', 'Copy link text']);
  assert.equal(entries[0].text, 'a@b.de');
});

test('a code block copies its code and the whole message, with CRLF folded to LF', () => {
  const pre = node('a();\r\nb();\n');
  const block = node('', {}, {});
  block.querySelector = () => pre;
  const message = node('', {}, {});
  message.dataset = { raw: 'intro\n\n```js\na();\n```' };
  const entries = targetsAt(node('a', { '.code-block': block, pre, '.msg': message }));
  assert.deepEqual(labels(entries), ['Copy code', 'Copy message']);
  assert.equal(entries[0].text, 'a();\nb();');
});

test('a paragraph that is the whole message is simply "Copy message"', () => {
  const paragraph = node('hello there', {}, {});
  const body = node('hello there');
  const message = node('hello there');
  message.dataset = { raw: 'hello there' };
  const entries = targetsAt(node('hello', { p: paragraph, '.msg-body, .msg-user-text': body, '.msg': message }));
  assert.deepEqual(labels(entries), ['Copy message']);
});

test('typing fields and empty space offer nothing, so the native menu or none shows', () => {
  assert.deepEqual(targetsAt(node('x', { 'input, textarea, select, [contenteditable=""], [contenteditable="true"]': node('x') })), []);
  assert.deepEqual(targetsAt(node('')), []);
});
