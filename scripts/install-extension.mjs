#!/usr/bin/env node
// Cross-platform installer for Clanker Controller (VS Code and Antigravity). No PowerShell needed.
//   node scripts/install-extension.mjs [vscode|antigravity|all] [--link] [--vsix-only] [--dir <extensionsDir>]
// Default: build a .vsix, install it with the editor CLI if found, otherwise copy into the extensions folder.
// --link: symlink/junction the source folder instead (live development).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'ai-chat-panel');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
const extId = `${manifest.publisher}.${manifest.name}`;
const folder = `${extId}-${manifest.version}`;
const home = os.homedir();
const win = process.platform === 'win32';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const dirIdx = args.indexOf('--dir');
const dirOverride = dirIdx >= 0 ? args[dirIdx + 1] : null;
const pos = args.filter((a, i) => !a.startsWith('--') && (dirIdx < 0 || i !== dirIdx + 1));
const which = pos[0] || 'all';

const TARGETS = {
  vscode: { label: 'VS Code', cli: ['code', 'code-insiders'], dirs: [path.join(home, '.vscode', 'extensions')] },
  antigravity: {
    label: 'Antigravity',
    cli: ['antigravity', 'antigravity-ide'],
    dirs: [path.join(home, '.antigravity', 'extensions'), path.join(home, '.antigravity-ide', 'extensions')],
  },
};

const IGNORE = new Set(['node_modules', 'test', '.vscode', '.git', 'install-into-antigravity.ps1', 'install-into-antigravity.sh']);
const skip = (name) => IGNORE.has(name) || name.endsWith('.vsix');

// voice-router/lib is shared with the extension (lib/voice-capture.js); bundle it so installed copies are self-contained.
function collect() {
  const own = walk(src).map((rel) => ({ rel, abs: path.join(src, rel) }));
  const sharedDir = path.join(root, 'voice-router', 'lib');
  const shared = walk(sharedDir).map((rel) => ({ rel: `voice-router/lib/${rel}`, abs: path.join(sharedDir, rel) }));
  return [...own, ...shared, { rel: 'LICENSE', abs: path.join(root, 'LICENSE') }];
}

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function buildVsix() {
  const entries = collect().map((f) => ({ name: `extension/${f.rel}`, data: fs.readFileSync(f.abs) }));
  entries.unshift(
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/>' +
          '<Default Extension=".js" ContentType="application/javascript"/><Default Extension=".svg" ContentType="image/svg+xml"/>' +
          '<Default Extension=".md" ContentType="text/markdown"/><Default Extension=".css" ContentType="text/css"/>' +
          '<Default Extension=".html" ContentType="text/html"/><Default Extension=".png" ContentType="image/png"/>' +
          '<Default Extension=".mjs" ContentType="application/javascript"/><Default Extension=".cjs" ContentType="application/javascript"/>' +
          '<Default Extension=".txt" ContentType="text/plain"/><Default Extension="" ContentType="application/octet-stream"/></Types>'
      ),
    },
    {
      name: 'extension.vsixmanifest',
      data: Buffer.from(
        '<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">' +
          `<Metadata><Identity Language="en-US" Id="${esc(manifest.name)}" Version="${esc(manifest.version)}" Publisher="${esc(manifest.publisher)}"/>` +
          `<DisplayName>${esc(manifest.displayName || manifest.name)}</DisplayName><Description xml:space="preserve">${esc(manifest.description || '')}</Description>` +
          `<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(manifest.engines?.vscode || '*')}"/></Properties></Metadata>` +
          '<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>' +
          '<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>'
      ),
    }
  );
  const outDir = path.join(root, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${manifest.name}-${manifest.version}.vsix`);
  fs.writeFileSync(file, zip(entries));
  return file;
}

function findCli(names) {
  for (const n of names) {
    const r = spawnSync(n, ['--version'], { shell: win, encoding: 'utf8' });
    if (r.status === 0) return n;
  }
  return null;
}

function registerExtension(extDir) {
  const reg = path.join(extDir, 'extensions.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(reg, 'utf8')); } catch {}
  if (!Array.isArray(list)) list = [];
  list = list.filter((e) => e?.identifier?.id !== extId);
  const loc = path.join(extDir, folder).replace(/\\/g, '/');
  list.push({
    identifier: { id: extId },
    version: manifest.version,
    location: { $mid: 1, path: loc.startsWith('/') ? loc : `/${loc}`, scheme: 'file' },
    relativeLocation: folder,
  });
  fs.writeFileSync(reg, JSON.stringify(list), 'utf8'); // no BOM
}

function removeOld(extDir, keepDest = null) {
  if (!fs.existsSync(extDir)) return;
  for (const n of fs.readdirSync(extDir)) {
    if (/\.bak/i.test(n)) continue;
    const full = path.join(extDir, n);
    if (keepDest && full === keepDest) continue;
    if (n === folder || n.startsWith(`${extId}-`)) fs.rmSync(full, { recursive: true, force: true });
  }
}

function isLinkedToSrc(dest) {
  try {
    return fs.lstatSync(dest).isSymbolicLink() && path.resolve(fs.realpathSync(dest)) === path.resolve(fs.realpathSync(src));
  } catch {
    return false;
  }
}

function installDirect(extDir, link) {
  fs.mkdirSync(extDir, { recursive: true });
  const dest = path.join(extDir, folder);
  if (link && isLinkedToSrc(dest)) {
    removeOld(extDir, dest);
    registerExtension(extDir);
    console.log(`  Linked (existing) -> ${dest}`);
    return;
  }
  removeOld(extDir);
  if (link) {
    fs.symlinkSync(src, dest, win ? 'junction' : 'dir');
  } else {
    for (const f of collect()) {
      const to = path.join(dest, f.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f.abs, to);
    }
  }
  registerExtension(extDir);
  console.log(`  ${link ? 'Linked' : 'Copied'} -> ${dest}`);
}

const vsix = buildVsix();
console.log(`Built ${path.relative(root, vsix)}`);
if (flag('--vsix-only')) process.exit(0);

const picks = which === 'all' ? Object.keys(TARGETS) : [which];
if (picks.some((p) => !TARGETS[p])) {
  console.error(`Unknown target "${which}". Use vscode, antigravity or all.`);
  process.exit(1);
}

let installed = 0;
for (const key of picks) {
  const t = TARGETS[key];
  const cli = dirOverride || flag('--link') ? null : findCli(t.cli);
  const existingDir = t.dirs.find((d) => fs.existsSync(d));
  if (!cli && !existingDir && !dirOverride && which === 'all') {
    console.log(`${t.label}: not found, skipping.`);
    continue;
  }
  console.log(`${t.label}:`);
  if (cli) {
    const r = spawnSync(cli, ['--install-extension', vsix, '--force'], { shell: win, stdio: 'inherit' });
    if (r.status === 0) { installed++; continue; }
    console.log('  CLI install failed, falling back to a direct copy.');
  }
  installDirect(dirOverride ? path.resolve(dirOverride) : existingDir || t.dirs[0], flag('--link'));
  installed++;
}
if (!installed) { console.error('No editor found. Pass a target (vscode|antigravity) or --dir.'); process.exit(1); }
console.log('Done. Run "Developer: Reload Window" in the editor to activate.');
