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

test('a scan stays inside its per-scan, per-project and total limits, and deleted words do not come back', () => withDictionary((paths) => {
  const { LIMITS } = dictionary;
  const many = Array.from({ length: LIMITS.scannedPerProject + 200 }, (_, index) => ({ term: `Word${index}x`, weight: 3 - index / 1000 }));
  const first = dictionary.applyScan(paths, 'p1', many, { projectName: 'Demo' });
  assert.equal(first.added, LIMITS.perScan);
  assert.equal(first.full, true);
  assert.equal(dictionary.applyScan(paths, 'p1', many.slice(0, LIMITS.perScan), { projectName: 'Demo' }).added, 0, 'a rescan finds the same words and adds none twice');
  assert.equal(dictionary.applyScan(paths, 'p1', many, { projectName: 'Demo' }).added, LIMITS.scannedPerProject - LIMITS.perScan, 'a project holds at most its own share of scanned words');
  assert.equal(dictionary.applyScan(paths, 'p1', many, { projectName: 'Demo' }).added, 0, 'and then no more');
  assert.equal(dictionary.listTerms(paths).length, LIMITS.scannedPerProject);
  dictionary.addTerm(paths, 'Hand picked', { projectId: 'p1' });
  dictionary.removeTerm(paths, 'Word0x', { projectId: 'p1' });
  assert.equal(dictionary.applyScan(paths, 'p1', many, { projectName: 'Demo' }).added, 1, 'the freed place goes to the next best word, not the deleted one');
  assert.ok(!dictionary.listEnabledTerms(paths, 'p1').includes('Word0x'), 'a deleted scanned word is not re-added');
  assert.equal(dictionary.removeScanned(paths, { projectId: 'p2' }), 0, 'another project is left alone');
  assert.equal(dictionary.removeScanned(paths, { projectId: 'p1' }), LIMITS.scannedPerProject);
  assert.deepEqual(dictionary.listEnabledTerms(paths, 'p1'), ['Hand picked']);
}));

test('the dictionary refuses to grow past its limit', () => withDictionary((paths) => {
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ terms: Array.from({ length: dictionary.LIMITS.entries }, (_, index) => `term${index}`) }));
  assert.throws(() => dictionary.addTerm(paths, 'one more'), /full/);
  assert.equal(dictionary.applyScan(paths, 'p1', [{ term: 'Another' }]).added, 0);
}));

test('the dictionary keeps well over a thousand words', () => withDictionary((paths) => {
  assert.ok(dictionary.LIMITS.entries >= 5000);
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ terms: Array.from({ length: 1500 }, (_, index) => `term${index}`) }));
  dictionary.addTerm(paths, 'ChatGPT');
  assert.equal(dictionary.listTerms(paths).length, 1501);
  assert.equal(dictionary.usage(paths).total, 1501);
}));

test('the words sent to the models are ranked per recording and capped', () => withDictionary(async (paths, noDatabase) => {
  dictionary.applyScan(paths, 'p1', Array.from({ length: 50 }, (_, index) => ({ term: `Scanned${index}`, weight: 2 })), { projectName: 'Demo' });
  dictionary.addTerm(paths, 'Mine', { projectId: 'p1' });
  const words = await dictionary.vocabulary(paths, noDatabase, { projectId: 'p1' });
  assert.equal(words[0], 'Mine', 'a word someone chose beats scanned words nobody has used');
  const prompt = dictionary.promptTerms(words);
  assert.ok(prompt.length <= dictionary.LIMITS.promptTerms);
  assert.ok(prompt.join(', ').length <= dictionary.LIMITS.promptChars);
  assert.deepEqual(dictionary.promptTerms(['a'.repeat(500), 'b']), [], 'a long term cannot push the prompt past its budget');
  assert.deepEqual(Object.keys(await dictionary.usage(paths)).sort(), ['byProject', 'enabled', 'limits', 'scanned', 'shared', 'total'], 'nothing about the selection is exposed');
  assert.equal(dictionary.usage(paths).total, 51);
}));

test('recent and used words win, and the order is the same every time', () => withDictionary(async (paths, noDatabase) => {
  const now = Date.UTC(2026, 9, 13);
  const day = 86400000;
  const entry = (term, extra = {}) => ({ term, enabled: true, addedAt: now - 400 * day, ...extra });
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ version: 2, terms: [
    ...Array.from({ length: 300 }, (_, index) => entry(`Idle${index}`, { projectId: 'plant', source: 'scan', weight: 0.6 })),
    entry('ChatGPT', { uses: 9, lastUsedAt: now - 2 * day, usedIn: { plant: 9, other: 9 } }),
    entry('Tecnomatix', { projectId: 'plant', uses: 4, lastUsedAt: now - 20 * day, usedIn: { plant: 4 } }),
    entry('Ancient', { projectId: 'plant', uses: 1, lastUsedAt: now - 365 * day }),
    entry('PlantBridge', { projectId: 'plant', source: 'scan', weight: 3 }),
    entry('VisorBridge', { projectId: 'visor', source: 'scan', weight: 3 }),
  ] }));
  const rank = (context) => dictionary.vocabulary(paths, noDatabase, { now, ...context });
  const plant = await rank({ projectId: 'plant' });
  assert.equal(plant[0], 'ChatGPT', 'a word used two days ago leads');
  assert.ok(plant.indexOf('Tecnomatix') < plant.indexOf('Ancient'), 'a word untouched for a year falls behind');
  assert.ok(plant.indexOf('PlantBridge') < plant.indexOf('Idle0'), 'a heavier scan word beats a lighter one');
  assert.ok(!plant.includes('VisorBridge'), 'another project own words never appear');
  assert.deepEqual(await rank({ projectId: 'plant' }), plant, 'no randomness: the same input gives the same list');
  assert.deepEqual(await rank({ projectId: 'plant' }), await rank({ projectId: 'plant' }));
  assert.deepEqual(await rank({}), ['ChatGPT'], 'with no project only shared words are offered');
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
