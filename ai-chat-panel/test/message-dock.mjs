import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const dockState = page => page.locator('.msg-group-user').first().evaluate(group => ({
  painted: decodeURIComponent(getComputedStyle(group).backgroundImage).includes('id="nb"'),
  opacity: Number(getComputedStyle(group.querySelector('.msg-actions')).opacity),
}));

export async function messageDock(page, { expanded = false, dock = false } = {}) {
  const image = { path: '/attachments/reference.png', name: 'reference.png', mime: 'image/png', dims: '315×348',
    uri: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="315" height="348"><rect width="315" height="348" fill="#aab8cb"/><rect x="35" y="42" width="245" height="264" rx="12" fill="#fff"/></svg>') };
  const chat = { id: 'message-dock', messages: [
    { role: 'user', text: 'Please refine the admin panel and its dropdown menus. Keep the design consistent and make the help articles easier to find.\n\nCheck the layout at desktop and phone widths, explain the changes, and verify the result before finishing.\n\nKeep the original attachment available while reviewing the details.', files: [image], at: '2026-03-02T07:00:00Z' },
    { role: 'assistant', text: 'I am reviewing the layout and checking the dropdown menus.', agent: 'claude', at: '2026-03-02T07:01:00Z' },
  ] };
  await send(page, { type: 'chatLoaded', chat });
  await page.clock.runFor(80);
  const group = page.locator('.msg-group-user').first(), bubble = group.locator('.msg-user');
  // Halo (aiChatPanel.appearance = 'halo') draws a flat bubble: no fused outline is ever painted, everything else holds.
  const outline = !(await page.evaluate(() => document.body.classList.contains('ui-halo')));
  await group.locator('.msg-clamp-toggle').waitFor({ state: 'attached' });
  await page.waitForTimeout(400);
  // Attachment focus must not paint an empty dock after the pointer leaves (the attached screenshot).
  await group.locator('.attachment-chip').focus();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(180);
  const idle = await dockState(page);
  assert.equal(idle.opacity, 0);
  assert.equal(idle.painted, false, 'attachment focus must not leave an empty dock outline');
  const toggle = bubble.locator('.msg-clamp-toggle');
  await toggle.waitFor({ state: 'visible' });
  const bounds = await toggle.boundingBox(), text = await group.locator('.msg-user-text').boundingBox();
  assert.ok(Math.abs(bounds.x - text.x) < 8 && bounds.y >= text.y && bounds.y + bounds.height <= text.y + text.height + 2, 'Show more belongs over the lower-left of the text');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await toggle.textContent(), 'Show less');
  const expandedText = await group.locator('.msg-user-text').boundingBox();
  assert.ok(expandedText.height > text.height + 5, 'expanding must reveal the hidden text');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  // Shape and content must follow the same CSS state on pointer enter/leave.
  await bubble.hover();
  await page.waitForTimeout(180);
  assert.equal((await dockState(page)).painted, outline);
  assert.equal((await dockState(page)).opacity, 1);
  await page.waitForTimeout(400);
  assert.equal(await group.locator('.msg-actions button').evaluateAll(buttons => buttons.every(button => {
    const rect = button.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return target === button || button.contains(target);
  })), true, 'Copy and Revert must be clickable inside the fused dock');
  assert.equal(await group.evaluate(group => group.querySelector('.msg-actions').getBoundingClientRect().top >= group.querySelector('.msg-user-content').getBoundingClientRect().bottom), true, 'the dock may overlap the tail padding, not the message text');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(180);
  assert.deepEqual(await dockState(page), { painted: false, opacity: 0 });
  // Keyboard navigation can still reveal and operate the dock; mouse focus elsewhere cannot pin it open.
  await page.keyboard.press('Tab');
  await group.getByRole('button', { name: 'Copy', exact: true }).focus();
  await page.waitForTimeout(180);
  assert.deepEqual(await dockState(page), { painted: outline, opacity: 1 });
  await page.locator('#promptInput').focus();
  await page.waitForTimeout(180);
  assert.deepEqual(await dockState(page), { painted: false, opacity: 0 });
  // Losing the window while hovered must hide the complete dock, including its painted background.
  await bubble.hover();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(180);
  assert.deepEqual(await dockState(page), { painted: false, opacity: 0 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.mouse.move(2, 2);
  await page.waitForTimeout(180);
  // A streaming reply can move the hovered bubble away without a physical pointer move.
  await bubble.hover();
  await send(page, { type: 'userMessage', text: 'Continue reviewing the pages.' });
  await send(page, { type: 'routing', agentId: 'claude' });
  await send(page, { type: 'delta', model: 'claude', text: 'Reviewing the next section and its responsive layout.\n\n'.repeat(60) });
  await page.clock.runFor(80);
  await page.waitForTimeout(180);
  assert.ok(await group.evaluate(element => element.getBoundingClientRect().bottom < 0), 'streaming should move the first bubble out of view');
  // Offscreen CSS transitions may only start resolving when style is queried; wait for the fade to settle.
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.msg-group-user .msg-actions')).opacity) === 0);
  assert.deepEqual(await dockState(page), { painted: false, opacity: 0 }, 'scrolling must not leave a stale dock');
  await send(page, { type: 'chatLoaded', chat });
  await page.clock.runFor(80);
  await page.waitForTimeout(400);
  if (expanded) await toggle.click();
  if (dock) await bubble.hover(); else { await page.locator('#promptInput').focus(); await page.mouse.move(2, 2); }
  await page.waitForTimeout(400);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  try {
    const out = path.resolve('out/ui-message-dock'); fs.mkdirSync(out, { recursive: true });
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const { page, problems } = await openChat(browser, { width: 900, height: 1000 });
      page.setDefaultTimeout(7000);
      await page.emulateMedia({ reducedMotion });
      await messageDock(page);
      assert.deepEqual(problems, []);
      await page.screenshot({ path: path.join(out, 'collapsed-' + reducedMotion + '.png') });
      await page.close();
    }
    console.log('Message dock: attachment focus, pointer exit, keyboard focus, window blur, and Show more/less passed in both motion modes.');
  } finally { await browser.close(); }
}
