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
  const many = Array.from({ length: LIMITS.scanned + 200 }, (_, index) => `Word${index}x`);
  const first = dictionary.addScanned(paths, many, 'Demo');
  assert.equal(first.added, LIMITS.scanBatch);
  assert.equal(first.full, true);
  assert.equal(dictionary.addScanned(paths, many, 'Demo').added, LIMITS.scanBatch, 'a second scan adds the next batch, never the same words');
  let total = 2 * LIMITS.scanBatch;
  for (let added; (added = dictionary.addScanned(paths, many, 'Demo').added); ) total += added;
  assert.equal(total, LIMITS.scanned, 'scans stop at the scanned share');
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

test('the dictionary keeps well over a thousand words', () => withDictionary((paths) => {
  assert.ok(dictionary.LIMITS.entries >= 5000);
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ terms: Array.from({ length: 1500 }, (_, index) => `term${index}`) }));
  dictionary.addTerm(paths, 'ChatGPT');
  assert.equal(dictionary.listTerms(paths).length, 1501);
  assert.equal(dictionary.usage(paths).total, 1501);
}));

test('the words sent to the models are ranked per recording and capped', () => withDictionary(async (paths, noDatabase) => {
  dictionary.addScanned(paths, Array.from({ length: 50 }, (_, index) => `Scanned${index}`), 'Demo');
  dictionary.addTerm(paths, 'Mine');
  const words = await dictionary.vocabulary(paths, noDatabase);
  assert.equal(words[0], 'Mine', 'a word someone chose beats scanned words nobody has used');
  const prompt = dictionary.promptTerms(words);
  assert.ok(prompt.length <= dictionary.LIMITS.promptTerms);
  assert.ok(prompt.join(', ').length <= dictionary.LIMITS.promptChars);
  assert.deepEqual(dictionary.promptTerms(['a'.repeat(500), 'b']), [], 'a long term cannot push the prompt past its budget');
  assert.deepEqual(Object.keys(await dictionary.usage(paths)).sort(), ['enabled', 'limits', 'scanned', 'total'], 'nothing about the selection is exposed');
  assert.equal(dictionary.usage(paths).total, 51);
}));

test('recent and project words win, and unused words take turns', () => withDictionary(async (paths, noDatabase) => {
  const now = Date.UTC(2026, 9, 13);
  const day = 86400000;
  const entry = (term, extra = {}) => ({ term, enabled: true, addedAt: now - 400 * day, ...extra });
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ terms: [
    ...Array.from({ length: 300 }, (_, index) => entry(`Idle${index}`)),
    entry('ChatGPT', { uses: 9, lastUsedAt: now - 2 * day, usedIn: { other: 9 } }),
    entry('Tecnomatix', { uses: 4, lastUsedAt: now - 20 * day, usedIn: { plant: 4 } }),
    entry('Ancient', { uses: 1, lastUsedAt: now - 365 * day }),
    entry('VisorBridge', { source: 'scan', project: 'Visor' }),
  ] }));
  const rank = (context) => dictionary.vocabulary(paths, noDatabase, { now, random: () => 0, ...context });
  const elsewhere = await rank({ projectId: 'none' });
  assert.equal(elsewhere[0], 'ChatGPT', 'a word used two days ago leads');
  assert.ok(elsewhere.indexOf('Ancient') > elsewhere.indexOf('Tecnomatix'), 'a word untouched for a year falls behind');
  const plant = await rank({ projectId: 'plant', projectName: 'Plant' });
  assert.ok(plant.indexOf('Tecnomatix') < plant.indexOf('Ancient') && plant.indexOf('Tecnomatix') < 3, 'the project own words rise');
  const visor = await rank({ projectId: 'v', projectName: 'visor' });
  assert.ok(visor.indexOf('VisorBridge') < 5, 'a scanned word rises in the project it came from');
  assert.ok(elsewhere.indexOf('VisorBridge') > 5, 'and stays low elsewhere');
  // Words with no history rotate: over many recordings most idle words get a turn in the prompt-sized head.
  const seen = new Set();
  for (let recording = 0; recording < 60; recording++) for (const term of (await dictionary.vocabulary(paths, noDatabase, { now })).slice(0, dictionary.LIMITS.promptTerms)) seen.add(term);
  assert.ok(seen.size > 200, `idle words take turns (saw ${seen.size})`);
  assert.ok((await dictionary.vocabulary(paths, noDatabase, { now })).slice(0, 3).includes('ChatGPT'), 'a recently used word keeps its place');
}));

test('dictated and sent words are remembered per project', () => withDictionary((paths) => {
  dictionary.addTerm(paths, 'ChatGPT');
  dictionary.addTerm(paths, 'SimTalk 2.0');
  dictionary.addTerm(paths, 'Off', {});
  dictionary.updateTerm(paths, 'Off', { enabled: false });
  assert.equal(dictionary.recordUse(paths, 'Ask chatgpt, then run the simtalk 2.0 method. Off. Nothing else', { projectId: 'p1', now: 1000 }), 2);
  assert.equal(dictionary.recordUse(paths, 'Ask ChatGPT again.', { projectId: 'p2', now: 2000 }), 1);
  assert.equal(dictionary.recordUse(paths, 'Nothing to see in ChatGPTs or pre-ChatGPT-ish text', { now: 3000 }), 0, 'only whole words count');
  const [chat, sim, off] = dictionary.listTerms(paths);
  assert.deepEqual([chat.uses, chat.lastUsedAt, chat.usedIn], [2, 2000, { p1: 1, p2: 1 }]);
  assert.deepEqual([sim.uses, sim.usedIn], [1, { p1: 1 }]);
  assert.equal(off.uses, undefined, 'a switched-off word is not tracked');
  assert.equal(dictionary.mentionedTerms([{ term: 'code-review' }, { term: 'Node.js' }], 'run Code-Review on node.js.').length, 2);
}));
