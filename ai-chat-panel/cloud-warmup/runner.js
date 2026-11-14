'use strict';

// A personal Cloud Run Job; no listening server and no project files. CLI output is never written to cloud logs.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { plan, due, credential, SUPPORTED, HOUR } = require('../lib/cloud-warmup-plan');

async function request(url, options = {}, fetchImpl = fetch) {
  const r = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) });
  if (!r.ok) { const e = Error(`Google request failed (${r.status})`); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
}

function bucketStore(bucket, getToken, fetchImpl = fetch) {
  return {
    async get(name) {
      const headers = { Authorization: `Bearer ${await getToken()}` };
      // Media and generation come from the same response; a concurrent rotation cannot turn a two-step read into a false 404.
      // XML API object GET documents the generation response header; the object body is our stored JSON.
      const url = `https://storage.googleapis.com/${encodeURIComponent(bucket)}/${name.split('/').map(encodeURIComponent).join('/')}`;
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return { value: null, generation: '0' };
      if (!r.ok) { const e = Error(`Google request failed (${r.status})`); e.status = r.status; throw e; }
      const generation = r.headers.get('x-goog-generation');
      if (!generation) throw Error('Google Storage did not return an object generation.');
      return { value: await r.json(), generation };
    },
    async put(name, value, generation) {
      const query = new URLSearchParams({ uploadType: 'media', name, ...(generation == null ? {} : { ifGenerationMatch: generation }) });
      return request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }, fetchImpl);
    },
  };
}

function invoke(agent, entry, home, auth, spawnChild = spawn) {
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (agent === 'claude') env.CLAUDE_CODE_OAUTH_TOKEN = auth;
  const args = agent === 'claude'
    ? ['-p', '--model', entry.model, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--system-prompt', 'Reply with only 1.', '--max-turns', '1']
    // Cloud Run cannot offer Codex's kernel sandbox. Disable command execution/search in the disposable, project-free container.
    : ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"', '-c', `model_reasoning_effort="${entry.effort || 'low'}"`, '-c', 'cli_auth_credentials_store="file"', '--model', entry.model, '-'];
  return new Promise(resolve => {
    let output = '', overflow = false;
    const child = spawnChild(agent === 'claude' ? 'claude' : 'codex', args, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdin.on('error', () => {}); child.stdin.end('respond with 1\n');
    const collect = chunk => { if (output.length + chunk.length > 262144) { overflow = true; child.kill('SIGKILL'); } else output += chunk; };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      const events = output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const complete = agent === 'claude'
        ? events.some(e => e.type === 'result' && !e.is_error && typeof e.result === 'string' && e.result.trim())
        : events.some(e => e.type === 'turn.completed') && events.some(e => e.type === 'item.completed' && e.item?.type === 'agent_message' && String(e.item.text || '').trim());
      const failed = events.some(e => e.is_error || ['turn.failed', 'error'].includes(e.type));
      const authError = /unauthorized|invalid_grant|refresh.token|token.{0,20}expired|not.logged.in|authentication.{0,20}(?:failed|required)|login.required|please.{0,20}(?:log.?in|sign.?in)|credentials.{0,20}(?:invalid|expired)|401/i.test(output);
      const limited = /rate.limit|usage.limit|429|limit.reached/i.test(output);
      resolve({ status: code === 0 && complete && !failed && !overflow ? 'done' : authError ? 'reconnect' : limited ? 'limited' : 'failed' });
    });
  });
}

async function execute({ store, now = () => Date.now(), invokeCli = invoke }) {
  const cfg = (await store.get('config.json')).value;
  if (!cfg?.enabled || !Number.isFinite(cfg.expiresAt) || cfg.expiresAt < now()) return;
  const schedule = plan(cfg.schedule), slot = due(schedule, now());
  if (!slot) return;
  // Generation preconditions make a durable reservation before any request. Retries/duplicate deliveries never resend it.
  const lease = await store.get('lease.json');
  if (lease.value?.until > now()) return;
  try { await store.put('lease.json', { until: now() + 10 * 60000 }, lease.generation); } catch (e) { if (e.status === 412) return; throw e; }
  try {
    for (const agent of SUPPORTED) {
      const entry = cfg.providers?.[agent];
      if (!entry?.model) continue;
      const record = await store.get(`state/${agent}.json`), previous = record.value || {};
      if (previous.slot === slot || previous.next > now() || previous.status === 'reconnect') continue;
      // Check the kill switch immediately before each CLI starts, including after a slow preceding provider.
      const live = (await store.get('config.json')).value;
      if (!live?.enabled || live.revision !== cfg.revision || live.expiresAt < now()) break;
      const at = now();
      await store.put(`state/${agent}.json`, { ...previous, slot, at, next: at + 5 * HOUR, status: 'starting' }, record.generation);
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'clanker-cloud-'));
      let status = { status: 'failed' };
      try {
        const secret = await store.get(`auth/${agent}.json`);
        let auth;
        try { auth = credential(agent, secret.value); } catch { status = { status: 'reconnect' }; continue; }
        if (agent === 'codex') { await fs.mkdir(path.join(home, '.codex')); await fs.writeFile(path.join(home, '.codex', 'auth.json'), JSON.stringify(auth), { mode: 0o600 }); }
        status = await invokeCli(agent, entry, home, auth);
        // Persist rotating tokens after every run, even a rate-limit response. Conditional write prevents a reconnect overwrite.
        if (agent === 'codex') {
          const updated = credential(agent, JSON.parse(await fs.readFile(path.join(home, '.codex', 'auth.json'), 'utf8')));
          try { await store.put(`auth/${agent}.json`, updated, secret.generation); } catch (e) { if (e.status !== 412) throw e; }
        }
      } catch { status = { status: 'failed' }; }
      finally {
        await fs.rm(home, { recursive: true, force: true });
        const latest = await store.get(`state/${agent}.json`);
        // An explicit reconnect resets state; don't overwrite that newer state with this older result.
        if (latest.value?.at === at) await store.put(`state/${agent}.json`, { ...latest.value, ...status }, latest.generation);
      }
    }
  } finally {
    const latest = await store.get('lease.json');
    await store.put('lease.json', { until: 0 }, latest.generation);
  }
}

if (require.main === module) {
  const getToken = async () => (await request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } })).access_token;
  execute({ store: bucketStore(process.env.CLANKER_BUCKET, getToken) }).catch(() => { console.error('Cloud warmup failed. Check permissions and the Clanker status panel.'); process.exitCode = 1; });
}
module.exports = { execute, bucketStore, invoke };
