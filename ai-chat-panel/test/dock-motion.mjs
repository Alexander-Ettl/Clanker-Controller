// Real-page regression: dock motion reuses SVG filters instead of decoding images every frame.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const browser = await chromium.launch();
try {
  const { page, problems } = await openChat(browser, { width: 900, height: 900, sidebar: true });
  await page.clock.resume();
  if (process.env.DEBUG_DOCK_KEYS) await page.evaluate(() => {
    window.debugKeys = [];
    const stringify = JSON.stringify;
    JSON.stringify = (value, ...args) => {
      const result = stringify(value, ...args);
      if (Array.isArray(value) && value.length === 4 && Array.isArray(value[3]) && value[3][0]?.rx) window.debugKeys.push(result);
      return result;
    };
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.originalDockFilters = [...document.querySelectorAll('#ig-silhouette-filter, #ig-light-filter')];
    window.dockImageWrites = [];
    new MutationObserver(records => {
      for (const r of records) if (r.target.matches('.ig-light, .ig-tint')) {
        window.dockImageWrites.push(r.target.getAttribute('style'));
      }
    }).observe(document.querySelector('.island-glass'), { subtree: true, attributes: true, attributeFilter: ['style'] });
  });
  await page.locator('#modelPill').click();
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.originalDockFilters.length === 2 && window.originalDockFilters.every(n => n.isConnected)), true);
  assert.equal(await page.evaluate(() => window.dockImageWrites.some(s => s.includes('data:image/svg'))), false);
  assert.equal(await page.locator('#ig-upper-silhouette path').count(), 1, 'menu retains its flat foot on the upper slab');
  assert.equal(await page.locator('#ig-silhouette path').count(), 0, 'the queue slab excludes the menu');
  await page.keyboard.press('Escape');
  await page.locator('textarea').first().fill('A growing composer\n'.repeat(8));
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => document.querySelector('.ig-light svg').getBoundingClientRect().height > 0), true);
  const darkFilter = await page.locator('.round-btn').first().evaluate(el => el.style.getPropertyValue('--lg-bd'));
  await page.evaluate(() => document.body.classList.add('vscode-light'));
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#ig-light-filter').count(), 1, 'theme updates leave one lighting graph');
  assert.notEqual(await page.locator('.round-btn').first().evaluate(el => el.style.getPropertyValue('--lg-bd')), darkFilter, 'small surfaces refresh their specular map when the theme changes');
  await page.evaluate(() => {
    const row = document.querySelector('.compose-row'), measure = row.getBoundingClientRect.bind(row);
    window.dockRestMeasurements = 0;
    row.getBoundingClientRect = () => { window.dockRestMeasurements++; return measure(); };
    const control = document.querySelector('#modelPill');
    window.controlPulse = control.animate([{ opacity: .8 }, { opacity: 1 }], { duration: 1000, iterations: Infinity });
    control.classList.add('perf-running-control');
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => { window.dockRestMeasurements = 0; });
  await page.waitForTimeout(350);
  assert.ok(await page.evaluate(() => window.dockRestMeasurements <= 2), 'a pulsing inner control must not keep stationary dock geometry polling');
  await page.evaluate(() => window.controlPulse.cancel());
  await page.locator('textarea').first().fill('');
  await page.locator('#modelPill').click(); await page.waitForTimeout(700);
  await page.waitForFunction(() => [...document.querySelectorAll('.island-glass')].every(el => el.classList.contains('is-refracted')));
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  await page.waitForFunction(() => [...document.querySelectorAll('.island-glass')].every(el => el.classList.contains('is-refracted')));
  await page.evaluate(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    window.repeatedDockEncodes = 0;
    HTMLCanvasElement.prototype.toBlob = function (...args) { window.repeatedDockEncodes++; return encode.apply(this, args); };
  });
  await page.locator('#modelPill').click(); await page.waitForTimeout(700);
  await page.waitForFunction(() => [...document.querySelectorAll('.island-glass')].every(el => el.classList.contains('is-refracted')));
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  await page.waitForFunction(() => [...document.querySelectorAll('.island-glass')].every(el => el.classList.contains('is-refracted')));
  if (process.env.DEBUG_DOCK_KEYS) console.log(await page.evaluate(() => window.debugKeys));
  assert.equal(await page.evaluate(() => window.repeatedDockEncodes), 0, 'reopening unchanged dock geometry reuses its encoded rim maps');
  assert.deepEqual(problems, []);
  console.log('Dock motion: retained filters, menu, composer growth, theme switch, idle geometry and cached mask encoding passed.');
} finally {
  await browser.close();
}
