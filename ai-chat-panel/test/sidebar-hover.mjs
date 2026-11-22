// Repeated real sidebar hovers: stable SVG geometry, translucent material, and no model calls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
import { scenarios } from './ui-tester/scenarios.mjs';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: false });
try {
  const { page } = await openChat(browser, { width: 900, height: 1100, sidebar: true });
  await scenarios.find(s => s.id === 'recent-context-hover').setup(page);
  if (process.argv.includes('--light')) await page.evaluate(() => { document.body.classList.add('vscode-light'); document.body.classList.remove('vscode-dark'); });
  await page.clock.resume();
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    window.hoverPathWrites = 0;
    new MutationObserver(records => { window.hoverPathWrites += records.filter(r => r.attributeName === 'd').length; })
      .observe(document.querySelector('.history-list'), { subtree: true, attributes: true, attributeFilter: ['d'] });
    window.hoverFrames = [];
    let last = performance.now();
    window.hoverRaf = requestAnimationFrame(function frame(now) { window.hoverFrames.push(now - last); last = now; window.hoverRaf = requestAnimationFrame(frame); });
  });
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(5, 5); await page.waitForTimeout(280);
    await page.locator('.history-item').first().hover(); await page.waitForTimeout(280);
  }
  const result = await page.evaluate(() => {
    cancelAnimationFrame(window.hoverRaf);
    return { pathWrites: window.hoverPathWrites, frames: window.hoverFrames.length,
      averageMs: window.hoverFrames.reduce((a, b) => a + b, 0) / window.hoverFrames.length,
      over33ms: window.hoverFrames.filter(n => n > 33).length,
      fill: getComputedStyle(document.querySelector('.history-peek-fill')).fill };
  });
  assert.equal(result.pathWrites, 0, 'hover never resizes or redraws the SVG outline');
  assert.match(result.fill, /0\.85\)/, 'the refracting surface stays dense enough that page text behind it cannot ghost through the labels');
  assert.match(await page.locator('.rail-glass').evaluate(el => getComputedStyle(el).backdropFilter), /url\(/, 'the shared-page backdrop uses the lens filter');
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await page.mouse.move(5, 5); await page.waitForTimeout(500);
  assert.equal(await page.locator('.rail-glass').evaluate(el => el.hidden), true, 'the shared lens disappears after the closing transition');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
