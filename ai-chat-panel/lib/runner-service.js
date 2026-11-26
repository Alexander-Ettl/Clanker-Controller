'use strict';

// Opt-in: the timer that calls the headless runner every few minutes (systemd --user on Linux, Task Scheduler on Windows).
// Nothing here runs unless the user picks "Set up the headless runner"; remove() takes it all out again.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NAME = 'clanker-run-due';
const TASK = 'Clanker Run Due';
const EVERY_MINUTES = 5;

/** `node` on PATH, or the editor's own executable run as node (what an editor-only machine has). */
function nodeCommand({ env = process.env, execPath = process.execPath, exists = fs.existsSync, platform = process.platform } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of String(env.PATH || env.Path || '').split(api.delimiter).filter(Boolean)) {
    for (const name of names) { const file = api.join(dir, name); if (exists(file)) return { command: file, env: {} }; }
  }
  return { command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function systemdUnits({ command, args, env = {} }) {
  const quote = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const service = [
    '[Unit]', 'Description=Run Clanker Controller prompts that are due (editor closed)', '',
    '[Service]', 'Type=oneshot',
    ...Object.entries(env).map(([key, value]) => `Environment=${key}=${value}`),
    `ExecStart=${[command, ...args].map(quote).join(' ')}`, 'Nice=10', '',
  ].join('\n');
  const timer = [
    '[Unit]', 'Description=Check for Clanker Controller prompts that are due', '',
    '[Timer]', 'OnBootSec=2min', `OnUnitActiveSec=${EVERY_MINUTES}min`, 'Persistent=true', '',
    '[Install]', 'WantedBy=timers.target', '',
  ].join('\n');
  return { service, timer };
}

function unitDir(home = os.homedir()) { return path.join(home, '.config', 'systemd', 'user'); }

/**
 * @returns {{ ok: boolean, message: string }}
 */
function install({ launcher, platform = process.platform, home = os.homedir(), run = (file, args) => execFileSync(file, args, { stdio: 'pipe' }), node = nodeCommand() } = {}) {
  const args = [launcher, '--quiet'];
  try {
    if (platform === 'linux') {
      const { service, timer } = systemdUnits({ command: node.command, args, env: node.env });
      fs.mkdirSync(unitDir(home), { recursive: true });
      fs.writeFileSync(path.join(unitDir(home), `${NAME}.service`), service);
      fs.writeFileSync(path.join(unitDir(home), `${NAME}.timer`), timer);
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', `${NAME}.timer`]);
      return { ok: true, message: `Installed ${NAME}.timer (systemd --user), every ${EVERY_MINUTES} minutes. Remove it from the same menu.` };
    }
    if (platform === 'win32') {
      const quoted = [node.command, ...args].map((part) => `"${part}"`).join(' ');
      run('schtasks.exe', ['/Create', '/F', '/SC', 'MINUTE', '/MO', String(EVERY_MINUTES), '/TN', TASK, '/TR', quoted]);
      return { ok: true, message: `Created the "${TASK}" task in Task Scheduler, every ${EVERY_MINUTES} minutes. Remove it from the same menu.` };
    }
    return { ok: false, message: 'Setting up the runner is supported on Linux (systemd) and Windows (Task Scheduler).' };
  } catch (error) {
    return { ok: false, message: `Could not set up the runner: ${String(error.stderr || error.message).trim().slice(0, 300)}` };
  }
}

function remove({ platform = process.platform, home = os.homedir(), run = (file, args) => execFileSync(file, args, { stdio: 'pipe' }) } = {}) {
  try {
    if (platform === 'linux') {
      try { run('systemctl', ['--user', 'disable', '--now', `${NAME}.timer`]); } catch { /* not installed */ }
      for (const ext of ['service', 'timer']) fs.rmSync(path.join(unitDir(home), `${NAME}.${ext}`), { force: true });
      try { run('systemctl', ['--user', 'daemon-reload']); } catch { /* nothing to reload */ }
    } else if (platform === 'win32') {
      try { run('schtasks.exe', ['/Delete', '/F', '/TN', TASK]); } catch { /* not installed */ }
    }
    return { ok: true, message: 'The headless runner is removed. Scheduled prompts run only while the editor is open again.' };
  } catch (error) { return { ok: false, message: `Could not remove it: ${error.message}` }; }
}

function installed({ platform = process.platform, home = os.homedir() } = {}) {
  return platform === 'linux' ? fs.existsSync(path.join(unitDir(home), `${NAME}.timer`)) : false;
}

module.exports = { install, remove, installed, systemdUnits, nodeCommand, EVERY_MINUTES };
