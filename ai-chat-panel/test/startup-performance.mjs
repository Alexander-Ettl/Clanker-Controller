// Cold-document startup in the real webview, fake host, headed Edge. No real model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const devDir = (sub) => path.join(process.platform === 'win32' ? 'C:/Dev' : path.join(os.homedir(), 'dev'), sub); // scratch output lives outside the synced repo
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
const out = path.resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || devDir('clanker-glass/startup'));
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: false });
const results = [];
try {
  for (const sidebar of [false, true]) for (let run = 0; run < 3; run++) {
    const { page, problems } = await openChat(browser, { width: 900, height: 900, sidebar, scale: 2 });
    await page.clock.resume();
    await page.addInitScript(() => {
      const started = performance.now();
      window.startup = { longTasks: [] };
      new PerformanceObserver(list => window.startup.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask' });
      document.addEventListener('DOMContentLoaded', () => { window.startup.domMs = performance.now() - started; });
      window.addEventListener('load', () => { window.startup.loadMs = performance.now() - started; });
      const observer = new MutationObserver(() => {
        if (!window.CLANKER_UI_INITIALIZED || document.documentElement.hasAttribute('data-ui-loading')) return;
        window.startup.usableMs = performance.now() - started;
        observer.disconnect();
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ui-loading'] });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.startup?.usableMs > 0);
    const { profile } = await cdp.send('Profiler.stop');
    if (run === 2) fs.writeFileSync(path.join(out, `${sidebar ? 'sidebar' : 'editor'}.cpuprofile`), JSON.stringify(profile));
    const data = await page.evaluate(() => ({ ...window.startup, resources: performance.getEntriesByType('resource').map(e => ({ name: e.name.split('/').at(-1), ms: e.duration, bytes: e.decodedBodySize })) }));
    results.push({ sidebar, run, ...data, problems });
    console.log(JSON.stringify({ sidebar, run, usableMs: data.usableMs, domMs: data.domMs, loadMs: data.loadMs, longTasks: data.longTasks }));
    await page.context().close();
  }
  fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify(results, null, 2));
} finally { await browser.close(); }
