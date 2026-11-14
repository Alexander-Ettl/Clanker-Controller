// Checks the 24 bundled work-context icons against the asset contract (docs/plans/recent-chat-context-icons.md),
// writes the static contact sheet for review, and renders it at 48, 20 and 16px in both themes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { CATEGORIES } = require('../lib/work-context.js');
const iconDir = fileURLToPath(new URL('../media/context-icons/', import.meta.url));
const sheetFile = fileURLToPath(new URL('../../docs/plans/recent-chat-context-icons-sheet.html', import.meta.url));
const shotDir = fileURLToPath(new URL('../../out/screenshots/', import.meta.url));
fs.mkdirSync(shotDir, { recursive: true });

const svgs = {};
for (const { id } of CATEGORIES) {
  const file = path.join(iconDir, `${id}.svg`);
  assert.ok(fs.existsSync(file), `${id}.svg is missing`);
  const svg = fs.readFileSync(file, 'utf8').trim();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/, `${id}: 24x24 viewBox`);
  assert.match(svg, /stroke="currentColor"/, `${id}: currentColor stroke`);
  assert.match(svg, /stroke-width="1\.75"/, `${id}: 1.75px stroke`);
  assert.doesNotMatch(svg, /<(script|image|text|filter|foreignObject|style|use)\b|href=|url\(|on\w+=|#[0-9a-f]{3,6}\b/i, `${id}: no scripts, rasters, text, filters, references or fixed colours`);
  svgs[id] = svg;
}
assert.equal(fs.readdirSync(iconDir).filter(name => name.endsWith('.svg')).length, CATEGORIES.length, 'no stray SVGs beside the 24 categories');

const sizes = [48, 20, 16];
const theme = (name, bg, fg, mute) => `<section class="${name}" style="background:${bg};color:${fg};--mute:${mute}"><h2>${name}</h2><div class="grid">${CATEGORIES.map(({ id, label, symbol }) =>
  `<figure><div class="row">${sizes.map(size => `<span class="ico" style="width:${size}px;height:${size}px">${svgs[id]}</span>`).join('')}</div><figcaption><b>${label}</b><br>${id}<br><i>${symbol}</i></figcaption></figure>`).join('')}</div></section>`;
const html = `<!doctype html><meta charset="utf-8"><title>Recent chat context icons: contact sheet</title>
<style>body{margin:0;font:12px/1.35 system-ui,sans-serif}section{padding:20px 24px}h2{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;opacity:.6}
.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:18px 12px}figure{margin:0}.row{display:flex;align-items:center;gap:12px;height:52px}.ico svg{display:block;width:100%;height:100%}
figcaption{color:var(--mute);margin-top:4px}figcaption b{color:inherit}</style>
${theme('dark', '#14161b', '#e8eaf0', '#9aa1b0')}${theme('light', '#f6f7f9', '#1b1e25', '#5d6472')}`;
fs.writeFileSync(sheetFile, html);

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 640 }, deviceScaleFactor: 2 });
  await page.setContent(html);
  await page.screenshot({ path: process.env.SHOT || path.join(shotDir, 'context-icons-sheet.png'), fullPage: true });
} finally { await browser.close(); }
console.log(`context icons ok (${CATEGORIES.length})`);
