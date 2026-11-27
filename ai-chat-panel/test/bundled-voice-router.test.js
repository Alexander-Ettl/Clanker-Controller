'use strict';

// Installed packages bundle voice-router/lib inside the extension (scripts/install-extension.mjs,
// scripts/package-marketplace.mjs), so its imports must resolve without the sibling ai-chat-panel/ folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', '..');

test('bundled voice-router/lib loads from the packaged extension layout', async () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-bundle-'));
  try {
    fs.cpSync(path.join(root, 'voice-router', 'lib'), path.join(ext, 'voice-router', 'lib'), { recursive: true });
    fs.cpSync(path.join(root, 'ai-chat-panel', 'lib'), path.join(ext, 'lib'), { recursive: true });
    const groq = await import(pathToFileURL(path.join(ext, 'voice-router', 'lib', 'groq-client.mjs')).href);
    assert.equal(typeof groq.transcribeAudio, 'function');
    const quota = await import(pathToFileURL(path.join(ext, 'voice-router', 'lib', 'quota-reader.mjs')).href);
    assert.equal(typeof quota.readQuotas, 'function');
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});
