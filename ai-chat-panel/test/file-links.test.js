const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFileRef, clearFileListCache } = require('../lib/file-links');

function project() {
  clearFileListCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-links-'));
  const put = (rel, age = 0) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    const when = new Date(Date.now() - age * 1000);
    fs.utimesSync(full, when, when);
    return full;
  };
  return { root, put };
}

test('a path under the project root resolves as written', async () => {
  const { root, put } = project();
  const file = put('docs/guide.md');
  assert.equal(await resolveFileRef('docs/guide.md', root), file);
  assert.equal(await resolveFileRef('docs\\guide.md', root), file);
  assert.equal(await resolveFileRef('./docs/guide.md', root), file);
});

test('a reference relative to a subfolder is found by searching the project', async () => {
  const { root, put } = project();
  const file = put('Portfolio/2026/restricted-access/enable-updates-ready.txt');
  assert.equal(await resolveFileRef('restricted-access\\enable-updates-ready.txt', root), file);
  assert.equal(await resolveFileRef('enable-updates-ready.txt', root), file);
});

test('several matches pick the most recently changed one; unknown files are null', async () => {
  const { root, put } = project();
  put('old/notes.md', 500);
  const fresh = put('new/notes.md', 1);
  assert.equal(await resolveFileRef('notes.md', root), fresh);
  assert.equal(await resolveFileRef('missing.md', root), null);
  assert.equal(await resolveFileRef('../outside.md', root), null);
});

test('absolute and file:// references are taken as they are, only if they exist', async () => {
  const { root, put } = project();
  const file = put('a.txt');
  assert.equal(await resolveFileRef(file, root), file);
  assert.equal(await resolveFileRef('file:///' + file.split(path.sep).join('/'), root), file);
  assert.equal(await resolveFileRef(path.join(root, 'nope.txt'), root), null);
});

test('a file written after the list was remembered is still found', async () => {
  const { root, put } = project();
  put('src/a.js');
  assert.equal(await resolveFileRef('notes/out.md', root), null);
  const written = put('sub/notes/out.md');
  assert.equal(await resolveFileRef('notes/out.md', root), written);
});
