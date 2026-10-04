import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const media = new URL('../ai-chat-panel/media/', import.meta.url);
const read = (name) => readFile(new URL(name, media), 'utf8');
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 600 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<style>${await read('style.css')}${await read('launcher.css')}
    body { margin: 0; } .rail { position: absolute; right: 0; top: 100px; }
    </style><aside class="rail"><div id="modelCards" class="model-cards"></div>
    <div id="historyList"></div><button id="settingsBtn"></button><button id="popOutBtn"></button>
    <button id="updatesBtn"></button></aside>`);
  await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
  for (const name of ['burn-rate.js', 'launcher.js']) await page.addScriptTag({ content: await read(name) });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'quotas', quotas: { claude: { remaining: 92, windowMinutes: 300,
      resetsAt: (Date.now() + 290 * 60000) / 1000 } },
  } })));
  const ring = page.locator('.model-card-claude .ring');
  const burn = ring.locator('.ring-burn');
  assert.match(await burn.textContent(), /1h 55m left/);
  assert.match(await ring.getAttribute('aria-label'), /includes idle time/);
  for (const width of [360, 280]) {
    await page.setViewportSize({ width, height: 600 });
    await ring.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ring-burn')).opacity === '1');
    const pill = await ring.locator('.ring-pill').boundingBox();
    const label = await burn.boundingBox();
    assert.ok(pill.x >= 0 && pill.x + pill.width <= width, 'pill fits viewport');
    assert.ok(label.y >= pill.y && label.y + label.height <= pill.y + pill.height, 'burn text fits pill');
    assert.equal(await burn.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'burn text fits width');
    await page.mouse.move(0, 0);
    await ring.focus();
    assert.equal(await ring.evaluate(el => el.matches(':focus-visible')), true);
    assert.equal(await burn.evaluate(el => getComputedStyle(el).opacity), '1');
    await ring.evaluate(el => el.blur());
  }
  assert.deepEqual(errors, []);
  console.log('Burn-rate hover and keyboard layout passed at 360px and 280px.');
} finally {
  await browser.close();
}
