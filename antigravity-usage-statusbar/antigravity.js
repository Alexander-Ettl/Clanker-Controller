'use strict';

const { execSync } = require('node:child_process');
const http = require('node:http');

let cachedConnection = null;
let discoveryInProgress = false;

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

function discoverLanguageServer() {
  try {
    const psScript =
      'Get-CimInstance Win32_Process -Filter "name like \'language_server%\'" | Select-Object ProcessId, CommandLine | ConvertTo-Json';
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const raw = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000,
    });

    if (!raw.trim()) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const procs = Array.isArray(parsed) ? parsed : [parsed];
    if (procs.length === 0) return null;

    // Prefer process started with --enable_lsp
    const targetProc =
      procs.find((p) => p.CommandLine && p.CommandLine.includes('--enable_lsp')) ||
      procs[0];

    if (!targetProc || !targetProc.CommandLine) return null;

    const csrfMatch = targetProc.CommandLine.match(/--csrf_token\s+([a-f0-9\-]+)/i);
    if (!csrfMatch) return null;
    const csrfToken = csrfMatch[1];
    const pid = String(targetProc.ProcessId);

    // Find listening TCP ports for this PID
    const netstatRaw = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2000,
    });

    const candidatePorts = [];
    for (const line of netstatRaw.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[parts.length - 1] === pid) {
        const state = parts[3].toLowerCase();
        // State is LISTENING (English) or ABHÖREN (German)
        if (state.includes('listen') || state.includes('ab')) {
          const addr = parts[1];
          const colonIdx = addr.lastIndexOf(':');
          if (colonIdx !== -1) {
            const port = parseInt(addr.slice(colonIdx + 1), 10);
            if (Number.isFinite(port) && !candidatePorts.includes(port)) {
              candidatePorts.push(port);
            }
          }
        }
      }
    }

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

  if (discoveryInProgress) return null;
  discoveryInProgress = true;
  try {
    const discovery = discoverLanguageServer();
    if (!discovery || discovery.candidatePorts.length === 0) return null;

    const connection = await probeAndConnect(discovery);
    if (!connection) return null;

    cachedConnection = {
      port: connection.port,
      csrfToken: connection.csrfToken,
      pid: connection.pid,
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
  fetchQuotaSummary,
  postConnectRpc,
};
