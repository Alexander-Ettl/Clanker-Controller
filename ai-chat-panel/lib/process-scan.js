'use strict';

// Linux counterpart of the PowerShell discovery in antigravity.js / antigravity-quota.js: finds the Antigravity language
// server (or `agy --hub`) by the --csrf_token on its command line, and the TCP ports that process listens on.
// Returns the same shape the Windows script prints: { procs: [{ ProcessId, CommandLine }], ports: [number] }.

const fs = require('node:fs');
const { execFile } = require('node:child_process');

const SERVER_NAME = /^(language_server|agy$)/;

/** `ss -ltnpH` lines -> { pid: [port] }. The users:(("name",pid=12,fd=3)) column names the owner. */
function parseSsListeners(text) {
  const byPid = new Map();
  for (const line of String(text).split('\n')) {
    const local = /^\S+\s+\d+\s+\d+\s+(\S+)\s/.exec(line.trim());
    const port = Number(local?.[1].split(':').pop());
    if (!Number.isFinite(port) || port <= 0) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1]);
      byPid.set(pid, [...(byPid.get(pid) || []), port]);
    }
  }
  return byPid;
}

function defaultExec(file, args) {
  return new Promise((resolve) => execFile(file, args, { encoding: 'utf8', timeout: 4000 }, (error, out) => resolve(error ? '' : String(out || ''))));
}

/** Every process whose name looks like the server and whose command line carries a token, read from /proc. */
function readProcs({ readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const procs = [];
  let names = [];
  try { names = readdir('/proc'); } catch { return procs; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = String(readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      const base = (args[0] || '').split('/').pop();
      const commandLine = args.join(' ');
      if (SERVER_NAME.test(base) && /csrf_token/.test(commandLine)) procs.push({ ProcessId: Number(name), CommandLine: commandLine });
    } catch { /* the process ended, or belongs to someone else */ }
  }
  return procs;
}

async function discoverLinux({ exec = defaultExec, ...io } = {}) {
  const procs = readProcs(io);
  if (!procs.length) return { procs, ports: [] };
  const owned = parseSsListeners(await exec('ss', ['-ltnpH']));
  const ports = procs.flatMap((proc) => owned.get(proc.ProcessId) || []);
  return { procs, ports: [...new Set(ports)] };
}

module.exports = { discoverLinux, parseSsListeners, readProcs };
