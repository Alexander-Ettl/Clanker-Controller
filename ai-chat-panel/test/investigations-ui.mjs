// Drives Chat Settings > Loops in the real chat page (the same HTML the extension serves) against a fake host, and
// takes pictures of it at wide and narrow sizes. Run: node ai-chat-panel/test/investigations-ui.mjs
// It sends nothing to a real CLI or model: the "host" is a script in the page that answers investigation requests.
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
require('./model-fixture').seedModels();
const uri = file => ({ fsPath: file, toString: () => file });
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(String(base), ...parts)) }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
  return originalLoad.call(this, request, parent, isMain);
};
const { ChatWindowHost } = require('../extension');
Module._load = originalLoad;
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const origin = 'http://127.0.0.1';
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
host.panel.sidebar = true;
const sidebarHtml = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-loops-'));

import { installFakeHost } from './ui-tester/fake-host.mjs';

const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
const results = [];
try {
  async function open(width, stateName, sidebar = true) {
    const page = await browser.newPage({ viewport: { width, height: 2600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${origin}/**`, route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(media, '.' + pathname);
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: sidebar ? sidebarHtml : html });
      if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', body: fs.readFileSync(file) });
    });
    await page.addInitScript(installFakeHost);
    await page.goto(origin);
    await page.locator('#stopBtn').waitFor({ state: 'attached' });
    await page.evaluate(name => window.setFakeState(name), stateName);
    await page.locator('#loopsBtn').click();
    await page.locator('.inv .inv-overview').waitFor();
    return { page, errors };
  }
  const pane = page => page.locator('#loopsModal .inv');
  const sentRequests = page => page.evaluate(() => window.sent.filter(m => m.type === 'investigations'));
  const shot = async (page, name) => { await pane(page).screenshot({ path: path.join(shots, `${name}.png`) }); };
  const test = async (name, work) => { try { await work(); results.push(`ok   ${name}`); } catch (error) { results.push(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; } };

  await test('opening the sidebar popup asks for state and options; the rail subscribes at startup', async () => {
    const { page, errors } = await open(420, 'empty');
    const requests = await sentRequests(page);
    assert.deepEqual(requests.map(m => m.request.action).sort(), ['list', 'list', 'options']);
    assert.ok(requests.every(m => /^inv-/.test(m.requestId)));
    assert.equal(await page.getByRole('button', { name: 'New loop' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Stop all' }).count(), 0, 'no loops, so nothing to stop');
    assert.ok((await pane(page).innerText()).includes('No loops yet'));
    assert.deepEqual(errors, []);
    await shot(page, 'empty-wide'); await page.close();
  });

  await test('creating a diagnose loop validates ranges, then sends create and an explicit start', async () => {
    const { page } = await open(420, 'empty');
    await page.getByRole('button', { name: 'New loop' }).click();
    const form = page.locator('.inv-form');
    await form.waitFor();
    await form.getByRole('radio', { name: 'Diagnose only' }).click();
    await page.waitForTimeout(700);
    await shot(page, 'form-wide');
    assert.equal(await form.locator('select').count(), 0, 'no native select popups in the form');
    assert.equal(await form.locator('.cs-dd-trigger').first().innerText(), 'Clanker Controller');
    await form.locator('.cs-dd-trigger').first().click();
    await page.waitForTimeout(250);
    await shot(page, 'form-dropdown-wide');
    assert.ok(await form.locator('.cs-dd-option').count() >= 1);
    await page.keyboard.press('Escape');
    assert.equal(await form.locator('.cs-dd-menu:visible').count(), 0);
    assert.ok((await form.innerText()).includes('Nothing is fixed'));
    assert.equal(await form.getByLabel('Runs in this loop').isVisible(), false, 'limits stay behind Options until asked for');
    await form.locator('.inv-options > summary').click();
    await page.waitForTimeout(300);
    await shot(page, 'form-options-wide');
    const runs = form.getByLabel('Runs in this loop');
    await runs.fill('99');
    await form.getByRole('button', { name: 'Start loop' }).click();
    assert.ok((await form.locator('.inv-field-error:visible').first().innerText()).includes('from 1 to 12'));
    assert.equal((await sentRequests(page)).filter(m => m.request.action === 'create').length, 0, 'invalid input never leaves the page');
    await runs.fill('3');
    await form.getByLabel('Tokens reserved per run').fill('30000');
    await form.getByRole('button', { name: 'Start loop' }).click();
    await page.locator('.inv-job').waitFor();
    const sent = (await sentRequests(page)).map(m => m.request);
    const create = sent.find(r => r.action === 'create');
    assert.equal(create.projectId, 'clanker');
    assert.equal(create.model, 'gemini-3.8-flash-high');
    assert.equal(create.limits.maxRuns, 3);
    assert.equal(create.limits.maxTokensPerRun, 30000);
    assert.ok(create.expiresAt > Date.now() + 7.9 * 3600e3 && create.expiresAt < Date.now() + 8.1 * 3600e3);
    assert.deepEqual(sent.map(r => r.action).slice(-2), ['create', 'start']);
    assert.equal(await page.getByRole('button', { name: 'Stop all' }).count(), 1, 'active, so Stop all is on screen');
    await page.close();
  });

  await test('one click on Start loop starts the full loop that fixes problems, with every model on Automatic', async () => {
    const { page } = await open(420, 'empty');
    await page.getByRole('button', { name: 'New loop' }).click();
    const form = page.locator('.inv-form');
    await form.waitFor();
    await form.getByRole('button', { name: 'Start loop' }).click();
    await page.locator('.inv-job').waitFor();
    const sent = (await sentRequests(page)).map(m => m.request);
    assert.deepEqual(sent.map(r => r.action).slice(-2), ['create', 'start']);
    const create = sent.find(r => r.action === 'create');
    assert.equal(create.recipe, 'full'); assert.equal(create.mode, 'fix', 'fixing is the default');
    assert.deepEqual(create.roles, {}, 'every role stays on Automatic'); assert.equal(create.model, undefined); assert.equal(create.expiresAt, undefined, 'the full loop has no expiry');
    assert.deepEqual(create.options, { visual: 'auto', agents: 10, parallelFixes: 3 });
    assert.equal(create.limits.maxTokensPerRun, 3000000); assert.equal(create.limits.maxRunMinutes, 180);
    await page.close();
  });

  await test('a failed action says why and keeps the loop where it was', async () => {
    const { page } = await open(420, 'stopped');
    await page.evaluate(() => { window.fake.fail.start = 'This investigation has finished or expired. Create a new loop.'; });
    await page.locator('.inv-job').getByRole('button', { name: 'Start' }).click();
    const status = page.locator('.inv-status.is-error');
    await status.waitFor();
    assert.ok((await status.innerText()).includes('finished or expired'));
    assert.equal(await page.locator('.inv-job .cs-tag').first().innerText(), 'Stopped');
    await page.close();
  });

  await test('waiting states use the backend reason and never claim a run is active', async () => {
    for (const [state, label, because] of [['deferred', 'Waiting: quota', 'Verified spare quota unavailable'], ['exhausted', 'Allowance used', 'Hourly allowance reached'], ['stopped', 'Stopped', 'Stopped by user']]) {
      const { page } = await open(420, state);
      const job = page.locator('.inv-job').first();
      assert.equal(await job.locator('.cs-tag').first().innerText(), label);
      assert.ok((await job.innerText()).includes(because));
      assert.equal(await page.locator('.inv-stages').count(), 0);
      assert.ok(!(await pane(page).innerText()).includes('Today’s allowance'), 'no daily allowance card');
      if (state === 'deferred') { await shot(page, 'deferred-wide'); assert.ok(/next eligible run/i.test(await pane(page).innerText())); }
      await page.close();
    }
  });

  await test('a running loop shows its stage and unknown usage honestly', async () => {
    const { page } = await open(420, 'running');
    assert.equal(await page.locator('.inv-job .cs-tag').first().innerText(), 'Running');
    assert.equal(await page.locator('.inv-stages li.is-now').innerText(), 'Tests');
    assert.equal(await page.locator('.inv-stages li.is-done').count(), 2);
    const text = await pane(page).innerText();
    assert.ok(text.includes('measured usage is reported when the run finishes'));
    assert.ok(!(await page.locator('.inv-job dt').allTextContents()).includes('Waiting because'), 'an active run must not show its stale scheduling reason');
    assert.ok(/Pause and cancel run/.test(text));
    await shot(page, 'running-wide');
    await page.evaluate(() => { window.setFakeState('stopped'); window.pushState(); });
    await page.locator('.inv-job[data-state="stopped"]').waitFor();
    assert.equal(await page.locator('.inv-stages').count(), 0, 'a pushed snapshot replaces the running view');
    await page.close();
  });

  await test('parallel runs each show their own stage and the bar says the computer is kept awake', async () => {
    const { page } = await open(420, 'parallel');
    assert.equal(await page.locator('.inv-job .cs-tag', { hasText: 'Running' }).count(), 2);
    assert.deepEqual(await page.locator('.inv-stages li.is-now').allInnerTexts(), ['Tests', 'Diagnosis']);
    const bar = await page.locator('.inv-bar-text').innerText();
    assert.ok(/2 runs are in progress/.test(bar) && /2 loops active/.test(bar) && /kept awake/.test(bar), bar);
    await shot(page, 'parallel-wide'); await page.setViewportSize({ width: 320, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow at 320px');
    await shot(page, 'parallel-narrow'); await page.close();
  });

  await test('Stop all is one click and sends stopAll', async () => {
    const { page } = await open(420, 'running');
    await page.getByRole('button', { name: 'Stop all' }).click();
    await page.locator('.inv-job[data-state="stopped"]').waitFor();
    assert.equal((await sentRequests(page)).filter(m => m.request.action === 'stopAll').length, 1);
    assert.equal(await page.getByRole('button', { name: 'Stop all' }).count(), 0);
    await page.close();
  });

  await test('findings come first with severity and observed/suspected apart, and a clean report is stated as valid', async () => {
    const { page } = await open(420, 'completed');
    const first = page.locator('.inv-run-card').first();
    await first.locator('summary').click();
    const findings = first.locator('.inv-finding');
    assert.equal(await findings.count(), 2);
    assert.deepEqual(await findings.first().locator('.cs-tag').allInnerTexts(), ['High severity', 'Observed']);
    assert.deepEqual(await findings.nth(1).locator('.cs-tag').allInnerTexts(), ['Medium severity', 'Suspected']);
    const text = await first.innerText();
    for (const part of ['EXPECTED', 'OBSERVED', 'SUSPECTED CAUSE', 'REPRODUCTION', 'UNCERTAINTY', 'EVIDENCE', 'ai-chat-panel/extension.js:1996', 'Should a removed project cancel']) assert.ok(text.includes(part), part);
    assert.ok(text.includes('31,200 tokens measured'));
    assert.ok(text.includes('not an interaction test'), 'fixture render is labelled as a recording');
    await shot(page, 'completed-wide');
    const clean = page.locator('.inv-run-card').nth(1);
    await clean.locator('summary').click();
    assert.ok((await clean.innerText()).includes('A clean report is a valid result'));
    assert.ok((await clean.innerText()).includes('Usage unknown, full 40,000 token reservation kept'));
    const failed = page.locator('.inv-run-card').nth(2);
    await failed.locator('summary').click();
    assert.ok((await failed.innerText()).includes('Flash did not return a completed diagnostic report.'));
    await page.close();
  });

  await test('report text is never interpreted as HTML', async () => {
    const { page, errors } = await open(420, 'hostile');
    await page.locator('.inv-run-card summary').click();
    const card = page.locator('.inv-run-card');
    assert.equal(await card.locator('img, script, svg[onload], a').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.locator('#summary-bold').count(), 0);
    const text = await card.innerText();
    assert.ok(text.includes('<img src=x onerror="window.pwned=1">'));
    assert.ok(text.includes('<script>window.pwned=2</script>'));
    assert.ok(text.includes('<b id="summary-bold">bold</b>'));
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('Copy handoff and Review with… use the handoff API and the chosen model, and send nothing by themselves', async () => {
    const { page } = await open(420, 'completed');
    const card = page.locator('.inv-run-card').first();
    await card.locator('summary').click();
    assert.equal((await sentRequests(page)).filter(m => ['review', 'handoff'].includes(m.request.action)).length, 0, 'finishing a run sends no review');
    await card.getByRole('button', { name: 'Copy handoff' }).click();
    await page.waitForFunction(() => window.sent.some(m => m.request?.action === 'handoff'));
    await card.getByRole('button', { name: 'Review with…' }).click();
    const picker = card.locator('.inv-review');
    await picker.locator('.cs-dd-trigger').click();
    assert.deepEqual(await picker.locator('.cs-dd-option').allInnerTexts(), ['Claude Opus 5.5 High', 'GPT 6.1 Sol High']);
    await page.waitForTimeout(250);
    await shot(page, 'review-dropdown-wide');
    await picker.getByRole('option', { name: 'GPT 6.1 Sol High', exact: true }).click();
    assert.ok((await picker.innerText()).includes('Nothing is sent until you press send'));
    await picker.getByRole('button', { name: 'Open draft in new chat' }).click();
    await page.waitForFunction(() => window.sent.some(m => m.request?.action === 'review'));
    const review = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'review');
    assert.deepEqual(review, { action: 'review', runId: 'run-3', modelId: 'gpt-6.1-sol-high' });
    await page.close();
  });

  await test('artifacts open only through the host by recorded name', async () => {
    const { page } = await open(420, 'completed');
    const card = page.locator('.inv-run-card').first();
    await card.locator('summary').click();
    await card.getByRole('button', { name: 'Test output' }).click();
    await page.waitForFunction(() => window.sent.some(m => m.request?.action === 'openArtifact'));
    const opened = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'openArtifact');
    assert.deepEqual(opened, { action: 'openArtifact', runId: 'run-3', name: 'tests.txt' });
    await page.close();
  });

  await test('another host owning the manager shows an honest unavailable state', async () => {
    const { page } = await (async () => {
      const opened = await open(420, 'empty');
      return opened;
    })();
    await page.evaluate(() => { window.fake.unavailable = true; });
    await page.getByRole('button', { name: 'New loop' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings', tab: 'general' } })));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings', tab: 'loops' } })));
    const card = page.locator('.inv-unavailable');
    await card.waitFor();
    assert.ok((await card.innerText()).includes('managed by another IDE window'));
    assert.equal(await page.getByRole('button', { name: 'New loop' }).count(), 0);
    await shot(page, 'unavailable-wide');
    await page.close();
  });

  await test('narrow windows keep every state inside the popup', async () => {
    for (const state of ['empty', 'deferred', 'running', 'completed', 'loop']) {
      const { page } = await open(320, state);
      if (state === 'loop') await page.locator('.inv-run-card').filter({ hasText: 'Security review' }).locator('summary').click();
      if (state === 'empty') { await page.getByRole('button', { name: 'New loop' }).click(); await page.locator('.inv-form').waitFor(); await page.locator('.inv-options > summary').click(); await page.locator('.inv-options details.inv-advanced summary').click(); }
      if (state === 'completed') { await page.locator('.inv-run-card summary').first().click(); await page.locator('.inv-finding').first().waitFor(); }
      const overflow = await page.evaluate(() => { const body = document.querySelector('#loopsModal .fs-modal-body'); return body.scrollWidth - body.clientWidth; });
      assert.ok(overflow <= 0, `${state} overflows by ${overflow}px`);
      await shot(page, `${state}-narrow`);
      await page.close();
    }
  });

  await test('deleting a loop takes two clicks, can be backed out of, and sends delete', async () => {
    const { page } = await open(420, 'stopped');
    const job = page.locator('.inv-job').first();
    await job.getByRole('button', { name: 'Delete', exact: true }).click();
    assert.ok((await job.innerText()).includes('Its reports stay below'));
    assert.equal((await sentRequests(page)).filter(m => m.request.action === 'delete').length, 0, 'one click deletes nothing');
    await job.getByRole('button', { name: 'Keep it' }).click();
    assert.equal(await job.getByRole('button', { name: 'Delete for good' }).count(), 0);
    await job.getByRole('button', { name: 'Delete', exact: true }).click();
    await shot(page, 'delete-confirm-wide');
    await job.getByRole('button', { name: 'Delete for good' }).click();
    await page.locator('.inv-job').waitFor({ state: 'detached' });
    const sent = (await sentRequests(page)).map(m => m.request).filter(r => r.action === 'delete');
    assert.deepEqual(sent, [{ action: 'delete', id: 'job-1' }]);
    assert.ok((await page.locator('.inv-status').innerText()).includes('Loop deleted'));
    await page.close();
  });

  await test('Find and fix swaps in the loop defaults and fields, and creates a fixloop loop', async () => {
    const { page } = await open(420, 'empty');
    await page.getByRole('button', { name: 'New loop' }).click();
    const form = page.locator('.inv-form');
    await form.waitFor();
    await form.getByRole('radio', { name: 'Diagnose only' }).click();
    await form.locator('.inv-options > summary').click();
    assert.equal(await form.getByLabel('Fixes per cycle').count(), 0, 'diagnose only has no fix fields');
    await form.getByRole('radio', { name: 'Basic fix loop' }).click();
    assert.equal(await form.getByRole('radio', { name: 'Basic fix loop' }).getAttribute('aria-checked'), 'true');
    assert.equal(await form.getByLabel('Tokens reserved per run').inputValue(), '300000');
    assert.equal(await form.getByLabel('Fixes per cycle').inputValue(), '3');
    assert.ok((await form.innerText()).includes('Claude and Codex fix them in a private copy'));
    await page.waitForTimeout(500);
    await shot(page, 'form-loop-wide');
    await form.getByLabel('Fixes per cycle').fill('9');
    await form.getByRole('button', { name: 'Start loop' }).click();
    assert.ok((await form.locator('.inv-field-error:visible').first().innerText()).includes('from 0 to 8'));
    await form.getByLabel('Fixes per cycle').fill('2');
    await form.getByRole('button', { name: 'Start loop' }).click();
    await page.locator('.inv-job').waitFor();
    const create = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'create');
    assert.equal(create.recipe, 'fixloop'); assert.equal(create.limits.fixesPerCycle, 2); assert.equal(create.limits.maxRunMinutes, 45);
    assert.equal(await page.locator('.inv-job .cs-tag').first().innerText(), 'Find and fix');
    await page.close();
    const again = await open(420, 'empty');
    await again.page.getByRole('button', { name: 'New loop' }).click();
    await again.page.locator('.inv-form').waitFor();
    await again.page.locator('.inv-form').getByRole('radio', { name: 'Basic fix loop' }).click();
    await again.page.locator('.inv-form').getByRole('radio', { name: 'Diagnose only' }).click();
    assert.equal(await again.page.locator('.inv-form').getByLabel('Fixes per cycle').count(), 0, 'switching back removes the fix fields');
    assert.equal(await again.page.locator('.inv-form').getByLabel('Tokens reserved per run').inputValue(), '250000');
    await again.page.close();
  });

  await test('a fix-loop shows its fix stage and carried-over problems, and its report separates every outcome', async () => {
    const { page, errors } = await open(420, 'loop');
    const job = page.locator('.inv-job').first();
    assert.equal(await job.locator('.inv-stages li.is-now').innerText(), 'Fix');
    assert.equal(await job.locator('.inv-stages li').count(), 8);
    const jobText = await job.innerText();
    assert.ok(jobText.includes('2 open problems for the next cycle') && jobText.includes('3 fixes per cycle'), jobText);
    assert.ok((await page.locator('.inv-bar').innerText()).includes('kept awake'));
    const card = page.locator('.inv-run-card').filter({ hasText: 'Security review' });
    await card.locator('summary').click();
    const text = await card.innerText();
    for (const part of ['1 fixed', '1 unverified', '1 unfixed', '1 new', '1 queued', 'FIXED AND VERIFIED', 'Queue drops a turn on reload', 'by Codex', 'STILL UNFIXED',
      'given up after two attempts', 'The change broke the syntax check and was reverted', 'NEW ISSUES FOUND WHILE VERIFYING', 'FOUND, QUEUED FOR THE NEXT CYCLE',
      'Before the fixes: syntax passed, tests failed.', 'After the fixes: syntax passed, tests passed.', 'Patch with the fixes', 'git apply', 'Nothing in your project has changed', '148,000 tokens measured']) assert.ok(text.includes(part), part);
    assert.equal(await card.locator('.inv-finding .cs-tag', { hasText: 'Fixed' }).count(), 1, 'the finding carries its fix status');
    await card.getByRole('button', { name: 'Patch with the fixes' }).click();
    const opened = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'openArtifact');
    assert.deepEqual(opened, { action: 'openArtifact', runId: 'run-loop', name: 'changes.patch' });
    await shot(page, 'loop-wide');
    assert.deepEqual(errors, []);
    await page.close();
    const done = await open(420, 'loopdone');
    assert.equal(await done.page.locator('.inv-job .cs-tag').last().innerText(), 'Finished');
    await done.page.close();
  });

  await test('Test the interface swaps in the tester defaults and creates a tester loop', async () => {
    const { page } = await open(420, 'empty');
    await page.getByRole('button', { name: 'New loop' }).click();
    const form = page.locator('.inv-form');
    await form.waitFor(); await form.locator('.inv-options > summary').click();
    await form.getByRole('radio', { name: 'Test the interface' }).click();
    assert.equal(await form.getByLabel('Tokens reserved per run').inputValue(), '60000');
    assert.equal(await form.getByLabel('Fixes per cycle').count(), 0, 'the tester never fixes');
    assert.ok((await form.innerText()).includes('at three widths'));
    await page.waitForTimeout(500);
    await shot(page, 'form-tester-wide');
    await form.getByRole('button', { name: 'Start loop' }).click();
    await page.locator('.inv-job').waitFor();
    const create = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'create');
    assert.equal(create.recipe, 'tester'); assert.equal(create.limits.maxTokensPerRun, 60000); assert.equal(create.limits.maxRunMinutes, 15);
    assert.equal(await page.locator('.inv-job .cs-tag').first().innerText(), 'Interface test');
    await page.close();
  });

  await test('an interface-test loop shows its own stages, and its report offers the handoff and screen report', async () => {
    const { page, errors } = await open(420, 'tester');
    assert.deepEqual(await page.locator('.inv-stages li').allInnerTexts(), ['Snapshot', 'Capture', 'Triage', 'Vision', 'Report']);
    assert.equal(await page.locator('.inv-stages li.is-now').innerText(), 'Vision');
    const card = page.locator('.inv-run-card').filter({ hasText: 'screens checked' });
    await card.locator('summary').click();
    assert.equal(await card.locator('.inv-finding').count(), 2);
    const text = await card.innerText();
    for (const part of ['Overlapping elements', 'ui:loops-loop@320', 'Flash looked at the picture', 'Fix handoff', 'Screen report']) assert.ok(text.includes(part), part);
    await shot(page, 'tester-wide');
    await page.setViewportSize({ width: 320, height: 2600 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow at 320px');
    await shot(page, 'tester-narrow');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('a loop paused for unchanged source explains itself on its card and lists only real reports', async () => {
    for (const width of [420, 320]) {
      const { page } = await open(width, 'unchanged');
      const text = await pane(page).innerText();
      assert.ok(text.includes('No new source since the last interface test'));
      assert.ok(!/skipped/i.test(text), 'no Skipped report');
      assert.equal(await page.locator('.inv-run-card').count(), 1);
      await shot(page, `unchanged-${width}`);
    }
  });

  await test('incomplete interface reviews never display Clean, and quiet runs only claim no new findings', async () => {
    const { page } = await open(320, 'tester');
    await page.evaluate(() => {
      const state = window.fake.state;
      const run = state.runs.find(run => run.status === 'completed');
      state.jobs = []; state.activeRunId = null; state.activeRunIds = [];
      state.runs = [{ ...run, findings: [], reviewIncomplete: true, questions: ['Visual review failed'], summary: 'Visual review incomplete.' }];
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'investigationsState', state } }));
    });
    const card = page.locator('.inv-run-card');
    assert.equal(await card.locator('summary .cs-tag').innerText(), 'Review incomplete');
    await card.locator('summary').click();
    assert.ok((await card.innerText()).includes('cannot confirm the interface is clean'));
    await shot(page, 'tester-incomplete-narrow');
    await page.evaluate(() => {
      const state = window.fake.state;
      state.runs[0].reviewIncomplete = false; state.runs[0].questions = [];
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'investigationsState', state } }));
    });
    assert.equal(await card.locator('summary .cs-tag').innerText(), 'No new findings');
    assert.ok((await card.innerText()).includes('Previously reported problems may still be present'));
    await page.close();
  });

  await test('Loops lives below Scheduled, toggles its own popup and is absent from Settings', async () => {
    const { page } = await open(420, 'empty', true);
    assert.equal(await page.evaluate(() => document.getElementById('queueBtn').nextElementSibling.id), 'loopsBtn');
    assert.equal(await page.locator('#settingsModal [data-tab="loops"]').count(), 0);
    assert.equal(await page.locator('#loopsBtn').getAttribute('aria-expanded'), 'true');
    await page.locator('#loopsBtn').click();
    assert.equal(await page.locator('#loopsModal').isVisible(), false);
    await page.locator('#loopsBtn').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#loopsModal').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#loopsBtn').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#loopsBtn').evaluate(el => el === document.activeElement), true);
    await page.locator('#loopsBtn').click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings' } })));
    assert.equal(await page.locator('#loopsModal').isVisible(), false);
    assert.equal(await page.locator('#settingsModal').isVisible(), true);
    await page.close();
  });

  await test('the loop pill counts elapsed time, survives waits and briefly shows completion before collapsing', async () => {
    const { page } = await open(420, 'empty', true);
    await page.locator('#loopsBtn').click();
    await page.clock.install();
    await page.evaluate(() => {
      const state = window.fake.states.deferred;
      state.jobs[0].startedAt = Date.now() - 65000;
      window.fake.state = state; window.pushState();
    });
    assert.equal(await page.locator('#loopElapsed').innerText(), '1:05');
    assert.equal(await page.locator('#loopsBtn').evaluate(el => el.classList.contains('is-pill')), true);
    await page.clock.fastForward(2000);
    assert.equal(await page.locator('#loopElapsed').innerText(), '1:07');
    await page.screenshot({ path: path.join(shots, 'loop-pill-running.png') });
    await page.evaluate(() => {
      window.fake.state.jobs.forEach(job => { job.enabled = false; job.reason = 'Run limit reached'; });
      window.pushState();
    });
    assert.equal(await page.locator('#loopElapsed').innerText(), 'Done');
    await page.screenshot({ path: path.join(shots, 'loop-pill-finished.png') });
    await page.clock.fastForward(7000);
    assert.equal(await page.locator('#loopsBtn').evaluate(el => el.classList.contains('is-pill')), false);
    assert.equal(await page.locator('#loopsBtn').isVisible(), true);
    await page.close();
  });

  await test('keyboard: the create form is reachable and operable without a pointer', async () => {
    const { page } = await open(420, 'empty');
    await page.getByRole('button', { name: 'New loop' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('.inv-form').waitFor();
    const focused = await page.evaluate(() => document.activeElement?.className);
    assert.equal(focused, 'cs-dd-trigger', 'focus moves into the form it opened');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.className.includes('cs-dd-option')), true, 'arrow opens the list and focuses an option');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'cs-dd-trigger', 'Escape closes and returns to the trigger');
    await page.close();
  });

  await test('the full loop is the default: fixing is on, Find only is one click, and nothing needs the Options', async () => {
    const { page } = await open(420, 'empty');
    await page.getByRole('button', { name: 'New loop' }).click();
    const form = page.locator('.inv-form');
    await form.waitFor();
    assert.equal(await form.getByRole('radio', { name: 'Full loop' }).getAttribute('aria-checked'), 'true');
    assert.equal(await form.getByRole('radio', { name: 'Fix problems' }).getAttribute('aria-checked'), 'true');
    assert.equal(await form.getByRole('radio', { name: 'Find only' }).isVisible(), true, 'the switch to Find only is on the form itself');
    assert.equal(await form.getByRole('switch', { name: 'Let Gemini make the fixes' }).getAttribute('aria-checked'), 'false');
    assert.ok((await form.innerText()).includes('better at fixing right now'));
    assert.equal(await form.locator('.cs-set', { hasText: 'Flash model' }).isVisible(), false, 'the full loop picks its own models');
    await page.waitForTimeout(600);
    await shot(page, 'form-full-wide');
    await form.getByRole('radio', { name: 'Find only' }).click();
    assert.equal(await form.getByRole('switch', { name: 'Let Gemini make the fixes' }).isVisible(), false, 'nothing is edited, so the editor choice is hidden');
    assert.ok((await form.innerText()).includes('edits nothing'));
    await form.getByRole('button', { name: 'Start loop' }).click();
    await page.locator('.inv-job').waitFor();
    const create = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'create');
    assert.equal(create.recipe, 'full'); assert.equal(create.mode, 'find');
    assert.equal(await page.locator('.inv-job .cs-tag').first().innerText(), 'Full loop, find only');
    await page.close();
  });

  await test('Gemini fixes are opt-in: the switch pins both editors, a pinned editor shows in the dropdown, and switching it off returns to Automatic', async () => {
    const { page } = await open(420, 'empty');
    await page.getByRole('button', { name: 'New loop' }).click();
    const form = page.locator('.inv-form');
    await form.waitFor(); await form.locator('.inv-options > summary').click();
    const editor = form.locator('.cs-set', { hasText: 'Editor (backend fixes)' }).locator('.cs-dd-trigger');
    assert.equal(await editor.innerText(), 'Automatic: Codex · GPT 6.1 Sol High');
    assert.equal(await form.locator('.cs-set', { hasText: 'Editor (visual fixes)' }).locator('.cs-dd-trigger').innerText(), 'Automatic: Claude · Claude Opus 5.5 High');
    const gemini = form.getByRole('switch', { name: 'Let Gemini make the fixes' });
    await gemini.click();
    assert.equal(await gemini.getAttribute('aria-checked'), 'true');
    assert.equal(await editor.innerText(), 'Gemini, its default model');
    await editor.click(); await page.waitForTimeout(250);
    await shot(page, 'form-roles-wide');
    await form.locator('.cs-set', { hasText: 'Editor (backend fixes)' }).getByRole('option', { name: 'GPT 6.1 Sol High', exact: true }).click();
    assert.equal(await gemini.getAttribute('aria-checked'), 'false', 'choosing another editor turns the switch off again');
    await gemini.click();
    await form.getByRole('button', { name: 'Start loop' }).click();
    await page.locator('.inv-job').waitFor();
    const create = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'create');
    assert.deepEqual(create.roles, { editor: 'gemini', visualEditor: 'gemini' });
    await page.close();
  });

  await test('the visual-check choice and the agent counts are sent, and the scouts can be pinned to another agent', async () => {
    const { page } = await open(420, 'empty');
    await page.getByRole('button', { name: 'New loop' }).click();
    const form = page.locator('.inv-form');
    await form.waitFor(); await form.locator('.inv-options > summary').click();
    const visual = form.locator('.cs-set', { hasText: 'Visual checks' });
    assert.ok((await visual.innerText()).includes('Playwright on any other site'));
    await visual.locator('.cs-dd-trigger').click(); await visual.locator('.cs-dd-option', { hasText: 'Playwright' }).click();
    const scouts = form.locator('.cs-set', { hasText: 'Scouts and verifiers' });
    await scouts.locator('.cs-dd-trigger').click(); await scouts.locator('.cs-dd-option', { hasText: 'Claude Sonnet 5.5 High' }).click();
    const agents = form.locator('.cs-set', { hasText: 'How many agents read' });
    await agents.locator('.cs-dd-trigger').click(); await agents.locator('.cs-dd-option', { hasText: '6 scouts' }).click();
    await form.getByRole('button', { name: 'Start loop' }).click();
    await page.locator('.inv-job').waitFor();
    const create = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'create');
    assert.deepEqual(create.roles, { scout: 'claude-sonnet-5-5-high' });
    assert.deepEqual(create.options, { visual: 'playwright', agents: 6, parallelFixes: 3 });
    await page.close();
  });

  await test('a running full loop shows its stages, its scouts, and that it resumed after a restart', async () => {
    const { page, errors } = await open(420, 'full');
    const job = page.locator('.inv-job').first();
    assert.deepEqual(await job.locator('.inv-stages li').allInnerTexts(), ['Prepare', 'Checks', 'Scouts', 'Confirm', 'Fix', 'Verify', 'Report']);
    assert.equal(await job.locator('.inv-stages li.is-now').innerText(), 'Scouts');
    const text = await job.innerText();
    for (const part of ['Models chosen automatically', 'Never. It ends when it is done', '5 scouts on Gemini 3.8 Flash High', 'Resumed 1 time after a restart', '1 open problem for the next cycle']) assert.ok(text.includes(part), part);
    assert.equal(await job.locator('.inv-chip.is-done').count(), 3);
    assert.equal(await job.locator('.inv-chip.is-running').count(), 1);
    assert.ok((await job.locator('dt').allTextContents()).includes('Activity'));
    assert.ok(!text.includes('Waiting for next investigation'));
    assert.equal(await job.locator('.cs-tag').first().innerText(), 'Full loop');
    assert.ok(!text.includes('Expired'), 'a loop without expiry never reads as expired');
    await page.evaluate(() => {
      const run = window.fake.state.runs.find(run => run.status === 'running');
      run.live.scoutTokens = 731214;
      run.live.agents[4] = { ...run.live.agents[4], state: 'waiting', reason: 'Waiting for model output' };
      run.live.note = '5 scouts on Gemini 3.8 Flash High: 1 responding, 1 awaiting response, 3 done';
      window.pushState();
    });
    await job.getByText(/731,214 tokens reported by completed scouts/).waitFor();
    assert.equal(await job.locator('.inv-chip.is-waiting').getAttribute('title'), 'Perf: waiting — Waiting for model output');
    await shot(page, 'full-running-wide');
    await page.setViewportSize({ width: 320, height: 2600 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow at 320px');
    await shot(page, 'full-running-narrow');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('a loop that was running when the IDE closed reads as resuming, not as failed or expired', async () => {
    const { page } = await open(420, 'fullresuming');
    assert.equal(await page.locator('.inv-job .cs-tag').last().innerText(), 'Resuming');
    assert.equal(await page.locator('.inv-job').getAttribute('data-state'), 'resuming');
    assert.equal(await page.getByRole('button', { name: 'Edit settings' }).count(), 0, 'an armed loop is not edited');
    await page.close();
  });

  await test('a full report separates fixed, unfixed and queued, names the scouts, the visual provider and the thrown-out fix', async () => {
    const { page } = await open(420, 'fullpaused');
    const card = page.locator('.inv-run-card').first();
    await card.locator('summary').click();
    const text = await card.innerText();
    for (const part of ['Full review, cycle 1', '2 fixed', 'FIXED AND VERIFIED', 'STILL UNFIXED', 'Made the "tests" check fail', 'FOUND, QUEUED FOR THE NEXT CYCLE', 'SCOUTS',
      '2 of 3 finished; 7 candidates, 4 confirmed, 3 refuted', 'Visual checks (playwright): 3 pages, 1 new layout problem', '1 fix thrown out for breaking a check', 'Patch with the fixes']) assert.ok(text.includes(part), part);
    await shot(page, 'full-report-wide');
    await page.close();
  });

  await test('a find-only report lists the confirmed problems, says nothing was edited, and states why visual checks did not run', async () => {
    const { page } = await open(420, 'fullfind');
    assert.equal(await page.locator('.inv-job .cs-tag').first().innerText(), 'Full loop, find only');
    const card = page.locator('.inv-run-card').first();
    assert.ok((await card.locator('summary').innerText()).includes('2 problems found'));
    await card.locator('summary').click();
    const text = await card.innerText();
    for (const part of ['CONFIRMED PROBLEMS (NOTHING WAS EDITED)', 'Queue drops a turn on reload', 'Visual checks did not run: This project has no pages to open']) assert.ok(text.includes(part), part);
    assert.ok(!text.includes('FIXED AND VERIFIED'));
    await page.close();
  });

  await test('a paused full loop can change who fixes and whether it fixes, and saves it with configure', async () => {
    const { page } = await open(420, 'fullpaused');
    await page.getByRole('button', { name: 'Edit settings' }).click();
    const edit = page.locator('.inv-edit');
    await edit.waitFor();
    assert.equal(await edit.getByRole('switch', { name: 'Let Gemini make the fixes' }).getAttribute('aria-checked'), 'false', 'only one editor was pinned, so the switch is off');
    assert.equal(await edit.locator('.cs-set', { hasText: 'Editor (backend fixes)' }).locator('.cs-dd-trigger').innerText(), 'Gemini, its default model');
    await edit.getByRole('radio', { name: 'Find only' }).click();
    await page.waitForTimeout(500);
    await shot(page, 'full-edit-wide');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => window.sent.some(m => m.request?.action === 'configure'));
    const configure = (await sentRequests(page)).map(m => m.request).find(r => r.action === 'configure');
    assert.equal(configure.id, 'job-full'); assert.equal(configure.mode, 'find'); assert.deepEqual(configure.roles, { editor: 'gemini' });
    assert.equal(await page.locator('.inv-job .cs-tag').first().innerText(), 'Full loop, find only');
    await page.close();
  });

  await test('the full form fits a 320px popup with the options open', async () => {
    const { page } = await open(320, 'empty');
    await page.getByRole('button', { name: 'New loop' }).click();
    await page.locator('.inv-form').waitFor(); await page.locator('.inv-options > summary').click();
    await page.locator('.inv-options details.inv-advanced summary').click();
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => { const body = document.querySelector('#loopsModal .fs-modal-body'); return body.scrollWidth - body.clientWidth; });
    assert.ok(overflow <= 0, 'overflows by ' + overflow + 'px');
    await shot(page, 'form-full-narrow');
    await page.close();
  });
} finally { await browser.close(); }
console.log(results.join('\n'));
console.log(`pictures: ${shots}`);
