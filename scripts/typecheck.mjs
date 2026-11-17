// Type-checks the files that start with `// @ts-check` (TS-01 pilot). TypeScript is installed outside the synced folder:
//   npm.cmd install --prefix C:\Dev\tools\ts typescript@5 @types/node@22 @types/vscode@1.85
// Set TS_TOOLS to use another location. Prints a hint and exits 0 when it is not installed, so a fresh checkout still passes `check`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = process.env.TS_TOOLS || 'C:/Dev/tools/ts';
const tsc = path.join(tools, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tsc)) {
  console.log(`typecheck skipped: TypeScript is not installed at ${tools} (see the header of scripts/typecheck.mjs).`);
  process.exit(0);
}
const run = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
process.exit(run.status ?? 1);
