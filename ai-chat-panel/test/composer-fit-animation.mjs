import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

// The bar's fit steps (main.js fitComposerBar) must come from the layout alone. The stop/send buttons sit flush with the bar's right edge
// and enter with a scale + rotate animation, and hover scales them: measured with those transforms, a 1px overshoot made every control
// shrink on a wide panel, and it stayed small until the next button press.
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const { page } = await openChat(browser, { width: 721, height: 700 });
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const fit = () => page.evaluate(() => [...document.querySelector('.composer').classList].filter(name => name.startsWith('fit-')));
  await send({ type: 'chatLoaded', chat: { id: 'fit', messages: [{ role: 'user', text: 'Work.' }] }, running: { agentId: 'claude', startedAt: Date.now() } });
  await page.waitForTimeout(1200);
  assert.deepEqual(await fit(), [], 'a wide panel starts with the full bar');

  // A re-measure in the middle of the entrance animation (any label or hidden change does it) must not shrink anything for good.
  await page.locator('#promptInput').fill('hello');
  await page.waitForTimeout(150);
  await page.evaluate(() => { const label = document.querySelector('.model-picker-label'); label.textContent = label.textContent + ''; });
  assert.deepEqual(await fit(), [], 'measured mid-animation, the bar is still full');
  await page.waitForTimeout(1200);
  assert.deepEqual(await fit(), [], 'and it is still full when the animation is over');

  // Hovering the button scales it; a measure while hovered must not count that either.
  await page.locator('#sendBtn').hover();
  await page.waitForTimeout(250);
  await page.evaluate(() => { const label = document.querySelector('.model-picker-label'); label.textContent = label.textContent + ''; });
  assert.deepEqual(await fit(), [], 'a hovered, scaled button does not shrink the bar');

  // The steps still work when the room really is short, and come back when it returns.
  await page.setViewportSize({ width: 240, height: 700 });
  await page.waitForTimeout(300);
  assert.ok((await fit()).length >= 3, 'a narrow panel sheds text and shrinks the buttons');
  await page.setViewportSize({ width: 721, height: 700 });
  await page.waitForTimeout(300);
  assert.deepEqual(await fit(), [], 'widening brings everything back');
  console.log('composer-fit-animation ok');
} finally { await browser.close(); }
