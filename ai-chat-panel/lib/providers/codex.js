'use strict';

// Codex (OpenAI). See lib/providers/index.js for what each field means.

const fs = require('node:fs');
const path = require('node:path');
const { cap, launchFailure } = require('./shared.js');

/**
 * Codex needs ChatGPT Plus or above, and `login status` keeps saying "Logged in" after a plan ends. The plan is in the
 * sign-in token Codex keeps on disk (refreshed whenever Codex runs), so it can be read without spending a prompt.
 * Returns null when it is fine (API key sign-in, a paid plan) and undefined when it cannot be told.
 */
function entitlement({ home, env = process.env }) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'), 'utf8'));
    if (auth.OPENAI_API_KEY || (auth.auth_mode && auth.auth_mode !== 'chatgpt')) return null;
    const claims = (token) => { try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))['https://api.openai.com/auth'] || {}; } catch { return {}; } };
    const plan = String(claims(auth.tokens?.access_token).chatgpt_plan_type || claims(auth.tokens?.id_token).chatgpt_plan_type || '').toLowerCase();
    if (!plan) return undefined;
    if (plan !== 'free') return null;
    return { kind: 'plan', reason: 'Needs ChatGPT Plus or above.', detail: 'This account is on the Free plan (chatgpt_plan_type: free). If you subscribed again, sign in to Codex again, then press Try again.' };
  } catch { return undefined; }
}

/** `codex debug models` JSON -> one entry per listed model and reasoning effort (normalized by the caller). */
function parseModels(text) {
  let models;
  try { models = JSON.parse(text).models; } catch { return []; }
  const listed = (Array.isArray(models) ? models : []).filter((m) => m?.slug && m.visibility === 'list');
  const preferred = listed.find((m) => m.is_default) || listed[0];
  return listed.flatMap((m) => {
    const name = m.display_name || m.slug;
    const efforts = (m.supported_reasoning_levels || []).map((level) => level.effort).filter(Boolean);
    return (efforts.length ? efforts : [m.default_reasoning_level || 'medium']).map((effort) => (
      { id: `${m.slug}-${effort}`, agent: 'codex', model: m.slug, effort, label: `${name} ${cap(effort)}`, ...(m.description ? { description: m.description } : {}), ...(Array.isArray(m.input_modalities) ? { vision: m.input_modalities.includes('image') } : {}), ...(Number.isFinite(m.context_window) ? { context: m.context_window } : {}), isDefault: m === preferred && effort === (m.default_reasoning_level || 'medium') }));
  });
}

module.exports = {
  id: 'codex',
  nativeAutoCompaction: true,
  name: 'Codex',
  company: 'OpenAI',
  color: '#8b5cf6',
  cli: 'codex',
  locate: ({ onPath, inExtensions, join, npmGlobal }) => [
    ...onPath('codex'),
    ...inExtensions('openai.chatgpt-', join('bin', 'windows-x86_64', 'codex.exe')),
    ...inExtensions('openai.chatgpt-', join('bin', 'windows', 'codex.exe')),
    join(npmGlobal, 'codex.cmd'),
  ],
  npmPackage: '@openai/codex',
  login: ['login'],
  authStatus: { args: ['login', 'status'], interpret: (result) => (result.ok ? 'connected' : launchFailure(result.stderr || result.stdout) ? 'broken' : 'signin') },
  entitlement,
  installPosix: 'npm install -g @openai/codex@latest && codex login',
  // Also the repair for a damaged install: an interrupted npm update leaves a `.codex-*` folder behind and drops the platform binary.
  install: 'Remove-Item -Path "$env:APPDATA\\npm\\node_modules\\@openai\\.codex-*" -Recurse -Force -ErrorAction SilentlyContinue; npm.cmd install -g @openai/codex@latest; if ($LASTEXITCODE -eq 0) { & "$env:APPDATA\\npm\\codex.cmd" login }',
  discoverModels: async ({ file, runCli }) => {
    const result = await runCli(file, ['debug', 'models'], 30000);
    return result.ok ? parseModels(result.stdout) : null;
  },
  parseModels,
};
