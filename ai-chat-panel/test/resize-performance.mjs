// How long the chat window stays busy after its width changes: dragging the divider between the sidebar chat and a pop-out chat,
// and above all the moment you let go, when the last size lands. Real page, fake host, real timers (no fake clock), headless Chromium.
//   node test/resize-performance.mjs [--turns=30] [--scale=2] [--sidebar] [--from=700] [--to=1000] [--rounds=4] [--pair] [--json=file] [--profile=dir]
// --pair opens a second chat window beside the first and resizes both at once (sidebar + pop-out, as in the editor).
// The numbers are for comparing two builds on the same machine. A loaded machine inflates them; run twice.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
import { historyFixture } from './chat-performance.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] ?? fallback;
const round1 = (n) => Math.round(n * 10) / 10;
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);

async function openLoaded(browser, { turns, sidebar, scale, width, height }) {
  const { page, problems } = await openChat(browser, { width, height, sidebar, scale, realTime: true });
  page.setDefaultTimeout(20000);
  // Work that does not depend on how busy the machine is: how many images were encoded, how many pixels went into canvases and ImageData.
  await page.evaluate(() => {
    const work = window.__work = { encodes: 0, encodedPixels: 0, imageDataPixels: 0, canvases: 0 };
    for (const name of ['toBlob', 'toDataURL']) { const original = HTMLCanvasElement.prototype[name]; HTMLCanvasElement.prototype[name] = function (...a) { work.encodes++; work.encodedPixels += this.width * this.height; return original.apply(this, a); }; }
    const create = Document.prototype.createElement; Document.prototype.createElement = function (tag, ...rest) { if (String(tag).toLowerCase() === 'canvas') work.canvases++; return create.call(this, tag, ...rest); };
    const Native = window.ImageData; window.ImageData = class extends Native { constructor(...a) { super(...a); work.imageDataPixels += this.width * this.height; } };
  });
  if (turns) await page.evaluate((chat) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatLoaded', chat } })), { id: `resize-${turns}`, messages: historyFixture(turns) });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const longTasks = window.__rp = [];
    new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => [e.startTime, e.duration]))).observe({ type: 'longtask' });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  return { page, cdp, problems };
}

// ThreadTime is CPU time the main thread really ran; TaskDuration is wall time and grows when the machine is swapping or busy.
const taskTime = async (cdp) => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;

/** One resize on every open window; `mode` is a single jump (the release) or a drag of 30 small steps ending on the same width. */
export async function resizeOnce(windows, width, height, mode, windowMs = 2500) {
  const before = await Promise.all(windows.map(w => taskTime(w.cdp)));
  const workBefore = await Promise.all(windows.map(w => w.page.evaluate(() => ({ ...window.__work }))));
  const marks = await Promise.all(windows.map(w => w.page.evaluate(() => { window.__rp.length = 0; return performance.now(); })));
  if (mode === 'drag') {
    const start = windows[0].width;
    for (let i = 1; i <= 30; i++) {
      const w = Math.round(start + ((width - start) * i) / 30);
      await Promise.all(windows.map(win => win.page.setViewportSize({ width: w, height })));
      await windows[0].page.waitForTimeout(16);
    }
  } else await Promise.all(windows.map(w => w.page.setViewportSize({ width, height })));
  const releaseMarks = await Promise.all(windows.map(w => w.page.evaluate(() => performance.now())));
  await windows[0].page.waitForTimeout(windowMs);
  const out = [];
  for (const [i, w] of windows.entries()) {
    const after = await taskTime(w.cdp);
    const tasks = await w.page.evaluate(() => window.__rp.slice());
    const afterRelease = tasks.filter(([start, dur]) => start + dur > releaseMarks[i]);
    const last = afterRelease.length ? Math.max(...afterRelease.map(([start, dur]) => start + dur)) - releaseMarks[i] : 0;
    const work = await w.page.evaluate(() => ({ ...window.__work }));
    const delta = Object.fromEntries(Object.entries(work).map(([k, v]) => [k, v - workBefore[i][k]]));
    out.push({ work: delta, busyMs: round1(after - before[i]), longest: round1(Math.max(0, ...afterRelease.map(t => t[1]))), longTasks: afterRelease.length, quietAfterMs: round1(last), dragMs: round1(releaseMarks[i] - marks[i]) });
    w.width = width;
  }
  return out;
}

