// What happens when the chat window changes width: the divider between the sidebar chat and a pop-out chat being dragged and let go,
// the window being hidden and shown, the pixel density changing, a theme switch or a streaming reply landing in the middle of it.
// Real page, fake host, real timers. Every scenario ends in the same state: the dock refracted again, nothing left over from the
// sizes it passed through, no page error.
//   node test/resize-settle.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
import { historyFixture } from './chat-performance.mjs';

const send = (page, data) => page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
const browser = await chromium.launch({ headless: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open({ width = 900, height = 800, sidebar = false, scale = 1, turns = 24 } = {}) {
  const { page, problems } = await openChat(browser, { width, height, sidebar, scale, realTime: true });
  page.setDefaultTimeout(15000);
  await page.evaluate(() => {
    const work = window.__work = { encodes: 0, encodedPixels: 0 };
    for (const name of ['toBlob', 'toDataURL']) { const original = HTMLCanvasElement.prototype[name]; HTMLCanvasElement.prototype[name] = function (...a) { work.encodes++; work.encodedPixels += this.width * this.height; return original.apply(this, a); }; }
    window.__errors = [];
    window.addEventListener('error', (event) => window.__errors.push(event.message));
  });
  if (turns) await send(page, { type: 'chatLoaded', chat: { id: `resize-${turns}`, messages: historyFixture(turns) } });
  await settled(page);
  return { page, problems };
}

/** Every dock layer back to its refracted rest state. The dock only drops the class on its next redraw, a frame after the resize, and
 *  refracts 160 ms after the last change: so give it that long first, or the class left over from the old size answers for the new one. */
const settled = async (page, timeout = 15000) => {
  await page.waitForTimeout(260);
  await page.waitForFunction(() => {
    const layers = [...document.querySelectorAll('.island-glass')];
    return layers.length > 0 && layers.every((el) => el.classList.contains('is-refracted'));
  }, null, { timeout, polling: 100 });
};

/** What the dock is made of right now, and whether every piece points at something that exists. */
async function anatomy(page) {
  return page.evaluate(() => {
    const out = { rims: 0, graphs: 0, broken: [], islands: [] };
    out.graphs = document.querySelectorAll('svg defs filter').length;
    for (const glass of document.querySelectorAll('.island-glass')) {
      const rims = [...glass.querySelectorAll('.ig-rim')];
      out.rims += rims.length;
      for (const rim of rims) {
        const id = /url\(\\?"?#([^")\\]+)/.exec(rim.style.backdropFilter || rim.style.webkitBackdropFilter || '')?.[1];
        if (!id || !document.getElementById(id)) out.broken.push(`a rim strip points at a missing filter (${id})`);
        const box = rim.getBoundingClientRect();
        if (!(box.width > 0 && box.height > 0)) out.broken.push('a rim strip has no size');
        if (!rim.style.maskImage && !rim.style.webkitMaskImage) out.broken.push('a rim strip has no mask');
      }
      const frost = glass.querySelector('.ig-frost');
      const layers = (frost.style.maskPosition || frost.style.webkitMaskPosition || '').split(',').length; // one position per layer
      const composite = (frost.style.maskComposite || frost.style.webkitMaskComposite || '').split(',').length;
      out.islands.push({ rims: rims.length, maskLayers: layers, composite });
      if (layers < 1) out.broken.push('the frost has no mask');
      if (layers > 1 && composite !== layers) out.broken.push(`the frost has ${layers} mask layers but ${composite} composite operators`);
    }
    return out;
  });
}

async function check(page, problems, label, { slack = 8 } = {}) {
  await settled(page);
  const parts = await anatomy(page);
  assert.deepEqual(parts.broken, [], `${label}: ${parts.broken.join('; ')}`);
  baseline.set(page, baseline.get(page) ?? parts.graphs);
  assert.ok(parts.graphs <= baseline.get(page) + slack, `${label}: ${parts.graphs} filter graphs are left in the page (${baseline.get(page)} at rest)`);
  assert.deepEqual(await page.evaluate(() => window.__errors), [], `${label}: script errors`);
  assert.deepEqual(problems, [], `${label}: console or page errors`);
  return parts;
}

