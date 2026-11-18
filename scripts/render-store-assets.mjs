#!/usr/bin/env node
// Renders the PNGs the Marketplace needs: it rejects SVG icons and SVG images in a README.
//   node scripts/render-store-assets.mjs
// Writes ai-chat-panel/media/icon.png (256x256), docs/images/hero.png and docs/images/cost.png.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// The logo uses currentColor, so the tile sets the colour. Dark glass tile, Claude-orange mark.
const logo = read('assets', 'Clanker_Controller_logo.svg').replace(/width="100%"\s+height="100%"/, 'width="100%" height="100%"');
const iconHtml = `<!doctype html><body style="margin:0;background:transparent">
<div style="width:256px;height:256px;border-radius:56px;box-sizing:border-box;display:grid;place-items:center;
  background:radial-gradient(120% 120% at 20% 10%,#2a2d38 0%,#14161d 55%,#0b0c10 100%);
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.10);color:#f0a283">
  <div style="width:176px;height:140px">${logo}</div>
</div></body>`;

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {});
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await page.setContent(iconHtml);
  await page.screenshot({ path: path.join(root, 'ai-chat-panel', 'media', 'icon.png'), omitBackground: true });

  for (const [name, w, h] of [['hero', 1280, 400], ['cost', 1280, 520]]) {
    const wide = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await wide.setContent(`<!doctype html><body style="margin:0;background:transparent">${read('docs', 'images', `${name}.svg`)}</body>`);
    await wide.screenshot({ path: path.join(root, 'docs', 'images', `${name}.png`), omitBackground: true });
    await wide.close();
  }
} finally {
  await browser.close();
}
console.log('Rendered icon.png, hero.png and cost.png');
