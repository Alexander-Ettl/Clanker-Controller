'use strict';

// Claude Code. See lib/providers/index.js for what each field means.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cap, parseVersion } = require('./shared.js');

const VALID_CHANNELS = new Set(['stable', 'latest']);

function managedSettingsPath(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  return '/etc/claude-code/managed-settings.json';
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

/** Claude Code's configured release channel (`stable` or `latest`): `claude update` follows this track, not always npm `latest`. */
function claudeUpdateChannel({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const files = [managedSettingsPath(platform, env), path.join(configDir, 'settings.local.json'), path.join(configDir, 'settings.json')];
  for (const file of files) {
    const channel = readJsonFile(file)?.autoUpdatesChannel;
    if (typeof channel === 'string' && VALID_CHANNELS.has(channel.trim().toLowerCase())) return channel.trim().toLowerCase();
  }
  return 'latest';
}

/** Claude's SDK initialize response includes model ids and supported efforts (entries are normalized by the caller). */
function parseModels(text) {
  const response = String(text || '').split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find((message) => message.type === 'control_response' && message.response?.request_id === 'model-discovery');
  const models = response?.response?.response?.models;
  return (Array.isArray(models) ? models : []).filter((m) => m?.resolvedModel || m?.value).flatMap((m) => {
    const model = m.resolvedModel || m.value;
    if (model === 'default') return [];
    const name = m.value === 'default' ? model.replace(/^claude-/, '').replace(/(\d)-(\d)/g, '$1.$2') : m.displayName || model;
    const efforts = m.supportedEffortLevels?.length ? m.supportedEffortLevels : [null];
    return efforts.map((effort) => ({ id: effort ? `${model}-${effort}` : model, agent: 'claude', model, effort,
      ...(m.description ? { description: m.description } : {}),
      label: `${/^claude\b/i.test(name) ? '' : 'Claude '}${name}${effort ? ` ${cap(effort)}` : ''}`,
      isDefault: (m.value === 'default' || models[0]?.resolvedModel === model) && effort === (m.defaultEffort || (efforts.includes('medium') ? 'medium' : efforts[0])) }));
  });
}

/** `claude auth status` names the plan; a claude.ai sign-in on the free plan (or none) cannot run Claude Code. */
function entitlement({ result }) {
  let status;
  try { status = JSON.parse(result?.stdout || ''); } catch { return undefined; }
  const plan = typeof status?.subscriptionType === 'string' ? status.subscriptionType.toLowerCase() : null;
  if (status?.authMethod !== 'claude.ai' || !plan) return undefined; // the field is missing or null for some paying accounts: no verdict
  if (!['free', 'none'].includes(plan)) return null;
  return { kind: 'plan', reason: 'Needs Claude Pro or Max, or an API key.', detail: `subscriptionType: ${plan}. If you subscribed again, sign in again, then press Try again.` };
}

module.exports = {
  id: 'claude',
  nativeAutoCompaction: (env) => env.DISABLE_AUTO_COMPACT !== '1' && env.DISABLE_COMPACT !== '1',
  name: 'Claude Code',
  company: 'Anthropic',
  color: '#f97316',
  cli: 'claude',
  locate: ({ onPath, inExtensions, join, home, local, npmGlobal }) => [
    ...onPath('claude'), join(npmGlobal, 'claude.cmd'), join(home, '.local', 'bin', 'claude.exe'), join(local, 'Programs', 'Claude', 'claude.exe'),
    ...inExtensions('anthropic.claude-code-', join('resources', 'native-binary', 'claude.exe')),
  ],
  npmPackage: '@anthropic-ai/claude-code',
  latestVersion: async (fetchImpl) => {
    const channel = claudeUpdateChannel();
    const res = await fetchImpl(`https://registry.npmjs.org/@anthropic-ai/claude-code/${channel}`, { signal: AbortSignal.timeout(8000) });
    return parseVersion((await res.json())?.version);
  },
  claudeUpdateChannel,
  login: ['auth', 'login'],
  authStatus: { args: ['auth', 'status'], interpret: (result) => (result.ok ? 'connected' : 'signin') },
  entitlement,
  installPosix: 'curl -fsSL https://claude.ai/install.sh | bash && "$HOME/.local/bin/claude" auth login',
  install: 'Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression; & "$env:USERPROFILE\\.local\\bin\\claude.exe" auth login',
  discoverModels: async ({ file, runCli }) => {
    const init = JSON.stringify({ type: 'control_request', request_id: 'model-discovery', request: { subtype: 'initialize' } }) + '\n';
    const result = await runCli(file, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], 30000, null, init);
    return result.ok ? parseModels(result.stdout) : null;
  },
  parseModels,
};
