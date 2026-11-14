'use strict';

// Filled from CLI discovery and its persisted cache. Keep these arrays stable:
// the picker, scheduler and running chats all hold references to them.
const AVAILABLE_MODELS = [];
const MODEL_CATALOG = [];
let favorites = [];
const providers = require('./providers'); // which agents exist; read at use, so one registered later counts
let enabledAgents = new Set(providers.ids());
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortRank = (entry) => EFFORTS.indexOf(entry.effort || /-(none|minimal|low|medium|high|xhigh|max|ultra)$/.exec(entry.model)?.[1]);

// These image-capable families are often discovered without modality metadata.
// Explicit discovery/config values still win; hosted text-only models remain excluded.
const visionSupported = entry => entry.vision ?? /^(?:claude-(?:opus|sonnet|haiku)-|gemini-|gpt-[56](?:[.-]|$))/i.test(entry.model || entry.id || '');

function displayName(name) {
  return String(name || '').replace(/[-_]+/g, ' ').replace(/\((low|medium|high|xhigh|max|ultra)\)/gi, '$1')
    .replace(/\s+/g, ' ').trim().split(' ').map((word) => /^(gpt|ai)$/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function normalizeModels(entries) {
  const unique = new Map();
  const owners = providers.all();
  const routes = new Map();
  for (const entry of entries || []) {
    if (!entry?.id || !entry.model || !providers.has(entry.agent)) continue;
    if (!routes.has(entry.id)) routes.set(entry.id, new Set());
    routes.get(entry.id).add(entry.agent);
  }
  for (const entry of entries || []) {
    if (!entry?.id || !entry.model || !providers.has(entry.agent)) continue;
    // The CLI is a route, not the model's maker. Cross-provider models may
    // share their upstream id with a native route; keep both addressable.
    const owner = owners.find((provider) => [provider.id, provider.cli].some((prefix) => entry.model === prefix || entry.model.startsWith(`${prefix}-`)));
    const qualify = owner ? owner.id !== entry.agent : routes.get(entry.id).size > 1;
    const id = qualify && !entry.id.startsWith(`${entry.agent}:`) ? `${entry.agent}:${entry.id}` : entry.id;
    const label = displayName(entry.label || entry.model);
    const base = label.replace(/\s+(none|minimal|low|medium|high|xhigh|max|ultra)$/i, '');
    const family = base.replace(/^(Claude\s+|(?:GPT|Gemini)\s+[\d.]+\s+)/i, '').split(' ')[0];
    unique.set(id, { ...entry, ...(entry.vision == null && visionSupported(entry) ? { vision: true } : {}), id, company: owner?.company || entry.company || providers.get(entry.agent).company, label, shortLabel: /^(GPT|Gemini)$/.test(family) ? base : family, ...(/^opus$/i.test(family) ? { brand: 'opus' } : {}), ...(/argon/i.test(entry.model) ? { brand: 'antigravityArgon' } : {}) });
  }
  const order = providers.ids();
  return [...unique.values()].sort((a, b) => order.indexOf(a.agent) - order.indexOf(b.agent)
    || displayName(a.model.replace(/-(low|medium|high|xhigh|max|ultra)$/, '')).localeCompare(displayName(b.model.replace(/-(low|medium|high|xhigh|max|ultra)$/, '')), 'en', { numeric: true })
    || effortRank(a) - effortRank(b));
}

function rebuildPicker() {
  const available = new Map(AVAILABLE_MODELS.map((entry) => [entry.id, entry]));
  const entries = favorites.filter((entry) => enabledAgents.has(entry.agent)).map((entry) => {
    const found = available.get(entry.id);
    return found?.agent === entry.agent ? found : AVAILABLE_MODELS.find((model) => model.agent === entry.agent && model.model === entry.model && model.effort === entry.effort)
      || (!AVAILABLE_MODELS.some((model) => model.agent === entry.agent) ? entry : null);
  }).filter(Boolean);
  MODEL_CATALOG.splice(0, MODEL_CATALOG.length, ...normalizeModels(entries));
}

function setModelCatalog(entries) {
  AVAILABLE_MODELS.splice(0, AVAILABLE_MODELS.length, ...normalizeModels(entries));
  rebuildPicker();
}

function setFavoriteModels(entries) {
  favorites = normalizeModels(entries);
  rebuildPicker();
}

function setEnabledAgents(agents) {
  enabledAgents = new Set(agents.filter((agent) => providers.has(agent)));
  rebuildPicker();
}

function modelOption(id) {
  return AVAILABLE_MODELS.find((option) => option.id === id) || MODEL_CATALOG.find((option) => option.id === id) || null;
}

function defaultModel(agent) {
  if (!enabledAgents.has(agent)) return null;
  return MODEL_CATALOG.find((option) => option.agent === agent && option.isDefault)
    || MODEL_CATALOG.find((option) => option.agent === agent)
    || AVAILABLE_MODELS.find((option) => option.agent === agent && option.isDefault)
    || AVAILABLE_MODELS.find((option) => option.agent === agent) || null;
}

function resolveModel(name) {
  const query = displayName(name).toLowerCase();
  return modelOption(name) || [...MODEL_CATALOG, ...AVAILABLE_MODELS].find((option) => option.label.toLowerCase() === query
    || option.label.replace(/\s+(none|minimal|low|medium|high|xhigh|max|ultra)$/i, '').toLowerCase() === query
    || displayName(option.model).toLowerCase() === query || option.shortLabel.toLowerCase() === query) || null;
}

module.exports = { MODEL_CATALOG, AVAILABLE_MODELS, displayName, normalizeModels, visionSupported, setModelCatalog, setFavoriteModels, setEnabledAgents, defaultModel, modelOption, resolveModel };
