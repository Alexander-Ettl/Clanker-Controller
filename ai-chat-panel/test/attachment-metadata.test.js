'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
let ChatWindowHost;
try {
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return { env: { language: 'en' }, Uri: { file: file => ({ fsPath: file }) } };
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ChatWindowHost } = require('../extension'));
} finally { Module._load = originalLoad; }

test('attachment metadata recognizes SVG/PDF from picker, upload and restored history', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-attachment-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = Object.assign(Object.create(ChatWindowHost.prototype), {
    panel: { webview: { asWebviewUri: uri => ({ toString: () => `preview:${uri.fsPath}` }) } },
    safeAttachmentPaths: paths => paths,
  });
  const names = ['comment.SVG', 'review.PDF', 'photo.png', 'notes.txt'];
  const files = names.map(name => { const file = path.join(root, name); fs.writeFileSync(file, 'test'); return file; });
  const types = ['image/svg+xml', 'application/pdf', 'image/png', ''];
  assert.deepEqual(host.webviewFiles(files).map(file => file.mime), types);
  for (let i = 0; i < files.length; i++) {
    const attachment = host.attachmentMetadata(files[i]);
    assert.equal(attachment.mime, types[i]);
    assert.equal(attachment.name, names[i]);
    assert.equal(attachment.size, 4);
    assert.equal(attachment.uri, `preview:${files[i]}`);
  }
  assert.equal(host.attachmentMetadata(files[0], 'application/octet-stream').mime, types[0]);
  assert.equal(host.attachmentMetadata(files[1], 'application/octet-stream').mime, types[1]);
  assert.equal(host.attachmentMetadata(files[3], 'text/plain').mime, 'text/plain');
});
