'use strict';

// GitHub Copilot CLI provider (`@github/copilot`).
// Foundation descriptor for running non-interactive turns (`copilot -p`),
// checking sign-in, and discovering models. Fine-tune flags or stream event
// mappings in `commandFor` and `normalizeEvent` below.

const { launchFailure } = require('./shared.js');

const DEFAULT_COPILOT_MODELS = [
  { id: 'copilot-claude-sonnet-4-5', agent: 'copilot', model: 'claude-sonnet-4.5', effort: null, label: 'Copilot · Claude Sonnet 4.5', isDefault: true },
  { id: 'copilot-claude-opus-4-6', agent: 'copilot', model: 'claude-opus-4.6', effort: null, label: 'Copilot · Claude Opus 4.6' },
  { id: 'copilot-gpt-5', agent: 'copilot', model: 'gpt-5', effort: null, label: 'Copilot · GPT-5' },
  { id: 'copilot-gpt-5-mini', agent: 'copilot', model: 'gpt-5-mini', effort: null, label: 'Copilot · GPT-5 Mini' },
  { id: 'copilot-gemini-2-5-pro', agent: 'copilot', model: 'gemini-2.5-pro', effort: null, label: 'Copilot · Gemini 2.5 Pro' },
];

function parseModels(text) {
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
    const entries = list
      .map((item, idx) => {
        const model = typeof item === 'string' ? item : item?.id || item?.model || item?.name;
        if (!model) return null;
        const title = (typeof item === 'object' && (item.label || item.displayName || item.name)) || model;
        return {
          id: `copilot-${String(model).replace(/[^a-z0-9.-]+/gi, '-')}`,
          agent: 'copilot',
          model: String(model),
          effort: null,
          label: /^Copilot\b/i.test(title) ? String(title) : `Copilot · ${title}`,
          isDefault: Boolean(item?.isDefault || item?.is_default || idx === 0),
        };
      })
      .filter(Boolean);
    if (entries.length) return entries;
  } catch {
    // Fall back to curated defaults when output is not JSON.
  }
  return DEFAULT_COPILOT_MODELS.map((entry) => ({ ...entry }));
}

module.exports = {
  id: 'copilot',
  name: 'GitHub Copilot',
  company: 'GitHub',
  color: '#10b981',
  cli: 'copilot',
  npmPackage: '@github/copilot',
  headlessApprovals: false,
  optional: true,
  icon: '<svg viewBox="0 0 24 24" class="agent-logo" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 11a8 8 0 0 1 16 0v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-3Z"/><path d="M7 11h4v3H7zM13 11h4v3h-4z"/><path d="M8 17v2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2"/></svg>',

  locate: ({ onPath, join, home, local, npmGlobal }) => [
    ...onPath('copilot'),
    join(npmGlobal, 'copilot.cmd'),
    join(local, 'Programs', 'copilot', 'copilot.exe'),
    join(home, '.local', 'bin', 'copilot.exe'),
  ],

  login: ['login'],
  authStatus: {
    args: ['--version'],
    interpret: (result) => {
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (launchFailure(output)) return 'broken';
      if (/not logged in|authentication required|run.*copilot login|please log in/i.test(output)) return 'signin';
      return result.ok ? 'ready' : 'signin';
    },
  },
  install: 'npm.cmd install -g @github/copilot@latest; if ($LASTEXITCODE -eq 0) { & "$env:APPDATA\\npm\\copilot.cmd" login }',

  discoverModels: async ({ file, runCli }) => {
    if (!file) return null;
    try {
      const result = await runCli(file, ['models', '--json'], 15000);
      if (result?.ok && result.stdout) return parseModels(result.stdout);
    } catch {
      // Fall back to default Copilot models when `models --json` is unsupported.
    }
    return DEFAULT_COPILOT_MODELS.map((entry) => ({ ...entry }));
  },

  commandFor({ command, fullPrompt, model, resume, permissionMode, cwd }) {
    const args = ['-p', fullPrompt];
    if (model && model !== 'copilot') args.push('--model', model);
    if (resume) args.push('--resume', resume);
    if (permissionMode === 'fullAccess' || permissionMode === 'auto') args.push('--allow-all-tools');
    if (cwd) args.push('--add-dir', cwd);
    return { command, args, input: '' };
  },

  normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    if (typeof raw.session_id === 'string' && (raw.type === 'init' || raw.event === 'init' || raw.type === 'session')) {
      return { type: 'session', sessionId: raw.session_id, agent: 'copilot' };
    }
    if (raw.type === 'delta' && typeof raw.text === 'string') {
      return { type: 'delta', text: raw.text, model: 'copilot', agent: 'copilot' };
    }
    return undefined;
  },

  parseModels,
  DEFAULT_COPILOT_MODELS,
};
