'use strict';

// Housekeeping for Clanker's own folder (chats, attachments, scheduler staging). Deliberately gentle: nothing that a
// chat or a waiting task still points to is touched, nothing younger than the grace period is touched (an image
// pasted into a draft has no chat yet), and chats themselves are never deleted here. Like git's pruning, it only
// removes what nothing reaches any more, and only after it has been unreachable for a while.
// `chats/` is never swept: chat snapshots, their tool-output blobs and `chats/transcripts/` (the plain-text copy a
// cross-agent briefing points into) stay until the chat is deleted.

const fs = require('node:fs');
const path = require('node:path');

const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const SIDECAR = require('./markup.js').SUFFIX;
const FINISHED =new Set(['done', 'cancelled']); // failed and interrupted tasks can be rescheduled, so they keep their files

/**
 * Attachment files that no chat or task mentions and that are older than the grace period.
 * @param {{ name: string, mtimeMs: number }[]} files
 * @param {string} haystack every chat and the scheduler queue as text: a file is in use if its name appears in it
 */
function selectOrphans(files, haystack, now = Date.now(), graceMs = GRACE_MS) {
  return files.filter((file) => now - file.mtimeMs >= graceMs && !haystack.includes(file.name));
}

/** Staging folders of scheduled tasks that finished (or vanished from the queue) longer ago than the grace period. */
function selectStaleStaging(dirs, tasks, now = Date.now(), graceMs = GRACE_MS) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return dirs.filter((dir) => {
    const task = byId.get(dir.name);
    const since = task ? Date.parse(task.completedAt || '') : dir.mtimeMs;
    return (!task || FINISHED.has(task.status)) && Number.isFinite(since) && now - since >= graceMs;
  });
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/** Runs both sweeps; returns what it removed. Never throws: housekeeping must not get in the way of the panel. */
function sweepStorage(sessionDir, { now = Date.now(), graceMs = GRACE_MS } = {}) {
  const removed = { attachments: 0, staging: 0, bytes: 0 };
  try {
    const chatsDir = path.join(sessionDir, 'chats');
    const queueFile = path.join(sessionDir, 'scheduler-queue.json');
    const haystack = [...(fs.existsSync(chatsDir) ? fs.readdirSync(chatsDir).map((name) => readText(path.join(chatsDir, name))) : []), readText(queueFile)].join('\n');

    const attachmentsDir = path.join(sessionDir, 'attachments');
    if (fs.existsSync(attachmentsDir)) {
      const files = fs.readdirSync(attachmentsDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
        const stat = fs.statSync(path.join(attachmentsDir, entry.name));
        return { name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size };
      });
      // A marked-up image keeps its original: the sidecar names it, and the sidecar lives as long as the flattened copy.
      let kept = haystack;
      for (const file of files) {
        if (!file.name.endsWith(SIDECAR) || !haystack.includes(file.name.slice(0, -SIDECAR.length))) continue;
        kept += `\n${file.name}\n${readText(path.join(attachmentsDir, file.name))}`;
      }
      for (const file of selectOrphans(files, kept, now, graceMs)) {
        try { fs.unlinkSync(path.join(attachmentsDir, file.name)); removed.attachments++; removed.bytes += file.size; } catch { /* in use or already gone */ }
      }
    }

    const stagingDir = path.join(sessionDir, 'scheduler');
    if (fs.existsSync(stagingDir)) {
      let tasks = [];
      try { tasks = JSON.parse(readText(queueFile) || '[]'); } catch { return removed; } // an unreadable queue: leave all staging alone
      const dirs = fs.readdirSync(stagingDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, mtimeMs: fs.statSync(path.join(stagingDir, entry.name)).mtimeMs }));
      for (const dir of selectStaleStaging(dirs, Array.isArray(tasks) ? tasks : [], now, graceMs)) {
        try { fs.rmSync(path.join(stagingDir, dir.name), { recursive: true, force: true }); removed.staging++; } catch { /* leave it for next time */ }
      }
    }
  } catch { /* best effort */ }
  return removed;
}

module.exports = { sweepStorage, selectOrphans, selectStaleStaging, GRACE_MS };
