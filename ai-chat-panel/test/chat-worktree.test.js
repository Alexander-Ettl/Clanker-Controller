'use strict';

// The git side of one worktree per chat, on real temporary repositories. No CLI, no model, nothing outside the temp folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const wt = require('../lib/chat-worktree.js');

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const write = (root, name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  const repo = path.join(base, 'my-app');
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main'], repo); run(['config', 'user.email', 't@t'], repo); run(['config', 'user.name', 't'], repo);
  write(repo, '.gitignore', '.env\nnode_modules/\n');
  write(repo, 'a.txt', 'one\n');
  run(['add', '.'], repo); run(['commit', '-qm', 'base'], repo);
  write(repo, '.env', 'SECRET=1\n');
  write(repo, 'node_modules/dep/index.js', 'module.exports = 1\n');
  return { repo, env: { CLANKER_WORKTREES: path.join(base, 'managed') }, base };
}

test('slugify makes safe, short names', () => {
  assert.equal(wt.slugify('Fix the Login Bug!'), 'fix-the-login-bug');
  assert.equal(wt.slugify('Überprüfung der Größe'), 'uberprufung-der-grosse');
  assert.equal(wt.slugify('   '), 'chat');
  assert.ok(wt.slugify('x'.repeat(200)).length <= 40);
});

test('managedRoot refuses a synced folder', () => {
  assert.throws(() => wt.managedRoot({ CLANKER_WORKTREES: '/home/u/Nextcloud/wt' }), /synced folder/);
  assert.throws(() => wt.managedRoot({ CLANKER_WORKTREES: 'C:\\Users\\u\\OneDrive\\wt' }), /synced folder/);
  assert.match(wt.managedRoot({}), /\.clanker[\\/]worktrees$/);
});

test('create: a branch under the managed folder, outside the repo, with ignored essentials linked', () => {
  const { repo, env } = fixture();
  const made = wt.createWorktree({ repoRoot: repo, title: 'Fix the login bug', env });
  assert.equal(made.branch, 'clanker/fix-the-login-bug');
  assert.ok(made.path.startsWith(env.CLANKER_WORKTREES + path.sep) && !made.path.startsWith(repo + path.sep));
  assert.equal(fs.readFileSync(path.join(made.path, 'a.txt'), 'utf8'), 'one\n');
  assert.deepEqual(made.linked.sort(), ['.env', 'node_modules']);
  assert.ok(fs.lstatSync(path.join(made.path, 'node_modules')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(made.path, '.env'), 'utf8'), 'SECRET=1\n', 'linked, so the same file, not a copy');
  assert.equal(run(['rev-parse', '--abbrev-ref', 'HEAD'], made.path), 'clanker/fix-the-login-bug');
  assert.deepEqual(made.warnings, []);
  // the links are not "dirty work"
  assert.deepEqual(wt.worktreeStatus(made), { branch: 'clanker/fix-the-login-bug', dirty: 0, ahead: 0, files: [] });
});

test('two chats with the same title get different worktrees and branches', () => {
  const { repo, env } = fixture();
  const one = wt.createWorktree({ repoRoot: repo, title: 'Same', chatId: 'aaaaaa-1', env });
  const two = wt.createWorktree({ repoRoot: repo, title: 'Same', chatId: 'bbbbbb-2', env });
  assert.notEqual(one.path, two.path);
  assert.notEqual(one.branch, two.branch);
  assert.equal(wt.listManaged(repo, env).length, 2);
});

test('two worktrees edit the same file at once without overwriting each other', () => {
  const { repo, env } = fixture();
  const a = wt.createWorktree({ repoRoot: repo, title: 'agent a', env });
  const b = wt.createWorktree({ repoRoot: repo, title: 'agent b', env });
  write(a.path, 'a.txt', 'from A\n'); write(b.path, 'a.txt', 'from B\n');
  run(['commit', '-qam', 'A'], a.path); run(['commit', '-qam', 'B'], b.path); // no index.lock clash: each tree has its own index
  assert.equal(fs.readFileSync(path.join(a.path, 'a.txt'), 'utf8'), 'from A\n');
  assert.equal(fs.readFileSync(path.join(b.path, 'a.txt'), 'utf8'), 'from B\n');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'one\n', 'the project folder is untouched');
  assert.deepEqual([wt.worktreeStatus(a).ahead, wt.worktreeStatus(b).ahead], [1, 1]);
});

test('create warns about uncommitted work and refuses submodules', () => {
  const { repo, env } = fixture();
  write(repo, 'a.txt', 'changed\n');
  const made = wt.createWorktree({ repoRoot: repo, title: 'dirty base', env });
  assert.match(made.warnings[0], /1 uncommitted file is in the project folder/);
  assert.equal(fs.readFileSync(path.join(made.path, 'a.txt'), 'utf8'), 'one\n');
  write(repo, '.gitmodules', '[submodule "x"]\n');
  assert.throws(() => wt.createWorktree({ repoRoot: repo, title: 'with submodule', env }), /submodules/);
});

