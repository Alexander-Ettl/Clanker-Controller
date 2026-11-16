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
const { DEFAULTS } = createRequire(import.meta.url)('../../lib/routing');
const openSettings = tab => page => page.evaluate(name => window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings', tab: name } })), tab);
const loopsState = state => async page => {
  await page.evaluate(name => window.setFakeState(name), state);
  await page.locator('#loopsBtn').click();
  await page.locator('.inv .inv-overview').waitFor();
};
const MODAL = '.fs-modal:not([hidden]) .fs-modal-sheet';

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

export const scenarios = [
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
    assert.equal(await badge.locator('img').count(), 2);
    await page.waitForFunction(() => [...document.querySelectorAll('.turn-queue-files img')].every(img => img.complete && img.naturalWidth > 0));
    await post({ type: 'schedulerQueue', queue: [{ ...task, files: files.slice(0, 1) }] });
    assert.match(await badge.textContent(), /1 photo/);
    await post({ type: 'schedulerQueue', queue: [task] });
    assert.match(await badge.textContent(), /2 photos/);
    await page.waitForTimeout(450);
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
    await page.clock.fastForward(2000);
    assert.equal(await page.locator('.turn-queue-clock').count(), 1, 'elapsed tasks exchange the clock for the grip');
    await page.waitForTimeout(650);
    const first = page.locator('[data-task-id="ready-one"] .turn-queue-grip');
    const target = page.locator('[data-task-id="ready-two"]');
    const from = await first.boundingBox(), to = await target.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await post({ type: 'schedulerQueue', queue: structuredClone(tasks) });
    assert.equal(await page.locator('[data-task-id="ready-one"].is-dragging').count(), 1, 'queue snapshots preserve pointer capture');
    await page.mouse.move(to.x + from.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(message => message.type === 'reorderScheduledTasks').ids), ['ready-two', 'ready-one', 'future']);
    assert.deepEqual(await page.locator('.turn-queue-item').evaluateAll(rows => rows.map(row => row.dataset.taskId)), ['ready-two', 'ready-one', 'future']);
    assert.equal(await page.locator('[data-task-id="future"] .turn-queue-clock').count(), 1);
    await page.waitForTimeout(450);
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
    const update = { type: 'chatSynced', chat: { ...chat, messages: [...chat.messages, { role: 'user', text: 'Continued in ChatGPT' }, { role: 'assistant', agent: 'codex', text: 'The latest answer from ChatGPT.' }] } };
    await post(update);
    assert.equal(await page.locator('#promptInput').inputValue(), 'My unsent draft');
    assert.equal(await page.locator('.msg-user').count(), 2);
    assert.match(await page.locator('#transcript').innerText(), /latest answer from ChatGPT/);
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
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'chatLoaded', chat: { id: 'countdown-chat', modelId: 'claude-sonnet-5-5-high', messages: [] } });
      post({ type: 'quotas', quotas: { claude: { remaining: 80 }, codex: { remaining: 80 } } });
      post({ type: 'schedulerQueue', queue: [{ id: 'claude-wait', chatId: 'countdown-chat', model: 'claude', prompt: 'continue', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: new Date(Date.now() + 1800000).toISOString(), attachments: [] }] });
    });
    await page.waitForFunction(() => document.querySelector('.schedule-time').textContent !== '');
    await page.locator('#modelPill').click();
    await page.locator('.model-option[data-agent="codex"]').first().click();
    assert.equal(await page.locator('.schedule-time').innerText(), '', 'GPT does not inherit the Claude countdown');
    assert.match(await page.locator('.turn-queue-when').innerText(), /at reset/, 'the Claude queue row keeps its reset');
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
  { id: 'sidebar-loading', sidebar: true, height: 1500, focus: '.rail', setup: async page => {
    const projects = page.locator('.project-pill');
    const recent = page.locator('#historyList');
    assert.equal(await projects.getAttribute('aria-busy'), 'true');
    assert.equal(await recent.getAttribute('aria-busy'), 'true');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await projects.locator('.skeleton').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
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
    assert.deepEqual(await state(), [true, false, '65%', ['65', '100']]);
    assert.deepEqual(await ring('gemini'), [false, false, '80%', ['65', '100']]);
    assert.deepEqual(await ring('claude-gpt'), [false, false, '18%', ['65', '100']]);
    assert.deepEqual(await ring('argon'), [false, true, '100%', ['65', '100']]);
    assert.deepEqual(await ring('split'), [true, false, '65%', ['65', '100']]);
    await send(false);
    assert.deepEqual(await state(), [true, false, '65%', ['65']]);
    await ring('argon');
    assert.deepEqual(await state(), [false, false, '80%', ['65']]);
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
  { id: 'queue-edit-stability', focus: '.compose-row', setup: queueStability },
  { id: 'queue-reset-wait', focus: '.compose-row', setup: queueReset },
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
  { id: 'pdf-file-links', setup: async page => {
    const text = 'Open [Review notes](<out/review notes.pdf>), `review.pdf`, `C:\\Project Files\\review.PDF`, or out/review.pdf.\n\n[Website](https://example.com/review.pdf)';
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'pdf-links', messages: [{ role: 'assistant', text }] } } })), text);
    const badges = page.locator('#transcript .file-badge[data-ext="pdf"]');
    assert.equal(await badges.count(), 4);
    assert.equal(await page.locator('#transcript a[href="https://example.com/review.pdf"]').count(), 1);
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
  { id: 'model-menu', scope: '#modelMenu', focus: '#modelMenu', setup: async page => { await page.locator('#modelPill').click(); await page.locator('.model-option').first().waitFor(); await page.waitForTimeout(700); /* the spring-open takes 0.5s */ } },
  ...['general', 'voice', 'remote', 'models'].map(tab => ({ id: `settings-${tab}`, height: 1400, focus: MODAL, setup: openSettings(tab) })),
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
  ...LOOP_STATES.map(state => ({ id: `loops-${state}`, height: 2600, focus: MODAL, setup: loopsState(state) })),
];
