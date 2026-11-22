'use strict';

// Antigravity's own language server knows the Gemini quota. Find its process, its CSRF token and its
// listening port, then ask it over Connect RPC. Ported from the retired usage status-bar extension.

const { execFile } = require('node:child_process');
const http = require('node:http');
const { discoverLinux } = require('./process-scan');

const QUOTA_RPC = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
// Discovery shells out (PowerShell + netstat), so a miss (Antigravity closed) is not retried on every poll.
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
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(postData);
    req.end();
  });
}

/**
 * The process that serves the quota RPC, from the candidates PowerShell listed: the classic `language_server*` (token as
 * `--csrf_token <value>`) or the newer `agy.exe --hub --hub-port=<port> --csrf_token=<value>`. Other agy.exe processes
 * (CLI sessions) carry no token and are skipped.
 */
function pickLanguageServer(procs) {
  const withToken = (procs || []).filter((p) => p?.CommandLine && /--csrf_token[=\s]+[a-f0-9-]+/i.test(p.CommandLine));
  const target = withToken.find((p) => p.CommandLine.includes('--enable_lsp')) || withToken.find((p) => p.CommandLine.includes('--hub')) || withToken[0];
  if (!target) return null;
  const hubPort = Number(target.CommandLine.match(/--hub-port[=\s]+(\d+)/i)?.[1]);
  return {
    pid: String(target.ProcessId),
    csrfToken: target.CommandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i)[1],
    hubPort: Number.isFinite(hubPort) ? hubPort : null,
  };
}

async function discoverLanguageServer() {
  if (process.platform !== 'win32' && process.platform !== 'linux') return null;
  try {
    const psScript = [
      '$procs = @(Get-CimInstance Win32_Process -Filter "name like \'language_server%\' or name = \'agy.exe\'" | Where-Object { $_.CommandLine -match \'csrf_token\' } | Select-Object ProcessId, CommandLine)',
      '$pids = @($procs | ForEach-Object { [int]$_.ProcessId })',
      // netstat, not Get-NetTCPConnection: that cmdlet loads a module and took over a second on its own, which with PowerShell's startup ran past the timeout.
      '$ports = @(netstat -ano -p tcp | ForEach-Object {',
      '  $parts = $_.Trim() -split "\\s+"',
      '  if ($parts.Length -ge 5 -and $pids -contains [int]$parts[-1] -and ($parts[3] -match "LISTENING|ABH")) {',
      '    [int]($parts[1] -split ":")[-1]',
      '  }',
      '})',
      'ConvertTo-Json @{ procs = $procs; ports = $ports }',
    ].join('\n');
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const stdout = process.platform === 'linux' ? JSON.stringify(await discoverLinux()) : await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { encoding: 'utf8', windowsHide: true, timeout: 12000 },
        (err, out) => resolve(err ? '' : (out || '')),
      );
    });
    if (!stdout.trim()) return null;
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { return null; }
    const rawProcs = parsed.procs ? (Array.isArray(parsed.procs) ? parsed.procs : [parsed.procs]) : [];
    const server = pickLanguageServer(rawProcs);
    if (!server) return null;
    const rawPorts = parsed.ports ? (Array.isArray(parsed.ports) ? parsed.ports : [parsed.ports]) : [];
    // The hub port first: it is the one that answers; the other listeners can be HTTPS-only.
    const candidatePorts = [...new Set([server.hubPort, ...rawPorts].map(Number).filter((port) => Number.isFinite(port) && port > 0))];
    return { pid: server.pid, csrfToken: server.csrfToken, candidatePorts };
  } catch {
    return null;
  }
}

async function probeAndConnect({ candidatePorts, csrfToken, pid }) {
  for (const port of candidatePorts) {
    try {
      const data = await postConnectRpc(port, QUOTA_RPC, csrfToken, '{}', 800);
      if (data && (data.response?.groups || data.groups)) return { port, csrfToken, pid, initialData: data };
    } catch {
      // Try the next port.
    }
  }
  return null;
}

async function fetchQuotaSummary() {
  if (cachedConnection) {
    try {
      const data = await postConnectRpc(cachedConnection.port, QUOTA_RPC, cachedConnection.csrfToken, '{}', 1500);
      return { data, port: cachedConnection.port, pid: cachedConnection.pid };
    } catch {
      cachedConnection = null;
    }
  }
  if (discoveryInProgress || Date.now() < nextDiscovery) return null;
  discoveryInProgress = true;
  try {
    const discovery = await discoverLanguageServer();
    const connection = discovery?.candidatePorts?.length ? await probeAndConnect(discovery) : null;
    if (!connection) { nextDiscovery = Date.now() + DISCOVERY_RETRY_MS; return null; }
    cachedConnection = { port: connection.port, csrfToken: connection.csrfToken, pid: connection.pid };
    return { data: connection.initialData, port: connection.port, pid: connection.pid };
  } finally {
    discoveryInProgress = false;
  }
}

/** Any other call on the same language server (GetAuthStatus, GetUserStatus ...); null when Antigravity is not running. */
async function callLanguageServer(rpc) {
  if (!cachedConnection) await fetchQuotaSummary();
  if (!cachedConnection) return null;
  try { return await postConnectRpc(cachedConnection.port, `/exa.language_server_pb.LanguageServerService/${rpc}`, cachedConnection.csrfToken, '{}', 2500); } catch { return null; }
}

module.exports = { fetchQuotaSummary, callLanguageServer, pickLanguageServer };
