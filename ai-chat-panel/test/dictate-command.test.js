'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

test('the in-editor dictation key is contributed, registered, and leaves F9 in text editors alone', () => {
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'aiChatPanel.dictateToggle'), 'the command is listed');
  assert.ok(source.includes("registerCommand('aiChatPanel.dictateToggle'"), 'the command is registered');
  const binding = pkg.contributes.keybindings.find((k) => k.command === 'aiChatPanel.dictateToggle');
  assert.equal(binding?.key, 'f9');
  assert.match(binding.when, /!editorTextFocus/, 'F9 stays Toggle Breakpoint while typing in an editor');
});
