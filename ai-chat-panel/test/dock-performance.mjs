// Frame times of the real chat page while the glass dock is busy: typing, a streaming reply, the model menu and scrolling.
// No model calls. Add --gpu to drive a headed Edge so frames include real GPU compositing (a headless run uses software
// rendering, which exaggerates filters); --sidebar for the rail layout; --no-glass to switch the liquid-glass engine off for a
// floor; --phases=typing,menu to run some of them. --out=path sets the report folder (default C:/Dev/clanker-glass/dock-performance).
//   node ai-chat-panel/test/dock-performance.mjs --gpu
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const phases = (args.find((a) => a.startsWith('--phases='))?.slice(9) || 'typing,menu,stream,scroll').split(',');

const browser = flag('gpu')
  ? await chromium.launch({ channel: 'msedge', headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--window-size=1000,1000'] })
  : await chromium.launch({ args: ['--enable-gpu-rasterization'] });
const { page, problems } = await openChat(browser, { width: 900, height: 900, scale: 2, sidebar: flag('sidebar') });
if (flag('no-glass')) {
  // The engine only starts when the engine can refract a backdrop, so say it can't.
  await page.addInitScript(() => { const supports = CSS.supports.bind(CSS); CSS.supports = (...a) => (String(a[1] || a[0]).includes('url(#x)') ? false : supports(...a)); });
  await page.reload();
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
}
await page.clock.resume(); // boot pins the clock for pictures; frames need real time
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const send = (data) => page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), data);

// A long chat, so the dock has real text and code behind it.
const messages = [];
for (let i = 0; i < 12; i++) {
  messages.push({ role: 'user', text: `Question number ${i} about the code.` });
  messages.push({ role: 'assistant', agent: 'codex', modelLabel: 'GPT', text: `Here is **answer ${i}**.\n\n- point one\n- point two\n\n\`\`\`js\nconst a = ${i};\nconsole.log(a);\n\`\`\`\n\nSome more explanatory text that wraps across lines so the bubble has a real height to paint.` });
}
const loadChat = (id, list, running = null) => send({ type: 'chatLoaded', chat: { id, messages: list }, running });
const now = (await page.evaluate(() => Date.now())) / 1000;
await send({ type: 'quotas', quotas: { claude: { remaining: 40, resetsAt: now + 5400, windowMinutes: 300 }, codex: { remaining: 60, resetsAt: now + 660, windowMinutes: 300 }, gemini: { remaining: 100, resetsAt: now + 17820, windowMinutes: 300 } } });
await send({ type: 'history', sessions: ['Fix the build', 'Refactor router', 'Write docs'].map((title, i) => ({ id: `h${i}`, title, updatedAt: new Date(Date.now() - i * 3600e3).toISOString(), latestAgent: ['codex', 'claude', 'gemini'][i], state: 'idle', selected: i === 0 })) });
await loadChat('long', messages);
await page.waitForTimeout(1500);

const stats = (t) => { const s = [...t].sort((a, b) => a - b); return { frames: t.length, avg: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s.at(-1).toFixed(1), over33ms: t.filter((x) => x > 33).length }; };
async function phase(name, ms, action) {
  await page.evaluate((duration) => { window.__frames = []; const end = performance.now() + duration; let last = performance.now(); const tick = (n) => { window.__frames.push(n - last); last = n; if (n < end) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }, ms);
  const before = await metrics();
  await action(ms);
  await page.waitForTimeout(100);
  const after = await metrics();
  const result = { phase: name, ...stats(await page.evaluate(() => window.__frames)), mainThreadMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000), styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000) };
  console.log(JSON.stringify(result));
  return result;
}
const until = async (ms, step) => { const end = Date.now() + ms; while (Date.now() < end) await step(); };

const results = [];
if (phases.includes('typing')) results.push(await phase('typing', 3000, async (ms) => {
  await page.locator('textarea').first().click();
  await until(ms, () => page.keyboard.type('hello', { delay: 30 }));
}));
if (phases.includes('menu')) results.push(await phase('menu', 3000, (ms) => until(ms, async () => {
  await page.locator('#modelPill').click(); await page.waitForTimeout(450); await page.keyboard.press('Escape'); await page.waitForTimeout(350);
})));
if (phases.includes('stream')) {
  await loadChat('streaming', messages.slice(0, 2), { agentId: 'codex', modelLabel: 'GPT', startedAt: Date.now() });
  const words = 'The quick brown fox jumps over the lazy dog while the island glass keeps refracting everything behind it. '.split(' ');
  let i = 0;
  results.push(await phase('stream', 4000, (ms) => until(ms, async () => { await send({ type: 'delta', model: 'codex', text: `${words[i++ % words.length]} ` }); await page.waitForTimeout(25); })));
  await send({ type: 'turn_complete', agent: 'codex' });
  await loadChat('long', messages);
  await page.waitForTimeout(800);
}
if (phases.includes('scroll')) results.push(await phase('scroll', 3000, async (ms) => {
  await page.mouse.move(450, 400);
  let direction = 1;
  await until(ms, async () => { for (let k = 0; k < 20; k++) { await page.mouse.wheel(0, 60 * direction); await page.waitForTimeout(16); } direction = -direction; });
}));

const out = path.resolve(args.find(a => a.startsWith('--out='))?.slice(6) || 'C:/Dev/clanker-glass/dock-performance');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify({ options: args, problems, results }, null, 2));
await browser.close();
