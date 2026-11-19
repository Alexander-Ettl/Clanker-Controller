#!/usr/bin/env node
// Renders the Clanker colour themes in a real VS Code window and saves a PNG per theme.
//   node scripts/theme-shots.mjs [--out=C:/Dev/scratch/theme-shots] [--only=paper|ink] [--code=<path to Code.exe>] [--cli=<its code.cmd>] [--demo=<profile dir>]
// For Antigravity IDE: --code="%LOCALAPPDATA%/Programs/Antigravity IDE/_/Antigravity IDE.exe" --cli="%LOCALAPPDATA%/Programs/Antigravity IDE/_/bin/antigravity-ide.cmd" --demo=C:/Dev/theme-demo-ag
// It starts a separate VS Code with its own user-data and extensions folders under C:\Dev\theme-demo, loads clanker-theme from this repo
// as a development extension, and reads the window through the Chromium debugging port. Your own VS Code settings are not touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = path.resolve(flag('out', 'C:/Dev/scratch/theme-shots'));
const only = flag('only', null);
const code = flag('code', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'));
const demo = flag('demo', 'C:/Dev/theme-demo');
const PORT = 9333;
const THEMES = [{ id: 'paper', label: 'Clanker Paper' }, { id: 'ink', label: 'Clanker Ink' }];

if (!fs.existsSync(code)) { console.error(`VS Code not found at ${code}. Pass --code=<path>.`); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const settingsPath = path.join(demo, 'user', 'User', 'settings.json');

// Build and install the real package, so what is rendered is what a user gets.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_|VSCODE_|ATOM_SHELL_INTERNAL)/i.test(k)));
const built = spawnSync('node', [`"${path.join(root, 'scripts', 'package-marketplace.mjs')}"`, '--publisher', 'clanker-controller', '--only', 'theme'], { stdio: 'inherit', shell: true });
if (built.status !== 0) process.exit(built.status || 1);
const vsix = 'C:/Dev/clanker-publish/out/clanker-theme-' + JSON.parse(fs.readFileSync(path.join(root, 'clanker-theme', 'package.json'), 'utf8')).version + '.vsix';
const cli = flag('cli', path.join(path.dirname(code), 'bin', 'code.cmd'));
const installed = spawnSync(`"${cli}"`, [`--user-data-dir=${demo}/user`, `--extensions-dir=${demo}/ext`, '--install-extension', `"${vsix}"`, '--force'], { stdio: 'inherit', shell: true, env: cleanEnv });
if (installed.status !== 0) process.exit(installed.status || 1);

for (const theme of THEMES.filter(t => !only || t.id === only)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings['workbench.colorTheme'] = theme.label;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // This script may run from inside an Electron IDE, whose ELECTRON_RUN_AS_NODE and VSCODE_* variables would turn the new VS Code into a
  // Node process or attach it to the parent window. Start it with a clean environment.
  const env = cleanEnv;
  const child = spawn(code, [
    `--user-data-dir=${demo}/user`, `--extensions-dir=${demo}/ext`,     `--remote-debugging-port=${PORT}`, '--disable-gpu-sandbox', '--force-device-scale-factor=2', '--skip-welcome', '--skip-release-notes', '--disable-telemetry',
    `${demo}/ws`, `${demo}/ws/README.md`, `${demo}/ws/retry.ts`,
  ], { stdio: 'ignore', detached: false, env });
  let browser;
  try {
    for (let i = 0; i < 60 && !browser; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { /* not up yet */ }
    }
    if (!browser) throw new Error('VS Code did not open its debugging port');
    let page;
    for (let i = 0; i < 40 && !page; i++) {
      page = browser.contexts().flatMap(c => c.pages()).find(p => /workbench/.test(p.url()));
      if (!page) await new Promise(r => setTimeout(r, 500));
    }
    if (!page) throw new Error('no workbench window');
    // Lay the workbench out at 1400x900 at twice the pixel density, whatever the real window is.
    await (await page.context().newCDPSession(page)).send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    await page.waitForSelector('.monaco-editor .mtk1, .monaco-editor [class*="mtk"]', { timeout: 30000 });
    await page.waitForTimeout(3000); // extension host, so the development theme is registered
    // Pick the theme the way a user does. The setting alone can lose the race with the extension scan on a fresh profile.
    await page.keyboard.press('Control+K'); await page.keyboard.press('Control+T');
    await page.waitForSelector('.quick-input-widget:not([style*="display: none"]) .monaco-list-row', { timeout: 15000 });
    await page.keyboard.type(theme.label);
    await page.waitForTimeout(700);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500); // retheme, semantic tokens, minimap
    await page.locator('.tab', { hasText: 'retry.ts' }).first().click();
    await page.waitForTimeout(2500); // semantic tokens for the TypeScript file
    await page.locator('.monaco-editor').first().click({ position: { x: 700, y: 700 } }); // out of the way, so no hover or focus ring is captured
    await page.mouse.move(1000, 850);
    await page.waitForTimeout(800);
    const file = path.join(out, `theme-${theme.id}.png`);
    await page.screenshot({ path: file, scale: 'device' });
    console.log('wrote', file);
  } finally {
    try { await browser?.close(); } catch { /* closing a window we are about to kill */ }
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 2500));
  }
}
