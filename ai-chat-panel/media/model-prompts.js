// (In media/ because the Settings webview uses the same helpers: window.modelPrompts there, require() in the extension and tests.)
// Favorite prompts use the exact picker id, including effort. Earlier prompts
// keyed by the CLI model id remain the fallback until a favorite overrides them.
// A new model version starts without either override.
// Stored as { [modelId]: { text, label } }: the label is kept so a prompt of a model that has left the catalog can still
// be shown under its name.
(function (root) {
  'use strict';

  const MAX_PROMPT = 4000;

  const cleanPrompt = (text) => String(text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_PROMPT);

  /** The map after setting `model`'s prompt; empty text removes it. Never mutates `prompts`. */
  function withPrompt(prompts, model, label, text) {
    const next = { ...(prompts || {}) };
    const clean = cleanPrompt(text);
    if (!model) return next;
    if (clean) next[model] = { text: clean, label: String(label || model).slice(0, 80) };
    else delete next[model];
    return next;
  }

  /** The text to send with a message answered by `option` (a catalog entry), or ''. */
  function promptFor(prompts, option) {
    if (option?.id && Object.prototype.hasOwnProperty.call(prompts || {}, option.id)) return prompts[option.id]?.text || '';
    return (option?.model && prompts?.[option.model]?.text) || '';
  }

  function permissionFor(settings, option, fallback = 'fullAccess') {
    const mode = settings?.[option?.id]?.permissionMode;
    return ['ask', 'auto', 'fullAccess'].includes(mode) ? mode : fallback;
  }

  /** One row per model, whatever its effort levels: the picker's "Claude Sonnet 5.5 High" and "... Medium" are one model. */
  function modelRows(catalog) {
    const rows = new Map();
    for (const entry of catalog || []) {
      if (!entry?.model || rows.has(entry.model)) continue;
      const effort = entry.effort ? ` ${entry.effort.charAt(0).toUpperCase()}${entry.effort.slice(1)}` : '';
      const label = effort && entry.label.endsWith(effort) ? entry.label.slice(0, -effort.length) : entry.label;
      rows.set(entry.model, { model: entry.model, agent: entry.agent, label });
    }
    return [...rows.values()];
  }

  /** Saved prompts whose model is no longer available: kept to read and copy, never sent. */
  function retiredPrompts(prompts, catalog) {
    const live = new Set((catalog || []).flatMap((entry) => [entry.model, entry.id]));
    return Object.entries(prompts || {}).filter(([model, prompt]) => prompt.text && !live.has(model)).map(([model, { text, label }]) => ({ model, text, label }));
  }

  /** The user's text followed by the model's prompt, then Auto-Verify's instruction (it asks for the last step, so it goes last). */
  function appendInstructions(text, { modelPrompt = '', verify = '' } = {}) {
    return [text, modelPrompt, verify].filter(Boolean).join('\n\n');
  }

  const api = { MAX_PROMPT, cleanPrompt, withPrompt, promptFor, permissionFor, modelRows, retiredPrompts, appendInstructions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.modelPrompts = api;
})(typeof window !== 'undefined' ? window : globalThis);
