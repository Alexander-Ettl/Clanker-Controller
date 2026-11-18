import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Settings > Voice > Dictionary in a real browser with the real settings.js and stylesheets: search, add, rename, switch,
// delete, scan and "Edit with AI" send the right messages, and the list copes with a narrow window and a full dictionary.
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const read = (file) => fs.readFileSync(path.join(media, file), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>${['style.css', 'launcher.css', 'settings.css'].map(read).join('\n')}</style>
<body style="margin:0;padding:12px;width:340px"><div class="fs-modal" style="position:static;display:block"><div class="fs-modal-sheet glass"><div class="fs-modal-body" id="csBody"></div></div></div>
<script>window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (message) => window.sent.push(message) });</script>
<script>${read('agent-icons.js')}</script><script>${read('model-prompts.js')}</script><script>${read('voice-hotkey.js')}</script><script>${read('settings.js')}</script>
<script>window.api = window.initChatSettings({ vscode: window.acquireVsCodeApi(), body: document.getElementById('csBody') }); window.api.showTab('voice');</script>`;
const limits = { entries: 5000, scanned: 1500, perScan: 80, promptTerms: 40, promptChars: 480, cleanupTerms: 150 };
const word = (term, extra = {}) => ({ term, enabled: true, addedAt: 1, ...extra });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 364, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(html);
  const sent = (type) => page.evaluate((type) => window.sent.filter((message) => message.type === type), type);
  const lastSent = async (type) => (await sent(type)).at(-1);
  const deliver = (entries, extra = {}) => page.evaluate(([entries, extra, limits]) => window.api.voiceDictionary({ entries, usage: { total: entries.length, enabled: entries.filter((e) => e.enabled).length, scanned: 0, limits: { entries: limits.entries } }, ...extra }), [entries, extra, limits]);
  const rows = () => page.locator('.cs-dict-row .cs-dict-term, .cs-dict-row .cs-dict-edit').count();

  assert.ok((await sent('requestVoiceDictionary')).length >= 1, 'opening the Voice tab asks for the dictionary');
  await deliver([]);
  assert.match(await page.locator('.cs-dict-empty').innerText(), /No words yet/);

  await deliver([word('SimTalk'), word('Tecnomatix', { enabled: false }), word('ChatWindowHost', { source: 'scan', project: 'Visor' })]);
  assert.equal(await rows(), 3);
  assert.equal(await page.locator('[data-role=dictTag]').innerText(), '3 words');
  assert.equal(await page.locator('.cs-dict .cs-usage').count(), 0, 'which words reach the models is not shown');
  assert.doesNotMatch(await page.locator('[data-role=dictionary]').innerText(), /Whisper|Sent to/);

  await page.fill('[data-role=dictSearch]', 'tec');
  assert.equal(await rows(), 1, 'search narrows the list');
  await page.fill('[data-role=dictSearch]', 'zzz');
  assert.match(await page.locator('.cs-dict-empty').innerText(), /No word matches/);
  await page.fill('[data-role=dictSearch]', '');

  await page.fill('[data-role=dictNew]', '  Liquid Glass ');
  await page.press('[data-role=dictNew]', 'Enter');
  assert.deepEqual(await lastSent('voiceDictionaryAdd'), { type: 'voiceDictionaryAdd', term: 'Liquid Glass', projectId: '' });
  assert.equal(await page.inputValue('[data-role=dictNew]'), '');
  await page.click('[data-role=dictAdd]');
  assert.match(await page.locator('[data-role=dictStatus]').innerText(), /Type a word/);

  await page.locator('.cs-dict-row', { hasText: 'SimTalk' }).locator('button[aria-label^=Rename]').click();
  await page.fill('.cs-dict-edit', 'SimTalk 2');
  await page.press('.cs-dict-edit', 'Enter');
  assert.deepEqual(await lastSent('voiceDictionaryEdit'), { type: 'voiceDictionaryEdit', term: 'SimTalk', projectId: '', next: 'SimTalk 2' });
  await page.locator('.cs-dict-row', { hasText: 'Tecnomatix' }).locator('.cs-switch').click();
  assert.deepEqual(await lastSent('voiceDictionaryEdit'), { type: 'voiceDictionaryEdit', term: 'Tecnomatix', projectId: '', enabled: true });
  await page.locator('.cs-dict-row', { hasText: 'ChatWindowHost' }).locator('button[aria-label^=Delete]').click();
  assert.deepEqual(await lastSent('voiceDictionaryRemove'), { type: 'voiceDictionaryRemove', term: 'ChatWindowHost', projectId: '' });

  // Scanning: one button for every project, plus one per project that has a folder.
  await page.evaluate(() => window.api.projectIcons([{ id: 'p1', name: 'Visor', root: 'C:/p/visor' }, { id: 'p2', name: 'No folder', root: '' }]));
  assert.deepEqual(await page.locator('[data-role=dictProjects] button').allInnerTexts(), ['Visor']);
  assert.equal(await page.locator('[data-role=dictScanAll]').innerText(), 'Scan all projects');
  await page.click('[data-role=dictProjects] button >> text=Visor');
  assert.deepEqual(await lastSent('voiceDictionaryScan'), { type: 'voiceDictionaryScan', id: 'p1' });
  assert.equal(await page.locator('[data-role=dictProjects] button').first().isDisabled(), true, 'one scan at a time');
  assert.equal(await page.locator('[data-role=dictScanAll]').isDisabled(), true, 'also for the scan-all button');
  await deliver([word('SimTalk')], { scanning: false, notice: 'Visor: added 12.' });
  assert.equal(await page.locator('[data-role=dictProjects] button').first().isDisabled(), false);
  assert.equal(await page.locator('[data-role=dictStatus]').innerText(), 'Visor: added 12.');
  await deliver([word('SimTalk')], { error: 'The dictionary is full.' });
  assert.match(await page.locator('[data-role=dictStatus]').getAttribute('class'), /is-error/);

  await page.click('[data-role=dictScanAll]');
  assert.deepEqual(await lastSent('voiceDictionaryScan'), { type: 'voiceDictionaryScan', all: true });
  assert.equal(await page.locator('[data-role=dictScanAll]').isDisabled(), true);
  await deliver([word('SimTalk')], { scanning: true, progress: 'Scanning Visor (1 of 2)…' });
  assert.equal(await page.locator('[data-role=dictStatus]').innerText(), 'Scanning Visor (1 of 2)…');
  await deliver([word('VisorBridge', { source: 'scan', projectId: 'p1' })], { scanning: false, notice: 'Scanned 1 project: added 12 words, refreshed 0. 1 had no folder.', report: [
    { name: 'Visor', status: 'ok', added: 12, updated: 3, removed: 1 }, { name: 'No folder', status: 'no-folder' }] });
  assert.deepEqual(await page.locator('.cs-dict-report-row').allInnerTexts(), ['Visor\n12 new · 3 refreshed · 1 dropped', 'No folder\nno folder']);
  assert.equal(await page.locator('[data-role=dictScanAll]').isDisabled(), false);

  // Each project has its own list; the shared words are a list of their own.
  const projects = [{ id: 'p1', name: 'Visor', hasFolder: true }, { id: 'p2', name: 'Plant Sim', hasFolder: true }];
  const mixed = [word('Tecnomatix', { projectId: 'p2' }), word('VisorBridge', { projectId: 'p1', source: 'scan', project: 'Visor' }), word('ChatGPT'), word('Astro', { projectId: 'p1' })];
  const usage = { total: 4, enabled: 4, scanned: 1, shared: 1, byProject: { p1: 2, p2: 1 }, limits: { entries: 5000 } };
  await page.setContent(html); // a fresh window: it opens on the project in front
  await page.evaluate(([mixed, projects, usage]) => window.api.voiceDictionary({ entries: mixed, usage, projects, current: 'p1' }), [mixed, projects, usage]);
  assert.equal(await page.locator('[data-role=dictScope]').inputValue(), 'p1', 'opens on the project you are working in');
  assert.deepEqual(await page.locator('[data-role=dictScope] option').allInnerTexts(), ['All words (4)', 'Shared by every project (1)', 'Visor (2)', 'Plant Sim (1)']);
  assert.deepEqual(await page.locator('.cs-dict-term').allInnerTexts(), ['VisorBridge', 'Astro'], 'only that project’s words');
  assert.equal(await page.locator('[data-role=dictTag]').innerText(), '2 words');
  assert.equal(await page.locator('[data-role=dictNew]').getAttribute('placeholder'), 'Add a word for Visor…');
  await page.fill('[data-role=dictNew]', 'Kinetic');
  await page.press('[data-role=dictNew]', 'Enter');
  assert.deepEqual(await lastSent('voiceDictionaryAdd'), { type: 'voiceDictionaryAdd', term: 'Kinetic', projectId: 'p1' }, 'a new word goes to the dictionary on show');
  await page.locator('.cs-dict-row', { hasText: 'Astro' }).locator('button[aria-label^="Share with every project"]').click();
  assert.deepEqual(await lastSent('voiceDictionaryMove'), { type: 'voiceDictionaryMove', term: 'Astro', projectId: 'p1', to: '' });
  await page.selectOption('[data-role=dictScope]', '');
  assert.deepEqual(await page.locator('.cs-dict-term').allInnerTexts(), ['ChatGPT']);
  assert.equal(await page.locator('[data-role=dictNew]').getAttribute('placeholder'), 'Add a shared word or name…');
  await page.locator('.cs-dict-row', { hasText: 'ChatGPT' }).locator('button[aria-label^="Use only in Visor"]').click();
  assert.deepEqual(await lastSent('voiceDictionaryMove'), { type: 'voiceDictionaryMove', term: 'ChatGPT', projectId: '', to: 'p1' });
  await page.selectOption('[data-role=dictScope]', '*');
  assert.equal(await page.locator('.cs-dict-term').count(), 4);
  assert.deepEqual(await page.locator('.cs-dict-row', { hasText: 'Tecnomatix' }).locator('.cs-dict-source').allInnerTexts(), ['Plant Sim']);
  assert.deepEqual(await page.locator('.cs-dict-row', { hasText: 'ChatGPT' }).locator('.cs-dict-source').allInnerTexts(), ['Shared']);
  await page.locator('.cs-dict-row', { hasText: 'Tecnomatix' }).locator('button[aria-label^=Delete]').click();
  assert.deepEqual(await lastSent('voiceDictionaryRemove'), { type: 'voiceDictionaryRemove', term: 'Tecnomatix', projectId: 'p2' }, 'a delete names the dictionary the word lives in');
  await page.selectOption('[data-role=dictScope]', 'p1');
  await page.click('[data-role=dictClearScanned]');
  assert.deepEqual(await lastSent('voiceDictionaryClearScanned'), { type: 'voiceDictionaryClearScanned', projectId: 'p1' });
  await page.selectOption('[data-role=dictScope]', '*');

  // Suggestions are offered, never applied on their own.
  assert.equal(await page.locator('[data-role=dictSuggest]').isHidden(), true);
  await page.evaluate(([mixed, projects, usage]) => window.api.voiceDictionary({ entries: mixed, usage, projects, current: 'p1', suggestions: { share: [{ term: 'Tecnomatix', projectId: 'p2', projects: 2 }], add: [{ term: 'NeuronLedger', projectId: 'p1', count: 4 }] } }), [mixed, projects, usage]);
  assert.equal(await page.locator('.cs-dict-hint').count(), 2);
  assert.match(await page.locator('.cs-dict-hint').first().innerText(), /Tecnomatix was used in 2 projects/);
  assert.match(await page.locator('.cs-dict-hint').nth(1).innerText(), /NeuronLedger came up in 4 of your messages in Visor/);
  await page.getByRole('button', { name: 'Share Tecnomatix', exact: true }).click();
  assert.deepEqual(await lastSent('voiceDictionarySuggestion'), { type: 'voiceDictionarySuggestion', kind: 'share', term: 'Tecnomatix', projectId: 'p2', accept: true });
  await page.getByRole('button', { name: 'Dismiss NeuronLedger', exact: true }).click();
  assert.deepEqual(await lastSent('voiceDictionarySuggestion'), { type: 'voiceDictionarySuggestion', kind: 'add', term: 'NeuronLedger', projectId: 'p1', accept: false });
  await page.locator('[data-role=dictionary]').screenshot({ path: path.join(os.tmpdir(), 'clanker-dictionary-projects.png') });
  await page.evaluate(([mixed, projects, usage]) => window.api.voiceDictionary({ entries: mixed, usage, projects, current: 'p1', suggestions: { share: [], add: [] } }), [mixed, projects, usage]);
  await page.selectOption('[data-role=dictScope]', '*');

  await page.click('[data-role=dictAI]');
  assert.ok(await lastSent('voiceDictionaryWithAI'));
  await deliver([word('A', { source: 'scan' }), word('B', { source: 'scan' })]);
  assert.equal(await page.locator('[data-role=dictClearScanned]').innerText(), 'Remove 2 scanned words');
  await page.click('[data-role=dictClearScanned]');
  assert.deepEqual(await lastSent('voiceDictionaryClearScanned'), { type: 'voiceDictionaryClearScanned' }, 'all words: every project’s scanned words');

  // A long dictionary: only the first rows are drawn, search reaches the rest, and nothing overflows the narrow window.
  await deliver(Array.from({ length: 1800 }, (_, index) => word(`Term${index}`, { source: index % 2 ? 'scan' : undefined })));
  assert.equal(await page.locator('[data-role=dictTag]').innerText(), '1,800 words');
  assert.doesNotMatch(await page.locator('[data-role=dictTag]').getAttribute('class'), /is-warn/);
  assert.equal(await rows(), 300, 'a long list draws a bounded number of rows');
  assert.match(await page.locator('.cs-dict-list .cs-dict-empty').innerText(), /1,500 more/);
  await page.fill('[data-role=dictSearch]', 'Term1799');
  assert.equal(await rows(), 1, 'search reaches words beyond the drawn rows');
  await page.fill('[data-role=dictSearch]', '');
  await deliver(Array.from({ length: 4800 }, (_, index) => word(`Term${index}`)));
  assert.match(await page.locator('[data-role=dictTag]').getAttribute('class'), /is-warn/);
  assert.equal(await page.locator('[data-role=dictTag]').innerText(), '4,800 / 5,000');
  await deliver(Array.from({ length: 1800 }, (_, index) => word(`Term${index}`, { source: index % 2 ? 'scan' : undefined })));
  assert.equal(await page.locator('.cs-dict-list').evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 270), true);
  await page.locator('[data-role=dictionary]').screenshot({ path: path.join(os.tmpdir(), 'clanker-dictionary-settings.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 364px');
  // The shared project list stays editable only after expanding its compact General card.
  await page.evaluate(() => {
    window.api.showTab('general');
    window.api.projectIcons([
      { id: 'p1', name: 'Visor', root: 'C:/p/visor', icon: 'favicon.svg' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 2}`, name: `Long project name ${i}`, root: '' })),
    ]);
  });
  const panel = page.locator('.cs-project-icons');
  assert.equal(await panel.evaluate(el => el.open), false);
  await panel.locator('summary').focus();
  await page.keyboard.press('Enter');
  for (const [label, type] of [['Choose', 'pickProjectIcon'], ['Detect', 'detectProjectIcon'], ['Ask AI', 'projectIconWithAI'], ['Clear', 'clearProjectIcon']]) {
    await page.getByRole('button', { name: `${label} icon for Visor`, exact: true }).click();
    assert.deepEqual(await lastSent(type), { type, id: 'p1' });
  }
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(await panel.locator('.cs-project-list').evaluate(el => el.scrollHeight > el.clientHeight && el.clientHeight <= 290), true);
  const clear = page.getByRole('button', { name: 'Clear icon for Visor', exact: true });
  await clear.scrollIntoViewIfNeeded();
  assert.equal(await clear.evaluate(el => { const a = el.getBoundingClientRect(), b = el.closest('.cs-project-list').getBoundingClientRect(); return a.left >= b.left && a.right <= b.right; }), true, 'all actions fit at 320px');
  await page.getByRole('button', { name: 'Choose icon for Long project name 7', exact: true }).click();
  assert.deepEqual(await lastSent('pickProjectIcon'), { type: 'pickProjectIcon', id: 'p9' });
  await page.evaluate(() => window.api.projectIcons([]));
  assert.equal(await panel.evaluate(el => el.open), true, 'updates preserve expansion');
  assert.match(await panel.locator('.cs-project-empty').innerText(), /Add a project/);
  await panel.locator('summary').focus();
  await page.keyboard.press('Space');
  assert.equal(await panel.evaluate(el => el.open), false);
  assert.deepEqual(errors, []);
  console.log('Settings dictionary: per-project lists, sharing, suggestions, scan all, search, add, rename, switch, delete, AI and limits passed.');
} finally { await browser.close(); }
