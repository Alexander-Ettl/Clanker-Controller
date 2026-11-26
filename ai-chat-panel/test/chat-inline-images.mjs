// Inline chat image embedding: before/after explicit markdown images, auto-embedded linked images capped at 4 with
// on-demand overflow expansion, shared lightbox popup on image click, and VS Code pop-out button on top.
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
require('./model-fixture').seedModels();
const uri = (file) => ({ fsPath: file, toString: () => file });
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(String(base), ...parts)) }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
  return originalLoad.call(this, request, parent, isMain);
};
const { ChatWindowHost } = require('../extension');
Module._load = originalLoad;
const media = path.resolve(fileURLToPath(new URL('../media/', import.meta.url)));
const origin = 'http://127.0.0.1';
const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: {}, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'claude' });
const html = host.renderHtml({ cspSource: origin, asWebviewUri: (value) => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });

const svgDataUri = (label, bg) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" rx="12" fill="${bg}"/><text x="160" y="96" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="22" font-weight="600">${label}</text></svg>`).toString('base64')}`;

const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 820, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${origin}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(media, '.' + pathname);
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.addInitScript(({ beforeUri, afterUri, shotUri }) => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.sent.push(message);
        if (message.type === 'previewFile') {
          setTimeout(() => {
            if (message.path.includes('missing')) {
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'filePreview', requestId: message.requestId, path: message.path, error: 'File not found' } }));
              return;
            }
            const uri = message.path.includes('before') ? beforeUri : message.path.includes('after') ? afterUri : shotUri;
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'filePreview', requestId: message.requestId, path: message.path, uri, name: message.path.split('/').pop() } }));
          }, 10);
        }
      },
      getState: () => ({}),
      setState() {},
    });
  }, {
    beforeUri: svgDataUri('Before', '#2b3240'),
    afterUri: svgDataUri('After', '#1f4d3a'),
    shotUri: svgDataUri('Shot', '#34304d'),
  });

  await page.goto(origin);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  const send = (message) => page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), message);

  // 1. Explicit side-by-side before/after images + missing fallback.
  const msg1 = [
    'Here is the before-and-after comparison:',
    '',
    '![Before](out/before.png)',
    '![After](out/after.png)',
    '',
    'Also tried ![Missing](out/missing.png).',
  ].join('\n');

  // 2. Reply with 15 linked screenshots: caps visible images at 4 and folds 11 behind "Show 11 more images".
  const fifteenLinks = Array.from({ length: 15 }, (_, idx) => `[shot-${idx + 1}.png](out/shot-${idx + 1}.png)`).join(', ');
  const msg2 = `Verified all viewports: ${fifteenLinks}. Plus a non-existent example [ghost.png](out/missing-auto.png).`;

  await send({
    type: 'chatLoaded',
    chat: {
      id: 'inline-images',
      modelId: 'auto',
      messages: [
        { role: 'user', text: 'Show before and after' },
        { role: 'assistant', agent: 'claude', text: msg1 },
        { role: 'user', text: 'Run all 15 checks' },
        { role: 'assistant', agent: 'codex', text: msg2 },
      ],
    },
  });

  await page.locator('.chat-image-card.is-ready').first().waitFor();
  await page.waitForTimeout(120);

  // Check explicit before/after grid.
  const firstMsg = page.locator('.msg-assistant').nth(0);
  const explicitGrid = firstMsg.locator('.chat-image-grid[data-inline-images="explicit"]');
  assert.equal(await explicitGrid.getAttribute('data-count'), '2', 'before/after sit in a 2-image side-by-side grid');
  assert.equal(await explicitGrid.locator('.chat-image-card.is-ready').count(), 2);

  // Click the pop-out button on Before -> opens in VS Code without opening lightbox.
  await explicitGrid.locator('.chat-image-card').first().locator('.chat-image-popout').click();
  assert.equal(await page.locator('.image-lightbox').count(), 0, 'pop-out button does not open lightbox');
  assert.equal(await page.evaluate(() => window.sent.findLast((m) => m.type === 'openFile')?.path), 'out/before.png', 'pop-out sends openFile to VS Code');

  // Click the After image itself -> opens shared lightbox popup, Esc closes it.
  await explicitGrid.locator('.chat-image-card').nth(1).locator('.chat-image-stage').click();
  await page.locator('.image-lightbox.is-open').waitFor();
  assert.equal(await page.locator('.image-lightbox-caption').textContent(), 'after.png');
  assert.equal(await page.locator('.image-lightbox .image-lightbox-open').count(), 1, 'shared lightbox includes Open in editor button');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(260);
  assert.equal(await page.locator('.image-lightbox').count(), 0, 'Escape closes shared lightbox');

  // Check 15-linked-image message: capped at 4 visible + "Show 11 more images" pill (missing-auto ignored).
  const secondMsg = page.locator('.msg-assistant').nth(1);
  const autoGallery = secondMsg.locator('.chat-image-gallery');
  await autoGallery.waitFor({ state: 'visible' });
  assert.equal(await autoGallery.locator('.chat-image-card.is-ready').count(), 4, 'caps visible auto-embedded images at 4');
  const moreBtn = autoGallery.locator('.chat-image-more');
  assert.equal(await moreBtn.textContent(), 'Show 12 more images', 'folds remaining 12 linked images behind expand button without fetching them yet');

  // Expand remaining images on demand.
  await moreBtn.click();
  await page.waitForTimeout(160);
  assert.equal(await autoGallery.locator('.chat-image-card.is-ready').count(), 15, 'expanding loads all remaining valid images (and skips missing-auto)');
  assert.equal(await autoGallery.locator('.chat-image-more').count(), 0, 'expand button disappears once expanded');

  assert.deepEqual(errors, []);
  console.log('chat inline images ok: explicit before/after, shared lightbox, VS Code popout, 4-image cap + 11 overflow expansion.');
} finally {
  await browser.close();
}
