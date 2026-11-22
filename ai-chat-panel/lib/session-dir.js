'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OWN_ENTRIES = ['chats', 'attachments', 'scheduler', 'scheduler-queue.json', 'handoff.json', 'slash-commands.json', 'voice-dictionary.json'];
const DATA_FOLDER = 'clanker-controller-data';
const CONTENT_KEYS = new Set(['text', 'title', 'draft', 'prompt', 'output', 'command']);

function rebasePaths(file, source, dir) {
  const text = fs.readFileSync(file, 'utf8');
  let changed = false;
  let value;
  try {
    value = JSON.parse(text, (key, item) => {
      if (typeof item !== 'string' || CONTENT_KEYS.has(key) || !path.isAbsolute(item)) return item;
      const relative = path.relative(source, item);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return item;
      changed = true;
      return path.join(dir, relative);
    });
  } catch { return; } // ChatStore can still recover a damaged snapshot from its backup.
  if (changed) fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

/**
 * @param {{ storageDir: string, legacyDirs?: string[], override?: string }} options
 * @returns {string} the session directory
 */
function resolveSessionDir({ storageDir, legacyDirs = [], override = process.env.AI_CHAT_PANEL_SESSION_DIR }) {
  if (override) return override;
  const parent = path.dirname(storageDir);
  // Antigravity can delete the extension-ID directory when it removes a package.
  const dir = path.join(parent, DATA_FOLDER, 'session');
  if (fs.existsSync(dir)) return dir;
  const modern = [path.join(storageDir, 'session'), path.join(parent, 'local.ai-chat-panel', 'session')].find(folder => fs.existsSync(folder));
  const legacy = legacyDirs.find(folder => folder && OWN_ENTRIES.some(name => fs.existsSync(path.join(folder, name))));
  const source = modern || legacy;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(dir), 'migrate-'));
  try {
    if (source) {
      const entries = modern ? fs.readdirSync(source) : OWN_ENTRIES;
      for (const name of entries) {
        if (name === 'router-endpoint.json') continue;
        const from = path.join(source, name);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(temporary, name), { recursive: true, preserveTimestamps: true,
          filter: file => path.basename(file) !== 'manager.lock' });
      }
      for (const folder of [temporary, path.join(temporary, 'chats'), path.join(temporary, 'investigations')]) {
        if (!fs.existsSync(folder)) continue;
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          if (entry.isFile() && /\.json(?:\.bak)?$/.test(entry.name)) rebasePaths(path.join(folder, entry.name), source, dir);
        }
      }
    }
    try { fs.renameSync(temporary, dir); } catch (error) {
      if (!fs.existsSync(dir)) throw error;
    }
  } finally {
    // After a successful rename this particular temporary path no longer exists.
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return dir;
}

module.exports = { resolveSessionDir, OWN_ENTRIES, DATA_FOLDER };
