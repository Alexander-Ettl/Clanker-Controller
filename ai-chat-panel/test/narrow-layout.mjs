import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

// A narrow panel never wraps the composer's bar or a scheduled prompt onto a third line. Both shed text in a fixed order and
// bring it back in the reverse order as the panel widens:
//   bar:  permission text, then the model's name, then the clock's time, then the buttons shrink to a plain row of icons
//   row:  "at reset", then the time (the clock stays, its tooltip says it), then the model's name
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const WIDTHS = [700, 560, 480, 440, 400, 360, 340, 320, 300, 280, 260, 240, 230];
  const seen = [];
  for (const width of WIDTHS) {
    const { page, problems } = await openChat(browser, { width, height: 800 });
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const now = await page.evaluate(() => Date.now());
    const base = { chatId: 'narrow', model: 'claude', modelId: 'claude-sonnet-5-5-high', status: 'pending', dispatchTrigger: 'quota-reset', notBefore: new Date(now + 45 * 60000 + 45000).toISOString(), attachments: [] };
    const files = [{ name: 'a.png', path: '/s/a.png', mime: 'image/png', uri: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22/%3E' }];
    await send({ type: 'chatLoaded', chat: { id: 'narrow', modelId: base.modelId, messages: [{ role: 'user', text: 'Work.' }] } });
    await send({ type: 'quotas', quotas: { claude: { remaining: 80, resetsAt: now / 1000 + 45 * 60 + 45 } } });
    await send({ type: 'schedulerQueue', queue: [
      { ...base, id: 'plain', prompt: 'continue' },
      { ...base, id: 'files', prompt: 'Add the new glass to the controller and check it', files, attachments: [{ name: 'a.png', mimeType: 'image/png', absolutePath: '/s/a.png' }] },
    ] });
    await page.evaluate(() => { const chip = document.getElementById('agentsBtn'); chip.hidden = false; chip.querySelector('.agents-chip-count').textContent = '3'; });
    await page.locator('#scheduleBtn').click(); // usage reset: the clock shows its countdown
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
    const tag = `at ${width}px`;

    const state = await page.evaluate(() => {
      const visible = el => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
      const rect = el => el.getBoundingClientRect();
      const composer = document.querySelector('.composer');
      const bar = [...composer.querySelectorAll('.composer-tools > :not([hidden]), .composer-actions > :not([hidden], .mic-wrap), .composer-actions > .mic-wrap > :not([hidden])')].filter(visible).map(rect).sort((a, b) => a.left - b.left);
      const apart = boxes => boxes.every((box, i) => i === 0 || box.left >= boxes[i - 1].right - 0.5);
      const rows = [...document.querySelectorAll('.turn-queue-item:not(.turn-queue-skeleton)')].map(row => {
        const parts = [...row.querySelectorAll(':scope > .model-pill, :scope > .turn-queue-files, :scope > .turn-queue-when, .turn-queue-actions')].filter(visible).map(rect).sort((a, b) => a.left - b.left);
        const text = row.querySelector('.turn-queue-when-text');
        return {
          height: Math.round(rect(row).height),
          apart: apart(parts) && parts.at(-1).right <= rect(row).right,
          lead: visible(row.querySelector('.tq-lead')), time: visible(text), label: visible(row.querySelector('.model-pill-label')),
          tip: row.querySelector('.turn-queue-when').title, hasFiles: Boolean(row.querySelector('.turn-queue-files')),
        };
      });
      const clock = document.getElementById('scheduleBtn');
      return {
        barApart: apart(bar) && bar.at(-1).right <= rect(composer).right && bar[0].left >= rect(composer).left,
        barMiddles: bar.map(box => Math.round((box.top + box.bottom) / 2)),
        perm: visible(composer.querySelector('.perm-chip-label')), model: visible(composer.querySelector('.model-picker-label')), clockTime: visible(clock.querySelector('.schedule-time')),
        clockTip: clock.title, bar: bar.length,
        rows,
      };
    });
    assert.equal(state.bar, 8, `${tag}: the bar holds +, model, agents, permissions, clock, format, dictate and send`);
    assert.ok(state.barApart, `${tag}: the bar's eight buttons sit side by side inside the composer`);
    assert.ok(Math.max(...state.barMiddles) - Math.min(...state.barMiddles) <= 8, `${tag}: the bar is one line (${state.barMiddles})`);
    assert.ok(state.rows.every(row => row.apart), `${tag}: nothing on a scheduled row's second line overlaps`);
    assert.equal(new Set(state.rows.map(row => row.height)).size, 1, `${tag}: a row with files is no taller than one without (two lines each)`);
    assert.match(state.rows[0].tip, /^at reset · \d+m \d+s$/, `${tag}: the row's time is in its tooltip`);
    if (!state.clockTime) assert.match(state.clockTip, /^\d+:\d\d · /, `${tag}: with the clock's time hidden, its tooltip carries it`);
    seen.push({ width, ...state, plain: state.rows[0], files: state.rows[1] });
    assert.deepEqual(problems, [], `${tag}: no page errors`);
    await page.close();
  }

  // Widest first: a part that is gone stays gone as the panel narrows, and the parts go in the promised order.
  const goneAt = (pick) => seen.findIndex(entry => !pick(entry)); // index of the first (widest) width without it; -1 never
  const stays = (name, pick) => { const gone = seen.map(entry => !pick(entry)); assert.deepEqual(gone, [...gone].sort((x, y) => x - y), `${name}: once gone, it stays gone`); };
  const inOrder = (name, picks) => picks.forEach((pick, i) => { if (i) assert.ok(goneAt(picks[i - 1]) !== -1 && goneAt(picks[i - 1]) <= goneAt(pick) || goneAt(pick) === -1 && goneAt(picks[i - 1]) !== -1, `${name}: order`); });
  const bar = [entry => entry.perm, entry => entry.model, entry => entry.clockTime];
  bar.forEach((pick, i) => stays(`bar part ${i}`, pick));
  inOrder('bar (permission text, model name, clock time)', bar);
  for (const who of ['plain', 'files']) {
    const row = ['lead', 'time', 'label'].map(key => entry => entry[who][key]);
    row.forEach((pick, i) => stays(`${who} row part ${i}`, pick));
    inOrder(`${who} row (at reset, time, model name)`, row);
  }
  assert.ok(seen.some(entry => !entry.perm && entry.model && entry.clockTime), 'the permission text goes first, while the model name and the time stay');
  assert.ok(seen.some(entry => !entry.model && entry.clockTime), 'then the model name goes, while the time stays');
  assert.ok(seen.some(entry => !entry.clockTime), 'then the clock keeps only its icon');
  console.log('Narrow layout: one-line bar, text shed in order (permission, model, time), two-line scheduled rows (at reset, time, model) passed.');
} finally { await browser.close(); }
