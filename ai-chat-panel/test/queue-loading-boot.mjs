// The extension serves window.INITIAL_QUEUE_LOADING as null (scheduler not loaded yet) or a count. The fake host always serves 0,
// so a startup crash on those paths (main.js drawing the skeleton before its state existed) never showed in other tests.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

export async function queueLoadingBoot(browser) {
  for (const queueLoading of [null, 2, 7, 0]) {
    const { page, problems } = await openChat(browser, { width: 420, height: 800, queueLoading });
    const label = `INITIAL_QUEUE_LOADING=${JSON.stringify(queueLoading)}`;
    // The script must run to its end: it announces itself last-but-one and fills the project tiles / transcript afterwards.
    assert.equal(await page.evaluate(() => window.sent.some(item => item.type === 'chatReady')), true, `${label}: main.js must reach chatReady`);
    const strip = page.locator('.turn-queue-strip');
    if (queueLoading === 0 || queueLoading === null) assert.equal(await strip.isHidden(), true, `${label}: no known prompts on the way, no skeleton`);
    else {
      assert.equal(await strip.isVisible(), true, `${label}: skeleton rows stand in for the loading queue`);
      assert.equal(await strip.getAttribute('aria-busy'), 'true');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'schedulerQueue', queue: [] } })));
      assert.equal(await strip.isHidden(), true, `${label}: an empty queue must clear the skeleton`);
      assert.equal(await strip.getAttribute('aria-busy'), null);
    }
    assert.deepEqual(problems, [], label);
    await page.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  try {
    await queueLoadingBoot(browser);
    console.log('Queue loading boot: null, counted and zero initial queue states start cleanly and clear their skeleton.');
  } finally { await browser.close(); }
}
