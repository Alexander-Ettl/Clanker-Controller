'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dictionary = require('../lib/voice-dictionary');
const { scanProject, looksLikeTerm } = require('../lib/voice-scan');

const PROJECTS = [{ id: 'visor', name: 'Visor' }, { id: 'plant', name: 'Plant Sim' }, { id: 'site', name: 'Website' }];
const withDictionary = async (run, projects = PROJECTS) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-dictionary-'));
  try { await run({ dictionaryFile: path.join(dir, 'words.json'), projects: () => projects }, path.join(dir, 'missing.db'), dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const entry = (term, extra = {}) => ({ term, enabled: true, addedAt: 1, ...extra });
const read = (paths) => JSON.parse(fs.readFileSync(paths.dictionaryFile, 'utf8'));

test('an old single dictionary is split by project where the evidence is clear, and keeps working everywhere else', () => withDictionary((paths) => {
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ terms: [
    entry('VisorBridge', { source: 'scan', project: 'visor' }),
    entry('Orphan', { source: 'scan', project: 'Some folder nobody registered' }),
    entry('Tecnomatix', { uses: 5, usedIn: { plant: 5 } }),
    entry('ChatGPT', { uses: 8, usedIn: { plant: 4, visor: 4 } }),
    entry('Once', { uses: 1, usedIn: { plant: 1 } }),
    entry('Handpicked'),
  ], ignored: ['gone'] }));
  const byTerm = Object.fromEntries(dictionary.listTerms(paths).map((item) => [item.term, item.projectId || '']));
  assert.deepEqual(byTerm, { VisorBridge: 'visor', Orphan: '', Tecnomatix: 'plant', ChatGPT: '', Once: '', Handpicked: '' });
  assert.equal(read(paths).version, 2, 'the file is saved in the new shape');
  assert.ok(fs.existsSync(`${paths.dictionaryFile}.v1.bak`), 'the old file is kept once');
  assert.deepEqual(read(paths).ignored, ['gone']);
}));

test('a project is offered its own words and the shared ones, never another project\'s', () => withDictionary(async (paths, noDatabase) => {
  dictionary.addTerm(paths, 'Tecnomatix', { projectId: 'plant' });
  dictionary.addTerm(paths, 'Astro', { projectId: 'site' });
  dictionary.addTerm(paths, 'ChatGPT');
  assert.deepEqual((await dictionary.vocabulary(paths, noDatabase, { projectId: 'plant' })).sort(), ['ChatGPT', 'Tecnomatix']);
  assert.deepEqual((await dictionary.vocabulary(paths, noDatabase, { projectId: 'site' })).sort(), ['Astro', 'ChatGPT']);
  assert.deepEqual(await dictionary.vocabulary(paths, noDatabase, { projectId: 'visor' }), ['ChatGPT'], 'a project with no words still gets the shared ones');
  assert.deepEqual(dictionary.listEnabledTerms(paths, 'plant').sort(), ['ChatGPT', 'Tecnomatix']);
  dictionary.addTerm(paths, 'plantbridge', { projectId: 'plant' });
  dictionary.addTerm(paths, 'PlantBridge'); // the same word shared: the project's spelling wins and it is listed once
  const words = await dictionary.vocabulary(paths, noDatabase, { projectId: 'plant' });
  assert.equal(words.filter((word) => word.toLowerCase() === 'plantbridge').length, 1);
  assert.ok(words.includes('plantbridge'));
}));

test('shared words never take more than their share of the slots', () => withDictionary(async (paths, noDatabase) => {
  const now = Date.UTC(2026, 9, 13);
  fs.writeFileSync(paths.dictionaryFile, JSON.stringify({ version: 2, terms: [
    ...Array.from({ length: 60 }, (_, index) => entry(`Shared${index}`, { uses: 50, lastUsedAt: now, addedAt: 0 })), // heavily used everywhere
    ...Array.from({ length: 60 }, (_, index) => entry(`Own${index}`, { projectId: 'plant', source: 'scan', weight: 0.6, addedAt: 0 })),
  ] }));
  const words = await dictionary.vocabulary(paths, noDatabase, { projectId: 'plant', now });
  const head = words.slice(0, dictionary.LIMITS.promptTerms);
  const shared = head.filter((word) => word.startsWith('Shared')).length;
  assert.ok(shared <= Math.ceil(dictionary.LIMITS.sharedShare * dictionary.LIMITS.promptTerms), `shared words in the prompt: ${shared}`);
  assert.ok(shared >= 8, 'but strong shared words do take their share');
  assert.ok(head.filter((word) => word.startsWith('Own')).length >= 28, 'the project fills the rest');
  const alone = await dictionary.vocabulary({ ...paths, dictionaryFile: paths.dictionaryFile }, noDatabase, { projectId: 'empty', now });
  assert.equal(alone.length, 60, 'a project without words of its own still gets every shared word, in order');
}));

