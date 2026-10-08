#!/usr/bin/env node
// Interface tester, deterministic layer. Visits every scenario at several widths, with and without long text, and measures:
// layout geometry (overlap, clipping, covered controls, overflow), the accessibility tree, console errors, failed requests,
// and a pixel diff against the last accepted picture. It uses no model tokens. Run:
//   node ai-chat-panel/test/ui-tester/run.mjs [--only=<scenario id>] [--update | --accept] [--out=<dir>] [--baseline=<dir>]
// First run records baselines. Later runs report what changed. --update replaces the baseline without comparing; --accept compares first, then adopts the current pictures.
// Output: <out>/report.json, report.md and crops/ (only regions that need a look). Exit code 1 when a NEW error was found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openChat } from './boot.mjs';

const { probe } = createRequire(import.meta.url)('./probe.js');
const here = path.dirname(fileURLToPath(import.meta.url));
export const WIDTHS = [900, 420, 320];
const DEFAULT_WIDTHS = WIDTHS;
const sha = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
const SEVERE = new Set(['error', 'warn']);

// Longer text in every language is the most common cause of a layout breaking, so each state is also probed with every
// text node about 45% longer (German-sized), which finds overflow without anyone writing an edge case.
function stretchText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.textContent.trim();
    if (text.length < 4 || /^(script|style)$/i.test(node.parentElement?.tagName || '')) continue;
    node.textContent = node.textContent.replace(text, `${text} ${text.slice(0, Math.ceil(text.length * 0.45))}`);
  }
}

async function diffPng(scratch, before, after) {
  return scratch.evaluate(async ([a, b]) => {
    const read = async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const [x, y] = [await read(a), await read(b)];
    // A page height that rounds differently by a pixel or two is not a change; compare what both pictures share.
    if (Math.abs(x.width - y.width) > 2 || Math.abs(x.height - y.height) > 2) return { changed: true, ratio: 1, bbox: { x: 0, y: 0, w: y.width, h: y.height }, sized: true };
    const w = Math.min(x.width, y.width), h = Math.min(x.height, y.height);
    let count = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const i = (py * x.width + px) * 4, j = (py * y.width + px) * 4;
      if (Math.max(Math.abs(x.data[i] - y.data[j]), Math.abs(x.data[i + 1] - y.data[j + 1]), Math.abs(x.data[i + 2] - y.data[j + 2])) > 24) {
        count++; if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    }
    const ratio = count / (w * h);
    return { changed: ratio > 0.0005, ratio: Number(ratio.toFixed(5)), bbox: count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null };
  }, [before.toString('base64'), after.toString('base64')]);
}

const unionOf = rects => {
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
};
// A crop is what Gemini looks at, so keep it small enough to read and to cost little.
const cropRegion = (rect, bounds) => {
  const pad = 32, w = Math.min(rect.w + pad * 2, 900, bounds.w), h = Math.min(rect.h + pad * 2, 700, bounds.h);
  const x = Math.max(bounds.x, Math.min(rect.x - pad, bounds.x + bounds.w - w)), y = Math.max(bounds.y, Math.min(rect.y - pad, bounds.y + bounds.h - h));
  return { x, y, width: w, height: h };
};
const lineDiff = (before, after) => {
  const a = new Set(before.split('\n')), b = new Set(after.split('\n'));
  return [...after.split('\n').filter(line => !a.has(line)).map(line => `+ ${line.trim()}`), ...before.split('\n').filter(line => !b.has(line)).map(line => `- ${line.trim()}`)].slice(0, 12);
};

/** A real page by address (a dev server the loop started, or any site). Collects script errors, console errors and failed or 4xx/5xx requests. */
export async function openUrl(browser, url, { width, height }) {
  const page = await browser.newPage({ viewport: { width, height } });
  const problems = [], origin = new URL(url).origin;
  page.on('pageerror', error => problems.push({ kind: 'page-error', detail: error.message.slice(0, 300) }));
  page.on('console', message => { if (message.type() === 'error') problems.push({ kind: 'console-error', detail: message.text().slice(0, 300) }); });
  page.on('requestfailed', request => { if (request.url().startsWith(origin)) problems.push({ kind: 'request-failed', detail: `${request.failure()?.errorText || 'failed'} ${new URL(request.url()).pathname}` }); });
  page.on('response', response => { if (response.url().startsWith(origin) && response.status() >= 400) problems.push({ kind: 'request-failed', detail: `${response.status()} ${new URL(response.url()).pathname}` }); });
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); // a dev server's live-reload socket never goes idle
  return { page, problems };
}

