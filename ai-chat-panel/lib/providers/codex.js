'use strict';

// Codex (OpenAI). See lib/providers/index.js for what each field means.

const { cap } = require('./shared.js');

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
  authStatus: { args: ['login', 'status'], interpret: (result) => (result.ok ? 'connected' : 'signin') },
  install: 'npm.cmd install -g @openai/codex; if ($LASTEXITCODE -eq 0) { & "$env:APPDATA\\npm\\codex.cmd" login }',
  discoverModels: async ({ file, runCli }) => {
    const result = await runCli(file, ['debug', 'models'], 30000);
    return result.ok ? parseModels(result.stdout) : null;
  },
  parseModels,
};
