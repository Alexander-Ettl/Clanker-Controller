'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planUndo, applyUndo, fileCount, parseNameStatus } = require('../lib/turn-undo.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n'); // git may check out CRLF on Windows
const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

test('parseNameStatus: NUL-separated status and path pairs', () => {
  assert.deepEqual(parseNameStatus('M\0a b.txt\0D\0gone.txt\0'), [['M', 'a b.txt'], ['D', 'gone.txt']]);
});

test('undo: puts back what the turn changed and leaves the rest alone', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-undo-')));
  try {
    run(['init', '-q'], root);
    run(['config', 'user.email', 't@t'], root);
    run(['config', 'user.name', 't'], root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'a1\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b1\n');
    fs.writeFileSync(path.join(root, 'c.txt'), 'c1\n');
    run(['add', '.'], root);
    run(['commit', '-qm', 'base'], root);
    fs.writeFileSync(path.join(root, 'b.txt'), 'b-dirty\n'); // your own unfinished edit before the turn
    fs.writeFileSync(path.join(root, 'mine.txt'), 'mine\n'); // your own untracked file
    await sleep(60);
    const startedAt = Date.now();
    const snapshot = run(['stash', 'create'], root);
    // File times come from a coarser clock than Date.now() (a few ms on Linux, up to ~16 ms on NTFS), so a file written
    // right after startedAt can look older than the turn. A real agent never writes that fast.
    await sleep(60);

    fs.writeFileSync(path.join(root, 'a.txt'), 'a-agent\n'); // edited
    fs.rmSync(path.join(root, 'b.txt')); // deleted
    fs.writeFileSync(path.join(root, 'new.txt'), 'n\n'); // created
    fs.writeFileSync(path.join(root, 'mine.txt'), 'mine+agent\n'); // your untracked file, edited by it

    const plans = planUndo([[root, snapshot]], startedAt);
    assert.equal(fileCount(plans), 3);
    const done = applyUndo(plans);
    assert.deepEqual([done.restored, done.removed, done.failed.length], [2, 1, 0]);
    assert.equal(read(root, 'a.txt'), 'a1\n');
    assert.equal(read(root, 'b.txt'), 'b-dirty\n');
    assert.equal(read(root, 'c.txt'), 'c1\n');
    assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
    assert.equal(read(root, 'mine.txt'), 'mine+agent\n'); // untracked and pre-existing: never deleted
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('undo: a snapshot git no longer has is reported, not guessed at', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-undo-')));
  try {
    run(['init', '-q'], root);
    const [plan] = planUndo([[root, '0'.repeat(40)]], Date.now());
    assert.equal(plan.missing, true);
    assert.equal(fileCount([plan]), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
