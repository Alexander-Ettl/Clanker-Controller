// Pixel evidence: a sidebar lens must bend the real transcript, beyond the same ordinary blur.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
import { scenarios } from './ui-tester/scenarios.mjs';
const outputPath = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: !process.argv.includes('--headed') });
try {
  for (const theme of ['light', 'dark']) {
    const { page, problems } = await openChat(browser, { width: 900, height: 1000, sidebar: true, scale: 2 });
    await page.evaluate(theme => {
      document.body.classList.toggle('vscode-light', theme === 'light'); document.body.classList.toggle('vscode-dark', theme === 'dark');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat: { id: 'refraction', messages: Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', agent: 'codex', text: `Layer ${i}: the text beneath this glass must visibly bend at its curved edge. `.repeat(3) })) } } }));
      document.querySelector('.transcript').style.backgroundImage = 'repeating-linear-gradient(90deg, #7093b8 0 3px, #e4dae9 3px 9px)';
    }, theme);
    await scenarios.find(s => s.id === 'usage-spent-hover').setup(page);
    await page.clock.resume(); await page.waitForTimeout(800);
    const lens = page.locator('.rail-glass');
    assert.match(await lens.evaluate(el => getComputedStyle(el).backdropFilter), /url\(/);
    const a = await lens.screenshot();
    await lens.evaluate(el => { el.style.backdropFilter = el.style.webkitBackdropFilter = 'blur(0.6px) saturate(115%) brightness(1.02)'; });
    const b = await lens.screenshot();
    const changed = await page.evaluate(async ([a, b]) => {
      const read = async bytes => {
        const img = new Image(); img.src = `data:image/png;base64,${bytes}`; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const x = await read(a), y = await read(b); let changed = 0;
      for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 24) changed++;
      return changed;
    }, [a.toString('base64'), b.toString('base64')]);
    assert.ok(changed > 200, `${theme}: lens must change backdrop pixels beyond ordinary blur (${changed})`);
    if (outputPath) {
      fs.mkdirSync(outputPath, { recursive: true });
      fs.writeFileSync(path.join(outputPath, `${theme}-refracted.png`), a);
      fs.writeFileSync(path.join(outputPath, `${theme}-blur-only.png`), b);
      await page.evaluate(() => { document.querySelector('.transcript').style.backgroundImage = ''; });
      await lens.evaluate(el => { el.style.removeProperty('backdrop-filter'); el.style.removeProperty('-webkit-backdrop-filter'); });
      await page.screenshot({ path: path.join(outputPath, `${theme}-context.png`) });
    }
    assert.deepEqual(problems, []);
    console.log(`${theme}: ${changed} backdrop pixels bent beyond the ordinary blur.`);
    await page.close();
  }
} finally { await browser.close(); }
