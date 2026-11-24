'use strict';

// What a turn changed, for the line under its reply ("3 files, +42 / -11") and for the diff editor. It reads the same
// bookkeeping as undo (lib/turn-undo.js): the snapshot `git stash create` took before the turn, per repo. The files are the
// ones undo would touch, so the two always agree: edited and deleted files compare against the snapshot, and a file counts
// as created only if it appeared after the turn began (your own untracked files are never listed).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planUndo } = require('./turn-undo.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const MAX_FILES = 200; // the list under a reply; the count still covers every file
const SCHEME = 'clanker-snapshot';

/** `--numstat -z` output as Map(file -> { add, del }); binary files report "-" and become null counts. */
function parseNumstat(out) {
  const counts = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(parts[i]);
    if (!match) continue;
    counts.set(match[3], { add: match[1] === '-' ? null : Number(match[1]), del: match[2] === '-' ? null : Number(match[2]) });
  }
  return counts;
}

/** Lines in a new file, or null for a binary one (a NUL byte in the first 8 KB, as git decides). */
function countLines(full) {
  try {
    const buffer = fs.readFileSync(full);
    if (buffer.subarray(0, 8192).includes(0)) return null;
    if (!buffer.length) return 0;
    return buffer.toString('utf8').split('\n').length - (buffer[buffer.length - 1] === 0x0a ? 1 : 0);
  } catch { return null; }
}

/**
 * The turn's changed files. `bases`: [[repoRoot, snapshotHash], ...] as the engine took them; `base`: the folder the
 * paths are shown relative to. Returns { files: [{ path, status: 'M'|'A'|'D', add, del, root, file }], count, add, del, missing }.
 * `root` and `file` stay on the host; the webview only gets the index and the shown path.
 */
function summarizeTurn(bases, startedAt, base) {
  const files = [];
  let missing = false;
  for (const plan of planUndo(bases, startedAt)) {
    if (plan.missing) { missing = true; continue; }
    let counts = new Map();
    let status = new Map();
    try {
      counts = parseNumstat(git(['diff', '--numstat', '--no-renames', '-z', plan.snapshot], plan.root));
      status = new Map(git(['diff', '--name-status', '--no-renames', '-z', plan.snapshot], plan.root).split('\0').filter(Boolean).reduce((pairs, part, i, all) => (i % 2 === 0 ? [...pairs, [all[i + 1], part[0]]] : pairs), []));
    } catch { /* an unreadable repo contributes only its created files */ }
    for (const file of plan.restore) files.push({ root: plan.root, file, status: status.get(file) === 'D' ? 'D' : 'M', ...(counts.get(file) || { add: 0, del: 0 }) });
    for (const file of plan.remove) {
      // `remove` holds created files, which are not in the snapshot: staged ones (A in the diff) and untracked ones.
      const staged = counts.get(file);
      files.push({ root: plan.root, file, status: 'A', ...(staged || { add: countLines(path.join(plan.root, file)), del: 0 }) });
    }
  }
  const rel = (entry) => path.relative(base || entry.root, path.join(entry.root, entry.file)).split(path.sep).join('/');
  const listed = files.map((entry) => ({ ...entry, path: rel(entry) })).sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: listed.slice(0, MAX_FILES),
    count: listed.length,
    add: listed.reduce((sum, entry) => sum + (entry.add || 0), 0),
    del: listed.reduce((sum, entry) => sum + (entry.del || 0), 0),
    missing,
  };
}

/** What the webview may see: no repo roots, no absolute paths. */
const publicSummary = (summary) => ({
  count: summary.count, add: summary.add, del: summary.del,
  files: summary.files.map(({ path: shown, status, add, del }) => ({ path: shown, status, add, del })),
});

/** `git show <snapshot>:<file>` for the left side of a diff; '' for a file the snapshot doesn't have (a created one). */
function snapshotText(root, snapshot, file) {
  try { return execFileSync('git', ['show', `${snapshot}:${file}`], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
}

/** The URI of the snapshot copy of a file, which the editor's virtual document provider turns into text (extension.js). */
function snapshotQuery(root, snapshot, file) { return JSON.stringify({ root, snapshot, file }); }

/** Reads a query made by snapshotQuery back, refusing anything that is not a 40/64 hex commit and a path inside the repo. */
function parseSnapshotQuery(query) {
  let data;
  try { data = JSON.parse(query); } catch { return null; }
  if (!data || typeof data.root !== 'string' || typeof data.file !== 'string' || !/^[0-9a-f]{40,64}$/.test(String(data.snapshot))) return null;
  const full = path.resolve(data.root, data.file);
  if (!full.startsWith(path.resolve(data.root) + path.sep)) return null;
  return data;
}

module.exports = { SCHEME, summarizeTurn, publicSummary, parseNumstat, countLines, snapshotText, snapshotQuery, parseSnapshotQuery };
