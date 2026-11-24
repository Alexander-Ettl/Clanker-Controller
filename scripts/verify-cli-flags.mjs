#!/usr/bin/env node
// Checks that every flag Clanker passes to a CLI still appears in that CLI's own --help (ai-chat-panel/test/fixtures/provider-flags.json).
//   node scripts/verify-cli-flags.mjs [claude|codex|agy ...] [--bin claude=/path/to/claude] [--json]
// Only runs `--version` and `--help`: no prompt is ever sent, so it is safe to run anywhere. A CLI that is not installed is reported
// as skipped, not as a pass. Exit code 1 when a flag is missing, 0 otherwise. A weekly CI job (.github/workflows/cli-drift.yml)
// runs it against the latest public CLI releases; it cannot sign in, so it says nothing about whether a turn still works.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ai-chat-panel', 'test', 'fixtures', 'provider-flags.json'), 'utf8'));
delete manifest['//'];
const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const binOverrides = Object.fromEntries(args.flatMap((arg, i) => (arg === '--bin' && args[i + 1]?.includes('=') ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
const picked = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--bin');
const names = picked.length ? picked : Object.keys(manifest);

const win = process.platform === 'win32';
const run = (bin, argv) => spawnSync(bin, argv, { encoding: 'utf8', timeout: 30000, shell: win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
function locate(name) {
  if (binOverrides[name]) return binOverrides[name];
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
  for (const dir of dirs) for (const ext of win ? ['.cmd', '.exe', ''] : ['']) if (dir && fs.existsSync(path.join(dir, name + ext))) return path.join(dir, name + ext);
  return null;
}
// "-p, --print" and "--print <value>" both count; a flag is matched as a whole word so "--model" is not satisfied by "--model-x".
const hasFlag = (text, flag) => new RegExp(`(^|[\\s,\\[|(])${flag.replace(/[-]/g, '\\-')}(?![\\w-])`, 'm').test(text);

const results = [];
for (const name of names) {
  const spec = manifest[name];
  if (!spec) { console.error(`Unknown CLI "${name}". Known: ${Object.keys(manifest).join(', ')}`); process.exit(2); }
  const bin = locate(name);
  if (!bin) { results.push({ cli: name, status: 'skipped', reason: 'not installed' }); continue; }
  const version = (run(bin, ['--version']).stdout || '').trim().split('\n')[0];
  let help = '';
  for (const argv of spec.help) { const out = run(bin, argv); help += `\n${out.stdout}\n${out.stderr}`; }
  if (!help.trim()) { results.push({ cli: name, version, status: 'error', reason: 'its --help printed nothing' }); continue; }
  const missing = spec.flags.filter((flag) => !hasFlag(help, flag));
  results.push({ cli: name, version, status: missing.length ? 'drift' : 'ok', checked: spec.flags.length, missing });
}

if (wantJson) console.log(JSON.stringify(results, null, 2));
else for (const r of results) {
  if (r.status === 'ok') console.log(`ok       ${r.cli} ${r.version}: all ${r.checked} flags are still in --help`);
  else if (r.status === 'drift') console.log(`DRIFT    ${r.cli} ${r.version}: --help no longer lists ${r.missing.join(', ')}`);
  else if (r.status === 'skipped') console.log(`skipped  ${r.cli}: ${r.reason}`);
  else console.log(`ERROR    ${r.cli} ${r.version || ''}: ${r.reason}`);
}
process.exit(results.some((r) => r.status === 'drift' || r.status === 'error') ? 1 : 0);
