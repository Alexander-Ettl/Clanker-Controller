'use strict';

// GitHub Copilot's monthly allowance, read from the same endpoint VS Code's Copilot status uses
// (`GET /copilot_internal/user`, quota_snapshots). It is not a documented API, so everything here fails soft: no reading means the
// ring says "no live quota", never an error. The CLI keeps its own login in the system keychain, which cannot be read, so the
// request uses the GitHub CLI's token for the same account (or COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN). The token goes to
// api.github.com only, is never logged, and nothing is read unless the Copilot CLI is signed in on this machine.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ENDPOINT = 'https://api.github.com/copilot_internal/user';
const FRESH_MS = 10 * 60 * 1000; // the allowance moves per request, not per second: one read every ten minutes is plenty
const RETRY_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** The account the Copilot CLI is signed in as on github.com, or null. */
function copilotLogin(home = os.homedir()) {
  try {
    const text = fs.readFileSync(path.join(process.env.COPILOT_HOME || path.join(home, '.copilot'), 'config.json'), 'utf8');
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')); // the file starts with comment lines
    const user = config.lastLoggedInUser || (config.loggedInUsers || [])[0];
    return user && /^https:\/\/github\.com\/?$/.test(user.host || '') && user.login ? String(user.login) : null;
  } catch { return null; }
}

function ghToken(login) {
  const ask = (args) => new Promise((resolve) => {
    execFile('gh', args, { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
  });
  return ask(['auth', 'token', '--hostname', 'github.com', '--user', login]).then((token) => token || ask(['auth', 'token', '--hostname', 'github.com']));
}

async function findToken(login) {
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) if (process.env[name]) return process.env[name];
  return ghToken(login);
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const PLAN_NAMES = { free_limited_copilot: 'Copilot Free', individual: 'Copilot Pro', individual_pro: 'Copilot Pro+', business: 'Copilot Business', enterprise: 'Copilot Enterprise' };

/**
 * The ring uses the premium or chat allowance the account has. GitHub's token-based plans report both in AI credits.
 */
function parseCopilotUsage(reply, now = Date.now()) {
  const snapshots = reply?.quota_snapshots;
  if (!snapshots || typeof snapshots !== 'object') return null;
  const choices = [['premium_interactions', 'premium requests'], ['chat', 'chat messages']];
  for (const [id, what] of choices) {
    const quota = snapshots[id];
    const entitlement = num(quota?.entitlement);
    if (!quota || quota.unlimited || quota.has_quota === false || !(entitlement > 0)) continue;
    const left = num(quota.percent_remaining) ?? (num(quota.remaining) !== null ? (quota.remaining / entitlement) * 100 : null);
    if (left === null) continue;
    const remaining = Math.max(0, Math.min(100, Math.round(left)));
    const resetsAt = Date.parse(reply.quota_reset_date_utc || reply.quota_reset_date || '');
    const creditBilling = (quota.token_based_billing ?? reply.token_based_billing) === true;
    const used = (creditBilling ? num(quota.credits_used) : null) ?? (entitlement - (num(quota.remaining) ?? entitlement * left / 100));
    const start = new Date(now);
    const monthMinutes = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate() * 1440;
    return {
      used: 100 - remaining, remaining, windowMinutes: monthMinutes, windowLabel: 'month',
      resetsAt: Number.isFinite(resetsAt) ? Math.floor(resetsAt / 1000) : null,
      detail: { what: creditBilling ? 'AI credits' : what, plan: PLAN_NAMES[reply.access_type_sku] || PLAN_NAMES[reply.copilot_plan] || 'Copilot', entitlement, used: Math.max(0, used) },
    };
  }
  return null;
}

let cached = null; // { at, value }
let inflight = null;

/**
 * The Copilot window, or null. `fetchImpl`, `token` and `login` are for tests; a normal call needs none.
 * Results are cached for ten minutes (two after a failure), because the quota poll runs every few seconds.
 */
async function readCopilotUsage({ fetchImpl = globalThis.fetch, token, login = copilotLogin(), now = Date.now() } = {}) {
  if (!login || !fetchImpl) return null;
  if (cached && now - cached.at < (cached.value ? FRESH_MS : RETRY_MS) && cached.login === login) return cached.value;
  inflight ||= (async () => {
    let value = null;
    try {
      const secret = token || await findToken(login);
      if (secret) {
        const response = await fetchImpl(ENDPOINT, {
          headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', 'User-Agent': 'ClankerController' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.ok) value = parseCopilotUsage(await response.json(), now);
      }
    } catch { /* offline, signed out, endpoint changed: no reading */ }
    cached = { at: now, value, login };
    return value;
  })().finally(() => { inflight = null; });
  return inflight;
}

const resetCopilotUsageCache = () => { cached = null; inflight = null; };

module.exports = { readCopilotUsage, parseCopilotUsage, copilotLogin, resetCopilotUsageCache };
