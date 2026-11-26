// @ts-check
'use strict';

const crypto = require('node:crypto');

const MAX_NAME_LENGTH = 60;

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   chatIds: string[],
 *   pinned: boolean,
 *   pinnedAt: number | null,
 *   createdAt: string,
 *   updatedAt: string,
 * }} ChatFolder
 */

/** @param {unknown} value @returns {string} */
function normalizeName(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/**
 * Normalizes a persisted folder array: drops malformed records, deduplicates folder IDs,
 * enforces that each chat belongs to at most one folder, and optionally drops deleted chat IDs.
 * @param {unknown} raw
 * @param {Set<string> | null} [existingChatIds]
 * @returns {ChatFolder[]}
 */
function normalizeFolders(raw, existingChatIds = null) {
  if (!Array.isArray(raw)) return [];
  const seenFolders = new Set();
  const claimedChats = new Set();
  /** @type {ChatFolder[]} */
  const folders = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (entry);
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : '';
    const name = normalizeName(record.name);
    if (!id || !name || seenFolders.has(id)) continue;
    seenFolders.add(id);
    /** @type {string[]} */
    const chatIds = [];
    if (Array.isArray(record.chatIds)) {
      for (const chatId of record.chatIds) {
        if (typeof chatId !== 'string' || !chatId || claimedChats.has(chatId)) continue;
        if (existingChatIds && !existingChatIds.has(chatId)) continue;
        claimedChats.add(chatId);
        chatIds.push(chatId);
      }
    }
    const pinned = record.pinned === true;
    const pinnedAt = pinned && Number.isFinite(Number(record.pinnedAt)) ? Number(record.pinnedAt) : (pinned ? 0 : null);
    const createdAt = typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : new Date(0).toISOString();
    const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : createdAt;
    folders.push({ id, name, chatIds, pinned, pinnedAt, createdAt, updatedAt });
  }
  return folders;
}

/**
 * @param {ChatFolder[]} folders
 * @param {string} name
 * @param {string[]} [chatIds]
 * @param {Set<string> | null} [existingChatIds]
 * @param {number} [now]
 * @returns {{ folders: ChatFolder[], folder: ChatFolder | null }}
 */
function createFolder(folders, name, chatIds = [], existingChatIds = null, now = Date.now()) {
  const cleanName = normalizeName(name);
  if (!cleanName) return { folders: normalizeFolders(folders, existingChatIds), folder: null };
  const base = normalizeFolders(folders, existingChatIds);
  const validAdds = [];
  const addSet = new Set();
  for (const chatId of Array.isArray(chatIds) ? chatIds : []) {
    if (typeof chatId !== 'string' || !chatId || addSet.has(chatId)) continue;
    if (existingChatIds && !existingChatIds.has(chatId)) continue;
    addSet.add(chatId);
    validAdds.push(chatId);
  }
  const iso = new Date(now).toISOString();
  const cleaned = base.map(folder => {
    if (!addSet.size || !folder.chatIds.some(id => addSet.has(id))) return folder;
    return { ...folder, chatIds: folder.chatIds.filter(id => !addSet.has(id)), updatedAt: iso };
  });
  /** @type {ChatFolder} */
  const folder = {
    id: crypto.randomUUID(),
    name: cleanName,
    chatIds: validAdds,
    pinned: false,
    pinnedAt: null,
    createdAt: iso,
    updatedAt: iso,
  };
  return { folders: [folder, ...cleaned], folder };
}

/**
 * @param {ChatFolder[]} folders
 * @param {string} folderId
 * @param {string} name
 * @param {number} [now]
 * @returns {ChatFolder[]}
 */
function renameFolder(folders, folderId, name, now = Date.now()) {
  const cleanName = normalizeName(name);
  if (!folderId || !cleanName) return normalizeFolders(folders);
  const iso = new Date(now).toISOString();
  return normalizeFolders(folders).map(folder => (folder.id === folderId ? { ...folder, name: cleanName, updatedAt: iso } : folder));
}

