'use strict';

// The loop's private copy of a project. Everything the loop edits, builds or serves happens here, never in the real checkout.
// The copy is a plain git repository (a "baseline" commit, then one commit per accepted fix), so a stopped run can be rewound
// to a clean state and the accumulated work can be written out as one patch.

const fs = require('node:fs');
const path = require('node:path');
const { git, run, nodeCommand } = require('./loop-exec');

const MAX_FILE_BYTES = 25 * 1024 * 1024, MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const SKIP_DIRS = /(?:^|\/)(?:node_modules|\.git|\.agents|\.venv|__pycache__|Pods|DerivedData|\.gradle|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|coverage)(?:\/|$)/;
const SECRETS = /(?:^|\/)(?:\.env(?:\.[\w.-]*)?|[^/]*\.(?:pem|key|p12|pfx|keystore|jks)|id_(?:rsa|ed25519|ecdsa)|credentials?(?:\.[\w]+)?|secrets?(?:\.[\w]+)?|\.npmrc|\.netrc)$/i;
const inside = (root, file) => { const relative = path.relative(root, file); return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative); };

/** Removes every junction/symlink below `dir` without following it, so deleting the tree can never reach the real dependencies. */
function unlinkJunctions(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries; try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let link = false; try { link = fs.lstatSync(full).isSymbolicLink(); } catch { /* gone */ }
      if (link) { try { fs.rmdirSync(full); } catch { try { fs.unlinkSync(full); } catch { /* checked by the caller */ } } }
      else if (entry.isDirectory() && entry.name !== '.git') stack.push(full);
    }
  }
}
/** Deletes a loop workspace. Its node_modules folders are junctions to the real ones: unlink every junction first and never delete through one. */
function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  unlinkJunctions(dir);
  const link = path.join(dir, 'snapshot', 'node_modules');
  try { if (fs.lstatSync(link).isSymbolicLink()) throw new Error('Refusing to delete a workspace that still links to the real dependencies.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Tracked and unignored files of the project, relative with forward slashes. Falls back to a plain walk outside git. */
function listProjectFiles(root) {
  let listed = null;
  try { listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean); } catch { /* not a repository */ }
  if (listed) return listed;
  const found = [], stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIP_DIRS.test(`${child}/`)) continue;
      if (entry.isDirectory()) stack.push(child); else if (entry.isFile()) found.push(child);
    }
  }
  return found;
}

/** node_modules folders (up to two levels deep) of the real project, relative. */
function findDependencyFolders(root) {
  const found = [];
  const visit = (rel, depth) => {
    let entries; try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === 'node_modules') found.push(child);
      else if (depth < 2 && !SKIP_DIRS.test(`${child}/`) && !entry.name.startsWith('.')) visit(child, depth + 1);
    }
  };
  visit('', 0);
  return found;
}
function linkDependencies(root, checkout) {
  for (const rel of findDependencyFolders(root)) {
    const target = path.join(checkout, rel);
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); if (!fs.existsSync(target)) fs.symlinkSync(path.join(root, rel), target, 'junction'); } catch { /* checks will report missing dependencies */ }
  }
}

/**
 * Copies the project into `<workspace>/snapshot`, skipping dependencies, secrets and oversized files, and links its dependency
 * folders. Copies in batches and yields between them so a big project does not freeze the extension host.
 */
async function snapshotProject(root, workspace) {
  const checkout = path.join(workspace, 'snapshot'); fs.mkdirSync(checkout, { recursive: true });
  let bytes = 0, copied = 0, skipped = 0;
  const jobs = [], made = new Map();
  for (const file of listProjectFiles(root)) {
    if (SKIP_DIRS.test(file) || SECRETS.test(file)) { skipped++; continue; }
    const source = path.resolve(root, file);
    if (!inside(root, source)) continue;
    let stat; try { stat = fs.lstatSync(source); } catch { continue; } // tracked but deleted in the working tree
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { skipped++; continue; }
    bytes += stat.size; if (bytes > MAX_TOTAL_BYTES) throw new Error('The project is larger than 2 GB without dependencies; the loop cannot copy it.');
    jobs.push([source, path.join(checkout, file)]);
  }
  for (let index = 0; index < jobs.length; index += 64) {
    await Promise.all(jobs.slice(index, index + 64).map(async ([source, target]) => {
      const dir = path.dirname(target);
      if (!made.has(dir)) made.set(dir, fs.promises.mkdir(dir, { recursive: true }));
      await made.get(dir);
      await fs.promises.copyFile(source, target); copied++;
    }));
  }
  linkDependencies(root, checkout);
  return { checkout, copied, skipped, bytes };
}

