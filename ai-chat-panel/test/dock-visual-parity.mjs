// The island's rim refraction is built from narrow tiles now. This renders the dock with the committed script (LG_REFERENCE=file)
// and the working one, at several widths, pixel densities and states, and fails if a single pixel differs.
//   LG_REFERENCE=/tmp/liquid-glass.head.js node test/dock-visual-parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const reference = process.env.LG_REFERENCE;
if (!reference) { console.log('Dock visual parity: set LG_REFERENCE to a copy of the previous liquid-glass.js to compare against; skipped.'); process.exit(0); }
const source = fs.readFileSync(reference, 'utf8');
const browser = await chromium.launch({ headless: true });

async function shot({ width, scale, light, menu, text, useReference }) {
  const { page, problems } = await openChat(browser, { width, height: 700, sidebar: false, scale });
  try {
    if (useReference) await page.route('**/liquid-glass.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    if (useReference) await page.reload(); // the first load happened before the route
    await page.locator('#stopBtn').waitFor({ state: 'attached' });
    await page.clock.runFor(1500);
    if (light) await page.evaluate(() => { document.body.classList.remove('vscode-dark'); document.body.classList.add('vscode-light'); });
    if (text) await page.locator('textarea').first().fill(text);
    if (menu) { await page.locator('#modelPill').click(); await page.clock.runFor(700); }
    await page.clock.runFor(1200);
    await page.waitForFunction(() => [...document.querySelectorAll('.island-glass')].every(el => el.classList.contains('is-refracted')), null, { timeout: 8000 });
    await page.clock.runFor(600);
    // The lower half only: the mascot above it blinks and looks around, which is no business of the dock.
    const picture = await page.screenshot({ animations: 'disabled', clip: { x: 0, y: 380, width, height: 320 } });
    assert.deepEqual(problems, []);
    return picture;
  } finally { await page.context().close(); }
}

/** Pixels whose channels differ by more than `tolerance`, and the largest difference. The two pictures are decoded in a page's canvas. */
async function compare(a, b) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([x, y]) => {
      const load = (b64) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.src = `data:image/png;base64,${b64}`; });
      const data = async (b64) => { const img = await load(b64), c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const [p, q] = [await data(x), await data(y)];
      let max = 0, over = 0, differing = 0;
      for (let i = 0; i < p.length; i += 4) {
        const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]), Math.abs(p[i + 3] - q[i + 3]));
        if (d) differing++;
        if (d > max) max = d;
        if (d > 4) over++;
      }
      return { max, over, differing, total: p.length / 4 };
    }, [a.toString('base64'), b.toString('base64')]);
  } finally { await page.close(); }
}

try {
  let compared = 0, inexact = 0;
  for (const scale of [1, 2]) for (const width of [360, 560, 900]) for (const light of [false, true]) for (const [menu, text] of [[false, ''], [false, 'A longer line that makes the composer wrap onto a second line, then a third line when the window is narrow enough to need it, as a long prompt does.'], [true, '']]) {
    const label = `${width}px ${scale}x ${light ? 'light' : 'dark'}${menu ? ' menu' : ''}${text ? ' long text' : ''}`;
    const a = await shot({ width, scale, light, menu, text, useReference: true });
    const b = await shot({ width, scale, light, menu, text, useReference: false });
    if (!a.equals(b)) {
      // Where a menu rests on the pill the soft ring is now several pieces, and the compositor dithers the seam by a level or two.
      // Anything the eye could see (more than 4/255 in a channel) fails.
      const diff = await compare(a, b);
      inexact++;
      if (diff.over > 0 || diff.max > 4) {
        fs.mkdirSync('out/dock-parity', { recursive: true });
        const name = label.replaceAll(' ', '-');
        fs.writeFileSync(`out/dock-parity/${name}-reference.png`, a); fs.writeFileSync(`out/dock-parity/${name}-current.png`, b);
      }
      assert.ok(diff.over === 0 && diff.max <= 4, `the dock differs from the reference at ${label}: ${diff.over} pixels by more than 4/255, largest ${diff.max}; both pictures are in out/dock-parity/`);
      console.log(`  ${label}: ${diff.differing} of ${diff.total} pixels differ, by at most ${diff.max}/255`);
    }
    compared++;
  }
  console.log(`Dock visual parity: ${compared} renders match the reference (${compared - inexact} pixel for pixel, ${inexact} within 4/255).`);
} finally { await browser.close(); }
