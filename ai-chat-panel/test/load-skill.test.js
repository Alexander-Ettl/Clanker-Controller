'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeEvent } = require('../lib/stream-engine');

const source = fs.readFileSync(path.join(__dirname, '../media/main.js'), 'utf8');
const helpers = source.match(/const SHELL_TOOLS[\s\S]*?function toolDisplayName\([\s\S]*?\n  \}/)[0];
const context = vm.createContext({});
vm.runInContext(`${helpers}; this.names = loadedSkillNames; this.kind = toolKind; this.label = toolDisplayName;`, context);
const names = (name, command) => Array.from(context.names(name, command));

test('real provider event shapes identify skill loads without changing tool/result IDs', () => {
  const fixtures = [
    ['claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'claude-read', name: 'Read', input: { file_path: 'C:\\Users\\user\\Sync\\AgentConfig\\skills\\claude-config-sync\\SKILL.md' } }] } }, 'claude-config-sync', 'claude-read'],
    ['claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'claude-skill', name: 'Skill', input: { skill: 'anti-ai-slop-writing' } }] } }, 'anti-ai-slop-writing', 'claude-skill'],
    ['codex', { type: 'item.started', item: { type: 'command_execution', id: 'item_1', command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw -LiteralPath \'C:\\Users\\user\\.codex\\skills\\.system\\openai-docs\\SKILL.md\'"' } }, 'openai-docs', 'item_1'],
    ['codex', { __appServer: true, method: 'item/started', params: { item: { type: 'commandExecution', id: 'server-1', command: "Get-Content -LiteralPath 'C:/Users/user/.agents/skills/ponytail/SKILL.md'" } } }, 'ponytail', 'server-1'],
    ['gemini', { event: 'step_update', step_update: { step_index: 6, step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: 'C:\\Users\\user\\.gemini\\config\\skills\\claude-config-sync\\SKILL.md' } } } }, 'claude-config-sync', 'step-6'],
  ];
  for (const [agent, raw, skill, id] of fixtures) {
    const event = normalizeEvent(raw, agent);
    assert.equal(event.type, 'tool_start');
    assert.equal(event.toolId, id);
    assert.deepEqual(names(event.name, event.command || event.file), [skill]);
    assert.equal(context.label(event.name, 'skill'), 'Load Skill');
  }
});

test('saved shell cards support Windows paths, wrappers, batched reads and multiple skills', () => {
  assert.deepEqual(names('bash', '"C:\\\\WINDOWS\\\\powershell.exe" -Command "Get-Content -LiteralPath \'C:\\\\Users\\\\user\\\\Sync\\\\My Skills\\\\ponytail\\\\SKILL.md\' -Raw"'), ['ponytail']);
  assert.deepEqual(names('shell', "Get-Content README.md; Get-Content 'skills/ponytail/SKILL.md','skills/openai-docs/SKILL.md'; Get-Content 'skills/ponytail/SKILL.md'"), ['ponytail', 'openai-docs']);
  assert.deepEqual(names('run_command', 'powershell -Command "Get-Content \'.agents\\skills\\synced\\SKILL.md\' -Head 15"'), ['synced']);
  assert.deepEqual(names('Bash', 'cat ~/.claude/skills/ponytail/SKILL.md'), ['ponytail']);
  assert.deepEqual(names('bash', 'bash -lc \'cat "skills/my skill/SKILL.md"\''), ['my skill']);
  assert.deepEqual(names('Bash', 'cd repo && sed -n 1,50p .agents/skills/synced/SKILL.md'), ['synced']);
  assert.deepEqual(names('Read', 'SKILL.md'), ['SKILL.md']);
  for (const name of ['Skill', 'load_skill', 'Load Skill']) assert.equal(context.label(name, context.kind(name)), 'Load Skill');
});

test('searches, listings, edits, references and ordinary reads stay under their original tool kinds', () => {
  for (const [name, command] of [
    ['Edit', 'skills/ponytail/SKILL.md'], ['Write', 'skills/ponytail/SKILL.md'],
    ['edit', 'skills/ponytail/SKILL.md'], ['list_dir', 'skills/ponytail/SKILL.md'],
    ['Grep', 'skills/ponytail/SKILL.md'], ['bash', 'rg SKILL.md skills'],
    ['bash', 'git diff -- skills/ponytail/SKILL.md'],
    ['bash', "sed -i 's/foo/bar/' skills/ponytail/SKILL.md"],
    ['bash', 'echo skills/ponytail/SKILL.md'],
    ['bash', "Get-Content README.md; rg foo skills/ponytail/SKILL.md"],
    ['bash', "Get-Content 'skills/*/SKILL.md'"],
    ['Read', 'skills/ponytail/SKILL.md.bak'], ['view_file', 'README.md'],
    ['shell', 'Get-Content skills/ponytail/references/notes.md'],
  ]) assert.deepEqual(names(name, command), [], `${name}: ${command}`);
});
