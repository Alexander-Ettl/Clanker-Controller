'use strict';

// The host side of "open this changed file as a diff": the page sends a list index, the host rebuilds the turn's file list
// from its own record and opens the editor's diff. A stub editor records what it was asked to open.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
require('./model-fixture').seedModels();

const calls = [];
const uri = (parts) => ({ ...parts, toString: () => JSON.stringify(parts) });
const vscodeStub = {
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  Uri: { file: (file) => uri({ scheme: 'file', fsPath: file }), from: (parts) => uri(parts), joinPath: (base, ...parts) => uri({ fsPath: path.join(String(base), ...parts) }) },
  commands: { executeCommand: async (...args) => { calls.push(args); } },
};
const load = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : load.call(this, request, parent, isMain); };
const { ChatWindowHost } = require('../extension');
Module._load = load;
const { snapshotText, parseSnapshotQuery, SCHEME } = require('../lib/turn-diff.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diff-host-')));
  run(['init', '-q'], root); run(['config', 'user.email', 't@t'], root); run(['config', 'user.name', 't'], root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'old\n'); fs.writeFileSync(path.join(root, 'gone.txt'), 'bye\n');
  run(['add', '.'], root); run(['commit', '-qm', 'base'], root);
  await sleep(60);
  const startedAt = Date.now();
  const snapshot = run(['rev-parse', 'HEAD'], root);
  await sleep(60);
  fs.writeFileSync(path.join(root, 'a.txt'), 'new\n'); fs.rmSync(path.join(root, 'gone.txt')); fs.writeFileSync(path.join(root, 'fresh.txt'), 'f\n');
  const posted = [];
  const host = { run: { chat: { messages: [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'done', undo: { bases: [[root, snapshot]], startedAt, count: 3 } }] }, post: (message) => posted.push(message) }, deps: { workspaceDir: root } };
  return { root, snapshot, host, posted };
}

test('opening each changed file asks the editor for a diff with the pre-turn copy on the left', async () => {
  calls.length = 0;
  const { root, snapshot, host } = await fixture();
  // Sorted: a.txt (edited), fresh.txt (new), gone.txt (deleted)
  await ChatWindowHost.prototype.openTurnDiff.call(host, 0);
  const [command, before, now, title] = calls.at(-1);
  assert.equal(command, 'vscode.diff');
  assert.equal(before.scheme, SCHEME);
  const query = parseSnapshotQuery(before.query);
  assert.deepEqual([query.root, query.snapshot, query.file], [root, snapshot, 'a.txt']);
  assert.equal(snapshotText(query.root, query.snapshot, query.file), 'old\n');
  assert.equal(now.fsPath, path.join(root, 'a.txt'));
  assert.match(title, /a\.txt \(before this turn/);

  await ChatWindowHost.prototype.openTurnDiff.call(host, 1);
  assert.match(calls.at(-1)[3], /fresh\.txt \(new in this turn\)/);
  assert.equal(snapshotText(root, snapshot, 'fresh.txt'), '', 'a created file has an empty left side');

  await ChatWindowHost.prototype.openTurnDiff.call(host, 2);
  const deleted = calls.at(-1);
  assert.match(deleted[3], /gone\.txt \(deleted in this turn\)/);
  assert.equal(deleted[2].authority, 'empty', 'a deleted file has an empty right side');
});

test('an index outside the list, or a turn already undone, opens nothing', async () => {
  calls.length = 0;
  const { host, posted } = await fixture();
  await ChatWindowHost.prototype.openTurnDiff.call(host, 99);
  await ChatWindowHost.prototype.openTurnDiff.call(host, '../../etc/passwd');
  assert.equal(calls.length, 0);
  assert.equal(posted.length, 2);
  host.run.chat.messages[1].undone = true;
  await ChatWindowHost.prototype.openTurnDiff.call(host, 0);
  assert.equal(calls.length, 0);
  assert.match(posted.at(-1).text, /no turn left/);
});
