import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Tool cards: each tool's output opens as a view that suits it (code with a gutter, grep by file, file list, terminal text, diff, search).
const require = createRequire(import.meta.url);
require('./model-fixture').seedModels();
const uri = file => ({ fsPath: file, toString: () => file });
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
const html = host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(media, '.' + pathname);
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage(message) { window.sent.push(message); }, getState: () => ({}), setState() {} }); });
  await page.goto(origin);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  await send({ type: 'chatLoaded', chat: { id: 'views', modelId: 'auto', messages: [] } });
  await send({ type: 'routing', agentId: 'claude' });
  let n = 0;
  const tool = async (name, command, output, extra = {}) => { const toolId = `t${++n}`; await send({ type: 'tool_start', name, command, toolId, ...extra }); await send({ type: 'tool_end', toolId, output, error: extra.error }); return page.locator('.tool-card').last(); };
  const open = async card => {
    await card.evaluate(el => { el.open = true; });
    await card.and(page.locator('[data-view="1"]')).waitFor();
  };

  // A read: a gutter of real line numbers, code that scrolls sideways, nothing built until the card opens.
  const long = 'const veryLongLine = ' + '"x".repeat(5) + '.repeat(40) + ';';
  const read = await tool('Read', 'src\\app.js', `10\tfunction a() {\n11\t  return 1;\n12\t}\n13\t${long}`);
  assert.equal(await read.getAttribute('data-view'), null, 'a closed card builds no view');
  await open(read);
  assert.equal(await read.getAttribute('data-view'), '1');
  assert.deepEqual(await read.locator('.tv-n').allTextContents(), ['10', '11', '12', '13']);
  assert.equal(await read.locator('.tv-chip').textContent(), 'JS');
  assert.match(await read.locator('.tv-label').textContent(), /lines 10\u201313/);
  assert.equal((await read.locator('.tv-row').nth(1).locator('.tv-c').textContent()), '  return 1;');
  const scroller = read.locator('.tv-scroll');
  const rowHeights = await read.locator('.tv-row').evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));
  assert.equal(new Set(rowHeights).size, 1, 'the long line stays on one row');
  assert.equal(await scroller.evaluate(el => el.scrollWidth > el.clientWidth), true, 'and scrolls sideways');
  const wrapButton = read.locator('.tv-btn[title="Wrap long lines"]');
  await wrapButton.click();
  assert.equal(await scroller.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'wrap folds it back in');
  assert.ok((await read.locator('.tv-row').last().boundingBox()).height > rowHeights[0] * 1.5);
  await wrapButton.click();
  assert.equal(await read.locator('.tv').evaluate(el => el.classList.contains('is-wrap')), false);

  // The expand button opens the same code large in the preview window.
  await read.locator('.tv-btn[title="View larger"]').click();
  const viewer = page.locator('.image-lightbox.is-code');
  await viewer.locator('.tv.is-big .tv-n').first().waitFor();
  assert.equal(await viewer.locator('.tv-n').count(), 4);
  assert.equal(await viewer.locator('.image-lightbox-download').count(), 0, 'code has nothing to download');
  assert.equal(await viewer.locator('.image-lightbox-open').count(), 1, 'a file opens in the editor from here');
  await page.keyboard.press('Escape');
  await page.locator('.image-lightbox').waitFor({ state: 'detached' });

  // Grep: grouped by file; a file header and a line number open the editor.
  const grep = await tool('Grep', '"loadChat" in src', 'src\\a.js:12:const x = loadChat();\nsrc\\a.js-13-  y();\n--\nsrc\\a.js:40:loadChat();\nC:\\w\\b.css:7:.a { color: red; }');
  await open(grep);
  assert.equal(await grep.locator('.tv-file').count(), 2);
  assert.match(await grep.locator('.tv-label').first().textContent(), /3 matches in 2 files/);
  assert.equal(await grep.locator('.tv-row.is-ctx').count(), 1);
  assert.equal(await grep.locator('.tv-row.is-gap').count(), 1);
  await grep.locator('.tv-row[data-line="40"] .tv-n').click();
  await grep.locator('.tv-file').nth(1).click();
  const sent = await page.evaluate(() => window.sent.filter(m => m.type === 'openFile'));
  assert.deepEqual(sent.slice(-2).map(m => [m.path, m.line]), [['src\\a.js', 40], ['C:\\w\\b.css', undefined]]);

  // Glob: a list of files, folders dimmed, pictures previewed.
  const glob = await tool('Glob', '"**/*" in C:\\Example Projects', 'docs\\a.md\nC:\\Example Projects\\shot.png\nREADME.md');
  await open(glob);
  assert.equal(await glob.locator('.tv-item').count(), 3);
  assert.equal(await glob.locator('.tv-item .tv-file-name').nth(1).textContent(), 'shot.png');
  await glob.locator('.tv-item').nth(1).click();
  assert.equal(await page.evaluate(() => window.sent.at(-1).type), 'previewFile');

  // A shell step: the command shown in full, then the output with its colours; CRLF and escapes are gone.
  const shell = await tool('Bash', 'cd app && npm test', '\u001b[31mFAIL\u001b[0m test/a.test.js\r\nnpm ERR! code 1\r\n \u001b[32m✓\u001b[0m fine\r\n', { error: true });
  await open(shell);
  assert.equal(await shell.locator('.tv-cmd .tv-n').textContent(), '$');
  assert.equal(await shell.locator('.tv-cmd .tv-c').textContent(), 'cd app && npm test');
  assert.equal(await shell.locator('.tv-out .an-31').textContent(), 'FAIL');
  assert.equal(await shell.locator('.tv-chip.is-error').count(), 1);
  assert.equal((await shell.locator('.tv-out').textContent()).includes('\u001b'), false);
  assert.equal(await shell.locator('.tv-row.is-err').count(), 1, 'a plain failure line is tinted too');
  const plain = await tool('Bash', 'git diff', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n');
  await open(plain);
  assert.equal(await plain.locator('.tv-row.is-add').count(), 1);
  assert.equal(await plain.locator('.tv-row.is-del').count(), 1);
  assert.equal(await plain.locator('.tv-row.is-hunk').count(), 1);

  // A step still running opens to its command; the output arrives into the same card.
  await send({ type: 'tool_start', name: 'Bash', command: 'sleep 3 && echo done', toolId: 'slow' });
  const slow = page.locator('.tool-card').last();
  await open(slow);
  assert.match(await slow.locator('.tv-note').textContent(), /Running/);
  await send({ type: 'tool_end', toolId: 'slow', output: 'done\n' });
  assert.equal(await slow.locator('.tv-out .tv-c').textContent(), 'done');

  // An edit shows a coloured diff with signs in the gutter and its language.
  await send({ type: 'tool_start', name: 'Edit', command: 'src\\app.css', toolId: 'ed', diff: '-a { color: red; }\n+a { color: blue; }\n  b {}' });
  await send({ type: 'tool_end', toolId: 'ed', output: 'updated' });
  const edit = page.locator('.tool-card').last();
  await open(edit);
  assert.equal(await edit.locator('.tv-chip').textContent(), 'CSS');
  assert.deepEqual(await edit.locator('.tv-n').allTextContents(), ['\u2212', '+', '']);
  assert.equal(await edit.locator('.tv-row.is-add .tv-c').textContent(), 'a { color: blue; }');

  // Web search: links open in the browser, the summary reads as text.
  const searchCard = await tool('WebSearch', 'hand cursor', 'Web search results for query: "hand cursor"\n\nLinks: [{"title":"MDN cursor","url":"https://developer.mozilla.org/cursor"}]\n\nUse `grab`. See [`cursor`](https://example.org/docs?a=1&b=2).');
  await open(searchCard);
  assert.equal(await searchCard.locator('.tv-link .tv-file-dir').textContent(), 'developer.mozilla.org');
  assert.deepEqual(await searchCard.locator('.tv-md code').allTextContents(), ['grab', 'cursor']);
  assert.equal(await searchCard.locator('.tv-md a').getAttribute('href'), 'https://example.org/docs?a=1&b=2');
  await searchCard.locator('.tv-link').click();
  assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'openUrl', url: 'https://developer.mozilla.org/cursor' });

  // Odd shapes fall back to plain text; a failed read keeps its reason in red.
  const odd = await tool('Read', 'notes.txt', 'just a sentence with no numbers');
  await open(odd);
  assert.equal(await odd.locator('.tv').count(), 0);
  assert.equal(await odd.locator('.tool-body').textContent(), 'just a sentence with no numbers');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Tool views: code gutter and sideways scroll, wrap, expand, grep, glob, shell, diff, search and plain fallback passed.');
