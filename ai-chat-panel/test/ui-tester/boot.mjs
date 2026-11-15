// Opens the REAL chat page (the HTML the extension serves, with its real stylesheets and scripts) in a browser page,
// against the fake host. Nothing is sent to a CLI or a model.
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeHost } from './fake-host.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const media = path.resolve(here, '..', '..', 'media');
export const origin = 'http://127.0.0.1';
const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };

const cachedHtml = new Map();
function chatHtml(sidebar) {
  if (cachedHtml.has(sidebar)) return cachedHtml.get(sidebar);
  require(path.join(here, '..', 'model-fixture')).seedModels();
  const uri = file => ({ fsPath: file, toString: () => file });
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return { env: { language: 'en' }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(String(base), ...parts)) }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { ChatWindowHost } = require(path.join(here, '..', '..', 'extension'));
    const host = Object.assign(Object.create(ChatWindowHost.prototype), { extensionUri: '/panel', panel: { sidebar }, deps: { getModels: () => ({}) }, run: null, activeModelId: 'auto', activeAgent: 'auto', lastRoutedAgent: 'codex' });
    cachedHtml.set(sidebar, host.renderHtml({ cspSource: origin, asWebviewUri: value => origin + '/' + path.relative('/panel/media', value.fsPath).replaceAll('\\', '/') }));
  } finally { Module._load = originalLoad; }
  return cachedHtml.get(sidebar);
}

/** A page showing the chat window. `problems` collects page errors, console errors and failed requests as they happen. */
export async function openChat(browser, { width, height, sidebar = false, scale = 1 }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  const problems = [];
  page.on('pageerror', error => problems.push({ kind: 'page-error', detail: error.message.slice(0, 300) }));
  page.on('console', message => { if (message.type() === 'error') problems.push({ kind: 'console-error', detail: message.text().slice(0, 300) }); });
  await page.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: chatHtml(sidebar) });
    const file = path.resolve(media, '.' + pathname);
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) { problems.push({ kind: 'request-failed', detail: `404 ${pathname}` }); return route.fulfill({ status: 404 }); }
    return route.fulfill({ contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  // A pinned wall clock, so times and "in 20m" read the same on every run and pictures and trees can be compared.
  await page.clock.install({ time: new Date(2026, 2, 2, 8, 0, 0) });
  await page.addInitScript(installFakeHost);
  await page.goto(origin);
  await page.locator('#stopBtn').waitFor({ state: 'attached' });
  return { page, problems };
}
