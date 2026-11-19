// Renders the README pictures from the real chat page, driven by the fake host with invented data.
// Nothing is sent to a CLI or model, and no real chat, project or account appears in the pictures.
//   node scripts/readme-shots.mjs [--out=docs/images] [--only=<shot id>] [--theme=dark|light]
// --theme=light renders the page as the IDE does under a light colour theme (body.vscode-light).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openChat } from '../ai-chat-panel/test/ui-tester/boot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outDir = path.resolve(root, flag('out', 'docs/images'));
const only = flag('only', null);
const theme = flag('theme', 'dark');
fs.mkdirSync(outDir, { recursive: true });

const post = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const connected = { enabled: true, unavailable: null, installed: true, auth: 'connected', settingUp: false, note: '', fault: null };
const quotas = (page) => page.evaluate(() => {
  const now = Date.now() / 1000, q = (remaining, reset, weekly) => ({ remaining, used: 100 - remaining, windowMinutes: 300, resetsAt: now + reset, secondary: { remaining: weekly, resetsAt: now + 4 * 86400 } });
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'quotas', quotas: { claude: q(72, 6600, 81), codex: q(91, 12100, 64), gemini: q(38, 3100, 77) } } }));
});
const providers = page => post(page, { type: 'cliConnections', setupNeeded: false, checking: false, providers: { claude: connected, codex: connected, gemini: connected } });

// The page clock is pinned (boot.mjs), so every timestamp is built from the same moment.
const PINNED = new Date(2026, 2, 2, 8, 0, 0).getTime();
const ago = minutes => new Date(PINNED - minutes * 60000).toISOString();
const PROJECTS = [{ id: 'atlas', name: 'Atlas API', root: 'C:/work/atlas-api' }, { id: 'web', name: 'Storefront', root: 'C:/work/storefront' }, { id: 'docs', name: 'Docs site', root: 'C:/work/docs' }];
const rail = async page => {
  await post(page, { type: 'project', projects: PROJECTS, project: PROJECTS[0], chatId: 'demo' });
  await post(page, { type: 'history', sessions: [
    { id: 'demo', title: 'Harden the sync worker', models: ['claude', 'codex', 'gemini'], latestAgent: 'gemini', projectName: 'Atlas API', updatedAt: ago(2), lastMessage: { role: 'assistant', agent: 'gemini', text: 'Changelog drafted.' } },
    { id: 'c2', title: 'Checkout flow redesign', models: ['claude'], latestAgent: 'claude', projectName: 'Storefront', updatedAt: ago(48), lastMessage: { role: 'assistant', agent: 'claude', text: 'Cart summary is responsive now.' } },
    { id: 'c3', title: 'Why is the nightly job slow?', models: ['codex'], latestAgent: 'codex', projectName: 'Atlas API', updatedAt: ago(190), lastMessage: { role: 'assistant', agent: 'codex', text: 'Two N+1 queries in the exporter.' } },
  ] });
};
const tool = (id, name, command, offset) => ({ role: 'tool', event: { type: 'tool_start', toolId: id, name, command, output: '' }, done: true, offset });
const conversation = async page => {
  const claude = 'Claude Opus 5.5', codex = 'GPT-6.1-Sol', gemini = 'Gemini 3.8 Flash';
  await post(page, { type: 'chatLoaded', chat: { id: 'demo', modelId: 'claude-opus-5-5-medium', messages: [
    { role: 'user', text: 'The sync worker drops jobs when the API rate-limits. Add retries with backoff and cover it with tests.', at: ago(14) },
    { role: 'assistant', agent: 'claude', modelLabel: claude, at: ago(11), text: 'Retries now use exponential backoff with jitter, capped at 30 seconds. A 429 honours `Retry-After`, and a job that exhausts its attempts goes to the dead-letter queue instead of vanishing.', },
    tool('t1', 'Edit', 'src/sync/worker.ts', 0),
    tool('t2', 'Bash', 'npm test -- sync', 0),
    { role: 'user', text: 'Codex, review that diff before I merge.', at: ago(8) },
    { role: 'assistant', agent: 'codex', modelLabel: codex, at: ago(5), text: 'One real problem: the jitter is applied after the cap, so the last retry can wait 45 seconds. Move it before the cap. Everything else holds, and the new tests cover the 429 path.' },
    { role: 'user', text: 'Gemini, write the changelog entry.', at: ago(3) },
    { role: 'assistant', agent: 'gemini', modelLabel: gemini, at: ago(2), text: '**Fixed:** the sync worker no longer drops jobs under API rate limits. Failed jobs retry with capped exponential backoff and land in the dead-letter queue after the last attempt.' },
  ] } });
};

