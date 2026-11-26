// The screens the interface tester visits. A scenario is { id, height?, focus?, setup?(page) } on the real chat page, or
// { id, html } for a static fixture (used by the tester's own tests). `focus` is the element the picture is cropped to.
// Add a scenario here whenever a bug is found by hand: it then stays checked on every run.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { pagedHistory } from '../chat-performance.mjs';
import { queueStability } from '../queue-stability.mjs';
import { queueReset } from '../queue-reset.mjs';
import { messageDock } from '../message-dock.mjs';
import { hiddenDialogs } from '../render-budgets.mjs';
const require = createRequire(import.meta.url);
const { DEFAULTS } = require('../../lib/routing');
const { StreamEngine } = require('../../lib/stream-engine');
const openSettings = tab => page => page.evaluate(name => window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings', tab: name } })), tab);
const loopsState = state => async page => {
  await page.evaluate(name => window.setFakeState(name), state);
  await page.locator('#loopsBtn').click();
  await page.locator('.inv .inv-overview').waitFor();
};
const MODAL = '.fs-modal:not([hidden]) .fs-modal-sheet';
// The host's message when aiChatPanel.appearance changes; a frame later the measuring code has seen the new shapes.
const toHalo = async page => {
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'appearance', appearance: 'halo' } })));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

const IDE_PALETTES = {
  dark: { kind: 'vscode-dark', background: '#172437', panel: '#213149', foreground: '#e4edf7', accent: '#8acbff' },
  light: { kind: 'vscode-light', background: '#fff4df', panel: '#fffaf0', foreground: '#382d24', accent: '#854020' },
  'contrast-dark': { kind: 'vscode-high-contrast', background: '#000000', panel: '#101010', foreground: '#ffffff', accent: '#ffff00' },
  'contrast-light': { kind: 'vscode-high-contrast-light', background: '#ffffff', panel: '#f5f5f5', foreground: '#000000', accent: '#0000aa' },
};
async function applyIdePalette(page, theme) {
  await page.evaluate(theme => {
    document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light');
    document.body.classList.add(theme.kind);
    const colours = { 'editor.background': theme.background, 'editor.foreground': theme.foreground,
      'editorWidget.background': theme.panel, 'sideBar.background': theme.panel,
      'textLink.foreground': theme.accent, 'focusBorder': theme.accent,
      'button.background': theme.accent, 'button.foreground': theme.background };
    for (const [key, value] of Object.entries(colours)) document.documentElement.style.setProperty(`--vscode-${key.replaceAll('.', '-')}`, value);
    document.documentElement.style.setProperty('--vscode-contrastBorder', theme.kind.includes('contrast') ? theme.accent : '');
  }, theme);
  await page.waitForFunction(() => document.body.style.getPropertyValue('--chat-bg').startsWith('rgb('));
}

