'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAnnotationTitle, readAgyTitle, readAgentTitle, hasAgentTitles } = require('../lib/agent-titles');

const ID = '0182f5ab-398b-4bc1-8130-d4859bb460e5';

test('an Antigravity annotation yields its title', () => {
  assert.equal(parseAnnotationTitle('title:"Fix API Value Hoverover Z-Index"\n'), 'Fix API Value Hoverover Z-Index');
  assert.equal(parseAnnotationTitle('title:"  Spaced \\"quoted\\"   name "'), 'Spaced "quoted" name');
  assert.equal(parseAnnotationTitle('other:1\ntitle: "Second line"'), 'Second line');
});

test('non-ASCII titles written as escaped UTF-8 bytes decode back', () => {
  // "Größe ändern" as protobuf text writes it
  assert.equal(parseAnnotationTitle('title:"Gr\\303\\266\\303\\237e \\303\\244ndern"'), 'Größe ändern');
  assert.equal(parseAnnotationTitle('title:"Gr\\xc3\\xb6\\xc3\\x9fe"'), 'Größe');
  assert.equal(parseAnnotationTitle('title:"Größe"'), 'Größe');
});

test('no title, an empty title or garbage give an empty string', () => {
  assert.equal(parseAnnotationTitle(''), '');
  assert.equal(parseAnnotationTitle(undefined), '');
  assert.equal(parseAnnotationTitle('subtitle:"x"'), '');
  assert.equal(parseAnnotationTitle('title:"   "'), '');
});

test('a long title is shortened', () => {
  assert.equal(parseAnnotationTitle(`title:"${'word '.repeat(40)}"`).length <= 80, true);
});

test('readAgyTitle reads <id>.pbtxt and ignores anything that is not a conversation id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-titles-'));
  try {
    fs.writeFileSync(path.join(dir, `${ID}.pbtxt`), 'title:"Role Boundary Test"');
    fs.writeFileSync(path.join(dir, 'secret.pbtxt'), 'title:"Should not be read"');
    assert.equal(await readAgyTitle(ID, { dir }), 'Role Boundary Test');
    assert.equal(await readAgyTitle('4e448a65-ee1c-4975-8698-1b998c135574', { dir }), ''); // no file yet
    assert.equal(await readAgyTitle('../secret', { dir }), '');
    assert.equal(await readAgyTitle('', { dir }), '');
    assert.equal(await readAgyTitle(undefined, { dir }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only Antigravity (gemini) chats have a readable agent title', async () => {
  assert.equal(hasAgentTitles('gemini'), true);
  assert.equal(hasAgentTitles('claude'), false);
  assert.equal(hasAgentTitles('codex'), false);
  assert.equal(hasAgentTitles('toString'), false);
  assert.equal(await readAgentTitle('claude', ID), '');
});
