'use strict';

// The composer's model picker. One entry per model + reasoning effort, grouped
// by the agent (CLI) that runs it. `effort` maps to each CLI's own flag
// (claude --effort, codex -c model_reasoning_effort); agy bakes it into the
// model id (`agy models` lists gemini-3.8-flash-high/-medium/-low).
// `brand` marks Opus for its own terminal and routing (P17-D); visually every
// model wears its agent's mark, so all Claude models look alike.
// Auto runs each agent's first entry here: Opus for UI, Sol for backend, Flash for docs.
const MODEL_CATALOG = [
  { id: 'claude-opus-5-5-medium', agent: 'claude', brand: 'opus', model: 'claude-opus-5-5', effort: 'medium', label: 'Claude Opus 5.5 Medium', shortLabel: 'Opus' },
  { id: 'claude-sonnet-5-5-high', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', label: 'Claude Sonnet 5.5 High' },
  { id: 'gpt-6-sol-high', agent: 'codex', model: 'gpt-6-sol', effort: 'high', label: 'GPT 6 Sol High' },
  { id: 'gpt-6-astra-high', agent: 'codex', model: 'gpt-6-astra', effort: 'high', label: 'GPT 6 Astra High' },
  { id: 'gpt-6-luna-high', agent: 'codex', model: 'gpt-6-luna', effort: 'high', label: 'GPT 6 Luna High' },
  { id: 'gemini-3.8-flash-high', agent: 'gemini', model: 'gemini-3.8-flash-high', effort: null, label: 'Gemini 3.8 Flash High' },
];

function modelOption(id) {
  return MODEL_CATALOG.find((option) => option.id === id) || null;
}

// P17-A: a family word anywhere in a name ("opus", "Claude Opus 5.5", a
// catalog id) picks that catalog entry, so callers that only know agents
// (injectPrompt, Telegram /prompt) can target one model directly.
const FAMILY = /\b(opus|sonnet|sol|astra|luna|flash)\b/i;
function resolveModel(name) {
  const family = FAMILY.exec(String(name || '').replace(/[-_.]/g, ' '))?.[1].toLowerCase();
  return modelOption(name) || (family && MODEL_CATALOG.find((option) => option.label.toLowerCase().includes(family))) || null;
}

module.exports = { MODEL_CATALOG, modelOption, resolveModel };
