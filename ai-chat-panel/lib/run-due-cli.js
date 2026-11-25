'use strict';

// `node ~/.clanker/clanker-run-due.js` : runs the scheduled turns that are due and exits. The editor writes the launcher
// and the settings it needs (lib/headless-runner.js publishSettings); a timer from lib/runner-service.js calls it every
// few minutes. With the editor open it does nothing, so a timer left installed is harmless.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDue, readSettings, publishSettings } = require('./headless-runner.js');

const homeDir = () => process.env.CLANKER_HOME || path.join(os.homedir(), '.clanker');
const LAUNCHER = 'clanker-run-due.js';

/** The editor calls this: a fixed-path launcher that survives folder moves and extension updates. */
function publishLauncher({ home = homeDir(), script = __filename } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const target = fs.realpathSync(script);
  const body = [
    '// Written by Clanker Controller; it rewrites this file at every start. Runs the scheduled prompts that are due, then exits.',
    "'use strict';",
    `const target = ${JSON.stringify(target)};`,
    'let cli;',
    "try { cli = require(target); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; console.error(`Clanker Controller is not at ${target} any more. Open the editor once so it rewrites this file.`); process.exit(3); }",
    'cli.main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });',
    '',
  ].join('\n');
  const file = path.join(home, LAUNCHER);
  try { if (fs.readFileSync(file, 'utf8') === body) return file; } catch { /* new file */ }
  fs.writeFileSync(file, body);
  return file;
}

async function main(argv = [], { out = (text) => console.log(text), err = (text) => console.error(text) } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { out('Usage: clanker-run-due.js [--max N] [--quiet]\nRuns scheduled Clanker prompts that are due while the editor is closed.'); return 0; }
  const settings = readSettings();
  if (!settings) { err('Clanker has not published its settings yet. Open the editor once, then try again.'); return 2; }
  require('./cli-telemetry.js').configureCliTelemetry(() => settings.cliTelemetry);
  const maxFlag = argv.indexOf('--max');
  const maxTasks = maxFlag >= 0 ? Math.max(1, Math.min(50, Number(argv[maxFlag + 1]) || 10)) : 10;
  const quiet = argv.includes('--quiet');
  // Loaded here, not at the top: `--help` and a missing set-up should not pull in the whole engine.
  const { readQuotas, recordClaudeUsage, claudeUsageAge } = require('./quota-bridge.js');
  const { probeClaudeUsage } = require('./claude-usage.js');
  const { notifyReply } = require('./notify.js');
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  const refreshUsage = async (cwd) => { if (claudeUsageAge() > 15 * 60 * 1000) recordClaudeUsage(await probeClaudeUsage(cwd).catch(() => null)); };
  const result = await runDue({
    settings, readQuotas, refreshUsage, maxTasks, signal: abort.signal,
    notify: (agent, text) => notifyReply({ toast: { agent, text, chatTitle: 'Scheduled task finished' }, appName: 'Clanker Controller', chime: false }),
    log: quiet ? () => {} : (line) => out(line),
  });
  if (!quiet || result.ran.length) out(result.skipped ? `Nothing run: ${result.skipped}.` : `Ran ${result.ran.length} scheduled turn${result.ran.length === 1 ? '' : 's'}${result.ran.length ? ` (${result.ran.map((item) => item.status).join(', ')})` : ''}.`);
  return result.ran.some((item) => item.status === 'failed') ? 1 : 0;
}

module.exports = { main, publishLauncher, publishSettings, LAUNCHER };
