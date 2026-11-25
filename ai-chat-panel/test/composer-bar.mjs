import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

// The composer is one squircle; the bar's order is fixed; stop and send share one slot; dictation locks send; the permission chip
// switches Ask / Auto / Full Access; the @ and / lists are menus on the composer's upper slab, above the queue.
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  for (const width of [900, 420, 300]) {
    const { page, problems } = await openChat(browser, { width, height: 760 });
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const box = selector => page.evaluate(selector => {
      const el = document.querySelector(selector), r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, shown: r.width > 0 };
    }, selector);
    const turns = [1, 2, 3].map(n => ({ id: `t${n}`, text: `Queued prompt ${n}`, modelId: 'auto', attachments: [], files: [] }));
    await send({ type: 'chatLoaded', chat: { id: 'bar', messages: [{ role: 'user', text: 'Work.' }], turnQueue: { turns, paused: false } }, running: { agentId: 'claude', startedAt: Date.now() } });
    await send({ type: 'workspaceFiles', files: ['README.md', 'src/main.js', 'docs/guide.md'], root: 'C:/p' });
    await send({ type: 'slashCommands', commands: [{ name: 'verify', description: 'Toggle Auto-Verify', panel: true }] });
    await page.waitForTimeout(1200); // past the stop button's own entrance animation
    const tag = `at ${width}px`;

    // One shape at every width: text on top, bar below, never a one-line pill.
    const composer = await box('.composer'), input = await box('#promptInput');
    assert.ok(input.width >= composer.width - 32, `${tag}: the text row spans the composer`);
    assert.ok((await box('#attachBtn')).top >= input.bottom - 2, `${tag}: the bar sits below the text`);

    // Bar order: + then the model, then the agents/permission chips on the left; clock, dictate, stop/send on the right.
    const [attach, model, perm, clock, mic, stop] = await Promise.all(['#attachBtn', '#modelPill', '#permBtn', '#scheduleBtn', '#micBtn', '#stopBtn'].map(box));
    assert.ok(model.left >= attach.right - 1 && model.left - attach.right < 12, `${tag}: the model sits right behind the plus`);
    assert.ok(perm.left >= model.right - 1, `${tag}: the permission chip follows the model`);
    assert.ok(clock.right <= mic.left + 1 && mic.right <= stop.left + 1, `${tag}: clock, dictate, then the stop/send slot`);
    assert.ok(stop.right <= composer.right, `${tag}: the slot stays inside the composer`);

    // Busy and empty: stop alone in the slot. Typing: send takes the very same spot, stop goes.
    assert.equal(await page.locator('#sendBtn').isHidden(), true, `${tag}: send is hidden while there is nothing to send`);
    await page.locator('#promptInput').fill('hello');
    await page.waitForTimeout(900); // the send button scales in; measure it at rest
    assert.equal(await page.locator('#stopBtn').isHidden(), true, `${tag}: no stop button while typing`);
    const slot = await box('#sendBtn');
    assert.ok(Math.abs(slot.right - stop.right) < 1 && Math.abs(slot.top - stop.top) < 1, `${tag}: send takes stop's exact place`);
    assert.equal(await page.locator('#sendBtn').getAttribute('data-mode'), 'queue');
    const micBefore = await box('#micBtn');
    await page.locator('#promptInput').fill('');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#sendBtn').isHidden(), true);
    assert.equal(await page.locator('#stopBtn').isVisible(), true);
    const micAfter = await box('#micBtn');
    assert.equal(micBefore.left, micAfter.left, `${tag}: the dictate button never moves when send and stop swap`);

    // Dictation: send is greyed out and Enter does nothing until it is finished or cancelled.
    await page.locator('#promptInput').fill('half a thought');
    await send({ type: 'micState', state: 'recording' });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#sendBtn').isDisabled(), true, `${tag}: send is greyed out while dictating`);
    const before = await page.evaluate(() => window.sent.filter(message => message.type === 'queueTurn' || message.type === 'send').length);
    await page.locator('#promptInput').press('Enter');
    assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'queueTurn' || message.type === 'send').length), before, `${tag}: Enter cannot send while dictating`);
    await send({ type: 'micState', state: 'idle' });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#sendBtn').isEnabled(), true, `${tag}: send is back once dictation ends`);
    await page.locator('#promptInput').fill('');

    // Permission chip: shows the active mode, switches it, and a model override is edited in place.
    assert.equal(await page.locator('#permBtn').getAttribute('data-mode'), 'fullAccess');
    await send({ type: 'permission', mode: 'ask', models: {} });
    assert.equal(await page.locator('#permBtn').getAttribute('data-mode'), 'ask');
    await page.locator('#permBtn').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#permMenu').evaluate(el => el.classList.contains('is-open')), true);
    await page.locator('.perm-option[data-mode="auto"]').click();
    assert.equal(await page.locator('#permBtn').getAttribute('data-mode'), 'auto');
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(message => message.type === 'setPermissionMode')), { type: 'setPermissionMode', mode: 'auto' });
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#permMenu').evaluate(el => el.classList.contains('is-open')), false, `${tag}: choosing closes the menu`);
    await send({ type: 'permission', models: { auto: { permissionMode: 'ask' } } }); // the active model ("auto") now has its own override
    assert.equal(await page.locator('#permBtn').getAttribute('data-mode'), 'ask', `${tag}: a model's override wins over the general mode`);
    await page.locator('#permBtn').click();
    await page.locator('.perm-option[data-mode="fullAccess"]').click();
    assert.deepEqual(await page.evaluate(() => window.sent.findLast(message => message.type === 'setModelSettings')), { type: 'setModelSettings', id: 'auto', permissionMode: 'fullAccess' });

    // The @ list is a menu on the upper slab: it rests on the composer, over the queue, fused by liquid-glass.
    await page.locator('#promptInput').focus();
    await page.locator('#promptInput').pressSequentially('@');
    await page.waitForTimeout(600);
    const list = await box('.mention-list'), top = await box('.composer'), queue = await box('.turn-queue-strip');
    assert.equal(await page.locator('.mention-list').evaluate(el => el.classList.contains('is-open')), true, `${tag}: @ opens the list`);
    assert.ok(Math.abs(list.bottom - top.top) < 4, `${tag}: the list rests on the composer's top edge`);
    assert.ok(list.top < queue.bottom && list.bottom > queue.top, `${tag}: the list overlaps the queue instead of floating above all of it`);
    assert.equal(await page.locator('.mention-list').evaluate(el => el.parentElement.classList.contains('model-menu-stage')), true);
    assert.equal(await page.locator('.compose-row > .mention-menu, .compose-row > .slash-bud').count(), 0, `${tag}: nothing of the old lists is left in the dock`);
    await page.keyboard.press('Escape');
    await page.locator('#promptInput').fill('');
    await page.locator('#promptInput').pressSequentially('/');
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.slash-list').evaluate(el => el.classList.contains('is-open')), true, `${tag}: / opens the command list`);
    assert.equal(await page.locator('.mention-list').evaluate(el => el.classList.contains('is-open')), false);
    await page.locator('#modelPill').click(); // opening the model menu puts the list away
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.slash-list').evaluate(el => el.classList.contains('is-open')), false, `${tag}: one menu at a time`);
    assert.deepEqual(problems, [], `${tag}: no page errors`);
    await page.close();
  }
  console.log('Composer bar: one squircle, fixed bar order, one stop/send slot, dictation lock, permission chip and upper-slab @ / lists passed.');
} finally { await browser.close(); }
