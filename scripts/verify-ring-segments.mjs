// Renders the launcher's usage rings with the real launcher.js and checks the split Gemini circle (two arcs, a gap between,
// one percentage and reset under each). Pictures go to --out=<dir> (default _work/ring-split). Needs Playwright with Edge.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const media = new URL('../ai-chat-panel/media/', import.meta.url);
const read = (name) => readFile(new URL(name, media), 'utf8');
const out = new URL(`${(process.argv.find((arg) => arg.startsWith('--out=')) || '--out=../_work/ring-split').slice(6).replace(/\/?$/, '/')}`, import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 360 }, deviceScaleFactor: 4, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<style>${await read('style.css')}${await read('launcher.css')}
    body { margin: 0; } .rail { position: absolute; right: 0; top: 0; width: 75px; padding: 10px; box-sizing: border-box; }
    </style><aside class="rail"><div id="modelCards" class="model-cards"></div>
    <div id="historyList"></div><button id="settingsBtn"></button><button id="popOutBtn"></button><button id="updatesBtn"></button></aside>`);
  await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
  await page.addScriptTag({ content: await read('agent-icons.js') });
  for (const name of ['burn-rate.js', 'ring-segments.js', 'launcher.js']) await page.addScriptTag({ content: await read(name) });

  const send = (quotas) => page.evaluate((quotas) => {
    const now = Date.now() / 1000;
    const win = ([remaining, minutes, reset]) => ({ remaining, used: 100 - remaining, windowMinutes: minutes, resetsAt: now + reset * 60 });
    const make = (spec) => spec && { ...win(spec), ...(spec.secondary ? { secondary: win(spec.secondary) } : {}) };
    const q = {};
    for (const [key, spec] of Object.entries(quotas)) q[key] = Array.isArray(spec) ? (spec.length > 3 ? { ...win(spec.slice(0, 3)), secondary: win(spec.slice(3)) } : win(spec)) : spec;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'quotas', quotas: q } }));
  }, quotas);
  // [remaining %, window minutes, minutes until reset]; four numbers more = its week: [%, minutes, reset]
  const claude = [72, 300, 130, 88, 10080, 4000];
  const codex = [41, 300, 95, 77, 10080, 6000];
  const shot = async (name) => { await page.locator('.rail').screenshot({ path: fileURLToPath(new URL(`${name}.png`, out)) }); };
  const gemini = page.locator('.model-card-gemini');
  const labels = () => gemini.locator('.split-col').evaluateAll((cols) => cols.map((col) => [col.dataset.pool, col.querySelector('.split-pct').textContent, col.querySelector('.split-eta').textContent]));
  const arcs = () => gemini.locator('.seg-fill').evaluateAll((paths) => paths.filter((path) => path.style.display !== 'none').map((path) => path.style.getPropertyValue('--pct')));

  // 1. Gemini 5h 80 / week 65 (the week limits), Argon 100.
  await send({ claude, codex, gemini: [80, 300, 110, 65, 10080, 3000], antigravityArgon: [100, 10080, 9000] });
  assert.equal(await gemini.evaluate((el) => el.classList.contains('is-split')), true, 'split is the default');
  assert.deepEqual(await arcs(), ['80', '65', '100'], 'Gemini draws its 5h outside and week inside, Argon one arc');
  assert.deepEqual(await labels(), [['gemini', '80', '1h50m'], ['argon', '100', '6d6h']]);
  assert.equal(await gemini.locator('.ring > svg > circle').evaluateAll((all) => all.every((c) => getComputedStyle(c).display === 'none')), true, 'the concentric circles step aside');
  const [left, right] = await gemini.locator('.seg-track').evaluateAll((paths) => [paths[0], paths[2]].map((p) => { const b = p.getBoundingClientRect(); return [b.left, b.right]; }));
  assert.ok(left[1] <= right[0] + 0.5 && right[0] - left[1] < 14, `the two arcs sit side by side with a small gap ${JSON.stringify([left, right])}`);
  const widths = await gemini.locator('.seg-fill').evaluateAll((paths) => paths.filter((p) => p.style.display !== 'none').map((p) => getComputedStyle(p).strokeWidth));
  assert.deepEqual(widths, ['3px', '3px', '8px'], 'the one-window Argon arc is thicker than the two thin Gemini rings');
  const box = await gemini.locator('.model-card-split').boundingBox();
  const rail = await page.locator('.rail').boundingBox();
  assert.ok(box.x >= rail.x && box.x + box.width <= rail.x + rail.width, 'the labels fit in the rail');
  assert.equal(await gemini.locator('.ring').getAttribute('aria-label'), (await gemini.getAttribute('title')));
  await shot('split-normal');

  // 2. Argon nearly spent, Gemini fine.
  await send({ claude, codex, gemini: [90, 300, 200, 85, 10080, 5000], antigravityArgon: [12, 10080, 1500] });
  assert.deepEqual(await arcs(), ['90', '85', '12']);
  assert.equal(await gemini.locator('.split-col.is-low').count(), 1);
  await shot('split-argon-low');

  // 3. No Argon on this plan: one full ring, one label.
  await send({ claude, codex, gemini: [80, 300, 110, 65, 10080, 3000] });
  assert.deepEqual(await arcs(), ['80', '65']);
  assert.equal((await labels()).length, 1);
  await shot('split-one-pool');

  // 4. Argon back; the 5h limits Gemini; a pool that is empty.
  await send({ claude, codex, gemini: [8, 300, 42, 65, 10080, 3000], antigravityArgon: [0, 10080, 300] });
  assert.deepEqual(await arcs(), ['8', '65', '0']);
  assert.deepEqual((await labels()).map((l) => l.slice(0, 3)), [['gemini', '8', '42m'], ['argon', '0', '5h']]);
  await shot('split-both-low');

  // 5. Hovering still opens the full pill; the older single-pool choices still work.
  await send({ claude, codex, gemini: [80, 300, 110, 65, 10080, 3000], antigravityArgon: [100, 10080, 9000] });
  await gemini.locator('.ring').hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.model-card-gemini .ring-row')).opacity === '1');
  await page.screenshot({ path: fileURLToPath(new URL('split-hover.png', out)) });
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'antigravityRing', value: 'argon' } })));
  assert.equal(await gemini.evaluate((el) => el.classList.contains('is-split')), false);
  assert.equal(await gemini.locator('.model-card-5h').textContent(), '100%');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'antigravityRing', value: 'split' } })));
  assert.equal(await gemini.evaluate((el) => el.classList.contains('is-split')), true);

  // 6. Three and four arcs: the geometry scales (the rail draws two today).
  await page.evaluate(() => {
    const { layout, arcPath, RADIUS } = window.ringSegments;
    const demo = (n, pcts) => `<svg viewBox="0 0 36 36" width="94" height="94" style="transform:rotate(-90deg)">${layout(n).map(([a, b], i) => `<path d="${arcPath(RADIUS, a, b)}" fill="none" stroke="#2a2a30" stroke-width="3" stroke-linecap="round"/><path d="${arcPath(RADIUS, a, b)}" pathLength="100" fill="none" stroke="#8aa4d6" stroke-width="3" stroke-linecap="round" stroke-dasharray="${pcts[i]} 100"/>`).join('')}</svg>`;
    document.body.insertAdjacentHTML('afterbegin', `<div id="demo" style="position:absolute;left:8px;top:8px;display:flex;gap:6px;background:#141416">${demo(1, [70])}${demo(2, [70, 40])}${demo(3, [90, 50, 20])}${demo(4, [100, 60, 30, 10])}</div>`);
  });
  await page.locator('#demo').screenshot({ path: fileURLToPath(new URL('segments-1-to-4.png', out)) });

  assert.deepEqual(errors, []);
  console.log('Split usage circle: arcs, labels, gap, missing pool and hover passed. Pictures in', fileURLToPath(out));
} finally {
  await browser.close();
}