export async function measure({ turns = 30, scale = 2, sidebar = false, from = 700, to = 1000, rounds = 4, pair = false, profileDir = '' } = {}) {
  const browser = await chromium.launch({ headless: true });
  const height = 900;
  try {
    const windows = [await openLoaded(browser, { turns, sidebar, scale, width: from, height })];
    if (pair) windows.push(await openLoaded(browser, { turns, sidebar: !sidebar, scale, width: Math.round(from * 0.6), height }));
    windows.forEach((w, i) => { w.width = i ? Math.round(from * 0.6) : from; });
    const result = { turns, scale, sidebar, pair, from, to, jump: [], drag: [] };
    for (const mode of ['jump', 'drag']) {
      for (let i = 0; i < rounds; i++) {
        // Every release lands on a width never seen before (the way a hand dragging a divider does), so nothing is answered from a cache.
        const target = from + Math.round(((to - from) * (((i + 1) * 0.618033988) % 1)) + (mode === 'drag' ? 3 : 0));
        if (profileDir && i === 1 && mode === 'jump') { for (const w of windows) { await w.cdp.send('Profiler.enable'); await w.cdp.send('Profiler.start'); } }
        const sample = await resizeOnce(windows, target, height, mode);
        if (profileDir && i === 1 && mode === 'jump') {
          fs.mkdirSync(profileDir, { recursive: true });
          for (const [n, w] of windows.entries()) { const { profile } = await w.cdp.send('Profiler.stop'); fs.writeFileSync(path.join(profileDir, `jump-${n}.cpuprofile`), JSON.stringify(profile)); }
        }
        result[mode].push(sample);
      }
    }
    result.problems = windows.flatMap(w => w.problems);
    return result;
  } finally { await browser.close(); }
}

export function summarize(result) {
  const lines = [];
  for (const mode of ['jump', 'drag']) {
    // The first sample pays for one-off work (building the first lens, compiling); report it apart from the steady ones.
    const samples = result[mode].map(round => round[0]);
    const steady = samples.slice(1);
    const pick = (key, list) => round1(median(list.map(s => s[key])));
    const work = (list) => { const w = list[Math.floor(list.length / 2)].work; return `${w.encodes} encodes, ${Math.round(w.encodedPixels / 1000)}k px encoded, ${Math.round(w.imageDataPixels / 1000)}k px of ImageData, ${w.canvases} canvases`; };
    lines.push(`${mode.padEnd(5)} first: busy ${samples[0].busyMs} ms, longest ${samples[0].longest} ms, quiet after ${samples[0].quietAfterMs} ms | steady median: busy ${pick('busyMs', steady)} ms, longest ${pick('longest', steady)} ms, long tasks ${pick('longTasks', steady)}, quiet after ${pick('quietAfterMs', steady)} ms | work per ${mode}: ${work(steady)}`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = { turns: Number(arg('turns', 30)), scale: Number(arg('scale', 2)), sidebar: args.includes('--sidebar'), from: Number(arg('from', 700)), to: Number(arg('to', 1000)), rounds: Number(arg('rounds', 4)), pair: args.includes('--pair'), profileDir: arg('profile', '') };
  const result = await measure(options);
  console.log(`${options.turns} turns, ${options.scale}x, ${options.sidebar ? 'sidebar' : 'editor'} layout${options.pair ? ' + a second window' : ''}, ${options.from}↔${options.to}px`);
  console.log(summarize(result));
  if (result.problems.length) console.log('page problems:', JSON.stringify(result.problems.slice(0, 5)));
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(result, null, 1));
}
