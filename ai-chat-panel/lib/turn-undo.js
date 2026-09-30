'use strict';

// Undo for the last turn, on plain git. Before a turn the engine records `git stash create` (see
// stream-engine.js repoSnapshots): a commit holding the working tree, touching no ref or file. Undo compares the
// tree with it and puts back only what differs, never `checkout .`, so files the turn didn't touch stay as they are.
// A file the turn created has no snapshot copy; it is deleted only if it appeared after the turn began, which keeps
// your own untracked files safe.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const CHUNK = 40; // paths per command line: Windows caps it near 32k characters

/** `-z` name-status output as [status, file] pairs (no renames: a rename reads as a delete and an add). */
function parseNameStatus(out) {
  const parts = out.split('\0').filter(Boolean);
  const pairs = [];
  for (let i = 0; i + 1 < parts.length; i += 2) pairs.push([parts[i][0], parts[i + 1]]);
  return pairs;
}

const inside = (root, file) => { const full = path.resolve(root, file); return full.startsWith(root + path.sep) ? full : ''; };
const bornSince = (full, since) => { try { return fs.statSync(full).birthtimeMs >= since; } catch { return false; } };

/**
 * What undoing would do in one repo: `restore` (put the snapshot's copy back: edited or deleted files) and
 * `remove` (created during the turn). Empty when the snapshot object is gone (git pruned it).
 */
function planRepo(root, snapshot, startedAt) {
  const plan = { root, restore: [], remove: [] };
  try { git(['cat-file', '-e', `${snapshot}^{commit}`], root); } catch { return { ...plan, missing: true }; }
  for (const [status, file] of parseNameStatus(git(['diff', '--name-status', '--no-renames', '-z', snapshot], root))) {
    if (status === 'A') { const full = inside(root, file); if (full && bornSince(full, startedAt)) plan.remove.push(file); } // staged during the turn
    else plan.restore.push(file);
  }
  for (const file of git(['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean)) {
    if (file.endsWith('/')) continue; // a nested repo
    const full = inside(root, file);
    if (full && bornSince(full, startedAt)) plan.remove.push(file);
  }
  return plan;
}

/** `bases`: [[repoRoot, snapshotHash], ...] as the engine took them. */
function planUndo(bases, startedAt) {
  return (bases || []).filter(([root, snapshot]) => root && snapshot).map(([root, snapshot]) => {
    try { return { ...planRepo(root, snapshot, startedAt), snapshot }; } catch { return { root, snapshot, restore: [], remove: [], missing: true }; }
  });
}

const fileCount = (plans) => plans.reduce((sum, plan) => sum + plan.restore.length + plan.remove.length, 0);
/** Every affected file, relative to `base` (the workspace), for the confirmation. */
const fileList = (plans, base) => plans.flatMap((plan) => [...plan.restore, ...plan.remove].map((file) => path.relative(base, path.join(plan.root, file)).split(path.sep).join('/')));

/** Applies a plan from planUndo. Returns how many files were restored and removed, and which failed. */
function applyUndo(plans) {
  const done = { restored: 0, removed: 0, failed: [] };
  for (const plan of plans) {
    for (let i = 0; i < plan.restore.length; i += CHUNK) {
      const files = plan.restore.slice(i, i + CHUNK);
      try { git(['restore', `--source=${plan.snapshot}`, '--worktree', '--', ...files], plan.root); done.restored += files.length; } catch { done.failed.push(...files); }
    }
    for (const file of plan.remove) {
      try { fs.rmSync(path.join(plan.root, file), { force: true }); done.removed += 1; } catch { done.failed.push(file); }
    }
  }
  return done;
}

module.exports = { planUndo, applyUndo, fileCount, fileList, parseNameStatus };
