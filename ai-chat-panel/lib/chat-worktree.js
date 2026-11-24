'use strict';

// An isolated git worktree for one chat, so two agents working in one repository can't overwrite each other (WORKTREE-01).
// This is the git side only: create, inspect, list and remove. Nothing here knows about chats' storage or the UI; the chat keeps
// the returned record ({ path, branch, base, repoRoot }) and uses `path` as its working root for every turn.
//
// Worktrees live under a managed folder outside the repository (and outside any synced folder), on a branch `clanker/<slug>`.
// Ignored essentials (.env, node_modules ...) are linked into the new tree, never copied. The folder is deleted through
// `git worktree remove` after our own links are unlinked first, so removing a worktree can never reach the real dependencies.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const SYNCED = /[\\/](Nextcloud|OneDrive|Dropbox)[\\/]/i;
const DEFAULT_SETUP = ['.env', '.env.local', 'node_modules'];

/** Where managed worktrees go: CLANKER_WORKTREES, else ~/.clanker/worktrees. Refuses a synced folder. */
function managedRoot(env = process.env) {
  const root = path.resolve(env.CLANKER_WORKTREES || path.join(os.homedir(), '.clanker', 'worktrees'));
  if (SYNCED.test(root + path.sep)) throw new Error(`Worktrees can't live in a synced folder (${root}). Set CLANKER_WORKTREES to a folder outside Nextcloud or OneDrive.`);
  return root;
}

