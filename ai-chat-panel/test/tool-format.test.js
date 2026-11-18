const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../media/tool-format');

test('languages come from the file name, and only ones the bundled Shiki has', () => {
  assert.equal(f.langFor('ai-chat-panel\\media\\style.css'), 'css');
  assert.equal(f.langFor('C:/x/main.mjs'), 'javascript');
  assert.equal(f.langFor('run.ps1'), 'powershell');
  assert.equal(f.langFor('Cargo.toml'), '', 'no TOML grammar: stays plain');
  assert.equal(f.langFor('Makefile'), '');
  assert.deepEqual(f.splitPath('a\\b\\c.js'), { name: 'c.js', dir: 'a\\b' });
  assert.deepEqual(f.splitPath('c.js'), { name: 'c.js', dir: '' });
});

test('a numbered read splits into rows; wrapped lines and stray text do not fool it', () => {
  const read = f.parseNumbered("440\t  background: #64d2ff;\n441\t  box-shadow: 0 0 10px rgba(100, 210, 255,\n0.6);\n442\t}");
  assert.equal(read, null, 'a line with no number in the middle is not a clean read');
  const clean = f.parseNumbered('     1\t\'use strict\';\n     2\t\n     3\tconst a = 1;\r\n');
  assert.deepEqual(clean.rows, [{ n: 1, text: "'use strict';" }, { n: 2, text: '' }, { n: 3, text: 'const a = 1;' }]);
  const offset = f.parseNumbered('440\ta\n441\tb\n\n<system-reminder>\nwhatever\n</system-reminder>');
  assert.equal(offset.rows[0].n, 440);
  assert.deepEqual(offset.tail, ['', '<system-reminder>', 'whatever', '</system-reminder>']);
  assert.equal(f.parseNumbered('1\u2192first\n2\u2192second').rows.length, 2, 'the arrow form');
  assert.equal(f.parseNumbered('plain text\nno numbers'), null);
  assert.equal(f.parseNumbered('1: only\n2: two'), null, 'a "N: text" list needs three consecutive rows');
  assert.equal(f.parseNumbered('1: a\n2: b\n3: c').rows.length, 3);
  assert.equal(f.parseNumbered('1\ta\n3\tb'), null, 'numbers must run on');
});

test('grep matches group by file and keep context lines and gaps', () => {
  const grep = f.parseGrep('ai-chat-panel\\media\\a.js:12:const x = 1;\nai-chat-panel\\media\\a.js-13-  y();\n--\nai-chat-panel\\media\\a.js:40:x++;\nC:\\w\\b.css:7:.a { color: red; }');
  assert.equal(grep.groups.length, 2);
  assert.equal(grep.hits, 3);
  assert.equal(grep.files, 2);
  assert.deepEqual(grep.groups[0].rows.map((row) => row.gap ? 'gap' : `${row.n}${row.context ? 'c' : ''}`), ['12', '13c', 'gap', '40']);
  assert.equal(grep.groups[1].file, 'C:\\w\\b.css');
  assert.equal(grep.groups[1].rows[0].text, '.a { color: red; }');
  assert.equal(f.parseGrep('a.js\nb.js'), null, 'files_with_matches output is a file list');
  assert.equal(f.parseGrep('No matches found'), null);
});

test('a Glob listing is a file list, spaces and all', () => {
  const list = f.parseFileList('presentation\\audit\\audit.py\nC:\\Example Projects\\shot.png\nREADME.md');
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items[1].target, { type: 'image', value: 'C:\\Example Projects\\shot.png' });
  assert.equal(f.parseFileList('No files found'), null);
  assert.equal(f.parseFileList('src/a.js:12:text\nsrc/b.js:3:more'), null, 'grep lines are not a list');
  assert.equal(f.parseFileList('a.js\nb.js\n(Results are truncated)').tail.length, 1);
});

test('web search results become links plus the summary', () => {
  const text = 'Web search results for query: "liquid glass cursor"\n\nLinks: [{"title":"A [draft]","url":"https://www.example.com/a?x=1"},{"title":"B","url":"https://b.dev/"}]\n\nThe search found things.\n- one';
  const search = f.parseSearch(text);
  assert.equal(search.query, 'liquid glass cursor');
  assert.deepEqual(search.links.map((link) => link.title), ['A [draft]', 'B']);
  assert.equal(search.summary, 'The search found things.\n- one');
  assert.equal(f.hostOf(search.links[0].url), 'example.com');
  assert.equal(f.parseSearch('Links: [not json]'), null);
  assert.equal(f.parseSearch('nothing here'), null);
});

test('terminal colour becomes classes, other escapes vanish, spinners collapse', () => {
  const lines = f.parseAnsi('\u001b[1;31mFAIL\u001b[0m test\n\u001b[32mok\u001b[39m\u001b[2K plain\n\u001b[38;5;200mx\u001b[0m');
  assert.deepEqual(lines[0], [{ text: 'FAIL', cls: 'an-31 an-b' }, { text: ' test', cls: '' }]);
  assert.deepEqual(lines[1].map((segment) => segment.text), ['ok', ' plain']);
  assert.equal(lines[1][0].cls, 'an-32');
  assert.equal(lines[2][0].cls, '', '256-colour is left to the theme');
  assert.equal(f.stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(f.normalize('a\r\nspin 10%\rspin 100%\r\nb'), 'a\nspin 100%\nb');
});

test('commands are unwrapped from their shell and typed', () => {
  assert.deepEqual(f.unwrapCommand('bash', 'git status'), { script: 'git status', lang: 'bash' });
  assert.deepEqual(f.unwrapCommand('PowerShell', 'Get-ChildItem'), { script: 'Get-ChildItem', lang: 'powershell' });
  const wrapped = f.unwrapCommand('command_execution', '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -LiteralPath a.js"');
  assert.deepEqual(wrapped, { script: 'Get-Content -LiteralPath a.js', lang: 'powershell' });
  assert.equal(f.unwrapCommand('command_execution', '/bin/bash -lc \'ls -la\'').script, 'ls -la');
});

test('log lines get a tone only from their start', () => {
  assert.equal(f.lineTone('npm ERR! code E404'), 'err');
  assert.equal(f.lineTone('  FAIL test/a.test.js'), 'err');
  assert.equal(f.lineTone('TypeError: x is not a function'), 'err');
  assert.equal(f.lineTone('warning: CRLF will be replaced'), 'warn');
  assert.equal(f.lineTone('✔ passes'), 'ok');
  assert.equal(f.lineTone('this mentions error in the middle'), '');
  assert.equal(f.lineTone('Error handling is fine'), '');
});

test('diffs and JSON in command output are recognised', () => {
  const diff = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n c';
  assert.equal(f.looksLikeDiff(diff), true);
  assert.equal(f.looksLikeDiff('- item\n+ item'), false);
  assert.deepEqual(diff.split('\n').map(f.diffTone), ['meta', 'meta', 'meta', 'meta', 'hunk', 'del', 'add', '']);
  assert.equal(f.looksLikeJson('{"message":"Successfully stopped"}'), true);
  assert.equal(f.looksLikeJson('[1, 2'), false);
  assert.equal(f.looksLikeJson('plain'), false);
});
