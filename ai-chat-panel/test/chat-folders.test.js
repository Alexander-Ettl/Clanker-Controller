'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chatFolders = require('../lib/chat-folders');

test('createFolder normalizes name, deduplicates chats, and keeps each chat in at most one folder', () => {
  const existing = new Set(['c1', 'c2', 'c3']);
  const first = chatFolders.createFolder([], '  Auth   refactor  ', ['c1', 'c1', 'ghost'], existing, 1000);
  assert.ok(first.folder);
  assert.equal(first.folder.name, 'Auth refactor');
  assert.deepEqual(first.folder.chatIds, ['c1']);
  assert.equal(first.folder.pinned, false);
  assert.equal(first.folder.pinnedAt, null);

  // Moving c1 into a second folder removes it from the first folder.
  const second = chatFolders.createFolder(first.folders, 'Release v2', ['c1', 'c2'], existing, 2000);
  assert.equal(second.folders.length, 2);
  const f2 = second.folders.find(f => f.name === 'Release v2');
  const f1 = second.folders.find(f => f.name === 'Auth refactor');
  assert.deepEqual(f2.chatIds, ['c1', 'c2']);
  assert.deepEqual(f1.chatIds, []);
});

test('createFolder rejects empty names and caps name length', () => {
  const blank = chatFolders.createFolder([], '   \t  ');
  assert.equal(blank.folder, null);
  assert.deepEqual(blank.folders, []);

  const long = chatFolders.createFolder([], 'A'.repeat(120));
  assert.equal(long.folder.name.length, chatFolders.MAX_NAME_LENGTH);
});

test('pinFolder, renameFolder, setChatFolder, setFolderChats, and deleteFolder preserve invariants', () => {
  const existing = new Set(['c1', 'c2', 'c3', 'c4']);
  const { folders: step1, folder: f1 } = chatFolders.createFolder([], 'Work', ['c1'], existing, 1000);
  const { folders: step2, folder: f2 } = chatFolders.createFolder(step1, 'Personal', ['c2'], existing, 2000);

  const pinned = chatFolders.pinFolder(step2, f1.id, true, 3000);
  assert.equal(pinned.find(f => f.id === f1.id).pinned, true);
  assert.equal(pinned.find(f => f.id === f1.id).pinnedAt, 3000);

  const unpinned = chatFolders.pinFolder(pinned, f1.id, false, 4000);
  assert.equal(unpinned.find(f => f.id === f1.id).pinned, false);
  assert.equal(unpinned.find(f => f.id === f1.id).pinnedAt, null);

  const renamed = chatFolders.renameFolder(unpinned, f1.id, 'Backend', 5000);
  assert.equal(renamed.find(f => f.id === f1.id).name, 'Backend');

  // Move c2 from Personal into Backend.
  const moved = chatFolders.setChatFolder(renamed, 'c2', f1.id, existing, 6000);
  assert.deepEqual(moved.find(f => f.id === f1.id).chatIds, ['c2', 'c1']);
  assert.deepEqual(moved.find(f => f.id === f2.id).chatIds, []);

  // Remove c1 from Backend (ungroup).
  const removed = chatFolders.setChatFolder(moved, 'c1', null, existing, 7000);
  assert.deepEqual(removed.find(f => f.id === f1.id).chatIds, ['c2']);

  // Bulk-set chats on Personal steals c2 from Backend and adds c3.
  const bulk = chatFolders.setFolderChats(removed, f2.id, ['c2', 'c3', 'missing'], existing, 8000);
  assert.deepEqual(bulk.find(f => f.id === f2.id).chatIds, ['c2', 'c3']);
  assert.deepEqual(bulk.find(f => f.id === f1.id).chatIds, []);

  // Deleting a folder removes only the folder record.
  const deleted = chatFolders.deleteFolder(bulk, f2.id);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].id, f1.id);
});

test('pruneDeletedChats drops deleted chat IDs and reports whether anything changed', () => {
  const { folders } = chatFolders.createFolder([], 'Active', ['c1', 'c2'], new Set(['c1', 'c2']), 1000);
  const unchanged = chatFolders.pruneDeletedChats(folders, new Set(['c1', 'c2', 'c3']));
  assert.equal(unchanged.changed, false);

  const pruned = chatFolders.pruneDeletedChats(folders, new Set(['c1']));
  assert.equal(pruned.changed, true);
  assert.deepEqual(pruned.folders[0].chatIds, ['c1']);
});

test('normalizeFolders sanitizes malformed input and prevents duplicate chat membership', () => {
  const raw = [
    null,
    { id: '', name: 'Bad' },
    { id: 'f1', name: 'One', chatIds: ['c1', 'c2'], pinned: true, pinnedAt: 500 },
    { id: 'f1', name: 'Duplicate ID', chatIds: ['c3'] },
    { id: 'f2', name: 'Two', chatIds: ['c2', 'c3'], pinned: false },
  ];
  const normalized = chatFolders.normalizeFolders(raw, new Set(['c1', 'c2', 'c3']));
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0].chatIds, ['c1', 'c2']);
  assert.equal(normalized[0].pinned, true);
  assert.equal(normalized[0].pinnedAt, 500);
  assert.deepEqual(normalized[1].chatIds, ['c3']);
});
