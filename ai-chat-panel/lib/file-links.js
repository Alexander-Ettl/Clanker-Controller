'use strict';
// Turns a file reference written in a chat ("restricted-access\\notes.txt", "./src/a.js", "C:/x/y.md") into a real path.
// Agents often name a file relative to the folder they were working in, not the project root, so a plain join(root, ref)
// misses. When it does, the project's own file list is searched for the reference as a path suffix.
const fs = require('node:fs');
const path = require('node:path');
const { projectFiles } = require('./projects');

const LIST_TTL_MS = 30000;
const LIST_LIMIT = 20000;
const lists = new Map();

/** The project's files, remembered for a moment so a few clicks in a row walk the folder once. `fresh`: walk it now. */
async function cachedFiles(root, list = projectFiles, fresh = false) {
  const hit = lists.get(root);
  if (!fresh && hit && Date.now() - hit.at < LIST_TTL_MS) return { files: hit.files, remembered: true };
  const files = await list(root, LIST_LIMIT);
  lists.set(root, { at: Date.now(), files });
  return { files, remembered: false };
}

function clean(ref) {
  let target = String(ref || '').replace(/^file:\/\/\/?/i, '');
  try { target = decodeURIComponent(target); } catch { /* keep as written */ }
  if (/^\/[a-z]:/i.test(target)) target = target.slice(1);
  return target;
}

/**
 * Where `ref` is. An absolute path or one that exists under `root` is taken as written. Otherwise the project is searched
 * for a file whose path ends with `ref`; of several, the most recently changed wins (the file the agent just wrote).
 * Returns null when nothing matches.
 */
async function resolveFileRef(ref, root, { list = projectFiles, exists = fs.existsSync, mtime = (file) => fs.statSync(file).mtimeMs } = {}) {
  const target = clean(ref);
  if (!target) return null;
  if (path.isAbsolute(target)) return exists(target) ? path.normalize(target) : null;
  const direct = path.join(root, target);
  if (exists(direct)) return direct;
  const wanted = target.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (!wanted.length || wanted.includes('..') || !root) return null;
  const tail = wanted.join('/').toLowerCase();
  const find = (files) => files.filter((file) => { const lower = file.toLowerCase(); return lower === tail || lower.endsWith(`/${tail}`); });
  const listed = await cachedFiles(root, list);
  let matches = find(listed.files);
  // A miss against a remembered list may be a file written since: walk the folder again once before giving up.
  if (!matches.length && listed.remembered) matches = find((await cachedFiles(root, list, true)).files);
  if (!matches.length) return null;
  const stamped = matches.map((file) => { const full = path.join(root, file); let at = 0; try { at = mtime(full); } catch { /* vanished since the listing */ } return { full, at }; });
  stamped.sort((a, b) => b.at - a.at || a.full.length - b.full.length || (a.full < b.full ? -1 : 1));
  return stamped[0].full;
}

/** Forget remembered file lists (tests, or after the project folder changed). */
function clearFileListCache() { lists.clear(); }

module.exports = { resolveFileRef, clearFileListCache };
