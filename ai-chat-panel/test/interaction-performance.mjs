// Real UI, fake host: all browser scenarios, one at a time so GPU contention cannot skew the results.
// --only=id,id --width=420 --theme=light --out=C:/Dev/clanker-glass/interactions
// Setup duration includes each scenario's intentional waits; it is not input latency.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
import { scenarios } from './ui-tester/scenarios.mjs';

const args = process.argv.slice(2);
const option = (key, fallback) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) || fallback;
const out = path.resolve(option('out', 'C:/Dev/clanker-glass/interactions'));
const only = option('only', '').split(',').filter(Boolean);
const selected = scenarios.filter(s => !only.length || only.includes(s.id));
if (!selected.length || only.some(id => !selected.some(s => s.id === id))) throw new Error('Unknown scenario selection');
const width = Number(option('width', '900'));
const theme = option('theme', 'dark');
const repeats = Number(option('repeat', '1'));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('--repeat must be 1..10');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const results = [];
const round = n => Math.round(n * 10) / 10;
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, median: round(sorted[Math.floor(sorted.length / 2)] || 0),
    p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] || 0), max: round(sorted.at(-1) || 0) };
};
function save() {
  fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify({ generatedAt: new Date().toISOString(), width, theme, renderer: 'headed Edge, scale 2, fake host', results }, null, 2));
  const table = ['| Action/scenario | Status | Main thread ms | Style ms | Layout ms | Frame p95/max ms | >33ms | Input→rAF p95 ms | Long tasks |',
    '|---|---|---:|---:|---:|---|---:|---:|---:|',
    ...results.map(r => `| ${r.id} | ${r.error ? 'FAILED' : 'pass'} | ${r.mainThreadMs ?? '-'} | ${r.styleMs ?? '-'} | ${r.layoutMs ?? '-'} | ${r.frames ? `${r.frames.p95}/${r.frames.max}` : 'clock changed'} | ${r.over33ms ?? '-'} | ${r.inputToFrame?.p95 ?? '-'} | ${r.longTasks?.length ?? '-'} |`)];
  fs.writeFileSync(path.join(out, 'report.md'), `# Interaction performance\n\n${results.length}/${selected.length * repeats} scenarios, ${width}px, ${theme}, headed Edge at 2x scale. No real model calls.\n\nSetup includes scripted waits. Input→rAF measures event-handler entry to the next animation frame, not physical display latency. Frame times are omitted when a scenario changes the test clock. Failed scenarios are coverage gaps, not successful performance measurements.\n\n${table.join('\n')}\n\n${results.filter(r => r.error).map(r => `- ${r.id}: ${r.error.replaceAll('\n', ' ').slice(0, 400)}`).join('\n')}\n`);
}
try {
  for (const scenario of Array.from({ length: repeats }, () => selected).flat()) {
    let page, timer;
    const result = { id: scenario.id, run: results.filter(r => r.id === scenario.id).length + 1 };
    try {
      const started = performance.now();
      const opened = await openChat(browser, { width, height: scenario.height || 900, sidebar: scenario.sidebar || scenario.id.startsWith('loops-'), scale: 2 });
      page = opened.page;
      result.openMs = round(performance.now() - started);
      page.setDefaultTimeout(6500);
      await page.clock.resume();
      let changedClock = false;
      for (const method of ['fastForward', 'runFor', 'pauseAt', 'install']) {
        const original = page.clock[method].bind(page.clock);
        page.clock[method] = (...args) => { changedClock = true; return original(...args); };
      }
      if (theme === 'light') await page.evaluate(() => { document.body.classList.remove('vscode-dark'); document.body.classList.add('vscode-light'); });
      await page.waitForTimeout(450);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      await page.evaluate(() => {
        const data = window.__interactionPerf = { frames: [], input: [], longTasks: [], active: true };
        let last;
        function tick(now) { if (!data.active) return; if (last !== undefined) data.frames.push(now - last); last = now; requestAnimationFrame(tick); }
        requestAnimationFrame(tick);
        new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })))).observe({ type: 'longtask' });
        for (const type of ['pointerdown', 'pointerover', 'keydown', 'input', 'paste', 'wheel']) document.addEventListener(type, () => {
          const start = performance.now(); requestAnimationFrame(() => data.input.push({ type, ms: performance.now() - start }));
        }, { capture: true, passive: true });
      });
      const before = await metrics(), setupStart = performance.now();
      if (args.includes('--profile')) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
      try {
        await Promise.race([scenario.setup?.(page), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Scenario exceeded 12s budget')), 12000); })]);
      } catch (error) { result.error = error.message; }
      clearTimeout(timer);
      await page.waitForTimeout(500);
      const after = await metrics();
      if (args.includes('--profile')) {
        const { profile } = await cdp.send('Profiler.stop');
        fs.writeFileSync(path.join(out, `${scenario.id}.cpuprofile`), JSON.stringify(profile));
      }
      const data = await page.evaluate(() => { window.__interactionPerf.active = false; return window.__interactionPerf; });
      result.setupAndSettleMs = round(performance.now() - setupStart);
      for (const [key, metric] of Object.entries({ mainThreadMs: 'TaskDuration', styleMs: 'RecalcStyleDuration', layoutMs: 'LayoutDuration', scriptMs: 'ScriptDuration' })) result[key] = round((after[metric] - before[metric]) * 1000);
      result.clockChanged = changedClock;
      result.frames = changedClock ? null : distribution(data.frames);
      result.over33ms = changedClock ? null : data.frames.filter(ms => ms > 33).length;
      result.inputToFrame = changedClock ? null : distribution(data.input.map(e => e.ms));
      result.longTasks = data.longTasks;
      result.problems = opened.problems;
    } catch (error) { result.error = error.message; }
    finally { clearTimeout(timer); if (page) await page.context().close(); }
    results.push(result);
    save();
    console.log(JSON.stringify(result));
  }
} finally { await browser.close(); }