const settings = async page => {
  await providers(page);
  await post(page, { type: 'openSettings', tab: 'general' });
  await post(page, { type: 'fleet', models: [], clis: {}, services: { sessionWarmup: { enabled: true, last: {
    claude: { label: 'Claude Code', at: PINNED - 52 * 60000, status: 'ok', tokens: 31 },
    codex: { label: 'Codex', at: PINNED - 49 * 60000, status: 'ok', tokens: 24 },
    gemini: { label: 'Antigravity', at: PINNED - 47 * 60000, status: 'ok', tokens: 19 } } } } });
  await post(page, { type: 'apiValue', totalUsd: 1751, monthUsd: 300, since: '2026-09-22T08:00:00Z', unpriced: 342,
    byAgent: { claude: 1169, codex: 423, gemini: 160 }, prices: { verified: '2026-11-15' } });
  await page.waitForTimeout(500);
};
/** The box from the top of `first` to the bottom of `last` (or `first` alone). */
const span = async (page, first, last) => {
  const a = await first.first().boundingBox(), b = last ? await last.first().boundingBox() : a;
  return { x: a.x, y: a.y, width: a.width, height: b.y + b.height - a.y };
};

const SHOTS = [
  { id: 'hero-chat', width: 1000, height: 880, sidebar: true, setup: async page => { await providers(page); await quotas(page); await rail(page); await conversation(page); } },
  // Prompts waiting for a usage reset, a clock time, or their turn.
  { id: 'scheduler', width: 620, height: 780, setup: async page => {
    await providers(page);
    const now = await page.evaluate(() => Date.now()); // the page clock is pinned, not the wall clock
    const base = { chatId: 'demo', model: 'claude', modelId: 'claude-opus-5-5-medium', status: 'pending', attachments: [] };
    await post(page, { type: 'chatLoaded', chat: { id: 'demo', modelId: base.modelId, messages: [
      { role: 'user', text: 'Migrate the remaining endpoints to the new auth middleware.', at: ago(30) },
      { role: 'assistant', agent: 'claude', modelLabel: 'Claude Opus 5.5', at: ago(1), text: "I hit the 5-hour limit after 14 of 22 endpoints. The rest are queued below and will start on their own when the window resets, so nothing needs your attention." },
    ] } });
    await post(page, { type: 'quotas', quotas: { claude: { remaining: 0, used: 100, windowMinutes: 300, resetsAt: now / 1000 + 5400 }, codex: { remaining: 91 }, gemini: { remaining: 38 } } });
    await post(page, { type: 'schedulerQueue', queue: [
      { ...base, id: 's1', prompt: 'Continue migrating the remaining endpoints', dispatchTrigger: 'quota-reset', notBefore: new Date(now + 5400000).toISOString() },
      { ...base, id: 's2', model: 'codex', modelId: 'gpt-6.1-sol-high', prompt: 'Review the auth migration for missed routes', dispatchTrigger: 'quota-reset', notBefore: new Date(now + 5400000).toISOString() },
      { ...base, id: 's3', model: 'gemini', modelId: 'gemini-3.8-flash-high', prompt: 'Draft release notes for tomorrow\u2019s deploy', dispatchTrigger: 'quota-reset', notBefore: new Date(now + 10800000).toISOString() },
    ] });
  } },
  // The switches behind "subscriptions first": automatic continue and windows started early.
  { id: 'settings-windows', width: 520, height: 2400, setup: async page => { await settings(page); },
    rect: async page => span(page, page.locator('.cs-row', { has: page.locator('[data-role=autoContinue], [aria-label="Automatically continue after usage resets"]') }), page.locator('[data-role=sessionWarmupStatusRow]')) },
  // What the same work would have cost per token.
  { id: 'settings-api-value', width: 520, height: 2400, setup: async page => {
    await settings(page);
    await page.locator('.cs-card', { has: page.locator('[data-role=apiValueTotal]') }).locator('.cs-row').first().click();
    await page.waitForTimeout(700);
  },
    rect: async page => span(page, page.locator('.cs-card', { has: page.locator('[data-role=apiValueTotal]') }), null) },
];

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {});
try {
  for (const shot of SHOTS.filter(item => !only || item.id === only)) {
    const { page, problems } = await openChat(browser, { width: shot.width, height: shot.height, sidebar: shot.sidebar, scale: 2 });
    await page.evaluate(theme => document.body.classList.add(`vscode-${theme}`), theme);
    await shot.setup(page);
    await page.waitForTimeout(900);
    const file = path.join(outDir, `${shot.id}${theme === 'dark' ? '' : `-${theme}`}.png`);
    const target = shot.clip?.(page);
    if (target) await target.screenshot({ path: file });
    else if (shot.rect) await page.screenshot({ path: file, clip: await shot.rect(page) });
    else await page.screenshot({ path: file });
    if (problems.length) console.warn(shot.id, problems);
    await page.close();
    console.log('wrote', shot.id);
  }
} finally { await browser.close(); }
