const test = require('node:test');
const assert = require('node:assert/strict');
const { cardTarget, lineTarget, resultTargets } = require('../media/tool-targets');

test('a viewed picture previews, whatever the tool is called', () => {
  assert.deepEqual(cardTarget('read', 'C:\\Dev\\clanker-glass\\hover\\a85-dark-recent.png'), { type: 'image', value: 'C:\\Dev\\clanker-glass\\hover\\a85-dark-recent.png' });
  assert.deepEqual(cardTarget('other', '"/tmp/shot.JPG"'), { type: 'image', value: '/tmp/shot.JPG' });
  assert.equal(cardTarget('shell', 'node make.mjs out.png'), null, 'a shell command that mentions a picture is not the picture');
});

test('reads and edits open in the editor; other tools do not guess', () => {
  assert.deepEqual(cardTarget('read', 'ai-chat-panel/extension.js'), { type: 'file', value: 'ai-chat-panel/extension.js' });
  assert.deepEqual(cardTarget('edit', 'C:\\x\\y.css'), { type: 'file', value: 'C:\\x\\y.css' });
  assert.equal(cardTarget('read', 'some text with spaces'), null);
  assert.equal(cardTarget('search', 'src/app.js'), null);
  assert.equal(cardTarget('shell', ''), null);
});

test('web tools open the page', () => {
  assert.deepEqual(cardTarget('web', 'https://example.com/a?b=1'), { type: 'url', value: 'https://example.com/a?b=1' });
  assert.deepEqual(cardTarget('web', 'https://example.com/docs summarise the API'), { type: 'url', value: 'https://example.com/docs' });
  assert.equal(cardTarget('web', 'react hooks tutorial'), null);
});

test('result lines name a file, a line, or a picture', () => {
  assert.deepEqual(lineTarget('ai-chat-panel/lib/file-links.js'), { type: 'file', value: 'ai-chat-panel/lib/file-links.js', line: undefined });
  assert.deepEqual(lineTarget('media/main.js:4433:  function appendToolCard'), { type: 'file', value: 'media/main.js', line: 4433 });
  assert.deepEqual(lineTarget('C:\\p\\a.js:12:x'), { type: 'file', value: 'C:\\p\\a.js', line: 12 });
  assert.deepEqual(lineTarget('out/shot.png'), { type: 'image', value: 'out/shot.png' });
  assert.equal(lineTarget('No matches found'), null);
  assert.equal(lineTarget('https://example.com/x.js'), null);
  assert.equal(resultTargets('a.js:1:x\n\nb.png').length, 3);
});
