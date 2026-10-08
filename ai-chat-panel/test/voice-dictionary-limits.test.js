'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dictionary = require('../lib/voice-dictionary');

const withDictionary = async (run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-dictionary-'));
  try { await run({ dictionaryFile: path.join(dir, 'words.json') }, path.join(dir, 'missing.db')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const termsOf = (paths) => dictionary.listTerms(paths).map((entry) => entry.term);

test('words can be renamed, switched off and deleted', () => withDictionary((paths) => {
  dictionary.addTerm(paths, 'Tecnomatix');
  dictionary.addTerm(paths, 'SimTalk');
  dictionary.updateTerm(paths, 'simtalk', { next: 'SimTalk 2.0' });
  dictionary.updateTerm(paths, 'Tecnomatix', { enabled: false });
  assert.deepEqual(dictionary.listEnabledTerms(paths), ['SimTalk 2.0']);
  assert.throws(() => dictionary.updateTerm(paths, 'SimTalk 2.0', { next: 'tecnomatix' }), /already in the dictionary/);
  assert.throws(() => dictionary.updateTerm(paths, 'missing', { next: 'x' }), /no longer/);
  dictionary.removeTerm(paths, 'Tecnomatix');
  assert.deepEqual(termsOf(paths), ['SimTalk 2.0']);
}));

test('a hand-edited or AI-edited file is read forgivingly', () => withDictionary((paths) => {
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ terms: ['Astro', { term: 'astro' }, { term: '' }, { term: 'x'.repeat(61) }, { term: 'Visor', enabled: false }, null, 7] }));
  assert.deepEqual(dictionary.listTerms(paths).map((entry) => [entry.term, entry.enabled]), [['Astro', true], ['Visor', false]]);
  fs.writeFileSync(paths.dictionaryFile, '{ not json');
  assert.deepEqual(dictionary.listTerms(paths), [], 'a broken file never blocks dictation');
}));

test('scanned words stay inside the batch, scanned-share and total limits, and deleted ones do not come back', () => withDictionary((paths) => {
  const { LIMITS } = dictionary;
  const many = Array.from({ length: 200 }, (_, index) => `Word${index}x`);
  const first = dictionary.addScanned(paths, many, 'Demo');
  assert.equal(first.added, LIMITS.scanBatch);
  assert.equal(first.full, true);
  assert.equal(dictionary.addScanned(paths, many, 'Demo').added, LIMITS.scanBatch, 'a second scan adds the next batch, never the same words');
  assert.equal(dictionary.addScanned(paths, many, 'Demo').added, LIMITS.scanned - 2 * LIMITS.scanBatch);
  assert.equal(dictionary.addScanned(paths, many, 'Demo').added, 0, 'the scanned share is full');
  dictionary.addTerm(paths, 'Hand picked');
  dictionary.removeTerm(paths, 'Word0x');
  assert.equal(dictionary.removeScanned(paths), LIMITS.scanned - 1);
  assert.deepEqual(dictionary.listEnabledTerms(paths), ['Hand picked']);
  assert.equal(dictionary.addScanned(paths, ['Word0x'], 'Demo').added, 0, 'a deleted scanned word is not re-added');
}));

test('the dictionary refuses to grow past its limit', () => withDictionary((paths) => {
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ terms: Array.from({ length: dictionary.LIMITS.entries }, (_, index) => `term${index}`) }));
  assert.throws(() => dictionary.addTerm(paths, 'one more'), /full/);
  assert.equal(dictionary.addScanned(paths, ['Another'], 'Demo').added, 0);
}));

test('what reaches the models is capped and puts hand-picked words before scanned ones', () => withDictionary(async (paths, noDatabase) => {
  dictionary.addScanned(paths, Array.from({ length: 50 }, (_, index) => `Scanned${index}`), 'Demo');
  dictionary.addTerm(paths, 'Mine');
  const words = await dictionary.vocabulary(paths, noDatabase);
  assert.equal(words[0], 'Mine');
  const prompt = dictionary.promptTerms(words);
  assert.ok(prompt.length <= dictionary.LIMITS.promptTerms);
  assert.ok(prompt.join(', ').length <= dictionary.LIMITS.promptChars);
  assert.deepEqual(dictionary.promptTerms(['a'.repeat(500), 'b']), [], 'a long term cannot push the prompt past its budget');
  const usage = await dictionary.usage(paths, noDatabase);
  assert.equal(usage.inPrompt, prompt.length);
  assert.equal(usage.total, 51);
}));