export async function runTester({ scenarios, outDir, baselineDir, only = null, update = false, accept = false, widths = WIDTHS, channel = 'msedge', log = () => {} }) {
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true }); fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true }); fs.mkdirSync(baselineDir, { recursive: true });
  // --accept stages the next baseline in the output folder; the caller adopts it once it has finished with the report.
  const writeDir = accept ? path.join(outDir, "next-baseline") : baselineDir; fs.mkdirSync(writeDir, { recursive: true });
  const knownFile = path.join(baselineDir, 'known.json');
  const known = new Set(fs.existsSync(knownFile) ? JSON.parse(fs.readFileSync(knownFile, 'utf8')) : []);
  const browser = await chromium.launch({ headless: true, channel }).catch(() => chromium.launch({ headless: true }));
  const states = [], seen = new Set();
  try {
    const scratch = await browser.newPage();
    for (const scenario of scenarios.filter(item => !only || item.id === only)) {
      for (const width of widths) {
        const height = scenario.height || 900;
        let page, problems = [];
        if (scenario.html) { page = await browser.newPage({ viewport: { width, height } }); await page.setContent(scenario.html); }
        else if (scenario.url) ({ page, problems } = await openUrl(browser, scenario.url, { width, height }));
        else ({ page, problems } = await openChat(browser, { width, height, sidebar: scenario.sidebar }));
        try {
          await scenario.setup?.(page);
          await page.waitForTimeout(150); // let transitions finish so pictures are stable
          // Fonts and script-driven sizes settle late; wait until the page height holds still for two frames.
          await page.evaluate(async () => {
            await document.fonts.ready;
            let last = -1, still = 0;
            for (let i = 0; i < 60 && still < 3; i++) { await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30))); const h = document.documentElement.scrollHeight + document.body.getBoundingClientRect().height; still = h === last ? still + 1 : 0; last = h; }
          });
          const focus = scenario.focus ? page.locator(scenario.focus).first() : null;
          const box = focus ? await focus.boundingBox() : { x: 0, y: 0, width, height };
          const bounds = { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)), w: Math.ceil(box.width), h: Math.ceil(box.height) };
          const id = `${scenario.id}@${width}`;
          const scope = scenario.scope || scenario.focus;
          const fingerprintOf = item => sha(`${id}|${item.kind}|${item.selector}|${item.other || ''}|${item.stress || ''}`);
          const mark = item => ({ ...item, fingerprint: fingerprintOf(item), isNew: !known.has(fingerprintOf(item)) });
          const base = (await page.evaluate(probe, { max: 40, scope })).map(mark);
          const basePrint = new Set(base.map(item => `${item.kind}|${item.selector}`));
          const picture = await page.screenshot({ animations: 'disabled', clip: { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } });
          const aria = await page.locator('body').ariaSnapshot().catch(() => '');
          const state = { id, scenario: scenario.id, width, findings: [], aria: 'new', pixel: { status: 'new' }, shot: null, crop: null };
          // Baselines: the picture and the accessibility tree from the last accepted run.
          const pngFile = path.join(baselineDir, `${id}.png`), ariaFile = path.join(baselineDir, `${id}.aria.txt`);
          if (fs.existsSync(pngFile) && !update) {
            const result = await diffPng(scratch, fs.readFileSync(pngFile), picture);
            state.pixel = { status: result.changed ? 'changed' : 'same', ratio: result.ratio, bbox: result.bbox };
          }
          if (fs.existsSync(ariaFile) && !update) {
            const before = fs.readFileSync(ariaFile, 'utf8');
            state.aria = before === aria ? 'same' : 'changed'; if (before !== aria) state.ariaDiff = lineDiff(before, aria);
          }
          if (update || accept || !fs.existsSync(pngFile)) { fs.writeFileSync(path.join(writeDir, `${id}.png`), picture); fs.writeFileSync(path.join(writeDir, `${id}.aria.txt`), aria); }
          // The crop is the region that needs a look: the worst new measured problems, else the part of the picture that changed.
          // It is taken from the page as it is now, before the text is stretched, so it shows what a user sees.
          const crop = async (rect, suffix = '') => {
            const file = path.join(outDir, 'crops', `${id.replace(/[^\w.-]/g, '_')}${suffix}.png`);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: file, animations: 'disabled', fullPage: true, clip: cropRegion(rect, { x: 0, y: 0, w: width, h: Math.max(height, bounds.y + bounds.h) }) });
            return path.basename(file);
          };
          const worst = base.filter(item => SEVERE.has(item.severity) && item.rect && item.isNew).slice(0, 3);
          const changed = state.pixel.status === 'changed' && state.pixel.bbox ? { x: bounds.x + state.pixel.bbox.x, y: bounds.y + state.pixel.bbox.y, w: state.pixel.bbox.w, h: state.pixel.bbox.h } : null;
          if (worst.length || changed) state.crop = await crop(worst.length ? unionOf(worst.map(item => item.rect)) : changed);
          // Longer text in every language is the usual way a layout breaks; probe again with every text node 45% longer.
          await page.evaluate(stretchText); await page.waitForTimeout(100);
          const stretched = (await page.evaluate(probe, { max: 40, scope })).filter(item => !basePrint.has(`${item.kind}|${item.selector}`)).map(item => mark({ ...item, stress: 'long-text' }));
          const worstStretched = stretched.filter(item => SEVERE.has(item.severity) && item.rect && item.isNew).slice(0, 3);
          if (!state.crop && worstStretched.length) { state.crop = await crop(unionOf(worstStretched.map(item => item.rect)), '-long-text'); state.cropStretched = true; }
          state.findings = [...base, ...stretched, ...problems.map(item => mark({ ...item, severity: item.kind === 'request-failed' ? 'warn' : 'error', selector: '(page)', text: '' }))]
            .filter(item => !seen.has(item.fingerprint) && seen.add(item.fingerprint));
          const findings = state.findings;
          if (state.crop || findings.some(item => SEVERE.has(item.severity))) { const file = path.join(outDir, 'shots', `${id.replace(/[^\w.-]/g, '_')}.png`); fs.writeFileSync(file, picture); state.shot = path.basename(file); }
          states.push(state); log(`${id}: ${findings.filter(item => SEVERE.has(item.severity)).length} to review, picture ${state.pixel.status}, tree ${state.aria}`);
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }

  const all = states.flatMap(state => state.findings.map(item => ({ ...item, state: state.id })));
  const summary = { states: states.length, errors: all.filter(i => i.severity === 'error').length, warnings: all.filter(i => i.severity === 'warn').length,
    newFindings: all.filter(i => i.isNew && SEVERE.has(i.severity)).length, pictureChanges: states.filter(s => s.pixel.status === 'changed').length,
    treeChanges: states.filter(s => s.aria === 'changed').length, recorded: states.filter(s => s.pixel.status === 'new').length };
  // A state needs the model when something new was measured or its picture or accessibility tree changed since the baseline.
  const needsVision = states.filter(s => s.findings.some(i => i.isNew && SEVERE.has(i.severity)) || s.pixel.status === 'changed' || s.aria === 'changed').map(s => s.id);
  if (!only) fs.writeFileSync(path.join(writeDir, 'known.json'),JSON.stringify(all.map(item => item.fingerprint), null, 1));
  const report = { generatedAt: new Date().toISOString(), widths, summary, needsVision, states };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), markdown(report, scenarios));
  return report;
}

