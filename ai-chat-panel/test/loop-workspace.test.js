'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshotProject, prepareWorkspace, addWorktree, removeWorktree, removeTree, head, dirty } = require('../lib/loop-workspace');
const { git } = require('../lib/loop-exec');

test('snapshot waits for shared destination directories before copying parallel files across batches', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  const files = Array.from({ length: 70 }, (_, index) => `file-${index}.js`);
  for (const file of files) fs.writeFileSync(path.join(root, 'lib', file), file);

  const mkdir = fs.promises.mkdir.bind(fs.promises), copyFile = fs.promises.copyFile.bind(fs.promises);
  const pending = [];
  let mkdirCalls = 0;
  t.mock.method(fs.promises, 'mkdir', (...args) => {
    mkdirCalls++;
    const task = new Promise(resolve => setImmediate(resolve)).then(() => mkdir(...args));
    pending.push(task);
    return task;
  });
  t.mock.method(fs.promises, 'copyFile', (source, target) => {
    assert.ok(fs.existsSync(path.dirname(target)), 'copy must wait until its destination directory exists');
    return copyFile(source, target);
  });

  try {
    const result = await snapshotProject(root, workspace);
    assert.equal(result.copied, files.length);
    assert.equal(mkdirCalls, 1, 'files sharing a directory reuse its creation promise');
    for (const file of files) assert.equal(fs.readFileSync(path.join(result.checkout, 'lib', file), 'utf8'), file);
  } finally {
    await Promise.allSettled(pending);
  }
});

test('preparation rebuilds a snapshot whose initial baseline commit failed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-incomplete-'));
  t.after(() => removeTree(dir));
  const root = path.join(dir, 'project'), workspace = path.join(dir, 'workspace');
  const snapshot = path.join(workspace, 'snapshot');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'source.js'), 'current source');
  fs.mkdirSync(snapshot, { recursive: true });
  git(snapshot, ['init', '-q']);
  fs.writeFileSync(path.join(snapshot, 'partial.txt'), 'left over from the failed preparation');

  const checkout = await prepareWorkspace(root, workspace);
  assert.ok(head(checkout));
  assert.equal(dirty(checkout), false);
  assert.equal(fs.existsSync(path.join(checkout, 'partial.txt')), false);
  assert.equal(fs.readFileSync(path.join(checkout, 'source.js'), 'utf8'), 'current source');
  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'current source');
});

test('preparation and resumed cleanup leave the host free to handle other work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-background-copy-'));
  t.after(() => removeTree(dir));
  const root = path.join(dir, 'project'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'source.js'), 'original');

  // Any of these synchronous operations on the host would block chats on a large tree.
  const mocks = ['readdirSync', 'lstatSync', 'mkdirSync', 'rmSync', 'symlinkSync'].map(name => {
    const original = fs[name];
    return t.mock.method(fs, name, (target, ...args) => {
      assert.ok(!String(target).startsWith(dir), `${name} must run in the background for project files`);
      return original.call(fs, target, ...args);
    });
  });
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  let checkout;
  try {
    checkout = await prepareWorkspace(root, workspace);
    fs.writeFileSync(path.join(checkout, 'source.js'), 'discard');
    fs.writeFileSync(path.join(checkout, 'untracked.js'), 'discard');
    assert.equal(await prepareWorkspace(root, workspace), checkout);
    assert.ok(ticks > 0, 'the host must continue processing timers during preparation');
  } finally {
    clearInterval(heartbeat);
    for (const mock of mocks) mock.mock.restore();
  }
  assert.equal(fs.readFileSync(path.join(checkout, 'source.js'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(checkout, 'untracked.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'original');
});

test('preparation can be cancelled without leaving a background copy running', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-cancel-copy-'));
  // Windows may briefly retain file handles after the worker and Git have been killed.
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  t.after(cleanup);
  const root = path.join(dir, 'project'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'source.js'), 'original');
  const controller = new AbortController();
  const stopped = new Error('Stopped by user');
  const preparation = prepareWorkspace(root, workspace, { signal: controller.signal });
  controller.abort(stopped);
  await assert.rejects(preparation, error => error === stopped);
  await assert.rejects(prepareWorkspace(root, workspace, { signal: controller.signal }), error => error === stopped);
  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'original');
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(workspace), false, 'a stopped worker must not recreate the workspace');
});

test('long paths survive snapshot staging, resumed cleanup and fix worktrees with longpaths disabled in the repository', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-longpaths-'));
  t.after(() => removeTree(dir));
  const root = path.join(dir, 'project'), workspace = path.join(dir, 'workspace');
  const relative = path.join(...Array.from({ length: 5 }, (_, i) => `archive-${i}-${'x'.repeat(44)}`), 'source.js');
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), 'baseline');

  const checkout = await prepareWorkspace(root, workspace);
  git(checkout, ['config', 'core.longpaths', 'false']); // Old workspaces must also work.
  assert.ok(path.join(checkout, relative).length > 260);
  assert.match(git(checkout, ['ls-files']), /source\.js/);
  const baseline = head(checkout);
  fs.writeFileSync(path.join(checkout, relative), 'uncommitted');
  const untracked = path.join(checkout, path.dirname(relative), 'untracked.js');
  fs.writeFileSync(untracked, 'discard');
  assert.equal(await prepareWorkspace(root, workspace), checkout);
  assert.equal(head(checkout), baseline);
  assert.equal(fs.readFileSync(path.join(checkout, relative), 'utf8'), 'baseline');
  assert.equal(fs.existsSync(untracked), false);

  const fix = addWorktree(checkout, workspace, root, 'long-path-fix');
  assert.equal(fs.readFileSync(path.join(fix, relative), 'utf8'), 'baseline');
  fs.writeFileSync(path.join(fix, relative), 'fixed');
  git(fix, ['add', '-A']); git(fix, ['commit', '-q', '-m', 'fix']);
  git(checkout, ['cherry-pick', head(fix)]);
  removeWorktree(checkout, fix, 'long-path-fix');
  assert.equal(fs.existsSync(fix), false);
  assert.equal(fs.readFileSync(path.join(checkout, relative), 'utf8'), 'fixed');
  assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), 'baseline');
});