// Two real PDF pages exercise the renderer and navigation without external files or model calls.
function samplePdf() {
  const stream = title => `BT /F1 24 Tf 30 220 Td (${title}) Tj ET\n0.35 0.5 0.85 rg 30 80 140 80 re f`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[5, 6].map(id => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 280] /Resources << /Font << /F1 7 0 R >> >> /Contents ${id} 0 R >>`),
    ...['Preview one', 'Preview two'].map(title => { const data = stream(title); return `<< /Length ${data.length} >>\nstream\n${data}\nendstream`; }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`;
}
async function attachmentPreviews(page) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M12 12h40v30H28L12 54Z" fill="none" stroke="#242936" stroke-width="4"/></svg>`;
  const files = [
    { name: 'comment.svg', path: 'comment.svg', mime: 'image/svg+xml', size: svg.length, uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` },
    { name: 'review.pdf', path: 'review.pdf', mime: 'application/pdf', size: 1200, uri: samplePdf() },
  ];
  await page.evaluate(files => {
    const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
    post({ type: 'userMessage', text: 'SVG and PDF previews in the conversation', files });
    for (const attachment of files) post({ type: 'attachmentSaved', attachment });
  }, files);
  await page.waitForFunction(() => document.querySelectorAll('.attachment-pdf:not([hidden])').length === 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.attachment-chip img')].every(img => img.complete && img.naturalWidth > 0));
}

export const LOOP_STATES = ['empty', 'running', 'parallel', 'completed', 'loop', 'loopdone', 'deferred', 'exhausted', 'tester', 'testerdone'];

const unavailable = async page => {
  await page.evaluate(() => {
    const now = Date.now() / 1000, quota = (remaining, reset) => ({ remaining, used: 100 - remaining, windowMinutes: 300, resetsAt: now + reset, secondary: { remaining: 60, resetsAt: now + 97200 } });
    const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
    post({ type: 'quotas', quotas: { claude: quota(72, 6600), codex: quota(100, 9000), gemini: quota(64, 7200) } });
    const ok = { enabled: true, unavailable: null, installed: true, auth: 'connected', settingUp: false, note: '', fault: null };
    post({ type: 'cliConnections', setupNeeded: false, checking: false, providers: { claude: ok,
      codex: { ...ok, auth: 'signin', fault: { code: 1, title: 'Not signed in', detail: 'Codex has no signed-in account. Sign in with your browser and it works again.', action: 'connectCli', label: 'Sign in' } },
      gemini: { ...ok, auth: 'broken', fault: { code: 1, title: 'Cannot start', detail: 'Antigravity crashed on launch: its language server did not start.', action: 'connectCli', label: 'Repair & sign in' } } } });
  });
};

async function copilotToolCards(page, agents) {
  const engine = new StreamEngine();
  const events = [];
  engine.on('event', event => events.push(event));
  try {
    for (const raw of require('../fixtures/copilot-events.json')) engine.consumeLine(JSON.stringify(raw), 'copilot');
  } finally { engine.dispose(); }
  const post = messages => page.evaluate(events => {
    for (const data of events) window.dispatchEvent(new MessageEvent('message', { data }));
  }, messages);
  await post([{ type: 'userMessage', text: 'Check and update the release status.' }, { type: 'routing', agentId: 'copilot' }]);
  const shellEnd = events.findIndex(event => event.type === 'tool_end' && event.toolId === 'shell-1');
  await post(events.slice(0, shellEnd));
  const shell = page.locator('.tool-shell');
  assert.match(await shell.getAttribute('class'), /is-running/, 'the hidden intent completion leaves the shell running');
  assert.equal(await shell.locator('.tool-body').textContent(), 'Starting checks\nChecks passed', 'dual output events are shown once');
  await post(events.slice(shellEnd));
  if (agents) {
    await page.locator('#agentsBtn').click();
    await page.locator('.agents-log .tool-read').evaluate(card => { card.open = true; });
    assert.equal(await page.locator('.agents-title').textContent(), 'Explorer');
    assert.match(await page.locator('.agents-log').textContent(), /The status file reads checked/);
    assert.match(await page.locator('.agents-log .tool-body').textContent(), /checked/);
    return;
  }
  await page.locator('.work-summary:not(.is-empty), .tool-edit, .tool-plug').evaluateAll(cards => cards.forEach(card => { card.open = true; }));
  assert.equal(await page.locator('.tool-skill .tool-label').textContent(), 'clanker-load-agent');
  assert.equal(await page.locator('.tool-edit summary .diff-add').textContent(), '+1');
  assert.equal(await page.locator('.tool-edit summary .diff-del').textContent(), '-1');
  assert.match(await page.locator('.tool-plug .tool-body').textContent(), /The docs service denied this lookup/);
  assert.equal(await page.locator('.turn .tool-read').count(), 0, 'subagent cards stay in the Agents viewer');
}

export const scenarios = [
  { id: 'model-handoff-divider', sidebar: true, height: 740, setup: async page => {
    const send = data => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
    const previous = [{ role: 'user', text: 'Check the migration notes.' }, { role: 'assistant', agent: 'claude', modelLabel: 'Claude Sonnet 5.5 High', text: 'The schema changes are ready. The verification is still pending.' }];
    const destination = 'gpt-6.1-sol-high';
    const chat = { id: 'handoff-fixture', modelId: destination, messages: previous };
    const label = 'Context handoff from Claude Sonnet 5.5 High to GPT 6.1 Sol High';
    await send({ type: 'chatLoaded', chat });
    const divider = page.getByRole('note', { name: label });
    assert.equal(await divider.count(), 0);
    const text = 'Run the verification and report back.';
    await page.locator('#promptInput').fill(text);
    await page.locator('#promptInput').press('Enter');
    await page.waitForFunction(() => window.sent.some(message => message.type === 'send'));
    const clientTurnId = await page.evaluate(() => window.sent.findLast(message => message.type === 'send').clientTurnId);
    const contextHandoff = { from: { agent: 'claude', label: 'Claude Sonnet 5.5 High' }, to: { agent: 'codex', label: 'GPT 6.1 Sol High' } };
    const user = { role: 'user', text, clientTurnId, contextHandoff };
    await send({ ...user, type: 'userMessage' });
    await send({ ...user, type: 'userMessage' });
    assert.equal(await divider.count(), 1);
    assert.equal(await divider.evaluate(node => node.nextElementSibling.querySelector('.msg-user-text').textContent.trim()), text);
    assert.equal(await page.locator('.msg-user-text').filter({ hasText: text }).count(), 1);
    await send({ type: 'chatLoaded', chat: { ...chat, messages: [...previous, user, { role: 'assistant', agent: 'codex', modelLabel: contextHandoff.to.label, text: 'The verification passed.' }] } });
    assert.equal(await divider.count(), 1, 'the marker restores with the user message');
    assert.equal(await divider.evaluate(node => node.nextElementSibling.querySelector('.msg-user-text').textContent.trim()), text);
  } },
  { id: 'usage-favorite-providers', sidebar: true, height: 660, focus: '.rail', setup: async page => {
    const send = data => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
    const { models } = require('../model-fixture');
    const claude = models.filter(model => model.agent === 'claude');
    const copilot = { id: 'copilot-auto', agent: 'copilot', model: 'auto', label: 'Copilot Auto' };
    const available = [...claude, copilot];
    const favorites = catalog => send({ type: 'modelCatalog', catalog, available });
    const visible = () => page.locator('#modelCards .model-card').evaluateAll(cards => cards.map(card => card.dataset.agent));
    await send({ type: 'cliConnections', providers: { claude: { enabled: true }, copilot: { enabled: true } } });
    await send({ type: 'quotas', quotas: { claude: { remaining: 79 }, copilot: { remaining: 100, windowMinutes: 43200 } } });
    await favorites(available);
    assert.deepEqual(await visible(), ['claude', 'copilot']);
    await favorites([claude[0], copilot]);
    assert.deepEqual(await visible(), ['claude', 'copilot'], 'another favorite keeps the provider visible');
    await favorites([claude[0]]);
    assert.deepEqual(await visible(), ['claude']);
    await favorites([]);
    assert.equal(await page.locator('.launcher-section').filter({ has: page.locator('#modelCards') }).isVisible(), false);
    await favorites([claude[0], copilot]);
    assert.deepEqual(await visible(), ['claude', 'copilot']);
    assert.equal(await page.locator('.model-card-copilot .model-card-5h').textContent(), '100%');
    await favorites([claude[0]]);
  } },
  { id: 'high-context-composer', height: 660, setup: async page => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'chatLoaded', chat: { id: 'high-context', context: { agent: 'gemini', tokens: 421000, limit: 512000 },
        messages: [{ role: 'user', text: 'Continue the implementation.' }] },
      running: { agentId: 'gemini', modelLabel: 'Gemini', startedAt: Date.now() },
    } })));
    assert.match(await page.locator('.pending-tokens').textContent(), /421k \/ 512k/);
    assert.equal(await page.locator('.context-warning').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Compact', exact: true }).count(), 0);
  } },
  { id: 'copilot-tool-cards', height: 850, setup: page => copilotToolCards(page, false) },
  { id: 'copilot-native-agent', height: 740, focus: MODAL, setup: page => copilotToolCards(page, true) },
  // The rail's usage circles in both themes: one ring pair (Claude), one (Codex) and the split Antigravity circle with its two arcs.
  ...['light', 'dark'].map(theme => ({ id: `usage-rings-${theme}`, sidebar: true, height: 700, focus: '.model-cards', setup: async page => {
    await applyIdePalette(page, theme === 'light' ? { ...IDE_PALETTES.light, background: '#e6e7ee', panel: '#d9dbe5', foreground: '#38405e', accent: '#365cb0' } : IDE_PALETTES.dark);
    await page.evaluate(() => {
      const now = Date.now() / 1000, win = (remaining, reset, minutes = 300) => ({ remaining, used: 100 - remaining, windowMinutes: minutes, resetsAt: now + reset });
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'quotas', quotas: { claude: { ...win(0, 8300), secondary: win(55, 400000, 10080) }, codex: { ...win(64, 2700), secondary: win(72, 300000, 10080) },
        gemini: { ...win(100, 1860), secondary: win(100, 300000, 10080) }, antigravityArgon: win(1, 360000, 10080) } });
    });
    await page.waitForTimeout(900);
  } })),
  ...['light', 'dark', 'menu', 'settings'].map(state => ({ id: `glass-depth-${state}`, sidebar: true, height: 1050,
    focus: state === 'menu' ? '.model-menu-stage' : state === 'settings' ? MODAL : undefined,
    scope: state === 'menu' ? '#modelMenu' : state === 'settings' ? MODAL : undefined, setup: async page => {
    const light = state !== 'dark';
    await applyIdePalette(page, light ? { ...IDE_PALETTES.light, background: '#e6e7ee', panel: '#d9dbe5', foreground: '#38405e', accent: '#365cb0' } : IDE_PALETTES.dark);
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'chatLoaded', chat: { id: 'glass-depth', modelId: 'gpt-6.1-sol-medium', messages: [
        { role: 'user', text: 'Make light-mode glass feel lighter, with quieter shadows.' },
        { role: 'assistant', agent: 'codex', text: 'The transcript stays calm and readable. Floating controls use subtle elevation, while menus remain distinct.\n\n**Keep the theme’s colours**, the rounded shapes and the existing motion.' },
      ] } });
      const project = { id: 'glass-project', name: 'Clanker Controller', root: 'C:/projects/clanker', iconUri: 'http://127.0.0.1/clanker.svg' };
      post({ type: 'project', projects: [project], project });
      post({ type: 'history', sessions: [{ id: 'glass-depth', selected: true, projectId: project.id, title: 'Light-mode glass', models: ['codex'], updatedAt: new Date().toISOString() }] });
    });
    if (state === 'settings') await openSettings('general')(page);
    if (state === 'menu') await page.locator('#modelPill').click();
    const material = await page.locator('body').evaluate(el => {
      const s = getComputedStyle(el); return { bubble: s.getPropertyValue('--shadow-bubble').trim(), raised: s.getPropertyValue('--panel-raised').trim(),
        composer: getComputedStyle(document.querySelector('.compose-row')).filter };
    });
    if (light) {
      assert.equal(material.bubble, '0 0 0 transparent');
      assert.equal(material.composer, 'none', 'the Dynamic Island composer carries no drop-shadow filter (UI-04)');
      assert.ok(material.raised.split(' ').map(Number).every((v, i) => v >= [217, 219, 229][i]));
    } else assert.equal(material.composer, 'none', 'the Dynamic Island composer carries no drop-shadow filter (UI-04)');
  } })),
  ...['dark', 'light', 'empty', 'busy'].map(state => ({ id: `onboarding-models-${state}`, focus: '#cliSetupModal .fs-modal-sheet', setup: async page => {
    if (state === 'light') await applyIdePalette(page, IDE_PALETTES.light);
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const models = [{ id: 'setup-codex', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', label: 'GPT 6.1 Sol Medium' },
      { id: 'setup-claude', agent: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' }];
    const snapshot = { type: 'cliStatus', versions: {}, updating: {}, notes: {}, fetched: state === 'empty' ? [] : models,
      favorites: [], catalog: [], prompts: {}, modelsBusy: state === 'busy' };
    await post(snapshot);
    await page.evaluate(() => { window.setupModelList = document.querySelector('#settingsModal [data-role="modelList"]'); });
    await post({ type: 'cliConnections', setupNeeded: true, checking: false, providers: { codex: { enabled: true, installed: true, auth: 'connected' } } });
    const setup = page.locator('#cliSetupModal');
    await setup.getByRole('button', { name: 'Next: favorite models', exact: true }).click();
    assert.equal(await page.evaluate(() => window.setupModelList === document.querySelector('#cliSetupModal [data-role="modelList"]')), true, 'onboarding uses the Settings list itself');
    assert.equal(await page.evaluate(() => window.sent.some(m => m.type === 'completeCliSetup')), false);
    if (state === 'busy') {
      assert.equal(await setup.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
      assert.match(await setup.locator('[data-role="availableDesc"]').innerText(), /Asking/);
    } else if (state === 'empty') {
      assert.match(await setup.locator('[data-role="modelList"]').innerText(), /Refresh to discover/);
    } else {
      const search = setup.getByRole('searchbox', { name: 'Search available models' });
      await search.fill('Sol');
      assert.equal(await setup.locator('.cs-model-row').count(), 1);
      await search.fill('');
      await setup.getByRole('button', { name: 'Codex', exact: true }).click();
      assert.equal(await setup.locator('.cs-model-row').count(), 1);
      const heart = setup.getByRole('button', { name: 'Favorite GPT 6.1 Sol Medium', exact: true });
      await heart.click();
      assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'toggleFavoriteModel').at(-1)), { type: 'toggleFavoriteModel', id: 'setup-codex' });
      await post({ ...snapshot, favorites: ['setup-codex'] });
      assert.equal(await heart.getAttribute('aria-pressed'), 'true');
      await setup.getByRole('button', { name: 'Refresh', exact: true }).click();
      assert.equal(await page.evaluate(() => window.sent.at(-1).type), 'refreshModels');
      await post({ ...snapshot, favorites: ['setup-codex'], modelsBusy: true });
      assert.equal(await setup.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
      await post({ ...snapshot, favorites: ['setup-codex'] });
      await setup.getByRole('button', { name: 'Back', exact: true }).click();
      await setup.getByRole('button', { name: 'Next: favorite models', exact: true }).click();
      assert.equal(await heart.getAttribute('aria-pressed'), 'true');
      await setup.getByRole('button', { name: 'Start chatting', exact: true }).click();
      await setup.waitFor({ state: 'hidden' });
      await post({ type: 'openSettings', tab: 'general' });
      assert.equal(await page.evaluate(() => window.setupModelList === document.querySelector('#settingsModal [data-role="modelList"]')), true);
      assert.equal(await page.locator('#settingsModal .cs-heart[data-model-id="setup-codex"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#settingsModal .cs-btn[data-role="openSetupGuide"]').click();
      await setup.getByRole('button', { name: 'Next: favorite models', exact: true }).click();
      await setup.locator('.cs-company[data-company="all"]').click();
    }
  } })),
  ...Object.entries(IDE_PALETTES).map(([id, theme]) => ({ id: `ide-palette-${id}`, focus: '#transcript', setup: async page => {
    await applyIdePalette(page, theme);
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'chatLoaded', chat: { id: 'palette-review', modelId: 'gpt-6.1-sol-medium', messages: [
        { role: 'user', text: 'Make the chat follow my editor theme.' },
        { role: 'assistant', agent: 'codex', text: 'The palette follows your IDE. **Glass and motion stay familiar.**\n\n[Theme settings](https://example.com) retain your selected colours.' },
      ] } });
    });
    const { parse, contrast } = createRequire(import.meta.url)('../../media/theme-palette');
    const expected = `rgb(${parse(theme.background).slice(0, 3).join(', ')})`;
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), expected);
    assert.match(await page.locator('#transcript').innerText(), /Glass and motion stay familiar/);
    assert.equal(await page.locator('.msg a').first().evaluate(el => getComputedStyle(el).color), `rgb(${parse(theme.accent).slice(0, 3).join(', ')})`);
    const tokens = await page.locator('body').evaluate(el => {
      const s = getComputedStyle(el); return ['--charcoal', '--text-primary', '--claude-color', '--eo-surface'].map(key => s.getPropertyValue(key).trim());
    });
    assert.ok(contrast(parse(tokens[0]), parse(tokens[1])) >= 4.5);
    assert.ok(['#f97316', '#ffa66b'].includes(tokens[2]), `Claude orange token (light: #f97316, dark: #ffa66b), got ${tokens[2]}`);
    if (id.includes('contrast')) assert.match(tokens[3], /^rgb\(/);
    await page.waitForFunction(panel => {
      const shape = document.querySelector('.msg-group-user')?.style.getPropertyValue('--bubble-image');
      return shape && decodeURIComponent(shape).includes(panel);
    }, tokens[0]);
  } })),
  { id: 'ide-palette-live', focus: '#transcript', setup: async page => {
    const scenario = scenarios.find(s => s.id === 'ide-palette-dark');
    await scenario.setup(page);
    await page.locator('#promptInput').fill('Keep my draft through a theme switch');
    const before = await page.locator('.msg-group-user').evaluate(el => el.style.getPropertyValue('--bubble-image'));
    await applyIdePalette(page, { ...IDE_PALETTES.dark, background: '#12291b', panel: '#21452e' });
    await page.waitForFunction(before => document.querySelector('.msg-group-user').style.getPropertyValue('--bubble-image') !== before, before);
    assert.equal(await page.locator('#promptInput').inputValue(), 'Keep my draft through a theme switch');
    // The host can replace body.style wholesale; our derived colours must recover even if its variables did not change.
    await page.evaluate(() => document.body.removeAttribute('style'));
    await page.waitForFunction(() => document.body.style.getPropertyValue('--chat-bg') === 'rgb(18, 41, 27)');
    await page.evaluate(() => document.documentElement.removeAttribute('style'));
    await page.waitForFunction(() => document.body.style.getPropertyValue('--chat-bg') === '');
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(17, 18, 22)');
    await applyIdePalette(page, { ...IDE_PALETTES.dark, background: '#12291b', panel: '#21452e' });
  } },
  { id: 'ide-palette-settings', focus: MODAL, setup: async page => {
    await applyIdePalette(page, IDE_PALETTES.light);
    await openSettings('general')(page);
  } },
  ...['rail', 'settings'].map(location => ({ id: `project-icon-contrast-${location}`, sidebar: true, focus: location === 'rail' ? '.rail' : '.cs-project-icons', scope: location === 'rail' ? '.project-pill' : '.cs-project-tile', setup: async page => {
    const project = { id: 'dark-mark', name: 'Clanker Controller', root: 'C:/projects/clanker', iconUri: 'http://127.0.0.1/clanker.svg' };
    await page.evaluate(project => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'project', projects: [project], project });
      post({ type: 'history', sessions: [{ id: 'dark-mark-chat', projectId: project.id, title: 'Icon contrast', updatedAt: new Date().toISOString(), models: ['codex'] }] });
    }, project);
    let selector = '.project-icon.is-dark';
    if (location === 'settings') {
      await openSettings('general')(page);
      await page.evaluate(project => window.dispatchEvent(new MessageEvent('message', { data: { type: 'projectIcons', projects: [project] } })), project);
      await page.locator('.cs-project-icons summary').click();
      selector = '.cs-project-tile img.is-dark';
      await page.locator('.cs-project-icons').evaluate(el => el.scrollIntoView({ block: 'center' }));
    }
    await page.locator(selector).first().waitFor();
    for (const theme of ['vscode-dark', 'vscode-high-contrast-light', 'vscode-light']) {
      await page.evaluate(theme => {
        document.body.classList.remove('vscode-dark', 'vscode-light', 'vscode-high-contrast-light');
        document.body.classList.add(theme);
      }, theme);
      const colours = await page.locator(selector).evaluateAll(images => images.map(image => getComputedStyle(image).backgroundColor));
      assert.ok(colours.length > 0);
      assert.ok(colours.every(colour => colour === 'rgba(255, 255, 255, 0.9)'), `${theme}: dark favicons keep their light backing`);
    }
  } })),
  { id: 'attachment-documents', focus: '.image-lightbox-frame', setup: async page => {
    await page.evaluate(() => {
      const files = [['sample.txt', '<script>unsafe()</script>\nReadable text'], ['sample.csv', 'Name,Value\n"a,b",42']].map(([name, text]) => ({ name, path: name, size: text.length, uri: `data:text/plain;base64,${btoa(text)}` }));
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'userMessage', text: 'Document previews', files });
      files.forEach(attachment => post({ type: 'attachmentSaved', attachment }));
    });
    assert.equal(await page.locator('.attachment-doc').count(), 4);
    await page.locator('.msg-attachments .attachment-chip').first().click();
    await page.waitForFunction(() => document.querySelector('.doc-code')?.textContent.includes('<script>'));
    assert.equal(await page.locator('.doc-code script').count(), 0);
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await page.locator('.attachment-strip .attachment-chip').last().click();
    await page.waitForFunction(() => document.querySelector('.doc-table')?.textContent.includes('a,b'));
    const office = await page.evaluate(() => {
      const doc = window.attachmentDocs.docxBlocks('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word preview</w:t></w:r></w:p></w:body></w:document>');
      return doc[0].textContent;
    });
    assert.equal(office, 'Word preview');
  } },
  { id: 'attachment-paste-pending', focus: '.compose-row', scope: '.attachment-strip', setup: async page => {
    await page.locator('textarea').first().fill('Review this pasted screenshot');
    const immediate = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#cbddea'; ctx.fillRect(0, 0, 640, 400);
      ctx.fillStyle = '#466080'; ctx.fillRect(100, 100, 440, 200);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const clipboardData = new DataTransfer(); clipboardData.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
      document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
      return !!document.querySelector('.attachment-chip.is-attaching img[src^="blob:"]');
    });
    assert.ok(immediate, 'preview is inserted before image preparation finishes');
    await page.waitForTimeout(700);
  } },
  ...['light', 'dark'].map(theme => ({ id: `glass-schedule-${theme}`, scope: '.schedule-menu', setup: async page => {
    await page.evaluate(theme => {
      document.body.classList.toggle('vscode-light', theme === 'light');
      document.body.classList.toggle('vscode-dark', theme === 'dark');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'glass-timer', messages: [{ role: 'user', text: 'Keep the message and its action dock fused in the glass material.' }, { role: 'assistant', agent: 'codex', text: 'The scheduling picker uses the same quiet glass edges.' }] } } }));
    }, theme);
    await page.locator('#scheduleBtn').click();
    await page.locator('#scheduleBtn').click();
    await page.locator('#scheduleBtn').hover();
    await page.locator('.schedule-menu.is-open').waitFor({ state: 'visible' });
    await page.waitForTimeout(700);
    // The picker is a menu on the composer's upper slab (like the model menu): it rests on the composer's top edge.
    const [menu, composer] = await Promise.all([page.locator('.schedule-menu').boundingBox(), page.locator('.composer').boundingBox()]);
    assert.ok(Math.abs(menu.y + menu.height - composer.y) < 4, 'the schedule menu rests on the composer top edge');
    assert.equal(await page.locator('.timer-chip[aria-checked="true"]').count(), 1, 'the selected timer remains visible');
  } })),
  { id: 'attachment-markup', focus: '.markup-editor', setup: async page => {
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#dfe8ef'; ctx.fillRect(0, 0, 640, 400);
      ctx.fillStyle = '#466080'; ctx.fillRect(100, 100, 440, 200);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'attachmentSaved', attachment: { name: 'sample.png', path: 'sample.png', mime: 'image/png', size: 1000, uri: canvas.toDataURL() } } }));
    });
    await page.locator('.attachment-strip .attachment-chip img').first().click();
    await page.getByRole('button', { name: 'Mark up image', exact: true }).click();
    await page.locator('.markup-editor.is-open').waitFor();
    const canvas = await page.locator('.markup-editor canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width * .25, canvas.y + canvas.height * .3);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * .7, canvas.y + canvas.height * .6, { steps: 12 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Save markup', exact: true }).click();
    const saved = await page.evaluate(() => window.sent.filter(m => m.type === 'saveMarkup').at(-1));
    assert.equal(saved.markup.items.length, 1);
    assert.match(saved.data, /^data:image\/png;base64,/);
    await page.evaluate(saved => window.attachmentMarkup.open({ src: saved.data, items: [], name: 'Saved composite' }), saved);
    await page.locator('.markup-editor.is-open').waitFor();
  } },
  { id: 'scheduled-attachments', focus: '.compose-row', setup: async page => {
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const svg = color => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`)}`;
    const files = [{ name: 'before.png', path: '/staged/before.png', mime: 'image/png', uri: svg('#6366f1') }, { name: 'after.png', path: '/staged/after.png', mime: 'image/png', uri: svg('#22c55e') }];
    const task = { id: 'scheduled-images', chatId: 'attachment-chat', model: 'codex', modelId: 'gpt-6.1-sol-medium', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: new Date(await page.evaluate(() => Date.now()) + 300000).toISOString(), prompt: 'Compare these attached screenshots', files, attachments: files.map(file => ({ name: file.name, mimeType: file.mime, absolutePath: file.path })) };
    await post({ type: 'chatLoaded', chat: { id: task.chatId, modelId: task.modelId, messages: [] } });
    await post({ type: 'schedulerQueue', queue: [task] });
    const badge = page.locator('.turn-queue-files');
    assert.match(await badge.textContent(), /2 photos/);
    assert.equal(await badge.getAttribute('title'), 'before.png\nafter.png');
    assert.equal(await badge.locator('img').count(), 0, 'queued rows show a count, not thumbnails');
    await post({ type: 'schedulerQueue', queue: [{ ...task, files: files.slice(0, 1) }] });
    assert.match(await badge.textContent(), /1 photo/);
    await post({ type: 'schedulerQueue', queue: [task] });
    assert.match(await badge.textContent(), /2 photos/);
    await page.waitForTimeout(450);
  } },
  { id: 'queue-edit-tail', height: 1100, focus: '.msg-group-user', scope: '.msg-user', setup: async page => {
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await post({ type: 'chatLoaded', chat: { id: 'edit-tail', messages: [] }, running: { agentId: 'claude', startedAt: Date.now() } });
    const input = page.locator('#promptInput');
    let text = 'A long prompt about glass panels and their layers. '.repeat(22) + 'UNIQUE_END_OF_PROMPT';
    await input.fill(text); await input.press('Enter');
    const initial = await page.evaluate(() => window.sent.findLast(m => m.type === 'queueTurn').turn);
    const edit = () => page.locator(`[data-id="${initial.id}"]`).getByRole('button', { name: 'Move back into the composer' }).click();
    let previous = initial;
    for (let i = 0; i < 3; i++) {
      await edit();
      assert.equal(await input.inputValue(), text, 'reopening immediately keeps the complete suffix');
      text += ` FINAL_EDIT_${i}`;
      await input.fill(text); await input.press('Enter');
      const latest = await page.evaluate(() => window.sent.findLast(m => m.type === 'editQueuedTurn'));
      await post({ type: 'turnQueue', chatId: 'edit-tail', paused: false, turns: [{ ...previous, queued: true, editing: false }] });
      assert.equal(await page.locator(`[data-id="${initial.id}"] .turn-queue-text`).textContent(), text, 'a delayed shorter snapshot cannot replace the saved edit');
      previous = latest.turn;
    }
    await post({ type: 'turnQueue', chatId: 'edit-tail', paused: true, turns: [{ ...previous, queued: true, editing: false }] });
    await edit(); assert.equal(await input.inputValue(), text);
    await input.press('Enter');
    await post({ type: 'chatLoaded', chat: { id: 'sent-tail', messages: [{ role: 'user', text }] } });
    await page.locator('.msg-clamp-toggle').click();
    await page.waitForTimeout(500);
    const body = page.locator('.msg-user-text');
    assert.equal(await body.textContent(), text);
    assert.ok(await body.evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'expanded text is not clipped');
  } },
  { id: 'ready-scheduled-drag', height: 1100, focus: '.compose-row', setup: async page => {
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const now = await page.evaluate(() => Date.now());
    const base = { chatId: 'ready-drag', model: 'claude', modelId: 'claude-sonnet-5-5-high', status: 'pending', attachments: [] };
    const tasks = [
      { ...base, id: 'ready-one', prompt: 'First ready prompt', dispatchTrigger: 'quota-reset', notBefore: new Date(now + 1000).toISOString() },
      { ...base, id: 'ready-two', prompt: 'Second ready prompt', dispatchTrigger: 'quota-reset', notBefore: new Date(now + 1000).toISOString() },
      { ...base, id: 'future', prompt: 'Keep this later appointment', dispatchTrigger: 'fixed-time', dispatchTime: new Date(now + 600000).toISOString() },
    ];
    await post({ type: 'chatLoaded', chat: { id: base.chatId, modelId: base.modelId, messages: [{ role: 'user', text: 'Current task' }] }, running: { agentId: 'claude', startedAt: now } });
    await post({ type: 'quotas', quotas: { claude: { remaining: 80 } } });
    await post({ type: 'schedulerQueue', queue: tasks });
    assert.equal(await page.locator('.turn-queue-clock').count(), 3);
    assert.equal(await page.locator('.turn-queue-item .turn-queue-rank').count(), 3, 'scheduled rows show their place in the order');
    assert.equal(await page.locator('.turn-queue-when > :first-child').first().evaluate(el => el.classList.contains('turn-queue-clock')), true, 'the clock sits before the time'); 
    await page.clock.fastForward(2000);
    assert.equal(await page.locator('.turn-queue-clock').count(), 1, 'elapsed tasks drop the clock; every row keeps its number');
    await page.waitForFunction(() => !document.querySelector('.turn-queue-item.is-entering') && document.querySelector('.turn-queue-strip').getAnimations().every(a => a.playState !== 'running'));
    const first = page.locator('[data-task-id="ready-one"] .turn-queue-text');
    const target = page.locator('[data-task-id="ready-two"]');
    const from = await first.boundingBox(), to = await target.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 8, { steps: 2 }); // a row only lifts once the pointer has moved
    await post({ type: 'schedulerQueue', queue: structuredClone(tasks) });
    assert.equal(await page.locator('[data-task-id="ready-one"].is-dragging').count(), 1, 'queue snapshots preserve pointer capture');
    await page.mouse.move(to.x + from.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(message => message.type === 'reorderScheduledTasks').ids), ['ready-two', 'ready-one', 'future']);
    assert.deepEqual(await page.locator('.turn-queue-item').evaluateAll(rows => rows.map(row => row.dataset.taskId)), ['ready-two', 'ready-one', 'future']);
    assert.equal(await page.locator('[data-task-id="future"] .turn-queue-clock').count(), 1);
    await page.waitForTimeout(450);
  } },
  { id: 'queue-mixed-drag', height: 1100, focus: '.compose-row', setup: async page => {
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const now = await page.evaluate(() => Date.now());
    const base = { chatId: 'mixed-drag', model: 'claude', modelId: 'claude-sonnet-5-5-high', status: 'pending', attachments: [] };
    const tasks = [
      { ...base, id: 'due', prompt: 'Due scheduled prompt', dispatchTrigger: 'fixed-time', dispatchTime: new Date(now - 1000).toISOString() },
      { ...base, id: 'later', prompt: 'Scheduled for later', dispatchTrigger: 'fixed-time', dispatchTime: new Date(now + 600000).toISOString() },
    ];
    const turns = [{ id: 'q1', text: 'First queued prompt', modelId: base.modelId, attachments: [] }, { id: 'q2', text: 'Second queued prompt that is long enough to wrap onto a second line in the narrow strip', modelId: base.modelId, attachments: [] }];
    await post({ type: 'chatLoaded', chat: { id: base.chatId, modelId: base.modelId, messages: [{ role: 'user', text: 'Current task' }], turnQueue: { turns, paused: false } }, running: { agentId: 'claude', startedAt: now } });
    await post({ type: 'quotas', quotas: { claude: { remaining: 80 } } });
    await post({ type: 'schedulerQueue', queue: tasks });
    const keys = () => page.locator('.turn-queue-item').evaluateAll(rows => rows.map(row => row.dataset.queueKey));
    assert.deepEqual(await keys(), ['scheduled:due', 'scheduled:later', 'turn:q1', 'turn:q2']);
    assert.doesNotMatch(await page.locator('.turn-queue-strip').innerText(), /ready/i, 'there is no "ready" state');
    assert.match(await page.locator('.turn-queue-head > span').innerText(), /^3 queued .* 1 scheduled$/, 'the due prompt counts as queued');
    await page.waitForFunction(() => !document.querySelector('.turn-queue-item.is-entering') && document.querySelector('.turn-queue-strip').getAnimations().every(a => a.playState !== 'running'));
    // a queued turn dragged above both scheduled prompts
    const grip = page.locator('[data-queue-key="turn:q2"] .turn-queue-text');
    const from = await grip.boundingBox(), top = await page.locator('[data-queue-key="scheduled:due"]').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, top.y + 4, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await keys(), ['turn:q2', 'scheduled:due', 'scheduled:later', 'turn:q1']);
    const sent = await page.evaluate(() => window.sent.findLast(message => message.type === 'setQueueOrder'));
    assert.deepEqual(sent.order, ['turn:q2', 'scheduled:due', 'scheduled:later', 'turn:q1']);
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(message => message.type === 'reorderQueuedTurns').ids), ['q2', 'q1']);
    // The queued-only reorder echoes before the mixed-order save: its old rank must not flash back.
    await post({ type: 'turnQueue', chatId: base.chatId, paused: false, order: [], turns: [turns[1], turns[0]] });
    assert.deepEqual(await keys(), sent.order, 'an intermediate old order must not undo the visible drop');
    await page.waitForTimeout(100);
    assert.deepEqual(await keys(), sent.order, 'the optimistic order remains stable while acknowledgement is delayed');
    // the host echoes the order back: a snapshot must not undo it
    await post({ type: 'turnQueue', chatId: base.chatId, paused: false, order: sent.order, turns: [turns[1], turns[0]] });
    assert.deepEqual(await keys(), ['turn:q2', 'scheduled:due', 'scheduled:later', 'turn:q1']);
    // and a scheduled prompt dragged below the last queued one
    await page.waitForTimeout(450); // the dropped row is still gliding into its slot
    const g2 = page.locator('[data-queue-key="scheduled:later"] .turn-queue-text');
    const f2 = await g2.boundingBox(), bottom = await page.locator('[data-queue-key="turn:q1"]').boundingBox();
    await page.mouse.move(f2.x + f2.width / 2, f2.y + f2.height / 2);
    await page.mouse.down();
    await page.mouse.move(f2.x + f2.width / 2, bottom.y + bottom.height - 4, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await keys(), ['turn:q2', 'scheduled:due', 'turn:q1', 'scheduled:later']);
    const nextOrder = await page.evaluate(() => window.sent.findLast(message => message.type === 'setQueueOrder').order);
    await post({ type: 'turnQueue', chatId: base.chatId, paused: false, order: sent.order, turns: [turns[1], turns[0]] });
    assert.deepEqual(await keys(), nextOrder, 'a late acknowledgement of the first drag cannot undo the second drag');
    await post({ type: 'turnQueue', chatId: base.chatId, paused: false, order: nextOrder, turns: [turns[1], turns[0]] });
    await post({ type: 'turnQueue', chatId: base.chatId, paused: false, order: sent.order, turns: [turns[1], turns[0]] });
    assert.deepEqual(await keys(), sent.order, 'after acknowledgement, later host reorders are accepted');
    await post({ type: 'turnQueue', chatId: base.chatId, paused: false, order: nextOrder, turns: [turns[1], turns[0]] });
    await page.waitForTimeout(450);
  } },
  { id: 'schedule-pill-chats', sidebar: true, height: 900, focus: '#queueBtn .sched-pill', setup: async page => {
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const now = await page.evaluate(() => Date.now());
    const at = minutes => new Date(now + minutes * 60000).toISOString();
    const task = (id, chatId, minutes) => ({ id, chatId, model: 'claude', modelId: 'claude-sonnet-5-5-high', status: 'pending', attachments: [], prompt: id, dispatchTrigger: 'fixed-time', dispatchTime: at(minutes) });
    await post({ type: 'project', projects: [{ id: 'p1', name: 'Clanker Controller' }, { id: 'p2', name: 'Visor Customer Edit Mode' }], project: { id: 'p1', name: 'Clanker Controller' }, chatId: 'c1' });
    await post({ type: 'history', sessions: [{ id: 'c1', title: 'Add login check', projectId: 'p1', models: ['gemini'], updatedAt: at(0) }, { id: 'c2', title: 'Customer edit mode', projectId: 'p2', models: ['claude'], updatedAt: at(0) }, { id: 'c3', title: 'No project here', models: ['codex'], updatedAt: at(0) }] });
    await post({ type: 'chatLoaded', chat: { id: 'c1', modelId: 'claude-sonnet-5-5-high', messages: [{ role: 'user', text: 'Hello' }] } });
    // One chat still gets a preview rather than only the generic Queue tooltip.
    await post({ type: 'schedulerQueue', queue: [task('a1', 'c1', 60), task('a2', 'c1', 70)] });
    const pill = page.locator('#queueBtn');
    await pill.hover();
    assert.equal(await pill.evaluate(el => el.classList.contains('is-sched-open')), true, 'one chat opens its preview');
    assert.equal(await page.locator('.sched-pill-row').count(), 1);
    assert.equal(await page.locator('#queueBtn .round-btn-tip').isVisible(), false);
    const firstRow = await page.locator('.sched-pill-row').elementHandle();
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => !document.querySelector('#queueBtn').classList.contains('is-sched-open'));
    await pill.hover();
    assert.equal(await firstRow.evaluate(el => el === document.querySelector('.sched-pill-row')), true, 'reopening reuses the preview rows');
    // several chats: hovering grows the pill into one card, a child of the pill, with a row per chat
    await post({ type: 'schedulerQueue', queue: [task('a1', 'c1', 60), task('a2', 'c1', 70), task('b1', 'c2', 65), task('c1t', 'c3', 80)] });
    await page.mouse.move(5, 5);
    await pill.hover();
    await page.waitForFunction(() => document.querySelector('#queueBtn .sched-pill').getBoundingClientRect().width > 250);
    assert.equal(await page.locator('#queueBtn > .sched-pill .sched-pill-row').count(), 3);
    assert.deepEqual(await page.locator('.sched-pill-row').evaluateAll(rows => rows.map(row => !!row.querySelector('.history-project-icon'))), [true, true, false], 'the project icon, or the agent logo without a project');
    assert.equal(await page.locator('.sched-pill-agent svg').count(), 1);
    const box = await pill.boundingBox(), card = await page.locator('.sched-pill').boundingBox();
    assert.ok(Math.abs(card.x + card.width - (box.x + box.width)) <= 2 && card.y <= box.y + 1, 'the card shares the pill\'s top right corner');
    await page.locator('.sched-pill-row').nth(1).click();
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(message => message.type === 'restoreChat').id), 'c2');
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => !document.querySelector('#queueBtn').classList.contains('is-sched-open'));
    await pill.hover();
    await page.waitForFunction(() => document.querySelector('#queueBtn .sched-pill').getBoundingClientRect().width > 250);
    await page.waitForTimeout(700);
  } },
  { id: 'queue-reset-aligned', focus: '.compose-row', setup: async page => {
    const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
    const { SchedulerQueue } = createRequire(import.meta.url)('../../lib/scheduler-queue');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clanker-reset-ui-'));
    const queue = new SchedulerQueue({ workspaceDir: root, sessionDir: root });
    try {
      const now = await page.evaluate(() => Date.now());
      for (const [index, offset] of [11000, 71000, 11000].entries()) {
        await queue.enqueue({ model: 'claude', modelId: 'claude-sonnet-5-5-high', chatId: 'aligned-reset', prompt: `Queued task ${index + 1}`, dispatchTrigger: 'quota-reset', notBefore: new Date(now + offset).toISOString() });
      }
      const tasks = await queue.getQueue();
      await page.evaluate(({ tasks, now }) => {
        const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
        post({ type: 'chatLoaded', chat: { id: 'aligned-reset', modelId: 'claude-sonnet-5-5-high', messages: [] } });
        post({ type: 'quotas', quotas: { claude: { remaining: 0, resetsAt: now / 1000 + 71 } } });
        post({ type: 'schedulerQueue', queue: tasks });
      }, { tasks, now });
      const labels = await page.locator('.turn-queue-when').allTextContents();
      assert.equal(labels.length, 3);
      assert.equal(new Set(labels).size, 1, 'all prompts waiting for one reset show the same countdown');
      await page.clock.fastForward(12000);
      assert.equal(new Set(await page.locator('.turn-queue-when').allTextContents()).size, 1, 'the old minute boundary does not split the rows');
    } finally { queue.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  } },
  { id: 'chatgpt-sync', focus: '#transcript', setup: async page => {
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const chat = { id: 'external-sync', modelId: 'gpt-6.1-sol-medium', messages: [{ role: 'user', text: 'Original task' }, { role: 'assistant', agent: 'codex', text: 'Original answer' }] };
    await post({ type: 'chatLoaded', chat });
    await page.locator('#promptInput').fill('My unsent draft');
    const { mergeTurns } = createRequire(import.meta.url)('../../lib/codex-chat-sync');
    const synced = { ...chat, sessions: { codex: { id: 'native-thread' } }, messages: [...chat.messages] };
    const wrapped = "The model was selected manually. Earlier Auto-mode role restrictions no longer apply. Follow the user's current request.\n\nPROJECT: Wittmann Website\n\nContinued in ChatGPT";
    mergeTurns(synced, [{ id: 'anchor', status: 'completed', items: [] }, { id: 'remote', status: 'completed', startedAt: 100, items: [
      { id: 'user-item', type: 'userMessage', content: [{ type: 'text', text: wrapped }] },
      { id: 'reply-item', type: 'agentMessage', text: 'The latest answer from ChatGPT.' },
    ] }], 'anchor');
    const update = { type: 'chatSynced', chat: synced };
    await post(update);
    assert.equal(await page.locator('#promptInput').inputValue(), 'My unsent draft');
    assert.equal(await page.locator('.msg-user').count(), 2);
    assert.match(await page.locator('#transcript').innerText(), /latest answer from ChatGPT/);
    assert.doesNotMatch(await page.locator('#transcript').innerText(), /Earlier Auto-mode|PROJECT: Wittmann/);
    assert.equal(await page.locator('.msg-user').last().innerText(), 'Continued in ChatGPT');
    await post(update);
    assert.equal(await page.locator('.msg-user').count(), 2, 'repeated snapshots do not duplicate messages');
    await post({ ...update, chat: { ...update.chat, id: 'a-different-chat' } });
    assert.equal(await page.locator('.msg-user').count(), 2, 'an update for another chat is ignored');
  } },
  { id: 'sent-bubble-confirmation', focus: '#transcript', setup: async page => {
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const chat = { id: 'send-race', modelId: 'gpt-6.1-sol-medium', messages: [] };
    await post({ type: 'chatLoaded', chat });
    await page.locator('#promptInput').fill('Keep my submitted prompt visible');
    await page.locator('#sendBtn').click();
    const clientTurnId = await page.locator('.msg-group-user').getAttribute('data-client-turn-id');
    assert.ok(clientTurnId);
    const confirmation = { type: 'userMessage', clientTurnId, text: 'Keep my submitted prompt visible', files: [] };
    await post(confirmation);
    assert.equal(await page.locator('.msg-user').count(), 1, 'normal host confirmation does not duplicate the optimistic bubble');
    // A replay arrives while the host is still preparing the send, before it saved the user record.
    await post({ type: 'chatLoaded', chat });
    assert.equal(await page.locator('.msg-user').count(), 0);
    await post(confirmation);
    await post({ type: 'routing', agentId: 'codex' });
    await post({ type: 'delta', agent: 'codex', text: 'The submitted prompt is visible while I work.' });
    assert.equal(await page.locator('.msg-user').count(), 1, 'confirmation repairs the missing local bubble');
    await post({ type: 'chatLoaded', chat: { ...chat, messages: [{ role: 'user', text: confirmation.text, clientTurnId }] } });
    await post(confirmation);
    assert.equal(await page.locator('.msg-user').count(), 1, 'replayed confirmations are idempotent after chat restoration');
  } },
  { id: 'provider-countdown', focus: '.compose-row', setup: async page => {
    const post = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    await post({ type: 'chatLoaded', chat: { id: 'countdown-chat', modelId: 'claude-sonnet-5-5-high', messages: [] } });
    // Model still has usage and current draft is not scheduled: already-sent timers stay out of the composer clock.
    await post({ type: 'quotas', quotas: { claude: { remaining: 80, resetsAt: Date.now() / 1000 + 1800 }, codex: { remaining: 80 } } });
    await post({ type: 'schedulerQueue', queue: [{ id: 'claude-wait', chatId: 'countdown-chat', model: 'claude', prompt: 'continue', status: 'pending', dispatchTrigger: 'fixed-time', dispatchTime: new Date(Date.now() + 7200000).toISOString(), attachments: [] }] });
    assert.equal(await page.locator('.schedule-time').innerText(), '', 'already-sent scheduled timer does not duplicate in the composer while Claude has usage');
    assert.equal(await page.locator('.composer.is-scheduled').count(), 0);
    // Out of usage on Claude auto-arms scheduling; switching to Codex (with usage) clears the composer countdown.
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'quotas', quotas: { claude: { remaining: 0, resetsAt: Date.now() / 1000 + 1800 }, codex: { remaining: 80 } } } })));
    await page.waitForFunction(() => document.querySelector('.schedule-time').textContent !== '');
    await page.locator('#modelPill').click();
    await page.locator('.model-option[data-agent="codex"]').first().click();
    assert.equal(await page.locator('.schedule-time').innerText(), '', 'GPT does not inherit the Claude reset countdown');
    assert.equal(await page.locator('.composer.is-scheduled').count(), 0);
    assert.match(await page.locator('.turn-queue-when').innerText(), /\d/, 'the Claude queue row keeps its scheduled time');
  } },
  ...['waiting', 'changed'].map(state => ({ id: `provider-switch-${state}`, focus: '.compose-row', setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const modelId = 'claude-sonnet-5-5-high';
      post({ type: 'chatLoaded', chat: { id: 'switch-chat', modelId, messages: [] } });
      post({ type: 'quotas', quotas: { claude: { remaining: 0, resetsAt: Date.now() / 1000 + 10800 }, codex: { remaining: 80 } } });
      post({ type: 'schedulerQueue', queue: [{ id: 'switch-task', chatId: 'switch-chat', model: 'claude', modelId, prompt: 'continue', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: new Date(Date.now() + 10800000).toISOString(), attachments: [] }] });
    });
    const change = page.getByRole('button', { name: 'Change model', exact: true });
    await change.waitFor();
    if (state === 'changed') {
      await change.click();
      // Simulate the host's durable editing hold and draft restoration.
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'restoreScheduledDraft', taskId: 'switch-task', text: 'continue', modelId: 'claude-sonnet-5-5-high', chooseModel: true, files: [] } })));
      await page.locator('.model-option[data-agent="codex"]').first().click();
      assert.equal(await page.locator('#promptInput').inputValue(), 'continue');
      assert.equal(await page.locator('.schedule-time').innerText(), '', 'old provider reset disappears on model change');
      assert.equal(await page.locator('#sendBtn').isEnabled(), true);
    }
  } })),
  { id: 'provider-switch-agy', focus: '.compose-row', setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const sonnet = 'gemini:claude-sonnet-5-5-high';
      const orchestrator = 'gemini-pro-orchestrator-g1-pro';
      post({ type: 'modelCatalog', catalog: [
        { id: sonnet, agent: 'gemini', model: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 High', shortLabel: 'Sonnet', company: 'Anthropic' },
        { id: orchestrator, agent: 'gemini', model: orchestrator, label: 'Orchestrator', shortLabel: 'Orchestrator', company: 'Google' },
      ], available: [
        { id: sonnet, agent: 'gemini', model: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 High', shortLabel: 'Sonnet', company: 'Anthropic' },
        { id: orchestrator, agent: 'gemini', model: orchestrator, label: 'Orchestrator', shortLabel: 'Orchestrator', company: 'Google' },
      ] });
      post({ type: 'chatLoaded', chat: { id: 'agy-switch-chat', modelId: sonnet, messages: [
        { role: 'user', text: 'Run checks' },
        { role: 'assistant', agent: 'gemini', modelLabel: 'Claude Sonnet 5.5 High', text: 'Gemini error: RESOURCE_EXHAUSTED: Individual quota reached. Resets in 4h40m5s.' },
      ] } });
      post({ type: 'quotas', quotas: { gemini: { remaining: 80, resetsAt: Date.now() / 1000 + 18000 }, antigravityClaudeGpt: { remaining: 0, resetsAt: Date.now() / 1000 + 16805 } } });
      post({ type: 'schedulerQueue', queue: [{ id: 'agy-task', chatId: 'agy-switch-chat', model: 'gemini', modelId: sonnet, prompt: 'continue', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: new Date(Date.now() + 16805000).toISOString(), attachments: [] }] });
    });
    assert.equal(await page.locator('[data-task-id="agy-task"] .is-primary').isDisabled(), true, 'Send Now is disabled while waiting for Sonnet reset');
    await page.getByRole('button', { name: 'Change model', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'restoreScheduledDraft', taskId: 'agy-task', text: 'continue', modelId: 'gemini:claude-sonnet-5-5-high', chooseModel: true, files: [] } })));
    await page.locator('.model-option[data-model-id="gemini-pro-orchestrator-g1-pro"]').click();
    assert.equal(await page.locator('.schedule-time').innerText(), '', 'old Antigravity model reset disappears on switching to Orchestrator');
    assert.equal(await page.locator('.composer.is-scheduled').count(), 0, 'composer disarms when target model has quota');
    await page.locator('#sendBtn').click();
    assert.equal(await page.evaluate(() => window.sent.findLast(m => m.type === 'saveScheduledDraft')?.clearReset), true, 'confirming a model with quota clears the old reset wait');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'schedulerQueue', queue: [{ id: 'agy-task', chatId: 'agy-switch-chat', model: 'gemini', modelId: 'gemini-pro-orchestrator-g1-pro', prompt: 'continue', status: 'pending', dispatchTrigger: 'fixed-time', dispatchTime: new Date(Date.now() - 1000).toISOString(), attachments: [] }] } })));
    assert.equal(await page.locator('[data-task-id="agy-task"] .is-primary').isEnabled(), true, 'Send Now is enabled once retargeted to Orchestrator');
  } },
  { id: 'edit-scheduled-unschedule', focus: '.compose-row', setup: async page => {
    const dispatchTime = new Date(Date.now() + 7200000).toISOString();
    await page.evaluate((when) => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'chatLoaded', chat: { id: 'unschedule-edit-chat', modelId: 'gpt-6.1-sol-high', messages: [{ role: 'user', text: 'Working' }] } });
      post({ type: 'routing', agentId: 'codex' });
      post({ type: 'quotas', quotas: { codex: { remaining: 75, resetsAt: Date.now() / 1000 + 3600 } } });
      post({ type: 'schedulerQueue', queue: [{ id: 'sched-later', chatId: 'unschedule-edit-chat', model: 'codex', modelId: 'gpt-6.1-sol-high', prompt: 'Run after removing schedule', status: 'pending', dispatchTrigger: 'fixed-time', dispatchTime: when, attachments: [] }] });
    }, dispatchTime);
    await page.getByRole('button', { name: 'Move back into the composer', exact: true }).click();
    await page.evaluate((when) => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'restoreScheduledDraft', taskId: 'sched-later', text: 'Run after removing schedule', modelId: 'gpt-6.1-sol-high', files: [],
      schedule: { dispatchTrigger: 'fixed-time', dispatchTime: when },
    } })), dispatchTime);
    assert.equal(await page.locator('.composer.is-scheduled').count(), 1, 'editing shows the prompt is scheduled');
    assert.equal(await page.locator('#scheduleBtn').getAttribute('data-mode'), 'calendar');
    assert.notEqual(await page.locator('.schedule-time').innerText(), '');
    // Hovering opens the calendar pill with a one-click Off button, and clicking the clock also cycles back to off.
    await page.locator('#scheduleBtn').hover();
    await page.locator('.timer-off').click();
    assert.equal(await page.locator('#scheduleBtn').getAttribute('data-mode'), 'off');
    assert.equal(await page.locator('.composer.is-scheduled').count(), 0);
    await page.locator('#scheduleBtn').click();
    assert.equal(await page.locator('#scheduleBtn').getAttribute('data-mode'), 'reset');
    for (let i = 0; i < 3; i++) await page.locator('#scheduleBtn').click();
    assert.equal(await page.locator('#scheduleBtn').getAttribute('data-mode'), 'off');
    assert.equal(await page.locator('.composer.is-scheduled').count(), 0, 'turning scheduling off clears the highlight');
    assert.equal(await page.locator('.schedule-time').innerText(), '');
    assert.equal(await page.locator('#sendBtn').getAttribute('data-mode'), 'queue', 'busy chat switches button to Queue once unscheduled');
    await page.locator('#sendBtn').click();
    assert.equal(await page.evaluate(() => window.sent.findLast(m => m.type === 'cancelScheduledTask')?.taskId), 'sched-later');
    assert.equal(await page.evaluate(() => window.sent.findLast(m => m.type === 'queueTurn')?.turn?.text), 'Run after removing schedule');
    await page.mouse.move(5, 5); // the send click leaves the pointer on the mic flyout, which would then cover the last queue row
  } },
  { id: 'bridge-agents', focus: MODAL, setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'subagent_start', id: 'bridge:demo', agent: 'codex', model: 'GPT-6.1-Sol', effort: 'medium', external: true, description: 'Check interview sources', subagentType: 'Cross-vendor task', prompt: 'Read the original interview and report verified findings.' });
      post({ type: 'subagent_status', id: 'bridge:demo', status: 'background' });
      post({ type: 'turn_complete' });
    });
    await page.locator('#agentsBtn').click();
    await page.getByText('Cross-vendor task · GPT-6.1-Sol · medium', { exact: true }).waitFor();
    assert.match(await page.locator('#agentsModal').innerText(), /Working in the background/);
  } },
  { id: 'usage-unavailable-rest', sidebar: true, focus: '.model-cards', setup: async page => {
    await unavailable(page);
    assert.equal(await page.locator('.model-card-codex .model-card-5h').innerText(), 'Not available');
    assert.equal(await page.locator('.model-card-claude .model-card-5h').innerText(), '72%');
    assert.equal(await page.locator('.model-card.is-faulty').count(), 2);
    await page.waitForTimeout(500); // the ring colour eases to red
    assert.equal(await page.locator('.model-card-codex .ring-fill').first().evaluate(el => getComputedStyle(el).stroke), 'rgb(255, 69, 58)');
  } },
  { id: 'usage-unavailable-hover', sidebar: true, focus: '.model-card-codex .ring-pill', setup: async page => {
    await unavailable(page);
    await page.locator('.model-card-codex .ring').hover();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.model-card-codex .ring-fault-code').innerText(), 'Exit code 1');
    assert.equal(await page.locator('.model-card-codex .ring-fault-title').innerText(), 'Not signed in');
    const button = page.locator('.model-card-codex .ring-fault-btn');
    assert.equal(await button.innerText(), 'Sign in');
    const pill = await page.locator('.model-card-codex .ring-pill').boundingBox(), box = await button.boundingBox();
    assert.ok(box.x >= pill.x && box.x + box.width <= pill.x + pill.width && box.y >= pill.y && box.y + box.height <= pill.y + pill.height, 'the button stays inside the pill');
    await button.click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'connectCli', agent: 'codex' });
    await page.locator('.model-card-codex .ring').hover();
    await page.waitForTimeout(300);
  } },
  { id: 'usage-unavailable-hover-antigravity', sidebar: true, focus: '.model-card-gemini .ring-pill', setup: async page => {
    await unavailable(page);
    await page.locator('.model-card-gemini .ring').hover();
    await page.waitForTimeout(900);
    const pill = await page.locator('.model-card-gemini .ring-pill').boundingBox();
    assert.ok(pill.width < 420, 'a fault pill is not the wide two-pool pill');
    assert.equal(await page.locator('.model-card-gemini .ring-fault-btn').innerText(), 'Repair & sign in');
  } },
  { id: 'usage-spent-hover', sidebar: true, focus: '.model-card-claude .ring-pill', setup: async page => {
    await page.evaluate(() => {
      for (const method of ['estimate', 'describe']) {
        const original = window.burnRate[method];
        window.burnRate[method] = quota => {
          if (quota?.remaining === 0 && quota.resetsAt * 1000 > Date.now()) throw new Error('Exhausted usage must skip burn-rate calculations');
          return original(quota);
        };
      }
      window.setUsageRemaining = remaining => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'quotas', quotas: { claude: { remaining, used: 100 - remaining, windowMinutes: 300,
          resetsAt: Date.now() / 1000 + 420, secondary: { remaining: 26, resetsAt: Date.now() / 1000 + 97200 } } },
      } }));
      window.setUsageRemaining(0);
    });
    const burn = page.locator('.model-card-claude .ring-burn');
    assert.equal(await burn.locator('.ring-burn-val').innerText(), 'Usage is spent');
    assert.equal(await burn.locator('.ring-burn-label').textContent(), '');
    assert.doesNotMatch(await page.locator('.model-card-claude .ring').getAttribute('aria-label'), /Average|%\/h|Measuring/);
    await page.evaluate(() => window.setUsageRemaining(80));
    assert.doesNotMatch(await burn.getAttribute('class'), /is-spent/);
    assert.notEqual(await burn.locator('.ring-burn-label').textContent(), '');
    await page.evaluate(() => window.setUsageRemaining(0));
    await page.locator('.model-card-claude .ring').hover();
    await page.waitForTimeout(900);
  } },
  ...[1, 2].flatMap(count => ['updating', 'done'].map(state => ({
    id: `cli-update-${count}-${state}`, sidebar: true, focus: '#updatesBtn .upd-pill',
    setup: async page => {
      await page.evaluate(({ count, state }) => {
        const agents = ['claude', 'codex'].slice(0, count);
        const post = data => window.dispatchEvent(new MessageEvent('message', { data: {
          checking: false, notes: {}, catalog: [], prompts: {}, modelSettings: {}, fetched: [], favorites: [], modelsBusy: false, ...data,
        } }));
        const versions = Object.fromEntries(agents.map(agent => [agent, { version: '2.1.306', latest: '2.1.308', outdated: true }]));
        post({ type: 'cliStatus', versions, updates: agents,
          updating: Object.fromEntries(agents.map(agent => [agent, { startedAt: Date.now() - 8000, estimateMs: 20000 }])) });
        if (state === 'done') post({ type: 'cliStatus', updates: [], updating: {},
          versions: Object.fromEntries(agents.map(agent => [agent, { version: '2.1.308', latest: '2.1.308' }])),
          notes: Object.fromEntries(agents.map(agent => [agent, { ok: true }])) });
        document.getElementById('updatesBtn').classList.add('is-peek');
      }, { count, state });
      await page.waitForTimeout(900);
      const button = page.locator('#updatesBtn');
      await button.evaluate(el => el.click());
      assert.equal(await page.evaluate(() => window.sent.at(-1)?.type), 'updateAllClis');
      assert.equal(await page.locator('#settingsModal').isVisible(), false);
      assert.equal(await button.locator('.upd-row').count(), count);
      assert.equal(await button.locator('.upd-status').isVisible(), false);
      const circle = await button.boundingBox(), pill = await button.locator('.upd-pill').boundingBox();
      assert.ok(Math.abs(pill.y - circle.y) < 1, 'top-right curves share a centre');
      if (count === 1) {
        assert.ok(Math.abs(pill.height - circle.height) < 1, 'one row is a perfect pill');
        assert.equal(await button.locator('.upd-pct').isVisible(), false);
      }
      if (state === 'done') assert.equal(await button.locator('.upd-bar b').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(125, 227, 181)');
    },
  }))),
  { id: 'recent-context-hover', sidebar: true, height: 1100, focus: '.history-item', setup: async page => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', sessions: [{
      id: 'hover-context', title: 'Conditional Hide Comment Button', models: ['claude'], latestAgent: 'claude',
      projectName: 'Visor', updatedAt: '2026-10-29T12:00:00Z',
      workContext: { version: 1, categoryId: 'frontend' },
      lastMessage: { role: 'assistant', agent: 'claude', text: 'Markup and logic are in place.' },
    }] } })));
    const item = page.locator('.history-item');
    const badge = item.locator('.history-context');
    await badge.waitFor({ state: 'visible' });
    await item.hover();
    await badge.waitFor({ state: 'hidden' });
    await page.waitForTimeout(750);
    assert.equal(await item.locator('.history-peek-context').innerText(), 'Interface');
    assert.equal(await item.locator('.history-peek-context svg').isVisible(), true);
  } },
  { id: 'project-rail-three', sidebar: true, height: 1050, focus: '.project-pill', scope: '.project-pill', setup: async page => {
    const projects = ['a', 'b', 'c', 'd'].map(id => ({ id, name: `Project ${id.toUpperCase()}`, root: `C:/projects/${id}` }));
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const ids = () => page.locator('.project-item[data-id]').evaluateAll(items => items.map(item => item.dataset.id));
    const select = (id, pinnedProjectIds = ['b']) => post({ type: 'project', projects, project: projects.find(project => project.id === id), pinnedProjectIds });
    await post({ type: 'history', sessions: [{ id: 'recent-d', projectId: 'd', updatedAt: '2026-11-17T10:00:00Z' }, { id: 'older-c', projectId: 'c', updatedAt: '2026-11-16T10:00:00Z' }] });
    await select('a');
    assert.deepEqual(await ids(), ['b', 'a', 'd']);
    const height = await page.locator('.project-pill').evaluate(el => el.offsetHeight);
    await select('b');
    assert.deepEqual(await ids(), ['b', 'd', 'c'], 'a pinned current project still leaves three unique tiles');
    assert.equal(await page.locator('.project-pill').evaluate(el => el.offsetHeight), height);
    await select('a', []);
    assert.deepEqual(await ids(), ['a', 'd', 'c'], 'without pins, recent projects fill the rail');
    await post({ type: 'history', sessions: [] });
    assert.equal((await ids()).length, 3, 'unused registered projects fill missing history slots');
    await post({ type: 'project', projects: projects.slice(0, 2), project: projects[0], pinnedProjectIds: [] });
    assert.deepEqual(await ids(), ['a', 'b'], 'fewer than three projects render without duplicates');
    await select('b');
    await page.waitForTimeout(700);
  } },
  { id: 'sidebar-loading', sidebar: true, height: 1500, focus: '.rail', setup: async page => {
    const projects = page.locator('.project-pill');
    const recent = page.locator('#historyList');
    assert.equal(await projects.getAttribute('aria-busy'), 'true');
    assert.equal(await recent.getAttribute('aria-busy'), 'true');
    assert.doesNotMatch(await page.locator('.rail').evaluate(el => getComputedStyle(el).backgroundImage), /repeating-linear-gradient/, 'no diagonal hatching behind the rail');
    assert.equal(await recent.locator('.history-row.skeleton').first().evaluate(el => ({ anim: getComputedStyle(el).animationName, bg: getComputedStyle(el).backgroundImage })).then(s => s.anim === 'skeleton-shimmer' && s.bg.includes('linear-gradient')), true, 'recent chat skeleton rows shimmer before history arrives');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await projects.locator('.skeleton').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await recent.locator('.history-row.skeleton').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    // When history lands before projects, recent tiles show a shimmer mark instead of blank tiles.
    await send({ type: 'history', sessions: [{ id: 'proj-wait', projectId: 'p1', title: 'Waiting project icon', models: ['codex'], updatedAt: '2026-03-02T07:58:00Z' }] });
    assert.equal(await recent.locator('.history-row .rail-skeleton-mark.skeleton').count(), 1, 'recent tile mark shimmers while projects are still loading');
    assert.equal(await recent.locator('.history-row .rail-skeleton-mark.skeleton').evaluate(el => getComputedStyle(el).animationName), 'skeleton-shimmer');
    await send({ type: 'history', sessions: [] });
    assert.equal(await recent.locator('.rail-skeleton').count(), 0, 'empty history finishes loading');
    assert.equal(await recent.getAttribute('aria-busy'), null);
    assert.equal(await projects.getAttribute('aria-busy'), 'true', 'history does not finish project loading');
    await send({ type: 'project', projects: [], project: null });
    assert.equal(await projects.locator('.rail-skeleton').count(), 0);
    assert.equal(await projects.getAttribute('aria-busy'), null);
    await page.getByRole('button', { name: 'Choose project', exact: true }).waitFor();
    await send({ type: 'history', sessions: [{ id: 'loaded', title: 'Loaded chat', models: ['codex'], updatedAt: '2026-03-02T07:00:00Z' }] });
    assert.equal(await recent.locator('.history-item').count(), 1);
    assert.equal(await recent.locator('.rail-skeleton').count(), 0);
    await page.reload(); // capture the actual startup state before either independent response
    await page.locator('.project-pill[aria-busy="true"]').waitFor();
  } },
  { id: 'antigravity-usage-hover', sidebar: true, focus: '.model-card-gemini .ring-pill', setup: async page => {
    const send = withArgon => page.evaluate(withArgon => {
      const now = Date.now() / 1000;
      const quota = (remaining, minutes, reset) => ({ remaining, used: 100 - remaining, windowMinutes: minutes, resetsAt: now + reset });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'quotas', quotas: {
        gemini: { ...quota(80, 300, 6600), secondary: quota(65, 10080, 180000) },
        antigravityClaudeGpt: { ...quota(18, 300, 7200), secondary: quota(42, 10080, 260000) },
        ...(withArgon ? { antigravityArgon: quota(100, 10080, 610000) } : {}),
      } } }));
    }, withArgon);
    await send(false);
    if (!(await page.locator('.model-card-gemini .ring-rows-argon').isHidden())) throw Error('Without an Argon pool its group must disappear');
    await send(true);
    await page.locator('.model-card-gemini .ring').hover();
    await page.waitForTimeout(900);
    const groups = page.locator('.model-card-gemini .ring-rows');
    const boxes = [await groups.nth(0).boundingBox(), await groups.nth(1).boundingBox(), await groups.nth(2).boundingBox()];
    boxes.forEach((box, i) => {
      if (!box || (i && (box.x < boxes[i - 1].x + boxes[i - 1].width || Math.abs(box.y - boxes[0].y) > 1))) throw Error(`Antigravity quota groups must sit side by side: ${JSON.stringify(boxes)}`);
    });
    const pill = await page.locator('.model-card-gemini .ring-pill').boundingBox();
    if (boxes[2].x + boxes[2].width > pill.x + pill.width) throw Error('The Argon group must stay inside the pill');
    const values = await page.locator('.model-card-gemini .ring-row-pct').allTextContents();
    if (values.join(',') !== '80%,65%,18%,42%,100%') throw Error('Antigravity quota values mixed between pools');
    // The circle defaults to the split: one arc per pool (Gemini, Argon), each with its own number under the ring. The choice in
    // Settings swaps in one pool; a missing Argon leaves one arc (split) or falls back to Gemini's rings (Argon alone).
    const card = page.locator('.model-card-gemini');
    const state = async () => [await card.evaluate(el => el.classList.contains('is-split')), await card.evaluate(el => el.classList.contains('ring-single')), await card.locator('.model-card-5h').textContent(), await card.locator('.split-pct').allTextContents()];
    const ring = async value => { await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: { type: 'antigravityRing', value } })), value); return state(); };
    assert.deepEqual(await state(), [true, false, '65%', ['80', '100']]);
    assert.deepEqual(await ring('gemini'), [false, false, '80%', ['80', '100']]);
    assert.deepEqual(await ring('claude-gpt'), [false, false, '18%', ['80', '100']]);
    assert.deepEqual(await ring('argon'), [false, true, '100%', ['80', '100']]);
    assert.deepEqual(await ring('split'), [true, false, '65%', ['80', '100']]);
    await send(false);
    assert.deepEqual(await state(), [true, false, '65%', ['80']]);
    await ring('argon');
    assert.deepEqual(await state(), [false, false, '80%', ['80']]);
    await ring('split');
    await send(true);
  } },
  { id: 'loops-sidebar', sidebar: true, height: 1400, focus: '#loopsModal .fs-modal-sheet', setup: loopsState('running') },
  { id: 'chat-empty' },
  { id: 'chat-window-restored', setup: async page => {
    assert.ok(await page.evaluate(() => window.sent.some(message => message.type === 'chatReady')));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'chatLoaded', chat: { id: 'restored-pop-out', draft: 'Continue checking this project', messages: [
        { role: 'user', text: 'Keep this conversation in its own window.' },
        { role: 'assistant', text: 'This is the restored conversation.' },
      ] },
    } })));
    await page.getByText('This is the restored conversation.', { exact: true }).waitFor();
    assert.equal(await page.locator('#promptInput').inputValue(), 'Continue checking this project');
  } },
  { id: 'message-clamped', focus: '#transcript', setup: page => messageDock(page) },
  { id: 'message-expanded', focus: '#transcript', setup: page => messageDock(page, { expanded: true }) },
  { id: 'message-dock-hover', focus: '#transcript', setup: page => messageDock(page, { dock: true }) },
  { id: 'chat-paged-history', height: 1000, setup: pagedHistory },
  { id: 'chat-dialog-budget', height: 1000, focus: '#historyModal .fs-modal-sheet', setup: hiddenDialogs },
  { id: 'streamed-reply-chunks', height: 1000, setup: async page => {
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const first = ['I', '’ll', ' inspect', ' the', ' original', ' screenshot', ',', ' trace', ' the', ' cause', '.', '\n\n', 'Then', ' verify', ' **the', ' fix**', '.'];
    const second = ['The', ' response', ' now', ' stays', ' together', '.'];
    await send({ type: 'chatLoaded', chat: { id: 'streamed-reply', messages: [{ role: 'user', text: 'Inspect this screenshot and fix the response formatting.' }] }, running: { agentId: 'codex', modelLabel: 'GPT 6.1 Sol Medium', startedAt: Date.now() } });
    // Separate browser tasks allow the Thinking pill's MutationObserver to run between every chunk.
    for (const text of first) await send({ type: 'delta', model: 'codex', text });
    const bubbles = page.locator('.msg-assistant');
    if (await bubbles.count() !== 1) throw Error('Streamed chunks were split into separate reply bubbles');
    if (await bubbles.first().getAttribute('data-raw') !== first.join('')) throw Error('Streaming lost spaces or paragraph breaks');
    await page.waitForFunction(() => document.querySelectorAll('.msg-assistant .msg-body p').length === 2, null, { timeout: 3000 }).catch(() => {}); // the body renders on the next frame
    if (await bubbles.first().locator('.msg-body p').count() !== 2) throw Error('Markdown paragraphs were changed');
    if (await bubbles.first().locator('strong').textContent() !== 'the fix') throw Error('Markdown split across chunks was broken');
    await page.locator('.msg-pending').waitFor({ state: 'visible' });
    await send({ type: 'tool_start', toolId: 'check', name: 'bash', command: 'npm.cmd run check' });
    await send({ type: 'tool_end', toolId: 'check', output: 'Passed' });
    for (const text of second) await send({ type: 'delta', model: 'codex', text });
    if (await bubbles.count() !== 2) throw Error('A real tool boundary must create exactly one continued reply');
    if (await bubbles.last().getAttribute('data-raw') !== second.join('')) throw Error('Continued reply chunks were changed');
    await send({ type: 'turn_complete', agent: 'codex' });
    if (await page.locator('.msg-pending').count()) throw Error('Thinking must end with the turn');
  } },
  { id: 'claude-recovered-reply', height: 1000, setup: async page => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'chatLoaded', chat: { id: 'recovered-chat', messages: [
        { role: 'user', text: 'Download and review the photos.', at: new Date(Date.now() - 20 * 60000).toISOString() },
        { role: 'assistant', text: '256 images downloaded. Checking resolution and descriptions.', agent: 'claude', modelLabel: 'Claude Sonnet 5.5 High', interrupted: true, interruptionReason: 'recovered_incomplete', at: new Date().toISOString() },
      ] },
    } })));
    await page.getByText('Recovered output · No completed reply was recorded', { exact: true }).waitFor();
    if (await page.locator('.msg-pending').count()) throw Error('Recovered historical output must not show as still running');
  } },
  { id: 'claude-background-command', height: 1000, setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const chat = { id: 'background-command', modelId: 'claude-sonnet-5-5-high', messages: [
        { role: 'user', text: 'Download and review the photos.', at: new Date(Date.now() - 8 * 60000).toISOString() },
        { role: 'assistant', text: 'The scraper takes about eight minutes. I will check the downloaded images next.', agent: 'claude', modelLabel: 'Claude Sonnet 5.5 High', inProgress: true },
        { role: 'tool', event: { type: 'tool_start', toolId: 'scraper', name: 'Bash', command: 'python scrape.py', output: 'Command running in background with ID: scrape-job.' }, done: true, offset: 40 },
      ] };
      const running = { agentId: 'claude', modelLabel: 'Claude Sonnet 5.5 High', startedAt: Date.now() - 8 * 60000 };
      post({ type: 'chatLoaded', chat, running });
      post({ type: 'delta', text: '\n\n256 images downloaded. Checking resolution and descriptions.', model: 'claude' });
      // Switch away and back, using the host's persisted reply and still-running turn.
      chat.messages[1].text += '\n\n256 images downloaded. Checking resolution and descriptions.';
      post({ type: 'chatLoaded', chat: { id: 'other-chat', messages: [] } });
      post({ type: 'chatLoaded', chat, running });
    });
    await page.locator('.msg-pending').waitFor({ state: 'visible' });
    await page.getByText('256 images downloaded. Checking resolution and descriptions.', { exact: false }).waitFor();
    if (await page.getByText(/^Worked for/).count()) throw Error('A background command must not mark the active turn finished');
    if (!await page.locator('#stopBtn').isVisible()) throw Error('Background work must remain stoppable');
  } },
  { id: 'claude-background-continued', height: 700, setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      // One stored turn from an older build (no flag), one live self-started turn.
      post({ type: 'chatLoaded', chat: { id: 'bg', messages: [
        { role: 'user', text: 'continue', at: new Date(Date.now() - 9 * 60000).toISOString() },
        { role: 'user', text: 'Background work continued', remote: true, agent: 'claude', at: new Date(Date.now() - 8 * 60000).toISOString() },
        { role: 'assistant', text: 'Immich is down; I will check the logs first.', agent: 'claude', modelLabel: 'Claude Sonnet 5.5 High', at: new Date().toISOString() },
      ] } });
      post({ type: 'userMessage', text: 'Background work continued', background: true });
    });
    await page.locator('.msg-background-divider').nth(1).waitFor();
    const bubbles = await page.locator('.msg-user').allInnerTexts();
    assert.deepEqual(bubbles.map(text => text.trim()), ['continue'], 'only the typed message is a bubble');
  } },
  { id: 'settings-scrollbar-constant', height: 900, focus: MODAL, setup: async page => {
    await openSettings('general')(page);
    const body = page.locator('#settingsModal .fs-modal-body');
    const widths = [];
    for (const tab of ['general', 'cloud', 'voice']) {
      await openSettings(tab)(page);
      await page.waitForTimeout(150);
      widths.push(await body.evaluate(el => el.clientWidth));
      assert.equal(await body.evaluate(el => getComputedStyle(el).overflowY), 'scroll');
    }
    assert.equal(new Set(widths).size, 1, `settings width changed between tabs: ${widths}`);
  } },
  { id: 'codex-capacity', focus: '.setup-card.is-upstream', setup: async page => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'upstream_error', agent: 'codex', detail: 'Selected model is at capacity. Please try a different model.',
    } })));
    await page.locator('.setup-card.is-upstream').waitFor();
    const note = await page.locator('.setup-card.is-upstream .setup-note').textContent();
    if (!note.includes('at capacity') || note.includes('503')) throw new Error('Capacity failure must explain model capacity without inventing an HTTP status');
  } },
  ...['dictate', 'polish'].map(action => ({ id: `composer-action-${action}`, focus: '.composer', setup: async page => {
    await page.locator('#promptInput').fill('Polish this draft into a clear, concise prompt.');
    await page.locator('#micBtn').hover();
    if (action === 'polish') {
      await page.locator('#polishBtn').click();
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'polishResult', requestId: 1, text: 'Rewrite this draft as a clear, concise prompt.',
      } })));
      await page.locator('.toast').waitFor({ state: 'detached' });
      await page.locator('#polishBtn').hover();
    }
    await page.waitForTimeout(450);
  } })),
  { id: 'composer-narrow-squircle', focus: '.composer', setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const now = Date.now();
      post({ type: 'chatLoaded', chat: { id: 'narrow-squircle', modelId: 'gpt-6.1-sol-high', messages: [{ role: 'user', text: 'Working' }] }, running: { agentId: 'codex', startedAt: now } });
      post({ type: 'quotas', quotas: { codex: { remaining: 0, resetsAt: now / 1000 + 6754 } } });
      post({ type: 'schedulerQueue', queue: [{ id: 'wait', chatId: 'narrow-squircle', model: 'codex', modelId: 'gpt-6.1-sol-high', prompt: 'Next step', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: new Date(now + 6754000).toISOString(), attachments: [] }] });
      for (const id of ['a1', 'a2', 'a3']) post({ type: 'subagent_start', id, agent: 'codex', status: 'running', description: id });
    });
    await page.waitForFunction(() => document.querySelector('.schedule-time').textContent !== '');
    await page.waitForTimeout(200);
    // The squircle is the only shape, at every width: the text row spans the composer and the bar sits below it.
    const state = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const composer = box('.composer'), input = box('#promptInput');
      return { width: window.innerWidth, composer: composer.width, inputWidth: input.width, inputBottom: input.bottom, barTop: box('#attachBtn').top, sendRight: box('#stopBtn').right, composerRight: composer.right };
    });
    assert.ok(state.inputWidth >= state.composer - 32, `expected a full-width input row, got ${state.inputWidth}px of ${state.composer}px`);
    assert.ok(state.barTop >= state.inputBottom - 2, 'the button bar sits below the text, never beside it');
    assert.ok(state.sendRight <= state.composerRight, 'the stop/send slot stays inside the composer');
  } },
  { id: 'queue-edit-stability', focus: '.compose-row', setup: queueStability },
  { id: 'queue-reset-wait', focus: '.compose-row', setup: queueReset },
  { id: 'queue-strip-dense', sidebar: true, focus: '.compose-row', setup: async page => {
    await applyIdePalette(page, IDE_PALETTES.light);
    const svg = color => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`)}`;
    const files = [{ name: 'shot.png', path: '/staged/shot.png', mime: 'image/png', uri: svg('#cbd5e1') }];
    await page.evaluate(({ files }) => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const hyd = 'gemini-4-hydrogen-xhigh';
      post({ type: 'modelCatalog', catalog: [{ id: hyd, agent: 'gemini', model: hyd, label: 'Gemini 4 Hydrogen XHigh', shortLabel: 'Hydrogen', company: 'Google' }], available: [{ id: hyd, agent: 'gemini', model: hyd, label: 'Gemini 4 Hydrogen XHigh', shortLabel: 'Hydrogen', company: 'Google' }] });
      post({ type: 'chatLoaded', chat: { id: 'dense-queue', modelId: hyd, messages: [{ role: 'user', text: 'Working' }] }, running: { agentId: 'gemini', startedAt: Date.now() } });
      const now = Date.now();
      const prompts = [
        'dont show the scheduler timer down here when you still have usage and make sure it stays clean',
        'Why cant i see which model is working here? Is it because no real model ran?',
        'why is steer now greyed out for 3/4 queued prompts?',
        'add the shimmer loading animation to the recent chats too. Remove extra borders',
        'make it so that only 7 scheduled / queued prompts can be displayed cleanly',
        'make it so you can see the full Model name when hovering of the name',
      ];
      const queue = prompts.map((prompt, i) => ({
        id: `s${i}`, chatId: 'dense-queue', model: 'gemini', modelId: hyd, prompt, status: 'pending',
        dispatchTrigger: 'fixed-time',
        dispatchTime: new Date(i === 3 ? now + 3600000 : now - 600000 * (i + 1)).toISOString(),
        files, attachments: [{ name: 'shot.png', mimeType: 'image/png', absolutePath: '/staged/shot.png' }],
      }));
      post({ type: 'schedulerQueue', queue });
      post({ type: 'turnQueue', chatId: 'dense-queue', paused: false, turns: [{ id: 'q1', text: 'i changes the model of the automatically queued turn', modelId: hyd, files, attachments: [] }] });
    }, { files });
    await page.waitForTimeout(700);
    const overflow = await page.locator('.turn-queue-item').evaluateAll(rows =>
      rows.filter(r => r.scrollHeight > r.clientHeight + 1 || r.scrollWidth > r.clientWidth + 1).length);
    assert.equal(overflow, 0, 'queue rows must never crush vertically or overflow horizontally');
    const pills = await page.locator('.turn-queue-item .model-pill').evaluateAll(els => els.map(el => ({ text: el.textContent.trim(), title: el.getAttribute('title') })));
    assert.ok(pills.length === 7 && pills.every(p => p.text === 'Hydrogen' && p.title === 'Gemini 4 Hydrogen XHigh'), 'queue model pills display short label with full model name in hover tooltip');
  } },
  { id: 'queue-usage-warning', setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'chatLoaded', chat: { id: 'usage-review', modelId: 'claude-sonnet-5-5-high', messages: [
        { role: 'user', text: 'Check the regulatory requirements.' },
        { role: 'assistant', agent: 'claude', text: "I started checking the requirements.\nYou've hit your session limit · resets 2:10pm (Europe/Berlin)" },
      ] } });
      post({ type: 'turnQueue', chatId: 'usage-review', paused: true, turns: [{ id: 'review', text: 'Check EU regulatory requirements', modelId: 'claude-sonnet-5-5-high', attachments: [], files: [] }] });
      post({ type: 'queueUsageWarning', chatId: 'usage-review', id: 'review', agent: 'claude', text: 'Claude Sonnet is out of usage. This prompt is still in the queue.' });
    });
    await page.locator('.queue-usage-warning').waitFor();
  } },
  // Claude through agy ran out: its pool is not the Gemini one the rail shows, which still has room. The notice names its own reset.
  { id: 'agy-quota-reached', focus: '.transcript', setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const now = Date.now() / 1000;
      post({ type: 'quotas', quotas: { gemini: { remaining: 64, used: 36, windowMinutes: 300, resetsAt: now + 7200, secondary: { remaining: 60, resetsAt: now + 97200 } } } });
      post({ type: 'chatLoaded', chat: { id: 'agy-limit', modelId: 'claude-sonnet-5-5-high', messages: [
        { role: 'user', text: 'Add the unit test for the fault data.' },
        { role: 'assistant', agent: 'gemini', at: new Date().toISOString(), modelLabel: 'Claude Sonnet 5.5 High', text: 'Backend first, then the launcher UI. Now a unit test for the fault data.\n\nGemini error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h43m1s.' },
      ] } });
    });
    await page.locator('.continue-at-reset').waitFor();
    assert.match(await page.locator('.continue-at-reset').innerText(), /Continue when .* resets/);
  } },
  ...['dark', 'light'].map(theme => ({ id: `inline-file-links-${theme}`, setup: async page => {
    await applyIdePalette(page, IDE_PALETTES[theme]);
    const text = 'The checks passed. See the [chat screenshot](out/chat.png) and [agents screenshot](out/agents.png) for the result. The [release notes](docs/publishing.md) describe the next steps.';
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'inline-files', messages: [
      { role: 'user', text: 'How did the interface checks go?' }, { role: 'assistant', agent: 'codex', text },
    ] } } })), text);
    const files = page.locator('#transcript .file-badge');
    assert.equal(await files.count(), 3);
    const style = await files.first().evaluate(file => {
      const css = getComputedStyle(file);
      return { border: css.borderTopWidth, background: css.backgroundColor, color: css.color, icon: Boolean(file.querySelector('svg')) };
    });
    assert.deepEqual(style, { border: '0px', background: 'rgba(0, 0, 0, 0)', color: theme === 'light' ? 'rgb(50, 101, 141)' : 'rgb(140, 184, 220)', icon: true });
    await files.first().click();
    assert.equal(await page.evaluate(() => window.sent.findLast(message => message.type === 'openFile').path), 'out/chat.png');
    await files.nth(1).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.sent.findLast(message => message.type === 'openFile').path), 'out/agents.png');
    await files.nth(1).blur();
    await page.mouse.move(0, 0);
  } })),
  ...['dark', 'light'].map(theme => ({ id: `chat-inline-images-${theme}`, setup: async page => {
    await applyIdePalette(page, IDE_PALETTES[theme]);
    const svg = (title, sub, bg, fg) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260"><rect width="480" height="260" rx="16" fill="${bg}"/><text x="240" y="122" text-anchor="middle" fill="${fg}" font-family="sans-serif" font-size="28" font-weight="700">${title}</text><text x="240" y="158" text-anchor="middle" fill="${fg}" opacity="0.72" font-family="sans-serif" font-size="16">${sub}</text></svg>`).toString('base64')}`;
    const beforeUri = svg('Before', '32px buttons · misaligned margin', theme === 'light' ? '#dfe5ee' : '#252936', theme === 'light' ? '#1c2430' : '#f4f6fb');
    const afterUri = svg('After', '42px buttons · aligned baseline', theme === 'light' ? '#d7eee3' : '#1b352c', theme === 'light' ? '#0f3d2e' : '#dcfce7');
    await page.evaluate(({ beforeUri, afterUri }) => {
      const origPost = window.acquireVsCodeApi;
      // Intercept previewFile via window.sent observer: scenarios boot already wired acquireVsCodeApi, so watch sent messages.
      let seen = window.sent.length;
      const poll = setInterval(() => {
        while (seen < window.sent.length) {
          const m = window.sent[seen++];
          if (m.type === 'previewFile') {
            const uri = m.path.includes('before') ? beforeUri : afterUri;
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'filePreview', requestId: m.requestId, path: m.path, uri, name: m.path.split('/').pop() } }));
          }
        }
      }, 15);
      setTimeout(() => clearInterval(poll), 3000);
      const text = 'Here is the visual diff between the old layout and the updated layout:\n\n![Before](out/before.png)\n![After](out/after.png)\n\nClick either image for the full preview, or use the top-right button to open it in VS Code.';
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'inline-imgs', messages: [
        { role: 'user', text: 'Show me the before and after screenshots' },
        { role: 'assistant', agent: 'claude', text },
      ] } } }));
    }, { beforeUri, afterUri });
    await page.locator('.chat-image-card.is-ready').nth(1).waitFor({ state: 'visible' });
    await page.waitForTimeout(120);
  } })),
  { id: 'pdf-file-links', setup: async page => {
    const text = 'Open [Review notes](<out/review notes.pdf>), `review.pdf`, `C:\\Project Files\\review.PDF`, or out/review.pdf.\n\n[Website](https://example.com/review.pdf)';
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'pdf-links', messages: [{ role: 'assistant', text }] } } })), text);
    const badges = page.locator('#transcript .file-badge[data-ext="pdf"]');
    assert.equal(await badges.count(), 4);
    assert.equal(await page.locator('#transcript a[data-external-url="https://example.com/review.pdf"]').count(), 1);
    await badges.first().click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.type === 'openFile').at(-1)), { type: 'openFile', path: 'out/review notes.pdf', line: null });
    await badges.nth(1).focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'openFile').at(-1).path), 'review.pdf');
  } },
  { id: 'pdf-code-label-links', setup: async page => {
    const text = '2. Allgemeine Vorlagen als PDF:\n   - [`Vorlage_Beispiel.pdf`](file:///C:/Users/user/Docs/Vorlage_Beispiel.pdf) *(Markdown)*\n   - [**Vorlage_Muster.pdf**](<C:/Users/user/Docs/Vorlage Muster.pdf>)\n   - [`C:/Docs/a.pdf`](C:/Docs/a.pdf)';
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'pdf-code-label', messages: [{ role: 'assistant', text }] } } })), text);
    const badges = page.locator('#transcript .file-badge');
    await badges.first().waitFor();
    assert.equal(await badges.count(), 3);
    assert.equal(await page.locator('#transcript .file-badge .file-badge, #transcript .file-badge code').count(), 0);
    assert.equal(await page.locator('#transcript .file-badge:not(:has(span))').count(), 0);
    assert.equal(await badges.first().innerText(), 'Vorlage_Beispiel.pdf');
    assert.equal(await badges.nth(1).innerText(), 'Vorlage_Muster.pdf');
    await badges.first().click();
    assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'openFile').at(-1).path), 'C:/Users/user/Docs/Vorlage_Beispiel.pdf');
  } },
  { id: 'env-file-links', setup: async page => {
    const text = '2. Geschützte [`.env`](file:///C:/Users/user/Projects/example-app/.env) für deine Zugangsdaten angelegt, dazu `C:/Users/user/app/.env.production` und [Beispiel](<C:/Users/user/app/.env.local>).';
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'env-links', messages: [{ role: 'assistant', text }] } } })), text);
    const badges = page.locator('#transcript .file-badge[data-ext="env"]');
    await badges.first().waitFor();
    assert.equal(await badges.count(), 3);
    assert.equal(await page.locator('#transcript').innerText().then(t => t.includes('](')), false);
    assert.equal(await badges.first().innerText(), '.env');
    assert.equal(await badges.first().locator('code').count(), 0);
    await badges.first().click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.type === 'openFile').at(-1)), { type: 'openFile', path: 'C:/Users/user/Projects/example-app/.env', line: null });
  } },
  { id: 'codex-pdf-file-links', setup: async page => {
    const file = '/C:/Users/user/Cloud - Beispiel Universität/Kurs/Unterlagen/Stakeholder_Maps_Example.pdf';
    const label = 'Beide Stakeholder Maps als PDF';
    const text = `Fertig: [${label}](<${file}>).\n\nZwei Seiten, jeweils unverändert aus den Original-PDFs übernommen und geprüft.`;
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'codex-pdf-links', messages: [{ role: 'assistant', agent: 'codex', text }] } } })), text);
    const badge = page.getByRole('button', { name: label, exact: true });
    await badge.waitFor();
    assert.equal(await badge.getAttribute('data-path'), file);
    assert.equal(await page.locator('#transcript').innerText().then(text => text.includes('](<')), false);
    await badge.click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.type === 'openFile').at(-1)), { type: 'openFile', path: file, line: null });
    assert.equal(await badge.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'openFile').at(-1).path), file);
  } },
  { id: 'attachment-previews', setup: attachmentPreviews },
  { id: 'attachment-image-actions', focus: '.image-context-menu', setup: async page => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2b5b84"/><circle cx="32" cy="32" r="14" fill="#fff"/></svg>`;
    const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const files = [
      { name: '1794686684460_image.png', path: '/attachments/1794686684460_image.png', mime: 'image/png', dims: '528×129', size: 1024, uri },
      { name: 'b7efae68-a440-4c03-a48f-994b89991baf_1794686684461_wordmark.png', path: '/attachments/1794686684461_wordmark.png', mime: 'image/png', dims: '528×129', size: 1024, uri },
    ];
    await page.evaluate(files => {
      window.sent = [];
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'userMessage', text: 'Check these two images', files } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'attachmentSaved', attachment: files[0] } }));
    }, files);
    const chips = page.locator('.msg-attachments .attachment-chip');
    await page.waitForFunction(() => [...document.querySelectorAll('.attachment-chip img')].every(img => img.complete && img.naturalWidth > 0));
    assert.equal(await page.locator('.attachment-chip .attachment-download').count(), 0, 'chips must not show an inline download button');
    await chips.nth(0).click();
    await page.locator('.image-lightbox.is-open img').waitFor();
    const toolbarBox = await page.locator('.image-lightbox-toolbar').boundingBox();
    const imgBox = await page.locator('.image-lightbox img').boundingBox();
    assert.ok(toolbarBox.y + toolbarBox.height <= imgBox.y - 6, 'download and close buttons must sit above the enlarged image with a gap');
    await page.locator('.image-lightbox-download').click();
    await page.locator('.image-lightbox-close').click();
    await page.locator('.image-lightbox').waitFor({ state: 'detached' });
    await chips.nth(1).click({ button: 'right' });
    await page.locator('.image-context-menu').waitFor();
    assert.deepEqual(await page.locator('.image-context-item').evaluateAll(els => els.map(el => el.dataset.action)), ['copy', 'download', 'rename']);
    await page.locator('.image-context-item[data-action="download"]').click();
    const downloads = await page.evaluate(() => window.sent.filter(m => m.type === 'downloadAttachment').map(m => m.name));
    assert.deepEqual(downloads, ['image.png', 'wordmark.png']);
    await chips.nth(1).click({ button: 'right' });
    await page.locator('.image-context-item[data-action="copy"]').click();
    assert.equal(await page.locator('.image-context-menu').count(), 0);
    await page.waitForFunction(() => window.sent.some(m => m.type === 'copyAttachment' && m.path === '/attachments/1794686684461_wordmark.png'));
    await chips.nth(1).click({ button: 'right' });
    await page.locator('.image-context-item[data-action="rename"]').click();
    const renameInput = chips.nth(1).locator('input.attachment-rename');
    await renameInput.waitFor();
    await renameInput.fill('brand-logo');
    await renameInput.press('Enter');
    assert.equal(await chips.nth(1).locator('.attachment-name').textContent(), 'brand-logo.png');
    assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'renameAttachment').at(-1)), { type: 'renameAttachment', path: '/attachments/1794686684461_wordmark.png', name: 'brand-logo' });
    await chips.nth(1).click({ button: 'right' });
    await page.locator('.image-context-menu').waitFor();
  } },
  { id: 'attachment-svg-viewer', focus: '.image-lightbox', setup: async page => {
    await attachmentPreviews(page);
    const chip = page.locator('.msg-attachments .attachment-chip').first();
    await chip.focus(); await page.keyboard.press('Enter');
    await page.locator('.image-lightbox img').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.image-lightbox').waitFor({ state: 'detached' });
    if (!await chip.evaluate(element => element === document.activeElement)) throw new Error('Preview did not restore keyboard focus');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.image-lightbox img')?.naturalWidth > 0);
    if (!await page.locator('.image-lightbox img').evaluate(element => element.clientWidth > 100 && element.clientHeight > 100)) throw new Error('SVG preview collapsed');
  } },
  { id: 'attachment-pdf-viewer', scope: '.attachment-strip', focus: '.attachment-strip', setup: async page => {
    await attachmentPreviews(page);
    const chip = page.locator('.msg-attachments .attachment-chip').last();
    await chip.click();
    assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'openFile').at(-1).path), 'review.pdf');
    assert.equal(await page.locator('.image-lightbox').count(), 0);
    const composerChip = page.locator('.attachment-strip .attachment-chip').last();
    await composerChip.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'openFile').length), 2);
  } },
  ...['light', 'dark'].map(theme => ({ id: `model-menu-queue-${theme}`, height: 1050, scope: '#modelMenu', setup: async page => {
    const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await page.evaluate(theme => { document.body.classList.toggle('vscode-light', theme === 'light'); document.body.classList.toggle('vscode-dark', theme === 'dark'); }, theme);
    const now = await page.evaluate(() => Date.now());
    await post({ type: 'chatLoaded', chat: { id: 'menu-queue', messages: [] } });
    await post({ type: 'schedulerQueue', queue: Array.from({ length: 8 }, (_, i) => ({ id: `menu-task-${i}`, chatId: 'menu-queue', model: 'claude', modelId: 'claude-sonnet-5-5-high', status: 'pending', prompt: `Scheduled prompt ${i + 1}: keep the model selector readable above this text`, dispatchTrigger: 'quota-reset', notBefore: new Date(now + 600000).toISOString() })) });
    await page.locator('#modelPill').click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.turn-queue-item').count(), 8);
    assert.equal(await page.locator('#ig-upper-silhouette path').count(), 1);
    assert.equal(await page.locator('#ig-silhouette path').count(), 0);
    const above = await page.locator('.model-option').first().evaluate(el => {
      const b = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
    });
    assert.ok(above, 'menu options receive pointer input above queue rows');
  } })),
  { id: 'model-menu', scope: '#modelMenu', focus: '#modelMenu', setup: async page => { await page.locator('#modelPill').click(); await page.locator('.model-option').first().waitFor(); await page.waitForTimeout(700); /* the spring-open takes 0.5s */ } },
  ...['light', 'dark'].map(theme => ({ id: `settings-quiet-${theme}`, height: 1400, focus: MODAL, setup: async page => {
    await page.evaluate(theme => {
      document.body.classList.toggle('vscode-light', theme === 'light');
      document.body.classList.toggle('vscode-dark', theme === 'dark');
    }, theme);
    await openSettings('general')(page);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', models: [], pinged: true, services: {}, clis: {
      claude: { path: 'claude.exe', version: '2.1.326' }, codex: { path: 'codex.cmd', version: '0.169.0' }, gemini: { path: 'agy.cmd', version: '1.5.10' },
    } } })));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'cliConnections', setupNeeded: false, checking: false, providers: {
      claude: { enabled: true, installed: true, auth: 'connected', note: '' },
      codex: { enabled: true, installed: true, auth: 'connected', note: '' },
      gemini: { enabled: true, installed: true, auth: 'connected', note: '' },
      copilot: { enabled: false, installed: false, auth: 'missing', note: '' },
    } } })));
    assert.equal(await page.locator('#settingsModal').innerText().then(text => text.includes('Use your existing account, or create one during sign-in.')), false);
  } })),
  ...['general', 'voice', 'remote', 'models'].map(tab => ({ id: `settings-${tab}`, height: 1400, focus: MODAL, setup: openSettings(tab) })),
  { id: 'settings-voice-local', height: 1400, focus: MODAL, scope: '[data-role=voiceEngine]', setup: async page => {
    await openSettings('voice')(page);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'voice', voice: {
      supported: true, hotkey: 'F9', hotkeyActive: true, mode: 'toggle', sounds: true, pauseMedia: true, micDevice: '',
      provider: 'local', groqModel: 'whisper-large-v3-turbo', localModel: 'small.en',
      localStt: {
        dir: '/home/user/.cache/clanker-controller/local-stt',
        runtime: { installed: false, path: '', source: '' },
        selectedModel: 'small.en',
        ready: false,
        busy: false,
        progress: null,
        error: '',
        models: [
          { id: 'base.en', label: 'Base · Fast', group: 'english', language: 'en', sizeMb: 60, ramGb: 0.3, description: 'Quick English transcription with low memory use.', installed: false, bytes: 0 },
          { id: 'small.en', label: 'Small · Balanced', group: 'english', language: 'en', sizeMb: 190, ramGb: 0.5, description: 'Recommended English default: accurate and light on RAM.', installed: false, bytes: 0 },
          { id: 'medium.en', label: 'Medium · Accurate', group: 'english', language: 'en', sizeMb: 539, ramGb: 1.5, description: 'Higher English accuracy; needs ~1.5 GB free RAM.', installed: false, bytes: 0 },
          { id: 'small', label: 'Small · Fast', group: 'multilingual', language: 'auto', sizeMb: 190, ramGb: 0.5, description: 'Multilingual (auto-detects 90+ languages) with modest RAM use.', installed: false, bytes: 0 },
          { id: 'large-v3-turbo', label: 'Large v3 Turbo · Best', group: 'multilingual', language: 'auto', sizeMb: 574, ramGb: 1.6, description: 'Best local multilingual quality; needs ~1.6 GB free RAM.', installed: false, bytes: 0 },
        ],
      },
      groq: { source: '', masked: '', today: { calls: 0 }, limits: {} },
    } } })));
    await page.locator('[data-role=voiceLocalPanel]').waitFor({ state: 'visible' });
    const groups = await page.locator('[data-role=voiceLocalModel] optgroup').evaluateAll(els => els.map(el => el.label));
    assert.deepEqual(groups, ['English only', 'Multilingual']);
    await page.locator('[data-role=voiceLocalInstall]').click();
    assert.ok(await page.evaluate(() => window.sent.some(m => m.type === 'installLocalStt' && m.model === 'small.en')));
  } },
  { id: 'settings-external-links', height: 1200, focus: '.cs-row:has([data-role=confirmExternalLinks])', setup: async page => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: {
      id: 'links', messages: [{ role: 'assistant', agent: 'codex', text: '[Docs](https://example.com/?a=1&b=2) and https://example.org' }],
    } } })));
    const docs = page.getByRole('link', { name: 'Docs', exact: true });
    assert.equal(await docs.getAttribute('href'), null);
    await docs.press('Enter');
    await page.getByRole('link', { name: 'https://example.org', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'openUrl').map(m => m.url)), [
      'https://example.com/?a=1&b=2', 'https://example.org',
    ]);
    await openSettings('general')(page);
    const toggle = page.getByRole('switch', { name: 'Confirm external links' });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.press('Space');
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'setConfirmExternalLinks')), { type: 'setConfirmExternalLinks', enabled: true });
    await toggle.evaluate(el => el.closest('.cs-row').scrollIntoView({ block: 'center' }));
  } },
  { id: 'settings-cli-telemetry', height: 1000, scope: '.cs-row:has([data-role=cliTelemetry])', focus: MODAL, setup: async page => {
    await openSettings('general')(page);
    const toggle = page.getByRole('switch', { name: 'CLI telemetry' });
    const fleet = services => page.evaluate(services => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', models: [], clis: {}, services } })), services);
    await fleet({});
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.press('Space');
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'setCliTelemetry')), { type: 'setCliTelemetry', enabled: true });
    await fleet({ cliTelemetry: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'setCliTelemetry')), { type: 'setCliTelemetry', enabled: false });
    const agyConfigBtn = page.getByRole('button', { name: 'Open Agy /config' });
    await agyConfigBtn.click();
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'openAgyConfig')), { type: 'openAgyConfig' });
    await toggle.evaluate(el => el.closest('.cs-row').scrollIntoView({ block: 'center' }));
  } },
  { id: 'settings-chat-names', height: 1400, scope: '.chat-names-picker', focus: MODAL, setup: async page => {
    await openSettings('general')(page);
    const pill = name => page.locator(`.names-pill[data-names="${name}"]`);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', models: [], clis: {}, services: {} } })));
    await pill('agent').scrollIntoViewIfNeeded();
    assert.equal(await pill('agent').evaluate(el => el.classList.contains('active')), true, 'the agent title is the default');
    assert.equal(await pill('groq').evaluate(el => el.classList.contains('active')), false);
    await pill('groq').click();
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'setChatNames')), { type: 'setChatNames', value: 'groq' });
    assert.equal(await pill('groq').evaluate(el => el.classList.contains('active')), true);
    assert.equal(await pill('agent').evaluate(el => el.classList.contains('active')), false);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', models: [], clis: {}, services: { chatNames: 'agent' } } })));
    assert.equal(await pill('agent').evaluate(el => el.classList.contains('active')), true, 'the saved choice is shown when the window opens');
    await pill('agent').evaluate(el => el.closest('.cs-row').scrollIntoView({ block: 'center' }));
  } },
  { id: 'settings-completion-sound', height: 1400, scope: '[data-role=completionSound]', focus: MODAL, setup: async page => {
    await openSettings('general')(page);
    const sw = page.locator('[data-role=completionSound]');
    const fleet = services => page.evaluate(services => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', models: [], clis: {}, services } })), services);
    await fleet({});
    await sw.evaluate(el => el.closest('.cs-row').scrollIntoView({ block: 'center' }));
    assert.equal(await sw.getAttribute('aria-checked'), 'true', 'the chime is on by default');
    await sw.click();
    assert.equal(await sw.getAttribute('aria-checked'), 'false');
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(m => m.type === 'setCompletionSound')), { type: 'setCompletionSound', enabled: false });
    await fleet({ completionSound: true });
    assert.equal(await sw.getAttribute('aria-checked'), 'true', 'the saved choice is shown when the window opens');
    await sw.click();
    assert.equal(await sw.getAttribute('aria-checked'), 'false');
  } },
  { id: 'settings-cloud-warmup', height: 1400, scope: '[data-role=cloudWarmupPanel]', focus: '[data-role=cloudWarmupPanel]', setup: async page => {
    await openSettings('general')(page);
    assert.equal(await page.locator('[data-role=cloudWarmupEnabled]').getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('[data-role=cloudWarmupPanel]').isHidden(), true);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', models: [], clis: {}, services: { cloudWarmup: {
      enabled: true, deployed: true, connected: true, project: 'clanker-personal-experiment', region: 'us-central1', busy: false,
      status: 'Cloud runner checked. Planned times cannot move an existing usage window.',
      providers: [{ agent: 'claude', label: 'Claude Code', selected: true, connected: false }, { agent: 'codex', label: 'Codex', selected: true, connected: true }],
      states: { codex: { status: 'reconnect' } }, estimate: { callsPerWeek: 30, cpuSeconds: 81000 },
    } } } })));
    const panel = page.locator('[data-role=cloudWarmupPanel]');
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await panel.isVisible(), true);
    assert.match(await panel.innerText(), /Google Cloud could charge you/);
    assert.match(await page.locator('[data-day="1"] .cs-cloud-preview').innerText(), /06:00.*11:00.*16:00/);
    assert.match(await page.locator('[data-role=cloudWarmupProviders]').innerText(), /Reconnect required/);
    await page.getByRole('combobox', { name: 'Monday work start', exact: true }).selectOption('10');
    assert.match(await page.locator('[data-day="1"] .cs-cloud-preview').innerText(), /07:00.*12:00.*17:00/);
    await page.locator('[data-role=cloudWarmupSave]').click();
    await panel.evaluate(el => el.scrollIntoView({ block: 'start' }));
  } },
  { id: 'settings-cli-broken', height: 1400, scope: '[data-role=providers]', focus: '[data-role=providers]', setup: async page => {
    await openSettings('general')(page);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', models: [], pinged: true, services: {}, clis: { claude: { path: 'claude.exe', version: '2.1.308' }, codex: { path: 'codex.cmd', version: '24.18.0' }, gemini: {} } } })));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'cliConnections', setupNeeded: false, checking: false, providers: {
      claude: { enabled: true, installed: true, auth: 'connected', note: '' },
      codex: { enabled: true, installed: true, auth: 'broken', note: 'Codex cannot start: Antigravity crashed on launch: its language server did not start.' },
      gemini: { enabled: false, installed: false, auth: 'missing', note: '' },
    } } })));
    const card = page.locator('[data-role=providers] .cs-provider[data-agent=codex]');
    await card.waitFor();
    assert.match(await card.innerText(), /Missing optional dependency/);
    await page.getByRole('button', { name: 'Repair & sign in' }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'connectCli', agent: 'codex' });
  } },
  { id: 'settings-search', height: 1400, scope: '.cs-settings-search', focus: '.cs-settings-search', setup: async page => {
    await openSettings('general')(page);
    await page.getByRole('combobox', { name: 'Search settings' }).fill('hotkey');
    await page.getByRole('option', { name: 'Dictation hotkey Voice', exact: true }).waitFor();
  } },
  { id: 'settings-search-jump', height: 1400, scope: '.cs-search-target', focus: MODAL, setup: async page => {
    await openSettings('general')(page);
    await page.evaluate(config => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', services: { routing: { config, usage: {}, models: [], connected: {} } } } })), DEFAULTS);
    const input = page.getByRole('combobox', { name: 'Search settings' });
    await input.fill('confidence needed'); await input.press('Enter');
    await page.locator('[data-pane="routing"] .cs-search-target').waitFor();
    // The highlight clears itself after 2.2 s; the tester's scope is that class, and a slow screenshot must not outlive it.
    await page.evaluate(() => { const t = document.querySelector('.cs-search-target'); new MutationObserver(() => t.classList.add('cs-search-target')).observe(t, { attributes: true, attributeFilter: ['class'] }); });
    await page.waitForTimeout(400);
  } },
  ...['collapsed', 'expanded', 'empty'].map(state => ({ id: `settings-project-icons-${state}`, height: 1400, focus: MODAL, setup: async page => {
    await openSettings('general')(page);
    await page.evaluate(empty => window.dispatchEvent(new MessageEvent('message', { data: { type: 'projectIcons', projects: empty ? [] : [
      { id: 'clanker', name: 'Clanker Controller', root: 'C:/projects/clanker' },
      { id: 'visor', name: 'Visor', root: 'C:/projects/visor', icon: 'public/favicon.svg', iconUri: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath d="m4 5 8 14 8-14" fill="none" stroke="%238ab4ff" stroke-width="3"/%3E%3C/svg%3E' },
      { id: 'long', name: 'A project with a very long name for testing compact rows', root: 'C:/projects/long', icon: 'public/assets/a-very-long-filename-for-the-project-icon.svg' },
      { id: 'plan', name: 'Planning', root: '' },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `extra-${i}`, name: `Project ${i + 1}`, root: 'C:/projects/extra' })),
    ] } })), state === 'empty');
    const panel = page.locator('.cs-project-icons');
    if (await panel.evaluate(el => el.open)) throw new Error('Project icons must start collapsed');
    if (state !== 'collapsed') {
      await panel.locator('summary').focus();
      await page.keyboard.press('Enter');
      if (!await panel.evaluate(el => el.open)) throw new Error('Keyboard did not expand project icons');
    }
  } })),
  { id: 'settings-routing', height: 1400, focus: MODAL, setup: async page => {
    await openSettings('routing')(page);
    await page.evaluate(config => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'fleet', services: { routing: { config, usage: { neurons: 1200, groq_requests: 86, groq_tokens: 197631 },
        models: [], connected: { cloudflare: true, groq: true }, reset: new Date(Date.now() + 3600000).toISOString() } },
    } })), DEFAULTS);
    await page.getByText('Smart routing', { exact: true }).waitFor();
  } },
  { id: 'tool-running-timer', focus: '.tool-card', setup: async page => {
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    const now = await page.evaluate(() => Date.now());
    await send({ type: 'chatLoaded', chat: { id: 'tool-timer-chat', messages: [{ role: 'user', text: 'Build the presentation deck.' }] }, running: { agentId: 'codex', modelLabel: 'GPT 6.1 Sol High', startedAt: now - (34 * 60 + 23) * 1000 } });
    await send({ type: 'tool_start', toolId: 'pptx', name: 'bash', command: 'python _work\\build_fluid_pptx.py', startedAt: now - (12 * 60 + 7) * 1000 });
    assert.equal(await page.locator('.tool-card.is-running .tool-time').textContent(), '12m 7s');
    await page.clock.fastForward(1000);
    assert.equal(await page.locator('.tool-card.is-running .tool-time').textContent(), '12m 8s');
  } },
  { id: 'turn-role-before-tools', focus: '.turn', setup: async page => {
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    const inspectTurn = () => page.evaluate(() => {
      const turn = document.querySelector('.turn');
      if (!turn) return null;
      const kids = [...turn.children].map(el => el.className);
      const role = turn.querySelector('.msg-role');
      const tool = turn.querySelector('.tool-card, .work-summary');
      const reply = turn.querySelector('.msg-assistant');
      return {
        kids,
        roleCount: turn.querySelectorAll('.msg-role').length,
        assistantCount: turn.querySelectorAll('.msg-assistant').length,
        roleText: role?.textContent.trim() || '',
        roleTop: role?.getBoundingClientRect().top ?? -1,
        toolTop: tool?.getBoundingClientRect().top ?? -1,
        replyTop: reply?.getBoundingClientRect().top ?? -1,
      };
    });

    // 1. Restored turn with tools before reply: single role header stays at top above tools and reply.
    await send({
      type: 'chatLoaded',
      chat: {
        id: 'role-restored-chat',
        messages: [
          { role: 'user', text: 'continue' },
          { role: 'assistant', text: 'Done.', agent: 'gemini', modelLabel: 'Gemini 4 Hydrogen XHigh' },
          { role: 'tool', offset: 0, done: true, event: { name: 'read_file', file: 'main.js' } },
        ],
      },
    });
    const restored = await inspectTurn();
    assert.equal(restored.roleCount, 1);
    assert.match(restored.roleText, /Gemini 4 Hydrogen XHigh/);
    assert.ok(restored.kids[0].includes('msg-group-user') && restored.kids[1].includes('msg-role'));
    assert.ok(restored.toolTop > restored.roleTop && restored.replyTop > restored.toolTop);

    // 2. Live turn: routing -> tool -> delta keeps exactly one role header at the top above tools.
    await send({ type: 'chatLoaded', chat: { id: 'role-stream-chat', messages: [] } });
    await send({ type: 'userMessage', text: 'continue' });
    await send({ type: 'routing', agentId: 'gemini', modelLabel: 'Gemini 4 Hydrogen XHigh' });
    await send({ type: 'tool_start', toolId: 't0', name: 'read_file', file: 'ai-chat-panel/media/main.js' });
    await send({ type: 'delta', text: 'Working on it.', model: 'gemini' });
    const streamed = await inspectTurn();
    assert.equal(streamed.roleCount, 1);
    assert.equal(streamed.assistantCount, 1);
    assert.ok(streamed.kids[0].includes('msg-group-user') && streamed.kids[1].includes('msg-role'));
    assert.ok(streamed.toolTop > streamed.roleTop && streamed.replyTop > streamed.toolTop);

    // 3. Tool-only live turn left visible for visual & geometry verification.
    await send({ type: 'chatLoaded', chat: { id: 'role-live-tool-only', messages: [] } });
    await send({ type: 'userMessage', text: 'continue' });
    await send({ type: 'routing', agentId: 'gemini', modelLabel: 'Gemini 4 Hydrogen XHigh' });
    await send({ type: 'tool_start', toolId: 't1', name: 'read_file', file: 'ai-chat-panel/media/main.js' });
    await send({ type: 'tool_start', toolId: 't2', name: 'run_command', command: 'npm.cmd run check' });
    const liveOnly = await inspectTurn();
    assert.equal(liveOnly.roleCount, 1);
    assert.equal(liveOnly.assistantCount, 0);
    assert.match(liveOnly.roleText, /Gemini 4 Hydrogen XHigh/);
    assert.ok(liveOnly.kids[0].includes('msg-group-user') && liveOnly.kids[1].includes('msg-role'));
    assert.ok(liveOnly.toolTop > liveOnly.roleTop);
  } },
  { id: 'queue-loading-skeleton', focus: '.compose-row', setup: async page => {
    const now = await page.evaluate(() => Date.now());
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    // 1. chatLoaded arrives before schedulerQueue with unknown/pending scheduled tasks + one local queued turn.
    await send({
      type: 'chatLoaded',
      chat: {
        id: 'queue-skel-chat',
        modelId: 'gpt-6.1-sol-high',
        scheduledPending: 2,
        turnQueue: { paused: false, turns: [{ id: 'q-local', modelId: 'gpt-6.1-sol-high', text: 'Continue once reset finishes', attachments: [] }] },
        messages: [{ role: 'user', text: 'Work on queue shimmer' }],
      },
    });
    const strip = page.locator('.turn-queue-strip');
    await strip.waitFor({ state: 'visible' });
    assert.equal(await strip.getAttribute('aria-busy'), 'true');
    assert.equal(await strip.locator('.turn-queue-skeleton').count(), 2);
    assert.equal(await strip.locator('.turn-queue-item:not(.turn-queue-skeleton)').count(), 1);
    assert.match(await strip.locator('.turn-queue-head > span').innerText(), /loading scheduled/);
    assert.equal(await strip.locator('.turn-queue-skeleton .skeleton').first().evaluate(el => getComputedStyle(el).animationName), 'skeleton-shimmer');

    // 2. Real schedulerQueue arrival swaps skeletons out seamlessly.
    await send({
      type: 'schedulerQueue',
      queue: [
        { id: 's1', chatId: 'queue-skel-chat', model: 'codex', modelId: 'gpt-6.1-sol-high', prompt: 'Scheduled task 1', status: 'pending', dispatchTrigger: 'fixed-time', dispatchTime: new Date(now + 600000).toISOString(), attachments: [] },
        { id: 's2', chatId: 'queue-skel-chat', model: 'codex', modelId: 'gpt-6.1-sol-high', prompt: 'Scheduled task 2', status: 'pending', dispatchTrigger: 'fixed-time', dispatchTime: new Date(now + 1200000).toISOString(), attachments: [] },
      ],
    });
    assert.equal(await strip.getAttribute('aria-busy'), null);
    assert.equal(await strip.locator('.turn-queue-skeleton').count(), 0);
    assert.equal(await strip.locator('.turn-queue-item.is-scheduled').count(), 2);

    // 3. chatLoading while switching to a chat with pending prompts shows shimmer placeholders immediately for visual inspection.
    await send({ type: 'chatLoading', queueCount: 2 });
    assert.equal(await strip.getAttribute('aria-busy'), 'true');
    assert.equal(await strip.locator('.turn-queue-skeleton').count(), 2);
    assert.equal(await strip.locator('.turn-queue-item:not(.turn-queue-skeleton)').count(), 0);
    assert.match(await strip.locator('.turn-queue-head > span').innerText(), /Loading prompts/);
    await page.waitForTimeout(600);
  } },
  ...['light', 'dark'].map(theme => ({ id: `glass-scrollbars-${theme}`, height: 1050, scope: '.turn-queue-strip', setup: async page => {
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await page.evaluate(t => { document.body.classList.toggle('vscode-light', t === 'light'); document.body.classList.toggle('vscode-dark', t === 'dark'); }, theme);
    const now = await page.evaluate(() => Date.now());
    await send({ type: 'chatLoaded', chat: { id: 'scrollbars', messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', agent: 'codex', text: `Message ${i + 1}: Review the glass dock and its scrolling content.\n\nKeep the transcript readable while prompts wait below.` })) } });
    await send({ type: 'schedulerQueue', queue: Array.from({ length: 12 }, (_, i) => ({ id: `scroll-${i}`, chatId: 'scrollbars', model: 'claude', modelId: 'claude-sonnet-5-5-high', status: 'pending', prompt: `Scheduled prompt ${i + 1}: inspect the shared glass scrollbar`, dispatchTrigger: 'fixed-time', dispatchTime: new Date(now + 600000).toISOString() })) });
    await page.waitForTimeout(700);
    const bars = await page.evaluate(() => ['.transcript', '.turn-queue-strip'].map(sel => {
      const el = document.querySelector(sel);
      const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb');
      const rail = getComputedStyle(el, '::-webkit-scrollbar');
      el.scrollTop = 100;
      return { width: rail.width, thumb: thumb.backgroundImage, radius: thumb.borderRadius, overflow: el.scrollHeight > el.clientHeight, scrolled: el.scrollTop > 0 };
    }));
    assert.deepEqual(bars[0], bars[1], 'both scroll areas use the same rail and thumb and can scroll');
    assert.equal(bars[0].width, '12px');
    assert.ok(bars[0].overflow && bars[0].scrolled);
  } })),
  { id: 'queue-seven-cap', height: 1400, focus: '.compose-row', setup: async page => {
    const now = await page.evaluate(() => Date.now());
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    const hyd = 'gemini-4-hydrogen-high';
    await send({ type: 'modelCatalog', catalog: [{ id: hyd, agent: 'gemini', model: hyd, label: 'Gemini 4 Hydrogen High', shortLabel: 'Hydrogen', company: 'Google' }], available: [{ id: hyd, agent: 'gemini', model: hyd, label: 'Gemini 4 Hydrogen High', shortLabel: 'Hydrogen', company: 'Google' }] });
    await send({ type: 'chatLoaded', chat: { id: 'seven-cap', modelId: hyd, messages: [{ role: 'user', text: 'Working' }, { role: 'assistant', agent: 'gemini', modelLabel: 'Gemini 4 Hydrogen High', text: 'Typing response remains visible above the queue.' }] } });
    const queue = Array.from({ length: 9 }, (_, i) => ({
      id: `cap-${i}`, chatId: 'seven-cap', model: 'gemini', modelId: hyd,
      prompt: `Queued prompt #${i + 1}: keep the chat readable`,
      status: 'pending', dispatchTrigger: 'fixed-time', dispatchTime: new Date(now + (i + 1) * 600000).toISOString(), attachments: [],
    }));
    await send({ type: 'schedulerQueue', queue });
    await page.waitForTimeout(650);
    const metrics = await page.locator('.turn-queue-strip').evaluate(strip => {
      const s = strip.getBoundingClientRect();
      const visible = [...strip.querySelectorAll('.turn-queue-item')].filter(r => {
        const b = r.getBoundingClientRect();
        return b.bottom > s.top + 1 && b.top < s.bottom - 1;
      }).length;
      const before = strip.scrollTop;
      strip.scrollTop = strip.scrollHeight;
      const scrolled = strip.scrollTop;
      strip.scrollTop = before;
      return { total: strip.querySelectorAll('.turn-queue-item').length, visible, scrollHeight: strip.scrollHeight, clientHeight: strip.clientHeight, scrolled, vhCap: Math.floor(innerHeight * 0.34 - 20) };
    });
    assert.equal(metrics.total, 9);
    // Seven rows, unless a narrow panel wraps each row onto three lines and the strip's 34vh ceiling cuts the list shorter.
    const clamped = metrics.clientHeight >= metrics.vhCap - 1;
    if (clamped) assert.ok(metrics.visible >= 4 && metrics.visible <= 7, `a height-clamped strip still shows 4 to 7 prompts, got ${metrics.visible}`);
    else assert.equal(metrics.visible, 7, 'displays only 7 prompts at once even on a 1400px tall viewport');
    assert.ok(metrics.scrollHeight > metrics.clientHeight + 20, 'extra prompts scroll inside the strip');
    assert.ok(metrics.scrolled > 0, 'scrolling reveals the remaining prompts');
    assert.equal(await page.locator('.turn-queue-item .model-pill').first().getAttribute('title'), 'Gemini 4 Hydrogen High');
  } },
  { id: 'queue-pill-change-model', height: 900, focus: '.compose-row', setup: async page => {
    const now = await page.evaluate(() => Date.now());
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    const hyd = 'gemini-4-hydrogen-high';
    const entry = { id: hyd, agent: 'gemini', model: hyd, label: 'Gemini 4 Hydrogen High', shortLabel: 'Hydrogen', company: 'Google' };
    await send({ type: 'modelCatalog', catalog: [entry], available: [entry] });
    await send({ type: 'chatLoaded', chat: { id: 'pill-chat', modelId: hyd, turnQueue: { paused: false, turns: [{ id: 'q1', modelId: hyd, text: 'Queued turn', attachments: [] }] }, messages: [{ role: 'user', text: 'Working' }] } });
    await send({ type: 'schedulerQueue', queue: [{ id: 's1', chatId: 'pill-chat', model: 'gemini', modelId: hyd, prompt: 'Scheduled turn', status: 'pending', dispatchTrigger: 'fixed-time', dispatchTime: new Date(now + 600000).toISOString(), attachments: [] }] });
    await page.waitForTimeout(650);
    assert.equal(await page.locator('.turn-queue-item button[aria-label*="Change model"]').count(), 0, 'the robot button is gone');
    // The number column is as tall as its row; a row is always two lines tall.
    const heights = await page.locator('.turn-queue-item').evaluateAll(rows => rows.map(row => ({ row: Math.round(row.getBoundingClientRect().height), grip: Math.round(row.querySelector('.turn-queue-rank').getBoundingClientRect().height) })));
    for (const h of heights) assert.equal(h.grip, h.row, 'the number column spans the whole row');
    // Clicking the scheduled row's model asks the host to take the task back with the model menu open.
    await page.locator('[data-task-id="s1"] .model-pill').click();
    assert.deepEqual(await page.evaluate(() => { const m = window.sent.findLast(x => x.type === 'unscheduleToComposer'); return m && { taskId: m.taskId, chooseModel: m.chooseModel }; }), { taskId: 's1', chooseModel: true });
    // Clicking a queued turn's model moves it into the composer and opens the model menu.
    await page.locator('[data-id="q1"] .model-pill').click();
    assert.equal(await page.locator('#promptInput').inputValue(), 'Queued turn');
    await page.locator('.model-option').first().waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } },
  ...LOOP_STATES.map(state => ({ id: `loops-${state}`, height: 2600, focus: MODAL, setup: loopsState(state) })),
  { id: 'chat-folders-manage', sidebar: true, height: 820, focus: MODAL, setup: async page => {
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    const projects = [
      { id: 'a', name: 'Portfolio 2026', root: '/dev/portfolio' },
      { id: 'b', name: 'Visor', root: '/dev/visor' },
      { id: 'c', name: 'Clanker Controller', root: '/dev/clanker' },
    ];
    const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
    const sessions = [
      { id: '1', projectId: 'c', projectName: 'Clanker Controller', title: 'OAuth callback fix', models: ['claude'], latestAgent: 'claude', messageCount: 14, updatedAt: ago(4), active: true, state: 'running', lastMessage: { role: 'assistant', agent: 'claude', text: 'Updated token refresh.' } },
      { id: '2', projectId: 'c', projectName: 'Clanker Controller', title: 'Login screen polish', models: ['gemini'], latestAgent: 'gemini', messageCount: 8, updatedAt: ago(25), lastMessage: { role: 'user', text: 'Match spacing in dark mode.' } },
      { id: '3', projectId: 'b', projectName: 'Visor', title: 'Release checklist', models: ['codex'], latestAgent: 'codex', messageCount: 19, updatedAt: ago(60 * 24 * 3), lastMessage: { role: 'assistant', agent: 'codex', text: 'Checks passed.' } },
      { id: '4', projectId: 'a', projectName: 'Portfolio 2026', title: 'Hero typography', models: ['claude'], latestAgent: 'claude', messageCount: 5, updatedAt: ago(12), selected: true, active: true, lastMessage: { role: 'assistant', agent: 'claude', text: 'Adjusted tracking.' } },
    ];
    const folders = [
      { id: 'f-rel', name: 'Release v2', chatIds: ['3'], pinned: true, pinnedAt: 1000, createdAt: ago(60 * 24 * 4), updatedAt: ago(60 * 24 * 3) },
      { id: 'f-auth', name: 'Auth flow', chatIds: ['1', '2'], pinned: false, pinnedAt: null, createdAt: ago(90), updatedAt: ago(4) },
    ];
    await send({ type: 'project', project: projects[0], projects, chatId: '4', required: false });
    await send({ type: 'history', sessions, folders, chatFoldersEnabled: true });
    await page.locator('#historyBtn').click();
    await page.locator('#historyModal .history-folder-card[data-folder-id="f-auth"] .history-folder-title').click();
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#historyModal .history-folder-card').count(), 2);
    assert.equal(await page.locator('#historyModal .history-folder-card[data-folder-id="f-auth"] .history-card').count(), 2);
  } },
  { id: 'chat-folders-rail', sidebar: true, height: 820, focus: '.rail', setup: async page => {
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    const projects = [
      { id: 'a', name: 'Portfolio 2026', root: '/dev/portfolio' },
      { id: 'b', name: 'Visor', root: '/dev/visor' },
      { id: 'c', name: 'Clanker Controller', root: '/dev/clanker' },
    ];
    const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
    const sessions = [
      { id: '1', projectId: 'a', projectName: 'Portfolio 2026', title: 'Hero typography', models: ['claude'], latestAgent: 'claude', messageCount: 5, updatedAt: ago(2), selected: true, active: true, lastMessage: { role: 'assistant', agent: 'claude', text: 'Adjusted tracking.' } },
      { id: '2', projectId: 'c', projectName: 'Clanker Controller', title: 'OAuth callback fix', models: ['claude'], latestAgent: 'claude', messageCount: 14, updatedAt: ago(6), active: true, state: 'running', lastMessage: { role: 'assistant', agent: 'claude', text: 'Updated token refresh.' } },
      { id: '3', projectId: 'c', projectName: 'Clanker Controller', title: 'Login screen polish', models: ['gemini'], latestAgent: 'gemini', messageCount: 8, updatedAt: ago(25), lastMessage: { role: 'user', text: 'Match spacing in dark mode.' } },
      { id: '4', projectId: 'b', projectName: 'Visor', title: 'Release checklist', models: ['codex'], latestAgent: 'codex', messageCount: 19, updatedAt: ago(60 * 24 * 3), lastMessage: { role: 'assistant', agent: 'codex', text: 'Checks passed.' } },
    ];
    const folders = [
      { id: 'f-rel', name: 'Release', chatIds: ['4'], pinned: true, pinnedAt: 1000, createdAt: ago(60 * 24 * 4), updatedAt: ago(60 * 24 * 3) },
      { id: 'f-auth', name: 'Auth', chatIds: ['2', '3'], pinned: false, pinnedAt: null, createdAt: ago(90), updatedAt: ago(6) },
    ];
    await send({ type: 'project', project: projects[0], projects, chatId: '1', required: false });
    await send({ type: 'history', sessions, folders, chatFoldersEnabled: true });
    await page.locator('#historyList .history-item[data-folder-id="f-auth"]').click();
    await page.mouse.move(10, 10);
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#historyList > :first-child').evaluate(el => el.classList.contains('history-folder-group') && el.dataset.folderId === 'f-auth'), true);
    assert.equal(await page.locator('#historyList .history-folder-contents .history-item').count(), 2);
  } },
  { id: 'gemini-thought-bundling', height: 780, focus: '.transcript', setup: async page => {
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    await send({ type: 'userMessage', text: 'Investigate the slow startup and fix it.' });
    await send({ type: 'routing', agentId: 'gemini', modelLabel: 'Gemini 4 Neon' });
    await send({ type: 'thought', text: 'First I will inspect the startup hooks and measure where time is spent.', agent: 'gemini' });
    for (let i = 1; i <= 3; i++) {
      await send({ type: 'tool_start', toolId: `a${i}`, name: 'read_file', command: `src/init-${i}.js`, agent: 'gemini' });
      await send({ type: 'tool_end', toolId: `a${i}`, output: 'ok', agent: 'gemini' });
    }
    await send({ type: 'thought', text: 'Found two synchronous disk reads during boot. Checking their callers before refactoring.', agent: 'gemini' });
    for (let i = 1; i <= 2; i++) {
      await send({ type: 'tool_start', toolId: `b${i}`, name: 'grep_search', command: `loadCache${i}`, agent: 'gemini' });
      await send({ type: 'tool_end', toolId: `b${i}`, output: 'match', agent: 'gemini' });
    }
    await send({ type: 'thought', text: '**Initial observation:** Switching cache warmup in `src/boot.js` to lazy async loading:\n- Avoid blocking startup on `loadCache1`\n- Re-run `npm run bench:startup` to confirm', agent: 'gemini' });
    await send({ type: 'tool_start', toolId: 'c1', name: 'bash', command: 'npm run bench:startup', agent: 'gemini' });
    await send({ type: 'tool_end', toolId: 'c1', output: 'startup 142ms', agent: 'gemini' });
    await page.waitForTimeout(450);
    assert.deepEqual(await page.locator('.thought-fold').evaluateAll(els => els.map(el => el.open)), [false, false, true]);
    assert.deepEqual(await page.locator('.work-summary.is-thought-steps > summary .work-label').allTextContents(), ['3 steps', '2 steps']);
  } },
  { id: 'gemini-update-steps', height: 780, focus: '.transcript', setup: async page => {
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    await send({ type: 'userMessage', text: 'Update thought and step bundling.' });
    await send({ type: 'routing', agentId: 'gemini', modelLabel: 'Gemini 4 Neon' });
    await send({ type: 'thought', text: 'Reading the current thought card handlers before updating the checklist view.', agent: 'gemini' });
    await send({ type: 'tool_start', toolId: 'r1', name: 'read_file', command: 'ai-chat-panel/media/main.js', agent: 'gemini' });
    await send({ type: 'tool_end', toolId: 'r1', output: 'ok', agent: 'gemini' });
    await send({ type: 'tool_start', toolId: 'r2', name: 'read_file', command: 'ai-chat-panel/media/style.css', agent: 'gemini' });
    await send({ type: 'tool_end', toolId: 'r2', output: 'ok', agent: 'gemini' });
    await send({ type: 'tool_start', toolId: 'u1', name: 'update_steps', command: 'Refine nested thought-step styles (2/4)', agent: 'gemini' });
    await send({ type: 'tool_end', toolId: 'u1', output: '✓ Update thought and tool bundling logic\n▸ Refine nested thought-step styles\n○ Update and add UI verification tests\n○ Verify tests and inspect screenshots', agent: 'gemini' });
    await send({ type: 'tool_start', toolId: 'e1', name: 'edit_file', command: 'ai-chat-panel/media/style.css', agent: 'gemini' });
    await send({ type: 'tool_end', toolId: 'e1', output: 'done', agent: 'gemini' });
    await page.waitForTimeout(450);
    assert.equal(await page.locator('.thought-fold').first().evaluate(el => el.open), false);
    assert.equal(await page.locator('.tool-card.tool-todo').first().evaluate(el => el.open), true);
    assert.equal(await page.locator('.tool-card.tool-todo .todo-step.is-active').count(), 1);
  } },
  // Halo, the minimal look (aiChatPanel.appearance = 'halo', media/halo.css and halo.js). Each one switches live, the way the
  // host does when the setting changes, so the switch itself is covered too. The whole matrix also runs in Halo with
  // CLANKER_UI_APPEARANCE=halo (see docs/ui-tester.md).
  ...['dark', 'light', 'contrast-dark'].map(theme => ({ id: `halo-empty-${theme}`, sidebar: true, setup: async page => {
    await applyIdePalette(page, IDE_PALETTES[theme]);
    await toHalo(page);
    assert.equal(await page.locator('.rail').isVisible(), false, 'the rail gives way to the header');
    assert.equal(await page.locator('.halo-top').isVisible(), true);
    assert.match(await page.locator('.halo-hello h2').textContent(), /^(Hi \S+|Hello)$/);
    assert.equal(await page.locator('.empty-mark').isVisible(), false, 'no mascot in Halo');
    assert.equal(await page.locator('#scheduleBtn').isVisible(), false, 'the clock waits until a send time is armed');
  } })),
  { id: 'halo-more-menu', sidebar: true, focus: '#haloMenu', setup: async page => {
    await toHalo(page);
    await page.locator('.halo-top [data-halo="more"]').click();
    await page.locator('#haloMenu').waitFor();
    const shown = await page.locator('#haloMenu .halo-item:visible').allTextContents();
    assert.deepEqual(shown.map(text => text.trim()), ['Open in editor', 'Schedule next message', 'Loops', 'Settings'], 'only what applies: no queue and no update without one');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Open in editor', 'the menu takes the keyboard');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Schedule next message');
  } },
  { id: 'halo-header-actions', sidebar: true, focus: MODAL, setup: async page => {
    await toHalo(page);
    const more = page.locator('.halo-top [data-halo="more"]');
    await more.click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#haloMenu').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'More', 'Esc hands focus back');
    await more.click();
    await page.locator('#haloMenu [data-halo="popOut"]').click();
    assert.ok(await page.evaluate(() => window.sent.some(m => m.type === 'newChatWindow')), 'Open in editor is the rail\'s pop-out');
    await more.click();
    await page.locator('#haloMenu [data-halo="schedule"]').click();
    assert.equal(await page.locator('#scheduleBtn').isVisible(), true, 'arming a send time brings the clock back');
    await page.locator('.halo-top [data-halo="chats"]').click();
    await page.locator('#historyModal:not([hidden])').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#historyModal').waitFor({ state: 'hidden' });
    await more.click();
    await page.locator('#haloMenu [data-halo="settings"]').click();
    await page.locator('#settingsModal:not([hidden])').waitFor();
    await page.waitForTimeout(300);
  } },
  ...['dark', 'light'].map(theme => ({ id: `halo-steps-${theme}`, height: 850, setup: async page => {
    await applyIdePalette(page, IDE_PALETTES[theme]);
    await toHalo(page);
    await copilotToolCards(page, false);
    const card = await page.locator('.work-steps .tool-shell').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow }));
    assert.deepEqual(card, { bg: 'rgba(0, 0, 0, 0)', shadow: 'none' }, 'a step is a row in the panel, not a card inside it');
    assert.equal(await page.locator('.turn').evaluate(el => getComputedStyle(el, '::before').content), 'none', 'no timeline rail');
    assert.notEqual(await page.locator('.turn > .msg-role').evaluate(el => getComputedStyle(el, '::before').content), 'none', 'the spark leads the reply');
  } })),
  { id: 'halo-running', height: 780, focus: '.compose-row', setup: async page => {
    await toHalo(page);
    const send = data => page.evaluate(msg => window.dispatchEvent(new MessageEvent('message', { data: msg })), data);
    await send({ type: 'userMessage', text: 'Investigate the slow startup and fix it.' });
    await send({ type: 'routing', agentId: 'gemini', modelLabel: 'Gemini 4 Neon' });
    await send({ type: 'tool_start', toolId: 'r1', name: 'read_file', command: 'src/boot.js', agent: 'gemini' });
    await send({ type: 'tool_end', toolId: 'r1', output: 'ok', agent: 'gemini' });
    const ring = () => page.locator('.composer').evaluate(el => getComputedStyle(el, '::before').content);
    assert.ok(await page.evaluate(() => document.body.classList.contains('is-turn-busy')));
    assert.notEqual(await ring(), 'none', 'the halo turns round the composer while the reply is written');
    assert.equal(await page.locator('.msg-pending').evaluate(el => getComputedStyle(el).backgroundImage), 'none', 'working is a spark and a word, not a pill');
    await send({ type: 'turn_complete' });
    assert.equal(await ring(), 'none', 'and stops when it is done');
    await send({ type: 'userMessage', text: 'Now the shutdown path.' });
    await send({ type: 'routing', agentId: 'gemini', modelLabel: 'Gemini 4 Neon' });
    await page.waitForTimeout(300);
  } },
  { id: 'halo-cli-update', sidebar: true, focus: '#haloMenu', setup: async page => {
    await toHalo(page);
    const status = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data: {
      checking: false, notes: {}, catalog: [], prompts: {}, modelSettings: {}, fetched: [], favorites: [], modelsBusy: false, ...data } })), data);
    await status({ type: 'cliStatus', versions: { claude: { version: '2.1.306', latest: '2.1.308', outdated: true }, codex: { version: '0.9.1', latest: '0.9.2', outdated: true } },
      updates: ['claude', 'codex'], updating: { claude: { startedAt: Date.now() - 8000, estimateMs: 20000 }, codex: { startedAt: Date.now() - 4000, estimateMs: 20000 } } });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.halo-top .halo-dot').isVisible(), true, 'the rail is hidden: More carries the signal');
    await page.locator('.halo-top [data-halo="more"]').click();
    const item = page.locator('#haloMenu [data-halo="update"]');
    assert.match(await item.textContent(), /Updating 2 CLIs/, 'progress shows in the menu');
    assert.equal(await item.isDisabled(), true, 'no second update while one runs');
  } },
  { id: 'halo-model-menu', scope: '#modelMenu', focus: '.model-menu-stage', setup: async page => {
    await toHalo(page);
    await page.locator('#modelPill').click();
    await page.waitForTimeout(700);
  } },
  { id: 'halo-settings-look', sidebar: true, focus: MODAL, setup: async page => {
    await toHalo(page);
    await openSettings('general')(page);
    await page.locator('#settingsModal:not([hidden]) .look-pill').first().waitFor();
    await page.locator('.look-pill[data-look="clanker"]').click();
    assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'setAppearance').at(-1)), { type: 'setAppearance', appearance: 'clanker' });
    assert.equal(await page.locator('.look-pill[data-look="clanker"]').getAttribute('aria-checked'), 'true');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'appearance', appearance: 'clanker' } })));
    assert.equal(await page.evaluate(() => document.body.classList.contains('ui-halo')), false, 'the host\'s broadcast switches back live');
    assert.equal(await page.locator('.halo-top').isVisible(), false);
    await page.locator('.look-pill[data-look="halo"]').click();
    await toHalo(page);
    await page.waitForTimeout(300);
  } },
];