/** A branch- and folder-safe name from a chat title. */
function slugify(text) {
  const slug = String(text || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return slug || 'chat';
}

const repoTopLevel = (dir) => path.resolve(git(dir, ['rev-parse', '--show-toplevel']).trim());
const branchExists = (repo, branch) => { try { git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; } };

/** Dirty files of a working tree (git status --porcelain), as [code, path] pairs. */
function dirtyFiles(dir) {
  return git(dir, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean).filter((entry) => entry.length > 3).map((entry) => [entry.slice(0, 2), entry.slice(3)]);
}

/**
 * Creates `<managed>/<repo name>/<slug>` on a new branch `clanker/<slug>` from `base` (default HEAD).
 * Returns { path, branch, base, baseCommit, repoRoot, linked, warnings }. Refuses a repository with submodules; warns when the
 * base checkout has uncommitted work, since a worktree starts from the commit and doesn't have it.
 */
function createWorktree({ repoRoot, title, chatId, base = 'HEAD', setup = DEFAULT_SETUP, env = process.env } = {}) {
  const repo = repoTopLevel(repoRoot);
  if (fs.existsSync(path.join(repo, '.gitmodules'))) throw new Error('This repository has submodules, which worktrees don\'t handle well. Work in the project folder instead.');
  const warnings = [];
  const dirty = dirtyFiles(repo);
  if (dirty.length) warnings.push(`${dirty.length} uncommitted file${dirty.length === 1 ? ' is' : 's are'} in the project folder. The worktree starts from the last commit and does not include ${dirty.length === 1 ? 'it' : 'them'}.`);
  const baseCommit = git(repo, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const parent = path.join(managedRoot(env), slugify(path.basename(repo)));
  fs.mkdirSync(parent, { recursive: true });
  // A taken name gets a short suffix from the chat id (or a counter), so two chats with the same title don't collide.
  const stem = slugify(title);
  let slug = stem;
  for (let n = 1; fs.existsSync(path.join(parent, slug)) || branchExists(repo, `clanker/${slug}`); n++) slug = `${stem}-${chatId ? String(chatId).replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase() || n : n}${n > 1 ? `-${n}` : ''}`;
  const target = path.join(parent, slug);
  const branch = `clanker/${slug}`;
  git(repo, ['worktree', 'add', '-b', branch, target, baseCommit]);
  const linked = [];
  for (const name of setup) {
    const from = path.join(repo, name);
    const to = path.join(target, name);
    if (!name || name.includes('..') || path.isAbsolute(name) || !fs.existsSync(from) || fs.existsSync(to)) continue; // a tracked file is already there
    try { git(repo, ['check-ignore', '-q', '--', name]); } catch { continue; } // only ignored files: a tracked one came with the checkout
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.symlinkSync(from, to, fs.statSync(from).isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    linked.push(name);
  }
  if (linked.length) ignoreLinks(repo, linked);
  return { path: target, branch, base, baseCommit, repoRoot: repo, linked, warnings };
}

/**
 * A pattern like `node_modules/` matches directories only, so git sees our symlink to it as an ordinary new file and `git add -A`
 * in the worktree would commit it. The names are already ignored in the project (that is why they were linked), so listing them
 * without the trailing slash in the repository's info/exclude changes nothing there and stops the symlink being staged.
 */
function ignoreLinks(repo, names) {
  try {
    const common = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim());
    const file = path.join(common, 'info', 'exclude');
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = names.map((name) => `/${name.replace(/\\/g, '/')}`).filter((line) => !have.split(/\r?\n/).includes(line));
    if (!missing.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}# Clanker worktree links (already ignored in this project)\n${missing.join('\n')}\n`);
  } catch { /* the worktree still works; a link could then be staged by `git add -A` */ }
}

/** Branch, dirty files and how far the branch is from its base. Throws when the folder is gone. */
function worktreeStatus({ path: dir, baseCommit }) {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const dirty = dirtyFiles(dir).filter(([, file]) => !isLinkedEssential(dir, file));
  let ahead = null;
  try { ahead = Number(git(dir, ['rev-list', '--count', `${baseCommit}..HEAD`]).trim()); } catch { /* base unknown */ }
  return { branch, dirty: dirty.length, ahead, files: dirty.map(([code, file]) => ({ code: code.trim() || '?', file })).slice(0, 200) };
}
const isLinkedEssential = (dir, file) => { try { return fs.lstatSync(path.join(dir, file.replace(/\/$/, ''))).isSymbolicLink(); } catch { return false; } };

/**
 * Every file that differs from the commit the worktree started from: committed, staged, edited and new (untracked, not ignored).
 * [{ status: 'M' | 'A' | 'D' | 'R', file }], sorted. Our links to .env or node_modules are not changes.
 */
function changesAgainstBase({ path: dir, baseCommit }) {
  const found = new Map();
  const parts = git(dir, ['diff', '--name-status', '-z', '--no-renames', baseCommit]).split('\0').filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) found.set(parts[i + 1], parts[i][0]);
  for (const file of git(dir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) if (!found.has(file)) found.set(file, 'A');
  return [...found].filter(([file]) => !isLinkedEssential(dir, file)).map(([file, status]) => ({ status, file })).sort((a, b) => a.file.localeCompare(b.file));
}

/** Removes our links from the tree so a delete can't follow them into the real dependencies. */
function unlinkEssentials(dir, setup) {
  const removed = [];
  for (const name of setup) {
    const full = path.join(dir, name);
    try { if (fs.lstatSync(full).isSymbolicLink()) { try { fs.rmdirSync(full); } catch { fs.unlinkSync(full); } removed.push(name); } } catch { /* not there */ }
  }
  return removed;
}

/**
 * Deletes the worktree and its branch when nothing would be lost. A dirty tree, or a branch with commits the base doesn't have,
 * stays unless `force` is set. Returns { removed, branchDeleted, reason }.
 */
function removeWorktree({ repoRoot, path: dir, branch, baseCommit, force = false, setup = DEFAULT_SETUP, env = process.env } = {}) {
  const repo = repoTopLevel(repoRoot);
  const root = managedRoot(env) + path.sep;
  const target = path.resolve(dir);
  if (!(target + path.sep).startsWith(root)) throw new Error('That folder is not one of Clanker\'s managed worktrees.');
  if (fs.existsSync(target)) {
    let state = null;
    try { state = worktreeStatus({ path: target, baseCommit: baseCommit || 'HEAD' }); } catch { /* an unreadable tree is removed by force only */ }
    if (!force && (!state || state.dirty)) return { removed: false, branchDeleted: false, reason: state ? `${state.dirty} uncommitted file${state.dirty === 1 ? '' : 's'}` : 'its state could not be read' };
    unlinkEssentials(target, setup);
    git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), target]);
  }
  git(repo, ['worktree', 'prune']);
  let branchDeleted = false;
  if (branch && branchExists(repo, branch)) {
    try { git(repo, ['branch', force ? '-D' : '-d', branch]); branchDeleted = true; } catch { /* unmerged commits: the branch stays so they aren't lost */ }
  }
  return { removed: true, branchDeleted, reason: branchDeleted || !branch ? '' : `the branch ${branch} has commits that are not merged, so it was kept` };
}

/** Managed worktrees git knows for this repository: [{ path, branch, head, missing }]. `missing`: the folder was deleted by hand. */
function listManaged(repoRoot, env = process.env) {
  const repo = repoTopLevel(repoRoot);
  const root = managedRoot(env) + path.sep;
  const out = [];
  let entry = {};
  for (const line of `${git(repo, ['worktree', 'list', '--porcelain'])}\n`.split(/\r?\n/)) {
    if (!line) { if (entry.path && (path.resolve(entry.path) + path.sep).startsWith(root)) out.push({ ...entry, missing: !fs.existsSync(entry.path) }); entry = {}; continue; }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') entry.path = value; else if (key === 'HEAD') entry.head = value; else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
  }
  return out;
}

/** Forgets worktrees whose folder was deleted by hand, so `git worktree list` has no stale entry. */
function pruneStale(repoRoot) { git(repoTopLevel(repoRoot), ['worktree', 'prune']); }

module.exports = { DEFAULT_SETUP, managedRoot, slugify, createWorktree, worktreeStatus, changesAgainstBase, removeWorktree, listManaged, pruneStale, dirtyFiles };
