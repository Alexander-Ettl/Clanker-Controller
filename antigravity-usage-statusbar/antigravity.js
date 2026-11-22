'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');

const SERVER_NAME = /^(language_server|agy$)/;

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

function readLinuxProcs({ readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
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
    } catch { /* process ended or owned by another user */ }
  }
  return procs;
}

async function discoverLinux({ exec, ...io } = {}) {
  const procs = readLinuxProcs(io);
  if (!procs.length) return { procs, ports: [] };
  const runSs = exec || ((file, args) => new Promise((resolve) => execFile(file, args, { encoding: 'utf8', timeout: 4000 }, (err, out) => resolve(err ? '' : String(out || '')))));
  const owned = parseSsListeners(await runSs('ss', ['-ltnpH']));
  const ports = procs.flatMap((proc) => owned.get(proc.ProcessId) || []);
  return { procs, ports: [...new Set(ports)] };
}

const DISCOVERY_RETRY_MS = 30_000;
let cachedConnection = null;
let discoveryInProgress = false;
let nextDiscovery = 0;

function postConnectRpc(port, path, csrfToken, postData = '{}', timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Codeium-Csrf-Token': csrfToken,
          'Connect-Protocol-Version': '1',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(postData);
    req.end();
  });
}

async function discoverLanguageServer() {
  if (process.platform !== 'win32' && process.platform !== 'linux') return null;
  try {
    const psScript = [
      '$procs = @(Get-CimInstance Win32_Process -Filter "name like \'language_server%\' or name = \'agy.exe\'" | Where-Object { $_.CommandLine -match \'csrf_token\' } | Select-Object ProcessId, CommandLine)',
      '$pids = @($procs | ForEach-Object { [int]$_.ProcessId })',
      '$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains [int]$_.OwningProcess } | Select-Object -ExpandProperty LocalPort)',
      'if (-not $ports -or $ports.Count -eq 0) {',
      '  $netstat = netstat -ano -p tcp',
      '  $ports = @($netstat | ForEach-Object {',
      '    $parts = $_.Trim() -split "\\s+"',
      '    if ($parts.Length -ge 5 -and $pids -contains [int]$parts[-1] -and ($parts[3] -match "LISTENING|ABH")) {',
      '      [int]($parts[1] -split ":")[-1]',
      '    }',
      '  })',
      '}',
      'ConvertTo-Json @{ procs = $procs; ports = $ports }',
    ].join('\n');
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const stdout = process.platform === 'linux' ? JSON.stringify(await discoverLinux()) : await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { encoding: 'utf8', windowsHide: true, timeout: 4000 },
        (err, out) => resolve(err ? '' : (out || '')),
      );
    });

    if (!stdout.trim()) return null;
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }

    const rawProcs = parsed.procs ? (Array.isArray(parsed.procs) ? parsed.procs : [parsed.procs]) : [];
    if (rawProcs.length === 0) return null;

    // The classic language_server* (`--csrf_token <value>`) or agy.exe --hub --hub-port=<port> --csrf_token=<value>.
    const withToken = rawProcs.filter((p) => p && p.CommandLine && /--csrf_token[=\s]+[a-f0-9-]+/i.test(p.CommandLine));
    const targetProc =
      withToken.find((p) => p.CommandLine.includes('--enable_lsp')) ||
      withToken.find((p) => p.CommandLine.includes('--hub')) ||
      withToken[0];

    if (!targetProc) return null;

    const csrfToken = targetProc.CommandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i)[1];
    const pid = String(targetProc.ProcessId);
    const hubPort = Number(targetProc.CommandLine.match(/--hub-port[=\s]+(\d+)/i)?.[1]);

    const rawPorts = parsed.ports ? (Array.isArray(parsed.ports) ? parsed.ports : [parsed.ports]) : [];
    // The hub port first: it is the one that answers; the other listeners can be HTTPS-only.
    const candidatePorts = [...new Set([hubPort, ...rawPorts].map(Number).filter((port) => Number.isFinite(port) && port > 0))];

    return { pid, csrfToken, candidatePorts };
  } catch {
    return null;
  }
}

async function probeAndConnect(discovery) {
  for (const port of discovery.candidatePorts) {
    try {
      const data = await postConnectRpc(
        port,
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
        discovery.csrfToken,
        '{}',
        800,
      );
      if (data && (data.response?.groups || data.groups)) {
        return {
          port,
          csrfToken: discovery.csrfToken,
          pid: discovery.pid,
          initialData: data,
        };
      }
    } catch {
      // Try next port candidate
    }
  }
  return null;
}

async function fetchQuotaSummary() {
  if (cachedConnection) {
    try {
      const data = await postConnectRpc(
        cachedConnection.port,
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
        cachedConnection.csrfToken,
        '{}',
        1500,
      );
      return { data, port: cachedConnection.port, pid: cachedConnection.pid };
    } catch {
      // Invalidate connection cache on failure
      cachedConnection = null;
    }
  }

  if (discoveryInProgress || Date.now() < nextDiscovery) return null;
  discoveryInProgress = true;
  try {
    const discovery = await discoverLanguageServer();
    if (!discovery || !discovery.candidatePorts || discovery.candidatePorts.length === 0) {
      nextDiscovery = Date.now() + DISCOVERY_RETRY_MS;
      return null;
    }

    const connection = await probeAndConnect(discovery);
    if (!connection) {
      nextDiscovery = Date.now() + DISCOVERY_RETRY_MS;
      return null;
    }

    cachedConnection = {
      port: connection.port,
      csrfToken: connection.csrfToken,
      pid: connection.pid,
      initialData: connection.initialData,
    };

    return {
      data: connection.initialData,
      port: connection.port,
      pid: connection.pid,
    };
  } finally {
    discoveryInProgress = false;
  }
}

function clearCachedConnection() {
  cachedConnection = null;
}

module.exports = {
  clearCachedConnection,
  discoverLanguageServer,
  discoverLinux,
  fetchQuotaSummary,
  parseSsListeners,
  postConnectRpc,
  readLinuxProcs,
};