const dirty = cwd => git(cwd, ['status', '--porcelain']).trim().length > 0;
const revert = cwd => { git(cwd, ['reset', '--hard', '-q']); git(cwd, ['clean', '-fdq']); };
const head = cwd => git(cwd, ['rev-parse', 'HEAD']).trim();
const baselineOf = cwd => git(cwd, ['rev-list', '--max-parents=0', 'HEAD']).trim().split(/\r?\n/)[0];
const branchOf = id => `fix-${String(id).replace(/[^\w.-]/g, '_')}`;

/** Removes every fix worktree left by a stopped run so the workspace is back to its last committed state. */
function cleanupWorktrees(checkout, workspace) {
  const fixDir = path.join(workspace, 'fix');
  try { if (fs.existsSync(fixDir)) removeTree(fixDir); } catch { /* retried next time */ }
  git(checkout, ['worktree', 'prune'], { allowFail: true });
  for (const branch of git(checkout, ['branch', '--list', 'fix-*', '--format=%(refname:short)'], { allowFail: true }).split(/\r?\n/).filter(Boolean)) git(checkout, ['branch', '-D', branch], { allowFail: true });
}

/** The workspace's checkout, rewound to its last commit; created from the real project the first time. */
async function prepareWorkspaceInProcess(root, workspace) {
  const checkout = path.join(workspace, 'snapshot');
  // `git init` may have succeeded before staging/committing failed. Such a copy has no
  // baseline to reset to; rebuild it just like an interrupted copy operation.
  if (fs.existsSync(path.join(checkout, '.git')) && git(checkout, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).trim()) {
    cleanupWorktrees(checkout, workspace);
    git(checkout, ['cherry-pick', '--abort'], { allowFail: true });
    revert(checkout); linkDependencies(root, checkout); return checkout;
  }
  if (fs.existsSync(workspace)) removeTree(workspace); // a crash while copying: start over
  await snapshotProject(root, workspace);
  const ignore = path.join(checkout, '.gitignore');
  fs.writeFileSync(ignore, `${fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') + '\n' : ''}node_modules\n.agents/\n`);
  git(checkout, ['init', '-q']);
  for (const [key, value] of [['user.email', 'loop@clanker.invalid'], ['user.name', 'Clanker loop'], ['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['commit.gpgsign', 'false']]) git(checkout, ['config', key, value]);
  git(checkout, ['add', '-A']); git(checkout, ['commit', '-q', '--allow-empty', '-m', 'baseline']);
  return checkout;
}

/** Discovery, cleanup and Git can block for minutes on a large project. Keep them off the extension host. */
async function prepareWorkspace(root, workspace, { signal } = {}) {
  signal?.throwIfAborted();
  const node = nodeCommand();
  const result = await run(node.command, [__filename, '--prepare'], {
    cwd: root, env: node.env, signal, input: JSON.stringify({ root, workspace }), timeoutMs: 30 * 60000,
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not prepare the loop workspace.');
  return JSON.parse(result.output).checkout;
}

// A native Node child owns the entire preparation, including its blocking Git processes.
// The parent's runner hides its window and kills its process tree on cancellation.
if (require.main === module && process.argv[2] === '--prepare') {
  const os = require('node:os');
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  Promise.resolve().then(() => {
    const { root, workspace } = JSON.parse(fs.readFileSync(0, 'utf8'));
    return prepareWorkspaceInProcess(root, workspace);
  }).then(checkout => process.stdout.write(JSON.stringify({ checkout })), error => {
    process.stderr.write(error.message); process.exitCode = 1;
  });
}

/** A worktree for one fix, on its own branch off the current head, with dependency folders linked. Returns its path. */
function addWorktree(checkout, workspace, root, id) {
  const dir = path.join(workspace, 'fix', String(id).replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(checkout, ['worktree', 'add', '-q', '-b', branchOf(id), dir, 'HEAD']);
  linkDependencies(root, dir);
  return dir;
}
function removeWorktree(checkout, dir, id) {
  try { unlinkJunctions(dir); } catch { /* removeTree below reports */ }
  git(checkout, ['worktree', 'remove', '--force', dir], { allowFail: true });
  try { removeTree(dir); } catch { /* left for the next cleanup */ }
  git(checkout, ['worktree', 'prune'], { allowFail: true });
  git(checkout, ['branch', '-D', branchOf(id)], { allowFail: true });
}

module.exports = { removeTree, unlinkJunctions, listProjectFiles, snapshotProject, linkDependencies, prepareWorkspace, cleanupWorktrees, addWorktree, removeWorktree,
  dirty, revert, head, baselineOf, inside, SECRETS, SKIP_DIRS };