function markdown(report, scenarios) {
  const { summary } = report;
  const WIDTHS = report.widths || DEFAULT_WIDTHS;
  const rows = scenarios.map(scenario => {
    const cells = WIDTHS.map(width => {
      const state = report.states.find(item => item.id === `${scenario.id}@${width}`);
      if (!state) return '-';
      const severe = state.findings.filter(item => SEVERE.has(item.severity)).length;
      return `${severe ? `${severe} to review` : 'clean'}${state.pixel.status === 'changed' ? ', picture changed' : ''}${state.aria === 'changed' ? ', tree changed' : ''}`;
    });
    return `| ${scenario.id} | ${cells.join(' | ')} |`;
  });
  const details = report.states.flatMap(state => state.findings.filter(item => SEVERE.has(item.severity)).map(item =>
    `- **${state.id}** ${item.severity} ${item.kind}${item.stress ? ' (long text)' : ''}${item.isNew ? '' : ' (known)'}: \`${item.selector}\`${item.text ? ` "${item.text}"` : ''}${item.detail ? `: ${item.detail}` : ''}`));
  return [`# Interface test report`, '', `${summary.states} states: ${summary.errors} errors, ${summary.warnings} warnings (${summary.newFindings} new), ${summary.pictureChanges} pictures and ${summary.treeChanges} accessibility trees changed, ${summary.recorded} recorded as baseline.`, '',
    `| Scenario | ${WIDTHS.map(w => `${w}px`).join(' | ')} |`, `|---|${WIDTHS.map(() => '---').join('|')}|`, ...rows, '', '## Findings', '', ...(details.length ? details : ['None.']), ''].join('\n');
}

const direct = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const { scenarios } = await import('./scenarios.mjs');
  const outDir = flag('out', fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-ui-tester-')));
  const baselineDir = flag('baseline', path.resolve(here, '..', '..', '..', '.ui-tester', 'baselines'));
  const report = await runTester({ scenarios, outDir, baselineDir, only: flag('only', null), update: args.includes('--update'), accept: args.includes('--accept'), log: line => console.log(line) });
  console.log(`\n${JSON.stringify(report.summary)}\nreport: ${path.join(outDir, 'report.md')}`);
  process.exitCode = report.summary.newFindings && report.states.some(s => s.findings.some(i => i.isNew && i.severity === 'error')) ? 1 : 0;
}
