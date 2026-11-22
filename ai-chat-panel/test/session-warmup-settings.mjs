import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Settings > General > "Start usage windows early" in a real browser with the real settings.js and stylesheets: the switch
// sends the right message, follow what the host reports, show what the last pings did, and fit the narrow window.
// Pictures go to a temp folder for a human look (dark and light).
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const read = (file) => fs.readFileSync(path.join(media, file), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>${['style.css', 'launcher.css', 'settings.css'].map(read).join('\n')}</style>
<body style="margin:0;padding:12px;width:340px"><div class="fs-modal" style="position:static;display:block"><div class="fs-modal-sheet glass"><div class="fs-modal-body" id="csBody"></div></div></div>
<script>window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (message) => window.sent.push(message) });</script>
<script>${read('agent-icons.js')}</script><script>${read('model-prompts.js')}</script><script>${read('voice-hotkey.js')}</script><script>${read('settings.js')}</script>
<script>window.api = window.initChatSettings({ vscode: window.acquireVsCodeApi(), body: document.getElementById('csBody') }); window.api.showTab('general');</script>`;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-warmup-'));
const at = new Date(); at.setHours(6, 30, 0, 0);
const last = {
  claude: { status: 'done', at: Date.now() - 60000, label: 'Claude Haiku 5.5 Low', tokens: 31 },
  codex: { status: 'running', at: Date.now() - 60000, label: 'GPT 5.5 Mini Low' },
  gemini: { status: 'failed', at: Date.now() - 60000, label: 'Gemini 3.8 Flash Low', error: 'exit 1' },
};
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const errors = [];
  for (const width of [364, 560]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(html);
    const sent = () => page.evaluate(() => window.sent.filter((message) => message.type === 'setSessionWarmup'));
    const toggle = page.locator('[data-role=sessionWarmup]');

    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'on by default');
    await toggle.click();
    assert.deepEqual((await sent()).at(-1), { type: 'setSessionWarmup', enabled: false });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    assert.deepEqual((await sent()).at(-1), { type: 'setSessionWarmup', enabled: true });
    assert.equal(await page.locator('[data-role=sessionWarmupTimeRow]').count(), 0, 'no start time to set any more');

    await page.evaluate(() => window.api.fleet({ models: [], clis: {}, services: { sessionWarmup: { enabled: false, last: {} } } }));
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'follows the host');
    await page.evaluate((last) => window.api.fleet({ models: [], clis: {}, services: { sessionWarmup: { enabled: true, last: {} } } }), last);
    assert.equal(await page.locator('[data-role=sessionWarmupStatusRow]').isHidden(), true, 'no results row before the first ping');
    await page.evaluate((last) => window.api.fleet({ models: [], clis: {}, services: { sessionWarmup: { enabled: true, last } } }), last);
    const status = await page.locator('[data-role=sessionWarmupStatus]').innerText();
    assert.match(status, /Claude Haiku 5\.5 Low \d\d:\d\d, 31 tokens/);
    assert.match(status, /GPT 5\.5 Mini Low: window already running/);
    assert.match(status, /Gemini 3\.8 Flash Low: failed, exit 1/);

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow at ${width}px`);
    await page.locator('[data-role=sessionWarmup]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `warmup-${width}.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: path.join(out, `warmup-${width}-light.png`), fullPage: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(out);
} finally { await browser.close(); }
