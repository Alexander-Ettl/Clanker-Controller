'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { summarizeTurn, publicSummary, parseNumstat, countLines, snapshotText, snapshotQuery, parseSnapshotQuery } = require('../lib/turn-diff.js');
const { planUndo, applyUndo, fileCount } = require('../lib/turn-undo.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const write = (root, name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };

async function turnRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diff-')));
  run(['init', '-q'], root);
  run(['config', 'user.email', 't@t'], root);
  run(['config', 'user.name', 't'], root);
  write(root, 'a.txt', 'a1\na2\na3\n');
  write(root, 'gone.txt', 'x\ny\n');
  write(root, 'keep.txt', 'k\n');
  run(['add', '.'], root);
  run(['commit', '-qm', 'base'], root);
  write(root, 'mine.txt', 'mine\n'); // your own untracked file
  await sleep(60);
  const startedAt = Date.now();
  const snapshot = run(['stash', 'create'], root) || run(['rev-parse', 'HEAD'], root);
  await sleep(60);
  return { root, startedAt, snapshot };
}

test('parseNumstat reads counts and marks binary files', () => {
  const counts = parseNumstat('3\t1\ta b.txt\0-\t-\timg.png\0');
  assert.deepEqual(counts.get('a b.txt'), { add: 3, del: 1 });
  assert.deepEqual(counts.get('img.png'), { add: null, del: null });
});

test('countLines handles a trailing newline, none, empty and binary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-'));
  write(dir, 'a', 'one\ntwo\n'); write(dir, 'b', 'one\ntwo'); write(dir, 'c', ''); fs.writeFileSync(path.join(dir, 'd'), Buffer.from([1, 0, 2]));
  assert.deepEqual(['a', 'b', 'c', 'd', 'missing'].map((name) => countLines(path.join(dir, name))), [2, 2, 0, null, null]);
});

test('a turn that edits, creates and deletes lists all three, and undo touches exactly the same files', async () => {
  const { root, startedAt, snapshot } = await turnRepo();
  write(root, 'a.txt', 'a1\nA2\na3\na4\n'); // +2 -1
  fs.rmSync(path.join(root, 'gone.txt')); // -2
  write(root, 'src/new.txt', 'n1\nn2\nn3\n'); // +3
  write(root, 'mine.txt', 'mine\nplus\n'); // your untracked file: not listed, like undo
  const summary = summarizeTurn([[root, snapshot]], startedAt, root);
  assert.deepEqual(summary.files.map((f) => [f.path, f.status, f.add, f.del]), [['a.txt', 'M', 2, 1], ['gone.txt', 'D', 0, 2], ['src/new.txt', 'A', 3, 0]]);
  assert.deepEqual([summary.count, summary.add, summary.del], [3, 5, 3]);
  assert.equal(summary.count, fileCount(planUndo([[root, snapshot]], startedAt)), 'the same set undo would restore or remove');
  applyUndo(planUndo([[root, snapshot]], startedAt));
  assert.equal(summarizeTurn([[root, snapshot]], startedAt, root).count, 0, 'after undo nothing is left to show');
});

test('a staged new file and a binary file are counted', async () => {
  const { root, startedAt, snapshot } = await turnRepo();
  write(root, 'staged.txt', 's\n');
  run(['add', 'staged.txt'], root);
  fs.writeFileSync(path.join(root, 'pic.bin'), Buffer.from([0, 1, 2, 3]));
  const summary = summarizeTurn([[root, snapshot]], startedAt, root);
  const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));
  assert.deepEqual([byPath['staged.txt'].status, byPath['staged.txt'].add], ['A', 1]);
  assert.deepEqual([byPath['pic.bin'].status, byPath['pic.bin'].add], ['A', null]);
});

test('paths are shown relative to the workspace, for several repos', async () => {
  const outer = await turnRepo();
  const inner = await turnRepo();
  write(outer.root, 'a.txt', 'changed\n');
  write(inner.root, 'a.txt', 'changed\n');
  const summary = summarizeTurn([[outer.root, outer.snapshot], [inner.root, inner.snapshot]], Math.max(outer.startedAt, inner.startedAt), outer.root);
  assert.equal(summary.count, 2);
  assert.ok(summary.files.some((f) => f.path === 'a.txt'));
  assert.ok(summary.files.some((f) => f.path.startsWith('../')), 'a repo outside the workspace keeps a relative path');
});

test('a pruned snapshot shows nothing and says so', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diff-none-'));
  run(['init', '-q'], root);
  const summary = summarizeTurn([[root, 'a'.repeat(40)]], Date.now(), root);
  assert.deepEqual([summary.count, summary.missing], [0, true]);
});

test('the webview copy carries no repo root and no absolute path', async () => {
  const { root, startedAt, snapshot } = await turnRepo();
  write(root, 'a.txt', 'z\n');
  const text = JSON.stringify(publicSummary(summarizeTurn([[root, snapshot]], startedAt, root)));
  assert.ok(!text.includes(root));
  assert.ok(!/"root"|"file"/.test(text));
});

test('snapshotText returns the pre-turn copy, or empty for a created file', async () => {
  const { root, snapshot } = await turnRepo();
  write(root, 'a.txt', 'changed\n');
  assert.equal(snapshotText(root, snapshot, 'a.txt'), 'a1\na2\na3\n');
  assert.equal(snapshotText(root, snapshot, 'src/new.txt'), '');
});

test('snapshot queries round-trip and refuse anything but a commit hash inside the repo', () => {
  const hash = 'a'.repeat(40);
  const ok = parseSnapshotQuery(snapshotQuery('/repo', hash, 'src/a.js'));
  assert.deepEqual(ok, { root: '/repo', snapshot: hash, file: 'src/a.js' });
  assert.equal(parseSnapshotQuery(snapshotQuery('/repo', 'HEAD', 'a.js')), null, 'refs are not commit hashes');
  assert.equal(parseSnapshotQuery(snapshotQuery('/repo', hash, '../../etc/passwd')), null);
  assert.equal(parseSnapshotQuery('not json'), null);
});