test('status sees edits, new files and commits', () => {
  const { repo, env } = fixture();
  const made = wt.createWorktree({ repoRoot: repo, title: 'status', env });
  write(made.path, 'a.txt', 'edit\n'); write(made.path, 'new.txt', 'n\n');
  const state = wt.worktreeStatus(made);
  assert.equal(state.dirty, 2);
  assert.deepEqual(state.files.map((f) => f.file).sort(), ['a.txt', 'new.txt']);
});

test('remove: a clean worktree and its merged branch go; the real node_modules and .env survive', () => {
  const { repo, env } = fixture();
  const made = wt.createWorktree({ repoRoot: repo, title: 'remove me', env });
  const result = wt.removeWorktree({ ...made, env });
  assert.deepEqual([result.removed, result.branchDeleted], [true, true]);
  assert.equal(fs.existsSync(made.path), false);
  assert.equal(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), true, 'never deletes through the link');
  assert.equal(fs.readFileSync(path.join(repo, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(wt.listManaged(repo, env).length, 0, 'no stale git worktree entry');
  assert.doesNotMatch(run(['branch', '--list', 'clanker/*'], repo), /clanker/);
});

test('git add -A in the worktree does not stage the links', () => {
  const { repo, env } = fixture();
  const made = wt.createWorktree({ repoRoot: repo, title: 'staging', env });
  write(made.path, 'work.txt', 'w\n');
  run(['add', '-A'], made.path);
  assert.equal(run(['diff', '--cached', '--name-only'], made.path), 'work.txt');
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/node_modules$/m);
  assert.equal(run(['status', '--porcelain'], repo), '', 'the project folder sees no change from the exclude lines');
});

test('remove: a dirty worktree stays unless forced, and unmerged commits keep their branch', () => {
  const { repo, env } = fixture();
  const made = wt.createWorktree({ repoRoot: repo, title: 'keep me', env });
  write(made.path, 'work.txt', 'precious\n');
  const refused = wt.removeWorktree({ ...made, env });
  assert.deepEqual([refused.removed, fs.existsSync(path.join(made.path, 'work.txt'))], [false, true]);
  assert.match(refused.reason, /1 uncommitted file/);
  run(['add', '.'], made.path); run(['commit', '-qm', 'work'], made.path);
  const kept = wt.removeWorktree({ ...made, env });
  assert.deepEqual([kept.removed, kept.branchDeleted], [true, false]);
  assert.match(kept.reason, /not merged, so it was kept/);
  assert.match(run(['branch', '--list', 'clanker/*'], repo), /keep-me/);
  const again = wt.createWorktree({ repoRoot: repo, title: 'force me', env });
  write(again.path, 'x.txt', 'x\n');
  assert.equal(wt.removeWorktree({ ...again, force: true, env }).removed, true);
});

test('remove refuses a folder that is not a managed worktree', () => {
  const { repo, env } = fixture();
  assert.throws(() => wt.removeWorktree({ repoRoot: repo, path: repo, env }), /not one of Clanker's managed worktrees/);
  assert.throws(() => wt.removeWorktree({ repoRoot: repo, path: path.join(env.CLANKER_WORKTREES, '..', 'elsewhere'), env }), /not one of/);
  assert.equal(fs.existsSync(path.join(repo, 'a.txt')), true);
});

test('a worktree folder deleted by hand shows as missing and prunes cleanly', () => {
  const { repo, env } = fixture();
  const made = wt.createWorktree({ repoRoot: repo, title: 'gone', env });
  fs.rmSync(made.path, { recursive: true, force: true });
  assert.equal(wt.listManaged(repo, env)[0].missing, true);
  wt.pruneStale(repo);
  assert.equal(wt.listManaged(repo, env).length, 0);
  const result = wt.removeWorktree({ ...made, env }); // the chat's delete still works afterwards
  assert.equal(result.removed, true);
});

test('changesAgainstBase lists committed, edited, new and deleted files, and none of the links', () => {
  const { repo, env } = fixture();
  write(repo, 'gone.txt', 'bye\n'); run(['add', '.'], repo); run(['commit', '-qm', 'more'], repo);
  const made = wt.createWorktree({ repoRoot: repo, title: 'changes', env });
  assert.deepEqual(wt.changesAgainstBase(made), [], 'a fresh worktree has no changes (the links do not count)');
  write(made.path, 'committed.txt', 'c\n'); run(['add', '.'], made.path); run(['commit', '-qm', 'x'], made.path);
  write(made.path, 'a.txt', 'one changed\n');
  write(made.path, 'src/new.js', 'n\n');
  fs.rmSync(path.join(made.path, 'gone.txt'));
  assert.deepEqual(wt.changesAgainstBase(made), [
    { status: 'M', file: 'a.txt' }, { status: 'A', file: 'committed.txt' }, { status: 'D', file: 'gone.txt' }, { status: 'A', file: 'src/new.js' },
  ]);
});
