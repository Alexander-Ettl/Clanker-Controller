#!/usr/bin/env node
// Builds the Marketplace / Open VSX packages for the extensions. See docs/publishing.md.
//   node scripts/package-marketplace.mjs --publisher <id> [--target win32-x64] [--stage <dir>] [--only chat|usage|theme] [--store ovsx|marketplace]
//
// Why a staging copy: the repo keeps `publisher: "local"` so the installed dev junctions keep their extension ID
// and chat storage. The published build needs a real publisher, the shared voice-router/lib bundled in, and the
// root README with absolute image links. All of that is done in a copy, so the repo itself is never rewritten.
// The staging folder and the npm cache live outside the synced folders (C:\Dev by default).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

const publisher = opt('publisher', process.env.CLANKER_PUBLISHER);
if (!publisher || publisher === 'local') {
  console.error('Pass --publisher <your Marketplace publisher ID> (or set CLANKER_PUBLISHER).');
  process.exit(2);
}
const target = opt('target');
const only = opt('only');
const store = opt('store', 'ovsx');
if (store !== 'ovsx' && store !== 'marketplace') {
  console.error(`Unknown --store "${store}". Expected "ovsx" or "marketplace".`);
  process.exit(2);
}
const stage = path.resolve(opt('stage', process.platform === 'win32' ? 'C:/Dev/clanker-publish' : path.join(os.tmpdir(), 'clanker-publish')));
if (/[\\/](Nextcloud|OneDrive)[\\/]/i.test(stage)) {
  console.error(`Refusing to stage inside a synced folder: ${stage}`);
  process.exit(2);
}
const outDir = path.join(stage, 'out');

const REPO = 'Alexander-Ettl/Clanker-Controller';
const raw = (p) => `https://raw.githubusercontent.com/${REPO}/main/${p}`;
const blob = (p) => `https://github.com/${REPO}/${/\/$/.test(p) ? 'tree' : 'blob'}/main/${p}`;

// The Marketplace needs absolute https links. Relative ones in the root README are resolved against the repo root.
function absolutise(markdown) {
  const clean = (p) => p.replace(/^\.\//, '');
  return markdown
    .replace(/(src=")(?!https?:|data:|#)([^"]+)"/g, (_, a, p) => `${a}${raw(clean(p))}"`)
    .replace(/(!\[[^\]]*\]\()(?!https?:|data:|#)([^)\s]+)\)/g, (_, a, p) => `${a}${raw(clean(p))})`)
    .replace(/(?<!!)(\[[^\]]*\]\()(?!https?:|mailto:|#)([^)\s]+)\)/g, (_, a, p) => `${a}${blob(clean(p))})`);
}

const SKIP = new Set(['node_modules', '.git', 'out']);
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) && !src.endsWith('.vsix') });
}

const EXTENSIONS = [
  {
    key: 'chat', dir: 'ai-chat-panel',
    prepare(dest) {
      copyTree(path.join(root, 'voice-router', 'lib'), path.join(dest, 'voice-router', 'lib')); // lib/voice-capture.js prefers this copy
      fs.writeFileSync(path.join(dest, 'README.md'), absolutise(fs.readFileSync(path.join(root, 'README.md'), 'utf8')));
    },
  },
  // VS Code Marketplace already has an unrelated/retired listing under `antigravity-usage-statusbar`,
  // so the Marketplace package uses `clanker-usage-statusbar` while Open VSX and local dev keep the original ID.
  { key: 'usage', dir: 'antigravity-usage-statusbar', marketplaceName: 'clanker-usage-statusbar', prepare() {} },
  { key: 'theme', dir: 'clanker-theme', prepare() {} },
];

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const env = { ...process.env, npm_config_cache: process.env.npm_config_cache || path.join(path.dirname(stage), 'tools', 'npm-cache') };

fs.mkdirSync(outDir, { recursive: true });
for (const ext of EXTENSIONS) {
  if (only && only !== ext.key) continue;
  const dest = path.join(stage, ext.dir);
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(path.join(root, ext.dir), dest);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dest, 'LICENSE'));
  ext.prepare(dest);

  const manifestPath = path.join(dest, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.publisher = publisher;
  if (store === 'marketplace' && ext.marketplaceName) manifest.name = ext.marketplaceName;
  delete manifest.private; // vsce refuses to publish a private package
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const file = path.join(outDir, `${manifest.name}-${manifest.version}${target ? `-${target}` : ''}.vsix`);
  const cmd = ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '--allow-star-activation', '--out', file, ...(target ? ['--target', target] : [])];
  console.log(`\n== ${manifest.displayName} (${publisher}.${manifest.name}@${manifest.version})`);
  const r = spawnSync(npx, cmd, { cwd: dest, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`-> ${file}`);
}