test('learning is per project: corrections and typed words go to the project, and use lifts them there', () => withDictionary(async (paths, noDatabase) => {
  dictionary.addTerm(paths, 'SimTalk', { projectId: 'plant', source: 'learned', replaceSpelling: true });
  assert.equal(dictionary.listTerms(paths)[0].projectId, 'plant');
  assert.deepEqual(await dictionary.vocabulary(paths, noDatabase, { projectId: 'visor' }), []);
  dictionary.addTerm(paths, 'Method', { projectId: 'plant' });
  assert.equal(dictionary.recordUse(paths, 'Run the simtalk method. SimTalk again, simtalk once more', { projectId: 'plant', now: 10 }), 2);
  const [sim] = dictionary.listTerms(paths);
  assert.deepEqual([sim.uses, sim.lastUsedAt], [1, 10], 'a word counts once per message however often it is said');
}));

test('a project word used in other projects is offered for sharing, and an unfamiliar term typed in several messages is offered for adding', () => withDictionary((paths) => {
  dictionary.addTerm(paths, 'Tecnomatix', { projectId: 'plant' });
  dictionary.addTerm(paths, 'Quiet', { projectId: 'plant' });
  dictionary.recordUse(paths, 'Tecnomatix model', { projectId: 'plant' });
  dictionary.recordUse(paths, 'Tecnomatix report', { projectId: 'site' });
  assert.deepEqual(dictionary.suggestions(paths).share, [], 'two uses are not a pattern yet');
  dictionary.recordUse(paths, 'More Tecnomatix', { projectId: 'site' });
  assert.deepEqual(dictionary.suggestions(paths).share, [{ term: 'Tecnomatix', projectId: 'plant', projects: 2 }]);
  assert.equal(dictionary.listTerms(paths).find((item) => item.term === 'Tecnomatix').uses, 1, 'a use elsewhere does not rank the word up in its own project');
  dictionary.acceptSuggestion(paths, 'share', 'Tecnomatix', 'plant');
  assert.equal(dictionary.listTerms(paths).find((item) => item.term === 'Tecnomatix').projectId, undefined, 'now shared');
  assert.deepEqual(dictionary.suggestions(paths).share, []);

  for (const text of ['Check the NeuronLedger', 'neuronLedger fails', 'NeuronLedger again NeuronLedger']) dictionary.recordUse(paths, text, { projectId: 'visor' });
  dictionary.recordUse(paths, 'Look at ```js\nconst CodeOnlyThing = HiddenHelperName;\n``` and C:/some/path/PathyThing.js https://x.io/LinkThing', { projectId: 'visor' });
  dictionary.recordUse(paths, 'x', { projectId: 'visor' });
  const found = dictionary.suggestions(paths).add;
  assert.deepEqual(found.map((item) => [item.term, item.projectId, item.count]), [['NeuronLedger', 'visor', 3]], 'counted once per message; pasted code, paths and links teach nothing');
  dictionary.dismissSuggestion(paths, 'add', 'NeuronLedger', 'visor');
  dictionary.recordUse(paths, 'NeuronLedger NeuronLedger', { projectId: 'visor' });
  assert.deepEqual(dictionary.suggestions(paths).add, [], 'a dismissed term stays dismissed');
  dictionary.recordUse(paths, 'WidgetFactory one', { projectId: 'plant' });
  dictionary.recordUse(paths, 'WidgetFactory two', { projectId: 'plant' });
  dictionary.recordUse(paths, 'WidgetFactory three', { projectId: 'plant' });
  dictionary.acceptSuggestion(paths, 'add', 'WidgetFactory', 'plant');
  assert.deepEqual(dictionary.suggestions(paths).add, []);
  assert.equal(dictionary.listTerms(paths).find((item) => item.term === 'WidgetFactory').projectId, 'plant');
}));

