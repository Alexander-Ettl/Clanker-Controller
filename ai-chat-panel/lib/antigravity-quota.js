'use strict';

// Antigravity's own language server knows the Gemini quota. Find its process, its CSRF token and its
// listening port, then ask it over Connect RPC. Ported from the retired usage status-bar extension.

const { execSync } = require('node:child_process');
const http = require('node:http');

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

function discoverLanguageServer() {
  try {
    const psScript =
      'Get-CimInstance Win32_Process -Filter "name like \'language_server%\'" | Select-Object ProcessId, CommandLine | ConvertTo-Json';
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const raw = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    const procs = Array.isArray(parsed) ? parsed : [parsed];
    // Prefer the process started with --enable_lsp.
    const target = procs.find((p) => p.CommandLine?.includes('--enable_lsp')) || procs[0];
    if (!target?.CommandLine) return null;
    const csrfMatch = target.CommandLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
    if (!csrfMatch) return null;
    const pid = String(target.ProcessId);

    const netstat = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 });
    const candidatePorts = [];
    for (const line of netstat.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[parts.length - 1] !== pid) continue;
      // LISTENING (English) or ABHÖREN (German).
      const state = parts[3].toLowerCase();
      if (!state.includes('listen') && !state.includes('ab')) continue;
      const port = parseInt(parts[1].slice(parts[1].lastIndexOf(':') + 1), 10);
      if (Number.isFinite(port) && !candidatePorts.includes(port)) candidatePorts.push(port);
    }
    return { pid, csrfToken: csrfMatch[1], candidatePorts };
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
    const discovery = discoverLanguageServer();
    const connection = discovery?.candidatePorts.length ? await probeAndConnect(discovery) : null;
    if (!connection) { nextDiscovery = Date.now() + DISCOVERY_RETRY_MS; return null; }
    cachedConnection = { port: connection.port, csrfToken: connection.csrfToken, pid: connection.pid };
    return { data: connection.initialData, port: connection.port, pid: connection.pid };
  } finally {
    discoveryInProgress = false;
  }
}

module.exports = { fetchQuotaSummary };