const baseline = new WeakMap(); // filter graphs a window has at rest: a resize may not leave more behind than a few
const results = [];
const scenario = async (name, body) => {
  const started = Date.now();
  try { await body(); results.push(`ok   ${name} (${Date.now() - started} ms)`); } catch (error) { results.push(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
  console.log(results.at(-1));
};

try {
  await scenario('releasing the divider: one refraction at the final width, none while it moves', async () => {
    const { page, problems } = await open({ scale: 2 });
    await check(page, problems, 'before');
    await page.evaluate(() => { window.__work.encodes = 0; window.__work.encodedPixels = 0; });
    for (let i = 1; i <= 40; i++) { await page.setViewportSize({ width: 900 + i * 7, height: 800 }); await sleep(12); } // a drag at roughly the frame rate
    const duringDrag = await page.evaluate(() => window.__work.encodes);
    assert.equal(duringDrag, 0, 'nothing is encoded while the window is still changing width');
    await page.waitForTimeout(120);
    await check(page, problems, 'released');
    const work = await page.evaluate(() => window.__work);
    assert.ok(work.encodes > 0, 'the release refracts the dock again');
    assert.ok(work.encodedPixels < 1_200_000, `a release encoded ${Math.round(work.encodedPixels / 1000)}k pixels (it was 2.6 million when the whole dock was drawn)`);
    assert.ok(await page.evaluate(() => document.querySelectorAll('.ig-rim').length) >= 2, 'the rim strips are back');
    await page.context().close();
  });

  await scenario('a new width does not rebuild the lens: a cache hit costs no tile work', async () => {
    const { page, problems } = await open({ scale: 2 });
    for (const width of [1000, 1100, 1200, 1300]) { await page.setViewportSize({ width, height: 800 }); await settled(page); }
    await check(page, problems, 'widths');
    await page.context().close();
  });

  await scenario('hammering the window size for a second leaves exactly one coherent dock', async () => {
    const { page, problems } = await open();
    for (let i = 0; i < 90; i++) { await page.setViewportSize({ width: 520 + ((i * 97) % 700), height: 700 + ((i * 31) % 200) }); await sleep(8); }
    const after = await check(page, problems, 'hammered');
    assert.ok(after.rims <= 16, `${after.rims} rim strips in two layers`);
    await page.context().close();
  });

  await scenario('the same width twice, and the same width after a detour, come back identical', async () => {
    const { page, problems } = await open({ width: 800 });
    const first = JSON.stringify((await check(page, problems, 'first')).islands);
    await page.setViewportSize({ width: 800, height: 800 }); // nothing changes: no refraction should start
    await page.waitForTimeout(400);
    assert.equal(JSON.stringify((await check(page, problems, 'same')).islands), first);
    await page.setViewportSize({ width: 560, height: 800 }); await settled(page);
    await page.setViewportSize({ width: 800, height: 800 }); await settled(page);
    assert.equal(JSON.stringify((await check(page, problems, 'detour')).islands), first, 'the detour changes nothing');
    await page.context().close();
  });

  await scenario('very narrow and very wide windows', async () => {
    const { page, problems } = await open();
    for (const width of [260, 180, 120, 2400, 3600, 320, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(350);
      assert.deepEqual(await page.evaluate(() => window.__errors), [], `${width}px`);
    }
    await check(page, problems, 'back to normal');
    await page.context().close();
  });

  await scenario('hidden while it is resized, shown again', async () => {
    const { page, problems } = await open();
    await page.evaluate(() => { document.body.style.display = 'none'; });
    for (const width of [500, 700, 640]) { await page.setViewportSize({ width, height: 800 }); await sleep(60); }
    await page.evaluate(() => { document.body.style.display = ''; });
    await check(page, problems, 'shown');
    // The composer must be laid out for the new width: the bar fits and the textarea is not squeezed to nothing.
    const box = await page.locator('.composer').first().boundingBox();
    assert.ok(box && box.width > 300 && box.width <= 640, `composer is ${box?.width}px wide in a 640px window`);
    await page.context().close();
  });

  await scenario('the pixel density changes together with the width', async () => {
    const { page, problems } = await open({ scale: 1 });
    const cdp = await page.context().newCDPSession(page);
    for (const [width, deviceScaleFactor] of [[700, 2], [900, 1], [640, 2], [1000, 1.5]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor, mobile: false });
      await page.waitForTimeout(250);
      await check(page, problems, `${width}px at ${deviceScaleFactor}x`);
    }
    await page.context().close();
  });

  await scenario('a theme switch in the middle of a drag', async () => {
    const { page, problems } = await open();
    for (let i = 1; i <= 20; i++) {
      await page.setViewportSize({ width: 900 - i * 12, height: 800 });
      if (i === 8) await page.evaluate(() => { document.body.classList.remove('vscode-dark'); document.body.classList.add('vscode-light'); });
      await sleep(12);
    }
    await check(page, problems, 'light after the drag');
    assert.equal(await page.locator('#ig-light-filter').count(), 1, 'one lighting graph, not one per theme');
    await page.context().close();
  });

  await scenario('the model menu open while the window changes width', async () => {
    const { page, problems } = await open();
    await page.locator('#modelPill').click();
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 640, height: 800 });
    await page.waitForTimeout(500);
    await check(page, problems, 'after the resize');
    await page.keyboard.press('Escape');
    await check(page, problems, 'after closing');
    await page.context().close();
  });

  await scenario('a reply streams in while the window is dragged: the end stays in view and nothing is lost', async () => {
    const { page, problems } = await open({ turns: 12 });
    await send(page, { type: 'userMessage', text: 'Stream while I resize' });
    await send(page, { type: 'delta', model: 'codex', text: 'Start. ' });
    for (let i = 1; i <= 30; i++) {
      await page.setViewportSize({ width: 900 - i * 9, height: 800 });
      await send(page, { type: 'delta', model: 'codex', text: `Line ${i} of the reply, long enough to wrap in a narrow window and change the height of the turn. ` });
      await sleep(10);
    }
    await send(page, { type: 'turn_complete', agent: 'codex' });
    await check(page, problems, 'streamed');
    const view = await page.locator('#transcript').evaluate((el) => ({ gap: el.scrollHeight - el.scrollTop - el.clientHeight, text: el.textContent }));
    assert.ok(view.gap < 6, `the end of the reply is ${view.gap}px below the view`);
    assert.ok(view.text.includes('Line 30 of the reply'), 'every delta arrived');
    await page.context().close();
  });

  await scenario('reading position: scrolled up in a long chat, the same turn stays in view through a width change', async () => {
    const { page, problems } = await open({ turns: 60 });
    await page.locator('#transcript').evaluate((el) => { el.scrollTop = 6000; });
    await page.waitForTimeout(200);
    const anchor = await page.evaluate(() => {
      const view = document.querySelector('#transcript').getBoundingClientRect();
      const group = [...document.querySelectorAll('.msg-group-user')].find((g) => g.getBoundingClientRect().top >= view.top);
      return { index: group.dataset.userIndex, top: group.getBoundingClientRect().top - view.top };
    });
    for (const width of [760, 640, 1000, 820]) { await page.setViewportSize({ width, height: 800 }); await page.waitForTimeout(250); }
    const after = await page.evaluate((index) => {
      const view = document.querySelector('#transcript').getBoundingClientRect();
      const group = document.querySelector(`.msg-group-user[data-user-index="${index}"]`);
      const box = group?.getBoundingClientRect();
      return box ? { top: box.top - view.top, height: box.height, viewHeight: view.height } : null;
    }, anchor.index);
    assert.ok(after, 'the turn the reader was looking at is still there');
    assert.ok(after.top > -after.height * 3 && after.top < after.viewHeight + after.height * 3, `the turn drifted ${Math.round(after.top - anchor.top)}px away from where it was`);
    await check(page, problems, 'scrolled chat');
    await page.context().close();
  });

  await scenario('the sidebar layout, narrow and wide', async () => {
    const { page, problems } = await open({ sidebar: true, width: 420 });
    for (const width of [320, 520, 380, 700]) { await page.setViewportSize({ width, height: 800 }); await page.waitForTimeout(300); }
    await check(page, problems, 'sidebar');
    await page.context().close();
  });

  await scenario('an empty chat and a very long chat both settle', async () => {
    for (const turns of [0, 150]) {
      const { page, problems } = await open({ turns });
      for (const width of [640, 1000, 760]) { await page.setViewportSize({ width, height: 800 }); await page.waitForTimeout(250); }
      await check(page, problems, `${turns} turns`);
      await page.context().close();
    }
  });

  await scenario('two windows resized at once, the way a divider between them does', async () => {
    const a = await open({ width: 700 }), b = await open({ width: 400, sidebar: true });
    for (let i = 1; i <= 30; i++) {
      await Promise.all([a.page.setViewportSize({ width: 700 + i * 8, height: 800 }), b.page.setViewportSize({ width: 400 - i * 4, height: 800 })]);
      await sleep(12);
    }
    await check(a.page, a.problems, 'first window');
    await check(b.page, b.problems, 'second window');
    await a.page.context().close(); await b.page.context().close();
  });
} finally {
  await browser.close();
}
if (process.exitCode) { console.error(`\n${results.filter((line) => line.startsWith('FAIL')).length} resize scenarios failed.`); } else console.log(`\nResize: ${results.length} scenarios passed.`);
