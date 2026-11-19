#!/usr/bin/env node
// Renders the PNGs the Marketplace needs: it rejects SVG icons and SVG images in a README.
//   node scripts/render-store-assets.mjs
// Writes ai-chat-panel/media/icon.png (256x256), docs/images/hero.png and docs/images/cost.png,
// and the matching site/public/favicon.svg when the site folder exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/** A superellipse |x|^n + |y|^n = 1 as an SVG path. A plain rounded rectangle (border-radius) joins its straight edge to a
 *  circular arc, so the curvature jumps from 0 to 1/r at the seam and the eye sees a flat spot. A superellipse eases in, so
 *  the curvature is continuous all the way round: the "squircle" corner of iOS icons. n = 5 is the usual app-icon value. */
export function squirclePath(size, n = 5, steps = 720) {
  const half = size / 2, pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    const x = half + half * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = half + half * Math.sign(s) * Math.abs(s) ** (2 / n);
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

// White mark on a black tile. The logo uses currentColor, so the group sets the colour.
const logoSvg = read('assets', 'Clanker_Controller_logo.svg');
const logoInner = logoSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const LOGO_W = 374.78, LOGO_H = 296.77;

export function iconSvg(size = 512) {
  const markW = size * 0.66, k = markW / LOGO_W;
  const tx = (size - markW) / 2, ty = (size - LOGO_H * k) / 2;
  const tile = squirclePath(size);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
<path d="${tile}" fill="#000"/>
<path d="${squirclePath(size - 2)}" transform="translate(1 1)" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="1.5"/>
<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})" fill="#fff" color="#fff">${logoInner}</g>
</svg>`;
}

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {});
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${iconSvg(256)}</body>`);
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
const favicon = path.join(root, 'site', 'public', 'favicon.svg');
if (fs.existsSync(path.dirname(favicon))) fs.writeFileSync(favicon, iconSvg(512));
console.log('Rendered icon.png, hero.png and cost.png');
