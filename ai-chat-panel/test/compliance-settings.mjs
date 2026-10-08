import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Settings > Compliance in a real browser with the real settings.js and stylesheets: the two loop switches send the right
// messages and follow the saved setting, every data flow has its terms link, the checklist is there, and nothing overflows the
// narrow window. Pictures go to a temp folder for a human look (tab bar with six tabs, light and dark).
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const read = (file) => fs.readFileSync(path.join(media, file), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>${['style.css', 'launcher.css', 'settings.css'].map(read).join('\n')}</style>
<body style="margin:0;padding:12px;width:340px"><div class="fs-modal" style="position:static;display:block"><div class="fs-modal-sheet glass"><div class="fs-modal-body" id="csBody"></div></div></div>
<script>window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (message) => window.sent.push(message) });</script>
<script>${read('agent-icons.js')}</script><script>${read('model-prompts.js')}</script><script>${read('voice-hotkey.js')}</script><script>${read('settings.js')}</script>
<script>window.api = window.initChatSettings({ vscode: window.acquireVsCodeApi(), body: document.getElementById('csBody') }); window.api.showTab('compliance');</script>`;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-compliance-'));
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const errors = [];
  for (const width of [364, 560]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(html);
    const sent = (type) => page.evaluate((type) => window.sent.filter((message) => message.type === type), type);

    assert.equal(await page.locator('.cs-tab').count(), 6, 'six tabs');
    assert.equal(await page.locator('.cs-tab[data-tab=compliance]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[data-pane=compliance]').isVisible(), true);
    assert.equal(await page.locator('[data-pane=general]').isVisible(), false);
    assert.match(await page.locator('[data-pane=compliance] .cs-note').innerText(), /not legal advice/);

    // Both switches default on, send their message, and follow what the host reports.
    for (const [role, key] of [['complianceScout', 'scout'], ['complianceRedact', 'redact']]) {
      assert.equal(await page.locator(`[data-role=${role}]`).getAttribute('aria-checked'), 'true', `${role} is on by default`);
      await page.click(`[data-role=${role}]`);
      assert.equal(await page.locator(`[data-role=${role}]`).getAttribute('aria-checked'), 'false');
      assert.deepEqual((await sent('setCompliance')).at(-1), { type: 'setCompliance', key, value: false });
      await page.click(`[data-role=${role}]`);
      assert.deepEqual((await sent('setCompliance')).at(-1), { type: 'setCompliance', key, value: true });
    }
    await page.evaluate(() => window.api.fleet({ models: [], clis: {}, services: { compliance: { scout: false, redact: true } } }));
    assert.equal(await page.locator('[data-role=complianceScout]').getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('[data-role=complianceRedact]').getAttribute('aria-checked'), 'true');

    // Data flows: every cloud service names its operator and links to its own terms; the local row has no link.
    const flows = page.locator('[data-role=complianceBody] .cs-card').first().locator('.cs-set');
    assert.equal(await flows.count(), 7);
    assert.equal(await flows.locator('button').count(), 6);
    for (const key of ['anthropicDpa', 'openaiDpa', 'googleDpa', 'cloudflareDpa', 'groqPrivacy', 'telegramPrivacy']) {
      const before = (await sent('openRoutingLink')).length;
      await flows.locator('button').nth(['anthropicDpa', 'openaiDpa', 'googleDpa', 'cloudflareDpa', 'groqPrivacy', 'telegramPrivacy'].indexOf(key)).click();
      assert.equal((await sent('openRoutingLink')).at(-1).key, key);
      assert.equal((await sent('openRoutingLink')).length, before + 1);
    }
    assert.match(await flows.last().innerText(), /Local/);
    assert.match(await page.locator('[data-role=complianceBody]').innerText(), /Impressum/);
    assert.match(await page.locator('[data-role=complianceBody]').innerText(), /Art\. 28/);
    for (const key of ['gdpr', 'dpf', 'aiAct', 'bfdi']) {
      const labels = await page.locator('[data-role=complianceBody] .cs-footer button').count();
      assert.equal(labels, 4);
      await page.locator('[data-role=complianceBody] .cs-footer button').nth(['gdpr', 'dpf', 'aiAct', 'bfdi'].indexOf(key)).click();
      assert.equal((await sent('openRoutingLink')).at(-1).key, key);
    }

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow at ${width}px`);
    assert.equal(await page.evaluate(() => { const bar = document.querySelector('.cs-tabs'); return bar.scrollWidth <= bar.clientWidth + 1; }), true, `the six tabs fit at ${width}px`);
    await page.screenshot({ path: path.join(out, `compliance-${width}.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: path.join(out, `compliance-${width}-light.png`), fullPage: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`Settings compliance: tab, switches, data flows, checklist and links passed. Pictures: ${out}`);
} finally { await browser.close(); }
