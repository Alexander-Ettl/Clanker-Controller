'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanMarkup, writeMarkup, markupPrompt } = require('../lib/markup');
const { attachmentPrompt } = require('../lib/attachments');

test('markup validates input and dispatches region hints while preserving the source', () => {
  assert.equal(cleanMarkup({ width: Infinity, height: 20 }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-markup-'));
  try {
    const original = path.join(dir, 'source.png'), composite = path.join(dir, 'marked.png');
    fs.writeFileSync(original, 'original'); fs.writeFileSync(composite, 'composite');
    writeMarkup(composite, original, { width: 100, height: 100, items: [{ kind: 'pen', color: '#ff3b30', size: 4, points: [[10, 10], [20, 20]] }, { kind: 'invalid' }] });
    assert.match(markupPrompt(composite), /red pen marks around/);
    assert.match(attachmentPrompt('Fix here', [composite]), /look at those regions first/);
    assert.equal(fs.readFileSync(original, 'utf8'), 'original');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
