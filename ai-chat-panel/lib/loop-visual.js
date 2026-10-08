'use strict';

// Visual checks for a loop, without assuming one framework. A provider turns the project into pages a headless browser can open;
// the same measuring harness (test/ui-tester) then looks at every page at three widths and reports layout problems, console
// errors and pictures that changed. Providers, in order of preference:
//   clanker     the Clanker chat window against its fake host (only for the Clanker Controller checkout)
//   visor       an Astro site wired to Visor: the dev server runs, and Visor's content scan names the pages to visit
//   playwright  any project with a dev server or static output: pages are found from the home page links and the sitemap
//   none        iOS apps, libraries and servers without pages: the run says so and carries on
// A provider that cannot start never fails the run; the reason is reported and the other checks continue.

const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { run, nodeCommand, npmCommand, sleep } = require('./loop-exec');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const SITE_SCRIPT = path.join(EXTENSION_ROOT, 'test', 'ui-tester', 'site.mjs');
const MAX_ROUTES = 8;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain' };

const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const get = async (url, ms = 4000) => { try { const response = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'follow' }); return { status: response.status, text: await response.text() }; } catch { return null; } };

/** Serves a folder of static files on a free port. */
async function serveStatic(root) {
  const base = path.resolve(root);
  const server = http.createServer((request, response) => {
    let file = path.join(base, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (!file.startsWith(base)) { response.writeHead(403).end(); return; }
    try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
    if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    if (!fs.existsSync(file)) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise(resolve => server.close(resolve)) };
}

/** Starts the project's own dev script on a free port and waits until it answers. Returns `{url, stop}`. */
async function startDevServer(profile, checkout, signal, { readyMs = 120000 } = {}) {
  const npm = npmCommand();
  if (!npm) throw new Error('npm was not found, so the dev server cannot start.');
  const port = await freePort();
  const controller = new AbortController();
  const stopAll = () => controller.abort(new Error('Dev server stopped'));
  signal?.addEventListener('abort', stopAll, { once: true });
  let found = null, log = '';
  const child = run(npm.command, [...npm.args, 'run', profile.web.script, '--', '--port', String(port), '--host', '127.0.0.1'],
    { cwd: checkout, signal: controller.signal, env: { ...npm.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0' }, timeoutMs: 2 * 3600000, maxBytes: 8 * 1024 * 1024,
      onLine: line => { log = (log + line + '\n').slice(-4000); const match = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/.exec(line); if (match && !found) found = Number(match[1]); } });
  let exited = false; child.then(() => { exited = true; }, () => { exited = true; });
  const deadline = Date.now() + readyMs;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (exited) throw new Error(`The dev server exited early: ${log.trim().split('\n').slice(-2).join(' ').slice(0, 240)}`);
      for (const candidate of new Set([found, port].filter(Boolean))) {
        const answer = await get(`http://127.0.0.1:${candidate}/`, 3000);
        if (answer && answer.status < 500) return { url: `http://127.0.0.1:${candidate}`, stop: () => { stopAll(); return child.catch(() => {}); } };
      }
      await sleep(1000, signal);
    }
    throw new Error('The dev server did not answer within two minutes.');
  } catch (error) { stopAll(); await child.catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', stopAll); }
}

/** Pages worth visiting. Visor's scan (when the site has Visor) names pages that are not linked from the menu; otherwise links and the sitemap. */
async function discoverRoutes(profile, checkout, baseUrl, { visorDir = null, signal } = {}) {
  const routes = new Set(['/']);
  const add = candidate => { try { const url = new URL(candidate, baseUrl); if (url.origin === new URL(baseUrl).origin && !/\.[a-z0-9]{2,5}$/i.test(url.pathname) || /\.html?$/.test(url.pathname)) routes.add(url.pathname.replace(/\/$/, '') || '/'); } catch { /* not a page */ } };
  let provider = 'links';
  if (profile.visor && visorDir) {
    const scan = path.join(visorDir, 'scripts', 'scan.mjs');
    if (fs.existsSync(scan)) {
      const node = nodeCommand();
      try {
        const result = await run(node.command, [scan], { cwd: checkout, signal, env: { ...node.env, ASTRO_CONTENT_EDITOR_ROOT: checkout }, timeoutMs: 60000, maxBytes: 16 * 1024 * 1024 });
        const entries = JSON.parse(result.output);
        const pages = new Map();
        for (const entry of Array.isArray(entries) ? entries : []) if (entry.slug) pages.set(`${entry.lang || 'und'}|${entry.slug}`, entry);
        const candidates = [...pages.values()].flatMap(entry => {
          const slug = entry.slug === 'home' ? '' : entry.slug;
          return entry.lang && entry.lang !== 'und' ? [`/${entry.lang}/${slug}`, `/${slug}`] : [`/${slug}`];
        });
        for (const candidate of candidates) {
          if (routes.size >= MAX_ROUTES * 2) break;
          const answer = await get(new URL(candidate, baseUrl).href, 5000);
          if (answer && answer.status === 200) add(candidate);
        }
        provider = 'visor';
      } catch { /* fall back to links */ }
    }
  }
  if (provider === 'links' || routes.size < 3) {
    const home = await get(baseUrl + '/');
    for (const match of home?.text.matchAll(/href=["'](\/[^"'#?\s]*)["']/g) || []) add(match[1]);
    const sitemap = await get(`${baseUrl}/sitemap.xml`);
    for (const match of sitemap?.text.matchAll(/<loc>([^<]+)<\/loc>/g) || []) add(match[1]);
  }
  return { routes: [...routes].slice(0, MAX_ROUTES), provider };
}

/** Which provider fits this project. `choice` is the user's setting: auto, visor, playwright or off. */
function chooseProvider(profile, choice = 'auto') {
  if (choice === 'off') return { id: 'none', reason: 'Visual checks are turned off for this loop.' };
  if (!fs.existsSync(SITE_SCRIPT)) return { id: 'none', reason: 'The visual test harness is not installed with this extension.' };
  if (profile.clanker && choice !== 'playwright') return { id: 'clanker' };
  if (profile.web) return { id: profile.visor && choice !== 'playwright' ? 'visor' : 'playwright' };
  if (profile.ios) return { id: 'none', reason: 'This is an iOS project; pages cannot be rendered here, so only code review and build checks run.' };
  return { id: 'none', reason: 'No web pages found in this project (no dev script and no index.html).' };
}

/**
 * Captures the pages and measures them. Resolves `{ok, provider, reason?, captureDir, report, routes, baselineDir}`.
 * `accept` stages this capture's pictures in `<captureDir>/next-baseline` for the caller to adopt.
 */
async function capture({ profile, checkout, directory, name = 'capture', signal, choice = 'auto', baselineDir, accept = true, visorDir = null, onActivity, server = null }) {
  const picked = chooseProvider(profile, choice);
  if (picked.id === 'none') return { ok: false, skipped: true, provider: 'none', reason: picked.reason };
  const captureDir = path.join(directory, name);
  fs.mkdirSync(baselineDir, { recursive: true });
  const node = nodeCommand();
  const finish = (report, extra = {}) => ({ ok: true, provider: picked.id, captureDir, report, baselineDir, ...extra });
  const readReport = () => { try { return JSON.parse(fs.readFileSync(path.join(captureDir, 'report.json'), 'utf8')); } catch { return null; } };
  if (picked.id === 'clanker') {
    const result = await run(node.command, ['ai-chat-panel/test/ui-tester/run.mjs', `--out=${captureDir}`, `--baseline=${baselineDir}`, ...(accept ? ['--accept'] : [])], { cwd: checkout, signal, env: node.env, timeoutMs: 15 * 60000, idleMs: 5 * 60000, onActivity });
    fs.writeFileSync(path.join(directory, `${name}.txt`), result.output + result.stderr);
    const report = readReport();
    return report ? finish(report, { routes: [] }) : { ok: false, provider: 'clanker', reason: `The interface tester produced no report: ${(result.stderr || result.output).trim().split('\n').slice(-2).join(' ').slice(0, 240)}` };
  }
  let live = server, started = false;
  try {
    if (!live) {
      started = true;
      live = profile.web.script ? await startDevServer(profile, checkout, signal) : await serveStatic(path.join(checkout, profile.web.static || '.'));
    }
    const { routes, provider } = await discoverRoutes(profile, checkout, live.url, { visorDir, signal });
    const result = await run(node.command, [SITE_SCRIPT, `--base=${live.url}`, `--routes=${routes.join(',')}`, `--out=${captureDir}`, `--baseline=${baselineDir}`, ...(accept ? ['--accept'] : [])],
      { cwd: EXTENSION_ROOT, signal, env: node.env, timeoutMs: 20 * 60000, idleMs: 5 * 60000, onActivity });
    fs.writeFileSync(path.join(directory, `${name}.txt`), result.output + result.stderr);
    const report = readReport();
    return report ? finish(report, { routes, routeSource: provider }) : { ok: false, provider: picked.id, reason: `The page tester produced no report: ${(result.stderr || result.output).trim().split('\n').slice(-2).join(' ').slice(0, 240)}` };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, provider: picked.id, reason: error.message.slice(0, 300) };
  } finally { if (started) await live?.stop?.(); }
}

module.exports = { capture, chooseProvider, startDevServer, serveStatic, discoverRoutes, SITE_SCRIPT, freePort };