test('a rescan refreshes a project\'s scanned words and never touches the ones people chose', () => withDictionary((paths) => {
  const first = dictionary.applyScan(paths, 'plant', [{ term: 'Alpha', weight: 3 }, { term: 'Beta', weight: 2 }, { term: 'Gamma', weight: 1 }], { projectName: 'Plant Sim' });
  assert.deepEqual([first.added, first.removed], [3, 0]);
  dictionary.addTerm(paths, 'Beta', { projectId: 'plant' }); // now the user's word
  dictionary.recordUse(paths, 'Gamma works', { projectId: 'plant' });
  const second = dictionary.applyScan(paths, 'plant', [{ term: 'Alpha', weight: 1.5 }, { term: 'Delta', weight: 2 }], { projectName: 'Plant Sim' });
  assert.deepEqual([second.added, second.updated, second.removed, second.kept], [1, 1, 0, 1]);
  const words = Object.fromEntries(dictionary.listTerms(paths).map((item) => [item.term, item]));
  assert.equal(words.Alpha.weight, 1.5, 'a word the scan still finds is re-weighted');
  assert.ok(words.Gamma, 'a stale word that was used stays');
  assert.equal(words.Beta.source, undefined, 'a word the user chose is theirs');
  assert.ok(words.Delta);
  dictionary.removeTerm(paths, 'Delta', { projectId: 'plant' });
  dictionary.applyScan(paths, 'plant', [{ term: 'Delta' }, { term: 'Epsilon' }]);
  assert.ok(!dictionary.listTerms(paths).some((item) => item.term === 'Delta'), 'a deleted scanned word stays gone for that project');
  assert.ok(!dictionary.listTerms(paths).some((item) => item.term === 'Alpha'), 'and a word the scan no longer finds is dropped');
  assert.throws(() => dictionary.applyScan(paths, '', []), /project/);
}));

test('words move between a project and the shared dictionary', () => withDictionary((paths) => {
  dictionary.addTerm(paths, 'Astro', { projectId: 'site' });
  dictionary.moveTerm(paths, 'Astro', { from: 'site', to: '' });
  assert.equal(dictionary.listTerms(paths)[0].projectId, undefined);
  dictionary.moveTerm(paths, 'Astro', { from: '', to: 'visor' });
  assert.equal(dictionary.listTerms(paths)[0].projectId, 'visor');
  dictionary.addTerm(paths, 'Astro');
  dictionary.moveTerm(paths, 'Astro', { from: 'visor', to: '' });
  assert.equal(dictionary.listTerms(paths).length, 1, 'moving onto an existing word merges them');
  assert.throws(() => dictionary.moveTerm(paths, 'Nothing', { from: 'visor', to: '' }), /no longer/);
}));

test('a scan ranks by how many files use a word and reads docs, glossaries, manifests and .gitignore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-scan-'));
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
  try {
    write('.gitignore', 'generated/\n*.log\n');
    write('generated/GeneratedThing.js', 'class GeneratedThing {}\nGeneratedThing; GeneratedThing;');
    write('Cargo.toml', '[package]\nname = "plantkit"\nversion = "0.1.0"\n');
    write('GLOSSARY.md', '# Glossary\n\n- **Tecnomatix** - the simulation suite\n- `SimTalk`: its scripting language\n');
    write('voice-router/index.js', 'const x = 1;');
    write('src/helpers/util.js', 'function createdAt() {}');
    for (let index = 0; index < 6; index++) write(`src/Spread${index}.js`, 'class SpreadWidget {}\nnew SpreadWidget();');
    write('src/Heavy.js', `class HeavyLocal {}\n${'HeavyLocal(); '.repeat(300)}`);
    write('docs/a.md', '# Dynamic Island Composer\n\nWe use the Dynamic Island for status. Speech goes through Whisper and Groq.\n');
    write('docs/b.md', 'The Dynamic Island shows progress. Then we ask Whisper to transcribe it, and sync with Nextcloud.\n');
    write('docs/c.md', 'Open the Dynamic Island. Dictation is powered by Whisper. Files sync via Nextcloud nightly.\n');
    write('docs/d.md', 'Our dictation uses Whisper, which is fast. Our storage uses Nextcloud, which is slow.\nBoth Whisper and Nextcloud matter.');
    write('docs/e.md', 'Dictation in Whisper and storage in Nextcloud. Plus more Whisper and Nextcloud.\n');
    const { terms, entries } = await scanProject(root, { name: 'Plant Sim' });
    assert.equal(terms[0], 'Plant Sim', 'the project name leads');
    for (const wanted of ['plantkit', 'Tecnomatix', 'SimTalk', 'voice-router', 'SpreadWidget', 'Dynamic Island', 'Dynamic Island Composer', 'Whisper', 'Nextcloud']) assert.ok(terms.includes(wanted), `${wanted} in ${terms}`);
    for (const unwanted of ['GeneratedThing', 'createdAt', 'Groq']) assert.ok(!terms.includes(unwanted), `${unwanted} not in ${terms}`);
    assert.ok(terms.indexOf('SpreadWidget') < terms.indexOf('HeavyLocal') || !terms.includes('HeavyLocal'), 'six files beat three hundred mentions in one');
    assert.ok(entries.every((item) => item.weight >= 0.6 && item.weight <= 3), 'weights stay in the scale the dictionary expects');
    assert.deepEqual((await scanProject(root, { name: 'Plant Sim' })).terms, terms, 'the same folder gives the same list');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only name-like tokens are learned from what people type', () => {
  for (const good of ['NeuronLedger', 'neuronLedger', 'GPT5', 'LLM', 'OpenAI']) assert.ok(looksLikeTerm(good), good);
  for (const bad of ['the', 'Hello', 'JSON', 'README', 'getElementById', 'hello-world', 'x', 'abc123def456ghi']) assert.ok(!looksLikeTerm(bad), bad);
});

