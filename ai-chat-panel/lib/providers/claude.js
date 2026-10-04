'use strict';

// Claude Code. See lib/providers/index.js for what each field means.

const { cap } = require('./shared.js');

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

module.exports = {
  id: 'claude',
  name: 'Claude Code',
  company: 'Anthropic',
  color: '#f97316',
  cli: 'claude',
  locate: ({ onPath, inExtensions, join, home, local, npmGlobal }) => [
    ...onPath('claude'), join(npmGlobal, 'claude.cmd'), join(home, '.local', 'bin', 'claude.exe'), join(local, 'Programs', 'Claude', 'claude.exe'),
    ...inExtensions('anthropic.claude-code-', join('resources', 'native-binary', 'claude.exe')),
  ],
  npmPackage: '@anthropic-ai/claude-code',
  login: ['auth', 'login'],
  authStatus: { args: ['auth', 'status'], interpret: (result) => (result.ok ? 'connected' : 'signin') },
  install: 'Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression; & "$env:USERPROFILE\\.local\\bin\\claude.exe" auth login',
  discoverModels: async ({ file, runCli }) => {
    const init = JSON.stringify({ type: 'control_request', request_id: 'model-discovery', request: { subtype: 'initialize' } }) + '\n';
    const result = await runCli(file, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], 30000, null, init);
    return result.ok ? parseModels(result.stdout) : null;
  },
  parseModels,
};
