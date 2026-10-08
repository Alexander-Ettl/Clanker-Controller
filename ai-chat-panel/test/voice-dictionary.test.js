'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addTerm, listEnabledTerms, vocabulary } = require('../lib/voice-dictionary');

test('accepting a casing correction updates the saved spelling without creating a duplicate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-dictionary-'));
  const paths = { dictionaryFile: path.join(dir, 'words.json') };
  try {
    addTerm(paths, 'simtalk');
    addTerm(paths, 'SimTalk');
    assert.deepEqual(listEnabledTerms(paths), ['simtalk'], 'ordinary duplicate additions preserve spelling');
    addTerm(paths, 'SimTalk', { replaceSpelling: true });
    assert.deepEqual(listEnabledTerms(paths), ['SimTalk']);
    assert.deepEqual(await vocabulary(paths, path.join(dir, 'missing.db')), ['SimTalk'], 'next recording uses the accepted spelling');
    assert.equal(JSON.parse(fs.readFileSync(paths.dictionaryFile, 'utf8')).terms.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dictionary write failures reach the caller', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-dictionary-'));
  try {
    const blocked = path.join(dir, 'blocked');
    fs.mkdirSync(blocked);
    assert.throws(() => addTerm({ dictionaryFile: blocked }, 'Tecnomatix'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