test('scan all projects scans each folder in turn, reports per project, and survives a missing folder or a failure', () => withDictionary(async (paths, _db, dir) => {
  const { scanProjects } = require('../lib/voice-scan-projects');
  const folder = (name, files) => {
    const root = path.join(dir, name);
    for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
    return root;
  };
  const projects = [
    { id: 'visor', name: 'Visor', root: folder('visor', { 'src/ClankerBridge.js': 'class ClankerBridge {}\nnew ClankerBridge();', 'src/b.js': 'ClankerBridge;' }) },
    { id: 'plant', name: 'Plant Sim', root: folder('plant', { 'src/PlantModel.js': 'class PlantModel {}\nPlantModel;', 'src/b.js': 'PlantModel;' }) },
    { id: 'site', name: 'Website', root: path.join(dir, 'moved-away') },
    { id: 'plan', name: 'Planning', root: null },
  ];
  const progress = [];
  const first = await scanProjects(projects, { paths, onProgress: (text) => progress.push(text) });
  assert.deepEqual(progress, ['Scanning Visor (1 of 4)…', 'Scanning Plant Sim (2 of 4)…']);
  assert.deepEqual(first.report.map((item) => [item.name, item.status]), [['Visor', 'ok'], ['Plant Sim', 'ok'], ['Website', 'no-folder'], ['Planning', 'no-folder']]);
  assert.match(first.notice, /^Scanned 2 projects: added \d+ words, refreshed 0\. 2 had no folder\.$/);
  assert.equal(first.error, '');
  const visorWords = dictionary.listEnabledTerms(paths, 'visor');
  assert.ok(visorWords.includes('ClankerBridge') && visorWords.includes('Visor') && !visorWords.includes('PlantModel'), `each project gets its own words: ${visorWords}`);
  assert.ok(dictionary.listEnabledTerms(paths, 'plant').includes('PlantModel'));
  const again = await scanProjects(projects.slice(0, 2), { paths });
  assert.match(again.notice, /refreshed [1-9]/, 'a second scan refreshes instead of duplicating');
  assert.equal(dictionary.listTerms(paths).filter((item) => item.term === 'ClankerBridge').length, 1);
  const single = await scanProjects([projects[0]], { paths });
  assert.match(single.notice, /^Visor: read 2 files, added 0 words, refreshed \d+\.$/);
  const partial = await scanProjects([projects[0]], { paths, scan: async () => ({ entries: [], stats: { files: 0, truncated: true } }) });
  assert.equal(partial.report[0].removed, 0);
  assert.ok(dictionary.listEnabledTerms(paths, 'visor').includes('ClankerBridge'));
  assert.equal((await scanProjects([projects[2]], { paths })).error, 'That project has no folder to scan.');
  assert.equal((await scanProjects(projects.slice(2), { paths })).error, 'None of the projects has a folder to scan.');
  const broken = await scanProjects(projects.slice(0, 2), { paths, scan: async (root) => { if (root.endsWith('visor')) throw new Error('disk on fire'); return { entries: [{ term: 'Fine', weight: 2 }], stats: { files: 1, truncated: false } }; } });
  assert.deepEqual(broken.report.map((item) => item.status), ['error', 'ok'], 'one failure does not stop the others');
  assert.match(broken.notice, /1 could not be read/);
  assert.match((await scanProjects([projects[0]], { paths, scan: async () => { throw new Error('nope'); } })).error, /Could not scan Visor: nope/);
}));

test('voice scan applies the source read budget to manifests', () => withDictionary(async (_paths, _db, dir) => {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'OversizedManifest', description: 'x'.repeat(512) }));
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/AllowedManifest\n');
  const { terms, stats } = await scanProject(dir, { limits: { fileBytes: 128, totalBytes: 128 } });
  assert.ok(terms.includes('AllowedManifest'));
  assert.ok(!terms.includes('OversizedManifest'));
  assert.equal(stats.files, 1);
  assert.ok(stats.bytes <= 128);
}));
