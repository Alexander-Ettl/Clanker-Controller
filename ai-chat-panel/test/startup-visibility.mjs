// Reproduce a cold webview: hold its stylesheet while the raw controls are parsed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
const browser = await chromium.launch();
try {
  for (const sidebar of [false, true]) {
    const { page, problems } = await openChat(browser, { width: 900, height: 900, sidebar });
    await page.clock.resume();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ui-loading'));
    await page.addInitScript(() => {
      window.earlyOptics = 0;
      for (const method of ['toDataURL', 'toBlob']) {
        const original = HTMLCanvasElement.prototype[method];
        HTMLCanvasElement.prototype[method] = function (...args) {
          if (document.documentElement.hasAttribute('data-ui-loading')) window.earlyOptics++;
          return original.apply(this, args);
        };
      }
    });
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { arrived = resolve; });
    await page.route('**/style.css', async route => { arrived(); await held; await route.fallback(); });
    const loading = page.reload();
    await requested;
    try {
      await page.locator('#newChatBtn').waitFor({ state: 'attached' });
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).opacity), '0', 'unstyled controls stay invisible');
      assert.equal(await page.locator('body').evaluate(el => el.inert), true, 'startup controls cannot receive input');
      assert.equal(await page.locator('html').getAttribute('data-ui-loading'), '');
    } finally { release(); }
    await loading;
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ui-loading'));
    assert.equal(await page.locator('#newChatBtn').isVisible(), true);
    assert.equal(await page.locator('#newChatBtn svg').evaluate(el => el.getBoundingClientRect().width < 40), true, 'first visible controls have their styled dimensions');
    assert.equal(await page.evaluate(() => window.earlyOptics), 0, 'lens encoding never blocks the styled reveal');
    await page.waitForFunction(() => [...document.querySelectorAll('.round-btn')].some(el => el.style.getPropertyValue('--lg-bd')));
    assert.deepEqual(problems, []);
    await page.unroute('**/style.css');
    let releaseScript, scriptArrived;
    const scriptHeld = new Promise(resolve => { releaseScript = resolve; });
    const scriptRequested = new Promise(resolve => { scriptArrived = resolve; });
    await page.route('**/settings.js', async route => { scriptArrived(); await scriptHeld; await route.fallback(); });
    const scriptsLoading = page.reload();
    await scriptRequested;
    try {
      await page.locator('#newChatBtn').waitFor({ state: 'attached' });
      assert.equal(await page.locator('body').evaluate(el => el.inert), true, 'parallel script fetches cannot reveal a half-initialized page');
    } finally { releaseScript(); }
    await scriptsLoading;
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ui-loading'));
    await page.locator('#modelPill').click();
    assert.equal(await page.locator('#modelMenu').evaluate(el => el.classList.contains('is-open')), true, 'the first interaction works after deferred dependencies initialize');
    await page.keyboard.press('Escape');
    await page.unroute('**/settings.js');
    await page.route('**/style.css', route => route.fulfill({ status: 404, body: '' }));
    await page.reload();
    await page.locator('.startup-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#newChatBtn').count(), 0, 'a failed stylesheet never exposes raw controls');
    await page.close();
  }
  console.log('Startup: delayed styles/scripts stay hidden, first interaction works, optics follow reveal, and missing styles recover in both layouts.');
} finally { await browser.close(); }