/**
 * Deletes only the folder wrapper; chats inside become ungrouped again.
 * @param {ChatFolder[]} folders
 * @param {string} folderId
 * @returns {ChatFolder[]}
 */
function deleteFolder(folders, folderId) {
  return normalizeFolders(folders).filter(folder => folder.id !== folderId);
}

/**
 * @param {ChatFolder[]} folders
 * @param {string} folderId
 * @param {boolean} pinned
 * @param {number} [now]
 * @returns {ChatFolder[]}
 */
function pinFolder(folders, folderId, pinned, now = Date.now()) {
  const base = normalizeFolders(folders);
  return base.map(folder => {
    if (folder.id !== folderId) return folder;
    if (folder.pinned === pinned) return folder;
    return { ...folder, pinned, pinnedAt: pinned ? now : null };
  });
}

/**
 * Moves a chat into `folderId`, or removes it from any folder when `folderId` is null/empty.
 * @param {ChatFolder[]} folders
 * @param {string} chatId
 * @param {string | null} folderId
 * @param {Set<string> | null} [existingChatIds]
 * @param {number} [now]
 * @returns {ChatFolder[]}
 */
function setChatFolder(folders, chatId, folderId, existingChatIds = null, now = Date.now()) {
  if (typeof chatId !== 'string' || !chatId) return normalizeFolders(folders, existingChatIds);
  if (existingChatIds && !existingChatIds.has(chatId)) return normalizeFolders(folders, existingChatIds);
  const base = normalizeFolders(folders, existingChatIds);
  const targetExists = Boolean(folderId && base.some(folder => folder.id === folderId));
  const iso = new Date(now).toISOString();
  return base.map(folder => {
    const had = folder.chatIds.includes(chatId);
    const shouldHave = targetExists && folder.id === folderId;
    if (had === shouldHave) return folder;
    const chatIds = shouldHave ? [chatId, ...folder.chatIds.filter(id => id !== chatId)] : folder.chatIds.filter(id => id !== chatId);
    return { ...folder, chatIds, updatedAt: iso };
  });
}

/**
 * Bulk-updates the chats inside `folderId`. Any chat added here is moved out of its previous folder.
 * @param {ChatFolder[]} folders
 * @param {string} folderId
 * @param {string[]} chatIds
 * @param {Set<string> | null} [existingChatIds]
 * @param {number} [now]
 * @returns {ChatFolder[]}
 */
function setFolderChats(folders, folderId, chatIds, existingChatIds = null, now = Date.now()) {
  const base = normalizeFolders(folders, existingChatIds);
  if (!base.some(folder => folder.id === folderId)) return base;
  const nextIds = [];
  const nextSet = new Set();
  for (const id of Array.isArray(chatIds) ? chatIds : []) {
    if (typeof id !== 'string' || !id || nextSet.has(id)) continue;
    if (existingChatIds && !existingChatIds.has(id)) continue;
    nextSet.add(id);
    nextIds.push(id);
  }
  const iso = new Date(now).toISOString();
  return base.map(folder => {
    if (folder.id === folderId) return { ...folder, chatIds: nextIds, updatedAt: iso };
    if (!folder.chatIds.some(id => nextSet.has(id))) return folder;
    return { ...folder, chatIds: folder.chatIds.filter(id => !nextSet.has(id)), updatedAt: iso };
  });
}

/**
 * Removes deleted chat IDs from every folder.
 * @param {ChatFolder[]} folders
 * @param {Set<string>} existingChatIds
 * @returns {{ folders: ChatFolder[], changed: boolean }}
 */
function pruneDeletedChats(folders, existingChatIds) {
  const before = normalizeFolders(folders);
  const after = normalizeFolders(before, existingChatIds);
  const changed = before.length !== after.length || before.some((folder, idx) => folder.chatIds.length !== after[idx].chatIds.length);
  return { folders: after, changed };
}

module.exports = {
  MAX_NAME_LENGTH,
  normalizeName,
  normalizeFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  pinFolder,
  setChatFolder,
  setFolderChats,
  pruneDeletedChats,
};
