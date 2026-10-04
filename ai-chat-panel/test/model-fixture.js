'use strict';

// Recorded CLI discovery for tests that exercise routing without real CLIs.
const { parseClaudeModels, parseCodexModels, parseAgyModels } = require('../lib/cli-tools');
const { setModelCatalog, setFavoriteModels } = require('../lib/model-catalog');
const models = [
  ...parseClaudeModels(JSON.stringify({ type: 'control_response', response: { request_id: 'model-discovery', response: { models: [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['medium'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['high'] },
  ] } } })),
  ...parseCodexModels(JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
  ] })),
  ...parseAgyModels('gemini-3.8-flash-high\tGemini 3.8 Flash (High)'),
];

function seedModels() { setModelCatalog(models); setFavoriteModels(models); }
module.exports = { models, seedModels };
