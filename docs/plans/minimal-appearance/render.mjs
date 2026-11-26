// Renders the minimal-appearance mockups to PNGs and contact sheets, and measures what a script can measure:
// sideways overflow and text contrast against the composited background, in every theme.
// Usage: node docs/plans/minimal-appearance/render.mjs [--out=<dir>] [--variants=quiet,halo,ledger] [--sheets-only]
// Pictures go outside the repo (default ~/dev/scratch/minimal-ui/render). No network, no model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const out = path.resolve(flag('out', path.join(os.homedir(), 'dev', 'scratch', 'minimal-ui', 'render')));
const VARIANTS = flag('variants', 'quiet,halo,ledger').split(',').filter(v => fs.existsSync(path.join(here, `${v}.html`)));
const THEMES = ['clanker-ink', 'dark-modern', 'navy', 'light-modern', 'solarized-light', 'hc-dark', 'hc-light'];
const STATES = ['empty', 'chat', 'steps', 'running', 'model', 'more', 'settings'];
const HEIGHT = 860;
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });

// Runs in the page. Composites each text element's background chain (colour, alpha, opacity) and reports contrast.
function probe() {
  const parse = value => {
    let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(value);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    return null;
  };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const lum = c => c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  const page = parse(getComputedStyle(document.body).backgroundColor);
  const background = el => {
    const chain = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) chain.push(parse(getComputedStyle(n).backgroundColor) || [0, 0, 0, 0]);
    return chain.reverse().reduce((under, top) => over(top, under), page);
  };
  const opacity = el => { let o = 1; for (let n = el; n; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; };
  const low = [];
  let min = Infinity;
  for (const el of document.querySelectorAll('body *')) {
    if (!el.childNodes.length || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || style.visibility === 'hidden') continue;
    if (el.closest('.shimmer, [aria-hidden="true"]') || style.backgroundClip === 'text' || style.webkitBackgroundClip === 'text') continue;
    const fg = parse(style.color);
    if (!fg) continue;
    const bg = background(el);
    const text = over([fg[0], fg[1], fg[2], fg[3] * opacity(el)], bg);
    const r = ratio(text, bg);
    const large = parseFloat(style.fontSize) >= 18.66 || (parseFloat(style.fontSize) >= 14 && +style.fontWeight >= 700);
    min = Math.min(min, r);
    if (r < (large ? 3 : 4.5)) low.push({ text: el.textContent.trim().slice(0, 40), ratio: +r.toFixed(2), cls: el.className || el.tagName });
  }
  const sideways = document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('body *')].some(el => {
    const r = el.getBoundingClientRect();
    return r.width && getComputedStyle(el).display !== 'none' && (r.right > innerWidth + 1 || r.left < -1) && !el.closest('.art');
  });
  return { min: +min.toFixed(2), low, sideways };
}

const browser = await chromium.launch();
const results = [];
const shoot = async (variant, theme, state, width) => {
  const page = await browser.newPage({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  const url = pathToFileURL(path.join(here, `${variant}.html`)).href + `?theme=${theme}&state=${state}`;
  await page.goto(url);
  await page.addStyleTag({ content: '*, *::before, *::after { animation-play-state: paused !important; animation-delay: -0.6s !important; transition: none !important; }' });
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(out, 'shots', `${variant}-${state}-${theme}-${width}.png`);
  await page.screenshot({ path: file });
  const measured = await page.evaluate(probe);
  results.push({ variant, theme, state, width, file, errors, ...measured });
  await page.close();
};

if (!process.argv.includes('--sheets-only')) {
  for (const variant of VARIANTS) {
    for (const state of STATES) await shoot(variant, 'clanker-ink', state, 420);
    for (const theme of THEMES.slice(1)) for (const state of ['chat', 'steps', 'model', 'settings']) await shoot(variant, theme, state, 420);
    for (const state of ['chat', 'empty']) for (const width of [320, 900]) await shoot(variant, 'clanker-ink', state, width);
    for (const width of [320, 900]) await shoot(variant, 'light-modern', 'steps', width);
  }
  fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(results, null, 1));
}

// Contact sheets: one HTML page of labelled pictures each, screenshotted.
const sheet = async (name, title, rows) => {
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#2a2a2e;color:#eee;font:13px system-ui}h1{font-size:18px;margin:0 0 16px}
  .row{display:flex;gap:18px;margin-bottom:22px;align-items:flex-start}.row>div{flex:none}.lab{margin:0 0 6px;color:#bbb;font-size:12px}img{display:block;border-radius:6px;box-shadow:0 0 0 1px #0006}</style>
  <h1>${title}</h1>${rows.map(r => `<div class="row">${r.map(c => `<div><p class="lab">${c.label}</p><img src="${pathToFileURL(c.file).href}" width="${c.w ?? 420}"></div>`).join('')}</div>`).join('')}`;
  const file = path.join(out, `${name}.html`);
  fs.writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(pathToFileURL(file).href);
  await page.waitForLoadState('load');
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  await page.close();
};
const shot = (v, s, t, w = 420) => path.join(out, 'shots', `${v}-${s}-${t}-${w}.png`);
const NAMES = { quiet: 'A · Quiet', halo: 'B · Halo', ledger: 'C · Ledger' };
for (const v of VARIANTS) {
  await sheet(`${v}-states`, `${NAMES[v]}: every state (Clanker Ink, 420 px)`, [STATES.slice(0, 4).map(s => ({ label: s, file: shot(v, s, 'clanker-ink') })), STATES.slice(4).map(s => ({ label: s, file: shot(v, s, 'clanker-ink') }))]);
  await sheet(`${v}-themes`, `${NAMES[v]}: themes (chat, steps open, model menu, settings)`, ['chat', 'steps', 'model', 'settings'].map(s => THEMES.map(t => ({ label: `${t} · ${s}`, file: shot(v, s, t), w: 300 }))));
  await sheet(`${v}-widths`, `${NAMES[v]}: 320 px and 900 px`, [[{ label: 'chat 320', file: shot(v, 'chat', 'clanker-ink', 320), w: 320 }, { label: 'chat 900', file: shot(v, 'chat', 'clanker-ink', 900), w: 900 }], [{ label: 'steps 320 light', file: shot(v, 'steps', 'light-modern', 320), w: 320 }, { label: 'steps 900 light', file: shot(v, 'steps', 'light-modern', 900), w: 900 }]]);
}
await sheet('overview', 'Minimal appearance: three directions (Clanker Ink, 420 px)', VARIANTS.map(v => ['empty', 'chat', 'steps', 'running'].map(s => ({ label: `${NAMES[v]} · ${s}`, file: shot(v, s, 'clanker-ink'), w: 340 }))));
await sheet('overview-light', 'Minimal appearance: three directions (Light Modern, 420 px)', VARIANTS.map(v => ['chat', 'steps', 'model', 'settings'].map(s => ({ label: `${NAMES[v]} · ${s}`, file: shot(v, s, 'light-modern'), w: 340 }))));
await browser.close();

if (results.length) {
  const bad = results.filter(r => r.errors.length || r.low.length || r.sideways);
  console.log(`${results.length} pictures in ${out}`);
  for (const r of bad) console.log(`${r.variant} ${r.state} ${r.theme} ${r.width}: ${r.sideways ? 'SIDEWAYS ' : ''}${r.errors.join('; ')} ${r.low.map(l => `${l.ratio} "${l.text}" (${l.cls})`).join(' | ')}`);
  console.log(`lowest contrast per variant: ${VARIANTS.map(v => `${v} ${Math.min(...results.filter(r => r.variant === v).map(r => r.min))}`).join(', ')}`);
}
