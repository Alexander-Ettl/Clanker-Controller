'use strict';

// Antigravity's `agy` CLI (the "gemini" provider id: its models are Gemini). See lib/providers/index.js for the fields.

/** `agy models` prints `<id>\t<label>`; the effort is part of the id, so one entry each (normalized by the caller). */
function parseModels(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.split('\t')).filter((cols) => cols.length >= 2 && cols[0].trim())
    .map(([id, label], i) => ({ id: id.trim(), agent: 'gemini', model: id.trim(), effort: null, label: label.trim(), isDefault: i === 0 }));
}

// agy is not on npm. Its CLI checks this service itself; the landing page says "... Stable Version: 1.2.14. Rolled out to 100%".
// A changed response means an unknown latest version, never a false "Up to date".
const UPDATER = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';

/** A release still rolling out to a fraction of users is not "available" yet: `agy update` would say it is current. */
function parseLatest(text) {
  const version = /Stable Version:\s*(\d+\.\d+\.\d+)/i.exec(String(text))?.[1];
  const rollout = Number(/Rolled out to\s*(\d+)%/i.exec(String(text))?.[1]);
  return version && rollout === 100 ? version : null;
}

/**
 * agy has no status command, but Antigravity's language server (running whenever the IDE is) lists the account's tier and the
 * tiers each model is allowed for. An account whose tier unlocks none of them cannot use the CLI. null when fine, undefined when it cannot be told.
 */
async function entitlement({ languageServer }) {
  const user = (await languageServer?.('GetUserStatus'))?.userStatus;
  const tier = user?.planStatus?.planInfo?.teamsTier;
  const models = user?.cascadeModelConfigData?.clientModelConfigs;
  if (!tier || !Array.isArray(models) || !models.length) return undefined;
  if (models.some((model) => !model.allowedTiers?.length || model.allowedTiers.includes(tier))) return null;
  return { kind: 'plan', reason: 'No Antigravity models on this plan.', detail: `Account tier ${tier} is not allowed for any model. If your plan changed, sign in to Antigravity again, then press Try again.` };
}

module.exports = {
  id: 'gemini',
  name: 'Antigravity',
  accountName: 'Gemini / Antigravity',
  company: 'Google',
  color: '#0ea5e9',
  cli: 'agy',
  headlessApprovals: false, // run headless it cannot ask: in Ask and Auto mode it skips what would need an approval
  locate: ({ onPath, join, home, local }) => [onPath('agy'), join(local, 'agy', 'bin', 'agy.exe'), join(home, '.gemini', 'antigravity-ide', 'bin', 'agy.exe')].flat(),
  latestVersion: async (fetchImpl) => {
    const res = await fetchImpl(UPDATER, { signal: AbortSignal.timeout(8000) });
    return res.ok ? parseLatest(await res.text()) : null;
  },
  login: [],
  // agy has no separate auth-status command. A model-list response confirms CLI readiness, not account validity.
  authStatus: { args: ['models'], interpret: (result) => (result.ok && parseModels(result.stdout).length ? 'ready' : 'signin') },
  entitlement,
  install: 'Invoke-RestMethod https://antigravity.google/cli/install.ps1 | Invoke-Expression; & "$env:LOCALAPPDATA\\agy\\bin\\agy.exe"',
  discoverModels: async ({ file, runCli }) => {
    const result = await runCli(file, ['models'], 30000);
    return result.ok ? parseModels(result.stdout) : null;
  },
  parseModels,
  parseLatest,
};
