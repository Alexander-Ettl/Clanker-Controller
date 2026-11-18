'use strict';

// Clanker Controller keeps its own state (chats, attachments, the scheduler queue, the voice dictionary) in the
// extension's per-user storage, not inside any project. Earlier versions kept it in a site's `.astro/session`; the
// first start after the change copies what is there, once, and never looks at that folder again.

const fs = require('node:fs');
const path = require('node:path');

const OWN_ENTRIES = ['chats', 'attachments', 'scheduler', 'scheduler-queue.json', 'handoff.json', 'slash-commands.json', 'voice-dictionary.json'];
const MIGRATED = '.migrated';

/**
 * @param {{ storageDir: string, legacyDirs?: string[], override?: string }} options
 * @returns {string} the session directory (created on first write by the code that uses it)
 */
function resolveSessionDir({ storageDir, legacyDirs = [], override = process.env.AI_CHAT_PANEL_SESSION_DIR }) {
  if (override) return override;
  const dir = path.join(storageDir, 'session');
  if (fs.existsSync(path.join(dir, MIGRATED))) return dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const legacy of legacyDirs.filter((candidate) => candidate && path.resolve(candidate) !== path.resolve(dir) && fs.existsSync(candidate))) {
      for (const entry of OWN_ENTRIES) {
        const from = path.join(legacy, entry);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, entry), { recursive: true, force: false, errorOnExist: false });
      }
    }
    fs.writeFileSync(path.join(dir, MIGRATED), new Date().toISOString());
  } catch {
    // Storage that cannot be written falls through to the same path: the first real write reports the problem.
  }
  return dir;
}

module.exports = { resolveSessionDir, OWN_ENTRIES };
