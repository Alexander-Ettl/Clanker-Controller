// Main-thread cost of streaming one long reply, new (incremental) renderer against the old whole-reply one.
//   node ai-chat-panel/test/stream-performance.mjs [--old] [--kb=80]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openChat, media } from './ui-tester/boot.mjs';

const old = process.argv.includes('--old');
const kb = Number((process.argv.find((a) => a.startsWith('--kb=')) || '--kb=80').slice(5));
const browser = await chromium.launch();
try {
  const { page } = await openChat(browser, { width: 900, height: 900 });
  if (old) await page.route('**/main.js', (route) => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(media, 'main.js'), 'utf8').replace('if (restoringHistory || NO_INCREMENTAL.test(raw))', 'if (true)') }));
  if (old) await page.reload();
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  await page.clock.resume();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const send = (data) => page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
  await send({ type: 'chatLoaded', chat: { id: 's', messages: [{ role: 'user', text: 'q' }] }, running: { agentId: 'codex', modelLabel: 'GPT', startedAt: 1 } });
  const para = 'Here is **a paragraph** with `inline code`, a [link](https://example.com), and enough words to wrap across a couple of lines in the bubble.\n\n- point one\n- point two\n\n';
  let text = '';
  for (let i = 0; text.length < kb * 1024; i++) text += i % 5 === 4 ? '```js\nconst a = ' + i + ';\nconsole.log(a);\n```\n\n' : para;
  const before = await metrics();
  const frames = await page.evaluate(() => { window.__f = []; let last = performance.now(); const t = (n) => { window.__f.push(n - last); last = n; requestAnimationFrame(t); }; requestAnimationFrame(t); return 0; });
  const start = Date.now();
  for (let i = 0; i < text.length; i += 120) { await send({ type: 'delta', model: 'codex', text: text.slice(i, i + 120) }); await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); }
  const after = await metrics();
  const f = (await page.evaluate(() => window.__f)).sort((a, b) => a - b);
  console.log(JSON.stringify({ renderer: old ? 'old' : 'incremental', kb, deltas: Math.ceil(text.length / 120), mainThreadMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000), scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000), layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000), styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000), p95FrameMs: +f[Math.floor(f.length * 0.95)].toFixed(1), maxFrameMs: +f.at(-1).toFixed(1) }));
} finally { await browser.close(); }
